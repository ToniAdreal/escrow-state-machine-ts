import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  calculateDeposit,
  reconcileSettlements,
  settleRelease,
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

function releasedReport(
  id: string,
  options: {
    deposit?: FeeBreakdown;
    proFeeBps?: number;
    referralCredits?: number;
    currency?: string;
  } = {},
): SettlementReport {
  const deposit = options.deposit ?? goldenDeposit();
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit,
    settlement: {
      proFeeBps: options.proFeeBps ?? 500,
      ...(options.referralCredits !== undefined
        ? { referralCredits: options.referralCredits }
        : {}),
    },
    ...(options.currency !== undefined
      ? { currency: options.currency }
      : {}),
  });
}

function assertReleaseAgreement(
  report: SettlementReport,
  deposit: number,
  proFeeBps: number,
  referralCredits = 0,
): void {
  assert.equal(report.outcome, "released");
  assert.equal(report.releasePath, "VERIFY_PASS → RELEASE");
  assert.ok(report.balanced);
  const settlement = settleRelease({ gross: deposit, proFeeBps, referralCredits });
  assert.deepEqual(report.settlement, settlement);
  // The report's totalOutflow is the sum of the parties' outflows, and
  // the per-party inflows are exactly settleRelease's split of the same
  // gross: creator net + platform fee + referrer credits.
  assert.equal(
    report.totalOutflow,
    report.parties.reduce((sum, p) => sum + p.outflow, 0),
  );
  assert.equal(
    report.totalInflow,
    report.parties.reduce((sum, p) => sum + p.inflow, 0),
  );
  assert.equal(report.totalOutflow, deposit);
  assert.equal(report.totalInflow, deposit);
  const byParty = new Map(report.parties.map((p) => [p.party, p]));
  assert.equal(byParty.get("sponsor")!.inflow, 0);
  assert.equal(byParty.get("sponsor")!.outflow, deposit);
  assert.equal(byParty.get("creator")!.inflow, settlement.net);
  assert.equal(byParty.get("creator")!.outflow, 0);
  assert.equal(byParty.get("platform")!.inflow, settlement.proFee);
  assert.equal(byParty.get("platform")!.outflow, 0);
  assert.equal(byParty.get("referrer")!.inflow, settlement.referralCredits);
  assert.equal(byParty.get("referrer")!.outflow, 0);
}

test("golden release: settleRelease agrees with the RELEASED report party by party", () => {
  const deposit = goldenDeposit();
  assert.equal(deposit.deposit, 10630);
  const report = releasedReport("esc-release-golden");
  assertReleaseAgreement(report, 10630, 500);
  // Golden split, pinned by hand: 5% of 10630 is 531.50, net 10098.50.
  assert.equal(report.settlement!.proFee, 531.5);
  assert.equal(report.settlement!.net, 10098.5);
});

test("golden release report reconciles to matched against an equal ledger row", () => {
  const report = releasedReport("esc-release-small", { deposit: smallDeposit() });
  assertReleaseAgreement(report, 1100, 500);
  const ledger: LedgerSettlement[] = [{ escrowId: "esc-release-small", amount: 1100 }];
  const result = reconcileSettlements([report], ledger);
  assert.deepEqual(
    result.matched.map((r) => r.escrowId),
    ["esc-release-small"],
  );
  assert.deepEqual(result.reportOnly, []);
  assert.deepEqual(result.ledgerOnly, []);
  assert.deepEqual(result.amountMismatch, []);
  assert.deepEqual(result.currencyMismatch, []);
});

test("batch of two release reports both land in matched, in input order", () => {
  const golden = releasedReport("esc-release-batch-golden");
  const small = releasedReport("esc-release-batch-small", { deposit: smallDeposit() });
  const result = reconcileSettlements(
    [golden, small],
    [
      { escrowId: "esc-release-batch-golden", amount: 10630 },
      { escrowId: "esc-release-batch-small", amount: 1100 },
    ],
  );
  assert.deepEqual(
    result.matched.map((r) => r.escrowId),
    ["esc-release-batch-golden", "esc-release-batch-small"],
  );
  assert.deepEqual(result.amountMismatch, []);
  assert.deepEqual(result.currencyMismatch, []);
});

test("ledger one cent short of the release lands in amountMismatch, not matched", () => {
  const report = releasedReport("esc-release-short");
  const result = reconcileSettlements([report], [
    { escrowId: "esc-release-short", amount: 10629.99 },
  ]);
  assert.deepEqual(result.matched, []);
  assert.equal(result.amountMismatch.length, 1);
  assert.equal(result.amountMismatch[0].report.escrowId, "esc-release-short");
  assert.equal(result.amountMismatch[0].reportAmount, 10630);
  assert.equal(result.amountMismatch[0].ledgerAmount, 10629.99);
  assert.deepEqual(result.currencyMismatch, []);
});

test("ledger one cent over the release lands in amountMismatch, not matched", () => {
  const report = releasedReport("esc-release-over", { deposit: smallDeposit() });
  const result = reconcileSettlements([report], [
    { escrowId: "esc-release-over", amount: 1100.01 },
  ]);
  assert.deepEqual(result.matched, []);
  assert.equal(result.amountMismatch.length, 1);
  assert.equal(result.amountMismatch[0].reportAmount, 1100);
  assert.equal(result.amountMismatch[0].ledgerAmount, 1100.01);
});

test("release report with no ledger row lands in reportOnly", () => {
  const report = releasedReport("esc-release-orphan");
  const result = reconcileSettlements([report], []);
  assert.deepEqual(
    result.reportOnly.map((r) => r.escrowId),
    ["esc-release-orphan"],
  );
  assert.deepEqual(result.matched, []);
  assert.deepEqual(result.ledgerOnly, []);
  assert.deepEqual(result.amountMismatch, []);
  assert.deepEqual(result.currencyMismatch, []);
});

test("currency disagreement lands in currencyMismatch even when amounts also disagree", () => {
  const report = releasedReport("esc-release-cur", { currency: "USD" });
  const result = reconcileSettlements([report], [
    { escrowId: "esc-release-cur", amount: 10000, currency: "EUR" },
  ]);
  // Single verdict (#889): the currency break is reported here and
  // nowhere else, even though 10000 also disagrees with 10630.
  assert.deepEqual(result.matched, []);
  assert.deepEqual(result.amountMismatch, []);
  assert.equal(result.currencyMismatch.length, 1);
  assert.equal(result.currencyMismatch[0].report, report);
  assert.equal(result.currencyMismatch[0].reportCurrency, "USD");
  assert.equal(result.currencyMismatch[0].ledgerCurrency, "EUR");
});

test("referral credits flow through the release report and reconcile matched", () => {
  const report = releasedReport("esc-release-referral", { referralCredits: 100 });
  // Hand-checked split: 5% fee 531.50, referrer 100, creator net 9998.50.
  assertReleaseAgreement(report, 10630, 500, 100);
  assert.equal(report.settlement!.net, 9998.5);
  const result = reconcileSettlements([report], [
    { escrowId: "esc-release-referral", amount: 10630 },
  ]);
  assert.deepEqual(
    result.matched.map((r) => r.escrowId),
    ["esc-release-referral"],
  );
  assert.deepEqual(result.amountMismatch, []);
});

test("same currency on both sides still matches on the release path", () => {
  const report = releasedReport("esc-release-cur-same", { currency: "USD" });
  const result = reconcileSettlements([report], [
    { escrowId: "esc-release-cur-same", amount: 10630, currency: "USD" },
  ]);
  assert.deepEqual(result.matched, [report]);
  assert.deepEqual(result.currencyMismatch, []);
  assert.deepEqual(result.amountMismatch, []);
});
