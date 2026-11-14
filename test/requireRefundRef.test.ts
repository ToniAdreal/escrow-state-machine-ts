import test from "node:test";
import assert from "node:assert/strict";
import { Escrow, type EscrowOptions } from "../src/index.js";

/**
 * `requireRefundRef` — opt-in up-front enforcement of
 * refund-reference recording on ARBITRATE_REFUND. The default stays
 * advisory-only (an ARBITRATE_REFUND without a reference is legal
 * and the entry simply omits it); flipping the switch makes "no
 * reference" a dispatch-time error instead of a silent gap in the
 * audit trail. It complements `rolePolicy`, which only constrains
 * the events it lists: the gate only constrains ARBITRATE_REFUND,
 * and a listed ARBITRATE_REFUND still needs a matching actor
 * first. The refund-side mirror of `requireSettlementRef` (#1075)
 * with the escrow dispatch signature and check order, building on
 * the `refundRef` field from #1123.
 *
 * Rules under test:
 *  - enabled: ARBITRATE_REFUND without a refundRef throws
 *    `refund reference required: …` and leaves no history
 *    residue, no state change, no listener call
 *  - enabled: ARBITRATE_REFUND with a refundRef passes and records
 *    it verbatim on the audit entry
 *  - disabled (default) and explicit false: a reference-free
 *    ARBITRATE_REFUND stays legal
 *  - non-boolean option values throw `invalid option` at
 *    construction; a typo'd option name is rejected as unknown
 *  - the gate only constrains ARBITRATE_REFUND: FUND / DISPUTE /
 *    SUBMIT_MILESTONE / VERIFY_PASS / RELEASE / ARBITRATE_RELEASE
 *    pass without a ref while the gate is on
 *  - RBAC interplay: a listed ARBITRATE_REFUND with a wrong actor
 *    reports the RBAC error (not refund-required); a listed
 *    ARBITRATE_REFUND with no actor reports the RBAC error first;
 *    an authorized actor without a ref reports refund-required
 *  - a rejected dispatch consumes no idempotency key and leaves no
 *    seq gap; a duplicate delivery is a no-op even with the gate on
 *  - the switch is escrow configuration, not audit data: it is never
 *    written into the toJSON() snapshot
 *  - fromJSON() does not restore the switch (advisory again after
 *    restore) unless the option is passed; fromHistory(id, history,
 *    { requireRefundRef: true }) re-attaches it
 *  - with requireActor also on, an ARBITRATE_REFUND with neither
 *    actor nor ref reports the actor error first (the actor gate
 *    runs before the refund-ref gate — check order pinned)
 */

/** Drive an escrow from CREATED to DISPUTED, always carrying an actor. */
function toDisputed(id: string, opts?: EscrowOptions): Escrow {
  const e = new Escrow(id, opts);
  e.dispatch("FUND", "deposit", 100, { actor: "sponsor" });
  e.dispatch("DISPUTE", "dispute opened", undefined, {
    actor: "creator",
  });
  return e;
}

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

test("enabled: ARBITRATE_REFUND without a refundRef throws and leaves no trace", () => {
  const e = toDisputed("rr-1", { requireRefundRef: true });
  let notified = 0;
  e.subscribe(() => {
    notified += 1;
  });
  const before = e.history.length;
  assert.throws(
    () => e.dispatch("ARBITRATE_REFUND"),
    /refund reference required: ARBITRATE_REFUND must carry a non-empty refundRef when requireRefundRef is enabled/,
  );
  assert.equal(e.history.length, before);
  assert.equal(e.state, "DISPUTED");
  assert.equal(notified, 0);
});

test("enabled: ARBITRATE_REFUND with a refundRef passes and records it verbatim", () => {
  const e = toDisputed("rr-2", { requireRefundRef: true });
  e.dispatch("ARBITRATE_REFUND", undefined, undefined, {
    refundRef: "rfnd-2026-0315",
  });
  assert.equal(e.state, "REFUNDED");
  assert.equal(e.history[e.history.length - 1].refundRef, "rfnd-2026-0315");
});

test("disabled by default: ARBITRATE_REFUND without a ref stays legal", () => {
  const e = toDisputed("rr-3");
  e.dispatch("ARBITRATE_REFUND");
  assert.equal(e.state, "REFUNDED");
  assert.equal(e.history[e.history.length - 1].refundRef, undefined);
});

test("explicit false: ARBITRATE_REFUND without a ref stays legal", () => {
  const e = toDisputed("rr-4", { requireRefundRef: false });
  e.dispatch("ARBITRATE_REFUND");
  assert.equal(e.state, "REFUNDED");
});

test("non-boolean requireRefundRef values throw at construction", () => {
  for (const bad of ["yes", 1, 0, null, {}, []] as const) {
    assert.throws(
      () => new Escrow("rr-5", { requireRefundRef: bad as never }),
      /invalid option: requireRefundRef must be a boolean/,
    );
  }
});

test("a typo'd option name is rejected, never silently dropped", () => {
  assert.throws(
    () => new Escrow("rr-6", { requireRefundref: true } as never),
    /invalid escrow options: unknown option "requireRefundref"/,
  );
});

test("the gate only constrains ARBITRATE_REFUND: other events pass without a ref", () => {
  const e = new Escrow("rr-7", { requireRefundRef: true });
  e.dispatch("FUND", "deposit", 100);
  assert.equal(e.state, "FUNDED");
  e.dispatch("SUBMIT_MILESTONE", "work done");
  assert.equal(e.state, "MILESTONE_SUBMITTED");
  e.dispatch("VERIFY_PASS", "attested", undefined, {
    evidence: "attestation-1",
  });
  assert.equal(e.state, "VERIFIED");
  // RELEASE carries a settlementRef, not a refundRef: it passes
  // with no ref of either kind while the refund gate is on.
  e.dispatch("RELEASE");
  assert.equal(e.state, "RELEASED");

  // ARBITRATE_RELEASE from DISPUTED likewise carries no refundRef
  // and passes while the gate is on.
  const disputed = toDisputed("rr-7b", { requireRefundRef: true });
  disputed.dispatch("ARBITRATE_RELEASE");
  assert.equal(disputed.state, "RELEASED");
});

test("RBAC interplay: policy errors win on ARBITRATE_REFUND, the gate covers authorized actors", () => {
  const e = toDisputed("rr-8", {
    requireRefundRef: true,
    rolePolicy: { ARBITRATE_REFUND: ["arbiter"] },
  });
  // Listed event, wrong actor: the RBAC error reports (checked before
  // the refund-ref gate).
  assert.throws(
    () =>
      e.dispatch("ARBITRATE_REFUND", undefined, undefined, {
        actor: "creator",
      }),
    /actor not authorized for ARBITRATE_REFUND/,
  );
  // Listed event, no actor at all: the RBAC error reports first —
  // the policy requires an actor in its list, not just any actor.
  assert.throws(
    () => e.dispatch("ARBITRATE_REFUND"),
    /actor not authorized for ARBITRATE_REFUND: policy requires an actor/,
  );
  // Listed event, matching actor, no ref: the gate speaks.
  assert.throws(
    () =>
      e.dispatch("ARBITRATE_REFUND", undefined, undefined, {
        actor: "arbiter",
      }),
    /refund reference required/,
  );
  e.dispatch("ARBITRATE_REFUND", undefined, undefined, {
    actor: "arbiter",
    refundRef: "rfnd-8",
  });
  assert.equal(e.state, "REFUNDED");
});

test("rejected dispatch consumes no idempotency key and leaves no seq gap", () => {
  const e = toDisputed("rr-9", { requireRefundRef: true });
  const before = e.history.length;
  assert.throws(
    () =>
      e.dispatch("ARBITRATE_REFUND", undefined, undefined, {
        idempotencyKey: "k-ref-1",
      }),
    /refund reference required/,
  );
  assert.equal(e.history.length, before);
  // The failed dispatch consumed nothing: the corrected retry with the
  // same key still executes.
  e.dispatch("ARBITRATE_REFUND", undefined, undefined, {
    refundRef: "rfnd-9",
    idempotencyKey: "k-ref-1",
  });
  assert.equal(e.state, "REFUNDED");
  assert.equal(e.history.length, before + 1);
  assert.equal(e.history[e.history.length - 1].seq, before + 1);
});

test("duplicate delivery is a no-op even when the gate is on", () => {
  const e = toDisputed("rr-10", { requireRefundRef: true });
  e.dispatch("ARBITRATE_REFUND", undefined, undefined, {
    refundRef: "rfnd-10",
    idempotencyKey: "k-ref-2",
  });
  assert.equal(e.state, "REFUNDED");
  const before = e.history.length;
  // Same key, no ref: the dedupe runs before the gate, so this is a
  // pure no-op, not a refund-required error.
  assert.equal(
    e.dispatch("ARBITRATE_REFUND", undefined, undefined, {
      idempotencyKey: "k-ref-2",
    }),
    "REFUNDED",
  );
  assert.equal(e.history.length, before);
});

test("the switch is not written into the toJSON() snapshot", () => {
  const e = toDisputed("rr-11", { requireRefundRef: true });
  const snapshot = e.toJSON();
  assert.equal("requireRefundRef" in snapshot, false);
});

test("fromJSON() does not restore the switch: advisory again after restore", () => {
  const e = toDisputed("rr-12", { requireRefundRef: true });
  const restored = Escrow.fromJSON(JSON.parse(JSON.stringify(e.toJSON())));
  restored.dispatch("ARBITRATE_REFUND");
  assert.equal(restored.state, "REFUNDED");
  assert.equal(
    restored.history[restored.history.length - 1].refundRef,
    undefined,
  );
});

test("fromJSON() with the option re-enables the gate; fromHistory() re-attaches it", () => {
  const e = toDisputed("rr-13", { requireRefundRef: true });
  const snapshot = JSON.parse(JSON.stringify(e.toJSON()));
  const gated = Escrow.fromJSON(snapshot, { requireRefundRef: true });
  assert.throws(
    () => gated.dispatch("ARBITRATE_REFUND"),
    /refund reference required/,
  );
  gated.dispatch("ARBITRATE_REFUND", undefined, undefined, {
    refundRef: "rfnd-13",
  });
  assert.equal(gated.state, "REFUNDED");

  const history = JSON.parse(JSON.stringify(e.history));
  const rehydrated = Escrow.fromHistory("rr-13", history, {
    requireRefundRef: true,
  });
  assert.throws(
    () => rehydrated.dispatch("ARBITRATE_REFUND"),
    /refund reference required/,
  );
  rehydrated.dispatch("ARBITRATE_REFUND", undefined, undefined, {
    refundRef: "rfnd-13b",
  });
  assert.equal(rehydrated.state, "REFUNDED");
  // ...and without the option the rehydrated escrow stays advisory.
  const relaxed = Escrow.fromHistory("rr-13", history);
  relaxed.dispatch("ARBITRATE_REFUND");
  assert.equal(relaxed.state, "REFUNDED");
});

test("with requireActor also on: actor error reports before refund error", () => {
  const e = toDisputed("rr-14", {
    requireActor: true,
    requireRefundRef: true,
  });
  // Neither actor nor ref: the actor gate runs first in this repo
  // (it is checked before the refund-ref gate), so it reports
  // before the refund error.
  assert.throws(() => e.dispatch("ARBITRATE_REFUND"), /actor required/);
  // Actor present but no ref: the refund gate reports.
  assert.throws(
    () =>
      e.dispatch("ARBITRATE_REFUND", undefined, undefined, {
        actor: "arbiter",
      }),
    /refund reference required/,
  );
  // Both present: passes.
  e.dispatch("ARBITRATE_REFUND", undefined, undefined, {
    actor: "arbiter",
    refundRef: "rfnd-14",
  });
  assert.equal(e.state, "REFUNDED");
});
