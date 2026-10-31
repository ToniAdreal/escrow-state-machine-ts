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
  SettlementEventDedupe,
} from "../src/index.js";
import type { SettlementReport } from "../src/index.js";

/**
 * Settlement webhook fan-out limits x `SettlementEventDedupe`
 * (backlog #758, the combination of #630 limits and #741 fan-out
 * dedupe).
 *
 * The limits file pins the cap and the deadline; the dedupe file pins
 * per-receiver first-sighting for a delivered fan-out. Neither says
 * what happens to receiver dedupe state when a fan-out is refused
 * outright, or when it only partly succeeds. Rules under test, with
 * one independent `SettlementEventDedupe` per endpoint and the
 * documented receiver order (verify the raw wire body first,
 * `checkAndRecord` only after a `true` verification, collapsed into
 * a local `receive()` helper):
 *  - an over-`maxEndpoints` batch is refused before any request:
 *    zero fetches reach any server, so all four receivers' dedupes
 *    stay empty — a refused batch records nothing anywhere
 *  - a 3-endpoint batch where one endpoint keeps returning 500 until
 *    its retries are exhausted: that endpoint fails alone, the other
 *    two endpoints' first deliveries are first sightings (each
 *    dedupe at size 1, re-delivery a duplicate), and the failed
 *    endpoint's dedupe stays empty — a failed delivery is not a
 *    recording, so the endpoint's later true delivery of the same
 *    eventId is still a first sighting
 */

const SECRET_A = "whsec_fanout_limits_dedupe_accounting";
const SECRET_B = "whsec_fanout_limits_dedupe_notify";
const SECRET_C = "whsec_fanout_limits_dedupe_ledger";
const SECRET_D = "whsec_fanout_limits_dedupe_audit";
const FIXED_NOW = "2026-10-31T14:58:00.000Z";

function goldenReport(): SettlementReport {
  const escrow = new Escrow("esc-fanout-limits-dedupe");
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
  body: string;
  signature: string;
}

interface TestServer {
  url: string;
  received: ReceivedRequest[];
  close: () => Promise<void>;
}

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<TestServer> {
  const received: ReceivedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        body: Buffer.concat(chunks).toString("utf8"),
        signature: String(req.headers["x-signature"] ?? ""),
      });
      handler(req, res);
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

const fail500 = (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(500, { "content-type": "application/json" });
  res.end("{}");
};

type ReceiveOutcome = "processed" | "duplicate" | "rejected";

/**
 * The documented receiver order: verify the raw wire body first; only
 * a verified delivery reaches `checkAndRecord`. A rejected delivery
 * never touches the dedupe store.
 */
function receive(
  raw: string,
  signature: string,
  dedupe: SettlementEventDedupe,
  secret: string,
): ReceiveOutcome {
  if (!verifySettlementWebhook(raw, signature, secret)) return "rejected";
  const { eventId } = JSON.parse(raw) as { eventId: string };
  return dedupe.checkAndRecord(eventId) ? "duplicate" : "processed";
}

async function closeAll(servers: TestServer[]): Promise<void> {
  for (const s of servers) await s.close();
}

test("over-maxEndpoints batch is refused before any request: all four dedupes stay empty", async () => {
  const servers = [
    await startServer(ok200),
    await startServer(ok200),
    await startServer(ok200),
    await startServer(ok200),
  ];
  const secrets = [SECRET_A, SECRET_B, SECRET_C, SECRET_D];
  try {
    await assert.rejects(
      () =>
        deliverSettlementWebhookToMany(
          goldenReport(),
          servers.map((s, i) => ({ url: s.url, secret: secrets[i] })),
          {
            allowInsecureHttp: true,
            backoffMs: 1,
            retries: 0,
            now: FIXED_NOW,
            maxEndpoints: 3,
          },
        ),
      /cannot deliver settlement webhook to many endpoints: 4 endpoints exceed maxEndpoints 3/,
    );
    // Zero fetches: no server saw a request, so no receiver could
    // have recorded anything for this event.
    for (const s of servers) assert.equal(s.received.length, 0);
    const dedupes = secrets.map(() => new SettlementEventDedupe());
    for (const dedupe of dedupes) assert.equal(dedupe.size, 0);
  } finally {
    await closeAll(servers);
  }
});

test("partial fan-out failure: successes record first sightings, the failed endpoint records nothing until its true delivery", async () => {
  const a = await startServer(ok200);
  const b = await startServer(ok200);
  // Starts failing; flipped to 200 below for the retry round, so the
  // same endpoint can later receive a true delivery of the same event.
  let failing = true;
  const c = await startServer((req, res) =>
    failing ? fail500(req, res) : ok200(req, res),
  );
  const servers = [a, b, c];
  const secrets = [SECRET_A, SECRET_B, SECRET_C];
  const eventId = "evt-fanout-limits-dedupe-1";
  try {
    const out = await deliverSettlementWebhookToMany(
      goldenReport(),
      servers.map((s, i) => ({ url: s.url, secret: secrets[i] })),
      {
        allowInsecureHttp: true,
        backoffMs: 1,
        jitterMs: 0,
        retries: 1,
        now: FIXED_NOW,
        eventId,
      },
    );
    assert.equal(out.delivered, 2);
    assert.equal(out.failed, 1);
    assert.deepEqual(
      out.results.map((r) => ({ ok: r.ok, attempts: r.attempts, status: r.status })),
      [
        { ok: true, attempts: 1, status: 200 },
        { ok: true, attempts: 1, status: 200 },
        { ok: false, attempts: 2, status: 500 },
      ],
    );
    assert.match(
      out.results[2].error ?? "",
      /failed after 2 attempts: server responded with status 500/,
    );
    // One attempt reached each healthy endpoint; the failing endpoint
    // was hit once per attempt (initial + 1 retry), all with 500s.
    assert.equal(a.received.length, 1);
    assert.equal(b.received.length, 1);
    assert.equal(c.received.length, 2);

    const dedupeA = new SettlementEventDedupe();
    const dedupeB = new SettlementEventDedupe();
    const dedupeC = new SettlementEventDedupe();
    // The two successful deliveries are first sightings, and
    // re-delivery to each is a duplicate — the failed endpoint's
    // failure did not disturb either receiver's state.
    assert.equal(
      receive(a.received[0].body, a.received[0].signature, dedupeA, SECRET_A),
      "processed",
    );
    assert.equal(dedupeA.size, 1);
    assert.equal(
      receive(a.received[0].body, a.received[0].signature, dedupeA, SECRET_A),
      "duplicate",
    );
    assert.equal(
      receive(b.received[0].body, b.received[0].signature, dedupeB, SECRET_B),
      "processed",
    );
    assert.equal(dedupeB.size, 1);
    assert.equal(
      receive(b.received[0].body, b.received[0].signature, dedupeB, SECRET_B),
      "duplicate",
    );
    // The failed endpoint's 500 deliveries were never accepted, so
    // its receiver recorded nothing: its dedupe is still empty.
    assert.equal(dedupeC.size, 0);

    // The endpoint recovers and receives a true delivery of the same
    // eventId: it is still a first sighting, not a duplicate.
    failing = false;
    const before = c.received.length;
    const retryOut = await deliverSettlementWebhookToMany(
      goldenReport(),
      [{ url: c.url, secret: SECRET_C }],
      {
        allowInsecureHttp: true,
        backoffMs: 1,
        retries: 0,
        now: FIXED_NOW,
        eventId,
      },
    );
    assert.equal(retryOut.delivered, 1);
    assert.equal(retryOut.failed, 0);
    assert.equal(c.received.length, before + 1);
    const trueDelivery = c.received[c.received.length - 1];
    assert.equal(JSON.parse(trueDelivery.body).eventId, eventId);
    assert.equal(
      receive(trueDelivery.body, trueDelivery.signature, dedupeC, SECRET_C),
      "processed",
    );
    assert.equal(dedupeC.size, 1);
    assert.equal(
      receive(trueDelivery.body, trueDelivery.signature, dedupeC, SECRET_C),
      "duplicate",
    );
  } finally {
    await closeAll(servers);
  }
});
