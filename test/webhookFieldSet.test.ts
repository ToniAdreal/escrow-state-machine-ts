import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementWebhook,
  calculateDeposit,
  verifySettlementWebhook,
} from "../src/index.js";
import type {
  SettlementReport,
  SettlementWebhookPayload,
} from "../src/index.js";

/**
 * Settlement webhook field-set pinning (backlog #229).
 *
 * Expected field sets are taken from the existing implementation in
 * `src/webhooks.ts` (`buildPayload`): the payload is built with a fixed
 * literal key order — `event, eventId, escrowId, outcome, deposit,
 * parties, at` — and `releasePath` is inserted between `outcome` and
 * `deposit` only for a `released` report that carries a path. This file
 * changes no payload behaviour; it pins that shape so a silent field
 * addition, removal, or reorder in the signed payload (which would
 * drift receiver-side verification / reconciliation) turns a dedicated
 * test red instead of slipping through per-field assertions scattered
 * across the other webhook suites. The dataquest sibling pins the
 * same property in `test/payoutWebhookFieldSet.test.ts`.
 */

const SECRET = "whsec_test_settlement_notifications_20261006";
const FIXED_NOW = "2026-10-06T11:30:00.000Z";
const FIXED_EVENT_ID = "evt-fieldset-1";

function goldenDeposit() {
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

function reportFor(
  escrow: Escrow,
  settlement?: { proFeeBps: number },
): SettlementReport {
  return buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: goldenDeposit(),
    ...(settlement ? { settlement } : {}),
  });
}

function releasedReport(id = "esc-fs-released"): SettlementReport {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return reportFor(e, { proFeeBps: 500 });
}

function refundedReport(id = "esc-fs-refunded"): SettlementReport {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("DISPUTE");
  e.dispatch("ARBITRATE_REFUND");
  return reportFor(e);
}

function expiredReport(id = "esc-fs-expired"): SettlementReport {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("EXPIRE");
  return reportFor(e);
}

function signedFor(report: SettlementReport) {
  return buildSettlementWebhook(report, {
    secret: SECRET,
    now: FIXED_NOW,
    eventId: FIXED_EVENT_ID,
  });
}

const RELEASED_KEYS = [
  "event",
  "eventId",
  "escrowId",
  "outcome",
  "releasePath",
  "deposit",
  "parties",
  "at",
] as const;

const LEGACY_KEYS = [
  "event",
  "eventId",
  "escrowId",
  "outcome",
  "deposit",
  "parties",
  "at",
] as const;

test("released payload: exact field set, canonical key order, and signed bytes", () => {
  const { payload, signature } = signedFor(releasedReport());
  assert.deepEqual(Object.keys(payload), [...RELEASED_KEYS]);
  assert.equal(
    JSON.stringify(payload),
    '{"event":"escrow.settled","eventId":"evt-fieldset-1","escrowId":"esc-fs-released","outcome":"released","releasePath":"VERIFY_PASS → RELEASE","deposit":10630,"parties":[{"party":"sponsor","inflow":0,"outflow":10630,"net":-10630},{"party":"creator","inflow":10098.5,"outflow":0,"net":10098.5},{"party":"platform","inflow":531.5,"outflow":0,"net":531.5},{"party":"referrer","inflow":0,"outflow":0,"net":0}],"at":"2026-10-06T11:30:00.000Z"}',
  );
  assert.ok(verifySettlementWebhook(JSON.stringify(payload), signature, SECRET));
  assert.ok(verifySettlementWebhook(payload, signature, SECRET));
});

test("refunded payload: exact field set and canonical key order, no releasePath", () => {
  const { payload, signature } = signedFor(refundedReport());
  assert.deepEqual(Object.keys(payload), [...LEGACY_KEYS]);
  assert.equal("releasePath" in payload, false);
  assert.equal(
    JSON.stringify(payload),
    '{"event":"escrow.settled","eventId":"evt-fieldset-1","escrowId":"esc-fs-refunded","outcome":"refunded","deposit":10630,"parties":[{"party":"sponsor","inflow":10630,"outflow":10630,"net":0},{"party":"creator","inflow":0,"outflow":0,"net":0},{"party":"platform","inflow":0,"outflow":0,"net":0},{"party":"referrer","inflow":0,"outflow":0,"net":0}],"at":"2026-10-06T11:30:00.000Z"}',
  );
  assert.ok(verifySettlementWebhook(JSON.stringify(payload), signature, SECRET));
});

test("expired payload: exact field set and canonical key order, no releasePath", () => {
  const { payload, signature } = signedFor(expiredReport());
  assert.deepEqual(Object.keys(payload), [...LEGACY_KEYS]);
  assert.equal("releasePath" in payload, false);
  assert.equal(
    JSON.stringify(payload),
    '{"event":"escrow.settled","eventId":"evt-fieldset-1","escrowId":"esc-fs-expired","outcome":"expired","deposit":10630,"parties":[{"party":"sponsor","inflow":10630,"outflow":10630,"net":0},{"party":"creator","inflow":0,"outflow":0,"net":0},{"party":"platform","inflow":0,"outflow":0,"net":0},{"party":"referrer","inflow":0,"outflow":0,"net":0}],"at":"2026-10-06T11:30:00.000Z"}',
  );
  assert.ok(verifySettlementWebhook(JSON.stringify(payload), signature, SECRET));
});

test("parties entries: exact field set and key order for every outcome", () => {
  for (const report of [releasedReport(), refundedReport(), expiredReport()]) {
    const { payload } = signedFor(report);
    assert.deepEqual(
      payload.parties.map((p) => p.party),
      ["sponsor", "creator", "platform", "referrer"],
    );
    for (const entry of payload.parties) {
      assert.deepEqual(Object.keys(entry), ["party", "inflow", "outflow", "net"]);
    }
  }
});

test("released without a releasePath keeps the legacy seven-field set", () => {
  const report: SettlementReport = { ...releasedReport(), releasePath: undefined };
  const { payload, signature } = signedFor(report);
  assert.equal(payload.outcome, "released");
  assert.deepEqual(Object.keys(payload), [...LEGACY_KEYS]);
  assert.ok(verifySettlementWebhook(payload, signature, SECRET));
});

test("deleting any top-level field from a released payload fails verification", () => {
  const { payload, signature } = signedFor(releasedReport());
  for (const key of RELEASED_KEYS) {
    const stripped: Record<string, unknown> = { ...payload };
    delete stripped[key];
    assert.equal(
      verifySettlementWebhook(
        stripped as unknown as SettlementWebhookPayload,
        signature,
        SECRET,
      ),
      false,
      `deleted ${key} (object body)`,
    );
    assert.equal(
      verifySettlementWebhook(JSON.stringify(stripped), signature, SECRET),
      false,
      `deleted ${key} (raw body)`,
    );
  }
});

test("deleting any top-level field from refunded/expired payloads fails verification", () => {
  for (const report of [refundedReport(), expiredReport()]) {
    const { payload, signature } = signedFor(report);
    for (const key of LEGACY_KEYS) {
      const stripped: Record<string, unknown> = { ...payload };
      delete stripped[key];
      assert.equal(
        verifySettlementWebhook(JSON.stringify(stripped), signature, SECRET),
        false,
        `${payload.outcome}: deleted ${key}`,
      );
    }
  }
});

test("adding a field to a signed payload fails verification", () => {
  const { payload, signature } = signedFor(releasedReport());
  const extended = { ...payload, admin: true };
  assert.equal(
    verifySettlementWebhook(
      extended as unknown as SettlementWebhookPayload,
      signature,
      SECRET,
    ),
    false,
  );
  assert.equal(
    verifySettlementWebhook(JSON.stringify(extended), signature, SECRET),
    false,
  );
});

test("tampering with any top-level field of a released payload fails verification", () => {
  const { payload, signature } = signedFor(releasedReport());
  const tampers: Array<[string, Record<string, unknown>]> = [
    ["event", { event: "escrow.refunded" }],
    ["eventId", { eventId: "evt-other" }],
    ["escrowId", { escrowId: "esc-other" }],
    ["outcome", { outcome: "refunded" }],
    ["releasePath", { releasePath: "DISPUTE → ARBITRATE_RELEASE" }],
    ["deposit", { deposit: 10631 }],
    [
      "parties",
      {
        parties: payload.parties.map((p) =>
          p.party === "creator" ? { ...p, net: p.net + 1 } : p,
        ),
      },
    ],
    ["at", { at: "2026-10-06T11:31:00.000Z" }],
  ];
  for (const [field, patch] of tampers) {
    const mutated = { ...payload, ...patch } as SettlementWebhookPayload;
    assert.equal(
      verifySettlementWebhook(mutated, signature, SECRET),
      false,
      `tampered ${field} (object body)`,
    );
    assert.equal(
      verifySettlementWebhook(JSON.stringify(mutated), signature, SECRET),
      false,
      `tampered ${field} (raw body)`,
    );
  }
});
