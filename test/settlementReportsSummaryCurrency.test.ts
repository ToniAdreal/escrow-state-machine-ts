import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReports,
  calculateDeposit,
  summarizeSettlementReports,
  UNSPECIFIED_SETTLEMENT_CURRENCY,
  type SettlementReport,
  type SettlementReportInputs,
  type SettlementReportResult,
} from "../src/index.js";

function deposit() {
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

function released(id: string) {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return e;
}

function refunded(id: string) {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_FAIL");
  e.dispatch("ARBITRATE_REFUND");
  return e;
}

function expired(id: string) {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("EXPIRE");
  return e;
}

function inputsFor(e: Escrow, currency?: string): SettlementReportInputs {
  return {
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: deposit(),
    settlement: { proFeeBps: 500 },
    ...(currency !== undefined ? { currency } : {}),
  };
}

test("single-currency batch: the currency bucket equals the top-level totals", () => {
  // Each escrow locks the golden deposit 10630. The released ones settle
  // at proFeeBps 500: proFee = 10630 * 5% = 531.5, creator net = 10098.5.
  const s = summarizeSettlementReports(
    buildSettlementReports([
      inputsFor(released("c-usd-1"), "USD"),
      inputsFor(released("c-usd-2"), "USD"),
    ]),
  );
  assert.deepEqual(Object.keys(s.byCurrency), ["USD"]);
  assert.deepEqual(s.byCurrency.USD, {
    reports: 2,
    totalDeposit: 21260,
    totalInflow: 21260,
    totalOutflow: 21260,
  });
  assert.equal(s.byCurrency.USD.totalDeposit, s.totalDeposit);
  assert.equal(s.byCurrency.USD.totalInflow, s.totalInflow);
  assert.equal(s.byCurrency.USD.totalOutflow, s.totalOutflow);
});

test("mixed USD/EUR batch: buckets split with no cross-currency leakage", () => {
  const s = summarizeSettlementReports(
    buildSettlementReports([
      inputsFor(released("c-mix-usd"), "USD"),
      inputsFor(refunded("c-mix-eur"), "EUR"),
    ]),
  );
  assert.deepEqual(Object.keys(s.byCurrency).sort(), ["EUR", "USD"]);
  // USD released: 10630 in, 10630 out (creator 10098.5 + platform 531.5).
  assert.deepEqual(s.byCurrency.USD, {
    reports: 1,
    totalDeposit: 10630,
    totalInflow: 10630,
    totalOutflow: 10630,
  });
  // EUR refunded: the full 10630 returns to the sponsor.
  assert.deepEqual(s.byCurrency.EUR, {
    reports: 1,
    totalDeposit: 10630,
    totalInflow: 10630,
    totalOutflow: 10630,
  });
  // Top-level totals are kept for backward compatibility and still sum raw
  // figures across currencies — the caller must not read 21260 as
  // single-currency money; the buckets are the single-currency view.
  assert.equal(s.totalDeposit, 21260);
  assert.equal(s.byCurrency.USD.totalDeposit + s.byCurrency.EUR.totalDeposit, 21260);
});

test("three currencies stay in three separate buckets", () => {
  const s = summarizeSettlementReports(
    buildSettlementReports([
      inputsFor(released("c-3-usd"), "USD"),
      inputsFor(refunded("c-3-eur"), "EUR"),
      inputsFor(expired("c-3-gbp"), "GBP"),
    ]),
  );
  assert.deepEqual(Object.keys(s.byCurrency).sort(), ["EUR", "GBP", "USD"]);
  for (const code of ["USD", "EUR", "GBP"]) {
    assert.deepEqual(s.byCurrency[code], {
      reports: 1,
      totalDeposit: 10630,
      totalInflow: 10630,
      totalOutflow: 10630,
    });
  }
});

test("currency-less reports land in the UNSPECIFIED bucket, never in a real currency", () => {
  const s = summarizeSettlementReports(
    buildSettlementReports([
      inputsFor(released("c-unspec-1")),
      inputsFor(released("c-unspec-2")),
      inputsFor(released("c-unspec-usd"), "USD"),
    ]),
  );
  assert.deepEqual(Object.keys(s.byCurrency).sort(), ["UNSPECIFIED", "USD"]);
  assert.equal(UNSPECIFIED_SETTLEMENT_CURRENCY, "UNSPECIFIED");
  assert.deepEqual(s.byCurrency.UNSPECIFIED, {
    reports: 2,
    totalDeposit: 21260,
    totalInflow: 21260,
    totalOutflow: 21260,
  });
  // The USD bucket holds only the one USD report; the two currency-less
  // reports did not leak into it.
  assert.deepEqual(s.byCurrency.USD, {
    reports: 1,
    totalDeposit: 10630,
    totalInflow: 10630,
    totalOutflow: 10630,
  });
});

test("error entries are excluded from every currency bucket", () => {
  const open = new Escrow("c-err-open");
  open.dispatch("FUND");
  const s = summarizeSettlementReports(
    buildSettlementReports([
      inputsFor(released("c-err-usd"), "USD"),
      inputsFor(open),
    ]),
  );
  assert.equal(s.errors, 1);
  assert.deepEqual(Object.keys(s.byCurrency), ["USD"]);
  assert.deepEqual(s.byCurrency.USD, {
    reports: 1,
    totalDeposit: 10630,
    totalInflow: 10630,
    totalOutflow: 10630,
  });
});

test("empty batch yields an empty byCurrency map", () => {
  const s = summarizeSettlementReports([]);
  assert.deepEqual(s.byCurrency, {});
  assert.equal(s.totalDeposit, 0);
});

test("all-error batch yields an empty byCurrency map", () => {
  const open1 = new Escrow("c-allerr-1");
  const open2 = new Escrow("c-allerr-2");
  const s = summarizeSettlementReports(
    buildSettlementReports([inputsFor(open1), inputsFor(open2)]),
  );
  assert.equal(s.errors, 2);
  assert.deepEqual(s.byCurrency, {});
  assert.equal(s.totalDeposit, 0);
});

test("per-bucket figures reproduce the underlying reports' own figures", () => {
  const results = buildSettlementReports([
    inputsFor(released("c-repro-usd"), "USD"),
    inputsFor(refunded("c-repro-eur"), "EUR"),
  ]);
  const usdReport = results[0].report!;
  const eurReport = results[1].report!;
  const s = summarizeSettlementReports(results);
  assert.equal(s.byCurrency.USD.totalDeposit, usdReport.deposit.deposit);
  assert.equal(s.byCurrency.USD.totalInflow, usdReport.totalInflow);
  assert.equal(s.byCurrency.USD.totalOutflow, usdReport.totalOutflow);
  assert.equal(s.byCurrency.EUR.totalDeposit, eurReport.deposit.deposit);
  assert.equal(s.byCurrency.EUR.totalInflow, eurReport.totalInflow);
  assert.equal(s.byCurrency.EUR.totalOutflow, eurReport.totalOutflow);
  // A released report's bucket still carries its own fee split; a
  // refunded report's bucket is the sponsor's full return.
  assert.equal(usdReport.parties[1].inflow, 10098.5);
  assert.equal(usdReport.parties[2].inflow, 531.5);
  assert.equal(eurReport.parties[0].inflow, 10630);
});

function fakeRefunded(id: string, amount: number, currency?: string): SettlementReportResult {
  const report: SettlementReport = {
    escrowId: id,
    ...(currency !== undefined ? { currency } : {}),
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
      { party: "sponsor", label: "Sponsor (depositor)", inflow: amount, outflow: amount, net: 0 },
      { party: "creator", label: "Creator (payee)", inflow: 0, outflow: 0, net: 0 },
      { party: "platform", label: "Platform (pro fee)", inflow: 0, outflow: 0, net: 0 },
      { party: "referrer", label: "Referrer (referral credits)", inflow: 0, outflow: 0, net: 0 },
    ],
    totalInflow: amount,
    totalOutflow: amount,
    balanced: true,
    eventCount: 2,
  };
  return { escrowId: id, report };
}

test("cent precision per bucket: 0.1 + 0.2 aggregates to exactly 0.3 in USD only", () => {
  const s = summarizeSettlementReports([
    fakeRefunded("c-cent-1", 0.1, "USD"),
    fakeRefunded("c-cent-2", 0.2, "USD"),
    fakeRefunded("c-cent-3", 0.1, "EUR"),
  ]);
  assert.equal(s.byCurrency.USD.totalDeposit, 0.3);
  assert.equal(s.byCurrency.USD.totalInflow, 0.3);
  assert.equal(s.byCurrency.EUR.totalDeposit, 0.1);
  // Top-level still sums raw figures across currencies (0.4), by design.
  assert.equal(s.totalDeposit, 0.4);
});

test("summarize does not mutate its input", () => {
  const results = buildSettlementReports([
    inputsFor(released("c-mut-usd"), "USD"),
    inputsFor(refunded("c-mut-eur"), "EUR"),
  ]);
  const before = JSON.stringify(results);
  summarizeSettlementReports(results);
  assert.equal(JSON.stringify(results), before);
});
