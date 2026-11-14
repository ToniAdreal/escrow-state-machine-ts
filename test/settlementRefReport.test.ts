import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementReports,
  calculateDeposit,
  diffSettlementReports,
  parseSettlementReportCsv,
  parseSettlementReportJson,
  renderReport,
  renderReportCsv,
  renderReportJson,
  summarizeSettlementReports,
  type EscrowHistoryEntry,
} from "../src/index.js";

/**
 * Backlog #1113: the settlement report carries the terminal RELEASE
 * entry's `settlementRef` — the one pointer from the audit report to
 * the real-world payment. The ref rides the report, the CSV and JSON
 * exports, the plain-text render, and the report diff; every other
 * outcome keeps its previous shape exactly.
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

function releaseEscrow(id: string, settlementRef?: string) {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch(
    "RELEASE",
    undefined,
    undefined,
    settlementRef !== undefined ? { settlementRef } : undefined,
  );
  return e;
}

function releasedReport(id: string, settlementRef?: string) {
  const escrow = releaseEscrow(id, settlementRef);
  return buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500 },
  });
}

/** A fully hashless (legacy) history: passes the chain check untouched. */
function handBuiltHistory(settlementRef: unknown): EscrowHistoryEntry[] {
  return [
    { seq: 1, event: "FUND", from: "CREATED", to: "FUNDED", at: "2026-03-06T08:00:00.000Z", amount: 10630 },
    { seq: 2, event: "SUBMIT_MILESTONE", from: "FUNDED", to: "MILESTONE_SUBMITTED", at: "2026-03-06T08:01:00.000Z" },
    { seq: 3, event: "VERIFY_PASS", from: "MILESTONE_SUBMITTED", to: "VERIFIED", at: "2026-03-06T08:02:00.000Z" },
    {
      seq: 4,
      event: "RELEASE",
      from: "VERIFIED",
      to: "RELEASED",
      at: "2026-03-06T08:03:00.000Z",
      ...(settlementRef !== undefined
        ? { settlementRef: settlementRef as string }
        : {}),
    },
  ] as EscrowHistoryEntry[];
}

test("released report carries the RELEASE entry's settlementRef", () => {
  const report = releasedReport("esc-ref", "wire-2026-0315");
  assert.equal(report.outcome, "released");
  assert.equal(report.settlementRef, "wire-2026-0315");
  assert.equal(report.balanced, true);
});

test("released report without a ref omits the key entirely (old shape)", () => {
  const report = releasedReport("esc-noref");
  assert.equal("settlementRef" in report, false);
  assert.equal(report.settlementRef, undefined);
  // The JSON form carries no trace of the field either.
  assert.equal(renderReportJson(report).includes("settlementRef"), false);
});

test("released-via-arbitration report has no settlementRef key", () => {
  const e = new Escrow("esc-arb");
  e.dispatch("FUND");
  e.dispatch("DISPUTE");
  e.dispatch("ARBITRATE_RELEASE");
  const report = buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500 },
  });
  assert.equal(report.outcome, "released");
  assert.equal(report.releasePath, "DISPUTE → ARBITRATE_RELEASE");
  assert.equal("settlementRef" in report, false);
});

test("refunded report has no settlementRef key", () => {
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
  assert.equal(report.outcome, "refunded");
  assert.equal("settlementRef" in report, false);
});

test("expired report has no settlementRef key", () => {
  const e = new Escrow("esc-expired");
  e.dispatch("FUND");
  e.dispatch("EXPIRE");
  const report = buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: goldenDeposit(),
  });
  assert.equal(report.outcome, "expired");
  assert.equal("settlementRef" in report, false);
});

test("CSV round-trip with ref: every row carries it, parse recovers it", () => {
  const report = releasedReport("esc-ref", "wire-2026-0315");
  const csv = renderReportCsv(report);
  const lines = csv.split("\n");
  assert.equal(
    lines[0],
    "escrowId,outcome,currency,settlementRef,refundRef,role,inflow,outflow,net",
  );
  for (const line of lines.slice(1)) {
    assert.equal(line.split(",")[3], "wire-2026-0315");
  }
  const parsed = parseSettlementReportCsv(csv);
  assert.equal(parsed.settlementRef, "wire-2026-0315");
  assert.equal(renderReportCsv(parsed), csv);
});

test("CSV round-trip without ref: column present but empty, key omitted", () => {
  const report = releasedReport("esc-noref");
  const csv = renderReportCsv(report);
  for (const line of csv.split("\n").slice(1)) {
    assert.equal(line.split(",")[3], "");
  }
  const parsed = parseSettlementReportCsv(csv);
  assert.equal("settlementRef" in parsed, false);
  assert.equal(renderReportCsv(parsed), csv);
});

test("legacy 7-column CSV parses and yields no settlementRef key", () => {
  const legacy = [
    "escrowId,outcome,currency,role,inflow,outflow,net",
    "esc-10630,released,,sponsor,0.00,10630.00,-10630.00",
    "esc-10630,released,,creator,10098.50,0.00,10098.50",
    "esc-10630,released,,platform,531.50,0.00,531.50",
    "esc-10630,released,,referrer,0.00,0.00,0.00",
    "esc-10630,released,,TOTAL,10630.00,10630.00,0.00",
  ].join("\n");
  const parsed = parseSettlementReportCsv(legacy);
  assert.equal(parsed.escrowId, "esc-10630");
  assert.equal(parsed.outcome, "released");
  assert.equal("settlementRef" in parsed, false);
  assert.deepEqual(parsed.parties, releasedReport("esc-10630").parties);
  // Re-rendering a legacy file produces the current 9-column shape.
  assert.equal(
    renderReportCsv(parsed).split("\n")[0],
    "escrowId,outcome,currency,settlementRef,refundRef,role,inflow,outflow,net",
  );
});

test("JSON round-trip carries the ref and omits it when absent", () => {
  const withRef = releasedReport("esc-ref", "tx-0xabc123");
  const parsedWithRef = parseSettlementReportJson(renderReportJson(withRef));
  assert.equal(parsedWithRef.settlementRef, "tx-0xabc123");
  assert.equal(renderReportJson(parsedWithRef), renderReportJson(withRef));

  const withoutRef = releasedReport("esc-noref");
  const parsedWithoutRef = parseSettlementReportJson(
    renderReportJson(withoutRef),
  );
  assert.equal("settlementRef" in parsedWithoutRef, false);
  assert.equal(renderReportJson(parsedWithoutRef), renderReportJson(withoutRef));
});

test("diff detects a changed settlementRef", () => {
  // Both reports come from hand-built histories with identical fixed
  // timestamps, so the ref is the only thing that can move — a live
  // escrow's real-clock timestamps would leak into the diff.
  const reportFor = (ref: string | undefined) =>
    buildSettlementReport({
      escrowId: "esc-ref",
      history: handBuiltHistory(ref),
      finalState: "RELEASED",
      deposit: goldenDeposit(),
      settlement: { proFeeBps: 500 },
    });
  const before = reportFor("wire-001");
  const after = reportFor("wire-002");
  const diff = diffSettlementReports(before, after);
  assert.deepEqual(diff.settlementRefChanged, {
    from: "wire-001",
    to: "wire-002",
  });
  // Nothing else moved: same escrow, same figures, same release path.
  assert.deepEqual(Object.keys(diff), ["settlementRefChanged"]);
});

test("diff detects a ref added and reports nothing when refs agree", () => {
  const reportFor = (ref: string | undefined) =>
    buildSettlementReport({
      escrowId: "esc-ref",
      history: handBuiltHistory(ref),
      finalState: "RELEASED",
      deposit: goldenDeposit(),
      settlement: { proFeeBps: 500 },
    });
  const withoutRef = reportFor(undefined);
  const withRef = reportFor("wire-001");
  assert.deepEqual(
    diffSettlementReports(withoutRef, withRef).settlementRefChanged,
    { from: undefined, to: "wire-001" },
  );
  assert.deepEqual(
    diffSettlementReports(withRef, withoutRef).settlementRefChanged,
    { from: "wire-001", to: undefined },
  );
  assert.deepEqual(diffSettlementReports(withRef, withRef), {});
});

test("parse CSV rejects a settlementRef that differs across rows", () => {
  const report = releasedReport("esc-ref", "wire-001");
  const csv = renderReportCsv(report).replaceAll(
    "wire-001,,creator",
    "wire-002,,creator",
  );
  assert.throws(
    () => parseSettlementReportCsv(csv),
    (err: unknown) =>
      err instanceof Error &&
      err.message.startsWith("cannot parse settlement report CSV") &&
      /settlementRef "wire-002" does not match "wire-001"/.test(err.message),
  );
});

test("parse CSV rejects an overlong settlementRef", () => {
  const ref = "r".repeat(257);
  const csv = [
    "escrowId,outcome,currency,settlementRef,role,inflow,outflow,net",
    `esc-10630,released,,${ref},sponsor,0.00,10630.00,-10630.00`,
    `esc-10630,released,,${ref},creator,10098.50,0.00,10098.50`,
    `esc-10630,released,,${ref},platform,531.50,0.00,531.50`,
    `esc-10630,released,,${ref},referrer,0.00,0.00,0.00`,
    `esc-10630,released,,${ref},TOTAL,10630.00,10630.00,0.00`,
  ].join("\n");
  assert.throws(
    () => parseSettlementReportCsv(csv),
    (err: unknown) =>
      err instanceof Error &&
      err.message.startsWith("cannot parse settlement report CSV") &&
      /settlementRef must be at most 256 characters, got 257/.test(
        err.message,
      ),
  );
});

test("renderReport prints the Settlement ref line only when present", () => {
  const withRef = renderReport(releasedReport("esc-ref", "wire-2026-0315"));
  assert.match(withRef, /Settlement ref: wire-2026-0315/);
  const withoutRef = renderReport(releasedReport("esc-noref"));
  assert.doesNotMatch(withoutRef, /Settlement ref:/);
});

test("illegal ref on the terminal RELEASE entry fails the build", () => {
  for (const badRef of ["", "x".repeat(257)]) {
    assert.throws(
      () =>
        buildSettlementReport({
          escrowId: "esc-badref",
          history: handBuiltHistory(badRef),
          finalState: "RELEASED",
          deposit: goldenDeposit(),
          settlement: { proFeeBps: 500 },
        }),
      (err: unknown) =>
        err instanceof Error &&
        /cannot build settlement report for esc-badref: settlementRef must be/.test(
          err.message,
        ),
    );
  }
});

test("a ref on an ARBITRATE_RELEASE entry fails the build", () => {
  const history = handBuiltHistory("wire-001");
  const last = history[history.length - 1];
  (last as { event: string }).event = "ARBITRATE_RELEASE";
  assert.throws(
    () =>
      buildSettlementReport({
        escrowId: "esc-badref",
        history,
        finalState: "RELEASED",
        deposit: goldenDeposit(),
        settlement: { proFeeBps: 500 },
      }),
    (err: unknown) =>
      err instanceof Error &&
      /cannot build settlement report for esc-badref: settlementRef is only allowed on RELEASE entries, got it on ARBITRATE_RELEASE/.test(
        err.message,
      ),
  );
});

test("summarizeSettlementReports is unaffected by the ref", () => {
  const withRef = releasedReport("esc-a", "wire-001");
  const withoutRef = releasedReport("esc-b");
  const summary = summarizeSettlementReports(
    buildSettlementReports([
      {
        escrowId: withRef.escrowId,
        history: releaseEscrow("esc-a", "wire-001").history,
        finalState: "RELEASED",
        deposit: goldenDeposit(),
        settlement: { proFeeBps: 500 },
      },
      {
        escrowId: withoutRef.escrowId,
        history: releaseEscrow("esc-b").history,
        finalState: "RELEASED",
        deposit: goldenDeposit(),
        settlement: { proFeeBps: 500 },
      },
    ]),
  );
  assert.equal(summary.reports, 2);
  assert.equal(summary.outcomes.released, 2);
  assert.equal(summary.totalDeposit, 21260);
  assert.equal(summary.totalInflow, 21260);
  assert.equal(summary.totalOutflow, 21260);
  assert.equal(summary.balanced, true);
  // The summary carries no ref field: it aggregates money, not pointers.
  assert.equal("settlementRef" in summary, false);
  assert.deepEqual(Object.keys(summary), [
    "total",
    "reports",
    "errors",
    "outcomes",
    "totalDeposit",
    "totalInflow",
    "totalOutflow",
    "totalRemaining",
    "parties",
    "byCurrency",
    "balanced",
  ]);
});
