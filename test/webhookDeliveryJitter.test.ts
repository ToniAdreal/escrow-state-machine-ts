import test from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementWebhook,
  calculateDeposit,
  deliverSettlementWebhook,
  deliverSettlementWebhookToMany,
} from "../src/index.js";
import type {
  SettlementReport,
  SettlementWebhook,
} from "../src/index.js";

const SECRET = "whsec_test_settlement_jitter_20261028";
const FIXED_NOW = "2026-10-28T10:00:00.000Z";
const URL = "https://ledger.example.com/hooks/escrow";

function goldenReport(): SettlementReport {
  const escrow = new Escrow("esc-jitter");
  escrow.dispatch("FUND");
  escrow.dispatch("SUBMIT_MILESTONE");
  escrow.dispatch("VERIFY_PASS");
  escrow.dispatch("RELEASE");
  return buildSettlementReport({
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
}

function goldenWebhook(): SettlementWebhook {
  return buildSettlementWebhook(goldenReport(), {
    secret: SECRET,
    now: FIXED_NOW,
  });
}

const json = (status: number, headers?: Record<string, string>) =>
  new Response("{}", { status, headers });

/**
 * Replace the global fetch with a canned response/error sequence (stays
 * on the last entry once exhausted). Delivery only reads status and
 * headers, so Response reuse across attempts is safe here.
 */
function stubFetch(script: Array<Response | Error>): {
  calls: () => number;
  restore: () => void;
} {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    const step = script[Math.min(calls, script.length - 1)];
    calls += 1;
    if (step instanceof Error) throw step;
    return step;
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

/** A loopback server that answers 500 once, then 200 on every retry. */
async function startFlakyServer(): Promise<{
  url: string;
  hits: () => number;
  close: () => Promise<void>;
}> {
  let hits = 0;
  const server: Server = createServer(
    (_req: IncomingMessage, res: ServerResponse) => {
      hits += 1;
      if (hits === 1) {
        res.writeHead(500);
        res.end("boom");
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      }
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/webhook`,
    hits: () => hits,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("default jitterMs=0 keeps the exact exponential backoff schedule (5xx path)", async () => {
  const stub = stubFetch([json(500), json(500), json(200)]);
  try {
    const started = Date.now();
    const result = await deliverSettlementWebhook(URL, goldenWebhook(), {
      allowInsecureHttp: true,
      retries: 2,
      backoffMs: 100,
      timeoutMs: 5000,
    });
    const elapsed = Date.now() - started;
    assert.deepEqual(result, { status: 200, attempts: 3 });
    assert.equal(stub.calls(), 3);
    // Regression lock: no jitter configured => pure 100 + 200 = 300ms
    // of sleeps. The generous lower bound only proves both sleeps
    // happened; it cannot flake on CI timer jitter.
    assert.ok(
      elapsed >= 250,
      `expected the 100+200ms backoff sleeps, elapsed ${elapsed}ms`,
    );
    assert.ok(
      elapsed < 300 + 3000,
      `expected no extra jitter wait, elapsed ${elapsed}ms`,
    );
  } finally {
    stub.restore();
  }
});

test("default jitterMs=0 keeps the exact exponential backoff schedule (network-error path)", async () => {
  const stub = stubFetch([
    new Error("socket hang up"),
    new Error("socket hang up"),
    json(200),
  ]);
  try {
    const started = Date.now();
    const result = await deliverSettlementWebhook(URL, goldenWebhook(), {
      allowInsecureHttp: true,
      retries: 2,
      backoffMs: 100,
      timeoutMs: 5000,
    });
    const elapsed = Date.now() - started;
    assert.deepEqual(result, { status: 200, attempts: 3 });
    assert.equal(stub.calls(), 3);
    assert.ok(
      elapsed >= 250,
      `expected the 100+200ms backoff sleeps, elapsed ${elapsed}ms`,
    );
    assert.ok(
      elapsed < 300 + 3000,
      `expected no extra jitter wait, elapsed ${elapsed}ms`,
    );
  } finally {
    stub.restore();
  }
});

test("jitterMs spreads the backoff wait: Math.random 0.5 adds half the jitter", async () => {
  const stub = stubFetch([json(500), json(500), json(200)]);
  try {
    const started = Date.now();
    const result = await withRandom(0.5, () =>
      deliverSettlementWebhook(URL, goldenWebhook(), {
        allowInsecureHttp: true,
        retries: 2,
        backoffMs: 100,
        jitterMs: 1000,
        timeoutMs: 5000,
      }),
    );
    const elapsed = Date.now() - started;
    assert.deepEqual(result, { status: 200, attempts: 3 });
    // Waits: (100 + 500) + (200 + 500) = 1300ms. Without jitter the
    // total would be 300ms, so the lower bound proves jitter applied.
    assert.ok(
      elapsed >= 1100,
      `expected jittered waits totalling ~1300ms, elapsed ${elapsed}ms`,
    );
    assert.ok(
      elapsed < 1300 + 3000,
      `expected jitter bounded by jitterMs, elapsed ${elapsed}ms`,
    );
  } finally {
    stub.restore();
  }
});

test("jitterMs follows the random draw: Math.random 0 adds no jitter", async () => {
  const stub = stubFetch([json(500), json(500), json(200)]);
  try {
    const started = Date.now();
    const result = await withRandom(0, () =>
      deliverSettlementWebhook(URL, goldenWebhook(), {
        allowInsecureHttp: true,
        retries: 2,
        backoffMs: 100,
        jitterMs: 1000,
        timeoutMs: 5000,
      }),
    );
    const elapsed = Date.now() - started;
    assert.deepEqual(result, { status: 200, attempts: 3 });
    // A draw of 0 must add nothing: if the code added a fixed jitter
    // regardless of the draw, this would take ~2300ms instead of ~300ms.
    assert.ok(
      elapsed >= 250,
      `expected the plain 100+200ms backoff sleeps, elapsed ${elapsed}ms`,
    );
    assert.ok(
      elapsed < 1000,
      `expected a zero draw to add zero jitter, elapsed ${elapsed}ms`,
    );
  } finally {
    stub.restore();
  }
});

test("a 429 Retry-After hint is waited exactly even with jitterMs set", async () => {
  const stub = stubFetch([
    json(429, { "retry-after": "0" }),
    json(500),
    json(200),
  ]);
  try {
    const started = Date.now();
    const result = await withRandom(0.5, () =>
      deliverSettlementWebhook(URL, goldenWebhook(), {
        allowInsecureHttp: true,
        retries: 2,
        backoffMs: 100,
        jitterMs: 5000,
        timeoutMs: 5000,
      }),
    );
    const elapsed = Date.now() - started;
    assert.deepEqual(result, { status: 200, attempts: 3 });
    // Waits: the hint (0ms, exact — no jitter) + the 500 backoff
    // (200 + 2500 = 2700ms). If the hint were jittered too, the total
    // would be 5200ms and the upper bound below would fail.
    assert.ok(
      elapsed >= 2400,
      `expected the jittered 500 backoff after an exact hint, elapsed ${elapsed}ms`,
    );
    assert.ok(
      elapsed < 4000,
      `expected the hint to carry no jitter, elapsed ${elapsed}ms`,
    );
  } finally {
    stub.restore();
  }
});

test("invalid jitterMs throws a config error before any request", async () => {
  const badValues: Array<{ name: string; value: unknown }> = [
    { name: "-1", value: -1 },
    { name: "NaN", value: Number.NaN },
    { name: "Infinity", value: Number.POSITIVE_INFINITY },
    { name: '"100" (string)', value: "100" },
    { name: "{} (object)", value: {} },
  ];
  for (const { name, value } of badValues) {
    const stub = stubFetch([json(200)]);
    try {
      await assert.rejects(
        () =>
          deliverSettlementWebhook(URL, goldenWebhook(), {
            allowInsecureHttp: true,
            jitterMs: value as number,
          }),
        /cannot deliver settlement webhook: jitterMs must be a non-negative number/,
        `jitterMs=${name}`,
      );
      assert.equal(stub.calls(), 0, `jitterMs=${name} must make zero fetch calls`);
    } finally {
      stub.restore();
    }
  }
});

test("fan-out: a per-endpoint jitterMs override applies over call-level 0", async () => {
  const a = await startFlakyServer();
  const b = await startFlakyServer();
  try {
    const started = Date.now();
    const out = await withRandom(0.5, () =>
      deliverSettlementWebhookToMany(
        goldenReport(),
        [
          { url: a.url, secret: SECRET },
          { url: b.url, secret: SECRET, jitterMs: 2000 },
        ],
        {
          allowInsecureHttp: true,
          retries: 1,
          backoffMs: 10,
          jitterMs: 0,
        },
      ),
    );
    const elapsed = Date.now() - started;
    assert.equal(out.delivered, 2);
    assert.equal(out.failed, 0);
    assert.deepEqual(
      out.results.map((r) => r.attempts),
      [2, 2],
    );
    // Endpoint B waits 10 + 0.5 * 2000 = 1010ms; endpoint A waits 10ms.
    // Fan-out runs concurrently, so the total tracks the slower one.
    // If B's override were dropped, the total would be ~10ms.
    assert.ok(
      elapsed >= 900,
      `expected B's jittered wait to dominate, elapsed ${elapsed}ms`,
    );
    assert.ok(
      elapsed < 1010 + 3000,
      `expected B's wait bounded by its jitterMs, elapsed ${elapsed}ms`,
    );
  } finally {
    await a.close();
    await b.close();
  }
});

test("fan-out: a per-endpoint jitterMs 0 overrides call-level jitterMs", async () => {
  const a = await startFlakyServer();
  const b = await startFlakyServer();
  try {
    const started = Date.now();
    const out = await withRandom(0.5, () =>
      deliverSettlementWebhookToMany(
        goldenReport(),
        [
          { url: a.url, secret: SECRET, jitterMs: 0 },
          { url: b.url, secret: SECRET, jitterMs: 0 },
        ],
        {
          allowInsecureHttp: true,
          retries: 1,
          backoffMs: 10,
          jitterMs: 2000,
        },
      ),
    );
    const elapsed = Date.now() - started;
    assert.equal(out.delivered, 2);
    assert.equal(out.failed, 0);
    // Both endpoints opted out of jitter: each waits 10ms. If the
    // overrides were ignored, each would wait 1010ms instead.
    assert.ok(
      elapsed < 800,
      `expected per-endpoint jitterMs 0 to cancel the call-level jitter, elapsed ${elapsed}ms`,
    );
  } finally {
    await a.close();
    await b.close();
  }
});

test("fan-out: an invalid per-endpoint jitterMs fails only that endpoint", async () => {
  const bad = await startFlakyServer();
  const good = await startFlakyServer();
  try {
    const out = await deliverSettlementWebhookToMany(
      goldenReport(),
      [
        { url: bad.url, secret: SECRET, jitterMs: -1 },
        { url: good.url, secret: SECRET },
      ],
      {
        allowInsecureHttp: true,
        retries: 1,
        backoffMs: 1,
      },
    );
    assert.equal(out.delivered, 1);
    assert.equal(out.failed, 1);
    assert.equal(out.results[0].ok, false);
    assert.equal(out.results[0].attempts, 0);
    assert.match(
      out.results[0].error ?? "",
      /cannot deliver settlement webhook: jitterMs must be a non-negative number/,
    );
    assert.equal(out.results[1].ok, true);
    assert.equal(out.results[1].attempts, 2);
    assert.equal(bad.hits(), 0, "the bad endpoint must make zero requests");
    assert.equal(good.hits(), 2);
  } finally {
    await bad.close();
    await good.close();
  }
});

test("fan-out: an invalid call-level jitterMs throws before any request", async () => {
  const stub = stubFetch([json(200)]);
  try {
    await assert.rejects(
      () =>
        deliverSettlementWebhookToMany(
          goldenReport(),
          [{ url: URL, secret: SECRET }],
          { allowInsecureHttp: true, jitterMs: -1 },
        ),
      /cannot deliver settlement webhook: jitterMs must be a non-negative number/,
    );
    assert.equal(stub.calls(), 0, "no request may be made on a config error");
  } finally {
    stub.restore();
  }
});
