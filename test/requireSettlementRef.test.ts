import test from "node:test";
import assert from "node:assert/strict";
import { Escrow, type EscrowOptions } from "../src/index.js";

/**
 * `requireSettlementRef` — opt-in up-front enforcement of
 * settlement-reference recording on RELEASE. The default stays
 * advisory-only (a RELEASE without a reference is legal and the
 * entry simply omits it); flipping the switch makes "no reference"
 * a dispatch-time error instead of a silent gap in the audit trail.
 * It complements `rolePolicy`, which only constrains the events it
 * lists: the gate only constrains RELEASE, and a listed RELEASE
 * still needs a matching actor first. Mirrors the dataquest
 * lifecycle's `requirePayoutRef` (#1045) with the escrow dispatch
 * signature and check order, building on the `settlementRef` field
 * from #1072.
 *
 * Rules under test:
 *  - enabled: RELEASE without a settlementRef throws
 *    `settlement reference required: …` and leaves no history
 *    residue, no state change, no listener call
 *  - enabled: RELEASE with a settlementRef passes and records it
 *    verbatim on the audit entry
 *  - disabled (default) and explicit false: a reference-free
 *    RELEASE stays legal
 *  - non-boolean option values throw `invalid option` at
 *    construction; a typo'd option name is rejected as unknown
 *  - the gate only constrains RELEASE: FUND / SUBMIT_MILESTONE /
 *    VERIFY_PASS pass without a ref while the gate is on
 *  - RBAC interplay: a listed RELEASE with a wrong actor reports
 *    the RBAC error (not settlement-required); a listed RELEASE
 *    with no actor reports the RBAC error first; an authorized
 *    actor without a ref reports settlement-required
 *  - a rejected dispatch consumes no idempotency key and leaves no
 *    seq gap; a duplicate delivery is a no-op even with the gate on
 *  - the switch is escrow configuration, not audit data: it is never
 *    written into the toJSON() snapshot
 *  - fromJSON() does not restore the switch (advisory again after
 *    restore) unless the option is passed; fromHistory(id, history,
 *    { requireSettlementRef: true }) re-attaches it
 *  - with requireActor also on, a RELEASE with neither actor nor ref
 *    reports the actor error first (the actor gate runs before the
 *    settlement-ref gate — check order pinned)
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

test("enabled: RELEASE without a settlementRef throws and leaves no trace", () => {
  const e = toVerified("rs-1", { requireSettlementRef: true });
  let notified = 0;
  e.subscribe(() => {
    notified += 1;
  });
  const before = e.history.length;
  assert.throws(
    () => e.dispatch("RELEASE"),
    /settlement reference required: RELEASE must carry a non-empty settlementRef when requireSettlementRef is enabled/,
  );
  assert.equal(e.history.length, before);
  assert.equal(e.state, "VERIFIED");
  assert.equal(notified, 0);
});

test("enabled: RELEASE with a settlementRef passes and records it verbatim", () => {
  const e = toVerified("rs-2", { requireSettlementRef: true });
  e.dispatch("RELEASE", undefined, undefined, {
    settlementRef: "0xabc123",
  });
  assert.equal(e.state, "RELEASED");
  assert.equal(e.history[e.history.length - 1].settlementRef, "0xabc123");
});

test("disabled by default: RELEASE without a ref stays legal", () => {
  const e = toVerified("rs-3");
  e.dispatch("RELEASE");
  assert.equal(e.state, "RELEASED");
  assert.equal(e.history[e.history.length - 1].settlementRef, undefined);
});

test("explicit false: RELEASE without a ref stays legal", () => {
  const e = toVerified("rs-4", { requireSettlementRef: false });
  e.dispatch("RELEASE");
  assert.equal(e.state, "RELEASED");
});

test("non-boolean requireSettlementRef values throw at construction", () => {
  for (const bad of ["yes", 1, 0, null, {}, []] as const) {
    assert.throws(
      () => new Escrow("rs-5", { requireSettlementRef: bad as never }),
      /invalid option: requireSettlementRef must be a boolean/,
    );
  }
});

test("a typo'd option name is rejected, never silently dropped", () => {
  assert.throws(
    () =>
      new Escrow("rs-6", { requireSettlementref: true } as never),
    /invalid escrow options: unknown option "requireSettlementref"/,
  );
});

test("the gate only constrains RELEASE: other events pass without a ref", () => {
  const e = new Escrow("rs-7", { requireSettlementRef: true });
  e.dispatch("FUND", "deposit", 100);
  assert.equal(e.state, "FUNDED");
  e.dispatch("SUBMIT_MILESTONE", "work done");
  assert.equal(e.state, "MILESTONE_SUBMITTED");
  e.dispatch("VERIFY_PASS", "attested");
  assert.equal(e.state, "VERIFIED");
});

test("RBAC interplay: policy errors win on RELEASE, the gate covers authorized actors", () => {
  const e = toVerified("rs-8", {
    requireSettlementRef: true,
    rolePolicy: { RELEASE: ["treasury"] },
  });
  // Listed event, wrong actor: the RBAC error reports (checked before
  // the settlement-ref gate).
  assert.throws(
    () =>
      e.dispatch("RELEASE", undefined, undefined, { actor: "creator" }),
    /actor not authorized for RELEASE/,
  );
  // Listed event, no actor at all: the RBAC error reports first —
  // the policy requires an actor in its list, not just any actor.
  assert.throws(
    () => e.dispatch("RELEASE"),
    /actor not authorized for RELEASE: policy requires an actor/,
  );
  // Listed event, matching actor, no ref: the gate speaks.
  assert.throws(
    () =>
      e.dispatch("RELEASE", undefined, undefined, { actor: "treasury" }),
    /settlement reference required/,
  );
  e.dispatch("RELEASE", undefined, undefined, {
    actor: "treasury",
    settlementRef: "tx-8",
  });
  assert.equal(e.state, "RELEASED");
});

test("rejected dispatch consumes no idempotency key and leaves no seq gap", () => {
  const e = toVerified("rs-9", { requireSettlementRef: true });
  const before = e.history.length;
  assert.throws(
    () =>
      e.dispatch("RELEASE", undefined, undefined, {
        idempotencyKey: "k-ref-1",
      }),
    /settlement reference required/,
  );
  assert.equal(e.history.length, before);
  // The failed dispatch consumed nothing: the corrected retry with the
  // same key still executes.
  e.dispatch("RELEASE", undefined, undefined, {
    settlementRef: "tx-9",
    idempotencyKey: "k-ref-1",
  });
  assert.equal(e.state, "RELEASED");
  assert.equal(e.history.length, before + 1);
  assert.equal(e.history[e.history.length - 1].seq, before + 1);
});

test("duplicate delivery is a no-op even when the gate is on", () => {
  const e = toVerified("rs-10", { requireSettlementRef: true });
  e.dispatch("RELEASE", undefined, undefined, {
    settlementRef: "tx-10",
    idempotencyKey: "k-ref-2",
  });
  assert.equal(e.state, "RELEASED");
  const before = e.history.length;
  // Same key, no ref: the dedupe runs before the gate, so this is a
  // pure no-op, not a settlement-required error.
  assert.equal(
    e.dispatch("RELEASE", undefined, undefined, {
      idempotencyKey: "k-ref-2",
    }),
    "RELEASED",
  );
  assert.equal(e.history.length, before);
});

test("the switch is not written into the toJSON() snapshot", () => {
  const e = toVerified("rs-11", { requireSettlementRef: true });
  const snapshot = e.toJSON();
  assert.equal("requireSettlementRef" in snapshot, false);
});

test("fromJSON() does not restore the switch: advisory again after restore", () => {
  const e = toVerified("rs-12", { requireSettlementRef: true });
  const restored = Escrow.fromJSON(JSON.parse(JSON.stringify(e.toJSON())));
  restored.dispatch("RELEASE");
  assert.equal(restored.state, "RELEASED");
  assert.equal(
    restored.history[restored.history.length - 1].settlementRef,
    undefined,
  );
});

test("fromJSON() with the option re-enables the gate; fromHistory() re-attaches it", () => {
  const e = toVerified("rs-13", { requireSettlementRef: true });
  const snapshot = JSON.parse(JSON.stringify(e.toJSON()));
  const gated = Escrow.fromJSON(snapshot, { requireSettlementRef: true });
  assert.throws(() => gated.dispatch("RELEASE"), /settlement reference required/);
  gated.dispatch("RELEASE", undefined, undefined, {
    settlementRef: "tx-13",
  });
  assert.equal(gated.state, "RELEASED");

  const history = JSON.parse(JSON.stringify(e.history));
  const rehydrated = Escrow.fromHistory("rs-13", history, {
    requireSettlementRef: true,
  });
  assert.throws(
    () => rehydrated.dispatch("RELEASE"),
    /settlement reference required/,
  );
  rehydrated.dispatch("RELEASE", undefined, undefined, {
    settlementRef: "tx-13b",
  });
  assert.equal(rehydrated.state, "RELEASED");
  // ...and without the option the rehydrated escrow stays advisory.
  const relaxed = Escrow.fromHistory("rs-13", history);
  relaxed.dispatch("RELEASE");
  assert.equal(relaxed.state, "RELEASED");
});

test("with requireActor also on: actor error reports before settlement error", () => {
  const e = toVerified("rs-14", {
    requireActor: true,
    requireSettlementRef: true,
  });
  // Neither actor nor ref: the actor gate runs first in this repo
  // (it is checked before the settlement-ref gate), so it reports
  // before the settlement error.
  assert.throws(() => e.dispatch("RELEASE"), /actor required/);
  // Actor present but no ref: the settlement gate reports.
  assert.throws(
    () =>
      e.dispatch("RELEASE", undefined, undefined, { actor: "treasury" }),
    /settlement reference required/,
  );
  // Both present: passes.
  e.dispatch("RELEASE", undefined, undefined, {
    actor: "treasury",
    settlementRef: "tx-14",
  });
  assert.equal(e.state, "RELEASED");
});
