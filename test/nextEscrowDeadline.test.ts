/**
 * Scheduler helper nextEscrowDeadline (backlog #834).
 *
 * The watchdog pair expiredEscrows()/expireOverdueEscrows() answers
 * "past deadline, act now"; this helper answers the scheduler's
 * question — "which non-terminal escrow comes due next, and when" —
 * so a caller can arm one timer instead of polling the batch. Only
 * non-terminal escrows with a deadline strictly after `now` qualify;
 * terminal, overdue, due-right-now, and deadline-less escrows are all
 * excluded, ties keep input order, and the helper never mutates.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Escrow, nextEscrowDeadline } from "../src/index.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const PAST = "2026-01-01T00:00:00.000Z";
const AT_NOW = "2026-06-01T00:00:00.000Z";
const SOON = "2026-06-15T00:00:00.000Z";
const LATER = "2026-07-01T00:00:00.000Z";
const LATEST = "2027-01-01T00:00:00.000Z";

function fundedEscrow(id: string, deadline?: string): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 1000);
  if (deadline !== undefined) escrow.setDeadline(deadline);
  return escrow;
}

function releasedEscrow(id: string, deadline: string): Escrow {
  const escrow = fundedEscrow(id, deadline);
  escrow.dispatch("SUBMIT_MILESTONE");
  escrow.dispatch("VERIFY_PASS");
  escrow.dispatch("RELEASE");
  return escrow;
}

describe("nextEscrowDeadline", () => {
  it("picks the earliest future deadline from a mixed batch", () => {
    const latest = fundedEscrow("n1", LATEST);
    const soon = fundedEscrow("n2", SOON);
    const later = fundedEscrow("n3", LATER);
    const result = nextEscrowDeadline([latest, soon, later], NOW);
    assert.ok(result !== undefined);
    assert.equal(result.escrow, soon);
    assert.equal(result.deadline, SOON);
  });

  it("excludes terminal, overdue, due-now, and deadline-less escrows", () => {
    const terminal = releasedEscrow("n4", SOON);
    const overdue = fundedEscrow("n5", PAST);
    const dueNow = fundedEscrow("n6", AT_NOW);
    const noDeadline = fundedEscrow("n7");
    const candidate = fundedEscrow("n8", LATER);
    const result = nextEscrowDeadline(
      [terminal, overdue, dueNow, noDeadline, candidate],
      NOW
    );
    assert.ok(result !== undefined);
    assert.equal(result.escrow, candidate);
    assert.equal(result.deadline, LATER);
  });

  it("returns undefined when every escrow is excluded", () => {
    const terminal = releasedEscrow("n9", LATEST);
    const overdue = fundedEscrow("n10", PAST);
    const noDeadline = fundedEscrow("n11");
    assert.equal(
      nextEscrowDeadline([terminal, overdue, noDeadline], NOW),
      undefined
    );
  });

  it("returns undefined for an empty batch", () => {
    assert.equal(nextEscrowDeadline([], NOW), undefined);
  });

  it("keeps input order on a tie for the earliest deadline", () => {
    const first = fundedEscrow("n12", SOON);
    const second = fundedEscrow("n13", SOON);
    const result = nextEscrowDeadline([second, first], NOW);
    assert.ok(result !== undefined);
    assert.equal(result.escrow, second);
    assert.equal(result.deadline, SOON);
  });

  it("throws fail-fast on an invalid now", () => {
    const escrow = fundedEscrow("n14", LATEST);
    assert.throws(
      () => nextEscrowDeadline([escrow], new Date(NaN)),
      /invalid now: expected a valid Date/
    );
  });

  it("is pure: state, history, deadline, and batch order are untouched", () => {
    const a = fundedEscrow("n15", LATER);
    const b = fundedEscrow("n16", SOON);
    const batch = [a, b];
    const stateBefore = [a.state, b.state];
    const historyBefore = [a.history, b.history];
    const deadlineBefore = [a.getDeadline(), b.getDeadline()];
    const result = nextEscrowDeadline(batch, NOW);
    assert.ok(result !== undefined);
    assert.equal(result.escrow, b);
    assert.deepEqual(
      batch.map((e) => e.id),
      ["n15", "n16"]
    );
    assert.deepEqual(
      batch.map((e) => e.state),
      stateBefore
    );
    assert.deepEqual(
      batch.map((e) => e.history),
      historyBefore
    );
    assert.deepEqual(
      batch.map((e) => e.getDeadline()),
      deadlineBefore
    );
  });

  it("is deterministic: a fixed now gives the same answer on repeat runs", () => {
    const batch = [
      fundedEscrow("n17", LATEST),
      fundedEscrow("n18", SOON),
      fundedEscrow("n19", LATER),
    ];
    const first = nextEscrowDeadline(batch, NOW);
    const second = nextEscrowDeadline(batch, NOW);
    assert.ok(first !== undefined && second !== undefined);
    assert.equal(first.escrow, second.escrow);
    assert.equal(first.deadline, second.deadline);
  });

  it("does not confuse a settled escrow's earliest deadline with the batch's next one", () => {
    // A RELEASED escrow carrying the batch's earliest deadline must not
    // win: its deadline no longer schedules anything.
    const settled = releasedEscrow("n20", SOON);
    const live = fundedEscrow("n21", LATER);
    const result = nextEscrowDeadline([settled, live], NOW);
    assert.ok(result !== undefined);
    assert.equal(result.escrow, live);
    assert.equal(result.deadline, LATER);
  });
});
