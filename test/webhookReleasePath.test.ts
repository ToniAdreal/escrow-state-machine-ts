import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementWebhook,
  calculateDeposit,
  verifySettlementWebhook,
} from "../src/index.js";
import type { SettlementReport, SettlementWebhookPayload } from "../src/index.js";

const SECRET = "whsec_test_settlement_notifications_20261006";
const FIXED_NOW = "2026-10-06T11:30:00.000Z";

function goldenDeposit() {
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

function reportFor(escrow: Escrow, settlement?: { proFeeBps: number }): SettlementReport {
  return buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: goldenDeposit(),
    ...(settlement ? { settlement } : {}),
  });
}

function normalReleaseReport(id = "esc-rp-normal") {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return reportFor(e, { proFeeBps: 500 });
}

function arbitrationReleaseReport(id = "esc-rp-arb") {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("DISPUTE");
  e.dispatch("ARBITRATE_RELEASE");
  return reportFor(e, { proFeeBps: 500 });
}

function refundedReport(id = "esc-rp-refund") {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("DISPUTE");
  e.dispatch("ARBITRATE_REFUND");
  return reportFor(e);
}

function expiredReport(id = "esc-rp-expired") {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("EXPIRE");
  return reportFor(e);
}

test("releasePath: normal RELEASE payload carries VERIFY_PASS → RELEASE verbatim from the report", () => {
  const report = normalReleaseReport();
  assert.equal(report.releasePath, "VERIFY_PASS → RELEASE");
  const { payload } = buildSettlementWebhook(report, { secret: SECRET, now: FIXED_NOW });
  assert.equal(payload.outcome, "released");
  assert.equal(payload.releasePath, "VERIFY_PASS → RELEASE");
  assert.equal(payload.releasePath, report.releasePath);
});

test("releasePath: arbitration release payload carries DISPUTE → ARBITRATE_RELEASE", () => {
  const report = arbitrationReleaseReport();
  assert.equal(report.releasePath, "DISPUTE → ARBITRATE_RELEASE");
  const { payload } = buildSettlementWebhook(report, { secret: SECRET, now: FIXED_NOW });
  assert.equal(payload.outcome, "released");
  assert.equal(payload.releasePath, "DISPUTE → ARBITRATE_RELEASE");
});

test("releasePath: refunded payload omits the key entirely", () => {
  const report = refundedReport();
  assert.equal(report.releasePath, undefined);
  const { payload, signature } = buildSettlementWebhook(report, { secret: SECRET, now: FIXED_NOW });
  assert.equal(payload.outcome, "refunded");
  assert.equal("releasePath" in payload, false);
  assert.equal(JSON.stringify(payload).includes("releasePath"), false);
  assert.ok(verifySettlementWebhook(payload, signature, SECRET));
});

test("releasePath: expired payload omits the key entirely", () => {
  const report = expiredReport();
  assert.equal(report.releasePath, undefined);
  const { payload, signature } = buildSettlementWebhook(report, { secret: SECRET, now: FIXED_NOW });
  assert.equal(payload.outcome, "expired");
  assert.equal("releasePath" in payload, false);
  assert.equal(JSON.stringify(payload).includes("releasePath"), false);
  assert.ok(verifySettlementWebhook(payload, signature, SECRET));
});

test("releasePath: released payload key order is fixed (releasePath after outcome, before deposit)", () => {
  const { payload } = buildSettlementWebhook(normalReleaseReport(), {
    secret: SECRET,
    now: FIXED_NOW,
  });
  assert.deepEqual(Object.keys(payload), [
    "event",
    "eventId",
    "escrowId",
    "outcome",
    "releasePath",
    "deposit",
    "parties",
    "at",
  ]);
  const raw = JSON.stringify(payload);
  assert.ok(raw.indexOf('"outcome"') < raw.indexOf('"releasePath"'));
  assert.ok(raw.indexOf('"releasePath"') < raw.indexOf('"deposit"'));
});

test("releasePath: refunded payload keeps the legacy key order without releasePath", () => {
  const { payload } = buildSettlementWebhook(refundedReport(), {
    secret: SECRET,
    now: FIXED_NOW,
  });
  assert.deepEqual(Object.keys(payload), [
    "event",
    "eventId",
    "escrowId",
    "outcome",
    "deposit",
    "parties",
    "at",
  ]);
});

test("releasePath: round-trip build → canonical JSON → verify passes (object and raw body)", () => {
  const { payload, signature } = buildSettlementWebhook(arbitrationReleaseReport(), {
    secret: SECRET,
    now: FIXED_NOW,
    eventId: "evt_release_path_roundtrip",
  });
  assert.ok(verifySettlementWebhook(payload, signature, SECRET));
  const raw = JSON.stringify(payload);
  assert.ok(verifySettlementWebhook(raw, signature, SECRET));
  // The parsed-then-restringified body is byte-identical (key order kept).
  const reparsed = JSON.parse(raw) as SettlementWebhookPayload;
  assert.equal(JSON.stringify(reparsed), raw);
  assert.ok(verifySettlementWebhook(reparsed, signature, SECRET));
});

test("releasePath: tampering with releasePath fails verification", () => {
  const { payload, signature } = buildSettlementWebhook(normalReleaseReport(), {
    secret: SECRET,
    now: FIXED_NOW,
  });
  const tampered: SettlementWebhookPayload = {
    ...payload,
    releasePath: "DISPUTE → ARBITRATE_RELEASE",
  };
  assert.equal(verifySettlementWebhook(tampered, signature, SECRET), false);
  assert.equal(verifySettlementWebhook(JSON.stringify(tampered), signature, SECRET), false);
});

test("releasePath: stripping releasePath from a signed payload fails verification", () => {
  const { payload, signature } = buildSettlementWebhook(normalReleaseReport(), {
    secret: SECRET,
    now: FIXED_NOW,
  });
  const { releasePath: _stripped, ...stripped } = payload;
  assert.equal("releasePath" in stripped, false);
  assert.equal(
    verifySettlementWebhook(stripped as SettlementWebhookPayload, signature, SECRET),
    false,
  );
  assert.equal(verifySettlementWebhook(JSON.stringify(stripped), signature, SECRET), false);
});

test("releasePath: a released report without a path omits the key and still verifies", () => {
  const report: SettlementReport = { ...normalReleaseReport(), releasePath: undefined };
  const { payload, signature } = buildSettlementWebhook(report, {
    secret: SECRET,
    now: FIXED_NOW,
  });
  assert.equal(payload.outcome, "released");
  assert.equal("releasePath" in payload, false);
  assert.ok(verifySettlementWebhook(payload, signature, SECRET));
});
