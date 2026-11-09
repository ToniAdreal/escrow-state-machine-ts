import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  createQuorum,
  dispatchArbitration,
  verifyHistoryChain,
} from "../src/index.js";

/**
 * Arbitration audit note carries the counted approvers (backlog #994).
 *
 * The gap this closes: `dispatchArbitration` recorded only the tally
 * (`quorum 5/5`) in the audit note, while the signer list lived only
 * in the caller's `Quorum` object (`approvalLog()`). Once that object
 * was dropped, the append-only history alone could not prove *who*
 * approved — the arbitration audit chain broke at its most important
 * link. The note now reads `quorum <counted>/<threshold> [signer, …]`,
 * with the list taken from `quorum.approvals()`: counted approvals
 * only, deduplicated, in approval-time order, expired approvals
 * excluded.
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

/** Quorum with `ids` approved, in the given order. */
function quorumWith(ids: string[], threshold = 5) {
  const quorum = createQuorum({ threshold, signers: SIGNERS });
  for (const id of ids) quorum.approve(id);
  return quorum;
}

function lastNote(escrow: Escrow): string | undefined {
  return escrow.history[escrow.history.length - 1].note;
}

describe("dispatchArbitration signer list in the audit note", () => {
  it("lists the counted signers in approval-time order", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(["dao-3", "dao-1", "dao-5", "dao-2", "dao-4"]);

    dispatchArbitration(escrow, quorum, "release");
    assert.equal(
      lastNote(escrow),
      "quorum 5/5 [dao-3, dao-1, dao-5, dao-2, dao-4]"
    );
  });

  it("lists every counted signer past the threshold", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith([
      "dao-1", "dao-2", "dao-3", "dao-4", "dao-5", "dao-6",
    ]);

    dispatchArbitration(escrow, quorum, "refund");
    assert.equal(
      lastNote(escrow),
      "quorum 6/5 [dao-1, dao-2, dao-3, dao-4, dao-5, dao-6]"
    );
  });

  it("lists a signer once even when it approved twice", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(["dao-1", "dao-2", "dao-3", "dao-4", "dao-5"]);
    quorum.approve("dao-1"); // still counts: no-op, no second entry

    dispatchArbitration(escrow, quorum, "release");
    assert.equal(
      lastNote(escrow),
      "quorum 5/5 [dao-1, dao-2, dao-3, dao-4, dao-5]"
    );
  });

  it("keeps the caller note in front of the signer list", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(["dao-1", "dao-2", "dao-3", "dao-4", "dao-5"]);

    dispatchArbitration(escrow, quorum, "release", "DAO vote passed");
    assert.equal(
      lastNote(escrow),
      "DAO vote passed [quorum 5/5 [dao-1, dao-2, dao-3, dao-4, dao-5]]"
    );
  });

  it("excludes approvals that expired out of the window", () => {
    const clock = fakeClock();
    const escrow = disputedEscrow();
    const quorum = createQuorum({
      threshold: 3,
      signers: SIGNERS,
      now: clock.now,
      maxApprovalAgeMs: WINDOW,
    });
    quorum.approve("dao-1");
    quorum.approve("dao-2");
    clock.advance(30_000);
    quorum.approve("dao-3");
    quorum.approve("dao-4");
    quorum.approve("dao-5");
    clock.advance(31_000); // dao-1/dao-2 are 61s old: expired
    assert.equal(quorum.approvalCount(), 3);

    dispatchArbitration(escrow, quorum, "release");
    assert.equal(lastNote(escrow), "quorum 3/3 [dao-3, dao-4, dao-5]");
  });

  it("re-approval after expiry moves the signer to its fresh position", () => {
    const clock = fakeClock();
    const escrow = disputedEscrow();
    const quorum = createQuorum({
      threshold: 5,
      signers: SIGNERS,
      now: clock.now,
      maxApprovalAgeMs: WINDOW,
    });
    for (const id of ["dao-1", "dao-2", "dao-3", "dao-4", "dao-5"])
      quorum.approve(id);
    clock.advance(WINDOW + 1); // every approval expired
    assert.equal(quorum.hasQuorum(), false);
    for (const id of ["dao-3", "dao-1", "dao-2", "dao-4", "dao-5"])
      quorum.approve(id);

    dispatchArbitration(escrow, quorum, "release");
    assert.equal(
      lastNote(escrow),
      "quorum 5/5 [dao-3, dao-1, dao-2, dao-4, dao-5]"
    );
  });

  it("a revoked signer drops out of the list", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith([
      "dao-1", "dao-2", "dao-3", "dao-4", "dao-5", "dao-6",
    ]);
    quorum.revoke("dao-2"); // 5 counted remain, still at threshold

    dispatchArbitration(escrow, quorum, "release");
    assert.equal(
      lastNote(escrow),
      "quorum 5/5 [dao-1, dao-3, dao-4, dao-5, dao-6]"
    );
  });

  it("below quorum still rejects and appends nothing", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(["dao-1", "dao-2", "dao-3", "dao-4"]);
    const historyBefore = escrow.history.length;

    assert.throws(
      () => dispatchArbitration(escrow, quorum, "release"),
      /arbitration requires quorum: 4\/5 approvals/
    );
    assert.equal(escrow.state, "DISPUTED");
    assert.equal(escrow.history.length, historyBefore);
  });

  it("the refund outcome carries the same signer list", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(["dao-9", "dao-7", "dao-5", "dao-3", "dao-1"]);

    dispatchArbitration(escrow, quorum, "refund");
    const last = escrow.history[escrow.history.length - 1];
    assert.equal(last.event, "ARBITRATE_REFUND");
    assert.equal(
      last.note,
      "quorum 5/5 [dao-9, dao-7, dao-5, dao-3, dao-1]"
    );
  });

  it("snapshot / fromJSON round-trip preserves the signer list note", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(["dao-1", "dao-2", "dao-3", "dao-4", "dao-5"]);
    dispatchArbitration(escrow, quorum, "release");

    const rebuilt = Escrow.fromJSON(
      JSON.parse(JSON.stringify(escrow.toJSON()))
    );
    assert.equal(rebuilt.state, "RELEASED");
    assert.equal(
      rebuilt.history[rebuilt.history.length - 1].note,
      "quorum 5/5 [dao-1, dao-2, dao-3, dao-4, dao-5]"
    );
    assert.equal(verifyHistoryChain(rebuilt.history), true);
  });

  it("the hash chain still verifies over the longer note", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(["dao-1", "dao-2", "dao-3", "dao-4", "dao-5"]);
    dispatchArbitration(escrow, quorum, "release");
    assert.equal(verifyHistoryChain(escrow.history), true);
  });
});
