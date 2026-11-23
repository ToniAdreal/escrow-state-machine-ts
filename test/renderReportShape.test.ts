import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  calculateDeposit,
  renderReport,
  renderReportCsv,
  renderReportJson,
  type SettlementReport,
} from "../src/index.js";

// Mirrors the golden fixtures in settlementReport.test.ts: pool $10,000,
// base $600 × 1.0, loyalty −$30, oracle +$60 → deposit $10,630.
function goldenDeposit() {
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

function releasedReport(id = "esc-10630"): SettlementReport {
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

function refundedReport(id = "esc-refund"): SettlementReport {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("DISPUTE");
  e.dispatch("ARBITRATE_REFUND");
  return buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500 },
  });
}

function expiredReport(id = "esc-expired"): SettlementReport {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("EXPIRE");
  return buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500 },
  });
}

/** The named error the CSV/JSON renderers already throw, now shared. */
function assertNamedShapeError(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof Error, "must throw an Error");
    assert.ok(!(err instanceof TypeError), "must not be a bare TypeError");
    assert.match(err.message, pattern);
    return true;
  });
}

test("null report is rejected with a named error, not a bare TypeError", () => {
  assertNamedShapeError(
    () => renderReport(null as unknown as SettlementReport),
    /^cannot render settlement report: report must be a SettlementReport object$/,
  );
});

test("string report is rejected with a named error", () => {
  assertNamedShapeError(
    () => renderReport("x" as unknown as SettlementReport),
    /^cannot render settlement report: report must be a SettlementReport object$/,
  );
});

test("number report is rejected with a named error", () => {
  assertNamedShapeError(
    () => renderReport(42 as unknown as SettlementReport),
    /^cannot render settlement report: report must be a SettlementReport object$/,
  );
});

test("empty object report is rejected with a named error", () => {
  assertNamedShapeError(
    () => renderReport({} as unknown as SettlementReport),
    /^cannot render settlement report: escrowId must be a non-empty string$/,
  );
});

test("non-finite deposit figure is rejected with a named error", () => {
  const report = releasedReport();
  const bad = {
    ...report,
    deposit: { ...report.deposit, deposit: Infinity },
  };
  assertNamedShapeError(
    () => renderReport(bad),
    /^cannot render settlement report: deposit\.deposit must be a finite number$/,
  );
});

test("released golden report still renders byte-identically", () => {
  const report = releasedReport();
  assert.equal(
    renderReport(report),
    [
      "Escrow settlement report — esc-10630",
      "Outcome: released (via VERIFY_PASS → RELEASE)",
      "Deposit: $10,630.00 (pool $10,000.00 + base $600.00×1 − loyalty $30.00 + oracle $60.00)",
      "",
      "Party                                 Inflow       Outflow           Net",
      "------------------------------------------------------------------------",
      "Sponsor (depositor)                    $0.00    $10,630.00   $-10,630.00",
      "Creator (payee)                   $10,098.50         $0.00    $10,098.50",
      "Platform (pro fee)                   $531.50         $0.00       $531.50",
      "Referrer (referral credits)            $0.00         $0.00         $0.00",
      "",
      "Totals: inflow $10,630.00 = outflow $10,630.00 — balanced ✓",
      `Audit: 4 events, ${report.firstEventAt} → ${report.lastEventAt}`,
      "Note: oracle fee is bundled into the deposit (off-chain reproduction, no on-chain payout attributed).",
    ].join("\n"),
  );
});

test("refunded golden report still renders byte-identically", () => {
  const report = refundedReport();
  assert.equal(
    renderReport(report),
    [
      "Escrow settlement report — esc-refund",
      "Outcome: refunded",
      "Deposit: $10,630.00 (pool $10,000.00 + base $600.00×1 − loyalty $30.00 + oracle $60.00)",
      "",
      "Party                                 Inflow       Outflow           Net",
      "------------------------------------------------------------------------",
      "Sponsor (depositor)               $10,630.00    $10,630.00         $0.00",
      "Creator (payee)                        $0.00         $0.00         $0.00",
      "Platform (pro fee)                     $0.00         $0.00         $0.00",
      "Referrer (referral credits)            $0.00         $0.00         $0.00",
      "",
      "Totals: inflow $10,630.00 = outflow $10,630.00 — balanced ✓",
      `Audit: 3 events, ${report.firstEventAt} → ${report.lastEventAt}`,
    ].join("\n"),
  );
});

test("expired golden report still renders byte-identically", () => {
  const report = expiredReport();
  assert.equal(
    renderReport(report),
    [
      "Escrow settlement report — esc-expired",
      "Outcome: expired",
      "Deposit: $10,630.00 (pool $10,000.00 + base $600.00×1 − loyalty $30.00 + oracle $60.00)",
      "",
      "Party                                 Inflow       Outflow           Net",
      "------------------------------------------------------------------------",
      "Sponsor (depositor)               $10,630.00    $10,630.00         $0.00",
      "Creator (payee)                        $0.00         $0.00         $0.00",
      "Platform (pro fee)                     $0.00         $0.00         $0.00",
      "Referrer (referral credits)            $0.00         $0.00         $0.00",
      "",
      "Totals: inflow $10,630.00 = outflow $10,630.00 — balanced ✓",
      `Audit: 2 events, ${report.firstEventAt} → ${report.lastEventAt}`,
    ].join("\n"),
  );
});

test("released golden report CSV and JSON outputs are unchanged", () => {
  const report = releasedReport();
  assert.equal(
    renderReportCsv(report),
    [
      "escrowId,outcome,currency,settlementRef,refundRef,role,inflow,outflow,net",
      "esc-10630,released,,,,sponsor,0.00,10630.00,-10630.00",
      "esc-10630,released,,,,creator,10098.50,0.00,10098.50",
      "esc-10630,released,,,,platform,531.50,0.00,531.50",
      "esc-10630,released,,,,referrer,0.00,0.00,0.00",
      "esc-10630,released,,,,TOTAL,10630.00,10630.00,0.00",
    ].join("\n"),
  );
  assert.equal(
    renderReportJson(report),
    `{"escrowId":"esc-10630","deposit":{"creatorPool":10000,"baseFee":600,"complexityMultiplier":1,"loyaltyDiscount":30,"oracleFee":60,"adjustedBaseFee":600,"deposit":10630},"eventCount":4,"firstEventAt":"${report.firstEventAt}","lastEventAt":"${report.lastEventAt}","outcome":"released","releasePath":"VERIFY_PASS → RELEASE","settlement":{"gross":10630,"proFee":531.5,"referralCredits":0,"net":10098.5},"parties":[{"party":"sponsor","label":"Sponsor (depositor)","inflow":0,"outflow":10630,"net":-10630},{"party":"creator","label":"Creator (payee)","inflow":10098.5,"outflow":0,"net":10098.5},{"party":"platform","label":"Platform (pro fee)","inflow":531.5,"outflow":0,"net":531.5},{"party":"referrer","label":"Referrer (referral credits)","inflow":0,"outflow":0,"net":0}],"totalInflow":10630,"totalOutflow":10630,"balanced":true}`,
  );
});
