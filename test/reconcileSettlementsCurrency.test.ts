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

function releasedReport(id: string, currency?: string): SettlementReport {
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
    ...(currency !== undefined ? { currency } : {}),
  });
}

test("currency disagreement lands in currencyMismatch, not matched or amountMismatch", () => {
  const report = releasedReport("esc-cur-mismatch", "USD");
  const result = reconcileSettlements([report], [
    { escrowId: "esc-cur-mismatch", amount: 10630, currency: "EUR" },
  ]);
  assert.deepEqual(result.matched, []);
  assert.deepEqual(result.amountMismatch, []);
  assert.equal(result.currencyMismatch.length, 1);
  assert.equal(result.currencyMismatch[0].report, report);
  assert.equal(result.currencyMismatch[0].reportCurrency, "USD");
  assert.equal(result.currencyMismatch[0].ledgerCurrency, "EUR");
});

test("same currency on both sides still matches", () => {
  const report = releasedReport("esc-cur-same", "USD");
  const result = reconcileSettlements([report], [
    { escrowId: "esc-cur-same", amount: 10630, currency: "USD" },
  ]);
  assert.deepEqual(result.matched, [report]);
  assert.deepEqual(result.currencyMismatch, []);
  assert.deepEqual(result.amountMismatch, []);
});

test("report without a currency pairs under the old rules", () => {
  const report = releasedReport("esc-cur-report-bare");
  assert.equal("currency" in report, false);
  const result = reconcileSettlements([report], [
    { escrowId: "esc-cur-report-bare", amount: 10630, currency: "EUR" },
  ]);
  assert.deepEqual(result.matched, [report]);
  assert.deepEqual(result.currencyMismatch, []);
});

test("ledger row without a currency pairs under the old rules", () => {
  const report = releasedReport("esc-cur-ledger-bare", "USD");
  const result = reconcileSettlements([report], [
    { escrowId: "esc-cur-ledger-bare", amount: 10630 },
  ]);
  assert.deepEqual(result.matched, [report]);
  assert.deepEqual(result.currencyMismatch, []);
});

test("neither side carrying a currency keeps the old amount rules", () => {
  const report = releasedReport("esc-cur-none");
  const matched = reconcileSettlements([report], [
    { escrowId: "esc-cur-none", amount: 10630 },
  ]);
  assert.equal(matched.matched.length, 1);
  const mismatched = reconcileSettlements([report], [
    { escrowId: "esc-cur-none", amount: 10000 },
  ]);
  assert.equal(mismatched.amountMismatch.length, 1);
  assert.equal(mismatched.currencyMismatch.length, 0);
});

test("illegal ledger currency fails fast", () => {
  const report = releasedReport("esc-cur-bad-ledger", "USD");
  for (const bad of ["usd", "US", "USDD", "US1", "", 840]) {
    assert.throws(
      () =>
        reconcileSettlements([report], [
          {
            escrowId: "esc-cur-bad-ledger",
            amount: 10630,
            currency: bad as unknown as string,
          },
        ]),
      /invalid settlement currency.*must be a 3-letter uppercase ISO 4217 code/,
      `currency ${JSON.stringify(bad)} must be rejected`,
    );
  }
});

test("illegal report currency fails fast", () => {
  const forged = {
    ...releasedReport("esc-cur-bad-report", "USD"),
    currency: "usd",
  };
  assert.throws(
    () =>
      reconcileSettlements([forged], [
        { escrowId: "esc-cur-bad-report", amount: 10630, currency: "USD" },
      ]),
    /invalid settlement currency.*must be a 3-letter uppercase ISO 4217 code/,
  );
});

test("mixed batch counts all five groups", () => {
  const matched = releasedReport("esc-mix-matched", "USD");
  const reportOnly = releasedReport("esc-mix-report-only", "USD");
  const amountMismatch = releasedReport("esc-mix-amount", "USD");
  const currencyMismatch = releasedReport("esc-mix-currency", "USD");
  const ledger: LedgerSettlement[] = [
    { escrowId: "esc-mix-matched", amount: 10630, currency: "USD" },
    { escrowId: "esc-mix-amount", amount: 10000, currency: "USD" },
    { escrowId: "esc-mix-currency", amount: 10630, currency: "EUR" },
    { escrowId: "esc-mix-ledger-only", amount: 500, currency: "USD" },
  ];
  const result = reconcileSettlements(
    [matched, reportOnly, amountMismatch, currencyMismatch],
    ledger,
  );
  assert.deepEqual(result.matched.map((r) => r.escrowId), ["esc-mix-matched"]);
  assert.deepEqual(result.reportOnly.map((r) => r.escrowId), ["esc-mix-report-only"]);
  assert.deepEqual(result.ledgerOnly.map((r) => r.escrowId), ["esc-mix-ledger-only"]);
  assert.deepEqual(result.amountMismatch.map((m) => m.report.escrowId), ["esc-mix-amount"]);
  assert.deepEqual(result.currencyMismatch.map((m) => m.report.escrowId), ["esc-mix-currency"]);
});

test("amount and currency both disagreeing reports only the currency group", () => {
  const report = releasedReport("esc-cur-both", "USD");
  const result = reconcileSettlements([report], [
    { escrowId: "esc-cur-both", amount: 10000, currency: "EUR" },
  ]);
  assert.equal(result.currencyMismatch.length, 1);
  assert.equal(result.currencyMismatch[0].reportCurrency, "USD");
  assert.equal(result.currencyMismatch[0].ledgerCurrency, "EUR");
  assert.deepEqual(result.amountMismatch, []);
  assert.deepEqual(result.matched, []);
});

test("empty inputs leave the currency group empty", () => {
  const result = reconcileSettlements([], []);
  assert.deepEqual(result.currencyMismatch, []);
});

test("currencyMismatch holds the same objects and keeps input order", () => {
  const second = releasedReport("esc-cur-order-2", "USD");
  const first = releasedReport("esc-cur-order-1", "USD");
  const ledger: LedgerSettlement[] = [
    { escrowId: "esc-cur-order-1", amount: 10630, currency: "GBP" },
    { escrowId: "esc-cur-order-2", amount: 10630, currency: "EUR" },
  ];
  const reportsBefore = JSON.stringify([second, first]);
  const ledgerBefore = JSON.stringify(ledger);
  const result = reconcileSettlements([second, first], ledger);
  assert.deepEqual(
    result.currencyMismatch.map((m) => m.report.escrowId),
    ["esc-cur-order-2", "esc-cur-order-1"],
  );
  assert.equal(result.currencyMismatch[0].report, second);
  assert.equal(result.currencyMismatch[0].ledger, ledger[1]);
  assert.equal(JSON.stringify([second, first]), reportsBefore);
  assert.equal(JSON.stringify(ledger), ledgerBefore);
});
