import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementWebhook,
  calculateDeposit,
  verifySettlementWebhook,
} from "../src/index.js";
import type { SettlementWebhookPayload } from "../src/index.js";

const SECRET = "whsec_test_settlement_notifications_20261006";
const FIXED_NOW = "2026-10-06T11:30:00.000Z";
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function goldenDeposit() {
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

function releasedReport(id = "esc-event-id") {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500 },
  });
}

test("eventId: default build derives a deterministic delivery ID from the report anchor", () => {
  const report = releasedReport();
  const { payload } = buildSettlementWebhook(report, {
    secret: SECRET,
    now: FIXED_NOW,
  });
  // Backlog #1430: the default is derived from the settlement-evidence
  // anchor (terminalSeq + terminalHash), not a fresh UUID.
  assert.equal(
    payload.eventId,
    `settlement-esc-event-id-${report.terminalSeq}-${report.terminalHash!.slice(0, 12)}`,
  );
});

test("eventId: a report without an anchor still gets a fresh UUID v4", () => {
  const anchored = releasedReport();
  const { terminalSeq: _seq, terminalHash: _hash, ...report } = anchored;
  const a = buildSettlementWebhook(report, { secret: SECRET, now: FIXED_NOW });
  const b = buildSettlementWebhook(report, { secret: SECRET, now: FIXED_NOW });
  assert.match(a.payload.eventId, UUID_V4);
  assert.match(b.payload.eventId, UUID_V4);
  assert.notEqual(a.payload.eventId, b.payload.eventId);
});

test("eventId: two default builds of the same settlement get the same eventId", () => {
  const report = releasedReport();
  const a = buildSettlementWebhook(report, { secret: SECRET, now: FIXED_NOW });
  const b = buildSettlementWebhook(report, { secret: SECRET, now: FIXED_NOW });
  assert.equal(a.payload.eventId, b.payload.eventId);
  assert.equal(a.signature, b.signature);
  // A different settlement still gets a different eventId.
  const other = buildSettlementWebhook(releasedReport("esc-event-id-2"), {
    secret: SECRET,
    now: FIXED_NOW,
  });
  assert.notEqual(a.payload.eventId, other.payload.eventId);
});

test("eventId: injected eventId is used verbatim and signs/validates", () => {
  const eventId = "evt_deterministic_001";
  const { payload, signature } = buildSettlementWebhook(releasedReport(), {
    secret: SECRET,
    now: FIXED_NOW,
    eventId,
  });
  assert.equal(payload.eventId, eventId);
  assert.equal(verifySettlementWebhook(payload, signature, SECRET), true);
  // Wire path: the parsed-then-stringified body round-trips byte-identically
  // (same key order), so raw-body verification succeeds too.
  assert.equal(
    verifySettlementWebhook(JSON.stringify(payload), signature, SECRET),
    true,
  );
});

test("eventId: tampering with eventId breaks signature verification", () => {
  const { payload, signature } = buildSettlementWebhook(releasedReport(), {
    secret: SECRET,
    now: FIXED_NOW,
    eventId: "evt_original",
  });
  const tampered: SettlementWebhookPayload = {
    ...payload,
    eventId: "evt_attacker_replayed",
  };
  assert.equal(verifySettlementWebhook(tampered, signature, SECRET), false);
  assert.equal(
    verifySettlementWebhook(JSON.stringify(tampered), signature, SECRET),
    false,
  );
});

test("eventId: empty injected eventId throws a configuration error", () => {
  assert.throws(
    () =>
      buildSettlementWebhook(releasedReport(), {
        secret: SECRET,
        now: FIXED_NOW,
        eventId: "",
      }),
    /eventId.*must be a non-empty string/,
  );
});

test("eventId: non-string injected eventId throws a configuration error", () => {
  assert.throws(
    () =>
      buildSettlementWebhook(releasedReport(), {
        secret: SECRET,
        now: FIXED_NOW,
        eventId: 12345 as never,
      }),
    /eventId.*must be a non-empty string/,
  );
});

test("eventId: payload type is exported and carries eventId", () => {
  const report = releasedReport();
  const { payload } = buildSettlementWebhook(report, {
    secret: SECRET,
    now: FIXED_NOW,
  });
  // Compile-time: SettlementWebhookPayload import must resolve.
  const typed: SettlementWebhookPayload = payload;
  assert.equal(typeof typed.eventId, "string");
  // eventId sits in the signed body: signature covers it — and the
  // default is the anchor-derived id, not a 36-char UUID (backlog #1430).
  assert.equal(
    payload.eventId,
    `settlement-esc-event-id-${report.terminalSeq}-${report.terminalHash!.slice(0, 12)}`,
  );
});
