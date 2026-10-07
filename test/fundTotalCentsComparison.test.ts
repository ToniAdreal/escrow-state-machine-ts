import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  calculateDeposit,
} from "../src/index.js";

/**
 * #69: `buildSettlementReport` used to compare the FUND total against the
 * caller-supplied deposit with an exact `!==` on raw floats. Top-ups add
 * decimals — 0.1 + 0.2 sums to 0.30000000000000004 — while `calculateDeposit`
 * produces the exact round2 value, so a legitimately funded escrow was
 * rejected. The comparison must happen at cent precision (round2 on both
 * sides), matching the library's documented money model ("all amounts are
 * rounded to cents").
 */

function tinyDeposit(deposit: number) {
  return {
    creatorPool: 0,
    baseFee: 0,
    complexityMultiplier: 1,
    loyaltyDiscount: 0,
    oracleFee: 0,
    adjustedBaseFee: 0,
    deposit,
  };
}

function goldenDeposit() {
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

/** CREATED → FUNDED(0.1) → FUNDED(+0.2 top-up); returned in FUNDED state. */
function fundedWithTopup(id = "esc-float") {
  const e = new Escrow(id);
  e.dispatch("FUND", undefined, 0.1);
  e.dispatch("FUND", undefined, 0.2); // top-up self-loop (#43)
  assert.equal(e.state, "FUNDED");
  return e;
}

test("0.1 + 0.2 top-up vs 0.3 deposit builds a released report (float dust absorbed)", () => {
  const e = fundedWithTopup();
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");

  const report = buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: tinyDeposit(0.3),
    settlement: { proFeeBps: 0 },
  });

  // Raw float total is 0.30000000000000004; the cent-precision comparison
  // must not reject it.
  assert.equal(report.outcome, "released");
  assert.ok(report.balanced);
  assert.equal(report.deposit.deposit, 0.3);
});

test("0.1 + 0.2 top-up vs 0.3 deposit builds an expired report", () => {
  const e = fundedWithTopup("esc-float-exp");
  e.dispatch("EXPIRE");

  const report = buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: tinyDeposit(0.3),
  });

  assert.equal(report.outcome, "expired");
  assert.ok(report.balanced);
});

test("a real ≥1-cent difference still throws", () => {
  const e = fundedWithTopup("esc-float-mismatch");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");

  // Funded total rounds to 0.30; 0.31 is a genuine one-cent discrepancy.
  assert.throws(
    () =>
      buildSettlementReport({
        escrowId: e.id,
        history: e.history,
        finalState: e.state,
        deposit: tinyDeposit(0.31),
        settlement: { proFeeBps: 0 },
      }),
    /does not match the FUND total/,
  );
});

test("a real ≥1-cent shortfall still throws", () => {
  const e = fundedWithTopup("esc-float-shortfall");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");

  // 0.29 vs funded 0.30: one cent short, must fail.
  assert.throws(
    () =>
      buildSettlementReport({
        escrowId: e.id,
        history: e.history,
        finalState: e.state,
        deposit: tinyDeposit(0.29),
        settlement: { proFeeBps: 0 },
      }),
    /does not match the FUND total/,
  );
});

test("sub-half-cent float dust is absorbed by the cent-precision comparison", () => {
  const e = fundedWithTopup("esc-float-dust");
  e.dispatch("EXPIRE");

  // round2(0.301) === 0.30: differences invisible in the cent model pass.
  const report = buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: tinyDeposit(0.301),
  });
  assert.equal(report.outcome, "expired");
});

test("single FUND path unchanged: exact 10630 still matches, and a 1-cent mismatch still throws", () => {
  const e = new Escrow("esc-single");
  e.dispatch("FUND", undefined, 10630);
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  const deposit = goldenDeposit();
  assert.equal(deposit.deposit, 10630);

  const report = buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit,
    settlement: { proFeeBps: 500 },
  });
  assert.equal(report.outcome, "released");
  assert.ok(report.balanced);

  const off = { ...deposit, deposit: 10629.99 };
  assert.throws(
    () =>
      buildSettlementReport({
        escrowId: e.id,
        history: e.history,
        finalState: e.state,
        deposit: off,
        settlement: { proFeeBps: 500 },
      }),
    /does not match the FUND total/,
  );
});
