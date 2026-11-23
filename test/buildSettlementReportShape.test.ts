import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  calculateDeposit,
} from "../src/index.js";
import type { SettlementReport } from "../src/index.js";

/**
 * `buildSettlementReport` input-shape validation (backlog #1347).
 *
 * Until now the function destructured `inputs` with no shape guard, so a
 * null / string / number `inputs` surfaced a bare `TypeError` from the
 * destructure, and a missing or non-object `deposit` surfaced a bare
 * `TypeError` reading `'deposit'` — both before any of the named
 * `cannot build settlement report: …` checks could run. A caller bug
 * must fail as a named configuration error, the same family the rest of
 * the build path uses. Every case below must throw a plain `Error`
 * (never a `TypeError`) with the pinned wording, and a standard report
 * built from a real escrow must keep building with identical figures.
 */

function goldenDeposit() {
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

function reportFor(
  escrow: Escrow,
  settlement?: { proFeeBps: number },
): SettlementReport {
  return buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: goldenDeposit(),
    ...(settlement ? { settlement } : {}),
  });
}

function releasedReport(id = "esc-shape-released"): SettlementReport {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return reportFor(e, { proFeeBps: 500 });
}

function refundedReport(id = "esc-shape-refunded"): SettlementReport {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("DISPUTE");
  e.dispatch("ARBITRATE_REFUND");
  return reportFor(e);
}

function expiredReport(id = "esc-shape-expired"): SettlementReport {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("EXPIRE");
  return reportFor(e);
}

/** Assert a call throws a plain Error (not TypeError) with an exact message. */
function assertNamedError(fn: () => unknown, message: string): void {
  assert.throws(
    fn,
    (e: unknown) => {
      assert.ok(e instanceof Error, "must throw an Error");
      assert.ok(
        !(e instanceof TypeError),
        `must be a named Error, not a TypeError (got: ${(e as Error).message})`,
      );
      assert.equal((e as Error).message, message);
      return true;
    },
  );
}

test("null inputs throws a named error, not a destructuring TypeError", () => {
  assertNamedError(
    () => buildSettlementReport(null as never),
    "cannot build settlement report: inputs must be an object, got null",
  );
});

test("string inputs throws a named error", () => {
  assertNamedError(
    () => buildSettlementReport("x" as never),
    'cannot build settlement report: inputs must be an object, got "x"',
  );
});

test("number inputs throws a named error", () => {
  assertNamedError(
    () => buildSettlementReport(42 as never),
    "cannot build settlement report: inputs must be an object, got 42",
  );
});

test("array inputs throws a named error", () => {
  assertNamedError(
    () => buildSettlementReport([] as never),
    "cannot build settlement report: inputs must be an object, got []",
  );
});

test("empty-object inputs throws a named deposit error, not reading 'deposit'", () => {
  assertNamedError(
    () => buildSettlementReport({} as never),
    "cannot build settlement report: deposit must be an object, got undefined",
  );
});

test("inputs missing deposit throws a named deposit error", () => {
  assertNamedError(
    () =>
      buildSettlementReport({
        escrowId: "esc-shape-no-deposit",
        history: [],
        finalState: "RELEASED",
      } as never),
    "cannot build settlement report: deposit must be an object, got undefined",
  );
});

test("null deposit throws a named deposit error", () => {
  assertNamedError(
    () =>
      buildSettlementReport({
        escrowId: "esc-shape-null-deposit",
        history: [],
        finalState: "RELEASED",
        deposit: null,
      } as never),
    "cannot build settlement report: deposit must be an object, got null",
  );
});

test("string deposit throws a named deposit error", () => {
  assertNamedError(
    () =>
      buildSettlementReport({
        escrowId: "esc-shape-string-deposit",
        history: [],
        finalState: "RELEASED",
        deposit: "x",
      } as never),
    'cannot build settlement report: deposit must be an object, got "x"',
  );
});

test("legal released/refunded/expired reports keep identical figures", () => {
  const deposit = goldenDeposit();
  const released = releasedReport();
  const refunded = refundedReport();
  const expired = expiredReport();

  assert.equal(released.outcome, "released");
  assert.equal(refunded.outcome, "refunded");
  assert.equal(expired.outcome, "expired");
  for (const report of [released, refunded, expired]) {
    assert.equal(report.deposit.deposit, deposit.deposit);
    assert.equal(report.deposit.creatorPool, deposit.creatorPool);
    assert.equal(report.deposit.baseFee, deposit.baseFee);
    assert.equal(
      report.deposit.complexityMultiplier,
      deposit.complexityMultiplier,
    );
    assert.equal(report.balanced, true);
  }
  assert.equal(released.escrowId, "esc-shape-released");
  assert.equal(refunded.escrowId, "esc-shape-refunded");
  assert.equal(expired.escrowId, "esc-shape-expired");
});
