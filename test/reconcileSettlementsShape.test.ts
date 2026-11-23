import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  calculateDeposit,
  reconcileSettlements,
  type LedgerSettlement,
  type SettlementReport,
} from "../src/index.js";

// Backlog #1343: `reconcileSettlements` iterated `reports` and `ledger`
// with no array guard, so a non-array argument surfaced a bare
// `TypeError: reports/ledger is not iterable` instead of the named
// `invalid reconcileSettlements: …` error every other shape failure at
// this entry throws. The per-row object checks only ran after the
// iteration started, so they could never catch it.

function goldenDeposit() {
  // Portfolio golden vector: pool $10,000, base $600 × 1.0, loyalty −$30,
  // oracle +$60 → deposit $10,630.
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

function releasedReport(id: string): SettlementReport {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500 },
  });
}

function ledgerRow(id: string, amount = 10630): LedgerSettlement {
  return { escrowId: id, amount };
}

test("reconcile: non-array reports throw a named error, not a bare TypeError", () => {
  for (const bad of [null, "x", 42, undefined, { escrowId: "esc-1" }]) {
    assert.throws(
      () => reconcileSettlements(bad as never, []),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!(error instanceof TypeError));
        assert.match(
          error.message,
          /^invalid reconcileSettlements: reports must be an array, got /,
        );
        return true;
      },
    );
  }
  assert.throws(
    () => reconcileSettlements(null as never, []),
    /invalid reconcileSettlements: reports must be an array, got null/,
  );
  assert.throws(
    () => reconcileSettlements("x" as never, []),
    /invalid reconcileSettlements: reports must be an array, got string/,
  );
  assert.throws(
    () => reconcileSettlements(42 as never, []),
    /invalid reconcileSettlements: reports must be an array, got number/,
  );
});

test("reconcile: non-array ledger throws a named error, not a bare TypeError", () => {
  for (const bad of [null, "x", 42, undefined, { escrowId: "esc-1" }]) {
    assert.throws(
      () => reconcileSettlements([], bad as never),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!(error instanceof TypeError));
        assert.match(
          error.message,
          /^invalid reconcileSettlements: ledger must be an array, got /,
        );
        return true;
      },
    );
  }
  assert.throws(
    () => reconcileSettlements([], null as never),
    /invalid reconcileSettlements: ledger must be an array, got null/,
  );
  assert.throws(
    () => reconcileSettlements([], "x" as never),
    /invalid reconcileSettlements: ledger must be an array, got string/,
  );
  assert.throws(
    () => reconcileSettlements([], 42 as never),
    /invalid reconcileSettlements: ledger must be an array, got number/,
  );
});

test("reconcile: the array guard fires before any pairing", () => {
  // A valid report and a ledger row that would have matched: the
  // reports-side guard still fires first, and nothing is paired.
  const report = releasedReport("esc-guard");
  assert.throws(
    () => reconcileSettlements(null as never, [ledgerRow("esc-guard")]),
    /reports must be an array, got null/,
  );
  // Same from the ledger side: the valid report is never consulted.
  assert.throws(
    () => reconcileSettlements([report], null as never),
    /ledger must be an array, got null/,
  );
  // And the guard leaves no partial pairing behind: the same valid
  // batch reconciles cleanly on the very next call.
  const after = reconcileSettlements([report], [ledgerRow("esc-guard")]);
  assert.equal(after.matched.length, 1);
  assert.equal(after.matched[0].escrowId, "esc-guard");
});

test("reconcile: duplicate report id rejection is unchanged", () => {
  const report = releasedReport("esc-dup");
  assert.throws(
    () => reconcileSettlements([report, report], [ledgerRow("esc-dup")]),
    /invalid reconcileSettlements: duplicate report escrowId: "esc-dup"/,
  );
});

test("reconcile: duplicate ledger id rejection is unchanged", () => {
  const report = releasedReport("esc-dup-ledger");
  assert.throws(
    () =>
      reconcileSettlements(
        [report],
        [ledgerRow("esc-dup-ledger"), ledgerRow("esc-dup-ledger")],
      ),
    /invalid reconcileSettlements: duplicate ledger escrowId: "esc-dup-ledger"/,
  );
});

test("reconcile: a legal batch groups exactly as before", () => {
  const matched = releasedReport("esc-matched");
  const onlyReport = releasedReport("esc-report-only");
  const mismatch = releasedReport("esc-mismatch");
  const result = reconcileSettlements(
    [matched, onlyReport, mismatch],
    [
      ledgerRow("esc-matched"),
      ledgerRow("esc-mismatch", 10000),
      ledgerRow("esc-ledger-only", 500),
    ],
  );
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].escrowId, "esc-matched");
  assert.deepEqual(
    result.reportOnly.map((r) => r.escrowId),
    ["esc-report-only"],
  );
  assert.deepEqual(
    result.ledgerOnly.map((r) => r.escrowId),
    ["esc-ledger-only"],
  );
  assert.equal(result.amountMismatch.length, 1);
  assert.equal(result.amountMismatch[0].report.escrowId, "esc-mismatch");
  assert.equal(result.amountMismatch[0].reportAmount, 10630);
  assert.equal(result.amountMismatch[0].ledgerAmount, 10000);
  assert.deepEqual(result.currencyMismatch, []);
});

test("reconcile: empty batches still return five empty groups", () => {
  const result = reconcileSettlements([], []);
  assert.deepEqual(result, {
    matched: [],
    reportOnly: [],
    ledgerOnly: [],
    amountMismatch: [],
    currencyMismatch: [],
  });
});
