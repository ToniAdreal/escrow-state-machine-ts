import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReports,
  calculateDeposit,
  summarizeSettlementReports,
  type SettlementReport,
  type SettlementReportInputs,
  type SettlementReportResult,
} from "../src/index.js";

function deposit() {
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

function released(id: string) {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return e;
}

function refunded(id: string) {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_FAIL");
  e.dispatch("ARBITRATE_REFUND");
  return e;
}

function expired(id: string) {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("EXPIRE");
  return e;
}

function inputsFor(e: Escrow): SettlementReportInputs {
  return {
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: deposit(),
    settlement: { proFeeBps: 500 },
  };
}

function mixedResults(): SettlementReportResult[] {
  const open = new Escrow("s-open");
  open.dispatch("FUND");
  return buildSettlementReports([
    inputsFor(released("s-rel")),
    inputsFor(refunded("s-ref")),
    inputsFor(expired("s-exp")),
    inputsFor(open),
  ]);
}

test("mixed batch: every field matches hand-computed expectations", () => {
  // Each escrow locks the golden deposit 10630. The released one settles at
  // proFeeBps 500: proFee = 10630 * 5% = 531.5, creator net = 10098.5.
  // Refunded/expired return the full 10630 to the sponsor (net 0).
  const s = summarizeSettlementReports(mixedResults());
  assert.equal(s.total, 4);
  assert.equal(s.reports, 3);
  assert.equal(s.errors, 1);
  assert.deepEqual(s.outcomes, { released: 1, refunded: 1, expired: 1 });
  // totalDeposit = 3 * 10630 (error entry excluded)
  assert.equal(s.totalDeposit, 31890);
  // Each successful report is internally balanced at 10630 in = 10630 out.
  assert.equal(s.totalInflow, 31890);
  assert.equal(s.totalOutflow, 31890);
  assert.deepEqual(
    s.parties.map((p) => [p.party, p.inflow, p.outflow, p.net]),
    [
      // sponsor: in 10630*2 (refund+expire), out 10630*3
      ["sponsor", 21260, 31890, -10630],
      ["creator", 10098.5, 0, 10098.5],
      ["platform", 531.5, 0, 531.5],
      ["referrer", 0, 0, 0],
    ],
  );
  assert.equal(s.balanced, true);
});

test("error entries count but never pollute the money figures", () => {
  const withError = summarizeSettlementReports(mixedResults());
  const withoutError = summarizeSettlementReports(mixedResults().slice(0, 3));
  assert.equal(withError.errors, withoutError.errors + 1);
  assert.equal(withError.totalDeposit, withoutError.totalDeposit);
  assert.equal(withError.totalInflow, withoutError.totalInflow);
  assert.equal(withError.totalOutflow, withoutError.totalOutflow);
  assert.deepEqual(withError.parties, withoutError.parties);
  assert.deepEqual(withError.outcomes, withoutError.outcomes);
});

test("empty input returns an all-zero summary", () => {
  const s = summarizeSettlementReports([]);
  assert.equal(s.total, 0);
  assert.equal(s.reports, 0);
  assert.equal(s.errors, 0);
  assert.deepEqual(s.outcomes, { released: 0, refunded: 0, expired: 0 });
  assert.equal(s.totalDeposit, 0);
  assert.equal(s.totalInflow, 0);
  assert.equal(s.totalOutflow, 0);
  assert.ok(s.parties.every((p) => p.inflow === 0 && p.outflow === 0 && p.net === 0));
  assert.equal(s.balanced, true);
});

test("all-error batch: money stays zero, errors counted", () => {
  const open1 = new Escrow("s-err-1");
  const open2 = new Escrow("s-err-2");
  const s = summarizeSettlementReports(
    buildSettlementReports([inputsFor(open1), inputsFor(open2)]),
  );
  assert.equal(s.total, 2);
  assert.equal(s.reports, 0);
  assert.equal(s.errors, 2);
  assert.equal(s.totalDeposit, 0);
  assert.equal(s.totalInflow, 0);
  assert.equal(s.totalOutflow, 0);
});

test("conservation: party nets sum to zero when every report is balanced", () => {
  const s = summarizeSettlementReports(mixedResults());
  const netSum = s.parties.reduce((acc, p) => acc + p.net, 0);
  assert.equal(Math.round(netSum * 100) / 100, 0);
  assert.equal(s.totalInflow, s.totalOutflow);
});

test("single released report: summary reproduces that report's own figures", () => {
  const results = buildSettlementReports([inputsFor(released("s-single"))]);
  const report = results[0].report!;
  const s = summarizeSettlementReports(results);
  assert.equal(s.totalDeposit, report.deposit.deposit);
  assert.equal(s.totalInflow, report.totalInflow);
  assert.equal(s.totalOutflow, report.totalOutflow);
  assert.deepEqual(s.parties, report.parties);
  assert.equal(s.outcomes.released, 1);
});

function fakeRefunded(id: string, amount: number): SettlementReportResult {
  const report: SettlementReport = {
    escrowId: id,
    outcome: "refunded",
    deposit: {
      creatorPool: amount,
      baseFee: 0,
      complexityMultiplier: 1,
      loyaltyDiscount: 0,
      oracleFee: 0,
      adjustedBaseFee: 0,
      deposit: amount,
    },
    parties: [
      { party: "sponsor", label: "Sponsor (depositor)", inflow: amount, outflow: amount, net: 0 },
      { party: "creator", label: "Creator (payee)", inflow: 0, outflow: 0, net: 0 },
      { party: "platform", label: "Platform (pro fee)", inflow: 0, outflow: 0, net: 0 },
      { party: "referrer", label: "Referrer (referral credits)", inflow: 0, outflow: 0, net: 0 },
    ],
    totalInflow: amount,
    totalOutflow: amount,
    balanced: true,
    eventCount: 2,
  };
  return { escrowId: id, report };
}

test("cent precision: 0.1 + 0.2 aggregates to exactly 0.3, not float dust", () => {
  const s = summarizeSettlementReports([fakeRefunded("s-c1", 0.1), fakeRefunded("s-c2", 0.2)]);
  assert.equal(s.totalDeposit, 0.3);
  assert.equal(s.totalInflow, 0.3);
  assert.equal(s.totalOutflow, 0.3);
  assert.equal(s.parties[0].inflow, 0.3);
});

test("an unbalanced report makes the summary unbalanced; input is not mutated", () => {
  const bad = fakeRefunded("s-unbal", 10);
  bad.report!.balanced = false;
  const results: SettlementReportResult[] = [bad];
  const before = JSON.stringify(results);
  const s = summarizeSettlementReports(results);
  assert.equal(s.balanced, false);
  assert.equal(JSON.stringify(results), before);
});
