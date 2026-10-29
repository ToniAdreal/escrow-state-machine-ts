/**
 * actOnStaleEscrows x rolePolicy combination (backlog #713).
 *
 * The batch executor and event-level RBAC each have their own suites,
 * but their combination was never pinned — and this file pins the
 * respect in which the stale executor differs from both neighbouring
 * executors. `expireOverdueEscrows` (#706) dispatches EXPIRE itself
 * with no actor at all, so a policy that lists EXPIRE fails there
 * with the missing-actor wording
 * `policy requires an actor in [...]`. Dataquest's `actOnStaleTasks`
 * (#707) dispatches with a `system` actor, so the same policy fails
 * there with `"system" is not in [...]`. `actOnStaleEscrows` does
 * neither: it takes the action from the caller and runs it verbatim,
 * so policy enforcement happens inside the action's own dispatch and
 * the wording tracks the actor the ACTION passes — an unauthorized
 * actor fails with `"watchdog" is not in [ops-lead]`, an actor-less
 * action with the missing-actor wording. The executor itself adds no
 * actor, rewrites no policy, and never swallows the policy error: it
 * reports it per escrow (`acted: false, error: <message>`) and keeps
 * going, exactly like any other per-escrow action failure.
 *
 * RBAC is checked after transition legality (see `dispatch`), so a
 * VERIFIED stale escrow with an EXPIRE policy still fails with the
 * transition error, not the authorization error — the policy never
 * masks an illegal transition, even when the action is dispatch-style.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Escrow, actOnStaleEscrows } from "../src/index.js";
import type { StaleEscrowActionResult } from "../src/index.js";
import type { RolePolicy } from "../src/stateMachine.js";

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
function verifiedStale(id: string, rolePolicy?: RolePolicy): Escrow {
  const escrow =
    rolePolicy === undefined ? new Escrow(id) : new Escrow(id, { rolePolicy });
  escrow.dispatch("FUND", "initial deposit", 1000, { at: daysAgo(40) });
  escrow.dispatch("SUBMIT_MILESTONE", undefined, undefined, {
    at: daysAgo(35),
  });
  escrow.dispatch("VERIFY_PASS", undefined, undefined, { at: daysAgo(30) });
  return escrow;
}

function byId(
  results: StaleEscrowActionResult[],
  id: string
): StaleEscrowActionResult {
  const found = results.find((r) => r.escrow.id === id);
  assert.ok(found, `expected a result entry for escrow ${id}`);
  return found;
}

const BUDGET = { FUNDED: 7 * DAY, VERIFIED: 7 * DAY };

describe("actOnStaleEscrows x rolePolicy", () => {
  it("unauthorized actor action: gated escrow reports the policy error, the rest still expire", () => {
    const gated = fundedAt("gated", daysAgo(30), { EXPIRE: ["ops-lead"] });
    const open = fundedAt("open", daysAgo(28));
    const otherEvent = fundedAt("other-event", daysAgo(25), {
      RELEASE: ["treasury"],
    });

    // The gated escrow is first in the batch: its failure must not
    // block the escrows after it.
    const results = actOnStaleEscrows(
      [gated, open, otherEvent],
      (e) => e.dispatch("EXPIRE", undefined, undefined, { actor: "watchdog", at: NOW }),
      BUDGET,
      NOW
    );

    assert.equal(results.length, 3);
    assert.deepEqual(
      results.map((r) => r.escrow.id),
      ["gated", "open", "other-event"]
    );

    const blocked = byId(results, "gated");
    assert.equal(blocked.acted, false);
    // The wording tracks the action's actor: "watchdog" is named as
    // not in the list — neither the missing-actor wording (the #706
    // executor, which passes no actor) nor a "system" wording (the
    // dataquest executor, which passes one).
    assert.equal(
      blocked.error,
      'actor not authorized for EXPIRE: "watchdog" is not in [ops-lead]'
    );
    assert.equal("entry" in blocked, false);
    // The failed escrow is untouched: still FUNDED, no new history.
    assert.equal(blocked.escrow.state, "FUNDED");
    assert.equal(blocked.escrow.history.length, 1);
    assert.equal(blocked.escrow.history[0].event, "FUND");

    for (const id of ["open", "other-event"]) {
      const ok = byId(results, id);
      assert.equal(ok.acted, true);
      assert.equal(ok.error, undefined);
      assert.equal(ok.escrow.state, "EXPIRED");
      // The other-event escrow's policy lists RELEASE, not EXPIRE,
      // so the EXPIRE dispatch is unrestricted for it.
      assert.equal(ok.entry?.event, "EXPIRE");
      assert.equal(ok.entry?.from, "FUNDED");
      assert.equal(ok.entry?.to, "EXPIRED");
      assert.equal(ok.entry?.actor, "watchdog");
      assert.equal(ok.entry?.seq, 2);
    }
  });

  it("authorized actor action: gated escrow expires and its audit entry is intact", () => {
    const gated = fundedAt("gated-ok", daysAgo(30), { EXPIRE: ["ops-lead"] });
    const open = fundedAt("open-ok", daysAgo(28));

    const results = actOnStaleEscrows(
      [gated, open],
      (e) => e.dispatch("EXPIRE", undefined, undefined, { actor: "ops-lead", at: NOW }),
      BUDGET,
      NOW
    );

    assert.equal(results.length, 2);
    for (const id of ["gated-ok", "open-ok"]) {
      const ok = byId(results, id);
      assert.equal(ok.acted, true);
      assert.equal(ok.error, undefined);
      assert.equal(ok.escrow.state, "EXPIRED");
      // The reported entry is the appended audit record itself.
      assert.deepEqual(ok.entry, ok.escrow.history[ok.escrow.history.length - 1]);
      assert.equal(ok.entry?.event, "EXPIRE");
      assert.equal(ok.entry?.from, "FUNDED");
      assert.equal(ok.entry?.to, "EXPIRED");
      assert.equal(ok.entry?.actor, "ops-lead");
      assert.equal(ok.entry?.at, NOW.toISOString());
      assert.equal(ok.entry?.seq, 2);
    }
  });

  it("a policy-blocked run consumes nothing: the same escrow still expires manually by an allowlisted actor, with no sequence gap", () => {
    const gated = fundedAt("gated-retry", daysAgo(30), {
      EXPIRE: ["ops-lead"],
    });

    const results = actOnStaleEscrows(
      [gated],
      (e) => e.dispatch("EXPIRE", undefined, undefined, { actor: "watchdog", at: NOW }),
      BUDGET,
      NOW
    );
    assert.equal(results[0].acted, false);
    assert.equal(gated.history.length, 1);

    // The executor changed no policy and consumed no sequence number:
    // the allowlisted actor executes cleanly, appending exactly one
    // entry at seq 2, and the snapshot still carries the policy.
    assert.equal(
      gated.dispatch("EXPIRE", undefined, undefined, {
        actor: "ops-lead",
        at: NOW,
      }),
      "EXPIRED"
    );
    assert.equal(gated.state, "EXPIRED");
    assert.equal(gated.history.length, 2);
    const last = gated.history[gated.history.length - 1];
    assert.equal(last.seq, 2);
    assert.equal(last.event, "EXPIRE");
    assert.equal(last.actor, "ops-lead");
    assert.deepEqual(gated.toJSON().rolePolicy, { EXPIRE: ["ops-lead"] });
  });

  it("action throw and policy rejection are distinguishable in the results", () => {
    const gated = fundedAt("gated-err", daysAgo(30), { EXPIRE: ["ops-lead"] });
    const thrower = fundedAt("thrower", daysAgo(28));
    const good = fundedAt("good", daysAgo(25));

    const results = actOnStaleEscrows(
      [gated, thrower, good],
      (e) => {
        if (e.id === "thrower") throw new Error("notify backend down");
        e.dispatch("EXPIRE", undefined, undefined, { actor: "watchdog", at: NOW });
      },
      BUDGET,
      NOW
    );

    assert.equal(results.length, 3);
    const policyFailure = byId(results, "gated-err");
    const actionFailure = byId(results, "thrower");
    assert.equal(policyFailure.acted, false);
    assert.equal(actionFailure.acted, false);
    // Two different causes, two different wordings — the executor
    // reports the dispatch's policy error verbatim instead of
    // collapsing it into a generic action failure.
    assert.equal(
      policyFailure.error,
      'actor not authorized for EXPIRE: "watchdog" is not in [ops-lead]'
    );
    assert.equal(actionFailure.error, "notify backend down");
    assert.notEqual(policyFailure.error, actionFailure.error);
    assert.equal(thrower.state, "FUNDED");
    assert.equal(thrower.history.length, 1);
    const ok = byId(results, "good");
    assert.equal(ok.acted, true);
    assert.equal(good.state, "EXPIRED");
  });

  it("actor-less action: gated escrow fails with the missing-actor wording, not a not-in-list wording", () => {
    const gated = fundedAt("gated-anon", daysAgo(30), {
      EXPIRE: ["ops-lead"],
    });
    const open = fundedAt("open-anon", daysAgo(28));

    const results = actOnStaleEscrows(
      [gated, open],
      (e) => e.dispatch("EXPIRE", undefined, undefined, { at: NOW }),
      BUDGET,
      NOW
    );

    assert.equal(results.length, 2);
    const blocked = byId(results, "gated-anon");
    assert.equal(blocked.acted, false);
    // The executor adds no actor of its own: with no actor in the
    // action's dispatch, the failure is the missing-actor wording.
    assert.equal(
      blocked.error,
      "actor not authorized for EXPIRE: policy requires an actor in [ops-lead]"
    );
    assert.equal(gated.state, "FUNDED");
    assert.equal(byId(results, "open-anon").acted, true);
    assert.equal(open.state, "EXPIRED");
  });

  it("transition legality runs before RBAC: a VERIFIED stale escrow with an EXPIRE policy fails with the transition error, not the authorization error", () => {
    const verified = verifiedStale("verified-gated", {
      EXPIRE: ["ops-lead"],
    });

    const results = actOnStaleEscrows(
      [verified],
      (e) => e.dispatch("EXPIRE", undefined, undefined, { actor: "watchdog", at: NOW }),
      BUDGET,
      NOW
    );

    assert.equal(results.length, 1);
    assert.equal(results[0].acted, false);
    assert.match(
      results[0].error ?? "",
      /invalid transition: EXPIRE from VERIFIED/
    );
    assert.equal(verified.state, "VERIFIED");
    assert.equal(verified.history.length, 3);
  });

  it("a non-stale gated escrow is never attempted, so its policy never surfaces", () => {
    const gated = fundedAt("gated-fresh", daysAgo(1), {
      EXPIRE: ["ops-lead"],
    });
    const stale = fundedAt("stale", daysAgo(30));

    const results = actOnStaleEscrows(
      [gated, stale],
      (e) => e.dispatch("EXPIRE", undefined, undefined, { actor: "watchdog", at: NOW }),
      BUDGET,
      NOW
    );

    assert.deepEqual(
      results.map((r) => r.escrow.id),
      ["stale"]
    );
    assert.equal(gated.state, "FUNDED");
    assert.equal(gated.history.length, 1);
    assert.equal(stale.state, "EXPIRED");
  });
});
