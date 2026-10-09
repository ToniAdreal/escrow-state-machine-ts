/**
 * staleEscrows watchdog screening (backlog #147).
 *
 * `expiredEscrows()` answers "past an absolute deadline"; this helper
 * answers the orthogonal question "stuck in the CURRENT state too
 * long" — dwell is measured from the last history entry's `at`, per
 * state budget, strictly past the budget. Pure filter, no executor:
 * a stale escrow has no single default disposition (notify /
 * arbitrate / expire are all legitimate), so acting stays the
 * caller's job. Mirrors dataquest's `staleTasks`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Escrow, staleEscrows } from "../src/index.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const DAY = 24 * 3600_000;
const iso = (d: Date): string => d.toISOString();
const daysAgo = (n: number): string => iso(new Date(NOW.getTime() - n * DAY));

/** Escrow funded at a fixed time (deterministic dwell). */
function fundedAt(id: string, at: string): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 1000, { at });
  return escrow;
}

/** Escrow funded `fundDays` ago, milestone submitted `submitDays` ago. */
function milestoneAt(id: string, fundDays: number, submitDays: number): Escrow {
  const escrow = fundedAt(id, daysAgo(fundDays));
  escrow.dispatch("SUBMIT_MILESTONE", undefined, undefined, {
    at: daysAgo(submitDays),
  });
  return escrow;
}

const BUDGET = {
  FUNDED: 7 * DAY, // a funded escrow should see a milestone within a week
  MILESTONE_SUBMITTED: 30 * DAY, // verification may take up to a month
};

describe("staleEscrows", () => {
  it("FUNDED dwell over budget is selected, under budget is not", () => {
    const stale = fundedAt("stale-funded", daysAgo(30)); // 30d > 7d
    const fresh = fundedAt("fresh-funded", daysAgo(3)); // 3d < 7d
    const found = staleEscrows([stale, fresh], BUDGET, NOW);
    assert.deepEqual(
      found.map((e) => e.id),
      ["stale-funded"]
    );
  });

  it("per-state budgets apply: same dwell, different state, different verdict", () => {
    // Both escrows have been in their current state for exactly 10 days.
    const funded = fundedAt("in-funded", daysAgo(10)); // 10d > FUNDED 7d → stale
    const milestone = milestoneAt("in-milestone", 20, 10); // 10d < MILESTONE 30d → not
    const found = staleEscrows([funded, milestone], BUDGET, NOW);
    assert.deepEqual(
      found.map((e) => e.id),
      ["in-funded"]
    );
    // And the same FUNDED escrow flips verdict under a looser FUNDED budget.
    assert.deepEqual(staleEscrows([funded], { FUNDED: 30 * DAY }, NOW), []);
  });

  it("terminal escrows are never selected, however long the dwell", () => {
    const released = fundedAt("released", daysAgo(400));
    released.dispatch("SUBMIT_MILESTONE", undefined, undefined, {
      at: daysAgo(390),
    });
    released.dispatch("VERIFY_PASS", undefined, undefined, {
      at: daysAgo(380),
    });
    released.dispatch("RELEASE", undefined, undefined, { at: daysAgo(370) });
    const refunded = fundedAt("refunded", daysAgo(400));
    refunded.dispatch("DISPUTE", undefined, undefined, { at: daysAgo(390) });
    refunded.dispatch("ARBITRATE_REFUND", undefined, undefined, {
      at: daysAgo(380),
    });
    const expired = fundedAt("expired", daysAgo(400));
    expired.dispatch("EXPIRE", undefined, undefined, { at: daysAgo(390) });
    assert.deepEqual(
      staleEscrows(
        [released, refunded, expired],
        { RELEASED: 1, REFUNDED: 1, EXPIRED: 1 },
        NOW
      ),
      []
    );
  });

  it("an escrow with empty history is never selected", () => {
    const fresh = new Escrow("never-dispatched"); // CREATED, no history
    assert.equal(fresh.history.length, 0);
    assert.deepEqual(staleEscrows([fresh], { CREATED: 0 }, NOW), []);
    assert.deepEqual(staleEscrows([], BUDGET, NOW), []);
  });

  it("states absent from the budget are ignored (no budget = no staleness)", () => {
    const funded = fundedAt("no-budget", daysAgo(400)); // ancient, but…
    assert.deepEqual(
      staleEscrows([funded], { MILESTONE_SUBMITTED: 1 }, NOW),
      []
    );
    assert.deepEqual(staleEscrows([funded], {}, NOW), []);
  });

  it("dwell is measured from the LAST history entry, not the first", () => {
    // Funded 60d ago but milestone submitted 2d ago: dwell in
    // MILESTONE_SUBMITTED is 2d, well under the 30d budget.
    const movedRecently = milestoneAt("moved", 60, 2);
    assert.deepEqual(staleEscrows([movedRecently], BUDGET, NOW), []);
    // Same shape, but the milestone has now sat for 40d > 30d.
    const satTooLong = milestoneAt("sat", 60, 40);
    assert.deepEqual(
      staleEscrows([satTooLong], BUDGET, NOW).map((e) => e.id),
      ["sat"]
    );
  });

  it("boundary: dwell exactly at the budget is not stale; 1ms past is", () => {
    const exactlyAt = fundedAt("exact", daysAgo(7)); // dwell exactly 7d
    assert.deepEqual(staleEscrows([exactlyAt], { FUNDED: 7 * DAY }, NOW), []);
    const past = fundedAt(
      "past",
      iso(new Date(NOW.getTime() - 7 * DAY - 1))
    );
    assert.equal(staleEscrows([past], { FUNDED: 7 * DAY }, NOW).length, 1);
    // Zero budget: stale the instant any time has passed.
    assert.equal(
      staleEscrows([fundedAt("zero", daysAgo(1))], { FUNDED: 0 }, NOW).length,
      1
    );
  });

  it("is pure: no mutation, no dispatch, same instances returned", () => {
    const stale = fundedAt("pure-stale", daysAgo(30));
    const fresh = fundedAt("pure-fresh", daysAgo(1));
    const staleBefore = JSON.stringify(stale.toJSON());
    const freshBefore = JSON.stringify(fresh.toJSON());
    const found = staleEscrows([stale, fresh], BUDGET, NOW);
    assert.equal(found.length, 1);
    assert.ok(found[0] === stale, "returns the original instance, not a copy");
    assert.equal(JSON.stringify(stale.toJSON()), staleBefore);
    assert.equal(JSON.stringify(fresh.toJSON()), freshBefore);
    assert.equal(stale.state, "FUNDED");
    assert.equal(stale.history.length, 1);
  });

  it("is deterministic: double run with a fixed now gives identical results", () => {
    const a = fundedAt("det-a", daysAgo(30));
    const b = milestoneAt("det-b", 50, 40);
    const c = fundedAt("det-c", daysAgo(1));
    const first = staleEscrows([a, b, c], BUDGET, NOW).map((e) => e.id);
    const second = staleEscrows([a, b, c], BUDGET, NOW).map((e) => e.id);
    assert.deepEqual(first, ["det-a", "det-b"]); // input order preserved
    assert.deepEqual(second, first);
  });

  it("invalid budget configuration fails fast", () => {
    const escrow = fundedAt("cfg", daysAgo(30));
    assert.throws(
      () => staleEscrows([escrow], { BOGUS: 1000 } as never, NOW),
      /invalid maxAgeByState: unknown state "BOGUS"/
    );
    assert.throws(
      () => staleEscrows([escrow], { FUNDED: -1 }, NOW),
      /invalid maxAgeByState: budget for "FUNDED" must be a non-negative finite number/
    );
    assert.throws(
      () => staleEscrows([escrow], { FUNDED: Number.NaN }, NOW),
      /invalid maxAgeByState: budget for "FUNDED" must be a non-negative finite number/
    );
    assert.throws(
      () => staleEscrows([escrow], { FUNDED: Number.POSITIVE_INFINITY }, NOW),
      /invalid maxAgeByState: budget for "FUNDED" must be a non-negative finite number/
    );
    assert.throws(
      () => staleEscrows([escrow], BUDGET, new Date(NaN)),
      /invalid now: expected a valid Date/
    );
    // Fail-fast means the escrow was never touched.
    assert.equal(escrow.state, "FUNDED");
    assert.equal(escrow.history.length, 1);
  });
});
