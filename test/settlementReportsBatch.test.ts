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

function inputsFor(e: Escrow, withSettlement = true): SettlementReportInputs {
  return {
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: deposit(),
    ...(withSettlement ? { settlement: { proFeeBps: 500 } } : {}),
  };
}

test("mixed batch: released/refunded/expired succeed, non-terminal errors, order preserved", () => {
  const rel = released("b-rel");
  const ref = refunded("b-ref");
  const exp = expired("b-exp");
  const open = new Escrow("b-open");
  open.dispatch("FUND");

  const results = buildSettlementReports([
    inputsFor(rel),
    inputsFor(ref),
    inputsFor(exp),
    inputsFor(open),
  ]);

  assert.deepEqual(
    results.map((r) => r.escrowId),
    ["b-rel", "b-ref", "b-exp", "b-open"],
  );
  assert.equal(results[0].report?.outcome, "released");
  assert.equal(results[0].error, undefined);
  assert.equal(results[1].report?.outcome, "refunded");
  assert.equal(results[2].report?.outcome, "expired");
  assert.equal(results[3].report, undefined);
  assert.match(results[3].error ?? "", /no settlement has happened yet/);
});

test("a bad first entry does not block later entries", () => {
  const open = new Escrow("b-bad-first");
  const rel = released("b-after-bad");
  const results = buildSettlementReports([inputsFor(open), inputsFor(rel)]);
  assert.match(results[0].error ?? "", /no settlement has happened yet/);
  assert.equal(results[1].report?.outcome, "released");
  assert.ok(results[1].report?.balanced);
});

test("terminal state / last-event mismatch is a per-item error, not a batch abort", () => {
  const exp = expired("b-mismatch");
  const rel = released("b-fine");
  // Claim REFUNDED for a history whose last event is EXPIRE.
  const mismatched: SettlementReportInputs = { ...inputsFor(exp), finalState: "REFUNDED" };
  const results = buildSettlementReports([mismatched, inputsFor(rel)]);
  assert.match(results[0].error ?? "", /state is REFUNDED but the last audit event is EXPIRE/);
  assert.equal(results[1].report?.outcome, "released");
});

test("empty input returns an empty result", () => {
  assert.deepEqual(buildSettlementReports([]), []);
});

test("purity: escrow states and histories are unchanged by batch reporting", () => {
  const escrows = [released("b-pure-1"), refunded("b-pure-2"), expired("b-pure-3")];
  const before = escrows.map((e) => JSON.stringify({ state: e.state, history: e.history }));
  buildSettlementReports(escrows.map((e) => inputsFor(e)));
  const after = escrows.map((e) => JSON.stringify({ state: e.state, history: e.history }));
  assert.deepEqual(after, before);
});

test("batch results match the single-escrow function entry for entry", () => {
  const escrows = [released("b-eq-1"), refunded("b-eq-2")];
  const inputs = escrows.map((e) => inputsFor(e));
  const results = buildSettlementReports(inputs);
  for (let i = 0; i < inputs.length; i++) {
    assert.deepEqual(results[i].report, buildSettlementReport(inputs[i]));
  }
});

test("released escrow missing settlement params errors per item with the single-path message", () => {
  const rel = released("b-nosettle");
  const exp = expired("b-still-fine");
  const results = buildSettlementReports([inputsFor(rel, false), inputsFor(exp)]);
  assert.match(results[0].error ?? "", /settlement parameters \(proFeeBps\) are required/);
  assert.equal(results[1].report?.outcome, "expired");
});
