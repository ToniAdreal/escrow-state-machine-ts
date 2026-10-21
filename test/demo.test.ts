import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  runDemo,
  DEMO_APPROVAL_LOG_CHECK_AT,
  DEMO_APPROVAL_LOG_ENTRIES,
  DEMO_APPROVAL_LOG_FIRST_AT,
  DEMO_APPROVAL_LOG_SECOND_AT,
  DEMO_APPROVAL_LOG_WINDOW_MS,
  DEMO_ARBITRATION_AT,
  DEMO_DEDUPE_CLEAR_EVENT_ID,
  DEMO_DEDUPE_CLEAR_START_MS,
  DEMO_DEDUPE_SNAPSHOT_ENTRIES,
  DEMO_DEDUPE_SNAPSHOT_EVENT_IDS,
  DEMO_DEDUPE_SNAPSHOT_START_MS,
  DEMO_DEDUPE_SNAPSHOT_TAMPERED_ERROR,
  DEMO_DEDUPE_SNAPSHOT_UNSEEN_EVENT_ID,
  DEMO_DEDUPE_TTL_MS,
  DEMO_DISPUTE_APPROVAL_LOG_ENTRIES,
  DEMO_BATCH_WEBHOOK_AT,
  DEMO_BATCH_WEBHOOK_EVENT_IDS,
  DEMO_CLEAR_DEADLINE_CHECK_AT,
  DEMO_CLEAR_DEADLINE_DEADLINE,
  DEMO_CLEAR_DEADLINE_ESCROW_ID,
  DEMO_CLEAR_DEADLINE_FUND_AT,
  DEMO_CLEAR_DEADLINE_NO_DEADLINE_ESCROW_ID,
  DEMO_CLEAR_DEADLINE_NO_DEADLINE_FUND_AT,
  DEMO_DEADLINE_STALE_DEADLINE,
  DEMO_DEADLINE_STALE_ESCROW_ID,
  DEMO_DEADLINE_STALE_FUND_AT,
  DEMO_DISPUTE_ESCROW_ID,
  DEMO_ESCROW_ID,
  DEMO_EXPECTED_SEQ_ESCROW_ID,
  DEMO_EXPECTED_SEQ_FUND_AT,
  DEMO_EXPECTED_SEQ_INVALID_FRACTION_ERROR,
  DEMO_EXPECTED_SEQ_INVALID_NEGATIVE_ERROR,
  DEMO_EXPECTED_SEQ_STALE_ERROR,
  DEMO_EXPECTED_SEQ_SUBMIT_AT,
  DEMO_EXPECTED_SEQ_VERIFY_AT,
  DEMO_EXPECTED_SEQ_VERIFY_EVIDENCE,
  DEMO_EXPIRABLE_DEADLINE,
  DEMO_EXPIRABLE_ESCROW_ID,
  DEMO_EXPIRABLE_FUND_AT,
  DEMO_FANOUT_AT,
  DEMO_FANOUT_ENDPOINTS,
  DEMO_FANOUT_EVENT_ID,
  DEMO_FRESH_ESCROW_ID,
  DEMO_FRESH_FUND_AT,
  DEMO_MONEY_GUARD_ERROR,
  DEMO_MONEY_GUARD_ILLEGAL_AMOUNTS,
  DEMO_MONEY_GUARD_LEGAL_AMOUNTS,
  DEMO_ONERROR_ESCROW_ID,
  DEMO_ONERROR_EXPECTED_REPORTS,
  DEMO_ONERROR_FUND_AT,
  DEMO_ONERROR_INVALID_ERROR,
  DEMO_ONERROR_LISTENER_ERROR,
  DEMO_ONERROR_PROBE_ESCROW_ID,
  DEMO_ONERROR_SUBMIT_AT,
  DEMO_ONERROR_VERIFY_AT,
  DEMO_ONERROR_VERIFY_EVIDENCE,
  DEMO_OVERDUE_CHECK_AFTER_AT,
  DEMO_OVERDUE_CHECK_AT_DEADLINE,
  DEMO_OVERDUE_CHECK_BEFORE_AT,
  DEMO_OVERDUE_CHECK_DEADLINE,
  DEMO_OVERDUE_CHECK_ESCROW_ID,
  DEMO_OVERDUE_ONLY_DEADLINE,
  DEMO_OVERDUE_ONLY_ESCROW_ID,
  DEMO_OVERDUE_ONLY_SUBMIT_AT,
  DEMO_PARSED_HISTORY_TAMPER_ERROR,
  DEMO_PARSED_HISTORY_TAMPERED_NOTE,
  DEMO_PARSED_HISTORY_TAMPERED_SEQ,
  DEMO_PENDING_ESCROW_ID,
  DEMO_PRO_FEE_BPS,
  DEMO_QUORUM_APPROVAL_ATS,
  DEMO_QUORUM_SIGNERS,
  DEMO_QUORUM_THRESHOLD,
  DEMO_REVOKE_FIRST_AT,
  DEMO_REVOKE_LOG_AFTER_REVOKE,
  DEMO_REVOKE_LOG_FINAL,
  DEMO_REVOKE_NOT_APPROVED_ERROR,
  DEMO_ABORT_BACKOFF_MS,
  DEMO_ABORT_BACKOFF_URL,
  DEMO_ABORT_ERROR,
  DEMO_ABORT_PRE_URL,
  DEMO_REVOKE_REAPPROVE_AT,
  DEMO_REVOKE_SECOND_AT,
  DEMO_REVOKE_UNKNOWN_ERROR,
  DEMO_REVOKE_UNKNOWN_SIGNER,
  DEMO_REBUILT_DEADLINE,
  DEMO_RETRY_AFTER_DELIVERY_HINT,
  DEMO_RETRY_AFTER_DELIVERY_HINT_MS,
  DEMO_RETRY_AFTER_DELIVERY_SCRIPTED_STATUSES,
  DEMO_RETRY_AFTER_DELIVERY_URL,
  DEMO_RETRY_AFTER_NOW_MS,
  DEMO_SINGLE_DELIVERY_SCRIPTED_STATUSES,
  DEMO_SINGLE_DELIVERY_URL,
  DEMO_SNAPSHOT_SERIALIZED_BYTES,
  DEMO_STALE_DAY_MS,
  DEMO_STALE_DEADLINE,
  DEMO_STALE_ESCROW_ID,
  DEMO_STALE_FUND_AT,
  DEMO_STALE_MAX_AGE_MS,
  DEMO_STALE_NOW,
  DEMO_SUBSCRIBE_ESCROW_ID,
  DEMO_SUBSCRIBE_FUND_AT,
  DEMO_SUBSCRIBE_SUBMIT_AT,
  DEMO_SUBSCRIBE_VERIFY_AT,
  DEMO_SUBSCRIBE_VERIFY_EVIDENCE,
  DEMO_TRANSITION_TABLE_EDGE_COUNT,
  DEMO_TRANSITION_TABLE_JSON_BYTES,
  DEMO_UNEXPIRABLE_DEADLINE,
  DEMO_UNEXPIRABLE_ESCROW_ID,
  DEMO_UNEXPIRABLE_VERIFY_AT,
  DEMO_VERIFY_EVIDENCE_DEFAULT_ESCROW_ID,
  DEMO_VERIFY_EVIDENCE_ERROR,
  DEMO_VERIFY_EVIDENCE_ESCROW_ID,
  DEMO_VERIFY_EVIDENCE_FUND_AT,
  DEMO_VERIFY_EVIDENCE_REF,
  DEMO_VERIFY_EVIDENCE_SUBMIT_AT,
  DEMO_VERIFY_EVIDENCE_VERIFY_AT,
  DEMO_WEBHOOK_AT,
  DEMO_WEBHOOK_EVENT_ID,
  DEMO_WEBHOOK_FRESHNESS_BOUNDARY_NOW_MS,
  DEMO_WEBHOOK_FRESHNESS_EXPIRED_NOW_MS,
  DEMO_WEBHOOK_FRESHNESS_FUTURE_NOW_MS,
  DEMO_WEBHOOK_FRESHNESS_MAX_AGE_MS,
  DEMO_WEBHOOK_FRESHNESS_MAX_FUTURE_SKEW_MS,
  DEMO_WEBHOOK_FRESHNESS_WITHIN_NOW_MS,
  DEMO_WEBHOOK_ROTATION_EMPTY_SECRETS_ERROR,
  DEMO_WEBHOOK_ROTATION_NEW_SECRET,
  DEMO_WEBHOOK_ROTATION_UNRELATED_SECRET,
  DEMO_WEBHOOK_SECRET,
} from "../src/demo.js";
import {
  Escrow,
  SettlementEventDedupe,
  allowedEvents,
  assertNonNegativeMoney,
  buildSettlementWebhook,
  createQuorum,
  deliverSettlementWebhook,
  depositAmountFromHistory,
  historyFromNdjson,
  historyToNdjson,
  isOverdue,
  parseEscrowHistory,
  parseRetryAfter,
  restoreQuorum,
  settleRelease,
  stateDiagram,
  transitionTable,
  transitionTableJson,
  verifyHistoryChain,
  verifySettlementWebhook,
} from "../src/index.js";
import { readmeDiagramInSync } from "../src/diagram.js";

const repoRoot = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
); // dist/test/*.test.js -> repo root

test("demo runs the full CREATED -> RELEASED chain in-process without throwing", async () => {
  const { escrow, report } = await runDemo();

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

test("demo settlement numbers are self-consistent with the golden deposit", async () => {
  const { report } = await runDemo();

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

test("demo verifies the main history's hash chain and detects a tampered FUND amount on a detached copy", async () => {
  const { escrow, historyChainVerified, tamperedChainVerified, tamperedFundAmount } =
    await runDemo();

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

test("demo lines print the audit hash chain section between the settlement report and the webhook", async () => {
  const { lines } = await runDemo();
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

test("demo builds a settlement webhook from the report and self-verifies it", async () => {
  const { webhook, webhookVerified } = await runDemo();

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

test("demo lines print the webhook build + verify section", async () => {
  const { lines } = await runDemo();
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

test("demo shows the webhook freshness window: inside and at the boundary pass, expired and future-skewed fail", async () => {
  const {
    webhook,
    webhookFreshnessMaxAgeMs,
    webhookFreshnessWithinWindow,
    webhookFreshnessBoundary,
    webhookFreshnessExpired,
    webhookFreshnessMaxFutureSkewMs,
    webhookFreshnessFutureSkewExceeded,
  } = await runDemo();

  // Hand-pinned fixture shape: a 1-hour age window and a 5-minute
  // future-skew bound, every injected instant derived from the
  // webhook's pinned `at`.
  assert.equal(DEMO_WEBHOOK_FRESHNESS_MAX_AGE_MS, 3_600_000);
  assert.equal(DEMO_WEBHOOK_FRESHNESS_MAX_FUTURE_SKEW_MS, 300_000);
  assert.equal(webhookFreshnessMaxAgeMs, DEMO_WEBHOOK_FRESHNESS_MAX_AGE_MS);
  assert.equal(
    webhookFreshnessMaxFutureSkewMs,
    DEMO_WEBHOOK_FRESHNESS_MAX_FUTURE_SKEW_MS,
  );
  const atMs = Date.parse(DEMO_WEBHOOK_AT);
  assert.equal(DEMO_WEBHOOK_FRESHNESS_WITHIN_NOW_MS, atMs + 1_800_000);
  assert.equal(DEMO_WEBHOOK_FRESHNESS_BOUNDARY_NOW_MS, atMs + 3_600_000);
  assert.equal(DEMO_WEBHOOK_FRESHNESS_EXPIRED_NOW_MS, atMs + 7_200_000);
  assert.equal(DEMO_WEBHOOK_FRESHNESS_FUTURE_NOW_MS, atMs - 600_000);

  // The four verdicts: inside passes, the inclusive boundary
  // passes, past the window the still-valid signature is refused,
  // and a sender clock ahead beyond the skew bound is refused.
  assert.equal(webhookFreshnessWithinWindow, true);
  assert.equal(webhookFreshnessBoundary, true);
  assert.equal(webhookFreshnessExpired, false);
  assert.equal(webhookFreshnessFutureSkewExceeded, false);

  // Independent re-verification agrees, and without the opt-in the
  // expired call's signature still verifies on its own — the
  // window, not the signature, is what refused it.
  const body = JSON.stringify(webhook.payload);
  assert.equal(
    verifySettlementWebhook(body, webhook.signature, {
      secrets: [DEMO_WEBHOOK_SECRET],
      maxAgeMs: DEMO_WEBHOOK_FRESHNESS_MAX_AGE_MS,
      now: DEMO_WEBHOOK_FRESHNESS_WITHIN_NOW_MS,
    }),
    true,
  );
  assert.equal(
    verifySettlementWebhook(body, webhook.signature, {
      secrets: [DEMO_WEBHOOK_SECRET],
      maxAgeMs: DEMO_WEBHOOK_FRESHNESS_MAX_AGE_MS,
      now: DEMO_WEBHOOK_FRESHNESS_EXPIRED_NOW_MS,
    }),
    false,
  );
  assert.equal(
    verifySettlementWebhook(body, webhook.signature, DEMO_WEBHOOK_SECRET),
    true,
  );
});

test("demo lines print the webhook freshness window section", async () => {
  const { lines } = await runDemo();
  const text = lines.join("\n");

  assert.match(
    text,
    /Webhook freshness window \(verifySettlementWebhook maxAgeMs \/ maxFutureSkewMs on the main webhook, injected now\):/,
  );
  assert.ok(
    text.includes(
      `  payload at ${DEMO_WEBHOOK_AT}, maxAgeMs ${DEMO_WEBHOOK_FRESHNESS_MAX_AGE_MS} ms: now at +1800000 ms — verifySettlementWebhook: true (signature valid and inside the window)`,
    ),
  );
  assert.ok(
    text.includes(
      `  boundary: now at exactly +${DEMO_WEBHOOK_FRESHNESS_MAX_AGE_MS} ms = maxAgeMs — verifySettlementWebhook: true (inclusive boundary — only a larger age fails)`,
    ),
  );
  assert.ok(
    text.includes(
      "  expired: now at +7200000 ms — verifySettlementWebhook: false (signature still valid, but the replay window has closed — fail-closed)",
    ),
  );
  assert.ok(
    text.includes(
      `  sender clock ahead: payload at is 600000 ms ahead of now, maxFutureSkewMs ${DEMO_WEBHOOK_FRESHNESS_MAX_FUTURE_SKEW_MS} ms — verifySettlementWebhook: false (future skew beyond the bound)`,
    ),
  );
  // The freshness section sits between the webhook section and the
  // receiver dedupe section — it bounds the same notification.
  const webhookAt = text.indexOf("Settlement webhook (signed");
  const freshnessAt = text.indexOf("Webhook freshness window (verifySettlementWebhook");
  const dedupeAt = text.indexOf("Receiver dedupe (SettlementEventDedupe");
  assert.ok(webhookAt < freshnessAt && freshnessAt < dedupeAt);
});

test("demo shows webhook secret rotation: old and new secrets verify, unrelated fails closed, empty secrets throws", async () => {
  const {
    report,
    webhook,
    webhookRotationOldVerified,
    webhookRotationNewVerified,
    webhookRotationUnrelatedVerified,
    webhookRotationEmptySecretsError,
  } = await runDemo();

  // Hand-pinned fixture shape: the demo secret plays the old
  // secret, the rotation constants are distinct placeholder
  // secrets, and the empty-set error is the pinned config error
  // from src/webhooks.ts.
  assert.notEqual(DEMO_WEBHOOK_ROTATION_NEW_SECRET, DEMO_WEBHOOK_SECRET);
  assert.notEqual(
    DEMO_WEBHOOK_ROTATION_UNRELATED_SECRET,
    DEMO_WEBHOOK_ROTATION_NEW_SECRET,
  );
  assert.notEqual(DEMO_WEBHOOK_ROTATION_UNRELATED_SECRET, DEMO_WEBHOOK_SECRET);
  assert.equal(
    DEMO_WEBHOOK_ROTATION_EMPTY_SECRETS_ERROR,
    "cannot verify settlement webhook: secrets must be a non-empty array",
  );

  // The four shapes: old-signed passes, new-signed passes,
  // unrelated-signed fails closed, empty set throws.
  assert.equal(webhookRotationOldVerified, true);
  assert.equal(webhookRotationNewVerified, true);
  assert.equal(webhookRotationUnrelatedVerified, false);
  assert.equal(
    webhookRotationEmptySecretsError,
    DEMO_WEBHOOK_ROTATION_EMPTY_SECRETS_ERROR,
  );

  // Independent re-verification: twins rebuilt by hand over the
  // identical payload (same fixed now / eventId) carry
  // byte-identical bodies and different signatures, and the
  // verdicts agree under the same candidate set.
  const body = JSON.stringify(webhook.payload);
  const rotationOpts = {
    secrets: [DEMO_WEBHOOK_ROTATION_NEW_SECRET, DEMO_WEBHOOK_SECRET],
  };
  const newTwin = buildSettlementWebhook(report, {
    secret: DEMO_WEBHOOK_ROTATION_NEW_SECRET,
    now: DEMO_WEBHOOK_AT,
    eventId: DEMO_WEBHOOK_EVENT_ID,
  });
  assert.equal(JSON.stringify(newTwin.payload), body);
  assert.notEqual(newTwin.signature, webhook.signature);
  assert.equal(
    verifySettlementWebhook(body, webhook.signature, rotationOpts),
    true,
  );
  assert.equal(
    verifySettlementWebhook(body, newTwin.signature, rotationOpts),
    true,
  );
  const unrelatedTwin = buildSettlementWebhook(report, {
    secret: DEMO_WEBHOOK_ROTATION_UNRELATED_SECRET,
    now: DEMO_WEBHOOK_AT,
    eventId: DEMO_WEBHOOK_EVENT_ID,
  });
  assert.equal(JSON.stringify(unrelatedTwin.payload), body);
  assert.equal(
    verifySettlementWebhook(body, unrelatedTwin.signature, rotationOpts),
    false,
  );
  assert.throws(
    () => verifySettlementWebhook(body, webhook.signature, { secrets: [] }),
    new RegExp(
      DEMO_WEBHOOK_ROTATION_EMPTY_SECRETS_ERROR.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      ),
    ),
  );
});

test("demo lines print the webhook secret rotation section", async () => {
  const { lines } = await runDemo();
  const text = lines.join("\n");

  assert.match(
    text,
    /Webhook secret rotation \(verifySettlementWebhook \{ secrets: \[new, old\] \} on the main webhook\):/,
  );
  assert.ok(
    text.includes(
      "  signed with the old secret (the main webhook): verifySettlementWebhook { secrets: [new, old] }: true (the old secret still verifies inside the rotation window)",
    ),
  );
  assert.ok(
    text.includes(
      "  signed with the new secret (identical payload, same fixed at / eventId): verifySettlementWebhook { secrets: [new, old] }: true (the rotated-in secret verifies too)",
    ),
  );
  assert.ok(
    text.includes(
      "  signed with an unrelated secret: verifySettlementWebhook { secrets: [new, old] }: false (no candidate matches — fail-closed, returns false without throwing)",
    ),
  );
  assert.ok(
    text.includes(
      `  empty candidate set: verifySettlementWebhook { secrets: [] } throws "${DEMO_WEBHOOK_ROTATION_EMPTY_SECRETS_ERROR}" (a caller configuration error, never a silent pass)`,
    ),
  );
  // The rotation section sits between the freshness section and
  // the receiver dedupe section — it re-verifies the same
  // notification under the receiver's candidate set.
  const freshnessAt = text.indexOf("Webhook freshness window (verifySettlementWebhook");
  const rotationAt = text.indexOf("Webhook secret rotation (verifySettlementWebhook");
  const dedupeAt = text.indexOf("Receiver dedupe (SettlementEventDedupe");
  assert.ok(freshnessAt < rotationAt && rotationAt < dedupeAt);
});

test("demo receiver dedupe counts the main webhook eventId new, duplicate, then new after the TTL", async () => {
  const { webhookDedupe } = await runDemo();

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

test("demo lines print the receiver dedupe section", async () => {
  const { lines } = await runDemo();
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

test("demo shows Retry-After parsing: both hint forms normalize to milliseconds on a fixed clock", async () => {
  const { retryAfterParsed, lines } = await runDemo();
  const text = lines.join("\n");

  // Hand-pinned expectations — written out here from the documented
  // semantics (delay-seconds -> seconds * 1000; an HTTP-date ->
  // max(0, date - now); signed numbers, garbage, and absent values
  // -> undefined), never derived by calling parseRetryAfter itself.
  // The fixed now is the webhook's `at` (second-aligned, so the two
  // HTTP-date strings land exactly); the same corpus shapes are
  // pinned independently by the bench fixture and by
  // test/webhookDelivery.test.ts.
  assert.equal(DEMO_RETRY_AFTER_NOW_MS, Date.parse(DEMO_WEBHOOK_AT));
  const EXPECTED: Array<{ value: string | null; parsed: number | undefined }> = [
    { value: "2", parsed: 2000 },
    { value: " 30 ", parsed: 30_000 },
    { value: "Fri, 06 Mar 2026 08:17:05 GMT", parsed: 5000 },
    { value: "Fri, 06 Mar 2026 08:16:59 GMT", parsed: 0 },
    { value: "-5", parsed: undefined },
    { value: "banana", parsed: undefined },
    { value: null, parsed: undefined },
  ];
  assert.deepEqual(retryAfterParsed, EXPECTED);
  // Independent cross-check: re-parsing each corpus value against
  // the same fixed now reproduces the demo's structured results.
  for (const { value, parsed } of EXPECTED) {
    assert.equal(parseRetryAfter(value, DEMO_RETRY_AFTER_NOW_MS), parsed);
  }
  // Every printed line verbatim, in corpus order, between the
  // receiver-dedupe segment and the dispute branch — the sender
  // half of the same webhook retry story — closing with the rule
  // that ties the parsed hint back to the delivery retry context.
  assert.ok(
    text.includes("Retry-After parsing (parseRetryAfter on a fixed clock):"),
  );
  assert.ok(
    text.includes(
      `  fixed now: ${DEMO_WEBHOOK_AT} — every value below is parsed against this injected instant, never the wall clock`,
    ),
  );
  for (const { value, parsed } of EXPECTED) {
    const shown = value === null ? "null" : `"${value}"`;
    assert.ok(
      text.includes(
        `  parseRetryAfter(${shown}) -> ${parsed === undefined ? "undefined" : parsed}`,
      ),
      `missing Retry-After line for ${shown}`,
    );
  }
  assert.ok(
    text.includes(
      "  sender rule: on a 429 the parsed hint, clamped by maxRetryDelayMs, sets the wait before the next attempt; undefined — absent or unparsable — falls back to exponential backoff",
    ),
  );
  const dedupeAt = text.indexOf("Receiver dedupe (SettlementEventDedupe");
  const retryAt = text.indexOf("Retry-After parsing (parseRetryAfter");
  const disputeAt = text.indexOf("Dispute branch (DISPUTE");
  assert.ok(dedupeAt < retryAt && retryAt < disputeAt);
});

test("demo Retry-After segment is deterministic: two runs print byte-identical parsing lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Retry-After parsing (parseRetryAfter on a fixed clock):"),
      ls.indexOf("Dispute branch (DISPUTE -> quorum arbitration -> refund):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + fixed-now line + 7 corpus lines + the sender-rule line;
  // every value is derived from the fixed corpus and the injected
  // fixed now alone, so no normalization is needed.
  assert.equal(segA.length, 10);
  assert.deepEqual(segA, segment(b.lines));
  assert.deepEqual(a.retryAfterParsed, b.retryAfterParsed);
});

test("demo dispute branch reaches DISPUTED, is refused below quorum, then refunds at quorum", async () => {
  const { disputeEscrow, disputeQuorum, arbitrationRejection } = await runDemo();

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

test("demo quorum restore preserves the mid-collection count across a JSON round-trip", async () => {
  const {
    disputeQuorum,
    quorumSnapshot,
    quorumRestoredApprovalCount,
    quorumRestoredHasQuorum,
  } = await runDemo();

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

test("demo lines print the quorum snapshot restore segment between the first vote and the refused attempt", async () => {
  const { lines } = await runDemo();
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

test("demo dispute refund report returns the full deposit to the sponsor", async () => {
  const { disputeReport } = await runDemo();

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

test("demo lines print the dispute / quorum / refund branch", async () => {
  const { lines } = await runDemo();
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

test("demo batch section isolates the still-FUNDED escrow's error and still reports the escrow after it", async () => {
  const { pendingEscrow, batchResults } = await runDemo();

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

test("demo batch summary aggregates only the successful reports (hand-computed totals)", async () => {
  const { batchSummary } = await runDemo();

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

test("demo lines print the batch reports + summary section", async () => {
  const { lines } = await runDemo();
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

test("demo batch webhooks sign each successful report with a distinct factory eventId and isolate the error entry", async () => {
  const { batchResults, batchWebhooks, batchWebhooksVerified } = await runDemo();

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

test("demo lines print the batch webhooks section with per-item isolation and re-verification", async () => {
  const { lines } = await runDemo();
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

test("demo fan-out delivers the main report to every fixed endpoint with a shared body and per-endpoint signatures", async () => {
  const { fanoutResult, fanoutCalls } = await runDemo();

  // Hand-pinned aggregate: 3 fixed endpoints, each answering 200 on
  // its first attempt through the fake fetch — delivered 3,
  // failed 0, results in endpoint order. Expectations are written
  // from src/webhooks.ts's documented fan-out semantics and
  // cross-checked against test/webhookFanout.test.ts, never
  // derived by calling the fan-out here a second time.
  assert.equal(DEMO_FANOUT_ENDPOINTS.length, 3);
  assert.deepEqual(
    fanoutResult.results,
    DEMO_FANOUT_ENDPOINTS.map((endpoint) => ({
      url: endpoint.url,
      ok: true,
      attempts: 1,
      status: 200,
    })),
  );
  assert.equal(fanoutResult.delivered, 3);
  assert.equal(fanoutResult.failed, 0);
  assert.equal(fanoutResult.delivered + fanoutResult.failed, 3);
  // One logical event: every captured call carries byte-identical
  // body bytes naming the shared fixed eventId / at and the main
  // escrow, while the signatures are pairwise distinct — signed
  // independently per endpoint.
  assert.equal(fanoutCalls.length, 3);
  assert.ok(fanoutCalls.every((call) => call.body === fanoutCalls[0].body));
  const sharedPayload = JSON.parse(fanoutCalls[0].body);
  assert.equal(sharedPayload.eventId, DEMO_FANOUT_EVENT_ID);
  assert.equal(sharedPayload.at, DEMO_FANOUT_AT);
  assert.equal(sharedPayload.escrowId, DEMO_ESCROW_ID);
  assert.equal(new Set(fanoutCalls.map((call) => call.signature)).size, 3);
  // Each signature verifies under its own endpoint's secret only.
  for (const [i, endpoint] of DEMO_FANOUT_ENDPOINTS.entries()) {
    const call = fanoutCalls.find((c) => c.url === endpoint.url);
    assert.ok(call, `missing fan-out call for ${endpoint.url}`);
    assert.ok(verifySettlementWebhook(call.body, call.signature, endpoint.secret));
    for (const [j, other] of DEMO_FANOUT_ENDPOINTS.entries()) {
      if (j === i) continue;
      assert.equal(
        verifySettlementWebhook(call.body, call.signature, other.secret),
        false,
      );
    }
  }
});

test("demo lines print the fan-out delivery section after the batch webhooks and before the watchdog screening", async () => {
  const { lines } = await runDemo();
  const text = lines.join("\n");

  assert.match(
    text,
    /Settlement webhook fan-out \(deliverSettlementWebhookToMany via fake fetch, zero network\):/,
  );
  assert.ok(
    text.includes(
      `  one logical event: eventId ${DEMO_FANOUT_EVENT_ID}, at ${DEMO_FANOUT_AT} — the payload body is built once and shared by every endpoint, signed per endpoint with its own secret`,
    ),
  );
  for (const endpoint of DEMO_FANOUT_ENDPOINTS) {
    assert.ok(
      text.includes(`  ${endpoint.url}: ok true — attempts 1, status 200`),
      `missing fan-out line for ${endpoint.url}`,
    );
  }
  assert.ok(
    text.includes(
      "  fan-out: 3 endpoints, 3 delivered, 0 failed — every endpoint received byte-identical body bytes, each signature verifies under its own endpoint's secret only",
    ),
  );
  const fanoutAt = text.indexOf("Settlement webhook fan-out (deliverSettlementWebhookToMany");
  assert.ok(
    fanoutAt >
      text.indexOf("Batch settlement webhooks (batch reports -> per-item signed webhooks):"),
    "fan-out segment must follow the batch webhooks segment",
  );
  assert.ok(
    text.indexOf("Watchdog screening (stale dwell axis") > fanoutAt,
    "fan-out segment must precede the watchdog screening segment",
  );
});

test("demo watchdog screening selects disjoint stale/expired subsets and expires only the stale escrow", async () => {
  const { watchdogEscrows, staleSelected, expiredSelected, staleActionResults } =
    await runDemo();

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

test("demo lines print the watchdog screening section after the batch webhooks", async () => {
  const { lines } = await runDemo();
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

test("demo deadline watchdog expires the expirable escrow, isolates the VERIFIED one, and never attempts the stale-only one", async () => {
  const {
    deadlineEscrows,
    deadlineExpiredSelected,
    deadlineStaleSelected,
    deadlineExpireResults,
  } = await runDemo();

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

test("demo lines print the deadline watchdog section after the stale screening", async () => {
  const { lines } = await runDemo();
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

test("demo shows the allowed-events listing: every state's events match the hand-pinned table, cross-checked against the transition table", async () => {
  const { allowedEventsByState, mainEscrowAllowedEvents, escrow, lines } =
    await runDemo();
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
  // The segment follows the deadline watchdog and precedes the
  // closing deposit-provenance segment; it prints every state line
  // verbatim, including its main-escrow line.
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
  assert.ok(
    allowedAt <
      text.indexOf(
        "Deposit provenance (depositAmountFromHistory on the main escrow history):",
      ),
    "allowed-events segment must precede the deposit-provenance segment",
  );
  for (const { state, events } of EXPECTED) {
    const line =
      events.length > 0
        ? `  ${state.padEnd(20)} -> ${events.join(", ")}`
        : `  ${state.padEnd(20)} -> (none — terminal)`;
    assert.ok(text.includes(line), `missing listing line for ${state}`);
  }
  assert.ok(
    text.includes(
      `  main escrow ${DEMO_ESCROW_ID} (RELEASED): allowedEvents -> (none) — a terminal escrow offers no further events, so an escrow-list UI renders no actions for it`,
    ),
  );
});

test("demo allowed-events segment is deterministic: two runs print byte-identical listing lines", async () => {
  const segment = (ls: string[]) => {
    const start = ls.indexOf(
      "Allowed events by state (allowedEvents over all 8 states):",
    );
    return ls.slice(start, start + 10);
  };
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + 8 state lines + the main-escrow line; every value is
  // derived from the transition table alone, so no normalization
  // is needed.
  assert.equal(segA.length, 10);
  assert.deepEqual(segA, segment(b.lines));
  assert.deepEqual(a.allowedEventsByState, b.allowedEventsByState);
  assert.deepEqual(a.mainEscrowAllowedEvents, b.mainEscrowAllowedEvents);
});

test("demo shows deposit provenance: traced amount matches the hand-pinned golden deposit and a no-FUND copy fails explicitly", async () => {
  const { escrow, report, tracedDepositAmount, noFundDepositError, lines } =
    await runDemo();
  const text = lines.join("\n");

  // Hand-pinned expectations — written out here from the main
  // escrow's fixed steps (one FUND entry, amount 10630) and from
  // settlementReport.ts's documented error wording, never derived
  // by calling depositAmountFromHistory itself.
  assert.equal(tracedDepositAmount, 10630);
  assert.equal(
    noFundDepositError,
    `settlement requires a FUND amount for ${DEMO_ESCROW_ID}: no FUND event in the audit history`,
  );
  // Cross-checks: an independent call on the escrow's own history
  // traces the same amount, it equals the settlement report's
  // deposit, and an independently built no-FUND copy throws the
  // same explicit error.
  assert.equal(depositAmountFromHistory(escrow.history, escrow.id), 10630);
  assert.equal(tracedDepositAmount, report.deposit.deposit);
  const handNoFund = escrow.history.filter((entry) => entry.event !== "FUND");
  assert.equal(handNoFund.length, 3);
  assert.throws(
    () => depositAmountFromHistory(handNoFund, escrow.id),
    (err: unknown) =>
      err instanceof Error && err.message === noFundDepositError,
  );
  // The escrow's own history is untouched by the copy: still 4
  // entries, its FUND amount still the golden 10630.
  assert.equal(escrow.history.length, 4);
  assert.equal(
    escrow.history.find((entry) => entry.event === "FUND")?.amount,
    10630,
  );
  // The segment follows the allowed-events listing, prints both
  // lines verbatim, and precedes the closing settlement-split
  // segment.
  const provenanceAt = text.indexOf(
    "Deposit provenance (depositAmountFromHistory on the main escrow history):",
  );
  assert.ok(
    provenanceAt >
      text.indexOf("Allowed events by state (allowedEvents over all 8 states):"),
    "deposit-provenance segment must follow the allowed-events listing",
  );
  assert.ok(
    provenanceAt <
      text.indexOf("Settlement split (settleRelease on the main escrow deposit):"),
    "deposit-provenance segment must precede the settlement-split segment",
  );
  assert.ok(
    text.includes(
      `  main escrow ${DEMO_ESCROW_ID}: depositAmountFromHistory -> 10630 (the sum of every FUND amount in the audit trail — matches the settlement report deposit 10630)`,
    ),
  );
  assert.ok(
    text.includes(
      `  no-FUND copy (3 entries, every FUND entry removed): depositAmountFromHistory FAILED — settlement requires a FUND amount for ${DEMO_ESCROW_ID}: no FUND event in the audit history (a history with no FUND event cannot corroborate a deposit, so settlement refuses rather than guessing)`,
    ),
  );
});

test("demo deposit-provenance segment is deterministic: two runs print byte-identical provenance lines", async () => {
  const segment = (ls: string[]) => {
    const start = ls.indexOf(
      "Deposit provenance (depositAmountFromHistory on the main escrow history):",
    );
    return ls.slice(start, start + 3);
  };
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + the traced-amount line + the FAILED line; every value
  // is derived from the fixed main history alone, so no
  // normalization is needed.
  assert.equal(segA.length, 3);
  assert.deepEqual(segA, segment(b.lines));
  assert.equal(a.tracedDepositAmount, b.tracedDepositAmount);
  assert.equal(a.noFundDepositError, b.noFundDepositError);
});

test("demo shows settlement split: settleRelease on the golden deposit conserves every part and matches the report", async () => {
  const { report, releaseSettlement, lines } = await runDemo();
  const text = lines.join("\n");

  // Hand-pinned expectations — written out here from settlement.ts's
  // documented arithmetic (proFee = round2(gross * bps / 10000);
  // net = round2(gross - proFee - referralCredits)) on the main
  // escrow's fixed inputs, never derived by calling settleRelease
  // itself. The same arithmetic is pinned at another scale by
  // economics.test.ts (1,000 at 500 bps -> proFee 50 / net 950) and
  // this same golden input is pinned by the bench fixture.
  assert.equal(DEMO_PRO_FEE_BPS, 500);
  assert.deepEqual(releaseSettlement, {
    gross: 10630,
    proFee: 531.5,
    referralCredits: 0,
    net: 10098.5,
  });
  // Conservation: every part of the deposit is accounted for — the
  // split parts sum back to the gross, which is the deposit itself.
  assert.equal(
    releaseSettlement.net +
      releaseSettlement.proFee +
      releaseSettlement.referralCredits,
    10630,
  );
  assert.equal(releaseSettlement.gross, report.deposit.deposit);
  // Independent cross-checks: a fresh call on the pinned inputs
  // reproduces the demo's split, the settlement embedded in the
  // main report is exactly this split, and its party rows carry
  // the same figures (creator = net, platform = proFee,
  // referrer = referralCredits).
  assert.deepEqual(
    settleRelease({ gross: 10630, proFeeBps: DEMO_PRO_FEE_BPS }),
    releaseSettlement,
  );
  assert.deepEqual(report.settlement, releaseSettlement);
  const byParty = Object.fromEntries(report.parties.map((p) => [p.party, p.net]));
  assert.equal(byParty.creator, releaseSettlement.net);
  assert.equal(byParty.platform, releaseSettlement.proFee);
  assert.equal(byParty.referrer, releaseSettlement.referralCredits);
  // The segment follows the deposit-provenance segment and precedes
  // the closing NDJSON round-trip segment, printing all three lines
  // verbatim.
  const splitAt = text.indexOf(
    "Settlement split (settleRelease on the main escrow deposit):",
  );
  assert.ok(
    splitAt >
      text.indexOf(
        "Deposit provenance (depositAmountFromHistory on the main escrow history):",
      ),
    "settlement-split segment must follow the deposit-provenance segment",
  );
  assert.ok(
    splitAt <
      text.indexOf(
        "Audit history NDJSON round-trip (historyToNdjson / historyFromNdjson on the main escrow history):",
      ),
    "settlement-split segment must precede the NDJSON round-trip segment",
  );
  assert.ok(
    text.includes(
      `  main escrow ${DEMO_ESCROW_ID}: settleRelease(gross 10630, proFeeBps 500, referralCredits 0) -> net 10098.5, proFee 531.5`,
    ),
  );
  assert.ok(
    text.includes(
      "  conservation: net 10098.5 + proFee 531.5 + referralCredits 0 = 10630 — equals gross 10630, the main escrow deposit (every part of the deposit is accounted for)",
    ),
  );
  assert.ok(
    text.includes(
      "  cross-check: the settlement report above is this same split — creator net 10098.5 (= net), platform net 531.5 (= proFee), referrer net 0 (= referralCredits)",
    ),
  );
});

test("demo settlement-split segment is deterministic: two runs print byte-identical split lines", async () => {
  const segment = (ls: string[]) => {
    const start = ls.indexOf(
      "Settlement split (settleRelease on the main escrow deposit):",
    );
    return ls.slice(start, start + 4);
  };
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + the split line + the conservation line + the
  // cross-check line; every value is derived from the fixed golden
  // deposit and fee rate alone, so no normalization is needed.
  assert.equal(segA.length, 4);
  assert.deepEqual(segA, segment(b.lines));
  assert.deepEqual(a.releaseSettlement, b.releaseSettlement);
});

test("demo shows history NDJSON round-trip: exported lines read back verbatim with a continuous seq chain", async () => {
  const {
    escrow,
    historyNdjson,
    historyNdjsonLineCount,
    historyNdjsonFirstLine,
    historyNdjsonRoundTripped,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-pinned expectations — written out here from the main
  // escrow's fixed steps (4 dispatches: FUND / SUBMIT_MILESTONE /
  // VERIFY_PASS / RELEASE), never derived by calling the NDJSON
  // functions themselves. The same export/import behaviour is
  // pinned independently by test/ndjson.test.ts.
  assert.equal(historyNdjsonLineCount, 4);
  assert.ok(historyNdjson.endsWith("\n"));
  assert.equal(historyNdjsonFirstLine, JSON.stringify(escrow.history[0]));
  const firstEntry = JSON.parse(historyNdjsonFirstLine) as {
    seq: number;
    event: string;
    from: string;
    to: string;
  };
  assert.deepEqual(
    [firstEntry.seq, firstEntry.event, firstEntry.from, firstEntry.to],
    [1, "FUND", "CREATED", "FUNDED"],
  );
  // Round-trip: same count, seq 1 -> 4 continuous, from/to chain
  // continuous, final entry lands in the escrow's RELEASED state,
  // and every entry matches the original history verbatim.
  assert.equal(historyNdjsonRoundTripped.length, 4);
  assert.deepEqual(
    historyNdjsonRoundTripped.map((e) => e.seq),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    historyNdjsonRoundTripped.map((e) => e.event),
    ["FUND", "SUBMIT_MILESTONE", "VERIFY_PASS", "RELEASE"],
  );
  for (const [i, entry] of historyNdjsonRoundTripped.entries()) {
    if (i > 0) assert.equal(entry.from, historyNdjsonRoundTripped[i - 1].to);
  }
  assert.equal(
    historyNdjsonRoundTripped[historyNdjsonRoundTripped.length - 1].to,
    "RELEASED",
  );
  assert.deepEqual(historyNdjsonRoundTripped, [...escrow.history]);
  // Independent cross-checks: fresh export/import calls reproduce
  // the demo's text and entries, and re-exporting the round-tripped
  // entries is byte-identical to the original export.
  assert.equal(historyToNdjson(escrow.history), historyNdjson);
  assert.deepEqual(historyFromNdjson(historyNdjson), historyNdjsonRoundTripped);
  assert.equal(historyToNdjson(historyNdjsonRoundTripped), historyNdjson);
  // The segment follows the settlement-split segment and prints
  // its lines verbatim; the overdue-judgement segment follows it
  // and the state-diagram and standalone-parsing segments follow
  // after that (their own tests pin the closing position).
  const ndjsonAt = text.indexOf(
    "Audit history NDJSON round-trip (historyToNdjson / historyFromNdjson on the main escrow history):",
  );
  assert.ok(
    ndjsonAt >
      text.indexOf("Settlement split (settleRelease on the main escrow deposit):"),
    "NDJSON round-trip segment must follow the settlement-split segment",
  );
  assert.ok(
    text.includes(
      `  main escrow ${DEMO_ESCROW_ID}: historyToNdjson -> 4 lines (one JSON entry per line, seq order, every line terminated)`,
    ),
  );
  assert.ok(text.includes(`  first line: ${historyNdjsonFirstLine}`));
  assert.ok(
    text.includes(
      "  historyFromNdjson -> 4 entries — round-trip identical: seq chain 1 -> 4 continuous, final entry lands in RELEASED, every entry matches the original history verbatim",
    ),
  );
  const reexportAt = lines.indexOf(
    "  re-export: historyToNdjson(round-tripped entries) reproduces the NDJSON text byte-for-byte",
  );
  assert.ok(reexportAt > 0, "NDJSON re-export line must be printed");
  assert.ok(
    reexportAt <
      lines.indexOf(
        "Overdue judgement (isOverdue on a funded escrow at three fixed instants):",
      ),
    "overdue-judgement segment must follow the NDJSON segment",
  );
});

test("demo history NDJSON segment is deterministic: two runs print byte-identical NDJSON lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf(
        "Audit history NDJSON round-trip (historyToNdjson / historyFromNdjson on the main escrow history):",
      ),
      ls.indexOf(
        "Overdue judgement (isOverdue on a funded escrow at three fixed instants):",
      ),
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + the export line + the first-line line + the round-trip
  // line + the re-export line + the blank separator before the
  // next segment; every value is derived from the fixed main
  // history alone, so no normalization is needed.
  assert.equal(segA.length, 6);
  assert.deepEqual(segA, segment(b.lines));
  assert.equal(a.historyNdjson, b.historyNdjson);
  assert.deepEqual(a.historyNdjsonRoundTripped, b.historyNdjsonRoundTripped);
});

test("demo shows overdue judgement: isOverdue false before, true at and after the deadline", async () => {
  const { overdueCheckEscrow, overdueChecks, lines } = await runDemo();
  const text = lines.join("\n");

  // Hand-pinned expectations — written out here from
  // src/stateMachine.ts (`now >= deadline` for a non-terminal
  // escrow with a deadline), never derived by calling isOverdue
  // to produce them. test/deadline.test.ts pins the same boundary
  // independently: now exactly at the deadline counts as overdue.
  assert.deepEqual(overdueChecks, [
    { at: DEMO_OVERDUE_CHECK_BEFORE_AT, overdue: false },
    { at: DEMO_OVERDUE_CHECK_AT_DEADLINE, overdue: true },
    { at: DEMO_OVERDUE_CHECK_AFTER_AT, overdue: true },
  ]);
  assert.equal(overdueCheckEscrow.id, DEMO_OVERDUE_CHECK_ESCROW_ID);
  assert.equal(overdueCheckEscrow.state, "FUNDED");
  assert.equal(overdueCheckEscrow.getDeadline(), DEMO_OVERDUE_CHECK_DEADLINE);
  assert.equal(overdueCheckEscrow.history.length, 1);
  // Independent cross-checks: fresh isOverdue calls on the demo's
  // escrow reproduce the three verdicts at the same instants.
  for (const { at, overdue } of overdueChecks) {
    assert.equal(isOverdue(overdueCheckEscrow, new Date(at)), overdue);
  }
  // The segment follows the NDJSON segment and prints its lines
  // verbatim; the state-diagram segment follows it, then the
  // standalone-parsing segment, and the event-sourced rebuild
  // segment now closes the demo after those (their own tests
  // pin the closing position).
  const overdueAt = text.indexOf(
    "Overdue judgement (isOverdue on a funded escrow at three fixed instants):",
  );
  assert.ok(
    overdueAt >
      text.indexOf(
        "Audit history NDJSON round-trip (historyToNdjson / historyFromNdjson on the main escrow history):",
      ),
    "overdue-judgement segment must follow the NDJSON segment",
  );
  assert.ok(
    text.includes(
      `  escrow ${DEMO_OVERDUE_CHECK_ESCROW_ID}: state FUNDED, deadline ${DEMO_OVERDUE_CHECK_DEADLINE} — isOverdue is advisory only (it reads the escrow, dispatches nothing)`,
    ),
  );
  assert.ok(
    text.includes(
      `  before deadline (${DEMO_OVERDUE_CHECK_BEFORE_AT}): isOverdue -> false`,
    ),
  );
  assert.ok(
    text.includes(
      `  at deadline (${DEMO_OVERDUE_CHECK_AT_DEADLINE}): isOverdue -> true (boundary: now >= deadline counts as overdue)`,
    ),
  );
  assert.ok(
    text.includes(
      `  after deadline (${DEMO_OVERDUE_CHECK_AFTER_AT}): isOverdue -> true`,
    ),
  );
  const unchangedAt = lines.indexOf(
    "  escrow unchanged after the three judgements: still FUNDED (1 history entry) — a watchdog dispatches EXPIRE explicitly",
  );
  assert.ok(unchangedAt > 0, "overdue unchanged line must be printed");
  assert.ok(
    lines.indexOf(
      "State diagram generation (stateDiagram from the transition table):",
    ) > unchangedAt,
    "state-diagram segment must follow the overdue-judgement segment",
  );
});

test("demo overdue-judgement segment is deterministic: two runs print byte-identical judgement lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf(
        "Overdue judgement (isOverdue on a funded escrow at three fixed instants):",
      ),
      ls.indexOf(
        "State diagram generation (stateDiagram from the transition table):",
      ) - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + the escrow line + the three judgement lines + the
  // unchanged line; every value is derived from the fixed
  // deadline and fixed instants alone, so no normalization is
  // needed.
  assert.equal(segA.length, 6);
  assert.deepEqual(segA, segment(b.lines));
  assert.deepEqual(a.overdueChecks, b.overdueChecks);
});

test("demo is deterministic: two runs produce identical lines", async () => {
  assert.deepEqual((await runDemo()).lines, (await runDemo()).lines);
});

test("compiled demo script exits 0 and prints the chain, history, report, and webhook", async () => {
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
  // Retry-After tail of the webhook story: the sender-side parsing
  // segment prints both hint forms normalized against the fixed now.
  assert.match(out, /Retry-After parsing \(parseRetryAfter on a fixed clock\):/);
  assert.ok(out.includes('  parseRetryAfter(" 30 ") -> 30000'));
  assert.ok(
    out.includes('  parseRetryAfter("Fri, 06 Mar 2026 08:17:05 GMT") -> 5000'),
  );
  assert.ok(out.includes("  parseRetryAfter(null) -> undefined"));
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
  // Fan-out tail: the main report is delivered to the three fixed
  // endpoints through the fake fetch — all delivered, none failed.
  assert.match(
    out,
    /Settlement webhook fan-out \(deliverSettlementWebhookToMany via fake fetch, zero network\):/,
  );
  assert.ok(
    out.includes(
      `  ${DEMO_FANOUT_ENDPOINTS[0].url}: ok true — attempts 1, status 200`,
    ),
  );
  assert.ok(
    out.includes(
      `  fan-out: 3 endpoints, 3 delivered, 0 failed — every endpoint received byte-identical body bytes, each signature verifies under its own endpoint's secret only`,
    ),
  );
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
  // Allowed-events tail: the listing prints every state in
  // transition-table order, the terminal states as (none — terminal),
  // and the main escrow's own empty set on its own line.
  assert.match(out, /Allowed events by state \(allowedEvents over all 8 states\):/);
  assert.ok(out.includes("  CREATED              -> FUND, EXPIRE"));
  assert.ok(
    out.includes(
      "  MILESTONE_SUBMITTED  -> VERIFY_PASS, VERIFY_FAIL, DISPUTE, EXPIRE",
    ),
  );
  assert.ok(out.includes("  RELEASED             -> (none — terminal)"));
  assert.ok(
    out.includes(
      `main escrow ${DEMO_ESCROW_ID} (RELEASED): allowedEvents -> (none) — a terminal escrow offers no further events, so an escrow-list UI renders no actions for it`,
    ),
  );
  // Deposit-provenance tail: that segment traces the golden
  // deposit out of the main history alone and shows the no-FUND
  // copy's explicit failure.
  assert.match(
    out,
    /Deposit provenance \(depositAmountFromHistory on the main escrow history\):/,
  );
  assert.ok(
    out.includes(
      `  main escrow ${DEMO_ESCROW_ID}: depositAmountFromHistory -> 10630 (the sum of every FUND amount in the audit trail — matches the settlement report deposit 10630)`,
    ),
  );
  assert.ok(
    out.includes(
      `no-FUND copy (3 entries, every FUND entry removed): depositAmountFromHistory FAILED — settlement requires a FUND amount for ${DEMO_ESCROW_ID}: no FUND event in the audit history (a history with no FUND event cannot corroborate a deposit, so settlement refuses rather than guessing)`,
    ),
  );
  // Settlement-split tail: that segment splits the golden
  // deposit with settleRelease in isolation and prints the
  // conservation sum back to the gross and the report cross-check.
  assert.match(
    out,
    /Settlement split \(settleRelease on the main escrow deposit\):/,
  );
  assert.ok(
    out.includes(
      `  main escrow ${DEMO_ESCROW_ID}: settleRelease(gross 10630, proFeeBps 500, referralCredits 0) -> net 10098.5, proFee 531.5`,
    ),
  );
  assert.ok(
    out.includes(
      "  conservation: net 10098.5 + proFee 531.5 + referralCredits 0 = 10630 — equals gross 10630, the main escrow deposit (every part of the deposit is accounted for)",
    ),
  );
  assert.ok(
    out.includes(
      "cross-check: the settlement report above is this same split — creator net 10098.5 (= net), platform net 531.5 (= proFee), referrer net 0 (= referralCredits)",
    ),
  );
  // NDJSON round-trip tail: that segment exports the main
  // history as NDJSON and reads it back verbatim.
  assert.match(
    out,
    /Audit history NDJSON round-trip \(historyToNdjson \/ historyFromNdjson on the main escrow history\):/,
  );
  assert.ok(
    out.includes(
      `  main escrow ${DEMO_ESCROW_ID}: historyToNdjson -> 4 lines (one JSON entry per line, seq order, every line terminated)`,
    ),
  );
  assert.ok(
    out.includes(
      "  historyFromNdjson -> 4 entries — round-trip identical: seq chain 1 -> 4 continuous, final entry lands in RELEASED, every entry matches the original history verbatim",
    ),
  );
  assert.ok(
    out.includes(
      "  re-export: historyToNdjson(round-tripped entries) reproduces the NDJSON text byte-for-byte",
    ),
  );
  // Overdue-judgement tail: the closing segment judges a funded
  // escrow at three fixed instants — before (false), exactly at
  // the deadline (true), after (true) — and ends on the
  // escrow-unchanged line.
  assert.match(
    out,
    /Overdue judgement \(isOverdue on a funded escrow at three fixed instants\):/,
  );
  assert.ok(
    out.includes(
      `  before deadline (${DEMO_OVERDUE_CHECK_BEFORE_AT}): isOverdue -> false`,
    ),
  );
  assert.ok(
    out.includes(
      `  at deadline (${DEMO_OVERDUE_CHECK_AT_DEADLINE}): isOverdue -> true (boundary: now >= deadline counts as overdue)`,
    ),
  );
  assert.ok(
    out.includes(
      `  after deadline (${DEMO_OVERDUE_CHECK_AFTER_AT}): isOverdue -> true`,
    ),
  );
  assert.ok(
    out.includes(
      "escrow unchanged after the three judgements: still FUNDED (1 history entry) — a watchdog dispatches EXPIRE explicitly",
    ),
  );
  // State-diagram tail: that segment renders the
  // transition table as the README's Mermaid block and prints
  // its summary, ending on the closing-fence line.
  assert.match(
    out,
    /State diagram generation \(stateDiagram from the transition table\):/,
  );
  assert.ok(
    out.includes(
      "  stateDiagram(): 21 lines, 14 edges (generated from transitionTable() — the Mermaid block the README embeds verbatim)",
    ),
  );
  assert.ok(out.includes("  initial transition (line 3): [*] --> CREATED"));
  assert.ok(
    out.includes("  first edge (line 4): CREATED --> FUNDED : FUND"),
  );
  assert.ok(
    out.includes(
      "  last edge (line 17): DISPUTED --> REFUNDED : ARBITRATE_REFUND",
    ),
  );
  assert.ok(out.includes("  last line: ```"));
  // README diagram sync check tail: the segment after the
  // state-diagram segment reports the readmeDiagramInSync()
  // verdict — true, with the checked file and the CLI
  // equivalent printed.
  assert.match(
    out,
    /README diagram sync check \(readmeDiagramInSync on this repo's README\):/,
  );
  assert.ok(
    out.includes(
      "  readmeDiagramInSync(): true (README.md embeds the exact stateDiagram() block generated above — no diagram drift)",
    ),
  );
  assert.ok(
    out.includes(
      "  CLI equivalent: node dist/src/diagram.js --check (exit 0 in sync, exit 1 on drift — the same check test/diagram.test.ts runs)",
    ),
  );
  // Standalone history-parsing tail: the closing segment parses
  // the main history back on its own — the intact parse lands in
  // RELEASED and the tampered copy is rejected with the explicit
  // hash-chain error. The event-sourced rebuild tail follows,
  // and the snapshot round-trip tail then closes the demo.
  assert.match(
    out,
    /Standalone history parsing \(parseEscrowHistory on the main escrow history\):/,
  );
  assert.ok(
    out.includes(
      `  main escrow ${DEMO_ESCROW_ID}: history serialized to JSON, parsed standalone (no Escrow instance) -> 4 entries, final entry lands in RELEASED (seq 4 RELEASE VERIFIED -> RELEASED)`,
    ),
  );
  assert.ok(
    out.includes(
      `  tampered copy: entry seq ${DEMO_PARSED_HISTORY_TAMPERED_SEQ} (SUBMIT_MILESTONE) note rewritten — parseEscrowHistory FAILED — ${DEMO_PARSED_HISTORY_TAMPER_ERROR}`,
    ),
  );
  assert.ok(
    out.includes(
      "  original history after the tamper check: parseEscrowHistory still returns 4 entries (detached copy — the escrow's own history is untouched)",
    ),
  );
  // Event-sourced rebuild tail: that segment rebuilds the
  // main escrow from its history alone — deadline NOT
  // restored, the bare-history trade-off.
  assert.match(
    out,
    /Event-sourced rebuild \(Escrow\.fromHistory on the main escrow history\):/,
  );
  assert.ok(
    out.includes(
      `  main escrow ${DEMO_ESCROW_ID}: Escrow.fromHistory(id, history) -> rebuilt escrow in state RELEASED with 4 history entries (history alone — no snapshot envelope)`,
    ),
  );
  assert.ok(
    out.includes(
      `  deadline NOT restored: main escrow deadline is ${DEMO_REBUILT_DEADLINE}, rebuilt escrow deadline is undefined — a bare history carries no deadline (nor the consumed idempotency keys); use fromJSON when those must survive`,
    ),
  );
  assert.ok(
    out.includes(
      `  original escrow after the rebuild: still RELEASED with its deadline ${DEMO_REBUILT_DEADLINE} intact (the rebuild reads the history and dispatches nothing)`,
    ),
  );
  // Snapshot round-trip tail: that segment exports
  // the main escrow with toJSON and restores it with
  // fromJSON — the deadline IS restored, the envelope
  // contrast.
  assert.match(
    out,
    /Snapshot round-trip \(Escrow\.toJSON \/ Escrow\.fromJSON on the main escrow\):/,
  );
  assert.ok(
    out.includes(
      `  main escrow ${DEMO_ESCROW_ID}: toJSON() -> snapshot v 1 (id + state + 4 history entries + deadline) serialized to ${DEMO_SNAPSHOT_SERIALIZED_BYTES} bytes — the persistence envelope a document store keeps`,
    ),
  );
  assert.ok(
    out.includes(
      `  Escrow.fromJSON(parsed snapshot) -> restored escrow in state RELEASED with 4 history entries — state and every entry identical to the original verbatim`,
    ),
  );
  assert.ok(
    out.includes(
      `  deadline restored: main escrow deadline is ${DEMO_REBUILT_DEADLINE}, restored escrow deadline is ${DEMO_REBUILT_DEADLINE} — the envelope carries the deadline (and the consumed idempotency keys) that a bare history cannot`,
    ),
  );
  assert.ok(
    out.includes(
      `  original escrow after the round-trip: still RELEASED with its deadline ${DEMO_REBUILT_DEADLINE} intact (the round-trip reads the escrow and dispatches nothing)`,
    ),
  );
  // Machine-readable transition-table segment: it
  // serializes the same transition table as canonical
  // JSON — the form a caller feeds to static validation
  // or code generation.
  assert.match(
    out,
    /Machine-readable transition table \(transitionTableJson from the transition table\):/,
  );
  assert.ok(
    out.includes(
      "  transitionTableJson(): 1160 bytes, 14 edges (canonical JSON — the machine-readable form of the same table stateDiagram() renders for humans, byte-identical to the committed transition-table snapshot)",
    ),
  );
  assert.ok(
    out.includes(
      "  parsed back: 14 edges, every (from, event, to) triple matches transitionTable() edge for edge",
    ),
  );
  assert.ok(out.includes("  first edge: CREATED --FUND--> FUNDED"));
  assert.ok(out.includes("  last edge: DISPUTED --ARBITRATE_REFUND--> REFUNDED"));
  // Money-guard tail: the segment runs the shared amount
  // boundary check over its fixed legal corpus and its
  // illegal pair.
  assert.match(
    out,
    /Money guard \(assertNonNegativeMoney on the shared amount boundary\):/,
  );
  assert.ok(
    out.includes(
      "  accepted: 0, 0.01, 10630, 1000000.25 — every legal amount passes without throwing (zero, a cent, the golden deposit, a large amount with cents)",
    ),
  );
  assert.ok(
    out.includes(
      '  rejected: -1 -> "amount must be a finite non-negative number"',
    ),
  );
  assert.ok(
    out.includes(
      '  rejected: NaN -> "amount must be a finite non-negative number"',
    ),
  );
  // Subscription tail: that segment fans two fixed
  // dispatches out to a collecting listener, unsubscribes
  // it, and prints the zero-new-notifications line after
  // one further dispatch.
  assert.match(
    out,
    /Subscription notifications \(Escrow\.subscribe on a branch escrow\):/,
  );
  assert.ok(
    out.includes("  notification 1: FUND CREATED -> FUNDED (entry seq 1)"),
  );
  assert.ok(
    out.includes(
      "  notification 2: SUBMIT_MILESTONE FUNDED -> MILESTONE_SUBMITTED (entry seq 2)",
    ),
  );
  assert.ok(
    out.includes(
      "  listener received after unsubscribe: 2 notification(s) (unchanged — VERIFY_PASS produced no new notification)",
    ),
  );
  // Deadline-clearing tail: that segment clears a fixed
  // past deadline (overdue true -> false, deadline read
  // back undefined) and shows the no-deadline clear as a
  // no-op.
  assert.match(out, /Deadline clearing \(clearDeadline on funded escrows\):/);
  assert.ok(
    out.includes(
      `  escrow ${DEMO_CLEAR_DEADLINE_ESCROW_ID}: state FUNDED, deadline ${DEMO_CLEAR_DEADLINE_DEADLINE} — at ${DEMO_CLEAR_DEADLINE_CHECK_AT} isOverdue -> true (past the deadline, non-terminal)`,
    ),
  );
  assert.ok(
    out.includes(
      `  after clearDeadline(): getDeadline() -> undefined, isOverdue at ${DEMO_CLEAR_DEADLINE_CHECK_AT} -> false (deadline removed — clearing dispatches nothing, escrow still FUNDED)`,
    ),
  );
  assert.ok(
    out.includes(
      `  escrow ${DEMO_CLEAR_DEADLINE_NO_DEADLINE_ESCROW_ID} (no deadline set): clearDeadline() is a no-op — getDeadline() -> undefined, isOverdue at ${DEMO_CLEAR_DEADLINE_CHECK_AT} -> false, state still FUNDED (1 history entry)`,
    ),
  );
  // Approval-log tail: that segment prints the
  // dispute quorum's full audit trail in record order and
  // the expiry contrast (count drops, trail retained);
  // the single-target delivery segment then closes the demo.
  assert.match(out, /Quorum approval log \(approvalLog audit trail\):/);
  assert.ok(
    out.includes(
      `  approval 1: ${DEMO_DISPUTE_APPROVAL_LOG_ENTRIES[0].signerId} at ${DEMO_DISPUTE_APPROVAL_LOG_ENTRIES[0].at}`,
    ),
  );
  assert.ok(
    out.includes(
      `  approval 2: ${DEMO_DISPUTE_APPROVAL_LOG_ENTRIES[1].signerId} at ${DEMO_DISPUTE_APPROVAL_LOG_ENTRIES[1].at}`,
    ),
  );
  assert.ok(
    out.includes(
      `  at ${DEMO_APPROVAL_LOG_CHECK_AT} the first vote is 60001 ms old — past the window: approvalCount 1, hasQuorum: false`,
    ),
  );
  assert.ok(
    out.includes(
      "  approvalLog() after expiry: 2 entries retained (arb-1, arb-2) — expiry never deletes the audit trail; only revoke() removes a signer's entries",
    ),
  );
  // Single-target delivery tail: that segment delivers
  // the main webhook alone through a scripted fake fetch —
  // 500 then 200, success after exactly one retry, the
  // captured signature verified over the wire body.
  assert.match(
    out,
    /Single-target webhook delivery \(deliverSettlementWebhook via scripted fake fetch, zero network\):/,
  );
  assert.ok(
    out.includes(
      `  endpoint: ${DEMO_SINGLE_DELIVERY_URL} — the main escrow's signed webhook (eventId ${DEMO_WEBHOOK_EVENT_ID}) delivered alone, the single-endpoint entry point under the fan-out wrapper`,
    ),
  );
  assert.ok(
    out.includes(
      "  attempt 1: scripted 500 (retryable 5xx) — attempt 2: scripted 200; result: status 200, attempts 2 (succeeded after exactly one retry, backoffMs 0 — no real waiting)",
    ),
  );
  assert.ok(
    out.includes(
      "  wire check: 2 captured POSTs, bodies byte-identical across attempts and equal to the signed payload body; the X-Signature the endpoint received verifies over the captured body: verifySettlementWebhook: ok",
    ),
  );
  // 429 Retry-After delivery tail: that segment runs
  // the rate-limit retry path end to end — scripted 429
  // with the pinned hint, parsed then clamped to a zero
  // wait by maxRetryDelayMs 0, scripted 200 on the retry.
  assert.match(
    out,
    /429 Retry-After webhook delivery \(deliverSettlementWebhook via scripted fake fetch, zero network\):/,
  );
  assert.ok(
    out.includes(
      `  attempt 1: scripted 429 with Retry-After: ${DEMO_RETRY_AFTER_DELIVERY_HINT} (parseRetryAfter -> ${DEMO_RETRY_AFTER_DELIVERY_HINT_MS} ms) — attempt 2: scripted 200; result: status 200, attempts 2`,
    ),
  );
  assert.ok(
    out.includes(
      "  wire check: 2 captured POSTs, bodies byte-identical across attempts and equal to the signed payload body; the X-Signature the endpoint received on the re-delivery verifies over the captured body: verifySettlementWebhook: ok",
    ),
  );
  // Dedupe snapshot tail: that segment persists a
  // fresh dedupe across a simulated restart — two ids new
  // then duplicate, snapshot exported (version + count
  // only), restored counters at zero with both ids still
  // duplicates, and the v:2 copy rejected.
  assert.match(
    out,
    /Dedupe snapshot persistence \(SettlementEventDedupe exportSnapshot \/ restore across a restart\):/,
  );
  assert.ok(
    out.includes(
      `  exportSnapshot(): v 1, ${DEMO_DEDUPE_SNAPSHOT_ENTRIES.length} entries — only the version and entry count are printed, never the full entries (persist the JSON before shutdown)`,
    ),
  );
  assert.ok(
    out.includes(
      "  after JSON round-trip + SettlementEventDedupe.restore(): stats size 2, hits 0, misses 0, evictions 0 — counters restart at zero, the recorded ids do not",
    ),
  );
  assert.ok(
    out.includes(
      `  tampered snapshot rejected: a detached copy with v changed to 2 throws "${DEMO_DEDUPE_SNAPSHOT_TAMPERED_ERROR}" — a corrupt snapshot fails loudly at startup instead of silently disabling deduplication`,
    ),
  );
  // Dedupe clear segment: the segment after the snapshot
  // segment resets a fresh dedupe with clear() — one id
  // new then duplicate with pinned stats, size and stats
  // all zero after the clear, the same id new again.
  assert.match(
    out,
    /Dedupe clear reset \(SettlementEventDedupe\.clear\(\) — explicit window reset\):/,
  );
  assert.ok(
    out.includes(
      "  clear(): size 0 — stats size 0, hits 0, misses 0, evictions 0 (every recorded id dropped, every counter reset to zero)",
    ),
  );
  assert.ok(
    out.includes(
      `  same eventId after clear — checkAndRecord: false (new event again, recorded — the reset reopened the window on purpose); stats after re-record: size 1, hits 0, misses 1, evictions 0 (counting restarts from zero)`,
    ),
  );
  // Subscribe onError tail: that segment routes a
  // throwing listener's errors to onError — 3 reports with
  // dispatch contexts, a throwing onError swallowed on the
  // probe escrow, and a non-function onError rejected.
  assert.match(
    out,
    /Subscribe onError error routing \(Escrow\.subscribe\(listener, \{ onError \}\) on a branch escrow\):/,
  );
  assert.ok(
    out.includes(
      `  onError received: 3 report(s) — first: "${DEMO_ONERROR_LISTENER_ERROR}" on FUND CREATED -> FUNDED (the error travels with its dispatch context)`,
    ),
  );
  assert.ok(
    out.includes(
      "  all contexts: FUND CREATED -> FUNDED; SUBMIT_MILESTONE FUNDED -> MILESTONE_SUBMITTED; VERIFY_PASS MILESTONE_SUBMITTED -> VERIFIED",
    ),
  );
  assert.ok(
    out.includes(
      `  non-function onError rejected at subscribe time: "${DEMO_ONERROR_INVALID_ERROR}" — nothing was registered (listenerCount still 1)`,
    ),
  );
  // Quorum revoke tail: the segment revokes one
  // vote (count drops below threshold), re-approves it
  // (threshold restored, re-voter last), and rejects an
  // unknown signer and a never-approved signer.
  assert.match(out, /Quorum revoke \(Quorum\.revoke\(\) — a signer changes their vote\):/);
  assert.ok(
    out.includes(
      `  revoke ${DEMO_QUORUM_SIGNERS[0]}: approvalCount 1, hasQuorum: false — approvals now [${DEMO_QUORUM_SIGNERS[1]}], approvalLog keeps 1 entry (revoke removes the signer's entries; expiry never does)`,
    ),
  );
  // AbortSignal tail: that segment aborts one
  // delivery before it starts and another during its
  // backoff sleep.
  assert.match(out, /Webhook delivery abort \(deliverSettlementWebhook with an AbortSignal, scripted fake fetch, zero network\):/);
  assert.ok(
    out.includes(
      "  an abort is a caller request to stop, never a retryable failure: neither shape retries, sleeps it off, or reports success",
    ),
  );
  // expectedSeq tail: that segment drives a branch
  // escrow through the optimistic-concurrency guard —
  // matching pins advance, a stale pin is refused,
  // invalid pins are refused, and an unguarded dispatch
  // is unchanged.
  assert.match(out, /Optimistic concurrency \(dispatch expectedSeq guard on a branch escrow\):/);
  assert.ok(
    out.includes(
      `  escrow ${DEMO_EXPECTED_SEQ_ESCROW_ID}: FUND with expectedSeq 0 (the empty history): -> FUNDED, seq 0 -> 1 (a matching guard advances exactly one entry)`,
    ),
  );
  assert.ok(
    out.includes(
      `  VERIFY_PASS retried with stale expectedSeq 1 (a second writer still holding the seq-1 snapshot): throws "${DEMO_EXPECTED_SEQ_STALE_ERROR}" — state stays MILESTONE_SUBMITTED, history stays 2 entries (nothing appended, nothing overwritten)`,
    ),
  );
  assert.ok(
    out.includes(
      "  VERIFY_PASS without expectedSeq: -> VERIFIED, seq 2 -> 3 (omitting the guard preserves the pre-guard behavior)",
    ),
  );
  // verifyEvidence tail: the closing segment drives
  // two branch escrows through the evidence gate — an
  // evidence-free VERIFY_PASS is refused on the strict
  // escrow, the same dispatch with evidence passes,
  // and a default escrow is unchanged; the demo ends
  // on the pre-gate-behavior line.
  assert.match(out, /Verify evidence gate \(EscrowOptions\.requireVerifyEvidence on branch escrows\):/);
  assert.ok(
    out.includes(
      `  VERIFY_PASS without evidence: throws "${DEMO_VERIFY_EVIDENCE_ERROR}" — state stays MILESTONE_SUBMITTED, history stays 2 entries (nothing appended)`,
    ),
  );
  assert.ok(
    out.includes(
      `  VERIFY_PASS with evidence "${DEMO_VERIFY_EVIDENCE_REF}": -> VERIFIED, evidence recorded verbatim on the audit entry (the library records the caller's reference; it does not verify the oracle or proof itself)`,
    ),
  );
  assert.ok(
    out
      .trimEnd()
      .endsWith(
        `  escrow ${DEMO_VERIFY_EVIDENCE_DEFAULT_ESCROW_ID} (default, flag off): VERIFY_PASS without evidence -> VERIFIED (omitting the flag preserves the pre-gate behavior)`,
      ),
  );
});

test("demo shows the state diagram generation segment in-process: the generated block matches the hand-written diagram line by line", async () => {
  const { stateDiagramText, stateDiagramEdgeCount, lines } = await runDemo();
  const text = lines.join("\n");

  // Hand-written expectations — the full 21-line Mermaid block
  // written out here line by line from TRANSITIONS in
  // src/stateMachine.ts, never derived by calling stateDiagram
  // itself. test/diagram.test.ts and the bench stateDiagram
  // fixture pin the same shape independently.
  const EXPECTED_LINES = [
    "```mermaid",
    "stateDiagram-v2",
    "    [*] --> CREATED",
    "    CREATED --> FUNDED : FUND",
    "    CREATED --> EXPIRED : EXPIRE",
    "    FUNDED --> FUNDED : FUND",
    "    FUNDED --> MILESTONE_SUBMITTED : SUBMIT_MILESTONE",
    "    FUNDED --> DISPUTED : DISPUTE",
    "    FUNDED --> EXPIRED : EXPIRE",
    "    MILESTONE_SUBMITTED --> VERIFIED : VERIFY_PASS",
    "    MILESTONE_SUBMITTED --> DISPUTED : VERIFY_FAIL",
    "    MILESTONE_SUBMITTED --> DISPUTED : DISPUTE",
    "    MILESTONE_SUBMITTED --> EXPIRED : EXPIRE",
    "    VERIFIED --> RELEASED : RELEASE",
    "    VERIFIED --> DISPUTED : DISPUTE",
    "    DISPUTED --> RELEASED : ARBITRATE_RELEASE",
    "    DISPUTED --> REFUNDED : ARBITRATE_REFUND",
    "    RELEASED --> [*]",
    "    REFUNDED --> [*]",
    "    EXPIRED --> [*]",
    "```",
  ];
  assert.deepEqual(stateDiagramText.split("\n"), EXPECTED_LINES);
  // The shape the backlog pins: first line is the mermaid fence,
  // the block carries the stateDiagram-v2 header, and the edge
  // count equals the transition table's edge count.
  assert.equal(stateDiagramText.split("\n")[0], "```mermaid");
  assert.ok(stateDiagramText.includes("stateDiagram-v2"));
  assert.equal(stateDiagramEdgeCount, 14);
  assert.equal(stateDiagramEdgeCount, transitionTable().length);
  // Cross-check against the library generator itself — the demo
  // segment is not self-certifying.
  assert.equal(stateDiagramText, stateDiagram());
  // The segment follows the overdue-judgement segment and
  // prints its summary lines verbatim; the standalone
  // history-parsing segment follows it and the event-sourced
  // rebuild segment now closes the demo after that (their own
  // tests pin the closing position).
  const diagramAt = text.indexOf(
    "State diagram generation (stateDiagram from the transition table):",
  );
  assert.ok(
    diagramAt >
      text.indexOf(
        "Overdue judgement (isOverdue on a funded escrow at three fixed instants):",
      ),
    "state-diagram segment must follow the overdue-judgement segment",
  );
  for (const line of [
    "  stateDiagram(): 21 lines, 14 edges (generated from transitionTable() — the Mermaid block the README embeds verbatim)",
    "  first line: ```mermaid",
    "  second line: stateDiagram-v2",
    "  initial transition (line 3): [*] --> CREATED",
    "  first edge (line 4): CREATED --> FUNDED : FUND",
    "  last edge (line 17): DISPUTED --> REFUNDED : ARBITRATE_REFUND",
    "  terminal lines (lines 18-20): RELEASED --> [*], REFUNDED --> [*], EXPIRED --> [*]",
  ]) {
    assert.ok(text.includes(line), `missing diagram line: ${line}`);
  }
  assert.ok(text.includes("  last line: ```"));
  assert.ok(
    lines.indexOf(
      "Standalone history parsing (parseEscrowHistory on the main escrow history):",
    ) >
      lines.indexOf(
        "State diagram generation (stateDiagram from the transition table):",
      ),
    "standalone history-parsing segment must follow the state-diagram segment",
  );
});

test("demo state diagram generation segment is deterministic: two runs print byte-identical diagram lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf(
        "State diagram generation (stateDiagram from the transition table):",
      ),
      ls.indexOf(
        "README diagram sync check (readmeDiagramInSync on this repo's README):",
      ) - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + total / first / second / initial / first-edge /
  // last-edge / terminal / last lines; every value is derived
  // from the transition table alone, so no normalization is
  // needed.
  assert.equal(segA.length, 9);
  assert.deepEqual(segA, segment(b.lines));
  assert.equal(a.stateDiagramText, b.stateDiagramText);
  assert.equal(a.stateDiagramEdgeCount, b.stateDiagramEdgeCount);
});

test("demo shows README diagram sync check: readmeDiagramInSync reports true for this repo's README", async () => {
  const result = await runDemo();
  const text = result.lines.join("\n");

  // Hand-pinned expectation — written out here from the state
  // test/diagram.test.ts pins independently (the README embeds
  // the exact generated diagram; the CLI --check form of the
  // same function requires the in-sync outcome), never derived
  // by calling readmeDiagramInSync to produce it.
  assert.equal(result.readmeDiagramInSync, true);
  // Independent cross-check: calling the library function
  // directly reproduces the same verdict — the demo segment
  // is not self-certifying.
  assert.equal(readmeDiagramInSync(), true);
  // The segment follows the state-diagram segment and precedes
  // the standalone history-parsing segment; it prints its
  // lines verbatim, and its CLI-equivalent line is the
  // segment's last line.
  const syncAt = text.indexOf(
    "README diagram sync check (readmeDiagramInSync on this repo's README):",
  );
  assert.ok(
    syncAt >
      text.indexOf(
        "State diagram generation (stateDiagram from the transition table):",
      ),
    "README sync segment must follow the state-diagram segment",
  );
  assert.equal(
    result.lines.indexOf(
      "Standalone history parsing (parseEscrowHistory on the main escrow history):",
    ),
    result.lines.indexOf(
      "  CLI equivalent: node dist/src/diagram.js --check (exit 0 in sync, exit 1 on drift — the same check test/diagram.test.ts runs)",
    ) + 2,
  );
  for (const line of [
    "  readmeDiagramInSync(): true (README.md embeds the exact stateDiagram() block generated above — no diagram drift)",
    "  checked file: README.md (this repo only — the sole file read by the check; no network, no wall clock)",
    "  if drifted: run `npm run diagram`, paste the generated block into README.md, and re-run — the demo fails here until the README matches the code again",
    "  CLI equivalent: node dist/src/diagram.js --check (exit 0 in sync, exit 1 on drift — the same check test/diagram.test.ts runs)",
  ]) {
    assert.ok(text.includes(line), `missing README sync line: ${line}`);
  }
});

test("demo README diagram sync check segment is deterministic: two runs print byte-identical sync lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf(
        "README diagram sync check (readmeDiagramInSync on this repo's README):",
      ),
      ls.indexOf(
        "Standalone history parsing (parseEscrowHistory on the main escrow history):",
      ) - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + verdict / checked-file / if-drifted / CLI lines;
  // the verdict is read from this repo's committed README
  // alone, so no normalization is needed.
  assert.equal(segA.length, 5);
  assert.deepEqual(segA, segment(b.lines));
  assert.equal(a.readmeDiagramInSync, b.readmeDiagramInSync);
});

test("demo shows standalone history parsing: serialized history parses back verbatim and a tampered middle entry is rejected", async () => {
  const { escrow, parsedHistoryEntries, parsedHistoryTamperError, lines } =
    await runDemo();
  const text = lines.join("\n");

  // Hand-pinned expectations — written out here from the main
  // escrow's fixed steps (4 dispatches: FUND / SUBMIT_MILESTONE /
  // VERIFY_PASS / RELEASE), never derived by calling
  // parseEscrowHistory to produce them. The same parser is
  // pinned independently by test/historyParserFuzz.test.ts.
  assert.equal(parsedHistoryEntries.length, 4);
  assert.deepEqual(
    parsedHistoryEntries.map((e) => e.seq),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    parsedHistoryEntries.map((e) => e.event),
    ["FUND", "SUBMIT_MILESTONE", "VERIFY_PASS", "RELEASE"],
  );
  assert.equal(parsedHistoryEntries.at(-1)?.to, "RELEASED");
  assert.deepEqual(parsedHistoryEntries, [...escrow.history]);
  // The tamper target is the middle entry, seq 2, and the error
  // is the parser's exact hash-chain-broken message.
  assert.equal(DEMO_PARSED_HISTORY_TAMPERED_SEQ, 2);
  assert.equal(parsedHistoryTamperError, DEMO_PARSED_HISTORY_TAMPER_ERROR);
  assert.equal(
    DEMO_PARSED_HISTORY_TAMPER_ERROR,
    "invalid snapshot: history hash chain is broken (an entry was tampered with, deleted, or reordered)",
  );
  // Independent cross-checks: a fresh standalone parse of the
  // serialized history reproduces the demo's entries, the same
  // tamper (rewritten note on seq 2) throws the same error, and
  // the escrow's own history keeps its original note.
  assert.deepEqual(
    parseEscrowHistory(JSON.parse(JSON.stringify(escrow.history))),
    parsedHistoryEntries,
  );
  const tampered = (
    JSON.parse(JSON.stringify(escrow.history)) as Array<
      Record<string, unknown>
    >
  ).map((entry) => ({ ...entry }));
  tampered[DEMO_PARSED_HISTORY_TAMPERED_SEQ - 1] = {
    ...tampered[DEMO_PARSED_HISTORY_TAMPERED_SEQ - 1],
    note: DEMO_PARSED_HISTORY_TAMPERED_NOTE,
  };
  assert.throws(() => parseEscrowHistory(tampered), {
    message: DEMO_PARSED_HISTORY_TAMPER_ERROR,
  });
  assert.notEqual(
    escrow.history[DEMO_PARSED_HISTORY_TAMPERED_SEQ - 1].note,
    DEMO_PARSED_HISTORY_TAMPERED_NOTE,
  );
  // The segment follows the state-diagram segment and prints
  // its lines verbatim; the event-sourced rebuild segment now
  // closes the demo after it (its own tests pin the closing
  // position).
  const parseAt = text.indexOf(
    "Standalone history parsing (parseEscrowHistory on the main escrow history):",
  );
  assert.ok(
    parseAt >
      text.indexOf(
        "State diagram generation (stateDiagram from the transition table):",
      ),
    "standalone history-parsing segment must follow the state-diagram segment",
  );
  assert.ok(
    text.includes(
      `  main escrow ${DEMO_ESCROW_ID}: history serialized to JSON, parsed standalone (no Escrow instance) -> 4 entries, final entry lands in RELEASED (seq 4 RELEASE VERIFIED -> RELEASED)`,
    ),
  );
  assert.ok(
    text.includes(
      "  parsed entries match the original history verbatim: every entry identical (seq chain 1 -> 4 continuous, hash chain re-verified)",
    ),
  );
  assert.ok(
    text.includes(
      `  tampered copy: entry seq ${DEMO_PARSED_HISTORY_TAMPERED_SEQ} (SUBMIT_MILESTONE) note rewritten — parseEscrowHistory FAILED — ${DEMO_PARSED_HISTORY_TAMPER_ERROR}`,
    ),
  );
  assert.ok(
    text.includes(
      "  original history after the tamper check: parseEscrowHistory still returns 4 entries (detached copy — the escrow's own history is untouched)",
    ),
  );
  assert.ok(
    lines.indexOf(
      "Event-sourced rebuild (Escrow.fromHistory on the main escrow history):",
    ) >
      lines.indexOf(
        "Standalone history parsing (parseEscrowHistory on the main escrow history):",
      ),
    "event-sourced rebuild segment must follow the standalone history-parsing segment",
  );
});

test("demo standalone history parsing segment is deterministic: two runs print byte-identical parsing lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf(
        "Standalone history parsing (parseEscrowHistory on the main escrow history):",
      ),
      ls.indexOf(
        "Event-sourced rebuild (Escrow.fromHistory on the main escrow history):",
      ) - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + the parse line + the verbatim line + the tamper
  // line + the untouched line; every value is derived from the
  // fixed main history alone, so no normalization is needed.
  assert.equal(segA.length, 5);
  assert.deepEqual(segA, segment(b.lines));
  assert.deepEqual(a.parsedHistoryEntries, b.parsedHistoryEntries);
  assert.equal(a.parsedHistoryTamperError, b.parsedHistoryTamperError);
});

test("demo shows the event-sourced rebuild: Escrow.fromHistory rebuilds the main escrow from its history alone and the deadline is not restored", async () => {
  const { escrow, historyRebuiltEscrow, historyRebuiltDeadline, lines } =
    await runDemo();
  const text = lines.join("\n");

  // Hand-pinned expectations — written out here from the main
  // escrow's fixed steps (4 dispatches landing in RELEASED) and
  // the fromHistory doc comment in src/stateMachine.ts (a bare
  // history restores neither the advisory deadline nor the
  // consumed idempotency-key set), never derived by calling
  // Escrow.fromHistory to produce them. test/fromHistory.test.ts
  // pins the same semantics independently, including the
  // honest-limits deadline case.
  assert.equal(DEMO_REBUILT_DEADLINE, "2026-04-01T09:00:00.000Z");
  assert.equal(historyRebuiltEscrow.id, DEMO_ESCROW_ID);
  assert.equal(historyRebuiltEscrow.state, "RELEASED");
  assert.equal(historyRebuiltEscrow.state, escrow.state);
  assert.equal(historyRebuiltEscrow.history.length, 4);
  assert.deepEqual(historyRebuiltEscrow.history, [...escrow.history]);
  assert.deepEqual(
    historyRebuiltEscrow.history.map((e) => e.event),
    ["FUND", "SUBMIT_MILESTONE", "VERIFY_PASS", "RELEASE"],
  );
  // The trade-off: the main escrow carries the fixed deadline
  // at rebuild time, the rebuilt escrow has none.
  assert.equal(escrow.getDeadline(), DEMO_REBUILT_DEADLINE);
  assert.equal(historyRebuiltDeadline, undefined);
  assert.equal(historyRebuiltEscrow.getDeadline(), undefined);
  // Independent cross-check: a fresh fromHistory rebuild of the
  // same history reproduces the demo's rebuilt escrow, and the
  // original escrow is untouched by the rebuild.
  const fresh = Escrow.fromHistory(escrow.id, escrow.history);
  assert.equal(fresh.state, historyRebuiltEscrow.state);
  assert.deepEqual(fresh.history, historyRebuiltEscrow.history);
  assert.equal(fresh.getDeadline(), undefined);
  assert.equal(escrow.state, "RELEASED");
  assert.equal(escrow.history.length, 4);
  // The segment follows the standalone history-parsing
  // segment and prints its lines verbatim; the snapshot
  // round-trip segment now closes the demo after it (its
  // own tests pin the closing position).
  const rebuildAt = text.indexOf(
    "Event-sourced rebuild (Escrow.fromHistory on the main escrow history):",
  );
  assert.ok(
    rebuildAt >
      text.indexOf(
        "Standalone history parsing (parseEscrowHistory on the main escrow history):",
      ),
    "event-sourced rebuild segment must follow the standalone history-parsing segment",
  );
  assert.ok(
    text.includes(
      `  main escrow ${DEMO_ESCROW_ID}: Escrow.fromHistory(id, history) -> rebuilt escrow in state RELEASED with 4 history entries (history alone — no snapshot envelope)`,
    ),
  );
  assert.ok(
    text.includes(
      "  rebuilt history matches the original verbatim: every entry identical (seq chain 1 -> 4 continuous, hash chain re-verified on rebuild)",
    ),
  );
  assert.ok(
    text.includes(
      `  deadline NOT restored: main escrow deadline is ${DEMO_REBUILT_DEADLINE}, rebuilt escrow deadline is undefined — a bare history carries no deadline (nor the consumed idempotency keys); use fromJSON when those must survive`,
    ),
  );
  assert.ok(
    text.includes(
      `  original escrow after the rebuild: still RELEASED with its deadline ${DEMO_REBUILT_DEADLINE} intact (the rebuild reads the history and dispatches nothing)`,
    ),
  );
  assert.ok(
    lines.indexOf(
      "Snapshot round-trip (Escrow.toJSON / Escrow.fromJSON on the main escrow):",
    ) >
      lines.indexOf(
        "Event-sourced rebuild (Escrow.fromHistory on the main escrow history):",
      ),
    "snapshot round-trip segment must follow the event-sourced rebuild segment",
  );
});

test("demo event-sourced rebuild segment is deterministic: two runs print byte-identical rebuild lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf(
        "Event-sourced rebuild (Escrow.fromHistory on the main escrow history):",
      ),
      ls.indexOf(
        "Snapshot round-trip (Escrow.toJSON / Escrow.fromJSON on the main escrow):",
      ) - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + the rebuild line + the verbatim line + the
  // deadline line + the original-escrow line; every value is
  // derived from the fixed main history and the fixed deadline
  // alone, so no normalization is needed.
  assert.equal(segA.length, 5);
  assert.deepEqual(segA, segment(b.lines));
  assert.deepEqual(a.historyRebuiltEscrow.history, b.historyRebuiltEscrow.history);
  assert.equal(a.historyRebuiltDeadline, b.historyRebuiltDeadline);
});

test("demo shows the snapshot round-trip: Escrow.toJSON/fromJSON restores state, history, and deadline verbatim", async () => {
  const {
    escrow,
    escrowSnapshot,
    snapshotJsonBytes,
    snapshotRestoredEscrow,
    snapshotRestoredDeadline,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-pinned expectations — written out here from the main
  // escrow's fixed steps (4 dispatches landing in RELEASED,
  // the fixed deadline attached by the rebuild segment) and
  // the toJSON/fromJSON doc comments in src/stateMachine.ts
  // (the envelope is v + id + state + history, plus deadline
  // when set; idempotency keys and the RBAC policy are
  // written only when non-empty), never derived by calling
  // Escrow.toJSON to produce them. test/serialization.test.ts
  // and test/deadline.test.ts pin the same round-trip
  // independently.
  assert.equal(DEMO_SNAPSHOT_SERIALIZED_BYTES, 1344);
  assert.equal(escrowSnapshot.v, 1);
  assert.equal(escrowSnapshot.id, DEMO_ESCROW_ID);
  assert.equal(escrowSnapshot.state, "RELEASED");
  assert.equal(escrowSnapshot.history.length, 4);
  assert.deepEqual(escrowSnapshot.history, [...escrow.history]);
  assert.equal(escrowSnapshot.deadline, DEMO_REBUILT_DEADLINE);
  assert.equal(escrowSnapshot.idempotencyKeys, undefined);
  assert.equal(escrowSnapshot.rolePolicy, undefined);
  assert.equal(snapshotJsonBytes, DEMO_SNAPSHOT_SERIALIZED_BYTES);
  assert.equal(
    snapshotJsonBytes,
    Buffer.byteLength(JSON.stringify(escrowSnapshot), "utf8"),
  );
  assert.equal(snapshotRestoredEscrow.id, DEMO_ESCROW_ID);
  assert.equal(snapshotRestoredEscrow.state, "RELEASED");
  assert.equal(snapshotRestoredEscrow.state, escrow.state);
  assert.equal(snapshotRestoredEscrow.history.length, 4);
  assert.deepEqual(snapshotRestoredEscrow.history, [...escrow.history]);
  assert.deepEqual(
    snapshotRestoredEscrow.history.map((e) => e.event),
    ["FUND", "SUBMIT_MILESTONE", "VERIFY_PASS", "RELEASE"],
  );
  // The contrast with the fromHistory rebuild: the snapshot
  // envelope DOES carry the deadline, so it is restored.
  assert.equal(escrow.getDeadline(), DEMO_REBUILT_DEADLINE);
  assert.equal(snapshotRestoredDeadline, DEMO_REBUILT_DEADLINE);
  assert.equal(snapshotRestoredEscrow.getDeadline(), DEMO_REBUILT_DEADLINE);
  // Independent cross-check: a fresh fromJSON restore of the
  // same serialized snapshot reproduces the demo's restored
  // escrow, and the original escrow is untouched.
  const fresh = Escrow.fromJSON(
    JSON.parse(JSON.stringify(escrowSnapshot)) as unknown,
  );
  assert.equal(fresh.state, snapshotRestoredEscrow.state);
  assert.deepEqual(fresh.history, snapshotRestoredEscrow.history);
  assert.equal(fresh.getDeadline(), DEMO_REBUILT_DEADLINE);
  assert.equal(escrow.state, "RELEASED");
  assert.equal(escrow.history.length, 4);
  // The segment follows the event-sourced rebuild segment and
  // prints its lines verbatim; the machine-readable
  // transition-table segment now closes the demo after it
  // (its own tests pin the closing position).
  const snapshotAt = text.indexOf(
    "Snapshot round-trip (Escrow.toJSON / Escrow.fromJSON on the main escrow):",
  );
  assert.ok(
    snapshotAt >
      text.indexOf(
        "Event-sourced rebuild (Escrow.fromHistory on the main escrow history):",
      ),
    "snapshot round-trip segment must follow the event-sourced rebuild segment",
  );
  assert.ok(
    text.includes(
      `  main escrow ${DEMO_ESCROW_ID}: toJSON() -> snapshot v 1 (id + state + 4 history entries + deadline) serialized to ${DEMO_SNAPSHOT_SERIALIZED_BYTES} bytes — the persistence envelope a document store keeps`,
    ),
  );
  assert.ok(
    text.includes(
      "  Escrow.fromJSON(parsed snapshot) -> restored escrow in state RELEASED with 4 history entries — state and every entry identical to the original verbatim",
    ),
  );
  assert.ok(
    text.includes(
      `  deadline restored: main escrow deadline is ${DEMO_REBUILT_DEADLINE}, restored escrow deadline is ${DEMO_REBUILT_DEADLINE} — the envelope carries the deadline (and the consumed idempotency keys) that a bare history cannot`,
    ),
  );
  assert.ok(
    text.includes(
      `  original escrow after the round-trip: still RELEASED with its deadline ${DEMO_REBUILT_DEADLINE} intact (the round-trip reads the escrow and dispatches nothing)`,
    ),
  );
  assert.ok(
    lines.indexOf(
      "Machine-readable transition table (transitionTableJson from the transition table):",
    ) >
      lines.indexOf(
        "Snapshot round-trip (Escrow.toJSON / Escrow.fromJSON on the main escrow):",
      ),
    "machine-readable transition-table segment must follow the snapshot round-trip segment",
  );
  assert.ok(
    lines.indexOf(
      "Money guard (assertNonNegativeMoney on the shared amount boundary):",
    ) >
      lines.indexOf(
        "Machine-readable transition table (transitionTableJson from the transition table):",
      ),
    "money-guard segment must follow the machine-readable transition-table segment",
  );
});

test("demo snapshot round-trip segment is deterministic: two runs print byte-identical snapshot lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf(
        "Snapshot round-trip (Escrow.toJSON / Escrow.fromJSON on the main escrow):",
      ),
      ls.indexOf(
        "Machine-readable transition table (transitionTableJson from the transition table):",
      ) - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + the snapshot line + the restored line + the
  // deadline line + the original-escrow line; every value is
  // derived from the fixed main history and the fixed deadline
  // alone, so no normalization is needed.
  assert.equal(segA.length, 5);
  assert.deepEqual(segA, segment(b.lines));
  assert.deepEqual(a.snapshotRestoredEscrow.history, b.snapshotRestoredEscrow.history);
  assert.equal(a.snapshotJsonBytes, b.snapshotJsonBytes);
  assert.equal(a.snapshotRestoredDeadline, b.snapshotRestoredDeadline);
});

test("demo shows the machine-readable transition table: transitionTableJson parses back to the transition table edge for edge", async () => {
  const {
    transitionTableJsonText,
    transitionTableJsonBytes,
    transitionTableEdges,
    transitionTableEdgeCount,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-pinned expectations — written out here from
  // TRANSITIONS in src/stateMachine.ts and the committed
  // snapshot test/__snapshots__/transitionTable.snapshot.json,
  // never derived by calling transitionTableJson to produce
  // them. test/transitionSnapshot.test.ts and the diagram
  // tests pin the same table independently: 14 edges, the
  // first CREATED --FUND--> FUNDED, the last
  // DISPUTED --ARBITRATE_REFUND--> REFUNDED.
  assert.equal(DEMO_TRANSITION_TABLE_EDGE_COUNT, 14);
  assert.equal(DEMO_TRANSITION_TABLE_JSON_BYTES, 1160);
  assert.equal(transitionTableEdgeCount, DEMO_TRANSITION_TABLE_EDGE_COUNT);
  assert.equal(transitionTableJsonBytes, DEMO_TRANSITION_TABLE_JSON_BYTES);
  assert.equal(
    transitionTableJsonBytes,
    Buffer.byteLength(transitionTableJsonText, "utf8"),
  );
  assert.ok(transitionTableJsonText.endsWith("]\n"));
  assert.ok(!transitionTableJsonText.endsWith("]\n\n"));
  assert.deepEqual(transitionTableEdges[0], {
    from: "CREATED",
    event: "FUND",
    to: "FUNDED",
  });
  assert.deepEqual(transitionTableEdges.at(-1), {
    from: "DISPUTED",
    event: "ARBITRATE_REFUND",
    to: "REFUNDED",
  });
  for (const edge of transitionTableEdges) {
    assert.deepEqual(Object.keys(edge), ["from", "event", "to"]);
  }
  // The parsed-back edge set equals the transition table's
  // edge set triple for triple, and the full lists match
  // edge for edge in order.
  const triple = (e: { from: string; event: string; to: string }) =>
    `${e.from}:${e.event}:${e.to}`;
  assert.deepEqual(
    new Set(transitionTableEdges.map(triple)),
    new Set(transitionTable().map(triple)),
  );
  assert.deepEqual(transitionTableEdges, transitionTable());
  assert.equal(transitionTableEdgeCount, transitionTable().length);
  // Cross-check against the library export itself — the demo
  // segment is not self-certifying.
  assert.equal(transitionTableJsonText, transitionTableJson());
  // The segment follows the snapshot round-trip segment
  // and precedes the closing money-guard segment; it
  // prints its lines verbatim.
  const tableAt = text.indexOf(
    "Machine-readable transition table (transitionTableJson from the transition table):",
  );
  assert.ok(
    tableAt >
      text.indexOf(
        "Snapshot round-trip (Escrow.toJSON / Escrow.fromJSON on the main escrow):",
      ),
    "machine-readable transition-table segment must follow the snapshot round-trip segment",
  );
  assert.ok(
    text.indexOf(
      "Money guard (assertNonNegativeMoney on the shared amount boundary):",
    ) > tableAt,
    "money-guard segment must follow the machine-readable transition-table segment",
  );
  for (const line of [
    "  transitionTableJson(): 1160 bytes, 14 edges (canonical JSON — the machine-readable form of the same table stateDiagram() renders for humans, byte-identical to the committed transition-table snapshot)",
    "  parsed back: 14 edges, every (from, event, to) triple matches transitionTable() edge for edge",
    "  first edge: CREATED --FUND--> FUNDED",
    "  last edge: DISPUTED --ARBITRATE_REFUND--> REFUNDED",
  ]) {
    assert.ok(text.includes(line), `missing transition-table line: ${line}`);
  }
});

test("demo machine-readable transition table segment is deterministic: two runs print byte-identical table lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf(
        "Machine-readable transition table (transitionTableJson from the transition table):",
      ),
      ls.indexOf(
        "Money guard (assertNonNegativeMoney on the shared amount boundary):",
      ) - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + the byte/edge line + the parsed-back line + the
  // first-edge line + the last-edge line; every value is
  // derived from the transition table alone, so no
  // normalization is needed.
  assert.equal(segA.length, 5);
  assert.deepEqual(segA, segment(b.lines));
  assert.equal(a.transitionTableJsonText, b.transitionTableJsonText);
  assert.equal(a.transitionTableJsonBytes, b.transitionTableJsonBytes);
  assert.deepEqual(a.transitionTableEdges, b.transitionTableEdges);
  assert.equal(a.transitionTableEdgeCount, b.transitionTableEdgeCount);
});

test("demo shows the money guard: assertNonNegativeMoney accepts the legal corpus and rejects the illegal pair with the pinned error", async () => {
  const { moneyGuardLegalAmounts, moneyGuardRejections, lines } =
    await runDemo();
  const text = lines.join("\n");

  // Hand-pinned expectations — written out here from the
  // documented semantics in src/stateMachine.ts, never
  // derived by calling the guard to produce them.
  // test/inputValidation.test.ts and the bench
  // assertNonNegativeMoney fixture pin the same corpora
  // and the same error message independently.
  assert.equal(
    DEMO_MONEY_GUARD_ERROR,
    "amount must be a finite non-negative number",
  );
  assert.deepEqual(DEMO_MONEY_GUARD_LEGAL_AMOUNTS, [0, 0.01, 10630, 1000000.25]);
  assert.deepEqual(moneyGuardLegalAmounts, [0, 0.01, 10630, 1000000.25]);
  assert.equal(DEMO_MONEY_GUARD_ILLEGAL_AMOUNTS.length, 2);
  assert.equal(DEMO_MONEY_GUARD_ILLEGAL_AMOUNTS[0], -1);
  assert.ok(Number.isNaN(DEMO_MONEY_GUARD_ILLEGAL_AMOUNTS[1]));
  assert.equal(moneyGuardRejections.length, 2);
  assert.equal(moneyGuardRejections[0].value, -1);
  assert.ok(Number.isNaN(moneyGuardRejections[1].value));
  for (const rejection of moneyGuardRejections) {
    assert.equal(
      rejection.message,
      "amount must be a finite non-negative number",
    );
  }
  // Cross-check against the library export itself — the
  // demo segment is not self-certifying: the legal corpus
  // passes the real guard and each illegal value throws
  // the exact pinned message from it.
  for (const value of moneyGuardLegalAmounts) {
    assertNonNegativeMoney("amount", value);
  }
  for (const rejection of moneyGuardRejections) {
    assert.throws(
      () => assertNonNegativeMoney("amount", rejection.value),
      (err: unknown) =>
        err instanceof Error &&
        err.message === "amount must be a finite non-negative number",
    );
  }
  // The segment follows the machine-readable
  // transition-table segment and precedes the closing
  // subscription segment; it prints its lines verbatim.
  const guardAt = text.indexOf(
    "Money guard (assertNonNegativeMoney on the shared amount boundary):",
  );
  assert.ok(
    guardAt >
      text.indexOf(
        "Machine-readable transition table (transitionTableJson from the transition table):",
      ),
    "money-guard segment must follow the machine-readable transition-table segment",
  );
  assert.ok(
    guardAt <
      text.indexOf(
        "Subscription notifications (Escrow.subscribe on a branch escrow):",
      ),
    "money-guard segment must precede the subscription segment",
  );
  for (const line of [
    "  accepted: 0, 0.01, 10630, 1000000.25 — every legal amount passes without throwing (zero, a cent, the golden deposit, a large amount with cents)",
    '  rejected: -1 -> "amount must be a finite non-negative number"',
    '  rejected: NaN -> "amount must be a finite non-negative number"',
  ]) {
    assert.ok(text.includes(line), `missing money-guard line: ${line}`);
  }
});

test("demo money guard segment is deterministic: two runs print byte-identical guard lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf(
        "Money guard (assertNonNegativeMoney on the shared amount boundary):",
      ),
      ls.indexOf(
        "Subscription notifications (Escrow.subscribe on a branch escrow):",
      ) - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + the accepted line + the two rejected lines;
  // every value is derived from the fixed corpora alone,
  // so no normalization is needed.
  assert.equal(segA.length, 4);
  assert.deepEqual(segA, segment(b.lines));
  assert.deepEqual(a.moneyGuardLegalAmounts, b.moneyGuardLegalAmounts);
  assert.equal(a.moneyGuardRejections.length, b.moneyGuardRejections.length);
  for (let i = 0; i < a.moneyGuardRejections.length; i++) {
    assert.ok(
      Object.is(a.moneyGuardRejections[i].value, b.moneyGuardRejections[i].value),
    );
    assert.equal(
      a.moneyGuardRejections[i].message,
      b.moneyGuardRejections[i].message,
    );
  }
});

test("demo shows subscription notifications: listener receives the first two dispatches matching history, then nothing after idempotent unsubscribe", async () => {
  const {
    subscribeEscrow,
    subscribeNotifications,
    subscribeMatchesHistory,
    subscribeCountAfterUnsubscribe,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-pinned expectations — written out here from the
  // documented subscribe() semantics in src/stateMachine.ts,
  // never derived by calling subscribe() to produce them.
  // test/subscribe.test.ts pins the same semantics
  // independently (order, entry identity, idempotent
  // unsubscribe).
  assert.equal(subscribeEscrow.id, DEMO_SUBSCRIBE_ESCROW_ID);
  assert.deepEqual(subscribeNotifications, [
    { event: "FUND", from: "CREATED", to: "FUNDED", seq: 1 },
    {
      event: "SUBMIT_MILESTONE",
      from: "FUNDED",
      to: "MILESTONE_SUBMITTED",
      seq: 2,
    },
  ]);
  assert.equal(subscribeMatchesHistory, true);
  // Each notification equals the audit entry with the same seq.
  for (const n of subscribeNotifications) {
    const entry = subscribeEscrow.history[n.seq - 1];
    assert.equal(entry.event, n.event);
    assert.equal(entry.from, n.from);
    assert.equal(entry.to, n.to);
  }
  // The post-unsubscribe dispatch landed (VERIFIED, 3 entries,
  // fixed timestamps + evidence) but produced no notification.
  assert.equal(subscribeCountAfterUnsubscribe, 2);
  assert.equal(subscribeEscrow.listenerCount, 0);
  assert.equal(subscribeEscrow.state, "VERIFIED");
  assert.equal(subscribeEscrow.history.length, 3);
  assert.deepEqual(
    subscribeEscrow.history.map((h) => h.at),
    [
      DEMO_SUBSCRIBE_FUND_AT,
      DEMO_SUBSCRIBE_SUBMIT_AT,
      DEMO_SUBSCRIBE_VERIFY_AT,
    ],
  );
  assert.equal(
    subscribeEscrow.history[2].evidence,
    DEMO_SUBSCRIBE_VERIFY_EVIDENCE,
  );
  // Independent cross-check: a fresh escrow with a fresh
  // listener reproduces the same fan-out shape — the demo
  // segment is not self-certifying.
  const probe = new Escrow("sub-demo-probe");
  const probeSeen: string[] = [];
  const probeUnsub = probe.subscribe((event, from, to, entry) => {
    probeSeen.push(`${event}:${from}->${to}:${entry.seq}`);
  });
  probe.dispatch("FUND", undefined, 100, { at: DEMO_SUBSCRIBE_FUND_AT });
  probeUnsub();
  probeUnsub();
  probe.dispatch("SUBMIT_MILESTONE", undefined, undefined, {
    at: DEMO_SUBSCRIBE_SUBMIT_AT,
  });
  assert.deepEqual(probeSeen, ["FUND:CREATED->FUNDED:1"]);
  assert.equal(probe.listenerCount, 0);
  // The segment follows the money-guard segment and
  // precedes the closing deadline-clearing segment; it
  // prints its lines verbatim.
  const subscribeAt = text.indexOf(
    "Subscription notifications (Escrow.subscribe on a branch escrow):",
  );
  assert.ok(
    subscribeAt >
      text.indexOf(
        "Money guard (assertNonNegativeMoney on the shared amount boundary):",
      ),
    "subscription segment must follow the money-guard segment",
  );
  assert.ok(
    subscribeAt <
      text.indexOf("Deadline clearing (clearDeadline on funded escrows):"),
    "subscription segment must precede the deadline-clearing segment",
  );
  for (const line of [
    `  escrow ${DEMO_SUBSCRIBE_ESCROW_ID}: subscribed 1 collecting listener (notified after each audit append, in subscription order)`,
    "  notification 1: FUND CREATED -> FUNDED (entry seq 1)",
    "  notification 2: SUBMIT_MILESTONE FUNDED -> MILESTONE_SUBMITTED (entry seq 2)",
    "  notifications match history: true (each (event, from, to) equals the history entry with the same seq)",
    "  unsubscribed: listenerCount 0 (second unsubscribe call is a no-op — idempotent)",
    "  listener received after unsubscribe: 2 notification(s) (unchanged — VERIFY_PASS produced no new notification)",
  ]) {
    assert.ok(text.includes(line), `missing subscription line: ${line}`);
  }
  assert.match(
    text,
    / {2}VERIFY_PASS +MILESTONE_SUBMITTED +-> VERIFIED +\(oracle\)/,
  );
});

test("demo subscription segment is deterministic: two runs print byte-identical notification lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf(
        "Subscription notifications (Escrow.subscribe on a branch escrow):",
      ),
      ls.indexOf("Deadline clearing (clearDeadline on funded escrows):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + escrow line + 2 notification lines + match line +
  // unsubscribed line + VERIFY_PASS line + after-unsubscribe
  // line; every value is derived from the fixed fixtures
  // alone, so no normalization is needed.
  assert.equal(segA.length, 8);
  assert.deepEqual(segA, segment(b.lines));
  assert.deepEqual(a.subscribeNotifications, b.subscribeNotifications);
  assert.equal(a.subscribeMatchesHistory, b.subscribeMatchesHistory);
  assert.equal(
    a.subscribeCountAfterUnsubscribe,
    b.subscribeCountAfterUnsubscribe,
  );
});

test("demo shows deadline clearing: clearDeadline removes the deadline and turns the overdue judgement false, and is a no-op without one", async () => {
  const {
    deadlineClearEscrow,
    deadlineClearDeadlineBefore,
    deadlineClearOverdueBefore,
    deadlineClearDeadlineAfter,
    deadlineClearOverdueAfter,
    deadlineClearNoDeadlineEscrow,
    deadlineClearNoDeadlineOverdue,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-pinned expectations — written out here from the
  // documented deadline semantics in src/stateMachine.ts,
  // never derived by calling clearDeadline() to produce
  // them. test/deadline.test.ts pins the same semantics
  // independently (clear removes, no-op when none, and
  // isOverdue false with no deadline).
  assert.equal(deadlineClearEscrow.id, DEMO_CLEAR_DEADLINE_ESCROW_ID);
  assert.equal(deadlineClearDeadlineBefore, DEMO_CLEAR_DEADLINE_DEADLINE);
  assert.equal(deadlineClearOverdueBefore, true);
  assert.equal(deadlineClearDeadlineAfter, undefined);
  assert.equal(deadlineClearOverdueAfter, false);
  assert.equal(deadlineClearEscrow.getDeadline(), undefined);
  assert.equal(deadlineClearEscrow.state, "FUNDED");
  assert.equal(deadlineClearEscrow.history.length, 1);
  assert.equal(
    deadlineClearEscrow.history[0].at,
    DEMO_CLEAR_DEADLINE_FUND_AT,
  );
  assert.equal(
    deadlineClearNoDeadlineEscrow.id,
    DEMO_CLEAR_DEADLINE_NO_DEADLINE_ESCROW_ID,
  );
  assert.equal(deadlineClearNoDeadlineEscrow.getDeadline(), undefined);
  assert.equal(deadlineClearNoDeadlineOverdue, false);
  assert.equal(deadlineClearNoDeadlineEscrow.state, "FUNDED");
  assert.equal(deadlineClearNoDeadlineEscrow.history.length, 1);
  assert.equal(
    deadlineClearNoDeadlineEscrow.history[0].at,
    DEMO_CLEAR_DEADLINE_NO_DEADLINE_FUND_AT,
  );
  // Independent cross-checks: fresh escrows reproduce the
  // same clear shape — the demo segment is not
  // self-certifying.
  const probe = new Escrow("clear-demo-probe");
  probe.dispatch("FUND", undefined, 100, {
    at: DEMO_CLEAR_DEADLINE_FUND_AT,
  });
  probe.setDeadline(DEMO_CLEAR_DEADLINE_DEADLINE);
  assert.equal(
    isOverdue(probe, new Date(DEMO_CLEAR_DEADLINE_CHECK_AT)),
    true,
  );
  probe.clearDeadline();
  assert.equal(probe.getDeadline(), undefined);
  assert.equal(
    isOverdue(probe, new Date(DEMO_CLEAR_DEADLINE_CHECK_AT)),
    false,
  );
  const probeNoDeadline = new Escrow("clear-demo-probe-none");
  probeNoDeadline.dispatch("FUND", undefined, 100, {
    at: DEMO_CLEAR_DEADLINE_NO_DEADLINE_FUND_AT,
  });
  probeNoDeadline.clearDeadline();
  assert.equal(probeNoDeadline.getDeadline(), undefined);
  assert.equal(probeNoDeadline.state, "FUNDED");
  // The segment follows the subscription segment and
  // precedes the closing approval-log segment; it prints
  // its lines verbatim.
  const clearAt = text.indexOf(
    "Deadline clearing (clearDeadline on funded escrows):",
  );
  assert.ok(
    clearAt >
      text.indexOf(
        "Subscription notifications (Escrow.subscribe on a branch escrow):",
      ),
    "deadline-clearing segment must follow the subscription segment",
  );
  assert.ok(
    clearAt < text.indexOf("Quorum approval log (approvalLog audit trail):"),
    "deadline-clearing segment must precede the approval-log segment",
  );
  for (const line of [
    `  escrow ${DEMO_CLEAR_DEADLINE_ESCROW_ID}: state FUNDED, deadline ${DEMO_CLEAR_DEADLINE_DEADLINE} — at ${DEMO_CLEAR_DEADLINE_CHECK_AT} isOverdue -> true (past the deadline, non-terminal)`,
    `  after clearDeadline(): getDeadline() -> undefined, isOverdue at ${DEMO_CLEAR_DEADLINE_CHECK_AT} -> false (deadline removed — clearing dispatches nothing, escrow still FUNDED)`,
    `  escrow ${DEMO_CLEAR_DEADLINE_NO_DEADLINE_ESCROW_ID} (no deadline set): clearDeadline() is a no-op — getDeadline() -> undefined, isOverdue at ${DEMO_CLEAR_DEADLINE_CHECK_AT} -> false, state still FUNDED (1 history entry)`,
  ]) {
    assert.ok(text.includes(line), `missing deadline-clearing line: ${line}`);
  }
});

test("demo deadline-clearing segment is deterministic: two runs print byte-identical clearing lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Deadline clearing (clearDeadline on funded escrows):"),
      ls.indexOf("Quorum approval log (approvalLog audit trail):") - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + the escrow line + the after-clear line + the
  // no-op line; every value is derived from the fixed
  // fixtures alone, so no normalization is needed.
  assert.equal(segA.length, 4);
  assert.deepEqual(segA, segment(b.lines));
  assert.equal(a.deadlineClearDeadlineBefore, b.deadlineClearDeadlineBefore);
  assert.equal(a.deadlineClearOverdueBefore, b.deadlineClearOverdueBefore);
  assert.equal(a.deadlineClearDeadlineAfter, b.deadlineClearDeadlineAfter);
  assert.equal(a.deadlineClearOverdueAfter, b.deadlineClearOverdueAfter);
  assert.equal(
    a.deadlineClearNoDeadlineOverdue,
    b.deadlineClearNoDeadlineOverdue,
  );
});

test("demo shows the quorum approval log: full trail in record order, and expired entries retained after the count drops", async () => {
  const {
    disputeQuorum,
    approvalLogEntries,
    approvalLogExpiryQuorum,
    approvalLogExpiryCountBefore,
    approvalLogExpiryHasQuorumBefore,
    approvalLogExpiryCountAfter,
    approvalLogExpiryHasQuorumAfter,
    approvalLogExpiryLogAfter,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-pinned expectations — written out here from the
  // documented approvalLog() semantics in src/quorum.ts,
  // never derived by calling approvalLog() to produce
  // them. test/approvalLog.test.ts and
  // test/quorumExpiry.test.ts pin the same semantics
  // independently (record order with canonical ISO
  // timestamps, expiry counts out but never deletes,
  // only revoke removes entries). The dispute trail's
  // timestamps are the demo's fixed approval sequence:
  // arb-1 before the restart, arb-2 on the restored
  // quorum, neither re-stamped.
  assert.deepEqual(approvalLogEntries, DEMO_DISPUTE_APPROVAL_LOG_ENTRIES);
  assert.deepEqual(
    approvalLogEntries.map((e) => e.at),
    [...DEMO_QUORUM_APPROVAL_ATS],
  );
  assert.deepEqual(disputeQuorum.approvalLog(), approvalLogEntries);
  assert.equal(approvalLogExpiryCountBefore, 2);
  assert.equal(approvalLogExpiryHasQuorumBefore, true);
  assert.equal(approvalLogExpiryCountAfter, 1);
  assert.equal(approvalLogExpiryHasQuorumAfter, false);
  assert.deepEqual(approvalLogExpiryQuorum.approvals(), [
    DEMO_QUORUM_SIGNERS[1],
  ]);
  assert.deepEqual(approvalLogExpiryLogAfter, DEMO_APPROVAL_LOG_ENTRIES);
  assert.equal(approvalLogExpiryQuorum.threshold, DEMO_QUORUM_THRESHOLD);
  // Independent cross-checks: fresh quorums reproduce
  // both shapes — the demo segment is not
  // self-certifying.
  let probeTick = 0;
  const probeDispute = createQuorum({
    threshold: DEMO_QUORUM_THRESHOLD,
    signers: [...DEMO_QUORUM_SIGNERS],
    now: () =>
      Date.parse(
        DEMO_QUORUM_APPROVAL_ATS[
          Math.min(probeTick++, DEMO_QUORUM_APPROVAL_ATS.length - 1)
        ],
      ),
  });
  probeDispute.approve(DEMO_QUORUM_SIGNERS[0]);
  probeDispute.approve(DEMO_QUORUM_SIGNERS[1]);
  assert.deepEqual(
    probeDispute.approvalLog(),
    DEMO_DISPUTE_APPROVAL_LOG_ENTRIES,
  );
  let probeNow = Date.parse(DEMO_APPROVAL_LOG_FIRST_AT);
  const probeExpiry = createQuorum({
    threshold: DEMO_QUORUM_THRESHOLD,
    signers: [...DEMO_QUORUM_SIGNERS],
    now: () => probeNow,
    maxApprovalAgeMs: DEMO_APPROVAL_LOG_WINDOW_MS,
  });
  probeExpiry.approve(DEMO_QUORUM_SIGNERS[0]);
  probeNow = Date.parse(DEMO_APPROVAL_LOG_SECOND_AT);
  probeExpiry.approve(DEMO_QUORUM_SIGNERS[1]);
  assert.equal(probeExpiry.approvalCount(), 2);
  assert.equal(probeExpiry.hasQuorum(), true);
  probeNow = Date.parse(DEMO_APPROVAL_LOG_CHECK_AT);
  assert.equal(probeExpiry.approvalCount(), 1);
  assert.equal(probeExpiry.hasQuorum(), false);
  assert.deepEqual(probeExpiry.approvalLog(), DEMO_APPROVAL_LOG_ENTRIES);
  // The segment follows the deadline-clearing segment and
  // precedes the closing single-target delivery segment;
  // it prints its lines verbatim, and its retained-entries
  // line is the segment's last line.
  const logAt = text.indexOf("Quorum approval log (approvalLog audit trail):");
  assert.ok(
    logAt >
      text.indexOf("Deadline clearing (clearDeadline on funded escrows):"),
    "approval-log segment must follow the deadline-clearing segment",
  );
  for (const line of [
    `  dispute quorum (${DEMO_QUORUM_THRESHOLD}-of-${DEMO_QUORUM_SIGNERS.length}): approvalLog() — the full audit trail in record order, one line per vote`,
    `  approval 1: ${DEMO_DISPUTE_APPROVAL_LOG_ENTRIES[0].signerId} at ${DEMO_DISPUTE_APPROVAL_LOG_ENTRIES[0].at}`,
    `  approval 2: ${DEMO_DISPUTE_APPROVAL_LOG_ENTRIES[1].signerId} at ${DEMO_DISPUTE_APPROVAL_LOG_ENTRIES[1].at}`,
    `  trail survives the restart: the pre-restart vote (${DEMO_QUORUM_SIGNERS[0]}) kept its original timestamp ${DEMO_QUORUM_APPROVAL_ATS[0]} through the snapshot round-trip`,
    `  expiring quorum (maxApprovalAgeMs ${DEMO_APPROVAL_LOG_WINDOW_MS}): approvals at ${DEMO_APPROVAL_LOG_FIRST_AT} and ${DEMO_APPROVAL_LOG_SECOND_AT} — approvalCount 2, hasQuorum: true`,
    `  at ${DEMO_APPROVAL_LOG_CHECK_AT} the first vote is 60001 ms old — past the window: approvalCount 1, hasQuorum: false`,
    "  approvalLog() after expiry: 2 entries retained (arb-1, arb-2) — expiry never deletes the audit trail; only revoke() removes a signer's entries",
  ]) {
    assert.ok(text.includes(line), `missing approval-log line: ${line}`);
  }
  const logSegment = lines.slice(
    lines.indexOf("Quorum approval log (approvalLog audit trail):"),
    lines.indexOf(
      "Single-target webhook delivery (deliverSettlementWebhook via scripted fake fetch, zero network):",
    ) - 1,
  );
  assert.equal(
    logSegment[logSegment.length - 1],
    "  approvalLog() after expiry: 2 entries retained (arb-1, arb-2) — expiry never deletes the audit trail; only revoke() removes a signer's entries",
  );
});

test("demo quorum approval-log segment is deterministic: two runs print byte-identical approval-log lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf("Quorum approval log (approvalLog audit trail):"),
      ls.indexOf(
        "Single-target webhook delivery (deliverSettlementWebhook via scripted fake fetch, zero network):",
      ) - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + the dispute-quorum line + 2 approval lines +
  // the restart line + the expiring-quorum line + the
  // past-window line + the retained-entries line; every
  // value is derived from the fixed fixtures alone, so no
  // normalization is needed.
  assert.equal(segA.length, 8);
  assert.deepEqual(segA, segment(b.lines));
  assert.deepEqual(a.approvalLogEntries, b.approvalLogEntries);
  assert.deepEqual(a.approvalLogExpiryLogAfter, b.approvalLogExpiryLogAfter);
  assert.equal(a.approvalLogExpiryCountBefore, b.approvalLogExpiryCountBefore);
  assert.equal(a.approvalLogExpiryCountAfter, b.approvalLogExpiryCountAfter);
  assert.equal(
    a.approvalLogExpiryHasQuorumBefore,
    b.approvalLogExpiryHasQuorumBefore,
  );
  assert.equal(
    a.approvalLogExpiryHasQuorumAfter,
    b.approvalLogExpiryHasQuorumAfter,
  );
});

test("demo shows single-target delivery: deliverSettlementWebhook retries a scripted 500 and succeeds, the captured signature verifying over the wire body", async () => {
  const {
    webhook,
    singleDeliveryResult,
    singleDeliveryCalls,
    singleDeliverySignatureVerified,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-pinned expectations — written out here from the
  // documented deliverSettlementWebhook() semantics in
  // src/webhooks.ts, never derived by calling the delivery
  // to produce them. test/webhookDelivery.test.ts pins the
  // same semantics independently (a 500-then-200 endpoint
  // succeeds on the next attempt; every attempt carries the
  // same signature over the same body; the receiver verifies
  // over the raw bytes).
  assert.deepEqual(DEMO_SINGLE_DELIVERY_SCRIPTED_STATUSES, [500, 200]);
  assert.deepEqual(singleDeliveryResult, { status: 200, attempts: 2 });
  assert.equal(singleDeliveryCalls.length, 2);
  for (const call of singleDeliveryCalls) {
    assert.equal(call.url, DEMO_SINGLE_DELIVERY_URL);
    assert.equal(call.method, "POST");
    assert.equal(call.body, JSON.stringify(webhook.payload));
    assert.equal(call.signature, webhook.signature);
  }
  assert.equal(singleDeliverySignatureVerified, true);
  assert.equal(
    verifySettlementWebhook(
      singleDeliveryCalls[1].body,
      singleDeliveryCalls[1].signature,
      DEMO_WEBHOOK_SECRET,
    ),
    true,
  );
  // Independent cross-check: a fresh scripted fetch through
  // the library entry point reproduces the same shape — the
  // demo segment is not self-certifying. The probe restores
  // the global fetch in the finally, exactly like the demo.
  const probeCalls: Array<{ body: string; signature: string }> = [];
  const probeFetch: typeof fetch = async (_input, init) => {
    probeCalls.push({
      body: String(init?.body ?? ""),
      signature: String(
        new Headers(init?.headers).get("x-signature") ?? "",
      ),
    });
    const status = probeCalls.length === 1 ? 500 : 200;
    return new Response(status === 200 ? "{}" : "boom", { status });
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = probeFetch;
  let probeResult;
  try {
    probeResult = await deliverSettlementWebhook(
      DEMO_SINGLE_DELIVERY_URL,
      webhook,
      { backoffMs: 0 },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(probeResult, { status: 200, attempts: 2 });
  assert.equal(probeCalls.length, 2);
  assert.equal(probeCalls[0].body, probeCalls[1].body);
  assert.equal(
    verifySettlementWebhook(
      probeCalls[1].body,
      probeCalls[1].signature,
      DEMO_WEBHOOK_SECRET,
    ),
    true,
  );
  // Global fetch restored by both the probe and the demo:
  // no later code can observe either fake.
  assert.equal(globalThis.fetch, originalFetch);
  // The segment follows the approval-log segment and
  // precedes the 429 Retry-After delivery segment; it
  // prints its lines verbatim, and its wire-check line is
  // the segment's last line.
  const deliveryAt = text.indexOf(
    "Single-target webhook delivery (deliverSettlementWebhook via scripted fake fetch, zero network):",
  );
  assert.ok(
    deliveryAt > text.indexOf("Quorum approval log (approvalLog audit trail):"),
    "single-target delivery segment must follow the approval-log segment",
  );
  for (const line of [
    `  endpoint: ${DEMO_SINGLE_DELIVERY_URL} — the main escrow's signed webhook (eventId ${DEMO_WEBHOOK_EVENT_ID}) delivered alone, the single-endpoint entry point under the fan-out wrapper`,
    "  attempt 1: scripted 500 (retryable 5xx) — attempt 2: scripted 200; result: status 200, attempts 2 (succeeded after exactly one retry, backoffMs 0 — no real waiting)",
    "  wire check: 2 captured POSTs, bodies byte-identical across attempts and equal to the signed payload body; the X-Signature the endpoint received verifies over the captured body: verifySettlementWebhook: ok",
  ]) {
    assert.ok(text.includes(line), `missing single-delivery line: ${line}`);
  }
  const deliverySegment = lines.slice(
    lines.indexOf(
      "Single-target webhook delivery (deliverSettlementWebhook via scripted fake fetch, zero network):",
    ),
    lines.indexOf(
      "429 Retry-After webhook delivery (deliverSettlementWebhook via scripted fake fetch, zero network):",
    ) - 1,
  );
  assert.equal(
    deliverySegment[deliverySegment.length - 1],
    "  wire check: 2 captured POSTs, bodies byte-identical across attempts and equal to the signed payload body; the X-Signature the endpoint received verifies over the captured body: verifySettlementWebhook: ok",
  );
});

test("demo single-target delivery segment is deterministic: two runs print byte-identical delivery lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf(
        "Single-target webhook delivery (deliverSettlementWebhook via scripted fake fetch, zero network):",
      ),
      ls.indexOf(
        "429 Retry-After webhook delivery (deliverSettlementWebhook via scripted fake fetch, zero network):",
      ) - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + the endpoint line + the attempt line + the
  // wire-check line; every value is derived from the fixed
  // fixtures and the scripted statuses alone, so no
  // normalization is needed.
  assert.equal(segA.length, 4);
  assert.deepEqual(segA, segment(b.lines));
  assert.deepEqual(a.singleDeliveryResult, b.singleDeliveryResult);
  assert.deepEqual(a.singleDeliveryCalls, b.singleDeliveryCalls);
  assert.equal(
    a.singleDeliverySignatureVerified,
    b.singleDeliverySignatureVerified,
  );
});

test("demo shows 429 Retry-After delivery: deliverSettlementWebhook parses the pinned hint, clamps the wait to zero, and retries to success", async () => {
  const {
    webhook,
    retryAfterDeliveryResult,
    retryAfterDeliveryHintMs,
    retryAfterDeliveryCalls,
    retryAfterDeliverySignatureVerified,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-pinned expectations — written out here from the
  // documented deliverSettlementWebhook() semantics in
  // src/webhooks.ts, never derived by calling the delivery
  // to produce them. test/maxRetryDelay.test.ts pins the
  // maxRetryDelayMs clamp independently and
  // test/webhookDelivery.test.ts pins the same
  // 429-then-200 retry shape (the hint honored over
  // backoff, the same signature and body on every
  // attempt, the receiver verifying over the raw bytes).
  assert.deepEqual(DEMO_RETRY_AFTER_DELIVERY_SCRIPTED_STATUSES, [429, 200]);
  assert.equal(DEMO_RETRY_AFTER_DELIVERY_HINT, "120");
  assert.equal(DEMO_RETRY_AFTER_DELIVERY_HINT_MS, 120_000);
  assert.deepEqual(retryAfterDeliveryResult, { status: 200, attempts: 2 });
  assert.equal(retryAfterDeliveryHintMs, 120_000);
  // Independent cross-check: parsing the pinned hint
  // directly reproduces the same milliseconds — the demo
  // segment is not self-certifying.
  assert.equal(parseRetryAfter(DEMO_RETRY_AFTER_DELIVERY_HINT), 120_000);
  assert.equal(retryAfterDeliveryCalls.length, 2);
  for (const call of retryAfterDeliveryCalls) {
    assert.equal(call.url, DEMO_RETRY_AFTER_DELIVERY_URL);
    assert.equal(call.method, "POST");
    assert.equal(call.body, JSON.stringify(webhook.payload));
    assert.equal(call.signature, webhook.signature);
  }
  assert.equal(retryAfterDeliverySignatureVerified, true);
  assert.equal(
    verifySettlementWebhook(
      retryAfterDeliveryCalls[1].body,
      retryAfterDeliveryCalls[1].signature,
      DEMO_WEBHOOK_SECRET,
    ),
    true,
  );
  // Independent cross-check: a fresh scripted fetch
  // through the library entry point reproduces the same
  // shape — a 429 carrying the pinned hint, clamped to a
  // zero wait, retried once to a 200. The probe restores
  // the global fetch in the finally, exactly like the
  // demo.
  const probeCalls: Array<{ body: string; signature: string }> = [];
  const probeFetch: typeof fetch = async (_input, init) => {
    probeCalls.push({
      body: String(init?.body ?? ""),
      signature: String(
        new Headers(init?.headers).get("x-signature") ?? "",
      ),
    });
    const status = probeCalls.length === 1 ? 429 : 200;
    return new Response(status === 200 ? "{}" : "rate limited", {
      status,
      headers:
        status === 429
          ? { "retry-after": DEMO_RETRY_AFTER_DELIVERY_HINT }
          : { "content-type": "application/json" },
    });
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = probeFetch;
  let probeResult;
  try {
    probeResult = await deliverSettlementWebhook(
      DEMO_RETRY_AFTER_DELIVERY_URL,
      webhook,
      { maxRetryDelayMs: 0 },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(probeResult, { status: 200, attempts: 2 });
  assert.equal(probeCalls.length, 2);
  assert.equal(probeCalls[0].body, probeCalls[1].body);
  assert.equal(
    verifySettlementWebhook(
      probeCalls[1].body,
      probeCalls[1].signature,
      DEMO_WEBHOOK_SECRET,
    ),
    true,
  );
  // Global fetch restored by both the probe and the demo:
  // no later code can observe either fake.
  assert.equal(globalThis.fetch, originalFetch);
  // The segment follows the single-target delivery
  // segment and precedes the closing dedupe-snapshot
  // segment; it prints its lines verbatim, and its
  // wire-check line is the segment's last line.
  const retryAt = text.indexOf(
    "429 Retry-After webhook delivery (deliverSettlementWebhook via scripted fake fetch, zero network):",
  );
  assert.ok(
    retryAt >
      text.indexOf(
        "Single-target webhook delivery (deliverSettlementWebhook via scripted fake fetch, zero network):",
      ),
    "429 Retry-After delivery segment must follow the single-target delivery segment",
  );
  for (const line of [
    `  endpoint: ${DEMO_RETRY_AFTER_DELIVERY_URL} — the main escrow's signed webhook (eventId ${DEMO_WEBHOOK_EVENT_ID}) delivered alone against a rate-limiting endpoint, the first demo delivery to run the 429 retry path end to end`,
    `  attempt 1: scripted 429 with Retry-After: ${DEMO_RETRY_AFTER_DELIVERY_HINT} (parseRetryAfter -> ${DEMO_RETRY_AFTER_DELIVERY_HINT_MS} ms) — attempt 2: scripted 200; result: status 200, attempts 2`,
    `  wait: retryDelayMs parses the hint and maxRetryDelayMs 0 clamps the parsed ${DEMO_RETRY_AFTER_DELIVERY_HINT_MS} ms to 0 — the hint is parsed and applied, and the retry fires with zero real waiting`,
    "  wire check: 2 captured POSTs, bodies byte-identical across attempts and equal to the signed payload body; the X-Signature the endpoint received on the re-delivery verifies over the captured body: verifySettlementWebhook: ok",
  ]) {
    assert.ok(text.includes(line), `missing 429 Retry-After line: ${line}`);
  }
  const retrySegment = lines.slice(
    lines.indexOf(
      "429 Retry-After webhook delivery (deliverSettlementWebhook via scripted fake fetch, zero network):",
    ),
    lines.indexOf(
      "Dedupe snapshot persistence (SettlementEventDedupe exportSnapshot / restore across a restart):",
    ) - 1,
  );
  assert.equal(
    retrySegment[retrySegment.length - 1],
    "  wire check: 2 captured POSTs, bodies byte-identical across attempts and equal to the signed payload body; the X-Signature the endpoint received on the re-delivery verifies over the captured body: verifySettlementWebhook: ok",
  );
});

test("demo 429 Retry-After delivery segment is deterministic: two runs print byte-identical delivery lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf(
        "429 Retry-After webhook delivery (deliverSettlementWebhook via scripted fake fetch, zero network):",
      ),
      ls.indexOf(
        "Dedupe snapshot persistence (SettlementEventDedupe exportSnapshot / restore across a restart):",
      ) - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + the endpoint line + the attempt line + the
  // wait line + the wire-check line; every value is
  // derived from the fixed fixtures and the scripted
  // statuses alone (the wait is clamped to zero, so no
  // real time enters), and no normalization is needed.
  assert.equal(segA.length, 5);
  assert.deepEqual(segA, segment(b.lines));
  assert.deepEqual(a.retryAfterDeliveryResult, b.retryAfterDeliveryResult);
  assert.equal(a.retryAfterDeliveryHintMs, b.retryAfterDeliveryHintMs);
  assert.deepEqual(a.retryAfterDeliveryCalls, b.retryAfterDeliveryCalls);
  assert.equal(
    a.retryAfterDeliverySignatureVerified,
    b.retryAfterDeliverySignatureVerified,
  );
});

test("demo shows dedupe snapshot persistence: recorded ids survive a JSON round-trip restore, counters restart at zero, and a v:2 copy is rejected", async () => {
  const {
    dedupeSnapshotSource,
    dedupeSnapshotFirst,
    dedupeSnapshotDuplicate,
    dedupeSnapshot,
    dedupeSnapshotRestored,
    dedupeSnapshotStatsAfterRestore,
    dedupeSnapshotRestoredSeen,
    dedupeSnapshotRestoredUnseen,
    dedupeSnapshotTamperedError,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-pinned expectations — written out here from the
  // documented exportSnapshot() / restore() semantics in
  // src/webhooks.ts, never derived by calling the snapshot
  // pair to produce them. test/settlementEventDedupeSnapshot
  // .test.ts pins the same shapes independently (exported
  // entries verbatim, ids still duplicate after restore,
  // counters zeroed, the v:2 rejection message).
  assert.equal(DEMO_DEDUPE_SNAPSHOT_START_MS, Date.parse(DEMO_WEBHOOK_AT));
  assert.deepEqual(dedupeSnapshotFirst, [false, false]);
  assert.deepEqual(dedupeSnapshotDuplicate, [true, true]);
  assert.deepEqual(dedupeSnapshot, {
    v: 1,
    entries: DEMO_DEDUPE_SNAPSHOT_ENTRIES.map(([id, at]) => [id, at]),
  });
  assert.equal(dedupeSnapshotSource.size, 2);
  assert.deepEqual(dedupeSnapshotStatsAfterRestore, {
    size: 2,
    hits: 0,
    misses: 0,
    evictions: 0,
  });
  assert.deepEqual(dedupeSnapshotRestoredSeen, [true, true]);
  assert.equal(dedupeSnapshotRestoredUnseen, false);
  assert.equal(dedupeSnapshotRestored.size, 3);
  assert.equal(
    dedupeSnapshotTamperedError,
    DEMO_DEDUPE_SNAPSHOT_TAMPERED_ERROR,
  );
  assert.equal(
    DEMO_DEDUPE_SNAPSHOT_TAMPERED_ERROR,
    "SettlementEventDedupe: invalid snapshot: unsupported snapshot version 2 (expected 1)",
  );
  // The tamper ran on a detached copy: the exported
  // snapshot object itself is untouched.
  assert.equal(dedupeSnapshot.v, 1);
  // Independent cross-check: a fresh dedupe through the
  // library entry points reproduces the same shape — the
  // demo segment is not self-certifying.
  const probe = new SettlementEventDedupe({
    ttlMs: DEMO_DEDUPE_TTL_MS,
    now: () => DEMO_DEDUPE_SNAPSHOT_START_MS,
  });
  for (const eventId of DEMO_DEDUPE_SNAPSHOT_EVENT_IDS) {
    assert.equal(probe.checkAndRecord(eventId), false);
    assert.equal(probe.checkAndRecord(eventId), true);
  }
  const probeSnapshot = probe.exportSnapshot();
  assert.deepEqual(probeSnapshot, dedupeSnapshot);
  const probeRestored = SettlementEventDedupe.restore(
    JSON.parse(JSON.stringify(probeSnapshot)) as unknown,
    { ttlMs: DEMO_DEDUPE_TTL_MS, now: () => DEMO_DEDUPE_SNAPSHOT_START_MS },
  );
  assert.deepEqual(probeRestored.stats(), dedupeSnapshotStatsAfterRestore);
  for (const eventId of DEMO_DEDUPE_SNAPSHOT_EVENT_IDS) {
    assert.equal(probeRestored.checkAndRecord(eventId), true);
  }
  assert.equal(
    probeRestored.checkAndRecord(DEMO_DEDUPE_SNAPSHOT_UNSEEN_EVENT_ID),
    false,
  );
  assert.throws(
    () =>
      SettlementEventDedupe.restore(
        { ...probeSnapshot, v: 2 },
        { ttlMs: DEMO_DEDUPE_TTL_MS, now: () => DEMO_DEDUPE_SNAPSHOT_START_MS },
      ),
    new RegExp(
      DEMO_DEDUPE_SNAPSHOT_TAMPERED_ERROR.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      ),
    ),
  );
  // The segment follows the 429 Retry-After delivery
  // segment and precedes the dedupe-clear segment; it
  // prints its lines verbatim (only the snapshot version
  // and entry count — never a full entry line), and its
  // tampered-snapshot line is the segment's last line.
  const snapshotAt = text.indexOf(
    "Dedupe snapshot persistence (SettlementEventDedupe exportSnapshot / restore across a restart):",
  );
  assert.ok(
    snapshotAt >
      text.indexOf(
        "429 Retry-After webhook delivery (deliverSettlementWebhook via scripted fake fetch, zero network):",
      ),
    "dedupe snapshot segment must follow the 429 Retry-After delivery segment",
  );
  for (const line of [
    `  source dedupe (fixed clock ${DEMO_WEBHOOK_AT}, TTL ${DEMO_DEDUPE_TTL_MS} ms): eventId ${DEMO_DEDUPE_SNAPSHOT_EVENT_IDS[0]} — checkAndRecord: false (new event), again: true (duplicate); eventId ${DEMO_DEDUPE_SNAPSHOT_EVENT_IDS[1]} — checkAndRecord: false (new event), again: true (duplicate)`,
    `  exportSnapshot(): v 1, ${DEMO_DEDUPE_SNAPSHOT_ENTRIES.length} entries — only the version and entry count are printed, never the full entries (persist the JSON before shutdown)`,
    "  after JSON round-trip + SettlementEventDedupe.restore(): stats size 2, hits 0, misses 0, evictions 0 — counters restart at zero, the recorded ids do not",
    `  restored dedupe: eventId ${DEMO_DEDUPE_SNAPSHOT_EVENT_IDS[0]} — checkAndRecord: true (duplicate — the restart did not reopen the dedupe window); eventId ${DEMO_DEDUPE_SNAPSHOT_EVENT_IDS[1]} — checkAndRecord: true (duplicate); eventId ${DEMO_DEDUPE_SNAPSHOT_UNSEEN_EVENT_ID} — checkAndRecord: false (new event, recorded)`,
    `  tampered snapshot rejected: a detached copy with v changed to 2 throws "${DEMO_DEDUPE_SNAPSHOT_TAMPERED_ERROR}" — a corrupt snapshot fails loudly at startup instead of silently disabling deduplication`,
  ]) {
    assert.ok(text.includes(line), `missing dedupe snapshot line: ${line}`);
  }
  const snapshotSegment = lines.slice(
    lines.indexOf(
      "Dedupe snapshot persistence (SettlementEventDedupe exportSnapshot / restore across a restart):",
    ),
    lines.indexOf(
      "Dedupe clear reset (SettlementEventDedupe.clear() — explicit window reset):",
    ) - 1,
  );
  assert.equal(
    snapshotSegment[snapshotSegment.length - 1],
    `  tampered snapshot rejected: a detached copy with v changed to 2 throws "${DEMO_DEDUPE_SNAPSHOT_TAMPERED_ERROR}" — a corrupt snapshot fails loudly at startup instead of silently disabling deduplication`,
  );
});

test("demo dedupe snapshot persistence segment is deterministic: two runs print byte-identical snapshot lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf(
        "Dedupe snapshot persistence (SettlementEventDedupe exportSnapshot / restore across a restart):",
      ),
      ls.indexOf(
        "Dedupe clear reset (SettlementEventDedupe.clear() — explicit window reset):",
      ) - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + the source line + the export line + the
  // restore-stats line + the restored-checks line + the
  // tampered line; every value is derived from the fixed
  // fixtures alone, so no normalization is needed.
  assert.equal(segA.length, 6);
  assert.deepEqual(segA, segment(b.lines));
  assert.deepEqual(a.dedupeSnapshot, b.dedupeSnapshot);
  assert.deepEqual(a.dedupeSnapshotFirst, b.dedupeSnapshotFirst);
  assert.deepEqual(a.dedupeSnapshotDuplicate, b.dedupeSnapshotDuplicate);
  assert.deepEqual(
    a.dedupeSnapshotStatsAfterRestore,
    b.dedupeSnapshotStatsAfterRestore,
  );
  assert.deepEqual(a.dedupeSnapshotRestoredSeen, b.dedupeSnapshotRestoredSeen);
  assert.equal(a.dedupeSnapshotRestoredUnseen, b.dedupeSnapshotRestoredUnseen);
  assert.equal(a.dedupeSnapshotTamperedError, b.dedupeSnapshotTamperedError);
});

test("demo shows dedupe clear reset: clear drops the recorded id and zeroes the counters, and the same id counts as new again", async () => {
  const {
    dedupeClearDedupe,
    dedupeClearFirst,
    dedupeClearDuplicate,
    dedupeClearStatsBefore,
    dedupeClearStatsAfterClear,
    dedupeClearSizeAfterClear,
    dedupeClearRerecord,
    dedupeClearStatsAfterRerecord,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-pinned expectations — written out here from the
  // documented clear() semantics in src/webhooks.ts (drop
  // all tracked ids, reset the observability counters to
  // zero), never derived by calling clear() to produce
  // them. test/settlementEventDedupe.test.ts pins the same
  // shape independently (record, duplicate, clear to size
  // 0 with zeroed stats, the same id new again).
  assert.equal(DEMO_DEDUPE_CLEAR_START_MS, Date.parse(DEMO_WEBHOOK_AT));
  assert.equal(dedupeClearFirst, false);
  assert.equal(dedupeClearDuplicate, true);
  assert.deepEqual(dedupeClearStatsBefore, {
    size: 1,
    hits: 1,
    misses: 1,
    evictions: 0,
  });
  assert.equal(dedupeClearSizeAfterClear, 0);
  assert.deepEqual(dedupeClearStatsAfterClear, {
    size: 0,
    hits: 0,
    misses: 0,
    evictions: 0,
  });
  assert.equal(dedupeClearRerecord, false);
  assert.deepEqual(dedupeClearStatsAfterRerecord, {
    size: 1,
    hits: 0,
    misses: 1,
    evictions: 0,
  });
  assert.equal(dedupeClearDedupe.size, 1);
  // Independent cross-check: a fresh dedupe through the
  // library entry points reproduces the same shape — the
  // demo segment is not self-certifying.
  const probe = new SettlementEventDedupe({
    ttlMs: DEMO_DEDUPE_TTL_MS,
    now: () => DEMO_DEDUPE_CLEAR_START_MS,
  });
  assert.equal(probe.checkAndRecord(DEMO_DEDUPE_CLEAR_EVENT_ID), false);
  assert.equal(probe.checkAndRecord(DEMO_DEDUPE_CLEAR_EVENT_ID), true);
  assert.deepEqual(probe.stats(), dedupeClearStatsBefore);
  probe.clear();
  assert.equal(probe.size, 0);
  assert.deepEqual(probe.stats(), dedupeClearStatsAfterClear);
  assert.equal(probe.checkAndRecord(DEMO_DEDUPE_CLEAR_EVENT_ID), false);
  assert.deepEqual(probe.stats(), dedupeClearStatsAfterRerecord);
  // The segment follows the dedupe snapshot segment and
  // precedes the closing onError segment; it prints its
  // lines verbatim, and its re-record line is the
  // segment's last line.
  const clearAt = text.indexOf(
    "Dedupe clear reset (SettlementEventDedupe.clear() — explicit window reset):",
  );
  assert.ok(
    clearAt >
      text.indexOf(
        "Dedupe snapshot persistence (SettlementEventDedupe exportSnapshot / restore across a restart):",
      ),
    "dedupe clear segment must follow the dedupe snapshot segment",
  );
  for (const line of [
    `  dedupe (fixed clock ${DEMO_WEBHOOK_AT}, TTL ${DEMO_DEDUPE_TTL_MS} ms): eventId ${DEMO_DEDUPE_CLEAR_EVENT_ID} — checkAndRecord: false (new event), again: true (duplicate); stats before clear: size 1, hits 1, misses 1, evictions 0`,
    "  clear(): size 0 — stats size 0, hits 0, misses 0, evictions 0 (every recorded id dropped, every counter reset to zero)",
    `  same eventId after clear — checkAndRecord: false (new event again, recorded — the reset reopened the window on purpose); stats after re-record: size 1, hits 0, misses 1, evictions 0 (counting restarts from zero)`,
  ]) {
    assert.ok(text.includes(line), `missing dedupe clear line: ${line}`);
  }
  const clearSegment = lines.slice(
    lines.indexOf(
      "Dedupe clear reset (SettlementEventDedupe.clear() — explicit window reset):",
    ),
    lines.indexOf(
      "Subscribe onError error routing (Escrow.subscribe(listener, { onError }) on a branch escrow):",
    ) - 1,
  );
  assert.equal(
    clearSegment[clearSegment.length - 1],
    `  same eventId after clear — checkAndRecord: false (new event again, recorded — the reset reopened the window on purpose); stats after re-record: size 1, hits 0, misses 1, evictions 0 (counting restarts from zero)`,
  );
});

test("demo dedupe clear segment is deterministic: two runs print byte-identical clear lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf(
        "Dedupe clear reset (SettlementEventDedupe.clear() — explicit window reset):",
      ),
      ls.indexOf(
        "Subscribe onError error routing (Escrow.subscribe(listener, { onError }) on a branch escrow):",
      ) - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + the dedupe line + the clear line + the
  // re-record line; every value is derived from the fixed
  // fixtures alone, so no normalization is needed.
  assert.equal(segA.length, 4);
  assert.deepEqual(segA, segment(b.lines));
  assert.equal(a.dedupeClearFirst, b.dedupeClearFirst);
  assert.equal(a.dedupeClearDuplicate, b.dedupeClearDuplicate);
  assert.deepEqual(a.dedupeClearStatsBefore, b.dedupeClearStatsBefore);
  assert.deepEqual(a.dedupeClearStatsAfterClear, b.dedupeClearStatsAfterClear);
  assert.equal(a.dedupeClearSizeAfterClear, b.dedupeClearSizeAfterClear);
  assert.equal(a.dedupeClearRerecord, b.dedupeClearRerecord);
  assert.deepEqual(
    a.dedupeClearStatsAfterRerecord,
    b.dedupeClearStatsAfterRerecord,
  );
});

test("demo shows subscribe onError routing: a throwing listener's errors reach onError with dispatch context, a throwing onError is swallowed, and a non-function onError is rejected", async () => {
  const {
    onErrorEscrow,
    onErrorReports,
    onErrorProbeEscrow,
    onErrorProbeState,
    onErrorInvalidError,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-pinned expectations — written out here from the
  // documented subscribe() semantics in src/stateMachine.ts,
  // never derived by calling subscribe() to produce them.
  // test/subscribe.test.ts pins the same shapes
  // independently (the caught error reaches onError with
  // context {event: "FUND", from: "CREATED", to: "FUNDED"},
  // a throwing onError still lets dispatch complete, and
  // onError: "x" throws /invalid subscribe: onError/).
  assert.equal(onErrorEscrow.id, DEMO_ONERROR_ESCROW_ID);
  assert.equal(onErrorEscrow.state, "VERIFIED");
  assert.equal(onErrorEscrow.history.length, 3);
  assert.deepEqual(
    onErrorReports,
    DEMO_ONERROR_EXPECTED_REPORTS.map((r) => ({ ...r })),
  );
  assert.deepEqual(DEMO_ONERROR_EXPECTED_REPORTS, [
    {
      message: DEMO_ONERROR_LISTENER_ERROR,
      event: "FUND",
      from: "CREATED",
      to: "FUNDED",
    },
    {
      message: DEMO_ONERROR_LISTENER_ERROR,
      event: "SUBMIT_MILESTONE",
      from: "FUNDED",
      to: "MILESTONE_SUBMITTED",
    },
    {
      message: DEMO_ONERROR_LISTENER_ERROR,
      event: "VERIFY_PASS",
      from: "MILESTONE_SUBMITTED",
      to: "VERIFIED",
    },
  ]);
  // Every report's context equals the audit entry with the
  // same position: the routing never mislabels a dispatch.
  for (const [i, report] of onErrorReports.entries()) {
    const entry = onErrorEscrow.history[i];
    assert.equal(report.event, entry.event);
    assert.equal(report.from, entry.from);
    assert.equal(report.to, entry.to);
  }
  assert.equal(onErrorProbeEscrow.id, DEMO_ONERROR_PROBE_ESCROW_ID);
  assert.equal(onErrorProbeState, "FUNDED");
  assert.equal(onErrorProbeEscrow.state, "FUNDED");
  assert.equal(onErrorProbeEscrow.history.length, 1);
  assert.equal(onErrorInvalidError, DEMO_ONERROR_INVALID_ERROR);
  assert.equal(
    DEMO_ONERROR_INVALID_ERROR,
    "invalid subscribe: onError must be a function, got string",
  );
  assert.equal(onErrorEscrow.listenerCount, 1);
  // Independent cross-check: a fresh escrow through the
  // library entry points reproduces the same shape — the
  // demo segment is not self-certifying.
  const probe = new Escrow("demo-onerror-probe");
  const probeReports: Array<{
    message: string;
    event: string;
    from: string;
    to: string;
  }> = [];
  const boom = new Error(DEMO_ONERROR_LISTENER_ERROR);
  probe.subscribe(
    () => {
      throw boom;
    },
    {
      onError: (err, ctx) => {
        assert.equal(err, boom);
        probeReports.push({
          message: err instanceof Error ? err.message : String(err),
          event: ctx.event,
          from: ctx.from,
          to: ctx.to,
        });
      },
    },
  );
  probe.dispatch("FUND", "Deposit locked (wire received)", 10630, {
    actor: "sponsor",
    at: DEMO_ONERROR_FUND_AT,
  });
  probe.dispatch(
    "SUBMIT_MILESTONE",
    "Deliverable URLs + IPFS metadata hash",
    undefined,
    { actor: "creator", at: DEMO_ONERROR_SUBMIT_AT },
  );
  probe.dispatch("VERIFY_PASS", "KPIs validated by oracle", undefined, {
    actor: "oracle",
    at: DEMO_ONERROR_VERIFY_AT,
    evidence: DEMO_ONERROR_VERIFY_EVIDENCE,
  });
  assert.deepEqual(probeReports, onErrorReports);
  assert.equal(probe.state, "VERIFIED");
  assert.throws(
    () => probe.subscribe(() => {}, { onError: "x" as never }),
    new RegExp(
      DEMO_ONERROR_INVALID_ERROR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ),
  );
  assert.equal(probe.listenerCount, 1);
  // The segment follows the dedupe clear segment and
  // precedes the closing quorum revoke segment; it prints
  // its lines verbatim, and its rejection line is the
  // segment's last line.
  const onErrorAt = text.indexOf(
    "Subscribe onError error routing (Escrow.subscribe(listener, { onError }) on a branch escrow):",
  );
  assert.ok(
    onErrorAt >
      text.indexOf(
        "Dedupe clear reset (SettlementEventDedupe.clear() — explicit window reset):",
      ),
    "onError segment must follow the dedupe clear segment",
  );
  for (const line of [
    `  escrow ${DEMO_ONERROR_ESCROW_ID}: 1 throwing listener + 1 collecting onError — 3 fixed dispatches (FUND, SUBMIT_MILESTONE, VERIFY_PASS) all succeeded: state VERIFIED, 3 history entries (a throwing listener never breaks dispatch or the audit trail)`,
    `  onError received: 3 report(s) — first: "${DEMO_ONERROR_LISTENER_ERROR}" on FUND CREATED -> FUNDED (the error travels with its dispatch context)`,
    "  all contexts: FUND CREATED -> FUNDED; SUBMIT_MILESTONE FUNDED -> MILESTONE_SUBMITTED; VERIFY_PASS MILESTONE_SUBMITTED -> VERIFIED",
    `  probe escrow ${DEMO_ONERROR_PROBE_ESCROW_ID}: an onError that itself throws is swallowed too — dispatch FUND still returned FUNDED (1 history entry)`,
    `  non-function onError rejected at subscribe time: "${DEMO_ONERROR_INVALID_ERROR}" — nothing was registered (listenerCount still 1)`,
  ]) {
    assert.ok(text.includes(line), `missing onError line: ${line}`);
  }
  const onErrorSegment = lines.slice(
    lines.indexOf(
      "Subscribe onError error routing (Escrow.subscribe(listener, { onError }) on a branch escrow):",
    ),
    lines.indexOf(
      "Quorum revoke (Quorum.revoke() — a signer changes their vote):",
    ) - 1,
  );
  assert.equal(
    onErrorSegment[onErrorSegment.length - 1],
    `  non-function onError rejected at subscribe time: "${DEMO_ONERROR_INVALID_ERROR}" — nothing was registered (listenerCount still 1)`,
  );
});

test("demo subscribe onError segment is deterministic: two runs print byte-identical routing lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf(
        "Subscribe onError error routing (Escrow.subscribe(listener, { onError }) on a branch escrow):",
      ),
      ls.indexOf(
        "Quorum revoke (Quorum.revoke() — a signer changes their vote):",
      ) - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + the escrow line + the received line + the
  // all-contexts line + the probe line + the rejection
  // line; every value is derived from the fixed fixtures
  // alone, so no normalization is needed.
  assert.equal(segA.length, 6);
  assert.deepEqual(segA, segment(b.lines));
  assert.deepEqual(a.onErrorReports, b.onErrorReports);
  assert.equal(a.onErrorProbeState, b.onErrorProbeState);
  assert.equal(a.onErrorInvalidError, b.onErrorInvalidError);
});

test("demo shows quorum revoke: a revoked vote drops below threshold and a re-approval restores it with the re-voter last", async () => {
  const {
    quorumRevokeQuorum,
    quorumRevokeCountBefore,
    quorumRevokeHasQuorumBefore,
    quorumRevokeCountAfterRevoke,
    quorumRevokeHasQuorumAfterRevoke,
    quorumRevokeApprovalsAfterRevoke,
    quorumRevokeCountAfterReapprove,
    quorumRevokeHasQuorumAfterReapprove,
    quorumRevokeApprovalsAfterReapprove,
    quorumRevokeLogFinal,
    quorumRevokeUnknownError,
    quorumRevokeNotApprovedError,
    lines,
  } = await runDemo();
  const text = lines.join("\n");
  // Hand-pinned expectations — written from the documented
  // revoke() semantics in src/quorum.ts and cross-checked
  // against test/revoke.test.ts, never derived by calling
  // the demo segment itself.
  assert.equal(quorumRevokeCountBefore, 2);
  assert.equal(quorumRevokeHasQuorumBefore, true);
  assert.equal(quorumRevokeCountAfterRevoke, 1);
  assert.equal(quorumRevokeHasQuorumAfterRevoke, false);
  assert.deepEqual(quorumRevokeApprovalsAfterRevoke, [DEMO_QUORUM_SIGNERS[1]]);
  assert.deepEqual(DEMO_REVOKE_LOG_AFTER_REVOKE, [
    { signerId: "arb-2", at: "2026-03-17T09:01:00.000Z" },
  ]);
  assert.equal(quorumRevokeCountAfterReapprove, 2);
  assert.equal(quorumRevokeHasQuorumAfterReapprove, true);
  assert.deepEqual(quorumRevokeApprovalsAfterReapprove, [
    DEMO_QUORUM_SIGNERS[1],
    DEMO_QUORUM_SIGNERS[0],
  ]);
  assert.deepEqual(quorumRevokeLogFinal, DEMO_REVOKE_LOG_FINAL);
  assert.deepEqual(DEMO_REVOKE_LOG_FINAL, [
    { signerId: "arb-2", at: "2026-03-17T09:01:00.000Z" },
    { signerId: "arb-1", at: "2026-03-17T09:02:00.000Z" },
  ]);
  assert.equal(quorumRevokeUnknownError, DEMO_REVOKE_UNKNOWN_ERROR);
  assert.equal(DEMO_REVOKE_UNKNOWN_ERROR, 'unknown quorum signer: "mallory"');
  assert.equal(quorumRevokeNotApprovedError, DEMO_REVOKE_NOT_APPROVED_ERROR);
  assert.equal(
    DEMO_REVOKE_NOT_APPROVED_ERROR,
    'cannot revoke: signer "arb-3" has not approved',
  );
  assert.equal(quorumRevokeQuorum.approvalCount(), 2);
  assert.equal(quorumRevokeQuorum.hasQuorum(), true);
  assert.deepEqual(quorumRevokeQuorum.approvals(), [
    DEMO_QUORUM_SIGNERS[1],
    DEMO_QUORUM_SIGNERS[0],
  ]);
  // Independent cross-check: a fresh quorum through the
  // library entry points reproduces the same cycle — the
  // demo segment is not self-certifying.
  let probeNowMs = Date.parse(DEMO_REVOKE_FIRST_AT);
  const probe = createQuorum({
    threshold: DEMO_QUORUM_THRESHOLD,
    signers: [...DEMO_QUORUM_SIGNERS],
    now: () => probeNowMs,
  });
  probe.approve(DEMO_QUORUM_SIGNERS[0]);
  probeNowMs = Date.parse(DEMO_REVOKE_SECOND_AT);
  probe.approve(DEMO_QUORUM_SIGNERS[1]);
  assert.equal(probe.approvalCount(), quorumRevokeCountBefore);
  probe.revoke(DEMO_QUORUM_SIGNERS[0]);
  assert.equal(probe.approvalCount(), quorumRevokeCountAfterRevoke);
  assert.equal(probe.hasQuorum(), false);
  assert.deepEqual(probe.approvalLog(), DEMO_REVOKE_LOG_AFTER_REVOKE);
  probeNowMs = Date.parse(DEMO_REVOKE_REAPPROVE_AT);
  probe.approve(DEMO_QUORUM_SIGNERS[0]);
  assert.deepEqual(probe.approvals(), quorumRevokeApprovalsAfterReapprove);
  assert.deepEqual(probe.approvalLog(), quorumRevokeLogFinal);
  assert.throws(
    () => probe.revoke(DEMO_REVOKE_UNKNOWN_SIGNER),
    new Error(DEMO_REVOKE_UNKNOWN_ERROR),
  );
  assert.throws(
    () => probe.revoke(DEMO_QUORUM_SIGNERS[2]),
    new Error(DEMO_REVOKE_NOT_APPROVED_ERROR),
  );
  assert.equal(probe.approvalCount(), 2);
  // The segment follows the onError segment and prints
  // its lines verbatim; the AbortSignal segment follows
  // it (and the expectedSeq and verifyEvidence segments
  // close the demo after that).
  const revokeAt = text.indexOf(
    "Quorum revoke (Quorum.revoke() — a signer changes their vote):",
  );
  assert.ok(
    revokeAt >
      text.indexOf(
        "Subscribe onError error routing (Escrow.subscribe(listener, { onError }) on a branch escrow):",
      ),
    "quorum revoke segment must follow the onError segment",
  );
  for (const line of [
    `  quorum (${DEMO_QUORUM_THRESHOLD}-of-${DEMO_QUORUM_SIGNERS.length}): approvals at ${DEMO_REVOKE_FIRST_AT} (${DEMO_QUORUM_SIGNERS[0]}) and ${DEMO_REVOKE_SECOND_AT} (${DEMO_QUORUM_SIGNERS[1]}) — approvalCount 2, hasQuorum: true`,
    `  revoke ${DEMO_QUORUM_SIGNERS[0]}: approvalCount 1, hasQuorum: false — approvals now [${DEMO_QUORUM_SIGNERS[1]}], approvalLog keeps 1 entry (revoke removes the signer's entries; expiry never does)`,
    `  re-approve ${DEMO_QUORUM_SIGNERS[0]} at ${DEMO_REVOKE_REAPPROVE_AT}: approvalCount 2, hasQuorum: true — approvals [${DEMO_QUORUM_SIGNERS[1]}, ${DEMO_QUORUM_SIGNERS[0]}] (the re-voter sorts last, by latest approval)`,
    `  revoke unknown signer "${DEMO_REVOKE_UNKNOWN_SIGNER}" rejected: "${DEMO_REVOKE_UNKNOWN_ERROR}"`,
    `  revoke ${DEMO_QUORUM_SIGNERS[2]} (never approved) rejected: "${DEMO_REVOKE_NOT_APPROVED_ERROR}" — both failed revokes leave the quorum untouched (approvalCount still 2, hasQuorum: true)`,
  ]) {
    assert.ok(text.includes(line), `missing quorum revoke line: ${line}`);
  }
  const abortAt = text.indexOf(
    "Webhook delivery abort (deliverSettlementWebhook with an AbortSignal, scripted fake fetch, zero network):",
  );
  assert.ok(abortAt > revokeAt, "abort segment must follow the quorum revoke segment");
});

test("demo quorum revoke segment is deterministic: two runs print byte-identical revoke lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf(
        "Quorum revoke (Quorum.revoke() — a signer changes their vote):",
      ),
      ls.indexOf(
        "Webhook delivery abort (deliverSettlementWebhook with an AbortSignal, scripted fake fetch, zero network):",
      ) - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + the reached line + the revoke line + the
  // re-approve line + the two rejection lines; every value
  // is derived from the fixed fixtures alone, so no
  // normalization is needed.
  assert.equal(segA.length, 6);
  assert.deepEqual(segA, segment(b.lines));
  assert.equal(a.quorumRevokeCountBefore, b.quorumRevokeCountBefore);
  assert.equal(a.quorumRevokeCountAfterRevoke, b.quorumRevokeCountAfterRevoke);
  assert.deepEqual(
    a.quorumRevokeApprovalsAfterReapprove,
    b.quorumRevokeApprovalsAfterReapprove,
  );
  assert.deepEqual(a.quorumRevokeLogFinal, b.quorumRevokeLogFinal);
  assert.equal(a.quorumRevokeUnknownError, b.quorumRevokeUnknownError);
  assert.equal(
    a.quorumRevokeNotApprovedError,
    b.quorumRevokeNotApprovedError,
  );
});

test("demo shows webhook delivery abort: a pre-aborted signal fetches zero times and an abort during backoff stops the retry", async () => {
  const {
    webhook,
    abortPreAbortedError,
    abortPreAbortedFetchCalls,
    abortDuringBackoffError,
    abortDuringBackoffFetchCalls,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-pinned expectations — written from the documented
  // deliverSettlementWebhook abort semantics in
  // src/webhooks.ts, never derived by calling the delivery
  // itself. test/webhookAbortSignal.test.ts pins the same
  // two shapes against the library directly.
  assert.equal(abortPreAbortedError, DEMO_ABORT_ERROR);
  assert.equal(abortPreAbortedFetchCalls, 0);
  assert.equal(abortDuringBackoffError, DEMO_ABORT_ERROR);
  assert.equal(abortDuringBackoffFetchCalls, 1);
  // Independent library-side probe: a pre-aborted signal
  // against a counting fetch rejects with the pinned error
  // and never fetches (the demo's own signed webhook is
  // the payload).
  let probeCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    probeCalls += 1;
    return new Response("{}", { status: 200 });
  };
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      deliverSettlementWebhook(DEMO_ABORT_PRE_URL, webhook, {
        signal: controller.signal,
      }),
      new Error(DEMO_ABORT_ERROR),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(probeCalls, 0);
  // The segment follows the quorum revoke segment and
  // prints its lines verbatim; the expectedSeq segment
  // follows it (and the verifyEvidence segment closes
  // the demo after that).
  const abortAt = text.indexOf(
    "Webhook delivery abort (deliverSettlementWebhook with an AbortSignal, scripted fake fetch, zero network):",
  );
  assert.ok(
    abortAt >
      text.indexOf(
        "Quorum revoke (Quorum.revoke() — a signer changes their vote):",
      ),
    "abort segment must follow the quorum revoke segment",
  );
  for (const line of [
    `  pre-aborted signal: endpoint ${DEMO_ABORT_PRE_URL} — delivery throws "${DEMO_ABORT_ERROR}" before any request: fake fetch called 0 time(s), zero attempts made`,
    `  abort during backoff: endpoint ${DEMO_ABORT_BACKOFF_URL} — attempt 1 answered scripted 500, the caller aborts during the pinned ${DEMO_ABORT_BACKOFF_MS} ms backoff sleep: delivery rejects "${DEMO_ABORT_ERROR}", fake fetch called 1 time(s) — no retry fires and the wait never elapses`,
    "  an abort is a caller request to stop, never a retryable failure: neither shape retries, sleeps it off, or reports success",
  ]) {
    assert.ok(text.includes(line), `missing abort line: ${line}`);
  }
  const expectedSeqAt = text.indexOf(
    "Optimistic concurrency (dispatch expectedSeq guard on a branch escrow):",
  );
  assert.ok(
    expectedSeqAt > abortAt,
    "expectedSeq segment must follow the abort segment",
  );
  const verifyEvidenceAt = text.indexOf(
    "Verify evidence gate (EscrowOptions.requireVerifyEvidence on branch escrows):",
  );
  assert.ok(
    verifyEvidenceAt > expectedSeqAt,
    "verifyEvidence segment must follow the expectedSeq segment",
  );
});

test("demo webhook abort segment is deterministic: two runs print byte-identical abort lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf(
        "Webhook delivery abort (deliverSettlementWebhook with an AbortSignal, scripted fake fetch, zero network):",
      ),
      ls.indexOf(
        "Optimistic concurrency (dispatch expectedSeq guard on a branch escrow):",
      ) - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + the pre-aborted line + the backoff line + the
  // summary line; every value is derived from the fixed
  // fixtures alone, so no normalization is needed.
  assert.equal(segA.length, 4);
  assert.deepEqual(segA, segment(b.lines));
  assert.equal(a.abortPreAbortedError, b.abortPreAbortedError);
  assert.equal(a.abortPreAbortedFetchCalls, b.abortPreAbortedFetchCalls);
  assert.equal(a.abortDuringBackoffError, b.abortDuringBackoffError);
  assert.equal(a.abortDuringBackoffFetchCalls, b.abortDuringBackoffFetchCalls);
});

test("demo shows dispatch expectedSeq optimistic concurrency: matching pins advance one entry each, a stale pin conflicts without touching the escrow, invalid pins throw, and an unguarded dispatch is unchanged", async () => {
  const {
    expectedSeqEscrow,
    expectedSeqFundState,
    expectedSeqSeqAfterFund,
    expectedSeqSubmitState,
    expectedSeqSeqAfterSubmit,
    expectedSeqStaleError,
    expectedSeqStateAfterStale,
    expectedSeqHistoryLengthAfterStale,
    expectedSeqInvalidNegativeError,
    expectedSeqInvalidFractionError,
    expectedSeqUnguardedState,
    expectedSeqFinalHistoryLength,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-pinned fixture shape: the pinned errors are the
  // exact strings src/stateMachine.ts throws for a seq-1
  // pin at seq 2 and for the two invalid pin shapes.
  assert.equal(
    DEMO_EXPECTED_SEQ_STALE_ERROR,
    "dispatch conflict: expected seq 1 but escrow is at seq 2",
  );
  assert.equal(
    DEMO_EXPECTED_SEQ_INVALID_NEGATIVE_ERROR,
    "invalid dispatch options: expectedSeq must be a non-negative integer, got -1",
  );
  assert.equal(
    DEMO_EXPECTED_SEQ_INVALID_FRACTION_ERROR,
    "invalid dispatch options: expectedSeq must be a non-negative integer, got 1.5",
  );

  // The four shapes: matching pins advance exactly one
  // entry each, the stale pin conflicts and changes
  // nothing, both invalid pins throw their pinned
  // validation errors, and the unguarded dispatch keeps
  // the pre-guard behavior.
  assert.equal(expectedSeqFundState, "FUNDED");
  assert.equal(expectedSeqSeqAfterFund, 1);
  assert.equal(expectedSeqSubmitState, "MILESTONE_SUBMITTED");
  assert.equal(expectedSeqSeqAfterSubmit, 2);
  assert.equal(expectedSeqStaleError, DEMO_EXPECTED_SEQ_STALE_ERROR);
  assert.equal(expectedSeqStateAfterStale, "MILESTONE_SUBMITTED");
  assert.equal(expectedSeqHistoryLengthAfterStale, 2);
  assert.equal(
    expectedSeqInvalidNegativeError,
    DEMO_EXPECTED_SEQ_INVALID_NEGATIVE_ERROR,
  );
  assert.equal(
    expectedSeqInvalidFractionError,
    DEMO_EXPECTED_SEQ_INVALID_FRACTION_ERROR,
  );
  assert.equal(expectedSeqUnguardedState, "VERIFIED");
  assert.equal(expectedSeqFinalHistoryLength, 3);
  assert.equal(expectedSeqEscrow.id, DEMO_EXPECTED_SEQ_ESCROW_ID);
  assert.equal(expectedSeqEscrow.state, "VERIFIED");
  assert.deepEqual(
    expectedSeqEscrow.history.map((e) => [e.seq, e.event, e.at]),
    [
      [1, "FUND", DEMO_EXPECTED_SEQ_FUND_AT],
      [2, "SUBMIT_MILESTONE", DEMO_EXPECTED_SEQ_SUBMIT_AT],
      [3, "VERIFY_PASS", DEMO_EXPECTED_SEQ_VERIFY_AT],
    ],
  );
  assert.equal(
    expectedSeqEscrow.history[2].evidence,
    DEMO_EXPECTED_SEQ_VERIFY_EVIDENCE,
  );

  // Independent re-verification: a fresh escrow driven
  // by hand through the same shapes agrees — a matching
  // pin advances, the stale pin throws the pinned
  // conflict, both invalid pins throw, and the
  // unguarded dispatch still lands.
  const probe = new Escrow("probe-expected-seq-demo");
  assert.equal(
    probe.dispatch("FUND", undefined, 100, { expectedSeq: 0 }),
    "FUNDED",
  );
  assert.throws(
    () => probe.dispatch("SUBMIT_MILESTONE", undefined, undefined, { expectedSeq: 0 }),
    new Error("dispatch conflict: expected seq 0 but escrow is at seq 1"),
  );
  assert.equal(probe.state, "FUNDED");
  assert.equal(probe.history.length, 1);
  assert.throws(
    () => probe.dispatch("SUBMIT_MILESTONE", undefined, undefined, { expectedSeq: -1 }),
    new Error(DEMO_EXPECTED_SEQ_INVALID_NEGATIVE_ERROR),
  );
  assert.throws(
    () => probe.dispatch("SUBMIT_MILESTONE", undefined, undefined, { expectedSeq: 1.5 }),
    new Error(DEMO_EXPECTED_SEQ_INVALID_FRACTION_ERROR),
  );
  assert.equal(
    probe.dispatch("SUBMIT_MILESTONE", undefined, undefined, { expectedSeq: 1 }),
    "MILESTONE_SUBMITTED",
  );
  assert.equal(probe.dispatch("VERIFY_PASS"), "VERIFIED");
  assert.equal(probe.history.length, 3);

  // The segment follows the abort segment and prints
  // its lines verbatim; the verifyEvidence segment
  // closes the demo after it.
  const abortAt = text.indexOf(
    "Webhook delivery abort (deliverSettlementWebhook with an AbortSignal, scripted fake fetch, zero network):",
  );
  const expectedSeqAt = text.indexOf(
    "Optimistic concurrency (dispatch expectedSeq guard on a branch escrow):",
  );
  assert.ok(
    expectedSeqAt > abortAt,
    "expectedSeq segment must follow the abort segment",
  );
  for (const line of [
    `  escrow ${DEMO_EXPECTED_SEQ_ESCROW_ID}: FUND with expectedSeq 0 (the empty history): -> FUNDED, seq 0 -> 1 (a matching guard advances exactly one entry)`,
    `  SUBMIT_MILESTONE with expectedSeq 1: -> MILESTONE_SUBMITTED, seq 1 -> 2 (the fresh pin matches again)`,
    `  VERIFY_PASS retried with stale expectedSeq 1 (a second writer still holding the seq-1 snapshot): throws "${DEMO_EXPECTED_SEQ_STALE_ERROR}" — state stays MILESTONE_SUBMITTED, history stays 2 entries (nothing appended, nothing overwritten)`,
    `  VERIFY_PASS with expectedSeq -1: throws "${DEMO_EXPECTED_SEQ_INVALID_NEGATIVE_ERROR}" (a caller configuration error, checked before the transition)`,
    `  VERIFY_PASS with expectedSeq 1.5: throws "${DEMO_EXPECTED_SEQ_INVALID_FRACTION_ERROR}" (a non-integer pin is rejected the same way)`,
    `  VERIFY_PASS without expectedSeq: -> VERIFIED, seq 2 -> 3 (omitting the guard preserves the pre-guard behavior)`,
  ]) {
    assert.ok(text.includes(line), `missing expectedSeq line: ${line}`);
  }
  const verifyEvidenceAt = text.indexOf(
    "Verify evidence gate (EscrowOptions.requireVerifyEvidence on branch escrows):",
  );
  assert.ok(
    verifyEvidenceAt > expectedSeqAt,
    "verifyEvidence segment must follow the expectedSeq segment",
  );
});

test("demo expectedSeq segment is deterministic: two runs print byte-identical expectedSeq lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf(
        "Optimistic concurrency (dispatch expectedSeq guard on a branch escrow):",
      ),
      ls.indexOf(
        "Verify evidence gate (EscrowOptions.requireVerifyEvidence on branch escrows):",
      ) - 1,
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + the two matching-pin lines + the stale
  // line + the two invalid-pin lines + the unguarded
  // line; every value is derived from the fixed
  // fixtures alone, so no normalization is needed.
  assert.equal(segA.length, 7);
  assert.deepEqual(segA, segment(b.lines));
  assert.equal(a.expectedSeqStaleError, b.expectedSeqStaleError);
  assert.equal(
    a.expectedSeqInvalidNegativeError,
    b.expectedSeqInvalidNegativeError,
  );
  assert.equal(
    a.expectedSeqInvalidFractionError,
    b.expectedSeqInvalidFractionError,
  );
  assert.equal(a.expectedSeqFinalHistoryLength, b.expectedSeqFinalHistoryLength);
});

test("demo shows requireVerifyEvidence gate: an evidence-free VERIFY_PASS is refused without touching the strict escrow, the same dispatch with evidence passes and records it, and a default escrow is unchanged", async () => {
  const {
    verifyEvidenceEscrow,
    verifyEvidenceError,
    verifyEvidenceStateAfterReject,
    verifyEvidenceHistoryLengthAfterReject,
    verifyEvidenceVerifiedState,
    verifyEvidenceRecordedEvidence,
    verifyEvidenceDefaultEscrow,
    verifyEvidenceDefaultState,
    lines,
  } = await runDemo();
  const text = lines.join("\n");

  // Hand-pinned fixture shape: the pinned error is the
  // exact string src/stateMachine.ts throws when the
  // gate is on and no evidence reference is given.
  assert.equal(
    DEMO_VERIFY_EVIDENCE_ERROR,
    'verify evidence required: dispatch("VERIFY_PASS") requires a non-empty evidence reference when requireVerifyEvidence is enabled',
  );

  // The three shapes: the evidence-free dispatch is
  // refused and changes nothing, the same dispatch
  // with evidence succeeds and records the reference
  // verbatim, and the default escrow (flag off) keeps
  // the pre-gate behavior.
  assert.equal(verifyEvidenceError, DEMO_VERIFY_EVIDENCE_ERROR);
  assert.equal(verifyEvidenceStateAfterReject, "MILESTONE_SUBMITTED");
  assert.equal(verifyEvidenceHistoryLengthAfterReject, 2);
  assert.equal(verifyEvidenceVerifiedState, "VERIFIED");
  assert.equal(verifyEvidenceRecordedEvidence, DEMO_VERIFY_EVIDENCE_REF);
  assert.equal(verifyEvidenceEscrow.id, DEMO_VERIFY_EVIDENCE_ESCROW_ID);
  assert.equal(verifyEvidenceEscrow.state, "VERIFIED");
  assert.deepEqual(
    verifyEvidenceEscrow.history.map((e) => [e.seq, e.event, e.at]),
    [
      [1, "FUND", DEMO_VERIFY_EVIDENCE_FUND_AT],
      [2, "SUBMIT_MILESTONE", DEMO_VERIFY_EVIDENCE_SUBMIT_AT],
      [3, "VERIFY_PASS", DEMO_VERIFY_EVIDENCE_VERIFY_AT],
    ],
  );
  assert.equal(
    verifyEvidenceEscrow.history[2].evidence,
    DEMO_VERIFY_EVIDENCE_REF,
  );
  assert.equal(verifyEvidenceDefaultState, "VERIFIED");
  assert.equal(
    verifyEvidenceDefaultEscrow.id,
    DEMO_VERIFY_EVIDENCE_DEFAULT_ESCROW_ID,
  );
  assert.equal(verifyEvidenceDefaultEscrow.state, "VERIFIED");
  assert.equal(verifyEvidenceDefaultEscrow.history.length, 3);
  assert.ok(
    !("evidence" in verifyEvidenceDefaultEscrow.history[2]),
    "default escrow VERIFY_PASS entry must carry no evidence field",
  );

  // Independent re-verification: fresh escrows driven
  // by hand through the same shapes agree — the strict
  // escrow refuses without evidence (state and history
  // untouched), accepts with evidence, and a default
  // escrow accepts without evidence.
  const probeStrict = new Escrow("probe-verify-evidence-demo", {
    requireVerifyEvidence: true,
  });
  probeStrict.dispatch("FUND", undefined, 100);
  probeStrict.dispatch("SUBMIT_MILESTONE");
  assert.throws(
    () => probeStrict.dispatch("VERIFY_PASS"),
    new Error(DEMO_VERIFY_EVIDENCE_ERROR),
  );
  assert.equal(probeStrict.state, "MILESTONE_SUBMITTED");
  assert.equal(probeStrict.history.length, 2);
  assert.equal(
    probeStrict.dispatch("VERIFY_PASS", undefined, undefined, {
      evidence: "probe-evidence-ref",
    }),
    "VERIFIED",
  );
  assert.equal(probeStrict.history[2].evidence, "probe-evidence-ref");
  const probeDefault = new Escrow("probe-verify-evidence-default-demo");
  probeDefault.dispatch("FUND", undefined, 100);
  probeDefault.dispatch("SUBMIT_MILESTONE");
  assert.equal(probeDefault.dispatch("VERIFY_PASS"), "VERIFIED");
  assert.ok(!("evidence" in probeDefault.history[2]));

  // The segment closes the demo: it follows the
  // expectedSeq segment, prints its lines verbatim,
  // and its pre-gate-behavior line is the demo's last
  // line.
  const expectedSeqAt = text.indexOf(
    "Optimistic concurrency (dispatch expectedSeq guard on a branch escrow):",
  );
  const verifyEvidenceAt = text.indexOf(
    "Verify evidence gate (EscrowOptions.requireVerifyEvidence on branch escrows):",
  );
  assert.ok(
    verifyEvidenceAt > expectedSeqAt,
    "verifyEvidence segment must follow the expectedSeq segment",
  );
  for (const line of [
    `  escrow ${DEMO_VERIFY_EVIDENCE_ESCROW_ID} (requireVerifyEvidence: true): FUND 10630 -> FUNDED, SUBMIT_MILESTONE -> MILESTONE_SUBMITTED on fixed timestamps (the gate is armed)`,
    `  VERIFY_PASS without evidence: throws "${DEMO_VERIFY_EVIDENCE_ERROR}" — state stays MILESTONE_SUBMITTED, history stays 2 entries (nothing appended)`,
    `  VERIFY_PASS with evidence "${DEMO_VERIFY_EVIDENCE_REF}": -> VERIFIED, evidence recorded verbatim on the audit entry (the library records the caller's reference; it does not verify the oracle or proof itself)`,
    `  escrow ${DEMO_VERIFY_EVIDENCE_DEFAULT_ESCROW_ID} (default, flag off): VERIFY_PASS without evidence -> VERIFIED (omitting the flag preserves the pre-gate behavior)`,
  ]) {
    assert.ok(text.includes(line), `missing verifyEvidence line: ${line}`);
  }
  assert.equal(
    lines[lines.length - 1],
    `  escrow ${DEMO_VERIFY_EVIDENCE_DEFAULT_ESCROW_ID} (default, flag off): VERIFY_PASS without evidence -> VERIFIED (omitting the flag preserves the pre-gate behavior)`,
  );
});

test("demo verifyEvidence segment is deterministic: two runs print byte-identical verifyEvidence lines", async () => {
  const segment = (ls: string[]) =>
    ls.slice(
      ls.indexOf(
        "Verify evidence gate (EscrowOptions.requireVerifyEvidence on branch escrows):",
      ),
    );
  const a = await runDemo();
  const b = await runDemo();
  const segA = segment(a.lines);
  // Header + the armed line + the refusal line + the
  // evidence line + the default line; every value is
  // derived from the fixed fixtures alone, so no
  // normalization is needed.
  assert.equal(segA.length, 5);
  assert.deepEqual(segA, segment(b.lines));
  assert.equal(a.verifyEvidenceError, b.verifyEvidenceError);
  assert.equal(
    a.verifyEvidenceRecordedEvidence,
    b.verifyEvidenceRecordedEvidence,
  );
  assert.equal(
    a.verifyEvidenceHistoryLengthAfterReject,
    b.verifyEvidenceHistoryLengthAfterReject,
  );
});
