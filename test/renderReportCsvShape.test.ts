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

// Mirrors the golden fixtures in settlementReportCsv.test.ts: pool $10,000,
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
  });
}

test("Infinity party inflow is rejected instead of rendering an Infinity row", () => {
  const report = releasedReport();
  const bad = {
    ...report,
    parties: report.parties.map((p) =>
      p.party === "creator" ? { ...p, inflow: Infinity } : p,
    ),
  };
  assert.throws(
    () => renderReportCsv(bad),
    /cannot render settlement report as CSV: each party\.inflow must be a finite number/,
  );
});

test("NaN party outflow is rejected instead of rendering a NaN row", () => {
  const report = releasedReport();
  const bad = {
    ...report,
    parties: report.parties.map((p) =>
      p.party === "sponsor" ? { ...p, outflow: NaN } : p,
    ),
  };
  assert.throws(
    () => renderReportCsv(bad),
    /cannot render settlement report as CSV: each party\.outflow must be a finite number/,
  );
});

test("Infinity party net is rejected even when inflow/outflow are finite", () => {
  const report = releasedReport();
  const bad = {
    ...report,
    parties: report.parties.map((p) =>
      p.party === "platform" ? { ...p, net: Infinity } : p,
    ),
  };
  assert.throws(
    () => renderReportCsv(bad),
    /cannot render settlement report as CSV: each party\.net must be a finite number/,
  );
});

test("empty escrowId is rejected", () => {
  const bad = { ...releasedReport(), escrowId: "" };
  assert.throws(
    () => renderReportCsv(bad),
    /cannot render settlement report as CSV: escrowId must be a non-empty string/,
  );
});

test("empty parties array is rejected", () => {
  const bad = { ...releasedReport(), parties: [] };
  assert.throws(
    () => renderReportCsv(bad),
    /cannot render settlement report as CSV: parties must be a non-empty array/,
  );
});

test("unknown party role is rejected", () => {
  const report = releasedReport();
  const bad = {
    ...report,
    parties: report.parties.map((p) =>
      p.party === "referrer" ? { ...p, party: "oracle" } : p,
    ),
  };
  assert.throws(
    () => renderReportCsv(bad as unknown as SettlementReport),
    /cannot render settlement report as CSV: each party\.party must be a PartyRole/,
  );
});

test("non-finite totalInflow on a full report is rejected", () => {
  const bad = { ...releasedReport(), totalInflow: Infinity };
  assert.throws(
    () => renderReportCsv(bad),
    /cannot render settlement report as CSV: totalInflow must be a finite number/,
  );
});

test("non-object report is rejected", () => {
  assert.throws(
    () => renderReportCsv(null as unknown as SettlementReport),
    /cannot render settlement report as CSV: report must be a SettlementReport object/,
  );
});

test("released golden report still renders byte-identically", () => {
  assert.equal(
    renderReportCsv(releasedReport()),
    [
      "escrowId,outcome,role,inflow,outflow,net",
      "esc-10630,released,sponsor,0.00,10630.00,-10630.00",
      "esc-10630,released,creator,10098.50,0.00,10098.50",
      "esc-10630,released,platform,531.50,0.00,531.50",
      "esc-10630,released,referrer,0.00,0.00,0.00",
      "esc-10630,released,TOTAL,10630.00,10630.00,0.00",
    ].join("\n"),
  );
});

test("refunded golden report still renders byte-identically", () => {
  assert.equal(
    renderReportCsv(refundedReport()),
    [
      "escrowId,outcome,role,inflow,outflow,net",
      "esc-refund,refunded,sponsor,10630.00,10630.00,0.00",
      "esc-refund,refunded,creator,0.00,0.00,0.00",
      "esc-refund,refunded,platform,0.00,0.00,0.00",
      "esc-refund,refunded,referrer,0.00,0.00,0.00",
      "esc-refund,refunded,TOTAL,10630.00,10630.00,0.00",
    ].join("\n"),
  );
});

test("expired golden report still renders byte-identically", () => {
  assert.equal(
    renderReportCsv(expiredReport()),
    [
      "escrowId,outcome,role,inflow,outflow,net",
      "esc-expired,expired,sponsor,10630.00,10630.00,0.00",
      "esc-expired,expired,creator,0.00,0.00,0.00",
      "esc-expired,expired,platform,0.00,0.00,0.00",
      "esc-expired,expired,referrer,0.00,0.00,0.00",
      "esc-expired,expired,TOTAL,10630.00,10630.00,0.00",
    ].join("\n"),
  );
});

test("parsed CSV subset still re-renders byte-identically through the gate", () => {
  const csv = renderReportCsv(releasedReport());
  const parsed = parseSettlementReportCsv(csv);
  assert.equal(renderReportCsv(parsed), csv);
});

test("bare carried-fields value without totals still renders", () => {
  const report = releasedReport();
  const bare = {
    escrowId: report.escrowId,
    outcome: report.outcome,
    parties: report.parties,
  };
  assert.equal(
    renderReportCsv(bare as unknown as SettlementReport),
    renderReportCsv(report),
  );
});
