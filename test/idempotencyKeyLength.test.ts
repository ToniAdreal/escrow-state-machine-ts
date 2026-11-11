/**
 * `MAX_IDEMPOTENCY_KEY_LENGTH` (256) enforcement on all three key gates
 * (backlog #1064).
 *
 * Dispatch idempotency keys were only checked for non-emptiness, so a
 * caller could pass a multi-megabyte string and have it written verbatim
 * into the consumed-key set and, through it, into every snapshot that
 * persists that set (#138). All three gates now enforce a 256-character
 * ceiling — a key is a short identifier (a UUID is 36 characters), so
 * 256 leaves orders of magnitude of headroom — with the same wording
 * (`idempotencyKey(s) … must be at most 256 characters, got N`),
 * rejecting oversized keys outright instead of truncating them
 * (truncation would change which deliveries a key dedupes). The
 * dispatch gate covers live consumption, constructor seeding covers
 * `new Escrow(id, { idempotencyKeys })` (and, through it,
 * `Escrow.fromHistory` and the `opts` union on `Escrow.fromJSON`),
 * and the snapshot parser covers `fromJSON` restores.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { Escrow, MAX_IDEMPOTENCY_KEY_LENGTH } from "../src/index.js";

function overlongKey(): string {
  return "k".repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1);
}

function atLimitKey(): string {
  return "k".repeat(MAX_IDEMPOTENCY_KEY_LENGTH);
}

function fundedEscrow(id: string): Escrow {
  const e = new Escrow(id);
  e.dispatch("FUND", "initial deposit", 100);
  return e;
}

// --- dispatch gate ---

test("dispatch rejects a key longer than MAX_IDEMPOTENCY_KEY_LENGTH with zero residue", () => {
  assert.equal(MAX_IDEMPOTENCY_KEY_LENGTH, 256);
  const e = new Escrow("e-cap-dispatch");
  assert.throws(
    () =>
      e.dispatch("FUND", "initial deposit", 100, {
        idempotencyKey: overlongKey(),
      }),
    /invalid dispatch options: idempotencyKey must be at most 256 characters, got 257/
  );
  assert.equal(e.state, "CREATED");
  assert.equal(e.history.length, 0);
  // The rejected key was not consumed: the same event with a short key
  // succeeds, and the overlong key still reports the length error
  // (it was never recorded as a seen key).
  assert.equal(
    e.dispatch("FUND", "initial deposit", 100, { idempotencyKey: "fund-1" }),
    "FUNDED"
  );
  assert.equal(e.history.length, 1);
  assert.throws(
    () =>
      e.dispatch("FUND", "top-up", 50, { idempotencyKey: overlongKey() }),
    /invalid dispatch options: idempotencyKey must be at most 256 characters, got 257/
  );
  assert.equal(e.history.length, 1);
});

test("dispatch accepts a key of exactly MAX_IDEMPOTENCY_KEY_LENGTH and dedupes on it", () => {
  const e = new Escrow("e-cap-at-limit");
  assert.equal(
    e.dispatch("FUND", "initial deposit", 100, {
      idempotencyKey: atLimitKey(),
    }),
    "FUNDED"
  );
  assert.equal(
    e.dispatch("FUND", "initial deposit", 100, {
      idempotencyKey: atLimitKey(),
    }),
    "FUNDED"
  );
  assert.equal(e.history.length, 1);
});

test("dispatch with short keys is unchanged", () => {
  const e = new Escrow("e-cap-short");
  e.dispatch("FUND", "first", 1000, { idempotencyKey: "k-1" });
  e.dispatch("FUND", "top-up", 630, { idempotencyKey: "k-2" });
  assert.equal(e.history.length, 2);
  assert.equal(e.state, "FUNDED");
});

// --- constructor seeding gate ---

test("constructor seeding rejects an overlong key", () => {
  assert.throws(
    () => new Escrow("e-cap-seed", { idempotencyKeys: [overlongKey()] }),
    /invalid option: idempotencyKeys entries must be at most 256 characters, got 257/
  );
});

test("constructor seeding accepts an at-limit key and dedupes on it", () => {
  const e = new Escrow("e-cap-seed-ok", { idempotencyKeys: [atLimitKey()] });
  assert.equal(
    e.dispatch("FUND", "initial deposit", 100, {
      idempotencyKey: atLimitKey(),
    }),
    "CREATED"
  );
  assert.equal(e.history.length, 0);
});

// --- snapshot parser gate ---

test("snapshot parsing rejects an overlong key", () => {
  const snapshot = {
    ...fundedEscrow("e-cap-snapshot").toJSON(),
    idempotencyKeys: [overlongKey()],
  };
  assert.throws(
    () => Escrow.fromJSON(snapshot),
    /invalid snapshot: idempotencyKeys entries must be at most 256 characters, got 257/
  );
});

test("snapshot round-trip carries an at-limit key and a replay stays a no-op", () => {
  const e = new Escrow("e-cap-roundtrip");
  e.dispatch("FUND", "initial deposit", 100, {
    idempotencyKey: atLimitKey(),
  });
  const snapshot = e.toJSON();
  assert.deepEqual(snapshot.idempotencyKeys, [atLimitKey()]);
  const restored = Escrow.fromJSON(snapshot);
  assert.equal(
    restored.dispatch("FUND", "initial deposit", 100, {
      idempotencyKey: atLimitKey(),
    }),
    "FUNDED"
  );
  assert.equal(restored.history.length, 1);
});

// --- fromHistory gate (via the constructor) ---

test("fromHistory seeding rejects an overlong key", () => {
  const source = fundedEscrow("e-cap-from-history");
  assert.throws(
    () =>
      Escrow.fromHistory("e-cap-from-history", source.history, {
        idempotencyKeys: [overlongKey()],
      }),
    /invalid option: idempotencyKeys entries must be at most 256 characters, got 257/
  );
});

test("fromHistory seeding accepts an at-limit key and dedupes on it", () => {
  const source = fundedEscrow("e-cap-from-history-ok");
  const rebuilt = Escrow.fromHistory("e-cap-from-history-ok", source.history, {
    idempotencyKeys: [atLimitKey()],
  });
  assert.equal(
    rebuilt.dispatch("FUND", "initial deposit", 100, {
      idempotencyKey: atLimitKey(),
    }),
    "FUNDED"
  );
  assert.equal(rebuilt.history.length, 1);
});

// --- fromJSON explicit-opts union gate ---

test("fromJSON with an overlong explicit opts key rejects via the constructor tag", () => {
  const snapshot = fundedEscrow("e-cap-fromjson-opts").toJSON();
  assert.throws(
    () =>
      Escrow.fromJSON(snapshot, { idempotencyKeys: [overlongKey()] }),
    /invalid option: idempotencyKeys entries must be at most 256 characters, got 257/
  );
});
