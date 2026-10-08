import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementWebhook,
  calculateDeposit,
  deliverSettlementWebhook,
} from "../src/index.js";
import type { SettlementWebhook } from "../src/index.js";

const SECRET = "whsec_test_max_retry_delay_20261007";
const FIXED_NOW = "2026-10-07T12:00:00.000Z";
// Never actually fetched: deliverSettlementWebhook calls the global fetch,
// which every test below stubs out.
const URL = "https://ledger.example.com/hooks/escrow";

function goldenWebhook(): SettlementWebhook {
  const escrow = new Escrow("esc-max-retry-delay");
  escrow.dispatch("FUND");
  escrow.dispatch("SUBMIT_MILESTONE");
  escrow.dispatch("VERIFY_PASS");
  escrow.dispatch("RELEASE");
  const report = buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: calculateDeposit({
      creatorPool: 10000,
      baseFee: 600,
      complexityMultiplier: 1.0,
      loyaltyDiscount: 30,
      oracleFee: 60,
    }),
    settlement: { proFeeBps: 500 },
  });
  return buildSettlementWebhook(report, { secret: SECRET, now: FIXED_NOW });
}

const json = (status: number, headers?: Record<string, string>) =>
  new Response("{}", { status, headers });

/**
 * Replace the global fetch with a canned response sequence (stays on the
 * last response once exhausted). The stub honors the `as typeof fetch`
 * shape; argument inspection is unnecessary — the delivery code paths under
 * test are driven entirely by the response status and headers.
 */
function stubFetch(responses: Response[]): {
  calls: () => number;
  restore: () => void;
} {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    const r = responses[Math.min(calls, responses.length - 1)];
    calls += 1;
    return r;
  }) as typeof fetch;
  return {
    calls: () => calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("429 with a runaway Retry-After is clamped by the default 60s cap", async () => {
  // Retry-After: 31536000 (one year) would stall the delivery promise for a
  // year if honored at face value. This test intentionally waits the full
  // default 60s cap so the clamp is proved with real wall-clock numbers.
  const stub = stubFetch([json(429, { "retry-after": "31536000" }), json(200)]);
  try {
    const start = Date.now();
    const result = await deliverSettlementWebhook(URL, goldenWebhook());
    const elapsed = Date.now() - start;
    assert.deepEqual(result, { status: 200, attempts: 2 });
    assert.equal(stub.calls(), 2);
    assert.ok(
      elapsed >= 55_000,
      `expected the 60s cap to be actually waited (hint honored), took ${elapsed}ms`,
    );
    assert.ok(
      elapsed < 60_000 + 5_000,
      `expected delivery inside the 60s cap, took ${elapsed}ms`,
    );
  } finally {
    stub.restore();
  }
});

test("explicit smaller maxRetryDelayMs clamps the hint", async () => {
  const stub = stubFetch([json(429, { "retry-after": "31536000" }), json(200)]);
  try {
    const start = Date.now();
    const result = await deliverSettlementWebhook(URL, goldenWebhook(), {
      maxRetryDelayMs: 400,
    });
    const elapsed = Date.now() - start;
    assert.deepEqual(result, { status: 200, attempts: 2 });
    assert.ok(
      elapsed >= 350,
      `expected the hint to still be honored up to the cap, took ${elapsed}ms`,
    );
    assert.ok(
      elapsed < 400 + 2_000,
      `expected delivery inside the 400ms cap, took ${elapsed}ms`,
    );
  } finally {
    stub.restore();
  }
});

test("explicit larger maxRetryDelayMs is honored", async () => {
  const stub = stubFetch([json(429, { "retry-after": "31536000" }), json(200)]);
  try {
    const start = Date.now();
    const result = await deliverSettlementWebhook(URL, goldenWebhook(), {
      maxRetryDelayMs: 2_500,
    });
    const elapsed = Date.now() - start;
    assert.deepEqual(result, { status: 200, attempts: 2 });
    assert.ok(
      elapsed >= 2_400,
      `expected the larger cap to be waited, took ${elapsed}ms`,
    );
    assert.ok(
      elapsed < 2_500 + 2_000,
      `expected delivery inside the 2500ms cap, took ${elapsed}ms`,
    );
  } finally {
    stub.restore();
  }
});

test("maxRetryDelayMs: 0 retries a hinted 429 immediately", async () => {
  const stub = stubFetch([json(429, { "retry-after": "31536000" }), json(200)]);
  try {
    const start = Date.now();
    const result = await deliverSettlementWebhook(URL, goldenWebhook(), {
      maxRetryDelayMs: 0,
    });
    const elapsed = Date.now() - start;
    assert.deepEqual(result, { status: 200, attempts: 2 });
    assert.equal(stub.calls(), 2);
    assert.ok(
      elapsed < 3_000,
      `expected the hint to be clamped to 0 (immediate retry), took ${elapsed}ms`,
    );
  } finally {
    stub.restore();
  }
});

test("429 without a Retry-After hint still uses exponential backoff", async () => {
  // The cap only clamps the 429 hint; the backoff fallback path must be
  // untouched even when a (larger) cap is configured.
  const stub = stubFetch([json(429), json(200)]);
  try {
    const start = Date.now();
    const result = await deliverSettlementWebhook(URL, goldenWebhook(), {
      backoffMs: 60,
      maxRetryDelayMs: 100_000,
    });
    const elapsed = Date.now() - start;
    assert.deepEqual(result, { status: 200, attempts: 2 });
    assert.ok(
      elapsed >= 55,
      `expected the 60ms exponential backoff to be waited, took ${elapsed}ms`,
    );
    assert.ok(
      elapsed < 60 + 2_000,
      `expected backoff, not the cap, to drive the wait, took ${elapsed}ms`,
    );
  } finally {
    stub.restore();
  }
});

const badValues: Array<{ name: string; value: unknown }> = [
  { name: "-1", value: -1 },
  { name: "Infinity", value: Infinity },
  { name: "NaN", value: Number.NaN },
  { name: '"60000" (string)', value: "60000" },
  { name: "{} (object)", value: {} },
  { name: "[] (array)", value: [] },
];

for (const { name, value } of badValues) {
  test(`maxRetryDelayMs=${name} throws a config error`, async () => {
    const stub = stubFetch([json(200)]);
    try {
      await assert.rejects(
        deliverSettlementWebhook(URL, goldenWebhook(), {
          maxRetryDelayMs: value as number,
        }),
        /cannot deliver settlement webhook: maxRetryDelayMs must be a non-negative number/,
      );
      assert.equal(stub.calls(), 0, "no request may be made on a config error");
    } finally {
      stub.restore();
    }
  });
}

test("a Retry-After HTTP-date far in the future is also clamped", async () => {
  const stub = stubFetch([
    json(429, { "retry-after": "Wed, 01 Jan 2031 00:00:00 GMT" }),
    json(200),
  ]);
  try {
    const start = Date.now();
    const result = await deliverSettlementWebhook(URL, goldenWebhook(), {
      maxRetryDelayMs: 300,
    });
    const elapsed = Date.now() - start;
    assert.deepEqual(result, { status: 200, attempts: 2 });
    assert.ok(
      elapsed < 300 + 2_000,
      `expected the HTTP-date hint to be clamped, took ${elapsed}ms`,
    );
  } finally {
    stub.restore();
  }
});
