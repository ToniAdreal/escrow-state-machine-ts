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

// Backlog #696: the 429 Retry-After clamp (maxRetryDelayMs) crossed with
// the retry jitter (jitterMs). Implementation read first (src/webhooks.ts,
// `retryDelayMs`): a parsable 429 hint returns `Math.min(hinted,
// maxRetryDelayMs)` exactly — jitter is never added on top of the hint.
// Jitter only spreads the exponential backoff on the fallback path (no
// hint, or a non-429 retryable status). These tests pin that order:
// with Math.random pinned to its maximum (1.0), any jitter wrongly added
// after the clamp would push the wait to cap + jitterMs (or re-clamp it
// to a larger cap), far outside the tight upper bounds below.

const SECRET = "whsec_test_max_retry_delay_jitter_20261029";
const FIXED_NOW = "2026-10-29T10:00:00.000Z";
const URL = "https://ledger.example.com/hooks/escrow";

function goldenWebhook(): SettlementWebhook {
  const escrow = new Escrow("esc-max-retry-delay-jitter");
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
 * last response once exhausted). Delivery only reads status and headers,
 * so Response reuse across attempts is safe here.
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

/** Run `run` with `Math.random` pinned to a fixed value, then restore it. */
async function withRandom<T>(value: number, run: () => Promise<T>): Promise<T> {
  const original = Math.random;
  Math.random = () => value;
  try {
    return await run();
  } finally {
    Math.random = original;
  }
}

test("hint over the cap + jitter waits exactly the cap, never cap + jitter", async () => {
  // Hint 120s, clamped to 400ms. With Math.random pinned to 1.0, jitter
  // wrongly added after the clamp would wait 400 + 5000 = 5400ms, so the
  // < 1900ms upper bound (well under 5400ms, well over timer slop) pins
  // the exact-cap behavior. (Jitter added before the clamp would be
  // clamped back to the same 400ms, observably identical — the pinned
  // observable is "the wait is exactly the cap".)
  const stub = stubFetch([json(429, { "retry-after": "120" }), json(200)]);
  try {
    const start = Date.now();
    const result = await withRandom(1, () =>
      deliverSettlementWebhook(URL, goldenWebhook(), {
        allowInsecureHttp: true,
        maxRetryDelayMs: 400,
        jitterMs: 5000,
        backoffMs: 10,
      }),
    );
    const elapsed = Date.now() - start;
    assert.deepEqual(result, { status: 200, attempts: 2 });
    assert.equal(stub.calls(), 2);
    assert.ok(
      elapsed >= 350,
      `expected the clamped hint to still be waited, took ${elapsed}ms`,
    );
    assert.ok(
      elapsed < 1900,
      `expected exactly the 400ms cap, not cap + jitter (5400ms), took ${elapsed}ms`,
    );
  } finally {
    stub.restore();
  }
});

test("zero-jitter control for the hint-over-cap case waits the same cap", async () => {
  // Same hint and cap, jitterMs 0: the wait must be identical to the
  // jittered case above — proving the jitter option does not move the
  // hint path at all, rather than merely shrinking it.
  const stub = stubFetch([json(429, { "retry-after": "120" }), json(200)]);
  try {
    const start = Date.now();
    const result = await deliverSettlementWebhook(URL, goldenWebhook(), {
      allowInsecureHttp: true,
      maxRetryDelayMs: 400,
      jitterMs: 0,
      backoffMs: 10,
    });
    const elapsed = Date.now() - start;
    assert.deepEqual(result, { status: 200, attempts: 2 });
    assert.equal(stub.calls(), 2);
    assert.ok(
      elapsed >= 350,
      `expected the clamped hint to still be waited, took ${elapsed}ms`,
    );
    assert.ok(
      elapsed < 1900,
      `expected exactly the 400ms cap, took ${elapsed}ms`,
    );
  } finally {
    stub.restore();
  }
});

test("hint under the cap + jitter waits exactly the hint, never hint + jitter", async () => {
  // Hint 0.4s (400ms) under a 5000ms cap, jitterMs 5000, Math.random at
  // maximum: jitter wrongly added would wait 5400ms. The tight upper
  // bound pins the receiver's prescribed time as exact.
  const stub = stubFetch([json(429, { "retry-after": "0.4" }), json(200)]);
  try {
    const start = Date.now();
    const result = await withRandom(1, () =>
      deliverSettlementWebhook(URL, goldenWebhook(), {
        allowInsecureHttp: true,
        maxRetryDelayMs: 5000,
        jitterMs: 5000,
        backoffMs: 10,
      }),
    );
    const elapsed = Date.now() - start;
    assert.deepEqual(result, { status: 200, attempts: 2 });
    assert.equal(stub.calls(), 2);
    assert.ok(
      elapsed >= 350,
      `expected the sub-cap hint to still be waited, took ${elapsed}ms`,
    );
    assert.ok(
      elapsed < 1900,
      `expected exactly the 400ms hint, not hint + jitter (5400ms), took ${elapsed}ms`,
    );
  } finally {
    stub.restore();
  }
});

test("no-hint 429 + jitter still spreads the backoff (jitter is alive)", async () => {
  // Contrast control: without a hint the fallback is the jittered
  // backoff, so with Math.random pinned to 1.0 the wait must be exactly
  // backoff + jitterMs (100 + 500 = 600ms). This proves the exactness in
  // the hint cases above is the branch order, not a dead jitter option.
  const stub = stubFetch([json(429), json(200)]);
  try {
    const start = Date.now();
    const result = await withRandom(1, () =>
      deliverSettlementWebhook(URL, goldenWebhook(), {
        allowInsecureHttp: true,
        backoffMs: 100,
        maxRetryDelayMs: 5000,
        jitterMs: 500,
      }),
    );
    const elapsed = Date.now() - start;
    assert.deepEqual(result, { status: 200, attempts: 2 });
    assert.equal(stub.calls(), 2);
    assert.ok(
      elapsed >= 550,
      `expected the jittered backoff (100 + 500ms) to be waited, took ${elapsed}ms`,
    );
    assert.ok(
      elapsed < 2100,
      `expected the jittered backoff, not the cap, to drive the wait, took ${elapsed}ms`,
    );
  } finally {
    stub.restore();
  }
});

test("no-hint 429 + jitter with Math.random at 0 waits exactly the backoff", async () => {
  // Lower edge of the same fallback window: random 0 collapses the
  // spread to the pure backoff, bounding the interval from below.
  const stub = stubFetch([json(429), json(200)]);
  try {
    const start = Date.now();
    const result = await withRandom(0, () =>
      deliverSettlementWebhook(URL, goldenWebhook(), {
        allowInsecureHttp: true,
        backoffMs: 100,
        maxRetryDelayMs: 5000,
        jitterMs: 500,
      }),
    );
    const elapsed = Date.now() - start;
    assert.deepEqual(result, { status: 200, attempts: 2 });
    assert.equal(stub.calls(), 2);
    assert.ok(
      elapsed >= 90,
      `expected the pure 100ms backoff to be waited, took ${elapsed}ms`,
    );
    assert.ok(
      elapsed < 1600,
      `expected the pure backoff, took ${elapsed}ms`,
    );
  } finally {
    stub.restore();
  }
});
