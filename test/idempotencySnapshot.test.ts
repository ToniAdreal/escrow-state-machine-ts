/**
 * Snapshot persistence tests for dispatch idempotency keys.
 *
 * The consumed-key set used to be in-memory only: a process restart
 * cleared it and a replayed key executed a second time. It is now part
 * of the snapshot (`idempotencyKeys`, written only when non-empty), so
 * cross-restart replays stay exactly-once — while legacy snapshots
 * without the field load exactly as before.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Escrow } from "../src/stateMachine.js";

function fundedWithKeys(): Escrow {
  const e = new Escrow("esc-idem-snap-1");
  e.dispatch("FUND", "initial deposit", 10630, { idempotencyKey: "fund-1" });
  e.dispatch("SUBMIT_MILESTONE", "milestone", undefined, {
    idempotencyKey: "submit-1",
  });
  return e;
}

describe("idempotency keys in snapshots", () => {
  it("consumed keys survive toJSON/fromJSON and a replay stays a no-op", () => {
    const restored = Escrow.fromJSON(
      JSON.parse(JSON.stringify(fundedWithKeys().toJSON()))
    );
    assert.equal(restored.state, "MILESTONE_SUBMITTED");
    assert.equal(restored.history.length, 2);
    // Replay of either consumed key: current state, no new history.
    assert.equal(
      restored.dispatch("FUND", "initial deposit", 10630, {
        idempotencyKey: "fund-1",
      }),
      "MILESTONE_SUBMITTED"
    );
    assert.equal(
      restored.dispatch("SUBMIT_MILESTONE", "milestone", undefined, {
        idempotencyKey: "submit-1",
      }),
      "MILESTONE_SUBMITTED"
    );
    assert.equal(restored.history.length, 2);
  });

  it("a keyless escrow's snapshot carries no idempotencyKeys field", () => {
    const e = new Escrow("esc-idem-snap-2");
    e.dispatch("FUND", "deposit", 500);
    const snapshot = e.toJSON();
    assert.equal("idempotencyKeys" in snapshot, false);
    assert.deepEqual(Object.keys(snapshot).sort(), [
      "history",
      "id",
      "state",
      "v",
    ]);
  });

  it("a legacy snapshot without the field loads with an empty key set", () => {
    const restored = Escrow.fromJSON({
      id: "legacy-idem",
      state: "FUNDED",
      history: [
        {
          seq: 1,
          event: "FUND",
          from: "CREATED",
          to: "FUNDED",
          at: "2026-03-01T00:00:00.000Z",
          amount: 500,
        },
      ],
    });
    assert.equal(restored.state, "FUNDED");
    // No keys were carried, so a fresh key executes normally.
    restored.dispatch("SUBMIT_MILESTONE", undefined, undefined, {
      idempotencyKey: "fresh-1",
    });
    assert.equal(restored.state, "MILESTONE_SUBMITTED");
    assert.equal(restored.history.length, 2);
  });

  it("a non-array idempotencyKeys throws an invalid-snapshot error", () => {
    const snapshot = fundedWithKeys().toJSON() as unknown as Record<
      string,
      unknown
    >;
    snapshot.idempotencyKeys = "fund-1";
    assert.throws(
      () => Escrow.fromJSON(snapshot),
      /invalid snapshot: idempotencyKeys must be an array/
    );
  });

  it("an empty-string entry throws an invalid-snapshot error", () => {
    const snapshot = fundedWithKeys().toJSON();
    snapshot.idempotencyKeys = ["fund-1", ""];
    assert.throws(
      () => Escrow.fromJSON(snapshot),
      /invalid snapshot: idempotencyKeys entries must be non-empty strings/
    );
  });

  it("a non-string entry throws an invalid-snapshot error", () => {
    const snapshot = fundedWithKeys().toJSON() as unknown as Record<
      string,
      unknown
    >;
    snapshot.idempotencyKeys = ["fund-1", 42];
    assert.throws(
      () => Escrow.fromJSON(snapshot),
      /invalid snapshot: idempotencyKeys entries must be non-empty strings/
    );
  });

  it("mutating the exported array does not affect the live escrow", () => {
    const e = fundedWithKeys();
    const snapshot = e.toJSON();
    snapshot.idempotencyKeys!.push("injected-key");
    snapshot.idempotencyKeys!.splice(0, 1);
    // The injected key was never consumed by the escrow: it executes.
    assert.equal(
      e.dispatch("VERIFY_PASS", undefined, undefined, {
        idempotencyKey: "injected-key",
      }),
      "VERIFIED"
    );
    // And the spliced-out original key is still consumed: no-op.
    const before = e.history.length;
    e.dispatch("FUND", "replay", 1, { idempotencyKey: "fund-1" });
    assert.equal(e.history.length, before);
  });

  it("a restored escrow consumes new keys and persists them onward", () => {
    const restored = Escrow.fromJSON(
      JSON.parse(JSON.stringify(fundedWithKeys().toJSON()))
    );
    restored.dispatch("VERIFY_PASS", undefined, undefined, {
      idempotencyKey: "verify-1",
    });
    const second = Escrow.fromJSON(
      JSON.parse(JSON.stringify(restored.toJSON()))
    );
    assert.deepEqual(second.toJSON().idempotencyKeys, [
      "fund-1",
      "submit-1",
      "verify-1",
    ]);
    const before = second.history.length;
    second.dispatch("VERIFY_PASS", undefined, undefined, {
      idempotencyKey: "verify-1",
    });
    assert.equal(second.history.length, before);
  });

  it("JSON.stringify direct round-trip preserves the key set", () => {
    const restored = Escrow.fromJSON(
      JSON.parse(JSON.stringify(fundedWithKeys()))
    );
    assert.deepEqual(restored.toJSON().idempotencyKeys, [
      "fund-1",
      "submit-1",
    ]);
  });

  it("duplicate entries in a snapshot are deduped, not rejected", () => {
    const snapshot = fundedWithKeys().toJSON();
    snapshot.idempotencyKeys = ["fund-1", "fund-1", "submit-1", "fund-1"];
    const restored = Escrow.fromJSON(snapshot);
    assert.deepEqual(restored.toJSON().idempotencyKeys, [
      "fund-1",
      "submit-1",
    ]);
    const before = restored.history.length;
    restored.dispatch("FUND", "replay", 1, { idempotencyKey: "fund-1" });
    assert.equal(restored.history.length, before);
  });
});
