import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  MAX_ESCROW_ID_LENGTH,
  buildSettlementReport,
  calculateDeposit,
  parseSettlementReportCsv,
  parseSettlementReportJson,
  reconcileSettlements,
  renderReportCsv,
  renderReportJson,
  type LedgerSettlement,
  type SettlementReport,
} from "../src/index.js";

// Backlog #1067: `reconcileSettlements` accepted any non-empty escrowId,
// so an id longer than the 256 characters the library can ever mint
// (#1061, `MAX_ESCROW_ID_LENGTH`) sailed through the reconcile entry
// even though no `Escrow` can carry it. The same cap now applies to the
// report-shape faces that feed reconciliation: the CSV parser and the
// shared shape check behind `renderReportJson` / `parseSettlementReportJson`.

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

function releasedReport(id: string): SettlementReport {
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

function ledgerRow(id: string, amount = 10630): LedgerSettlement {
  return { escrowId: id, amount };
}

const overlongId = "x".repeat(MAX_ESCROW_ID_LENGTH + 1);
const atLimitId = "y".repeat(MAX_ESCROW_ID_LENGTH);

test("cap value is the #1061 constant (256), not a second magic number", () => {
  assert.equal(MAX_ESCROW_ID_LENGTH, 256);
  assert.equal(overlongId.length, 257);
  assert.equal(atLimitId.length, 256);
});

test("reconcile: overlong report escrowId is rejected", () => {
  const report = { ...releasedReport("esc-short"), escrowId: overlongId };
  assert.throws(
    () => reconcileSettlements([report], [ledgerRow("esc-short")]),
    /invalid reconcileSettlements: report escrowId must be at most 256 characters, got 257/,
  );
});

test("reconcile: overlong ledger escrowId is rejected", () => {
  const report = releasedReport("esc-short");
  assert.throws(
    () => reconcileSettlements([report], [ledgerRow(overlongId)]),
    /invalid reconcileSettlements: ledger escrowId must be at most 256 characters, got 257/,
  );
});

test("reconcile: an id exactly at the cap pairs and matches on both sides", () => {
  const report = { ...releasedReport("esc-short"), escrowId: atLimitId };
  const result = reconcileSettlements([report], [ledgerRow(atLimitId)]);
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].escrowId, atLimitId);
  assert.deepEqual(result.reportOnly, []);
  assert.deepEqual(result.ledgerOnly, []);
});

test("reconcile: short ids are unaffected", () => {
  const report = releasedReport("esc-short");
  const result = reconcileSettlements([report], [ledgerRow("esc-short")]);
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].escrowId, "esc-short");
});

test("reconcile: an overlong id leaves no partial pairing behind", () => {
  // The overlong report sits after a valid one and its ledger row would
  // have matched: the throw must happen before either lookup map is
  // consulted, so nothing is paired and no module state is polluted —
  // the same valid batch reconciles cleanly on the very next call.
  const valid = releasedReport("esc-valid");
  const overlong = { ...releasedReport("esc-other"), escrowId: overlongId };
  assert.throws(
    () =>
      reconcileSettlements(
        [valid, overlong],
        [ledgerRow("esc-valid"), ledgerRow(overlongId)],
      ),
    /report escrowId must be at most 256 characters, got 257/,
  );
  const after = reconcileSettlements([valid], [ledgerRow("esc-valid")]);
  assert.equal(after.matched.length, 1);
  assert.equal(after.matched[0].escrowId, "esc-valid");

  // Same for the ledger side: a valid row plus an overlong row throws,
  // and the valid-only batch still matches afterwards.
  assert.throws(
    () =>
      reconcileSettlements(
        [valid],
        [ledgerRow("esc-valid"), ledgerRow(overlongId)],
      ),
    /ledger escrowId must be at most 256 characters, got 257/,
  );
  const afterLedger = reconcileSettlements([valid], [ledgerRow("esc-valid")]);
  assert.equal(afterLedger.matched.length, 1);
});

test("CSV parse: an overlong escrowId is rejected, an at-cap id round-trips", () => {
  const csv = renderReportCsv(releasedReport("esc-csv"));
  const overlongCsv = csv.replaceAll("esc-csv", overlongId);
  assert.throws(
    () => parseSettlementReportCsv(overlongCsv),
    /cannot parse settlement report CSV: escrowId must be at most 256 characters, got 257/,
  );
  const atLimitCsv = csv.replaceAll("esc-csv", atLimitId);
  const parsed = parseSettlementReportCsv(atLimitCsv);
  assert.equal(parsed.escrowId, atLimitId);
  assert.equal(parsed.outcome, "released");
});

test("JSON shape check: an overlong escrowId is rejected, an at-cap id renders and parses", () => {
  const report = releasedReport("esc-json");
  assert.throws(
    () => renderReportJson({ ...report, escrowId: overlongId }),
    /cannot render settlement report as JSON: escrowId must be at most 256 characters, got 257/,
  );
  const atLimit = { ...report, escrowId: atLimitId };
  const text = renderReportJson(atLimit);
  const parsed = parseSettlementReportJson(text);
  assert.equal(parsed.escrowId, atLimitId);
  assert.equal(parsed.totalOutflow, 10630);
});
