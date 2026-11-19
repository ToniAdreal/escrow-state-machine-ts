/**
 * `DispatchOptions` unknown-field fail-closed (#1254).
 *
 * `Escrow.dispatch(event, note, amount, opts)` validated every known
 * option field but never scanned the keys: a typo'd `idempotencykey`
 * was silently dropped — losing the idempotency dedupe the caller
 * thought it had — and a typo'd `actorr` silently dropped the audit
 * attribution. The constructor got the same fail-closed rule in #548
 * (`ESCROW_OPTION_FIELDS`); dispatch is the same silent-config-loss
 * class, moved from construction time to every dispatch. Unknown keys
 * now throw `invalid dispatch options: unknown option "<key>"` before
 * any field is read — after the `expectedSeq` guard (which stays
 * first of all) and after the opts-must-be-object check, before the
 * actor shape validation and the idempotency dedup.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Escrow } from "../src/index.js";

const AT = "2026-03-09T09:00:00.000Z";

/** Drive an escrow to MILESTONE_SUBMITTED with a pinned audit clock. */
function milestoneSubmitted(): Escrow {
  const escrow = new Escrow("unknown-opts-1");
  escrow.dispatch("FUND", undefined, 100, { at: AT });
  escrow.dispatch("SUBMIT_MILESTONE");
  return escrow;
}

describe("DispatchOptions unknown-field fail-closed", () => {
  it("accepts all seven known keys across their legal paths", () => {
    const escrow = new Escrow("unknown-opts-ok");
    assert.equal(
      escrow.dispatch("FUND", undefined, 100, {
        actor: "sponsor",
        idempotencyKey: "fund-1",
        at: AT,
        expectedSeq: 0,
      }),
      "FUNDED"
    );
    escrow.dispatch("SUBMIT_MILESTONE", undefined, undefined, {
      expectedSeq: 1,
    });
    assert.equal(
      escrow.dispatch("VERIFY_PASS", undefined, undefined, {
        evidence: "oracle-req-1",
        actor: "oracle",
        expectedSeq: 2,
      }),
      "VERIFIED"
    );
    assert.equal(escrow.history[2].evidence, "oracle-req-1");
    assert.equal(
      escrow.dispatch("RELEASE", undefined, undefined, {
        settlementRef: "wire-2026-03-09-001",
        expectedSeq: 3,
      }),
      "RELEASED"
    );
    assert.equal(
      escrow.history[3].settlementRef,
      "wire-2026-03-09-001"
    );

    const refunded = new Escrow("unknown-opts-ok-refund");
    refunded.dispatch("FUND", undefined, 100);
    refunded.dispatch("DISPUTE");
    assert.equal(
      refunded.dispatch("ARBITRATE_REFUND", undefined, undefined, {
        refundRef: "refund-2026-03-09-001",
      }),
      "REFUNDED"
    );
    assert.equal(
      refunded.history[2].refundRef,
      "refund-2026-03-09-001"
    );
  });

  it("rejects a typo'd idempotencykey and names the field", () => {
    const escrow = new Escrow("unknown-opts-bad-1");
    assert.throws(
      () =>
        escrow.dispatch("FUND", undefined, 100, {
          idempotencykey: "k1",
        } as never),
      /invalid dispatch options: unknown option "idempotencykey"/
    );
    assert.equal(escrow.state, "CREATED");
    assert.equal(escrow.history.length, 0);
  });

  it("rejects a typo'd actorr and names the field", () => {
    const escrow = new Escrow("unknown-opts-bad-2");
    assert.throws(
      () =>
        escrow.dispatch("FUND", undefined, 100, {
          actorr: "sponsor",
        } as never),
      /invalid dispatch options: unknown option "actorr"/
    );
    assert.equal(escrow.history.length, 0);
  });

  it("rejects case-variant misspellings (expectedseq, Actor)", () => {
    const escrow = new Escrow("unknown-opts-bad-3");
    assert.throws(
      () =>
        escrow.dispatch("FUND", undefined, 100, {
          expectedseq: 0,
        } as never),
      /unknown option "expectedseq"/
    );
    assert.throws(
      () =>
        escrow.dispatch("FUND", undefined, 100, {
          Actor: "sponsor",
        } as never),
      /unknown option "Actor"/
    );
    assert.equal(escrow.history.length, 0);
  });

  it("a rejected dispatch consumes no idempotency key and appends nothing", () => {
    const escrow = new Escrow("unknown-opts-bad-4");
    assert.throws(
      () =>
        escrow.dispatch("FUND", undefined, 100, {
          idempotencyKey: "retry-1",
          actorr: "sponsor",
        } as never),
      /unknown option "actorr"/
    );
    assert.equal(escrow.state, "CREATED");
    assert.equal(escrow.history.length, 0);
    // The key was never consumed: retrying with the same key succeeds
    // instead of being treated as a duplicate.
    assert.equal(
      escrow.dispatch("FUND", undefined, 100, {
        idempotencyKey: "retry-1",
      }),
      "FUNDED"
    );
    assert.equal(escrow.history.length, 1);
  });

  it("non-object opts keeps its original error", () => {
    const escrow = new Escrow("unknown-opts-bad-5");
    assert.throws(
      () =>
        escrow.dispatch("FUND", undefined, 100, "nope" as never),
      /invalid dispatch options: opts must be an object/
    );
    assert.throws(
      () => escrow.dispatch("FUND", undefined, 100, [] as never),
      /invalid dispatch options: opts must be an object/
    );
    assert.equal(escrow.history.length, 0);
  });

  it("the expectedSeq guard still runs before the unknown-option scan", () => {
    const escrow = milestoneSubmitted();
    assert.equal(escrow.history.length, 2);
    assert.throws(
      () =>
        escrow.dispatch("VERIFY_PASS", undefined, undefined, {
          expectedSeq: 0,
          bogus: 1,
        } as never),
      /dispatch conflict: expected seq 0 but escrow is at seq 2/
    );
    assert.equal(escrow.state, "MILESTONE_SUBMITTED");
    assert.equal(escrow.history.length, 2);
  });

  it("unknown key is reported before the transition check", () => {
    const escrow = new Escrow("unknown-opts-bad-6");
    assert.throws(
      () =>
        escrow.dispatch("RELEASE", undefined, undefined, {
          bogus: 1,
        } as never),
      /invalid dispatch options: unknown option "bogus"/
    );
    assert.equal(escrow.state, "CREATED");
    assert.equal(escrow.history.length, 0);
  });

  it("unknown key is reported even on a duplicate-key delivery", () => {
    const escrow = new Escrow("unknown-opts-bad-7");
    escrow.dispatch("FUND", undefined, 100, { idempotencyKey: "dup-1" });
    // A pure duplicate is a no-op — but a duplicate carrying a typo'd
    // key is a caller bug, reported like a malformed actor on a
    // duplicate key (see the dispatch check-ordering JSDoc).
    assert.throws(
      () =>
        escrow.dispatch("FUND", undefined, 100, {
          idempotencyKey: "dup-1",
          bogus: 1,
        } as never),
      /invalid dispatch options: unknown option "bogus"/
    );
    assert.equal(escrow.history.length, 1);
  });
});
