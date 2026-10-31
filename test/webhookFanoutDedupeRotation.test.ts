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
 * Settlement webhook fan-out x `SettlementEventDedupe` x secret
 * rotation (backlog #755).
 *
 * The two halves exist separately and say nothing about the
 * combination: `webhookFanoutDedupe.test.ts` (#741) fans out to 4
 * endpoints with one secret per endpoint and no rotation candidate
 * list, while `webhookFanoutRotation.test.ts` (#681) fans out under
 * a `[new, old]` candidate list but never records anything in a
 * dedupe. The gap this file closes: during a rotation window, the
 * SAME old-signed eventId delivered to several endpoints must be
 * verified under each receiver's `[new, old]` candidate list and
 * only then recorded in that receiver's own
 * `SettlementEventDedupe` — and after rotation, a new-signed copy
 * of the same eventId must still be a duplicate, because dedupe is
 * keyed by eventId, not by signature version. Rules under test,
 * with one independent `SettlementEventDedupe` per endpoint and
 * the documented receiver order (verify the raw wire body first,
 * `checkAndRecord` only after a `true` verification, collapsed
 * into a local `receive()` helper):
 *  - one fan-out of an old-signed eventId to 4 endpoints: every
 *    receiver verifies under `[new, old]` and accepts its copy as
 *    a first sighting, each dedupe at size 1
 *  - re-delivering each recorded wire body to its own endpoint
 *    reports duplicate on all four receivers, with hits/misses
 *    counting the flow per receiver
 *  - a tampered delivery to one endpoint verifies false, records
 *    nothing anywhere, and the true delivery to that endpoint is
 *    still a first sighting
 *  - after rotation, a new-signed copy of the SAME eventId is a
 *    duplicate on all four receivers, while a new-signed copy of a
 *    fresh eventId is still processed (the duplicate verdict comes
 *    from the eventId, not from the signature version)
 *  - a copy signed with an unrelated secret is rejected under
 *    `[new, old]`, records nothing, and the true old-signed
 *    delivery to that endpoint is still a first sighting
 */

const OLD_SECRET = "whsec_fanout_dedupe_rotation_old";
const NEW_SECRET = "whsec_fanout_dedupe_rotation_new";
const UNRELATED_SECRET = "whsec_fanout_dedupe_rotation_unrelated";
const FIXED_NOW = "2026-10-31T12:00:00.000Z";
const TAMPERED_NOW = "2026-10-31T12:00:01.000Z";
const CANDIDATES = { secrets: [NEW_SECRET, OLD_SECRET] };

function goldenReport(): SettlementReport {
  const escrow = new Escrow("esc-fanout-dedupe-rotation");
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
 * The documented receiver order: verify the raw wire body first
 * under the rotation candidate list; only a verified delivery
 * reaches `checkAndRecord`. A rejected delivery never touches the
 * dedupe store.
 */
function receive(
  raw: string,
  signature: string,
  dedupe: SettlementEventDedupe,
): ReceiveOutcome {
  if (!verifySettlementWebhook(raw, signature, CANDIDATES)) return "rejected";
  const { eventId } = JSON.parse(raw) as { eventId: string };
  return dedupe.checkAndRecord(eventId) ? "duplicate" : "processed";
}

async function fanOutOldSigned(eventId: string): Promise<{
  servers: TestServer[];
  bodies: string[];
  signatures: string[];
}> {
  const servers = [await startServer(), await startServer(), await startServer(), await startServer()];
  try {
    // All four endpoints are still on the old secret at fan-out
    // time: every copy is old-signed, and every receiver must
    // accept it under its [new, old] rotation candidate list.
    const out = await deliverSettlementWebhookToMany(
      goldenReport(),
      servers.map((s) => ({ url: s.url, secret: OLD_SECRET })),
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

test("fan-out of an old-signed eventId: every receiver verifies under [new, old] and records a first sighting", async () => {
  const { servers, bodies, signatures } = await fanOutOldSigned("evt-fanout-dedupe-rotation-1");
  try {
    const dedupes = [0, 1, 2, 3].map(() => new SettlementEventDedupe());
    for (let i = 0; i < 4; i++) {
      assert.equal(JSON.parse(bodies[i]).eventId, "evt-fanout-dedupe-rotation-1");
      // The old-signed copy verifies under the rotation list in
      // either candidate order, and under neither single secret
      // alone does it prove rotation acceptance — the [new, old]
      // list is what the receiver actually runs.
      assert.equal(
        verifySettlementWebhook(bodies[i], signatures[i], { secrets: [OLD_SECRET, NEW_SECRET] }),
        true,
      );
      assert.equal(receive(bodies[i], signatures[i], dedupes[i]), "processed");
      assert.equal(dedupes[i].size, 1);
      assert.deepEqual(dedupes[i].stats(), {
        size: 1,
        hits: 0,
        misses: 1,
        evictions: 0,
      });
    }
  } finally {
    await closeAll(servers);
  }
});

test("re-delivery of the old-signed copy is a duplicate on all four receivers", async () => {
  const { servers, bodies, signatures } = await fanOutOldSigned("evt-fanout-dedupe-rotation-2");
  try {
    const dedupes = [0, 1, 2, 3].map(() => new SettlementEventDedupe());
    for (let i = 0; i < 4; i++) {
      assert.equal(receive(bodies[i], signatures[i], dedupes[i]), "processed");
      assert.equal(receive(bodies[i], signatures[i], dedupes[i]), "duplicate");
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

test("a tampered delivery records nothing and its true old-signed delivery is still first-seen", async () => {
  const { servers, bodies, signatures } = await fanOutOldSigned("evt-fanout-dedupe-rotation-tamper");
  try {
    const dedupes = [0, 1, 2, 3].map(() => new SettlementEventDedupe());
    const rawC = bodies[2];
    const sigC = signatures[2];
    // Same eventId, one second moved on `at`: the bytes no longer
    // match the signature, but the eventId the receiver would
    // record is intact.
    const tampered = rawC.replace(FIXED_NOW, TAMPERED_NOW);
    assert.notEqual(tampered, rawC);
    assert.equal(verifySettlementWebhook(tampered, sigC, CANDIDATES), false);
    assert.equal(receive(tampered, sigC, dedupes[2]), "rejected");
    assert.equal(dedupes[2].size, 0);
    // The forgery did not poison the store: the true delivery is first-seen.
    assert.equal(receive(rawC, sigC, dedupes[2]), "processed");
    assert.equal(receive(rawC, sigC, dedupes[2]), "duplicate");
    // The other receivers never saw anything.
    assert.equal(dedupes[0].size, 0);
    assert.equal(dedupes[1].size, 0);
    assert.equal(dedupes[3].size, 0);
  } finally {
    await closeAll(servers);
  }
});

test("post-rotation new-signed copy of the same eventId is still a duplicate; a fresh eventId is processed", async () => {
  const { servers, bodies, signatures } = await fanOutOldSigned("evt-fanout-dedupe-rotation-3");
  try {
    const dedupes = [0, 1, 2, 3].map(() => new SettlementEventDedupe());
    const report = goldenReport();
    for (let i = 0; i < 4; i++) {
      assert.equal(receive(bodies[i], signatures[i], dedupes[i]), "processed");
    }
    // After rotation the sender re-signs the SAME logical event
    // with the new secret. Verification passes under [new, old],
    // but dedupe is keyed by eventId, not by signature version.
    for (let i = 0; i < 4; i++) {
      const { payload, signature } = buildSettlementWebhook(report, {
        secret: NEW_SECRET,
        now: FIXED_NOW,
        eventId: "evt-fanout-dedupe-rotation-3",
      });
      const raw = JSON.stringify(payload);
      assert.equal(verifySettlementWebhook(raw, signature, CANDIDATES), true);
      assert.equal(receive(raw, signature, dedupes[i]), "duplicate");
      assert.equal(dedupes[i].size, 1);
    }
    // Control: a new-signed copy of a FRESH eventId is processed,
    // proving the duplicate verdict above comes from the eventId
    // and not from the new signature being rejected.
    for (let i = 0; i < 4; i++) {
      const { payload, signature } = buildSettlementWebhook(report, {
        secret: NEW_SECRET,
        now: FIXED_NOW,
        eventId: "evt-fanout-dedupe-rotation-3-fresh",
      });
      const raw = JSON.stringify(payload);
      assert.equal(receive(raw, signature, dedupes[i]), "processed");
      assert.equal(dedupes[i].size, 2);
    }
  } finally {
    await closeAll(servers);
  }
});

test("an unrelated-secret copy is rejected and leaves the receiver's dedupe untouched", () => {
  const report = goldenReport();
  const dedupe = new SettlementEventDedupe();
  const { payload, signature } = buildSettlementWebhook(report, {
    secret: UNRELATED_SECRET,
    now: FIXED_NOW,
    eventId: "evt-fanout-dedupe-rotation-unrelated",
  });
  const raw = JSON.stringify(payload);
  assert.equal(verifySettlementWebhook(raw, signature, CANDIDATES), false);
  assert.equal(receive(raw, signature, dedupe), "rejected");
  assert.equal(dedupe.size, 0);
  // The true old-signed delivery of the same eventId is still a first sighting.
  const { payload: truePayload, signature: trueSig } = buildSettlementWebhook(report, {
    secret: OLD_SECRET,
    now: FIXED_NOW,
    eventId: "evt-fanout-dedupe-rotation-unrelated",
  });
  const trueRaw = JSON.stringify(truePayload);
  assert.equal(receive(trueRaw, trueSig, dedupe), "processed");
  assert.equal(receive(trueRaw, trueSig, dedupe), "duplicate");
});
