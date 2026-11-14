import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  stateAtFromHistory,
  type EscrowHistoryEntry,
} from "../src/index.js";

/**
 * `stateAt(time)` / `stateAtFromHistory(history, time, auditKey?)`
 * (backlog #1134): read-only time travel over the append-only audit
 * history. Mirrors dataquest #1130 (`TaskLifecycle.stateAt`).
 *
 * Rules under test:
 *  - the state at a moment is the `to` of the last entry at or before it
 *  - the boundary is inclusive: a query exactly on an entry's `at` sees
 *    that entry's effect (same boundary isOverdue uses)
 *  - a time before the first entry returns the initial state, "CREATED"
 *  - a time after the last entry returns the final state
 *  - a Date and the same moment as a string agree
 *  - an invalid time throws `invalid stateAt time: …` before anything
 *    is read; a broken history throws `invalid snapshot: …`
 *  - the pure function and the instance method agree on every probe
 *  - the query is a pure read: state/history untouched, dispatching
 *    afterwards continues at the next seq
 *  - an empty history replays to "CREATED" at any time
 *  - a keyed (HMAC) chain needs its auditKey, like rehydration does
 */

const T10 = "2026-03-01T10:00:00.000Z";
const T11 = "2026-03-01T11:00:00.000Z";
const T12 = "2026-03-01T12:00:00.000Z";
const T13 = "2026-03-01T13:00:00.000Z";

/** FUND @10:00, SUBMIT_MILESTONE @11:00, VERIFY_PASS @12:00, RELEASE @13:00. */
function buildEscrow(): Escrow {
  const escrow = new Escrow("escrow-stateat-042");
  escrow.dispatch("FUND", "deposit", 500, { at: T10 });
  escrow.dispatch("SUBMIT_MILESTONE", undefined, undefined, { at: T11 });
  escrow.dispatch("VERIFY_PASS", undefined, undefined, { at: T12 });
  escrow.dispatch("RELEASE", undefined, undefined, { at: T13 });
  return escrow;
}

test("stateAt: a moment between entries returns the intermediate state", () => {
  const escrow = buildEscrow();
  assert.equal(escrow.stateAt("2026-03-01T10:30:00.000Z"), "FUNDED");
  assert.equal(
    escrow.stateAt("2026-03-01T11:30:00.000Z"),
    "MILESTONE_SUBMITTED",
  );
  assert.equal(escrow.stateAt("2026-03-01T12:30:00.000Z"), "VERIFIED");
});

test("stateAt: a moment after the last entry returns the final state", () => {
  const escrow = buildEscrow();
  assert.equal(escrow.stateAt("2026-03-02T00:00:00.000Z"), "RELEASED");
  assert.equal(
    escrow.stateAt(new Date("2027-01-01T00:00:00.000Z")),
    "RELEASED",
  );
});

test("stateAt: a moment before the first entry returns the initial state", () => {
  const escrow = buildEscrow();
  assert.equal(escrow.stateAt("2026-03-01T09:59:59.999Z"), "CREATED");
  assert.equal(escrow.stateAt("2026-01-01T00:00:00.000Z"), "CREATED");
});

test("stateAt: a query exactly on an entry timestamp sees that entry's effect", () => {
  const escrow = buildEscrow();
  assert.equal(escrow.stateAt(T10), "FUNDED");
  assert.equal(escrow.stateAt(T11), "MILESTONE_SUBMITTED");
  assert.equal(escrow.stateAt(T12), "VERIFIED");
  assert.equal(escrow.stateAt(T13), "RELEASED");
});

test("stateAt: a Date and the same moment as a string agree", () => {
  const escrow = buildEscrow();
  for (const probe of [T10, T11, T12, T13, "2026-03-01T11:30:00.000Z"]) {
    assert.equal(
      escrow.stateAt(new Date(probe)),
      escrow.stateAt(probe),
      `probe ${probe}`,
    );
  }
});

test("stateAt: invalid times throw before anything is read", () => {
  const escrow = buildEscrow();
  const bad: unknown[] = [
    "not-a-date",
    "2026-13-01T10:00:00.000Z",
    new Date(Number.NaN),
    1772342400000,
    null,
    undefined,
    {},
  ];
  for (const time of bad) {
    assert.throws(
      () => escrow.stateAt(time as never),
      /invalid stateAt time: expected a valid Date or ISO-8601 string/,
      `time=${String(time)}`,
    );
    assert.throws(
      () => stateAtFromHistory(escrow.history, time as never),
      /invalid stateAt time: expected a valid Date or ISO-8601 string/,
      `pure time=${String(time)}`,
    );
  }
  assert.equal(escrow.state, "RELEASED");
  assert.equal(escrow.history.length, 4);
});

test("stateAtFromHistory: a broken history throws instead of guessing a state", () => {
  const escrow = buildEscrow();
  const broken = escrow.history.map((entry) => ({ ...entry }));
  // Break the chain: entry 2 claims to start from CREATED, not FUNDED.
  (broken[1] as EscrowHistoryEntry).from = "CREATED";
  assert.throws(
    () => stateAtFromHistory(broken, T12),
    /invalid snapshot: history\[1\]: from CREATED does not continue previous to FUNDED/,
  );
  // A truncated log (missing the final entries) is a different break.
  const truncated = escrow.history.slice(0, 2).map((entry) => ({ ...entry }));
  (truncated[1] as EscrowHistoryEntry).seq = 3;
  assert.throws(
    () => stateAtFromHistory(truncated, T12),
    /invalid snapshot: history\[1\]: seq must be 2, got 3/,
  );
});

test("stateAtFromHistory: pure function and instance method agree on every probe", () => {
  const escrow = buildEscrow();
  const probes = [
    "2026-02-28T23:59:59.999Z",
    T10,
    "2026-03-01T10:00:00.001Z",
    T11,
    "2026-03-01T11:59:59.999Z",
    T12,
    T13,
    "2026-03-01T13:00:00.001Z",
    "2026-04-01T00:00:00.000Z",
  ];
  for (const probe of probes) {
    assert.equal(
      stateAtFromHistory(escrow.history, probe),
      escrow.stateAt(probe),
      `probe ${probe}`,
    );
  }
  // The pure form also works on a plain JSON round-trip of the log.
  const log = JSON.parse(JSON.stringify(escrow.history)) as unknown;
  assert.equal(stateAtFromHistory(log, T12), "VERIFIED");
});

test("stateAt: the query is a pure read — dispatching afterwards continues", () => {
  const escrow = new Escrow("escrow-stateat-pure");
  escrow.dispatch("FUND", "deposit", 500, { at: T10 });
  escrow.dispatch("SUBMIT_MILESTONE", undefined, undefined, { at: T11 });
  escrow.dispatch("VERIFY_PASS", undefined, undefined, { at: T12 });
  assert.equal(escrow.stateAt(T11), "MILESTONE_SUBMITTED");
  assert.equal(escrow.state, "VERIFIED");
  assert.equal(escrow.history.length, 3);
  escrow.dispatch("RELEASE", undefined, undefined, {
    at: "2026-03-01T14:00:00.000Z",
  });
  assert.equal(escrow.state, "RELEASED");
  assert.equal(escrow.history.length, 4);
  assert.equal(escrow.history[3].seq, 4);
  assert.equal(escrow.stateAt(T12), "VERIFIED");
  assert.equal(escrow.stateAt("2026-03-01T14:00:00.000Z"), "RELEASED");
});

test("stateAtFromHistory: an empty history is CREATED at any time", () => {
  assert.equal(stateAtFromHistory([], T10), "CREATED");
  assert.equal(stateAtFromHistory([], "2027-01-01T00:00:00.000Z"), "CREATED");
  const fresh = new Escrow("escrow-stateat-fresh");
  assert.equal(fresh.stateAt(T10), "CREATED");
  assert.equal(fresh.stateAt(new Date()), "CREATED");
});

test("stateAt: two entries at the same timestamp both count (non-decreasing)", () => {
  const escrow = new Escrow("escrow-stateat-same-at");
  escrow.dispatch("FUND", "deposit", 500, { at: T10 });
  escrow.dispatch("SUBMIT_MILESTONE", undefined, undefined, { at: T10 }); // equal timestamps are legal
  assert.equal(escrow.stateAt(T10), "MILESTONE_SUBMITTED");
  assert.equal(escrow.stateAt("2026-03-01T09:59:59.999Z"), "CREATED");
});

test("stateAtFromHistory: a keyed chain needs its auditKey, like rehydration", () => {
  const keyed = new Escrow("escrow-stateat-keyed", { auditKey: "s3cr3t" });
  keyed.dispatch("FUND", "deposit", 500, { at: T10 });
  keyed.dispatch("SUBMIT_MILESTONE", undefined, undefined, { at: T11 });
  const log = JSON.parse(JSON.stringify(keyed.history)) as unknown;
  assert.equal(
    stateAtFromHistory(log, "2026-03-01T10:30:00.000Z", "s3cr3t"),
    "FUNDED",
  );
  assert.equal(stateAtFromHistory(log, T11, "s3cr3t"), "MILESTONE_SUBMITTED");
  // No key (or the wrong one) on a keyed chain is fail-closed.
  assert.throws(
    () => stateAtFromHistory(log, T11),
    /invalid snapshot: history hash chain is broken/,
  );
  assert.throws(
    () => stateAtFromHistory(log, T11, "wrong-audit-key"),
    /invalid snapshot: history hash chain is broken/,
  );
});
