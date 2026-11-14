/**
 * Per-state visit budget (EscrowOptions.maxVisitsByState).
 *
 * The budget caps how many times the escrow may ENTER each listed state —
 * not how many times it may run an event. A visit is counted as 1 for
 * the escrow's initial state (the first history entry's `from`, or the
 * current state when the history is still empty) plus 1 per history entry
 * whose `to` is that state, so the count is derived from the append-only
 * history and survives toJSON()/fromJSON() round-trips together with the
 * budget itself. States absent from the map are unlimited; omitting the
 * map disables the check entirely. This mirrors the dataquest lifecycle's
 * `maxVisitsByState` (same counting, same check order, same error
 * wording), ported to the escrow's milestone loop:
 * FUNDED → SUBMIT_MILESTONE → MILESTONE_SUBMITTED → PARTIAL_RELEASE →
 * FUNDED, which the transition table otherwise leaves unbounded.
 *
 * Note the asymmetry the tests pin down, exactly as dataquest does for
 * its DRAFT state: a budget of 1 on CREATED does NOT block the first
 * FUND — no edge re-enters CREATED, so the initial visit can never be
 * "re-entered". What the initial-visit rule does pin is the opposite
 * direction: FUNDED with budget 1 is already spent by the first FUND,
 * so the first re-entry (the PARTIAL_RELEASE back to FUNDED) is
 * blocked. The backlog item's parenthetical ("CREATED budget 1 blocks
 * the first FUND") assumed departure semantics and contradicts the
 * dataquest port the same item mandates; entry semantics win, and this
 * file pins them.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  transitionTable,
} from "../src/stateMachine.js";

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

describe("state visit budget", () => {
  it("loop blocked at the budget point: FUNDED budget 2 stops the second re-entry", () => {
    const escrow = new Escrow("e-visit-1", {
      maxVisitsByState: { FUNDED: 2 },
    });
    funded(escrow); // FUNDED visited 1 of 2
    milestoneRound(escrow); // PARTIAL_RELEASE back to FUNDED: 2 of 2
    assert.equal(escrow.state, "FUNDED");
    assert.equal(escrow.visitCount("FUNDED"), 2);
    // Second round starts fine — MILESTONE_SUBMITTED is unbudgeted —
    // but the PARTIAL_RELEASE that would re-enter FUNDED a third time
    // is the dispatch the budget stops.
    escrow.dispatch("SUBMIT_MILESTONE", "second milestone");
    const before = escrow.history.length;
    assert.throws(
      () => escrow.dispatch("PARTIAL_RELEASE", "second tranche", TRANCHE),
      (err: unknown) =>
        err instanceof Error &&
        err.message ===
          "state visit budget exhausted: FUNDED already visited 2 of 2 times",
      "re-entering FUNDED a third time must throw the explicit budget error",
    );
    assert.equal(escrow.state, "MILESTONE_SUBMITTED");
    assert.equal(escrow.history.length, before);
  });

  it("second SUBMIT_MILESTONE blocked when MILESTONE_SUBMITTED is budgeted at 1", () => {
    const escrow = new Escrow("e-visit-2", {
      maxVisitsByState: { MILESTONE_SUBMITTED: 1 },
    });
    funded(escrow);
    escrow.dispatch("SUBMIT_MILESTONE", "first milestone"); // 1 of 1
    escrow.dispatch("PARTIAL_RELEASE", "tranche released", TRANCHE);
    assert.throws(
      () => escrow.dispatch("SUBMIT_MILESTONE", "second milestone"),
      (err: unknown) =>
        err instanceof Error &&
        err.message ===
          "state visit budget exhausted: MILESTONE_SUBMITTED already visited 1 of 1 times",
      "the second round's SUBMIT_MILESTONE must throw the explicit budget error",
    );
    assert.equal(escrow.state, "FUNDED");
  });

  it("budget not exhausted: two full rounds pass with FUNDED budget 3", () => {
    const escrow = new Escrow("e-visit-3", {
      maxVisitsByState: { FUNDED: 3 },
    });
    funded(escrow); // 1 of 3
    milestoneRound(escrow); // 2 of 3
    milestoneRound(escrow); // 3 of 3
    assert.equal(escrow.state, "FUNDED");
    assert.equal(escrow.visitCount("FUNDED"), 3);
    assert.equal(escrow.history.length, 5);
  });

  it("initial visit counts: FUNDED budget 1 blocks the first re-entry", () => {
    const escrow = new Escrow("e-visit-4", {
      maxVisitsByState: { FUNDED: 1 },
    });
    funded(escrow); // the first FUND already spent the budget
    assert.equal(escrow.visitCount("FUNDED"), 1);
    escrow.dispatch("SUBMIT_MILESTONE", "milestone submitted");
    assert.throws(
      () => escrow.dispatch("PARTIAL_RELEASE", "tranche released", TRANCHE),
      (err: unknown) =>
        err instanceof Error &&
        err.message ===
          "state visit budget exhausted: FUNDED already visited 1 of 1 times",
      "the budget counts total visits, not re-entries on top of the first visit",
    );
    assert.equal(escrow.state, "MILESTONE_SUBMITTED");
  });

  it("initial-state counting: CREATED budget 1 does not block the first FUND (no edge re-enters CREATED)", () => {
    // The transition table has no edge targeting CREATED, so the initial
    // CREATED visit can never be "re-entered" — the honest observable
    // content of the initial-count rule is that the CREATED budget does
    // not leak into other states' counts. Mirrors dataquest's DRAFT test.
    assert.deepEqual(
      transitionTable().filter((e) => e.to === "CREATED"),
      [],
      "no transition targets CREATED in this table",
    );
    const escrow = new Escrow("e-visit-5", {
      maxVisitsByState: { CREATED: 1 },
    });
    assert.equal(escrow.visitCount("CREATED"), 1);
    escrow.dispatch("FUND", "initial funding", FUND_AMOUNT);
    assert.equal(escrow.state, "FUNDED");
    assert.equal(escrow.visitCount("CREATED"), 1);
    assert.equal(escrow.visitCount("FUNDED"), 1);
  });

  it("constructor rejects invalid budgets", () => {
    // 0 is already spent by the initial visit itself, so it is a
    // construction error, not a usable budget — same bar as dataquest.
    assert.throws(
      () => new Escrow("e-visit-6a", { maxVisitsByState: { FUNDED: 0 } }),
      (err: unknown) =>
        err instanceof Error &&
        err.message ===
          "invalid option: maxVisitsByState[FUNDED] must be a positive integer, got 0",
    );
    const bad: Array<[string, unknown, RegExp]> = [
      ["negative", { FUNDED: -1 }, /must be a positive integer, got -1/],
      ["fraction", { FUNDED: 1.5 }, /must be a positive integer, got 1\.5/],
      ["NaN", { FUNDED: Number.NaN }, /must be a positive integer, got NaN/],
      [
        "string",
        { FUNDED: "2" },
        /must be a positive integer, got 2/,
      ],
      [
        "unknown state",
        { FUNDDED: 1 },
        /maxVisitsByState has unknown state FUNDDED/,
      ],
      ["array", [], /maxVisitsByState must be an object, got object/],
      ["string map", "FUNDED", /maxVisitsByState must be an object, got string/],
    ];
    for (const [label, value, pattern] of bad) {
      assert.throws(
        () =>
          new Escrow("e-visit-6b", {
            maxVisitsByState: value as never,
          }),
        pattern,
        `${label} must fail fast at construction`,
      );
    }
    // An empty map is legal and means "no budgets".
    const empty = new Escrow("e-visit-6c", { maxVisitsByState: {} });
    funded(empty);
    milestoneRound(empty);
    assert.equal(empty.state, "FUNDED");
  });

  it("rejected dispatch leaves no residue and does not consume an idempotency key", () => {
    const escrow = new Escrow("e-visit-7", {
      maxVisitsByState: { FUNDED: 2 },
    });
    funded(escrow);
    milestoneRound(escrow); // FUNDED 2 of 2
    escrow.dispatch("SUBMIT_MILESTONE", "second milestone");
    const before = escrow.history.length;
    assert.throws(
      () =>
        escrow.dispatch("PARTIAL_RELEASE", "second tranche", TRANCHE, {
          idempotencyKey: "k-blocked",
        }),
      /state visit budget exhausted: FUNDED already visited 2 of 2 times/,
    );
    assert.equal(escrow.history.length, before);
    // The key was not consumed by the failed dispatch: the same key on
    // a different, legal event still executes.
    assert.equal(
      escrow.dispatch("DISPUTE", "dispute instead", undefined, {
        idempotencyKey: "k-blocked",
      }),
      "DISPUTED",
    );
    assert.equal(escrow.history.length, before + 1);
    // And now the key IS consumed: replaying it is a no-op.
    assert.equal(
      escrow.dispatch("DISPUTE", "replay", undefined, {
        idempotencyKey: "k-blocked",
      }),
      "DISPUTED",
    );
    assert.equal(escrow.history.length, before + 1);
  });

  it("visitCount steps per entry and throws on an unknown state", () => {
    const escrow = new Escrow("e-visit-8");
    assert.equal(escrow.visitCount("CREATED"), 1);
    assert.equal(escrow.visitCount("FUNDED"), 0);
    assert.equal(escrow.visitCount("RELEASED"), 0);
    funded(escrow);
    assert.equal(escrow.visitCount("CREATED"), 1);
    assert.equal(escrow.visitCount("FUNDED"), 1);
    escrow.dispatch("SUBMIT_MILESTONE", "milestone submitted");
    assert.equal(escrow.visitCount("MILESTONE_SUBMITTED"), 1);
    // A top-up self-loop counts as a fresh visit to FUNDED.
    escrow.dispatch("PARTIAL_RELEASE", "tranche released", TRANCHE);
    assert.equal(escrow.visitCount("FUNDED"), 2);
    assert.throws(
      () => escrow.visitCount("funded" as never),
      (err: unknown) =>
        err instanceof Error &&
        err.message === "invalid visit count: unknown state funded",
      "a misspelled state is a caller bug, not a zero count",
    );
  });

  it("top-up self-loop counts as a visit: FUNDED budget 2 stops the third FUND", () => {
    const escrow = new Escrow("e-visit-9", {
      maxVisitsByState: { FUNDED: 2 },
    });
    escrow.dispatch("FUND", "initial", 100); // 1 of 2
    escrow.dispatch("FUND", "top-up", 50); // 2 of 2
    assert.equal(escrow.visitCount("FUNDED"), 2);
    assert.throws(
      () => escrow.dispatch("FUND", "one too many", 10),
      (err: unknown) =>
        err instanceof Error &&
        err.message ===
          "state visit budget exhausted: FUNDED already visited 2 of 2 times",
    );
    assert.equal(escrow.history.length, 2);
  });

  it("snapshot round-trip preserves budget AND used count (no reset)", () => {
    const escrow = new Escrow("e-visit-10", {
      maxVisitsByState: { FUNDED: 2 },
    });
    funded(escrow);
    milestoneRound(escrow); // FUNDED 2 of 2
    const snapshot = escrow.toJSON();
    assert.deepEqual(snapshot.maxVisitsByState, { FUNDED: 2 });
    const restored = Escrow.fromJSON(snapshot);
    assert.equal(restored.visitCount("FUNDED"), 2);
    assert.deepEqual(restored.toJSON().maxVisitsByState, { FUNDED: 2 });
    restored.dispatch("SUBMIT_MILESTONE", "second milestone");
    assert.throws(
      () => restored.dispatch("PARTIAL_RELEASE", "second tranche", TRANCHE),
      /state visit budget exhausted: FUNDED already visited 2 of 2 times/,
      "the restored escrow resumes with the exact count the live escrow had",
    );
    // An explicit opts budget overrides the snapshot's entirely.
    const loosened = Escrow.fromJSON(snapshot, {
      maxVisitsByState: { FUNDED: 5 },
    });
    loosened.dispatch("SUBMIT_MILESTONE", "second milestone");
    assert.equal(
      loosened.dispatch("PARTIAL_RELEASE", "second tranche", TRANCHE),
      "FUNDED",
    );
    assert.equal(loosened.visitCount("FUNDED"), 3);
  });

  it("unbudgeted snapshots carry no maxVisitsByState field and rehydrate unlimited", () => {
    const escrow = new Escrow("e-visit-11");
    funded(escrow);
    assert.equal("maxVisitsByState" in escrow.toJSON(), false);
    const restored = Escrow.fromJSON(escrow.toJSON());
    for (let i = 0; i < 3; i++) milestoneRound(restored);
    assert.equal(restored.state, "FUNDED");
    assert.equal(restored.visitCount("FUNDED"), 4);
  });

  it("fromJSON accepts a snapshot whose history already exceeds its budget (policy for the future, not history truth)", () => {
    const escrow = new Escrow("e-visit-12");
    funded(escrow);
    milestoneRound(escrow);
    milestoneRound(escrow); // FUNDED visited 3 times, unbudgeted
    const snapshot = escrow.toJSON();
    (snapshot as { maxVisitsByState: unknown }).maxVisitsByState = {
      FUNDED: 2,
    };
    const restored = Escrow.fromJSON(snapshot);
    assert.equal(restored.state, "FUNDED");
    assert.equal(restored.visitCount("FUNDED"), 3);
    restored.dispatch("SUBMIT_MILESTONE", "milestone");
    assert.throws(
      () => restored.dispatch("PARTIAL_RELEASE", "tranche", TRANCHE),
      (err: unknown) =>
        err instanceof Error &&
        err.message ===
          "state visit budget exhausted: FUNDED already visited 3 of 2 times",
      "rehydration does not throw; the next dispatch into the state does",
    );
  });

  it("fromHistory re-attaches a budget; used count derives from the replayed log", () => {
    const escrow = new Escrow("e-visit-13");
    funded(escrow);
    milestoneRound(escrow); // FUNDED 2 of 2, in the bare log
    const history = escrow.history;
    const rebuilt = Escrow.fromHistory("e-visit-13", history, {
      maxVisitsByState: { FUNDED: 2 },
    });
    assert.equal(rebuilt.state, "FUNDED");
    assert.equal(rebuilt.visitCount("FUNDED"), 2);
    rebuilt.dispatch("SUBMIT_MILESTONE", "second milestone");
    assert.throws(
      () => rebuilt.dispatch("PARTIAL_RELEASE", "second tranche", TRANCHE),
      /state visit budget exhausted: FUNDED already visited 2 of 2 times/,
    );
    // A rebuild without the budget is unlimited, as before.
    const unbudgeted = Escrow.fromHistory("e-visit-13", history);
    unbudgeted.dispatch("SUBMIT_MILESTONE", "second milestone");
    assert.equal(
      unbudgeted.dispatch("PARTIAL_RELEASE", "second tranche", TRANCHE),
      "FUNDED",
    );
  });

  it("default (no opts): unlimited re-entries, pre-budget behavior unchanged", () => {
    const escrow = new Escrow("e-visit-14");
    funded(escrow);
    for (let i = 0; i < 5; i++) milestoneRound(escrow);
    assert.equal(escrow.state, "FUNDED");
    assert.equal(escrow.visitCount("FUNDED"), 6);
    const empty = new Escrow("e-visit-14b", {});
    funded(empty);
    for (let i = 0; i < 5; i++) milestoneRound(empty);
    assert.equal(empty.state, "FUNDED");
  });

  it("transition check runs before the budget check", () => {
    const escrow = new Escrow("e-visit-15", {
      maxVisitsByState: { FUNDED: 1 },
    });
    funded(escrow); // FUNDED 1 of 1
    escrow.dispatch("SUBMIT_MILESTONE", "milestone submitted");
    // FUND from MILESTONE_SUBMITTED is illegal, and its target (FUNDED)
    // is budget-exhausted — the transition error must report first.
    assert.throws(
      () => escrow.dispatch("FUND", "illegal", 10),
      (err: unknown) =>
        err instanceof Error &&
        err.message === "invalid transition: FUND from MILESTONE_SUBMITTED",
    );
    assert.equal(escrow.state, "MILESTONE_SUBMITTED");
  });

  it("RBAC check runs before the budget check", () => {
    const escrow = new Escrow("e-visit-16", {
      maxVisitsByState: { FUNDED: 1 },
      rolePolicy: { PARTIAL_RELEASE: ["treasury"] },
    });
    funded(escrow); // FUNDED 1 of 1
    escrow.dispatch("SUBMIT_MILESTONE", "milestone submitted");
    // No actor, and the budget is spent — RBAC reports first.
    assert.throws(
      () => escrow.dispatch("PARTIAL_RELEASE", "tranche", TRANCHE),
      (err: unknown) =>
        err instanceof Error &&
        err.message ===
          'actor not authorized for PARTIAL_RELEASE: policy requires an actor in [treasury]',
    );
    assert.equal(escrow.state, "MILESTONE_SUBMITTED");
  });

  it("fromJSON rejects malformed maxVisitsByState envelopes", () => {
    const escrow = new Escrow("e-visit-17");
    funded(escrow);
    const base = escrow.toJSON();
    const bad: Array<[string, unknown]> = [
      ["zero budget", { FUNDED: 0 }],
      ["fraction", { FUNDED: 1.5 }],
      ["unknown state", { NOPE: 1 }],
      ["non-object", "FUNDED"],
    ];
    for (const [label, value] of bad) {
      const tampered = { ...base, maxVisitsByState: value };
      assert.throws(
        () => Escrow.fromJSON(tampered),
        /invalid snapshot: maxVisitsByState/,
        `${label} must fail closed on restore`,
      );
    }
  });
});
