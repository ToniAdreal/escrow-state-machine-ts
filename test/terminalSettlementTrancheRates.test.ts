import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  calculateDeposit,
  reconcileSettlements,
  settlePartialRelease,
  summarizeSettlementReports,
  type LedgerSettlement,
  type PriorTrancheSettlement,
} from "../src/index.js";

/**
 * Terminal settlement at per-tranche actual rates (backlog #1421): the
 * audit trail records only the released amounts, not the rate each
 * slice was reported at, so without `priorTrancheSettlements` the
 * terminal branches re-derive every prior tranche's fee split at the
 * terminal rate — a slice reported earlier at a different rate is
 * restated. With the splits supplied, each prior tranche settles at
 * its own recorded rate and only the remainder settles at the terminal
 * rate (RELEASED), and a REFUNDED / EXPIRED report splits the released
 * total into the tranches' net total (creator row) and pro-fee total
 * (platform row) instead of folding the fee into the creator row.
 * The no-splits paths stay byte-identical to the previous reports.
 */

function deposit10000() {
  // Clean $10,000 deposit: pool $10,000, no fees, so the probe numbers
  // from the backlog item read directly (5000 @ 500bps → fee 250).
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 0,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 0,
    oracleFee: 0,
  });
}

function party(report: ReturnType<typeof buildSettlementReport>, role: string) {
  const row = report.parties.find((p) => p.party === role);
  assert.ok(row, `missing ${role} ledger row`);
  return row;
}

/** FUND 10000, milestone, the given tranches, re-submit, verify, RELEASE. */
function releasedWithPartials(
  amounts: number[],
  id = "esc-tranche-rates-released",
): Escrow {
  const e = new Escrow(id);
  e.dispatch("FUND", undefined, 10000);
  e.dispatch("SUBMIT_MILESTONE");
  for (const amount of amounts) e.dispatch("PARTIAL_RELEASE", undefined, amount);
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return e;
}

/** FUND 10000, milestone, one tranche, dispute, arbitration refund. */
function refundedWithPartial(amount: number, id = "esc-tranche-rates-refunded"): Escrow {
  const e = new Escrow(id);
  e.dispatch("FUND", undefined, 10000);
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("PARTIAL_RELEASE", undefined, amount);
  e.dispatch("DISPUTE");
  e.dispatch("ARBITRATE_REFUND");
  return e;
}

/** FUND 10000, milestone, one tranche, EXPIRE. */
function expiredWithPartial(amount: number, id = "esc-tranche-rates-expired"): Escrow {
  const e = new Escrow(id);
  e.dispatch("FUND", undefined, 10000);
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("PARTIAL_RELEASE", undefined, amount);
  e.dispatch("EXPIRE");
  return e;
}

function releasedReport(
  escrow: Escrow,
  settlement: { proFeeBps: number; referralCredits?: number },
  priorTrancheSettlements?: PriorTrancheSettlement[],
) {
  return buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: deposit10000(),
    settlement,
    ...(priorTrancheSettlements !== undefined ? { priorTrancheSettlements } : {}),
  });
}

function terminalReport(
  escrow: Escrow,
  priorTrancheSettlements?: PriorTrancheSettlement[],
) {
  return buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: deposit10000(),
    ...(priorTrancheSettlements !== undefined ? { priorTrancheSettlements } : {}),
  });
}

test("RELEASED at changed rates: prior tranche keeps its own rate (backlog probe)", () => {
  // The backlog probe: deposit 10000, first release 5000 settled at
  // 500bps (fee 250), terminal settlement at 1000bps. Lifetime fee is
  // 250 + 500 = 750, not the 1000 the terminal-rate restatement gives.
  const escrow = releasedWithPartials([5000]);
  const report = releasedReport(
    escrow,
    { proFeeBps: 1000 },
    [{ released: 5000, proFeeBps: 500 }],
  );

  assert.deepEqual(report.settlement, {
    gross: 10000,
    proFee: 750,
    referralCredits: 0,
    net: 9250,
  });
  assert.equal(party(report, "creator").inflow, 9250);
  assert.equal(party(report, "platform").inflow, 750);
  assert.equal(party(report, "referrer").inflow, 0);
  assert.equal(party(report, "sponsor").outflow, 10000);
  assert.equal(report.balanced, true);
  assert.equal(report.totalInflow, 10000);
  assert.equal(report.totalOutflow, 10000);
  assert.equal(report.outcome, "released");

  // The same escrow without the splits shows the old restatement:
  // the whole deposit at the terminal 1000bps, fee 1000, net 9000.
  const restated = releasedReport(escrow, { proFeeBps: 1000 });
  assert.equal(restated.settlement?.proFee, 1000);
  assert.equal(restated.settlement?.net, 9000);
  assert.notDeepEqual(report.settlement, restated.settlement);
});

test("RELEASED at the same rate: byte-identical to the report without splits", () => {
  const escrow = releasedWithPartials([5000]);
  const withSplits = releasedReport(
    escrow,
    { proFeeBps: 1000 },
    [{ released: 5000, proFeeBps: 1000 }],
  );
  const withoutSplits = releasedReport(escrow, { proFeeBps: 1000 });

  assert.deepEqual(withSplits, withoutSplits);
  assert.equal(withSplits.settlement?.proFee, 1000);
  assert.equal(withSplits.settlement?.net, 9000);
});

test("RELEASED with referral credits: each tranche's credits counted once, never doubled", () => {
  const escrow = releasedWithPartials([5000]);
  const report = releasedReport(
    escrow,
    { proFeeBps: 1000, referralCredits: 50 },
    [{ released: 5000, proFeeBps: 500, referralCredits: 100 }],
  );

  // Prior tranche: 5000 − 250 fee − 100 credits = 4650 net.
  // Remainder: 5000 − 500 fee − 50 credits = 4450 net.
  // Lifetime: fee 750, credits 150, net 9100.
  assert.deepEqual(report.settlement, {
    gross: 10000,
    proFee: 750,
    referralCredits: 150,
    net: 9100,
  });
  assert.equal(party(report, "referrer").inflow, 150);
  assert.equal(party(report, "creator").inflow, 9100);
  assert.equal(report.balanced, true);
});

test("RELEASED with two prior tranches at different rates: per-tranche actuals accumulate", () => {
  const escrow = releasedWithPartials([3000, 2000]);
  const report = releasedReport(
    escrow,
    { proFeeBps: 1000 },
    [
      { released: 3000, proFeeBps: 500 },
      { released: 2000, proFeeBps: 200 },
    ],
  );

  // Tranche 1: fee 150, net 2850. Tranche 2: fee 40, net 1960.
  // Remainder 5000 at 1000bps: fee 500, net 4500.
  // Lifetime: fee 690, net 9310. The per-tranche oracle agrees.
  const first = settlePartialRelease({ gross: 10000, released: 3000, proFeeBps: 500 });
  const second = settlePartialRelease({ gross: 10000, released: 2000, proFeeBps: 200 });
  const remainder = settlePartialRelease({ gross: 10000, released: 5000, proFeeBps: 1000 });
  assert.equal(first.proFee + second.proFee + remainder.proFee, 690);
  assert.deepEqual(report.settlement, {
    gross: 10000,
    proFee: 690,
    referralCredits: 0,
    net: 9310,
  });
  assert.equal(party(report, "platform").inflow, 690);
  assert.equal(party(report, "creator").inflow, 9310);
  assert.equal(report.balanced, true);
});

test("REFUNDED at changed rates: creator row is the tranche net, platform row its fee", () => {
  const escrow = refundedWithPartial(5000);
  const report = terminalReport(escrow, [{ released: 5000, proFeeBps: 500 }]);

  assert.equal(report.outcome, "refunded");
  assert.equal(party(report, "sponsor").inflow, 5000);
  assert.equal(party(report, "sponsor").outflow, 10000);
  assert.equal(party(report, "sponsor").net, -5000);
  // The 5000 already paid out splits into net 4750 + fee 250 —
  // the fee is no longer folded into the creator row.
  assert.equal(party(report, "creator").inflow, 4750);
  assert.equal(party(report, "platform").inflow, 250);
  assert.equal(party(report, "referrer").inflow, 0);
  assert.equal(report.balanced, true);
  assert.equal(report.totalInflow, 10000);
  assert.equal(report.totalOutflow, 10000);

  // Without the splits the folded figures are the previous ones:
  // creator 5000, platform 0.
  const folded = terminalReport(escrow);
  assert.equal(party(folded, "creator").inflow, 5000);
  assert.equal(party(folded, "platform").inflow, 0);
  assert.deepEqual(folded.parties, report.parties.map((p) =>
    p.party === "creator"
      ? { ...p, inflow: 5000, net: 5000 }
      : p.party === "platform"
        ? { ...p, inflow: 0, net: 0 }
        : p,
  ));
});

test("EXPIRED at changed rates with credits: net / fee / credits split across rows", () => {
  const escrow = expiredWithPartial(5000);
  const report = terminalReport(escrow, [
    { released: 5000, proFeeBps: 500, referralCredits: 100 },
  ]);

  assert.equal(report.outcome, "expired");
  assert.equal(party(report, "sponsor").inflow, 5000);
  // 5000 − 250 fee − 100 credits = 4650 net to the creator.
  assert.equal(party(report, "creator").inflow, 4650);
  assert.equal(party(report, "platform").inflow, 250);
  assert.equal(party(report, "referrer").inflow, 100);
  assert.equal(report.balanced, true);
  assert.equal(report.totalInflow, 10000);
  assert.equal(report.totalOutflow, 10000);
});

test("prior splits whose amount disagrees with the trail fail closed", () => {
  const escrow = releasedWithPartials([5000]);
  assert.throws(
    () =>
      releasedReport(escrow, { proFeeBps: 1000 }, [
        { released: 4999, proFeeBps: 500 },
      ]),
    /priorTrancheSettlements\[0\]\.released 4999 does not match the audit history PARTIAL_RELEASE amount 5000/,
  );
  const refunded = refundedWithPartial(5000);
  assert.throws(
    () =>
      terminalReport(refunded, [{ released: 5000.01, proFeeBps: 500 }]),
    /does not match the audit history PARTIAL_RELEASE amount 5000/,
  );
});

test("prior splits with the wrong tranche count fail closed", () => {
  const escrow = releasedWithPartials([5000]);
  assert.throws(
    () =>
      releasedReport(escrow, { proFeeBps: 1000 }, [
        { released: 5000, proFeeBps: 500 },
        { released: 0, proFeeBps: 500 },
      ]),
    /priorTrancheSettlements has 2 entries but the audit history has 1 PARTIAL_RELEASE tranche/,
  );
  // Splits supplied for an escrow with no tranche at all fail too.
  const plain = new Escrow("esc-tranche-rates-no-tranche");
  plain.dispatch("FUND", undefined, 10000);
  plain.dispatch("SUBMIT_MILESTONE");
  plain.dispatch("VERIFY_PASS");
  plain.dispatch("RELEASE");
  assert.throws(
    () =>
      releasedReport(plain, { proFeeBps: 1000 }, [
        { released: 5000, proFeeBps: 500 },
      ]),
    /priorTrancheSettlements has 1 entry but the audit history has 0 PARTIAL_RELEASE tranches/,
  );
});

test("prior splits with a bad shape fail closed before any money math", () => {
  const escrow = releasedWithPartials([5000]);
  assert.throws(
    () =>
      buildSettlementReport({
        escrowId: escrow.id,
        history: escrow.history,
        finalState: escrow.state,
        deposit: deposit10000(),
        settlement: { proFeeBps: 1000 },
        priorTrancheSettlements: [
          { released: 5000, proFeeBp: 500 } as unknown as PriorTrancheSettlement,
        ],
      }),
    /priorTrancheSettlements\[0\]: unknown field "proFeeBp"/,
  );
  assert.throws(
    () =>
      releasedReport(escrow, { proFeeBps: 1000 }, [
        { released: 5000, proFeeBps: 10001 },
      ]),
    /proFeeBps must be an integer in \[0, 10000\]/,
  );
  assert.throws(
    () =>
      buildSettlementReport({
        escrowId: escrow.id,
        history: escrow.history,
        finalState: escrow.state,
        deposit: deposit10000(),
        settlement: { proFeeBps: 1000 },
        priorTrancheSettlements: "not-an-array" as unknown as PriorTrancheSettlement[],
      }),
    /priorTrancheSettlements must be an array/,
  );
});

test("prior splits on a non-terminal escrow fail closed instead of being ignored", () => {
  const e = new Escrow("esc-tranche-rates-funded");
  e.dispatch("FUND", undefined, 10000);
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("PARTIAL_RELEASE", undefined, 5000);
  assert.throws(
    () =>
      buildSettlementReport({
        escrowId: e.id,
        history: e.history,
        finalState: e.state,
        deposit: deposit10000(),
        partialRelease: { released: 1000, proFeeBps: 500 },
        priorTrancheSettlements: [{ released: 5000, proFeeBps: 500 }],
      }),
    /priorTrancheSettlements is only valid for a terminal escrow \(state is FUNDED\)/,
  );
});

test("summarize and reconcile treat a per-tranche report like any other report", () => {
  const released = releasedReport(
    releasedWithPartials([5000], "esc-tranche-rates-sum-rel"),
    { proFeeBps: 1000 },
    [{ released: 5000, proFeeBps: 500 }],
  );
  const refunded = terminalReport(
    refundedWithPartial(5000, "esc-tranche-rates-sum-ref"),
    [{ released: 5000, proFeeBps: 500 }],
  );

  const summary = summarizeSettlementReports([
    { escrowId: released.escrowId, report: released },
    { escrowId: refunded.escrowId, report: refunded },
  ]);
  assert.equal(summary.total, 2);
  assert.equal(summary.reports, 2);
  assert.equal(summary.errors, 0);
  assert.equal(summary.totalDeposit, 20000);
  assert.equal(summary.totalOutflow, 20000);
  assert.equal(summary.balanced, true);
  assert.equal(summary.outcomes.released, 1);
  assert.equal(summary.outcomes.refunded, 1);

  const ledger: LedgerSettlement[] = [
    { escrowId: released.escrowId, amount: 10000 },
    { escrowId: refunded.escrowId, amount: 10000 },
  ];
  const result = reconcileSettlements([released, refunded], ledger);
  assert.equal(result.matched.length, 2);
  assert.equal(result.reportOnly.length, 0);
  assert.equal(result.ledgerOnly.length, 0);
  assert.equal(result.amountMismatch.length, 0);
  assert.equal(result.currencyMismatch.length, 0);
});

test("empty prior splits on a no-tranche escrow behave exactly like omitting them", () => {
  const e = new Escrow("esc-tranche-rates-empty");
  e.dispatch("FUND", undefined, 10000);
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  const withEmpty = releasedReport(e, { proFeeBps: 1000 }, []);
  const without = releasedReport(e, { proFeeBps: 1000 });
  assert.deepEqual(withEmpty, without);
});
