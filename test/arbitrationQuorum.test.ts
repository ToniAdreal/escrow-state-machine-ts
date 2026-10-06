import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  createQuorum,
  dispatchArbitration,
} from "../src/index.js";

const SIGNERS = [
  "dao-1", "dao-2", "dao-3", "dao-4", "dao-5",
  "dao-6", "dao-7", "dao-8", "dao-9",
];

/** Escrow sitting in DISPUTED: CREATED → FUNDED → DISPUTED. */
function disputedEscrow(): Escrow {
  const escrow = new Escrow("esc-1");
  escrow.dispatch("FUND", undefined, 10630);
  escrow.dispatch("DISPUTE");
  assert.equal(escrow.state, "DISPUTED");
  return escrow;
}

/** Quorum with the first `n` signers approved (5/9 rule). */
function quorumWith(n: number) {
  const quorum = createQuorum({ threshold: 5, signers: SIGNERS });
  for (let i = 0; i < n; i++) quorum.approve(SIGNERS[i]);
  return quorum;
}

describe("dispatchArbitration", () => {
  it("throws without quorum and leaves state/history untouched", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(4); // 4/9: below threshold
    const historyBefore = escrow.history.length;

    assert.throws(
      () => dispatchArbitration(escrow, quorum, "release"),
      /arbitration requires quorum: 4\/5 approvals/
    );

    assert.equal(escrow.state, "DISPUTED");
    assert.equal(escrow.history.length, historyBefore);
    assert.equal(
      escrow.history[escrow.history.length - 1].event,
      "DISPUTE"
    );
  });

  it("dispatches ARBITRATE_RELEASE once quorum is reached", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(5);

    const state = dispatchArbitration(escrow, quorum, "release");
    assert.equal(state, "RELEASED");
    assert.equal(escrow.state, "RELEASED");

    const last = escrow.history[escrow.history.length - 1];
    assert.equal(last.event, "ARBITRATE_RELEASE");
    assert.equal(last.from, "DISPUTED");
    assert.equal(last.to, "RELEASED");
    assert.equal(last.note, "quorum 5/5");
  });

  it("dispatches ARBITRATE_REFUND once quorum is reached", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(6);

    const state = dispatchArbitration(escrow, quorum, "refund");
    assert.equal(state, "REFUNDED");

    const last = escrow.history[escrow.history.length - 1];
    assert.equal(last.event, "ARBITRATE_REFUND");
    assert.equal(last.note, "quorum 6/5");
  });

  it("appends the caller note in front of the quorum tally", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(5);

    dispatchArbitration(escrow, quorum, "release", "DAO vote passed");
    const last = escrow.history[escrow.history.length - 1];
    assert.equal(last.note, "DAO vote passed [quorum 5/5]");
  });

  it("still enforces transitions from non-DISPUTED states", () => {
    // Quorum is reached, but the escrow is FUNDED (never disputed).
    const escrow = new Escrow("esc-2");
    escrow.dispatch("FUND", undefined, 10630);
    const quorum = quorumWith(9);

    assert.throws(
      () => dispatchArbitration(escrow, quorum, "release"),
      /invalid transition: ARBITRATE_RELEASE from FUNDED/
    );
    assert.equal(escrow.state, "FUNDED");
  });

  it("rejects an invalid outcome before touching anything", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(5);
    const historyBefore = escrow.history.length;

    assert.throws(
      () => dispatchArbitration(escrow, quorum, "explode" as "release"),
      /invalid arbitration outcome/
    );

    assert.equal(escrow.state, "DISPUTED");
    assert.equal(escrow.history.length, historyBefore);
  });

  it("rejects after approvals are revoked below the threshold", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(5);
    quorum.revoke("dao-5"); // back to 4/9
    assert.equal(quorum.hasQuorum(), false);

    assert.throws(
      () => dispatchArbitration(escrow, quorum, "refund"),
      /arbitration requires quorum: 4\/5 approvals/
    );
    assert.equal(escrow.state, "DISPUTED");
  });

  it("respects the terminal lock: arbitration on an already-released escrow fails", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(5);
    dispatchArbitration(escrow, quorum, "release");
    assert.equal(escrow.state, "RELEASED");

    assert.throws(
      () => dispatchArbitration(escrow, quorum, "refund"),
      /invalid transition: ARBITRATE_REFUND from RELEASED/
    );
  });
});
