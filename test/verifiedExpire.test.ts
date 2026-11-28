/**
 * VERIFIED overdue escrows can EXPIRE (backlog #1422).
 *
 * Product decision, pinned here: a verified-but-unreleased escrow that
 * passes its deadline expires back to the sponsor — the milestone was
 * verified, but nobody released it and the campaign window has closed,
 * so the still-locked balance is refunded and the escrow reaches a
 * terminal state instead of locking funds forever. Before this change
 * `VERIFIED` had no `EXPIRE` edge, so `expireOverdueEscrows` reported
 * `{ expired: false, error: "invalid transition: EXPIRE from VERIFIED" }`
 * on every watchdog run and the escrow never moved.
 *
 * The deliberate asymmetry is pinned too: `DISPUTED` keeps NO edge —
 * expiry must never let one side unilaterally walk out of an open
 * arbitration, so a disputed escrow still fails per-escrow and the
 * batch continues past it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  allowedEvents,
  buildSettlementReport,
  calculateDeposit,
  expireOverdueEscrows,
  stateDiagram,
  transition,
  transitionTable,
  verifyHistoryChain,
} from "../src/index.js";

const PAST = new Date("2026-01-15T00:00:00.000Z");
const FUTURE = new Date("2027-01-01T00:00:00.000Z");
const NOW = new Date("2026-06-01T00:00:00.000Z");
const FUND_AT = new Date("2026-01-01T00:00:00.000Z");
const SUBMIT_AT = new Date("2026-02-01T00:00:00.000Z");
const VERIFY_AT = new Date("2026-03-01T00:00:00.000Z");

/** Portfolio golden vector: pool 10000 / base 600 x 1.0 / loyalty -30 / oracle +60. */
function goldenDeposit() {
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

function verifiedWithDeadline(id: string, deadline: Date): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 10630, { at: FUND_AT });
  escrow.dispatch("SUBMIT_MILESTONE", "milestone done", undefined, {
    at: SUBMIT_AT,
  });
  escrow.dispatch("VERIFY_PASS", undefined, undefined, { at: VERIFY_AT });
  escrow.setDeadline(deadline);
  return escrow;
}

function disputedWithDeadline(id: string, deadline: Date): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 10630, { at: FUND_AT });
  escrow.dispatch("DISPUTE", "buyer unhappy", undefined, { at: SUBMIT_AT });
  escrow.setDeadline(deadline);
  return escrow;
}

function fundedWithDeadline(id: string, deadline: Date): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 10630, { at: FUND_AT });
  escrow.setDeadline(deadline);
  return escrow;
}

describe("VERIFIED overdue escrows expire (backlog #1422)", () => {
  it("transition: VERIFIED accepts EXPIRE to EXPIRED, and allowedEvents lists it", () => {
    assert.equal(transition("VERIFIED", "EXPIRE"), "EXPIRED");
    assert.deepEqual(allowedEvents("VERIFIED"), [
      "RELEASE",
      "DISPUTE",
      "EXPIRE",
    ]);
  });

  it("an overdue VERIFIED escrow expires through the executor, with a pinned EXPIRE audit entry", () => {
    const verified = verifiedWithDeadline("verified", PAST);
    const [result] = expireOverdueEscrows([verified], NOW);
    assert.equal(result.expired, true);
    assert.equal(result.error, undefined);
    assert.equal(verified.state, "EXPIRED");
    const last = verified.history[verified.history.length - 1];
    assert.equal(last.event, "EXPIRE");
    assert.equal(last.from, "VERIFIED");
    assert.equal(last.to, "EXPIRED");
    assert.equal(last.at, NOW.toISOString());
    assert.equal(result.entry?.seq, last.seq);
    assert.ok(verifyHistoryChain(verified.history));
  });

  it("a not-overdue VERIFIED escrow is never attempted", () => {
    const verified = verifiedWithDeadline("not-overdue", FUTURE);
    assert.deepEqual(expireOverdueEscrows([verified], NOW), []);
    assert.equal(verified.state, "VERIFIED");
    assert.equal(verified.history.length, 3);
  });

  it("an overdue DISPUTED escrow is classified unexpirable (not failed) and the batch continues (backlog #1434)", () => {
    const disputed = disputedWithDeadline("disputed", PAST);
    const after = fundedWithDeadline("after", PAST);
    const results = expireOverdueEscrows([disputed, after], NOW);
    assert.equal(results.length, 2);
    assert.equal(results[0].expired, false);
    assert.equal(results[0].unexpirable, true);
    assert.equal("error" in results[0], false);
    assert.equal(disputed.state, "DISPUTED");
    assert.equal(disputed.history.length, 2);
    assert.equal(results[1].expired, true);
    assert.equal(after.state, "EXPIRED");
  });

  it("the EXPIRED report after a VERIFIED expiry refunds the full locked balance", () => {
    const verified = verifiedWithDeadline("verified-report", PAST);
    expireOverdueEscrows([verified], NOW);
    const report = buildSettlementReport({
      escrowId: verified.id,
      history: verified.history,
      finalState: verified.state,
      deposit: goldenDeposit(),
      settlement: { proFeeBps: 500 },
    });
    assert.equal(report.outcome, "expired");
    assert.ok(report.balanced);
    assert.equal(report.totalInflow, 10630);
    assert.equal(report.totalOutflow, 10630);
    const byParty = Object.fromEntries(
      report.parties.map((p) => [p.party, p]),
    );
    assert.deepEqual(
      {
        inflow: byParty.sponsor.inflow,
        outflow: byParty.sponsor.outflow,
        net: byParty.sponsor.net,
      },
      { inflow: 10630, outflow: 10630, net: 0 },
    );
    assert.equal(byParty.creator.inflow, 0);
    assert.equal(byParty.platform.inflow, 0);
    assert.equal(byParty.referrer.inflow, 0);
  });

  it("the EXPIRED report after a partial release refunds only the still-locked remainder", () => {
    const escrow = new Escrow("verified-partial");
    escrow.dispatch("FUND", "initial deposit", 10630, { at: FUND_AT });
    escrow.dispatch("SUBMIT_MILESTONE", "milestone done", undefined, {
      at: SUBMIT_AT,
    });
    escrow.dispatch("PARTIAL_RELEASE", "first tranche", 4252, {
      at: new Date("2026-02-15T00:00:00.000Z"),
    });
    escrow.dispatch("SUBMIT_MILESTONE", "milestone done", undefined, {
      at: new Date("2026-02-20T00:00:00.000Z"),
    });
    escrow.dispatch("VERIFY_PASS", undefined, undefined, { at: VERIFY_AT });
    escrow.setDeadline(PAST);
    const [result] = expireOverdueEscrows([escrow], NOW);
    assert.equal(result.expired, true);
    assert.equal(escrow.state, "EXPIRED");
    const report = buildSettlementReport({
      escrowId: escrow.id,
      history: escrow.history,
      finalState: escrow.state,
      deposit: goldenDeposit(),
      settlement: { proFeeBps: 500 },
    });
    assert.equal(report.outcome, "expired");
    assert.ok(report.balanced);
    const byParty = Object.fromEntries(
      report.parties.map((p) => [p.party, p]),
    );
    // 10630 locked, 4252 already paid out: only 6378 returns.
    assert.deepEqual(
      {
        inflow: byParty.sponsor.inflow,
        outflow: byParty.sponsor.outflow,
        net: byParty.sponsor.net,
      },
      { inflow: 6378, outflow: 10630, net: -4252 },
    );
    assert.equal(byParty.creator.inflow, 4252);
    assert.equal(report.totalInflow, 10630);
    assert.equal(report.totalOutflow, 10630);
  });

  it("the transition table and diagram carry the new edge", () => {
    const edges = transitionTable();
    assert.equal(edges.length, 18);
    assert.deepEqual(
      edges.find((e) => e.from === "VERIFIED" && e.event === "EXPIRE"),
      { from: "VERIFIED", event: "EXPIRE", to: "EXPIRED" },
    );
    assert.deepEqual(
      edges.find((e) => e.from === "DISPUTED" && e.event === "ARBITRATE_SPLIT"),
      { from: "DISPUTED", event: "ARBITRATE_SPLIT", to: "RELEASED" },
    );
    assert.ok(stateDiagram().includes("    VERIFIED --> EXPIRED : EXPIRE"));
    assert.ok(
      stateDiagram().includes("    DISPUTED --> RELEASED : ARBITRATE_SPLIT"),
    );
  });

  it("a dry run predicts a VERIFIED expiry and changes nothing", () => {
    const verified = verifiedWithDeadline("verified-dry", PAST);
    const [result] = expireOverdueEscrows([verified], NOW, { dryRun: true });
    assert.equal(result.wouldExpire, true);
    assert.equal(result.expired, false);
    assert.equal(result.error, undefined);
    assert.equal("entry" in result, false);
    assert.equal(verified.state, "VERIFIED");
    assert.equal(verified.history.length, 3);
  });
});
