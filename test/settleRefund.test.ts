import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  calculateDeposit,
  settleRefund,
} from "../src/index.js";

test("golden vector: full deposit returns to the sponsor, every other party 0", () => {
  const r = settleRefund({ deposit: 10630 });
  assert.deepEqual(r, {
    deposit: 10630,
    sponsor: 10630,
    creator: 0,
    platform: 0,
    referrer: 0,
    totalOutflow: 10630,
    balanced: true,
  });
});

test("zero deposit refunds zero everywhere and stays balanced", () => {
  const r = settleRefund({ deposit: 0 });
  assert.deepEqual(r, {
    deposit: 0,
    sponsor: 0,
    creator: 0,
    platform: 0,
    referrer: 0,
    totalOutflow: 0,
    balanced: true,
  });
});

test("deposit passes through exactly, with no fee deduction and no rounding", () => {
  // 100.50 is not a whole number: a refund must not round it to 101 or
  // skim a fee off it — the sponsor gets back exactly what was locked.
  const r = settleRefund({ deposit: 100.5 });
  assert.equal(r.sponsor, 100.5);
  assert.equal(r.platform, 0);
  assert.equal(r.totalOutflow, 100.5);
  assert.ok(r.balanced);
});

test("agrees with buildSettlementReport's REFUNDED branch on the same escrow", () => {
  const deposit = calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
  assert.equal(deposit.deposit, 10630);

  const e = new Escrow("esc-refund-settle");
  e.dispatch("FUND");
  e.dispatch("DISPUTE");
  e.dispatch("ARBITRATE_REFUND");
  const report = buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit,
  });
  assert.equal(report.outcome, "refunded");
  assert.ok(report.balanced);

  const refund = settleRefund({ deposit: deposit.deposit });
  const sponsor = report.parties.find((p) => p.party === "sponsor")!;
  assert.equal(refund.sponsor, sponsor.outflow);
  for (const role of ["creator", "platform", "referrer"] as const) {
    assert.equal(refund[role], 0);
    assert.equal(report.parties.find((p) => p.party === role)!.outflow, 0);
  }
  assert.equal(refund.totalOutflow, report.totalOutflow);
  assert.ok(refund.balanced);
});

test("negative or non-finite deposit fails fast", () => {
  assert.throws(
    () => settleRefund({ deposit: -1 }),
    /deposit must be a finite non-negative number/,
  );
  assert.throws(
    () => settleRefund({ deposit: Number.NaN }),
    /deposit must be a finite non-negative number/,
  );
  assert.throws(
    () => settleRefund({ deposit: Infinity }),
    /deposit must be a finite non-negative number/,
  );
});
