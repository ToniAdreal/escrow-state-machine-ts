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
  parseRetryAfter,
  verifySettlementWebhook,
} from "../src/index.js";
import type { SettlementWebhook } from "../src/index.js";

const SECRET = "whsec_test_settlement_delivery_20261006";
const FIXED_NOW = "2026-10-06T16:00:00.000Z";

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
  const escrow = new Escrow("esc-delivery");
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

interface ReceivedRequest {
  method: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * Spin up a local HTTP server on 127.0.0.1:0, run the test against it, then
 * tear it down (including never-responding connections).
 */
async function withServer(
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    received: ReceivedRequest[],
  ) => void,
  run: (url: string, received: ReceivedRequest[]) => Promise<void>,
): Promise<void> {
  const received: ReceivedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        method: req.method,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      handler(req, res, received);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}/webhook`, received);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("200 success: POSTs JSON with X-Signature matching buildSettlementWebhook", async () => {
  const signed = goldenWebhook();
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    },
    async (url, received) => {
      const result = await deliverSettlementWebhook(url, signed);
      assert.deepEqual(result, { status: 200, attempts: 1 });
      assert.equal(received.length, 1);
      const [req] = received;
      assert.equal(req.method, "POST");
      assert.equal(req.headers["content-type"], "application/json");
      assert.equal(req.headers["x-signature"], signed.signature);
      // The wire body is byte-identical to what was signed: the receiver can
      // verify it over the raw bytes.
      assert.equal(req.body, JSON.stringify(signed.payload));
      assert.ok(
        verifySettlementWebhook(req.body, String(req.headers["x-signature"]), SECRET),
      );
    },
  );
});

test("retries 5xx with backoff: two 500s then 200 succeeds on attempt 3", async () => {
  const signed = goldenWebhook();
  await withServer(
    (_req, res, received) => {
      if (received.length < 3) {
        res.writeHead(500);
        res.end("boom");
      } else {
        res.writeHead(200);
        res.end("{}");
      }
    },
    async (url, received) => {
      const result = await deliverSettlementWebhook(url, signed, {
        retries: 3,
        backoffMs: 5,
        timeoutMs: 5000,
      });
      assert.deepEqual(result, { status: 200, attempts: 3 });
      assert.equal(received.length, 3);
      // Every attempt carries the same signature over the same body.
      for (const req of received) {
        assert.equal(req.headers["x-signature"], signed.signature);
        assert.equal(req.body, JSON.stringify(signed.payload));
      }
    },
  );
});

test("400 is not retried", async () => {
  const signed = goldenWebhook();
  await withServer(
    (_req, res) => {
      res.writeHead(400);
      res.end("bad request");
    },
    async (url, received) => {
      await assert.rejects(
        () => deliverSettlementWebhook(url, signed, { retries: 3, backoffMs: 1 }),
        /failed with status 400 \(not retried\)/,
      );
      assert.equal(received.length, 1);
    },
  );
});

test("timeout throws a clear error after exhausting retries", async () => {
  const signed = goldenWebhook();
  await withServer(
    () => {
      // Never respond: the client's per-attempt timeout must fire.
    },
    async (url, received) => {
      const started = Date.now();
      await assert.rejects(
        () =>
          deliverSettlementWebhook(url, signed, {
            retries: 1,
            backoffMs: 5,
            timeoutMs: 80,
          }),
        /failed after 2 attempts: webhook delivery timed out after 80ms/,
      );
      assert.equal(received.length, 2);
      assert.ok(
        Date.now() - started < 10_000,
        "delivery must surface timeouts, never hang",
      );
    },
  );
});

test("persistent 500 exhausts retries then throws with the last status", async () => {
  const signed = goldenWebhook();
  await withServer(
    (_req, res) => {
      res.writeHead(500);
      res.end("always broken");
    },
    async (url, received) => {
      await assert.rejects(
        () =>
          deliverSettlementWebhook(url, signed, {
            retries: 2,
            backoffMs: 5,
            timeoutMs: 5000,
          }),
        /failed after 3 attempts: server responded with status 500/,
      );
      assert.equal(received.length, 3);
    },
  );
});

test("connection refused is retried as a network error", async () => {
  // Grab a port and release it so the address is (transiently) dead.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  probe.closeAllConnections();
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const signed = goldenWebhook();
  await assert.rejects(
    () =>
      deliverSettlementWebhook(`http://127.0.0.1:${port}/webhook`, signed, {
        retries: 1,
        backoffMs: 1,
        timeoutMs: 2000,
      }),
    /failed after 2 attempts/,
  );
});

test("invalid delivery options throw config errors before any request", async () => {
  const signed = goldenWebhook();
  const deadUrl = "http://127.0.0.1:9/webhook";
  await assert.rejects(
    () => deliverSettlementWebhook(deadUrl, signed, { retries: -1 }),
    /cannot deliver settlement webhook: retries must be a non-negative integer/,
  );
  await assert.rejects(
    () => deliverSettlementWebhook(deadUrl, signed, { retries: 1.5 }),
    /cannot deliver settlement webhook: retries must be a non-negative integer/,
  );
  await assert.rejects(
    () => deliverSettlementWebhook(deadUrl, signed, { backoffMs: -1 }),
    /cannot deliver settlement webhook: backoffMs must be a non-negative number/,
  );
  await assert.rejects(
    () => deliverSettlementWebhook(deadUrl, signed, { timeoutMs: 0 }),
    /cannot deliver settlement webhook: timeoutMs must be a positive number/,
  );
  await assert.rejects(
    () => deliverSettlementWebhook("not a url", signed),
    /cannot deliver settlement webhook: invalid url/,
  );
  await assert.rejects(
    () => deliverSettlementWebhook("ftp://example.com/hook", signed),
    /cannot deliver settlement webhook: unsupported protocol/,
  );
});

test("backoff between retries is exponential", async () => {
  const signed = goldenWebhook();
  await withServer(
    (_req, res) => {
      res.writeHead(500);
      res.end("boom");
    },
    async (url, received) => {
      const started = Date.now();
      await assert.rejects(
        () =>
          deliverSettlementWebhook(url, signed, {
            retries: 2,
            backoffMs: 60,
            timeoutMs: 2000,
          }),
        /failed after 3 attempts/,
      );
      const elapsed = Date.now() - started;
      // Expected backoff sleeps: 60ms + 120ms = 180ms. Generous lower bound
      // so CI jitter cannot flake it; the point is both sleeps happened.
      assert.ok(
        elapsed >= 150,
        `expected exponential backoff sleeps (60+120ms), elapsed ${elapsed}ms`,
      );
      assert.equal(received.length, 3);
    },
  );
});

test("429 is retried: 429 then 200 succeeds on attempt 2", async () => {
  const signed = goldenWebhook();
  await withServer(
    (_req, res, received) => {
      if (received.length < 2) {
        res.writeHead(429);
        res.end("slow down");
      } else {
        res.writeHead(200);
        res.end("{}");
      }
    },
    async (url, received) => {
      const result = await deliverSettlementWebhook(url, signed, {
        retries: 3,
        backoffMs: 1,
        timeoutMs: 5000,
      });
      assert.deepEqual(result, { status: 200, attempts: 2 });
      assert.equal(received.length, 2);
    },
  );
});

test("persistent 429 exhausts retries then throws with the last status", async () => {
  const signed = goldenWebhook();
  await withServer(
    (_req, res) => {
      res.writeHead(429);
      res.end("still busy");
    },
    async (url, received) => {
      await assert.rejects(
        () =>
          deliverSettlementWebhook(url, signed, {
            retries: 2,
            backoffMs: 1,
            timeoutMs: 5000,
          }),
        /failed after 3 attempts: server responded with status 429/,
      );
      assert.equal(received.length, 3);
    },
  );
});

test("429 Retry-After seconds are honored over backoff", async () => {
  const signed = goldenWebhook();
  await withServer(
    (_req, res, received) => {
      if (received.length < 2) {
        res.writeHead(429, { "Retry-After": "1" });
        res.end("slow down");
      } else {
        res.writeHead(200);
        res.end("{}");
      }
    },
    async (url, received) => {
      const started = Date.now();
      const result = await deliverSettlementWebhook(url, signed, {
        retries: 3,
        // Backoff would wait ~1ms; Retry-After says 1s. The server wins.
        backoffMs: 1,
        timeoutMs: 5000,
      });
      const elapsed = Date.now() - started;
      assert.deepEqual(result, { status: 200, attempts: 2 });
      assert.equal(received.length, 2);
      assert.ok(
        elapsed >= 900,
        `expected Retry-After 1s to be honored, elapsed ${elapsed}ms`,
      );
    },
  );
});

test("429 Retry-After HTTP-date is honored", async () => {
  const signed = goldenWebhook();
  await withServer(
    (_req, res, received) => {
      if (received.length < 2) {
        // ~1.5s in the future; HTTP-dates truncate to whole seconds, so the
        // parsed delta lands somewhere between ~0.5s and ~1.5s.
        const retryAt = new Date(Date.now() + 1500).toUTCString();
        res.writeHead(429, { "Retry-After": retryAt });
        res.end("slow down");
      } else {
        res.writeHead(200);
        res.end("{}");
      }
    },
    async (url, received) => {
      const started = Date.now();
      const result = await deliverSettlementWebhook(url, signed, {
        retries: 3,
        backoffMs: 1,
        timeoutMs: 5000,
      });
      const elapsed = Date.now() - started;
      assert.deepEqual(result, { status: 200, attempts: 2 });
      assert.equal(received.length, 2);
      assert.ok(
        elapsed >= 400,
        `expected Retry-After HTTP-date to be honored, elapsed ${elapsed}ms`,
      );
    },
  );
});

test("unparsable Retry-After falls back to exponential backoff", async () => {
  const signed = goldenWebhook();
  await withServer(
    (_req, res, received) => {
      if (received.length < 3) {
        res.writeHead(429, { "Retry-After": "banana" });
        res.end("slow down");
      } else {
        res.writeHead(200);
        res.end("{}");
      }
    },
    async (url, received) => {
      const started = Date.now();
      const result = await deliverSettlementWebhook(url, signed, {
        retries: 2,
        // Backoff sleeps: 50ms + 100ms = 150ms. A parsed "banana" would have
        // blown the schedule; falling back keeps delivery fast.
        backoffMs: 50,
        timeoutMs: 5000,
      });
      const elapsed = Date.now() - started;
      assert.deepEqual(result, { status: 200, attempts: 3 });
      assert.equal(received.length, 3);
      assert.ok(
        elapsed < 10_000,
        `fallback backoff should stay fast, elapsed ${elapsed}ms`,
      );
    },
  );
});

test("past Retry-After HTTP-date retries immediately (no backoff wait)", async () => {
  const signed = goldenWebhook();
  await withServer(
    (_req, res, received) => {
      if (received.length < 2) {
        const past = new Date(Date.now() - 30_000).toUTCString();
        res.writeHead(429, { "Retry-After": past });
        res.end("slow down");
      } else {
        res.writeHead(200);
        res.end("{}");
      }
    },
    async (url, received) => {
      const started = Date.now();
      const result = await deliverSettlementWebhook(url, signed, {
        retries: 3,
        // A past date must not trigger a 2000ms backoff sleep.
        backoffMs: 2000,
        timeoutMs: 5000,
      });
      const elapsed = Date.now() - started;
      assert.deepEqual(result, { status: 200, attempts: 2 });
      assert.equal(received.length, 2);
      assert.ok(
        elapsed < 1500,
        `past Retry-After should retry immediately, elapsed ${elapsed}ms`,
      );
    },
  );
});

test("parseRetryAfter: seconds, HTTP-date, and garbage", () => {
  const now = Date.now();
  assert.equal(parseRetryAfter("1", now), 1000);
  assert.equal(parseRetryAfter("0", now), 0);
  assert.equal(parseRetryAfter("  30 ", now), 30_000);
  const future = new Date(now + 5000).toUTCString();
  const delta = parseRetryAfter(future, now);
  assert.ok(
    delta !== undefined && delta > 4000 && delta <= 5000,
    `HTTP-date delta ${delta}ms`,
  );
  assert.equal(parseRetryAfter(new Date(now - 1000).toUTCString(), now), 0);
  assert.equal(parseRetryAfter("banana", now), undefined);
  assert.equal(parseRetryAfter("-5", now), undefined);
  assert.equal(parseRetryAfter(null, now), undefined);
  assert.equal(parseRetryAfter(undefined, now), undefined);
});
