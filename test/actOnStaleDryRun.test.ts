/**
 * actOnStaleEscrows dry run (backlog #1083).
 *
 * `expireOverdueEscrows` gained a dry-run rehearsal port in #1050;
 * this is the same port for the stale-escrow watchdog executor, so a
 * caller can preview a sweep before running a real action over it.
 * Semantics differ in one honest way: the stale executor takes an
 * arbitrary caller-supplied action, so `wouldAct` answers only
 * "in the stale selection", never "would succeed" — a dispatch-style
 * action can still be illegal from the escrow's state, and the dry
 * run does not predict that. The live run keeps reporting the actual
 * outcome via `acted` and leaves `wouldAct` absent.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Escrow, actOnStaleEscrows } from "../src/index.js";

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

describe("actOnStaleEscrows dry run", () => {
  it("dry run calls the action zero times and leaves state/history untouched", () => {
    const stale = fundedAt("stale", daysAgo(30));
    const fresh = fundedAt("fresh", daysAgo(3));
    let calls = 0;
    const results = actOnStaleEscrows(
      [stale, fresh],
      () => {
        calls += 1;
      },
      BUDGET,
      NOW,
      { dryRun: true }
    );
    assert.equal(calls, 0);
    assert.deepEqual(
      results.map((r) => [r.escrow.id, r.acted, r.wouldAct]),
      [["stale", false, true]]
    );
    assert.equal(results[0].error, undefined);
    assert.equal(results[0].entry, undefined);
    assert.equal(stale.state, "FUNDED");
    assert.equal(stale.history.length, 1);
    assert.equal(fresh.state, "FUNDED");
    assert.equal(fresh.history.length, 1);
  });

  it("wouldAct is true exactly for the stale set: fresh, terminal, and history-less escrows are absent", () => {
    const staleFunded = fundedAt("stale-funded", daysAgo(30));
    const fresh = fundedAt("fresh", daysAgo(2));
    const staleVerified = verifiedStale("stale-verified");
    const settled = fundedAt("settled", daysAgo(60));
    settled.dispatch("SUBMIT_MILESTONE", undefined, undefined, { at: daysAgo(55) });
    settled.dispatch("VERIFY_PASS", undefined, undefined, { at: daysAgo(52) });
    settled.dispatch("RELEASE", undefined, undefined, { at: daysAgo(50) });
    const neverFunded = new Escrow("never-funded");
    const results = actOnStaleEscrows(
      [staleFunded, fresh, staleVerified, settled, neverFunded],
      () => {
        throw new Error("must never be called");
      },
      BUDGET,
      NOW,
      { dryRun: true }
    );
    assert.deepEqual(
      results.map((r) => r.escrow.id),
      ["stale-funded", "stale-verified"]
    );
    assert.ok(results.every((r) => r.acted === false && r.wouldAct === true));
    assert.equal(settled.state, "RELEASED");
    assert.equal(neverFunded.state, "CREATED");
  });

  it("a dry run followed by a live run on the same batch still executes", () => {
    const stale = fundedAt("stale", daysAgo(30));
    const seen: string[] = [];
    const dry = actOnStaleEscrows([stale], (e) => seen.push(e.id), BUDGET, NOW, {
      dryRun: true,
    });
    assert.equal(dry.length, 1);
    assert.equal(seen.length, 0);
    assert.equal(stale.state, "FUNDED");
    const live = actOnStaleEscrows([stale], (e) => seen.push(e.id), BUDGET, NOW);
    assert.equal(live.length, 1);
    assert.equal(live[0].acted, true);
    assert.equal(live[0].wouldAct, undefined);
    assert.deepEqual(seen, ["stale"]);
  });

  it("invalid opts fail fast with zero action calls, before the action check", () => {
    const stale = fundedAt("stale", daysAgo(30));
    let calls = 0;
    const spy = () => {
      calls += 1;
    };
    assert.throws(
      () => actOnStaleEscrows([stale], spy, BUDGET, NOW, "yes" as never),
      /invalid actOnStaleEscrows options: opts must be an object/
    );
    assert.throws(
      () => actOnStaleEscrows([stale], spy, BUDGET, NOW, null as never),
      /invalid actOnStaleEscrows options: opts must be an object/
    );
    assert.throws(
      () => actOnStaleEscrows([stale], spy, BUDGET, NOW, [] as never),
      /invalid actOnStaleEscrows options: opts must be an object/
    );
    assert.throws(
      () =>
        actOnStaleEscrows([stale], spy, BUDGET, NOW, { dryRun: "yes" } as never),
      /invalid actOnStaleEscrows options: dryRun must be a boolean, got "yes"/
    );
    assert.throws(
      () => actOnStaleEscrows([stale], spy, BUDGET, NOW, { dryRun: 1 } as never),
      /invalid actOnStaleEscrows options: dryRun must be a boolean, got 1/
    );
    assert.throws(
      () =>
        actOnStaleEscrows([stale], spy, BUDGET, NOW, { dryRun: null } as never),
      /invalid actOnStaleEscrows options: dryRun must be a boolean, got null/
    );
    // An invalid opts object beats an invalid action: both are config
    // errors, and opts is checked first, still before any action runs.
    assert.throws(
      () =>
        actOnStaleEscrows([stale], undefined as never, BUDGET, NOW, {
          dryRun: "yes",
        } as never),
      /invalid actOnStaleEscrows options: dryRun must be a boolean/
    );
    assert.equal(calls, 0);
    assert.equal(stale.state, "FUNDED");
    assert.equal(stale.history.length, 1);
  });

  it("empty and all-fresh batches dry-run to no entries", () => {
    let calls = 0;
    const action = () => {
      calls += 1;
    };
    assert.deepEqual(
      actOnStaleEscrows([], action, BUDGET, NOW, { dryRun: true }),
      []
    );
    assert.deepEqual(
      actOnStaleEscrows(
        [fundedAt("fresh", daysAgo(1))],
        action,
        BUDGET,
        NOW,
        { dryRun: true }
      ),
      []
    );
    assert.equal(calls, 0);
  });

  it("an action that would throw is never invoked in a dry run: only wouldAct is reported", () => {
    const stale = fundedAt("stale", daysAgo(30));
    const results = actOnStaleEscrows(
      [stale],
      () => {
        throw new Error("notify backend down");
      },
      BUDGET,
      NOW,
      { dryRun: true }
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].acted, false);
    assert.equal(results[0].wouldAct, true);
    assert.equal(results[0].error, undefined);
    assert.equal(stale.state, "FUNDED");
    assert.equal(stale.history.length, 1);
  });

  it("wouldAct means selected, not would-succeed: an illegal EXPIRE edge still reports wouldAct", () => {
    // VERIFIED has no EXPIRE edge, so the live run would report
    // acted: false with an "invalid transition" error — but the dry
    // run cannot know that about an arbitrary action, and reports
    // the selection only. The escrow is untouched either way.
    const stuck = verifiedStale("stuck-verified");
    const results = actOnStaleEscrows(
      [stuck],
      (e) => e.dispatch("EXPIRE"),
      BUDGET,
      NOW,
      { dryRun: true }
    );
    assert.deepEqual(
      results.map((r) => [r.acted, r.wouldAct, r.error]),
      [[false, true, undefined]]
    );
    assert.equal(stuck.state, "VERIFIED");
    assert.equal(stuck.history.length, 3);
  });

  it("a dry run produces zero subscription notifications", () => {
    const stale = fundedAt("stale", daysAgo(30));
    const notifications: string[] = [];
    stale.subscribe((_event, _from, to) => {
      notifications.push(to);
    });
    const results = actOnStaleEscrows(
      [stale],
      (e) => e.dispatch("EXPIRE"),
      BUDGET,
      NOW,
      { dryRun: true }
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].wouldAct, true);
    assert.deepEqual(notifications, []);
    assert.equal(stale.state, "FUNDED");
  });

  it("dryRun: false and an empty opts object behave as the live run", () => {
    const staleA = fundedAt("stale-a", daysAgo(30));
    const staleB = fundedAt("stale-b", daysAgo(30));
    const seen: string[] = [];
    const off = actOnStaleEscrows(
      [staleA],
      (e) => seen.push(e.id),
      BUDGET,
      NOW,
      { dryRun: false }
    );
    assert.equal(off[0].acted, true);
    assert.equal(off[0].wouldAct, undefined);
    const empty = actOnStaleEscrows(
      [staleB],
      (e) => seen.push(e.id),
      BUDGET,
      NOW,
      {}
    );
    assert.equal(empty[0].acted, true);
    assert.equal(empty[0].wouldAct, undefined);
    assert.deepEqual(seen, ["stale-a", "stale-b"]);
  });

  it("invalid maxAgeByState / now still fail fast in a dry run, before any action", () => {
    const stale = fundedAt("stale", daysAgo(30));
    let calls = 0;
    const spy = () => {
      calls += 1;
    };
    assert.throws(
      () =>
        actOnStaleEscrows([stale], spy, { BOGUS: 1000 } as never, NOW, {
          dryRun: true,
        }),
      /invalid maxAgeByState: unknown state "BOGUS"/
    );
    assert.throws(
      () =>
        actOnStaleEscrows([stale], spy, BUDGET, new Date(NaN), {
          dryRun: true,
        }),
      /invalid now: expected a valid Date/
    );
    assert.equal(calls, 0);
    assert.equal(stale.state, "FUNDED");
    assert.equal(stale.history.length, 1);
  });
});
