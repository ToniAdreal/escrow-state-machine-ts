import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  calculateDeposit,
  renderReportJson,
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

test("released golden report round-trips through JSON with every field intact", () => {
  const report = releasedReport();
  const parsed = JSON.parse(renderReportJson(report)) as SettlementReport;
  assert.deepEqual(parsed, report);
  assert.equal(parsed.escrowId, "esc-10630");
  assert.equal(parsed.outcome, "released");
  assert.equal(parsed.releasePath, "VERIFY_PASS → RELEASE");
  assert.equal(parsed.balanced, true);
  assert.equal(parsed.eventCount, 4);
});

test("released golden deposit breakdown and party ledgers are pinned", () => {
  const parsed = JSON.parse(renderReportJson(releasedReport())) as SettlementReport;
  // Deposit: 10000 + 600 − 30 + 60 = 10630.
  assert.equal(parsed.deposit.deposit, 10630);
  assert.equal(parsed.deposit.creatorPool, 10000);
  assert.equal(parsed.deposit.oracleFee, 60);
  // 5% of 10630 = 531.50 pro fee; creator net = 10630 − 531.50 = 10098.50.
  assert.deepEqual(
    parsed.parties.map((p) => [p.party, p.inflow, p.outflow, p.net]),
    [
      ["sponsor", 0, 10630, -10630],
      ["creator", 10098.5, 0, 10098.5],
      ["platform", 531.5, 0, 531.5],
      ["referrer", 0, 0, 0],
    ],
  );
  assert.deepEqual(
    parsed.settlement,
    { gross: 10630, proFee: 531.5, referralCredits: 0, net: 10098.5 },
  );
  assert.equal(parsed.totalInflow, 10630);
  assert.equal(parsed.totalOutflow, 10630);
});

test("amounts stay JSON numbers, never two-decimal strings", () => {
  const json = renderReportJson(releasedReport());
  const parsed = JSON.parse(json) as SettlementReport;
  assert.equal(typeof parsed.deposit.deposit, "number");
  assert.equal(typeof parsed.parties[1].inflow, "number");
  assert.equal(typeof parsed.parties[2].inflow, "number");
  // Raw text carries the number, not the CSV-style quoted string.
  assert.ok(json.includes('"inflow":10098.5'));
  assert.ok(!json.includes('"inflow":"10098.50"'));
  assert.ok(!json.includes('"deposit":10630.00'));
});

test("refunded escrow returns the full deposit to the sponsor in JSON", () => {
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
  const parsed = JSON.parse(renderReportJson(report)) as SettlementReport;
  assert.deepEqual(parsed, report);
  assert.equal(parsed.outcome, "refunded");
  assert.equal(parsed.settlement, undefined);
  assert.deepEqual(
    parsed.parties.map((p) => [p.party, p.inflow, p.outflow, p.net]),
    [
      ["sponsor", 10630, 10630, 0],
      ["creator", 0, 0, 0],
      ["platform", 0, 0, 0],
      ["referrer", 0, 0, 0],
    ],
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
  const parsed = JSON.parse(renderReportJson(report)) as SettlementReport;
  assert.equal(parsed.outcome, "expired");
  assert.equal(parsed.parties[0].inflow, 10630);
  assert.equal(parsed.parties[0].outflow, 10630);
});

test("referral credits land on the referrer in JSON, creator net shrinks", () => {
  const escrow = releaseEscrow("esc-referral");
  const report = buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500, referralCredits: 200 },
  });
  const parsed = JSON.parse(renderReportJson(report)) as SettlementReport;
  // Creator net = 10630 − 531.50 − 200 = 9898.50.
  assert.equal(parsed.parties[1].net, 9898.5);
  assert.equal(parsed.parties[3].inflow, 200);
  assert.equal(parsed.settlement?.referralCredits, 200);
});

test("rendering twice is byte-identical and does not mutate the report", () => {
  const report = releasedReport();
  const before = JSON.stringify(report);
  assert.equal(renderReportJson(report), renderReportJson(report));
  assert.equal(JSON.stringify(report), before);
});

test("undefined optional fields are omitted, not serialized as null", () => {
  const report: SettlementReport = {
    escrowId: "esc-minimal",
    outcome: "refunded",
    deposit: goldenDeposit(),
    parties: [
      { party: "sponsor", label: "Sponsor (depositor)", inflow: 10630, outflow: 10630, net: 0 },
      { party: "creator", label: "Creator (payee)", inflow: 0, outflow: 0, net: 0 },
      { party: "platform", label: "Platform (pro fee)", inflow: 0, outflow: 0, net: 0 },
      { party: "referrer", label: "Referrer (referral credits)", inflow: 0, outflow: 0, net: 0 },
    ],
    totalInflow: 10630,
    totalOutflow: 10630,
    balanced: true,
    eventCount: 3,
  };
  const parsed = JSON.parse(renderReportJson(report)) as Record<string, unknown>;
  assert.equal("releasePath" in parsed, false);
  assert.equal("settlement" in parsed, false);
  assert.equal("firstEventAt" in parsed, false);
  assert.equal(parsed.outcome, "refunded");
});

test("an id carrying a comma or quote round-trips through JSON escaping", () => {
  const report = releasedReport('esc,"x');
  const parsed = JSON.parse(renderReportJson(report)) as SettlementReport;
  assert.equal(parsed.escrowId, 'esc,"x');
  assert.deepEqual(parsed, report);
});

test("non-report inputs throw an explicit error instead of serializing", () => {
  const base = releasedReport();
  const bad: Array<[string, unknown]> = [
    ["null", null],
    ["array", []],
    ["string", "not a report"],
    ["number", 10630],
    ["missing escrowId", { ...base, escrowId: "" }],
    ["bad outcome", { ...base, outcome: "pending" }],
    ["missing parties", { ...base, parties: [] }],
    ["unknown party role", { ...base, parties: [{ party: "oracle", label: "Oracle", inflow: 0, outflow: 0, net: 0 }] }],
    ["non-finite inflow", { ...base, parties: base.parties.map((p) => (p.party === "creator" ? { ...p, inflow: Infinity } : p)) }],
    ["non-finite deposit", { ...base, deposit: { ...base.deposit, deposit: NaN } }],
    ["non-boolean balanced", { ...base, balanced: "yes" }],
    ["negative eventCount", { ...base, eventCount: -1 }],
  ];
  for (const [name, value] of bad) {
    assert.throws(
      () => renderReportJson(value as SettlementReport),
      /cannot render settlement report as JSON/,
      name,
    );
  }
});
