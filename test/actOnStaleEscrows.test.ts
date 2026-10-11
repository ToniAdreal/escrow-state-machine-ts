/**
 * actOnStaleEscrows watchdog executor (backlog #179).
 *
 * `staleEscrows()` is a pure filter, but acting on its selection with
 * a hand-written loop has a trap: dispatch-style actions (e.g.
 * EXPIRE) are not legal from every non-terminal state, so the loop
 * aborts on the first unactionable escrow. actOnStaleEscrows() runs a
 * caller-supplied action per stale escrow, isolates per-escrow
 * failures, and reports `{ escrow, acted, error? }` per attempt —
 * semantics aligned item-for-item with dataquest's actOnStaleTasks
 * (threshold params, result shape, error isolation), except that
 * there is NO default action: a stale escrow has no single obvious
 * disposition, so the action is required.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Escrow, actOnStaleEscrows, staleEscrows } from "../src/index.js";
import type { StaleEscrowActionResult } from "../src/index.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const DAY = 24 * 3600_000;
const iso = (d: Date): string => d.toISOString();
const daysAgo = (n: number): string => iso(new Date(NOW.getTime() - n * DAY));

function fundedAt(id: string, at: string): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 1000, { at });
  return escrow;
}

/** FUNDED 40d ago, milestone submitted 35d ago, verified 30d ago. */
function verifiedStale(id: string): Escrow {
  const escrow = fundedAt(id, daysAgo(40));
  escrow.dispatch("SUBMIT_MILESTONE", undefined, undefined, {
    at: daysAgo(35),
  });
  escrow.dispatch("VERIFY_PASS", undefined, undefined, { at: daysAgo(30) });
  return escrow;
}

const BUDGET = { FUNDED: 7 * DAY, VERIFIED: 7 * DAY };

describe("actOnStaleEscrows", () => {
  it("mixed healthy/stale batch: only stale escrows are acted on, in batch order", () => {
    const staleA = fundedAt("stale-a", daysAgo(30));
    const fresh = fundedAt("fresh", daysAgo(3));
    const staleB = fundedAt("stale-b", daysAgo(20));
    const seen: string[] = [];
    const results = actOnStaleEscrows(
      [staleA, fresh, staleB],
      (e) => seen.push(e.id),
      BUDGET,
      NOW
    );
    assert.deepEqual(seen, ["stale-a", "stale-b"]);
    assert.deepEqual(
      results.map((r) => r.escrow.id),
      ["stale-a", "stale-b"]
    );
    assert.ok(results.every((r) => r.acted && r.error === undefined));
    // The fresh escrow produced no entry and was never touched.
    assert.equal(fresh.state, "FUNDED");
    assert.equal(fresh.history.length, 1);
  });

  it("a throwing action is isolated: its escrow reports the error, the rest still run", () => {
    const bad = fundedAt("bad", daysAgo(30));
    const good = fundedAt("good", daysAgo(25));
    const results = actOnStaleEscrows(
      [bad, good],
      (e) => {
        if (e.id === "bad") throw new Error("notify backend down");
      },
      BUDGET,
      NOW
    );
    assert.equal(results.length, 2);
    assert.equal(results[0].acted, false);
    assert.equal(results[0].error, "notify backend down");
    assert.equal(results[1].acted, true);
    assert.equal(results[1].error, undefined);
  });

  it("a non-Error throw is stringified into the result error", () => {
    const escrow = fundedAt("string-throw", daysAgo(30));
    const results = actOnStaleEscrows(
      [escrow],
      () => {
        throw "plain string failure"; // eslint-disable-line no-throw-literal
      },
      BUDGET,
      NOW
    );
    assert.deepEqual(
      results.map((r) => [r.acted, r.error]),
      [[false, "plain string failure"]]
    );
  });

  it("dispatch-style action: EXPIRE succeeds where legal, is reported (not fatal) from VERIFIED", () => {
    const expirable = fundedAt("expirable", daysAgo(30)); // FUNDED has an EXPIRE edge
    const stuck = verifiedStale("stuck-verified"); // VERIFIED has none
    const after = fundedAt("after", daysAgo(28));
    const results: StaleEscrowActionResult[] = actOnStaleEscrows(
      [expirable, stuck, after],
      (e) => e.dispatch("EXPIRE"),
      BUDGET,
      NOW
    );
    assert.equal(results[0].acted, true);
    assert.equal(expirable.state, "EXPIRED");
    assert.equal(results[1].acted, false);
    assert.match(results[1].error ?? "", /invalid transition: EXPIRE from VERIFIED/);
    // The failed escrow is left untouched and the batch kept going.
    assert.equal(stuck.state, "VERIFIED");
    assert.equal(stuck.history.length, 3);
    assert.equal(results[2].acted, true);
    assert.equal(after.state, "EXPIRED");
  });

  it("empty batch and all-fresh batch produce no entries and run no action", () => {
    let calls = 0;
    const action = () => {
      calls += 1;
    };
    assert.deepEqual(actOnStaleEscrows([], action, BUDGET, NOW), []);
    assert.deepEqual(
      actOnStaleEscrows([fundedAt("fresh", daysAgo(1))], action, BUDGET, NOW),
      []
    );
    assert.equal(calls, 0);
  });

  it("threshold boundary: dwell exactly at the budget is not acted on; 1ms past is", () => {
    const exactlyAt = fundedAt("exact", daysAgo(7));
    const past = fundedAt("past", iso(new Date(NOW.getTime() - 7 * DAY - 1)));
    const seen: string[] = [];
    const results = actOnStaleEscrows(
      [exactlyAt, past],
      (e) => seen.push(e.id),
      { FUNDED: 7 * DAY },
      NOW
    );
    assert.deepEqual(seen, ["past"]);
    assert.equal(results.length, 1);
    assert.equal(results[0].escrow, past);
  });

  it("result counts are self-consistent with the staleEscrows selection", () => {
    const batch = [
      fundedAt("a", daysAgo(30)),
      fundedAt("b", daysAgo(2)),
      verifiedStale("c"),
      fundedAt("d", daysAgo(15)),
    ];
    const results = actOnStaleEscrows(
      batch,
      (e) => {
        if (e.id === "c") throw new Error("boom");
      },
      BUDGET,
      NOW
    );
    const selected = staleEscrows(batch, BUDGET, NOW);
    assert.equal(results.length, selected.length);
    const acted = results.filter((r) => r.acted).length;
    const failed = results.filter((r) => !r.acted).length;
    assert.equal(acted + failed, results.length);
    assert.equal(acted, 2);
    assert.equal(failed, 1);
    // Every failure carries an error; every success carries none.
    assert.ok(results.every((r) => (r.acted ? r.error === undefined : typeof r.error === "string")));
  });

  it("invalid configuration fails fast before any action runs", () => {
    const escrow = fundedAt("cfg", daysAgo(30));
    let calls = 0;
    const spy = () => {
      calls += 1;
    };
    assert.throws(
      () => actOnStaleEscrows([escrow], spy, { BOGUS: 1000 } as never, NOW),
      /invalid maxAgeByState: unknown state "BOGUS"/
    );
    assert.throws(
      () => actOnStaleEscrows([escrow], spy, { FUNDED: -1 }, NOW),
      /invalid maxAgeByState: budget for "FUNDED" must be a non-negative finite number/
    );
    assert.throws(
      () => actOnStaleEscrows([escrow], spy, BUDGET, new Date(NaN)),
      /invalid now: expected a valid Date/
    );
    assert.throws(
      () => actOnStaleEscrows([escrow], undefined as never, BUDGET, NOW),
      /invalid action: expected a function/
    );
    assert.throws(
      () => actOnStaleEscrows([escrow], "EXPIRE" as never, BUDGET, NOW),
      /invalid action: expected a function/
    );
    assert.equal(calls, 0);
    assert.equal(escrow.state, "FUNDED");
    assert.equal(escrow.history.length, 1);
  });

  it("now is injectable: the same escrow is fresh earlier, stale later", () => {
    const escrow = fundedAt("timed", daysAgo(10));
    const seen: string[] = [];
    const earlier = new Date(NOW.getTime() - 8 * DAY); // dwell 2d < 7d
    assert.deepEqual(actOnStaleEscrows([escrow], (e) => seen.push(e.id), BUDGET, earlier), []);
    assert.equal(seen.length, 0);
    const results = actOnStaleEscrows([escrow], (e) => seen.push(e.id), BUDGET, NOW);
    assert.equal(results.length, 1);
    assert.deepEqual(seen, ["timed"]);
  });
});
