import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementReports,
  calculateDeposit,
  summarizeSettlementReports,
  UNSPECIFIED_SETTLEMENT_CURRENCY,
  type SettlementReport,
  type SettlementReportInputs,
  type SettlementReportResult,
} from "../src/index.js";

/**
 * `summarizeSettlementReports` used to ignore `report.remaining`
 * entirely: a batch of partially-released escrows reported how much
 * had been deposited and settled, but never how much was still
 * locked. `totalRemaining` is the sum of each successful report's
 * `remaining` (reports without one — a full release, refund, or
 * expiry — contribute 0), at the top level and per currency bucket.
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

function releasedEscrow(id: string) {
  const e = new Escrow(id);
  e.dispatch("FUND", undefined, 10630);
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return e;
}

function partialInputs(
  escrow: Escrow,
  released: number,
  currency?: string,
): SettlementReportInputs {
  return {
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: goldenDeposit(),
    partialRelease: { released, proFeeBps: 500 },
    ...(currency !== undefined ? { currency } : {}),
  };
}

test("single partial release: totalRemaining is the still-locked 6378", () => {
  const results = buildSettlementReports([
    partialInputs(fundedEscrow("r-one"), 4252, "USD"),
  ]);
  assert.equal(results[0].report!.outcome, "partially-released");
  assert.equal(results[0].report!.remaining, 6378);
  const s = summarizeSettlementReports(results);
  assert.equal(s.totalRemaining, 6378);
  assert.equal(s.byCurrency.USD.totalRemaining, 6378);
  assert.equal(s.byCurrency.USD.reports, 1);
  // The ledger runs over the full deposit, so the other totals still
  // read 10630 / 10630; only totalRemaining shows the locked remainder.
  assert.equal(s.totalDeposit, 10630);
  assert.equal(s.totalInflow, 10630);
  assert.equal(s.totalOutflow, 10630);
});

test("USD/EUR mixed batch: remainders split per currency with no leakage", () => {
  const results = buildSettlementReports([
    partialInputs(fundedEscrow("r-mix-usd"), 4252, "USD"),
    partialInputs(fundedEscrow("r-mix-eur"), 3000, "EUR"),
  ]);
  assert.equal(results[0].report!.remaining, 6378);
  assert.equal(results[1].report!.remaining, 7630);
  const s = summarizeSettlementReports(results);
  assert.equal(s.byCurrency.USD.totalRemaining, 6378);
  assert.equal(s.byCurrency.EUR.totalRemaining, 7630);
  // Top-level still sums raw figures across currencies (by design).
  assert.equal(s.totalRemaining, 14008);
  assert.equal(
    s.byCurrency.USD.totalRemaining + s.byCurrency.EUR.totalRemaining,
    s.totalRemaining,
  );
});

test("full-release report contributes 0 to totalRemaining", () => {
  const full = releasedEscrow("r-full");
  const s = summarizeSettlementReports(
    buildSettlementReports([
      {
        escrowId: full.id,
        history: full.history,
        finalState: full.state,
        deposit: goldenDeposit(),
        settlement: { proFeeBps: 500 },
        currency: "USD",
      },
    ]),
  );
  assert.equal(s.reports, 1);
  assert.equal(s.totalRemaining, 0);
  assert.equal(s.byCurrency.USD.totalRemaining, 0);
});

test("currency-less partial report lands in the UNSPECIFIED bucket", () => {
  const s = summarizeSettlementReports(
    buildSettlementReports([partialInputs(fundedEscrow("r-unspec"), 4252)]),
  );
  assert.deepEqual(Object.keys(s.byCurrency), [UNSPECIFIED_SETTLEMENT_CURRENCY]);
  assert.equal(s.byCurrency.UNSPECIFIED.totalRemaining, 6378);
  assert.equal(s.totalRemaining, 6378);
});

test("error entries are excluded from totalRemaining", () => {
  const open = new Escrow("r-err-open");
  open.dispatch("FUND");
  const s = summarizeSettlementReports(
    buildSettlementReports([
      partialInputs(fundedEscrow("r-err-partial"), 4252, "USD"),
      {
        escrowId: open.id,
        history: open.history,
        finalState: open.state,
        deposit: goldenDeposit(),
        settlement: { proFeeBps: 500 },
      },
    ]),
  );
  assert.equal(s.errors, 1);
  assert.equal(s.reports, 1);
  assert.equal(s.totalRemaining, 6378);
  assert.equal(s.byCurrency.USD.totalRemaining, 6378);
});

test("empty batch yields totalRemaining 0 and an empty byCurrency map", () => {
  const s = summarizeSettlementReports([]);
  assert.equal(s.totalRemaining, 0);
  assert.deepEqual(s.byCurrency, {});
});

test("two partial releases sum: 6378 + 6378 = 12756", () => {
  const s = summarizeSettlementReports(
    buildSettlementReports([
      partialInputs(fundedEscrow("r-sum-1"), 4252, "USD"),
      partialInputs(fundedEscrow("r-sum-2"), 4252, "USD"),
    ]),
  );
  assert.equal(s.totalRemaining, 12756);
  assert.equal(s.byCurrency.USD.totalRemaining, 12756);
});

test("reading rule: totalDeposit - totalOutflow is 0 for a balanced partial report, totalRemaining is not", () => {
  const s = summarizeSettlementReports(
    buildSettlementReports([partialInputs(fundedEscrow("r-rule"), 4252, "USD")]),
  );
  // Hand-computing the remainder from the other totals would read 0:
  // the partial report's ledger runs over the full deposit, so inflow
  // and outflow both equal 10630. totalRemaining is the only honest
  // read of the still-locked money.
  assert.equal(s.totalDeposit - s.totalOutflow, 0);
  assert.equal(s.totalRemaining, 6378);
  assert.equal(s.byCurrency.USD.totalDeposit - s.byCurrency.USD.totalOutflow, 0);
  assert.equal(s.byCurrency.USD.totalRemaining, 6378);
});

test("mixed partial + full-release batch: only the partial report counts", () => {
  const full = releasedEscrow("r-mix-full");
  const s = summarizeSettlementReports(
    buildSettlementReports([
      partialInputs(fundedEscrow("r-mix-partial"), 4252, "USD"),
      {
        escrowId: full.id,
        history: full.history,
        finalState: full.state,
        deposit: goldenDeposit(),
        settlement: { proFeeBps: 500 },
        currency: "USD",
      },
    ]),
  );
  assert.equal(s.reports, 2);
  assert.equal(s.outcomes["partially-released"], 1);
  assert.equal(s.outcomes.released, 1);
  assert.equal(s.totalRemaining, 6378);
  assert.equal(s.byCurrency.USD.totalRemaining, 6378);
  assert.equal(s.totalDeposit, 21260);
});

function fakeReleasedWithoutRemaining(id: string): SettlementReportResult {
  // A hand-built report with no `remaining` key at all: the summary
  // must treat the missing field as 0, never as undefined/NaN.
  const report: SettlementReport = {
    escrowId: id,
    outcome: "released",
    deposit: {
      creatorPool: 10000,
      baseFee: 600,
      complexityMultiplier: 1,
      loyaltyDiscount: 30,
      oracleFee: 60,
      adjustedBaseFee: 570,
      deposit: 10630,
    },
    parties: [
      { party: "sponsor", label: "Sponsor (depositor)", inflow: 0, outflow: 10630, net: -10630 },
      { party: "creator", label: "Creator (payee)", inflow: 10098.5, outflow: 0, net: 10098.5 },
      { party: "platform", label: "Platform (pro fee)", inflow: 531.5, outflow: 0, net: 531.5 },
      { party: "referrer", label: "Referrer (referral credits)", inflow: 0, outflow: 0, net: 0 },
    ],
    totalInflow: 10630,
    totalOutflow: 10630,
    balanced: true,
    eventCount: 4,
  };
  return { escrowId: id, report };
}

test("report without a remaining field contributes 0, never NaN", () => {
  const s = summarizeSettlementReports([fakeReleasedWithoutRemaining("r-fake")]);
  assert.equal(s.totalRemaining, 0);
  assert.ok(Number.isFinite(s.totalRemaining));
  assert.equal(s.byCurrency.UNSPECIFIED.totalRemaining, 0);
});
