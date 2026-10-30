import test from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementWebhook,
  calculateDeposit,
  deliverSettlementWebhookToMany,
  verifySettlementWebhook,
  SettlementEventDedupe,
} from "../src/index.js";
import type { SettlementReport } from "../src/index.js";

/**
 * Settlement webhook fan-out x `SettlementEventDedupe` endpoint
 * isolation (backlog #741, the escrow-side peer of dataquest #740).
 *
 * The single-endpoint receiver flow (#725) pins verify-then-record for
 * one receiver. It says nothing about a fan-out, where the SAME
 * eventId is delivered to several endpoints at once: dedupe state must
 * be per receiver, never shared across endpoints, or one endpoint's
 * first sighting would falsely mark another endpoint's first delivery
 * as a duplicate. Rules under test, with one independent
 * `SettlementEventDedupe` per endpoint and the documented receiver
 * order (verify the raw wire body first, `checkAndRecord` only after
 * a `true` verification, collapsed into a local `receive()` helper):
 *  - one fan-out to 4 endpoints: every receiver accepts its own
 *    per-endpoint-signed copy as a first sighting, each dedupe at
 *    size 1, even though all four copies share one eventId
 *  - re-delivering each recorded wire body to its own endpoint
 *    reports duplicate on all four receivers, with hits/misses
 *    counting the flow per receiver
 *  - endpoint isolation, the core of this item: an eventId recorded
 *    at endpoint A alone does NOT make the same eventId a duplicate
 *    at endpoint B — B's first delivery of that eventId is still
 *    accepted, and only then do re-deliveries to A and to B both
 *    report duplicate, while untouched endpoints C and D stay at
 *    size 0
 *  - a tampered delivery to one endpoint verifies false, records
 *    nothing anywhere, and the true delivery to that endpoint is
 *    still a first sighting
 *  - a wire body recorded for endpoint A, presented to endpoint B's
 *    receiver, is rejected (it is signed with A's secret, not B's)
 *    and leaves B's dedupe untouched, so B's true delivery of the
 *    same eventId is still accepted
 */

const SECRET_A = "whsec_fanout_dedupe_accounting";
const SECRET_B = "whsec_fanout_dedupe_notify";
const SECRET_C = "whsec_fanout_dedupe_ledger";
const SECRET_D = "whsec_fanout_dedupe_audit";
const FIXED_NOW = "2026-10-10T11:58:00.000Z";
const TAMPERED_NOW = "2026-10-10T11:58:01.000Z";

function goldenReport(): SettlementReport {
  const escrow = new Escrow("esc-fanout-dedupe");
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

async function startServer(): Promise<TestServer> {
  const received: ReceivedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        body: Buffer.concat(chunks).toString("utf8"),
        signature: String(req.headers["x-signature"] ?? ""),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
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

const SECRETS = [SECRET_A, SECRET_B, SECRET_C, SECRET_D];

async function fanOut(eventId: string): Promise<{
  servers: TestServer[];
  bodies: string[];
  signatures: string[];
}> {
  const servers = [await startServer(), await startServer(), await startServer(), await startServer()];
  try {
    const out = await deliverSettlementWebhookToMany(
      goldenReport(),
      servers.map((s, i) => ({ url: s.url, secret: SECRETS[i] })),
      { allowInsecureHttp: true, backoffMs: 1, now: FIXED_NOW, eventId },
    );
    assert.equal(out.delivered, 4);
    assert.equal(out.failed, 0);
    return {
      servers,
      bodies: servers.map((s) => s.received[0].body),
      signatures: servers.map((s) => s.received[0].signature),
    };
  } catch (err) {
    for (const s of servers) await s.close();
    throw err;
  }
}

async function closeAll(servers: TestServer[]): Promise<void> {
  for (const s of servers) await s.close();
}

test("fan-out to 4 endpoints: every receiver accepts its own copy as first sighting", async () => {
  const { servers, bodies, signatures } = await fanOut("evt-fanout-dedupe-1");
  try {
    const dedupes = SECRETS.map(() => new SettlementEventDedupe());
    for (let i = 0; i < 4; i++) {
      assert.equal(JSON.parse(bodies[i]).eventId, "evt-fanout-dedupe-1");
      assert.equal(receive(bodies[i], signatures[i], dedupes[i], SECRETS[i]), "processed");
      assert.equal(dedupes[i].size, 1);
    }
  } finally {
    await closeAll(servers);
  }
});

test("re-delivery to the same endpoint is a duplicate on all four receivers", async () => {
  const { servers, bodies, signatures } = await fanOut("evt-fanout-dedupe-2");
  try {
    const dedupes = SECRETS.map(() => new SettlementEventDedupe());
    for (let i = 0; i < 4; i++) {
      assert.equal(receive(bodies[i], signatures[i], dedupes[i], SECRETS[i]), "processed");
      assert.equal(receive(bodies[i], signatures[i], dedupes[i], SECRETS[i]), "duplicate");
      assert.deepEqual(dedupes[i].stats(), {
        size: 1,
        hits: 1,
        misses: 1,
        evictions: 0,
      });
    }
  } finally {
    await closeAll(servers);
  }
});

test("endpoint isolation: A recording an eventId does not make B's first delivery a duplicate", () => {
  const report = goldenReport();
  const dedupeA = new SettlementEventDedupe();
  const dedupeB = new SettlementEventDedupe();
  const dedupeC = new SettlementEventDedupe();
  const dedupeD = new SettlementEventDedupe();
  // The same logical event, signed per endpoint as a fan-out would.
  const { payload: payloadA, signature: sigA } = buildSettlementWebhook(report, {
    secret: SECRET_A,
    now: FIXED_NOW,
    eventId: "evt-fanout-dedupe-isolation",
  });
  const { payload: payloadB, signature: sigB } = buildSettlementWebhook(report, {
    secret: SECRET_B,
    now: FIXED_NOW,
    eventId: "evt-fanout-dedupe-isolation",
  });
  const rawA = JSON.stringify(payloadA);
  const rawB = JSON.stringify(payloadB);
  // A sees the event first; B has not seen it yet.
  assert.equal(receive(rawA, sigA, dedupeA, SECRET_A), "processed");
  assert.equal(dedupeA.size, 1);
  // B's first delivery of the SAME eventId is still a first sighting.
  assert.equal(receive(rawB, sigB, dedupeB, SECRET_B), "processed");
  assert.equal(dedupeB.size, 1);
  // Only now are re-deliveries duplicates, independently per endpoint.
  assert.equal(receive(rawA, sigA, dedupeA, SECRET_A), "duplicate");
  assert.equal(receive(rawB, sigB, dedupeB, SECRET_B), "duplicate");
  // Endpoints that never received the event are untouched.
  assert.equal(dedupeC.size, 0);
  assert.equal(dedupeD.size, 0);
});

test("a tampered delivery to one endpoint records nothing and its true delivery is still first-seen", async () => {
  const { servers, bodies, signatures } = await fanOut("evt-fanout-dedupe-tamper");
  try {
    const dedupes = SECRETS.map(() => new SettlementEventDedupe());
    const rawC = bodies[2];
    const sigC = signatures[2];
    // Same eventId, one second moved on `at`: the bytes no longer match
    // the signature, but the eventId the receiver would record is intact.
    const tampered = rawC.replace(FIXED_NOW, TAMPERED_NOW);
    assert.notEqual(tampered, rawC);
    assert.equal(verifySettlementWebhook(tampered, sigC, SECRET_C), false);
    assert.equal(receive(tampered, sigC, dedupes[2], SECRET_C), "rejected");
    assert.equal(dedupes[2].size, 0);
    // The forgery did not poison the store: the true delivery is first-seen.
    assert.equal(receive(rawC, sigC, dedupes[2], SECRET_C), "processed");
    assert.equal(receive(rawC, sigC, dedupes[2], SECRET_C), "duplicate");
  } finally {
    await closeAll(servers);
  }
});

test("A's wire body presented to B's receiver is rejected and leaves B's dedupe untouched", async () => {
  const { servers, bodies, signatures } = await fanOut("evt-fanout-dedupe-cross");
  try {
    const dedupeB = new SettlementEventDedupe();
    // A's copy is signed with A's secret, so B's verification fails even
    // though the eventId matches B's own copy exactly.
    assert.equal(verifySettlementWebhook(bodies[0], signatures[0], SECRET_B), false);
    assert.equal(receive(bodies[0], signatures[0], dedupeB, SECRET_B), "rejected");
    assert.equal(dedupeB.size, 0);
    // B's own true delivery is still a first sighting.
    assert.equal(receive(bodies[1], signatures[1], dedupeB, SECRET_B), "processed");
  } finally {
    await closeAll(servers);
  }
});
