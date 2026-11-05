/**
 * `Escrow.fromHistory` x settlement report consistency (backlog #912).
 *
 * Event sourcing (`Escrow.fromHistory`, `src/stateMachine.ts:2115`, #235)
 * and settlement reporting (`buildSettlementReport`,
 * `src/settlementReport.ts:219`) each have their own tests, but the
 * end-to-end proposition — "a report built from a replayed escrow equals
 * the report built from the live escrow" — had no coverage at all: no
 * test paired the two paths, so a replay that silently dropped a FUND
 * amount, reordered an entry, or re-chained with different hashes could
 * still produce a clean-looking report that disagreed with the live one.
 * These tests close that loop: the history is the sole source of truth,
 * so the replayed report must be field-for-field identical to the live
 * one, and a broken history must fail at `fromHistory` — before any
 * report is built — never by producing a report from tampered evidence.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  calculateDeposit,
  depositAmountFromHistory,
  type AuditKey,
  type EscrowHistoryEntry,
  type FeeBreakdown,
  type SettlementReport,
} from "../src/index.js";

const T1 = "2026-03-01T10:00:00.000Z";
const T2 = "2026-03-01T11:00:00.000Z";
const T3 = "2026-03-01T12:00:00.000Z";
const T4 = "2026-03-01T13:00:00.000Z";
const T5 = "2026-03-01T14:00:00.000Z";

/** Portfolio golden vector: pool $10,000, base $600 × 1.0, loyalty −$30, oracle +$60 → deposit $10,630. */
function goldenDeposit(): FeeBreakdown {
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

/** Live escrow driven CREATED -> FUNDED -> MILESTONE_SUBMITTED -> VERIFIED -> RELEASED, timestamps pinned. */
function releasedEscrow(id = "esc-replay-report-1"): Escrow {
  const e = new Escrow(id);
  e.dispatch("FUND", "sponsor deposit", 10630, { at: T1 });
  e.dispatch("SUBMIT_MILESTONE", "creator delivers KPI bundle", undefined, {
    at: T2,
  });
  e.dispatch("VERIFY_PASS", "oracle attestation ok", undefined, { at: T3 });
  e.dispatch("RELEASE", "pay out", undefined, { at: T4 });
  return e;
}

/** Live escrow driven to VERIFIED only (replay-then-continue case). */
function verifiedEscrow(id = "esc-replay-report-continue"): Escrow {
  const e = new Escrow(id);
  e.dispatch("FUND", "sponsor deposit", 10630, { at: T1 });
  e.dispatch("SUBMIT_MILESTONE", "creator delivers KPI bundle", undefined, {
    at: T2,
  });
  e.dispatch("VERIFY_PASS", "oracle attestation ok", undefined, { at: T3 });
  return e;
}

function reportFor(
  escrow: Escrow,
  deposit: FeeBreakdown,
  settlement?: { proFeeBps: number; referralCredits?: number },
  auditKey?: AuditKey,
): SettlementReport {
  return buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit,
    ...(settlement !== undefined ? { settlement } : {}),
    ...(auditKey !== undefined ? { auditKey } : {}),
  });
}

/**
 * Detach the live history through plain JSON (as the NDJSON transport
 * would), rebuild the escrow from it, and build that escrow's report —
 * the exact path a receiving service takes.
 */
function replayedReportFor(
  live: Escrow,
  deposit: FeeBreakdown,
  settlement?: { proFeeBps: number; referralCredits?: number },
  auditKey?: AuditKey,
): SettlementReport {
  const history = JSON.parse(
    JSON.stringify(live.history),
  ) as EscrowHistoryEntry[];
  const restored = Escrow.fromHistory(
    live.id,
    history,
    auditKey !== undefined ? { auditKey } : undefined,
  );
  return reportFor(restored, deposit, settlement, auditKey);
}

test("released: replayed report is field-for-field identical to the live report", () => {
  const live = releasedEscrow();
  const liveReport = reportFor(live, goldenDeposit(), { proFeeBps: 500 });
  // A second, independently computed deposit: the deposit value itself
  // must agree, not just the object reference.
  const replayedReport = replayedReportFor(live, goldenDeposit(), {
    proFeeBps: 500,
  });

  assert.deepEqual(replayedReport, liveReport);
  assert.equal(replayedReport.outcome, "released");
  assert.equal(replayedReport.releasePath, "VERIFY_PASS → RELEASE");
  assert.equal(replayedReport.eventCount, 4);
  assert.equal(replayedReport.deposit.deposit, 10630);
  assert.ok(replayedReport.balanced);
  assert.deepEqual(
    replayedReport.parties.map((p) => [p.party, p.inflow, p.outflow, p.net]),
    [
      ["sponsor", 0, 10630, -10630],
      ["creator", 10098.5, 0, 10098.5],
      ["platform", 531.5, 0, 531.5],
      ["referrer", 0, 0, 0],
    ],
  );
});

test("refunded: replayed report matches the live report", () => {
  const live = new Escrow("esc-replay-report-refund");
  live.dispatch("FUND", "sponsor deposit", 10630, { at: T1 });
  live.dispatch("DISPUTE", "milestone disputed", undefined, { at: T2 });
  live.dispatch("ARBITRATE_REFUND", "arbitrator refunds", undefined, {
    at: T3,
  });

  const liveReport = reportFor(live, goldenDeposit());
  const replayedReport = replayedReportFor(live, goldenDeposit());

  assert.deepEqual(replayedReport, liveReport);
  assert.equal(replayedReport.outcome, "refunded");
  const sponsor = replayedReport.parties.find((p) => p.party === "sponsor")!;
  assert.deepEqual(
    { inflow: sponsor.inflow, outflow: sponsor.outflow, net: sponsor.net },
    { inflow: 10630, outflow: 10630, net: 0 },
  );
  assert.ok(replayedReport.balanced);
});

test("top-up: replayed report's deposit equals the FUND total and matches live", () => {
  const live = new Escrow("esc-replay-report-topup");
  live.dispatch("FUND", "initial wire", 10000, { at: T1 });
  live.dispatch("FUND", "top-up wire", 630, { at: T2 });
  live.dispatch("SUBMIT_MILESTONE", "creator delivers KPI bundle", undefined, {
    at: T3,
  });
  live.dispatch("VERIFY_PASS", "oracle attestation ok", undefined, { at: T4 });
  live.dispatch("RELEASE", "pay out", undefined, { at: T5 });

  // The FUND total is the corroborated deposit: both histories must sum
  // to it independently of the caller-supplied breakdown.
  assert.equal(depositAmountFromHistory(live.history), 10630);
  const replayedHistory = JSON.parse(
    JSON.stringify(live.history),
  ) as EscrowHistoryEntry[];
  assert.equal(depositAmountFromHistory(replayedHistory), 10630);

  const liveReport = reportFor(live, goldenDeposit(), { proFeeBps: 500 });
  const replayedReport = replayedReportFor(live, goldenDeposit(), {
    proFeeBps: 500,
  });

  assert.deepEqual(replayedReport, liveReport);
  assert.equal(replayedReport.deposit.deposit, 10630);
  assert.equal(replayedReport.eventCount, 5);
  assert.equal(replayedReport.totalInflow, 10630);
  assert.equal(replayedReport.totalOutflow, 10630);
  assert.ok(replayedReport.balanced);
});

test("referral credits: replayed report carries the same referrer split", () => {
  const live = releasedEscrow("esc-replay-report-referral");
  const settlement = { proFeeBps: 500, referralCredits: 200 };
  const liveReport = reportFor(live, goldenDeposit(), settlement);
  const replayedReport = replayedReportFor(live, goldenDeposit(), settlement);

  assert.deepEqual(replayedReport, liveReport);
  const byParty = Object.fromEntries(
    replayedReport.parties.map((p) => [p.party, p]),
  );
  assert.equal(byParty.referrer.net, 200);
  assert.equal(byParty.creator.net, 9898.5);
  assert.equal(byParty.platform.net, 531.5);
  assert.ok(replayedReport.balanced);
});

test("arbitration release: replayed report keeps the arbitration path", () => {
  const live = new Escrow("esc-replay-report-arb");
  live.dispatch("FUND", "sponsor deposit", 10630, { at: T1 });
  live.dispatch("SUBMIT_MILESTONE", "creator delivers KPI bundle", undefined, {
    at: T2,
  });
  live.dispatch("VERIFY_FAIL", "oracle attestation failed", undefined, {
    at: T3,
  });
  live.dispatch("ARBITRATE_RELEASE", "arbitrator releases", undefined, {
    at: T4,
  });

  const liveReport = reportFor(live, goldenDeposit(), { proFeeBps: 500 });
  const replayedReport = replayedReportFor(live, goldenDeposit(), {
    proFeeBps: 500,
  });

  assert.deepEqual(replayedReport, liveReport);
  assert.equal(replayedReport.outcome, "released");
  assert.equal(replayedReport.releasePath, "VERIFY_FAIL → ARBITRATE_RELEASE");
  assert.ok(replayedReport.balanced);
});

test("replay-then-continue: RELEASE dispatched on the replayed escrow reports like live", () => {
  const live = verifiedEscrow();
  const replayedHistory = JSON.parse(
    JSON.stringify(live.history),
  ) as EscrowHistoryEntry[];
  const restored = Escrow.fromHistory(live.id, replayedHistory);

  // Both escrows take the same final step with the same pinned timestamp,
  // so their histories — and therefore their reports — must be identical.
  assert.equal(
    live.dispatch("RELEASE", "pay out", undefined, { at: T4 }),
    "RELEASED",
  );
  assert.equal(
    restored.dispatch("RELEASE", "pay out", undefined, { at: T4 }),
    "RELEASED",
  );
  assert.deepEqual(restored.history, live.history);

  const liveReport = reportFor(live, goldenDeposit(), { proFeeBps: 500 });
  const replayedReport = reportFor(restored, goldenDeposit(), {
    proFeeBps: 500,
  });
  assert.deepEqual(replayedReport, liveReport);
  assert.equal(replayedReport.releasePath, "VERIFY_PASS → RELEASE");
});

test("keyed history: same-key replay reports identically; wrong key fails before any report", () => {
  const key = "history-key";
  const live = new Escrow("esc-replay-report-keyed", { auditKey: key });
  live.dispatch("FUND", "sponsor deposit", 10630, { at: T1 });
  live.dispatch("SUBMIT_MILESTONE", "creator delivers KPI bundle", undefined, {
    at: T2,
  });
  live.dispatch("VERIFY_PASS", "oracle attestation ok", undefined, { at: T3 });
  live.dispatch("RELEASE", "pay out", undefined, { at: T4 });

  const liveReport = reportFor(live, goldenDeposit(), { proFeeBps: 500 }, key);
  const replayedReport = replayedReportFor(
    live,
    goldenDeposit(),
    { proFeeBps: 500 },
    key,
  );
  assert.deepEqual(replayedReport, liveReport);

  const history = JSON.parse(
    JSON.stringify(live.history),
  ) as EscrowHistoryEntry[];
  // No key, or the wrong key: the rebuild itself must fail closed, so
  // no report can ever be built from the unrebuilt history.
  assert.throws(() => Escrow.fromHistory(live.id, history), /hash chain is broken/);
  assert.throws(
    () => Escrow.fromHistory(live.id, history, { auditKey: "wrong-key" }),
    /hash chain is broken/,
  );
  // Same fail-closed rule on the report path: a keyed history reported
  // without its key must not produce a report either.
  assert.throws(
    () =>
      buildSettlementReport({
        escrowId: live.id,
        history,
        finalState: live.state,
        deposit: goldenDeposit(),
        settlement: { proFeeBps: 500 },
      }),
    /hash chain is broken/,
  );
});

test("tampered history: a rewritten FUND amount fails at fromHistory, no report is produced", () => {
  const live = releasedEscrow("esc-replay-report-tamper");
  const tampered = JSON.parse(
    JSON.stringify(live.history),
  ) as EscrowHistoryEntry[];
  tampered[0].amount = 1; // rewrite the deposit, keep the old hashes

  // The throw happens in the rebuild itself: buildSettlementReport is
  // never reached, so no report — clean-looking or otherwise — can be
  // produced from tampered evidence.
  assert.throws(
    () => Escrow.fromHistory(live.id, tampered),
    /hash chain is broken/,
  );
});

test("broken chain: a deleted or reordered entry fails at fromHistory, no report is produced", () => {
  const live = releasedEscrow("esc-replay-report-chain");
  const history = JSON.parse(
    JSON.stringify(live.history),
  ) as EscrowHistoryEntry[];

  const deleted = history.filter((_, i) => i !== 1);
  assert.throws(
    () => Escrow.fromHistory(live.id, deleted),
    /seq must be 2, got 3/,
  );

  const reordered = [history[0], history[2], history[1], history[3]];
  assert.throws(
    () => Escrow.fromHistory(live.id, reordered),
    /seq must be 2, got 3/,
  );
});
