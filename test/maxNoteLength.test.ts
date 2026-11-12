/**
 * `MAX_NOTE_LENGTH` (32,768) enforcement on both gates (backlog #937).
 *
 * The dataquest lifecycle already caps notes at 32,768 characters on
 * dispatch and on snapshot/history parse; the escrow side only checked
 * the note's type, so an unbounded note could be written straight
 * into the append-only audit history and inflate every snapshot and
 * NDJSON export that serializes it verbatim. Both gates now enforce
 * the same value with the same wording (`note must be at most 32768
 * characters, got N`), and the parse gate covers `fromJSON`,
 * `fromHistory`, `parseEscrowHistory`, and `historyFromNdjson`
 * (all four funnel through `parseEscrowSnapshot`).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  Escrow,
  MAX_NOTE_LENGTH,
  createQuorum,
  dispatchArbitration,
  historyFromNdjson,
  parseEscrowHistory,
} from "../src/index.js";

function fresh(): Escrow {
  return new Escrow("note-limit-test");
}

const AT = "2026-11-06T00:00:00.000Z";

function overlongNote(): string {
  return "x".repeat(MAX_NOTE_LENGTH + 1);
}

function fundedHistoryWithNote(note: string) {
  return [
    {
      seq: 1,
      event: "FUND",
      from: "CREATED",
      to: "FUNDED",
      at: AT,
      amount: 100,
      note,
    },
  ];
}

// --- dispatch gate ---

test("dispatch rejects a note longer than MAX_NOTE_LENGTH with no history residue", () => {
  const e = fresh();
  assert.equal(MAX_NOTE_LENGTH, 32_768);
  assert.throws(
    () => e.dispatch("FUND", overlongNote(), 100),
    /invalid dispatch: note must be at most 32768 characters, got 32769/
  );
  assert.deepEqual(e.history, []);
  assert.equal(e.state, "CREATED");
});

test("dispatch accepts a note of exactly MAX_NOTE_LENGTH characters", () => {
  const e = fresh();
  e.dispatch("FUND", "x".repeat(MAX_NOTE_LENGTH), 100);
  assert.equal(e.state, "FUNDED");
  assert.equal(e.history[0].note?.length, MAX_NOTE_LENGTH);
});

test("dispatch rejects a note one character over the limit", () => {
  const e = fresh();
  assert.throws(
    () => e.dispatch("FUND", "x".repeat(MAX_NOTE_LENGTH + 1), 100),
    /got 32769/
  );
  assert.deepEqual(e.history, []);
});

test("non-string notes still fail with the old type error, not the length error", () => {
  const e = fresh();
  assert.throws(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => e.dispatch("FUND", 42 as any, 100),
    /invalid dispatch: note must be a string, got number/
  );
  assert.deepEqual(e.history, []);
});

test("an empty note still dispatches normally", () => {
  const e = fresh();
  e.dispatch("FUND", "", 100);
  assert.equal(e.state, "FUNDED");
  assert.equal(e.history[0].note, "");
});

test("a rejected overlong note does not consume its idempotency key", () => {
  const e = fresh();
  const key = "k-note-limit";
  assert.throws(
    () => e.dispatch("FUND", overlongNote(), 100, { idempotencyKey: key }),
    /note must be at most 32768 characters/
  );
  // Same key with a fitting note succeeds — the failed dispatch never
  // recorded it.
  e.dispatch("FUND", "fits", 100, { idempotencyKey: key });
  assert.equal(e.state, "FUNDED");
  assert.equal(e.history.length, 1);
});

// --- snapshot / history parse gate ---

test("fromJSON rejects a snapshot whose history entry note is overlong", () => {
  const e = fresh();
  e.dispatch("FUND", "short note", 100);
  const snapshot = e.toJSON() as unknown as Record<string, unknown>;
  const history = snapshot.history as Record<string, unknown>[];
  history[0].note = overlongNote();
  assert.throws(
    () => Escrow.fromJSON(snapshot),
    /invalid snapshot: history\[0\]: note must be at most 32768 characters, got 32769/
  );
});

test("parseEscrowHistory rejects an overlong note entry", () => {
  assert.throws(
    () => parseEscrowHistory(fundedHistoryWithNote(overlongNote())),
    /invalid snapshot: history\[0\]: note must be at most 32768 characters, got 32769/
  );
});

test("fromHistory rejects a history log with an overlong note", () => {
  assert.throws(
    () =>
      Escrow.fromHistory(
        "note-limit-test",
        fundedHistoryWithNote(overlongNote())
      ),
    /note must be at most 32768 characters, got 32769/
  );
});

test("historyFromNdjson rejects an NDJSON line with an overlong note", () => {
  const line = JSON.stringify(fundedHistoryWithNote(overlongNote())[0]);
  assert.throws(
    () => historyFromNdjson(`${line}\n`),
    /note must be at most 32768 characters, got 32769/
  );
});

test("a history at exactly the limit parses on every restore path", () => {
  const atLimit = fundedHistoryWithNote("x".repeat(MAX_NOTE_LENGTH));
  assert.equal(parseEscrowHistory(atLimit).length, 1);
  const rebuilt = Escrow.fromHistory("note-limit-test", atLimit);
  assert.equal(rebuilt.state, "FUNDED");
  assert.equal(rebuilt.history[0].note?.length, MAX_NOTE_LENGTH);
});

// --- arbitration path (funnels through dispatch) ---

test("dispatchArbitration rejects a caller note that overflows once the quorum suffix is appended", () => {
  const escrow = new Escrow("esc-arb");
  escrow.dispatch("FUND", undefined, 10630);
  escrow.dispatch("DISPUTE");
  const quorum = createQuorum({
    threshold: 5,
    signers: ["dao-1", "dao-2", "dao-3", "dao-4", "dao-5"],
  });
  for (const signer of ["dao-1", "dao-2", "dao-3", "dao-4", "dao-5"]) {
    quorum.approve(signer);
  }
  // Exactly at the limit as given, but dispatchArbitration appends
  // " [quorum 5/5 [dao-1, dao-2, dao-3, dao-4, dao-5]]" — the combined
  // note must fail, not silently truncate or overflow the audit
  // history. The pre-check in dispatchArbitration names the quorum
  // suffix as the cause (backlog #1081) instead of the dispatch's
  // generic note error.
  assert.throws(
    () =>
      dispatchArbitration(
        escrow,
        quorum,
        "release",
        "x".repeat(MAX_NOTE_LENGTH)
      ),
    /arbitration note too long: caller note 32768 chars plus quorum suffix 49 chars exceeds MAX_NOTE_LENGTH 32768/
  );
  assert.equal(escrow.state, "DISPUTED");
  assert.equal(escrow.history.length, 2);
});
