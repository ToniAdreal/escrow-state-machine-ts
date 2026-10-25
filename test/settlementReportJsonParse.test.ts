import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  calculateDeposit,
  parseSettlementReportJson,
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

test("released golden report round-trips through parse with every field intact", () => {
  const report = releasedReport();
  const parsed = parseSettlementReportJson(renderReportJson(report));
  assert.deepEqual(parsed, report);
  assert.equal(parsed.escrowId, "esc-10630");
  assert.equal(parsed.outcome, "released");
  assert.equal(parsed.releasePath, "VERIFY_PASS → RELEASE");
  assert.equal(parsed.balanced, true);
  assert.equal(parsed.eventCount, 4);
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
});

test("refunded report round-trips without releasePath or settlement keys", () => {
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
  const parsed = parseSettlementReportJson(renderReportJson(report));
  assert.deepEqual(parsed, report);
  assert.equal(parsed.outcome, "refunded");
  assert.equal(parsed.settlement, undefined);
  assert.equal(parsed.parties[0].inflow, 10630);
  assert.equal(parsed.parties[0].outflow, 10630);
});

test("expired report round-trips with outcome expired", () => {
  const e = new Escrow("esc-expired");
  e.dispatch("FUND");
  e.dispatch("EXPIRE");
  const report = buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: goldenDeposit(),
  });
  const parsed = parseSettlementReportJson(renderReportJson(report));
  assert.deepEqual(parsed, report);
  assert.equal(parsed.outcome, "expired");
});

test("referral-credits report round-trips with referrer ledger intact", () => {
  const escrow = releaseEscrow("esc-referral");
  const report = buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500, referralCredits: 200 },
  });
  const parsed = parseSettlementReportJson(renderReportJson(report));
  assert.deepEqual(parsed, report);
  // Creator net = 10630 − 531.50 − 200 = 9898.50.
  assert.equal(parsed.parties[1].net, 9898.5);
  assert.equal(parsed.parties[3].inflow, 200);
});

test("a parsed report re-renders byte-identically", () => {
  const report = releasedReport();
  const json = renderReportJson(report);
  assert.equal(renderReportJson(parseSettlementReportJson(json)), json);
});

test("an id carrying a comma or quote round-trips through parse", () => {
  const report = releasedReport('esc,"x');
  const parsed = parseSettlementReportJson(renderReportJson(report));
  assert.deepEqual(parsed, report);
  assert.equal(parsed.escrowId, 'esc,"x');
});

test("parsing twice yields independent copies, not shared objects", () => {
  const report = releasedReport();
  const json = renderReportJson(report);
  const first = parseSettlementReportJson(json);
  const second = parseSettlementReportJson(json);
  assert.notEqual(first.parties[0], second.parties[0]);
  assert.notEqual(first.deposit, second.deposit);
  first.parties[1].inflow = -1;
  assert.equal(second.parties[1].inflow, 10098.5);
  assert.equal(report.parties[1].inflow, 10098.5);
});

test("unparseable text throws a parse error, never a SyntaxError leak", () => {
  for (const text of ["", "{not json", '{"escrowId":', '{"escrowId": "esc-1",}']) {
    assert.throws(
      () => parseSettlementReportJson(text),
      /cannot parse settlement report JSON: invalid JSON/,
      JSON.stringify(text),
    );
  }
});

test("valid JSON that is not a report object is rejected", () => {
  for (const text of ["null", "[]", '"hello"', "42", "true"]) {
    assert.throws(
      () => parseSettlementReportJson(text),
      /cannot parse settlement report JSON: report must be a SettlementReport object/,
      text,
    );
  }
});

test("a non-string input is rejected before any parsing", () => {
  assert.throws(
    () => parseSettlementReportJson(undefined as unknown as string),
    /cannot parse settlement report JSON: input must be a JSON string/,
  );
  assert.throws(
    () => parseSettlementReportJson(10630 as unknown as string),
    /cannot parse settlement report JSON: input must be a JSON string/,
  );
});

test("damaged report fields are rejected with the parse prefix", () => {
  const base = releasedReport();
  const baseJson = renderReportJson(base);
  const damaged: Array<[string, string, RegExp]> = [
    [
      "empty escrowId",
      JSON.stringify({ ...base, escrowId: "" }),
      /cannot parse settlement report JSON: escrowId must be a non-empty string/,
    ],
    [
      "missing escrowId",
      JSON.stringify(Object.fromEntries(Object.entries(base).filter(([k]) => k !== "escrowId"))),
      /cannot parse settlement report JSON: escrowId must be a non-empty string/,
    ],
    [
      "illegal outcome",
      JSON.stringify({ ...base, outcome: "pending" }),
      /cannot parse settlement report JSON: outcome must be "released", "refunded", or "expired"/,
    ],
    [
      "empty parties",
      JSON.stringify({ ...base, parties: [] }),
      /cannot parse settlement report JSON: parties must be a non-empty array/,
    ],
    [
      "unknown party role",
      JSON.stringify({
        ...base,
        parties: [{ party: "oracle", label: "Oracle", inflow: 0, outflow: 0, net: 0 }],
      }),
      /cannot parse settlement report JSON: each party\.party must be a PartyRole/,
    ],
    [
      "missing deposit",
      JSON.stringify(Object.fromEntries(Object.entries(base).filter(([k]) => k !== "deposit"))),
      /cannot parse settlement report JSON: deposit must be a FeeBreakdown object/,
    ],
    [
      "non-boolean balanced",
      JSON.stringify({ ...base, balanced: "yes" }),
      /cannot parse settlement report JSON: balanced must be a boolean/,
    ],
    [
      "negative eventCount",
      JSON.stringify({ ...base, eventCount: -1 }),
      /cannot parse settlement report JSON: eventCount must be a non-negative integer/,
    ],
  ];
  for (const [name, text, pattern] of damaged) {
    assert.throws(() => parseSettlementReportJson(text), pattern, name);
  }
  // The base document itself parses: the rejections above come from the
  // damage, not from the fixture.
  assert.equal(parseSettlementReportJson(baseJson).escrowId, "esc-10630");
});

test("non-finite money figures are rejected, in every JSON spelling", () => {
  const base = releasedReport();
  const json = renderReportJson(base);
  // 1e999 is valid JSON syntax but parses to Infinity.
  const overflowDeposit = json.replace('"deposit":10630', '"deposit":1e999');
  assert.notEqual(overflowDeposit, json);
  assert.throws(
    () => parseSettlementReportJson(overflowDeposit),
    /cannot parse settlement report JSON: deposit\.deposit must be a finite number/,
  );
  const overflowInflow = json.replace('"inflow":10098.5', '"inflow":1e999');
  assert.notEqual(overflowInflow, json);
  assert.throws(
    () => parseSettlementReportJson(overflowInflow),
    /cannot parse settlement report JSON: each party\.inflow must be a finite number/,
  );
  // A non-finite figure that passed through a plain JSON.stringify arrives
  // as null, which must fail the same way rather than parse as zero.
  const nullDeposit = JSON.stringify({
    ...base,
    deposit: { ...base.deposit, deposit: null },
  });
  assert.throws(
    () => parseSettlementReportJson(nullDeposit),
    /cannot parse settlement report JSON: deposit\.deposit must be a finite number/,
  );
  const nullSettlement = JSON.stringify({
    ...base,
    settlement: { ...base.settlement, net: null },
  });
  assert.throws(
    () => parseSettlementReportJson(nullSettlement),
    /cannot parse settlement report JSON: settlement\.net must be a finite number/,
  );
});

test("a parsed report is a SettlementReport, not a re-derived audit", () => {
  // Structural import only: a hand-built document with consistent fields
  // parses, even though no escrow history backs it. This pins the honest
  // limit documented on parseSettlementReportJson — chain verification
  // still belongs to verifyHistoryChain, not to this import.
  const handBuilt: SettlementReport = {
    escrowId: "esc-hand",
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
  const parsed = parseSettlementReportJson(JSON.stringify(handBuilt));
  assert.deepEqual(parsed, handBuilt);
});
