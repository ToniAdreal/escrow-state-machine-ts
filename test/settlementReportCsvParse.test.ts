import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  calculateDeposit,
  parseSettlementReportCsv,
  renderReportCsv,
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

function refundedReport(id = "esc-refund") {
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

const CSV_PREFIX = "cannot parse settlement report CSV";

test("released golden report round-trips through parse with every CSV-carried field intact", () => {
  const report = releasedReport();
  const parsed = parseSettlementReportCsv(renderReportCsv(report));
  assert.equal(parsed.escrowId, "esc-10630");
  assert.equal(parsed.outcome, "released");
  // 5% of 10630 = 531.50 pro fee; creator net = 10630 − 531.50 = 10098.50.
  assert.deepEqual(parsed.parties, report.parties);
  assert.equal(parsed.totalInflow, report.totalInflow);
  assert.equal(parsed.totalOutflow, report.totalOutflow);
  assert.equal(parsed.balanced, true);
  // The CSV carries no deposit breakdown, settlement, releasePath,
  // eventCount, or audit window — the parsed value must not claim them.
  assert.equal("deposit" in parsed, false);
  assert.equal("settlement" in parsed, false);
  assert.equal("eventCount" in parsed, false);
});

test("parsed value re-renders byte-identically through renderReportCsv", () => {
  const report = releasedReport();
  const csv = renderReportCsv(report);
  assert.equal(renderReportCsv(parseSettlementReportCsv(csv)), csv);
});

test("refunded and expired reports round-trip with full-refund rows", () => {
  const refunded = parseSettlementReportCsv(renderReportCsv(refundedReport()));
  assert.equal(refunded.outcome, "refunded");
  assert.deepEqual(
    refunded.parties.map((p) => [p.party, p.inflow, p.outflow, p.net]),
    [
      ["sponsor", 10630, 10630, 0],
      ["creator", 0, 0, 0],
      ["platform", 0, 0, 0],
      ["referrer", 0, 0, 0],
    ],
  );
  assert.equal(refunded.totalInflow, 10630);
  assert.equal(refunded.totalOutflow, 10630);
  assert.equal(refunded.balanced, true);

  const e = new Escrow("esc-expired");
  e.dispatch("FUND");
  e.dispatch("EXPIRE");
  const expired = buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: goldenDeposit(),
  });
  const parsedExpired = parseSettlementReportCsv(renderReportCsv(expired));
  assert.equal(parsedExpired.outcome, "expired");
  assert.equal(parsedExpired.totalInflow, 10630);
  assert.equal(renderReportCsv(parsedExpired), renderReportCsv(expired));
});

test("RFC 4180-quoted escrowId with comma and quote round-trips", () => {
  const csv = renderReportCsv(releasedReport('esc,"x'));
  const parsed = parseSettlementReportCsv(csv);
  assert.equal(parsed.escrowId, 'esc,"x');
  assert.equal(renderReportCsv(parsed), csv);
});

test("party rows in any order parse and keep CSV order", () => {
  const csv = [
    "escrowId,outcome,role,inflow,outflow,net",
    "esc-10630,released,referrer,0.00,0.00,0.00",
    "esc-10630,released,platform,531.50,0.00,531.50",
    "esc-10630,released,creator,10098.50,0.00,10098.50",
    "esc-10630,released,sponsor,0.00,10630.00,-10630.00",
    "esc-10630,released,TOTAL,10630.00,10630.00,0.00",
  ].join("\n");
  const parsed = parseSettlementReportCsv(csv);
  assert.deepEqual(
    parsed.parties.map((p) => p.party),
    ["referrer", "platform", "creator", "sponsor"],
  );
  assert.equal(renderReportCsv(parsed), csv);
});

test("CRLF line endings, a trailing newline, and a BOM are tolerated", () => {
  const csv = renderReportCsv(releasedReport()).replace(/\n/g, "\r\n");
  const parsed = parseSettlementReportCsv(`\uFEFF${csv}\r\n`);
  assert.equal(parsed.escrowId, "esc-10630");
  assert.equal(parsed.totalInflow, 10630);
});

test("an unbalanced hand-built CSV parses with balanced false, not a throw", () => {
  const csv = [
    "escrowId,outcome,role,inflow,outflow,net",
    "esc-x,released,sponsor,0.00,100.00,-100.00",
    "esc-x,released,creator,90.00,0.00,90.00",
    "esc-x,released,platform,5.00,0.00,5.00",
    "esc-x,released,referrer,0.00,0.00,0.00",
    "esc-x,released,TOTAL,95.00,100.00,-5.00",
  ].join("\n");
  const parsed = parseSettlementReportCsv(csv);
  assert.equal(parsed.balanced, false);
  assert.equal(parsed.totalInflow, 95);
  assert.equal(parsed.totalOutflow, 100);
});

const damaged: Array<[string, string, RegExp]> = [
  ["empty input", "", /expected 6 records/],
  [
    "wrong header",
    "id,outcome,role,inflow,outflow,net\nesc-10630,released,sponsor,0.00,10630.00,-10630.00\nesc-10630,released,creator,10098.50,0.00,10098.50\nesc-10630,released,platform,531.50,0.00,531.50\nesc-10630,released,referrer,0.00,0.00,0.00\nesc-10630,released,TOTAL,10630.00,10630.00,0.00",
    /header must be exactly/,
  ],
  [
    "missing TOTAL row",
    "escrowId,outcome,role,inflow,outflow,net\nesc-10630,released,sponsor,0.00,10630.00,-10630.00\nesc-10630,released,creator,10098.50,0.00,10098.50\nesc-10630,released,platform,531.50,0.00,531.50\nesc-10630,released,referrer,0.00,0.00,0.00",
    /expected 6 records/,
  ],
  [
    "TOTAL inflow disagrees with party rows",
    "escrowId,outcome,role,inflow,outflow,net\nesc-10630,released,sponsor,0.00,10630.00,-10630.00\nesc-10630,released,creator,10098.50,0.00,10098.50\nesc-10630,released,platform,531.50,0.00,531.50\nesc-10630,released,referrer,0.00,0.00,0.00\nesc-10630,released,TOTAL,10631.00,10630.00,0.00",
    /TOTAL row inflow .* does not equal the sum/,
  ],
  [
    "TOTAL net disagrees with party rows",
    "escrowId,outcome,role,inflow,outflow,net\nesc-10630,released,sponsor,0.00,10630.00,-10630.00\nesc-10630,released,creator,10098.50,0.00,10098.50\nesc-10630,released,platform,531.50,0.00,531.50\nesc-10630,released,referrer,0.00,0.00,0.00\nesc-10630,released,TOTAL,10630.00,10630.00,1.00",
    /TOTAL row net .* does not equal the sum/,
  ],
  [
    "party net disagrees with its inflow minus outflow",
    "escrowId,outcome,role,inflow,outflow,net\nesc-10630,released,sponsor,0.00,10630.00,-10630.00\nesc-10630,released,creator,10098.50,0.00,10099.50\nesc-10630,released,platform,531.50,0.00,531.50\nesc-10630,released,referrer,0.00,0.00,0.00\nesc-10630,released,TOTAL,10630.00,10630.00,0.00",
    /net .* does not equal inflow .* minus outflow/,
  ],
  [
    "unknown party role",
    "escrowId,outcome,role,inflow,outflow,net\nesc-10630,released,sponsor,0.00,10630.00,-10630.00\nesc-10630,released,creator,10098.50,0.00,10098.50\nesc-10630,released,platform,531.50,0.00,531.50\nesc-10630,released,auditor,0.00,0.00,0.00\nesc-10630,released,TOTAL,10630.00,10630.00,0.00",
    /role must be a PartyRole/,
  ],
  [
    "duplicate party role",
    "escrowId,outcome,role,inflow,outflow,net\nesc-10630,released,sponsor,0.00,10630.00,-10630.00\nesc-10630,released,creator,10098.50,0.00,10098.50\nesc-10630,released,platform,531.50,0.00,531.50\nesc-10630,released,creator,0.00,0.00,0.00\nesc-10630,released,TOTAL,10630.00,10630.00,0.00",
    /appears more than once/,
  ],
  [
    "missing referrer row, replaced by a second TOTAL-shaped row",
    "escrowId,outcome,role,inflow,outflow,net\nesc-10630,released,sponsor,0.00,10630.00,-10630.00\nesc-10630,released,creator,10098.50,0.00,10098.50\nesc-10630,released,platform,531.50,0.00,531.50\nesc-10630,released,TOTAL,10630.00,10630.00,0.00\nesc-10630,released,TOTAL,10630.00,10630.00,0.00",
    /role must be a PartyRole/,
  ],
  [
    "escrowId mismatch across rows",
    "escrowId,outcome,role,inflow,outflow,net\nesc-10630,released,sponsor,0.00,10630.00,-10630.00\nesc-other,released,creator,10098.50,0.00,10098.50\nesc-10630,released,platform,531.50,0.00,531.50\nesc-10630,released,referrer,0.00,0.00,0.00\nesc-10630,released,TOTAL,10630.00,10630.00,0.00",
    /escrowId .* does not match/,
  ],
  [
    "outcome mismatch across rows",
    "escrowId,outcome,role,inflow,outflow,net\nesc-10630,released,sponsor,0.00,10630.00,-10630.00\nesc-10630,refunded,creator,10098.50,0.00,10098.50\nesc-10630,released,platform,531.50,0.00,531.50\nesc-10630,released,referrer,0.00,0.00,0.00\nesc-10630,released,TOTAL,10630.00,10630.00,0.00",
    /outcome .* does not match/,
  ],
  [
    "non-numeric amount",
    "escrowId,outcome,role,inflow,outflow,net\nesc-10630,released,sponsor,0.00,10630.00,-10630.00\nesc-10630,released,creator,abc,0.00,10098.50\nesc-10630,released,platform,531.50,0.00,531.50\nesc-10630,released,referrer,0.00,0.00,0.00\nesc-10630,released,TOTAL,10630.00,10630.00,0.00",
    /must be a two-decimal money figure/,
  ],
  [
    "Infinity amount",
    "escrowId,outcome,role,inflow,outflow,net\nesc-10630,released,sponsor,0.00,10630.00,-10630.00\nesc-10630,released,creator,Infinity,0.00,10098.50\nesc-10630,released,platform,531.50,0.00,531.50\nesc-10630,released,referrer,0.00,0.00,0.00\nesc-10630,released,TOTAL,10630.00,10630.00,0.00",
    /must be a two-decimal money figure/,
  ],
  [
    "three-decimal amount",
    "escrowId,outcome,role,inflow,outflow,net\nesc-10630,released,sponsor,0.00,10630.00,-10630.00\nesc-10630,released,creator,10098.500,0.00,10098.50\nesc-10630,released,platform,531.50,0.00,531.50\nesc-10630,released,referrer,0.00,0.00,0.00\nesc-10630,released,TOTAL,10630.00,10630.00,0.00",
    /must be a two-decimal money figure/,
  ],
  [
    "negative inflow",
    "escrowId,outcome,role,inflow,outflow,net\nesc-10630,released,sponsor,0.00,10630.00,-10630.00\nesc-10630,released,creator,-10098.50,0.00,10098.50\nesc-10630,released,platform,531.50,0.00,531.50\nesc-10630,released,referrer,0.00,0.00,0.00\nesc-10630,released,TOTAL,10630.00,10630.00,0.00",
    /inflow must not be negative/,
  ],
  [
    "unterminated quoted field",
    'escrowId,outcome,role,inflow,outflow,net\n"esc-10630,released,sponsor,0.00,10630.00,-10630.00',
    /unterminated quoted field/,
  ],
  [
    "character after a closing quote",
    'escrowId,outcome,role,inflow,outflow,net\n"esc-10630"x,released,sponsor,0.00,10630.00,-10630.00\nesc-10630,released,creator,10098.50,0.00,10098.50\nesc-10630,released,platform,531.50,0.00,531.50\nesc-10630,released,referrer,0.00,0.00,0.00\nesc-10630,released,TOTAL,10630.00,10630.00,0.00',
    /unexpected character after a closing quote/,
  ],
  [
    "extra row after TOTAL",
    "escrowId,outcome,role,inflow,outflow,net\nesc-10630,released,sponsor,0.00,10630.00,-10630.00\nesc-10630,released,creator,10098.50,0.00,10098.50\nesc-10630,released,platform,531.50,0.00,531.50\nesc-10630,released,referrer,0.00,0.00,0.00\nesc-10630,released,TOTAL,10630.00,10630.00,0.00\nesc-10630,released,TOTAL,10630.00,10630.00,0.00",
    /expected 6 records/,
  ],
  [
    "empty escrowId",
    "escrowId,outcome,role,inflow,outflow,net\n,released,sponsor,0.00,10630.00,-10630.00\n,released,creator,10098.50,0.00,10098.50\n,released,platform,531.50,0.00,531.50\n,released,referrer,0.00,0.00,0.00\n,released,TOTAL,10630.00,10630.00,0.00",
    /escrowId must be a non-empty string/,
  ],
];

for (const [name, text, pattern] of damaged) {
  test(`damaged input rejected: ${name}`, () => {
    assert.throws(
      () => parseSettlementReportCsv(text),
      (err: unknown) =>
        err instanceof Error &&
        err.message.startsWith(CSV_PREFIX) &&
        pattern.test(err.message),
      name,
    );
  });
}

test("non-string input rejected", () => {
  assert.throws(
    () => parseSettlementReportCsv(10630 as unknown as string),
    (err: unknown) =>
      err instanceof Error && err.message.startsWith(CSV_PREFIX),
  );
});

test("two parses of the same text yield independent copies", () => {
  const csv = renderReportCsv(releasedReport());
  const first = parseSettlementReportCsv(csv);
  const second = parseSettlementReportCsv(csv);
  first.parties[0].inflow = 999;
  assert.equal(second.parties[0].inflow, 0);
  assert.notEqual(first.parties, second.parties);
});
