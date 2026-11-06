import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementReports,
  calculateDeposit,
  createQuorum,
  dispatchArbitration,
  summarizeSettlementReports,
  type SettlementReportInputs,
} from "../src/index.js";

// Backlog #786: settlementReportsBatch x quorum.
//
// Read-first note (do not invent report fields): a SettlementReport
// carries NO quorum/approval field — its state surface is outcome,
// releasePath (released only), parties, totals, balanced, eventCount
// and the audit window. Arbitration approval state therefore shows up
// in a batch as: (a) the reached escrow's outcome/releasePath and the
// "quorum n/5" tally in its audit history's last entry, and (b) the
// below-threshold escrow having NO report at all (DISPUTED is
// non-terminal, so the batch records a per-item error and the summary
// excludes it). These tests pin exactly that, and nothing more.

const SIGNERS = [
  "dao-1", "dao-2", "dao-3", "dao-4", "dao-5",
  "dao-6", "dao-7", "dao-8", "dao-9",
];

function deposit() {
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

/** Escrow sitting in DISPUTED, funded with the exact deposit amount. */
function disputedEscrow(id: string): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", undefined, 10630);
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
    settlement: { proFeeBps: 500 },
  };
}

test("quorum-reached release reports, below-threshold disputed escrow errors per item", () => {
  const reached = disputedEscrow("q-rel");
  dispatchArbitration(reached, quorumWith(5), "release");
  assert.equal(reached.state, "RELEASED");
  const reachedLast = reached.history[reached.history.length - 1];
  assert.equal(reachedLast.event, "ARBITRATE_RELEASE");
  assert.equal(reachedLast.note, "quorum 5/5");

  const unreached = disputedEscrow("q-open");
  const historyBefore = unreached.history.length;
  assert.throws(
    () => dispatchArbitration(unreached, quorumWith(4), "release"),
    /arbitration requires quorum: 4\/5 approvals/,
  );
  assert.equal(unreached.state, "DISPUTED");
  assert.equal(unreached.history.length, historyBefore);
  assert.equal(unreached.history[unreached.history.length - 1].event, "DISPUTE");
  assert.ok(!(unreached.history[unreached.history.length - 1].note ?? "").includes("quorum"));

  const results = buildSettlementReports([inputsFor(reached), inputsFor(unreached)]);
  assert.deepEqual(results.map((r) => r.escrowId), ["q-rel", "q-open"]);

  const report = results[0].report;
  assert.ok(report);
  assert.equal(results[0].error, undefined);
  assert.equal(report.outcome, "released");
  assert.equal(report.releasePath, "DISPUTE → ARBITRATE_RELEASE");
  assert.equal(report.balanced, true);
  assert.equal(report.deposit.deposit, 10630);
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
  assert.equal(report.totalInflow, 10630);
  assert.equal(report.totalOutflow, 10630);
  assert.equal(report.eventCount, reached.history.length);
  assert.equal(report.firstEventAt, reached.history[0].at);
  assert.equal(report.lastEventAt, reachedLast.at);
  // The report carries no quorum field: approval state is the
  // outcome/releasePath above plus the audit note, not a new field.
  assert.equal((report as unknown as Record<string, unknown>).quorum, undefined);

  assert.equal(results[1].report, undefined);
  assert.match(results[1].error ?? "", /no settlement has happened yet/);
});

test("summary counts only the reached escrow: below-threshold money never enters totals", () => {
  const reached = disputedEscrow("q-sum-rel");
  dispatchArbitration(reached, quorumWith(5), "release");
  const unreached = disputedEscrow("q-sum-open");
  assert.throws(() => dispatchArbitration(unreached, quorumWith(4), "refund"));

  const results = buildSettlementReports([inputsFor(reached), inputsFor(unreached)]);
  const summary = summarizeSettlementReports(results);
  assert.equal(summary.total, 2);
  assert.equal(summary.reports, 1);
  assert.equal(summary.errors, 1);
  assert.deepEqual(summary.outcomes, { released: 1, refunded: 0, expired: 0, "partially-released": 0 });
  // Exactly one deposit, not two: the unreached escrow contributes zero.
  assert.equal(summary.totalDeposit, 10630);
  assert.equal(summary.totalInflow, 10630);
  assert.equal(summary.totalOutflow, 10630);
  assert.equal(summary.balanced, true);
  assert.deepEqual(
    summary.parties.map((p) => [p.party, p.inflow, p.outflow, p.net]),
    [
      ["sponsor", 0, 10630, -10630],
      ["creator", 10098.5, 0, 10098.5],
      ["platform", 531.5, 0, 531.5],
      ["referrer", 0, 0, 0],
    ],
  );
});

test("quorum-reached release + quorum-reached refund: batch reports match single reports, summary recomputes", () => {
  const released = disputedEscrow("q-both-rel");
  dispatchArbitration(released, quorumWith(5), "release");
  const refunded = disputedEscrow("q-both-ref");
  dispatchArbitration(refunded, quorumWith(6), "refund");
  assert.equal(refunded.history[refunded.history.length - 1].note, "quorum 6/5");

  const inputs = [inputsFor(released), inputsFor(refunded)];
  const results = buildSettlementReports(inputs);
  assert.equal(results[0].report?.outcome, "released");
  assert.equal(results[0].report?.releasePath, "DISPUTE → ARBITRATE_RELEASE");
  assert.equal(results[1].report?.outcome, "refunded");
  assert.equal(results[1].report?.releasePath, undefined);
  assert.equal(results[1].report?.settlement, undefined);
  assert.deepEqual(
    results[1].report?.parties.map((p) => [p.party, p.inflow, p.outflow, p.net]),
    [
      ["sponsor", 10630, 10630, 0],
      ["creator", 0, 0, 0],
      ["platform", 0, 0, 0],
      ["referrer", 0, 0, 0],
    ],
  );
  // Batch entries are exactly the single-escrow reports.
  for (let i = 0; i < inputs.length; i++) {
    assert.deepEqual(results[i].report, buildSettlementReport(inputs[i]));
  }

  const summary = summarizeSettlementReports(results);
  assert.equal(summary.total, 2);
  assert.equal(summary.reports, 2);
  assert.equal(summary.errors, 0);
  assert.deepEqual(summary.outcomes, { released: 1, refunded: 1, expired: 0, "partially-released": 0 });
  assert.equal(summary.totalDeposit, 21260);
  assert.equal(summary.totalInflow, 21260);
  assert.equal(summary.totalOutflow, 21260);
  assert.equal(summary.balanced, true);
  // Recomputed party-by-party from the two reports, not copied totals.
  const recomputed = new Map<string, [number, number]>();
  for (const r of results) {
    for (const p of r.report!.parties) {
      const prev = recomputed.get(p.party) ?? [0, 0];
      recomputed.set(p.party, [prev[0] + p.inflow, prev[1] + p.outflow]);
    }
  }
  for (const p of summary.parties) {
    const [inflow, outflow] = recomputed.get(p.party)!;
    assert.equal(p.inflow, inflow);
    assert.equal(p.outflow, outflow);
    assert.equal(p.net, Math.round((inflow - outflow) * 100) / 100);
  }
  assert.deepEqual(
    summary.parties.map((p) => [p.party, p.inflow, p.outflow, p.net]),
    [
      ["sponsor", 10630, 21260, -10630],
      ["creator", 10098.5, 0, 10098.5],
      ["platform", 531.5, 0, 531.5],
      ["referrer", 0, 0, 0],
    ],
  );
});

test("revoked below threshold: entry errors and does not block a reached companion", () => {
  const revoked = disputedEscrow("q-revoked");
  const quorum = quorumWith(5);
  quorum.revoke("dao-5");
  assert.equal(quorum.hasQuorum(), false);
  assert.throws(
    () => dispatchArbitration(revoked, quorum, "release"),
    /arbitration requires quorum: 4\/5 approvals/,
  );
  assert.equal(revoked.state, "DISPUTED");

  const reached = disputedEscrow("q-revoked-companion");
  dispatchArbitration(reached, quorumWith(5), "refund");

  const results = buildSettlementReports([inputsFor(revoked), inputsFor(reached)]);
  assert.equal(results[0].report, undefined);
  assert.match(results[0].error ?? "", /no settlement has happened yet/);
  assert.equal(results[1].report?.outcome, "refunded");
  assert.equal(results[1].report?.balanced, true);
});

test("batch purity: reporting quorum escrows changes no escrow state or history", () => {
  const released = disputedEscrow("q-pure-rel");
  dispatchArbitration(released, quorumWith(5), "release");
  const open = disputedEscrow("q-pure-open");
  assert.throws(() => dispatchArbitration(open, quorumWith(3), "release"));
  const escrows = [released, open];
  const before = escrows.map((e) => JSON.stringify({ state: e.state, history: e.history }));
  buildSettlementReports(escrows.map((e) => inputsFor(e)));
  summarizeSettlementReports(buildSettlementReports(escrows.map((e) => inputsFor(e))));
  const after = escrows.map((e) => JSON.stringify({ state: e.state, history: e.history }));
  assert.deepEqual(after, before);
});
