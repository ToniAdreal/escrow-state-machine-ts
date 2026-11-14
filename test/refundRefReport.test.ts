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
 * Backlog #1123: the settlement report carries the terminal
 * ARBITRATE_REFUND entry's `refundRef` — the mirror of
 * `settlementRef` on released reports (#1113): the one pointer from
 * the audit report to the real-world refund. The ref rides the
 * report, the CSV and JSON exports, the plain-text render, and the
 * report diff; every other outcome keeps its previous shape exactly.
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

function refundEscrow(id: string, refundRef?: string) {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("DISPUTE");
  e.dispatch(
    "ARBITRATE_REFUND",
    undefined,
    undefined,
    refundRef !== undefined ? { refundRef } : undefined,
  );
  return e;
}

function refundedReport(id: string, refundRef?: string) {
  const escrow = refundEscrow(id, refundRef);
  return buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: goldenDeposit(),
  });
}

/** A fully hashless (legacy) refund history: passes the chain check untouched. */
function handBuiltHistory(refundRef: unknown): EscrowHistoryEntry[] {
  return [
    { seq: 1, event: "FUND", from: "CREATED", to: "FUNDED", at: "2026-03-06T08:00:00.000Z", amount: 10630 },
    { seq: 2, event: "DISPUTE", from: "FUNDED", to: "DISPUTED", at: "2026-03-06T08:01:00.000Z" },
    {
      seq: 3,
      event: "ARBITRATE_REFUND",
      from: "DISPUTED",
      to: "REFUNDED",
      at: "2026-03-06T08:02:00.000Z",
      ...(refundRef !== undefined
        ? { refundRef: refundRef as string }
        : {}),
    },
  ] as EscrowHistoryEntry[];
}

test("refunded report carries the ARBITRATE_REFUND entry's refundRef", () => {
  const report = refundedReport("esc-ref", "rfnd-2026-0315");
  assert.equal(report.outcome, "refunded");
  assert.equal(report.refundRef, "rfnd-2026-0315");
  assert.equal(report.balanced, true);
});

test("refunded report without a ref omits the key entirely (old shape)", () => {
  const report = refundedReport("esc-noref");
  assert.equal("refundRef" in report, false);
  assert.equal(report.refundRef, undefined);
  // The JSON form carries no trace of the field either.
  assert.equal(renderReportJson(report).includes("refundRef"), false);
});

test("released report has no refundRef key", () => {
  const e = new Escrow("esc-rel");
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  const report = buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500 },
  });
  assert.equal(report.outcome, "released");
  assert.equal("refundRef" in report, false);
});

test("expired report has no refundRef key", () => {
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
  assert.equal("refundRef" in report, false);
});

test("CSV round-trip with ref: every row carries it, parse recovers it", () => {
  const report = refundedReport("esc-ref", "rfnd-2026-0315");
  const csv = renderReportCsv(report);
  const lines = csv.split("\n");
  assert.equal(
    lines[0],
    "escrowId,outcome,currency,settlementRef,refundRef,role,inflow,outflow,net",
  );
  for (const line of lines.slice(1)) {
    assert.equal(line.split(",")[4], "rfnd-2026-0315");
    // The settlementRef column stays empty on a refunded report.
    assert.equal(line.split(",")[3], "");
  }
  const parsed = parseSettlementReportCsv(csv);
  assert.equal(parsed.refundRef, "rfnd-2026-0315");
  assert.equal("settlementRef" in parsed, false);
  assert.equal(renderReportCsv(parsed), csv);
});

test("CSV round-trip without ref: column present but empty, key omitted", () => {
  const report = refundedReport("esc-noref");
  const csv = renderReportCsv(report);
  for (const line of csv.split("\n").slice(1)) {
    assert.equal(line.split(",")[4], "");
  }
  const parsed = parseSettlementReportCsv(csv);
  assert.equal("refundRef" in parsed, false);
  assert.equal(renderReportCsv(parsed), csv);
});

test("8-column CSV parses and yields no refundRef key", () => {
  const eightColumn = [
    "escrowId,outcome,currency,settlementRef,role,inflow,outflow,net",
    "esc-10630,refunded,,,sponsor,10630.00,10630.00,0.00",
    "esc-10630,refunded,,,creator,0.00,0.00,0.00",
    "esc-10630,refunded,,,platform,0.00,0.00,0.00",
    "esc-10630,refunded,,,referrer,0.00,0.00,0.00",
    "esc-10630,refunded,,,TOTAL,10630.00,10630.00,0.00",
  ].join("\n");
  const parsed = parseSettlementReportCsv(eightColumn);
  assert.equal(parsed.escrowId, "esc-10630");
  assert.equal(parsed.outcome, "refunded");
  assert.equal("refundRef" in parsed, false);
  assert.deepEqual(parsed.parties, refundedReport("esc-10630").parties);
  // Re-rendering an 8-column file produces the current 9-column shape.
  assert.equal(
    renderReportCsv(parsed).split("\n")[0],
    "escrowId,outcome,currency,settlementRef,refundRef,role,inflow,outflow,net",
  );
});

test("legacy 7-column CSV parses and yields neither ref key", () => {
  const legacy = [
    "escrowId,outcome,currency,role,inflow,outflow,net",
    "esc-10630,refunded,,sponsor,10630.00,10630.00,0.00",
    "esc-10630,refunded,,creator,0.00,0.00,0.00",
    "esc-10630,refunded,,platform,0.00,0.00,0.00",
    "esc-10630,refunded,,referrer,0.00,0.00,0.00",
    "esc-10630,refunded,,TOTAL,10630.00,10630.00,0.00",
  ].join("\n");
  const parsed = parseSettlementReportCsv(legacy);
  assert.equal("settlementRef" in parsed, false);
  assert.equal("refundRef" in parsed, false);
  assert.equal(
    renderReportCsv(parsed).split("\n")[0],
    "escrowId,outcome,currency,settlementRef,refundRef,role,inflow,outflow,net",
  );
});

test("JSON round-trip carries the ref and omits it when absent", () => {
  const withRef = refundedReport("esc-ref", "rfnd-0xabc123");
  const parsedWithRef = parseSettlementReportJson(renderReportJson(withRef));
  assert.equal(parsedWithRef.refundRef, "rfnd-0xabc123");
  assert.equal(renderReportJson(parsedWithRef), renderReportJson(withRef));

  const withoutRef = refundedReport("esc-noref");
  const parsedWithoutRef = parseSettlementReportJson(
    renderReportJson(withoutRef),
  );
  assert.equal("refundRef" in parsedWithoutRef, false);
  assert.equal(renderReportJson(parsedWithoutRef), renderReportJson(withoutRef));
});

test("diff detects a changed refundRef", () => {
  // Both reports come from hand-built histories with identical fixed
  // timestamps, so the ref is the only thing that can move — a live
  // escrow's real-clock timestamps would leak into the diff.
  const reportFor = (ref: string | undefined) =>
    buildSettlementReport({
      escrowId: "esc-ref",
      history: handBuiltHistory(ref),
      finalState: "REFUNDED",
      deposit: goldenDeposit(),
    });
  const before = reportFor("rfnd-001");
  const after = reportFor("rfnd-002");
  const diff = diffSettlementReports(before, after);
  assert.deepEqual(diff.refundRefChanged, {
    from: "rfnd-001",
    to: "rfnd-002",
  });
  // Nothing else moved: same escrow, same figures.
  assert.deepEqual(Object.keys(diff), ["refundRefChanged"]);
});

test("diff detects a ref added and reports nothing when refs agree", () => {
  const reportFor = (ref: string | undefined) =>
    buildSettlementReport({
      escrowId: "esc-ref",
      history: handBuiltHistory(ref),
      finalState: "REFUNDED",
      deposit: goldenDeposit(),
    });
  const withoutRef = reportFor(undefined);
  const withRef = reportFor("rfnd-001");
  assert.deepEqual(
    diffSettlementReports(withoutRef, withRef).refundRefChanged,
    { from: undefined, to: "rfnd-001" },
  );
  assert.deepEqual(
    diffSettlementReports(withRef, withoutRef).refundRefChanged,
    { from: "rfnd-001", to: undefined },
  );
  assert.deepEqual(diffSettlementReports(withRef, withRef), {});
});

test("parse CSV rejects a refundRef that differs across rows", () => {
  const report = refundedReport("esc-ref", "rfnd-001");
  const csv = renderReportCsv(report).replaceAll(
    "rfnd-001,creator",
    "rfnd-002,creator",
  );
  assert.throws(
    () => parseSettlementReportCsv(csv),
    (err: unknown) =>
      err instanceof Error &&
      err.message.startsWith("cannot parse settlement report CSV") &&
      /refundRef "rfnd-002" does not match "rfnd-001"/.test(err.message),
  );
});

test("parse CSV rejects an overlong refundRef", () => {
  const ref = "r".repeat(257);
  const csv = [
    "escrowId,outcome,currency,settlementRef,refundRef,role,inflow,outflow,net",
    `esc-10630,refunded,,,${ref},sponsor,10630.00,10630.00,0.00`,
    `esc-10630,refunded,,,${ref},creator,0.00,0.00,0.00`,
    `esc-10630,refunded,,,${ref},platform,0.00,0.00,0.00`,
    `esc-10630,refunded,,,${ref},referrer,0.00,0.00,0.00`,
    `esc-10630,refunded,,,${ref},TOTAL,10630.00,10630.00,0.00`,
  ].join("\n");
  assert.throws(
    () => parseSettlementReportCsv(csv),
    (err: unknown) =>
      err instanceof Error &&
      err.message.startsWith("cannot parse settlement report CSV") &&
      /refundRef must be at most 256 characters, got 257/.test(
        err.message,
      ),
  );
});

test("renderReport prints the Refund ref line only when present", () => {
  const withRef = renderReport(refundedReport("esc-ref", "rfnd-2026-0315"));
  assert.match(withRef, /Refund ref: rfnd-2026-0315/);
  const withoutRef = renderReport(refundedReport("esc-noref"));
  assert.doesNotMatch(withoutRef, /Refund ref:/);
  // A released report prints its Settlement ref line, never a refund line.
  const released = renderReport(
    buildSettlementReport({
      escrowId: "esc-rel",
      history: (() => {
        const e = new Escrow("esc-rel");
        e.dispatch("FUND");
        e.dispatch("SUBMIT_MILESTONE");
        e.dispatch("VERIFY_PASS");
        e.dispatch("RELEASE", undefined, undefined, {
          settlementRef: "wire-001",
        });
        return e.history;
      })(),
      finalState: "RELEASED",
      deposit: goldenDeposit(),
      settlement: { proFeeBps: 500 },
    }),
  );
  assert.match(released, /Settlement ref: wire-001/);
  assert.doesNotMatch(released, /Refund ref:/);
});

test("illegal ref on the terminal ARBITRATE_REFUND entry fails the build", () => {
  for (const badRef of ["", "x".repeat(257)]) {
    assert.throws(
      () =>
        buildSettlementReport({
          escrowId: "esc-badref",
          history: handBuiltHistory(badRef),
          finalState: "REFUNDED",
          deposit: goldenDeposit(),
        }),
      (err: unknown) =>
        err instanceof Error &&
        /cannot build settlement report for esc-badref: refundRef must be/.test(
          err.message,
        ),
    );
  }
});

test("a ref on a RELEASE entry fails the build", () => {
  // A release trail whose terminal RELEASE entry carries a refundRef:
  // the parser would reject this shape, and the build path must too
  // instead of silently dropping the ref.
  const releaseHistory: EscrowHistoryEntry[] = [
    { seq: 1, event: "FUND", from: "CREATED", to: "FUNDED", at: "2026-03-06T08:00:00.000Z", amount: 10630 },
    { seq: 2, event: "SUBMIT_MILESTONE", from: "FUNDED", to: "MILESTONE_SUBMITTED", at: "2026-03-06T08:01:00.000Z" },
    { seq: 3, event: "VERIFY_PASS", from: "MILESTONE_SUBMITTED", to: "VERIFIED", at: "2026-03-06T08:02:00.000Z" },
    {
      seq: 4,
      event: "RELEASE",
      from: "VERIFIED",
      to: "RELEASED",
      at: "2026-03-06T08:03:00.000Z",
      refundRef: "rfnd-001",
    },
  ];
  assert.throws(
    () =>
      buildSettlementReport({
        escrowId: "esc-badref",
        history: releaseHistory,
        finalState: "RELEASED",
        deposit: goldenDeposit(),
        settlement: { proFeeBps: 500 },
      }),
    (err: unknown) =>
      err instanceof Error &&
      /cannot build settlement report for esc-badref: refundRef is only allowed on ARBITRATE_REFUND entries, got it on RELEASE/.test(
        err.message,
      ),
  );
});

test("a settlementRef on an ARBITRATE_REFUND entry fails the build", () => {
  const history = handBuiltHistory(undefined);
  const last = history[history.length - 1];
  (last as unknown as Record<string, unknown>).settlementRef = "wire-001";
  assert.throws(
    () =>
      buildSettlementReport({
        escrowId: "esc-badref",
        history,
        finalState: "REFUNDED",
        deposit: goldenDeposit(),
      }),
    (err: unknown) =>
      err instanceof Error &&
      /cannot build settlement report for esc-badref: settlementRef is only allowed on RELEASE entries, got it on ARBITRATE_REFUND/.test(
        err.message,
      ),
  );
});

test("summarizeSettlementReports is unaffected by the ref", () => {
  const withRef = refundedReport("esc-a", "rfnd-001");
  const withoutRef = refundedReport("esc-b");
  const summary = summarizeSettlementReports(
    buildSettlementReports([
      {
        escrowId: withRef.escrowId,
        history: refundEscrow("esc-a", "rfnd-001").history,
        finalState: "REFUNDED",
        deposit: goldenDeposit(),
      },
      {
        escrowId: withoutRef.escrowId,
        history: refundEscrow("esc-b").history,
        finalState: "REFUNDED",
        deposit: goldenDeposit(),
      },
    ]),
  );
  assert.equal(summary.reports, 2);
  assert.equal(summary.outcomes.refunded, 2);
  assert.equal(summary.totalDeposit, 21260);
  assert.equal(summary.totalInflow, 21260);
  assert.equal(summary.totalOutflow, 21260);
  assert.equal(summary.balanced, true);
  // The summary carries no ref field: it aggregates money, not pointers.
  assert.equal("refundRef" in summary, false);
  assert.equal("settlementRef" in summary, false);
});
