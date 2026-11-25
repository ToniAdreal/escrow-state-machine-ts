import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  calculateDeposit,
  settlePartialReleases,
  settleRelease,
  type EscrowHistoryEntry,
} from "../src/index.js";

/**
 * Terminal settlement after recorded partial releases (backlog #1400):
 * a RELEASED report must settle the whole escrow as one cumulative
 * batch — the recorded tranches plus the still-locked remainder — so the
 * platform fee is never charged twice on a released slice; a REFUNDED /
 * EXPIRED report must refund only the still-locked remainder, with the
 * released total shown on the creator's row as money already paid out.
 * The no-prior-tranche paths stay byte-identical to the plain
 * `settleRelease` / full-deposit refund.
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

function party(report: ReturnType<typeof buildSettlementReport>, role: string) {
  const row = report.parties.find((p) => p.party === role);
  assert.ok(row, `missing ${role} ledger row`);
  return row;
}

/** FUND 10630, milestone, the given tranches, re-submit, verify, RELEASE. */
function releasedWithPartials(
  amounts: number[],
  id = "esc-terminal-partials",
): Escrow {
  const e = new Escrow(id);
  e.dispatch("FUND", undefined, 10630);
  e.dispatch("SUBMIT_MILESTONE");
  for (const amount of amounts) e.dispatch("PARTIAL_RELEASE", undefined, amount);
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return e;
}

/** FUND 10630, milestone, one tranche, dispute, arbitration refund. */
function refundedWithPartial(amount: number, id = "esc-refund-partial"): Escrow {
  const e = new Escrow(id);
  e.dispatch("FUND", undefined, 10630);
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("PARTIAL_RELEASE", undefined, amount);
  e.dispatch("DISPUTE");
  e.dispatch("ARBITRATE_REFUND");
  return e;
}

/** FUND 10630, one tranche, EXPIRE. */
function expiredWithPartial(amount: number, id = "esc-expire-partial"): Escrow {
  const e = new Escrow(id);
  e.dispatch("FUND", undefined, 10630);
  e.dispatch("PARTIAL_RELEASE", undefined, amount);
  e.dispatch("EXPIRE");
  return e;
}

function releasedReport(
  escrow: Escrow,
  settlement: { proFeeBps: number; referralCredits?: number },
) {
  return buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: goldenDeposit(),
    settlement,
  });
}

function terminalReport(escrow: Escrow) {
  return buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: goldenDeposit(),
  });
}

/** Deep-clone entries (the live history is frozen, so mutate clones). */
function cloneHistory(
  history: readonly EscrowHistoryEntry[],
): EscrowHistoryEntry[] {
  return JSON.parse(JSON.stringify(history)) as EscrowHistoryEntry[];
}

test("RELEASED after two tranches: lifetime totals are the cumulative batch", () => {
  const escrow = releasedWithPartials([4000, 2000]);
  const report = releasedReport(escrow, { proFeeBps: 500 });

  // The batch oracle: tranches 4000 + 2000 + remainder 4630 at 500bps.
  const batch = settlePartialReleases({
    gross: 10630,
    releases: [4000, 2000, 4630],
    proFeeBps: 500,
  });
  assert.deepEqual(report.settlement, {
    gross: 10630,
    proFee: batch.totalProFee,
    referralCredits: 0,
    net: batch.totalNet,
  });
  // Multi-tranche vs single-tranche: with clean amounts the lifetime
  // totals equal the single-shot settlement exactly.
  assert.deepEqual(report.settlement, settleRelease({ gross: 10630, proFeeBps: 500 }));
  assert.equal(report.settlement?.proFee, 531.5);
  assert.equal(report.settlement?.net, 10098.5);
  assert.equal(party(report, "creator").inflow, 10098.5);
  assert.equal(party(report, "platform").inflow, 531.5);
  assert.equal(party(report, "referrer").inflow, 0);
  assert.equal(party(report, "sponsor").outflow, 10630);
  assert.equal(party(report, "sponsor").inflow, 0);
  assert.equal(report.balanced, true);
  assert.equal(report.totalInflow, 10630);
  assert.equal(report.totalOutflow, 10630);
  assert.equal(report.outcome, "released");
});

test("RELEASED with referral credits: credits counted once, on the first tranche", () => {
  const escrow = releasedWithPartials([4000, 2000]);
  const report = releasedReport(escrow, { proFeeBps: 500, referralCredits: 100 });

  const batch = settlePartialReleases({
    gross: 10630,
    releases: [4000, 2000, 4630],
    proFeeBps: 500,
    referralCredits: 100,
  });
  assert.deepEqual(report.settlement, {
    gross: 10630,
    proFee: batch.totalProFee,
    referralCredits: batch.totalReferralCredits,
    net: batch.totalNet,
  });
  assert.equal(report.settlement?.proFee, 531.5);
  assert.equal(report.settlement?.referralCredits, 100);
  assert.equal(report.settlement?.net, 9998.5);
  assert.equal(party(report, "referrer").inflow, 100);
  assert.equal(party(report, "creator").inflow, 9998.5);
  assert.equal(report.balanced, true);
});

test("RELEASED with non-clean tranches: per-tranche cent rounding is kept, not the single-shot fee", () => {
  const escrow = releasedWithPartials([3333.33, 3333.33]);
  const report = releasedReport(escrow, { proFeeBps: 500 });

  // Per-tranche fees: 166.67 + 166.67 + 198.17 = 531.51 — one cent
  // above the single-shot fee on the whole deposit (531.50), because
  // each tranche's fee is rounded to cents at settlement time.
  const batch = settlePartialReleases({
    gross: 10630,
    releases: [3333.33, 3333.33, 3963.34],
    proFeeBps: 500,
  });
  assert.equal(batch.totalProFee, 531.51);
  assert.equal(batch.totalNet, 10098.49);
  assert.deepEqual(report.settlement, {
    gross: 10630,
    proFee: 531.51,
    referralCredits: 0,
    net: 10098.49,
  });
  assert.notDeepEqual(
    report.settlement,
    settleRelease({ gross: 10630, proFeeBps: 500 }),
  );
  assert.equal(party(report, "platform").inflow, 531.51);
  assert.equal(party(report, "creator").inflow, 10098.49);
  assert.equal(report.balanced, true);
  assert.equal(report.totalInflow, 10630);
});

test("RELEASED after one golden tranche: batch oracle, final leg is the remainder", () => {
  const escrow = releasedWithPartials([4252]);
  const report = releasedReport(escrow, { proFeeBps: 500 });

  const batch = settlePartialReleases({
    gross: 10630,
    releases: [4252, 6378],
    proFeeBps: 500,
  });
  assert.deepEqual(report.settlement, {
    gross: 10630,
    proFee: batch.totalProFee,
    referralCredits: 0,
    net: batch.totalNet,
  });
  assert.equal(report.settlement?.proFee, 531.5);
  assert.equal(report.settlement?.net, 10098.5);
  assert.equal(report.outcome, "released");
  assert.equal(report.balanced, true);
});

test("RELEASED when tranches already paid the whole deposit: final tranche is 0", () => {
  const escrow = releasedWithPartials([4000, 6630]);
  const report = releasedReport(escrow, { proFeeBps: 500 });

  const batch = settlePartialReleases({
    gross: 10630,
    releases: [4000, 6630, 0],
    proFeeBps: 500,
  });
  assert.deepEqual(report.settlement, {
    gross: 10630,
    proFee: batch.totalProFee,
    referralCredits: 0,
    net: batch.totalNet,
  });
  assert.equal(report.settlement?.proFee, 531.5);
  assert.equal(report.settlement?.net, 10098.5);
  assert.equal(report.balanced, true);
  assert.equal(report.totalInflow, 10630);
});

test("RELEASED via arbitration after tranches: same batch totals, no settlementRef", () => {
  const e = new Escrow("esc-arb-partials");
  e.dispatch("FUND", undefined, 10630);
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("PARTIAL_RELEASE", undefined, 4000);
  e.dispatch("DISPUTE");
  e.dispatch("ARBITRATE_RELEASE");
  const report = releasedReport(e, { proFeeBps: 500 });

  const batch = settlePartialReleases({
    gross: 10630,
    releases: [4000, 6630],
    proFeeBps: 500,
  });
  assert.deepEqual(report.settlement, {
    gross: 10630,
    proFee: batch.totalProFee,
    referralCredits: 0,
    net: batch.totalNet,
  });
  assert.equal(report.outcome, "released");
  assert.equal(report.settlementRef, undefined);
  assert.equal(report.balanced, true);
});

test("RELEASED with no prior tranche: byte-identical to the plain full-deposit settlement", () => {
  const e = new Escrow("esc-plain-release");
  e.dispatch("FUND", undefined, 10630);
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  const report = releasedReport(e, { proFeeBps: 500 });

  assert.deepEqual(report.settlement, settleRelease({ gross: 10630, proFeeBps: 500 }));
  assert.deepEqual(report.parties, [
    { party: "sponsor", label: "Sponsor (depositor)", inflow: 0, outflow: 10630, net: -10630 },
    { party: "creator", label: "Creator (payee)", inflow: 10098.5, outflow: 0, net: 10098.5 },
    { party: "platform", label: "Platform (pro fee)", inflow: 531.5, outflow: 0, net: 531.5 },
    { party: "referrer", label: "Referrer (referral credits)", inflow: 0, outflow: 0, net: 0 },
  ]);
  assert.equal(report.balanced, true);
});

test("REFUNDED after a tranche: only the still-locked remainder returns to the sponsor", () => {
  const escrow = refundedWithPartial(4000);
  const report = terminalReport(escrow);

  assert.equal(report.outcome, "refunded");
  assert.equal(party(report, "sponsor").inflow, 6630);
  assert.equal(party(report, "sponsor").outflow, 10630);
  assert.equal(party(report, "sponsor").net, -4000);
  // The released total stays paid out, shown on the creator's row.
  assert.equal(party(report, "creator").inflow, 4000);
  assert.equal(party(report, "platform").inflow, 0);
  assert.equal(party(report, "referrer").inflow, 0);
  assert.equal(report.balanced, true);
  assert.equal(report.totalInflow, 10630);
  assert.equal(report.totalOutflow, 10630);
});

test("EXPIRED after a tranche: same remainder-only refund ledger", () => {
  const escrow = expiredWithPartial(4000);
  const report = terminalReport(escrow);

  assert.equal(report.outcome, "expired");
  assert.equal(party(report, "sponsor").inflow, 6630);
  assert.equal(party(report, "sponsor").outflow, 10630);
  assert.equal(party(report, "creator").inflow, 4000);
  assert.equal(report.balanced, true);
  assert.equal(report.totalInflow, 10630);
});

test("REFUNDED with no prior tranche: byte-identical full-deposit refund", () => {
  const e = new Escrow("esc-plain-refund");
  e.dispatch("FUND", undefined, 10630);
  e.dispatch("DISPUTE");
  e.dispatch("ARBITRATE_REFUND");
  const report = terminalReport(e);

  assert.equal(report.outcome, "refunded");
  assert.equal(party(report, "sponsor").inflow, 10630);
  assert.equal(party(report, "sponsor").outflow, 10630);
  assert.equal(party(report, "sponsor").net, 0);
  assert.equal(party(report, "creator").inflow, 0);
  assert.equal(report.balanced, true);
  assert.equal(report.totalInflow, 10630);
  assert.equal(report.totalOutflow, 10630);
});

test("RELEASED with an over-released trail throws instead of settling a negative remainder", () => {
  const escrow = releasedWithPartials([4000, 2000]);
  const history = cloneHistory(escrow.history);
  // Strip the chain: a fully hashless (legacy) history passes the chain
  // check, so the over-release guard — not the tamper check — is what
  // fires. (With the hashes intact, editing the amount would fail the
  // chain check first, which is the correct behaviour for a live trail.)
  for (const entry of history) {
    delete (entry as { hash?: string }).hash;
    delete (entry as { prevHash?: string }).prevHash;
  }
  const firstTranche = history.find((e) => e.event === "PARTIAL_RELEASE");
  assert.ok(firstTranche);
  firstTranche.amount = 9000; // 9000 + 2000 = 11000 > deposit 10630
  assert.throws(
    () =>
      buildSettlementReport({
        escrowId: escrow.id,
        history,
        finalState: "RELEASED",
        deposit: goldenDeposit(),
        settlement: { proFeeBps: 500 },
      }),
    /partial releases total 11000 but the deposit is 10630/,
  );
});

test("REFUNDED with an over-released trail throws instead of refunding a negative remainder", () => {
  const escrow = refundedWithPartial(4000);
  const history = cloneHistory(escrow.history);
  // Strip the chain (see the RELEASED case above): hashless legacy
  // history, so the over-release guard is what fires.
  for (const entry of history) {
    delete (entry as { hash?: string }).hash;
    delete (entry as { prevHash?: string }).prevHash;
  }
  const tranche = history.find((e) => e.event === "PARTIAL_RELEASE");
  assert.ok(tranche);
  tranche.amount = 11000; // > deposit 10630
  assert.throws(
    () =>
      buildSettlementReport({
        escrowId: escrow.id,
        history,
        finalState: "REFUNDED",
        deposit: goldenDeposit(),
      }),
    /partial releases total 11000 but the deposit is 10630/,
  );
});
