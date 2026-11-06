/**
 * fromJSON + EscrowOptions tests (#106).
 *
 * `Escrow.fromJSON` used to rebuild with a bare `new Escrow(id)`, silently
 * dropping per-instance guardrails: an escrow constructed with
 * `requireVerifyEvidence` or `maxDeposit` lost those risk controls on every
 * restart, with no way to re-attach them on the restore path. `fromJSON`
 * now accepts an optional `EscrowOptions` second parameter that is passed
 * straight through to the constructor (same validation). Since backlog
 * #918 the snapshot itself also stores both flags, so the opts are an
 * OVERRIDE of stored state now, not the only way to re-attach them —
 * see test/snapshotDepositCap.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Escrow } from "../src/stateMachine.js";

/** Escrow driven to MILESTONE_SUBMITTED, the state that can VERIFY_PASS. */
function seeded(): Escrow {
  const escrow = new Escrow("seed-1", {
    requireVerifyEvidence: true,
    maxDeposit: 20000,
  });
  escrow.dispatch("FUND", "initial deposit", 10630);
  escrow.dispatch("SUBMIT_MILESTONE", "milestone 1 delivered");
  return escrow;
}

describe("Escrow.fromJSON(snapshot, opts)", () => {
  it("re-enables requireVerifyEvidence: VERIFY_PASS without evidence throws, no residue", () => {
    const snap = JSON.parse(JSON.stringify(seeded().toJSON()));
    const restored = Escrow.fromJSON(snap, { requireVerifyEvidence: true });
    assert.equal(restored.state, "MILESTONE_SUBMITTED");
    assert.equal(restored.history.length, 2);
    assert.throws(
      () => restored.dispatch("VERIFY_PASS"),
      /verify evidence required/
    );
    assert.equal(restored.state, "MILESTONE_SUBMITTED");
    assert.equal(restored.history.length, 2);
  });

  it("restored evidence gate passes when evidence is supplied", () => {
    const snap = JSON.parse(JSON.stringify(seeded().toJSON()));
    const restored = Escrow.fromJSON(snap, { requireVerifyEvidence: true });
    const ref = "chainlink-req-0xdeadbeef::fulfilled";
    assert.equal(
      restored.dispatch("VERIFY_PASS", "KPIs validated", undefined, {
        evidence: ref,
      }),
      "VERIFIED"
    );
    assert.equal(restored.history[restored.history.length - 1].evidence, ref);
  });

  it("re-enables maxDeposit: top-up past the cap throws with no residue", () => {
    const snap = JSON.parse(JSON.stringify(seeded().toJSON()));
    // Locked total is 10630; cap it below that.
    const restored = Escrow.fromJSON(snap, { maxDeposit: 10630 });
    assert.equal(restored.state, "MILESTONE_SUBMITTED");
    // New funding is impossible in this state, so use a fresh FUND-stage
    // snapshot: build escrow, fund once, snapshot, restore with a tight cap.
    const escrow = new Escrow("cap-1");
    escrow.dispatch("FUND", "initial", 900);
    const restored2 = Escrow.fromJSON(
      JSON.parse(JSON.stringify(escrow.toJSON())),
      { maxDeposit: 1000 }
    );
    assert.throws(
      () => restored2.dispatch("FUND", "over the cap", 200),
      /deposit cap exceeded/
    );
    assert.equal(restored2.state, "FUNDED");
    assert.equal(restored2.history.length, 1);
  });

  it("restored maxDeposit still allows funding within the cap", () => {
    const escrow = new Escrow("cap-2");
    escrow.dispatch("FUND", "initial", 900);
    const restored = Escrow.fromJSON(
      JSON.parse(JSON.stringify(escrow.toJSON())),
      { maxDeposit: 1000 }
    );
    assert.equal(restored.dispatch("FUND", "top-up", 100), "FUNDED");
    assert.equal(restored.history.length, 2);
  });

  it("without opts the restored escrow keeps the snapshot's guardrails; a guardrail-free snapshot keeps legacy behavior", () => {
    const snap = JSON.parse(JSON.stringify(seeded().toJSON()));
    const restored = Escrow.fromJSON(snap);
    // The snapshot carries the gate and the cap now (#918): the
    // restored escrow enforces both without any opts.
    assert.throws(
      () => restored.dispatch("VERIFY_PASS"),
      /verify evidence required/
    );
    // A guardrail-free snapshot restores legacy behavior: no cap, no gate.
    const big = new Escrow("big-1");
    const bigRestored = Escrow.fromJSON(
      JSON.parse(JSON.stringify(big.toJSON()))
    );
    assert.equal(bigRestored.dispatch("FUND", "whale", 1e9), "FUNDED");
    const plain = new Escrow("plain-1");
    plain.dispatch("FUND", "initial deposit", 10630);
    plain.dispatch("SUBMIT_MILESTONE", "milestone 1 delivered");
    const plainRestored = Escrow.fromJSON(
      JSON.parse(JSON.stringify(plain.toJSON()))
    );
    assert.equal(plainRestored.dispatch("VERIFY_PASS"), "VERIFIED");
  });

  it("both flags can be re-enabled together on the same restored escrow", () => {
    const escrow = new Escrow("both-1");
    escrow.dispatch("FUND", "initial", 900);
    const restored = Escrow.fromJSON(
      JSON.parse(JSON.stringify(escrow.toJSON())),
      { requireVerifyEvidence: true, maxDeposit: 1000 }
    );
    assert.throws(
      () => restored.dispatch("FUND", "over the cap", 101),
      /deposit cap exceeded/
    );
    restored.dispatch("FUND", "top-up", 100); // 900 + 100 == cap: allowed
    assert.equal(restored.history.length, 2);
    // requireVerifyEvidence only gates VERIFY_PASS; this state has none.
    // Drive it to the VERIFY_PASS state on the restored instance.
    restored.dispatch("SUBMIT_MILESTONE", "done");
    assert.throws(
      () => restored.dispatch("VERIFY_PASS"),
      /verify evidence required/
    );
    assert.equal(
      restored.dispatch("VERIFY_PASS", "ok", undefined, {
        evidence: "quote-0x1",
      }),
      "VERIFIED"
    );
  });

  it("invalid opts are rejected by the constructor validation (not masked)", () => {
    const snap = JSON.parse(JSON.stringify(seeded().toJSON()));
    assert.throws(
      () => Escrow.fromJSON(snap, null as never),
      /invalid escrow options/
    );
    assert.throws(
      () => Escrow.fromJSON(snap, { requireVerifyEvidence: "yes" } as never),
      /invalid escrow options/
    );
    assert.throws(
      () => Escrow.fromJSON(snap, { maxDeposit: -5 }),
      /invalid escrow options|maxDeposit/
    );
    assert.throws(() => Escrow.fromJSON(snap, { maxDeposit: NaN }), /maxDeposit/);
  });

  it("snapshot validation still runs first: corrupt snapshot + valid opts throws", () => {
    const snap = JSON.parse(JSON.stringify(seeded().toJSON()));
    snap.history[0].event = "RELEASE"; // corrupt: CREATED cannot RELEASE
    assert.throws(
      () =>
        Escrow.fromJSON(snap, {
          requireVerifyEvidence: true,
          maxDeposit: 20000,
        }),
      /invalid snapshot/
    );
  });

  it("the guardrails ride along in the snapshot; only the audit key never leaks (#918)", () => {
    const snap = JSON.parse(JSON.stringify(seeded().toJSON()));
    const restored = Escrow.fromJSON(snap, {
      requireVerifyEvidence: true,
      maxDeposit: 20000,
    });
    const resnap = JSON.parse(JSON.stringify(restored.toJSON()));
    assert.equal(resnap.requireVerifyEvidence, true);
    assert.equal(resnap.maxDeposit, 20000);
    assert.deepEqual(Object.keys(resnap).sort(), [
      "history",
      "id",
      "maxDeposit",
      "requireVerifyEvidence",
      "state",
      "v",
    ]);
    // And the re-snapshot rehydrates WITH the guardrails, without opts.
    const plain = Escrow.fromJSON(resnap);
    assert.equal(plain.state, "MILESTONE_SUBMITTED");
    assert.throws(
      () => plain.dispatch("VERIFY_PASS"),
      /verify evidence required/
    );
  });

  it("opts restored state keeps dispatching: full lifecycle survives to RELEASED", () => {
    const snap = JSON.parse(JSON.stringify(seeded().toJSON()));
    const restored = Escrow.fromJSON(snap, { requireVerifyEvidence: true });
    restored.dispatch("VERIFY_PASS", "ok", undefined, {
      evidence: "chainlink-req-0xabc::fulfilled",
    });
    assert.equal(restored.dispatch("RELEASE"), "RELEASED");
    assert.ok(restored.isTerminal);
  });
});
