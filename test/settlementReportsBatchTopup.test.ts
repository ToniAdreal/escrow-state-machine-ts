import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementReports,
  calculateDeposit,
  depositAmountFromHistory,
  summarizeSettlementReports,
  type SettlementReportInputs,
} from "../src/index.js";

/**
 * Batch settlement reports x top-ups (#695): batch reporting
 * (`settlementReportsBatch` tests) and top-ups (`topup` tests) each have
 * coverage on their own, but their combination had none — a batch
 * containing a topped-up escrow must report the FUND *sum* as the deposit,
 * and the batch summary must reconcile against the per-report ledgers.
 */

// 10000 + 600 − 30 + 60 = 10630, the exact FUND sum of the top-up escrow.
function deposit10630() {
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

// 4370 + 600 − 30 + 60 = 5000, the exact single FUND amount of the control.
function deposit5000() {
  return calculateDeposit({
    creatorPool: 4370,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

function toppedUpReleased(id: string): Escrow {
  const e = new Escrow(id);
  e.dispatch("FUND", "initial wire", 10000);
  e.dispatch("FUND", "top-up wire", 630);
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return e;
}

function singleFundReleased(id: string): Escrow {
  const e = new Escrow(id);
  e.dispatch("FUND", "only deposit", 5000);
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return e;
}

function inputsFor(
  e: Escrow,
  deposit: ReturnType<typeof calculateDeposit>,
): SettlementReportInputs {
  return {
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit,
    settlement: { proFeeBps: 500 },
  };
}

function party(
  report: {
    parties: { party: string; inflow: number; outflow: number; net: number }[];
  },
  role: string,
) {
  const found = report.parties.find((p) => p.party === role);
  assert.ok(found, `party ${role} must be present`);
  return found;
}

test("batch with a topped-up escrow: report deposit is the FUND sum and the summary reconciles", () => {
  const topup = toppedUpReleased("bt-topup");
  const control = singleFundReleased("bt-control");

  assert.equal(depositAmountFromHistory(topup.history, topup.id), 10630);
  assert.equal(depositAmountFromHistory(control.history, control.id), 5000);

  const results = buildSettlementReports([
    inputsFor(topup, deposit10630()),
    inputsFor(control, deposit5000()),
  ]);
  assert.deepEqual(
    results.map((r) => r.escrowId),
    ["bt-topup", "bt-control"],
  );
  assert.equal(results[0].error, undefined);
  assert.equal(results[1].error, undefined);
  const topupReport = results[0].report;
  const controlReport = results[1].report;
  assert.ok(topupReport);
  assert.ok(controlReport);

  // Top-up report: deposit is the SUM (10000 + 630), not the first FUND.
  assert.equal(topupReport.outcome, "released");
  assert.equal(topupReport.deposit.deposit, 10630);
  assert.equal(topupReport.totalInflow, 10630);
  assert.equal(topupReport.totalOutflow, 10630);
  assert.equal(topupReport.balanced, true);
  // 5% pro fee on 10630: platform 531.50, creator net 10098.50.
  assert.equal(party(topupReport, "sponsor").outflow, 10630);
  assert.equal(party(topupReport, "creator").inflow, 10098.5);
  assert.equal(party(topupReport, "platform").inflow, 531.5);
  assert.equal(party(topupReport, "referrer").inflow, 0);

  // Single-FUND control: unchanged behaviour, deposit is the one amount.
  assert.equal(controlReport.outcome, "released");
  assert.equal(controlReport.deposit.deposit, 5000);
  assert.equal(controlReport.totalInflow, 5000);
  assert.equal(controlReport.totalOutflow, 5000);
  assert.equal(controlReport.balanced, true);
  assert.equal(party(controlReport, "creator").inflow, 4750);
  assert.equal(party(controlReport, "platform").inflow, 250);

  // Summary totals equal the sum of the two per-report ledgers.
  const summary = summarizeSettlementReports(results);
  assert.equal(summary.total, 2);
  assert.equal(summary.reports, 2);
  assert.equal(summary.errors, 0);
  assert.deepEqual(summary.outcomes, { released: 2, refunded: 0, expired: 0 });
  assert.equal(summary.totalDeposit, 15630);
  assert.equal(summary.totalInflow, 15630);
  assert.equal(summary.totalOutflow, 15630);
  assert.equal(summary.balanced, true);
  assert.equal(party(summary, "sponsor").outflow, 15630);
  assert.equal(party(summary, "creator").inflow, 14848.5);
  assert.equal(party(summary, "platform").inflow, 781.5);
  assert.equal(party(summary, "referrer").inflow, 0);
  // Recomputed from the reports themselves, not just hardcoded: the
  // summary must not drift from the reports it summarizes.
  for (const role of ["sponsor", "creator", "platform", "referrer"] as const) {
    const inflow =
      party(topupReport, role).inflow + party(controlReport, role).inflow;
    const outflow =
      party(topupReport, role).outflow + party(controlReport, role).outflow;
    assert.equal(party(summary, role).inflow, inflow, `summary ${role} inflow`);
    assert.equal(party(summary, role).outflow, outflow, `summary ${role} outflow`);
  }
});

test("batch top-up report matches the single-escrow function entry for entry", () => {
  const topup = toppedUpReleased("bt-eq-topup");
  const inputs = inputsFor(topup, deposit10630());
  const [result] = buildSettlementReports([inputs]);
  assert.deepEqual(result.report, buildSettlementReport(inputs));
});

test("a topped-up escrow with a mismatched deposit is a per-item error, not a batch abort", () => {
  const topup = toppedUpReleased("bt-bad-topup");
  const control = singleFundReleased("bt-fine-control");
  const results = buildSettlementReports([
    // Caller claims 10000, but the trail records 10000 + 630 = 10630.
    inputsFor(topup, deposit5000()),
    inputsFor(control, deposit5000()),
  ]);
  // Note: deposit5000() is 5000, which disagrees with the FUND total 10630.
  assert.equal(results[0].report, undefined);
  assert.match(results[0].error ?? "", /does not match the FUND total 10630/);
  assert.equal(results[1].report?.outcome, "released");
  assert.equal(results[1].report?.deposit.deposit, 5000);
});
