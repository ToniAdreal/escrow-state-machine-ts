import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementWebhook,
  calculateDeposit,
  depositAmountFromHistory,
  verifySettlementWebhook,
} from "../src/index.js";

const SECRET = "whsec_test_topup_settlement_webhook_20261028";
const FIXED_NOW = "2026-10-28T13:30:00.000Z";

/**
 * Backlog #671: `depositAmountFromHistory` sums every FUND amount since #43,
 * but no test pinned that the settlement *webhook payload* carries that sum
 * after a top-up — the `webhooks` and `settlementWebhooksBatch` suites never
 * fund an escrow twice. A payload built from the first FUND only (10000) or
 * the last FUND only (630) would look plausible while under-reporting the
 * locked deposit by the top-up, so the sum semantics need their own suite.
 */
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
function releasedWithTopup(id = "esc-topup") {
  const e = new Escrow(id);
  e.dispatch("FUND", undefined, 10000);
  e.dispatch("FUND", undefined, 630); // top-up self-loop (#43)
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  assert.equal(e.state, "RELEASED");
  return e;
}

function reportFor(e: Escrow, deposit = goldenDeposit()) {
  return buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit,
    settlement: { proFeeBps: 500 },
  });
}

test("two FUNDs sum into the webhook payload deposit, matching the report", () => {
  const e = releasedWithTopup();
  assert.equal(depositAmountFromHistory(e.history), 10630);

  const report = reportFor(e);
  assert.equal(report.deposit.deposit, 10630);
  const signed = buildSettlementWebhook(report, {
    secret: SECRET,
    now: FIXED_NOW,
    eventId: "topup-sum-event",
  });
  assert.equal(signed.payload.deposit, 10630);
  assert.equal(signed.payload.deposit, report.deposit.deposit);
  // The summed deposit flows through the whole ledger, not just the header.
  const byParty = Object.fromEntries(
    signed.payload.parties.map((p) => [p.party, p]),
  );
  assert.equal(byParty.sponsor.outflow, 10630);
  assert.equal(byParty.creator.net, 10098.5);
  assert.equal(byParty.platform.net, 531.5);
  assert.ok(
    verifySettlementWebhook(signed.payload, signed.signature, SECRET),
  );
});

test("caller deposit equal to the first FUND only is rejected (sum, not first)", () => {
  const e = releasedWithTopup();
  assert.throws(
    () => reportFor(e, { ...goldenDeposit(), deposit: 10000 }),
    /does not match the FUND total 10630/,
  );
});

test("caller deposit equal to the last FUND only is rejected (sum, not last)", () => {
  const e = releasedWithTopup();
  assert.throws(
    () => reportFor(e, { ...goldenDeposit(), deposit: 630 }),
    /does not match the FUND total 10630/,
  );
});

test("single FUND control: payload deposit equals the one FUND amount", () => {
  const e = new Escrow("esc-single-fund");
  e.dispatch("FUND", undefined, 10630);
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");

  const report = reportFor(e);
  const signed = buildSettlementWebhook(report, {
    secret: SECRET,
    now: FIXED_NOW,
    eventId: "single-fund-event",
  });
  assert.equal(signed.payload.deposit, 10630);
  assert.equal(signed.payload.deposit, report.deposit.deposit);
  assert.ok(
    verifySettlementWebhook(signed.payload, signed.signature, SECRET),
  );
});

test("a FUND without an amount keeps the report's caller-deposit behavior", () => {
  // Execution-round verification of the pre-existing semantics: when any
  // FUND entry carries no amount, `totalFundedAmount` is undefined, so the
  // report skips the deposit-match check and the deposit stays the caller's
  // responsibility (the #25 fail-fast path only fires on a *recorded*
  // mismatch). The webhook then carries the caller-supplied deposit.
  const e = new Escrow("esc-amountless-fund");
  e.dispatch("FUND"); // no amount
  e.dispatch("FUND", undefined, 630); // top-up with an amount
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");

  const report = reportFor(e);
  const signed = buildSettlementWebhook(report, {
    secret: SECRET,
    now: FIXED_NOW,
    eventId: "amountless-fund-event",
  });
  assert.equal(signed.payload.deposit, 10630);
  assert.equal(signed.payload.deposit, report.deposit.deposit);
});

test("a FUND without an amount still fails depositAmountFromHistory", () => {
  const e = new Escrow("esc-amountless-fund-helper");
  e.dispatch("FUND"); // no amount
  e.dispatch("FUND", undefined, 630);
  assert.throws(
    () => depositAmountFromHistory(e.history, e.id),
    /settlement requires a FUND amount/,
  );
});

test("tampering the summed deposit breaks webhook verification", () => {
  const e = releasedWithTopup();
  const signed = buildSettlementWebhook(reportFor(e), {
    secret: SECRET,
    now: FIXED_NOW,
    eventId: "topup-tamper-event",
  });
  const tampered = { ...signed.payload, deposit: 10000 };
  assert.equal(
    verifySettlementWebhook(tampered, signed.signature, SECRET),
    false,
  );
});
