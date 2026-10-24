import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  calculateDeposit,
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

function releasedReport(id = "esc-10630") {
  const escrow = releaseEscrow(id);
  return buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500 },
  });
}

test("released golden fixture renders the exact CSV rows", () => {
  const csv = renderReportCsv(releasedReport());
  // 5% of 10630 = 531.50 pro fee; creator net = 10630 − 531.50 = 10098.50.
  assert.equal(
    csv,
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

test("refunded escrow returns the full deposit to the sponsor in CSV", () => {
  const e = new Escrow("esc-refund");
  e.dispatch("FUND");
  e.dispatch("DISPUTE");
  e.dispatch("ARBITRATE_REFUND");
  const report = buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: goldenDeposit(),
  });
  assert.equal(
    renderReportCsv(report),
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

test("expired escrow renders the same full-refund shape with outcome expired", () => {
  const e = new Escrow("esc-expired");
  e.dispatch("FUND");
  e.dispatch("EXPIRE");
  const report = buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: goldenDeposit(),
  });
  const lines = renderReportCsv(report).split("\n");
  assert.equal(lines[0], "escrowId,outcome,role,inflow,outflow,net");
  assert.equal(lines[1], "esc-expired,expired,sponsor,10630.00,10630.00,0.00");
  assert.equal(lines[5], "esc-expired,expired,TOTAL,10630.00,10630.00,0.00");
});

test("TOTAL row sums agree with the report totals and the party nets", () => {
  const report = releasedReport();
  const lines = renderReportCsv(report).split("\n");
  const total = lines[lines.length - 1].split(",");
  assert.equal(total[3], report.totalInflow.toFixed(2));
  assert.equal(total[4], report.totalOutflow.toFixed(2));
  const netSum = Math.round(
    report.parties.reduce((s, p) => s + p.net, 0) * 100,
  ) / 100;
  assert.equal(total[5], netSum.toFixed(2));
});

test("zero-amount parties still get their own row", () => {
  const lines = renderReportCsv(releasedReport()).split("\n");
  // Header + 4 party rows + TOTAL = 6 lines; the referrer row is all zeros
  // but present, so an import never has to guess whether a party is missing.
  assert.equal(lines.length, 6);
  assert.equal(lines[4], "esc-10630,released,referrer,0.00,0.00,0.00");
});

test("referral credits land on the referrer row at two decimals", () => {
  const escrow = releaseEscrow("esc-referral");
  const report = buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500, referralCredits: 200 },
  });
  const lines = renderReportCsv(report).split("\n");
  // Creator net = 10630 − 531.50 − 200 = 9898.50.
  assert.equal(lines[2], "esc-referral,released,creator,9898.50,0.00,9898.50");
  assert.equal(lines[4], "esc-referral,released,referrer,200.00,0.00,200.00");
});

test("party rows keep the fixed sponsor/creator/platform/referrer order", () => {
  const roles = renderReportCsv(releasedReport())
    .split("\n")
    .slice(1, 5)
    .map((line) => line.split(",")[2]);
  assert.deepEqual(roles, ["sponsor", "creator", "platform", "referrer"]);
});

test("amounts never carry thousands separators", () => {
  const csv = renderReportCsv(releasedReport());
  assert.ok(!csv.includes("10,630"));
  assert.ok(csv.includes("10630.00"));
  assert.ok(csv.includes("10098.50"));
});

test("fields with a comma or quote are RFC 4180-escaped", () => {
  const report: SettlementReport = {
    escrowId: 'esc,"x',
    outcome: "released",
    deposit: goldenDeposit(),
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
  const lines = renderReportCsv(report).split("\n");
  assert.equal(lines[1], '"esc,""x",released,sponsor,0.00,10630.00,-10630.00');
  assert.equal(lines[5], '"esc,""x",released,TOTAL,10630.00,10630.00,0.00');
});

test("output is newline-joined with no trailing newline", () => {
  const csv = renderReportCsv(releasedReport());
  assert.ok(!csv.endsWith("\n"));
  assert.equal(csv.split("\n").length, 6);
});
