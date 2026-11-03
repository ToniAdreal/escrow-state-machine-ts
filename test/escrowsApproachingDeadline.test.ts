/**
 * Watchdog helper escrowsApproachingDeadline (backlog #840).
 *
 * The dataquest lifecycle already has tasksApproachingDeadline; the
 * escrow side only had the two poles — expiredEscrows (past deadline)
 * and staleEscrows (stuck too long) — with no "warn before it is too
 * late" primitive in between. This helper fills that gap with the same
 * window semantics: non-terminal, deadline inside (now, now + withinMs]
 * — overdue belongs to expiredEscrows, never to both.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  escrowsApproachingDeadline,
  expiredEscrows,
} from "../src/index.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const DAY = 24 * 3600_000;
const PAST = "2026-01-01T00:00:00.000Z";
const AT_NOW = "2026-06-01T00:00:00.000Z";
const SOON = "2026-06-15T00:00:00.000Z";
const AT_EDGE = "2026-06-08T00:00:00.000Z";
const JUST_PAST_EDGE = "2026-06-08T00:00:00.001Z";
const LATER = "2026-07-01T00:00:00.000Z";

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

describe("escrowsApproachingDeadline", () => {
  it("returns every in-window escrow, in input order", () => {
    const later = fundedEscrow("a1", LATER);
    const soon = fundedEscrow("a2", SOON);
    const edge = fundedEscrow("a3", AT_EDGE);
    const result = escrowsApproachingDeadline(
      [later, soon, edge],
      7 * DAY,
      NOW
    );
    // Only the 7-day window qualifies: SOON is 14 days out, LATER
    // further still; AT_EDGE is exactly 7 days out (upper bound
    // inclusive), so only the edge escrow is selected here.
    assert.deepEqual(
      result.map((e) => e.id),
      ["a3"]
    );
    const wide = escrowsApproachingDeadline(
      [later, soon, edge],
      40 * DAY,
      NOW
    );
    assert.deepEqual(
      wide.map((e) => e.id),
      ["a1", "a2", "a3"]
    );
  });

  it("excludes terminal, overdue, due-now, and deadline-less escrows", () => {
    const terminal = releasedEscrow("a4", SOON);
    const overdue = fundedEscrow("a5", PAST);
    const dueNow = fundedEscrow("a6", AT_NOW);
    const noDeadline = fundedEscrow("a7");
    const candidate = fundedEscrow("a8", SOON);
    const result = escrowsApproachingDeadline(
      [terminal, overdue, dueNow, noDeadline, candidate],
      30 * DAY,
      NOW
    );
    assert.deepEqual(
      result.map((e) => e.id),
      ["a8"]
    );
  });

  it("excludes a deadline exactly at now (lower bound exclusive)", () => {
    const dueNow = fundedEscrow("a9", AT_NOW);
    assert.deepEqual(escrowsApproachingDeadline([dueNow], DAY, NOW), []);
    // ...and even a zero window cannot admit it.
    assert.deepEqual(escrowsApproachingDeadline([dueNow], 0, NOW), []);
  });

  it("includes a deadline exactly at now + withinMs (upper bound inclusive)", () => {
    const edge = fundedEscrow("a10", AT_EDGE);
    const result = escrowsApproachingDeadline([edge], 7 * DAY, NOW);
    assert.deepEqual(
      result.map((e) => e.id),
      ["a10"]
    );
  });

  it("excludes a deadline one millisecond past the window", () => {
    const past = fundedEscrow("a11", JUST_PAST_EDGE);
    assert.deepEqual(escrowsApproachingDeadline([past], 7 * DAY, NOW), []);
  });

  it("returns an empty array for an empty batch", () => {
    assert.deepEqual(escrowsApproachingDeadline([], DAY, NOW), []);
  });

  it("returns nothing for a zero window, even with a future deadline", () => {
    const soon = fundedEscrow("a12", SOON);
    assert.deepEqual(escrowsApproachingDeadline([soon], 0, NOW), []);
  });

  it("throws fail-fast on invalid withinMs", () => {
    const escrow = fundedEscrow("a13", SOON);
    for (const bad of [NaN, Infinity, -1, -DAY]) {
      assert.throws(
        () => escrowsApproachingDeadline([escrow], bad, NOW),
        /invalid escrowsApproachingDeadline: withinMs must be a non-negative finite number/
      );
    }
    assert.throws(
      () =>
        escrowsApproachingDeadline(
          [escrow],
          "7 days" as unknown as number,
          NOW
        ),
      /invalid escrowsApproachingDeadline: withinMs must be a non-negative finite number/
    );
  });

  it("throws fail-fast on an invalid now", () => {
    const escrow = fundedEscrow("a14", SOON);
    assert.throws(
      () => escrowsApproachingDeadline([escrow], DAY, new Date(NaN)),
      /invalid now: expected a valid Date/
    );
  });

  it("is pure: state, history, deadline, and batch order are untouched", () => {
    const a = fundedEscrow("a15", LATER);
    const b = fundedEscrow("a16", SOON);
    const batch = [a, b];
    const stateBefore = [a.state, b.state];
    const historyBefore = [a.history, b.history];
    const deadlineBefore = [a.getDeadline(), b.getDeadline()];
    const result = escrowsApproachingDeadline(batch, 30 * DAY, NOW);
    // Both qualify (LATER lands exactly on the inclusive upper bound),
    // and the filter preserves input order.
    assert.deepEqual(
      result.map((e) => e.id),
      ["a15", "a16"]
    );
    assert.deepEqual(
      batch.map((e) => e.id),
      ["a15", "a16"]
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

  it("never overlaps expiredEscrows on the same batch", () => {
    const overdue = fundedEscrow("a17", PAST);
    const dueNow = fundedEscrow("a18", AT_NOW);
    const approaching = fundedEscrow("a19", SOON);
    const far = fundedEscrow("a20", LATER);
    const batch = [overdue, dueNow, approaching, far];
    // 20-day window: SOON (14 days out) qualifies, LATER (30 days out)
    // does not — so the far escrow is in neither helper's selection.
    const atRisk = escrowsApproachingDeadline(batch, 20 * DAY, NOW);
    const expired = expiredEscrows(batch, NOW);
    assert.deepEqual(
      atRisk.map((e) => e.id),
      ["a19"]
    );
    assert.deepEqual(
      expired.map((e) => e.id),
      ["a17", "a18"]
    );
    const overlap = atRisk.filter((e) => expired.includes(e));
    assert.deepEqual(overlap, []);
  });

  it("is deterministic: a fixed now gives the same answer on repeat runs", () => {
    const batch = [
      fundedEscrow("a21", LATER),
      fundedEscrow("a22", SOON),
      fundedEscrow("a23", PAST),
    ];
    const first = escrowsApproachingDeadline(batch, 30 * DAY, NOW);
    const second = escrowsApproachingDeadline(batch, 30 * DAY, NOW);
    assert.deepEqual(
      first.map((e) => e.id),
      second.map((e) => e.id)
    );
  });
});
