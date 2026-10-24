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
} from "../src/index.js";
import type { SettlementWebhook } from "../src/index.js";

const SECRET = "whsec_test_settlement_delivery_abort_20261008";
const FIXED_NOW = "2026-10-08T11:00:00.000Z";

function goldenDeposit() {
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

function goldenWebhook(): SettlementWebhook {
  const escrow = new Escrow("esc-abort-signal");
  escrow.dispatch("FUND");
  escrow.dispatch("SUBMIT_MILESTONE");
  escrow.dispatch("VERIFY_PASS");
  escrow.dispatch("RELEASE");
  const report = buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500 },
  });
  return buildSettlementWebhook(report, { secret: SECRET, now: FIXED_NOW });
}

/**
 * Spin up a local HTTP server on 127.0.0.1:0, run the test against it, then
 * tear it down (including never-responding connections).
 */
async function withServer(
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    received: number,
  ) => void,
  run: (url: string, received: () => number) => Promise<void>,
): Promise<void> {
  let received = 0;
  const server: Server = createServer((req, res) => {
    req.resume(); // Drain the request body; only the count matters here.
    req.on("end", () => {
      received++;
      handler(req, res, received);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}/webhook`, () => received);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function okHandler(_req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
}

function boomHandler(_req: IncomingMessage, res: ServerResponse) {
  res.writeHead(500);
  res.end("boom");
}

/**
 * Deterministic abort triggers (no wall-clock racing).
 *
 * Earlier revisions fired `controller.abort()` from a `setTimeout`
 * (50ms / 150ms). Under load those timers drift against the request /
 * backoff schedule — the abort landed in the wrong phase (or the expected
 * retry had not happened yet) and the test flaked in full-suite runs while
 * passing standalone. Every trigger below is an event that proves the
 * delivery is in the phase under test:
 *
 * - in-flight cases abort inside the server handler itself: the handler
 *   only runs once the request has actually arrived, so the fetch is
 *   in flight by construction;
 * - backoff / Retry-After cases abort on the server response's `finish`
 *   event: the failing response has been sent, so the client is either
 *   entering the interruptible wait or already in it. Both interleavings
 *   reject with `webhook delivery aborted` after exactly the attempts
 *   already made (`sleepAbortable` also rejects when the signal is
 *   already aborted on entry), so the assertions hold deterministically.
 *
 * Wall clock survives only as a loose upper-bound assertion inside the
 * tests (`elapsed < 10_000`): abort must cut a 30s wait short — it is a
 * fail-fast bound, never a trigger.
 */
function abortOnResponseFinished(
  res: ServerResponse,
  controller: AbortController,
): void {
  res.once("finish", () => controller.abort());
}

test("pre-aborted signal throws immediately with zero HTTP attempts", async () => {
  const signed = goldenWebhook();
  const controller = new AbortController();
  controller.abort();
  await withServer(okHandler, async (url, received) => {
    const started = Date.now();
    await assert.rejects(
      () => deliverSettlementWebhook(url, signed, { allowInsecureHttp: true,  signal: controller.signal }),
      /webhook delivery aborted/,
    );
    assert.equal(received(), 0, "no request may be made after a pre-abort");
    assert.ok(
      Date.now() - started < 2000,
      "pre-abort must fail fast, never touch the network",
    );
  });
});

test("abort during backoff ends the retry loop far before the backoff", async () => {
  const signed = goldenWebhook();
  const controller = new AbortController();
  await withServer(
    (req, res) => {
      // The 500 response going out is the event that starts the backoff;
      // abort as soon as it has been sent, not after a guessed delay.
      abortOnResponseFinished(res, controller);
      boomHandler(req, res);
    },
    async (url, received) => {
    const started = Date.now();
    await assert.rejects(
      () =>
        deliverSettlementWebhook(url, signed, { allowInsecureHttp: true, 
          // Without an abort this would sleep 30s before retry 1.
          retries: 5,
          backoffMs: 30_000,
          timeoutMs: 2000,
          signal: controller.signal,
        }),
      /webhook delivery aborted/,
    );
    const elapsed = Date.now() - started;
    assert.equal(received(), 1, "only the initial attempt went out");
    assert.ok(
      elapsed < 10_000,
      `abort must cut the 30s backoff short, elapsed ${elapsed}ms`,
    );
  });
});

test("abort during an in-flight request rejects without retrying", async () => {
  const signed = goldenWebhook();
  const controller = new AbortController();
  await withServer(
    () => {
      // Never respond: without an abort the 30s timeout would fire.
      // The handler running at all proves the request is in flight, so
      // aborting here is deterministic — no timer guesswork.
      controller.abort();
    },
    async (url, received) => {
      const started = Date.now();
      await assert.rejects(
        () =>
          deliverSettlementWebhook(url, signed, { allowInsecureHttp: true, 
            retries: 3,
            backoffMs: 10,
            timeoutMs: 30_000,
            signal: controller.signal,
          }),
        /webhook delivery aborted/,
      );
      const elapsed = Date.now() - started;
      assert.equal(received(), 1, "the abort must not be treated as a retryable network error");
      assert.ok(
        elapsed < 10_000,
        `abort must win over the 30s timeout, elapsed ${elapsed}ms`,
      );
    },
  );
});

test("abort on a retry attempt stops after the attempts already made", async () => {
  const signed = goldenWebhook();
  const controller = new AbortController();
  await withServer(
    (_req, res, received) => {
      if (received < 2) {
        boomHandler(_req, res);
      } else {
        // Second request: never respond, and abort from inside the
        // handler — its arrival is the event, replacing the old 150ms
        // guess that the retry would have happened by then.
        controller.abort();
      }
    },
    async (url, received) => {
      await assert.rejects(
        () =>
          deliverSettlementWebhook(url, signed, { allowInsecureHttp: true, 
            retries: 3,
            backoffMs: 20,
            timeoutMs: 30_000,
            signal: controller.signal,
          }),
        /webhook delivery aborted/,
      );
      assert.equal(
        received(),
        2,
        "the first (failed) attempt stands; the in-flight retry is aborted, not retried",
      );
    },
  );
});

test("abort during a Retry-After wait stops the loop", async () => {
  const signed = goldenWebhook();
  const controller = new AbortController();
  await withServer(
    (_req, res, received) => {
      if (received < 2) {
        // Abort once the 429 has been sent: the client is then entering
        // (or already in) the Retry-After wait this test exercises.
        abortOnResponseFinished(res, controller);
        res.writeHead(429, { "Retry-After": "30" });
        res.end("slow down");
      } else {
        okHandler(_req, res);
      }
    },
    async (url, received) => {
      const started = Date.now();
      await assert.rejects(
        () =>
          deliverSettlementWebhook(url, signed, { allowInsecureHttp: true, 
            retries: 3,
            backoffMs: 10,
            timeoutMs: 2000,
            signal: controller.signal,
          }),
        /webhook delivery aborted/,
      );
      const elapsed = Date.now() - started;
      assert.equal(received(), 1, "the Retry-After wait must be interruptible");
      assert.ok(
        elapsed < 10_000,
        `Retry-After 30s must not be waited out, elapsed ${elapsed}ms`,
      );
    },
  );
});

test("a signal that never aborts leaves the normal path untouched", async () => {
  const signed = goldenWebhook();
  const controller = new AbortController();
  await withServer(okHandler, async (url, received) => {
    const result = await deliverSettlementWebhook(url, signed, { allowInsecureHttp: true, 
      signal: controller.signal,
    });
    assert.deepEqual(result, { status: 200, attempts: 1 });
    assert.equal(received(), 1);
  });
});

test("retries still work when a signal is wired but never aborts", async () => {
  const signed = goldenWebhook();
  const controller = new AbortController();
  await withServer(
    (_req, res, received) => {
      if (received < 2) {
        boomHandler(_req, res);
      } else {
        okHandler(_req, res);
      }
    },
    async (url, received) => {
      const result = await deliverSettlementWebhook(url, signed, { allowInsecureHttp: true, 
        retries: 3,
        backoffMs: 5,
        timeoutMs: 2000,
        signal: controller.signal,
      });
      assert.deepEqual(result, { status: 200, attempts: 2 });
      assert.equal(received(), 2);
    },
  );
});

test("non-AbortSignal values are config errors before any request", async () => {
  const signed = goldenWebhook();
  await withServer(okHandler, async (url, received) => {
    for (const bad of [{}, "x", null, 123]) {
      await assert.rejects(
        () =>
          deliverSettlementWebhook(url, signed, { allowInsecureHttp: true, 
            signal: bad as unknown as AbortSignal,
          }),
        /cannot deliver settlement webhook: signal must be an AbortSignal/,
        `expected a config error for signal=${String(bad)}`,
      );
    }
    assert.equal(received(), 0, "a bad signal must fail before any request");
  });
});
