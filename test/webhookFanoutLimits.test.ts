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
  calculateDeposit,
  deliverSettlementWebhookToMany,
} from "../src/index.js";
import type { SettlementReport } from "../src/index.js";

/**
 * Settlement webhook fan-out limits (backlog #630):
 * `DeliverSettlementWebhookToManyOptions.maxEndpoints` and
 * `overallDeadlineMs`.
 *
 * Rules under test:
 *  - maxEndpoints caps the fan-out size: more endpoints than the cap
 *    throws a caller configuration error before any request (zero
 *    fetch calls); an invalid cap throws the same way; exactly the
 *    cap passes
 *  - overallDeadlineMs caps the whole call's wall-clock time: a
 *    hanging endpoint is stopped by the deadline (not by the
 *    per-attempt timeout), reports the deadline timeout error, and
 *    the aggregate carries deadlineExceeded: true; endpoints that
 *    already completed keep their results
 *  - a per-endpoint signal override does NOT exempt an endpoint from
 *    the deadline; a caller abort on its own signal, with the deadline
 *    not fired, keeps the plain abort text and deadlineExceeded false
 *  - every test uses local 127.0.0.1 servers: no external network
 */

const SECRET_A = "whsec_fanout_limits_accounting_20261026";
const SECRET_B = "whsec_fanout_limits_notify_20261026";
const SECRET_C = "whsec_fanout_limits_reconcile_20261026";
const FIXED_NOW = "2026-10-26T15:28:00.000Z";

function goldenReport(): SettlementReport {
  const escrow = new Escrow("esc-fanout-limits");
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

interface ReceivedRequest {
  method: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface TestServer {
  url: string;
  received: ReceivedRequest[];
  close: () => Promise<void>;
}

async function startServer(
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    received: ReceivedRequest[],
  ) => void,
): Promise<TestServer> {
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
  return {
    url: `http://127.0.0.1:${address.port}/webhook`,
    received,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const ok200 = (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
};

// Never responds: the request hangs until the caller aborts it (or
// the per-attempt timeout fires, whichever comes first).
const hangForever = (_req: IncomingMessage, _res: ServerResponse) => {};

const BASE_OPTS = {
  allowInsecureHttp: true,
  backoffMs: 1,
  retries: 0,
  now: FIXED_NOW,
} as const;

test("maxEndpoints exceeded throws before any request (zero fetch calls)", async () => {
  const a = await startServer(ok200);
  const b = await startServer(ok200);
  const c = await startServer(ok200);
  try {
    await assert.rejects(
      () =>
        deliverSettlementWebhookToMany(
          goldenReport(),
          [
            { url: a.url, secret: SECRET_A },
            { url: b.url, secret: SECRET_B },
            { url: c.url, secret: SECRET_C },
          ],
          { ...BASE_OPTS, maxEndpoints: 2 },
        ),
      /cannot deliver settlement webhook to many endpoints: 3 endpoints exceed maxEndpoints 2/,
    );
    assert.equal(a.received.length, 0);
    assert.equal(b.received.length, 0);
    assert.equal(c.received.length, 0);
  } finally {
    await a.close();
    await b.close();
    await c.close();
  }
});

test("maxEndpoints equal to the endpoint count passes, deadlineExceeded false", async () => {
  const a = await startServer(ok200);
  const b = await startServer(ok200);
  try {
    const out = await deliverSettlementWebhookToMany(
      goldenReport(),
      [
        { url: a.url, secret: SECRET_A },
        { url: b.url, secret: SECRET_B },
      ],
      { ...BASE_OPTS, maxEndpoints: 2 },
    );
    assert.deepEqual(out.results, [
      { url: a.url, ok: true, attempts: 1, status: 200 },
      { url: b.url, ok: true, attempts: 1, status: 200 },
    ]);
    assert.equal(out.delivered, 2);
    assert.equal(out.failed, 0);
    assert.equal(out.deadlineExceeded, false);
  } finally {
    await a.close();
    await b.close();
  }
});

test("invalid maxEndpoints values throw before any request", async () => {
  const a = await startServer(ok200);
  try {
    for (const bad of [0, -1, 1.5, Number.NaN, "2"]) {
      await assert.rejects(
        () =>
          deliverSettlementWebhookToMany(
            goldenReport(),
            [{ url: a.url, secret: SECRET_A }],
            {
              ...BASE_OPTS,
              maxEndpoints: bad as unknown as number,
            },
          ),
        /cannot deliver settlement webhook to many endpoints: maxEndpoints must be a positive integer/,
      );
    }
    assert.equal(a.received.length, 0);
  } finally {
    await a.close();
  }
});

test("invalid overallDeadlineMs values throw before any request", async () => {
  const a = await startServer(ok200);
  try {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        () =>
          deliverSettlementWebhookToMany(
            goldenReport(),
            [{ url: a.url, secret: SECRET_A }],
            {
              ...BASE_OPTS,
              overallDeadlineMs: bad,
            },
          ),
        /cannot deliver settlement webhook to many endpoints: overallDeadlineMs must be a positive number/,
      );
    }
    assert.equal(a.received.length, 0);
  } finally {
    await a.close();
  }
});

test("overallDeadlineMs stops a hanging endpoint, keeps completed results, deadlineExceeded true", async () => {
  const fast = await startServer(ok200);
  const hanging = await startServer(hangForever);
  try {
    const started = Date.now();
    const out = await deliverSettlementWebhookToMany(
      goldenReport(),
      [
        { url: fast.url, secret: SECRET_A },
        { url: hanging.url, secret: SECRET_B },
      ],
      {
        ...BASE_OPTS,
        timeoutMs: 10_000,
        overallDeadlineMs: 100,
      },
    );
    const elapsed = Date.now() - started;
    assert.ok(
      elapsed < 5000,
      `deadline must stop the call, not the 10s per-attempt timeout (elapsed ${elapsed}ms)`,
    );
    assert.deepEqual(out.results[0], {
      url: fast.url,
      ok: true,
      attempts: 1,
      status: 200,
    });
    assert.deepEqual(out.results[1], {
      url: hanging.url,
      ok: false,
      attempts: 1,
      error:
        "settlement webhook delivery timed out: overall deadline of 100ms exceeded",
    });
    assert.equal(out.delivered, 1);
    assert.equal(out.failed, 1);
    assert.equal(out.deadlineExceeded, true);
    assert.equal(fast.received.length, 1);
    assert.equal(hanging.received.length, 1);
  } finally {
    await fast.close();
    await hanging.close();
  }
});

test("generous overallDeadlineMs does not trip: deadlineExceeded false", async () => {
  const a = await startServer(ok200);
  const b = await startServer(ok200);
  try {
    const out = await deliverSettlementWebhookToMany(
      goldenReport(),
      [
        { url: a.url, secret: SECRET_A },
        { url: b.url, secret: SECRET_B },
      ],
      { ...BASE_OPTS, overallDeadlineMs: 10_000 },
    );
    assert.equal(out.delivered, 2);
    assert.equal(out.failed, 0);
    assert.equal(out.deadlineExceeded, false);
  } finally {
    await a.close();
    await b.close();
  }
});

test("per-endpoint signal override does not exempt an endpoint from the deadline", async () => {
  const hanging = await startServer(hangForever);
  const ownSignal = new AbortController().signal; // never aborted
  try {
    const out = await deliverSettlementWebhookToMany(
      goldenReport(),
      [{ url: hanging.url, secret: SECRET_A, signal: ownSignal }],
      {
        ...BASE_OPTS,
        timeoutMs: 10_000,
        overallDeadlineMs: 100,
      },
    );
    assert.deepEqual(out.results, [
      {
        url: hanging.url,
        ok: false,
        attempts: 1,
        error:
          "settlement webhook delivery timed out: overall deadline of 100ms exceeded",
      },
    ]);
    assert.equal(out.delivered, 0);
    assert.equal(out.failed, 1);
    assert.equal(out.deadlineExceeded, true);
  } finally {
    await hanging.close();
  }
});

test("caller abort with the deadline not fired keeps the plain abort text", async () => {
  const aborted = await startServer(ok200);
  const healthy = await startServer(ok200);
  const controller = new AbortController();
  controller.abort();
  try {
    const out = await deliverSettlementWebhookToMany(
      goldenReport(),
      [
        { url: aborted.url, secret: SECRET_A, signal: controller.signal },
        { url: healthy.url, secret: SECRET_B },
      ],
      { ...BASE_OPTS, overallDeadlineMs: 5000 },
    );
    assert.deepEqual(out.results[0], {
      url: aborted.url,
      ok: false,
      attempts: 0,
      error: "webhook delivery aborted",
    });
    assert.deepEqual(out.results[1], {
      url: healthy.url,
      ok: true,
      attempts: 1,
      status: 200,
    });
    assert.equal(out.delivered, 1);
    assert.equal(out.failed, 1);
    assert.equal(out.deadlineExceeded, false);
    assert.equal(aborted.received.length, 0);
  } finally {
    await aborted.close();
    await healthy.close();
  }
});
