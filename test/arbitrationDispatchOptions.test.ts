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

/** Escrow sitting in DISPUTED: CREATED → FUNDED → DISPUTED (seq 2). */
function disputedEscrow(): Escrow {
  const escrow = new Escrow("esc-1");
  escrow.dispatch("FUND", undefined, 10630);
  escrow.dispatch("DISPUTE");
  assert.equal(escrow.state, "DISPUTED");
  assert.equal(escrow.history.length, 2);
  return escrow;
}

/** Quorum with the first `n` signers approved (5/9 rule). */
function quorumWith(n: number) {
  const quorum = createQuorum({ threshold: 5, signers: SIGNERS });
  for (let i = 0; i < n; i++) quorum.approve(SIGNERS[i]);
  return quorum;
}

describe("dispatchArbitration retry-safety opts (idempotencyKey / expectedSeq)", () => {
  it("second dispatch with the same idempotencyKey is a pure no-op", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(5);
    const opts = { idempotencyKey: "arb-1" } as const;

    const first = dispatchArbitration(escrow, quorum, "release", undefined, opts);
    assert.equal(first, "RELEASED");
    const historyLength = escrow.history.length;
    const lastBefore = escrow.history[historyLength - 1];

    // The scenario from the gap report: a timed-out caller retries the
    // terminal arbitration call; the retry must not throw
    // "invalid transition: ARBITRATE_RELEASE from RELEASED".
    const second = dispatchArbitration(escrow, quorum, "release", undefined, opts);
    assert.equal(second, "RELEASED");
    assert.equal(escrow.history.length, historyLength);
    assert.deepEqual(escrow.history[escrow.history.length - 1], lastBefore);
    assert.equal(escrow.history[escrow.history.length - 1].event, "ARBITRATE_RELEASE");
  });

  it("quorum-gated rejection does not consume the idempotencyKey", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(4); // 4/9: below threshold
    const opts = { idempotencyKey: "arb-retry" } as const;

    assert.throws(
      () => dispatchArbitration(escrow, quorum, "release", undefined, opts),
      /arbitration requires quorum: 4\/5 approvals/
    );
    assert.equal(escrow.state, "DISPUTED");
    assert.equal(escrow.history.length, 2);

    // Caller gathers the missing approval, retries with the SAME key —
    // the key was never "used up", so the retry executes.
    quorum.approve(SIGNERS[4]);
    const state = dispatchArbitration(escrow, quorum, "release", undefined, opts);
    assert.equal(state, "RELEASED");
    assert.equal(escrow.history.length, 3);
    assert.equal(escrow.history[2].event, "ARBITRATE_RELEASE");
  });

  it("refund outcome also no-ops on a repeated idempotencyKey", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(6);
    const opts = { idempotencyKey: "arb-refund-1" } as const;

    dispatchArbitration(escrow, quorum, "refund", undefined, opts);
    const historyLength = escrow.history.length;
    const state = dispatchArbitration(escrow, quorum, "refund", undefined, opts);
    assert.equal(state, "REFUNDED");
    assert.equal(escrow.history.length, historyLength);
  });

  it("expectedSeq pinned to the read seq succeeds", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(5);

    const state = dispatchArbitration(escrow, quorum, "release", undefined, {
      expectedSeq: 2,
    });
    assert.equal(state, "RELEASED");
    assert.equal(escrow.history.length, 3);
  });

  it("expectedSeq mismatch throws dispatch conflict and leaves no trace", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(5);
    const historyBefore = escrow.history.length;

    assert.throws(
      () =>
        dispatchArbitration(escrow, quorum, "release", undefined, {
          expectedSeq: 99,
        }),
      /dispatch conflict: expected seq 99 but escrow is at seq 2/
    );

    assert.equal(escrow.state, "DISPUTED");
    assert.equal(escrow.history.length, historyBefore);
  });

  it("guarded retry: idempotencyKey + updated expectedSeq no-ops", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(5);

    dispatchArbitration(escrow, quorum, "release", undefined, {
      idempotencyKey: "arb-guarded",
      expectedSeq: 2,
    });
    assert.equal(escrow.history.length, 3);

    // Retry re-reads the seq (now 3): expectedSeq passes, dedupe no-ops.
    const state = dispatchArbitration(escrow, quorum, "release", undefined, {
      idempotencyKey: "arb-guarded",
      expectedSeq: 3,
    });
    assert.equal(state, "RELEASED");
    assert.equal(escrow.history.length, 3);
  });

  it("stale expectedSeq is a loud conflict, not a silent no-op", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(5);

    dispatchArbitration(escrow, quorum, "release", undefined, {
      idempotencyKey: "arb-stale",
      expectedSeq: 2,
    });
    const historyLength = escrow.history.length;

    // Caller retries with the seq it originally read (2), not the
    // current one (3): the expectedSeq guard runs before the dedupe,
    // so this is a conflict, not a no-op.
    assert.throws(
      () =>
        dispatchArbitration(escrow, quorum, "release", undefined, {
          idempotencyKey: "arb-stale",
          expectedSeq: 2,
        }),
      /dispatch conflict: expected seq 2 but escrow is at seq 3/
    );
    assert.equal(escrow.history.length, historyLength);
  });

  it("invalid expectedSeq shapes throw invalid dispatch options", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(5);

    for (const expectedSeq of [-1, 1.5, NaN, "2" as unknown as number]) {
      assert.throws(
        () =>
          dispatchArbitration(escrow, quorum, "release", undefined, {
            expectedSeq,
          }),
        /invalid dispatch options: expectedSeq must be a non-negative integer/
      );
    }
    assert.equal(escrow.history.length, 2);
  });

  it("invalid idempotencyKey shapes throw invalid dispatch options", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(5);

    for (const idempotencyKey of ["", 42 as unknown as string, null as unknown as string]) {
      assert.throws(
        () =>
          dispatchArbitration(escrow, quorum, "release", undefined, {
            idempotencyKey,
          }),
        /invalid dispatch options: idempotencyKey must be a non-empty string/
      );
    }
    assert.equal(escrow.history.length, 2);
  });

  it("quorum gate runs before option validation", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(4); // below threshold, with an invalid key

    assert.throws(
      () =>
        dispatchArbitration(escrow, quorum, "release", undefined, {
          idempotencyKey: "",
        }),
      /arbitration requires quorum: 4\/5 approvals/
    );
    assert.equal(escrow.history.length, 2);
  });

  it("forwards at + actor alongside the new fields (regression)", () => {
    const escrow = new Escrow("esc-opts");
    escrow.dispatch("FUND", undefined, 10630, { at: "2026-03-01T09:00:00.000Z" });
    escrow.dispatch("DISPUTE", undefined, undefined, { at: "2026-03-02T09:00:00.000Z" });
    const quorum = quorumWith(5);

    const state = dispatchArbitration(escrow, quorum, "refund", undefined, {
      actor: "dao-1",
      at: "2026-03-07T13:30:00.000Z",
      idempotencyKey: "arb-opts",
      expectedSeq: 2,
    });
    assert.equal(state, "REFUNDED");

    const last = escrow.history[escrow.history.length - 1];
    assert.equal(last.event, "ARBITRATE_REFUND");
    assert.equal(last.actor, "dao-1");
    assert.equal(last.at, "2026-03-07T13:30:00.000Z");
    assert.equal(last.note, "quorum 5/5");
  });

  it("opts omitted keeps the exact historical behavior", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(5);

    const state = dispatchArbitration(escrow, quorum, "release");
    assert.equal(state, "RELEASED");
    const last = escrow.history[escrow.history.length - 1];
    assert.equal(last.event, "ARBITRATE_RELEASE");
    assert.equal(last.note, "quorum 5/5");
    assert.equal(last.actor, undefined);
  });
});
