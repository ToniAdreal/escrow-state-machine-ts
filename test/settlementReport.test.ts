import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  calculateDeposit,
  depositAmountFromHistory,
  renderReport,
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

/** Hand-computed accounting for the golden fixture. */
function manualAccounting(deposit: number, proFeeBps: number, referralCredits: number) {
  const proFee = Math.round(((deposit * proFeeBps) / 10000) * 100) / 100;
  const net = Math.round((deposit - proFee - referralCredits) * 100) / 100;
  return { proFee, net };
}

function releaseEscrow(id = "esc-10630") {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return e;
}

test("golden fixture: deposit $10,630 released with 5% pro fee", () => {
  const deposit = goldenDeposit();
  assert.equal(deposit.deposit, 10630);

  const escrow = releaseEscrow();
  const report = buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit,
    settlement: { proFeeBps: 500 },
  });

  // Manual accounting, computed independently of the module:
  const { proFee, net } = manualAccounting(10630, 500, 0);
  assert.equal(proFee, 531.5);
  assert.equal(net, 10098.5);

  assert.equal(report.outcome, "released");
  assert.equal(report.releasePath, "VERIFY_PASS → RELEASE");
  assert.equal(report.eventCount, 4);
  assert.ok(report.balanced);

  const byParty = Object.fromEntries(report.parties.map((p) => [p.party, p]));
  assert.deepEqual(
    { inflow: byParty.sponsor.inflow, outflow: byParty.sponsor.outflow, net: byParty.sponsor.net },
    { inflow: 0, outflow: 10630, net: -10630 },
  );
  assert.deepEqual(
    { inflow: byParty.creator.inflow, outflow: byParty.creator.outflow, net: byParty.creator.net },
    { inflow: net, outflow: 0, net },
  );
  assert.deepEqual(
    { inflow: byParty.platform.inflow, net: byParty.platform.net },
    { inflow: proFee, net: proFee },
  );
  assert.equal(byParty.referrer.inflow, 0);

  // Conservation of money: every cent out flowed in somewhere; all nets sum to zero.
  assert.equal(report.totalInflow, 10630);
  assert.equal(report.totalOutflow, 10630);
  assert.equal(
    report.parties.reduce((s, p) => Math.round((s + p.net) * 100) / 100, 0),
    0,
  );
});

test("referral credits are attributed to the referrer", () => {
  const escrow = releaseEscrow("esc-referral");
  const report = buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500, referralCredits: 200 },
  });
  const { proFee, net } = manualAccounting(10630, 500, 200);
  const byParty = Object.fromEntries(report.parties.map((p) => [p.party, p]));
  assert.equal(byParty.referrer.net, 200);
  assert.equal(byParty.creator.net, net);
  assert.equal(byParty.platform.net, proFee);
  assert.ok(report.balanced);
});

test("arbitration release records the arbitration path", () => {
  const e = new Escrow("esc-arb");
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_FAIL");
  e.dispatch("ARBITRATE_RELEASE");
  const report = buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500 },
  });
  assert.equal(report.outcome, "released");
  assert.equal(report.releasePath, "VERIFY_FAIL → ARBITRATE_RELEASE");
  assert.equal(report.eventCount, 4);
  assert.ok(report.balanced);
});

test("refund returns the full deposit to the sponsor", () => {
  const e = new Escrow("esc-refund");
  e.dispatch("FUND");
  e.dispatch("DISPUTE");
  e.dispatch("ARBITRATE_REFUND");
  const report = buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: goldenDeposit(),
  });
  assert.equal(report.outcome, "refunded");
  const sponsor = report.parties.find((p) => p.party === "sponsor")!;
  assert.equal(sponsor.inflow, 10630);
  assert.equal(sponsor.outflow, 10630);
  assert.equal(sponsor.net, 0);
  assert.ok(report.balanced);
});

test("expired returns the full deposit to the sponsor", () => {
  const e = new Escrow("esc-expired");
  e.dispatch("FUND");
  e.dispatch("EXPIRE");
  const report = buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: goldenDeposit(),
  });
  assert.equal(report.outcome, "expired");
  assert.ok(report.balanced);
});

test("non-terminal escrow throws: no settlement yet", () => {
  const e = new Escrow("esc-open");
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  assert.throws(
    () =>
      buildSettlementReport({
        escrowId: e.id,
        history: e.history,
        finalState: e.state,
        deposit: goldenDeposit(),
      }),
    /no settlement has happened yet/,
  );
});

test("released escrow requires settlement parameters", () => {
  const escrow = releaseEscrow("esc-noparam");
  assert.throws(
    () =>
      buildSettlementReport({
        escrowId: escrow.id,
        history: escrow.history,
        finalState: escrow.state,
        deposit: goldenDeposit(),
      }),
    /settlement parameters/,
  );
});

test("released escrow with empty history throws", () => {
  assert.throws(
    () =>
      buildSettlementReport({
        escrowId: "esc-ghost",
        history: [],
        finalState: "RELEASED",
        deposit: goldenDeposit(),
        settlement: { proFeeBps: 500 },
      }),
    /empty audit history/,
  );
});

test("renderReport prints the human-readable ledger", () => {
  const escrow = releaseEscrow();
  const report = buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500 },
  });
  const text = renderReport(report);
  assert.match(text, /esc-10630/);
  assert.match(text, /released/);
  assert.match(text, /10,630\.00/);
  assert.match(text, /10,098\.50/);
  assert.match(text, /531\.50/);
  assert.match(text, /balanced ✓/);
  assert.match(text, /Audit: 4 events/);
});

test("depositAmountFromHistory reads the FUND amount from the audit trail", () => {
  const e = new Escrow("esc-fundamt");
  e.dispatch("FUND", "deposit locked", 10630);
  assert.equal(depositAmountFromHistory(e.history, e.id), 10630);
});

test("depositAmountFromHistory throws when the FUND entry has no amount", () => {
  const e = new Escrow("esc-noamt");
  e.dispatch("FUND");
  assert.throws(
    () => depositAmountFromHistory(e.history, e.id),
    /settlement requires a FUND amount/,
  );
});

test("depositAmountFromHistory throws when there is no FUND event at all", () => {
  assert.throws(
    () => depositAmountFromHistory([], "esc-ghost"),
    /settlement requires a FUND amount/,
  );
});

test("buildSettlementReport rejects a deposit that disagrees with the recorded FUND amount", () => {
  const e = new Escrow("esc-mismatch");
  e.dispatch("FUND", undefined, 5000);
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  assert.throws(
    () =>
      buildSettlementReport({
        escrowId: e.id,
        history: e.history,
        finalState: e.state,
        deposit: goldenDeposit(), // 10630 !== recorded FUND amount 5000
        settlement: { proFeeBps: 500 },
      }),
    /does not match the FUND amount/,
  );
});

test("buildSettlementReport accepts a deposit that matches the recorded FUND amount", () => {
  const e = new Escrow("esc-match");
  e.dispatch("FUND", undefined, 10630);
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  const report = buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500 },
  });
  assert.ok(report.balanced);
  assert.equal(report.totalInflow, 10630);
  assert.equal(report.totalOutflow, 10630);
});
