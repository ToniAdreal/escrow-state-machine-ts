/**
 * actOnStaleEscrows x subscribe combination (backlog #735).
 *
 * Mirrors dataquest's actOnStaleTasks x subscribe coverage (#732) on
 * the escrow side, where there is deliberately NO default action: the
 * executor takes the action from the caller and runs it verbatim, so
 * the notification assertions below pin the action's own dispatch,
 * not a built-in one. `subscribe.test.ts` and
 * `subscribeReentrancy.test.ts` never mention `actOnStaleEscrows`,
 * so before this file nothing backed the claims that a watchdog
 * executor's dispatch notifies, that a policy refusal or a failed
 * transition stays silent, that a notify-only action stays silent,
 * or that unsubscribing before the executor silences it.
 *
 * The listener contract pinned here is the documented one from
 * `subscribe()`: listeners run after a successful dispatch, in
 * subscription order, with `(event, from, to, entry)` where `entry`
 * is a frozen, detached copy of the appended audit entry — so each
 * positive case also checks the notification entry against the
 * escrow's own history tail and against the executor's report entry.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Escrow, actOnStaleEscrows } from "../src/index.js";
import type {
  EscrowEvent,
  EscrowHistoryEntry,
  EscrowState,
  RolePolicy,
} from "../src/index.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const DAY = 24 * 3600_000;
const iso = (d: Date): string => d.toISOString();
const daysAgo = (n: number): string => iso(new Date(NOW.getTime() - n * DAY));

function fundedAt(id: string, at: string, rolePolicy?: RolePolicy): Escrow {
  const escrow =
    rolePolicy === undefined ? new Escrow(id) : new Escrow(id, { rolePolicy });
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

/** Terminal escrow: funded 40d ago, expired 20d ago. */
function expiredAt(id: string): Escrow {
  const escrow = fundedAt(id, daysAgo(40));
  escrow.dispatch("EXPIRE", undefined, undefined, { at: daysAgo(20) });
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

const BUDGET = { FUNDED: 7 * DAY, VERIFIED: 7 * DAY };

describe("actOnStaleEscrows x subscribe", () => {
  it("dispatch action success: the executor's EXPIRE notifies exactly once, entry matches history and the report", () => {
    const escrow = fundedAt("stale", daysAgo(30));
    const { seen } = collect(escrow);
    const [result] = actOnStaleEscrows(
      [escrow],
      (e) => e.dispatch("EXPIRE"),
      BUDGET,
      NOW
    );
    assert.equal(result.acted, true);
    assert.equal(result.error, undefined);
    assert.equal(escrow.state, "EXPIRED");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].event, "EXPIRE");
    assert.equal(seen[0].from, "FUNDED");
    assert.equal(seen[0].to, "EXPIRED");
    const last = escrow.history[escrow.history.length - 1];
    assert.equal(last.seq, 2);
    assert.deepEqual(seen[0].entry, last);
    assert.ok(Object.isFrozen(seen[0].entry));
    assert.deepEqual(result.entry, last);
  });

  it("batch: only acted escrows notify once each; fresh and terminal escrows stay silent", () => {
    const staleA = fundedAt("stale-a", daysAgo(30));
    const fresh = fundedAt("fresh", daysAgo(3));
    const terminal = expiredAt("terminal");
    const staleB = fundedAt("stale-b", daysAgo(20));
    const seenA = collect(staleA).seen;
    const seenFresh = collect(fresh).seen;
    const seenTerminal = collect(terminal).seen;
    const seenB = collect(staleB).seen;
    const results = actOnStaleEscrows(
      [staleA, fresh, terminal, staleB],
      (e) => e.dispatch("EXPIRE"),
      BUDGET,
      NOW
    );
    assert.deepEqual(
      results.map((r) => r.escrow.id),
      ["stale-a", "stale-b"]
    );
    assert.ok(results.every((r) => r.acted && r.error === undefined));
    assert.equal(seenA.length, 1);
    assert.equal(seenA[0].event, "EXPIRE");
    assert.equal(seenB.length, 1);
    assert.equal(seenB[0].event, "EXPIRE");
    assert.equal(seenFresh.length, 0);
    assert.equal(seenTerminal.length, 0);
    assert.equal(staleA.state, "EXPIRED");
    assert.equal(staleB.state, "EXPIRED");
    // The untouched escrows kept their state and history exactly.
    assert.equal(fresh.state, "FUNDED");
    assert.equal(fresh.history.length, 1);
    assert.equal(terminal.state, "EXPIRED");
    assert.equal(terminal.history.length, 2);
  });

  it("policy refusal: gated escrow reports the policy error, zero notifications, untouched; the rest still expire and notify", () => {
    const gated = fundedAt("gated", daysAgo(30), { EXPIRE: ["ops-lead"] });
    const open = fundedAt("open", daysAgo(28));
    const seenGated = collect(gated).seen;
    const seenOpen = collect(open).seen;
    const results = actOnStaleEscrows(
      [gated, open],
      (e) =>
        e.dispatch("EXPIRE", undefined, undefined, {
          actor: "watchdog",
          at: NOW,
        }),
      BUDGET,
      NOW
    );
    assert.equal(results.length, 2);
    const blocked = results[0];
    assert.equal(blocked.acted, false);
    assert.equal(
      blocked.error,
      'actor not authorized for EXPIRE: "watchdog" is not in [ops-lead]'
    );
    assert.equal("entry" in blocked, false);
    assert.equal(seenGated.length, 0);
    assert.equal(blocked.escrow.state, "FUNDED");
    assert.equal(blocked.escrow.history.length, 1);
    const ok = results[1];
    assert.equal(ok.acted, true);
    assert.equal(ok.error, undefined);
    assert.equal(ok.escrow.state, "EXPIRED");
    assert.equal(seenOpen.length, 1);
    assert.equal(seenOpen[0].entry.event, "EXPIRE");
    assert.equal(seenOpen[0].entry.actor, "watchdog");
    assert.equal(seenOpen[0].entry.seq, 2);
  });

  it("failed transition: VERIFIED stale escrow gets zero notifications and is untouched; the batch keeps going", () => {
    const stuck = verifiedStale("stuck-verified");
    const after = fundedAt("after", daysAgo(28));
    const seenStuck = collect(stuck).seen;
    const seenAfter = collect(after).seen;
    const results = actOnStaleEscrows(
      [stuck, after],
      (e) => e.dispatch("EXPIRE"),
      BUDGET,
      NOW
    );
    assert.equal(results.length, 2);
    assert.equal(results[0].acted, false);
    assert.match(results[0].error ?? "", /invalid transition: EXPIRE from VERIFIED/);
    assert.equal("entry" in results[0], false);
    assert.equal(seenStuck.length, 0);
    assert.equal(stuck.state, "VERIFIED");
    assert.equal(stuck.history.length, 3);
    assert.equal(results[1].acted, true);
    assert.equal(after.state, "EXPIRED");
    assert.equal(seenAfter.length, 1);
    assert.equal(seenAfter[0].event, "EXPIRE");
  });

  it("notify-only action: acted with no entry, zero notifications, escrow untouched", () => {
    const escrow = fundedAt("notify-only", daysAgo(30));
    const { seen } = collect(escrow);
    const notified: string[] = [];
    const [result] = actOnStaleEscrows(
      [escrow],
      (e) => {
        notified.push(e.id);
      },
      BUDGET,
      NOW
    );
    assert.equal(result.acted, true);
    assert.equal(result.error, undefined);
    assert.equal("entry" in result, false);
    assert.deepEqual(notified, ["notify-only"]);
    assert.equal(seen.length, 0);
    assert.equal(escrow.state, "FUNDED");
    assert.equal(escrow.history.length, 1);
  });

  it("unsubscribe before the executor: expiry still happens, zero notifications", () => {
    const escrow = fundedAt("unsubbed", daysAgo(30));
    const { seen, unsubscribe } = collect(escrow);
    unsubscribe();
    unsubscribe(); // idempotent: second call is a no-op, must not throw
    assert.equal(escrow.listenerCount, 0);
    const [result] = actOnStaleEscrows(
      [escrow],
      (e) => e.dispatch("EXPIRE"),
      BUDGET,
      NOW
    );
    assert.equal(result.acted, true);
    assert.equal(escrow.state, "EXPIRED");
    assert.equal(escrow.history.length, 2);
    assert.equal(seen.length, 0);
  });

  it("throwing listener is isolated: executor dispatch still succeeds, peer still receives", () => {
    const escrow = fundedAt("throwing-peer", daysAgo(30));
    escrow.subscribe(() => {
      throw new Error("bad fan-out consumer");
    });
    const { seen } = collect(escrow);
    const [result] = actOnStaleEscrows(
      [escrow],
      (e) => e.dispatch("EXPIRE"),
      BUDGET,
      NOW
    );
    assert.equal(result.acted, true);
    assert.equal(escrow.state, "EXPIRED");
    assert.equal(escrow.history.length, 2);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].event, "EXPIRE");
    assert.equal(seen[0].from, "FUNDED");
    assert.equal(seen[0].to, "EXPIRED");
  });

  it("after a policy refusal, an authorized manual dispatch still notifies", () => {
    const escrow = fundedAt("gated-then-manual", daysAgo(30), {
      EXPIRE: ["ops-lead"],
    });
    const { seen } = collect(escrow);
    const [refused] = actOnStaleEscrows(
      [escrow],
      (e) =>
        e.dispatch("EXPIRE", undefined, undefined, {
          actor: "watchdog",
          at: NOW,
        }),
      BUDGET,
      NOW
    );
    assert.equal(refused.acted, false);
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
});
