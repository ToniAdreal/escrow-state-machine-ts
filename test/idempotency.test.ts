/**
 * Idempotency-key tests for Escrow.dispatch.
 *
 * Payments systems retry deliveries; dispatch must not append a duplicate
 * history entry when the same logical operation arrives twice. Keys are
 * global to the escrow instance (not per-event) and recorded only after a
 * successful dispatch. The consumed set is also persisted in snapshots
 * (see test/idempotencySnapshot.test.ts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Escrow } from "../src/stateMachine.js";

describe("dispatch idempotency keys", () => {
  it("same key twice leaves a single history entry", () => {
    const escrow = new Escrow("e1");
    const opts = { idempotencyKey: "fund-1" };
    assert.equal(escrow.dispatch("FUND", "initial deposit", 10630, opts), "FUNDED");
    assert.equal(escrow.dispatch("FUND", "initial deposit", 10630, opts), "FUNDED");
    assert.equal(escrow.history.length, 1);
    assert.equal(escrow.history[0].seq, 1);
    assert.equal(escrow.history[0].amount, 10630);
  });

  it("different keys append normally", () => {
    const escrow = new Escrow("e2");
    escrow.dispatch("FUND", "first", 1000, { idempotencyKey: "k-1" });
    escrow.dispatch("FUND", "top-up", 630, { idempotencyKey: "k-2" });
    assert.equal(escrow.history.length, 2);
    assert.equal(escrow.history[1].amount, 630);
    assert.equal(escrow.state, "FUNDED");
  });

  it("no key behaves exactly as before (repeat FUND is a top-up)", () => {
    const escrow = new Escrow("e3");
    escrow.dispatch("FUND", undefined, 1000);
    escrow.dispatch("FUND", undefined, 630);
    assert.equal(escrow.history.length, 2);
  });

  it("a duplicate key on a different event is still a no-op", () => {
    const escrow = new Escrow("e4");
    escrow.dispatch("FUND", "initial", 1000, { idempotencyKey: "shared-key" });
    // Same key, different event: global uniqueness, not per-event.
    assert.equal(
      escrow.dispatch("SUBMIT_MILESTONE", "milestone", undefined, {
        idempotencyKey: "shared-key",
      }),
      "FUNDED"
    );
    assert.equal(escrow.state, "FUNDED");
    assert.equal(escrow.history.length, 1);
  });

  it("a duplicate key returns the current state, not the state at first use", () => {
    const escrow = new Escrow("e5");
    escrow.dispatch("FUND", "initial", 1000, { idempotencyKey: "k-first" });
    escrow.dispatch("SUBMIT_MILESTONE", undefined, undefined, {
      idempotencyKey: "k-second",
    });
    assert.equal(escrow.state, "MILESTONE_SUBMITTED");
    // Retry of the first key after the escrow moved on: no-op, current state.
    assert.equal(
      escrow.dispatch("FUND", "initial", 1000, { idempotencyKey: "k-first" }),
      "MILESTONE_SUBMITTED"
    );
    assert.equal(escrow.history.length, 2);
  });

  it("a failed dispatch does not consume the key", () => {
    const escrow = new Escrow("e6");
    // Invalid transition from CREATED: throws, key must not be recorded.
    assert.throws(
      () =>
        escrow.dispatch("SUBMIT_MILESTONE", "bad", undefined, {
          idempotencyKey: "retry-key",
        }),
      /invalid transition/
    );
    assert.equal(escrow.history.length, 0);
    // Same key with corrected input succeeds.
    assert.equal(
      escrow.dispatch("FUND", "corrected", 500, { idempotencyKey: "retry-key" }),
      "FUNDED"
    );
    assert.equal(escrow.history.length, 1);
  });

  it("a failed dispatch due to invalid amount does not consume the key", () => {
    const escrow = new Escrow("e7");
    assert.throws(
      () => escrow.dispatch("FUND", "bad amount", -5, { idempotencyKey: "k-amt" }),
      /must be a finite non-negative number/
    );
    assert.equal(escrow.history.length, 0);
    assert.equal(
      escrow.dispatch("FUND", "corrected", 500, { idempotencyKey: "k-amt" }),
      "FUNDED"
    );
    assert.equal(escrow.history.length, 1);
  });

  it("invalid keys and opts throw descriptive errors", () => {
    const escrow = new Escrow("e8");
    assert.throws(
      () => escrow.dispatch("FUND", undefined, 100, { idempotencyKey: "" }),
      /idempotencyKey must be a non-empty string/
    );
    assert.throws(
      () =>
        escrow.dispatch("FUND", undefined, 100, {
          idempotencyKey: 42 as unknown as string,
        }),
      /idempotencyKey must be a non-empty string/
    );
    assert.throws(
      () =>
        escrow.dispatch(
          "FUND",
          undefined,
          100,
          "key" as unknown as { idempotencyKey: string }
        ),
      /opts must be an object/
    );
    assert.equal(escrow.history.length, 0);
  });

  it("seen keys ARE persisted across snapshots (restart-safe replay)", () => {
    const escrow = new Escrow("e9");
    escrow.dispatch("FUND", "initial", 1000, { idempotencyKey: "k-1" });
    const rebuilt = Escrow.fromJSON(escrow.toJSON());
    // Same key after a restart is still a duplicate: no-op, no new entry.
    // (Full persistence coverage: test/idempotencySnapshot.test.ts.)
    assert.equal(
      rebuilt.dispatch("FUND", "replayed after restart", 630, {
        idempotencyKey: "k-1",
      }),
      "FUNDED"
    );
    assert.equal(rebuilt.history.length, 1);
    assert.equal(
      JSON.stringify(escrow.toJSON().history[0].amount),
      "1000"
    );
  });

  it("duplicate dispatch does not advance seq and leaves no gap", () => {
    const escrow = new Escrow("e10");
    escrow.dispatch("FUND", "a", 100, { idempotencyKey: "dup" });
    escrow.dispatch("FUND", "a", 100, { idempotencyKey: "dup" });
    escrow.dispatch("FUND", "b", 200, { idempotencyKey: "next" });
    assert.deepEqual(
      escrow.history.map((e) => e.seq),
      [1, 2]
    );
  });
});
