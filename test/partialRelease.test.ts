import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  allowedEvents,
  depositAmountFromHistory,
  releasedAmountFromHistory,
  transition,
} from "../src/index.js";

/**
 * #1028: the state machine had no partial-release event — the pure
 * settlement helpers (`settlePartialRelease` / `settlePartialReleases`)
 * could compute a tranche, but no transition could record it in the
 * append-only history, so milestone-based staged payouts (one tranche
 * per completed milestone) had no auditable form: the only ways out of
 * FUNDED were a full RELEASE or arbitration. `PARTIAL_RELEASE` closes
 * that gap: a mandatory cent-rounded amount, legal from FUNDED and
 * MILESTONE_SUBMITTED, self-looping back to FUNDED, never exceeding
 * the still-locked balance (FUND total minus released total).
 */

const T0 = "2026-03-01T00:00:00.000Z";
const T1 = "2026-03-01T00:00:01.000Z";
const T2 = "2026-03-01T00:00:02.000Z";
const T3 = "2026-03-01T00:00:03.000Z";
const T4 = "2026-03-01T00:00:04.000Z";
const T5 = "2026-03-01T00:00:05.000Z";

function fundedEscrow(id: string, amount = 10630): Escrow {
  const e = new Escrow(id);
  e.dispatch("FUND", "deposit", amount, { at: T0 });
  return e;
}

test("PARTIAL_RELEASE from FUNDED stays FUNDED and records the tranche", () => {
  const e = fundedEscrow("pr-1");
  assert.equal(e.dispatch("PARTIAL_RELEASE", "milestone 1", 4252, { at: T1 }), "FUNDED");
  assert.equal(e.history.length, 2);
  const entry = e.history[1];
  assert.equal(entry.event, "PARTIAL_RELEASE");
  assert.equal(entry.from, "FUNDED");
  assert.equal(entry.to, "FUNDED");
  assert.equal(entry.amount, 4252);
  assert.equal(entry.seq, 2);
  assert.equal(depositAmountFromHistory(e.history, "pr-1"), 10630);
  assert.equal(releasedAmountFromHistory(e.history, "pr-1"), 4252);
});

test("PARTIAL_RELEASE from MILESTONE_SUBMITTED returns to FUNDED", () => {
  const e = fundedEscrow("pr-2");
  e.dispatch("SUBMIT_MILESTONE", "milestone 1", undefined, { at: T1 });
  assert.equal(e.state, "MILESTONE_SUBMITTED");
  assert.equal(e.dispatch("PARTIAL_RELEASE", "agreed tranche", 4252, { at: T2 }), "FUNDED");
  assert.equal(e.history[2].from, "MILESTONE_SUBMITTED");
  assert.equal(e.history[2].to, "FUNDED");
  assert.equal(releasedAmountFromHistory(e.history, "pr-2"), 4252);
});

test("multiple partial releases accumulate against the locked balance", () => {
  const e = fundedEscrow("pr-3");
  e.dispatch("PARTIAL_RELEASE", "tranche 1", 4252, { at: T1 });
  e.dispatch("PARTIAL_RELEASE", "tranche 2", 6378, { at: T2 });
  assert.equal(e.state, "FUNDED");
  assert.equal(e.history.length, 3);
  assert.equal(releasedAmountFromHistory(e.history, "pr-3"), 10630);
  assert.equal(depositAmountFromHistory(e.history, "pr-3"), 10630);
  // Nothing left locked: the next release, however small, is refused.
  assert.throws(
    () => e.dispatch("PARTIAL_RELEASE", "one cent too many", 0.01, { at: T3 }),
    /partial release exceeds locked balance: release 0.01 exceeds locked 0/,
  );
  assert.equal(e.history.length, 3);
});

test("releasing exactly the remaining balance is legal and stays PARTIAL_RELEASE", () => {
  const e = fundedEscrow("pr-4", 1000);
  assert.equal(e.dispatch("PARTIAL_RELEASE", "all of it", 1000, { at: T1 }), "FUNDED");
  const entry = e.history[1];
  assert.equal(entry.event, "PARTIAL_RELEASE");
  assert.equal(entry.to, "FUNDED");
  assert.equal(releasedAmountFromHistory(e.history, "pr-4"), 1000);
  // It is NOT silently rewritten as a full RELEASE: the escrow is still
  // FUNDED, and a full release still needs VERIFY_PASS first.
  assert.equal(e.state, "FUNDED");
  assert.throws(
    () => e.dispatch("RELEASE", undefined, undefined, { at: T2 }),
    /invalid transition: RELEASE from FUNDED/,
  );
});

test("over-release is refused with no history residue", () => {
  const e = fundedEscrow("pr-5", 1000);
  e.dispatch("PARTIAL_RELEASE", "tranche 1", 600, { at: T1 });
  assert.throws(
    () => e.dispatch("PARTIAL_RELEASE", "too much", 401, { at: T2 }),
    /partial release exceeds locked balance: release 401 exceeds locked 400/,
  );
  assert.equal(e.state, "FUNDED");
  assert.equal(e.history.length, 2);
  assert.equal(releasedAmountFromHistory(e.history, "pr-5"), 600);
});

test("zero, negative, NaN and Infinity releases are refused with no residue", () => {
  const e = fundedEscrow("pr-6", 1000);
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => e.dispatch("PARTIAL_RELEASE", "bad amount", bad, { at: T1 }),
      /amount must be a finite non-negative number|PARTIAL_RELEASE amount must be greater than 0/,
    );
  }
  assert.equal(e.state, "FUNDED");
  assert.equal(e.history.length, 1);
  assert.equal(releasedAmountFromHistory(e.history, "pr-6"), 0);
});

test("PARTIAL_RELEASE without an amount is refused", () => {
  const e = fundedEscrow("pr-7", 1000);
  assert.throws(
    () => e.dispatch("PARTIAL_RELEASE", "no amount"),
    /amount is required on PARTIAL_RELEASE/,
  );
  assert.equal(e.history.length, 1);
});

test("PARTIAL_RELEASE is rejected from CREATED, VERIFIED and terminal states", () => {
  const fresh = new Escrow("pr-8a");
  assert.throws(
    () => fresh.dispatch("PARTIAL_RELEASE", undefined, 100, { at: T0 }),
    /invalid transition: PARTIAL_RELEASE from CREATED/,
  );
  const verified = fundedEscrow("pr-8b");
  verified.dispatch("SUBMIT_MILESTONE", undefined, undefined, { at: T1 });
  verified.dispatch("VERIFY_PASS", undefined, undefined, {
    at: T2,
    evidence: "oracle-req-1",
  });
  assert.throws(
    () => verified.dispatch("PARTIAL_RELEASE", undefined, 100, { at: T3 }),
    /invalid transition: PARTIAL_RELEASE from VERIFIED/,
  );
  verified.dispatch("RELEASE", undefined, undefined, { at: T4 });
  assert.throws(
    () => verified.dispatch("PARTIAL_RELEASE", undefined, 100, { at: T5 }),
    /invalid transition: PARTIAL_RELEASE from RELEASED/,
  );
  assert.equal(verified.history.length, 4);
});

test("releasedAmountFromHistory is 0 with no releases and throws on an amountless entry", () => {
  const e = fundedEscrow("pr-9");
  assert.equal(releasedAmountFromHistory(e.history, "pr-9"), 0);
  e.dispatch("PARTIAL_RELEASE", "tranche", 100, { at: T1 });
  const stripped = e.history.map((entry) =>
    entry.event === "PARTIAL_RELEASE" ? { ...entry, amount: undefined } : { ...entry },
  );
  // The parser accepts the amountless entry (like FUND); the strict
  // reader refuses to account for money the trail cannot corroborate.
  assert.throws(
    () => releasedAmountFromHistory(stripped, "pr-9"),
    /settlement requires a PARTIAL_RELEASE amount for pr-9: a PARTIAL_RELEASE event was recorded without an amount/,
  );
});

test("snapshot round-trip preserves the released total and dispatch continues", () => {
  const e = fundedEscrow("pr-10");
  e.dispatch("PARTIAL_RELEASE", "tranche 1", 4252, { at: T1 });
  const restored = Escrow.fromJSON(e.toJSON());
  assert.equal(restored.state, "FUNDED");
  assert.equal(releasedAmountFromHistory(restored.history, "pr-10"), 4252);
  restored.dispatch("PARTIAL_RELEASE", "tranche 2", 6378, { at: T2 });
  assert.equal(restored.history.length, 3);
  assert.equal(restored.history[2].seq, 3);
  assert.equal(releasedAmountFromHistory(restored.history, "pr-10"), 10630);
});

test("fromHistory replay restores a partially-released escrow", () => {
  const e = fundedEscrow("pr-11");
  e.dispatch("PARTIAL_RELEASE", "tranche 1", 4252, { at: T1 });
  const replayed = Escrow.fromHistory("pr-11", e.history);
  assert.equal(replayed.state, "FUNDED");
  assert.equal(releasedAmountFromHistory(replayed.history, "pr-11"), 4252);
  replayed.dispatch("PARTIAL_RELEASE", "tranche 2", 1000, { at: T2 });
  assert.equal(replayed.history.length, 3);
});

test("idempotent PARTIAL_RELEASE replays as a no-op; a failed release consumes no key", () => {
  const e = fundedEscrow("pr-12", 1000);
  e.dispatch("PARTIAL_RELEASE", "tranche", 600, { at: T1, idempotencyKey: "k1" });
  assert.equal(e.dispatch("PARTIAL_RELEASE", "tranche", 600, { at: T2, idempotencyKey: "k1" }), "FUNDED");
  assert.equal(e.history.length, 2);
  assert.equal(releasedAmountFromHistory(e.history, "pr-12"), 600);
  // A refused release (over the locked balance) consumes no key, so the
  // same key retries successfully with a corrected amount.
  assert.throws(
    () => e.dispatch("PARTIAL_RELEASE", "too much", 500, { at: T3, idempotencyKey: "k2" }),
    /partial release exceeds locked balance/,
  );
  assert.equal(e.dispatch("PARTIAL_RELEASE", "corrected", 400, { at: T4, idempotencyKey: "k2" }), "FUNDED");
  assert.equal(e.history.length, 3);
  assert.equal(releasedAmountFromHistory(e.history, "pr-12"), 1000);
});

test("maxDeposit cap is judged on the net locked balance, so a release frees room", () => {
  const e = new Escrow("pr-13", { maxDeposit: 10000 });
  e.dispatch("FUND", "deposit", 9000, { at: T0 });
  e.dispatch("PARTIAL_RELEASE", "tranche", 2000, { at: T1 });
  // Locked is now 7000: a 3000 top-up lands exactly on the cap.
  assert.equal(e.dispatch("FUND", "top-up", 3000, { at: T2 }), "FUNDED");
  assert.throws(
    () => e.dispatch("FUND", "one cent over", 0.01, { at: T3 }),
    /deposit cap exceeded: locked 10000 \+ new funding 0.01 would exceed maxDeposit 10000/,
  );
  assert.equal(e.history.length, 3);
});

test("PARTIAL_RELEASE amounts are rounded to cents like FUND amounts", () => {
  const e = fundedEscrow("pr-14", 10000);
  e.dispatch("PARTIAL_RELEASE", "rounding", 4252.125, { at: T1 });
  assert.equal(e.history[1].amount, 4252.13);
  assert.equal(releasedAmountFromHistory(e.history, "pr-14"), 4252.13);
});

test("transition table and allowedEvents list PARTIAL_RELEASE on both legal states", () => {
  assert.equal(transition("FUNDED", "PARTIAL_RELEASE"), "FUNDED");
  assert.equal(transition("MILESTONE_SUBMITTED", "PARTIAL_RELEASE"), "FUNDED");
  assert.deepEqual(allowedEvents("FUNDED"), [
    "FUND",
    "PARTIAL_RELEASE",
    "SUBMIT_MILESTONE",
    "DISPUTE",
    "EXPIRE",
  ]);
  assert.deepEqual(allowedEvents("MILESTONE_SUBMITTED"), [
    "VERIFY_PASS",
    "VERIFY_FAIL",
    "PARTIAL_RELEASE",
    "DISPUTE",
    "EXPIRE",
  ]);
  assert.ok(!allowedEvents("CREATED").includes("PARTIAL_RELEASE"));
  assert.ok(!allowedEvents("VERIFIED").includes("PARTIAL_RELEASE"));
  assert.deepEqual(allowedEvents("RELEASED"), []);
});

test("an amount on any other event is still rejected with the updated message", () => {
  const e = new Escrow("pr-15");
  assert.throws(
    () => e.dispatch("RELEASE", undefined, 100),
    /amount is only accepted on FUND and PARTIAL_RELEASE, not on RELEASE/,
  );
  e.dispatch("FUND");
  assert.throws(
    () => e.dispatch("SUBMIT_MILESTONE", undefined, 100),
    /amount is only accepted on FUND and PARTIAL_RELEASE/,
  );
  assert.equal(e.history.length, 1);
});
