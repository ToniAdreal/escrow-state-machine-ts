/**
 * stuckEscrows watchdog selector (backlog #1434).
 *
 * `expiredEscrows()` flags every overdue escrow, but a `DISPUTED`
 * escrow has no `EXPIRE` edge — expiry must not let a party walk out
 * of an open arbitration unilaterally — so no executor can ever expire
 * it. Before this item, the watchdog re-reported the same transition
 * error for those escrows every round, and the operator had no way to
 * tell "already expired" from "overdue but unexpirable".
 * `stuckEscrows()` lists exactly the unexpirable subset, so
 * `stuckEscrows` + expirable-overdue partitions `expiredEscrows`
 * with no overlap and no gap, and `expireOverdueEscrows` classifies
 * those escrows as `{ expired: false, unexpirable: true }` instead of
 * failing them.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  expiredEscrows,
  expireOverdueEscrows,
  stuckEscrows,
} from "../src/index.js";

const PAST = new Date("2026-01-01T00:00:00.000Z");
const FUTURE = new Date("2027-01-01T00:00:00.000Z");
const NOW = new Date("2026-06-01T00:00:00.000Z");
// Fixture audit timestamps: pinned strictly before NOW, because
// expireOverdueEscrows pins the screening `now` as each EXPIRE entry's
// `at`, and dispatch rejects a backward-moving audit clock.
const FUND_AT = new Date("2026-01-01T00:00:00.000Z");
const SUBMIT_AT = new Date("2026-02-01T00:00:00.000Z");
const VERIFY_AT = new Date("2026-03-01T00:00:00.000Z");

function fundedWithDeadline(id: string, deadline: Date): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 1000, { at: FUND_AT });
  escrow.setDeadline(deadline);
  return escrow;
}

function disputedWithDeadline(id: string, deadline: Date): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 1000, { at: FUND_AT });
  escrow.dispatch("DISPUTE", "buyer unhappy", undefined, { at: SUBMIT_AT });
  escrow.setDeadline(deadline);
  return escrow;
}

function verifiedWithDeadline(id: string, deadline: Date): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 1000, { at: FUND_AT });
  escrow.dispatch("SUBMIT_MILESTONE", "milestone done", undefined, {
    at: SUBMIT_AT,
  });
  escrow.dispatch("VERIFY_PASS", undefined, undefined, { at: VERIFY_AT });
  escrow.setDeadline(deadline);
  return escrow;
}

function createdWithDeadline(id: string, deadline: Date): Escrow {
  const escrow = new Escrow(id);
  escrow.setDeadline(deadline);
  return escrow;
}

function releasedWithDeadline(id: string, deadline: Date): Escrow {
  const escrow = verifiedWithDeadline(id, deadline);
  escrow.dispatch("RELEASE", "release to creator", undefined, {
    at: new Date("2026-04-01T00:00:00.000Z"),
  });
  return escrow;
}

function ids(escrows: Escrow[]): string[] {
  return escrows.map((e) => e.id);
}

describe("stuckEscrows", () => {
  it("an overdue DISPUTED escrow is stuck", () => {
    const disputed = disputedWithDeadline("disputed", PAST);
    assert.deepEqual(ids(stuckEscrows([disputed], NOW)), ["disputed"]);
  });

  it("overdue escrows with an EXPIRE edge are not stuck: FUNDED, VERIFIED, CREATED", () => {
    const batch = [
      fundedWithDeadline("funded", PAST),
      verifiedWithDeadline("verified", PAST),
      createdWithDeadline("created", PAST),
    ];
    assert.deepEqual(stuckEscrows(batch, NOW), []);
    // ...but they are all overdue, so the expired selection does list them.
    assert.deepEqual(ids(expiredEscrows(batch, NOW)), [
      "funded",
      "verified",
      "created",
    ]);
  });

  it("a not-yet-overdue DISPUTED escrow is not stuck", () => {
    const disputed = disputedWithDeadline("not-yet", FUTURE);
    assert.deepEqual(stuckEscrows([disputed], NOW), []);
  });

  it("a terminal escrow is never stuck, even with a past deadline", () => {
    const released = releasedWithDeadline("released", PAST);
    assert.equal(released.state, "RELEASED");
    assert.deepEqual(stuckEscrows([released], NOW), []);
    assert.deepEqual(expiredEscrows([released], NOW), []);
  });

  it("a deadline-less DISPUTED escrow is not stuck", () => {
    const disputed = new Escrow("no-deadline");
    disputed.dispatch("FUND", "initial deposit", 1000, { at: FUND_AT });
    disputed.dispatch("DISPUTE", "buyer unhappy", undefined, { at: SUBMIT_AT });
    assert.deepEqual(stuckEscrows([disputed], NOW), []);
  });

  it("returns the same instances in input order and changes nothing", () => {
    const first = disputedWithDeadline("first", PAST);
    const middle = fundedWithDeadline("middle", PAST);
    const last = disputedWithDeadline("last", PAST);
    const before = [first, middle, last].map((e) => ({
      state: e.state,
      history: e.history,
    }));

    const stuck = stuckEscrows([first, middle, last], NOW);

    assert.equal(stuck.length, 2);
    assert.equal(stuck[0], first);
    assert.equal(stuck[1], last);
    assert.deepEqual(
      [first, middle, last].map((e) => ({ state: e.state, history: e.history })),
      before
    );
  });

  it("partitions expiredEscrows with the expirable overdue set: no overlap, no gap", () => {
    const batch = [
      disputedWithDeadline("stuck-a", PAST),
      fundedWithDeadline("expirable-a", PAST),
      verifiedWithDeadline("expirable-b", PAST),
      disputedWithDeadline("stuck-b", PAST),
      fundedWithDeadline("not-overdue", FUTURE),
      new Escrow("no-deadline"),
      releasedWithDeadline("terminal", PAST),
    ];
    const expired = expiredEscrows(batch, NOW);
    const stuck = stuckEscrows(batch, NOW);
    const expirable = expired.filter((e) => !stuck.includes(e));

    assert.deepEqual(ids(expired), [
      "stuck-a",
      "expirable-a",
      "expirable-b",
      "stuck-b",
    ]);
    assert.deepEqual(ids(stuck), ["stuck-a", "stuck-b"]);
    assert.deepEqual(ids(expirable), ["expirable-a", "expirable-b"]);
    // No overlap: no escrow is both stuck and expirable.
    assert.equal(
      stuck.filter((e) => expirable.includes(e)).length,
      0
    );
    // No gap: stuck + expirable covers the whole expired selection.
    assert.equal(stuck.length + expirable.length, expired.length);
  });

  it("the live executor agrees: every expired escrow either expires or is exactly the stuck set", () => {
    const batch = [
      disputedWithDeadline("stuck-a", PAST),
      fundedWithDeadline("expirable-a", PAST),
      disputedWithDeadline("stuck-b", PAST),
      verifiedWithDeadline("expirable-b", PAST),
    ];
    const stuckIds = ids(stuckEscrows(batch, NOW));
    const before = batch.map((e) => e.history.length);

    const results = expireOverdueEscrows(batch, NOW);

    assert.equal(results.length, 4);
    for (const result of results) {
      if (stuckIds.includes(result.escrow.id)) {
        assert.equal(result.expired, false);
        assert.equal(result.unexpirable, true);
        assert.equal("error" in result, false);
      } else {
        assert.equal(result.expired, true);
        assert.equal("unexpirable" in result, false);
        assert.equal("error" in result, false);
      }
    }
    // The stuck escrows are untouched; the expirable ones gained
    // exactly one EXPIRE entry each.
    assert.deepEqual(
      batch.map((e) => e.history.length),
      before.map((n, i) =>
        stuckIds.includes(batch[i].id) ? n : n + 1
      )
    );
  });

  it("the dry run agrees: wouldExpire true exactly for the non-stuck expired set", () => {
    const batch = [
      disputedWithDeadline("stuck", PAST),
      fundedWithDeadline("expirable", PAST),
    ];
    const stuckIds = ids(stuckEscrows(batch, NOW));

    const results = expireOverdueEscrows(batch, NOW, { dryRun: true });

    assert.equal(results.length, 2);
    for (const result of results) {
      assert.equal(result.expired, false);
      if (stuckIds.includes(result.escrow.id)) {
        assert.equal(result.wouldExpire, false);
        assert.equal(result.unexpirable, true);
        assert.equal("error" in result, false);
      } else {
        assert.equal(result.wouldExpire, true);
        assert.equal("unexpirable" in result, false);
        assert.equal(result.error, undefined);
      }
    }
    assert.deepEqual(
      batch.map((e) => e.state),
      ["DISPUTED", "FUNDED"]
    );
  });

  it("returns an empty array for an empty batch", () => {
    assert.deepEqual(stuckEscrows([], NOW), []);
  });

  it("fails fast on a malformed batch", () => {
    assert.throws(
      () => stuckEscrows(null as unknown as Escrow[], NOW),
      /invalid stuckEscrows: escrows must be an array, got null/
    );
    assert.throws(
      () =>
        stuckEscrows(
          [fundedWithDeadline("ok", PAST), null as unknown as Escrow],
          NOW
        ),
      /invalid stuckEscrows: escrows\[1\] must be an Escrow, got null/
    );
  });

  it("fails fast on an invalid now", () => {
    const disputed = disputedWithDeadline("disputed", PAST);
    assert.throws(
      () => stuckEscrows([disputed], new Date("not-a-date")),
      /invalid now: expected a valid Date/
    );
    assert.throws(
      () => stuckEscrows([disputed], "2026-06-01" as unknown as Date),
      /invalid now: expected a valid Date/
    );
  });
});
