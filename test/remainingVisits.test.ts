/**
 * Budget-remaining read-only API (backlog #1211).
 *
 * Backlog #1140 exposed the used count (`visitCount(state)`); a
 * caller that wanted to answer "how many FUNDED visits are left"
 * still had to compute `budget - used` itself and hand-roll the
 * Infinity / unconfigured sentinel branches — and the budget lives
 * in the snapshot opts, which is not always at hand. The
 * `remainingVisits(state)` method delegates to the same private
 * history-derived count the dispatch-time visit-budget check reads,
 * so the remaining number can never drift from the audit trail or
 * from the `state visit budget exhausted: …` error text: 0 here
 * means the next dispatch into that state is rejected. Mirrors the
 * dataquest lifecycle's `remainingVisits` (backlog #1210's sibling),
 * with one deliberate difference: this escrow rejects a 0 visit
 * budget at construction (budgets must be positive integers), so a
 * 0 remaining is only ever reached by spending, never by
 * configuring.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Escrow } from "../src/stateMachine.js";

const FUND_AMOUNT = 10000;
const TRANCHE = 100;

/** Drive a fresh escrow to FUNDED. */
function funded(escrow: Escrow): void {
  escrow.dispatch("FUND", "initial funding", FUND_AMOUNT);
}

/** One milestone round: FUNDED → MILESTONE_SUBMITTED → FUNDED. */
function milestoneRound(escrow: Escrow): void {
  escrow.dispatch("SUBMIT_MILESTONE", "milestone submitted");
  escrow.dispatch("PARTIAL_RELEASE", "tranche released", TRANCHE);
}

describe("budget remaining read-only API", () => {
  it("fresh escrow: remaining equals budget minus the initial visit, Infinity when unbudgeted", () => {
    const escrow = new Escrow("e-rem-1", {
      maxVisitsByState: { FUNDED: 2 },
    });
    // The initial CREATED visit already counts, but CREATED has no
    // budget here, so it reads Infinity; FUNDED has budget 2 and 0
    // visits so far, so 2 remain.
    assert.equal(escrow.remainingVisits("FUNDED"), 2);
    assert.equal(escrow.remainingVisits("CREATED"), Infinity);
    assert.equal(escrow.remainingVisits("MILESTONE_SUBMITTED"), Infinity);
    assert.equal(escrow.remainingVisits("RELEASED"), Infinity);
  });

  it("remaining steps down with each visit and is 0 at exhaustion", () => {
    const escrow = new Escrow("e-rem-2", {
      maxVisitsByState: { FUNDED: 2 },
    });
    funded(escrow); // FUNDED visited 1 of 2
    assert.equal(escrow.remainingVisits("FUNDED"), 1);
    milestoneRound(escrow); // PARTIAL_RELEASE back to FUNDED: 2 of 2
    assert.equal(escrow.remainingVisits("FUNDED"), 0);
    // The second round starts fine — MILESTONE_SUBMITTED is
    // unbudgeted — but the PARTIAL_RELEASE that would re-enter
    // FUNDED a third time is the dispatch the budget stops.
    escrow.dispatch("SUBMIT_MILESTONE", "second milestone");
    assert.throws(
      () => escrow.dispatch("PARTIAL_RELEASE", "tranche released", TRANCHE),
      (err: unknown) =>
        err instanceof Error &&
        err.message ===
          "state visit budget exhausted: FUNDED already visited 2 of 2 times",
      "0 remaining must mean the next re-entry is rejected, with matching numbers",
    );
    // A rejected dispatch leaves the remaining count at 0, never negative.
    assert.equal(escrow.remainingVisits("FUNDED"), 0);
    assert.equal(escrow.visitCount("FUNDED"), 2);
  });

  it("remaining stays Infinity without a budget even as visits step", () => {
    const escrow = new Escrow("e-rem-3");
    funded(escrow);
    milestoneRound(escrow);
    milestoneRound(escrow);
    assert.equal(escrow.visitCount("FUNDED"), 3);
    assert.equal(escrow.remainingVisits("FUNDED"), Infinity);
    assert.equal(escrow.remainingVisits("MILESTONE_SUBMITTED"), Infinity);
  });

  it("a budget of 1 on an already-passed state reads 0", () => {
    // CREATED's initial visit already spent its single budget.
    const created = new Escrow("e-rem-4", {
      maxVisitsByState: { CREATED: 1 },
    });
    assert.equal(created.remainingVisits("CREATED"), 0);
    assert.equal(created.visitCount("CREATED"), 1);
    // FUNDED's first FUND spends its single budget the same way.
    const fundedOne = new Escrow("e-rem-5", {
      maxVisitsByState: { FUNDED: 1 },
    });
    assert.equal(fundedOne.remainingVisits("FUNDED"), 1);
    funded(fundedOne);
    assert.equal(fundedOne.remainingVisits("FUNDED"), 0);
  });

  it("a budget of 1 on a never-visited state reads 1 until the first entry", () => {
    const escrow = new Escrow("e-rem-6", {
      maxVisitsByState: { MILESTONE_SUBMITTED: 1 },
    });
    assert.equal(escrow.remainingVisits("MILESTONE_SUBMITTED"), 1);
    funded(escrow);
    assert.equal(escrow.remainingVisits("MILESTONE_SUBMITTED"), 1);
    escrow.dispatch("SUBMIT_MILESTONE", "milestone submitted");
    assert.equal(escrow.remainingVisits("MILESTONE_SUBMITTED"), 0);
  });

  it("a 0 visit budget is rejected at construction, never readable as 0", () => {
    // Deliberate escrow difference from dataquest's resubmit/dispute
    // budgets (which allow 0): visit budgets must be positive
    // integers, so 0 remaining is only ever reached by spending.
    assert.throws(
      () => new Escrow("e-rem-7", { maxVisitsByState: { FUNDED: 0 } }),
      (err: unknown) =>
        err instanceof Error &&
        err.message ===
          "invalid option: maxVisitsByState[FUNDED] must be a positive integer, got 0",
    );
  });

  it("remainingVisits throws on an unknown state, like visitCount", () => {
    const escrow = new Escrow("e-rem-8", {
      maxVisitsByState: { FUNDED: 2 },
    });
    assert.throws(
      () => escrow.remainingVisits("funded" as never),
      (err: unknown) =>
        err instanceof Error &&
        err.message === "invalid remaining visits: unknown state funded",
      "a misspelled state is a caller bug, not an infinite budget",
    );
    assert.throws(
      () => escrow.remainingVisits("NOWHERE" as never),
      /invalid remaining visits: unknown state NOWHERE/,
    );
  });

  it("snapshot round-trip preserves the remaining value", () => {
    const escrow = new Escrow("e-rem-9", {
      maxVisitsByState: { FUNDED: 2 },
    });
    funded(escrow);
    milestoneRound(escrow);
    assert.equal(escrow.remainingVisits("FUNDED"), 0);
    const restored = Escrow.fromJSON(escrow.toJSON());
    assert.equal(restored.remainingVisits("FUNDED"), 0);
    assert.equal(restored.visitCount("FUNDED"), 2);
    assert.equal(restored.state, "FUNDED");
    // A fresh snapshot with budget still to spend restores the same way.
    const halfSpent = new Escrow("e-rem-10", {
      maxVisitsByState: { FUNDED: 3 },
    });
    funded(halfSpent);
    assert.equal(halfSpent.remainingVisits("FUNDED"), 2);
    const halfRestored = Escrow.fromJSON(halfSpent.toJSON());
    assert.equal(halfRestored.remainingVisits("FUNDED"), 2);
  });

  it("fromHistory rebuild with the same budget reports the same remaining", () => {
    const escrow = new Escrow("e-rem-11", {
      maxVisitsByState: { FUNDED: 2 },
    });
    funded(escrow);
    const rebuilt = Escrow.fromHistory(escrow.id, escrow.history, {
      maxVisitsByState: { FUNDED: 2 },
    });
    assert.equal(rebuilt.remainingVisits("FUNDED"), 1);
    assert.equal(rebuilt.visitCount("FUNDED"), 1);
    // A bare history carries no budget, so a rebuild without one is unlimited.
    const bare = Escrow.fromHistory(escrow.id, escrow.history);
    assert.equal(bare.remainingVisits("FUNDED"), Infinity);
  });

  it("reading remaining is pure: state and history are untouched", () => {
    const escrow = new Escrow("e-rem-12", {
      maxVisitsByState: { FUNDED: 2 },
    });
    funded(escrow);
    const before = escrow.history.length;
    assert.equal(escrow.remainingVisits("FUNDED"), 1);
    assert.equal(escrow.remainingVisits("FUNDED"), 1);
    assert.equal(escrow.remainingVisits("CREATED"), Infinity);
    assert.equal(escrow.state, "FUNDED");
    assert.equal(escrow.history.length, before);
  });

  it("remaining always agrees with visitCount: max(0, budget - used)", () => {
    const escrow = new Escrow("e-rem-13", {
      maxVisitsByState: { FUNDED: 3, MILESTONE_SUBMITTED: 2 },
    });
    for (const state of ["FUNDED", "MILESTONE_SUBMITTED", "CREATED"] as const) {
      const budget =
        state === "CREATED" ? undefined : state === "FUNDED" ? 3 : 2;
      const expected =
        budget === undefined
          ? Infinity
          : Math.max(0, budget - escrow.visitCount(state));
      assert.equal(escrow.remainingVisits(state), expected);
    }
    funded(escrow);
    milestoneRound(escrow);
    for (const state of ["FUNDED", "MILESTONE_SUBMITTED"] as const) {
      const budget = state === "FUNDED" ? 3 : 2;
      assert.equal(
        escrow.remainingVisits(state),
        Math.max(0, budget - escrow.visitCount(state)),
      );
    }
    assert.equal(escrow.remainingVisits("FUNDED"), 1);
    assert.equal(escrow.remainingVisits("MILESTONE_SUBMITTED"), 1);
  });

  it("fromJSON with an overriding budget re-derives the remaining value", () => {
    const escrow = new Escrow("e-rem-14", {
      maxVisitsByState: { FUNDED: 2 },
    });
    funded(escrow);
    milestoneRound(escrow);
    assert.equal(escrow.remainingVisits("FUNDED"), 0);
    // Widening the budget on restore re-opens one visit.
    const widened = Escrow.fromJSON(escrow.toJSON(), {
      maxVisitsByState: { FUNDED: 3 },
    });
    assert.equal(widened.remainingVisits("FUNDED"), 1);
    // Dropping the budget on restore returns Infinity.
    const unbounded = Escrow.fromJSON(escrow.toJSON(), {
      maxVisitsByState: {},
    });
    assert.equal(unbounded.remainingVisits("FUNDED"), Infinity);
  });
});
