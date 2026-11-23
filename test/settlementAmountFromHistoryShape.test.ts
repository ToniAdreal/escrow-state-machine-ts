/**
 * Settlement-amount history shape guards (backlog #1359).
 *
 * `depositAmountFromHistory` and `releasedAmountFromHistory` both started
 * by reading their `history` argument with no array check, so a null
 * history surfaced a bare `TypeError` (`Cannot read properties of null
 * (reading 'filter')` / `history is not iterable`) — and a string history
 * was worse for the release reader: iterating a string yields its
 * characters, none of them a PARTIAL_RELEASE entry, so the function
 * silently returned 0 for a caller bug. Both readers are the settlement
 * report's amount source (the FUND total a report corroborates against,
 * and the paid-out tranche total), so a caller passing the wrong shape
 * deserves a named error at the entry point, not a bare TypeError or a
 * silently empty paid-out total. Both guards use the same wording the
 * batch entry points already use (`invalid <fn>: history must be an
 * array`, #1343/#1358) and run before any label validation or scan.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  depositAmountFromHistory,
  releasedAmountFromHistory,
} from "../src/index.js";

const BAD_HISTORIES: Array<[unknown, string]> = [
  [null, "null"],
  ["x", "string"],
  [42, "number"],
  [{}, "object"],
];

function fundedEscrow(id: string, amount = 10630): Escrow {
  const e = new Escrow(id);
  e.dispatch("FUND", "deposit", amount);
  return e;
}

function assertNamedShapeError(
  fn: () => unknown,
  expectedMessage: string,
): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof Error, "must throw an Error");
    assert.ok(
      !(error instanceof TypeError),
      "must be a named Error, not a bare TypeError",
    );
    assert.equal(error.message, expectedMessage);
    return true;
  });
}

test("depositAmountFromHistory rejects a non-array history with a named error", () => {
  for (const [bad, got] of BAD_HISTORIES) {
    assertNamedShapeError(
      () => depositAmountFromHistory(bad as never),
      `invalid depositAmountFromHistory: history must be an array, got ${got}`,
    );
  }
});

test("releasedAmountFromHistory rejects a non-array history with a named error", () => {
  for (const [bad, got] of BAD_HISTORIES) {
    assertNamedShapeError(
      () => releasedAmountFromHistory(bad as never),
      `invalid releasedAmountFromHistory: history must be an array, got ${got}`,
    );
  }
});

test("releasedAmountFromHistory no longer silently returns 0 for a string history", () => {
  // A string history used to iterate its characters, find no
  // PARTIAL_RELEASE entry, and return 0 — the same silently-empty
  // answer as a genuinely unreleased escrow. It now throws.
  assertNamedShapeError(
    () => releasedAmountFromHistory("x" as never),
    "invalid releasedAmountFromHistory: history must be an array, got string",
  );
});

test("depositAmountFromHistory reads a single FUND amount", () => {
  const e = fundedEscrow("amt-1");
  assert.equal(depositAmountFromHistory(e.history, e.id), 10630);
});

test("depositAmountFromHistory sums the initial FUND plus top-ups", () => {
  const e = new Escrow("amt-2");
  e.dispatch("FUND", "initial wire", 10630);
  e.dispatch("FUND", "top-up wire", 2000);
  assert.equal(depositAmountFromHistory(e.history, e.id), 12630);
});

test("releasedAmountFromHistory returns 0 with no PARTIAL_RELEASE event", () => {
  const e = fundedEscrow("amt-3");
  assert.equal(releasedAmountFromHistory(e.history, e.id), 0);
});

test("releasedAmountFromHistory sums two tranches", () => {
  const e = fundedEscrow("amt-4");
  e.dispatch("PARTIAL_RELEASE", "tranche 1", 4252);
  e.dispatch("PARTIAL_RELEASE", "tranche 2", 6378);
  assert.equal(releasedAmountFromHistory(e.history, e.id), 10630);
  assert.equal(depositAmountFromHistory(e.history, e.id), 10630);
});

test("depositAmountFromHistory still throws its named error for a history with no FUND event", () => {
  assertNamedShapeError(
    () => depositAmountFromHistory([], "esc-ghost"),
    "settlement requires a FUND amount for esc-ghost: no FUND event in the audit history",
  );
});

test("depositAmountFromHistory still throws its named error when a FUND entry has no amount", () => {
  const e = new Escrow("amt-5");
  e.dispatch("FUND");
  assertNamedShapeError(
    () => depositAmountFromHistory(e.history, e.id),
    "settlement requires a FUND amount for amt-5: a FUND event was recorded without an amount",
  );
});

test("releasedAmountFromHistory still throws its named error when a PARTIAL_RELEASE entry has no amount", () => {
  const e = fundedEscrow("amt-6");
  e.dispatch("PARTIAL_RELEASE", "tranche 1", 4252);
  const stripped = e.history.map((entry) =>
    entry.event === "PARTIAL_RELEASE"
      ? { ...entry, amount: undefined }
      : entry,
  );
  assertNamedShapeError(
    () => releasedAmountFromHistory(stripped, e.id),
    "settlement requires a PARTIAL_RELEASE amount for amt-6: a PARTIAL_RELEASE event was recorded without an amount",
  );
});

test("the history guard runs before the escrowId label validation", () => {
  // Both inputs are wrong; the shape error must win over the label
  // error, so the caller learns the argument shape is wrong first.
  assertNamedShapeError(
    () => depositAmountFromHistory(null as never, ""),
    "invalid depositAmountFromHistory: history must be an array, got null",
  );
  assertNamedShapeError(
    () => releasedAmountFromHistory(null as never, ""),
    "invalid releasedAmountFromHistory: history must be an array, got null",
  );
});

test("a valid escrowId still labels the no-FUND error after the guard", () => {
  assertNamedShapeError(
    () => depositAmountFromHistory([], "esc-ghost"),
    "settlement requires a FUND amount for esc-ghost: no FUND event in the audit history",
  );
});

test("an empty history is an array, so the readers keep their old answers for it", () => {
  assertNamedShapeError(
    () => depositAmountFromHistory([], "esc-ghost"),
    "settlement requires a FUND amount for esc-ghost: no FUND event in the audit history",
  );
  assert.equal(releasedAmountFromHistory([], "esc-ghost"), 0);
});
