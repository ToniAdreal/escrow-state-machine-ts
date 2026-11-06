/**
 * Snapshot persistence of `maxDeposit` / `requireVerifyEvidence` (#918).
 *
 * The deposit cap and the verify-evidence gate used to be per-instance
 * constructor configuration only: a snapshot never stored them, so a
 * restored escrow silently lost both guardrails unless the caller
 * re-enabled them via `fromJSON(snapshot, opts)`. They are snapshot
 * state now (like `rolePolicy`/`deadline`): `toJSON()` writes
 * `maxDeposit` when a cap is set and `requireVerifyEvidence: true`
 * when the gate is on, `fromJSON()` restores them, and an explicit
 * opt overrides the snapshot's value entirely. The audit key stays
 * the deliberate exception — a secret is never written into a
 * snapshot. The schema version stays 1: both fields are optional and
 * additive, so legacy snapshots without them load exactly as before.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  diffEscrowSnapshots,
} from "../src/stateMachine.js";

/** Plain-JSON copy of a snapshot, as a document store would hold it. */
function stored(escrow: Escrow): Record<string, unknown> {
  return JSON.parse(JSON.stringify(escrow.toJSON())) as Record<string, unknown>;
}

/** Escrow with both guardrails, driven to MILESTONE_SUBMITTED. */
function seeded(): Escrow {
  const escrow = new Escrow("seed-cap-gate", {
    requireVerifyEvidence: true,
    maxDeposit: 20000,
  });
  escrow.dispatch("FUND", "initial deposit", 10630);
  escrow.dispatch("SUBMIT_MILESTONE", "milestone 1 delivered");
  return escrow;
}

/** Escrow with a 1000 cap, 900 locked, still in FUNDED. */
function funded(): Escrow {
  const escrow = new Escrow("funded-cap", { maxDeposit: 1000 });
  escrow.dispatch("FUND", "initial", 900);
  return escrow;
}

describe("snapshot persistence of maxDeposit / requireVerifyEvidence (#918)", () => {
  it("maxDeposit round-trips through a JSON snapshot, v stays 1", () => {
    const snap = stored(funded());
    assert.equal(snap.v, 1);
    assert.equal(snap.maxDeposit, 1000);
    const restored = Escrow.fromJSON(snap);
    assert.equal(restored.toJSON().maxDeposit, 1000);
    assert.equal(restored.toJSON().v, 1);
  });

  it("requireVerifyEvidence round-trips through a JSON snapshot", () => {
    const snap = stored(seeded());
    assert.equal(snap.requireVerifyEvidence, true);
    const restored = Escrow.fromJSON(snap);
    assert.equal(restored.toJSON().requireVerifyEvidence, true);
  });

  it("both guardrails round-trip together and survive a second restore", () => {
    const restored = Escrow.fromJSON(stored(seeded()));
    const second = Escrow.fromJSON(stored(restored));
    assert.equal(second.toJSON().maxDeposit, 20000);
    assert.equal(second.toJSON().requireVerifyEvidence, true);
    assert.equal(second.state, "MILESTONE_SUBMITTED");
  });

  it("a guardrail-free escrow keeps its exact legacy snapshot shape", () => {
    const escrow = new Escrow("plain");
    escrow.dispatch("FUND", "initial", 100);
    const snap = escrow.toJSON();
    assert.equal("maxDeposit" in snap, false);
    assert.equal("requireVerifyEvidence" in snap, false);
    assert.deepEqual(Object.keys(snap).sort(), [
      "history",
      "id",
      "state",
      "v",
    ]);
  });

  it("a legacy snapshot without the fields loads uncapped with the gate off", () => {
    // No cap: a top-up of any size is accepted after restore.
    const restored = Escrow.fromJSON(stored(fundedCapFree()));
    assert.equal(restored.dispatch("FUND", "big top-up", 5000), "FUNDED");
    // No gate: VERIFY_PASS without evidence is accepted after restore.
    const escrow = new Escrow("legacy-gate");
    escrow.dispatch("FUND", "initial deposit", 10630);
    escrow.dispatch("SUBMIT_MILESTONE", "milestone 1 delivered");
    const restored2 = Escrow.fromJSON(stored(escrow));
    assert.equal(restored2.dispatch("VERIFY_PASS"), "VERIFIED");
    function fundedCapFree(): Escrow {
      const e = new Escrow("legacy-cap");
      e.dispatch("FUND", "initial", 900);
      return e;
    }
  });

  it("a tampered maxDeposit is rejected, never silently dropped", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "1000", null]) {
      const snap = stored(funded());
      snap.maxDeposit = bad;
      assert.throws(
        () => Escrow.fromJSON(snap),
        /invalid snapshot: maxDeposit must be a finite non-negative number/
      );
    }
  });

  it("a tampered requireVerifyEvidence is rejected, never silently dropped", () => {
    for (const bad of ["true", 1, 0, null]) {
      const snap = stored(seeded());
      snap.requireVerifyEvidence = bad;
      assert.throws(
        () => Escrow.fromJSON(snap),
        /invalid snapshot: requireVerifyEvidence must be a boolean/
      );
    }
  });

  it("a restored cap is enforced: one cent over throws with no residue", () => {
    const restored = Escrow.fromJSON(stored(funded()));
    // 900 locked, cap 1000: exactly to the cap is allowed, one cent over is not.
    assert.equal(restored.dispatch("FUND", "to the cap", 100), "FUNDED");
    assert.throws(
      () => restored.dispatch("FUND", "one cent over", 0.01),
      /deposit cap exceeded: locked 1000 \+ new funding 0\.01 would exceed maxDeposit 1000/
    );
    assert.equal(restored.state, "FUNDED");
    assert.equal(restored.history.length, 2);
  });

  it("a restored gate is enforced: evidence-free VERIFY_PASS throws, evidence passes", () => {
    const restored = Escrow.fromJSON(stored(seeded()));
    assert.throws(
      () => restored.dispatch("VERIFY_PASS"),
      /verify evidence required/
    );
    assert.equal(restored.state, "MILESTONE_SUBMITTED");
    assert.equal(restored.history.length, 2);
    const ref = "chainlink-req-0xdeadbeef::fulfilled";
    assert.equal(
      restored.dispatch("VERIFY_PASS", "KPIs validated", undefined, {
        evidence: ref,
      }),
      "VERIFIED"
    );
    assert.equal(restored.history[restored.history.length - 1].evidence, ref);
  });

  it("an explicit opts.maxDeposit overrides the snapshot cap", () => {
    // Tighten: snapshot cap 1000, opts cap 950 — a 100 top-up (900 locked) fails.
    const tightened = Escrow.fromJSON(stored(funded()), { maxDeposit: 950 });
    assert.throws(
      () => tightened.dispatch("FUND", "over the tightened cap", 100),
      /deposit cap exceeded/
    );
    // Loosen: opts cap 2000 — the same top-up succeeds.
    const loosened = Escrow.fromJSON(stored(funded()), { maxDeposit: 2000 });
    assert.equal(loosened.dispatch("FUND", "within the loosened cap", 100), "FUNDED");
    assert.equal(loosened.toJSON().maxDeposit, 2000);
  });

  it("an explicit opts.requireVerifyEvidence overrides the snapshot gate", () => {
    // Snapshot gate on, opts gate off: evidence-free VERIFY_PASS passes.
    const opened = Escrow.fromJSON(stored(seeded()), {
      requireVerifyEvidence: false,
    });
    assert.equal(opened.dispatch("VERIFY_PASS"), "VERIFIED");
    // Snapshot gate off, opts gate on: evidence-free VERIFY_PASS throws.
    const escrow = new Escrow("gate-off");
    escrow.dispatch("FUND", "initial deposit", 10630);
    escrow.dispatch("SUBMIT_MILESTONE", "milestone 1 delivered");
    const closed = Escrow.fromJSON(stored(escrow), {
      requireVerifyEvidence: true,
    });
    assert.throws(
      () => closed.dispatch("VERIFY_PASS"),
      /verify evidence required/
    );
  });

  it("diffEscrowSnapshots reports cap and gate changes, and silence when unchanged", () => {
    // One live escrow, one history: cap/gate changes are expressed by
    // editing the plain snapshot object, never by diffing two live
    // instances — two instances' FUND entries carry different
    // wall-clock timestamps (and therefore different hashes), so their
    // histories are not append-only extensions of each other.
    const escrow = new Escrow("diff-1", { maxDeposit: 1000 });
    escrow.dispatch("FUND", "initial", 900);
    const base = escrow.toJSON();
    // Cap set vs absent: same history, only the cap field differs.
    const uncapped = { ...base };
    delete (uncapped as Record<string, unknown>).maxDeposit;
    assert.deepEqual(diffEscrowSnapshots(uncapped, base).depositCapChanged, {
      from: undefined,
      to: 1000,
    });
    // Gate flip: same history, only the gate field differs.
    const gated = { ...base, requireVerifyEvidence: true };
    const diff = diffEscrowSnapshots(base, gated);
    assert.deepEqual(diff.evidenceGateChanged, { from: false, to: true });
    assert.equal(diff.depositCapChanged, undefined);
    // Identical snapshots: nothing reported at all.
    assert.deepEqual(diffEscrowSnapshots(base, escrow.toJSON()), {});
  });

  it("the audit key is never written into a snapshot", () => {
    const escrow = new Escrow("keyed", {
      auditKey: "top-secret-key",
      maxDeposit: 1000,
      requireVerifyEvidence: true,
    });
    escrow.dispatch("FUND", "initial", 900);
    const text = JSON.stringify(escrow.toJSON());
    assert.equal(text.includes("auditKey"), false);
    assert.equal(text.includes("top-secret-key"), false);
    // The keyed chain still verifies on restore with the same key.
    const restored = Escrow.fromJSON(stored(escrow), {
      auditKey: "top-secret-key",
    });
    assert.equal(restored.dispatch("FUND", "top-up", 100), "FUNDED");
  });

  it("an explicit requireVerifyEvidence: false in a snapshot restores gate-off", () => {
    const snap = stored(seeded());
    snap.requireVerifyEvidence = false;
    const restored = Escrow.fromJSON(snap);
    assert.equal(restored.toJSON().requireVerifyEvidence, undefined);
    assert.equal(restored.dispatch("VERIFY_PASS"), "VERIFIED");
  });
});
