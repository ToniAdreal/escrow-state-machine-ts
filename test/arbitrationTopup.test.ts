import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  calculateDeposit,
  createQuorum,
  depositAmountFromHistory,
  dispatchArbitration,
} from "../src/index.js";
import type { SettlementReportInputs } from "../src/index.js";

/**
 * Top-up escrow x arbitration quorum (backlog #800).
 *
 * Top-ups (#43) and the quorum gate (arbitration.ts) were each covered
 * on their own, but no test pinned them together: a DISPUTED escrow
 * whose locked total is an initial FUND plus a top-up must settle on
 * the summed total, and the quorum threshold must be a pure count —
 * independent of how large the locked total is. The report carries no
 * quorum field (see #786), so the quorum shows up here exactly as it
 * does elsewhere: the reached escrow's outcome/releasePath and the
 * `quorum 5/5 [dao-1, dao-2, dao-3, dao-4, dao-5]` tally in its audit history's last entry, and the
 * below-threshold escrow having no settlement at all.
 *
 * Rules under test:
 *  - FUND 10000 + top-up FUND 630, then DISPUTE: the locked total read
 *    from history is 10630 (the sum, not the first FUND), the second
 *    FUND is a FUNDED self-loop, and the escrow sits in DISPUTED
 *  - below quorum (4/9) → arbitration throws
 *    `arbitration requires quorum: 4/5 approvals`, state and history
 *    are untouched, and no settlement report can be built
 *  - a below-quorum rejection consumes nothing: gathering the 5th
 *    approval afterwards lets the same escrow arbitrate successfully
 *  - reached quorum (5/9) release → report deposit 10630, outcome
 *    `released`, releasePath `DISPUTE → ARBITRATE_RELEASE`, 5%
 *    pro-fee split (creator 10098.50, platform 531.50), balanced
 *  - reached quorum (5/9) refund → report deposit 10630, outcome
 *    `refunded`, no `releasePath` key, sponsor refunded in full
 *    (inflow == outflow == 10630, every other party zero)
 *  - the quorum gate is independent of the locked total: an escrow
 *    locked at 20000 (10000 + 10000 top-up) still needs exactly 5
 *    approvals — 4 fails, 5 passes — just like the 10630 escrow
 */

const SIGNERS = [
  "dao-1", "dao-2", "dao-3", "dao-4", "dao-5",
  "dao-6", "dao-7", "dao-8", "dao-9",
];

/** The golden deposit fixture: 10000 + 600 - 30 + 60 = 10630. */
function deposit() {
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

/**
 * Escrow sitting in DISPUTED whose locked total is an initial FUND
 * plus a top-up: CREATED → FUNDED → FUNDED (top-up) → DISPUTED.
 */
function toppedUpDisputedEscrow(id: string): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 10000);
  escrow.dispatch("FUND", "top-up", 630);
  escrow.dispatch("DISPUTE");
  assert.equal(escrow.state, "DISPUTED");
  return escrow;
}

/** Quorum with the first `n` signers approved (5/9 rule). */
function quorumWith(n: number) {
  const quorum = createQuorum({ threshold: 5, signers: SIGNERS });
  for (let i = 0; i < n; i++) quorum.approve(SIGNERS[i]);
  return quorum;
}

function inputsFor(e: Escrow): SettlementReportInputs {
  return {
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: deposit(),
    // Required for a released escrow; ignored on the refunded path.
    settlement: { proFeeBps: 500 },
  };
}

test("top-up disputed escrow locks the FUND sum, not the first FUND", () => {
  const escrow = toppedUpDisputedEscrow("arb-topup-fixture");
  assert.deepEqual(
    escrow.history.map((h) => [h.event, h.from, h.to, h.amount]),
    [
      ["FUND", "CREATED", "FUNDED", 10000],
      ["FUND", "FUNDED", "FUNDED", 630],
      ["DISPUTE", "FUNDED", "DISPUTED", undefined],
    ],
  );
  assert.deepEqual(
    escrow.history.map((h) => h.seq),
    [1, 2, 3],
  );
  // The settlement total is the sum of every FUND entry — a report
  // built on the first FUND alone (10000) would disagree with the
  // audit trail and must be rejected by buildSettlementReport.
  assert.equal(depositAmountFromHistory(escrow.history, escrow.id), 10630);
  assert.equal(deposit().deposit, 10630);
});

test("below-quorum release arbitration is rejected and builds no settlement", () => {
  const escrow = toppedUpDisputedEscrow("arb-topup-no-quorum");
  const historyBefore = escrow.history.length;

  assert.throws(
    () => dispatchArbitration(escrow, quorumWith(4), "release"),
    /arbitration requires quorum: 4\/5 approvals/,
  );
  assert.equal(escrow.state, "DISPUTED");
  assert.equal(escrow.history.length, historyBefore);
  assert.equal(escrow.history[escrow.history.length - 1].event, "DISPUTE");
  assert.ok(!(escrow.history[escrow.history.length - 1].note ?? "").includes("quorum"));
  // A still-DISPUTED escrow has no settlement: the report builder
  // refuses, so the top-up total settles nothing yet.
  assert.throws(
    () => buildSettlementReport(inputsFor(escrow)),
    /no settlement has happened yet/,
  );
});

test("below-quorum refund rejection consumes nothing: the 5th approval retries cleanly", () => {
  const escrow = toppedUpDisputedEscrow("arb-topup-retry");
  const quorum = quorumWith(4);

  assert.throws(
    () => dispatchArbitration(escrow, quorum, "refund"),
    /arbitration requires quorum: 4\/5 approvals/,
  );
  assert.equal(escrow.state, "DISPUTED");
  assert.equal(escrow.history.length, 3);

  // Gathering the 5th approval afterwards lets the same escrow
  // arbitrate with no seq gap and no trace of the failed attempt.
  quorum.approve(SIGNERS[4]);
  const state = dispatchArbitration(escrow, quorum, "refund");
  assert.equal(state, "REFUNDED");
  assert.equal(escrow.state, "REFUNDED");
  assert.equal(escrow.history.length, 4);
  const last = escrow.history[escrow.history.length - 1];
  assert.equal(last.seq, 4);
  assert.equal(last.event, "ARBITRATE_REFUND");
  assert.equal(last.from, "DISPUTED");
  assert.equal(last.to, "REFUNDED");
  assert.equal(last.note, "quorum 5/5 [dao-1, dao-2, dao-3, dao-4, dao-5]");
});

test("reached-quorum release settles the topped-up total with the 5% split", () => {
  const escrow = toppedUpDisputedEscrow("arb-topup-release");
  const state = dispatchArbitration(escrow, quorumWith(5), "release");
  assert.equal(state, "RELEASED");
  assert.equal(escrow.state, "RELEASED");
  const last = escrow.history[escrow.history.length - 1];
  assert.equal(last.event, "ARBITRATE_RELEASE");
  assert.equal(last.from, "DISPUTED");
  assert.equal(last.to, "RELEASED");
  assert.equal(last.note, "quorum 5/5 [dao-1, dao-2, dao-3, dao-4, dao-5]");

  const report = buildSettlementReport(inputsFor(escrow));
  assert.equal(report.outcome, "released");
  assert.equal(report.releasePath, "DISPUTE → ARBITRATE_RELEASE");
  // The report deposit is the FUND sum (10000 + 630), not the
  // initial FUND alone.
  assert.equal(report.deposit.deposit, 10630);
  assert.equal(report.deposit.deposit, depositAmountFromHistory(escrow.history, escrow.id));
  assert.equal(report.balanced, true);
  assert.equal(report.totalInflow, 10630);
  assert.equal(report.totalOutflow, 10630);
  assert.equal(report.eventCount, escrow.history.length);
  assert.deepEqual(report.settlement, {
    gross: 10630,
    proFee: 531.5,
    referralCredits: 0,
    net: 10098.5,
  });
  assert.deepEqual(
    report.parties.map((p) => [p.party, p.inflow, p.outflow, p.net]),
    [
      ["sponsor", 0, 10630, -10630],
      ["creator", 10098.5, 0, 10098.5],
      ["platform", 531.5, 0, 531.5],
      ["referrer", 0, 0, 0],
    ],
  );
  // The report carries no quorum field: approval state is the
  // outcome/releasePath above plus the audit note, not a new field.
  assert.equal((report as unknown as Record<string, unknown>).quorum, undefined);
});

test("reached-quorum refund returns the full topped-up total to the sponsor", () => {
  const escrow = toppedUpDisputedEscrow("arb-topup-refund");
  const state = dispatchArbitration(escrow, quorumWith(5), "refund");
  assert.equal(state, "REFUNDED");
  assert.equal(escrow.state, "REFUNDED");
  const last = escrow.history[escrow.history.length - 1];
  assert.equal(last.event, "ARBITRATE_REFUND");
  assert.equal(last.note, "quorum 5/5 [dao-1, dao-2, dao-3, dao-4, dao-5]");

  const report = buildSettlementReport(inputsFor(escrow));
  assert.equal(report.outcome, "refunded");
  assert.equal(report.releasePath, undefined);
  assert.equal(report.deposit.deposit, 10630);
  assert.equal(report.deposit.deposit, depositAmountFromHistory(escrow.history, escrow.id));
  assert.equal(report.balanced, true);
  assert.equal(report.totalInflow, 10630);
  assert.equal(report.totalOutflow, 10630);
  assert.deepEqual(
    report.parties.map((p) => [p.party, p.inflow, p.outflow, p.net]),
    [
      ["sponsor", 10630, 10630, 0],
      ["creator", 0, 0, 0],
      ["platform", 0, 0, 0],
      ["referrer", 0, 0, 0],
    ],
  );
});

test("quorum threshold is independent of the locked total", () => {
  // A much larger locked total (10000 + 10000 top-up = 20000) needs
  // exactly the same 5 approvals: the gate counts signers, not money.
  // No settlement report is built here — the 20000 total deliberately
  // has no matching fee fixture, and the gate must be pinned without
  // inventing one.
  const escrow = new Escrow("arb-topup-big");
  escrow.dispatch("FUND", "initial deposit", 10000);
  escrow.dispatch("FUND", "top-up", 10000);
  escrow.dispatch("DISPUTE");
  assert.equal(depositAmountFromHistory(escrow.history, escrow.id), 20000);

  const quorum = quorumWith(4);
  assert.throws(
    () => dispatchArbitration(escrow, quorum, "release"),
    /arbitration requires quorum: 4\/5 approvals/,
  );
  assert.equal(escrow.state, "DISPUTED");
  assert.equal(escrow.history.length, 3);

  quorum.approve(SIGNERS[4]);
  assert.equal(dispatchArbitration(escrow, quorum, "release"), "RELEASED");
  assert.equal(escrow.state, "RELEASED");
  assert.equal(escrow.history[escrow.history.length - 1].note, "quorum 5/5 [dao-1, dao-2, dao-3, dao-4, dao-5]");
});
