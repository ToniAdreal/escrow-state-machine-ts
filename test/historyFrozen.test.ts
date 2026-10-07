/**
 * Frozen audit-history snapshot (backlog #68).
 *
 * Before this change, `escrow.history` returned the live internal array
 * (type-level `readonly` only), so in-process callers could push/splice or
 * rewrite entry fields and corrupt the "immutable" audit log. The getter
 * now returns a detached, frozen copy per call (array + entries frozen),
 * mirroring the dataquest-task-lifecycle fix (backlog #26).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { Escrow, type EscrowHistoryEntry } from "../src/stateMachine.js";

function funded(): Escrow {
  const escrow = new Escrow("freeze-test");
  escrow.dispatch("FUND", "initial deposit", 100);
  return escrow;
}

// --- array-level immutability ---

test("external push on the returned history throws", () => {
  const escrow = funded();
  const history = escrow.history;
  assert.strictEqual(Object.isFrozen(history), true);
  assert.throws(
    () =>
      (history as unknown as unknown[]).push({
        seq: 999,
        event: "FUND",
        from: "FUNDED",
        to: "FUNDED",
        at: new Date().toISOString(),
      }),
    TypeError
  );
  assert.strictEqual(escrow.history.length, 1);
});

test("external splice on the returned history throws", () => {
  const escrow = funded();
  const history = escrow.history;
  assert.throws(
    () => (history as unknown as unknown[]).splice(0, 1),
    TypeError
  );
  assert.strictEqual(escrow.history.length, 1);
});

// --- entry-level immutability ---

test("rewriting an entry field does not affect the escrow internals", () => {
  const escrow = funded();
  const history = escrow.history;
  const entry = history[0] as Readonly<EscrowHistoryEntry>;
  assert.strictEqual(Object.isFrozen(entry), true);
  assert.throws(() => {
    // @ts-expect-error deliberately rewriting a frozen entry
    entry.note = "tampered";
  }, TypeError);
  assert.strictEqual(escrow.history[0].note, "initial deposit");
});

test("getter returns detached snapshots: two calls are independent copies", () => {
  const escrow = funded();
  const first = escrow.history;
  const second = escrow.history;
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first[0], second[0]);
  assert.deepStrictEqual(first, second);
});

// --- normal operation unaffected ---

test("dispatch still appends after snapshot reads", () => {
  const escrow = funded();
  const before = escrow.history.length;
  escrow.dispatch("SUBMIT_MILESTONE");
  const history = escrow.history;
  assert.strictEqual(history.length, before + 1);
  assert.strictEqual(history[history.length - 1].seq, before + 1);
  assert.strictEqual(history[history.length - 1].from, "FUNDED");
  assert.strictEqual(escrow.state, "MILESTONE_SUBMITTED");
});

test("toJSON/fromJSON round-trip is unaffected", () => {
  const escrow = funded();
  escrow.dispatch("SUBMIT_MILESTONE");
  // JSON wire shape is unchanged by the frozen getter: JSON.stringify drops
  // the `note: undefined` key on both sides, so the round-trip stays
  // byte-identical to before this change.
  const restored = Escrow.fromJSON(escrow.toJSON());
  assert.strictEqual(
    JSON.stringify(restored.history),
    JSON.stringify(escrow.history)
  );
  assert.strictEqual(restored.state, escrow.state);
  restored.dispatch("VERIFY_PASS");
  assert.strictEqual(restored.history.length, escrow.history.length + 1);
});

test("frozen snapshot feeds pure history consumers", () => {
  // downstream helpers (settlementReport, webhooks) take the history array;
  // they must work on the frozen snapshot without mutation.
  const escrow = funded();
  const history = escrow.history;
  const funds = history.filter((entry) => entry.event === "FUND");
  assert.strictEqual(funds.length, 1);
  assert.strictEqual(funds[0].amount, 100);
});
