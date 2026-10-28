import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  createQuorum,
  dispatchArbitration,
} from "../src/index.js";

/**
 * Arbitration dispatch × quorum approval expiry (backlog #668).
 *
 * The gap this closes: `maxApprovalAgeMs` (backlog #162) is covered in
 * `quorumExpiry` tests, and the arbitration gate is covered in
 * `arbitrationQuorum` tests, but the *interaction* was untested — when
 * collected approvals age out of the window, does the arbitration
 * dispatch actually refuse, and does re-approval restore it? The
 * `dispatchArbitration` gate reads `quorum.hasQuorum()` /
 * `approvalCount()` live, so expiry should flow straight through to
 * the `arbitration requires quorum: <counted>/<threshold> approvals`
 * rejection — these tests pin that behavior instead of assuming it.
 */

const SIGNERS = [
  "dao-1", "dao-2", "dao-3", "dao-4", "dao-5",
  "dao-6", "dao-7", "dao-8", "dao-9",
];
const WINDOW = 60_000;

function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** Escrow sitting in DISPUTED: CREATED → FUNDED → DISPUTED. */
function disputedEscrow(): Escrow {
  const escrow = new Escrow("esc-1");
  escrow.dispatch("FUND", undefined, 10630);
  escrow.dispatch("DISPUTE");
  assert.equal(escrow.state, "DISPUTED");
  return escrow;
}

/** 5/9 quorum with an expiry window on the injected clock. */
function expiringQuorum(clock: { now: () => number }) {
  return createQuorum({
    threshold: 5,
    signers: SIGNERS,
    now: clock.now,
    maxApprovalAgeMs: WINDOW,
  });
}

describe("dispatchArbitration with expiring quorum approvals", () => {
  it("refuses arbitration once every approval has expired, leaving state/history untouched", () => {
    const clock = fakeClock();
    const escrow = disputedEscrow();
    const quorum = expiringQuorum(clock);
    for (let i = 0; i < 5; i++) quorum.approve(SIGNERS[i]);
    assert.equal(quorum.hasQuorum(), true);

    clock.advance(WINDOW + 1); // every approval is now WINDOW + 1 old
    assert.equal(quorum.hasQuorum(), false);
    assert.equal(quorum.approvalCount(), 0);

    const historyBefore = escrow.history.length;
    assert.throws(
      () => dispatchArbitration(escrow, quorum, "release"),
      /arbitration requires quorum: 0\/5 approvals/
    );
    assert.equal(escrow.state, "DISPUTED");
    assert.equal(escrow.history.length, historyBefore);
    assert.equal(
      escrow.history[escrow.history.length - 1].event,
      "DISPUTE"
    );
  });

  it("refuses arbitration when staggered expiry drops the count below threshold", () => {
    const clock = fakeClock();
    const escrow = disputedEscrow();
    const quorum = expiringQuorum(clock);
    quorum.approve("dao-1");
    clock.advance(30_000);
    for (let i = 1; i < 5; i++) quorum.approve(SIGNERS[i]);
    assert.equal(quorum.hasQuorum(), true);

    clock.advance(30_001); // dao-1 is 60_001 old; the rest are 30_001
    assert.equal(quorum.approvalCount(), 4);
    assert.deepEqual(quorum.approvals(), [
      "dao-2", "dao-3", "dao-4", "dao-5",
    ]);

    const historyBefore = escrow.history.length;
    assert.throws(
      () => dispatchArbitration(escrow, quorum, "refund"),
      /arbitration requires quorum: 4\/5 approvals/
    );
    assert.equal(escrow.state, "DISPUTED");
    assert.equal(escrow.history.length, historyBefore);
  });

  it("allows arbitration again after the expired signer re-approves", () => {
    const clock = fakeClock();
    const escrow = disputedEscrow();
    const quorum = expiringQuorum(clock);
    for (let i = 0; i < 5; i++) quorum.approve(SIGNERS[i]);
    clock.advance(WINDOW + 1);
    assert.throws(
      () => dispatchArbitration(escrow, quorum, "release"),
      /arbitration requires quorum: 0\/5 approvals/
    );

    quorum.approve("dao-1"); // fresh approval, still inside the window
    clock.advance(1_000);
    for (let i = 1; i < 5; i++) quorum.approve(SIGNERS[i]);
    assert.equal(quorum.hasQuorum(), true);

    const state = dispatchArbitration(escrow, quorum, "release");
    assert.equal(state, "RELEASED");
    const last = escrow.history[escrow.history.length - 1];
    assert.equal(last.event, "ARBITRATE_RELEASE");
    assert.equal(last.note, "quorum 5/5");
  });

  it("still allows arbitration at the inclusive expiry boundary", () => {
    const clock = fakeClock();
    const escrow = disputedEscrow();
    const quorum = expiringQuorum(clock);
    for (let i = 0; i < 5; i++) quorum.approve(SIGNERS[i]);
    clock.advance(WINDOW); // age exactly maxApprovalAgeMs still counts
    assert.equal(quorum.hasQuorum(), true);

    const state = dispatchArbitration(escrow, quorum, "refund");
    assert.equal(state, "REFUNDED");
    assert.equal(
      escrow.history[escrow.history.length - 1].event,
      "ARBITRATE_REFUND"
    );
  });

  it("does not consume an idempotency key on an expiry-gated rejection", () => {
    const clock = fakeClock();
    const escrow = disputedEscrow();
    const quorum = expiringQuorum(clock);
    for (let i = 0; i < 5; i++) quorum.approve(SIGNERS[i]);
    clock.advance(WINDOW + 1);

    // The quorum gate runs before the escrow is ever touched, so the
    // key must survive for the retry after re-approval.
    assert.throws(
      () =>
        dispatchArbitration(escrow, quorum, "release", undefined, {
          idempotencyKey: "arb-1",
        }),
      /arbitration requires quorum: 0\/5 approvals/
    );

    for (let i = 0; i < 5; i++) quorum.approve(SIGNERS[i]);
    const state = dispatchArbitration(escrow, quorum, "release", undefined, {
      idempotencyKey: "arb-1",
    });
    assert.equal(state, "RELEASED");
    const arbitrationEntries = escrow.history.filter(
      (e) => e.event === "ARBITRATE_RELEASE"
    );
    assert.equal(arbitrationEntries.length, 1);
  });

  it("windowless quorum control: advancing the clock changes nothing", () => {
    const clock = fakeClock();
    const escrow = disputedEscrow();
    const quorum = createQuorum({
      threshold: 5,
      signers: SIGNERS,
      now: clock.now,
    });
    for (let i = 0; i < 5; i++) quorum.approve(SIGNERS[i]);
    clock.advance(10 * WINDOW); // far past any window — none configured
    assert.equal(quorum.hasQuorum(), true);

    const state = dispatchArbitration(escrow, quorum, "refund");
    assert.equal(state, "REFUNDED");
  });
});
