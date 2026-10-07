/**
 * Constructor id validation + dispatch note type validation (backlog #67).
 *
 * Before this change, `new Escrow("")` passed while `fromJSON` would reject
 * the same id, and `dispatch(event, <non-string>)` wrote the junk straight
 * into the append-only audit history. Both paths now fail fast.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { Escrow } from "../src/stateMachine.js";

function fresh(): Escrow {
  return new Escrow("guard-test");
}

// --- constructor id validation ---

test("empty string id is rejected at construction", () => {
  assert.throws(() => new Escrow(""), /invalid escrow: id must be a non-empty string/);
});

test("non-string ids are rejected at construction", () => {
  const bad = [undefined, null, 123, 0, false, {}, [], Symbol("x")];
  for (const id of bad) {
    assert.throws(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => new Escrow(id as any),
      /invalid escrow: id must be a non-empty string/,
      `expected rejection for id=${String(id)}`
    );
  }
});

test("a valid id constructs normally", () => {
  const e = new Escrow("esc-123");
  assert.equal(e.id, "esc-123");
  assert.equal(e.state, "CREATED");
  assert.deepEqual(e.history, []);
});

// --- dispatch note validation ---

test("non-string note throws and leaves no history residue", () => {
  const e = fresh();
  const bad = [123, 0, false, null, {}, [], Symbol("n")];
  for (const note of bad) {
    assert.throws(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => e.dispatch("FUND", note as any, 100),
      /invalid dispatch: note must be a string, got /,
      `expected rejection for note=${String(note)}`
    );
  }
  assert.deepEqual(e.history, []);
  assert.equal(e.state, "CREATED");
});

test("note validation fires before the transition check", () => {
  const e = fresh();
  // SUBMIT_MILESTONE is illegal from CREATED, but the bad note must be
  // reported first — fail-fast input validation, not a transition error.
  assert.throws(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => e.dispatch("SUBMIT_MILESTONE", 42 as any),
    /invalid dispatch: note must be a string/
  );
  assert.deepEqual(e.history, []);
});

test("note validation fires before idempotency dedup records nothing", () => {
  const e = fresh();
  const key = "k-note-guard";
  // A bad note on a never-seen key must throw, not silently consume the key:
  // after the failure the same key with a good note works.
  assert.throws(
    () =>
      e.dispatch("FUND", 42 as never, 100, { idempotencyKey: key }),
    /invalid dispatch: note must be a string/
  );
  e.dispatch("FUND", "good note", 100, { idempotencyKey: key });
  assert.equal(e.history.length, 1);
  assert.equal(e.history[0].note, "good note");
});

test("empty string note and omitted note stay legal", () => {
  const e = fresh();
  e.dispatch("FUND", "", 100);
  assert.equal(e.history[0].note, "");
  e.dispatch("SUBMIT_MILESTONE"); // no note at all
  assert.equal(e.history[1].note, undefined);
});

// --- toJSON/fromJSON round-trip unaffected ---

test("legal paths and snapshots are unaffected", () => {
  const e = new Escrow("esc-rt");
  e.dispatch("FUND", "initial deposit", 500);
  e.dispatch("SUBMIT_MILESTONE", "milestone one");
  const snap = e.toJSON();
  assert.equal(snap.id, "esc-rt");
  const rebuilt = Escrow.fromJSON(JSON.parse(JSON.stringify(snap)));
  assert.equal(rebuilt.id, "esc-rt");
  assert.equal(rebuilt.state, "MILESTONE_SUBMITTED");
  assert.deepEqual(rebuilt.history, e.history);
  // ...and the rebuilt escrow keeps dispatching without seq gaps.
  rebuilt.dispatch("VERIFY_PASS", "oracle ok");
  assert.equal(rebuilt.history[rebuilt.history.length - 1].seq, 3);
});
