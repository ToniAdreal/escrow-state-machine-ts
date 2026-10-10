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
  verifySettlementWebhook,
} from "../src/index.js";
import type { SettlementReport } from "../src/index.js";

/**
 * Settlement webhook multi-endpoint fan-out (backlog #156).
 *
 * Rules under test:
 *  - one logical settlement event is fanned out concurrently to every
 *    endpoint; the payload body is built once (shared eventId + at) and
 *    signed independently per endpoint with that endpoint's own secret
 *  - each endpoint reuses the single-endpoint delivery logic, so retry
 *    budgets are counted per endpoint and reported attempts are real
 *  - results come back in input order with aggregate delivered/failed
 *    counts (delivered + failed === endpoints.length); one endpoint's
 *    failure never blocks or fails the others
 *  - call-level configuration errors throw before any request: empty /
 *    non-array endpoints, invalid global delivery options
 *  - every test uses local 127.0.0.1 servers: no external network
 */

const SECRET_A = "whsec_fanout_accounting_20261010";
const SECRET_B = "whsec_fanout_notify_20261010";
const FIXED_NOW = "2026-10-10T11:58:00.000Z";

function goldenReport(): SettlementReport {
  const escrow = new Escrow("esc-fanout");
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
const always500 = (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(500);
  res.end("boom");
};

test("two endpoints both 200: shared body, per-endpoint signatures, aggregate counts", async () => {
  const a = await startServer(ok200);
  const b = await startServer(ok200);
  try {
    const out = await deliverSettlementWebhookToMany(
      goldenReport(),
      [
        { url: a.url, secret: SECRET_A },
        { url: b.url, secret: SECRET_B },
      ],
      { backoffMs: 1, now: FIXED_NOW, eventId: "evt-fanout-1" },
    );
    assert.equal(out.delivered, 2);
    assert.equal(out.failed, 0);
    assert.equal(out.delivered + out.failed, 2);
    assert.deepEqual(out.results, [
      { url: a.url, ok: true, attempts: 1, status: 200 },
      { url: b.url, ok: true, attempts: 1, status: 200 },
    ]);
    assert.equal(a.received.length, 1);
    assert.equal(b.received.length, 1);
    const [reqA] = a.received;
    const [reqB] = b.received;
    // Same logical event: byte-identical bodies (shared eventId + at)…
    assert.equal(reqA.body, reqB.body);
    assert.equal(JSON.parse(reqA.body).eventId, "evt-fanout-1");
    assert.equal(JSON.parse(reqA.body).at, FIXED_NOW);
    // …but independently signed per endpoint, each verifiable only
    // under its own secret.
    assert.notEqual(reqA.headers["x-signature"], reqB.headers["x-signature"]);
    assert.ok(verifySettlementWebhook(reqA.body, String(reqA.headers["x-signature"]), SECRET_A));
    assert.ok(verifySettlementWebhook(reqB.body, String(reqB.headers["x-signature"]), SECRET_B));
  } finally {
    await a.close();
    await b.close();
  }
});

test("secrets do not cross: A's secret cannot verify B's delivery", async () => {
  const a = await startServer(ok200);
  const b = await startServer(ok200);
  try {
    await deliverSettlementWebhookToMany(
      goldenReport(),
      [
        { url: a.url, secret: SECRET_A },
        { url: b.url, secret: SECRET_B },
      ],
      { backoffMs: 1, now: FIXED_NOW },
    );
    const [reqA] = a.received;
    const [reqB] = b.received;
    assert.equal(verifySettlementWebhook(reqB.body, String(reqB.headers["x-signature"]), SECRET_A), false);
    assert.equal(verifySettlementWebhook(reqA.body, String(reqA.headers["x-signature"]), SECRET_B), false);
  } finally {
    await a.close();
    await b.close();
  }
});

test("one endpoint persistent 500, other succeeds: input order preserved, failure isolated", async () => {
  const a = await startServer(always500);
  const b = await startServer(ok200);
  try {
    const out = await deliverSettlementWebhookToMany(
      goldenReport(),
      [
        { url: a.url, secret: SECRET_A },
        { url: b.url, secret: SECRET_B },
      ],
      { retries: 1, backoffMs: 1, now: FIXED_NOW },
    );
    assert.equal(out.results.length, 2);
    assert.equal(out.results[0].url, a.url);
    assert.equal(out.results[0].ok, false);
    assert.equal(out.results[0].attempts, 2, "initial attempt + 1 retry");
    assert.equal(out.results[0].status, 500);
    assert.match(out.results[0].error ?? "", /failed after 2 attempts: server responded with status 500/);
    assert.deepEqual(out.results[1], { url: b.url, ok: true, attempts: 1, status: 200 });
    assert.equal(out.delivered, 1);
    assert.equal(out.failed, 1);
    assert.equal(out.delivered + out.failed, 2);
    assert.equal(a.received.length, 2);
    assert.equal(b.received.length, 1, "healthy endpoint was not retried or blocked");
  } finally {
    await a.close();
    await b.close();
  }
});

test("attempts are counted per endpoint independently", async () => {
  const a = await startServer((_req, res, received) => {
    if (received.length < 3) {
      res.writeHead(500);
      res.end("boom");
    } else {
      res.writeHead(200);
      res.end("{}");
    }
  });
  const b = await startServer((_req, res, received) => {
    if (received.length < 2) {
      res.writeHead(500);
      res.end("boom");
    } else {
      res.writeHead(200);
      res.end("{}");
    }
  });
  try {
    const out = await deliverSettlementWebhookToMany(
      goldenReport(),
      [
        { url: a.url, secret: SECRET_A },
        { url: b.url, secret: SECRET_B },
      ],
      { backoffMs: 1, now: FIXED_NOW },
    );
    assert.deepEqual(out.results, [
      { url: a.url, ok: true, attempts: 3, status: 200 },
      { url: b.url, ok: true, attempts: 2, status: 200 },
    ]);
    assert.equal(a.received.length, 3);
    assert.equal(b.received.length, 2);
    assert.equal(out.delivered, 2);
  } finally {
    await a.close();
    await b.close();
  }
});

test("empty or non-array endpoints throw a configuration error before any request", async () => {
  const a = await startServer(ok200);
  try {
    await assert.rejects(
      () => deliverSettlementWebhookToMany(goldenReport(), [], { now: FIXED_NOW }),
      /cannot deliver settlement webhook to many endpoints: endpoints must be a non-empty array/,
    );
    await assert.rejects(
      () =>
        deliverSettlementWebhookToMany(
          goldenReport(),
          undefined as unknown as [],
          { now: FIXED_NOW },
        ),
      /endpoints must be a non-empty array/,
    );
    assert.equal(a.received.length, 0);
  } finally {
    await a.close();
  }
});

test("invalid global delivery options throw before any request", async () => {
  const a = await startServer(ok200);
  try {
    await assert.rejects(
      () =>
        deliverSettlementWebhookToMany(
          goldenReport(),
          [{ url: a.url, secret: SECRET_A }],
          { retries: -1, now: FIXED_NOW },
        ),
      /cannot deliver settlement webhook: retries must be a non-negative integer/,
    );
    assert.equal(a.received.length, 0, "global config errors are not per-endpoint outcomes");
  } finally {
    await a.close();
  }
});

test("invalid URL endpoint marks only itself failed with attempts 0", async () => {
  const b = await startServer(ok200);
  try {
    const out = await deliverSettlementWebhookToMany(
      goldenReport(),
      [
        { url: "not a url", secret: SECRET_A },
        { url: b.url, secret: SECRET_B },
      ],
      { backoffMs: 1, now: FIXED_NOW },
    );
    assert.equal(out.results[0].ok, false);
    assert.equal(out.results[0].attempts, 0, "no request was attempted");
    assert.match(out.results[0].error ?? "", /cannot deliver settlement webhook: invalid url/);
    assert.deepEqual(out.results[1], { url: b.url, ok: true, attempts: 1, status: 200 });
    assert.equal(out.delivered, 1);
    assert.equal(out.failed, 1);
    assert.equal(b.received.length, 1);
  } finally {
    await b.close();
  }
});

test("empty-secret endpoint marks only itself failed with attempts 0", async () => {
  const a = await startServer(ok200);
  const b = await startServer(ok200);
  try {
    const out = await deliverSettlementWebhookToMany(
      goldenReport(),
      [
        { url: a.url, secret: "" },
        { url: b.url, secret: SECRET_B },
      ],
      { backoffMs: 1, now: FIXED_NOW },
    );
    assert.equal(out.results[0].ok, false);
    assert.equal(out.results[0].attempts, 0);
    assert.match(out.results[0].error ?? "", /signing secret must not be empty/);
    assert.deepEqual(out.results[1], { url: b.url, ok: true, attempts: 1, status: 200 });
    assert.equal(a.received.length, 0);
    assert.equal(out.delivered, 1);
    assert.equal(out.failed, 1);
  } finally {
    await a.close();
    await b.close();
  }
});

test("per-endpoint retries override applies only to that endpoint", async () => {
  const a = await startServer(always500);
  const b = await startServer(always500);
  try {
    const out = await deliverSettlementWebhookToMany(
      goldenReport(),
      [
        { url: a.url, secret: SECRET_A, retries: 0 },
        { url: b.url, secret: SECRET_B },
      ],
      { retries: 2, backoffMs: 1, now: FIXED_NOW },
    );
    assert.equal(out.results[0].attempts, 1, "override: no retries");
    assert.equal(out.results[0].ok, false);
    assert.equal(out.results[1].attempts, 3, "call-level retries apply");
    assert.equal(out.results[1].ok, false);
    assert.equal(a.received.length, 1);
    assert.equal(b.received.length, 3);
    assert.equal(out.failed, 2);
    assert.equal(out.delivered + out.failed, 2);
  } finally {
    await a.close();
    await b.close();
  }
});

test("per-endpoint invalid override marks only itself failed with attempts 0", async () => {
  const a = await startServer(ok200);
  const b = await startServer(ok200);
  try {
    const out = await deliverSettlementWebhookToMany(
      goldenReport(),
      [
        { url: a.url, secret: SECRET_A, retries: -1 },
        { url: b.url, secret: SECRET_B },
      ],
      { backoffMs: 1, now: FIXED_NOW },
    );
    assert.equal(out.results[0].ok, false);
    assert.equal(out.results[0].attempts, 0);
    assert.match(out.results[0].error ?? "", /retries must be a non-negative integer/);
    assert.deepEqual(out.results[1], { url: b.url, ok: true, attempts: 1, status: 200 });
    assert.equal(a.received.length, 0);
    assert.equal(out.delivered, 1);
    assert.equal(out.failed, 1);
  } finally {
    await a.close();
    await b.close();
  }
});

test("400 endpoint is not retried and reports status 400 while the other succeeds", async () => {
  const a = await startServer((_req, res) => {
    res.writeHead(400);
    res.end("bad request");
  });
  const b = await startServer(ok200);
  try {
    const out = await deliverSettlementWebhookToMany(
      goldenReport(),
      [
        { url: a.url, secret: SECRET_A },
        { url: b.url, secret: SECRET_B },
      ],
      { retries: 3, backoffMs: 1, now: FIXED_NOW },
    );
    assert.equal(out.results[0].ok, false);
    assert.equal(out.results[0].attempts, 1);
    assert.equal(out.results[0].status, 400);
    assert.match(out.results[0].error ?? "", /failed with status 400 \(not retried\)/);
    assert.deepEqual(out.results[1], { url: b.url, ok: true, attempts: 1, status: 200 });
    assert.equal(a.received.length, 1);
    assert.equal(out.delivered, 1);
    assert.equal(out.failed, 1);
  } finally {
    await a.close();
    await b.close();
  }
});
