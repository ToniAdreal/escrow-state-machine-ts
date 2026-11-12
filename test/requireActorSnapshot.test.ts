import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  diffEscrowSnapshots,
  type EscrowOptions,
} from "../src/index.js";

/**
 * `requireActor` in snapshots (backlog #1078). Before this item the
 * gate was escrow configuration that never entered `toJSON()`:
 * a restored escrow silently lost it and accepted anonymous
 * dispatches it would previously have rejected. The gate now
 * follows the `requireVerifyEvidence` precedent — persisted as an
 * optional `requireActor: true` field, restored by `fromJSON`
 * unless an explicit option overrides it, and reported by
 * `diffEscrowSnapshots` as `actorGateChanged`.
 *
 * Rules under test:
 *  - `toJSON()` writes `requireActor: true` only when the gate is
 *    on; a gate-off escrow's snapshot keeps its exact legacy shape
 *  - `fromJSON()` restores the gate: a restored escrow rejects an
 *    anonymous dispatch and keeps dispatching with an actor
 *  - an explicit `opts.requireActor` overrides the snapshot's value
 *    in both directions (on -> off and off -> on)
 *  - a legacy snapshot without the field restores with the gate off
 *  - a non-boolean `requireActor` field is rejected as
 *    `invalid snapshot: requireActor must be a boolean, …`
 *  - `diffEscrowSnapshots` reports `actorGateChanged` on a true
 *    off->on or on->off flip, and reports nothing when both sides
 *    are gate-off (absent field and explicit `false` are the same
 *    state)
 *  - a signed snapshot round-trips the gate, and flipping the gate
 *    inside a signed envelope fails the MAC check
 *  - the gate survives a JSON wire round-trip and stays on across
 *    further dispatches
 */

const SECRET = "require-actor-snapshot-test-secret";

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

test("toJSON() writes requireActor: true only when the gate is on", () => {
  assert.equal(toVerified("ras-1", { requireActor: true }).toJSON().requireActor, true);
  const open = toVerified("ras-1b");
  assert.equal("requireActor" in open.toJSON(), false);
  const explicitOff = toVerified("ras-1c", { requireActor: false });
  assert.equal("requireActor" in explicitOff.toJSON(), false);
});

test("fromJSON() round-trip retains the gate: anonymous dispatch rejected after restore", () => {
  const e = toVerified("ras-2", { requireActor: true });
  const restored = Escrow.fromJSON(JSON.parse(JSON.stringify(e.toJSON())));
  assert.throws(() => restored.dispatch("RELEASE"), /actor required/);
  restored.dispatch("RELEASE", undefined, undefined, { actor: "treasury" });
  assert.equal(restored.state, "RELEASED");
  // The gate is still on in the re-exported snapshot.
  assert.equal(restored.toJSON().requireActor, true);
});

test("fromJSON() opts override turns the gate off", () => {
  const e = toVerified("ras-3", { requireActor: true });
  const restored = Escrow.fromJSON(JSON.parse(JSON.stringify(e.toJSON())), {
    requireActor: false,
  });
  restored.dispatch("RELEASE");
  assert.equal(restored.state, "RELEASED");
  assert.equal("requireActor" in restored.toJSON(), false);
});

test("fromJSON() opts override turns the gate on for a gate-off snapshot", () => {
  const e = toVerified("ras-4");
  const restored = Escrow.fromJSON(JSON.parse(JSON.stringify(e.toJSON())), {
    requireActor: true,
  });
  assert.throws(() => restored.dispatch("RELEASE"), /actor required/);
  restored.dispatch("RELEASE", undefined, undefined, { actor: "treasury" });
  assert.equal(restored.state, "RELEASED");
});

test("legacy snapshot without the field restores with the gate off", () => {
  const e = toVerified("ras-5", { requireActor: true });
  const legacy = JSON.parse(JSON.stringify(e.toJSON()));
  delete legacy.requireActor;
  const restored = Escrow.fromJSON(legacy);
  restored.dispatch("RELEASE");
  assert.equal(restored.state, "RELEASED");
});

test("non-boolean requireActor in a snapshot is rejected", () => {
  const base = toVerified("ras-6", { requireActor: true }).toJSON();
  for (const bad of ["yes", 1, 0, null, {}, []]) {
    const snapshot = { ...base, requireActor: bad };
    assert.throws(
      () => Escrow.fromJSON(snapshot),
      /invalid snapshot: requireActor must be a boolean/,
    );
  }
});

test("diffEscrowSnapshots reports actorGateChanged off -> on", () => {
  const gated = toVerified("ras-7", { requireActor: true }).toJSON();
  const off = { ...gated };
  delete off.requireActor;
  assert.deepEqual(diffEscrowSnapshots(off, gated), {
    actorGateChanged: { from: false, to: true },
  });
});

test("diffEscrowSnapshots reports actorGateChanged on -> off", () => {
  const gated = toVerified("ras-8", { requireActor: true }).toJSON();
  const off = { ...gated };
  delete off.requireActor;
  assert.deepEqual(diffEscrowSnapshots(gated, off), {
    actorGateChanged: { from: true, to: false },
  });
});

test("diffEscrowSnapshots: absent field and explicit false are the same gate-off state", () => {
  const gated = toVerified("ras-9", { requireActor: true }).toJSON();
  const off = { ...gated };
  delete off.requireActor;
  const explicitOff = { ...off, requireActor: false };
  assert.deepEqual(diffEscrowSnapshots(off, explicitOff), {});
  assert.deepEqual(diffEscrowSnapshots(explicitOff, off), {});
});

test("signed snapshot round-trip retains the gate", () => {
  const e = toVerified("ras-10", { requireActor: true });
  const envelope = e.exportSignedSnapshot(SECRET);
  assert.equal(envelope.snapshot.requireActor, true);
  const restored = Escrow.restoreSignedSnapshot(
    JSON.parse(JSON.stringify(envelope)),
    SECRET,
  );
  assert.throws(() => restored.dispatch("RELEASE"), /actor required/);
  restored.dispatch("RELEASE", undefined, undefined, { actor: "treasury" });
  assert.equal(restored.state, "RELEASED");
});

test("flipping requireActor inside a signed envelope fails the MAC check", () => {
  const e = toVerified("ras-11", { requireActor: true });
  const envelope = e.exportSignedSnapshot(SECRET);
  const tampered = JSON.parse(JSON.stringify(envelope));
  delete tampered.snapshot.requireActor;
  assert.throws(
    () => Escrow.restoreSignedSnapshot(tampered, SECRET),
    /signed snapshot MAC mismatch/,
  );
});

test("gate survives a JSON wire round-trip and stays on across further dispatches", () => {
  const e = toVerified("ras-12", { requireActor: true });
  const wire = JSON.stringify(e.toJSON());
  const restored = Escrow.fromJSON(JSON.parse(wire));
  restored.dispatch("RELEASE", undefined, undefined, { actor: "treasury" });
  assert.equal(restored.state, "RELEASED");
  assert.equal(restored.toJSON().requireActor, true);
  assert.equal(JSON.parse(JSON.stringify(restored.toJSON())).requireActor, true);
});
