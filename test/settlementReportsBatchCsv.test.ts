import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReports,
  calculateDeposit,
  parseSettlementReportCsv,
  renderReportCsv,
  summarizeSettlementReports,
  type SettlementReportInputs,
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

function inputsFor(e: Escrow, withSettlement = true): SettlementReportInputs {
  return {
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: deposit(),
    ...(withSettlement ? { settlement: { proFeeBps: 500 } } : {}),
  };
}

test("batch -> per-report CSV -> parse: each parsed subset matches its batch report", () => {
  const rel = released("bc-rel");
  const ref = refunded("bc-ref");
  const results = buildSettlementReports([inputsFor(rel), inputsFor(ref)]);
  assert.equal(results[0].report?.outcome, "released");
  assert.equal(results[1].report?.outcome, "refunded");

  for (const result of results) {
    const report = result.report!;
    const csv = renderReportCsv(report);
    const parsed = parseSettlementReportCsv(csv);
    // The CSV carries only the subset: escrowId/outcome/party rows/TOTAL.
    // It must never be claimed to be the full report (#600 honesty rule).
    assert.equal(parsed.escrowId, report.escrowId);
    assert.equal(parsed.outcome, report.outcome);
    assert.deepEqual(parsed.parties, report.parties);
    assert.equal(parsed.totalInflow, report.totalInflow);
    assert.equal(parsed.totalOutflow, report.totalOutflow);
    assert.equal(parsed.balanced, report.balanced);
    assert.equal("deposit" in parsed, false);
    assert.equal("settlement" in parsed, false);
    assert.equal("eventCount" in parsed, false);
    // A parsed subset re-renders byte-identically: the import chain is lossless
    // for everything the CSV claims to carry.
    assert.equal(renderReportCsv(parsed), csv);
  }
});

test("batch summary equals the sum of the parsed TOTAL rows, per outcome and per party", () => {
  const rel = released("bc-sum-rel");
  const ref = refunded("bc-sum-ref");
  const results = buildSettlementReports([inputsFor(rel), inputsFor(ref)]);
  const summary = summarizeSettlementReports(results);

  const parsed = results.map((r) => parseSettlementReportCsv(renderReportCsv(r.report!)));
  const totalInflow = parsed.reduce((sum, p) => sum + p.totalInflow, 0);
  const totalOutflow = parsed.reduce((sum, p) => sum + p.totalOutflow, 0);
  assert.equal(summary.totalInflow, totalInflow);
  assert.equal(summary.totalOutflow, totalOutflow);
  assert.equal(summary.total, 2);
  assert.equal(summary.reports, 2);
  assert.equal(summary.errors, 0);
  assert.deepEqual(summary.outcomes, { released: 1, refunded: 1, expired: 0 });
  assert.equal(summary.balanced, true);

  // Per-party sums from the parsed rows must match the summary's party ledger.
  for (const party of summary.parties) {
    const inflow = parsed.reduce(
      (sum, p) => sum + (p.parties.find((row) => row.party === party.party)?.inflow ?? 0),
      0,
    );
    const outflow = parsed.reduce(
      (sum, p) => sum + (p.parties.find((row) => row.party === party.party)?.outflow ?? 0),
      0,
    );
    assert.equal(party.inflow, inflow);
    assert.equal(party.outflow, outflow);
    assert.equal(party.net, inflow - outflow);
  }

  // Golden-vector spot check: two $10,630 deposits, one released (5% fee),
  // one fully refunded — both sides of the batch reconcile to $21,260.
  assert.equal(summary.totalDeposit, 21260);
  assert.equal(summary.totalInflow, 21260);
  assert.equal(summary.totalOutflow, 21260);
  assert.deepEqual(
    summary.parties.map((p) => [p.party, p.inflow, p.outflow, p.net]),
    [
      ["sponsor", 10630, 21260, -10630],
      ["creator", 10098.5, 0, 10098.5],
      ["platform", 531.5, 0, 531.5],
      ["referrer", 0, 0, 0],
    ],
  );
});

test("a per-item batch error contributes nothing to the CSV chain or the summary", () => {
  const rel = released("bc-err-rel");
  const ref = refunded("bc-err-ref");
  const open = new Escrow("bc-err-open");
  open.dispatch("FUND");

  const results = buildSettlementReports([inputsFor(rel), inputsFor(open), inputsFor(ref)]);
  assert.equal(results[1].report, undefined);
  assert.match(results[1].error ?? "", /no settlement has happened yet/);

  const summary = summarizeSettlementReports(results);
  assert.equal(summary.total, 3);
  assert.equal(summary.reports, 2);
  assert.equal(summary.errors, 1);
  assert.equal(summary.totalInflow, 21260);
  assert.equal(summary.totalOutflow, 21260);

  // Only the two successful reports enter the CSV import chain, in batch order.
  const parsed = results
    .filter((r) => r.report)
    .map((r) => parseSettlementReportCsv(renderReportCsv(r.report!)));
  assert.deepEqual(
    parsed.map((p) => p.escrowId),
    ["bc-err-rel", "bc-err-ref"],
  );
  assert.equal(
    parsed.reduce((sum, p) => sum + p.totalInflow, 0),
    summary.totalInflow,
  );
  assert.equal(
    parsed.reduce((sum, p) => sum + p.totalOutflow, 0),
    summary.totalOutflow,
  );
});

test("quoted escrowId survives the batch CSV chain without shifting columns", () => {
  const rel = released('bc,"q');
  const results = buildSettlementReports([inputsFor(rel)]);
  const parsed = parseSettlementReportCsv(renderReportCsv(results[0].report!));
  assert.equal(parsed.escrowId, 'bc,"q');
  assert.equal(parsed.outcome, "released");
  assert.deepEqual(parsed.parties, results[0].report!.parties);
  assert.equal(parsed.totalInflow, results[0].report!.totalInflow);
});
