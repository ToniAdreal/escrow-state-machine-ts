import test from "node:test";
import assert from "node:assert/strict";
import {
  summarizeSettlementReports,
  type SettlementReport,
  type SettlementReportResult,
} from "../src/index.js";

// Backlog #1098: `summarizeSettlementReports` must fail closed when a
// batch's money figures overflow, instead of silently returning
// `Infinity` totals. The fixtures below are hand-built reports — the
// function deliberately never re-validates a single report, so a
// hand-built report can carry figures no builder would ever produce
// (astronomical amounts, report totals that disagree with party rows);
// only the sums are guarded.

const OVERFLOW_MESSAGE =
  "settlement reports summary computation overflowed: inputs too large";

function assertOverflows(results: readonly SettlementReportResult[]) {
  assert.throws(
    () => summarizeSettlementReports(results),
    (err: unknown) =>
      err instanceof Error && err.message === OVERFLOW_MESSAGE,
  );
}

function fakeReport(
  id: string,
  opts: {
    amount?: number;
    currency?: string;
    totalInflow?: number;
    totalOutflow?: number;
    sponsorInflow?: number;
    sponsorOutflow?: number;
    remaining?: number;
  } = {},
): SettlementReportResult {
  const amount = opts.amount ?? 0;
  const report: SettlementReport = {
    escrowId: id,
    outcome: "refunded",
    deposit: {
      creatorPool: amount,
      baseFee: 0,
      complexityMultiplier: 1,
      loyaltyDiscount: 0,
      oracleFee: 0,
      adjustedBaseFee: 0,
      deposit: amount,
    },
    parties: [
      {
        party: "sponsor",
        label: "Sponsor (depositor)",
        inflow: opts.sponsorInflow ?? amount,
        outflow: opts.sponsorOutflow ?? amount,
        net: 0,
      },
      { party: "creator", label: "Creator (payee)", inflow: 0, outflow: 0, net: 0 },
      { party: "platform", label: "Platform (pro fee)", inflow: 0, outflow: 0, net: 0 },
      { party: "referrer", label: "Referrer (referral credits)", inflow: 0, outflow: 0, net: 0 },
    ],
    totalInflow: opts.totalInflow ?? amount,
    totalOutflow: opts.totalOutflow ?? amount,
    balanced: true,
    eventCount: 2,
  };
  if (opts.currency !== undefined) report.currency = opts.currency;
  if (opts.remaining !== undefined) report.remaining = opts.remaining;
  return { escrowId: id, report };
}

test("single report carrying Infinity fails closed at the top-level totals", () => {
  assertOverflows([fakeReport("s-inf", { amount: Number.POSITIVE_INFINITY })]);
});

test("single report carrying NaN fails closed, not silently summed", () => {
  assertOverflows([fakeReport("s-nan", { amount: Number.NaN })]);
});

test("batch accumulation overflow: two finite reports summing past MAX_VALUE", () => {
  assertOverflows([
    fakeReport("s-max-1", { amount: Number.MAX_VALUE }),
    fakeReport("s-max-2", { amount: Number.MAX_VALUE }),
  ]);
});

test("per-currency bucket overflow is caught even when top-level totals stay finite", () => {
  // Signed to keep the top-level sums finite: -MAX_VALUE (EUR) +
  // MAX_VALUE + MAX_VALUE (USD) = MAX_VALUE, while the USD bucket
  // alone sums to Infinity on the second USD report.
  assertOverflows([
    fakeReport("s-eur", { amount: -Number.MAX_VALUE, currency: "EUR" }),
    fakeReport("s-usd-1", { amount: Number.MAX_VALUE, currency: "USD" }),
    fakeReport("s-usd-2", { amount: Number.MAX_VALUE, currency: "USD" }),
  ]);
});

test("party subtotal overflow is caught even when the report totals stay finite", () => {
  // The two reports agree on tiny report-level totals (1 each) but
  // carry MAX_VALUE sponsor inflows, so only the party sums overflow.
  assertOverflows([
    fakeReport("s-p-1", {
      amount: 1,
      totalInflow: 1,
      totalOutflow: 1,
      sponsorInflow: Number.MAX_VALUE,
      sponsorOutflow: 1,
    }),
    fakeReport("s-p-2", {
      amount: 1,
      totalInflow: 1,
      totalOutflow: 1,
      sponsorInflow: Number.MAX_VALUE,
      sponsorOutflow: 1,
    }),
  ]);
});

test("party net overflow is caught when opposite-signed extremes meet", () => {
  // Inflow and outflow each stay finite on their own; the net
  // (inflow - outflow) is the figure that overflows.
  assertOverflows([
    fakeReport("s-net", {
      amount: 1,
      totalInflow: 1,
      totalOutflow: 1,
      sponsorInflow: Number.MAX_VALUE,
      sponsorOutflow: -Number.MAX_VALUE,
    }),
  ]);
});

test("large but finite batch still sums normally", () => {
  const s = summarizeSettlementReports([
    fakeReport("s-big-1", { amount: 1e300 }),
    fakeReport("s-big-2", { amount: 1e300 }),
  ]);
  assert.equal(s.totalDeposit, 2e300);
  assert.equal(s.totalInflow, 2e300);
  assert.equal(s.totalOutflow, 2e300);
  assert.equal(s.parties[0].inflow, 2e300);
  assert.equal(s.byCurrency.UNSPECIFIED.totalDeposit, 2e300);
});

test("normal batch figures are unchanged by the guard", () => {
  const s = summarizeSettlementReports([
    fakeReport("s-n-1", { amount: 100, remaining: 40 }),
    fakeReport("s-n-2", { amount: 250, remaining: 0 }),
  ]);
  assert.equal(s.total, 2);
  assert.equal(s.reports, 2);
  assert.equal(s.errors, 0);
  assert.equal(s.totalDeposit, 350);
  assert.equal(s.totalInflow, 350);
  assert.equal(s.totalOutflow, 350);
  assert.equal(s.totalRemaining, 40);
  assert.deepEqual(
    s.parties.map((p) => [p.party, p.inflow, p.outflow, p.net]),
    [
      ["sponsor", 350, 350, 0],
      ["creator", 0, 0, 0],
      ["platform", 0, 0, 0],
      ["referrer", 0, 0, 0],
    ],
  );
  assert.equal(s.byCurrency.UNSPECIFIED.totalDeposit, 350);
  assert.equal(s.byCurrency.UNSPECIFIED.totalRemaining, 40);
});

test("empty and all-error batches are unchanged", () => {
  const empty = summarizeSettlementReports([]);
  assert.equal(empty.total, 0);
  assert.equal(empty.totalDeposit, 0);
  assert.equal(empty.balanced, true);

  const allErrors = summarizeSettlementReports([
    { escrowId: "s-e-1", error: "boom" },
    { escrowId: "s-e-2", error: "boom" },
  ]);
  assert.equal(allErrors.total, 2);
  assert.equal(allErrors.reports, 0);
  assert.equal(allErrors.errors, 2);
  assert.equal(allErrors.totalDeposit, 0);
  assert.equal(allErrors.totalInflow, 0);
  assert.equal(allErrors.totalOutflow, 0);
  assert.equal(allErrors.totalRemaining, 0);
  assert.deepEqual(allErrors.byCurrency, {});
});
