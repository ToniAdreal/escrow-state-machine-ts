import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementReports,
  calculateDeposit,
  summarizeSettlementReports,
  verifyHistoryChain,
  type EscrowHistoryEntry,
  type SettlementReportInputs,
} from "../src/index.js";

// Backlog #787: settlementReportsBatch x hash chain.
//
// Read-first note (do not invent report fields): a SettlementReport
// carries NO hash-chain field — its state surface is outcome,
// releasePath (released only), parties, totals, balanced, eventCount
// and the audit window. The hash chain is not a report field; it is
// the entry gate inside buildSettlementReport: an intact chained
// history passes, a fully hashless (legacy) history passes through,
// and a broken or mixed chained/hashless history throws, which the
// batch wrapper turns into a per-item error. These tests pin exactly
// that batch behaviour, and nothing more.

function deposit() {
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

function releasedEscrow(id: string): Escrow {
  const e = new Escrow(id);
  e.dispatch("FUND", undefined, 10630);
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  assert.equal(e.state, "RELEASED");
  return e;
}

function refundedEscrow(id: string): Escrow {
  const e = new Escrow(id);
  e.dispatch("FUND", undefined, 10630);
  e.dispatch("DISPUTE");
  e.dispatch("ARBITRATE_REFUND");
  assert.equal(e.state, "REFUNDED");
  return e;
}

function inputsFor(
  e: Escrow,
  history: readonly EscrowHistoryEntry[] = e.history,
): SettlementReportInputs {
  return {
    escrowId: e.id,
    history,
    finalState: e.state,
    deposit: deposit(),
    settlement: { proFeeBps: 500 },
  };
}

/** Deep-clone chained entries (the live history is frozen, so mutate clones). */
function cloneHistory(history: readonly EscrowHistoryEntry[]): EscrowHistoryEntry[] {
  return JSON.parse(JSON.stringify(history)) as EscrowHistoryEntry[];
}

/** A history whose entries carry no chain fields at all (legacy snapshot). */
function stripChain(history: readonly EscrowHistoryEntry[]): EscrowHistoryEntry[] {
  return history.map((entry) => {
    const { hash, prevHash, ...rest } = entry;
    return rest as EscrowHistoryEntry;
  });
}

test("intact chained batch: both reports match the single-escrow reports entry for entry", () => {
  const released = releasedEscrow("h-rel");
  const refunded = refundedEscrow("h-ref");
  assert.equal(verifyHistoryChain(released.history), true);
  assert.equal(verifyHistoryChain(refunded.history), true);

  const inputs = [inputsFor(released), inputsFor(refunded)];
  const results = buildSettlementReports(inputs);
  assert.deepEqual(results.map((r) => r.escrowId), ["h-rel", "h-ref"]);
  assert.equal(results[0].error, undefined);
  assert.equal(results[1].error, undefined);
  assert.equal(results[0].report?.outcome, "released");
  assert.equal(results[0].report?.releasePath, "VERIFY_PASS → RELEASE");
  assert.equal(results[1].report?.outcome, "refunded");
  assert.equal(results[1].report?.releasePath, undefined);
  // Batch entries are exactly the single-escrow reports.
  for (let i = 0; i < inputs.length; i++) {
    assert.deepEqual(results[i].report, buildSettlementReport(inputs[i]));
  }
  // The reports carry no hash-chain field: chain state lives in the
  // histories above, not in the report objects.
  assert.equal((results[0].report as unknown as Record<string, unknown>).hash, undefined);
  assert.equal((results[1].report as unknown as Record<string, unknown>).prevHash, undefined);

  const summary = summarizeSettlementReports(results);
  assert.equal(summary.total, 2);
  assert.equal(summary.reports, 2);
  assert.equal(summary.errors, 0);
  assert.deepEqual(summary.outcomes, { released: 1, refunded: 1, expired: 0, "partially-released": 0 });
  assert.equal(summary.totalDeposit, 21260);
  assert.equal(summary.totalInflow, 21260);
  assert.equal(summary.totalOutflow, 21260);
  assert.equal(summary.balanced, true);
});

test("tampered FUND amount in one escrow: only that entry errors, companion report intact", () => {
  const released = releasedEscrow("h-tamper-rel");
  const refunded = refundedEscrow("h-tamper-ref");
  const tampered = cloneHistory(released.history);
  tampered[0].amount = 1; // attacker shrinks the locked deposit
  assert.equal(verifyHistoryChain(tampered), false);

  const results = buildSettlementReports([inputsFor(released, tampered), inputsFor(refunded)]);
  assert.deepEqual(results.map((r) => r.escrowId), ["h-tamper-rel", "h-tamper-ref"]);
  assert.equal(results[0].report, undefined);
  assert.match(results[0].error ?? "", /hash chain/);
  assert.equal(results[1].error, undefined);
  assert.deepEqual(results[1].report, buildSettlementReport(inputsFor(refunded)));
  assert.equal(results[1].report?.outcome, "refunded");
  assert.equal(results[1].report?.balanced, true);
  // The tamper touched only the clone: the live escrow is untouched.
  assert.equal(released.history[0].amount, 10630);
  assert.equal(verifyHistoryChain(released.history), true);
});

test("deleted middle entry in one escrow: only that entry errors, companion report intact", () => {
  const released = releasedEscrow("h-del-rel");
  const refunded = refundedEscrow("h-del-ref");
  const gapped = cloneHistory(refunded.history);
  gapped.splice(1, 1); // DISPUTE gone: prevHash link snaps
  assert.equal(verifyHistoryChain(gapped), false);

  const results = buildSettlementReports([inputsFor(released), inputsFor(refunded, gapped)]);
  assert.equal(results[0].error, undefined);
  assert.deepEqual(results[0].report, buildSettlementReport(inputsFor(released)));
  assert.equal(results[1].report, undefined);
  assert.match(results[1].error ?? "", /hash chain/);
});

test("mixed chained/hashless history in one escrow: only that entry errors, companion report intact", () => {
  const released = releasedEscrow("h-mix-rel");
  const refunded = refundedEscrow("h-mix-ref");
  const mixed = cloneHistory(released.history);
  delete (mixed[1] as { hash?: string }).hash;
  delete (mixed[1] as { prevHash?: string }).prevHash;
  assert.equal(verifyHistoryChain(mixed), false);

  const results = buildSettlementReports([inputsFor(released, mixed), inputsFor(refunded)]);
  assert.equal(results[0].report, undefined);
  assert.match(results[0].error ?? "", /hash chain/);
  assert.equal(results[1].error, undefined);
  assert.deepEqual(results[1].report, buildSettlementReport(inputsFor(refunded)));
});

test("legacy hashless batch passes through: both reports match the single hashless reports", () => {
  const released = releasedEscrow("h-legacy-rel");
  const refunded = refundedEscrow("h-legacy-ref");
  const legacyReleased = stripChain(released.history);
  const legacyRefunded = stripChain(refunded.history);
  for (const entry of [...legacyReleased, ...legacyRefunded]) {
    assert.equal(entry.hash, undefined);
    assert.equal(entry.prevHash, undefined);
  }
  // Fully hashless is legacy pass-through, not a break.
  assert.equal(verifyHistoryChain(legacyReleased), true);
  assert.equal(verifyHistoryChain(legacyRefunded), true);

  const inputs = [inputsFor(released, legacyReleased), inputsFor(refunded, legacyRefunded)];
  const results = buildSettlementReports(inputs);
  assert.equal(results[0].error, undefined);
  assert.equal(results[1].error, undefined);
  assert.equal(results[0].report?.outcome, "released");
  assert.equal(results[1].report?.outcome, "refunded");
  for (let i = 0; i < inputs.length; i++) {
    assert.deepEqual(results[i].report, buildSettlementReport(inputs[i]));
  }
});

test("summary totals unchanged by a tampered entry: tampered escrow contributes zero, companion totals stand", () => {
  const released = releasedEscrow("h-sum-rel");
  const refunded = refundedEscrow("h-sum-ref");
  const tampered = cloneHistory(released.history);
  tampered[2] = { ...tampered[2], note: "tampered" };
  assert.equal(verifyHistoryChain(tampered), false);

  const tamperedResults = buildSettlementReports([inputsFor(released, tampered), inputsFor(refunded)]);
  const companionOnly = buildSettlementReports([inputsFor(refunded)]);
  const tamperedSummary = summarizeSettlementReports(tamperedResults);
  const companionSummary = summarizeSettlementReports(companionOnly);
  // Same money figures as the companion alone: the tampered entry
  // contributes zero, and the companion report is byte-identical.
  assert.equal(tamperedSummary.total, 2);
  assert.equal(tamperedSummary.reports, 1);
  assert.equal(tamperedSummary.errors, 1);
  assert.equal(tamperedSummary.totalDeposit, companionSummary.totalDeposit);
  assert.equal(tamperedSummary.totalInflow, companionSummary.totalInflow);
  assert.equal(tamperedSummary.totalOutflow, companionSummary.totalOutflow);
  assert.deepEqual(tamperedSummary.parties, companionSummary.parties);
  assert.equal(tamperedSummary.totalDeposit, 10630);
  assert.equal(tamperedSummary.balanced, true);
  assert.deepEqual(tamperedResults[1].report, companionOnly[0].report);
});

test("batch purity: reporting chained, tampered-clone and legacy batches changes no escrow state or history", () => {
  const released = releasedEscrow("h-pure-rel");
  const refunded = refundedEscrow("h-pure-ref");
  const escrows = [released, refunded];
  const before = escrows.map((e) => JSON.stringify({ state: e.state, history: e.history }));
  const tampered = cloneHistory(released.history);
  tampered[0].amount = 1;
  buildSettlementReports([inputsFor(released, tampered), inputsFor(refunded)]);
  buildSettlementReports([inputsFor(released, stripChain(released.history)), inputsFor(refunded)]);
  summarizeSettlementReports(buildSettlementReports([inputsFor(released), inputsFor(refunded)]));
  const after = escrows.map((e) => JSON.stringify({ state: e.state, history: e.history }));
  assert.deepEqual(after, before);
});
