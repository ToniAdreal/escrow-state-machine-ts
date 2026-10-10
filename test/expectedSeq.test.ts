import test from "node:test";
import assert from "node:assert/strict";
import { Escrow } from "../src/index.js";

/**
 * `dispatch(event, note, amount, { expectedSeq })` — optimistic-
 * concurrency guard, the paired counterpart of dataquest-task-
 * lifecycle's guard (backlog #151) with identical semantics.
 *
 * Rules under test:
 *  - `expectedSeq` asserts the current history length (= last entry's
 *    seq; 0 for an empty history) and is checked before every other
 *    dispatch validation — note/option shape, idempotency dedupe,
 *    transition legality, RBAC, amount/deposit-cap checks — and before
 *    any mutation
 *  - a match advances normally; a mismatch (stale or ahead) throws
 *    `dispatch conflict: expected seq <n> but escrow is at seq <m>` and
 *    changes nothing: state, history, the consumed idempotency-key
 *    set, and listener notifications are all untouched
 *  - a non-integer / negative / non-number value throws
 *    `invalid dispatch options: …` up front
 *  - after a conflict, re-reading the escrow and retrying with the
 *    fresh seq succeeds (including with the idempotency key the
 *    conflicted attempt carried — a conflict consumes nothing)
 *  - omitting `expectedSeq` preserves the exact pre-guard behavior
 */

test("matching expectedSeq advances normally, step by step", () => {
  const e = new Escrow("seq-1");
  assert.equal(e.dispatch("FUND", undefined, 100, { expectedSeq: 0 }), "FUNDED");
  assert.equal(e.dispatch("SUBMIT_MILESTONE", undefined, undefined, { expectedSeq: 1 }), "MILESTONE_SUBMITTED");
  assert.equal(e.dispatch("VERIFY_PASS", undefined, undefined, { expectedSeq: 2 }), "VERIFIED");
  assert.equal(e.history.length, 3);
  assert.equal(e.history[2].seq, 3);
});

test("expectedSeq 0 is the guard for an empty history", () => {
  const e = new Escrow("seq-2");
  assert.equal(e.history.length, 0);
  assert.equal(e.dispatch("FUND", undefined, undefined, { expectedSeq: 0 }), "FUNDED");
  // …and 0 is stale immediately afterwards.
  assert.throws(
    () => e.dispatch("SUBMIT_MILESTONE", undefined, undefined, { expectedSeq: 0 }),
    /dispatch conflict: expected seq 0 but escrow is at seq 1/,
  );
  assert.equal(e.state, "FUNDED");
  assert.equal(e.history.length, 1);
});

test("stale expectedSeq throws conflict and leaves state/history/listeners untouched", () => {
  const e = new Escrow("seq-3");
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  let notified = 0;
  e.subscribe(() => {
    notified++;
  });
  assert.throws(
    () => e.dispatch("VERIFY_PASS", undefined, undefined, { expectedSeq: 1 }),
    /dispatch conflict: expected seq 1 but escrow is at seq 2/,
  );
  assert.equal(e.state, "MILESTONE_SUBMITTED");
  assert.equal(e.history.length, 2);
  assert.equal(notified, 0);
});

test("an expectedSeq ahead of the escrow also conflicts", () => {
  const e = new Escrow("seq-4");
  e.dispatch("FUND");
  assert.throws(
    () => e.dispatch("SUBMIT_MILESTONE", undefined, undefined, { expectedSeq: 5 }),
    /dispatch conflict: expected seq 5 but escrow is at seq 1/,
  );
  assert.equal(e.state, "FUNDED");
  assert.equal(e.history.length, 1);
});

test("a conflict consumes no idempotency key: the same key retries successfully", () => {
  const e = new Escrow("seq-5");
  e.dispatch("FUND");
  // Stale guard + a fresh key: the conflict must not consume the key.
  assert.throws(
    () =>
      e.dispatch("SUBMIT_MILESTONE", undefined, undefined, {
        expectedSeq: 0,
        idempotencyKey: "submit-1",
      }),
    /dispatch conflict: expected seq 0 but escrow is at seq 1/,
  );
  assert.deepEqual(e.toJSON().idempotencyKeys, undefined);
  // Retry with the fresh seq and the SAME key executes for real…
  assert.equal(
    e.dispatch("SUBMIT_MILESTONE", undefined, undefined, {
      expectedSeq: 1,
      idempotencyKey: "submit-1",
    }),
    "MILESTONE_SUBMITTED",
  );
  assert.equal(e.history.length, 2);
  assert.deepEqual(e.toJSON().idempotencyKeys, ["submit-1"]);
  // …and only now is the key consumed (a bare retry is a no-op).
  assert.equal(
    e.dispatch("SUBMIT_MILESTONE", undefined, undefined, { idempotencyKey: "submit-1" }),
    "MILESTONE_SUBMITTED",
  );
  assert.equal(e.history.length, 2);
});

test("invalid expectedSeq values throw up front and append nothing", () => {
  const e = new Escrow("seq-6");
  for (const bad of [-1, 1.5, NaN, Infinity, -Infinity, "1", null, {}] as unknown[]) {
    assert.throws(
      () => e.dispatch("FUND", undefined, undefined, { expectedSeq: bad as number }),
      /invalid dispatch options: expectedSeq must be a non-negative integer/,
      `should reject ${String(bad)}`,
    );
  }
  assert.equal(e.state, "CREATED");
  assert.equal(e.history.length, 0);
});

test("after a conflict, retrying with the fresh seq succeeds", () => {
  const e = new Escrow("seq-7");
  e.dispatch("FUND", undefined, undefined, { expectedSeq: 0 });
  // A second writer still holding the seq-0 snapshot conflicts…
  assert.throws(
    () => e.dispatch("SUBMIT_MILESTONE", undefined, undefined, { expectedSeq: 0 }),
    /dispatch conflict: expected seq 0 but escrow is at seq 1/,
  );
  // …re-reads (seq is now 1) and retries successfully.
  assert.equal(
    e.dispatch("SUBMIT_MILESTONE", undefined, undefined, { expectedSeq: 1 }),
    "MILESTONE_SUBMITTED",
  );
  assert.equal(e.history.length, 2);
});

test("the guard runs first: conflict beats option-shape and transition errors", () => {
  const e = new Escrow("seq-8");
  e.dispatch("FUND");
  // Stale seq + invalid actor + illegal transition (RELEASE is not
  // legal from FUNDED): the conflict wins, because the caller's
  // premise (the seq) is checked before the call itself is validated.
  assert.throws(
    () =>
      e.dispatch("RELEASE", undefined, undefined, {
        expectedSeq: 0,
        actor: 123 as unknown as string,
      }),
    /dispatch conflict: expected seq 0 but escrow is at seq 1/,
  );
  // An invalid expectedSeq value likewise beats an illegal transition.
  assert.throws(
    () => e.dispatch("RELEASE", undefined, undefined, { expectedSeq: -2 }),
    /invalid dispatch options: expectedSeq must be a non-negative integer/,
  );
  assert.equal(e.state, "FUNDED");
  assert.equal(e.history.length, 1);
});

test("the guard runs before RBAC: conflict beats an unauthorized actor, fresh seq reaches RBAC", () => {
  const e = new Escrow("seq-9", { rolePolicy: { RELEASE: ["treasury"] } });
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  // Stale seq + unauthorized actor on a policy-gated event: the guard
  // fires first — the RBAC verdict would leak that the escrow moved.
  assert.throws(
    () =>
      e.dispatch("RELEASE", undefined, undefined, {
        expectedSeq: 2,
        actor: "mallory",
      }),
    /dispatch conflict: expected seq 2 but escrow is at seq 3/,
  );
  assert.equal(e.state, "VERIFIED");
  assert.equal(e.history.length, 3);
  // With the fresh seq the same call reaches the RBAC check and is
  // rejected there instead…
  assert.throws(
    () =>
      e.dispatch("RELEASE", undefined, undefined, {
        expectedSeq: 3,
        actor: "mallory",
      }),
    /actor not authorized for RELEASE/,
  );
  // …and the allowlisted actor with the fresh seq succeeds.
  assert.equal(
    e.dispatch("RELEASE", undefined, undefined, {
      expectedSeq: 3,
      actor: "treasury",
    }),
    "RELEASED",
  );
  assert.equal(e.history.length, 4);
});

test("omitting expectedSeq preserves the pre-guard behavior", () => {
  const e = new Escrow("seq-10");
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  assert.throws(() => e.dispatch("FUND"), /invalid transition/);
  assert.equal(e.dispatch("VERIFY_PASS"), "VERIFIED");
  assert.equal(e.history.length, 3);
});
