/**
 * `SettlementEventDedupeOptions` unknown-field fail-closed (#1265).
 *
 * The constructor validated each of its three known option keys
 * (`ttlMs`, `maxEntries`, `now`) but never scanned the keys: a typo'd
 * `ttl` was silently dropped and the store fell back to the 1-hour
 * default, so a caller that believed it had pinned a 60-second
 * deduplication window actually left the replay window an hour wide;
 * a typo'd `maxEntry` likewise silently kept the 10_000-entry cap.
 * The snapshot path (`exportSnapshot` / `restore`) already rejected
 * unknown fields — the constructor was the only gap. Unknown keys
 * now throw `SettlementEventDedupe: unknown option "<key>"` before
 * any field is read, so the typo is reported as itself and no
 * instance is ever produced from a misspelled configuration.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  SettlementEventDedupe,
  type SettlementEventDedupeOptions,
} from "../src/index.js";

const TTL = 60_000;

function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** Build an options object carrying one key the type does not know. */
function withUnknownKey(key: string, value: unknown) {
  return { [key]: value } as unknown as SettlementEventDedupeOptions;
}

function assertUnknownOption(key: string, value: unknown) {
  assert.throws(
    () => new SettlementEventDedupe(withUnknownKey(key, value)),
    (err: unknown) =>
      err instanceof Error &&
      err.message ===
        `SettlementEventDedupe: unknown option "${key}"`,
  );
}

test("known key ttlMs still configures the window", () => {
  const clock = fakeClock();
  const dedupe = new SettlementEventDedupe({ ttlMs: TTL, now: clock.now });
  assert.equal(dedupe.checkAndRecord("evt-1"), false);
  clock.advance(TTL - 1);
  assert.equal(dedupe.checkAndRecord("evt-1"), true);
  clock.advance(1);
  assert.equal(dedupe.checkAndRecord("evt-1"), false);
});

test("known key maxEntries still caps the store with LRU eviction", () => {
  const clock = fakeClock();
  const dedupe = new SettlementEventDedupe({ maxEntries: 2, now: clock.now });
  assert.equal(dedupe.checkAndRecord("evt-1"), false);
  assert.equal(dedupe.checkAndRecord("evt-2"), false);
  assert.equal(dedupe.size, 2);
  assert.equal(dedupe.checkAndRecord("evt-3"), false);
  assert.equal(dedupe.size, 2);
  // The oldest id (evt-1) was evicted; evt-2 is still present, and the
  // duplicate hit refreshes its recency, so re-recording evt-1 next
  // evicts evt-3 instead.
  assert.equal(dedupe.checkAndRecord("evt-2"), true);
  assert.equal(dedupe.checkAndRecord("evt-1"), false);
  assert.equal(dedupe.checkAndRecord("evt-3"), false);
});

test("known key now still injects the clock", () => {
  const clock = fakeClock();
  const dedupe = new SettlementEventDedupe({ ttlMs: TTL, now: clock.now });
  assert.equal(dedupe.checkAndRecord("evt-1"), false);
  // The wall clock never moved; only the injected clock advances time.
  clock.advance(TTL);
  assert.equal(dedupe.checkAndRecord("evt-1"), false);
});

test("typo'd ttl is rejected with the exact message", () => {
  assertUnknownOption("ttl", 60_000);
});

test("typo'd maxEntry is rejected with the exact message", () => {
  assertUnknownOption("maxEntry", 100);
});

test("case-variant ttlms is rejected, keys are case-sensitive", () => {
  assertUnknownOption("ttlms", 60_000);
});

test("case-variant maxentries is rejected, keys are case-sensitive", () => {
  assertUnknownOption("maxentries", 100);
});

test("typo'd nowMs is rejected with the exact message", () => {
  assertUnknownOption("nowMs", () => 1_000_000);
});

test("unknown key is reported before any known key is validated", () => {
  // Both keys are wrong, but the unknown-key error must win: the scan
  // runs before the ttlMs positivity check reads anything.
  assert.throws(
    () =>
      new SettlementEventDedupe({
        ttl: 60_000,
        ttlMs: -1,
      } as unknown as SettlementEventDedupeOptions),
    (err: unknown) =>
      err instanceof Error &&
      err.message === 'SettlementEventDedupe: unknown option "ttl"',
  );
});

test("a rejected construction produces no instance to observe", () => {
  // The constructor throws before assigning any field, so nothing
  // escapes the failed construction; a fresh valid construction
  // afterwards behaves exactly as if the failed one never happened.
  assert.throws(
    () => new SettlementEventDedupe(withUnknownKey("ttl", 60_000)),
    /SettlementEventDedupe: unknown option "ttl"/,
  );
  const clock = fakeClock();
  const dedupe = new SettlementEventDedupe({ ttlMs: TTL, now: clock.now });
  assert.equal(dedupe.size, 0);
  assert.equal(dedupe.checkAndRecord("evt-1"), false);
  assert.equal(dedupe.checkAndRecord("evt-1"), true);
});

test("omitted options keep the 1-hour default TTL", () => {
  const clock = fakeClock();
  const dedupe = new SettlementEventDedupe({ now: clock.now });
  assert.equal(dedupe.checkAndRecord("evt-1"), false);
  clock.advance(3_600_000 - 1);
  assert.equal(dedupe.checkAndRecord("evt-1"), true);
  clock.advance(1);
  assert.equal(dedupe.checkAndRecord("evt-1"), false);
});

test("omitted options keep the 10_000-entry default cap", () => {
  const clock = fakeClock();
  const dedupe = new SettlementEventDedupe({ now: clock.now });
  for (let i = 0; i < 10_000; i++) {
    assert.equal(dedupe.checkAndRecord(`evt-${i}`), false);
  }
  assert.equal(dedupe.size, 10_000);
  assert.equal(dedupe.checkAndRecord("evt-10000"), false);
  assert.equal(dedupe.size, 10_000);
  // The oldest id was evicted under the default cap.
  assert.equal(dedupe.checkAndRecord("evt-0"), false);
  assert.equal(dedupe.checkAndRecord("evt-9999"), true);
});

test("snapshot export/restore behaviour is unchanged, restore rejects unknown opts", () => {
  const clock = fakeClock();
  const dedupe = new SettlementEventDedupe({ ttlMs: TTL, now: clock.now });
  assert.equal(dedupe.checkAndRecord("evt-1"), false);
  assert.equal(dedupe.checkAndRecord("evt-2"), false);
  const snapshot = dedupe.exportSnapshot();
  const restored = SettlementEventDedupe.restore(snapshot, {
    ttlMs: TTL,
    now: clock.now,
  });
  assert.equal(restored.checkAndRecord("evt-1"), true);
  assert.equal(restored.checkAndRecord("evt-2"), true);
  assert.equal(restored.checkAndRecord("evt-3"), false);
  // Restore routes through the constructor, so it inherits the guard.
  assert.throws(
    () =>
      SettlementEventDedupe.restore(snapshot, withUnknownKey("ttl", 60_000)),
    (err: unknown) =>
      err instanceof Error &&
      err.message === 'SettlementEventDedupe: unknown option "ttl"',
  );
});
