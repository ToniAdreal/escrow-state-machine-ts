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

describe("dispatchArbitration shape guards", () => {
  it("rejects a null escrow with a named error", () => {
    const quorum = quorumWith(5);
    assert.throws(
      () => dispatchArbitration(null as unknown as Escrow, quorum, "release"),
      /invalid dispatchArbitration: escrow must be an Escrow, got null/
    );
  });

  it("rejects an undefined escrow with a named error", () => {
    const quorum = quorumWith(5);
    assert.throws(
      () => dispatchArbitration(undefined as unknown as Escrow, quorum, "release"),
      /invalid dispatchArbitration: escrow must be an Escrow, got undefined/
    );
  });

  it("rejects a non-Escrow escrow with a named error", () => {
    const quorum = quorumWith(5);
    assert.throws(
      () => dispatchArbitration("x" as unknown as Escrow, quorum, "release"),
      /invalid dispatchArbitration: escrow must be an Escrow, got string/
    );
    // A plain object with an id is not an Escrow either — the guard is
    // instanceof, not a shape check (only a real Escrow carries the
    // dispatch/history machinery this function relies on).
    assert.throws(
      () =>
        dispatchArbitration(
          { id: "esc-1" } as unknown as Escrow,
          quorum,
          "release"
        ),
      /invalid dispatchArbitration: escrow must be an Escrow, got object/
    );
  });

  it("rejects a null quorum with a named error and leaves the escrow untouched", () => {
    const escrow = disputedEscrow();
    const historyBefore = escrow.history.length;
    assert.throws(
      () =>
        dispatchArbitration(
          escrow,
          null as unknown as ReturnType<typeof createQuorum>,
          "release"
        ),
      /invalid dispatchArbitration: quorum must be a Quorum, got null/
    );
    assert.equal(escrow.state, "DISPUTED");
    assert.equal(escrow.history.length, historyBefore);
  });

  it("rejects an undefined quorum with a named error", () => {
    const escrow = disputedEscrow();
    assert.throws(
      () =>
        dispatchArbitration(
          escrow,
          undefined as unknown as ReturnType<typeof createQuorum>,
          "release"
        ),
      /invalid dispatchArbitration: quorum must be a Quorum, got undefined/
    );
    assert.equal(escrow.state, "DISPUTED");
  });

  it("rejects a non-object quorum with a named error", () => {
    const escrow = disputedEscrow();
    assert.throws(
      () =>
        dispatchArbitration(
          escrow,
          "x" as unknown as ReturnType<typeof createQuorum>,
          "release"
        ),
      /invalid dispatchArbitration: quorum must be a Quorum, got string/
    );
    assert.equal(escrow.state, "DISPUTED");
  });

  it("rejects a quorum missing hasQuorum with a named error", () => {
    const escrow = disputedEscrow();
    assert.throws(
      () =>
        dispatchArbitration(
          escrow,
          {} as unknown as ReturnType<typeof createQuorum>,
          "release"
        ),
      /invalid dispatchArbitration: quorum must be a Quorum, got object/
    );
    assert.equal(escrow.state, "DISPUTED");
  });

  it("rejects a partial quorum missing approvalCount/approvals before the gate", () => {
    // Only hasQuorum is present: the guard reads the same three
    // methods this function itself calls, so a half-shaped quorum must
    // fail here — not crash as `approvalCount is not a function`
    // inside the below-threshold error branch.
    const escrow = disputedEscrow();
    const partial = {
      hasQuorum: () => false,
    } as unknown as ReturnType<typeof createQuorum>;
    assert.throws(
      () => dispatchArbitration(escrow, partial, "release"),
      /invalid dispatchArbitration: quorum must be a Quorum, got object/
    );
    assert.equal(escrow.state, "DISPUTED");
  });

  it("reports the outcome error before the shape guard", () => {
    // Guard ordering: outcome validation runs first, so a bad outcome
    // still names itself even when both inputs are null.
    assert.throws(
      () =>
        dispatchArbitration(
          null as unknown as Escrow,
          null as unknown as ReturnType<typeof createQuorum>,
          "explode" as "release"
        ),
      /invalid arbitration outcome/
    );
  });

  it("reports the escrow error before the quorum gate", () => {
    // A null escrow plus a below-threshold quorum must name the escrow,
    // not the quorum shortfall — the shape guard precedes the gate.
    const quorum = quorumWith(4); // 4/9: below threshold
    assert.throws(
      () => dispatchArbitration(null as unknown as Escrow, quorum, "release"),
      /invalid dispatchArbitration: escrow must be an Escrow/
    );
  });

  it("reports the quorum shortfall for a well-formed pair (guard does not mask it)", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(4); // 4/9: below threshold
    assert.throws(
      () => dispatchArbitration(escrow, quorum, "release"),
      /arbitration requires quorum: 4\/5 approvals/
    );
    assert.equal(escrow.state, "DISPUTED");
  });

  it("still dispatches release/refund on the legal path", () => {
    const releaseEscrow = disputedEscrow();
    const releaseState = dispatchArbitration(
      releaseEscrow,
      quorumWith(5),
      "release"
    );
    assert.equal(releaseState, "RELEASED");
    assert.equal(
      releaseEscrow.history[releaseEscrow.history.length - 1].event,
      "ARBITRATE_RELEASE"
    );

    const refundEscrow = disputedEscrow();
    const refundState = dispatchArbitration(
      refundEscrow,
      quorumWith(5),
      "refund"
    );
    assert.equal(refundState, "REFUNDED");
    assert.equal(
      refundEscrow.history[refundEscrow.history.length - 1].event,
      "ARBITRATE_REFUND"
    );
  });
});
