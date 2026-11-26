import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  calculateDeposit,
  settlePartialRelease,
  type EscrowHistoryEntry,
} from "../src/index.js";

/**
 * Backlog #1416: a FUNDED `partially-released` report used to settle the
 * reported slice against the full deposit, ignoring PARTIAL_RELEASE
 * tranches already in the audit history. A second slice could then
 * over-release the escrow and still be stamped `balanced: true` (the
 * probe: deposit 10630, prior tranche 6000, second slice 6000 →
 * remaining 4630, balanced true, while the true balance was −1370).
 *
 * The slice is incremental: the cumulative total of prior tranches plus
 * this slice must not exceed the deposit, and `remaining` is the
 * deposit minus every released tranche. An over-releasing slice fails
 * closed instead of producing a report.
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

/** FUND 10630, then the given partial-release tranches; stays FUNDED. */
function fundedWithPartials(amounts: number[], id: string): Escrow {
  const e = new Escrow(id);
  e.dispatch("FUND", undefined, 10630);
  for (const amount of amounts) e.dispatch("PARTIAL_RELEASE", undefined, amount);
  return e;
}

function partialReport(
  escrow: Escrow,
  partialRelease: { released: number; proFeeBps: number; referralCredits?: number },
) {
  return buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: goldenDeposit(),
    partialRelease,
  });
}

/** Deep-clone entries (the live history is frozen, so mutate clones). */
function cloneHistory(history: readonly EscrowHistoryEntry[]): EscrowHistoryEntry[] {
  return JSON.parse(JSON.stringify(history)) as EscrowHistoryEntry[];
}

/** Strip the hash chain: a fully hashless (legacy) history passes the chain check. */
function stripChain(history: EscrowHistoryEntry[]): void {
  for (const entry of history) {
    delete (entry as { hash?: string }).hash;
    delete (entry as { prevHash?: string }).prevHash;
  }
}

function byParty(report: ReturnType<typeof buildSettlementReport>) {
  return Object.fromEntries(report.parties.map((p) => [p.party, p]));
}

test("no prior tranche: byte-identical to the single-slice report", () => {
  const escrow = fundedWithPartials([], "esc-cum-none");
  const report = partialReport(escrow, { released: 4252, proFeeBps: 500 });

  // The pure function's own numbers, computed independently of the report.
  const expected = settlePartialRelease({ gross: 10630, released: 4252, proFeeBps: 500 });
  assert.deepEqual(report.partialSettlement, expected);
  assert.equal(report.outcome, "partially-released");
  assert.equal(report.remaining, 6378);
  assert.equal(report.totalInflow, 10630);
  assert.equal(report.totalOutflow, 10630);
  assert.ok(report.balanced);
  assert.equal(byParty(report).sponsor.inflow, 6378);
});

test("one prior tranche + second slice within balance: remaining is cumulative", () => {
  const escrow = fundedWithPartials([6000], "esc-cum-second");
  const report = partialReport(escrow, { released: 4000, proFeeBps: 500 });

  // The slice itself still splits per settlePartialRelease …
  assert.deepEqual(report.partialSettlement, {
    released: 4000,
    proFee: 200,
    referralCredits: 0,
    net: 3800,
    // … but the remainder is the deposit minus EVERY tranche: the
    // prior 6000 plus this 4000, not the slice's own 6630.
    remaining: 630,
  });
  assert.equal(report.remaining, 630);
  assert.equal(byParty(report).sponsor.inflow, 630);
  assert.equal(byParty(report).sponsor.outflow, 10630);
  assert.equal(byParty(report).sponsor.net, -10000);
  assert.equal(byParty(report).creator.inflow, 3800);
  assert.equal(byParty(report).platform.inflow, 200);
  assert.equal(byParty(report).referrer.inflow, 0);
  // The slice report's ledger covers this slice plus the still-locked
  // remainder only: the prior 6000 was already reported on its own
  // report, so this report alone does not reconcile the full deposit
  // and `balanced` is honestly false — not a stamped-over-release.
  assert.equal(report.totalInflow, 4630);
  assert.equal(report.totalOutflow, 10630);
  assert.equal(report.balanced, false);
  assert.equal(report.eventCount, 2);
});

test("second slice exactly equal to the remaining balance: remaining 0", () => {
  const escrow = fundedWithPartials([6000], "esc-cum-exact");
  const report = partialReport(escrow, { released: 4630, proFeeBps: 500 });

  assert.equal(report.partialSettlement?.remaining, 0);
  assert.equal(report.remaining, 0);
  assert.equal(byParty(report).sponsor.inflow, 0);
  assert.equal(report.totalInflow, 4630);
  assert.equal(report.balanced, false);
});

test("second slice over the balance by one cent throws with the cumulative total", () => {
  const escrow = fundedWithPartials([6000], "esc-cum-over-cent");
  assert.throws(
    () => partialReport(escrow, { released: 4631, proFeeBps: 500 }),
    /cannot build settlement report for esc-cum-over-cent: partial releases total 10631 but the deposit is 10630/,
  );
  // No report was produced and the escrow is untouched.
  assert.equal(escrow.state, "FUNDED");
  assert.equal(escrow.history.length, 2);
});

test("two prior tranches: the cumulative total, not the last slice, is guarded", () => {
  const escrow = fundedWithPartials([6000, 4000], "esc-cum-two-prior");
  // 6000 + 4000 already released; a further 1000 would total 11000.
  assert.throws(
    () => partialReport(escrow, { released: 1000, proFeeBps: 500 }),
    /cannot build settlement report for esc-cum-two-prior: partial releases total 11000 but the deposit is 10630/,
  );
  // … while a slice that fits the cumulative balance still reports,
  // with the remainder net of both prior tranches.
  const report = partialReport(escrow, { released: 630, proFeeBps: 500 });
  assert.equal(report.remaining, 0);
  assert.equal(report.partialSettlement?.remaining, 0);
  assert.equal(byParty(report).sponsor.inflow, 0);
});

test("the probe from the research round now fails closed", () => {
  const escrow = fundedWithPartials([6000], "esc-cum-probe");
  assert.throws(
    () => partialReport(escrow, { released: 6000, proFeeBps: 500 }),
    /partial releases total 12000 but the deposit is 10630/,
  );
});

test("referral credits are per-slice inputs, never accumulated from history", () => {
  const escrow = fundedWithPartials([6000], "esc-cum-credits");
  // The prior tranche's credits (if any) live on its own report; the
  // trail records amounts only, so this slice's credits land once,
  // on this slice, and are never re-added from the history.
  const withCredits = partialReport(escrow, {
    released: 4000,
    proFeeBps: 500,
    referralCredits: 50,
  });
  assert.equal(withCredits.partialSettlement?.referralCredits, 50);
  assert.equal(byParty(withCredits).referrer.inflow, 50);
  assert.equal(byParty(withCredits).creator.inflow, 3750);
  assert.equal(withCredits.remaining, 630);

  const withoutCredits = partialReport(escrow, { released: 4000, proFeeBps: 500 });
  assert.equal(withoutCredits.partialSettlement?.referralCredits, 0);
  assert.equal(byParty(withoutCredits).referrer.inflow, 0);
  assert.equal(byParty(withoutCredits).creator.inflow, 3800);
  assert.equal(withoutCredits.remaining, 630);
});

test("an over-release attempt produces no report at all (no balanced:false report)", () => {
  const escrow = fundedWithPartials([6000], "esc-cum-no-report");
  let report: ReturnType<typeof buildSettlementReport> | undefined;
  assert.throws(
    () => {
      report = partialReport(escrow, { released: 6000, proFeeBps: 500 });
    },
    /partial releases total 12000 but the deposit is 10630/,
  );
  assert.equal(report, undefined);
  assert.equal(escrow.state, "FUNDED");
  assert.equal(escrow.history.length, 2);
});

test("hand-built history with an amountless PARTIAL_RELEASE fails closed in the helper", () => {
  const escrow = fundedWithPartials([6000], "esc-cum-noamount");
  const history = cloneHistory(escrow.history);
  // Strip the chain (see terminalSettlementWithPartialReleases): a
  // fully hashless (legacy) history passes the chain check, so the
  // amount guard — not the tamper check — is what fires.
  stripChain(history);
  const tranche = history.find((e) => e.event === "PARTIAL_RELEASE");
  assert.ok(tranche);
  delete (tranche as { amount?: number }).amount;
  assert.throws(
    () =>
      buildSettlementReport({
        escrowId: escrow.id,
        history,
        finalState: "FUNDED",
        deposit: goldenDeposit(),
        partialRelease: { released: 1000, proFeeBps: 500 },
      }),
    /settlement requires a PARTIAL_RELEASE amount for esc-cum-noamount: a PARTIAL_RELEASE event was recorded without an amount/,
  );
});
