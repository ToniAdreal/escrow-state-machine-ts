import { test } from "node:test";
import assert from "node:assert/strict";
import { createQuorum } from "../src/quorum.js";

const FIVE_OF_NINE = {
  threshold: 5,
  signers: [
    "dao-1", "dao-2", "dao-3", "dao-4", "dao-5",
    "dao-6", "dao-7", "dao-8", "dao-9",
  ],
};

/** Deterministic clock: each call returns the next value from `ticks`. */
function scriptedClock(ticks: number[]): () => number {
  let i = 0;
  return () => ticks[Math.min(i++, ticks.length - 1)];
}

test("injected clock: timestamps are recorded exactly", () => {
  const q = createQuorum({ ...FIVE_OF_NINE, now: scriptedClock([1_000, 2_000, 3_000]) });
  q.approve("dao-1");
  q.approve("dao-2");
  q.approve("dao-3");
  assert.deepStrictEqual(q.approvalLog(), [
    { signerId: "dao-1", at: new Date(1_000).toISOString() },
    { signerId: "dao-2", at: new Date(2_000).toISOString() },
    { signerId: "dao-3", at: new Date(3_000).toISOString() },
  ]);
});

test("revoke removes the signer's log entry", () => {
  const q = createQuorum({ ...FIVE_OF_NINE, now: scriptedClock([1_000, 2_000, 3_000]) });
  q.approve("dao-1");
  q.approve("dao-2");
  q.approve("dao-3");
  q.revoke("dao-2");
  assert.deepStrictEqual(
    q.approvalLog().map((e) => e.signerId),
    ["dao-1", "dao-3"]
  );
  assert.strictEqual(q.approvalLog().length, q.approvalCount());
  assert.deepStrictEqual(q.approvals(), ["dao-1", "dao-3"]);
});

test("re-approve is idempotent: no second entry, original timestamp kept", () => {
  const q = createQuorum({ ...FIVE_OF_NINE, now: scriptedClock([1_000, 2_000]) });
  q.approve("dao-1");
  q.approve("dao-1"); // clock has advanced to 2000 but approval is a no-op
  assert.deepStrictEqual(q.approvalLog(), [
    { signerId: "dao-1", at: new Date(1_000).toISOString() },
  ]);
});

test("approve after revoke records a fresh timestamp at the end", () => {
  const q = createQuorum({
    ...FIVE_OF_NINE,
    now: scriptedClock([1_000, 2_000, 3_000]),
  });
  q.approve("dao-1");
  q.approve("dao-2");
  q.revoke("dao-1");
  q.approve("dao-1");
  assert.deepStrictEqual(q.approvalLog(), [
    { signerId: "dao-2", at: new Date(2_000).toISOString() },
    { signerId: "dao-1", at: new Date(3_000).toISOString() },
  ]);
});

test("default clock uses wall time", () => {
  const q = createQuorum(FIVE_OF_NINE);
  const before = Date.now();
  q.approve("dao-7");
  const after = Date.now();
  const [entry] = q.approvalLog();
  assert.strictEqual(entry.signerId, "dao-7");
  const ms = Date.parse(entry.at);
  assert.ok(Number.isFinite(ms), "at must parse as a date");
  assert.ok(before <= ms && ms <= after, "at must fall between before/after");
});

test("approvalLog returns a detached copy", () => {
  const q = createQuorum({ ...FIVE_OF_NINE, now: scriptedClock([1_000]) });
  q.approve("dao-1");
  const seen = q.approvalLog() as unknown as Array<{ signerId: string; at: string }>;
  seen.push({ signerId: "dao-9", at: "x" });
  seen[0].at = "tampered";
  assert.strictEqual(q.approvalCount(), 1);
  assert.deepStrictEqual(q.approvalLog(), [
    { signerId: "dao-1", at: new Date(1_000).toISOString() },
  ]);
  assert.deepStrictEqual(q.approvals(), ["dao-1"]);
});

test("invalid now config throws", () => {
  assert.throws(
    () =>
      createQuorum({ ...FIVE_OF_NINE, now: "later" as unknown as () => number }),
    /now must be a function/
  );
});
