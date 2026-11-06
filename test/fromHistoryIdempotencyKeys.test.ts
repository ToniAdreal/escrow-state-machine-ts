/**
 * Escrow.fromHistory idempotency-key re-attachment tests (#924).
 *
 * A bare audit history carries no consumed-key set, so a rebuild from a
 * log alone used to start with an EMPTY key set and would re-execute a
 * dispatch key consumed before the log was taken. `EscrowOptions`
 * now accepts `idempotencyKeys` (the dataquest lifecycle already had
 * the same option), the constructor seeds `_seenIdempotencyKeys` with
 * it, and `fromHistory` re-attaches the keys through the constructor
 * with no signature change. `fromJSON` unions an explicit
 * `opts.idempotencyKeys` with the snapshot's keys instead of
 * overriding them, so neither source can silently un-consume a key.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Escrow, type EscrowHistoryEntry } from "../src/index.js";

const T1 = "2026-03-01T10:00:00.000Z";
const T2 = "2026-03-01T11:00:00.000Z";
const T3 = "2026-03-01T12:00:00.000Z";
const T4 = "2026-03-01T13:00:00.000Z";

/** Escrow driven CREATED -> FUNDED -> MILESTONE_SUBMITTED -> VERIFIED, FUND keyed. */
function goldenEscrow(id = "escrow-from-history-keys-1"): Escrow {
  const e = new Escrow(id);
  e.dispatch("FUND", "sponsor deposit", 10630, {
    at: T1,
    idempotencyKey: "fund-1",
  });
  e.dispatch("SUBMIT_MILESTONE", "creator delivers KPI bundle", undefined, {
    at: T2,
  });
  e.dispatch("VERIFY_PASS", "oracle attestation ok", undefined, { at: T3 });
  return e;
}

/** The golden escrow's history as a detached plain-JSON value. */
function goldenHistory(id?: string): EscrowHistoryEntry[] {
  return JSON.parse(JSON.stringify(goldenEscrow(id).history));
}

describe("Escrow.fromHistory(id, history, { idempotencyKeys })", () => {
  it("re-attached key replay is a no-op (state and history untouched)", () => {
    const restored = Escrow.fromHistory(
      "escrow-from-history-keys-1",
      goldenHistory(),
      { idempotencyKeys: ["fund-1"] },
    );
    assert.equal(restored.state, "VERIFIED");
    assert.equal(
      restored.dispatch("FUND", "sponsor deposit", 10630, {
        at: T4,
        idempotencyKey: "fund-1",
      }),
      "VERIFIED",
    );
    assert.equal(restored.history.length, 3);
    assert.deepEqual(
      restored.history.map((h) => h.seq),
      [1, 2, 3],
    );
  });

  it("a fresh key on the rebuilt escrow still executes", () => {
    const restored = Escrow.fromHistory(
      "escrow-from-history-keys-1",
      goldenHistory(),
      { idempotencyKeys: ["fund-1"] },
    );
    assert.equal(
      restored.dispatch("RELEASE", "pay out", undefined, {
        at: T4,
        idempotencyKey: "release-1",
      }),
      "RELEASED",
    );
    assert.equal(restored.history.length, 4);
    assert.equal(restored.history[3].seq, 4);
  });

  it("a failed dispatch does not consume the key", () => {
    const restored = Escrow.fromHistory(
      "escrow-from-history-keys-1",
      goldenHistory(),
      { idempotencyKeys: ["fund-1"] },
    );
    // FUND is illegal from VERIFIED, so the dispatch fails — and the
    // key must stay unconsumed for a later, legal dispatch.
    assert.throws(
      () =>
        restored.dispatch("FUND", "top-up", 100, {
          at: T4,
          idempotencyKey: "release-try",
        }),
      /invalid transition: FUND from VERIFIED/,
    );
    assert.equal(restored.history.length, 3);
    assert.equal(
      restored.dispatch("RELEASE", "pay out", undefined, {
        at: T4,
        idempotencyKey: "release-try",
      }),
      "RELEASED",
    );
    assert.equal(restored.history.length, 4);
  });

  it("invalid key shapes throw at construction (fromHistory opts included)", () => {
    for (const bad of ["fund-1", [""], [42], [null], [undefined]] as unknown[]) {
      assert.throws(
        () => new Escrow("bad-keys", { idempotencyKeys: bad as string[] }),
        /invalid option: idempotencyKeys/,
      );
      assert.throws(
        () =>
          Escrow.fromHistory("bad-keys", [], {
            idempotencyKeys: bad as string[],
          }),
        /invalid option: idempotencyKeys/,
      );
    }
  });

  it("duplicate keys in opts are deduped (written out once)", () => {
    const escrow = new Escrow("dedup-keys", {
      idempotencyKeys: ["a", "b", "a", "b", "c"],
    });
    assert.deepEqual(escrow.toJSON().idempotencyKeys, ["a", "b", "c"]);
  });

  it("rebuilt escrow's toJSON() writes out the re-attached keys", () => {
    const restored = Escrow.fromHistory(
      "escrow-from-history-keys-1",
      goldenHistory(),
      { idempotencyKeys: ["fund-1"] },
    );
    assert.deepEqual(restored.toJSON().idempotencyKeys, ["fund-1"]);
    restored.dispatch("RELEASE", "pay out", undefined, {
      at: T4,
      idempotencyKey: "release-1",
    });
    assert.deepEqual(restored.toJSON().idempotencyKeys, [
      "fund-1",
      "release-1",
    ]);
  });

  it("fromHistory without keys behaves as before: a consumed key re-executes", () => {
    const live = new Escrow("escrow-replay-old");
    live.dispatch("FUND", "first", 1000, {
      at: T1,
      idempotencyKey: "fund-1",
    });
    const history = JSON.parse(JSON.stringify(live.history));
    const restored = Escrow.fromHistory("escrow-replay-old", history);
    // No keys re-attached: the same key tops up again (old behavior).
    assert.equal(
      restored.dispatch("FUND", "first", 1000, {
        at: T2,
        idempotencyKey: "fund-1",
      }),
      "FUNDED",
    );
    assert.equal(restored.history.length, 2);
  });

  it("caller mutating the opts array after construction changes nothing", () => {
    const keys = ["late-key"];
    const escrow = new Escrow("mutated-opts", { idempotencyKeys: keys });
    keys.push("injected-key");
    // "injected-key" was pushed after construction: not seeded, so it
    // executes instead of no-op-ing.
    assert.equal(
      escrow.dispatch("FUND", "first", 1000, {
        at: T1,
        idempotencyKey: "injected-key",
      }),
      "FUNDED",
    );
    assert.equal(escrow.history.length, 1);
    assert.deepEqual(escrow.toJSON().idempotencyKeys, [
      "late-key",
      "injected-key",
    ]);
  });

  it("fromJSON unions opts keys with snapshot keys (neither source drops)", () => {
    const live = new Escrow("escrow-union-keys");
    live.dispatch("FUND", "first", 1000, {
      at: T1,
      idempotencyKey: "snap-key",
    });
    const snapshot = live.toJSON();
    const restored = Escrow.fromJSON(snapshot, {
      idempotencyKeys: ["opts-key"],
    });
    // Both the snapshot key and the opts key replay as no-ops.
    assert.equal(
      restored.dispatch("FUND", "first", 1000, {
        at: T2,
        idempotencyKey: "snap-key",
      }),
      "FUNDED",
    );
    assert.equal(
      restored.dispatch("FUND", "first", 1000, {
        at: T2,
        idempotencyKey: "opts-key",
      }),
      "FUNDED",
    );
    assert.equal(restored.history.length, 1);
    // A genuinely fresh key still executes.
    assert.equal(
      restored.dispatch("FUND", "top-up", 500, {
        at: T2,
        idempotencyKey: "fresh-key",
      }),
      "FUNDED",
    );
    assert.equal(restored.history.length, 2);
    assert.deepEqual(restored.toJSON().idempotencyKeys, [
      "snap-key",
      "opts-key",
      "fresh-key",
    ]);
  });

  it("empty history plus seeded keys: the seeded key is already a no-op", () => {
    const restored = Escrow.fromHistory("fresh-seeded", [], {
      idempotencyKeys: ["pre-key"],
    });
    assert.equal(restored.state, "CREATED");
    assert.equal(
      restored.dispatch("FUND", "first", 1000, {
        at: T1,
        idempotencyKey: "pre-key",
      }),
      "CREATED",
    );
    assert.equal(restored.history.length, 0);
    assert.equal(
      restored.dispatch("FUND", "first", 1000, {
        at: T1,
        idempotencyKey: "other-key",
      }),
      "FUNDED",
    );
    assert.equal(restored.history.length, 1);
  });
});
