import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementReports,
  calculateDeposit,
  summarizeSettlementReports,
  type SettlementReport,
  type SettlementReportInputs,
  type SettlementReportResult,
} from "../src/index.js";

// Backlog #1268: `summarizeSettlementReports` must fail closed when the
// same escrow's report appears twice in the batch — without the guard,
// deposit/inflow/outflow/parties all double-count in the day-end
// totals. The batch builder (`buildSettlementReports`, #993) and
// `reconcileSettlements` already refuse duplicates; the summary was the
// unguarded entry point a hand-assembled batch could still reach.

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

function reportFor(e: Escrow): SettlementReportResult {
  return { escrowId: e.id, report: buildSettlementReport(inputsFor(e)) };
}

function assertDuplicate(
  results: readonly SettlementReportResult[],
  id: string,
) {
  assert.throws(
    () => summarizeSettlementReports(results),
    (err: unknown) =>
      err instanceof Error &&
      err.message ===
        `invalid summarizeSettlementReports: duplicate report escrowId: "${id}"`,
  );
}

// Hand-built report carrying figures no builder would ever produce, so
// the duplicate-vs-overflow precedence can be pinned without a real
// overflow-sized escrow.
function fakeReport(id: string, amount: number): SettlementReportResult {
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
      {
        party: "sponsor",
        label: "Sponsor (depositor)",
        inflow: amount,
        outflow: amount,
        net: 0,
      },
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

test("the same result object twice throws with the id in the error", () => {
  const result = reportFor(released("sum-dup-same"));
  assertDuplicate([result, result], "sum-dup-same");
});

test("two separately built reports for one escrow throw", () => {
  const rel = released("sum-dup-built");
  assertDuplicate(
    [reportFor(rel), reportFor(rel)],
    "sum-dup-built",
  );
});

test("non-adjacent duplicates are caught and name the first repeated id", () => {
  const a = released("sum-dup-a");
  const b = expired("sum-dup-b");
  assertDuplicate(
    [reportFor(a), reportFor(b), reportFor(a)],
    "sum-dup-a",
  );
});

test("duplicate across outcomes still throws", () => {
  const rel = released("sum-dup-x");
  const exp = expired("sum-dup-x");
  assertDuplicate([reportFor(rel), reportFor(exp)], "sum-dup-x");
});

test("distinct escrowIds summarize normally, each counted once", () => {
  const results = buildSettlementReports([
    inputsFor(released("sum-ok-1")),
    inputsFor(expired("sum-ok-2")),
  ]);
  const summary = summarizeSettlementReports(results);
  assert.equal(summary.total, 2);
  assert.equal(summary.reports, 2);
  assert.equal(summary.errors, 0);
  assert.equal(summary.outcomes.released, 1);
  assert.equal(summary.outcomes.expired, 1);
  // One deposit each (10,630), not doubled: the guard's absence would
  // have shown 21,260 here for a duplicated batch, and this pins the
  // honest per-report sum for distinct escrows.
  assert.equal(summary.totalDeposit, 21260);
  assert.equal(summary.totalInflow, 21260);
  assert.equal(summary.totalOutflow, 21260);
});

test("error entries sharing an escrowId label never trigger the check", () => {
  const results: SettlementReportResult[] = [
    { escrowId: "sum-err", error: "boom" },
    { escrowId: "sum-err", error: "boom again" },
    reportFor(released("sum-err-real")),
  ];
  const summary = summarizeSettlementReports(results);
  assert.equal(summary.total, 3);
  assert.equal(summary.reports, 1);
  assert.equal(summary.errors, 2);
  assert.equal(summary.totalDeposit, 10630);
});

test("duplicate error wins over the overflow guard", () => {
  // Two MAX_VALUE reports for the same id would overflow the sums if
  // they were ever added; the duplicate pre-scan must throw first.
  assertDuplicate(
    [fakeReport("sum-ovf", Number.MAX_VALUE), fakeReport("sum-ovf", Number.MAX_VALUE)],
    "sum-ovf",
  );
});

test("empty batch is unchanged: all-zero summary, balanced", () => {
  const summary = summarizeSettlementReports([]);
  assert.equal(summary.total, 0);
  assert.equal(summary.reports, 0);
  assert.equal(summary.errors, 0);
  assert.equal(summary.totalDeposit, 0);
  assert.equal(summary.totalInflow, 0);
  assert.equal(summary.totalOutflow, 0);
  assert.equal(summary.totalRemaining, 0);
  assert.equal(summary.balanced, true);
  assert.deepEqual(summary.byCurrency, {});
});

test("an error entry for the same id does not mask a duplicate report", () => {
  const rel = released("sum-mix");
  assertDuplicate(
    [
      { escrowId: "sum-mix", error: "boom" },
      reportFor(rel),
      reportFor(rel),
    ],
    "sum-mix",
  );
});

test("three copies of one report throw, naming the id once", () => {
  const rel = released("sum-triple");
  const result = reportFor(rel);
  assertDuplicate([result, result, result], "sum-triple");
});
