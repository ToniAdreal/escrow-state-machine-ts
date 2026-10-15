/**
 * Demo: drive one escrow through the full happy path
 * CREATED -> FUNDED -> MILESTONE_SUBMITTED -> VERIFIED -> RELEASED,
 * print the append-only audit history plus the final settlement report,
 * then build the signed settlement webhook for the released escrow and
 * verify it the way a receiver would. The receiver side then runs
 * that webhook's `eventId` through `SettlementEventDedupe` on a fixed
 * clock: the first delivery is new (booked), an immediate redelivery
 * is a duplicate (skipped), and after the clock advances by exactly
 * the TTL the same id counts as new again. A second escrow then walks the
 * dispute branch: VERIFY_FAIL lands it in DISPUTED, a 2-of-3 arbitrator
 * quorum is collected vote by vote — after the first vote the quorum
 * is snapshotted, round-tripped through JSON, and restored with
 * `restoreQuorum` at the identical count (the arbitration-restart
 * path), with one below-threshold arbitration attempt refused
 * without touching the escrow — and the reached quorum refunds the
 * sponsor in full (REFUNDED), closing with
 * that escrow's refund settlement report. The demo closes with the
 * day-end batch pipeline over all three escrows: `buildSettlementReports`
 * builds one report per escrow with per-item error isolation (the
 * third escrow is still FUNDED, so it lands as `{escrowId, error}`
 * without blocking the batch), `summarizeSettlementReports`
 * aggregates the batch into one reconciliation summary, and
 * `buildSettlementWebhooks` then signs one webhook per successful
 * report from that same batch result — each with its own
 * factory-generated `eventId`, the failed entry forwarded as
 * `{escrowId, error}` — with a receiver-side re-verification of a
 * built webhook printed per successful item.
 *
 * Usage: `npm run demo` (builds with tsc, then runs node on the compiled
 * output). Zero runtime dependencies: this file only imports the library
 * itself.
 *
 * Everything is deterministic: the escrow id, fee inputs, actors, notes,
 * evidence reference, and every dispatch timestamp are fixed constants
 * below — no wall clock, no randomness, no network. Two runs print
 * byte-identical output.
 */

import { fileURLToPath } from "node:url";
import {
  Escrow,
  SettlementEventDedupe,
  buildSettlementReport,
  buildSettlementReports,
  buildSettlementWebhook,
  buildSettlementWebhooks,
  calculateDeposit,
  createQuorum,
  dispatchArbitration,
  renderReport,
  restoreQuorum,
  summarizeSettlementReports,
  verifySettlementWebhook,
  type BuildSettlementWebhooksResult,
  type EscrowEvent,
  type Quorum,
  type QuorumConfig,
  type QuorumSnapshot,
  type SettlementReport,
  type SettlementReportResult,
  type SettlementReportsSummary,
  type SettlementWebhook,
} from "./index.js";

/** Fixed demo fixture: the portfolio golden fee vector (deposit 10,630). */
export const DEMO_ESCROW_ID = "DEMO-ESC-001";
export const DEMO_PRO_FEE_BPS = 500;

/**
 * Signing secret for the demo webhook only — a placeholder printed in
 * the source, NOT a real credential. A real deployment loads its
 * secret from its own credential store and never commits it.
 */
export const DEMO_WEBHOOK_SECRET =
  "whsec_demo_settlement_notifications_not_a_real_secret";
/** Fixed webhook eventId / `at` so the demo signature is deterministic. */
export const DEMO_WEBHOOK_EVENT_ID = "evt_demo_settlement_001";
export const DEMO_WEBHOOK_AT = "2026-03-06T08:17:00.000Z";

/**
 * Receiver-dedupe fixtures: a 1-hour TTL (the `SettlementEventDedupe`
 * default, passed explicitly here) and a fixed clock that starts at
 * the webhook's own `at` instant. After the first two deliveries the
 * clock advances by exactly `DEMO_DEDUPE_TTL_MS`: an id is a
 * duplicate only while `now - firstSeenAt < ttlMs`, so at exactly
 * one TTL the record has expired and the id counts as new again.
 */
export const DEMO_DEDUPE_TTL_MS = 3_600_000;
export const DEMO_DEDUPE_START_MS = Date.parse(DEMO_WEBHOOK_AT);

/** Fixed fixture for the dispute branch: a second escrow, same deposit. */
export const DEMO_DISPUTE_ESCROW_ID = "DEMO-ESC-002";
/**
 * Demo-scale quorum: 2-of-3 arbitrators. This is the same M-of-N
 * counting rule the README FAQ describes for the case study's 5/9 DAO
 * multi-sig, at a size a demo printout can show vote by vote — a
 * scale difference, not a rule difference.
 */
export const DEMO_QUORUM_SIGNERS = ["arb-1", "arb-2", "arb-3"] as const;
export const DEMO_QUORUM_THRESHOLD = 2;
/** Fixed approval timestamps (the quorum clock is injected, see below). */
export const DEMO_QUORUM_APPROVAL_ATS = [
  "2026-03-07T12:00:00.000Z",
  "2026-03-07T13:00:00.000Z",
] as const;
/** Fixed `at` for the below-threshold attempt and the refund dispatch. */
export const DEMO_ARBITRATION_ATTEMPT_AT = "2026-03-07T12:30:00.000Z";
export const DEMO_ARBITRATION_AT = "2026-03-07T13:30:00.000Z";

/**
 * Third escrow for the closing batch section: funded with the same
 * golden deposit but never submitted, so it is still FUNDED (not
 * terminal, nothing to settle) when the batch runs — its batch entry
 * must land as `{escrowId, error}` without blocking the other two.
 */
export const DEMO_PENDING_ESCROW_ID = "DEMO-ESC-003";
export const DEMO_PENDING_FUND_AT = "2026-03-03T09:00:00.000Z";

/**
 * Batch-webhook fixtures for the closing section: one shared `at`
 * for the whole batch (the day-end snapshot point, after every demo
 * dispatch) and the deterministic `eventId` factory sequence. The
 * factory is called once per attempted report, in batch order, so
 * the released report takes the first id and the refunded report
 * the second; the forwarded error entry consumes no id. Ids are
 * never reused across reports — a receiver deduplicating on
 * `eventId` would otherwise drop all but the first settlement.
 */
export const DEMO_BATCH_WEBHOOK_AT = "2026-03-08T09:00:00.000Z";
export const DEMO_BATCH_WEBHOOK_EVENT_IDS = [
  "evt_demo_batch_001",
  "evt_demo_batch_002",
] as const;

const steps: Array<{
  event: EscrowEvent;
  actor: string;
  note: string;
  at: string;
  amount?: number;
  evidence?: string;
}> = [
  {
    event: "FUND",
    actor: "sponsor",
    note: "Deposit locked (wire received)",
    at: "2026-03-01T09:00:00.000Z",
    amount: 10630,
  },
  {
    event: "SUBMIT_MILESTONE",
    actor: "creator",
    note: "Deliverable URLs + IPFS metadata hash",
    at: "2026-03-05T12:30:00.000Z",
  },
  {
    event: "VERIFY_PASS",
    actor: "oracle",
    note: "KPIs validated by oracle",
    at: "2026-03-06T08:15:00.000Z",
    evidence: "demo-oracle-attestation-001",
  },
  {
    event: "RELEASE",
    actor: "system",
    note: "Verification passed — release funds",
    at: "2026-03-06T08:16:00.000Z",
  },
];

/**
 * Dispute-branch steps for the second escrow: the same golden deposit,
 * then a milestone whose verification fails — VERIFY_FAIL is the legal
 * edge from MILESTONE_SUBMITTED into DISPUTED. The arbitration itself
 * is not a plain step: it is gated on the quorum (see runDemo).
 */
const disputeSteps: Array<{
  event: EscrowEvent;
  actor: string;
  note: string;
  at: string;
  amount?: number;
}> = [
  {
    event: "FUND",
    actor: "sponsor",
    note: "Deposit locked (wire received)",
    at: "2026-03-02T09:00:00.000Z",
    amount: 10630,
  },
  {
    event: "SUBMIT_MILESTONE",
    actor: "creator",
    note: "Deliverable URLs + IPFS metadata hash",
    at: "2026-03-06T10:00:00.000Z",
  },
  {
    event: "VERIFY_FAIL",
    actor: "oracle",
    note: "KPIs missed — verification failed, dispute opened",
    at: "2026-03-07T11:00:00.000Z",
  },
];

export interface DemoResult {
  escrow: Escrow;
  report: SettlementReport;
  webhook: SettlementWebhook;
  webhookVerified: boolean;
  /**
   * Receiver-side dedupe store after the demo's three deliveries of
   * the main webhook's `eventId` (new, duplicate, new-after-TTL):
   * its stats read hits 1 / misses 2 / size 1.
   */
  webhookDedupe: SettlementEventDedupe;
  /** Second escrow, driven through the dispute branch to REFUNDED. */
  disputeEscrow: Escrow;
  /** Refund settlement report of the dispute escrow. */
  disputeReport: SettlementReport;
  /**
   * The 2-of-3 arbitrator quorum, at threshold after two approvals.
   * This is the quorum restored from the mid-collection snapshot
   * (see {@link DemoResult.quorumSnapshot}): the below-threshold
   * attempt, the second approval, and the arbitration dispatch all
   * run on the restored instance.
   */
  disputeQuorum: Quorum;
  /**
   * Snapshot of the dispute quorum taken after its first approval
   * (1 of 2), before the simulated restart — plain JSON, `v: 1`,
   * carrying the one recorded approval at its fixed timestamp.
   */
  quorumSnapshot: QuorumSnapshot;
  /**
   * Counting state of the quorum restored from
   * {@link DemoResult.quorumSnapshot} via a JSON round-trip +
   * `restoreQuorum`, captured immediately after the restore:
   * 1 approval, below threshold — identical to the pre-snapshot
   * quorum, which is the point of the segment.
   */
  quorumRestoredApprovalCount: number;
  quorumRestoredHasQuorum: boolean;
  /**
   * Error message of the below-threshold `dispatchArbitration` attempt
   * (`arbitration requires quorum: 1/2 approvals`) — the attempt is
   * part of the demo, and its refusal left the escrow untouched.
   */
  arbitrationRejection: string;
  /** Third escrow, left FUNDED so the batch section has a failing item. */
  pendingEscrow: Escrow;
  /** Per-item batch results, in batch order (released, error, refunded). */
  batchResults: SettlementReportResult[];
  /** Reconciliation summary over {@link DemoResult.batchResults}. */
  batchSummary: SettlementReportsSummary;
  /** Per-item batch webhooks built from {@link DemoResult.batchResults}. */
  batchWebhooks: BuildSettlementWebhooksResult[];
  /**
   * True when every successfully built batch webhook re-verifies
   * under the demo secret over its raw body bytes (and at least one
   * webhook was built) — the receiver-side check the demo prints.
   */
  batchWebhooksVerified: boolean;
  lines: string[];
}

/**
 * Run the demo lifecycle without printing anything, and return the
 * escrow, its settlement report, and the exact lines `main()` prints —
 * so tests can assert on the demo itself, not just on the library.
 */
export function runDemo(): DemoResult {
  const fees = calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });

  const escrow = new Escrow(DEMO_ESCROW_ID);
  const lines: string[] = [
    `Escrow ${escrow.id}: ${escrow.state}`,
    `Deposit preview: ${fees.deposit} (pool ${fees.creatorPool} + base ${fees.baseFee}×${fees.complexityMultiplier} − loyalty ${fees.loyaltyDiscount} + oracle ${fees.oracleFee})`,
    "",
  ];

  for (const { event, actor, note, at, amount, evidence } of steps) {
    const from = escrow.state;
    const to = escrow.dispatch(event, note, amount, { actor, at, evidence });
    lines.push(`  ${event.padEnd(18)} ${from.padEnd(19)} -> ${to}  (${actor})`);
  }

  const report = buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: fees,
    settlement: { proFeeBps: DEMO_PRO_FEE_BPS },
  });

  lines.push("", `Final state: ${escrow.state} (terminal: ${escrow.isTerminal})`);
  lines.push("History (append-only audit trail):");
  lines.push("  seq  event              from                 -> to                   actor        at");
  for (const h of escrow.history) {
    const amount = h.amount !== undefined ? `  amount ${h.amount}` : "";
    lines.push(
      `  ${String(h.seq).padStart(3)}  ${h.event.padEnd(18)} ${h.from.padEnd(20)} -> ${h.to.padEnd(20)} ${String(h.actor ?? "-").padEnd(12)} ${h.at}${amount}`,
    );
  }
  lines.push("", "Settlement report:");
  lines.push(renderReport(report));

  // RELEASE is where settlement webhooks fire: build the signed
  // `escrow.settled` notification from the settlement report (fixed
  // now/eventId, demo-only secret above — see its comment), print what
  // a receiver would get, then verify it with the same secret over the
  // raw body bytes, the transport-safe receiver path.
  const webhook = buildSettlementWebhook(report, {
    secret: DEMO_WEBHOOK_SECRET,
    now: DEMO_WEBHOOK_AT,
    eventId: DEMO_WEBHOOK_EVENT_ID,
  });
  const webhookVerified = verifySettlementWebhook(
    JSON.stringify(webhook.payload),
    webhook.signature,
    DEMO_WEBHOOK_SECRET,
  );
  lines.push("", "Settlement webhook (signed escrow.settled notification):");
  lines.push(`  event:        ${webhook.payload.event}`);
  lines.push(`  eventId:      ${webhook.payload.eventId}`);
  lines.push(`  escrowId:     ${webhook.payload.escrowId}`);
  lines.push(`  outcome:      ${webhook.payload.outcome}`);
  lines.push(`  releasePath:  ${webhook.payload.releasePath ?? "-"}`);
  lines.push(`  deposit:      ${webhook.payload.deposit}`);
  lines.push(
    `  parties:      ${webhook.payload.parties.map((p) => `${p.party} net ${p.net}`).join(", ")}`,
  );
  lines.push(`  at:           ${webhook.payload.at}`);
  lines.push(`  signature:    ${webhook.signature}`);
  lines.push(
    `  verifySettlementWebhook: ${webhookVerified ? "ok" : "FAILED"}`,
  );

  // --- Receiver dedupe: the same eventId delivered three times ---
  // Verification proves a delivery is authentic; dedupe is the other
  // half of the receiver's at-most-once story (see the README's
  // receiver guidance): a retried delivery re-POSTs the same eventId,
  // and booking it twice would settle twice. The dedupe runs on a
  // fixed clock starting at the webhook's `at` (DEMO_DEDUPE_START_MS)
  // with an explicit 1-hour TTL. Deliveries 1 and 2 happen at the
  // same fixed instant; the clock then advances by exactly the TTL,
  // at which point the record has expired (duplicates are only
  // `now - firstSeenAt < ttlMs`), so delivery 3 counts as new again.
  let dedupeNowMs = DEMO_DEDUPE_START_MS;
  const webhookDedupe = new SettlementEventDedupe({
    ttlMs: DEMO_DEDUPE_TTL_MS,
    now: () => dedupeNowMs,
  });
  const dedupeFirst = webhookDedupe.checkAndRecord(webhook.payload.eventId);
  const dedupeSecond = webhookDedupe.checkAndRecord(webhook.payload.eventId);
  dedupeNowMs += DEMO_DEDUPE_TTL_MS;
  const dedupeAfterTtl = webhookDedupe.checkAndRecord(webhook.payload.eventId);
  const dedupeStats = webhookDedupe.stats();
  lines.push(
    "",
    "Receiver dedupe (SettlementEventDedupe on the webhook eventId):",
    `  delivery 1: eventId ${webhook.payload.eventId} — checkAndRecord: ${dedupeFirst} (new event, book the settlement)`,
    `  delivery 2: eventId ${webhook.payload.eventId} — checkAndRecord: ${dedupeSecond} (duplicate, skip — no second booking)`,
    `  delivery 3 (fixed clock +${DEMO_DEDUPE_TTL_MS} ms = TTL): eventId ${webhook.payload.eventId} — checkAndRecord: ${dedupeAfterTtl} (new event again, TTL expired)`,
    `  dedupe stats: size ${dedupeStats.size}, hits ${dedupeStats.hits}, misses ${dedupeStats.misses}, evictions ${dedupeStats.evictions}`,
  );

  // --- Dispute branch: DISPUTED -> quorum arbitration -> REFUNDED ---
  // A second escrow, funded with the same golden deposit, whose
  // milestone fails verification. The quorum clock is injected with
  // the fixed approval timestamps above, so approvalLog() — and the
  // whole printout — stays deterministic.
  const disputeEscrow = new Escrow(DEMO_DISPUTE_ESCROW_ID);
  let approvalTick = 0;
  // One config object, shared by createQuorum below and the later
  // restoreQuorum call: restore validates the snapshot against the
  // config it is restored into (threshold / signer set must match),
  // and the shared injected clock keeps approval timestamps on the
  // fixed DEMO_QUORUM_APPROVAL_ATS sequence across the restore —
  // the first approval stamps ATS[0], the post-restore approval
  // stamps ATS[1], exactly as without a restart. (Counting never
  // consults the clock here: with no maxApprovalAgeMs configured,
  // approvals do not expire.)
  const quorumConfig: QuorumConfig = {
    threshold: DEMO_QUORUM_THRESHOLD,
    signers: [...DEMO_QUORUM_SIGNERS],
    now: () =>
      Date.parse(
        DEMO_QUORUM_APPROVAL_ATS[
          Math.min(approvalTick++, DEMO_QUORUM_APPROVAL_ATS.length - 1)
        ],
      ),
  };
  let disputeQuorum = createQuorum(quorumConfig);
  lines.push(
    "",
    "Dispute branch (DISPUTE -> quorum arbitration -> refund):",
    `Escrow ${disputeEscrow.id}: ${disputeEscrow.state}`,
    `  quorum: ${DEMO_QUORUM_THRESHOLD}-of-${DEMO_QUORUM_SIGNERS.length} arbitrators (${DEMO_QUORUM_SIGNERS.join(", ")}) — demo scale of the README FAQ's 5/9 DAO multi-sig, same M-of-N rule`,
  );
  for (const { event, actor, note, at, amount } of disputeSteps) {
    const from = disputeEscrow.state;
    const to = disputeEscrow.dispatch(event, note, amount, { actor, at });
    lines.push(`  ${event.padEnd(18)} ${from.padEnd(19)} -> ${to}  (${actor})`);
  }

  // First vote: 1/2, below threshold. The arbitration attempt must be
  // refused with the explicit quorum error and leave no trace: same
  // state, same history length before and after.
  disputeQuorum.approve(DEMO_QUORUM_SIGNERS[0]);
  lines.push(
    `  approve ${DEMO_QUORUM_SIGNERS[0]}        quorum ${disputeQuorum.approvalCount()}/${disputeQuorum.threshold} — hasQuorum: ${disputeQuorum.hasQuorum()}`,
  );

  // --- Simulated restart: snapshot -> JSON -> restoreQuorum ---
  // The arbitration process restarts mid-collection: the quorum's
  // state survives only as its snapshot, persisted as JSON text and
  // parsed back (the snapshot is the export format — restore
  // re-validates the signer set and threshold against the config).
  // The restored quorum must count exactly what the pre-snapshot
  // quorum counted (1 approval, below threshold); collection then
  // continues on the restored instance, not the original — the
  // refused attempt and the second vote below both run against it.
  const countBeforeSnapshot = disputeQuorum.approvalCount();
  const hasQuorumBeforeSnapshot = disputeQuorum.hasQuorum();
  const quorumSnapshot = disputeQuorum.snapshot();
  const restoredQuorum = restoreQuorum(
    quorumConfig,
    JSON.parse(JSON.stringify(quorumSnapshot)),
  );
  const quorumRestoredApprovalCount = restoredQuorum.approvalCount();
  const quorumRestoredHasQuorum = restoredQuorum.hasQuorum();
  lines.push(
    `  quorum snapshot: ${quorumSnapshot.approvals.length} approval(s) persisted via JSON round-trip (v${quorumSnapshot.v}, threshold ${quorumSnapshot.threshold}, signers ${quorumSnapshot.signers.join(", ")})`,
    `  quorum restored: approvalCount ${quorumRestoredApprovalCount}/${restoredQuorum.threshold} — hasQuorum: ${quorumRestoredHasQuorum} (matches pre-snapshot ${countBeforeSnapshot}/${quorumSnapshot.threshold} — hasQuorum: ${hasQuorumBeforeSnapshot})`,
  );
  disputeQuorum = restoredQuorum;

  const historyBeforeAttempt = disputeEscrow.history.length;
  let arbitrationRejection = "";
  try {
    dispatchArbitration(disputeEscrow, disputeQuorum, "refund", "Refund the sponsor", {
      actor: DEMO_QUORUM_SIGNERS[0],
      at: DEMO_ARBITRATION_ATTEMPT_AT,
    });
  } catch (err) {
    arbitrationRejection = err instanceof Error ? err.message : String(err);
  }
  lines.push(
    `  dispatchArbitration("refund") rejected: ${arbitrationRejection} — escrow unchanged at ${disputeEscrow.state} (history ${historyBeforeAttempt} -> ${disputeEscrow.history.length} entries)`,
  );

  // Second vote — cast on the restored quorum — reaches the
  // threshold; the same call now dispatches
  // ARBITRATE_REFUND (actor + fixed `at` forwarded to the audit entry)
  // and the full deposit returns to the sponsor.
  disputeQuorum.approve(DEMO_QUORUM_SIGNERS[1]);
  lines.push(
    `  approve ${DEMO_QUORUM_SIGNERS[1]}        quorum ${disputeQuorum.approvalCount()}/${disputeQuorum.threshold} — hasQuorum: ${disputeQuorum.hasQuorum()}`,
  );
  const disputeFrom = disputeEscrow.state;
  const disputeTo = dispatchArbitration(
    disputeEscrow,
    disputeQuorum,
    "refund",
    "Dispute upheld — refund the sponsor",
    { actor: DEMO_QUORUM_SIGNERS[1], at: DEMO_ARBITRATION_AT },
  );
  lines.push(
    `  ${"ARBITRATE_REFUND".padEnd(18)} ${disputeFrom.padEnd(19)} -> ${disputeTo}  (${DEMO_QUORUM_SIGNERS[1]})`,
  );

  const disputeReport = buildSettlementReport({
    escrowId: disputeEscrow.id,
    history: disputeEscrow.history,
    finalState: disputeEscrow.state,
    deposit: fees,
  });
  lines.push(
    "",
    `Final state: ${disputeEscrow.state} (terminal: ${disputeEscrow.isTerminal})`,
    "History (append-only audit trail):",
    "  seq  event              from                 -> to                   actor        at",
  );
  for (const h of disputeEscrow.history) {
    const amount = h.amount !== undefined ? `  amount ${h.amount}` : "";
    lines.push(
      `  ${String(h.seq).padStart(3)}  ${h.event.padEnd(18)} ${h.from.padEnd(20)} -> ${h.to.padEnd(20)} ${String(h.actor ?? "-").padEnd(12)} ${h.at}${amount}`,
    );
  }
  lines.push("", "Settlement report (dispute refund):");
  lines.push(renderReport(disputeReport));

  // --- Batch settlement: one batch -> per-item reports -> one summary ---
  // The day-end pipeline the single-report sections above feed into.
  // The batch set is the demo's fixed escrows in a deliberate order —
  // released, still-FUNDED, refunded — so the failing item sits in the
  // middle: its entry lands as {escrowId, error} and the refunded
  // report after it still builds, proving per-item error isolation.
  // Hand-computed expectations (golden deposit 10,630 on both terminal
  // escrows; the error entry contributes nothing to any total):
  // reports 2, errors 1; totalDeposit = totalInflow = totalOutflow =
  // 21,260; sponsor net -10,630 (the released outflow; on the refunded
  // escrow its inflow cancels its own outflow), creator net 10,098.50,
  // platform net 531.50, referrer net 0; balanced true.
  const pendingEscrow = new Escrow(DEMO_PENDING_ESCROW_ID);
  pendingEscrow.dispatch("FUND", "Deposit locked (wire received)", 10630, {
    actor: "sponsor",
    at: DEMO_PENDING_FUND_AT,
  });
  const batchResults = buildSettlementReports([
    {
      escrowId: escrow.id,
      history: escrow.history,
      finalState: escrow.state,
      deposit: fees,
      settlement: { proFeeBps: DEMO_PRO_FEE_BPS },
    },
    {
      escrowId: pendingEscrow.id,
      history: pendingEscrow.history,
      finalState: pendingEscrow.state,
      deposit: fees,
    },
    {
      escrowId: disputeEscrow.id,
      history: disputeEscrow.history,
      finalState: disputeEscrow.state,
      deposit: fees,
    },
  ]);
  const batchSummary = summarizeSettlementReports(batchResults);
  lines.push(
    "",
    "Batch settlement reports (batch -> per-item isolation -> summary):",
  );
  for (const result of batchResults) {
    if (result.report) {
      lines.push(
        `  ${result.escrowId}: report — outcome ${result.report.outcome}, deposit ${result.report.deposit.deposit}, balanced ${result.report.balanced}`,
      );
    } else {
      lines.push(`  ${result.escrowId}: error — ${result.error}`);
    }
  }
  lines.push(
    `  summary: ${batchSummary.total} escrows — ${batchSummary.reports} reports, ${batchSummary.errors} error (released ${batchSummary.outcomes.released}, refunded ${batchSummary.outcomes.refunded}, expired ${batchSummary.outcomes.expired})`,
    `  summary totals: deposit ${batchSummary.totalDeposit}, inflow ${batchSummary.totalInflow}, outflow ${batchSummary.totalOutflow} — ${batchSummary.balanced ? "balanced ✓" : "UNBALANCED ✗"}`,
    `  summary parties: ${batchSummary.parties.map((p) => `${p.party} net ${p.net}`).join(", ")}`,
  );

  // --- Batch webhooks: batch reports -> per-item signed webhooks ---
  // The second half of the day-end pipeline: the batch results go
  // straight into buildSettlementWebhooks, no hand-written loop and
  // no pre-filtering. One shared secret and one shared fixed `now`;
  // the eventIds come from a deterministic factory (see the fixture
  // comment above) — a factory, never one fixed id, because every
  // settlement in the batch is a distinct event. The FUNDED entry's
  // report error is forwarded untouched as {escrowId, error} and
  // does not block the refunded webhook after it. Each built webhook
  // is re-verified the way a receiver would, over the raw body
  // bytes, and that verdict is printed on its line.
  let batchEventSeq = 0;
  const batchWebhooks = buildSettlementWebhooks(batchResults, {
    secret: DEMO_WEBHOOK_SECRET,
    now: DEMO_BATCH_WEBHOOK_AT,
    // Sequential factory: evt_demo_batch_001, evt_demo_batch_002, …
    // (DEMO_BATCH_WEBHOOK_EVENT_IDS) — a fresh id per report, by
    // construction never reused.
    eventIdFactory: () =>
      `evt_demo_batch_${String(++batchEventSeq).padStart(3, "0")}`,
  });
  const batchVerifications = batchWebhooks.map((entry) =>
    entry.webhook
      ? verifySettlementWebhook(
          JSON.stringify(entry.webhook.payload),
          entry.webhook.signature,
          DEMO_WEBHOOK_SECRET,
        )
      : undefined,
  );
  const builtCount = batchWebhooks.filter((entry) => entry.webhook).length;
  const batchWebhooksVerified =
    builtCount > 0 &&
    batchVerifications.every((verified) => verified !== false);
  lines.push(
    "",
    "Batch settlement webhooks (batch reports -> per-item signed webhooks):",
  );
  for (const [i, entry] of batchWebhooks.entries()) {
    if (entry.webhook) {
      lines.push(
        `  ${entry.escrowId}: webhook — eventId ${entry.webhook.payload.eventId}, outcome ${entry.webhook.payload.outcome}, at ${entry.webhook.payload.at}, verifySettlementWebhook: ${batchVerifications[i] ? "ok" : "FAILED"}`,
      );
    } else {
      lines.push(`  ${entry.escrowId}: error — ${entry.error}`);
    }
  }
  lines.push(
    `  batch webhooks: ${builtCount} webhooks, ${batchWebhooks.length - builtCount} error — eventIds distinct (${DEMO_BATCH_WEBHOOK_EVENT_IDS.join(", ")}), factory-generated per report, never reused`,
  );

  return {
    escrow,
    report,
    webhook,
    webhookVerified,
    webhookDedupe,
    disputeEscrow,
    disputeReport,
    disputeQuorum,
    quorumSnapshot,
    quorumRestoredApprovalCount,
    quorumRestoredHasQuorum,
    arbitrationRejection,
    pendingEscrow,
    batchResults,
    batchSummary,
    batchWebhooks,
    batchWebhooksVerified,
    lines,
  };
}

function main(): void {
  console.log(runDemo().lines.join("\n"));
}

// Run only when executed directly (`node dist/src/demo.js`), not when
// imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
