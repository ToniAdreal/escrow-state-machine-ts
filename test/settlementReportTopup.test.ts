import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  calculateDeposit,
  depositAmountFromHistory,
  parseSettlementReportCsv,
  renderReportCsv,
} from "../src/index.js";

/**
 * Settlement report x CSV after a top-up (backlog #708): the combination the
 * top-up suite and the CSV suite never tested together. There is no TOPUP
 * event in this repo — a top-up is a second FUND on the FUNDED self-loop
 * (#43), and `depositAmountFromHistory` sums every FUND amount. The report
 * and its CSV must therefore be driven by the FUND *total*, not by the
 * first FUND alone.
 *
 * Honest correction to the backlog's last case, verified against
 * `src/settlementReport.ts` before writing it: when any FUND entry lacks an
 * amount, `totalFundedAmount` is undefined and `buildSettlementReport`
 * deliberately keeps its legacy caller-responsible fallback (the deposit
 * comes from the caller) — it does NOT refuse. The fail-fast refusal lives
 * in `depositAmountFromHistory`, which is the corroboration helper. The
 * test below pins that split exactly, instead of asserting a refusal the
 * report path never made: a report built on an amount-less FUND history is
 * uncorroborated, and its CSV TOTAL row is the caller's number, not an
 * audit-proven sum. (Changing the report path to refuse would also break
 * the existing golden CSV tests, whose FUND events carry no amount.)
 */

function toppedUpDeposit() {
  // Portfolio golden vector: pool $10,000, base $600 × 1.0, loyalty −$30,
  // oracle +$60 → deposit $10,630, exactly the FUND total 10000 + 630.
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

function toppedUpReleasedReport(id = "esc-topup-csv") {
  const e = new Escrow(id);
  e.dispatch("FUND", "initial wire", 10000);
  e.dispatch("FUND", "top-up wire", 630);
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  const report = buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: toppedUpDeposit(),
    settlement: { proFeeBps: 500 },
  });
  return { escrow: e, report };
}

test("topped-up released report is driven by the FUND total, not the first FUND", () => {
  const { report } = toppedUpReleasedReport();
  assert.equal(report.outcome, "released");
  assert.equal(report.deposit.deposit, 10630);
  assert.equal(report.eventCount, 5);
  assert.equal(report.releasePath, "VERIFY_PASS → RELEASE");
  // 5% of 10630 = 531.50 pro fee; creator net = 10630 − 531.50 = 10098.50.
  assert.deepEqual(
    report.parties.map((p) => [p.party, p.inflow, p.outflow, p.net]),
    [
      ["sponsor", 0, 10630, -10630],
      ["creator", 10098.5, 0, 10098.5],
      ["platform", 531.5, 0, 531.5],
      ["referrer", 0, 0, 0],
    ],
  );
  assert.equal(report.totalInflow, 10630);
  assert.equal(report.totalOutflow, 10630);
  assert.equal(report.balanced, true);
});

test("topped-up report renders CSV rows on the FUND total", () => {
  const { report } = toppedUpReleasedReport();
  assert.equal(
    renderReportCsv(report),
    [
      "escrowId,outcome,role,inflow,outflow,net",
      "esc-topup-csv,released,sponsor,0.00,10630.00,-10630.00",
      "esc-topup-csv,released,creator,10098.50,0.00,10098.50",
      "esc-topup-csv,released,platform,531.50,0.00,531.50",
      "esc-topup-csv,released,referrer,0.00,0.00,0.00",
      "esc-topup-csv,released,TOTAL,10630.00,10630.00,0.00",
    ].join("\n"),
  );
  // TOTAL row agrees with the party rows, not with either FUND alone.
  const lines = renderReportCsv(report).split("\n");
  const partyInflow = lines
    .slice(1, 5)
    .reduce((s, line) => s + Number(line.split(",")[3]), 0);
  const partyOutflow = lines
    .slice(1, 5)
    .reduce((s, line) => s + Number(line.split(",")[4]), 0);
  const total = lines[5].split(",");
  assert.equal(Number(total[3]), partyInflow);
  assert.equal(Number(total[4]), partyOutflow);
  assert.equal(Number(total[3]), 10630);
});

test("topped-up CSV parses back to the same subset and re-renders byte-identically", () => {
  const { report } = toppedUpReleasedReport();
  const csv = renderReportCsv(report);
  const parsed = parseSettlementReportCsv(csv);
  assert.equal(parsed.escrowId, "esc-topup-csv");
  assert.equal(parsed.outcome, "released");
  assert.deepEqual(parsed.parties, report.parties);
  assert.equal(parsed.totalInflow, report.totalInflow);
  assert.equal(parsed.totalOutflow, report.totalOutflow);
  assert.equal(parsed.balanced, true);
  // Per #600: the CSV carries a subset only — it must not claim a deposit
  // breakdown or an event count.
  assert.equal("deposit" in parsed, false);
  assert.equal("eventCount" in parsed, false);
  assert.equal(renderReportCsv(parsed), csv);
});

test("a deposit disagreeing with the FUND total never reaches CSV rendering", () => {
  const e = new Escrow("esc-topup-mismatch-csv");
  e.dispatch("FUND", "initial wire", 10000);
  e.dispatch("FUND", "top-up wire", 630);
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  assert.throws(
    () =>
      buildSettlementReport({
        escrowId: e.id,
        history: e.history,
        finalState: e.state,
        deposit: calculateDeposit({
          creatorPool: 10000,
          baseFee: 0,
          complexityMultiplier: 1.0,
          loyaltyDiscount: 0,
          oracleFee: 0,
        }), // 10000 !== FUND total 10630
        settlement: { proFeeBps: 500 },
      }),
    /does not match the FUND total 10630/,
  );
});

test("amount-less FUND: corroboration refuses, report falls back to caller deposit (pinned split)", () => {
  const e = new Escrow("esc-topup-unpriced");
  e.dispatch("FUND", "initial wire", 10000);
  e.dispatch("FUND", "top-up, amount unknown");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  // The audit trail cannot corroborate a total here: one slice is unknown.
  assert.throws(
    () => depositAmountFromHistory(e.history, e.id),
    /settlement requires a FUND amount/,
  );
  // The report path keeps its documented legacy fallback instead of
  // refusing — so the CSV TOTAL below is the caller's number, explicitly
  // NOT an audit-proven sum. Callers that need corroboration must check
  // depositAmountFromHistory first.
  const report = buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: toppedUpDeposit(),
    settlement: { proFeeBps: 500 },
  });
  assert.equal(report.totalInflow, 10630);
  const lines = renderReportCsv(report).split("\n");
  assert.equal(lines[5], "esc-topup-unpriced,released,TOTAL,10630.00,10630.00,0.00");
});
