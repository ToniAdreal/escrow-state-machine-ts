/**
 * watchdog executors x `requireActor` (backlog #965).
 *
 * `expireOverdueEscrows` and `actOnStaleEscrows` are the only callers
 * that dispatch on an escrow's behalf with a fixed actor, so they are
 * the most likely place for the attribution gate to quietly change
 * behaviour — but no test ever combined the two: `grep -rln
 * requireActor test/expireOverdue*.test.ts
 * test/actOnStaleEscrows*.test.ts` was empty, and
 * `test/requireActor.test.ts` only covers bare dispatch and
 * `fromHistory` re-attachment.
 *
 * Two adaptations from the dataquest twin (#957), recorded honestly:
 *
 *  - The backlog item assumed the escrow watchdogs already dispatch
 *    as `system`. They did not: `expireOverdueEscrows` dispatched
 *    `EXPIRE` with no actor at all, so a `requireActor: true`
 *    escrow landed `{ expired: false, error: "actor required: …" }`
 *    instead of expiring — the first run of this file proved it.
 *    The same commit attributes the executor's EXPIRE to the
 *    `system` actor, mirroring dataquest's `expireOverdueTasks`
 *    (`task.dispatch("EXPIRE", { actor: "system", at: atIso })`).
 *    The tests below pin that attribution; without the fix they go
 *    red on the actor gate, not on a transition.
 *  - Escrow has no ABANDON event (its event set is FUND /
 *    SUBMIT_MILESTONE / VERIFY_PASS / VERIFY_FAIL / DISPUTE / RELEASE
 *    / ARBITRATE_* / EXPIRE), so the stale leg cannot "ABANDON" the
 *    way dataquest's default action does. The dispatch-style stale
 *    disposition here is EXPIRE — the same action the existing
 *    `actOnStaleEscrows` tests use — supplied by the caller with
 *    actor `system` and a pinned `at`.
 *
 * Rules under test:
 *  - a `requireActor: true` overdue escrow is EXPIREd by
 *    `expireOverdueEscrows`, the entry carrying actor `system`
 *  - a `requireActor: true` stale escrow is EXPIREd by
 *    `actOnStaleEscrows` with a `system`-attributed action, the
 *    entry carrying actor `system`
 *  - the control group: a bare dispatch without an actor on the same
 *    escrow still throws `actor required` and leaves no residue, and
 *    the watchdog still succeeds on that same instance afterwards
 *  - `fromHistory` re-attaching `requireActor` keeps both watchdogs
 *    working
 *  - per-escrow isolation holds in a mixed batch: an unexpirable
 *    task reports its transition error while the `requireActor`
 *    sibling still expires
 *  - a pinned `at` still stamps the watchdog entry with actor `system`
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  actOnStaleEscrows,
  expireOverdueEscrows,
  verifyHistoryChain,
} from "../src/index.js";
import type {
  EscrowHistoryEntry,
  ExpireOverdueResult,
  StaleEscrowActionResult,
} from "../src/index.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const PAST = new Date("2026-01-01T00:00:00.000Z");
const DAY = 24 * 3600_000;
const iso = (d: Date): string => d.toISOString();
const daysAgo = (n: number): string => iso(new Date(NOW.getTime() - n * DAY));

function lastEntry(escrow: Escrow): EscrowHistoryEntry {
  const history = escrow.history;
  return history[history.length - 1];
}

/** FUNDED 30 days ago, deadline long past. */
function overdueFundedEscrow(
  id: string,
  opts?: { requireActor?: boolean }
): Escrow {
  const escrow = new Escrow(id, opts);
  escrow.dispatch("FUND", "initial deposit", 1000, {
    actor: "sponsor",
    at: daysAgo(30),
  });
  escrow.setDeadline(PAST);
  return escrow;
}

/** FUNDED 30 days ago, no deadline — stale by dwell, not by deadline. */
function staleFundedEscrow(
  id: string,
  opts?: { requireActor?: boolean }
): Escrow {
  const escrow = new Escrow(id, opts);
  escrow.dispatch("FUND", "initial deposit", 1000, {
    actor: "sponsor",
    at: daysAgo(30),
  });
  return escrow;
}

/** VERIFIED 30 days ago: overdue by deadline but with no EXPIRE edge. */
function verifiedOverdueEscrow(id: string): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 1000, {
    actor: "sponsor",
    at: daysAgo(40),
  });
  escrow.dispatch("SUBMIT_MILESTONE", undefined, undefined, {
    actor: "creator",
    at: daysAgo(35),
  });
  escrow.dispatch("VERIFY_PASS", undefined, undefined, {
    actor: "oracle",
    at: daysAgo(30),
  });
  escrow.setDeadline(PAST);
  return escrow;
}

const STALE_BUDGET = { FUNDED: 7 * DAY, VERIFIED: 7 * DAY };

/** The dispatch-style stale action: EXPIRE, attributed to `system`. */
function expireAsSystem(escrow: Escrow): void {
  escrow.dispatch("EXPIRE", undefined, undefined, {
    actor: "system",
    at: NOW,
  });
}

function byId(
  results: ExpireOverdueResult[],
  id: string
): ExpireOverdueResult {
  const found = results.find((r) => r.escrow.id === id);
  assert.ok(found, `expected a result entry for escrow ${id}`);
  return found;
}

describe("watchdog executors x requireActor", () => {
  it("expireOverdueEscrows EXPIREs a requireActor escrow, signed as system", () => {
    const escrow = overdueFundedEscrow("watchdog-ra-expire", {
      requireActor: true,
    });

    const [result] = expireOverdueEscrows([escrow], NOW);
    assert.equal(result.expired, true);
    assert.equal(result.error, undefined);
    assert.equal(escrow.state, "EXPIRED");
    assert.ok(result.entry, "expected entry on success");

    // attribution is on both the live history entry and the report copy
    assert.equal(lastEntry(escrow).actor, "system");
    assert.equal(lastEntry(escrow).event, "EXPIRE");
    assert.equal(result.entry.actor, "system");
    assert.equal(result.entry.event, "EXPIRE");

    // the attributed entry is covered by the tamper-evident chain
    assert.equal(verifyHistoryChain(escrow.history), true);
  });

  it("actOnStaleEscrows EXPIREs a requireActor stale escrow, signed as system", () => {
    const escrow = staleFundedEscrow("watchdog-ra-stale", {
      requireActor: true,
    });

    const [result]: StaleEscrowActionResult[] = actOnStaleEscrows(
      [escrow],
      expireAsSystem,
      STALE_BUDGET,
      NOW
    );
    assert.equal(result.acted, true);
    assert.equal(result.error, undefined);
    assert.equal(escrow.state, "EXPIRED");
    assert.ok(result.entry, "expected entry on success");

    assert.equal(lastEntry(escrow).actor, "system");
    assert.equal(lastEntry(escrow).event, "EXPIRE");
    assert.equal(result.entry.actor, "system");
    assert.equal(result.entry.event, "EXPIRE");

    assert.equal(verifyHistoryChain(escrow.history), true);
  });

  it("control: bare dispatch without an actor still throws, watchdog still works on the same escrow", () => {
    const escrow = overdueFundedEscrow("watchdog-ra-control", {
      requireActor: true,
    });
    const before = escrow.history.length;

    // the gate still bites a human-style dispatch with no actor
    assert.throws(
      () => escrow.dispatch("SUBMIT_MILESTONE"),
      /actor required: dispatch must carry a non-empty actor when requireActor is enabled/
    );
    assert.equal(escrow.history.length, before);
    assert.equal(escrow.state, "FUNDED");

    // ...and the watchdog, which always carries `system`, is unaffected
    const [result] = expireOverdueEscrows([escrow], NOW);
    assert.equal(result.expired, true);
    assert.equal(escrow.state, "EXPIRED");
    assert.equal(lastEntry(escrow).actor, "system");
  });

  it("fromHistory re-attaching requireActor keeps expireOverdueEscrows working", () => {
    // restore the same log twice: once advisory, once with the gate on
    const history = overdueFundedEscrow("watchdog-ra-reattach").history;
    const plain = Escrow.fromHistory("watchdog-ra-reattach", history);
    const gated = Escrow.fromHistory("watchdog-ra-reattach", history, {
      requireActor: true,
    });

    // the gate really is on for the re-attached escrow
    assert.throws(() => gated.dispatch("SUBMIT_MILESTONE"), /actor required/);

    // and the watchdog still expires it (deadline re-attached, as a
    // deadline is config, not audit data — same as dataquest's SLA)
    gated.setDeadline(PAST);
    const [result] = expireOverdueEscrows([gated], NOW);
    assert.equal(result.expired, true);
    assert.equal(gated.state, "EXPIRED");
    assert.equal(lastEntry(gated).actor, "system");

    // the advisory twin is untouched by construction
    assert.equal(plain.state, "FUNDED");
  });

  it("fromHistory re-attaching requireActor keeps actOnStaleEscrows working", () => {
    const history = staleFundedEscrow("watchdog-ra-reattach-stale").history;
    const gated = Escrow.fromHistory("watchdog-ra-reattach-stale", history, {
      requireActor: true,
    });

    assert.throws(() => gated.dispatch("SUBMIT_MILESTONE"), /actor required/);

    const [result]: StaleEscrowActionResult[] = actOnStaleEscrows(
      [gated],
      expireAsSystem,
      STALE_BUDGET,
      NOW
    );
    assert.equal(result.acted, true);
    assert.equal(gated.state, "EXPIRED");
    assert.equal(lastEntry(gated).actor, "system");
    assert.equal(verifyHistoryChain(gated.history), true);
  });

  it("mixed batch: an unexpirable escrow does not block a requireActor sibling", () => {
    const gated = overdueFundedEscrow("watchdog-ra-batch-ok", {
      requireActor: true,
    });
    const stuck = verifiedOverdueEscrow("watchdog-ra-batch-stuck");

    const results = expireOverdueEscrows([stuck, gated], NOW);
    assert.equal(results.length, 2);

    // the stuck escrow fails on the missing EXPIRE edge, not the actor gate
    assert.equal(results[0].expired, false);
    assert.match(
      results[0].error ?? "",
      /invalid transition: EXPIRE from VERIFIED/
    );
    assert.equal(stuck.state, "VERIFIED");

    // the requireActor sibling still expires in the same batch
    assert.equal(results[1].expired, true);
    assert.equal(gated.state, "EXPIRED");
    assert.equal(lastEntry(gated).actor, "system");
  });

  it("pinned at still stamps the watchdog entry with actor system on a requireActor escrow", () => {
    const escrow = overdueFundedEscrow("watchdog-ra-pinned-at", {
      requireActor: true,
    });

    const [result] = expireOverdueEscrows([escrow], NOW);
    assert.equal(result.expired, true);
    assert.equal(lastEntry(escrow).at, iso(NOW));
    assert.equal(lastEntry(escrow).actor, "system");
    assert.equal(result.entry?.at, iso(NOW));
    assert.equal(verifyHistoryChain(escrow.history), true);
  });
});
