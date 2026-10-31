import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementWebhook,
  calculateDeposit,
  depositAmountFromHistory,
  verifySettlementWebhook,
  SettlementEventDedupe,
} from "../src/index.js";

/**
 * Top-up settlement webhook x `SettlementEventDedupe` (backlog #760).
 *
 * `webhookTopup` (#671) pins that a top-up settlement webhook carries the
 * SUMMED deposit (10000 + 630), and `webhookFanoutDedupe` (#741) pins
 * verify-then-record for a fan-out, but no test pins the serial receiver
 * flow for a top-up settlement: the same fixed eventId re-delivered must
 * be deduped by eventId, not by delivery count, and a failed (tampered)
 * delivery must not poison the store. Rules under test, with the
 * documented receiver order (verify the raw wire body first,
 * `checkAndRecord` only after a `true` verification, collapsed into a
 * local `receive()` helper):
 *  - a top-up settlement webhook built with a fixed eventId: first
 *    delivery is a first sighting, and the payload still carries the
 *    summed 10630 deposit
 *  - a tampered delivery verifies false, records nothing, and the true
 *    delivery afterwards is still a first sighting
 *  - a true re-delivery of the same eventId reports duplicate
 *  - a second top-up settlement with a different eventId is still a
 *    first sighting, even after the first eventId is recorded
 */

const SECRET = "whsec_test_topup_settlement_webhook_dedupe_20261031";
const FIXED_NOW = "2026-10-31T15:30:00.000Z";

function goldenDeposit() {
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

/** CREATED → FUNDED(10000) → FUNDED(+630 top-up) → RELEASED. */
function releasedWithTopup(id: string) {
  const e = new Escrow(id);
  e.dispatch("FUND", undefined, 10000);
  e.dispatch("FUND", undefined, 630); // top-up self-loop (#43)
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  assert.equal(e.state, "RELEASED");
  assert.equal(depositAmountFromHistory(e.history), 10630);
  return e;
}

function signedTopupWebhook(id: string, eventId: string) {
  const e = releasedWithTopup(id);
  const report = buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500 },
  });
  assert.equal(report.deposit.deposit, 10630);
  const { payload, signature } = buildSettlementWebhook(report, {
    secret: SECRET,
    now: FIXED_NOW,
    eventId,
  });
  assert.equal(payload.deposit, 10630);
  return { raw: JSON.stringify(payload), signature, payload };
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
): ReceiveOutcome {
  if (!verifySettlementWebhook(raw, signature, SECRET)) return "rejected";
  const { eventId } = JSON.parse(raw) as { eventId: string };
  return dedupe.checkAndRecord(eventId) ? "duplicate" : "processed";
}

test("top-up settlement webhook first delivery is processed and carries the summed deposit", () => {
  const dedupe = new SettlementEventDedupe();
  const { raw, signature, payload } = signedTopupWebhook(
    "esc-topup-dedupe",
    "evt-topup-dedupe-1",
  );
  assert.equal(payload.eventId, "evt-topup-dedupe-1");
  assert.equal(receive(raw, signature, dedupe), "processed");
  assert.equal(dedupe.size, 1);
  assert.deepEqual(dedupe.stats(), {
    size: 1,
    hits: 0,
    misses: 1,
    evictions: 0,
  });
});

test("true re-delivery of the same top-up eventId reports duplicate", () => {
  const dedupe = new SettlementEventDedupe();
  const { raw, signature } = signedTopupWebhook(
    "esc-topup-dedupe-redelivery",
    "evt-topup-dedupe-2",
  );
  assert.equal(receive(raw, signature, dedupe), "processed");
  assert.equal(receive(raw, signature, dedupe), "duplicate");
  assert.deepEqual(dedupe.stats(), {
    size: 1,
    hits: 1,
    misses: 1,
    evictions: 0,
  });
});

test("tampered top-up delivery records nothing and the true delivery is still first-seen", () => {
  const dedupe = new SettlementEventDedupe();
  const { raw, signature, payload } = signedTopupWebhook(
    "esc-topup-dedupe-tamper",
    "evt-topup-dedupe-3",
  );
  // Same eventId, but the summed deposit rewritten to the first FUND
  // only: the bytes no longer match the signature, while the eventId
  // the receiver would record is intact.
  const tampered = JSON.stringify({ ...payload, deposit: 10000 });
  assert.notEqual(tampered, raw);
  assert.equal(verifySettlementWebhook(tampered, signature, SECRET), false);
  assert.equal(receive(tampered, signature, dedupe), "rejected");
  assert.equal(dedupe.size, 0);
  // The forgery did not poison the store: the true delivery is
  // first-seen, and only its re-delivery is a duplicate.
  assert.equal(receive(raw, signature, dedupe), "processed");
  assert.equal(receive(raw, signature, dedupe), "duplicate");
});

test("a second top-up event with a different eventId is still first-seen", () => {
  const dedupe = new SettlementEventDedupe();
  const first = signedTopupWebhook(
    "esc-topup-dedupe-a",
    "evt-topup-dedupe-4a",
  );
  const second = signedTopupWebhook(
    "esc-topup-dedupe-b",
    "evt-topup-dedupe-4b",
  );
  assert.equal(receive(first.raw, first.signature, dedupe), "processed");
  assert.equal(receive(second.raw, second.signature, dedupe), "processed");
  assert.equal(dedupe.size, 2);
  // Both eventIds are now recorded: re-deliveries of either report
  // duplicate, proving the verdict keys on eventId, not on delivery
  // count or on the shared top-up amounts.
  assert.equal(receive(first.raw, first.signature, dedupe), "duplicate");
  assert.equal(receive(second.raw, second.signature, dedupe), "duplicate");
  assert.deepEqual(dedupe.stats(), {
    size: 2,
    hits: 2,
    misses: 2,
    evictions: 0,
  });
});
