/**
 * expireOverdueEscrows x subscribe combination (backlog #739).
 *
 * Mirrors the actOnStaleEscrows x subscribe coverage (#735) on the
 * deadline-watchdog executor. `expireOverdueEscrows()` runs one
 * `dispatch("EXPIRE")` per overdue escrow and isolates per-escrow
 * failures, but no test backed the claims that a successful executor
 * EXPIRE notifies, that a failed transition or a policy refusal stays
 * silent, or that unsubscribing before the executor silences it —
 * `test/subscribe*.test.ts` never mentions `expireOverdueEscrows`,
 * and the executor's own tests never subscribe.
 *
 * The listener contract pinned here is the documented one from
 * `subscribe()`: listeners run after a successful dispatch, in
 * subscription order, with `(event, from, to, entry)` where `entry`
 * is a frozen, detached copy of the appended audit entry — so each
 * positive case also checks the notification entry against the
 * escrow's own history tail and against the executor's report entry.
 * Note the executor dispatches with no actor, so a gated escrow's
 * refusal here is the no-actor policy error
 * (`policy requires an actor in [...]`), not the named-actor form.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Escrow, expireOverdueEscrows } from "../src/index.js";
import type {
  EscrowEvent,
  EscrowHistoryEntry,
  EscrowState,
  RolePolicy,
} from "../src/index.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const PAST = new Date("2026-01-15T00:00:00.000Z");
const FUTURE = new Date("2027-01-01T00:00:00.000Z");
const FUND_AT = new Date("2026-01-01T00:00:00.000Z");
const SUBMIT_AT = new Date("2026-02-01T00:00:00.000Z");
const VERIFY_AT = new Date("2026-03-01T00:00:00.000Z");

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

/** VERIFIED escrow past its deadline: overdue, but no EXPIRE edge. */
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

/** DISPUTED escrow past its deadline: overdue, but no EXPIRE edge. */
function disputedWithDeadline(id: string, deadline: Date): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 1000, { at: FUND_AT });
  escrow.dispatch("DISPUTE", "buyer unhappy", undefined, { at: SUBMIT_AT });
  escrow.setDeadline(deadline);
  return escrow;
}

/** Terminal escrow: funded, then expired long before NOW. */
function alreadyExpired(id: string): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 1000, { at: FUND_AT });
  escrow.dispatch("EXPIRE", undefined, undefined, { at: SUBMIT_AT });
  escrow.setDeadline(PAST);
  return escrow;
}

type Notification = {
  event: EscrowEvent;
  from: EscrowState;
  to: EscrowState;
  entry: EscrowHistoryEntry;
};

function collect(escrow: Escrow): {
  seen: Notification[];
  unsubscribe: () => void;
} {
  const seen: Notification[] = [];
  const unsubscribe = escrow.subscribe((event, from, to, entry) => {
    seen.push({ event, from, to, entry });
  });
  return { seen, unsubscribe };
}

describe("expireOverdueEscrows x subscribe", () => {
  it("executor success: the EXPIRE notifies exactly once, entry matches history and the report", () => {
    const escrow = fundedWithDeadline("overdue", PAST);
    const { seen } = collect(escrow);
    const [result] = expireOverdueEscrows([escrow], NOW);
    assert.equal(result.expired, true);
    assert.equal(result.error, undefined);
    assert.equal(escrow.state, "EXPIRED");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].event, "EXPIRE");
    assert.equal(seen[0].from, "FUNDED");
    assert.equal(seen[0].to, "EXPIRED");
    const last = escrow.history[escrow.history.length - 1];
    assert.equal(last.seq, 2);
    assert.equal(last.at, NOW.toISOString());
    assert.deepEqual(seen[0].entry, last);
    assert.ok(Object.isFrozen(seen[0].entry));
    assert.deepEqual(result.entry, last);
  });

  it("batch: only attempted escrows notify once each; not-overdue, deadline-free and terminal escrows stay silent", () => {
    const overdueA = fundedWithDeadline("overdue-a", PAST);
    const notOverdue = fundedWithDeadline("not-overdue", FUTURE);
    const noDeadline = new Escrow("no-deadline");
    noDeadline.dispatch("FUND", "initial deposit", 1000, { at: FUND_AT });
    const terminal = alreadyExpired("terminal");
    const overdueB = fundedWithDeadline("overdue-b", PAST);
    const seenA = collect(overdueA).seen;
    const seenNotOverdue = collect(notOverdue).seen;
    const seenNoDeadline = collect(noDeadline).seen;
    const seenTerminal = collect(terminal).seen;
    const seenB = collect(overdueB).seen;
    const results = expireOverdueEscrows(
      [overdueA, notOverdue, noDeadline, terminal, overdueB],
      NOW
    );
    // Only overdue non-terminal escrows are attempted at all.
    assert.deepEqual(
      results.map((r) => r.escrow.id),
      ["overdue-a", "overdue-b"]
    );
    assert.ok(results.every((r) => r.expired && r.error === undefined));
    assert.equal(seenA.length, 1);
    assert.equal(seenA[0].event, "EXPIRE");
    assert.equal(seenB.length, 1);
    assert.equal(seenB[0].event, "EXPIRE");
    assert.equal(seenNotOverdue.length, 0);
    assert.equal(seenNoDeadline.length, 0);
    assert.equal(seenTerminal.length, 0);
    assert.equal(overdueA.state, "EXPIRED");
    assert.equal(overdueB.state, "EXPIRED");
    // The untouched escrows kept their state and history exactly.
    assert.equal(notOverdue.state, "FUNDED");
    assert.equal(notOverdue.history.length, 1);
    assert.equal(noDeadline.state, "FUNDED");
    assert.equal(noDeadline.history.length, 1);
    assert.equal(terminal.state, "EXPIRED");
    assert.equal(terminal.history.length, 2);
  });

  it("failed transition: VERIFIED overdue escrow gets zero notifications and is untouched; the batch keeps going", () => {
    const stuck = verifiedWithDeadline("stuck-verified", PAST);
    const after = fundedWithDeadline("after", PAST);
    const seenStuck = collect(stuck).seen;
    const seenAfter = collect(after).seen;
    const results = expireOverdueEscrows([stuck, after], NOW);
    assert.equal(results.length, 2);
    assert.equal(results[0].expired, false);
    assert.match(
      results[0].error ?? "",
      /invalid transition: EXPIRE from VERIFIED/
    );
    assert.equal("entry" in results[0], false);
    assert.equal(seenStuck.length, 0);
    assert.equal(stuck.state, "VERIFIED");
    assert.equal(stuck.history.length, 3);
    assert.equal(results[1].expired, true);
    assert.equal(after.state, "EXPIRED");
    assert.equal(seenAfter.length, 1);
    assert.equal(seenAfter[0].event, "EXPIRE");
  });

  it("DISPUTED overdue escrow also fails gracefully with zero notifications", () => {
    const disputed = disputedWithDeadline("disputed", PAST);
    const after = fundedWithDeadline("after-disputed", PAST);
    const seenDisputed = collect(disputed).seen;
    const seenAfter = collect(after).seen;
    const results = expireOverdueEscrows([disputed, after], NOW);
    assert.equal(results.length, 2);
    assert.equal(results[0].expired, false);
    assert.match(
      results[0].error ?? "",
      /invalid transition: EXPIRE from DISPUTED/
    );
    assert.equal("entry" in results[0], false);
    assert.equal(seenDisputed.length, 0);
    assert.equal(disputed.state, "DISPUTED");
    assert.equal(disputed.history.length, 2);
    assert.equal(results[1].expired, true);
    assert.equal(seenAfter.length, 1);
  });

  it("policy refusal: the executor dispatches with no actor, so a gated escrow reports the no-actor policy error, zero notifications, untouched; the rest still expire and notify", () => {
    const gated = fundedWithDeadline("gated", PAST, { EXPIRE: ["ops-lead"] });
    const open = fundedWithDeadline("open", PAST);
    const seenGated = collect(gated).seen;
    const seenOpen = collect(open).seen;
    const results = expireOverdueEscrows([gated, open], NOW);
    assert.equal(results.length, 2);
    const blocked = results[0];
    assert.equal(blocked.expired, false);
    assert.equal(
      blocked.error,
      'actor not authorized for EXPIRE: policy requires an actor in [ops-lead]'
    );
    assert.equal("entry" in blocked, false);
    assert.equal(seenGated.length, 0);
    assert.equal(blocked.escrow.state, "FUNDED");
    assert.equal(blocked.escrow.history.length, 1);
    const ok = results[1];
    assert.equal(ok.expired, true);
    assert.equal(ok.error, undefined);
    assert.equal(ok.escrow.state, "EXPIRED");
    assert.equal(seenOpen.length, 1);
    assert.equal(seenOpen[0].event, "EXPIRE");
    assert.equal(seenOpen[0].entry.seq, 2);
    assert.equal(seenOpen[0].entry.at, NOW.toISOString());
  });

  it("unsubscribe before the executor: expiry still happens, zero notifications", () => {
    const escrow = fundedWithDeadline("unsubbed", PAST);
    const { seen, unsubscribe } = collect(escrow);
    unsubscribe();
    unsubscribe(); // idempotent: second call is a no-op, must not throw
    assert.equal(escrow.listenerCount, 0);
    const [result] = expireOverdueEscrows([escrow], NOW);
    assert.equal(result.expired, true);
    assert.equal(escrow.state, "EXPIRED");
    assert.equal(escrow.history.length, 2);
    assert.equal(seen.length, 0);
  });

  it("throwing listener is isolated: executor dispatch still succeeds, peer still receives", () => {
    const escrow = fundedWithDeadline("throwing-peer", PAST);
    escrow.subscribe(() => {
      throw new Error("bad fan-out consumer");
    });
    const { seen } = collect(escrow);
    const [result] = expireOverdueEscrows([escrow], NOW);
    assert.equal(result.expired, true);
    assert.equal(escrow.state, "EXPIRED");
    assert.equal(escrow.history.length, 2);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].event, "EXPIRE");
    assert.equal(seen[0].from, "FUNDED");
    assert.equal(seen[0].to, "EXPIRED");
  });

  it("after a policy refusal, an authorized manual dispatch still notifies", () => {
    const escrow = fundedWithDeadline("gated-then-manual", PAST, {
      EXPIRE: ["ops-lead"],
    });
    const { seen } = collect(escrow);
    const [refused] = expireOverdueEscrows([escrow], NOW);
    assert.equal(refused.expired, false);
    assert.equal(seen.length, 0);
    assert.equal(escrow.state, "FUNDED");
    const next = escrow.dispatch("EXPIRE", undefined, undefined, {
      actor: "ops-lead",
    });
    assert.equal(next, "EXPIRED");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].event, "EXPIRE");
    assert.equal(seen[0].entry.actor, "ops-lead");
  });

  it("notification entry is a detached copy: mutating it cannot rewrite the audit history", () => {
    const escrow = fundedWithDeadline("detached", PAST);
    const { seen } = collect(escrow);
    expireOverdueEscrows([escrow], NOW);
    assert.equal(seen.length, 1);
    assert.throws(() => {
      (seen[0].entry as { note?: string }).note = "forged";
    }, TypeError);
    const last = escrow.history[escrow.history.length - 1];
    assert.deepEqual(seen[0].entry, last);
    assert.equal(escrow.history.length, 2);
  });
});
