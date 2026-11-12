import test from "node:test";
import assert from "node:assert/strict";
import { Escrow, type EscrowOptions } from "../src/index.js";

/**
 * `requireActor` — opt-in up-front enforcement of audit attribution on
 * every dispatch. The default stays advisory-only (an anonymous dispatch
 * is legal and the entry simply omits the actor); flipping the switch
 * makes "no actor" a dispatch-time error instead of a silent gap in
 * the audit trail. It complements `rolePolicy`, which only constrains
 * the events it lists: `requireActor` covers all of them, and a listed
 * event still needs a matching actor, not just any actor. Mirrors the
 * dataquest lifecycle's `requireActor` (#928) with the escrow dispatch
 * signature and check order.
 *
 * Rules under test:
 *  - enabled: dispatch without an actor throws `actor required: …`
 *    and leaves no history residue, no state change, no listener call
 *  - enabled: dispatch with an actor passes and records it
 *  - disabled (default) and explicit false: anonymous dispatch legal
 *  - non-boolean option values throw `invalid option` at construction
 *  - RBAC interplay: a listed event with a wrong actor reports the
 *    RBAC error (not actor-required); a listed event with no actor
 *    reports the RBAC error first; an unlisted event with no actor
 *    reports actor-required
 *  - a rejected dispatch consumes no idempotency key and leaves no seq gap
 *  - the switch IS written into the toJSON() snapshot (backlog
 *    #1078): `requireActor: true` only when the gate is on, so a
 *    restored escrow keeps enforcing it
 *  - fromJSON() restores the switch (an explicit `opts.requireActor`
 *    overrides the snapshot's value);
 *    fromHistory(id, history, { requireActor: true }) re-attaches it
 *    (a bare history carries no gate)
 *  - with requireVerifyEvidence also on, a VERIFY_PASS with an actor but
 *    no evidence reports the evidence error; with neither, the evidence
 *    error reports first (the evidence gate runs before the actor gate
 *    in this repo — check order pinned)
 */

/** Drive an escrow from CREATED to VERIFIED, always carrying an actor. */
function toVerified(id: string, opts?: EscrowOptions): Escrow {
  const e = new Escrow(id, opts);
  e.dispatch("FUND", "deposit", 100, { actor: "sponsor" });
  e.dispatch("SUBMIT_MILESTONE", "work done", undefined, {
    actor: "creator",
  });
  e.dispatch("VERIFY_PASS", "attested", undefined, {
    actor: "oracle",
    evidence: "attestation-1",
  });
  return e;
}

test("enabled: dispatch without an actor throws and leaves no trace", () => {
  const e = new Escrow("ra-1", { requireActor: true });
  let notified = 0;
  e.subscribe(() => {
    notified += 1;
  });
  const before = e.history.length;
  assert.throws(
    () => e.dispatch("FUND", "deposit", 100),
    /actor required: dispatch must carry a non-empty actor when requireActor is enabled/,
  );
  assert.equal(e.history.length, before);
  assert.equal(e.state, "CREATED");
  assert.equal(notified, 0);
});

test("enabled: dispatch with an actor passes and records it", () => {
  const e = new Escrow("ra-2", { requireActor: true });
  e.dispatch("FUND", "deposit", 100, { actor: "sponsor" });
  assert.equal(e.state, "FUNDED");
  assert.equal(e.history[0].actor, "sponsor");
});

test("disabled by default: anonymous dispatch stays legal", () => {
  const e = new Escrow("ra-3");
  e.dispatch("FUND", "deposit", 100);
  assert.equal(e.state, "FUNDED");
  assert.equal(e.history[0].actor, undefined);
});

test("explicit false: anonymous dispatch stays legal", () => {
  const e = new Escrow("ra-4", { requireActor: false });
  e.dispatch("FUND", "deposit", 100);
  assert.equal(e.state, "FUNDED");
});

test("non-boolean requireActor values throw at construction", () => {
  for (const bad of ["yes", 1, 0, null, {}, []] as const) {
    assert.throws(
      () => new Escrow("ra-5", { requireActor: bad as never }),
      /invalid option: requireActor must be a boolean/,
    );
  }
});

test("RBAC interplay: policy errors win on listed events, requireActor covers the rest", () => {
  const e = new Escrow("ra-6", {
    requireActor: true,
    rolePolicy: { FUND: ["sponsor"] },
  });
  // Listed event, wrong actor: the RBAC error reports (checked before
  // the actor-required gate).
  assert.throws(
    () => e.dispatch("FUND", "deposit", 100, { actor: "creator" }),
    /actor not authorized for FUND/,
  );
  // Listed event, no actor at all: the RBAC error reports first —
  // the policy requires an actor in its list, not just any actor.
  assert.throws(
    () => e.dispatch("FUND", "deposit", 100),
    /actor not authorized for FUND: policy requires an actor/,
  );
  // Listed event, matching actor: passes.
  e.dispatch("FUND", "deposit", 100, { actor: "sponsor" });
  assert.equal(e.state, "FUNDED");
  // Unlisted event, no actor: the policy is silent, requireActor speaks.
  assert.throws(
    () => e.dispatch("SUBMIT_MILESTONE", "work done"),
    /actor required: dispatch must carry a non-empty actor/,
  );
  e.dispatch("SUBMIT_MILESTONE", "work done", undefined, {
    actor: "creator",
  });
  assert.equal(e.state, "MILESTONE_SUBMITTED");
});

test("rejected dispatch consumes no idempotency key and leaves no seq gap", () => {
  const e = new Escrow("ra-7", { requireActor: true });
  const before = e.history.length;
  assert.throws(
    () =>
      e.dispatch("FUND", "deposit", 100, { idempotencyKey: "k-actor-1" }),
    /actor required/,
  );
  assert.equal(e.history.length, before);
  // The failed dispatch consumed nothing: the corrected retry with the
  // same key still executes.
  e.dispatch("FUND", "deposit", 100, {
    actor: "sponsor",
    idempotencyKey: "k-actor-1",
  });
  assert.equal(e.state, "FUNDED");
  assert.equal(e.history.length, before + 1);
  assert.equal(e.history[e.history.length - 1].seq, before + 1);
});

test("the switch is written into the toJSON() snapshot when on, absent when off (backlog #1078)", () => {
  const gated = toVerified("ra-8", { requireActor: true });
  assert.equal(gated.toJSON().requireActor, true);
  const open = toVerified("ra-8b");
  assert.equal("requireActor" in open.toJSON(), false);
});

test("fromJSON() restores the switch: restored escrow still requires an actor (backlog #1078)", () => {
  const e = toVerified("ra-9", { requireActor: true });
  const restored = Escrow.fromJSON(JSON.parse(JSON.stringify(e.toJSON())));
  assert.throws(() => restored.dispatch("RELEASE"), /actor required/);
  restored.dispatch("RELEASE", undefined, undefined, { actor: "treasury" });
  assert.equal(restored.state, "RELEASED");
});

test("fromHistory() re-attaches the switch via options", () => {
  const e = toVerified("ra-10");
  const history = JSON.parse(JSON.stringify(e.history));
  const rehydrated = Escrow.fromHistory("ra-10", history, {
    requireActor: true,
  });
  assert.throws(() => rehydrated.dispatch("RELEASE"), /actor required/);
  rehydrated.dispatch("RELEASE", undefined, undefined, {
    actor: "treasury",
  });
  assert.equal(rehydrated.state, "RELEASED");
  // ...and without the option the rehydrated escrow stays advisory.
  const relaxed = Escrow.fromHistory("ra-10", history);
  relaxed.dispatch("RELEASE");
  assert.equal(relaxed.state, "RELEASED");
});

test("with requireVerifyEvidence also on: evidence error reports before actor error", () => {
  const e = toVerified("ra-11", {
    requireActor: true,
    requireVerifyEvidence: true,
  });
  // The escrow is VERIFIED; drive a fresh one to MILESTONE_SUBMITTED
  // so VERIFY_PASS is the next legal edge.
  const f = new Escrow("ra-11b", {
    requireActor: true,
    requireVerifyEvidence: true,
  });
  f.dispatch("FUND", "deposit", 100, { actor: "sponsor" });
  f.dispatch("SUBMIT_MILESTONE", "work done", undefined, {
    actor: "creator",
  });
  // Actor present but no evidence: the evidence gate reports.
  assert.throws(
    () =>
      f.dispatch("VERIFY_PASS", "attested", undefined, { actor: "oracle" }),
    /verify evidence required/,
  );
  // Neither actor nor evidence: the evidence gate runs first in this
  // repo (it is checked before the transition/RBAC checks), so it
  // reports before the actor gate.
  assert.throws(
    () => f.dispatch("VERIFY_PASS", "attested"),
    /verify evidence required/,
  );
  // Both present: passes.
  f.dispatch("VERIFY_PASS", "attested", undefined, {
    actor: "oracle",
    evidence: "attestation-11",
  });
  assert.equal(f.state, "VERIFIED");
  assert.equal(e.state, "VERIFIED");
});
