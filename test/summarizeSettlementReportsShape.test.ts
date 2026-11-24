import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementReports,
  calculateDeposit,
  summarizeSettlementReports,
  type SettlementReportInputs,
  type SettlementReportResult,
} from "../src/index.js";

// Backlog #1369: `summarizeSettlementReports` must reject a null or
// non-object batch entry with a named error naming its index. The probe
// (HEAD d89be40, dist read-only): `[null]` threw a bare `TypeError:
// Cannot read properties of null (reading 'report')`, while `["x"]`,
// `[42]`, and `[[]]` were silently counted as failed escrows — a caller
// bug became an error count instead of a failure. The guard is the same
// `isRecord` rule `verifyHistoryChain` uses for history entries (#1368),
// and it runs in the pre-pass, so a malformed batch fails whole before
// any figure is summed. A plain-object entry without a `report` keeps
// the previous behavior (counted as an error); only non-objects throw.

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

function assertEntryShape(
  results: readonly unknown[],
  index: number,
  shown: string,
) {
  assert.throws(
    () => summarizeSettlementReports(results as never),
    (err: unknown) =>
      err instanceof Error &&
      !(err instanceof TypeError) &&
      err.message ===
        `invalid summarizeSettlementReports: results[${index}] must be an object, got ${shown}`,
  );
}

test("a null entry throws a named error, not a bare TypeError", () => {
  assertEntryShape([null], 0, "null");
});

test("a string entry throws a named error naming its index", () => {
  assertEntryShape(["x"], 0, "string");
});

test("a number entry throws a named error naming its index", () => {
  assertEntryShape([42], 0, "number");
});

test("an array entry is not an object and throws a named error", () => {
  assertEntryShape([[]], 0, "array");
});

test("an undefined entry throws a named error naming its index", () => {
  assertEntryShape([undefined], 0, "undefined");
});

test("the error names the first offending index, not always 0", () => {
  const ok = reportFor(released("sum-shape-idx"));
  assertEntryShape([ok, null], 1, "null");
  const ok2 = reportFor(expired("sum-shape-idx2"));
  assertEntryShape([ok, ok2, "x"], 2, "string");
});

test("a malformed batch fails whole: no partial summary is produced", () => {
  // A valid report before the bad entry must not be summed and
  // returned — the guard throws in the pre-pass, before any figure.
  const ok = reportFor(released("sum-shape-whole"));
  assert.throws(
    () => summarizeSettlementReports([ok, null] as never),
    /invalid summarizeSettlementReports: results\[1\] must be an object, got null/,
  );
});

test("a legal mixed batch summarizes exactly as before the guard", () => {
  const results = buildSettlementReports([
    inputsFor(released("sum-shape-ok-1")),
    inputsFor(expired("sum-shape-ok-2")),
  ]);
  results.push({ escrowId: "sum-shape-ok-err", error: "boom" });
  const summary = summarizeSettlementReports(results);
  assert.equal(summary.total, 3);
  assert.equal(summary.reports, 2);
  assert.equal(summary.errors, 1);
  assert.equal(summary.outcomes.released, 1);
  assert.equal(summary.outcomes.expired, 1);
  // One deposit each (10,630), not doubled or polluted by the error.
  assert.equal(summary.totalDeposit, 21260);
  assert.equal(summary.totalInflow, 21260);
  assert.equal(summary.totalOutflow, 21260);
  assert.equal(summary.balanced, true);
});

test("an empty batch is unchanged: all-zero summary, balanced", () => {
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

test("a plain-object entry without a report is still counted as an error", () => {
  // The guard's boundary: only non-objects throw. An object entry with
  // no `report` keeps the previous behavior — it is an error entry,
  // never summed.
  const results: SettlementReportResult[] = [
    { escrowId: "sum-shape-plain", error: "boom" },
    reportFor(released("sum-shape-plain-ok")),
  ];
  const summary = summarizeSettlementReports(results);
  assert.equal(summary.total, 2);
  assert.equal(summary.reports, 1);
  assert.equal(summary.errors, 1);
  assert.equal(summary.totalDeposit, 10630);
});
