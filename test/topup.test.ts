import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  allowedEvents,
  buildSettlementReport,
  calculateDeposit,
  depositAmountFromHistory,
  transition,
} from "../src/index.js";

/**
 * Top-ups (#43): real escrows often need additional collateral locked in.
 * FUND is now a self-loop on FUNDED — the initial deposit from CREATED, then
 * further deposits while still FUNDED. The locked total is always the sum of
 * every FUND entry's amount; settlement reads the sum from the audit trail.
 */

function toppedUp(id = "esc-topup"): Escrow {
  const e = new Escrow(id);
  e.dispatch("FUND", "initial wire", 10630);
  e.dispatch("FUND", "top-up wire", 2000);
  return e;
}

test("FUND self-loop: FUNDED accepts a second FUND without leaving the state", () => {
  const e = toppedUp();
  assert.equal(e.state, "FUNDED");
  assert.equal(e.history.length, 2);
  const second = e.history[1];
  assert.equal(second.event, "FUND");
  assert.equal(second.from, "FUNDED");
  assert.equal(second.to, "FUNDED");
  assert.equal(second.amount, 2000);
  assert.deepEqual(
    e.history.map((h) => h.seq),
    [1, 2],
  );
  assert.equal(transition("FUNDED", "FUND"), "FUNDED");
  assert.ok(allowedEvents("FUNDED").includes("FUND"));
});

test("depositAmountFromHistory sums every FUND amount (deposit + top-ups)", () => {
  const e = toppedUp();
  assert.equal(depositAmountFromHistory(e.history, e.id), 12630);
});

test("depositAmountFromHistory: single FUND still reads the one amount", () => {
  const e = new Escrow("esc-single");
  e.dispatch("FUND", "only deposit", 5000);
  assert.equal(depositAmountFromHistory(e.history, e.id), 5000);
});

test("depositAmountFromHistory throws when any FUND entry lacks an amount", () => {
  // A top-up recorded without an amount must never be silently treated as 0:
  // an unknown slice of the total is a corrupt total, not a cheap one.
  const e = new Escrow("esc-partial");
  e.dispatch("FUND", "initial", 10630);
  e.dispatch("FUND", "top-up, amount unknown");
  assert.throws(
    () => depositAmountFromHistory(e.history, e.id),
    /settlement requires a FUND amount/,
  );
});

test("top-up amounts go through the same boundary validation", () => {
  const e = new Escrow("esc-badtopup");
  e.dispatch("FUND", "initial", 100);
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "100" as unknown as number]) {
    assert.throws(
      () => e.dispatch("FUND", "bad top-up", bad),
      /finite non-negative/,
      `top-up amount ${String(bad)} must be rejected`,
    );
  }
  // Failed dispatches leave no history trace.
  assert.equal(e.history.length, 1);
  assert.equal(e.state, "FUNDED");
});

test("FUND is still invalid from states other than CREATED and FUNDED", () => {
  const e = new Escrow("esc-fundother");
  e.dispatch("FUND", "initial", 100);
  e.dispatch("SUBMIT_MILESTONE");
  assert.throws(() => e.dispatch("FUND", "late", 50), /invalid transition/);
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  assert.throws(() => e.dispatch("FUND", "terminal", 50), /invalid transition/);
});

test("two-FUND history round-trips through fromJSON (self-loop is a legal edge)", () => {
  const e = toppedUp("esc-topup-snap");
  const clone = Escrow.fromJSON(JSON.parse(JSON.stringify(e.toJSON())));
  assert.equal(clone.state, "FUNDED");
  assert.deepEqual(clone.history, e.history);
  assert.equal(depositAmountFromHistory(clone.history, clone.id), 12630);
});

test("buildSettlementReport accepts a deposit equal to the FUND total", () => {
  const e = new Escrow("esc-topup-settle");
  e.dispatch("FUND", "initial", 10630);
  e.dispatch("FUND", "top-up", 2000);
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  const report = buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: calculateDeposit({
      creatorPool: 12000,
      baseFee: 600,
      complexityMultiplier: 1.0,
      loyaltyDiscount: 30,
      oracleFee: 60,
    }), // 12000 + 600 − 30 + 60 = 12630, the exact FUND total
    settlement: { proFeeBps: 500 },
  });
  assert.equal(report.totalInflow, 12630);
  assert.equal(report.totalOutflow, 12630);
  assert.ok(report.balanced);
});

test("buildSettlementReport rejects a deposit that disagrees with the FUND total", () => {
  const e = new Escrow("esc-topup-mismatch");
  e.dispatch("FUND", "initial", 10630);
  e.dispatch("FUND", "top-up", 2000);
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
          baseFee: 600,
          complexityMultiplier: 1.0,
          loyaltyDiscount: 30,
          oracleFee: 60,
        }), // 10630 !== FUND total 12630
        settlement: { proFeeBps: 500 },
      }),
    /does not match the FUND total 12630/,
  );
});
