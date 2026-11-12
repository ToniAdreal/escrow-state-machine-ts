import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementReports,
  calculateDeposit,
  depositAmountFromHistory,
  parseSettlementReportJson,
  releasedAmountFromHistory,
  renderReportJson,
} from "../src/index.js";

// Backlog #1091: `buildSettlementReport` minted reports for any
// `escrowId` — empty or longer than the 256 characters the escrow
// constructor, the CSV/JSON parsers, and `reconcileSettlements` all
// enforce — so the library could build a report it could not itself
// parse or reconcile. The build path now fails fast on the identity,
// and the history-amount helpers validate an explicitly passed label
// the same way (the default "escrow" label stays unvalidated: it is a
// label for a call with no report identity, not an identity).

function goldenDeposit() {
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

function releaseEscrow(id: string) {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return e;
}

function reportInputs(id: string) {
  const e = releaseEscrow(id);
  return {
    escrowId: id,
    history: e.history,
    finalState: e.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500 },
  };
}

test("buildSettlementReport rejects an empty escrowId", () => {
  const inputs = reportInputs("esc-empty-id");
  assert.throws(
    () => buildSettlementReport({ ...inputs, escrowId: "" }),
    /cannot build settlement report: escrowId must be a non-empty string/,
  );
});

test("buildSettlementReport rejects a non-string escrowId", () => {
  const inputs = reportInputs("esc-nonstring-id");
  assert.throws(
    () =>
      buildSettlementReport({
        ...inputs,
        escrowId: 42 as unknown as string,
      }),
    /cannot build settlement report: escrowId must be a non-empty string/,
  );
});

test("buildSettlementReport rejects a 257-char escrowId and leaves the escrow untouched", () => {
  const e = releaseEscrow("esc-overlong-id");
  const historyBefore = e.history;
  const stateBefore = e.state;
  assert.throws(
    () =>
      buildSettlementReport({
        escrowId: "x".repeat(257),
        history: e.history,
        finalState: e.state,
        deposit: goldenDeposit(),
        settlement: { proFeeBps: 500 },
      }),
    /cannot build settlement report: escrowId must be at most 256 characters, got 257/,
  );
  assert.equal(e.state, stateBefore);
  assert.deepEqual(e.history, historyBefore);
});

test("buildSettlementReport checks the identity before the chain check", () => {
  // A tampered history plus a bad id must report the id error, not the
  // chain error: identity validation runs before any money math.
  const e = releaseEscrow("esc-order-id");
  const tampered = e.history.map((entry, i) =>
    i === 0 ? { ...entry, amount: 1 } : entry,
  );
  assert.throws(
    () =>
      buildSettlementReport({
        escrowId: "",
        history: tampered,
        finalState: e.state,
        deposit: goldenDeposit(),
        settlement: { proFeeBps: 500 },
      }),
    /cannot build settlement report: escrowId must be a non-empty string/,
  );
});

test("a 256-char escrowId builds and the report round-trips through JSON", () => {
  const id = "e".repeat(256);
  const report = buildSettlementReport(reportInputs(id));
  assert.equal(report.escrowId, id);
  assert.ok(report.balanced);
  const parsed = parseSettlementReportJson(renderReportJson(report));
  assert.equal(parsed.escrowId, id);
  assert.deepEqual(parsed, report);
});

test("a short escrowId builds exactly as before", () => {
  const report = buildSettlementReport(reportInputs("esc-10630"));
  assert.equal(report.escrowId, "esc-10630");
  assert.equal(report.outcome, "released");
  assert.ok(report.balanced);
});

test("depositAmountFromHistory rejects an explicitly passed overlong label", () => {
  const e = releaseEscrow("esc-helper-label");
  assert.throws(
    () => depositAmountFromHistory(e.history, "x".repeat(257)),
    /cannot read settlement amount: escrowId must be at most 256 characters, got 257/,
  );
});

test("releasedAmountFromHistory rejects an explicitly passed empty label", () => {
  const e = releaseEscrow("esc-helper-label-2");
  assert.throws(
    () => releasedAmountFromHistory(e.history, ""),
    /cannot read settlement amount: escrowId must be a non-empty string/,
  );
});

test("a 256-char label into the helpers passes and returns the amount", () => {
  const e = new Escrow("esc-helper-label-256");
  e.dispatch("FUND", undefined, 10630);
  assert.equal(depositAmountFromHistory(e.history, "x".repeat(256)), 10630);
  assert.equal(releasedAmountFromHistory(e.history, "y".repeat(256)), 0);
});

test("the default label path is unchanged: no-arg helpers still label errors 'escrow'", () => {
  assert.throws(
    () => depositAmountFromHistory([]),
    /settlement requires a FUND amount for escrow: no FUND event in the audit history/,
  );
  assert.equal(releasedAmountFromHistory([]), 0);
});

test("batch: a bad escrowId fails only its own entry, the rest still report", () => {
  const good = reportInputs("esc-batch-good");
  const bad = reportInputs("esc-batch-bad");
  const results = buildSettlementReports([
    good,
    { ...bad, escrowId: "" },
    { ...bad, escrowId: "z".repeat(257) },
  ]);
  assert.equal(results.length, 3);
  assert.ok(results[0]?.report);
  assert.equal(results[0]?.report?.escrowId, "esc-batch-good");
  assert.equal(results[0]?.error, undefined);
  assert.equal(results[1]?.report, undefined);
  assert.match(
    results[1]?.error ?? "",
    /cannot build settlement report: escrowId must be a non-empty string/,
  );
  assert.equal(results[2]?.report, undefined);
  assert.match(
    results[2]?.error ?? "",
    /cannot build settlement report: escrowId must be at most 256 characters, got 257/,
  );
});
