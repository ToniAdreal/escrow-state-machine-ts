/**
 * Settlement-report batch shape guards (backlog #1358).
 *
 * `summarizeSettlementReports` and `buildSettlementReports` both started
 * by iterating their batch argument with no array check, so a null batch
 * surfaced a bare `TypeError` (`results is not iterable` /
 * `inputsList is not iterable`) — and a string batch was worse: the
 * summarizer silently returned an all-zero summary for it, because
 * iterating a string yields its characters and none of them carries a
 * report. The batch builder and the summarizer are the day-end
 * settlement path (build, then summarize), so a caller passing the
 * wrong shape deserves a named error at the entry point, not a bare
 * TypeError or a silently empty day-end total. Both guards use the
 * same wording `reconcileSettlements` already uses for its own batch
 * inputs (#1343) and run before any iteration, duplicate check, or
 * per-entry validation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReports,
  calculateDeposit,
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

function legalBatch() {
  return [
    inputsFor(released("s-rel")),
    inputsFor(refunded("s-ref")),
    inputsFor(expired("s-exp")),
  ];
}

test("summarizeSettlementReports rejects a null batch with a named error", () => {
  assert.throws(
    () => summarizeSettlementReports(null as never),
    {
      name: "Error",
      message:
        "invalid summarizeSettlementReports: results must be an array, got null",
    },
  );
});

test("summarizeSettlementReports rejects a string batch with a named error", () => {
  assert.throws(
    () => summarizeSettlementReports("x" as never),
    {
      name: "Error",
      message:
        "invalid summarizeSettlementReports: results must be an array, got string",
    },
  );
});

test("summarizeSettlementReports rejects a number batch with a named error", () => {
  assert.throws(
    () => summarizeSettlementReports(42 as never),
    {
      name: "Error",
      message:
        "invalid summarizeSettlementReports: results must be an array, got number",
    },
  );
});

test("summarizeSettlementReports rejects a plain-object batch with a named error", () => {
  assert.throws(
    () => summarizeSettlementReports({} as never),
    {
      name: "Error",
      message:
        "invalid summarizeSettlementReports: results must be an array, got object",
    },
  );
});

test("buildSettlementReports rejects a null batch with a named error", () => {
  assert.throws(
    () => buildSettlementReports(null as never),
    {
      name: "Error",
      message:
        "invalid buildSettlementReports: inputsList must be an array, got null",
    },
  );
});

test("buildSettlementReports rejects a string batch with a named error", () => {
  assert.throws(
    () => buildSettlementReports("x" as never),
    {
      name: "Error",
      message:
        "invalid buildSettlementReports: inputsList must be an array, got string",
    },
  );
});

test("buildSettlementReports rejects a number batch with a named error", () => {
  assert.throws(
    () => buildSettlementReports(42 as never),
    {
      name: "Error",
      message:
        "invalid buildSettlementReports: inputsList must be an array, got number",
    },
  );
});

test("buildSettlementReports rejects a plain-object batch with a named error", () => {
  assert.throws(
    () => buildSettlementReports({} as never),
    {
      name: "Error",
      message:
        "invalid buildSettlementReports: inputsList must be an array, got object",
    },
  );
});

test("legal three-report batch builds and summarizes exactly as before", () => {
  const results = buildSettlementReports(legalBatch());
  assert.deepEqual(
    results.map((r) => r.escrowId),
    ["s-rel", "s-ref", "s-exp"],
  );
  assert.equal(results[0].report?.outcome, "released");
  assert.equal(results[1].report?.outcome, "refunded");
  assert.equal(results[2].report?.outcome, "expired");
  assert.equal(results[0].error, undefined);

  const s = summarizeSettlementReports(results);
  assert.equal(s.total, 3);
  assert.equal(s.reports, 3);
  assert.equal(s.errors, 0);
  assert.equal(s.outcomes.released, 1);
  assert.equal(s.outcomes.refunded, 1);
  assert.equal(s.outcomes.expired, 1);
  assert.equal(s.totalDeposit, 3 * deposit().deposit);
  assert.equal(s.balanced, true);
});

test("empty batch is unchanged: builds to [] and summarizes to all zeros", () => {
  assert.deepEqual(buildSettlementReports([]), []);
  const s = summarizeSettlementReports([]);
  assert.equal(s.total, 0);
  assert.equal(s.reports, 0);
  assert.equal(s.errors, 0);
  assert.equal(s.totalDeposit, 0);
  assert.equal(s.balanced, true);
});

test("duplicate escrowId batch still fails closed with the duplicate error", () => {
  const one = inputsFor(released("s-dup"));
  assert.throws(
    () => buildSettlementReports([one, { ...one }]),
    /buildSettlementReports: duplicate escrowId "s-dup" in batch/,
  );
});

test("non-terminal escrow still yields a per-entry error, never a throw", () => {
  const open = new Escrow("s-open");
  open.dispatch("FUND");
  const results = buildSettlementReports([inputsFor(open)]);
  assert.equal(results[0].report, undefined);
  assert.match(results[0].error ?? "", /no settlement has happened yet/);
  const s = summarizeSettlementReports(results);
  assert.equal(s.total, 1);
  assert.equal(s.reports, 0);
  assert.equal(s.errors, 1);
  assert.equal(s.totalDeposit, 0);
});
