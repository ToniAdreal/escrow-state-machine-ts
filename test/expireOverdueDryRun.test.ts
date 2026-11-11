/**
 * expireOverdueEscrows dry run (backlog #1050).
 *
 * An operator about to expire a batch has no safe rehearsal port: the
 * executor dispatches EXPIRE the moment it runs, writing history and
 * notifying subscribers. `expireOverdueEscrows(escrows, now,
 * { dryRun: true })` predicts instead — same screened set, same order,
 * zero dispatch — and each result carries `wouldExpire` plus, when
 * false, the same-wording `error` the live run would have reported.
 *
 * The wording pins are the point of this file: for every failure mode
 * (no EXPIRE edge, backdated `now`, a `rolePolicy` that does not admit
 * `system`) a twin escrow is built identically, the live run is
 * executed on the twin, and the dry-run error must equal the live
 * error byte for byte — a rehearsal that disagrees with the real run
 * about WHY an escrow would not expire is worse than no rehearsal.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  expireOverdueEscrows,
  ExpireOverdueResult,
} from "../src/index.js";
import type { RolePolicy } from "../src/index.js";

const PAST = new Date("2026-01-01T00:00:00.000Z");
const FUTURE = new Date("2027-01-01T00:00:00.000Z");
const NOW = new Date("2026-06-01T00:00:00.000Z");
// Fixture audit timestamps: pinned strictly before NOW, because the
// executor pins the screening `now` as each EXPIRE entry's `at`, and
// dispatch rejects a backward-moving audit clock.
const FUND_AT = new Date("2026-01-01T00:00:00.000Z");
const SUBMIT_AT = new Date("2026-02-01T00:00:00.000Z");
const VERIFY_AT = new Date("2026-03-01T00:00:00.000Z");
// Backdated-clock fixture: the last history entry (FUND) sits after
// the screening `now`, while the deadline is already past at `now`.
const LATE_FUND_AT = new Date("2026-05-01T00:00:00.000Z");
const BACKDATED_NOW = new Date("2026-02-01T00:00:00.000Z");

function fundedWithDeadline(
  id: string,
  deadline: Date,
  rolePolicy?: RolePolicy
): Escrow {
  const escrow =
    rolePolicy === undefined ? new Escrow(id) : new Escrow(id, { rolePolicy });
  escrow.dispatch("FUND", "initial deposit", 1000, { at: FUND_AT });
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

function disputedWithDeadline(id: string, deadline: Date): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 1000, { at: FUND_AT });
  escrow.dispatch("DISPUTE", "buyer unhappy", undefined, { at: SUBMIT_AT });
  escrow.setDeadline(deadline);
  return escrow;
}

/** Overdue at BACKDATED_NOW, but its last history entry is after it. */
function backdatedWithDeadline(id: string): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 1000, { at: LATE_FUND_AT });
  escrow.setDeadline(new Date("2026-01-15T00:00:00.000Z"));
  return escrow;
}

function byId(results: ExpireOverdueResult[], id: string): ExpireOverdueResult {
  const found = results.find((r) => r.escrow.id === id);
  assert.ok(found, `expected a result entry for escrow ${id}`);
  return found;
}

/** The live run's error for a twin escrow, for exact-wording pins. */
function liveError(build: () => Escrow, now: Date): string {
  const twin = build();
  const [result] = expireOverdueEscrows([twin], now);
  assert.equal(result.expired, false);
  assert.equal(typeof result.error, "string");
  return result.error as string;
}

describe("expireOverdueEscrows dryRun", () => {
  it("dry run changes nothing: state and history frozen for the whole batch", () => {
    const expirable = fundedWithDeadline("expirable", PAST);
    const verified = verifiedWithDeadline("verified", PAST);
    const disputed = disputedWithDeadline("disputed", PAST);
    const notOverdue = fundedWithDeadline("not-overdue", FUTURE);
    const batch = [expirable, verified, disputed, notOverdue];
    const before = batch.map((e) => ({
      id: e.id,
      state: e.state,
      history: e.history,
    }));

    const results = expireOverdueEscrows(batch, NOW, { dryRun: true });

    assert.deepEqual(
      batch.map((e) => ({ id: e.id, state: e.state, history: e.history })),
      before
    );
    // Only the screened (overdue) escrows are reported, in batch order.
    assert.deepEqual(
      results.map((r) => r.escrow.id),
      ["expirable", "verified", "disputed"]
    );
  });

  it("dry run selects the same set as the live run, in batch order", () => {
    const buildBatch = () => [
      fundedWithDeadline("a", PAST),
      fundedWithDeadline("b", FUTURE),
      verifiedWithDeadline("c", PAST),
      new Escrow("d"),
      fundedWithDeadline("e", PAST),
    ];
    const dryIds = expireOverdueEscrows(buildBatch(), NOW, {
      dryRun: true,
    }).map((r) => r.escrow.id);
    const liveIds = expireOverdueEscrows(buildBatch(), NOW).map(
      (r) => r.escrow.id
    );
    assert.deepEqual(dryIds, liveIds);
    assert.deepEqual(dryIds, ["a", "c", "e"]);
  });

  it("expirable escrows report wouldExpire true, expired false, no entry, no error", () => {
    const escrow = fundedWithDeadline("expirable", PAST);
    const [result] = expireOverdueEscrows([escrow], NOW, { dryRun: true });
    assert.equal(result.wouldExpire, true);
    assert.equal(result.expired, false);
    assert.equal(result.error, undefined);
    assert.equal("entry" in result, false);
    assert.equal("wouldExpire" in result, true);
    assert.equal(escrow.state, "FUNDED");
  });

  it("VERIFIED overdue: wouldExpire false with the live run's exact error wording", () => {
    const build = () => verifiedWithDeadline("verified", PAST);
    const [dry] = expireOverdueEscrows([build()], NOW, { dryRun: true });
    assert.equal(dry.wouldExpire, false);
    assert.equal(dry.expired, false);
    assert.equal("entry" in dry, false);
    assert.equal(dry.error, liveError(build, NOW));
    assert.match(dry.error ?? "", /invalid transition: EXPIRE from VERIFIED/);
  });

  it("DISPUTED overdue: wouldExpire false with the live run's exact error wording", () => {
    const build = () => disputedWithDeadline("disputed", PAST);
    const [dry] = expireOverdueEscrows([build()], NOW, { dryRun: true });
    assert.equal(dry.wouldExpire, false);
    assert.equal(dry.error, liveError(build, NOW));
    assert.match(dry.error ?? "", /invalid transition: EXPIRE from DISPUTED/);
  });

  it("backdated now: wouldExpire false with the live run's exact error wording", () => {
    const build = () => backdatedWithDeadline("backdated");
    const [dry] = expireOverdueEscrows([build()], BACKDATED_NOW, {
      dryRun: true,
    });
    assert.equal(dry.wouldExpire, false);
    assert.equal(dry.error, liveError(build, BACKDATED_NOW));
    assert.match(
      dry.error ?? "",
      /invalid dispatch options: at 2026-02-01T00:00:00\.000Z is earlier than the previous entry's at 2026-05-01T00:00:00\.000Z/
    );
  });

  it("rolePolicy: excluding system predicts refusal verbatim; including system predicts expiry", () => {
    const excluded = () => fundedWithDeadline("gated", PAST, { EXPIRE: ["ops"] });
    const [dry] = expireOverdueEscrows([excluded()], NOW, { dryRun: true });
    assert.equal(dry.wouldExpire, false);
    assert.equal(dry.error, liveError(excluded, NOW));
    assert.match(
      dry.error ?? "",
      /actor not authorized for EXPIRE: "system" is not in \[ops\]/
    );

    const admitted = fundedWithDeadline("admitted", PAST, {
      EXPIRE: ["ops", "system"],
    });
    const [ok] = expireOverdueEscrows([admitted], NOW, { dryRun: true });
    assert.equal(ok.wouldExpire, true);
    assert.equal(ok.error, undefined);
  });

  it("dry run notifies no subscriber; the live run right after notifies once per expiry", () => {
    const a = fundedWithDeadline("a", PAST);
    const b = fundedWithDeadline("b", PAST);
    const stuck = verifiedWithDeadline("stuck", PAST);
    let notifications = 0;
    for (const escrow of [a, b, stuck]) {
      escrow.subscribe(() => {
        notifications += 1;
      });
    }

    const dry = expireOverdueEscrows([a, b, stuck], NOW, { dryRun: true });
    assert.equal(notifications, 0);
    assert.deepEqual(
      dry.map((r) => r.wouldExpire),
      [true, true, false]
    );

    const live = expireOverdueEscrows([a, b, stuck], NOW);
    assert.equal(notifications, 2);
    assert.deepEqual(
      live.map((r) => r.expired),
      [true, true, false]
    );
  });

  it("a dry run leaves no residue: the same batch then expires in full live", () => {
    const a = fundedWithDeadline("a", PAST);
    const b = fundedWithDeadline("b", PAST);
    const stuck = verifiedWithDeadline("stuck", PAST);
    const beforeLen = new Map([
      ["a", a.history.length],
      ["b", b.history.length],
      ["stuck", stuck.history.length],
    ]);

    const dry = expireOverdueEscrows([a, b, stuck], NOW, { dryRun: true });
    assert.deepEqual(
      dry.map((r) => r.wouldExpire),
      [true, true, false]
    );

    const live = expireOverdueEscrows([a, b, stuck], NOW);
    assert.equal(byId(live, "a").expired, true);
    assert.equal(byId(live, "b").expired, true);
    assert.equal(byId(live, "stuck").expired, false);
    // Exactly one new EXPIRE entry per expirable escrow, none for the stuck one.
    assert.equal(a.history.length, (beforeLen.get("a") ?? 0) + 1);
    assert.equal(b.history.length, (beforeLen.get("b") ?? 0) + 1);
    assert.equal(stuck.history.length, beforeLen.get("stuck"));
    assert.equal(a.history[a.history.length - 1].event, "EXPIRE");
    assert.equal(a.history[a.history.length - 1].at, NOW.toISOString());
  });

  it("illegal opts throw fail-fast with zero calls", () => {
    const escrow = fundedWithDeadline("guarded", PAST);
    const historyLen = escrow.history.length;
    for (const badOpts of [
      { dryRun: "yes" },
      { dryRun: 1 },
      null,
      [],
    ] as unknown[]) {
      assert.throws(
        () =>
          expireOverdueEscrows(
            [escrow],
            NOW,
            badOpts as { dryRun?: boolean }
          ),
        /invalid expireOverdueEscrows options/
      );
    }
    // Nothing was dispatched by any rejected call.
    assert.equal(escrow.state, "FUNDED");
    assert.equal(escrow.history.length, historyLen);
  });

  it("dry run on an empty batch returns an empty array", () => {
    assert.deepEqual(expireOverdueEscrows([], NOW, { dryRun: true }), []);
  });

  it("live-run results carry no wouldExpire key", () => {
    const ok = fundedWithDeadline("ok", PAST);
    const stuck = verifiedWithDeadline("stuck2", PAST);
    const results = expireOverdueEscrows([ok, stuck], NOW);
    for (const result of results) {
      assert.equal("wouldExpire" in result, false);
    }
  });
});
