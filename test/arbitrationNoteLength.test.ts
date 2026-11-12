/**
 * `dispatchArbitration` quorum-suffix note overflow (backlog #1081).
 *
 * `dispatchArbitration` appends ` [quorum n/m [signers]]` to the caller's
 * note before dispatching. A caller note that fits `MAX_NOTE_LENGTH`
 * (32,768) on its own can overflow once the library-appended suffix is
 * added — and the dispatch's generic `invalid dispatch: note must be at
 * most …` error then blames the caller's note for the library's own
 * suffix. The pre-check in `dispatchArbitration` must catch the merged
 * length first and name the quorum suffix as the cause.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  MAX_NOTE_LENGTH,
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

/** Quorum with the first `n` of `signers` approved (default 5/9 rule). */
function quorumWith(n: number, signers: string[] = SIGNERS, threshold = 5) {
  const quorum = createQuorum({ threshold, signers });
  for (let i = 0; i < n; i++) quorum.approve(signers[i]);
  return quorum;
}

/**
 * The suffix `dispatchArbitration` appends after the caller note:
 * ` [quorum n/m [signer, …]]`. For the default 5 dao signers it is
 * 2 + len("quorum 5/5 [") + 5*5 + 4*2 + 1 = 49 chars.
 */
const DEFAULT_SUFFIX_LENGTH = 49;

describe("dispatchArbitration quorum-suffix note length", () => {
  it("rejects a full-length caller note once the suffix is added, with the suffix named", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(5);
    const historyBefore = escrow.history.length;
    const note = "x".repeat(MAX_NOTE_LENGTH);

    assert.throws(
      () => dispatchArbitration(escrow, quorum, "release", note),
      new RegExp(
        `arbitration note too long: caller note ${MAX_NOTE_LENGTH} chars ` +
          `plus quorum suffix ${DEFAULT_SUFFIX_LENGTH} chars exceeds MAX_NOTE_LENGTH ${MAX_NOTE_LENGTH}`
      )
    );

    assert.equal(escrow.state, "DISPUTED");
    assert.equal(escrow.history.length, historyBefore);
  });

  it("accepts a caller note that fills the ceiling exactly once the suffix is added", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(5);
    const note = "x".repeat(MAX_NOTE_LENGTH - DEFAULT_SUFFIX_LENGTH);

    const state = dispatchArbitration(escrow, quorum, "release", note);
    assert.equal(state, "RELEASED");

    const last = escrow.history[escrow.history.length - 1];
    assert.equal(last.note?.length, MAX_NOTE_LENGTH);
    assert.ok(last.note?.endsWith(" [quorum 5/5 [dao-1, dao-2, dao-3, dao-4, dao-5]]"));
  });

  it("rejects a caller note one char past the exact-fit boundary", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(5);
    const note = "x".repeat(MAX_NOTE_LENGTH - DEFAULT_SUFFIX_LENGTH + 1);

    assert.throws(
      () => dispatchArbitration(escrow, quorum, "release", note),
      /arbitration note too long: caller note 32720 chars plus quorum suffix 49 chars exceeds MAX_NOTE_LENGTH 32768/
    );
    assert.equal(escrow.state, "DISPUTED");
  });

  it("passes a short note through with the quorum suffix in history", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(5);

    dispatchArbitration(escrow, quorum, "refund", "DAO vote passed");

    const last = escrow.history[escrow.history.length - 1];
    assert.equal(last.event, "ARBITRATE_REFUND");
    assert.equal(
      last.note,
      "DAO vote passed [quorum 5/5 [dao-1, dao-2, dao-3, dao-4, dao-5]]"
    );
  });

  it("scales the reported suffix length with the signer ids", () => {
    // 5 signers of 256 chars each: suffix = 2 + 12 + 5*256 + 4*2 + 1 = 1304.
    const longSigners = Array.from({ length: 9 }, (_, i) =>
      `${"s".repeat(255)}${i}`
    );
    const escrowShort = disputedEscrow();
    const escrowLong = disputedEscrow();
    const note = "x".repeat(MAX_NOTE_LENGTH);

    assert.throws(
      () => dispatchArbitration(escrowShort, quorumWith(5), "release", note),
      /plus quorum suffix 49 chars exceeds/
    );
    assert.throws(
      () => dispatchArbitration(escrowLong, quorumWith(5, longSigners), "release", note),
      /plus quorum suffix 1304 chars exceeds/
    );
    assert.equal(escrowShort.state, "DISPUTED");
    assert.equal(escrowLong.state, "DISPUTED");
  });

  it("still reports a non-string note with the old caller error", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(5);

    assert.throws(
      // @ts-expect-error deliberate misuse: non-string note
      () => dispatchArbitration(escrow, quorum, "release", 42),
      /invalid arbitration note: must be a string, got number/
    );
    assert.equal(escrow.state, "DISPUTED");
  });

  it("still throws the quorum error first when below threshold, even with an overlong note", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(4); // 4/5: below threshold
    const note = "x".repeat(MAX_NOTE_LENGTH);

    assert.throws(
      () => dispatchArbitration(escrow, quorum, "release", note),
      /arbitration requires quorum: 4\/5 approvals/
    );
    assert.equal(escrow.state, "DISPUTED");
  });

  it("names the suffix when the quorum suffix alone overflows (no caller note)", () => {
    // 130 signers of 256 chars: suffix = 16 + 130*256 + 129*2 + 1 = 33555.
    const manySigners = Array.from({ length: 130 }, (_, i) =>
      `${"s".repeat(253)}${String(i).padStart(3, "0")}`
    );
    const escrow = disputedEscrow();
    const quorum = quorumWith(130, manySigners, 130);

    assert.throws(
      () => dispatchArbitration(escrow, quorum, "release"),
      /arbitration note too long: caller note 0 chars plus quorum suffix 33555 chars exceeds MAX_NOTE_LENGTH 32768/
    );
    assert.equal(escrow.state, "DISPUTED");
  });
});
