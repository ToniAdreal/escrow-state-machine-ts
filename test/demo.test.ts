import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  runDemo,
  DEMO_ARBITRATION_AT,
  DEMO_DEDUPE_TTL_MS,
  DEMO_BATCH_WEBHOOK_AT,
  DEMO_BATCH_WEBHOOK_EVENT_IDS,
  DEMO_DEADLINE_STALE_DEADLINE,
  DEMO_DEADLINE_STALE_ESCROW_ID,
  DEMO_DEADLINE_STALE_FUND_AT,
  DEMO_DISPUTE_ESCROW_ID,
  DEMO_ESCROW_ID,
  DEMO_EXPIRABLE_DEADLINE,
  DEMO_EXPIRABLE_ESCROW_ID,
  DEMO_EXPIRABLE_FUND_AT,
  DEMO_FRESH_ESCROW_ID,
  DEMO_FRESH_FUND_AT,
  DEMO_OVERDUE_ONLY_DEADLINE,
  DEMO_OVERDUE_ONLY_ESCROW_ID,
  DEMO_OVERDUE_ONLY_SUBMIT_AT,
  DEMO_PENDING_ESCROW_ID,
  DEMO_QUORUM_APPROVAL_ATS,
  DEMO_QUORUM_SIGNERS,
  DEMO_QUORUM_THRESHOLD,
  DEMO_STALE_DAY_MS,
  DEMO_STALE_DEADLINE,
  DEMO_STALE_ESCROW_ID,
  DEMO_STALE_FUND_AT,
  DEMO_STALE_MAX_AGE_MS,
  DEMO_STALE_NOW,
  DEMO_UNEXPIRABLE_DEADLINE,
  DEMO_UNEXPIRABLE_ESCROW_ID,
  DEMO_UNEXPIRABLE_VERIFY_AT,
  DEMO_WEBHOOK_AT,
  DEMO_WEBHOOK_EVENT_ID,
  DEMO_WEBHOOK_SECRET,
} from "../src/demo.js";
import {
  allowedEvents,
  restoreQuorum,
  transitionTable,
  verifyHistoryChain,
  verifySettlementWebhook,
} from "../src/index.js";

const repoRoot = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
); // dist/test/*.test.js -> repo root

test("demo runs the full CREATED -> RELEASED chain in-process without throwing", () => {
  const { escrow, report } = runDemo();

  assert.equal(escrow.id, DEMO_ESCROW_ID);
  assert.equal(escrow.state, "RELEASED");
  assert.equal(escrow.isTerminal, true);
  // FUND -> SUBMIT_MILESTONE -> VERIFY_PASS -> RELEASE (4 dispatches)
  assert.equal(escrow.history.length, 4);
  assert.deepEqual(
    escrow.history.map((h) => [h.event, h.from, h.to]),
    [
      ["FUND", "CREATED", "FUNDED"],
      ["SUBMIT_MILESTONE", "FUNDED", "MILESTONE_SUBMITTED"],
      ["VERIFY_PASS", "MILESTONE_SUBMITTED", "VERIFIED"],
      ["RELEASE", "VERIFIED", "RELEASED"],
    ],
  );
  assert.equal(report.outcome, "released");
});

test("demo settlement numbers are self-consistent with the golden deposit", () => {
  const { report } = runDemo();

  // Golden vector: deposit 10,630; 5% pro fee -> platform 531.50,
  // creator 10,098.50, referrer 0, sponsor -10,630.
  assert.equal(report.deposit.deposit, 10630);
  assert.ok(report.balanced);
  assert.equal(report.totalInflow, 10630);
  assert.equal(report.totalOutflow, 10630);
  // Conservation: deposit in = money out, so every party's net sums to 0.
  const netSum = report.parties.reduce((sum, p) => sum + p.net, 0);
  assert.equal(Math.round(netSum * 100) / 100, 0);
  const byParty = Object.fromEntries(report.parties.map((p) => [p.party, p.net]));
  assert.deepEqual(byParty, {
    sponsor: -10630,
    creator: 10098.5,
    platform: 531.5,
    referrer: 0,
  });
});

test("demo verifies the main history's hash chain and detects a tampered FUND amount on a detached copy", () => {
  const { escrow, historyChainVerified, tamperedChainVerified, tamperedFundAmount } =
    runDemo();

  // The intact chain passes, both as reported by the demo and on an
  // independent re-verification of the escrow's own history.
  assert.equal(historyChainVerified, true);
  assert.equal(verifyHistoryChain(escrow.history), true);
  // The tampered copy is the golden FUND amount altered by exactly 1,
  // and its stored hash no longer recomputes — verdict false.
  assert.equal(tamperedFundAmount, 10631);
  assert.equal(tamperedChainVerified, false);
  // Independent cross-check: rebuilding the tamper by hand from the
  // demo's history yields the same false verdict, while the escrow's
  // own FUND amount is untouched at the golden 10630.
  const handTampered = escrow.history.map((entry) => ({ ...entry }));
  const fund = handTampered.find((entry) => entry.event === "FUND");
  assert.ok(fund !== undefined && fund.amount !== undefined);
  fund.amount += 1;
  assert.equal(fund.amount, tamperedFundAmount);
  assert.equal(verifyHistoryChain(handTampered), false);
  assert.equal(
    escrow.history.find((entry) => entry.event === "FUND")?.amount,
    10630,
  );
});

test("demo lines print the audit hash chain section between the settlement report and the webhook", () => {
  const { lines } = runDemo();
  const text = lines.join("\n");

  assert.match(text, /Audit hash chain \(verifyHistoryChain on the main escrow history\):/);
  assert.ok(
    text.includes(
      "  intact history: verifyHistoryChain: true (4 entries, genesis-linked, every hash recomputes)",
    ),
  );
  assert.ok(
    text.includes(
      "  tampered copy: FUND amount 10630 -> 10631 — verifyHistoryChain: false (tamper detected: the stored hash no longer recomputes)",
    ),
  );
  assert.ok(
    text.includes(
      "  original history after the tamper check: verifyHistoryChain: true (detached copy — the escrow's own history is untouched)",
    ),
  );
  // Position: the chain verdicts describe the history whose settlement
  // report was just printed, and precede the webhook built from it.
  const reportAt = text.indexOf("Settlement report:");
  const chainAt = text.indexOf("Audit hash chain (verifyHistoryChain");
  const webhookAt = text.indexOf("Settlement webhook (signed");
  assert.ok(reportAt < chainAt && chainAt < webhookAt);
});

test("demo builds a settlement webhook from the report and self-verifies it", () => {
  const { webhook, webhookVerified } = runDemo();

  // Payload field set / values mirror the webhooks test fixture shape:
  // fixed eventId + fixed `at`, released outcome with its release path.
  assert.deepEqual(Object.keys(webhook.payload), [
    "event",
    "eventId",
    "escrowId",
    "outcome",
    "releasePath",
    "deposit",
    "parties",
    "at",
  ]);
  assert.equal(webhook.payload.event, "escrow.settled");
  assert.equal(webhook.payload.eventId, DEMO_WEBHOOK_EVENT_ID);
  assert.equal(webhook.payload.escrowId, DEMO_ESCROW_ID);
  assert.equal(webhook.payload.outcome, "released");
  assert.equal(webhook.payload.releasePath, "VERIFY_PASS → RELEASE");
  assert.equal(webhook.payload.deposit, 10630);
  assert.equal(webhook.payload.at, DEMO_WEBHOOK_AT);
  assert.deepEqual(
    webhook.payload.parties.map((p) => [p.party, p.net]),
    [
      ["sponsor", -10630],
      ["creator", 10098.5],
      ["platform", 531.5],
      ["referrer", 0],
    ],
  );
  assert.match(webhook.signature, /^sha256=[0-9a-f]{64}$/);
  // The demo's own receiver-side check passes, and an independent
  // re-verification over the raw body bytes agrees.
  assert.equal(webhookVerified, true);
  assert.ok(
    verifySettlementWebhook(
      JSON.stringify(webhook.payload),
      webhook.signature,
      DEMO_WEBHOOK_SECRET,
    ),
  );
  // Tampering with a signed field (deposit) breaks verification.
  const tampered = { ...webhook.payload, deposit: 1 };
  assert.equal(
    verifySettlementWebhook(
      JSON.stringify(tampered),
      webhook.signature,
      DEMO_WEBHOOK_SECRET,
    ),
    false,
  );
});

test("demo lines print the webhook build + verify section", () => {
  const { lines } = runDemo();
  const text = lines.join("\n");

  assert.match(
    text,
    /Settlement webhook \(signed escrow\.settled notification\):/,
  );
  assert.ok(text.includes(`  eventId:      ${DEMO_WEBHOOK_EVENT_ID}`));
  assert.ok(text.includes("  outcome:      released"));
  assert.ok(text.includes("  releasePath:  VERIFY_PASS → RELEASE"));
  assert.ok(text.includes("  deposit:      10630"));
  assert.ok(text.includes(`  at:           ${DEMO_WEBHOOK_AT}`));
  assert.match(text, / {2}signature: {4}sha256=[0-9a-f]{64}/);
  assert.ok(text.includes("  verifySettlementWebhook: ok"));
});

test("demo receiver dedupe counts the main webhook eventId new, duplicate, then new after the TTL", () => {
  const { webhookDedupe } = runDemo();

  // Three deliveries of evt_demo_settlement_001 on the fixed clock:
  // first sighting is a miss (book it), the immediate redelivery is
  // the one hit (skip it), and after the clock advances by exactly
  // the TTL the expired id is a miss again and re-recorded — so the
  // store ends with one live entry, hits 1, misses 2, no evictions.
  assert.deepEqual(webhookDedupe.stats(), {
    size: 1,
    hits: 1,
    misses: 2,
    evictions: 0,
  });
  assert.equal(DEMO_DEDUPE_TTL_MS, 3_600_000);
});

test("demo lines print the receiver dedupe section", () => {
  const { lines } = runDemo();
  const text = lines.join("\n");

  assert.match(
    text,
    /Receiver dedupe \(SettlementEventDedupe on the webhook eventId\):/,
  );
  assert.ok(
    text.includes(
      `  delivery 1: eventId ${DEMO_WEBHOOK_EVENT_ID} — checkAndRecord: false (new event, book the settlement)`,
    ),
  );
  assert.ok(
    text.includes(
      `  delivery 2: eventId ${DEMO_WEBHOOK_EVENT_ID} — checkAndRecord: true (duplicate, skip — no second booking)`,
    ),
  );
  assert.ok(
    text.includes(
      `  delivery 3 (fixed clock +${DEMO_DEDUPE_TTL_MS} ms = TTL): eventId ${DEMO_WEBHOOK_EVENT_ID} — checkAndRecord: false (new event again, TTL expired)`,
    ),
  );
  assert.ok(text.includes("  dedupe stats: size 1, hits 1, misses 2, evictions 0"));
  // The dedupe section sits between the webhook section and the
  // dispute branch — it is the receiver half of the webhook story.
  const webhookAt = text.indexOf("Settlement webhook (signed");
  const dedupeAt = text.indexOf("Receiver dedupe (SettlementEventDedupe");
  const disputeAt = text.indexOf("Dispute branch (DISPUTE");
  assert.ok(webhookAt < dedupeAt && dedupeAt < disputeAt);
});

test("demo dispute branch reaches DISPUTED, is refused below quorum, then refunds at quorum", () => {
  const { disputeEscrow, disputeQuorum, arbitrationRejection } = runDemo();

  assert.equal(disputeEscrow.id, DEMO_DISPUTE_ESCROW_ID);
  assert.equal(disputeEscrow.state, "REFUNDED");
  assert.equal(disputeEscrow.isTerminal, true);
  // FUND -> SUBMIT_MILESTONE -> VERIFY_FAIL -> ARBITRATE_REFUND: exactly
  // 4 entries — the refused below-threshold attempt left no trace.
  assert.equal(disputeEscrow.history.length, 4);
  assert.deepEqual(
    disputeEscrow.history.map((h) => [h.event, h.from, h.to]),
    [
      ["FUND", "CREATED", "FUNDED"],
      ["SUBMIT_MILESTONE", "FUNDED", "MILESTONE_SUBMITTED"],
      ["VERIFY_FAIL", "MILESTONE_SUBMITTED", "DISPUTED"],
      ["ARBITRATE_REFUND", "DISPUTED", "REFUNDED"],
    ],
  );
  assert.equal(
    arbitrationRejection,
    `arbitration requires quorum: 1/${DEMO_QUORUM_THRESHOLD} approvals`,
  );
  // The arbitration entry carries the forwarded fixed actor + timestamp
  // and the auto-recorded quorum tally.
  const last = disputeEscrow.history[disputeEscrow.history.length - 1];
  assert.equal(last.actor, DEMO_QUORUM_SIGNERS[1]);
  assert.equal(last.at, DEMO_ARBITRATION_AT);
  assert.equal(
    last.note,
    `Dispute upheld — refund the sponsor [quorum ${DEMO_QUORUM_THRESHOLD}/${DEMO_QUORUM_THRESHOLD}]`,
  );
  // Quorum: 2-of-3 reached, approval log on the fixed injected clock.
  assert.equal(disputeQuorum.threshold, DEMO_QUORUM_THRESHOLD);
  assert.equal(disputeQuorum.signerCount, DEMO_QUORUM_SIGNERS.length);
  assert.equal(disputeQuorum.approvalCount(), 2);
  assert.equal(disputeQuorum.hasQuorum(), true);
  assert.deepEqual(disputeQuorum.approvalLog(), [
    { signerId: DEMO_QUORUM_SIGNERS[0], at: DEMO_QUORUM_APPROVAL_ATS[0] },
    { signerId: DEMO_QUORUM_SIGNERS[1], at: DEMO_QUORUM_APPROVAL_ATS[1] },
  ]);
});

test("demo quorum restore preserves the mid-collection count across a JSON round-trip", () => {
  const {
    disputeQuorum,
    quorumSnapshot,
    quorumRestoredApprovalCount,
    quorumRestoredHasQuorum,
  } = runDemo();

  // The snapshot was taken after exactly one approval (arb-1 at the
  // first fixed approval timestamp), under the demo config.
  assert.equal(quorumSnapshot.v, 1);
  assert.equal(quorumSnapshot.threshold, DEMO_QUORUM_THRESHOLD);
  assert.deepEqual(quorumSnapshot.signers, [...DEMO_QUORUM_SIGNERS]);
  assert.deepEqual(quorumSnapshot.approvals, [
    { signerId: DEMO_QUORUM_SIGNERS[0], at: DEMO_QUORUM_APPROVAL_ATS[0] },
  ]);
  // The restore reproduced the pre-snapshot counting state exactly:
  // one approval, still below threshold.
  assert.equal(quorumRestoredApprovalCount, 1);
  assert.equal(quorumRestoredHasQuorum, false);
  // Independent cross-check: restoring the same snapshot again (fresh
  // JSON round-trip; a config without the injected clock — counting
  // without an expiry window never consults it) yields the same
  // state, and collection continues seamlessly to threshold.
  const independentlyRestored = restoreQuorum(
    { threshold: DEMO_QUORUM_THRESHOLD, signers: [...DEMO_QUORUM_SIGNERS] },
    JSON.parse(JSON.stringify(quorumSnapshot)),
  );
  assert.equal(independentlyRestored.approvalCount(), 1);
  assert.equal(independentlyRestored.hasQuorum(), false);
  assert.deepEqual(independentlyRestored.approvals(), [
    DEMO_QUORUM_SIGNERS[0],
  ]);
  independentlyRestored.approve(DEMO_QUORUM_SIGNERS[1]);
  assert.equal(independentlyRestored.approvalCount(), 2);
  assert.equal(independentlyRestored.hasQuorum(), true);
  // And the demo's own restored quorum is the one that finished the
  // arbitration: both fixed-timestamp approvals are in its log.
  assert.equal(disputeQuorum.approvalCount(), 2);
  assert.deepEqual(disputeQuorum.approvalLog(), [
    { signerId: DEMO_QUORUM_SIGNERS[0], at: DEMO_QUORUM_APPROVAL_ATS[0] },
    { signerId: DEMO_QUORUM_SIGNERS[1], at: DEMO_QUORUM_APPROVAL_ATS[1] },
  ]);
});

test("demo lines print the quorum snapshot restore segment between the first vote and the refused attempt", () => {
  const { lines } = runDemo();
  const text = lines.join("\n");

  assert.ok(
    text.includes(
      `  quorum snapshot: 1 approval(s) persisted via JSON round-trip (v1, threshold ${DEMO_QUORUM_THRESHOLD}, signers ${DEMO_QUORUM_SIGNERS.join(", ")})`,
    ),
  );
  assert.ok(
    text.includes(
      `  quorum restored: approvalCount 1/${DEMO_QUORUM_THRESHOLD} — hasQuorum: false (matches pre-snapshot 1/${DEMO_QUORUM_THRESHOLD} — hasQuorum: false)`,
    ),
  );
  // Position: after the first approval, before the below-threshold
  // refusal and the second approval (which lands on the restored
  // quorum).
  const firstVoteAt = text.indexOf(`  approve ${DEMO_QUORUM_SIGNERS[0]}`);
  const snapshotAt = text.indexOf("  quorum snapshot:");
  const restoredAt = text.indexOf("  quorum restored:");
  const refusalAt = text.indexOf('  dispatchArbitration("refund") rejected:');
  const secondVoteAt = text.indexOf(`  approve ${DEMO_QUORUM_SIGNERS[1]}`);
  assert.ok(
    firstVoteAt < snapshotAt &&
      snapshotAt < restoredAt &&
      restoredAt < refusalAt &&
      refusalAt < secondVoteAt,
  );
});

test("demo dispute refund report returns the full deposit to the sponsor", () => {
  const { disputeReport } = runDemo();

  assert.equal(disputeReport.escrowId, DEMO_DISPUTE_ESCROW_ID);
  assert.equal(disputeReport.outcome, "refunded");
  assert.ok(disputeReport.balanced);
  assert.equal(disputeReport.totalInflow, 10630);
  assert.equal(disputeReport.totalOutflow, 10630);
  const byParty = Object.fromEntries(
    disputeReport.parties.map((p) => [p.party, p.net]),
  );
  assert.deepEqual(byParty, { sponsor: 0, creator: 0, platform: 0, referrer: 0 });
});

test("demo lines print the dispute / quorum / refund branch", () => {
  const { lines } = runDemo();
  const text = lines.join("\n");

  assert.match(text, /Dispute branch \(DISPUTE -> quorum arbitration -> refund\):/);
  assert.ok(text.includes(`Escrow ${DEMO_DISPUTE_ESCROW_ID}: CREATED`));
  assert.ok(text.includes("same M-of-N rule"));
  assert.match(text, /VERIFY_FAIL +MILESTONE_SUBMITTED +-> DISPUTED/);
  assert.ok(
    text.includes(
      `  approve ${DEMO_QUORUM_SIGNERS[0]}        quorum 1/${DEMO_QUORUM_THRESHOLD} — hasQuorum: false`,
    ),
  );
  assert.ok(
    text.includes(
      '  dispatchArbitration("refund") rejected: arbitration requires quorum: 1/2 approvals — escrow unchanged at DISPUTED (history 3 -> 3 entries)',
    ),
  );
  assert.ok(
    text.includes(
      `  approve ${DEMO_QUORUM_SIGNERS[1]}        quorum 2/${DEMO_QUORUM_THRESHOLD} — hasQuorum: true`,
    ),
  );
  assert.match(text, /ARBITRATE_REFUND +DISPUTED +-> REFUNDED/);
  assert.match(text, /Final state: REFUNDED \(terminal: true\)/);
  assert.match(text, /Settlement report \(dispute refund\):/);
  assert.ok(text.includes(`Outcome: refunded`));
});

test("demo batch section isolates the still-FUNDED escrow's error and still reports the escrow after it", () => {
  const { pendingEscrow, batchResults } = runDemo();

  assert.equal(pendingEscrow.id, DEMO_PENDING_ESCROW_ID);
  assert.equal(pendingEscrow.state, "FUNDED");
  assert.equal(pendingEscrow.isTerminal, false);
  // Batch order is released -> pending (error) -> refunded: the error
  // sits in the middle, and the entry after it still produced a report.
  assert.equal(batchResults.length, 3);
  assert.deepEqual(
    batchResults.map((r) => r.escrowId),
    [DEMO_ESCROW_ID, DEMO_PENDING_ESCROW_ID, DEMO_DISPUTE_ESCROW_ID],
  );
  assert.equal(batchResults[0].report?.outcome, "released");
  assert.equal(batchResults[0].error, undefined);
  assert.equal(batchResults[1].report, undefined);
  assert.equal(
    batchResults[1].error,
    `cannot build settlement report for ${DEMO_PENDING_ESCROW_ID}: escrow is in FUNDED, no settlement has happened yet`,
  );
  assert.equal(batchResults[2].report?.outcome, "refunded");
  assert.equal(batchResults[2].error, undefined);
});

test("demo batch summary aggregates only the successful reports (hand-computed totals)", () => {
  const { batchSummary } = runDemo();

  // Golden deposit 10,630 on both terminal escrows; the FUNDED error
  // entry is counted but contributes nothing to any money figure.
  assert.equal(batchSummary.total, 3);
  assert.equal(batchSummary.reports, 2);
  assert.equal(batchSummary.errors, 1);
  assert.deepEqual(batchSummary.outcomes, {
    released: 1,
    refunded: 1,
    expired: 0,
  });
  assert.equal(batchSummary.totalDeposit, 21260);
  assert.equal(batchSummary.totalInflow, 21260);
  assert.equal(batchSummary.totalOutflow, 21260);
  assert.equal(batchSummary.balanced, true);
  // Sponsor: -10,630 on the release, 0 net on the refund (in = out).
  // Creator 10,098.50 and platform 531.50 come from the release only.
  const byParty = Object.fromEntries(
    batchSummary.parties.map((p) => [p.party, p.net]),
  );
  assert.deepEqual(byParty, {
    sponsor: -10630,
    creator: 10098.5,
    platform: 531.5,
    referrer: 0,
  });
});

test("demo lines print the batch reports + summary section", () => {
  const { lines } = runDemo();
  const text = lines.join("\n");

  assert.match(
    text,
    /Batch settlement reports \(batch -> per-item isolation -> summary\):/,
  );
  assert.ok(
    text.includes(
      `  ${DEMO_ESCROW_ID}: report — outcome released, deposit 10630, balanced true`,
    ),
  );
  assert.ok(
    text.includes(
      `  ${DEMO_PENDING_ESCROW_ID}: error — cannot build settlement report for ${DEMO_PENDING_ESCROW_ID}: escrow is in FUNDED, no settlement has happened yet`,
    ),
  );
  assert.ok(
    text.includes(
      `  ${DEMO_DISPUTE_ESCROW_ID}: report — outcome refunded, deposit 10630, balanced true`,
    ),
  );
  assert.ok(
    text.includes(
      "  summary: 3 escrows — 2 reports, 1 error (released 1, refunded 1, expired 0)",
    ),
  );
  assert.ok(
    text.includes(
      "  summary totals: deposit 21260, inflow 21260, outflow 21260 — balanced ✓",
    ),
  );
  assert.ok(
    text.includes(
      "  summary parties: sponsor net -10630, creator net 10098.5, platform net 531.5, referrer net 0",
    ),
  );
});

test("demo batch webhooks sign each successful report with a distinct factory eventId and isolate the error entry", () => {
  const { batchResults, batchWebhooks, batchWebhooksVerified } = runDemo();

  // Same order as the batch reports: released -> error -> refunded.
  // The batch results go straight into buildSettlementWebhooks.
  assert.equal(batchWebhooks.length, 3);
  assert.deepEqual(
    batchWebhooks.map((entry) => entry.escrowId),
    batchResults.map((result) => result.escrowId),
  );
  // Successful items: factory eventIds in sequence, shared fixed `at`,
  // outcomes mirroring their reports.
  assert.equal(batchWebhooks[0].error, undefined);
  assert.equal(
    batchWebhooks[0].webhook?.payload.eventId,
    DEMO_BATCH_WEBHOOK_EVENT_IDS[0],
  );
  assert.equal(batchWebhooks[0].webhook?.payload.outcome, "released");
  assert.equal(batchWebhooks[0].webhook?.payload.at, DEMO_BATCH_WEBHOOK_AT);
  assert.equal(batchWebhooks[2].error, undefined);
  assert.equal(
    batchWebhooks[2].webhook?.payload.eventId,
    DEMO_BATCH_WEBHOOK_EVENT_IDS[1],
  );
  assert.equal(batchWebhooks[2].webhook?.payload.outcome, "refunded");
  assert.equal(batchWebhooks[2].webhook?.payload.at, DEMO_BATCH_WEBHOOK_AT);
  // Distinct ids: a receiver deduplicating on eventId keeps both.
  assert.notEqual(
    batchWebhooks[0].webhook?.payload.eventId,
    batchWebhooks[2].webhook?.payload.eventId,
  );
  // The failed item is forwarded untouched — same message the batch
  // report stage produced — and consumed no factory eventId (the
  // refunded webhook after it holds the second id, asserted above).
  assert.equal(batchWebhooks[1].webhook, undefined);
  assert.equal(batchWebhooks[1].error, batchResults[1].error);
  // The demo's own re-verification passes, and an independent
  // re-verification of each built webhook agrees (raw body + object).
  assert.equal(batchWebhooksVerified, true);
  for (const entry of batchWebhooks) {
    if (!entry.webhook) continue;
    assert.match(entry.webhook.signature, /^sha256=[0-9a-f]{64}$/);
    assert.ok(
      verifySettlementWebhook(
        JSON.stringify(entry.webhook.payload),
        entry.webhook.signature,
        DEMO_WEBHOOK_SECRET,
      ),
    );
    assert.ok(
      verifySettlementWebhook(
        entry.webhook.payload,
        entry.webhook.signature,
        DEMO_WEBHOOK_SECRET,
      ),
    );
    assert.equal(
      verifySettlementWebhook(
        entry.webhook.payload,
        entry.webhook.signature,
        "wrong-secret",
      ),
      false,
    );
  }
});

test("demo lines print the batch webhooks section with per-item isolation and re-verification", () => {
  const { lines } = runDemo();
  const text = lines.join("\n");

  assert.match(
    text,
    /Batch settlement webhooks \(batch reports -> per-item signed webhooks\):/,
  );
  assert.ok(
    text.includes(
      `  ${DEMO_ESCROW_ID}: webhook — eventId ${DEMO_BATCH_WEBHOOK_EVENT_IDS[0]}, outcome released, at ${DEMO_BATCH_WEBHOOK_AT}, verifySettlementWebhook: ok`,
    ),
  );
  assert.ok(
    text.includes(
      `  ${DEMO_PENDING_ESCROW_ID}: error — cannot build settlement report for ${DEMO_PENDING_ESCROW_ID}: escrow is in FUNDED, no settlement has happened yet`,
    ),
  );
  assert.ok(
    text.includes(
      `  ${DEMO_DISPUTE_ESCROW_ID}: webhook — eventId ${DEMO_BATCH_WEBHOOK_EVENT_IDS[1]}, outcome refunded, at ${DEMO_BATCH_WEBHOOK_AT}, verifySettlementWebhook: ok`,
    ),
  );
  assert.ok(
    text.includes(
      `  batch webhooks: 2 webhooks, 1 error — eventIds distinct (${DEMO_BATCH_WEBHOOK_EVENT_IDS.join(", ")}), factory-generated per report, never reused`,
    ),
  );
});

test("demo watchdog screening selects disjoint stale/expired subsets and expires only the stale escrow", () => {
  const { watchdogEscrows, staleSelected, expiredSelected, staleActionResults } =
    runDemo();

  // Screening batch in fixture order: stale-only, expired-only, neither.
  assert.deepEqual(
    watchdogEscrows.map((e) => e.id),
    [DEMO_STALE_ESCROW_ID, DEMO_OVERDUE_ONLY_ESCROW_ID, DEMO_FRESH_ESCROW_ID],
  );
  // The two axes pick different escrows out of the same batch — the
  // dwell axis takes the long-FUNDED escrow (its deadline is still
  // ahead), the deadline axis takes the just-submitted escrow (its
  // dwell is only 1 day), and the fresh escrow is in neither subset.
  assert.deepEqual(
    staleSelected.map((e) => e.id),
    [DEMO_STALE_ESCROW_ID],
  );
  assert.deepEqual(
    expiredSelected.map((e) => e.id),
    [DEMO_OVERDUE_ONLY_ESCROW_ID],
  );
  assert.equal(staleSelected[0], watchdogEscrows[0]);
  assert.equal(expiredSelected[0], watchdogEscrows[1]);
  // Hand-computed dwell on the fixed now (last history entry's `at`):
  // 17 days in FUNDED, 1 day in MILESTONE_SUBMITTED, 1 day in FUNDED,
  // against the pinned 7-day budget for both screened states.
  assert.equal(DEMO_STALE_MAX_AGE_MS, 7 * DEMO_STALE_DAY_MS);
  const nowMs = Date.parse(DEMO_STALE_NOW);
  const dwellDays = watchdogEscrows.map((e) => {
    const last = e.history[e.history.length - 1];
    // For the stale escrow the last entry is the watchdog's own
    // EXPIRE (asserted below), so dwell is read off the FUND entry —
    // the entry that entered FUNDED — for that one.
    const entered =
      e.id === DEMO_STALE_ESCROW_ID ? e.history[0] : last;
    return (nowMs - Date.parse(entered.at)) / DEMO_STALE_DAY_MS;
  });
  assert.deepEqual(dwellDays, [17, 1, 1]);
  assert.equal(watchdogEscrows[0].history[0].at, DEMO_STALE_FUND_AT);
  assert.equal(
    watchdogEscrows[1].history[watchdogEscrows[1].history.length - 1].at,
    DEMO_OVERDUE_ONLY_SUBMIT_AT,
  );
  assert.equal(
    watchdogEscrows[2].history[watchdogEscrows[2].history.length - 1].at,
    DEMO_FRESH_FUND_AT,
  );
  // Deadlines are the fixtures that make the deadline axis diverge.
  assert.equal(watchdogEscrows[0].getDeadline(), DEMO_STALE_DEADLINE);
  assert.equal(watchdogEscrows[1].getDeadline(), DEMO_OVERDUE_ONLY_DEADLINE);
  // The executor attempted exactly the stale selection and expired it;
  // the other two escrows are untouched (states + history lengths).
  assert.equal(staleActionResults.length, 1);
  assert.equal(staleActionResults[0].escrow, watchdogEscrows[0]);
  assert.equal(staleActionResults[0].acted, true);
  assert.equal(staleActionResults[0].error, undefined);
  assert.deepEqual(
    watchdogEscrows.map((e) => e.state),
    ["EXPIRED", "MILESTONE_SUBMITTED", "FUNDED"],
  );
  assert.deepEqual(
    watchdogEscrows.map((e) => e.history.length),
    [2, 2, 1],
  );
  // The EXPIRE entry is pinned to the fixed now with the watchdog
  // actor — a wall-clock stamp here would break determinism.
  const expireEntry =
    watchdogEscrows[0].history[watchdogEscrows[0].history.length - 1];
  assert.equal(expireEntry.event, "EXPIRE");
  assert.equal(expireEntry.from, "FUNDED");
  assert.equal(expireEntry.to, "EXPIRED");
  assert.equal(expireEntry.at, DEMO_STALE_NOW);
  assert.equal(expireEntry.actor, "watchdog");
});

test("demo lines print the watchdog screening section after the batch webhooks", () => {
  const { lines } = runDemo();
  const text = lines.join("\n");

  assert.match(
    text,
    /Watchdog screening \(stale dwell axis vs expired deadline axis\):/,
  );
  assert.ok(
    text.includes(
      `  fixed now: ${DEMO_STALE_NOW} — stale budgets: FUNDED 7 days, MILESTONE_SUBMITTED 7 days (dwell from the last history entry, strictly past the budget)`,
    ),
  );
  // Per-escrow lines are full literals: fixture timestamps, dwell,
  // and both verdicts are pinned, not recomputed from the demo.
  assert.ok(
    text.includes(
      "  DEMO-ESC-004: state FUNDED, entered 2026-02-20T09:00:00.000Z, dwell 17 days, deadline 2026-04-01T09:00:00.000Z — stale: true, expired: false",
    ),
  );
  assert.ok(
    text.includes(
      "  DEMO-ESC-005: state MILESTONE_SUBMITTED, entered 2026-03-08T09:00:00.000Z, dwell 1 day, deadline 2026-03-08T12:00:00.000Z — stale: false, expired: true",
    ),
  );
  assert.ok(
    text.includes(
      "  DEMO-ESC-006: state FUNDED, entered 2026-03-08T09:00:00.000Z, dwell 1 day, deadline 2026-04-01T09:00:00.000Z — stale: false, expired: false",
    ),
  );
  assert.ok(
    text.includes(
      "  stale vs expired on the same batch: stale [DEMO-ESC-004], expired [DEMO-ESC-005] — different axes, different subsets (dwell in the current state vs absolute deadline)",
    ),
  );
  assert.ok(
    text.includes(
      "  actOnStaleEscrows (action: dispatch EXPIRE at the fixed now): 1 attempted",
    ),
  );
  assert.ok(text.includes("  DEMO-ESC-004: acted true — now EXPIRED"));
  assert.ok(
    text.includes(
      "  non-stale escrows untouched: DEMO-ESC-005 still MILESTONE_SUBMITTED, DEMO-ESC-006 still FUNDED",
    ),
  );
  // Position: the screening closes the demo, after the batch webhooks.
  const webhooksAt = text.indexOf(
    "Batch settlement webhooks (batch reports",
  );
  const watchdogAt = text.indexOf("Watchdog screening (stale dwell axis");
  assert.ok(webhooksAt < watchdogAt);
});

test("demo deadline watchdog expires the expirable escrow, isolates the VERIFIED one, and never attempts the stale-only one", () => {
  const {
    deadlineEscrows,
    deadlineExpiredSelected,
    deadlineStaleSelected,
    deadlineExpireResults,
  } = runDemo();

  // Deadline batch in fixture order: unexpirable, expirable, stale-only.
  assert.deepEqual(
    deadlineEscrows.map((e) => e.id),
    [
      DEMO_UNEXPIRABLE_ESCROW_ID,
      DEMO_EXPIRABLE_ESCROW_ID,
      DEMO_DEADLINE_STALE_ESCROW_ID,
    ],
  );
  // The deadline axis selects the two past-deadline escrows in batch
  // order; the stale axis on the same batch selects only the third —
  // disjoint subsets, captured before the executor ran.
  assert.deepEqual(
    deadlineExpiredSelected.map((e) => e.id),
    [DEMO_UNEXPIRABLE_ESCROW_ID, DEMO_EXPIRABLE_ESCROW_ID],
  );
  assert.deepEqual(
    deadlineStaleSelected.map((e) => e.id),
    [DEMO_DEADLINE_STALE_ESCROW_ID],
  );
  assert.equal(deadlineExpiredSelected[0], deadlineEscrows[0]);
  assert.equal(deadlineExpiredSelected[1], deadlineEscrows[1]);
  assert.equal(deadlineStaleSelected[0], deadlineEscrows[2]);
  // Fixture deadlines and entry timestamps are the pinned constants.
  assert.equal(deadlineEscrows[0].getDeadline(), DEMO_UNEXPIRABLE_DEADLINE);
  assert.equal(deadlineEscrows[1].getDeadline(), DEMO_EXPIRABLE_DEADLINE);
  assert.equal(
    deadlineEscrows[2].getDeadline(),
    DEMO_DEADLINE_STALE_DEADLINE,
  );
  assert.equal(
    deadlineEscrows[0].history[deadlineEscrows[0].history.length - 1].at,
    DEMO_UNEXPIRABLE_VERIFY_AT,
  );
  assert.equal(deadlineEscrows[1].history[0].at, DEMO_EXPIRABLE_FUND_AT);
  assert.equal(deadlineEscrows[2].history[0].at, DEMO_DEADLINE_STALE_FUND_AT);
  // The executor attempted exactly the expired selection, in order:
  // the VERIFIED escrow first — per-item error, escrow untouched —
  // and its failure did not block the FUNDED escrow after it.
  assert.equal(deadlineExpireResults.length, 2);
  assert.equal(deadlineExpireResults[0].escrow, deadlineEscrows[0]);
  assert.equal(deadlineExpireResults[0].expired, false);
  assert.match(
    deadlineExpireResults[0].error ?? "",
    /invalid transition: EXPIRE from VERIFIED/,
  );
  assert.equal(deadlineExpireResults[1].escrow, deadlineEscrows[1]);
  assert.equal(deadlineExpireResults[1].expired, true);
  assert.equal(deadlineExpireResults[1].error, undefined);
  assert.deepEqual(
    deadlineEscrows.map((e) => e.state),
    ["VERIFIED", "EXPIRED", "FUNDED"],
  );
  // History lengths: the failed attempt appended nothing (3 entries
  // stay 3), the successful expiry appended exactly the EXPIRE entry
  // (1 -> 2), and the never-attempted escrow is untouched (1).
  // The EXPIRE entry's `at` is deliberately NOT asserted: the
  // executor dispatches without a pinned `at`, so it carries the
  // dispatch-time wall clock (see the demo fixture comment).
  assert.deepEqual(
    deadlineEscrows.map((e) => e.history.length),
    [3, 2, 1],
  );
  const expireEntry =
    deadlineEscrows[1].history[deadlineEscrows[1].history.length - 1];
  assert.equal(expireEntry.event, "EXPIRE");
  assert.equal(expireEntry.from, "FUNDED");
  assert.equal(expireEntry.to, "EXPIRED");
});

test("demo lines print the deadline watchdog section after the stale screening", () => {
  const { lines } = runDemo();
  const text = lines.join("\n");

  assert.match(
    text,
    /Deadline watchdog \(expiredEscrows screening -> expireOverdueEscrows execution\):/,
  );
  assert.ok(
    text.includes(
      `  fixed now: ${DEMO_STALE_NOW} — screening and execution on the deadline axis; the stale budgets above (FUNDED 7 days, MILESTONE_SUBMITTED 7 days) are reused for the comparison line`,
    ),
  );
  // Per-escrow lines are full literals: fixture timestamps, dwell,
  // and both verdicts are pinned, not recomputed from the demo.
  assert.ok(
    text.includes(
      "  DEMO-ESC-007: state VERIFIED, entered 2026-03-07T09:00:00.000Z, dwell 2 days, deadline 2026-03-08T09:00:00.000Z — expired: true, stale: false",
    ),
  );
  assert.ok(
    text.includes(
      "  DEMO-ESC-008: state FUNDED, entered 2026-03-08T09:00:00.000Z, dwell 1 day, deadline 2026-03-08T12:00:00.000Z — expired: true, stale: false",
    ),
  );
  assert.ok(
    text.includes(
      "  DEMO-ESC-009: state FUNDED, entered 2026-02-20T09:00:00.000Z, dwell 17 days, deadline 2026-04-01T09:00:00.000Z — expired: false, stale: true",
    ),
  );
  assert.ok(
    text.includes(
      "  expiredEscrows selection: [DEMO-ESC-007, DEMO-ESC-008] — the stale-only escrow DEMO-ESC-009 is not selected (its deadline is still ahead)",
    ),
  );
  assert.ok(text.includes("  expireOverdueEscrows: 2 attempted"));
  assert.ok(
    text.includes(
      "  DEMO-ESC-007: expired false — error: invalid transition: EXPIRE from VERIFIED (escrow unchanged at VERIFIED)",
    ),
  );
  assert.ok(text.includes("  DEMO-ESC-008: expired true — now EXPIRED"));
  assert.ok(
    text.includes(
      "  deadline vs stale on the same batch: expired [DEMO-ESC-007, DEMO-ESC-008], stale [DEMO-ESC-009] — different axes, different subsets (absolute deadline vs dwell in the current state)",
    ),
  );
  assert.ok(
    text.includes("  non-expired escrows untouched: DEMO-ESC-009 still FUNDED"),
  );
  // Position: the deadline watchdog closes the demo, after the
  // stale screening section.
  const screeningAt = text.indexOf("Watchdog screening (stale dwell axis");
  const deadlineAt = text.indexOf("Deadline watchdog (expiredEscrows");
  assert.ok(screeningAt < deadlineAt);
});

test("demo shows the allowed-events listing: every state's events match the hand-pinned table, cross-checked against the transition table", () => {
  const { allowedEventsByState, mainEscrowAllowedEvents, escrow, lines } =
    runDemo();
  const text = lines.join("\n");

  // Hand-pinned expectations — written out here from TRANSITIONS in
  // src/stateMachine.ts, in declaration order, never derived by
  // calling allowedEvents itself. Terminal states (RELEASED /
  // REFUNDED / EXPIRED) expect the empty list. The same lists are
  // pinned by bench's allowedEvents fixture.
  const EXPECTED: Array<{ state: string; events: string[] }> = [
    { state: "CREATED", events: ["FUND", "EXPIRE"] },
    {
      state: "FUNDED",
      events: ["FUND", "SUBMIT_MILESTONE", "DISPUTE", "EXPIRE"],
    },
    {
      state: "MILESTONE_SUBMITTED",
      events: ["VERIFY_PASS", "VERIFY_FAIL", "DISPUTE", "EXPIRE"],
    },
    { state: "VERIFIED", events: ["RELEASE", "DISPUTE"] },
    {
      state: "DISPUTED",
      events: ["ARBITRATE_RELEASE", "ARBITRATE_REFUND"],
    },
    { state: "RELEASED", events: [] },
    { state: "REFUNDED", events: [] },
    { state: "EXPIRED", events: [] },
  ];
  assert.deepEqual(allowedEventsByState, EXPECTED);
  // Cross-check against the transition table itself (the source of
  // the committed snapshot in test/__snapshots__): grouping its
  // edges by `from` must reproduce the same per-state lists — the
  // demo segment is not self-certifying.
  const fromTable = new Map<string, string[]>();
  for (const { from, event } of transitionTable()) {
    const list = fromTable.get(from) ?? [];
    list.push(event);
    fromTable.set(from, list);
  }
  for (const { state, events } of EXPECTED) {
    assert.deepEqual(events, fromTable.get(state) ?? [], `state ${state}`);
    assert.deepEqual(allowedEvents(state as never), events, `state ${state}`);
  }
  // The main escrow is RELEASED, so its own allowed set is the
  // empty list — the boundary the segment calls out on its own line.
  assert.equal(escrow.state, "RELEASED");
  assert.deepEqual(mainEscrowAllowedEvents, []);
  // The segment closes the demo: it follows the deadline watchdog,
  // prints every state line verbatim, and its main-escrow line is
  // the demo's last line.
  const allowedAt = text.indexOf(
    "Allowed events by state (allowedEvents over all 8 states):",
  );
  assert.ok(
    allowedAt >
      text.indexOf(
        "Deadline watchdog (expiredEscrows screening -> expireOverdueEscrows execution):",
      ),
    "allowed-events segment must follow the deadline watchdog",
  );
  for (const { state, events } of EXPECTED) {
    const line =
      events.length > 0
        ? `  ${state.padEnd(20)} -> ${events.join(", ")}`
        : `  ${state.padEnd(20)} -> (none — terminal)`;
    assert.ok(text.includes(line), `missing listing line for ${state}`);
  }
  assert.equal(
    lines[lines.length - 1],
    `  main escrow ${DEMO_ESCROW_ID} (RELEASED): allowedEvents -> (none) — a terminal escrow offers no further events, so an escrow-list UI renders no actions for it`,
  );
});

test("demo allowed-events segment is deterministic: two runs print byte-identical listing lines", () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Allowed events by state (allowedEvents over all 8 states):"),
    );
  const a = runDemo();
  const b = runDemo();
  const segA = segment(a.lines);
  // Header + 8 state lines + the main-escrow line; every value is
  // derived from the transition table alone, so no normalization
  // is needed.
  assert.equal(segA.length, 10);
  assert.deepEqual(segA, segment(b.lines));
  assert.deepEqual(a.allowedEventsByState, b.allowedEventsByState);
  assert.deepEqual(a.mainEscrowAllowedEvents, b.mainEscrowAllowedEvents);
});

test("demo is deterministic: two runs produce identical lines", () => {
  assert.deepEqual(runDemo().lines, runDemo().lines);
});

test("compiled demo script exits 0 and prints the chain, history, report, and webhook", () => {
  const out = execFileSync("node", [path.join(repoRoot, "dist", "src", "demo.js")], {
    encoding: "utf8",
  });

  assert.match(out, /Escrow DEMO-ESC-001: CREATED/);
  for (const [event, from, to] of [
    ["FUND", "CREATED", "FUNDED"],
    ["SUBMIT_MILESTONE", "FUNDED", "MILESTONE_SUBMITTED"],
    ["VERIFY_PASS", "MILESTONE_SUBMITTED", "VERIFIED"],
    ["RELEASE", "VERIFIED", "RELEASED"],
  ] as const) {
    assert.ok(
      out.includes(event) && out.includes(from) && out.includes(to),
      `missing chain step ${event}: ${from} -> ${to}`,
    );
  }
  assert.match(out, /Final state: RELEASED \(terminal: true\)/);
  // Audit trails: 4 numbered history entries for the main escrow plus
  // 4 for the dispute escrow (FUND/SUBMIT/VERIFY_FAIL/ARBITRATE_REFUND)
  const seqRows = out.match(/^\s+\d+  /gm) ?? [];
  assert.equal(seqRows.length, 8);
  // Dispute branch tail: below-quorum refusal, then REFUNDED refund
  assert.match(out, /Dispute branch \(DISPUTE -> quorum arbitration -> refund\):/);
  assert.match(out, /Escrow DEMO-ESC-002: CREATED/);
  assert.match(
    out,
    /dispatchArbitration\("refund"\) rejected: arbitration requires quorum: 1\/2 approvals/,
  );
  assert.match(out, /Final state: REFUNDED \(terminal: true\)/);
  assert.match(out, /Settlement report \(dispute refund\):/);
  // Settlement report tail: balanced totals on the golden deposit
  assert.match(out, /Totals: inflow \$10,630\.00 = outflow \$10,630\.00 — balanced ✓/);
  // Settlement webhook tail: signed notification built + verified
  assert.match(
    out,
    /Settlement webhook \(signed escrow\.settled notification\):/,
  );
  assert.ok(out.includes(`  eventId:      ${DEMO_WEBHOOK_EVENT_ID}`));
  assert.match(out, / {2}signature: {4}sha256=[0-9a-f]{64}/);
  assert.match(out, /verifySettlementWebhook: ok/);
  // Batch tail: per-item isolation (error in the middle) + summary
  assert.match(out, /Batch settlement reports \(batch -> per-item isolation -> summary\):/);
  assert.match(
    out,
    /DEMO-ESC-003: error — cannot build settlement report for DEMO-ESC-003: escrow is in FUNDED/,
  );
  assert.match(
    out,
    /summary totals: deposit 21260, inflow 21260, outflow 21260 — balanced ✓/,
  );
  // Batch webhook tail: per-item signed webhooks over the batch
  // reports — distinct factory eventIds, the error forwarded in the
  // middle, and a receiver-side re-verification per built webhook.
  assert.match(
    out,
    /Batch settlement webhooks \(batch reports -> per-item signed webhooks\):/,
  );
  assert.ok(
    out.includes(
      `DEMO-ESC-001: webhook — eventId ${DEMO_BATCH_WEBHOOK_EVENT_IDS[0]}, outcome released, at ${DEMO_BATCH_WEBHOOK_AT}, verifySettlementWebhook: ok`,
    ),
  );
  assert.match(
    out,
    /DEMO-ESC-003: error — cannot build settlement report for DEMO-ESC-003: escrow is in FUNDED/,
  );
  assert.ok(
    out.includes(
      `DEMO-ESC-002: webhook — eventId ${DEMO_BATCH_WEBHOOK_EVENT_IDS[1]}, outcome refunded, at ${DEMO_BATCH_WEBHOOK_AT}, verifySettlementWebhook: ok`,
    ),
  );
  assert.match(out, /batch webhooks: 2 webhooks, 1 error — eventIds distinct/);
  // Watchdog tail: the closing screening prints both axes' subsets
  // over the same batch and the stale disposition result. (The
  // seq-row count above stays 8: the watchdog section prints no
  // numbered history rows.)
  assert.match(out, /Watchdog screening \(stale dwell axis vs expired deadline axis\):/);
  assert.ok(
    out.includes(
      "  DEMO-ESC-004: state FUNDED, entered 2026-02-20T09:00:00.000Z, dwell 17 days, deadline 2026-04-01T09:00:00.000Z — stale: true, expired: false",
    ),
  );
  assert.ok(
    out.includes(
      "  stale vs expired on the same batch: stale [DEMO-ESC-004], expired [DEMO-ESC-005] — different axes, different subsets (dwell in the current state vs absolute deadline)",
    ),
  );
  assert.ok(out.includes("  DEMO-ESC-004: acted true — now EXPIRED"));
  // Deadline watchdog tail: the closing section screens three more
  // escrows by deadline and executes the selection — the VERIFIED
  // escrow's per-item error printed before the FUNDED escrow's
  // successful expiry, and the stale-only escrow never attempted.
  // (The seq-row count above stays 8: this section prints no
  // numbered history rows either.)
  assert.match(
    out,
    /Deadline watchdog \(expiredEscrows screening -> expireOverdueEscrows execution\):/,
  );
  assert.ok(
    out.includes(
      "  expiredEscrows selection: [DEMO-ESC-007, DEMO-ESC-008] — the stale-only escrow DEMO-ESC-009 is not selected (its deadline is still ahead)",
    ),
  );
  assert.ok(
    out.includes(
      "  DEMO-ESC-007: expired false — error: invalid transition: EXPIRE from VERIFIED (escrow unchanged at VERIFIED)",
    ),
  );
  assert.ok(out.includes("  DEMO-ESC-008: expired true — now EXPIRED"));
  assert.ok(
    out.includes(
      "  deadline vs stale on the same batch: expired [DEMO-ESC-007, DEMO-ESC-008], stale [DEMO-ESC-009] — different axes, different subsets (absolute deadline vs dwell in the current state)",
    ),
  );
  // Allowed-events tail: the closing listing prints every state in
  // transition-table order, the terminal states as (none — terminal),
  // and the main escrow's own empty set on the last line.
  assert.match(out, /Allowed events by state \(allowedEvents over all 8 states\):/);
  assert.ok(out.includes("  CREATED              -> FUND, EXPIRE"));
  assert.ok(
    out.includes(
      "  MILESTONE_SUBMITTED  -> VERIFY_PASS, VERIFY_FAIL, DISPUTE, EXPIRE",
    ),
  );
  assert.ok(out.includes("  RELEASED             -> (none — terminal)"));
  assert.ok(
    out.trimEnd().endsWith(
      `main escrow ${DEMO_ESCROW_ID} (RELEASED): allowedEvents -> (none) — a terminal escrow offers no further events, so an escrow-list UI renders no actions for it`,
    ),
  );
});
