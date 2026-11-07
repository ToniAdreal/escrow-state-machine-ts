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

/**
 * A `partially-released` report's `totalOutflow` is the full locked
 * deposit (10,630), but the money that actually left escrow is the
 * released slice (4,252). An external ledger records what was paid,
 * so reconciliation must pair a partial report against the released
 * slice — otherwise every honest ledger row is misread as a mismatch.
 */

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

function fundedEscrow(id: string) {
  const e = new Escrow(id);
  e.dispatch("FUND", undefined, 10630);
  return e;
}

function partialReport(id: string, currency?: string): SettlementReport {
  const escrow = fundedEscrow(id);
  return buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: goldenDeposit(),
    partialRelease: { released: 4252, proFeeBps: 500 },
    ...(currency !== undefined ? { currency } : {}),
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

test("ledger carrying the released slice matches a partial report", () => {
  const report = partialReport("esc-partial-match");
  assert.equal(report.outcome, "partially-released");
  assert.equal(report.totalOutflow, 10630);
  assert.equal(report.partialSettlement?.released, 4252);
  assert.equal(report.remaining, 6378);

  const result = reconcileSettlements([report], [
    { escrowId: "esc-partial-match", amount: 4252 },
  ]);
  assert.deepEqual(
    result.matched.map((r) => r.escrowId),
    ["esc-partial-match"],
  );
  assert.deepEqual(result.amountMismatch, []);
});

test("ledger carrying the full deposit mismatches, reportAmount is the released slice", () => {
  const report = partialReport("esc-partial-full");
  const result = reconcileSettlements([report], [
    { escrowId: "esc-partial-full", amount: 10630 },
  ]);
  assert.deepEqual(result.matched, []);
  assert.equal(result.amountMismatch.length, 1);
  assert.equal(result.amountMismatch[0].report.escrowId, "esc-partial-full");
  assert.equal(result.amountMismatch[0].reportAmount, 4252);
  assert.equal(result.amountMismatch[0].ledgerAmount, 10630);
  assert.match(
    result.amountMismatch[0].reason ?? "",
    /partial release: compared against partialSettlement\.released/,
  );
});

test("ledger carrying the still-locked remainder mismatches on the released slice", () => {
  const report = partialReport("esc-partial-remaining");
  const result = reconcileSettlements([report], [
    { escrowId: "esc-partial-remaining", amount: 6378 },
  ]);
  assert.equal(result.amountMismatch.length, 1);
  assert.equal(result.amountMismatch[0].reportAmount, 4252);
  assert.equal(result.amountMismatch[0].ledgerAmount, 6378);
  assert.match(
    result.amountMismatch[0].reason ?? "",
    /partialSettlement\.released/,
  );
});

test("ledger row without an amount matches a partial report on the reference alone", () => {
  const report = partialReport("esc-partial-ref-only");
  const result = reconcileSettlements([report], [{ escrowId: "esc-partial-ref-only" }]);
  assert.deepEqual(
    result.matched.map((r) => r.escrowId),
    ["esc-partial-ref-only"],
  );
  assert.deepEqual(result.amountMismatch, []);
});

test("full-release reports keep totalOutflow and carry no reason", () => {
  const report = releasedReport("esc-full-still");
  const result = reconcileSettlements([report], [
    { escrowId: "esc-full-still", amount: 10000 },
  ]);
  assert.equal(result.amountMismatch.length, 1);
  assert.equal(result.amountMismatch[0].reportAmount, 10630);
  assert.equal(result.amountMismatch[0].ledgerAmount, 10000);
  assert.equal(result.amountMismatch[0].reason, undefined);
});

test("currency mismatch still wins over amount mismatch for a partial report", () => {
  const report = partialReport("esc-partial-fx", "USD");
  const result = reconcileSettlements([report], [
    { escrowId: "esc-partial-fx", amount: 9999, currency: "EUR" },
  ]);
  assert.equal(result.currencyMismatch.length, 1);
  assert.equal(result.currencyMismatch[0].reportCurrency, "USD");
  assert.equal(result.currencyMismatch[0].ledgerCurrency, "EUR");
  assert.deepEqual(result.amountMismatch, []);
  assert.deepEqual(result.matched, []);
});

test("cent precision applies to the released slice, not the deposit", () => {
  const report = partialReport("esc-partial-cents");
  // 4252.004 rounds to 4252.00: float noise on the slice, not a
  // disagreement. 4251.99 is a real one-cent shortfall on the slice.
  const noise = reconcileSettlements([report], [
    { escrowId: "esc-partial-cents", amount: 4252.004 },
  ]);
  assert.equal(noise.matched.length, 1);
  assert.equal(noise.amountMismatch.length, 0);

  const short = reconcileSettlements([report], [
    { escrowId: "esc-partial-cents", amount: 4251.99 },
  ]);
  assert.equal(short.matched.length, 0);
  assert.equal(short.amountMismatch.length, 1);
  assert.equal(short.amountMismatch[0].reportAmount, 4252);
  assert.equal(short.amountMismatch[0].ledgerAmount, 4251.99);
});

test("hand-built partial report without partialSettlement falls back to totalOutflow", () => {
  const report = {
    escrowId: "esc-hand-partial",
    outcome: "partially-released",
    totalOutflow: 10630,
  } as unknown as SettlementReport;
  const full = reconcileSettlements([report], [
    { escrowId: "esc-hand-partial", amount: 10630 },
  ]);
  assert.equal(full.matched.length, 1);

  const slice = reconcileSettlements([report], [
    { escrowId: "esc-hand-partial", amount: 4252 },
  ]);
  assert.equal(slice.amountMismatch.length, 1);
  assert.equal(slice.amountMismatch[0].reportAmount, 10630);
  assert.equal(slice.amountMismatch[0].reason, undefined);
});

test("mixed batch: partial and full-release reports pair on their own figures", () => {
  const partial = partialReport("esc-mix-partial");
  const full = releasedReport("esc-mix-full");
  const result = reconcileSettlements(
    [partial, full],
    [
      { escrowId: "esc-mix-partial", amount: 4252 },
      { escrowId: "esc-mix-full", amount: 10630 },
    ],
  );
  assert.deepEqual(
    result.matched.map((r) => r.escrowId),
    ["esc-mix-partial", "esc-mix-full"],
  );
  assert.deepEqual(result.amountMismatch, []);

  const mismatched = reconcileSettlements(
    [partial, full],
    [
      { escrowId: "esc-mix-partial", amount: 10630 },
      { escrowId: "esc-mix-full", amount: 4252 },
    ],
  );
  assert.equal(mismatched.amountMismatch.length, 2);
  assert.deepEqual(
    mismatched.amountMismatch.map((m) => [m.report.escrowId, m.reportAmount]),
    [
      ["esc-mix-partial", 4252],
      ["esc-mix-full", 10630],
    ],
  );
  assert.equal(mismatched.amountMismatch[0].reason !== undefined, true);
  assert.equal(mismatched.amountMismatch[1].reason, undefined);
});

test("agreeing currency does not disturb a partial slice match", () => {
  const report = partialReport("esc-partial-usd", "USD");
  const ledger: LedgerSettlement[] = [
    { escrowId: "esc-partial-usd", amount: 4252, currency: "USD" },
  ];
  const result = reconcileSettlements([report], ledger);
  assert.deepEqual(
    result.matched.map((r) => r.escrowId),
    ["esc-partial-usd"],
  );
  assert.deepEqual(result.currencyMismatch, []);
  assert.deepEqual(result.amountMismatch, []);
});
