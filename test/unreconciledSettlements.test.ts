import test from "node:test";
import assert from "node:assert/strict";
import {
  createQuorum,
  dispatchArbitration,
  Escrow,
  unreconciledSettlements,
  type EscrowOptions,
} from "../src/index.js";

/**
 * `unreconciledSettlements` (backlog #1116): the dataquest
 * lifecycle's `unreconciledPayouts` counterpart for this escrow — a
 * one-liner listing the RELEASED escrows whose settlement has no
 * external payment evidence (no `settlementRef` on the RELEASE
 * entry), so finance ops can chase them instead of hand-scanning
 * histories.
 *
 * Rules under test:
 *  - a RELEASED escrow whose RELEASE entry carries no settlementRef
 *    is returned; one carrying a ref is not
 *  - a RELEASED escrow with no RELEASE entry at all is returned too
 *    — reachable through arbitration: `ARBITRATE_RELEASE` carries
 *    no ref by construction, so an arbitration-released escrow is
 *    unreconciled by the same rule
 *  - REFUNDED / EXPIRED / in-progress escrows never appear, whatever
 *    their histories carry
 *  - an empty batch returns an empty array
 *  - pure: state and history are untouched, and the returned array
 *    holds the same escrow objects, in input order
 *  - one ref may settle several escrows: all of them are excluded
 *  - with the opt-in `requireSettlementRef` gate on, a ref-less
 *    RELEASE cannot happen at all, so the selection is empty — the
 *    gate and the screen agree by construction
 */

const AT = [
  "2026-03-01T00:00:00.000Z",
  "2026-03-01T01:00:00.000Z",
  "2026-03-01T02:00:00.000Z",
  "2026-03-01T03:00:00.000Z",
];

const SIGNERS = [
  "dao-1",
  "dao-2",
  "dao-3",
  "dao-4",
  "dao-5",
  "dao-6",
  "dao-7",
  "dao-8",
  "dao-9",
];

/** Full lifecycle CREATED -> FUNDED -> ... -> RELEASED, pinned timestamps. */
function releasedEscrow(
  id: string,
  settlementRef?: string,
  opts?: EscrowOptions,
): Escrow {
  const e = new Escrow(id, opts);
  e.dispatch("FUND", undefined, 1000, { at: AT[0] });
  e.dispatch("SUBMIT_MILESTONE", undefined, undefined, { at: AT[1] });
  e.dispatch("VERIFY_PASS", undefined, undefined, { at: AT[2] });
  e.dispatch("RELEASE", undefined, undefined, {
    at: AT[3],
    ...(settlementRef !== undefined ? { settlementRef } : {}),
  });
  return e;
}

/** An escrow driven to VERIFIED (one RELEASE away). */
function verifiedEscrow(id: string): Escrow {
  const e = new Escrow(id);
  e.dispatch("FUND", undefined, 1000, { at: AT[0] });
  e.dispatch("SUBMIT_MILESTONE", undefined, undefined, { at: AT[1] });
  e.dispatch("VERIFY_PASS", undefined, undefined, { at: AT[2] });
  return e;
}

/** An escrow sitting in DISPUTED: CREATED -> FUNDED -> DISPUTED. */
function disputedEscrow(id: string): Escrow {
  const e = new Escrow(id);
  e.dispatch("FUND", undefined, 1000, { at: AT[0] });
  e.dispatch("DISPUTE", undefined, undefined, { at: AT[1] });
  assert.equal(e.state, "DISPUTED");
  return e;
}

/** Quorum with the first `n` signers approved (5/9 rule). */
function quorumWith(n: number) {
  const quorum = createQuorum({ threshold: 5, signers: SIGNERS });
  for (let i = 0; i < n; i++) quorum.approve(SIGNERS[i]);
  return quorum;
}

/** DISPUTED escrow released by arbitration (no RELEASE entry). */
function arbitrationReleasedEscrow(id: string): Escrow {
  const e = disputedEscrow(id);
  dispatchArbitration(e, quorumWith(5), "release");
  assert.equal(e.state, "RELEASED");
  return e;
}

/** DISPUTED escrow refunded by arbitration. */
function arbitrationRefundedEscrow(id: string): Escrow {
  const e = disputedEscrow(id);
  dispatchArbitration(e, quorumWith(5), "refund");
  assert.equal(e.state, "REFUNDED");
  return e;
}

/** FUNDED escrow expired by dispatch. */
function expiredEscrow(id: string): Escrow {
  const e = new Escrow(id);
  e.dispatch("FUND", undefined, 1000, { at: AT[0] });
  e.dispatch("EXPIRE", undefined, undefined, { at: AT[1] });
  assert.equal(e.state, "EXPIRED");
  return e;
}

test("RELEASED without a settlementRef is unreconciled", () => {
  const e = releasedEscrow("unrec-1");
  assert.equal(e.state, "RELEASED");
  assert.equal("settlementRef" in e.history[3], false);
  assert.deepEqual(unreconciledSettlements([e]), [e]);
});

test("RELEASED with a settlementRef is reconciled", () => {
  const e = releasedEscrow("unrec-2", "0xabc123");
  assert.equal(e.history[3].settlementRef, "0xabc123");
  assert.deepEqual(unreconciledSettlements([e]), []);
});

test("arbitration-released escrow (no RELEASE entry) is unreconciled", () => {
  const e = arbitrationReleasedEscrow("unrec-3");
  assert.equal(e.state, "RELEASED");
  assert.equal(
    e.history.some((entry) => entry.event === "RELEASE"),
    false,
  );
  assert.equal(e.history[e.history.length - 1].event, "ARBITRATE_RELEASE");
  assert.deepEqual(unreconciledSettlements([e]), [e]);
});

test("REFUNDED escrow never appears", () => {
  const e = arbitrationRefundedEscrow("unrec-4");
  assert.equal(e.state, "REFUNDED");
  assert.deepEqual(unreconciledSettlements([e]), []);
});

test("EXPIRED escrow never appears", () => {
  const e = expiredEscrow("unrec-5");
  assert.equal(e.state, "EXPIRED");
  assert.deepEqual(unreconciledSettlements([e]), []);
});

test("in-progress escrows never appear", () => {
  const created = new Escrow("unrec-6a");
  const funded = new Escrow("unrec-6b");
  funded.dispatch("FUND", undefined, 1000, { at: AT[0] });
  const verified = verifiedEscrow("unrec-6c");
  const disputed = disputedEscrow("unrec-6d");
  assert.deepEqual(
    unreconciledSettlements([created, funded, verified, disputed]),
    [],
  );
});

test("empty batch returns an empty array", () => {
  assert.deepEqual(unreconciledSettlements([]), []);
});

test("pure: state and history untouched, same objects in input order", () => {
  const withRef = releasedEscrow("unrec-8a", "0xabc123");
  const withoutRef = releasedEscrow("unrec-8b");
  const arbitrated = arbitrationReleasedEscrow("unrec-8c");
  const inProgress = verifiedEscrow("unrec-8d");
  const batch = [withRef, withoutRef, arbitrated, inProgress];
  const before = batch.map((e) => JSON.stringify(e.toJSON()));
  const result = unreconciledSettlements(batch);
  assert.equal(result.length, 2);
  assert.equal(result[0], withoutRef);
  assert.equal(result[1], arbitrated);
  assert.deepEqual(
    batch.map((e) => JSON.stringify(e.toJSON())),
    before,
  );
});

test("one ref may settle several escrows: all of them are excluded", () => {
  const a = releasedEscrow("unrec-9a", "batch-7");
  const b = releasedEscrow("unrec-9b", "batch-7");
  assert.deepEqual(unreconciledSettlements([a, b]), []);
});

test("requireSettlementRef on: a ref-less RELEASE cannot happen, selection is empty", () => {
  const opts: EscrowOptions = { requireSettlementRef: true };
  // A ref-less RELEASE is refused at dispatch time and leaves the
  // escrow VERIFIED (not RELEASED), so it cannot enter the screen.
  const gated = new Escrow("unrec-10a", opts);
  gated.dispatch("FUND", undefined, 1000, { at: AT[0] });
  gated.dispatch("SUBMIT_MILESTONE", undefined, undefined, { at: AT[1] });
  gated.dispatch("VERIFY_PASS", undefined, undefined, { at: AT[2] });
  assert.throws(
    () => gated.dispatch("RELEASE", undefined, undefined, { at: AT[3] }),
    /settlement reference required/,
  );
  assert.equal(gated.state, "VERIFIED");
  // With a ref the same gate lets the release through, and the
  // released escrow is reconciled.
  const settled = releasedEscrow("unrec-10b", "0xabc123", opts);
  assert.equal(settled.state, "RELEASED");
  assert.deepEqual(unreconciledSettlements([gated, settled]), []);
});

test("mixed batch selects only the unreconciled, in input order", () => {
  const settled = releasedEscrow("unrec-11a", "0xabc123");
  const missing = releasedEscrow("unrec-11b");
  const inProgress = verifiedEscrow("unrec-11c");
  const arbitrated = arbitrationReleasedEscrow("unrec-11d");
  const refunded = arbitrationRefundedEscrow("unrec-11e");
  const expired = expiredEscrow("unrec-11f");
  const result = unreconciledSettlements([
    settled,
    missing,
    inProgress,
    arbitrated,
    refunded,
    expired,
  ]);
  assert.deepEqual(
    result.map((e) => e.id),
    ["unrec-11b", "unrec-11d"],
  );
  assert.equal(result[0], missing);
  assert.equal(result[1], arbitrated);
});
