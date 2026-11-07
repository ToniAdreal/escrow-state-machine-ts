/**
 * expireOverdueEscrows x rolePolicy combination (backlog #706).
 *
 * The batch executor and event-level RBAC each have their own suites,
 * but their combination was never pinned. Since backlog #965 the
 * escrow executor dispatches EXPIRE attributed to the `system` actor
 * — the same attribution dataquest's executor uses — so a policy
 * that lists EXPIRE without `system` fails with the named-actor
 * wording `"system" is not in [...]`, and a policy that DOES list
 * `system` lets the watchdog through. A policy that does not list
 * EXPIRE, or no policy at all, leaves the watchdog path
 * unrestricted. (Before #965 the executor dispatched with no actor
 * at all, so the same policies failed with the missing-actor wording
 * `policy requires an actor in [...]`; that difference is gone —
 * the executor now always carries an actor, and the actor is
 * `system`.)
 *
 * RBAC is checked after transition legality (see `dispatch`), so a
 * VERIFIED overdue escrow with an EXPIRE policy still fails with the
 * transition error, not the authorization error — the policy never
 * masks an illegal transition.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  expireOverdueEscrows,
  ExpireOverdueResult,
} from "../src/index.js";
import type { RolePolicy } from "../src/stateMachine.js";

const PAST = new Date("2026-01-15T00:00:00.000Z");
const NOW = new Date("2026-06-01T00:00:00.000Z");
// Fixture audit timestamps: pinned strictly before NOW, because
// expireOverdueEscrows pins the screening `now` as each EXPIRE entry's
// `at`, and dispatch rejects a backward-moving audit clock.
const FUND_AT = new Date("2026-01-01T00:00:00.000Z");
const SUBMIT_AT = new Date("2026-02-01T00:00:00.000Z");
const VERIFY_AT = new Date("2026-03-01T00:00:00.000Z");

function fundedOverdue(id: string, rolePolicy?: RolePolicy): Escrow {
  const escrow =
    rolePolicy === undefined
      ? new Escrow(id)
      : new Escrow(id, { rolePolicy });
  escrow.dispatch("FUND", "initial deposit", 1000, { at: FUND_AT });
  escrow.setDeadline(PAST);
  return escrow;
}

function verifiedOverdue(id: string, rolePolicy?: RolePolicy): Escrow {
  const escrow =
    rolePolicy === undefined
      ? new Escrow(id)
      : new Escrow(id, { rolePolicy });
  escrow.dispatch("FUND", "initial deposit", 1000, { at: FUND_AT });
  escrow.dispatch("SUBMIT_MILESTONE", "milestone done", undefined, {
    at: SUBMIT_AT,
  });
  escrow.dispatch("VERIFY_PASS", undefined, undefined, { at: VERIFY_AT });
  escrow.setDeadline(PAST);
  return escrow;
}

function byId(results: ExpireOverdueResult[], id: string): ExpireOverdueResult {
  const found = results.find((r) => r.escrow.id === id);
  assert.ok(found, `expected a result entry for escrow ${id}`);
  return found;
}

describe("expireOverdueEscrows x rolePolicy", () => {
  it("mixed batch: no-policy and other-event policies expire, EXPIRE-listed policy fails with the named-actor wording", () => {
    const open = fundedOverdue("open");
    const otherEvent = fundedOverdue("other-event", {
      RELEASE: ["treasury"],
    });
    const gated = fundedOverdue("gated", { EXPIRE: ["ops-lead"] });

    const results = expireOverdueEscrows([open, otherEvent, gated], NOW);

    assert.equal(results.length, 3);
    assert.deepEqual(
      results.map((r) => r.escrow.id),
      ["open", "other-event", "gated"]
    );

    for (const id of ["open", "other-event"]) {
      const ok = byId(results, id);
      assert.equal(ok.expired, true);
      assert.equal(ok.error, undefined);
      assert.equal(ok.escrow.state, "EXPIRED");
      assert.equal(ok.entry?.event, "EXPIRE");
      assert.equal(ok.entry?.from, "FUNDED");
      assert.equal(ok.entry?.to, "EXPIRED");
      assert.equal(ok.entry?.at, NOW.toISOString());
      // the executor always attributes its EXPIRE to `system`
      assert.equal(ok.entry?.actor, "system");
    }

    const blocked = byId(results, "gated");
    assert.equal(blocked.expired, false);
    // The executor dispatches as `system`, so the failure is the
    // named-actor wording — not the missing-actor wording a
    // no-actor dispatch would produce.
    assert.equal(
      blocked.error,
      'actor not authorized for EXPIRE: "system" is not in [ops-lead]'
    );
    assert.equal("entry" in blocked, false);
    // The failed escrow is untouched: still FUNDED, no new history.
    assert.equal(blocked.escrow.state, "FUNDED");
    assert.equal(blocked.escrow.history.length, 1);
    assert.equal(blocked.escrow.history[0].event, "FUND");
  });

  it("a policy-blocked escrow first in the batch does not block later escrows", () => {
    const blocked = fundedOverdue("blocked-first", {
      EXPIRE: ["ops-lead"],
    });
    const later = fundedOverdue("later");

    const results = expireOverdueEscrows([blocked, later], NOW);

    assert.equal(results.length, 2);
    assert.equal(byId(results, "blocked-first").expired, false);
    assert.equal(byId(results, "later").expired, true);
    assert.equal(blocked.state, "FUNDED");
    assert.equal(later.state, "EXPIRED");
  });

  it("a policy-blocked escrow can still be expired manually by an allowlisted actor, with no sequence gap", () => {
    const gated = fundedOverdue("gated-retry", { EXPIRE: ["ops-lead"] });

    const results = expireOverdueEscrows([gated], NOW);
    assert.equal(results[0].expired, false);
    assert.equal(gated.history.length, 1);

    // The batch failure consumed nothing: the same screening `now`
    // (not earlier than the FUND entry) plus an allowlisted actor
    // executes cleanly, appending exactly one entry at seq 2.
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
    assert.equal(last.at, NOW.toISOString());
  });

  it("a multi-role EXPIRE policy still blocks the executor when neither role is system, and either listed role can expire manually", () => {
    const gated = fundedOverdue("gated-multi", {
      EXPIRE: ["ops-lead", "watchdog"],
    });

    const results = expireOverdueEscrows([gated], NOW);
    assert.equal(results.length, 1);
    assert.equal(results[0].expired, false);
    assert.equal(
      results[0].error,
      'actor not authorized for EXPIRE: "system" is not in [ops-lead, watchdog]'
    );
    assert.equal(gated.state, "FUNDED");

    // The second listed role is a genuine allowlist member, not a
    // fallback: it expires the escrow the executor could not.
    assert.equal(
      gated.dispatch("EXPIRE", undefined, undefined, {
        actor: "watchdog",
        at: NOW,
      }),
      "EXPIRED"
    );
  });

  it("a policy that lists system lets the executor expire", () => {
    // The gate is satisfiable by policy: allowlisting `system` for
    // EXPIRE hands the watchdog the key instead of blocking it.
    const gated = fundedOverdue("gated-system", {
      EXPIRE: ["system", "ops-lead"],
    });

    const [result] = expireOverdueEscrows([gated], NOW);
    assert.equal(result.expired, true);
    assert.equal(result.error, undefined);
    assert.equal(gated.state, "EXPIRED");
    assert.equal(result.entry?.event, "EXPIRE");
    assert.equal(result.entry?.actor, "system");
    assert.equal(gated.history[gated.history.length - 1].actor, "system");
  });

  it("a policy-listed escrow that is not overdue is never attempted, so the policy never surfaces", () => {
    const gated = fundedOverdue("gated-not-overdue", {
      EXPIRE: ["ops-lead"],
    });
    // Push the deadline past the screening instant: no longer overdue.
    gated.setDeadline(new Date("2027-01-01T00:00:00.000Z"));

    const results = expireOverdueEscrows([gated], NOW);
    assert.deepEqual(results, []);
    assert.equal(gated.state, "FUNDED");
    assert.equal(gated.history.length, 1);
  });

  it("transition legality runs before RBAC: a VERIFIED overdue escrow with an EXPIRE policy fails with the transition error, not the authorization error", () => {
    const verified = verifiedOverdue("verified-gated", {
      EXPIRE: ["ops-lead"],
    });

    const results = expireOverdueEscrows([verified], NOW);
    assert.equal(results.length, 1);
    assert.equal(results[0].expired, false);
    assert.match(
      results[0].error ?? "",
      /invalid transition: EXPIRE from VERIFIED/
    );
    assert.equal(verified.state, "VERIFIED");
    assert.equal(verified.history.length, 3);
  });
});
