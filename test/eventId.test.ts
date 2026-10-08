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

test("eventId: default build generates a UUID v4 delivery ID", () => {
  const { payload } = buildSettlementWebhook(releasedReport(), {
    secret: SECRET,
    now: FIXED_NOW,
  });
  assert.match(payload.eventId, UUID_V4);
});

test("eventId: two default builds get different eventIds", () => {
  const report = releasedReport();
  const a = buildSettlementWebhook(report, { secret: SECRET, now: FIXED_NOW });
  const b = buildSettlementWebhook(report, { secret: SECRET, now: FIXED_NOW });
  assert.notEqual(a.payload.eventId, b.payload.eventId);
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
  const { payload } = buildSettlementWebhook(releasedReport(), {
    secret: SECRET,
    now: FIXED_NOW,
  });
  // Compile-time: SettlementWebhookPayload import must resolve.
  const typed: SettlementWebhookPayload = payload;
  assert.equal(typeof typed.eventId, "string");
  // eventId sits in the signed body: signature covers it.
  assert.equal(payload.eventId.length, 36);
});
