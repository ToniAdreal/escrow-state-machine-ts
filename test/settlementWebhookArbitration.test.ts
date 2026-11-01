import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementWebhook,
  calculateDeposit,
  createQuorum,
  dispatchArbitration,
  verifySettlementWebhook,
} from "../src/index.js";
import type { SettlementReportInputs } from "../src/index.js";

/**
 * Arbitration result x settlement webhook (backlog #799).
 *
 * Arbitration and settlement webhooks were each covered on their own,
 * but no test pinned them together through the quorum gate: a DISPUTED
 * escrow released by a reached quorum must produce a `released`
 * webhook carrying the arbitration path and the report's split, and a
 * DISPUTED escrow refunded by a reached quorum must produce a
 * `refunded` webhook with no release path and the full deposit back
 * to the sponsor. A below-quorum arbitration must produce no
 * settlement at all, because the escrow never leaves DISPUTED.
 *
 * Rules under test:
 *  - quorum release (5/9) → report outcome `released`, releasePath
 *    `DISPUTE → ARBITRATE_RELEASE`, webhook with the same outcome
 *    and path, 5% pro-fee split of the 10630 deposit (creator
 *    10098.50, platform 531.50), and a signature that verifies
 *  - quorum refund (5/9) → report outcome `refunded`, webhook with
 *    the same outcome and no `releasePath` key at all, sponsor
 *    refunded in full (inflow == outflow == 10630, net 0, every
 *    other party zero), and a signature that verifies
 *  - below quorum (4/9) → arbitration throws, state and history are
 *    untouched, and no settlement report (hence no webhook) can be
 *    built from the still-DISPUTED escrow
 */

const SECRET = "whsec_test_arbitration_settlement_webhook_20261101";
const STRANGER_SECRET = "whsec_test_arbitration_settlement_webhook_stranger_20261101";
const FIXED_NOW = "2026-11-01T21:00:00.000Z";

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

/** Escrow sitting in DISPUTED: CREATED → FUNDED → DISPUTED. */
function disputedEscrow(id: string): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", deposit().deposit);
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

function partyMap(payload: { parties: Array<{ party: string; inflow: number; outflow: number; net: number }> }) {
  return new Map(payload.parties.map((p) => [p.party, p]));
}

test("quorum release flows into a released webhook with the arbitration path and split", () => {
  const escrow = disputedEscrow("arb-webhook-release");
  const state = dispatchArbitration(escrow, quorumWith(5), "release");
  assert.equal(state, "RELEASED");
  assert.equal(escrow.state, "RELEASED");
  const last = escrow.history[escrow.history.length - 1];
  assert.equal(last.event, "ARBITRATE_RELEASE");
  assert.equal(last.from, "DISPUTED");
  assert.equal(last.to, "RELEASED");

  const report = buildSettlementReport(inputsFor(escrow));
  assert.equal(report.outcome, "released");
  assert.equal(report.releasePath, "DISPUTE → ARBITRATE_RELEASE");
  assert.equal(report.deposit.deposit, 10630);
  assert.equal(report.balanced, true);

  const webhook = buildSettlementWebhook(report, {
    secret: SECRET,
    now: FIXED_NOW,
    eventId: "evt-arb-release-1",
  });
  assert.equal(webhook.payload.event, "escrow.settled");
  assert.equal(webhook.payload.eventId, "evt-arb-release-1");
  assert.equal(webhook.payload.escrowId, "arb-webhook-release");
  assert.equal(webhook.payload.outcome, "released");
  assert.equal(webhook.payload.releasePath, "DISPUTE → ARBITRATE_RELEASE");
  assert.equal(webhook.payload.releasePath, report.releasePath);
  assert.equal(webhook.payload.deposit, 10630);
  assert.equal(webhook.payload.at, FIXED_NOW);

  const byParty = partyMap(webhook.payload);
  assert.deepEqual(
    { inflow: byParty.get("sponsor")!.inflow, outflow: byParty.get("sponsor")!.outflow, net: byParty.get("sponsor")!.net },
    { inflow: 0, outflow: 10630, net: -10630 },
  );
  assert.deepEqual(
    { inflow: byParty.get("creator")!.inflow, outflow: byParty.get("creator")!.outflow, net: byParty.get("creator")!.net },
    { inflow: 10098.5, outflow: 0, net: 10098.5 },
  );
  assert.deepEqual(
    { inflow: byParty.get("platform")!.inflow, outflow: byParty.get("platform")!.outflow, net: byParty.get("platform")!.net },
    { inflow: 531.5, outflow: 0, net: 531.5 },
  );
  assert.deepEqual(
    { inflow: byParty.get("referrer")!.inflow, outflow: byParty.get("referrer")!.outflow, net: byParty.get("referrer")!.net },
    { inflow: 0, outflow: 0, net: 0 },
  );

  assert.match(webhook.signature, /^sha256=[0-9a-f]{64}$/);
  assert.equal(
    verifySettlementWebhook(webhook.payload, webhook.signature, SECRET),
    true,
  );
  assert.equal(
    verifySettlementWebhook(JSON.stringify(webhook.payload), webhook.signature, SECRET),
    true,
  );
  assert.equal(
    verifySettlementWebhook(webhook.payload, webhook.signature, STRANGER_SECRET),
    false,
  );
});

test("quorum refund flows into a refunded webhook with no releasePath and a full sponsor refund", () => {
  const escrow = disputedEscrow("arb-webhook-refund");
  const state = dispatchArbitration(escrow, quorumWith(5), "refund");
  assert.equal(state, "REFUNDED");
  assert.equal(escrow.state, "REFUNDED");
  const last = escrow.history[escrow.history.length - 1];
  assert.equal(last.event, "ARBITRATE_REFUND");
  assert.equal(last.from, "DISPUTED");
  assert.equal(last.to, "REFUNDED");

  const report = buildSettlementReport(inputsFor(escrow));
  assert.equal(report.outcome, "refunded");
  assert.equal(report.releasePath, undefined);
  assert.equal(report.deposit.deposit, 10630);
  assert.equal(report.balanced, true);

  const webhook = buildSettlementWebhook(report, {
    secret: SECRET,
    now: FIXED_NOW,
    eventId: "evt-arb-refund-1",
  });
  assert.equal(webhook.payload.event, "escrow.settled");
  assert.equal(webhook.payload.eventId, "evt-arb-refund-1");
  assert.equal(webhook.payload.escrowId, "arb-webhook-refund");
  assert.equal(webhook.payload.outcome, "refunded");
  assert.equal(webhook.payload.deposit, 10630);
  assert.equal(webhook.payload.at, FIXED_NOW);
  // Refunded payloads omit releasePath entirely (never `undefined`).
  assert.equal("releasePath" in webhook.payload, false);
  assert.equal(JSON.stringify(webhook.payload).includes("releasePath"), false);

  const byParty = partyMap(webhook.payload);
  const sponsor = byParty.get("sponsor")!;
  assert.deepEqual(
    { inflow: sponsor.inflow, outflow: sponsor.outflow, net: sponsor.net },
    { inflow: 10630, outflow: 10630, net: 0 },
  );
  for (const party of ["creator", "platform", "referrer"] as const) {
    const row = byParty.get(party)!;
    assert.deepEqual(
      { inflow: row.inflow, outflow: row.outflow, net: row.net },
      { inflow: 0, outflow: 0, net: 0 },
    );
  }

  assert.match(webhook.signature, /^sha256=[0-9a-f]{64}$/);
  assert.equal(
    verifySettlementWebhook(webhook.payload, webhook.signature, SECRET),
    true,
  );
  assert.equal(
    verifySettlementWebhook(webhook.payload, webhook.signature, STRANGER_SECRET),
    false,
  );
});

test("below-quorum arbitration produces no settlement and no webhook", () => {
  const escrow = disputedEscrow("arb-webhook-no-quorum");
  const historyBefore = escrow.history.length;

  assert.throws(
    () => dispatchArbitration(escrow, quorumWith(4), "release"),
    /arbitration requires quorum: 4\/5 approvals/,
  );
  assert.equal(escrow.state, "DISPUTED");
  assert.equal(escrow.history.length, historyBefore);
  assert.equal(escrow.history[escrow.history.length - 1].event, "DISPUTE");

  // A still-DISPUTED escrow has no settlement: the report builder
  // refuses, so there is nothing a webhook could be built from.
  assert.throws(
    () => buildSettlementReport(inputsFor(escrow)),
    /no settlement has happened yet/,
  );
});
