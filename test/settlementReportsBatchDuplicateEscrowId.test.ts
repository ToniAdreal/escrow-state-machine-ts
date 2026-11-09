import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementReports,
  calculateDeposit,
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

test("duplicate escrowId aborts the whole batch with the id in the error", () => {
  const rel = released("dup-same");
  assert.throws(
    () => buildSettlementReports([inputsFor(rel), inputsFor(rel)]),
    /duplicate escrowId "dup-same" in batch: escrowIds must be unique within a batch/,
  );
});

test("duplicate id in the middle aborts before any report is produced", () => {
  const a = released("dup-mid-a");
  const b = released("dup-mid-b");
  // The throw means no partial results leak: the caller gets nothing,
  // so a double-counted summary can never be built from this batch.
  assert.throws(
    () =>
      buildSettlementReports([inputsFor(a), inputsFor(b), inputsFor(b)]),
    /duplicate escrowId "dup-mid-b"/,
  );
});

test("non-adjacent duplicates are caught", () => {
  const a = released("dup-far-a");
  const b = expired("dup-far-b");
  const c = released("dup-far-c");
  assert.throws(
    () =>
      buildSettlementReports([inputsFor(a), inputsFor(b), inputsFor(c), inputsFor(a)]),
    /duplicate escrowId "dup-far-a"/,
  );
});

test("distinct escrowIds still batch normally", () => {
  const rel = released("dup-ok-1");
  const exp = expired("dup-ok-2");
  const results = buildSettlementReports([inputsFor(rel), inputsFor(exp)]);
  assert.equal(results.length, 2);
  assert.equal(results[0].report?.outcome, "released");
  assert.equal(results[1].report?.outcome, "expired");
});

test("single-escrow buildSettlementReport is unaffected by the batch rule", () => {
  const rel = released("dup-single");
  const first = buildSettlementReport(inputsFor(rel));
  const second = buildSettlementReport(inputsFor(rel));
  assert.equal(first.outcome, "released");
  assert.deepEqual(second, first);
});

test("duplicate check wins over a per-item failure in the same batch", () => {
  const rel = released("dup-wins");
  const open = new Escrow("dup-wins-open");
  open.dispatch("FUND");
  // Without the duplicate guard this batch would return a per-item error
  // for the non-terminal escrow plus a report; the duplicate must abort
  // the whole call instead.
  const dupOpen: SettlementReportInputs = { ...inputsFor(open), escrowId: "dup-wins" };
  assert.throws(
    () => buildSettlementReports([inputsFor(rel), dupOpen]),
    /duplicate escrowId "dup-wins"/,
  );
});

test("every distinct duplicate id is named in the error", () => {
  const a = released("dup-all-a");
  const b = expired("dup-all-b");
  assert.throws(
    () =>
      buildSettlementReports([
        inputsFor(a),
        inputsFor(b),
        inputsFor(a),
        inputsFor(b),
      ]),
    /duplicate escrowId "dup-all-a", "dup-all-b" in batch/,
  );
});

test("empty batch still returns an empty result", () => {
  assert.deepEqual(buildSettlementReports([]), []);
});
