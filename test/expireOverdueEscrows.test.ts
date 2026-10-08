/**
 * expireOverdueEscrows watchdog executor (#101).
 *
 * `expiredEscrows()` is a pure filter, but it has a trap: VERIFIED and
 * DISPUTED escrows have no EXPIRE edge in the transition table, so a
 * hand-written `for` loop dispatching EXPIRE aborts the whole batch on
 * the first such escrow. expireOverdueEscrows() reports per-escrow
 * outcomes instead and never lets one bad escrow block the rest.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  expireOverdueEscrows,
  ExpireOverdueResult,
} from "../src/index.js";

const PAST = new Date("2026-01-01T00:00:00.000Z");
const FUTURE = new Date("2027-01-01T00:00:00.000Z");
const NOW = new Date("2026-06-01T00:00:00.000Z");

function fundedWithDeadline(id: string, deadline: Date): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 1000);
  escrow.setDeadline(deadline);
  return escrow;
}

function verifiedWithDeadline(id: string, deadline: Date): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 1000);
  escrow.dispatch("SUBMIT_MILESTONE", "milestone done");
  escrow.dispatch("VERIFY_PASS");
  escrow.setDeadline(deadline);
  return escrow;
}

function disputedWithDeadline(id: string, deadline: Date): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 1000);
  escrow.dispatch("DISPUTE", "buyer unhappy");
  escrow.setDeadline(deadline);
  return escrow;
}

function byId(results: ExpireOverdueResult[], id: string): ExpireOverdueResult {
  const found = results.find((r) => r.escrow.id === id);
  assert.ok(found, `expected a result entry for escrow ${id}`);
  return found;
}

describe("expireOverdueEscrows", () => {
  it("expires a mixed batch with correct per-item outcomes", () => {
    const expirable = fundedWithDeadline("expirable", PAST);
    const notOverdue = fundedWithDeadline("not-overdue", FUTURE);
    const noDeadline = new Escrow("no-deadline");
    noDeadline.dispatch("FUND", "initial deposit", 1000);
    const verified = verifiedWithDeadline("verified", PAST);

    const results = expireOverdueEscrows(
      [expirable, notOverdue, noDeadline, verified],
      NOW
    );

    // only overdue non-terminal escrows are attempted
    assert.equal(results.length, 2);
    const ok = byId(results, "expirable");
    assert.equal(ok.expired, true);
    assert.equal(ok.error, undefined);
    assert.equal(ok.escrow.state, "EXPIRED");

    const stuck = byId(results, "verified");
    assert.equal(stuck.expired, false);
    assert.match(
      stuck.error ?? "",
      /invalid transition: EXPIRE from VERIFIED/
    );
    // the failed escrow is untouched: still VERIFIED, no new history
    assert.equal(stuck.escrow.state, "VERIFIED");
  });

  it("a failing VERIFIED escrow does not block later escrows in the batch", () => {
    const first = fundedWithDeadline("first", PAST);
    const stuck = verifiedWithDeadline("stuck", PAST);
    const last = fundedWithDeadline("last", PAST);

    const results = expireOverdueEscrows([first, stuck, last], NOW);

    assert.equal(results.length, 3);
    assert.equal(byId(results, "first").expired, true);
    assert.equal(byId(results, "stuck").expired, false);
    assert.equal(byId(results, "last").expired, true);
    assert.equal(first.state, "EXPIRED");
    assert.equal(last.state, "EXPIRED");
    assert.equal(stuck.state, "VERIFIED");
  });

  it("DISPUTED overdue escrows also fail gracefully with an error message", () => {
    const disputed = disputedWithDeadline("disputed", PAST);
    const results = expireOverdueEscrows([disputed], NOW);
    assert.equal(results.length, 1);
    assert.equal(results[0].expired, false);
    assert.match(
      results[0].error ?? "",
      /invalid transition: EXPIRE from DISPUTED/
    );
    assert.equal(disputed.state, "DISPUTED");
  });

  it("returns an empty array for an empty batch", () => {
    assert.deepEqual(expireOverdueEscrows([], NOW), []);
  });

  it("successful expiry is auditable: state flips and EXPIRE lands in history", () => {
    const escrow = fundedWithDeadline("audit", PAST);
    const before = escrow.history.length;
    const results = expireOverdueEscrows([escrow], NOW);
    assert.equal(results.length, 1);
    assert.equal(results[0].expired, true);
    assert.equal(escrow.state, "EXPIRED");
    assert.equal(escrow.history.length, before + 1);
    const last = escrow.history[escrow.history.length - 1];
    assert.equal(last.event, "EXPIRE");
    assert.equal(last.from, "FUNDED");
    assert.equal(last.to, "EXPIRED");
  });

  it("the injectable now controls which escrows count as overdue", () => {
    const a = fundedWithDeadline("a", new Date("2026-05-01T00:00:00.000Z"));
    const b = fundedWithDeadline("b", new Date("2026-07-01T00:00:00.000Z"));

    const early = expireOverdueEscrows([a, b], new Date("2026-04-01T00:00:00.000Z"));
    assert.deepEqual(
      early.map((r) => r.escrow.id),
      []
    );

    const mid = expireOverdueEscrows([a, b], NOW);
    assert.deepEqual(
      mid.map((r) => r.escrow.id),
      ["a"]
    );
    assert.equal(mid[0].expired, true);
  });

  it("a second run on the same batch is a no-op: already-expired escrows are skipped", () => {
    const escrow = fundedWithDeadline("once", PAST);
    const firstRun = expireOverdueEscrows([escrow], NOW);
    assert.equal(firstRun.length, 1);
    assert.equal(firstRun[0].expired, true);
    const historyLen = escrow.history.length;

    const secondRun = expireOverdueEscrows([escrow], NOW);
    assert.deepEqual(secondRun, []);
    // no duplicate EXPIRE entry
    assert.equal(escrow.history.length, historyLen);
  });

  it("results come back in batch order", () => {
    const c = fundedWithDeadline("c", PAST);
    const a = fundedWithDeadline("a", PAST);
    const m = fundedWithDeadline("m", PAST);
    const results = expireOverdueEscrows([c, a, m], NOW);
    assert.deepEqual(
      results.map((r) => r.escrow.id),
      ["c", "a", "m"]
    );
  });

  it("expired:true entries have no error key; failed entries carry a string error", () => {
    const ok = fundedWithDeadline("ok", PAST);
    const stuck = verifiedWithDeadline("stuck2", PAST);
    const results = expireOverdueEscrows([ok, stuck], NOW);
    const good = byId(results, "ok");
    assert.equal("error" in good, false);
    const bad = byId(results, "stuck2");
    assert.equal(typeof bad.error, "string");
    assert.ok((bad.error ?? "").length > 0);
  });

  it("result entries reference the exact input escrow instances", () => {
    const escrow = fundedWithDeadline("identity", PAST);
    const results = expireOverdueEscrows([escrow], NOW);
    assert.equal(results[0].escrow, escrow);
  });
});
