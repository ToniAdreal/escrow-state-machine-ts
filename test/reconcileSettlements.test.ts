import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  calculateDeposit,
  reconcileSettlements,
  type LedgerSettlement,
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

function smallDeposit() {
  // $1,000 pool + $100 base fee, nothing else → deposit $1,100.
  return calculateDeposit({
    creatorPool: 1000,
    baseFee: 100,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 0,
    oracleFee: 0,
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

function refundedReport(id: string): SettlementReport {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("DISPUTE");
  e.dispatch("ARBITRATE_REFUND");
  return buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: smallDeposit(),
  });
}

function expiredReport(id: string): SettlementReport {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("EXPIRE");
  return buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: smallDeposit(),
  });
}

test("four groups in one batch: matched, reportOnly, ledgerOnly, amountMismatch", () => {
  const released = releasedReport("esc-matched");
  const refunded = refundedReport("esc-report-only");
  const mismatched = releasedReport("esc-mismatch");
  assert.equal(released.totalOutflow, 10630);
  assert.equal(refunded.totalOutflow, 1100);
  assert.equal(mismatched.totalOutflow, 10630);

  const ledger: LedgerSettlement[] = [
    { escrowId: "esc-matched", amount: 10630 },
    { escrowId: "esc-mismatch", amount: 10000 },
    { escrowId: "esc-ledger-only", amount: 500 },
  ];
  const result = reconcileSettlements([released, refunded, mismatched], ledger);

  assert.deepEqual(
    result.matched.map((r) => r.escrowId),
    ["esc-matched"],
  );
  assert.deepEqual(
    result.reportOnly.map((r) => r.escrowId),
    ["esc-report-only"],
  );
  assert.deepEqual(
    result.ledgerOnly.map((r) => r.escrowId),
    ["esc-ledger-only"],
  );
  assert.equal(result.amountMismatch.length, 1);
  assert.equal(result.amountMismatch[0].report.escrowId, "esc-mismatch");
  assert.equal(result.amountMismatch[0].reportAmount, 10630);
  assert.equal(result.amountMismatch[0].ledgerAmount, 10000);
});

test("all three outcomes pair on totalOutflow", () => {
  const released = releasedReport("esc-rel");
  const refunded = refundedReport("esc-ref");
  const expired = expiredReport("esc-exp");
  assert.equal(expired.outcome, "expired");
  assert.equal(expired.totalOutflow, 1100);

  const result = reconcileSettlements(
    [released, refunded, expired],
    [
      { escrowId: "esc-rel", amount: 10630 },
      { escrowId: "esc-ref", amount: 1100 },
      { escrowId: "esc-exp", amount: 1100 },
    ],
  );
  assert.deepEqual(
    result.matched.map((r) => r.escrowId),
    ["esc-rel", "esc-ref", "esc-exp"],
  );
  assert.deepEqual(result.reportOnly, []);
  assert.deepEqual(result.ledgerOnly, []);
  assert.deepEqual(result.amountMismatch, []);
});

test("ledger row without an amount matches on the reference alone", () => {
  const released = releasedReport("esc-ref-only");
  const result = reconcileSettlements([released], [{ escrowId: "esc-ref-only" }]);
  assert.deepEqual(
    result.matched.map((r) => r.escrowId),
    ["esc-ref-only"],
  );
  assert.deepEqual(result.amountMismatch, []);
});

test("amounts compare at cent precision, not float-exact", () => {
  const released = releasedReport("esc-cents");
  // 10630.004 rounds to 10630.00 at cent precision: float noise, not a
  // disagreement. 10629.99 is a real one-cent shortfall.
  const noise = reconcileSettlements([released], [
    { escrowId: "esc-cents", amount: 10630.004 },
  ]);
  assert.equal(noise.matched.length, 1);
  assert.equal(noise.amountMismatch.length, 0);

  const short = reconcileSettlements([released], [
    { escrowId: "esc-cents", amount: 10629.99 },
  ]);
  assert.equal(short.matched.length, 0);
  assert.equal(short.amountMismatch.length, 1);
  assert.equal(short.amountMismatch[0].ledgerAmount, 10629.99);
});

test("duplicate ledger escrowId fails fast", () => {
  const released = releasedReport("esc-dup");
  assert.throws(
    () =>
      reconcileSettlements([released], [
        { escrowId: "esc-dup", amount: 10630 },
        { escrowId: "esc-dup", amount: 10630 },
      ]),
    /duplicate ledger escrowId: "esc-dup"/,
  );
});

test("empty inputs return four empty groups", () => {
  const result = reconcileSettlements([], []);
  assert.deepEqual(result, {
    matched: [],
    reportOnly: [],
    ledgerOnly: [],
    amountMismatch: [],
  });
});

test("reports with no ledger land in reportOnly; ledger with no reports lands in ledgerOnly", () => {
  const released = releasedReport("esc-alone");
  const onlyReports = reconcileSettlements([released], []);
  assert.deepEqual(
    onlyReports.reportOnly.map((r) => r.escrowId),
    ["esc-alone"],
  );
  const onlyLedger = reconcileSettlements([], [{ escrowId: "esc-ghost", amount: 1 }]);
  assert.deepEqual(
    onlyLedger.ledgerOnly.map((r) => r.escrowId),
    ["esc-ghost"],
  );
});

test("malformed ledger rows fail fast", () => {
  const released = releasedReport("esc-bad-ledger");
  assert.throws(
    () => reconcileSettlements([released], [{ escrowId: "", amount: 1 }]),
    /ledger escrowId must be a non-empty string/,
  );
  assert.throws(
    () => reconcileSettlements([released], [{ escrowId: "esc-bad-ledger", amount: -5 }]),
    /ledger amount must be a non-negative finite number/,
  );
  assert.throws(
    () => reconcileSettlements([released], [{ escrowId: "esc-bad-ledger", amount: NaN }]),
    /ledger amount must be a non-negative finite number/,
  );
  assert.throws(
    () => reconcileSettlements([released], [null as unknown as LedgerSettlement]),
    /ledger entry must be an object/,
  );
});

test("malformed reports fail fast", () => {
  assert.throws(
    () =>
      reconcileSettlements(
        [{ escrowId: "", totalOutflow: 1 } as unknown as SettlementReport],
        [],
      ),
    /report escrowId must be a non-empty string/,
  );
  assert.throws(
    () =>
      reconcileSettlements(
        [{ escrowId: "esc-bad", totalOutflow: Infinity } as unknown as SettlementReport],
        [],
      ),
    /report totalOutflow must be a finite number/,
  );
});

test("pure: inputs unchanged, groups hold the same objects, in input order", () => {
  const first = releasedReport("esc-first");
  const second = refundedReport("esc-second");
  const reports = [second, first];
  const ledger: LedgerSettlement[] = [
    { escrowId: "esc-ghost", amount: 7 },
    { escrowId: "esc-first", amount: 10630 },
  ];
  const reportsBefore = JSON.stringify(reports);
  const ledgerBefore = JSON.stringify(ledger);

  const result = reconcileSettlements(reports, ledger);

  // Input order preserved inside each group, not sorted.
  assert.deepEqual(
    result.matched.map((r) => r.escrowId),
    ["esc-first"],
  );
  assert.deepEqual(
    result.reportOnly.map((r) => r.escrowId),
    ["esc-second"],
  );
  assert.deepEqual(
    result.ledgerOnly.map((r) => r.escrowId),
    ["esc-ghost"],
  );
  // Same object references, not copies, so callers can act on them.
  assert.equal(result.matched[0], first);
  assert.equal(result.reportOnly[0], second);
  assert.equal(result.ledgerOnly[0], ledger[0]);
  // Nothing mutated: no dispatch, no rewriting of either input list.
  assert.equal(JSON.stringify(reports), reportsBefore);
  assert.equal(JSON.stringify(ledger), ledgerBefore);
});
