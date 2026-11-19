import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  diffEscrowSnapshots,
  type EscrowOptions,
} from "../src/index.js";

/**
 * `requireSettlementRef` / `requireRefundRef` in snapshots (backlog
 * #1256). Before this item the two gates were escrow configuration
 * that never entered `toJSON()`: a restored escrow silently lost
 * them and accepted a reference-free RELEASE / ARBITRATE_REFUND it
 * would previously have rejected. The gates now follow the
 * `requireActor` precedent (#1078) — persisted as optional
 * `requireSettlementRef: true` / `requireRefundRef: true` fields,
 * restored by `fromJSON` unless an explicit option overrides them,
 * and reported by `diffEscrowSnapshots` as
 * `settlementRefGateChanged` / `refundRefGateChanged`.
 *
 * Rules under test:
 *  - `toJSON()` writes each gate `true` only when it is on; a
 *    gate-off escrow's snapshot keeps its exact legacy shape
 *  - `fromJSON()` restores both gates: a restored escrow rejects a
 *    reference-free RELEASE / ARBITRATE_REFUND and keeps
 *    dispatching with a reference
 *  - an explicit `opts.requireSettlementRef` / `opts.requireRefundRef`
 *    overrides the snapshot's value in both directions (on -> off
 *    and off -> on)
 *  - a legacy snapshot without the fields restores with the gates off
 *  - a non-boolean `requireSettlementRef` / `requireRefundRef` field
 *    is rejected as `invalid snapshot: … must be a boolean, …`
 *  - `diffEscrowSnapshots` reports `settlementRefGateChanged` /
 *    `refundRefGateChanged` on a true off->on or on->off flip, and
 *    reports nothing when both sides are gate-off (absent field and
 *    explicit `false` are the same state)
 *  - a signed snapshot round-trips both gates, and flipping either
 *    gate inside a signed envelope fails the MAC check
 *  - the gates survive a JSON wire round-trip and stay on across
 *    further dispatches
 */

const SECRET = "snapshot-require-refs-test-secret";

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

/** Drive an escrow from CREATED to DISPUTED, always carrying an actor. */
function toDisputed(id: string, opts?: EscrowOptions): Escrow {
  const e = new Escrow(id, opts);
  e.dispatch("FUND", "deposit", 100, { actor: "sponsor" });
  e.dispatch("DISPUTE", "dispute opened", undefined, {
    actor: "creator",
  });
  return e;
}

test("toJSON() writes both gates true only when they are on", () => {
  const gated = toVerified("srr-1", {
    requireSettlementRef: true,
    requireRefundRef: true,
  }).toJSON();
  assert.equal(gated.requireSettlementRef, true);
  assert.equal(gated.requireRefundRef, true);
  const open = toVerified("srr-1b");
  assert.equal("requireSettlementRef" in open.toJSON(), false);
  assert.equal("requireRefundRef" in open.toJSON(), false);
  const explicitOff = toVerified("srr-1c", {
    requireSettlementRef: false,
    requireRefundRef: false,
  });
  assert.equal("requireSettlementRef" in explicitOff.toJSON(), false);
  assert.equal("requireRefundRef" in explicitOff.toJSON(), false);
});

test("toJSON() writes each gate independently", () => {
  const settlementOnly = toVerified("srr-1d", {
    requireSettlementRef: true,
  }).toJSON();
  assert.equal(settlementOnly.requireSettlementRef, true);
  assert.equal("requireRefundRef" in settlementOnly, false);
  const refundOnly = toDisputed("srr-1e", {
    requireRefundRef: true,
  }).toJSON();
  assert.equal(refundOnly.requireRefundRef, true);
  assert.equal("requireSettlementRef" in refundOnly, false);
});

test("fromJSON() round-trip retains the settlement gate", () => {
  const e = toVerified("srr-2", { requireSettlementRef: true });
  const restored = Escrow.fromJSON(JSON.parse(JSON.stringify(e.toJSON())));
  assert.throws(
    () => restored.dispatch("RELEASE"),
    /settlement reference required/,
  );
  restored.dispatch("RELEASE", undefined, undefined, {
    settlementRef: "0xabc123",
  });
  assert.equal(restored.state, "RELEASED");
  // The gate is still on in the re-exported snapshot.
  assert.equal(restored.toJSON().requireSettlementRef, true);
});

test("fromJSON() round-trip retains the refund gate", () => {
  const e = toDisputed("srr-3", { requireRefundRef: true });
  const restored = Escrow.fromJSON(JSON.parse(JSON.stringify(e.toJSON())));
  assert.throws(
    () => restored.dispatch("ARBITRATE_REFUND"),
    /refund reference required/,
  );
  restored.dispatch("ARBITRATE_REFUND", undefined, undefined, {
    refundRef: "rfnd-2026-0315",
  });
  assert.equal(restored.state, "REFUNDED");
  // The gate is still on in the re-exported snapshot.
  assert.equal(restored.toJSON().requireRefundRef, true);
});

test("fromJSON() opts override turns both gates off", () => {
  const e = toVerified("srr-4", {
    requireSettlementRef: true,
    requireRefundRef: true,
  });
  const restored = Escrow.fromJSON(JSON.parse(JSON.stringify(e.toJSON())), {
    requireSettlementRef: false,
    requireRefundRef: false,
  });
  restored.dispatch("RELEASE");
  assert.equal(restored.state, "RELEASED");
  assert.equal("requireSettlementRef" in restored.toJSON(), false);
  assert.equal("requireRefundRef" in restored.toJSON(), false);
});

test("fromJSON() opts override turns both gates on for a gate-off snapshot", () => {
  const restoredSettled = Escrow.fromJSON(
    JSON.parse(JSON.stringify(toVerified("srr-5a").toJSON())),
    { requireSettlementRef: true },
  );
  assert.throws(
    () => restoredSettled.dispatch("RELEASE"),
    /settlement reference required/,
  );
  restoredSettled.dispatch("RELEASE", undefined, undefined, {
    settlementRef: "0xabc123",
  });
  assert.equal(restoredSettled.state, "RELEASED");
  assert.equal(restoredSettled.toJSON().requireSettlementRef, true);
  const restoredRefunded = Escrow.fromJSON(
    JSON.parse(JSON.stringify(toDisputed("srr-5b").toJSON())),
    { requireRefundRef: true },
  );
  assert.throws(
    () => restoredRefunded.dispatch("ARBITRATE_REFUND"),
    /refund reference required/,
  );
  restoredRefunded.dispatch("ARBITRATE_REFUND", undefined, undefined, {
    refundRef: "rfnd-2026-0315",
  });
  assert.equal(restoredRefunded.state, "REFUNDED");
  assert.equal(restoredRefunded.toJSON().requireRefundRef, true);
});

test("legacy snapshot without the fields restores with the gates off", () => {
  const e = toVerified("srr-6", {
    requireSettlementRef: true,
    requireRefundRef: true,
  });
  const legacy = JSON.parse(JSON.stringify(e.toJSON()));
  delete legacy.requireSettlementRef;
  delete legacy.requireRefundRef;
  const restored = Escrow.fromJSON(legacy);
  restored.dispatch("RELEASE");
  assert.equal(restored.state, "RELEASED");
  const d = toDisputed("srr-6b", {
    requireSettlementRef: true,
    requireRefundRef: true,
  });
  const legacyDisputed = JSON.parse(JSON.stringify(d.toJSON()));
  delete legacyDisputed.requireSettlementRef;
  delete legacyDisputed.requireRefundRef;
  const restoredDisputed = Escrow.fromJSON(legacyDisputed);
  restoredDisputed.dispatch("ARBITRATE_REFUND");
  assert.equal(restoredDisputed.state, "REFUNDED");
});

test("non-boolean requireSettlementRef / requireRefundRef in a snapshot is rejected", () => {
  const base = toVerified("srr-7", {
    requireSettlementRef: true,
    requireRefundRef: true,
  }).toJSON();
  for (const bad of ["yes", 1, 0, null, {}, []]) {
    const settlementSnapshot = { ...base, requireSettlementRef: bad };
    assert.throws(
      () => Escrow.fromJSON(settlementSnapshot),
      /invalid snapshot: requireSettlementRef must be a boolean/,
    );
    const refundSnapshot = { ...base, requireRefundRef: bad };
    assert.throws(
      () => Escrow.fromJSON(refundSnapshot),
      /invalid snapshot: requireRefundRef must be a boolean/,
    );
  }
});

test("diffEscrowSnapshots reports settlementRefGateChanged off -> on and on -> off", () => {
  const gated = toVerified("srr-8", {
    requireSettlementRef: true,
  }).toJSON();
  const off = { ...gated };
  delete off.requireSettlementRef;
  assert.deepEqual(diffEscrowSnapshots(off, gated), {
    settlementRefGateChanged: { from: false, to: true },
  });
  assert.deepEqual(diffEscrowSnapshots(gated, off), {
    settlementRefGateChanged: { from: true, to: false },
  });
});

test("diffEscrowSnapshots reports refundRefGateChanged off -> on and on -> off", () => {
  const gated = toDisputed("srr-9", {
    requireRefundRef: true,
  }).toJSON();
  const off = { ...gated };
  delete off.requireRefundRef;
  assert.deepEqual(diffEscrowSnapshots(off, gated), {
    refundRefGateChanged: { from: false, to: true },
  });
  assert.deepEqual(diffEscrowSnapshots(gated, off), {
    refundRefGateChanged: { from: true, to: false },
  });
});

test("diffEscrowSnapshots: absent field and explicit false are the same gate-off state", () => {
  const gated = toVerified("srr-10", {
    requireSettlementRef: true,
    requireRefundRef: true,
  }).toJSON();
  const off = { ...gated };
  delete off.requireSettlementRef;
  delete off.requireRefundRef;
  const explicitOff = {
    ...off,
    requireSettlementRef: false,
    requireRefundRef: false,
  };
  assert.deepEqual(diffEscrowSnapshots(off, explicitOff), {});
  assert.deepEqual(diffEscrowSnapshots(explicitOff, off), {});
});

test("signed snapshot round-trip retains both gates", () => {
  const e = toVerified("srr-11", {
    requireSettlementRef: true,
    requireRefundRef: true,
  });
  const envelope = e.exportSignedSnapshot(SECRET);
  assert.equal(envelope.snapshot.requireSettlementRef, true);
  assert.equal(envelope.snapshot.requireRefundRef, true);
  const restored = Escrow.restoreSignedSnapshot(
    JSON.parse(JSON.stringify(envelope)),
    SECRET,
  );
  assert.throws(
    () => restored.dispatch("RELEASE"),
    /settlement reference required/,
  );
  restored.dispatch("RELEASE", undefined, undefined, {
    settlementRef: "0xabc123",
  });
  assert.equal(restored.state, "RELEASED");
  const d = toDisputed("srr-11b", {
    requireSettlementRef: true,
    requireRefundRef: true,
  });
  const disputedEnvelope = d.exportSignedSnapshot(SECRET);
  const restoredDisputed = Escrow.restoreSignedSnapshot(
    JSON.parse(JSON.stringify(disputedEnvelope)),
    SECRET,
  );
  assert.throws(
    () => restoredDisputed.dispatch("ARBITRATE_REFUND"),
    /refund reference required/,
  );
  restoredDisputed.dispatch("ARBITRATE_REFUND", undefined, undefined, {
    refundRef: "rfnd-2026-0315",
  });
  assert.equal(restoredDisputed.state, "REFUNDED");
});

test("flipping either gate inside a signed envelope fails the MAC check", () => {
  const e = toVerified("srr-12", {
    requireSettlementRef: true,
    requireRefundRef: true,
  });
  const envelope = e.exportSignedSnapshot(SECRET);
  const tamperedSettlement = JSON.parse(JSON.stringify(envelope));
  delete tamperedSettlement.snapshot.requireSettlementRef;
  assert.throws(
    () => Escrow.restoreSignedSnapshot(tamperedSettlement, SECRET),
    /signed snapshot MAC mismatch/,
  );
  const tamperedRefund = JSON.parse(JSON.stringify(envelope));
  delete tamperedRefund.snapshot.requireRefundRef;
  assert.throws(
    () => Escrow.restoreSignedSnapshot(tamperedRefund, SECRET),
    /signed snapshot MAC mismatch/,
  );
});

test("gates survive a JSON wire round-trip and stay on across further dispatches", () => {
  const e = toVerified("srr-13", {
    requireSettlementRef: true,
    requireRefundRef: true,
  });
  const wire = JSON.stringify(e.toJSON());
  const restored = Escrow.fromJSON(JSON.parse(wire));
  restored.dispatch("RELEASE", undefined, undefined, {
    settlementRef: "0xabc123",
  });
  assert.equal(restored.state, "RELEASED");
  assert.equal(restored.toJSON().requireSettlementRef, true);
  assert.equal(restored.toJSON().requireRefundRef, true);
  assert.equal(
    JSON.parse(JSON.stringify(restored.toJSON())).requireSettlementRef,
    true,
  );
  assert.equal(
    JSON.parse(JSON.stringify(restored.toJSON())).requireRefundRef,
    true,
  );
});
