import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  calculateDeposit,
  type EscrowHistoryEntry,
} from "../src/index.js";

/**
 * The report is derived entirely from the audit history, so a history that
 * was tampered with after the fact must never produce a clean report.
 * buildSettlementReport verifies the hash chain at entry, with the same
 * semantics as the snapshot parser: intact chain -> pass, fully hashless
 * (legacy) -> pass through, mixed chained/hashless -> reject.
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

function releasedEscrow() {
  const e = new Escrow("esc-chain");
  e.dispatch("FUND", undefined, 10630);
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return e;
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

function buildFor(history: readonly EscrowHistoryEntry[], finalState: "RELEASED" | "REFUNDED" | "EXPIRED") {
  return () =>
    buildSettlementReport({
      escrowId: "esc-chain",
      history,
      finalState,
      deposit: goldenDeposit(),
      settlement: { proFeeBps: 500 },
    });
}

test("intact chained history passes the chain check", () => {
  const e = releasedEscrow();
  const report = buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500 },
  });
  assert.equal(report.outcome, "released");
  assert.ok(report.balanced);
});

test("tampered FUND amount breaks the chain: report refused", () => {
  const history = cloneHistory(releasedEscrow().history);
  history[0].amount = 1; // attacker shrinks the locked deposit
  assert.throws(buildFor(history, "RELEASED"), /hash chain/);
});

test("tampered note breaks the chain: report refused", () => {
  const e = releasedEscrow();
  const history = cloneHistory(e.history);
  history[2] = { ...history[2], note: "tampered" };
  assert.throws(buildFor(history, "RELEASED"), /hash chain/);
});

test("tampered event name breaks the chain: report refused", () => {
  const e = releasedEscrow();
  const history = cloneHistory(e.history);
  history[2] = { ...history[2], event: "VERIFY_FAIL" };
  assert.throws(buildFor(history, "RELEASED"), /hash chain/);
});

test("deleted middle entry breaks the chain: report refused", () => {
  const e = releasedEscrow();
  const history = cloneHistory(e.history);
  history.splice(1, 1); // SUBMIT_MILESTONE gone: prevHash link snaps
  assert.throws(buildFor(history, "RELEASED"), /hash chain/);
});

test("reordered entries break the chain: report refused", () => {
  const e = releasedEscrow();
  const history = cloneHistory(e.history);
  [history[1], history[2]] = [history[2], history[1]];
  assert.throws(buildFor(history, "RELEASED"), /hash chain/);
});

test("legacy hashless history passes through", () => {
  const e = releasedEscrow();
  const legacy = stripChain(e.history);
  for (const entry of legacy) {
    assert.equal(entry.hash, undefined);
    assert.equal(entry.prevHash, undefined);
  }
  const report = buildFor(legacy, "RELEASED")();
  assert.equal(report.outcome, "released");
  assert.ok(report.balanced);
});

test("mixed chained/hashless history is rejected", () => {
  const e = releasedEscrow();
  const mixed = cloneHistory(e.history);
  delete (mixed[1] as { hash?: string }).hash;
  delete (mixed[1] as { prevHash?: string }).prevHash;
  assert.throws(buildFor(mixed, "RELEASED"), /hash chain/);
});

test("refunded path is protected: tampered history refused", () => {
  const e = new Escrow("esc-refund");
  e.dispatch("FUND", undefined, 10630);
  e.dispatch("DISPUTE");
  e.dispatch("ARBITRATE_REFUND");
  const history = cloneHistory(e.history);
  history[0].amount = 1;
  assert.throws(buildFor(history, "REFUNDED"), /hash chain/);
});

test("expired path is protected: tampered history refused", () => {
  const e = new Escrow("esc-expired");
  e.dispatch("FUND", undefined, 10630);
  e.dispatch("EXPIRE");
  const history = cloneHistory(e.history);
  history[1] = { ...history[1], event: "ARBITRATE_REFUND" };
  assert.throws(buildFor(history, "EXPIRED"), /hash chain/);
});

test("the error message names the tampering surface explicitly", () => {
  const history = cloneHistory(releasedEscrow().history);
  history[0].amount = 1;
  assert.throws(
    buildFor(history, "RELEASED"),
    /cannot build settlement report for esc-chain: audit history hash chain is broken or mixes chained and hashless entries/
  );
});
