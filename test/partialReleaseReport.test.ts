import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementReports,
  calculateDeposit,
  parseSettlementReportCsv,
  parseSettlementReportJson,
  renderReport,
  renderReportCsv,
  renderReportJson,
  settlePartialRelease,
  settleRelease,
  summarizeSettlementReports,
  type EscrowHistoryEntry,
} from "../src/index.js";

/**
 * A FUNDED escrow has no settlement report today: `buildSettlementReport`
 * only knows the three terminal outcomes, so an escrow that released part
 * of its deposit and keeps the rest locked cannot get its slice on the
 * books. With `partialRelease` inputs a FUNDED escrow reports outcome
 * `"partially-released"`, with the slice settled per `settlePartialRelease`
 * and the remainder still locked on the sponsor's row.
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

function fundedEscrow(id = "esc-partial") {
  const e = new Escrow(id);
  e.dispatch("FUND", undefined, 10630);
  return e;
}

function releasedEscrow(id = "esc-10630") {
  const e = new Escrow(id);
  e.dispatch("FUND", undefined, 10630);
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return e;
}

/** Deep-clone entries (the live history is frozen, so mutate clones). */
function cloneHistory(history: readonly EscrowHistoryEntry[]): EscrowHistoryEntry[] {
  return JSON.parse(JSON.stringify(history)) as EscrowHistoryEntry[];
}

function partialReport(escrow: Escrow, partialRelease: { released: number; proFeeBps: number; referralCredits?: number }) {
  return buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: goldenDeposit(),
    partialRelease,
  });
}

test("golden slice: 4252 of 10630 at 500bps matches settlePartialRelease exactly", () => {
  const escrow = fundedEscrow();
  const report = partialReport(escrow, { released: 4252, proFeeBps: 500 });

  // The pure function's own numbers, computed independently of the report:
  const expected = settlePartialRelease({ gross: 10630, released: 4252, proFeeBps: 500 });
  assert.deepEqual(expected, {
    released: 4252,
    proFee: 212.6,
    referralCredits: 0,
    net: 4039.4,
    remaining: 6378,
  });
  assert.deepEqual(report.partialSettlement, expected);
  assert.equal(report.outcome, "partially-released");
  assert.equal(report.remaining, 6378);
  assert.equal(report.eventCount, 1);
  assert.ok(report.balanced);

  // Ledger over the full deposit: sponsor outflow is the whole locked
  // deposit, sponsor inflow is the amount still held; the slice flows
  // out to creator / platform / referrer.
  const byParty = Object.fromEntries(report.parties.map((p) => [p.party, p]));
  assert.deepEqual(
    { inflow: byParty.sponsor.inflow, outflow: byParty.sponsor.outflow, net: byParty.sponsor.net },
    { inflow: 6378, outflow: 10630, net: -4252 },
  );
  assert.deepEqual(
    { inflow: byParty.creator.inflow, outflow: byParty.creator.outflow, net: byParty.creator.net },
    { inflow: 4039.4, outflow: 0, net: 4039.4 },
  );
  assert.deepEqual(
    { inflow: byParty.platform.inflow, net: byParty.platform.net },
    { inflow: 212.6, net: 212.6 },
  );
  assert.equal(byParty.referrer.inflow, 0);

  // Conservation over the full deposit; all nets sum to zero.
  assert.equal(report.totalInflow, 10630);
  assert.equal(report.totalOutflow, 10630);
  assert.equal(
    report.parties.reduce((s, p) => Math.round((s + p.net) * 100) / 100, 0),
    0,
  );
  // No full-release fields leak into a partial report.
  assert.equal(report.settlement, undefined);
  assert.equal(report.releasePath, undefined);
});

test("referral credits in the slice go to the referrer, net shrinks", () => {
  const report = partialReport(fundedEscrow("esc-partial-ref"), {
    released: 5000,
    proFeeBps: 500,
    referralCredits: 100,
  });
  const expected = settlePartialRelease({ gross: 10630, released: 5000, proFeeBps: 500, referralCredits: 100 });
  assert.deepEqual(report.partialSettlement, expected);
  const byParty = Object.fromEntries(report.parties.map((p) => [p.party, p]));
  assert.equal(byParty.referrer.net, 100);
  assert.equal(byParty.creator.net, expected.net);
  assert.equal(byParty.platform.net, expected.proFee);
  assert.equal(report.remaining, 5630);
  assert.ok(report.balanced);
});

test("released = gross equals the full-release report's ledger", () => {
  const partial = partialReport(fundedEscrow("esc-partial-full"), {
    released: 10630,
    proFeeBps: 500,
    referralCredits: 50,
  });
  const escrow = releasedEscrow("esc-full");
  const full = buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500, referralCredits: 50 },
  });
  // Same slice numbers as the full-release split, and the same ledger:
  // remaining 0 means the sponsor row is the released outcome's row.
  assert.deepEqual(partial.partialSettlement, {
    released: 10630,
    proFee: 531.5,
    referralCredits: 50,
    net: 10048.5,
    remaining: 0,
  });
  assert.deepEqual(partial.parties, full.parties);
  assert.equal(partial.totalInflow, full.totalInflow);
  assert.equal(partial.totalOutflow, full.totalOutflow);
  assert.equal(partial.remaining, 0);
  // The two outcomes still differ where they must.
  assert.equal(partial.outcome, "partially-released");
  assert.equal(full.outcome, "released");
  assert.equal(full.settlement?.net, settleRelease({ gross: 10630, proFeeBps: 500, referralCredits: 50 }).net);
});

test("released above the deposit throws (delegated to settlePartialRelease)", () => {
  const escrow = fundedEscrow("esc-partial-over");
  assert.throws(
    () => partialReport(escrow, { released: 10631, proFeeBps: 500 }),
    /released must not exceed gross/,
  );
  // No report was produced and the escrow is untouched.
  assert.equal(escrow.state, "FUNDED");
  assert.equal(escrow.history.length, 1);
});

test("terminal RELEASED escrow + partialRelease throws", () => {
  const escrow = releasedEscrow("esc-terminal-partial");
  assert.throws(
    () =>
      buildSettlementReport({
        escrowId: escrow.id,
        history: escrow.history,
        finalState: escrow.state,
        deposit: goldenDeposit(),
        partialRelease: { released: 4252, proFeeBps: 500 },
      }),
    /partialRelease is only valid for a FUNDED escrow \(state is RELEASED\)/,
  );
});

test("FUNDED escrow without partialRelease keeps the old error", () => {
  const escrow = fundedEscrow("esc-no-slice");
  assert.throws(
    () =>
      buildSettlementReport({
        escrowId: escrow.id,
        history: escrow.history,
        finalState: escrow.state,
        deposit: goldenDeposit(),
      }),
    /escrow is in FUNDED, no settlement has happened yet/,
  );
});

test("tampered history still reports the broken chain first", () => {
  const history = cloneHistory(fundedEscrow("esc-tampered").history);
  history[0].amount = 1; // attacker shrinks the locked deposit
  assert.throws(
    () =>
      buildSettlementReport({
        escrowId: "esc-tampered",
        history,
        finalState: "FUNDED",
        deposit: goldenDeposit(),
        partialRelease: { released: 4252, proFeeBps: 500 },
      }),
    /hash chain/,
  );
});

test("non-object partialRelease throws a clear error", () => {
  const escrow = fundedEscrow("esc-bad-slice");
  assert.throws(
    () =>
      buildSettlementReport({
        escrowId: escrow.id,
        history: escrow.history,
        finalState: escrow.state,
        deposit: goldenDeposit(),
        // @ts-expect-error deliberate misuse: partialRelease must be an object
        partialRelease: "4252",
      }),
    /partialRelease must be an object/,
  );
});

test("batch wrapper inherits the partial outcome and the summary counts it", () => {
  const partialEscrow = fundedEscrow("esc-batch-partial");
  const released = releasedEscrow("esc-batch-full");
  const results = buildSettlementReports([
    {
      escrowId: partialEscrow.id,
      history: partialEscrow.history,
      finalState: partialEscrow.state,
      deposit: goldenDeposit(),
      partialRelease: { released: 4252, proFeeBps: 500 },
    },
    {
      escrowId: released.id,
      history: released.history,
      finalState: released.state,
      deposit: goldenDeposit(),
      settlement: { proFeeBps: 500 },
    },
    // A FUNDED escrow with no slice fails only its own entry.
    {
      escrowId: "esc-batch-nonslice",
      history: fundedEscrow("esc-batch-nonslice").history,
      finalState: "FUNDED",
      deposit: goldenDeposit(),
    },
  ]);
  assert.equal(results[0].report?.outcome, "partially-released");
  assert.equal(results[0].report?.remaining, 6378);
  assert.equal(results[1].report?.outcome, "released");
  assert.match(results[2].error ?? "", /no settlement has happened yet/);

  const summary = summarizeSettlementReports(results);
  assert.equal(summary.reports, 2);
  assert.equal(summary.errors, 1);
  assert.equal(summary.outcomes["partially-released"], 1);
  assert.equal(summary.outcomes.released, 1);
  assert.equal(summary.totalDeposit, 21260);
  assert.ok(summary.balanced);
});

test("JSON round-trip preserves partialSettlement and remaining", () => {
  const report = partialReport(fundedEscrow("esc-json"), { released: 4252, proFeeBps: 500 });
  const parsed = parseSettlementReportJson(renderReportJson(report));
  assert.deepEqual(parsed, report);
  assert.equal(parsed.outcome, "partially-released");
  assert.equal(parsed.remaining, 6378);
  assert.deepEqual(parsed.partialSettlement, report.partialSettlement);
});

test("CSV round-trip carries the partial outcome and ledgers", () => {
  const report = partialReport(fundedEscrow("esc-csv"), { released: 4252, proFeeBps: 500 });
  const parsed = parseSettlementReportCsv(renderReportCsv(report));
  assert.equal(parsed.outcome, "partially-released");
  assert.deepEqual(parsed.parties, report.parties);
  assert.equal(parsed.totalInflow, 10630);
  assert.equal(parsed.totalOutflow, 10630);
  assert.ok(parsed.balanced);
});

test("renderReport names the released slice and the amount still locked", () => {
  const report = partialReport(fundedEscrow("esc-text"), { released: 4252, proFeeBps: 500 });
  const text = renderReport(report);
  assert.match(text, /Outcome: partially-released/);
  assert.match(text, /Partial release: \$4,252\.00 of \$10,630\.00 released/);
  assert.match(text, /\$6,378\.00 remains locked/);
});
