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
 * Quorum approval expiry x settlement webhook (backlog #810).
 *
 * The gap this closes: `quorumExpiry` tests pin that an expired quorum
 * refuses arbitration, and #799 pins that a *valid* quorum's arbitration
 * flows into a settlement webhook — but nothing pinned the expired
 * side of that combination. An arbitration refused for expired
 * approvals must leave the escrow in DISPUTED with no settlement
 * report at all (never a report built under the stale, pre-expiry
 * quorum), so there is nothing a webhook could be built from. And
 * once the signers re-approve inside the window, the same escrow must
 * arbitrate cleanly and produce a report and a verifiable webhook —
 * the expiry is a delay, not a poisoning of the escrow.
 *
 * Rules under test:
 *  - 5/9 approvals aged past `maxApprovalAgeMs` → arbitration throws
 *    `arbitration requires quorum: 0/5 approvals`, state and history
 *    untouched, and `buildSettlementReport` refuses the still-DISPUTED
 *    escrow (`no settlement has happened yet`), so no webhook exists
 *  - re-approval after expiry (fresh approvals, back inside the
 *    window) → the same escrow arbitrates to RELEASED, the report
 *    carries outcome `released` and path
 *    `DISPUTE → ARBITRATE_RELEASE` with the 5% pro-fee split of the
 *    10630 deposit (creator 10098.50, platform 531.50), and the
 *    webhook built from it verifies with the right secret only
 */

const SECRET = "whsec_test_quorum_expiry_settlement_webhook_20261102";
const STRANGER_SECRET = "whsec_test_quorum_expiry_settlement_webhook_stranger_20261102";
const FIXED_NOW = "2026-11-02T11:00:00.000Z";

const SIGNERS = [
  "dao-1", "dao-2", "dao-3", "dao-4", "dao-5",
  "dao-6", "dao-7", "dao-8", "dao-9",
];
const WINDOW = 60_000;

function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

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

/** 5/9 quorum with an expiry window on the injected clock. */
function expiringQuorum(clock: { now: () => number }) {
  return createQuorum({
    threshold: 5,
    signers: SIGNERS,
    now: clock.now,
    maxApprovalAgeMs: WINDOW,
  });
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

test("expired quorum arbitration leaves no settlement and no webhook to build", () => {
  const clock = fakeClock();
  const escrow = disputedEscrow("quorum-expiry-no-webhook");
  const quorum = expiringQuorum(clock);
  for (let i = 0; i < 5; i++) quorum.approve(SIGNERS[i]);
  assert.equal(quorum.hasQuorum(), true);

  clock.advance(WINDOW + 1); // every approval is now WINDOW + 1 old
  assert.equal(quorum.hasQuorum(), false);
  assert.equal(quorum.approvalCount(), 0);

  const historyBefore = escrow.history.length;
  assert.throws(
    () => dispatchArbitration(escrow, quorum, "release"),
    /arbitration requires quorum: 0\/5 approvals/,
  );
  assert.equal(escrow.state, "DISPUTED");
  assert.equal(escrow.history.length, historyBefore);
  assert.equal(escrow.history[escrow.history.length - 1].event, "DISPUTE");

  // The escrow never left DISPUTED, so there is no settlement report —
  // and therefore nothing a settlement webhook could be built from.
  // This is the stale-quorum guard: expiry must not silently yield a
  // report under the pre-expiry quorum.
  assert.throws(
    () => buildSettlementReport(inputsFor(escrow)),
    /no settlement has happened yet/,
  );
});

test("re-approval inside the window restores clean arbitration, report, and verifiable webhook", () => {
  const clock = fakeClock();
  const escrow = disputedEscrow("quorum-expiry-recovered");
  const quorum = expiringQuorum(clock);
  for (let i = 0; i < 5; i++) quorum.approve(SIGNERS[i]);
  clock.advance(WINDOW + 1);
  assert.throws(
    () => dispatchArbitration(escrow, quorum, "release"),
    /arbitration requires quorum: 0\/5 approvals/,
  );
  assert.equal(escrow.state, "DISPUTED");

  // Re-approval timestamps fresh approvals inside the window — no
  // clock rewind is needed, because expiry is per-approval age.
  for (let i = 0; i < 5; i++) quorum.approve(SIGNERS[i]);
  assert.equal(quorum.hasQuorum(), true);

  const state = dispatchArbitration(escrow, quorum, "release");
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
  assert.equal(report.deposit.deposit, 10630);
  assert.equal(report.balanced, true);

  const webhook = buildSettlementWebhook(report, {
    secret: SECRET,
    now: FIXED_NOW,
    eventId: "evt-quorum-expiry-recovered-1",
  });
  assert.equal(webhook.payload.event, "escrow.settled");
  assert.equal(webhook.payload.eventId, "evt-quorum-expiry-recovered-1");
  assert.equal(webhook.payload.escrowId, "quorum-expiry-recovered");
  assert.equal(webhook.payload.outcome, "released");
  assert.equal(webhook.payload.releasePath, "DISPUTE → ARBITRATE_RELEASE");
  assert.equal(webhook.payload.releasePath, report.releasePath);
  assert.equal(webhook.payload.deposit, 10630);
  assert.equal(webhook.payload.at, FIXED_NOW);

  const byParty = partyMap(webhook.payload);
  assert.deepEqual(
    { inflow: byParty.get("creator")!.inflow, outflow: byParty.get("creator")!.outflow, net: byParty.get("creator")!.net },
    { inflow: 10098.5, outflow: 0, net: 10098.5 },
  );
  assert.deepEqual(
    { inflow: byParty.get("platform")!.inflow, outflow: byParty.get("platform")!.outflow, net: byParty.get("platform")!.net },
    { inflow: 531.5, outflow: 0, net: 531.5 },
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
