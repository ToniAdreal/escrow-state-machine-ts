import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  calculateDeposit,
  parseSettlementReportCsv,
  renderReportCsv,
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

function releaseEscrow(id = "esc-10630") {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return e;
}

function releasedReport(id = "esc-10630", currency?: string) {
  const escrow = releaseEscrow(id);
  return buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500 },
    ...(currency !== undefined ? { currency } : {}),
  });
}

test("USD report renders the currency column with the code on every row", () => {
  const csv = renderReportCsv(releasedReport("esc-10630", "USD"));
  assert.equal(
    csv,
    [
      "escrowId,outcome,currency,role,inflow,outflow,net",
      "esc-10630,released,USD,sponsor,0.00,10630.00,-10630.00",
      "esc-10630,released,USD,creator,10098.50,0.00,10098.50",
      "esc-10630,released,USD,platform,531.50,0.00,531.50",
      "esc-10630,released,USD,referrer,0.00,0.00,0.00",
      "esc-10630,released,USD,TOTAL,10630.00,10630.00,0.00",
    ].join("\n"),
  );
});

test("EUR and USD reports differ only in the currency column", () => {
  // A multi-currency bookkeeping import must be able to tell the two
  // apart from the CSV alone, without re-querying the report.
  const usd = renderReportCsv(releasedReport("esc-10630", "USD"));
  const eur = renderReportCsv(releasedReport("esc-10630", "EUR"));
  assert.notEqual(usd, eur);
  for (const line of eur.split("\n").slice(1)) {
    assert.equal(line.split(",")[2], "EUR");
  }
  for (const line of usd.split("\n").slice(1)) {
    assert.equal(line.split(",")[2], "USD");
  }
});

test("currency-less report renders the same 7-column shape with an empty currency column", () => {
  const csv = renderReportCsv(releasedReport());
  assert.equal(
    csv,
    [
      "escrowId,outcome,currency,role,inflow,outflow,net",
      "esc-10630,released,,sponsor,0.00,10630.00,-10630.00",
      "esc-10630,released,,creator,10098.50,0.00,10098.50",
      "esc-10630,released,,platform,531.50,0.00,531.50",
      "esc-10630,released,,referrer,0.00,0.00,0.00",
      "esc-10630,released,,TOTAL,10630.00,10630.00,0.00",
    ].join("\n"),
  );
  // Same column count as the currency-carrying export, so an importer
  // never has to guess the shape from the header.
  for (const line of csv.split("\n")) {
    assert.equal(line.split(",").length, 7);
  }
});

test("USD report round-trips: parse recovers the currency and re-renders byte-identically", () => {
  const report = releasedReport("esc-10630", "USD");
  const csv = renderReportCsv(report);
  const parsed = parseSettlementReportCsv(csv);
  assert.equal(parsed.currency, "USD");
  assert.equal(renderReportCsv(parsed), csv);
});

test("currency-less report round-trips without inventing a currency", () => {
  const report = releasedReport();
  const csv = renderReportCsv(report);
  const parsed = parseSettlementReportCsv(csv);
  assert.equal("currency" in parsed, false);
  assert.equal(parsed.currency, undefined);
  assert.equal(renderReportCsv(parsed), csv);
});

test("parse rejects a lowercase currency code", () => {
  const csv = renderReportCsv(releasedReport("esc-10630", "USD")).replaceAll(
    ",USD,",
    ",usd,",
  );
  assert.throws(
    () => parseSettlementReportCsv(csv),
    (err: unknown) =>
      err instanceof Error &&
      err.message.startsWith("cannot parse settlement report CSV") &&
      /currency must be a 3-letter uppercase ISO 4217 code/.test(err.message),
  );
});

test("parse rejects a four-letter currency code", () => {
  const csv = renderReportCsv(releasedReport("esc-10630", "USD")).replaceAll(
    ",USD,",
    ",USDD,",
  );
  assert.throws(
    () => parseSettlementReportCsv(csv),
    (err: unknown) =>
      err instanceof Error &&
      err.message.startsWith("cannot parse settlement report CSV") &&
      /currency must be a 3-letter uppercase ISO 4217 code/.test(err.message),
  );
});

test("parse rejects a currency mismatch across rows", () => {
  const csv = renderReportCsv(releasedReport("esc-10630", "USD")).replace(
    "esc-10630,released,USD,creator",
    "esc-10630,released,EUR,creator",
  );
  assert.throws(
    () => parseSettlementReportCsv(csv),
    (err: unknown) =>
      err instanceof Error &&
      err.message.startsWith("cannot parse settlement report CSV") &&
      /currency .* does not match/.test(err.message),
  );
});

test("render rejects a hand-built report with an illegal currency", () => {
  const report: SettlementReport = {
    ...releasedReport(),
    currency: "usd",
  };
  assert.throws(
    () => renderReportCsv(report),
    (err: unknown) =>
      err instanceof Error &&
      err.message ===
        "cannot render settlement report as CSV: currency must be a 3-letter uppercase ISO 4217 code when present",
  );
});

test("build still rejects an illegal currency before any money math runs", () => {
  const escrow = releaseEscrow("esc-10630");
  assert.throws(
    () =>
      buildSettlementReport({
        escrowId: escrow.id,
        history: escrow.history,
        finalState: escrow.state,
        deposit: goldenDeposit(),
        settlement: { proFeeBps: 500 },
        currency: "usd",
      }),
    /invalid settlement currency.*must be a 3-letter uppercase ISO 4217 code/,
  );
});
