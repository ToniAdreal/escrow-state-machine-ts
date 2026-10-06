import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  assertNonNegativeMoney,
} from "../src/index.js";

test("assertNonNegativeMoney: rejects NaN, Infinity, negatives, non-numbers", () => {
  assert.throws(
    () => assertNonNegativeMoney("amount", -1),
    /amount must be a finite non-negative number/,
  );
  assert.throws(
    () => assertNonNegativeMoney("amount", NaN),
    /must be a finite non-negative number/,
  );
  assert.throws(
    () => assertNonNegativeMoney("amount", Infinity),
    /must be a finite non-negative number/,
  );
  assert.throws(
    () => assertNonNegativeMoney("amount", -Infinity),
    /must be a finite non-negative number/,
  );
  assert.throws(
    () => assertNonNegativeMoney("amount", "10630"),
    /must be a finite non-negative number/,
  );
  assert.throws(
    () => assertNonNegativeMoney("amount", undefined),
    /must be a finite non-negative number/,
  );
  // accepts 0 and normal money values
  assertNonNegativeMoney("amount", 0);
  assertNonNegativeMoney("amount", 10630);
  assertNonNegativeMoney("amount", 0.01);
});

test("FUND accepts a valid amount and records it on the history entry", () => {
  const e = new Escrow("cmp-input-001");
  e.dispatch("FUND", "wire received", 10630);
  assert.equal(e.state, "FUNDED");
  assert.equal(e.history[0].amount, 10630);
  assert.equal(e.history[0].note, "wire received");
  // zero is a valid deposit (e.g. fee-free campaign)
  const e2 = new Escrow("cmp-input-002");
  e2.dispatch("FUND", undefined, 0);
  assert.equal(e2.history[0].amount, 0);
});

test("FUND without an amount keeps backward-compatible behavior", () => {
  const e = new Escrow("cmp-input-003");
  e.dispatch("FUND");
  assert.equal(e.state, "FUNDED");
  assert.equal(e.history[0].amount, undefined);
});

test("FUND rejects negative / NaN / infinite amounts without state change", () => {
  for (const bad of [-1, NaN, Infinity, -Infinity, "10630", null]) {
    const e = new Escrow("cmp-input-004");
    assert.throws(
      () => e.dispatch("FUND", undefined, bad as number),
      /amount must be a finite non-negative number/,
    );
    // rejected input never mutates state or history
    assert.equal(e.state, "CREATED");
    assert.equal(e.history.length, 0);
  }
});

test("amount is rejected on any event other than FUND", () => {
  const e = new Escrow("cmp-input-005");
  assert.throws(
    () => e.dispatch("RELEASE", undefined, 100),
    /amount is only accepted on FUND, not on RELEASE/,
  );
  e.dispatch("FUND");
  assert.throws(
    () => e.dispatch("SUBMIT_MILESTONE", undefined, 100),
    /amount is only accepted on FUND/,
  );
  assert.equal(e.state, "FUNDED");
  assert.equal(e.history.length, 1);
});

test("amount check fires before transition check for non-FUND events", () => {
  const e = new Escrow("cmp-input-006");
  e.dispatch("FUND");
  // double FUND is now a legal top-up self-loop (#43); use a non-FUND event
  // with an amount instead: the FUND-only rule must fire first, not the
  // invalid-transition rule.
  assert.throws(
    () => e.dispatch("RELEASE", undefined, 500),
    /amount is only accepted on FUND, not on RELEASE/,
  );
});
