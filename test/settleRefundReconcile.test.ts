import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  calculateDeposit,
  reconcileSettlements,
  settleRefund,
  type FeeBreakdown,
  type LedgerSettlement,
  type SettlementReport,
} from "../src/index.js";

function goldenDeposit(): FeeBreakdown {
  // Portfolio golden vector: pool $10,000, base $600 × 1.0, loyalty −$30,
  // oracle +$60 → deposit $10,630.
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

function smallDeposit(): FeeBreakdown {
  // $1,000 pool + $100 base fee, nothing else → deposit $1,100.
  return calculateDeposit({
    creatorPool: 1000,
    baseFee: 100,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 0,
    oracleFee: 0,
  });
}

function refundedReport(id: string, deposit: FeeBreakdown): SettlementReport {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("DISPUTE");
  e.dispatch("ARBITRATE_REFUND");
  return buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit,
  });
}

function assertRefundAgreement(
  report: SettlementReport,
  deposit: number,
): void {
  assert.equal(report.outcome, "refunded");
  assert.ok(report.balanced);
  const refund = settleRefund({ deposit });
  assert.equal(refund.totalOutflow, report.totalOutflow);
  assert.ok(refund.balanced);
  for (const role of ["sponsor", "creator", "platform", "referrer"] as const) {
    assert.equal(
      refund[role],
      report.parties.find((p) => p.party === role)!.outflow,
    );
  }
  assert.equal(report.parties.find((p) => p.party === "sponsor")!.inflow, deposit);
}

test("golden refund: settleRefund agrees with the REFUNDED report party by party", () => {
  const deposit = goldenDeposit();
  assert.equal(deposit.deposit, 10630);
  const report = refundedReport("esc-refund-golden", deposit);
  assertRefundAgreement(report, 10630);
});

test("small refund report reconciles to matched against an equal ledger row", () => {
  const report = refundedReport("esc-refund-small", smallDeposit());
  assertRefundAgreement(report, 1100);
  const ledger: LedgerSettlement[] = [{ escrowId: "esc-refund-small", amount: 1100 }];
  const result = reconcileSettlements([report], ledger);
  assert.deepEqual(
    result.matched.map((r) => r.escrowId),
    ["esc-refund-small"],
  );
  assert.deepEqual(result.reportOnly, []);
  assert.deepEqual(result.ledgerOnly, []);
  assert.deepEqual(result.amountMismatch, []);
});

test("batch of two refund reports both land in matched, in input order", () => {
  const golden = refundedReport("esc-refund-batch-golden", goldenDeposit());
  const small = refundedReport("esc-refund-batch-small", smallDeposit());
  const result = reconcileSettlements(
    [golden, small],
    [
      { escrowId: "esc-refund-batch-golden", amount: 10630 },
      { escrowId: "esc-refund-batch-small", amount: 1100 },
    ],
  );
  assert.deepEqual(
    result.matched.map((r) => r.escrowId),
    ["esc-refund-batch-golden", "esc-refund-batch-small"],
  );
  assert.deepEqual(result.amountMismatch, []);
});

test("ledger one cent short of the refund lands in amountMismatch, not matched", () => {
  const report = refundedReport("esc-refund-short", goldenDeposit());
  const result = reconcileSettlements([report], [
    { escrowId: "esc-refund-short", amount: 10629.99 },
  ]);
  assert.deepEqual(result.matched, []);
  assert.equal(result.amountMismatch.length, 1);
  assert.equal(result.amountMismatch[0].report.escrowId, "esc-refund-short");
  assert.equal(result.amountMismatch[0].reportAmount, 10630);
  assert.equal(result.amountMismatch[0].ledgerAmount, 10629.99);
});

test("ledger one cent over the refund lands in amountMismatch, not matched", () => {
  const report = refundedReport("esc-refund-over", smallDeposit());
  const result = reconcileSettlements([report], [
    { escrowId: "esc-refund-over", amount: 1100.01 },
  ]);
  assert.deepEqual(result.matched, []);
  assert.equal(result.amountMismatch.length, 1);
  assert.equal(result.amountMismatch[0].reportAmount, 1100);
  assert.equal(result.amountMismatch[0].ledgerAmount, 1100.01);
});

test("zero-deposit refund closes the loop: refund, report, and ledger all zero", () => {
  const deposit = calculateDeposit({
    creatorPool: 0,
    baseFee: 0,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 0,
    oracleFee: 0,
  });
  assert.equal(deposit.deposit, 0);
  const report = refundedReport("esc-refund-zero", deposit);
  assertRefundAgreement(report, 0);
  assert.equal(report.totalOutflow, 0);
  const result = reconcileSettlements([report], [
    { escrowId: "esc-refund-zero", amount: 0 },
  ]);
  assert.deepEqual(
    result.matched.map((r) => r.escrowId),
    ["esc-refund-zero"],
  );
  assert.deepEqual(result.amountMismatch, []);
});

test("fractional deposit refund closes the loop with no rounding or fee skim", () => {
  const deposit = calculateDeposit({
    creatorPool: 100,
    baseFee: 0,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 0,
    oracleFee: 0.5,
  });
  assert.equal(deposit.deposit, 100.5);
  const report = refundedReport("esc-refund-fractional", deposit);
  assertRefundAgreement(report, 100.5);
  const result = reconcileSettlements([report], [
    { escrowId: "esc-refund-fractional", amount: 100.5 },
  ]);
  assert.deepEqual(
    result.matched.map((r) => r.escrowId),
    ["esc-refund-fractional"],
  );
});

test("pairing is by escrowId, not amount: same-amount rows under other ids do not match", () => {
  const report = refundedReport("esc-refund-id-a", smallDeposit());
  const result = reconcileSettlements([report], [
    { escrowId: "esc-refund-id-b", amount: 1100 },
  ]);
  assert.deepEqual(result.matched, []);
  assert.deepEqual(
    result.reportOnly.map((r) => r.escrowId),
    ["esc-refund-id-a"],
  );
  assert.deepEqual(
    result.ledgerOnly.map((r) => r.escrowId),
    ["esc-refund-id-b"],
  );
  assert.deepEqual(result.amountMismatch, []);
});

test("ledger row without a recorded amount pairs on reference alone, as documented", () => {
  const report = refundedReport("esc-refund-no-amount", smallDeposit());
  const result = reconcileSettlements([report], [
    { escrowId: "esc-refund-no-amount" },
  ]);
  assert.deepEqual(
    result.matched.map((r) => r.escrowId),
    ["esc-refund-no-amount"],
  );
  assert.deepEqual(result.amountMismatch, []);
});
