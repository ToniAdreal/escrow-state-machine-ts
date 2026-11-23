import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  approvalStatement,
  createQuorum,
  restoreQuorum,
} from "../src/index.js";

const SIGNERS = ["dao-1", "dao-2", "dao-3"];

/** Mutable clock: the test sets `clock.current` to move time explicitly. */
function mutableClock(startMs: number): {
  now: () => number;
  current: number;
} {
  const clock = { now: () => clock.current, current: startMs };
  return clock;
}

const CLOCK_ERROR =
  /quorum: now must return a finite number of milliseconds since the epoch, got /;

function badClockQuorum(
  badNow: () => number,
  extra: Record<string, unknown> = {}
) {
  return createQuorum({
    threshold: 2,
    signers: SIGNERS,
    maxApprovalAgeMs: 60_000,
    now: badNow,
    ...extra,
  });
}

test("NaN clock: approve fails closed with the pinned error and records nothing", () => {
  const q = badClockQuorum(() => NaN);
  assert.throws(() => q.approve("dao-1"), /got NaN/);
  assert.throws(() => q.approve("dao-1"), CLOCK_ERROR);
  assert.deepStrictEqual(q.approvalLog(), []);
  assert.deepStrictEqual(q.snapshot().approvals, []);
  assert.equal(q.approvalCount(), 0);
});

test("Infinity and -Infinity clocks: approve fails closed and records nothing", () => {
  for (const bad of [Infinity, -Infinity]) {
    const q = badClockQuorum(() => bad);
    assert.throws(() => q.approve("dao-1"), new RegExp(`got ${bad}`));
    assert.deepStrictEqual(q.approvalLog(), []);
    assert.deepStrictEqual(q.snapshot().approvals, []);
  }
});

test("non-number clock: approve fails closed and records nothing", () => {
  const q = badClockQuorum(() => "yesterday" as never);
  assert.throws(() => q.approve("dao-1"), /got yesterday/);
  assert.deepStrictEqual(q.approvalLog(), []);
  const q2 = badClockQuorum(() => undefined as never);
  assert.throws(() => q2.approve("dao-1"), /got undefined/);
  assert.deepStrictEqual(q2.approvalLog(), []);
});

test("a bad clock never silently locks the quorum: reads throw instead of reporting zero", () => {
  const clock = mutableClock(1_000);
  const q = createQuorum({
    threshold: 2,
    signers: SIGNERS,
    maxApprovalAgeMs: 60_000,
    now: clock.now,
  });
  q.approve("dao-1");
  q.approve("dao-2");
  assert.equal(q.hasQuorum(), true);
  assert.equal(q.approvalCount(), 2);
  // The clock goes bad after two valid approvals were recorded.
  clock.current = NaN;
  assert.throws(() => q.hasQuorum(), /got NaN/);
  assert.throws(() => q.approvalCount(), CLOCK_ERROR);
  assert.throws(() => q.approvals(), CLOCK_ERROR);
  assert.throws(() => q.remainingApprovals(), CLOCK_ERROR);
  // The audit trail itself is untouched and still readable: the
  // entries were recorded with good timestamps, so approvalLog and
  // snapshot never throw a bare RangeError.
  assert.deepStrictEqual(q.approvalLog(), [
    { signerId: "dao-1", at: new Date(1_000).toISOString() },
    { signerId: "dao-2", at: new Date(1_000).toISOString() },
  ]);
  assert.equal(q.snapshot().approvals.length, 2);
});

test("a bad clock from birth leaves approvalLog/snapshot readable, never a RangeError", () => {
  const q = badClockQuorum(() => NaN);
  assert.throws(() => q.approve("dao-1"), CLOCK_ERROR);
  assert.doesNotThrow(() => q.approvalLog());
  assert.doesNotThrow(() => q.snapshot());
  assert.deepStrictEqual(q.approvalLog(), []);
  assert.deepStrictEqual(q.snapshot().approvals, []);
});

test("a clock that recovers: the failed approve leaves no residue and the retry succeeds", () => {
  const clock = mutableClock(NaN);
  const q = createQuorum({
    threshold: 1,
    signers: SIGNERS,
    maxApprovalAgeMs: 60_000,
    now: clock.now,
  });
  assert.throws(() => q.approve("dao-1"), /got NaN/);
  assert.deepStrictEqual(q.approvalLog(), []);
  clock.current = 5_000;
  q.approve("dao-1");
  assert.equal(q.approvalCount(), 1);
  assert.deepStrictEqual(q.approvalLog(), [
    { signerId: "dao-1", at: new Date(5_000).toISOString() },
  ]);
});

test("approveSigned with a bad clock throws the clock error, not a signature error", () => {
  const pair = generateKeyPairSync("ed25519");
  const q = badClockQuorum(() => NaN, {
    signerPublicKeys: { "dao-1": pair.publicKey },
  });
  const sig = sign(null, approvalStatement("dao-1"), pair.privateKey);
  assert.throws(() => q.approveSigned("dao-1", sig), CLOCK_ERROR);
  assert.throws(() => q.approveSigned("dao-1", sig), /got NaN/);
  assert.deepStrictEqual(q.approvalLog(), []);
  assert.equal(q.approvalCount(), 0);
});

test("approveSigned upgrade path with a bad clock throws and leaves the entry untouched", () => {
  const clock = mutableClock(1_000);
  const pair = generateKeyPairSync("ed25519");
  const q = createQuorum({
    threshold: 1,
    signers: SIGNERS,
    maxApprovalAgeMs: 60_000,
    now: clock.now,
    signerPublicKeys: { "dao-1": pair.publicKey },
  });
  q.approve("dao-1", "gov-prop-9");
  clock.current = NaN;
  const sig = sign(null, approvalStatement("dao-1"), pair.privateKey);
  assert.throws(() => q.approveSigned("dao-1", sig), CLOCK_ERROR);
  // No upgrade, no new entry, no residue.
  assert.deepStrictEqual(q.approvalLog(), [
    { signerId: "dao-1", at: new Date(1_000).toISOString(), evidence: "gov-prop-9" },
  ]);
});

test("re-approving a counted signer with a bad clock throws instead of silently no-op", () => {
  const clock = mutableClock(1_000);
  const q = createQuorum({
    threshold: 2,
    signers: SIGNERS,
    maxApprovalAgeMs: 60_000,
    now: clock.now,
  });
  q.approve("dao-1");
  clock.current = Infinity;
  assert.throws(() => q.approve("dao-1"), /got Infinity/);
  assert.equal(q.approvalLog().length, 1);
  assert.deepStrictEqual(q.approvalLog(), [
    { signerId: "dao-1", at: new Date(1_000).toISOString() },
  ]);
});

test("good clock behavior is unchanged: window expiry still counts and re-approval refreshes", () => {
  const clock = mutableClock(1_000);
  const q = createQuorum({
    threshold: 2,
    signers: SIGNERS,
    maxApprovalAgeMs: 60_000,
    now: clock.now,
  });
  q.approve("dao-1");
  q.approve("dao-2");
  assert.equal(q.hasQuorum(), true);
  clock.current = 61_001; // both approvals expired (age 60_001 > 60_000)
  assert.equal(q.approvalCount(), 0);
  assert.equal(q.hasQuorum(), false);
  q.approve("dao-1");
  assert.equal(q.approvalCount(), 1);
  assert.deepStrictEqual(q.approvalLog(), [
    { signerId: "dao-1", at: new Date(1_000).toISOString() },
    { signerId: "dao-2", at: new Date(1_000).toISOString() },
    { signerId: "dao-1", at: new Date(61_001).toISOString() },
  ]);
});

test("no-window quorum: a bad clock still fails at approve, never records NaN", () => {
  const q = createQuorum({ threshold: 1, signers: SIGNERS, now: () => NaN });
  assert.throws(() => q.approve("dao-1"), CLOCK_ERROR);
  assert.deepStrictEqual(q.approvalLog(), []);
  assert.doesNotThrow(() => q.snapshot());
});

test("restoreQuorum with a bad clock: restored log stays readable, fresh approve fails closed", () => {
  const clock = mutableClock(1_000);
  const q = createQuorum({
    threshold: 1,
    signers: SIGNERS,
    maxApprovalAgeMs: 60_000,
    now: clock.now,
  });
  q.approve("dao-1");
  const snapshot = q.snapshot();
  const restored = restoreQuorum(
    {
      threshold: 1,
      signers: SIGNERS,
      maxApprovalAgeMs: 60_000,
      now: () => NaN,
    },
    snapshot
  );
  // Restored entries carry finite timestamps from the snapshot.
  assert.deepStrictEqual(restored.approvalLog(), q.approvalLog());
  // But any read that consults the clock fails closed, never
  // silently reports the restored approval as expired.
  assert.throws(() => restored.approvalCount(), CLOCK_ERROR);
  assert.throws(() => restored.hasQuorum(), CLOCK_ERROR);
  // And a fresh approve on the restored quorum fails before recording.
  assert.throws(() => restored.approve("dao-2"), CLOCK_ERROR);
  assert.deepStrictEqual(restored.approvalLog(), q.approvalLog());
});
