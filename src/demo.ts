/**
 * Demo: drive one escrow through the full happy path
 * CREATED -> FUNDED -> MILESTONE_SUBMITTED -> VERIFIED -> RELEASED,
 * print the append-only audit history plus the final settlement report,
 * verify that history's hash chain with `verifyHistoryChain` — the
 * intact chain passes, and a detached copy whose FUND entry's amount
 * is altered fails, while the escrow's own history stays untouched —
 * then build the signed settlement webhook for the released escrow and
 * verify it the way a receiver would. The receiver side then runs
 * that webhook's `eventId` through `SettlementEventDedupe` on a fixed
 * clock: the first delivery is new (booked), an immediate redelivery
 * is a duplicate (skipped), and after the clock advances by exactly
 * the TTL the same id counts as new again. The sender side then
 * parses `Retry-After` hints with `parseRetryAfter` on the same
 * fixed clock: a fixed corpus (delay-seconds, a whitespace-padded
 * value, future and past HTTP-dates, a signed value, a garbage
 * string, and null) is printed value by value — both hint forms
 * normalize to milliseconds, a past date yields 0, and unparsable
 * or absent values yield `undefined`, the caller's cue to fall
 * back to exponential backoff. A second escrow then walks the
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
 * built webhook printed per successful item. The main report is
 * then delivered for real in a fan-out segment:
 * `deliverSettlementWebhookToMany` sends that one logical
 * settlement event to three fixed endpoints through an injected
 * deterministic fake `fetch` (zero network — the library's
 * delivery layer calls the global `fetch`, so the fake is
 * installed on `globalThis` for this segment only and the
 * original is restored afterwards): every endpoint answers 200
 * on the first attempt, so the aggregate reads 3 delivered /
 * 0 failed; the captured calls are asserted, outside the
 * printing, to carry byte-identical bodies (one shared
 * `eventId`, one shared `at`), each signed with its own
 * endpoint's secret and verifiable only under that secret.
 * Because delivery is asynchronous, `runDemo` is async.
 * The demo closes with a
 * watchdog screening over three further escrows on one fixed `now`:
 * `staleEscrows` selects by dwell in the current state (the last
 * history entry's `at` against a per-state budget, deadline ignored)
 * while `expiredEscrows` selects the same batch by absolute deadline
 * — the two axes pick different escrows — and `actOnStaleEscrows`
 * then expires the one stale escrow, its dispatch pinned to the same
 * fixed `now` so no wall clock enters the audit history. A final
 * deadline-watchdog section then screens three more escrows with
 * `expiredEscrows` on the same fixed `now` and runs that selection
 * through the `expireOverdueEscrows` executor: the VERIFIED escrow
 * past its deadline has no EXPIRE edge, so it lands as a per-item
 * error without blocking the past-deadline FUNDED escrow after it,
 * which expires; the third escrow is stale-only (its deadline is
 * still ahead), so the deadline executor never attempts it — the
 * two watchdog axes pick disjoint subsets of this batch too. One
 * honest caveat: the executor dispatches EXPIRE with no pinned
 * `at`, so its audit entries carry the dispatch-time wall clock;
 * the demo prints no timestamp for those entries, so its printed
 * output stays byte-identical across runs. The demo then prints an
 * allowed-events listing: `allowedEvents(state)` is run
 * over all 8 states in transition-table order and printed as a
 * one-line-per-state overview — the query an escrow-list UI or a
 * watchdog consults to decide what an escrow can do next — with
 * the three terminal states (RELEASED / REFUNDED / EXPIRED)
 * returning the empty list, and the main escrow's own RELEASED
 * state called out on its own line as that same empty set. The demo
 * then prints a deposit-provenance segment:
 * `depositAmountFromHistory` traces the locked deposit back out of
 * the main escrow's audit history alone (the sum of every FUND
 * amount — the golden 10,630 the settlement report above was built
 * on), and a fixed copy of that history with every FUND entry
 * removed is shown failing with the explicit
 * `settlement requires a FUND amount` error — a history that cannot
 * corroborate a deposit settles nothing, rather than guessing.
 * The demo then shows a settlement-split segment:
 * `settleRelease` splits that same golden deposit in isolation —
 * gross 10,630 at the main escrow's 500 bps pro fee yields a
 * 531.50 platform fee and a 10,098.50 creator net with zero
 * referral credits, the three parts summing back to the deposit
 * exactly — the same split the settlement report above was built
 * on, shown as the pure function's own input and output.
 * The demo then shows an audit-history NDJSON round-trip
 * segment: the main escrow's history is exported with
 * `historyToNdjson` (one JSON entry per line, seq order) and read
 * back with `historyFromNdjson` — the persistence channel an
 * escrow's fund-flow audit log uses to land on disk and feed
 * reconciliation — and the round-tripped entries are asserted,
 * outside the printing, to match the original history verbatim:
 * same entry count, continuous seq chain, and the final entry
 * landing in RELEASED. The demo then shows an overdue
 * judgement segment: a further funded escrow with a fixed
 * deadline is judged by `isOverdue` at three fixed instants —
 * before the deadline (false), exactly at the deadline (true:
 * the boundary counts as overdue), and after it (true) — the
 * advisory boolean a watchdog reads before it dispatches EXPIRE
 * explicitly; the judgement itself dispatches nothing and the
 * escrow stays FUNDED.
 * The demo then shows a state-diagram generation
 * segment: `stateDiagram()` renders the transition table as the
 * Mermaid stateDiagram-v2 block the README embeds verbatim —
 * 21 lines, 14 of them edge lines, one per transition-table
 * edge — and the segment asserts, outside the printing, that
 * the edge count equals `transitionTable()`'s edge count, so a
 * diagram whose shape broke would fail the demo itself.
 * The demo then shows a standalone history-parsing
 * segment: the main escrow's history is serialized to JSON and
 * parsed back on its own with `parseEscrowHistory()` — no
 * `Escrow` instance involved — the recovery / reconciliation
 * pre-flight that validates an untrusted audit history (entry
 * shapes, chain continuity, hash-chain re-verification) before
 * anything rebuilds from it; the parsed entries are asserted,
 * outside the printing, to match the original history verbatim,
 * and a detached copy whose middle entry's note is rewritten is
 * shown failing with the explicit hash-chain-broken error,
 * while the escrow's own history stays untouched.
 * The demo then shows an event-sourced rebuild
 * segment: a fixed advisory deadline is attached to the main
 * escrow (it lives only in the snapshot envelope, never in
 * the history), and the escrow is then rebuilt from its
 * history alone with `Escrow.fromHistory()` — the rebuilt
 * escrow lands in the same RELEASED state with a history
 * identical to the original verbatim, but its deadline is
 * undefined: what a bare history cannot restore (the
 * deadline, the consumed idempotency-key set, and
 * subscriptions) is exactly the rebuild trade-off the
 * `fromHistory` doc comment states, and it is asserted
 * outside the printing.
 * The demo then shows a snapshot round-trip
 * segment: the main escrow — still carrying that fixed
 * deadline — is exported with `toJSON()` (the serialized
 * snapshot printed with its byte count) and restored with
 * `Escrow.fromJSON()` from the parsed serialization: the
 * restored escrow lands in the same RELEASED state with a
 * history identical to the original verbatim, and its
 * deadline IS restored — the snapshot envelope (state +
 * history + deadline + the consumed idempotency-key set)
 * is the persistence channel that carries exactly what a
 * bare history cannot, the contrast the rebuild segment
 * above sets up; the fidelity is asserted outside the
 * printing.
 * The demo then shows a machine-readable
 * transition-table segment: `transitionTableJson()`
 * serializes the same transition table the state-diagram
 * segment renders for humans as canonical JSON — the form
 * a caller feeds to static validation or code generation —
 * printed with its serialized byte count and edge total,
 * and the segment asserts, outside the printing, that the
 * edges parsed back from the JSON match `transitionTable()`
 * edge for edge (every `from` / `event` / `to` triple), with
 * the edge total hand-pinned at the same 14 the committed
 * snapshot and the diagram tests pin.
 * The demo then shows a money-guard segment:
 * `assertNonNegativeMoney()` — the boundary check every
 * amount entry point shares — is run over a fixed legal
 * corpus (0, a cent, the golden deposit, a large amount
 * with cents), which passes without throwing, and over a
 * fixed illegal pair (a negative amount and NaN), each
 * rejected with the exact
 * `amount must be a finite non-negative number` error —
 * illegal money stopped at the boundary, before any
 * accounting sees it; both sides are asserted outside the
 * printing against hand-pinned expectations.
 * The demo then shows a subscription segment:
 * a branch escrow carries one fixed collecting listener
 * subscribed via `Escrow.subscribe()` — the fan-out seam
 * a reconciliation / notification side wires into — which
 * receives `(event, from, to, entry)` after each of two
 * fixed dispatches, in order and matching that escrow's
 * audit history entry for entry; the listener is then
 * unsubscribed (twice — unsubscribe is idempotent) and a
 * third fixed dispatch moves the escrow while producing
 * zero new notifications; both sides are asserted outside
 * the printing against hand-pinned expectations.
 * The demo then shows a deadline-clearing
 * segment: a further funded escrow carries a fixed past
 * deadline and reads overdue at a fixed later instant,
 * then `clearDeadline()` — the entry point for a deadline
 * cancelled by an extension agreement — removes it, so
 * `getDeadline()` reads back `undefined` and the overdue
 * judgement at the same instant turns false; a second
 * funded escrow that never carried a deadline shows the
 * same call as a harmless no-op; both sides are asserted
 * outside the printing against hand-pinned expectations.
 * The demo then shows a quorum approval-log
 * segment: `approvalLog()` on the dispute quorum prints
 * the full approval audit trail — each arbitrator with
 * the fixed timestamp of their vote, including the vote
 * cast before the simulated restart, which kept its
 * original timestamp through the snapshot round-trip —
 * and a separate quorum carrying a fixed
 * `maxApprovalAgeMs` window shows the expiry contrast
 * on a fixed clock: once the clock advances past the
 * window for the oldest vote, that approval stops
 * counting (the count drops and quorum is lost) while
 * `approvalLog()` still retains the expired entry —
 * expiry never deletes the audit trail; only `revoke()`
 * removes a signer's entries. Both sides are asserted
 * outside the printing against hand-pinned expectations.
 * The demo finally closes with a single-target delivery
 * segment: the main escrow's signed settlement webhook
 * is delivered with `deliverSettlementWebhook()` alone —
 * the single-endpoint entry point most integrators start
 * from, which the fan-out segment above only ever runs
 * wrapped — to one fixed endpoint through a scripted fake
 * `fetch` (zero network) that answers 500 on the first
 * attempt and 200 on the second, so the delivery succeeds
 * after exactly one retry (a path no earlier demo delivery
 * took: the fan-out fake answers 200 immediately); every
 * captured request carries the same signed body bytes,
 * and the `X-Signature` header the endpoint received
 * verifies under the demo secret with
 * `verifySettlementWebhook()`; both sides are asserted
 * outside the printing against hand-pinned expectations.
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
  actOnStaleEscrows,
  assertNonNegativeMoney,
  allowedEvents,
  buildSettlementReport,
  buildSettlementReports,
  buildSettlementWebhook,
  buildSettlementWebhooks,
  calculateDeposit,
  createQuorum,
  deliverSettlementWebhook,
  deliverSettlementWebhookToMany,
  depositAmountFromHistory,
  dispatchArbitration,
  expiredEscrows,
  expireOverdueEscrows,
  historyFromNdjson,
  historyToNdjson,
  isOverdue,
  parseEscrowHistory,
  parseRetryAfter,
  renderReport,
  restoreQuorum,
  settleRelease,
  staleEscrows,
  stateDiagram,
  summarizeSettlementReports,
  transitionTable,
  transitionTableJson,
  verifyHistoryChain,
  verifySettlementWebhook,
  type ApprovalLogEntry,
  type BuildSettlementWebhooksResult,
  type DeliverSettlementWebhookToManyResult,
  type EscrowEvent,
  type EscrowHistoryEntry,
  type EscrowSnapshot,
  type EscrowState,
  type ExpireOverdueResult,
  type Quorum,
  type QuorumConfig,
  type QuorumSnapshot,
  type Settlement,
  type SettlementReport,
  type SettlementReportResult,
  type SettlementReportsSummary,
  type SettlementWebhook,
  type SettlementWebhookEndpoint,
  type StaleEscrowActionResult,
  type TransitionEdge,
  type WebhookDeliveryResult,
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

/**
 * Fixed clock for the Retry-After parsing segment: the same instant
 * the dedupe clock starts at (the webhook's own `at`), second-aligned
 * so the HTTP-date corpus values — which carry one-second precision —
 * land exactly. Injected into every `parseRetryAfter` call, so no
 * wall clock enters the segment.
 */
export const DEMO_RETRY_AFTER_NOW_MS = DEMO_DEDUPE_START_MS;

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

/**
 * Fan-out fixtures for the delivery segment after the batch
 * section: the main escrow's settlement report is delivered as
 * ONE logical event (one shared `eventId`, one shared `at` — an
 * hour after the batch webhook timestamp) to three fixed
 * endpoints, each with its OWN demo-only signing secret (the
 * same placeholder status as {@link DEMO_WEBHOOK_SECRET}: printed
 * in the source, NOT real credentials). Hand-pinned expectations
 * — written from src/webhooks.ts's documented fan-out semantics
 * and cross-checked against test/webhookFanout.test.ts (shared
 * body, per-endpoint signatures, input-order results) and the
 * bench fan-out fixture (4 endpoints, fake fetch, all 200):
 * - 3 endpoints, each answering 200 on the first attempt via the
 *   injected fake fetch -> delivered 3, failed 0, every result
 *   `{ok: true, attempts: 1, status: 200}` in endpoint order
 * - every captured call carries the SAME body bytes (the shared
 *   eventId / `at` below), signed independently per endpoint:
 *   each signature verifies under its own endpoint's secret and
 *   under no other endpoint's secret
 */
export const DEMO_FANOUT_AT = "2026-03-08T10:00:00.000Z";
export const DEMO_FANOUT_EVENT_ID = "evt_demo_fanout_001";
export const DEMO_FANOUT_ENDPOINTS: readonly SettlementWebhookEndpoint[] = [
  {
    url: "https://billing.example.com/hooks/settlement",
    secret: "whsec_demo_fanout_billing_not_a_real_secret",
  },
  {
    url: "https://notifications.example.com/hooks/settlement",
    secret: "whsec_demo_fanout_notifications_not_a_real_secret",
  },
  {
    url: "https://ledger.example.com/hooks/settlement",
    secret: "whsec_demo_fanout_ledger_not_a_real_secret",
  },
];

/**
 * Watchdog fixtures for the closing section: three further escrows
 * screened on one fixed `now` (the morning after the batch webhook
 * timestamp) under two different axes. Hand-computed expectations —
 * dwell is `now` minus the last history entry's `at`, stale only when
 * strictly past the state's budget (7 days for both screened states):
 * - DEMO-ESC-004 (stale only): FUNDED at 2026-02-20T09:00 — dwell
 *   17 days > 7-day FUNDED budget, so stale; deadline 2026-04-01 is
 *   still ahead, so not expired.
 * - DEMO-ESC-005 (expired only): milestone submitted at
 *   2026-03-08T09:00 — dwell 1 day < 7-day MILESTONE_SUBMITTED
 *   budget, so not stale; deadline 2026-03-08T12:00 has passed, so
 *   expired.
 * - DEMO-ESC-006 (neither): FUNDED at 2026-03-08T09:00 — dwell
 *   1 day, deadline 2026-04-01 ahead, so neither stale nor expired.
 * The stale disposition is an EXPIRE dispatch pinned to the same
 * fixed `now` (actor `watchdog`): a dispatch without an explicit
 * `at` would stamp the wall clock and break determinism.
 */
export const DEMO_STALE_NOW = "2026-03-09T09:00:00.000Z";
export const DEMO_STALE_DAY_MS = 86_400_000;
export const DEMO_STALE_MAX_AGE_MS = 7 * DEMO_STALE_DAY_MS;
export const DEMO_STALE_ESCROW_ID = "DEMO-ESC-004";
export const DEMO_STALE_FUND_AT = "2026-02-20T09:00:00.000Z";
export const DEMO_STALE_DEADLINE = "2026-04-01T09:00:00.000Z";
export const DEMO_OVERDUE_ONLY_ESCROW_ID = "DEMO-ESC-005";
export const DEMO_OVERDUE_ONLY_FUND_AT = "2026-03-07T09:00:00.000Z";
export const DEMO_OVERDUE_ONLY_SUBMIT_AT = "2026-03-08T09:00:00.000Z";
export const DEMO_OVERDUE_ONLY_DEADLINE = "2026-03-08T12:00:00.000Z";
export const DEMO_FRESH_ESCROW_ID = "DEMO-ESC-006";
export const DEMO_FRESH_FUND_AT = "2026-03-08T09:00:00.000Z";
export const DEMO_FRESH_DEADLINE = "2026-04-01T09:00:00.000Z";

/**
 * Deadline-watchdog fixtures for the closing section: three more
 * escrows screened and executed on the SAME fixed `now`
 * (DEMO_STALE_NOW) and under the SAME 7-day stale budgets as the
 * screening section above, so the two sections compare like with
 * like. Hand-computed expectations — dwell is `now` minus the last
 * history entry's `at`:
 * - DEMO-ESC-007 (expired, unexpirable): VERIFIED at
 *   2026-03-07T09:00 — dwell 2 days, and VERIFIED carries no stale
 *   budget in the demo map anyway, so not stale; deadline
 *   2026-03-08T09:00 has passed, so expired. But VERIFIED has no
 *   EXPIRE edge, so `expireOverdueEscrows` lands it as
 *   `{expired: false, error}` — and must not block the batch.
 * - DEMO-ESC-008 (expired, expirable): FUNDED at
 *   2026-03-08T09:00 — dwell 1 day, so not stale; deadline
 *   2026-03-08T12:00 has passed, so expired, and FUNDED does carry
 *   an EXPIRE edge: it ends EXPIRED.
 * - DEMO-ESC-009 (stale only): FUNDED at 2026-02-20T09:00 — dwell
 *   17 days > the 7-day FUNDED budget, so stale; deadline
 *   2026-04-01 is still ahead, so not expired and the deadline
 *   executor never attempts it.
 * Batch order is deliberate: the unexpirable escrow comes FIRST,
 * so its per-item error visibly does not abort the batch.
 * Caveat (see the file header): `expireOverdueEscrows` dispatches
 * EXPIRE without a pinned `at`, so the appended audit entry carries
 * the dispatch-time wall clock — the demo prints no timestamp for
 * it and its printed output stays byte-identical across runs.
 */
export const DEMO_UNEXPIRABLE_ESCROW_ID = "DEMO-ESC-007";
export const DEMO_UNEXPIRABLE_FUND_AT = "2026-03-02T09:00:00.000Z";
export const DEMO_UNEXPIRABLE_SUBMIT_AT = "2026-03-06T09:00:00.000Z";
export const DEMO_UNEXPIRABLE_VERIFY_AT = "2026-03-07T09:00:00.000Z";
export const DEMO_UNEXPIRABLE_DEADLINE = "2026-03-08T09:00:00.000Z";
export const DEMO_EXPIRABLE_ESCROW_ID = "DEMO-ESC-008";
export const DEMO_EXPIRABLE_FUND_AT = "2026-03-08T09:00:00.000Z";
export const DEMO_EXPIRABLE_DEADLINE = "2026-03-08T12:00:00.000Z";
export const DEMO_DEADLINE_STALE_ESCROW_ID = "DEMO-ESC-009";
export const DEMO_DEADLINE_STALE_FUND_AT = "2026-02-20T09:00:00.000Z";
export const DEMO_DEADLINE_STALE_DEADLINE = "2026-04-01T09:00:00.000Z";

/**
 * Overdue-judgement fixtures for the closing section: one further
 * escrow, funded with the same golden deposit and given a fixed
 * deadline, judged by `isOverdue` at three fixed instants.
 * Hand-computed expectations — written from src/stateMachine.ts
 * (`now.getTime() >= Date.parse(deadline)` for a non-terminal
 * escrow with a deadline; no deadline or a terminal state is
 * never overdue), never derived by calling `isOverdue` itself,
 * and cross-checked against test/deadline.test.ts, whose boundary
 * case pins the same rule (now exactly at the deadline is true):
 * - before the deadline (2026-03-09, one day ahead): false
 * - exactly at the deadline (2026-03-10): true — the boundary
 *   counts as overdue because the comparison is >=
 * - after the deadline (2026-03-11, one day past): true
 * The escrow stays FUNDED throughout: `isOverdue` is advisory
 * only and never dispatches, so all three judgements read the
 * same escrow in the same state.
 */
export const DEMO_OVERDUE_CHECK_ESCROW_ID = "DEMO-ESC-010";
export const DEMO_OVERDUE_CHECK_FUND_AT = "2026-03-08T09:00:00.000Z";
export const DEMO_OVERDUE_CHECK_DEADLINE = "2026-03-10T09:00:00.000Z";
export const DEMO_OVERDUE_CHECK_BEFORE_AT = "2026-03-09T09:00:00.000Z";
export const DEMO_OVERDUE_CHECK_AT_DEADLINE = "2026-03-10T09:00:00.000Z";
export const DEMO_OVERDUE_CHECK_AFTER_AT = "2026-03-11T09:00:00.000Z";

/**
 * Standalone history-parsing fixtures for the closing segment:
 * the main escrow's history is serialized to JSON and parsed
 * back with `parseEscrowHistory()` alone. Hand-pinned
 * expectations — written from src/stateMachine.ts's documented
 * `parseEscrowHistory` semantics (the exact `parseEscrowSnapshot`
 * code path: seq from 1 with no gaps, from/to chain continuous
 * from CREATED, every edge legal, canonical non-decreasing
 * timestamps, and a fully chained history's hash chain
 * re-verified), never derived by calling the parser itself, and
 * cross-checked against test/historyParserFuzz.test.ts:
 * - the intact serialized history parses to the same 4 entries
 *   verbatim, the final entry landing in RELEASED
 * - a detached copy whose middle entry (seq 2,
 *   SUBMIT_MILESTONE) carries {@link DEMO_PARSED_HISTORY_TAMPERED_NOTE}
 *   instead of its original note is structurally well-formed but
 *   no longer recomputes its stored hash, so the parse throws
 *   `invalid snapshot: history hash chain is broken (an entry
 *   was tampered with, deleted, or reordered)` — the
 *   `invalid snapshot:` tag is the parser's own, because
 *   `parseEscrowHistory` validates through the snapshot parser
 *   (see its doc comment in src/stateMachine.ts)
 * The tamper touches only the detached copy: the escrow's own
 * history keeps its original note and still parses afterwards.
 */
export const DEMO_PARSED_HISTORY_TAMPERED_SEQ = 2;
export const DEMO_PARSED_HISTORY_TAMPERED_NOTE =
  "REWRITTEN after the fact — milestone note altered";
export const DEMO_PARSED_HISTORY_TAMPER_ERROR =
  "invalid snapshot: history hash chain is broken (an entry was tampered with, deleted, or reordered)";

/**
 * Event-sourced rebuild fixture for the closing segment: the
 * fixed advisory deadline attached to the main escrow just
 * before it is rebuilt from its history alone with
 * `Escrow.fromHistory()`. Hand-pinned expectations — written
 * from the `fromHistory` doc comment in src/stateMachine.ts
 * (a bare history cannot restore the advisory deadline, the
 * consumed idempotency-key set, or subscriptions: a rebuild
 * starts with no deadline, an empty key set, and zero
 * listeners), never derived by calling `fromHistory` itself,
 * and cross-checked against test/fromHistory.test.ts's
 * honest-limits case, where a live escrow carrying a
 * 2026-04-01 deadline keeps it through `fromJSON` but loses
 * it through `fromHistory`:
 * - the rebuilt escrow lands in RELEASED (the main escrow's
 *   own final state) with the same 4 history entries verbatim
 * - the rebuilt escrow's deadline is `undefined`, even though
 *   the main escrow carries {@link DEMO_REBUILT_DEADLINE} at
 *   rebuild time — the deadline was never in the history
 * The original escrow keeps its deadline and its state: the
 * rebuild only reads the history and dispatches nothing.
 */
export const DEMO_REBUILT_DEADLINE = "2026-04-01T09:00:00.000Z";

/**
 * Snapshot round-trip expectations for the closing segment:
 * the main escrow (RELEASED, 4 history entries, carrying
 * {@link DEMO_REBUILT_DEADLINE}) is exported with `toJSON()`
 * and restored with `Escrow.fromJSON()`. Hand-pinned
 * expectations — written from the `toJSON`/`fromJSON` doc
 * comments in src/stateMachine.ts (the snapshot envelope is
 * `v` + id + state + history, plus `deadline` when one is
 * set; the consumed idempotency keys and the RBAC policy are
 * written only when non-empty, and the main escrow has
 * neither, so neither field appears), never derived by
 * calling `toJSON` itself, and cross-checked against
 * test/serialization.test.ts and test/deadline.test.ts's
 * round-trip cases:
 * - the snapshot carries `v: 1` (the SNAPSHOT_VERSION the
 *   envelope is stamped with) and the fixed deadline
 * - the restored escrow lands in RELEASED with the same 4
 *   history entries verbatim and its deadline restored to
 *   {@link DEMO_REBUILT_DEADLINE} — the envelope carries
 *   what the bare history in the rebuild segment above
 *   cannot
 * - the serialized snapshot is exactly
 *   {@link DEMO_SNAPSHOT_SERIALIZED_BYTES} bytes as UTF-8
 *   (1,342 characters; the RELEASE entry's note carries an
 *   em dash, a 3-byte UTF-8 character, so bytes ≠ characters)
 * The original escrow keeps its state and deadline: the
 * round-trip only reads the escrow and dispatches nothing.
 */
export const DEMO_SNAPSHOT_SERIALIZED_BYTES = 1344;

/**
 * Machine-readable transition-table expectations for the
 * closing segment: `transitionTableJson()` serializes the
 * transition table as canonical JSON (declaration order,
 * 2-space indent, exactly one trailing newline). Hand-pinned
 * expectations — written from TRANSITIONS in
 * src/stateMachine.ts and the committed snapshot
 * test/__snapshots__/transitionTable.snapshot.json, never
 * derived by calling `transitionTableJson` itself, and
 * cross-checked against test/transitionSnapshot.test.ts and
 * the diagram tests, which pin the same table:
 * - exactly {@link DEMO_TRANSITION_TABLE_EDGE_COUNT} edges
 *   (14), the first CREATED --FUND--> FUNDED and the last
 *   DISPUTED --ARBITRATE_REFUND--> REFUNDED
 * - the serialized text is exactly
 *   {@link DEMO_TRANSITION_TABLE_JSON_BYTES} bytes as UTF-8
 *   (the table is pure ASCII, so bytes = characters)
 * - the edges parsed back from the JSON match
 *   `transitionTable()` edge for edge: every
 *   `from` / `event` / `to` triple, in the same order, with
 *   the pinned key order `from`, `event`, `to`
 * The segment is pure: no escrow instance, no dispatch, no
 * network, no randomness, no wall clock.
 */
export const DEMO_TRANSITION_TABLE_EDGE_COUNT = 14;
export const DEMO_TRANSITION_TABLE_JSON_BYTES = 1160;

/**
 * Money-guard expectations for the closing segment:
 * `assertNonNegativeMoney(name, value)` is the boundary
 * check every amount entry point shares — a monetary
 * input must be a finite, non-negative number, anything
 * else throws `${name} must be a finite non-negative
 * number`. Hand-pinned from the documented semantics in
 * src/stateMachine.ts, cross-checked against
 * test/inputValidation.test.ts and bench's
 * assertNonNegativeMoney fixture, never derived by
 * calling the guard itself:
 * - legal (must pass without throwing), under the name
 *   "amount": 0, 0.01 (a cent), 10630 (the golden
 *   deposit), 1000000.25 (a large amount with cents)
 * - illegal (must throw exactly
 *   {@link DEMO_MONEY_GUARD_ERROR}): -1 (a negative
 *   amount) and NaN
 * The segment is pure: no escrow instance, no dispatch,
 * no network, no randomness, no wall clock.
 */
export const DEMO_MONEY_GUARD_ERROR =
  "amount must be a finite non-negative number";
export const DEMO_MONEY_GUARD_LEGAL_AMOUNTS: readonly number[] = [
  0, 0.01, 10630, 1000000.25,
];
export const DEMO_MONEY_GUARD_ILLEGAL_AMOUNTS: readonly number[] = [-1, NaN];

/**
 * Subscription fixtures for the closing segment: one further
 * branch escrow carrying a single collecting listener.
 * Hand-pinned expectations — written from the documented
 * `subscribe()` semantics in src/stateMachine.ts (listeners
 * run after the audit append, in subscription order, with
 * `(event, from, to, entry)`; unsubscribe is idempotent and
 * stops all further notifications), never derived by calling
 * `subscribe()` itself, and cross-checked against
 * test/subscribe.test.ts:
 * - FUND (CREATED -> FUNDED, seq 1) and SUBMIT_MILESTONE
 *   (FUNDED -> MILESTONE_SUBMITTED, seq 2) are notified, in
 *   order, each matching the audit entry with the same seq
 * - after unsubscribe (called twice), VERIFY_PASS still
 *   moves the escrow to VERIFIED (history 3 entries) but
 *   produces zero new notifications — the count stays 2
 *   and `listenerCount` reads 0
 * Every timestamp is a fixed literal: no network, no
 * randomness, no wall clock.
 */
export const DEMO_SUBSCRIBE_ESCROW_ID = "DEMO-ESC-011";
export const DEMO_SUBSCRIBE_FUND_AT = "2026-03-12T09:00:00.000Z";
export const DEMO_SUBSCRIBE_SUBMIT_AT = "2026-03-12T10:00:00.000Z";
export const DEMO_SUBSCRIBE_VERIFY_AT = "2026-03-12T11:00:00.000Z";
export const DEMO_SUBSCRIBE_VERIFY_EVIDENCE = "demo-oracle-attestation-011";

/**
 * Deadline-clearing fixtures for the closing segment: one
 * further funded escrow carrying a fixed deadline, plus a
 * second funded escrow that never carries one. Hand-pinned
 * expectations — written from the documented deadline
 * semantics in src/stateMachine.ts (`clearDeadline()`
 * removes the attached deadline and is a no-op when none
 * is set; `isOverdue()` is false when no deadline is set
 * and, for a non-terminal escrow, is `now >= deadline`
 * otherwise), never derived by calling `clearDeadline()`
 * itself, and cross-checked against test/deadline.test.ts:
 * - DEMO-ESC-012 is FUNDED with deadline
 *   {@link DEMO_CLEAR_DEADLINE_DEADLINE} (2026-03-14), so
 *   at {@link DEMO_CLEAR_DEADLINE_CHECK_AT} (2026-03-15)
 *   it reads overdue true; after `clearDeadline()` its
 *   `getDeadline()` is `undefined` and the same judgement
 *   reads false, while the escrow stays FUNDED with its
 *   single FUND history entry (clearing dispatches
 *   nothing)
 * - DEMO-ESC-013 is FUNDED with no deadline at all;
 *   `clearDeadline()` leaves it untouched: deadline still
 *   `undefined`, overdue still false, state still FUNDED
 * Every timestamp is a fixed literal: no network, no
 * randomness, no wall clock.
 */
export const DEMO_CLEAR_DEADLINE_ESCROW_ID = "DEMO-ESC-012";
export const DEMO_CLEAR_DEADLINE_FUND_AT = "2026-03-13T09:00:00.000Z";
export const DEMO_CLEAR_DEADLINE_DEADLINE = "2026-03-14T09:00:00.000Z";
export const DEMO_CLEAR_DEADLINE_CHECK_AT = "2026-03-15T09:00:00.000Z";
export const DEMO_CLEAR_DEADLINE_NO_DEADLINE_ESCROW_ID = "DEMO-ESC-013";
export const DEMO_CLEAR_DEADLINE_NO_DEADLINE_FUND_AT =
  "2026-03-13T10:00:00.000Z";

/**
 * Approval-log fixtures for the final closing segment: the
 * dispute quorum's own trail, plus a separate expiring
 * quorum on a fixed clock. Hand-pinned expectations —
 * written from the documented `approvalLog()` semantics
 * in src/quorum.ts (the log is the full audit trail in
 * record order, each entry `{signerId, at}` with a
 * canonical ISO timestamp; the `maxApprovalAgeMs` expiry
 * window only affects the counting views — `approvalCount`
 * / `hasQuorum` / `approvals` — and never deletes log
 * entries; only `revoke()` removes a signer's entries),
 * never derived by calling `approvalLog()` itself, and
 * cross-checked against test/approvalLog.test.ts and
 * test/quorumExpiry.test.ts:
 * - the dispute quorum's trail is exactly two entries, in
 *   record order: arb-1 at {@link DEMO_QUORUM_APPROVAL_ATS}[0]
 *   (cast before the simulated restart) and arb-2 at
 *   {@link DEMO_QUORUM_APPROVAL_ATS}[1] (cast on the
 *   restored quorum) — the snapshot round-trip neither
 *   drops nor re-stamps a vote
 * - the expiring quorum (2-of-3, same signer ids, window
 *   {@link DEMO_APPROVAL_LOG_WINDOW_MS}) collects arb-1 at
 *   {@link DEMO_APPROVAL_LOG_FIRST_AT} and arb-2 30 s
 *   later: approvalCount 2, hasQuorum true; after the
 *   fixed clock advances to
 *   {@link DEMO_APPROVAL_LOG_CHECK_AT} (60,001 ms after
 *   the first vote — past the window — and 30,001 ms
 *   after the second), arb-1's vote no longer counts:
 *   approvalCount 1, hasQuorum false, `approvals()` is
 *   exactly [arb-2] — yet the trail still holds both
 *   entries with their original timestamps
 * Every timestamp is a fixed literal: no network, no
 * randomness, no wall clock (the expiring quorum's clock
 * is a variable the segment sets to fixed instants only).
 */
export const DEMO_DISPUTE_APPROVAL_LOG_ENTRIES: readonly ApprovalLogEntry[] = [
  { signerId: "arb-1", at: "2026-03-07T12:00:00.000Z" },
  { signerId: "arb-2", at: "2026-03-07T13:00:00.000Z" },
];
export const DEMO_APPROVAL_LOG_WINDOW_MS = 60_000;
export const DEMO_APPROVAL_LOG_FIRST_AT = "2026-03-16T09:00:00.000Z";
export const DEMO_APPROVAL_LOG_SECOND_AT = "2026-03-16T09:00:30.000Z";
export const DEMO_APPROVAL_LOG_CHECK_AT = "2026-03-16T09:01:00.001Z";
export const DEMO_APPROVAL_LOG_ENTRIES: readonly ApprovalLogEntry[] = [
  { signerId: "arb-1", at: "2026-03-16T09:00:00.000Z" },
  { signerId: "arb-2", at: "2026-03-16T09:00:30.000Z" },
];

/**
 * Single-target delivery fixtures for the final closing
 * segment: the main escrow's already-built signed webhook
 * ({@link DEMO_WEBHOOK_EVENT_ID} / {@link DEMO_WEBHOOK_AT},
 * signed under {@link DEMO_WEBHOOK_SECRET} in the webhook
 * segment above) is delivered alone to ONE fixed endpoint.
 * Hand-pinned expectations — written from the documented
 * `deliverSettlementWebhook()` semantics in
 * src/webhooks.ts (2xx succeeds as `{status, attempts}`;
 * 5xx is retried with exponential backoff; the request
 * body is the canonical JSON of the signed payload,
 * byte-identical on every attempt, with the signature in
 * the `X-Signature` header), never derived by calling the
 * delivery itself, and cross-checked against
 * test/webhookDelivery.test.ts, whose scripted-server
 * cases pin the same retry shape (500s then a 200 succeed
 * on the next attempt, same signature and body on every
 * attempt):
 * - the scripted fake answers 500 on attempt 1 and 200
 *   on attempt 2 -> the result is exactly
 *   `{status: 200, attempts: 2}`
 * - exactly 2 requests are captured, both POSTs to
 *   {@link DEMO_SINGLE_DELIVERY_URL}, bodies byte-identical
 *   to each other and to the canonical body of the demo
 *   webhook, and the captured `X-Signature` equals the
 *   webhook's signature and verifies over the captured
 *   body under {@link DEMO_WEBHOOK_SECRET}
 * The endpoint is an example.com URL that is never really
 * fetched: the library's delivery layer calls the global
 * `fetch`, so a scripted fake is installed on `globalThis`
 * for this segment only and the original is restored
 * afterwards (the same seam the fan-out segment uses).
 * `backoffMs: 0` keeps the single retry wait at zero, so
 * no real waiting and no wall clock enter the segment.
 */
export const DEMO_SINGLE_DELIVERY_URL =
  "https://hooks.example.com/settlement-single";
export const DEMO_SINGLE_DELIVERY_SCRIPTED_STATUSES: readonly number[] = [
  500, 200,
];

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
  /**
   * `verifyHistoryChain` verdict on the main escrow's intact audit
   * history: `true` — every link recomputes, genesis-linked.
   */
  historyChainVerified: boolean;
  /**
   * `verifyHistoryChain` verdict on a detached copy of that history
   * whose FUND entry's amount was altered by 1 (10630 -> 10631):
   * `false` — the stored hash no longer recomputes from the altered
   * content. The escrow's own history is untouched by the tamper.
   */
  tamperedChainVerified: boolean;
  /** The FUND amount on the tampered copy (original 10630). */
  tamperedFundAmount: number;
  webhook: SettlementWebhook;
  webhookVerified: boolean;
  /**
   * Receiver-side dedupe store after the demo's three deliveries of
   * the main webhook's `eventId` (new, duplicate, new-after-TTL):
   * its stats read hits 1 / misses 2 / size 1.
   */
  webhookDedupe: SettlementEventDedupe;
  /**
   * Sender-side `parseRetryAfter` results over the fixed corpus, in
   * corpus order, parsed against {@link DEMO_RETRY_AFTER_NOW_MS}:
   * delay-seconds and HTTP-date hints normalized to milliseconds,
   * a past date at 0, and the signed / garbage / null values at
   * `undefined` (the fallback-to-backoff cue).
   */
  retryAfterParsed: Array<{
    value: string | null;
    parsed: number | undefined;
  }>;
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
  /**
   * Aggregate fan-out outcome of delivering the main report via
   * `deliverSettlementWebhookToMany` to
   * {@link DEMO_FANOUT_ENDPOINTS}: 3 results in endpoint order,
   * delivered 3 / failed 0 — every endpoint answered 200 on its
   * first attempt through the injected fake fetch.
   */
  fanoutResult: DeliverSettlementWebhookToManyResult;
  /**
   * The requests the injected fake fetch captured during the
   * fan-out, in call order: every `body` byte-identical (the one
   * shared logical event), each `signature` made with that
   * endpoint's own secret.
   */
  fanoutCalls: Array<{ url: string; body: string; signature: string }>;
  /**
   * The three watchdog escrows, in screening order (stale-only,
   * expired-only, neither), AFTER the stale action ran: the stale
   * escrow is EXPIRED, the other two are untouched.
   */
  watchdogEscrows: Escrow[];
  /**
   * `staleEscrows` selection over {@link DemoResult.watchdogEscrows}
   * on the fixed demo `now`, captured before the action ran: just
   * the stale-only escrow (dwell axis).
   */
  staleSelected: Escrow[];
  /**
   * `expiredEscrows` selection over the same batch on the same fixed
   * `now`, also captured before the action ran: just the
   * expired-only escrow (deadline axis) — a different subset than
   * {@link DemoResult.staleSelected}, which is the point of the
   * closing section.
   */
  expiredSelected: Escrow[];
  /**
   * Per-escrow outcomes of `actOnStaleEscrows` expiring the stale
   * selection: one entry, acted, the escrow now EXPIRED.
   */
  staleActionResults: StaleEscrowActionResult[];
  /**
   * The three deadline-watchdog escrows, in batch order
   * (unexpirable, expirable, stale-only), AFTER the executor ran:
   * VERIFIED (unchanged by its failed attempt), EXPIRED, FUNDED
   * (never attempted).
   */
  deadlineEscrows: Escrow[];
  /**
   * `expiredEscrows` selection over {@link DemoResult.deadlineEscrows}
   * on the fixed demo `now`, captured before the executor ran: the
   * unexpirable and expirable escrows, in batch order.
   */
  deadlineExpiredSelected: Escrow[];
  /**
   * `staleEscrows` selection over the same deadline batch on the
   * same fixed `now` and budgets, also captured before the executor
   * ran: just the stale-only escrow — a disjoint subset from
   * {@link DemoResult.deadlineExpiredSelected}.
   */
  deadlineStaleSelected: Escrow[];
  /**
   * Per-escrow outcomes of `expireOverdueEscrows` over the deadline
   * batch, in batch order: the VERIFIED escrow first as
   * `{expired: false, error}`, then the FUNDED escrow expired —
   * the first entry's error did not block the second.
   */
  deadlineExpireResults: ExpireOverdueResult[];
  /** `allowedEvents(state)` for every state, in transition-table order. */
  allowedEventsByState: Array<{ state: EscrowState; events: EscrowEvent[] }>;
  /** `allowedEvents` for the main escrow's RELEASED state — the empty list. */
  mainEscrowAllowedEvents: EscrowEvent[];
  /**
   * Deposit traced from the main escrow's audit history alone by
   * `depositAmountFromHistory`: the sum of every FUND amount —
   * the golden 10630, identical to the settlement report's deposit.
   */
  tracedDepositAmount: number;
  /**
   * Error message of `depositAmountFromHistory` on a fixed copy of
   * the main history with every FUND entry removed
   * (`settlement requires a FUND amount for DEMO-ESC-001: no FUND
   * event in the audit history`) — the failure is part of the demo,
   * and the escrow's own history is untouched by the copy.
   */
  noFundDepositError: string;
  /**
   * Pure settlement split of the main escrow's golden deposit by
   * `settleRelease` at {@link DEMO_PRO_FEE_BPS} with no referral
   * credits: gross 10630, proFee 531.5, referralCredits 0, net
   * 10098.5 — the parts sum back to the gross exactly, and the
   * split is identical to the settlement embedded in the main
   * report (the report derives its RELEASE payout from this same
   * function on this same deposit).
   */
  releaseSettlement: Settlement;
  /**
   * NDJSON export of the main escrow's audit history by
   * `historyToNdjson`: 4 lines, one JSON entry per line in seq
   * order, every line `\n`-terminated (including the last).
   */
  historyNdjson: string;
  /** Number of NDJSON lines in {@link DemoResult.historyNdjson}: 4. */
  historyNdjsonLineCount: number;
  /**
   * First NDJSON line of {@link DemoResult.historyNdjson}: the
   * canonical JSON of the FUND entry (seq 1, CREATED -> FUNDED).
   */
  historyNdjsonFirstLine: string;
  /**
   * Entries read back from {@link DemoResult.historyNdjson} by
   * `historyFromNdjson`: identical to the main escrow's history
   * verbatim — 4 entries, seq 1 -> 4 continuous, the final entry
   * landing in RELEASED.
   */
  historyNdjsonRoundTripped: EscrowHistoryEntry[];
  /**
   * The closing segment's funded escrow (DEMO-ESC-010), after the
   * three `isOverdue` judgements ran: still FUNDED with its fixed
   * deadline set — the judgement is advisory and dispatched
   * nothing, so its history still holds the single FUND entry.
   */
  overdueCheckEscrow: Escrow;
  /**
   * `isOverdue(overdueCheckEscrow, now)` at the three fixed
   * instants, in order: before the deadline (false), exactly at
   * the deadline (true — the >= boundary counts as overdue), and
   * after it (true). Hand-pinned in the fixture comment above and
   * cross-checked against test/deadline.test.ts's boundary case.
   */
  overdueChecks: Array<{ at: string; overdue: boolean }>;
  /**
   * Full `stateDiagram()` Mermaid block text (no trailing
   * newline): 21 lines — the fenced stateDiagram-v2 block the
   * README embeds verbatim, rendered from `transitionTable()`.
   */
  stateDiagramText: string;
  /**
   * Edge lines inside {@link DemoResult.stateDiagramText}: the
   * 14 transition edges, equal to `transitionTable().length`.
   */
  stateDiagramEdgeCount: number;
  /**
   * Entries `parseEscrowHistory()` returns for the main escrow's
   * JSON-serialized history, parsed standalone (no `Escrow`
   * instance involved): identical to the main escrow's history
   * verbatim — 4 entries, seq 1 -> 4 continuous, the final entry
   * landing in RELEASED.
   */
  parsedHistoryEntries: EscrowHistoryEntry[];
  /**
   * Error message of `parseEscrowHistory()` on a detached copy
   * of that serialized history whose middle entry (seq
   * {@link DEMO_PARSED_HISTORY_TAMPERED_SEQ}) carries the
   * rewritten note {@link DEMO_PARSED_HISTORY_TAMPERED_NOTE}:
   * exactly {@link DEMO_PARSED_HISTORY_TAMPER_ERROR} — the
   * tampered entry's stored hash no longer recomputes. The
   * escrow's own history is untouched by the copy.
   */
  parsedHistoryTamperError: string;
  /**
   * The main escrow rebuilt from its history alone by
   * `Escrow.fromHistory(id, history)` in the closing segment:
   * same id, same RELEASED state, and a history identical to
   * the main escrow's verbatim — 4 entries, seq 1 -> 4
   * continuous, hash chain re-verified on rebuild.
   */
  historyRebuiltEscrow: Escrow;
  /**
   * Deadline of {@link DemoResult.historyRebuiltEscrow}:
   * `undefined` — NOT restored, even though the main escrow
   * carries {@link DEMO_REBUILT_DEADLINE} at rebuild time.
   * A bare history carries no deadline (it lives only in the
   * snapshot envelope), which is the honest `fromHistory`
   * trade-off the closing segment pins.
   */
  historyRebuiltDeadline: string | undefined;
  /**
   * Snapshot of the main escrow taken by `toJSON()` in the
   * closing segment: `v: 1`, id + RELEASED state + the 4
   * history entries + the fixed deadline — no
   * `idempotencyKeys` / `rolePolicy` fields, because the main
   * escrow consumed no keys and carries no policy, so both
   * keep their absent legacy shape.
   */
  escrowSnapshot: EscrowSnapshot;
  /**
   * UTF-8 byte count of the serialized
   * {@link DemoResult.escrowSnapshot}:
   * {@link DEMO_SNAPSHOT_SERIALIZED_BYTES} (1,344) — the size
   * of the persistence envelope a document store would keep.
   */
  snapshotJsonBytes: number;
  /**
   * The main escrow restored by `Escrow.fromJSON()` from the
   * parsed serialization of {@link DemoResult.escrowSnapshot}
   * in the closing segment: same id, same RELEASED state, and
   * a history identical to the main escrow's verbatim.
   */
  snapshotRestoredEscrow: Escrow;
  /**
   * Deadline of {@link DemoResult.snapshotRestoredEscrow}:
   * {@link DEMO_REBUILT_DEADLINE} — RESTORED, in contrast to
   * {@link DemoResult.historyRebuiltDeadline}: the snapshot
   * envelope carries the deadline (and the consumed
   * idempotency-key set) that a bare history cannot.
   */
  snapshotRestoredDeadline: string | undefined;
  /**
   * Full `transitionTableJson()` canonical JSON text: the
   * machine-readable form of the same transition table the
   * state-diagram segment renders for humans — 2-space
   * indent, exactly one trailing newline, byte-identical to
   * the committed snapshot
   * `test/__snapshots__/transitionTable.snapshot.json`.
   */
  transitionTableJsonText: string;
  /**
   * UTF-8 byte count of
   * {@link DemoResult.transitionTableJsonText}:
   * {@link DEMO_TRANSITION_TABLE_JSON_BYTES} (1,160).
   */
  transitionTableJsonBytes: number;
  /**
   * Edges parsed back from
   * {@link DemoResult.transitionTableJsonText} with
   * `JSON.parse`: identical to `transitionTable()` edge for
   * edge — every `from` / `event` / `to` triple in order.
   */
  transitionTableEdges: TransitionEdge[];
  /**
   * Number of edges in {@link DemoResult.transitionTableEdges}:
   * {@link DEMO_TRANSITION_TABLE_EDGE_COUNT} (14), equal to
   * `transitionTable().length`.
   */
  transitionTableEdgeCount: number;
  /**
   * Legal amounts the closing money-guard segment ran
   * through `assertNonNegativeMoney("amount", …)`:
   * {@link DEMO_MONEY_GUARD_LEGAL_AMOUNTS} — every one
   * passed without throwing.
   */
  moneyGuardLegalAmounts: readonly number[];
  /**
   * Rejections from the closing money-guard segment, in
   * corpus order: each illegal amount with the exact
   * error message the guard threw for it
   * ({@link DEMO_MONEY_GUARD_ERROR}).
   */
  moneyGuardRejections: Array<{ value: number; message: string }>;
  /**
   * The closing segment's branch escrow
   * ({@link DEMO_SUBSCRIBE_ESCROW_ID}), after all three fixed
   * dispatches ran: VERIFIED with 3 history entries — the
   * third dispatch landed after unsubscribe.
   */
  subscribeEscrow: Escrow;
  /**
   * Notifications the collecting listener received, in
   * dispatch order: exactly the first two dispatches
   * (FUND seq 1, SUBMIT_MILESTONE seq 2), each matching the
   * audit entry with the same seq.
   */
  subscribeNotifications: Array<{
    event: EscrowEvent;
    from: EscrowState;
    to: EscrowState;
    seq: number;
  }>;
  /**
   * True when every notification in
   * {@link DemoResult.subscribeNotifications} equals the
   * branch escrow's audit entry with the same seq
   * (event / from / to all equal).
   */
  subscribeMatchesHistory: boolean;
  /**
   * Notification count after unsubscribe + one further
   * dispatch: still 2 — the post-unsubscribe dispatch
   * produced zero new notifications.
   */
  subscribeCountAfterUnsubscribe: number;
  /**
   * The closing segment's funded escrow
   * ({@link DEMO_CLEAR_DEADLINE_ESCROW_ID}), after its
   * fixed deadline was cleared: still FUNDED with 1
   * history entry and no deadline — clearing dispatches
   * nothing.
   */
  deadlineClearEscrow: Escrow;
  /**
   * Deadline of {@link DemoResult.deadlineClearEscrow}
   * before `clearDeadline()` ran:
   * {@link DEMO_CLEAR_DEADLINE_DEADLINE}.
   */
  deadlineClearDeadlineBefore: string | undefined;
  /**
   * `isOverdue(deadlineClearEscrow, CHECK_AT)` before
   * clearing: `true` — the fixed check instant is past
   * the fixed deadline and the escrow is non-terminal.
   */
  deadlineClearOverdueBefore: boolean;
  /**
   * Deadline of {@link DemoResult.deadlineClearEscrow}
   * after `clearDeadline()` ran: `undefined`.
   */
  deadlineClearDeadlineAfter: string | undefined;
  /**
   * `isOverdue(deadlineClearEscrow, CHECK_AT)` after
   * clearing, at the same fixed instant: `false` — with
   * no deadline set an escrow is never overdue.
   */
  deadlineClearOverdueAfter: boolean;
  /**
   * The closing segment's second funded escrow
   * ({@link DEMO_CLEAR_DEADLINE_NO_DEADLINE_ESCROW_ID}),
   * which never carried a deadline, after
   * `clearDeadline()` ran on it: still FUNDED with 1
   * history entry and no deadline — the call was a
   * harmless no-op.
   */
  deadlineClearNoDeadlineEscrow: Escrow;
  /**
   * `isOverdue(deadlineClearNoDeadlineEscrow, CHECK_AT)`:
   * `false`, unchanged by the no-op clear.
   */
  deadlineClearNoDeadlineOverdue: boolean;
  /**
   * Full approval audit trail of the dispute quorum
   * ({@link DemoResult.disputeQuorum}) as `approvalLog()`
   * returns it after the refund: exactly the two fixed
   * votes in record order
   * ({@link DEMO_DISPUTE_APPROVAL_LOG_ENTRIES}) — the
   * pre-restart vote kept its original timestamp through
   * the snapshot round-trip.
   */
  approvalLogEntries: ReadonlyArray<ApprovalLogEntry>;
  /**
   * The final closing segment's expiring quorum (2-of-3,
   * same signer ids, window
   * {@link DEMO_APPROVAL_LOG_WINDOW_MS}), after the fixed
   * clock advanced past the window for its first vote:
   * approvalCount 1, hasQuorum false, trail intact.
   */
  approvalLogExpiryQuorum: Quorum;
  /**
   * Counted approvals of the expiring quorum before the
   * fixed clock advance: 2 (both votes inside the window).
   */
  approvalLogExpiryCountBefore: number;
  /**
   * `hasQuorum()` of the expiring quorum before the
   * advance: `true` — threshold 2 reached.
   */
  approvalLogExpiryHasQuorumBefore: boolean;
  /**
   * Counted approvals of the expiring quorum after the
   * advance to {@link DEMO_APPROVAL_LOG_CHECK_AT}: 1 —
   * the first vote is past the window and no longer
   * counts; `approvals()` is exactly [arb-2].
   */
  approvalLogExpiryCountAfter: number;
  /**
   * `hasQuorum()` of the expiring quorum after the
   * advance: `false` — quorum lost to expiry alone.
   */
  approvalLogExpiryHasQuorumAfter: boolean;
  /**
   * `approvalLog()` of the expiring quorum after the
   * advance: both entries retained with their original
   * timestamps ({@link DEMO_APPROVAL_LOG_ENTRIES}) —
   * expiry never deletes the audit trail.
   */
  approvalLogExpiryLogAfter: ReadonlyArray<ApprovalLogEntry>;
  /**
   * Result of delivering the main escrow's signed webhook
   * alone to {@link DEMO_SINGLE_DELIVERY_URL} with
   * `deliverSettlementWebhook()`: exactly
   * `{status: 200, attempts: 2}` — the scripted endpoint
   * answered 500 first, so the delivery succeeded only
   * after one retry.
   */
  singleDeliveryResult: WebhookDeliveryResult;
  /**
   * The requests the scripted fake fetch captured during
   * the single-target delivery, in call order: exactly 2,
   * both POSTs to {@link DEMO_SINGLE_DELIVERY_URL} with
   * byte-identical bodies (the canonical body of the demo
   * webhook) and the webhook's signature in `x-signature`.
   */
  singleDeliveryCalls: Array<{
    url: string;
    method: string;
    body: string;
    signature: string;
  }>;
  /**
   * True when the `X-Signature` header captured on the
   * final (successful) attempt verifies over that
   * attempt's captured raw body under the demo secret —
   * the receiver-side check, run the transport-safe way
   * over the wire bytes.
   */
  singleDeliverySignatureVerified: boolean;
  lines: string[];
}

/**
 * Run the demo lifecycle without printing anything, and return the
 * escrow, its settlement report, and the exact lines `main()` prints —
 * so tests can assert on the demo itself, not just on the library.
 */
export async function runDemo(): Promise<DemoResult> {
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

  // --- Audit hash chain: verifyHistoryChain on the history above ---
  // The settlement just printed is derived from this history, and the
  // history is hash-chained (each entry links to its predecessor,
  // genesis-linked to GENESIS_PREV_HASH): verifyHistoryChain
  // recomputes every link and returns a plain boolean — true for
  // the intact chain. To show what a rewrite looks like, build a
  // detached copy (fresh entry objects — the escrow's history getter
  // hands out frozen copies), alter the FUND entry's amount by 1,
  // and verify again: the stored hash no longer recomputes from the
  // altered canonical content, so the verdict flips to false. The
  // escrow's own history is never touched, and re-verifying it
  // after the tamper check still passes.
  const historyChainVerified = verifyHistoryChain(escrow.history);
  const tamperedHistory = escrow.history.map((entry) => ({ ...entry }));
  const tamperedFund = tamperedHistory.find((entry) => entry.event === "FUND");
  if (tamperedFund === undefined || tamperedFund.amount === undefined) {
    throw new Error("demo fixture broken: main history has no FUND amount");
  }
  const originalFundAmount = tamperedFund.amount;
  tamperedFund.amount = originalFundAmount + 1;
  const tamperedFundAmount = tamperedFund.amount;
  const tamperedChainVerified = verifyHistoryChain(tamperedHistory);
  lines.push(
    "",
    "Audit hash chain (verifyHistoryChain on the main escrow history):",
    `  intact history: verifyHistoryChain: ${historyChainVerified} (${escrow.history.length} entries, genesis-linked, every hash recomputes)`,
    `  tampered copy: FUND amount ${originalFundAmount} -> ${tamperedFundAmount} — verifyHistoryChain: ${tamperedChainVerified} (tamper detected: the stored hash no longer recomputes)`,
    `  original history after the tamper check: verifyHistoryChain: ${verifyHistoryChain(escrow.history)} (detached copy — the escrow's own history is untouched)`,
  );

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

  // --- Retry-After parsing: how the sender reads a 429 hint ---
  // Dedupe is the receiver's half of a retried delivery; this is the
  // sender's half. When a settlement-webhook endpoint answers 429,
  // `deliverSettlementWebhook` reads its `Retry-After` header through
  // `parseRetryAfter` before the next attempt — but the demo never
  // runs a live delivery, so the two hint forms were never shown.
  // A fixed 7-value corpus is parsed against one injected fixed now
  // (DEMO_RETRY_AFTER_NOW_MS — the webhook's `at`, second-aligned so
  // the HTTP-date strings below land exactly). Hand-pinned
  // expectations, written from the documented semantics
  // (delay-seconds -> seconds * 1000; an HTTP-date ->
  // max(0, date - now); signed numbers, garbage, and absent values
  // -> undefined), never derived by calling parseRetryAfter itself
  // (the demo tests cross-check the printed results against the
  // bench fixture's independently pinned corpus as well):
  //   "2"                                    -> 2000
  //   " 30 " (whitespace is trimmed)         -> 30000
  //   "Fri, 06 Mar 2026 08:17:05 GMT" (+5 s) -> 5000
  //   "Fri, 06 Mar 2026 08:16:59 GMT" (-1 s) -> 0
  //   "-5" (signed)                          -> undefined
  //   "banana"                               -> undefined
  //   null                                   -> undefined
  const RETRY_AFTER_CASES: ReadonlyArray<string | null> = [
    "2",
    " 30 ",
    new Date(DEMO_RETRY_AFTER_NOW_MS + 5000).toUTCString(),
    new Date(DEMO_RETRY_AFTER_NOW_MS - 1000).toUTCString(),
    "-5",
    "banana",
    null,
  ];
  const retryAfterParsed = RETRY_AFTER_CASES.map((value) => ({
    value,
    parsed: parseRetryAfter(value, DEMO_RETRY_AFTER_NOW_MS),
  }));
  lines.push(
    "",
    "Retry-After parsing (parseRetryAfter on a fixed clock):",
    `  fixed now: ${DEMO_WEBHOOK_AT} — every value below is parsed against this injected instant, never the wall clock`,
  );
  for (const { value, parsed } of retryAfterParsed) {
    const shown = value === null ? "null" : `"${value}"`;
    lines.push(
      `  parseRetryAfter(${shown}) -> ${parsed === undefined ? "undefined" : parsed}`,
    );
  }
  lines.push(
    "  sender rule: on a 429 the parsed hint, clamped by maxRetryDelayMs, sets the wait before the next attempt; undefined — absent or unparsable — falls back to exponential backoff",
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

  // --- Fan-out delivery: deliverSettlementWebhookToMany (after batch) ---
  // Building a webhook is not delivering it: the sections above
  // sign webhooks and verify them in-process, but no delivery
  // ever runs — yet fan-out to the accounting / notifications /
  // ledger endpoints is how a settlement actually lands. The main
  // escrow's report is delivered as ONE logical event to the
  // three fixed endpoints above. This library's delivery layer
  // calls the global `fetch` (there is no fetchImpl option), so
  // a deterministic fake is installed on `globalThis` for this
  // segment only and the original is restored in the `finally`
  // — zero network, and no later code can observe the fake. The
  // fake records each call and answers 200 immediately, so no
  // retry / backoff path is ever reached. Hand-pinned
  // expectations — written out in the fixture comment above from
  // src/webhooks.ts's documented semantics, never derived by
  // calling the fan-out itself (test/webhookFanout.test.ts and
  // the bench fan-out fixture pin the same shape independently):
  //   3 endpoints -> delivered 3, failed 0
  //   every result {ok: true, attempts: 1, status: 200}, in order
  //   every captured body byte-identical, eventId / at shared
  //   each signature verifies under its own endpoint's secret
  // Asserted HERE, outside the printing — a mismatch throws
  // instead of printing a false verdict.
  const fanoutCalls: Array<{ url: string; body: string; signature: string }> =
    [];
  const fanoutFetch: typeof fetch = async (input, init) => {
    fanoutCalls.push({
      url: String(input),
      body: String(init?.body ?? ""),
      signature: String(
        new Headers(init?.headers).get("x-signature") ?? "",
      ),
    });
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const originalFetch = globalThis.fetch;
  let fanoutResult: DeliverSettlementWebhookToManyResult;
  globalThis.fetch = fanoutFetch;
  try {
    fanoutResult = await deliverSettlementWebhookToMany(
      report,
      DEMO_FANOUT_ENDPOINTS.map((endpoint) => ({ ...endpoint })),
      { now: DEMO_FANOUT_AT, eventId: DEMO_FANOUT_EVENT_ID },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  if (
    fanoutResult.results.length !== 3 ||
    fanoutResult.delivered !== 3 ||
    fanoutResult.failed !== 0 ||
    fanoutResult.results.some(
      (result, i) =>
        !result.ok ||
        result.attempts !== 1 ||
        result.status !== 200 ||
        result.url !== DEMO_FANOUT_ENDPOINTS[i].url,
    ) ||
    fanoutCalls.length !== 3 ||
    fanoutCalls.some((call) => call.body !== fanoutCalls[0].body) ||
    JSON.parse(fanoutCalls[0].body).eventId !== "evt_demo_fanout_001" ||
    JSON.parse(fanoutCalls[0].body).at !== "2026-03-08T10:00:00.000Z" ||
    DEMO_FANOUT_ENDPOINTS.some((endpoint, i) => {
      const call = fanoutCalls.find((c) => c.url === endpoint.url);
      if (!call) return true;
      if (!verifySettlementWebhook(call.body, call.signature, endpoint.secret)) {
        return true;
      }
      return DEMO_FANOUT_ENDPOINTS.some(
        (other, j) =>
          j !== i &&
          verifySettlementWebhook(call.body, call.signature, other.secret),
      );
    })
  ) {
    throw new Error(
      "demo fixture broken: deliverSettlementWebhookToMany fan-out does not have the pinned shape (3 endpoints, 3 delivered / 0 failed, one attempt each at status 200, byte-identical shared bodies, per-endpoint signatures verifiable only under their own secret)",
    );
  }
  lines.push(
    "",
    "Settlement webhook fan-out (deliverSettlementWebhookToMany via fake fetch, zero network):",
    `  one logical event: eventId ${DEMO_FANOUT_EVENT_ID}, at ${DEMO_FANOUT_AT} — the payload body is built once and shared by every endpoint, signed per endpoint with its own secret`,
  );
  for (const result of fanoutResult.results) {
    lines.push(
      `  ${result.url}: ok ${result.ok} — attempts ${result.attempts}, status ${result.status}`,
    );
  }
  lines.push(
    `  fan-out: ${fanoutResult.results.length} endpoints, ${fanoutResult.delivered} delivered, ${fanoutResult.failed} failed — every endpoint received byte-identical body bytes, each signature verifies under its own endpoint's secret only`,
  );

  // --- Watchdog screening: staleEscrows (dwell) vs expiredEscrows ---
  // Two production screening axes over one fresh batch of three
  // escrows, all on the fixed DEMO_STALE_NOW — see the fixture
  // comment above for the hand-computed expectations. staleEscrows
  // measures dwell in the CURRENT state (last history entry's `at`
  // against a per-state budget) and never looks at the deadline;
  // expiredEscrows looks only at the absolute deadline and never at
  // dwell. Both selections are captured BEFORE any action runs, so
  // the printed comparison is a snapshot of the same pre-action
  // batch. The disposition then goes through actOnStaleEscrows with
  // an EXPIRE dispatch pinned to the fixed `now`: dispatching
  // without an explicit `at` would stamp the wall clock into the
  // audit history and break the demo's determinism.
  const staleOnlyEscrow = new Escrow(DEMO_STALE_ESCROW_ID);
  staleOnlyEscrow.dispatch("FUND", "Deposit locked (wire received)", 10630, {
    actor: "sponsor",
    at: DEMO_STALE_FUND_AT,
  });
  staleOnlyEscrow.setDeadline(DEMO_STALE_DEADLINE);
  const overdueOnlyEscrow = new Escrow(DEMO_OVERDUE_ONLY_ESCROW_ID);
  overdueOnlyEscrow.dispatch("FUND", "Deposit locked (wire received)", 10630, {
    actor: "sponsor",
    at: DEMO_OVERDUE_ONLY_FUND_AT,
  });
  overdueOnlyEscrow.dispatch(
    "SUBMIT_MILESTONE",
    "Deliverable URLs + IPFS metadata hash",
    undefined,
    { actor: "creator", at: DEMO_OVERDUE_ONLY_SUBMIT_AT },
  );
  overdueOnlyEscrow.setDeadline(DEMO_OVERDUE_ONLY_DEADLINE);
  const freshEscrow = new Escrow(DEMO_FRESH_ESCROW_ID);
  freshEscrow.dispatch("FUND", "Deposit locked (wire received)", 10630, {
    actor: "sponsor",
    at: DEMO_FRESH_FUND_AT,
  });
  freshEscrow.setDeadline(DEMO_FRESH_DEADLINE);
  const watchdogEscrows = [staleOnlyEscrow, overdueOnlyEscrow, freshEscrow];
  const staleMaxAgeByState = {
    FUNDED: DEMO_STALE_MAX_AGE_MS,
    MILESTONE_SUBMITTED: DEMO_STALE_MAX_AGE_MS,
  };
  const staleNow = new Date(DEMO_STALE_NOW);
  const staleSelected = staleEscrows(
    watchdogEscrows,
    staleMaxAgeByState,
    staleNow,
  );
  const expiredSelected = expiredEscrows(watchdogEscrows, staleNow);
  const staleIds = new Set(staleSelected.map((e) => e.id));
  const expiredIds = new Set(expiredSelected.map((e) => e.id));
  const staleNowMs = Date.parse(DEMO_STALE_NOW);
  lines.push(
    "",
    "Watchdog screening (stale dwell axis vs expired deadline axis):",
    `  fixed now: ${DEMO_STALE_NOW} — stale budgets: FUNDED 7 days, MILESTONE_SUBMITTED 7 days (dwell from the last history entry, strictly past the budget)`,
  );
  for (const watchdogEscrow of watchdogEscrows) {
    const lastEntry =
      watchdogEscrow.history[watchdogEscrow.history.length - 1];
    const dwellDays =
      (staleNowMs - Date.parse(lastEntry.at)) / DEMO_STALE_DAY_MS;
    lines.push(
      `  ${watchdogEscrow.id}: state ${watchdogEscrow.state}, entered ${lastEntry.at}, dwell ${dwellDays} ${dwellDays === 1 ? "day" : "days"}, deadline ${watchdogEscrow.getDeadline()} — stale: ${staleIds.has(watchdogEscrow.id)}, expired: ${expiredIds.has(watchdogEscrow.id)}`,
    );
  }
  lines.push(
    `  stale vs expired on the same batch: stale [${staleSelected.map((e) => e.id).join(", ")}], expired [${expiredSelected.map((e) => e.id).join(", ")}] — different axes, different subsets (dwell in the current state vs absolute deadline)`,
  );
  const staleActionResults = actOnStaleEscrows(
    watchdogEscrows,
    (e) =>
      e.dispatch(
        "EXPIRE",
        "Stale in current state past the 7-day budget — expired by watchdog",
        undefined,
        { actor: "watchdog", at: DEMO_STALE_NOW },
      ),
    staleMaxAgeByState,
    staleNow,
  );
  lines.push(
    `  actOnStaleEscrows (action: dispatch EXPIRE at the fixed now): ${staleActionResults.length} attempted`,
  );
  for (const result of staleActionResults) {
    lines.push(
      result.acted
        ? `  ${result.escrow.id}: acted true — now ${result.escrow.state}`
        : `  ${result.escrow.id}: acted false — error: ${result.error}`,
    );
  }
  lines.push(
    `  non-stale escrows untouched: ${overdueOnlyEscrow.id} still ${overdueOnlyEscrow.state}, ${freshEscrow.id} still ${freshEscrow.state}`,
  );

  // --- Deadline watchdog: expiredEscrows -> expireOverdueEscrows ---
  // The execution half of the deadline axis, over a fresh batch of
  // three escrows on the same fixed `now` and the same 7-day stale
  // budgets — see the fixture comment above for the hand-computed
  // expectations. Both selections are captured BEFORE the executor
  // runs, so the printed comparison is a snapshot of the same
  // pre-action batch. The executor then attempts exactly the
  // expired selection: the VERIFIED escrow has no EXPIRE edge, so
  // it lands as a per-item error and the batch continues to the
  // FUNDED escrow after it, which expires. (The executor dispatches
  // EXPIRE with no pinned `at` — its audit entries carry the
  // dispatch-time wall clock, so no timestamp is printed for them;
  // see the fixture comment.)
  const unexpirableEscrow = new Escrow(DEMO_UNEXPIRABLE_ESCROW_ID);
  unexpirableEscrow.dispatch("FUND", "Deposit locked (wire received)", 10630, {
    actor: "sponsor",
    at: DEMO_UNEXPIRABLE_FUND_AT,
  });
  unexpirableEscrow.dispatch(
    "SUBMIT_MILESTONE",
    "Deliverable URLs + IPFS metadata hash",
    undefined,
    { actor: "creator", at: DEMO_UNEXPIRABLE_SUBMIT_AT },
  );
  unexpirableEscrow.dispatch(
    "VERIFY_PASS",
    "KPIs validated by oracle",
    undefined,
    {
      actor: "oracle",
      at: DEMO_UNEXPIRABLE_VERIFY_AT,
      evidence: "demo-oracle-attestation-002",
    },
  );
  unexpirableEscrow.setDeadline(DEMO_UNEXPIRABLE_DEADLINE);
  const expirableEscrow = new Escrow(DEMO_EXPIRABLE_ESCROW_ID);
  expirableEscrow.dispatch("FUND", "Deposit locked (wire received)", 10630, {
    actor: "sponsor",
    at: DEMO_EXPIRABLE_FUND_AT,
  });
  expirableEscrow.setDeadline(DEMO_EXPIRABLE_DEADLINE);
  const deadlineStaleEscrow = new Escrow(DEMO_DEADLINE_STALE_ESCROW_ID);
  deadlineStaleEscrow.dispatch(
    "FUND",
    "Deposit locked (wire received)",
    10630,
    { actor: "sponsor", at: DEMO_DEADLINE_STALE_FUND_AT },
  );
  deadlineStaleEscrow.setDeadline(DEMO_DEADLINE_STALE_DEADLINE);
  const deadlineEscrows = [
    unexpirableEscrow,
    expirableEscrow,
    deadlineStaleEscrow,
  ];
  const deadlineExpiredSelected = expiredEscrows(deadlineEscrows, staleNow);
  const deadlineStaleSelected = staleEscrows(
    deadlineEscrows,
    staleMaxAgeByState,
    staleNow,
  );
  const deadlineExpiredIds = new Set(
    deadlineExpiredSelected.map((e) => e.id),
  );
  const deadlineStaleIds = new Set(deadlineStaleSelected.map((e) => e.id));
  lines.push(
    "",
    "Deadline watchdog (expiredEscrows screening -> expireOverdueEscrows execution):",
    `  fixed now: ${DEMO_STALE_NOW} — screening and execution on the deadline axis; the stale budgets above (FUNDED 7 days, MILESTONE_SUBMITTED 7 days) are reused for the comparison line`,
  );
  for (const deadlineEscrow of deadlineEscrows) {
    const lastEntry =
      deadlineEscrow.history[deadlineEscrow.history.length - 1];
    const dwellDays =
      (staleNowMs - Date.parse(lastEntry.at)) / DEMO_STALE_DAY_MS;
    lines.push(
      `  ${deadlineEscrow.id}: state ${deadlineEscrow.state}, entered ${lastEntry.at}, dwell ${dwellDays} ${dwellDays === 1 ? "day" : "days"}, deadline ${deadlineEscrow.getDeadline()} — expired: ${deadlineExpiredIds.has(deadlineEscrow.id)}, stale: ${deadlineStaleIds.has(deadlineEscrow.id)}`,
    );
  }
  lines.push(
    `  expiredEscrows selection: [${deadlineExpiredSelected.map((e) => e.id).join(", ")}] — the stale-only escrow ${deadlineStaleEscrow.id} is not selected (its deadline is still ahead)`,
  );
  const deadlineExpireResults = expireOverdueEscrows(
    deadlineEscrows,
    staleNow,
  );
  lines.push(
    `  expireOverdueEscrows: ${deadlineExpireResults.length} attempted`,
  );
  for (const result of deadlineExpireResults) {
    lines.push(
      result.expired
        ? `  ${result.escrow.id}: expired true — now ${result.escrow.state}`
        : `  ${result.escrow.id}: expired false — error: ${result.error} (escrow unchanged at ${result.escrow.state})`,
    );
  }
  lines.push(
    `  deadline vs stale on the same batch: expired [${deadlineExpiredSelected.map((e) => e.id).join(", ")}], stale [${deadlineStaleSelected.map((e) => e.id).join(", ")}] — different axes, different subsets (absolute deadline vs dwell in the current state)`,
    `  non-expired escrows untouched: ${deadlineStaleEscrow.id} still ${deadlineStaleEscrow.state}`,
  );

  // --- Allowed-events listing: allowedEvents over all 8 states ---
  // Every section above dispatches a fixed script, so a reader never
  // sees the query an escrow-list UI or a watchdog consults BEFORE
  // dispatching — "what can this escrow do next?" `allowedEvents(state)`
  // answers it from the transition table alone: pure, no escrow
  // instance, no dispatch, no mutation (no network, no randomness,
  // no wall clock). All 8 states are listed in transition-table
  // declaration order. Hand-pinned expectations — written out here
  // from TRANSITIONS in src/stateMachine.ts, never derived by calling
  // allowedEvents itself (the demo tests cross-check the printed
  // listing against the transitionTable snapshot as well, and bench
  // #304's fixture pins the same lists):
  //   CREATED:             FUND, EXPIRE
  //   FUNDED:              FUND, SUBMIT_MILESTONE, DISPUTE, EXPIRE
  //   MILESTONE_SUBMITTED: VERIFY_PASS, VERIFY_FAIL, DISPUTE, EXPIRE
  //   VERIFIED:            RELEASE, DISPUTE
  //   DISPUTED:            ARBITRATE_RELEASE, ARBITRATE_REFUND
  //   RELEASED:            (none — terminal)
  //   REFUNDED:            (none — terminal)
  //   EXPIRED:             (none — terminal)
  const ALL_STATES: EscrowState[] = [
    "CREATED",
    "FUNDED",
    "MILESTONE_SUBMITTED",
    "VERIFIED",
    "DISPUTED",
    "RELEASED",
    "REFUNDED",
    "EXPIRED",
  ];
  const allowedEventsByState = ALL_STATES.map((state) => ({
    state,
    events: allowedEvents(state),
  }));
  const mainEscrowAllowedEvents = allowedEvents(escrow.state);
  lines.push(
    "",
    "Allowed events by state (allowedEvents over all 8 states):",
  );
  for (const { state, events } of allowedEventsByState) {
    lines.push(
      `  ${state.padEnd(20)} -> ${events.length > 0 ? events.join(", ") : "(none — terminal)"}`,
    );
  }
  lines.push(
    `  main escrow ${escrow.id} (${escrow.state}): allowedEvents -> ${mainEscrowAllowedEvents.length > 0 ? mainEscrowAllowedEvents.join(", ") : "(none)"} — a terminal escrow offers no further events, so an escrow-list UI renders no actions for it`,
  );

  // --- Deposit provenance: depositAmountFromHistory (closing) ---
  // Every figure in the settlement report printed at the top of the
  // demo rests on the locked deposit, but the report receives that
  // deposit from the caller (`calculateDeposit`) — a reader never
  // sees it corroborated by the audit trail alone, which is the
  // reconciliation / audit question: "show me, from the history
  // only, how much was actually locked." `depositAmountFromHistory`
  // answers it: the SUM of the `amount` on every FUND entry (the
  // initial deposit plus any top-ups). Hand-pinned expectation —
  // written out here from the main escrow's fixed steps above,
  // never derived by calling the function itself (the demo tests
  // cross-check the printed amount against the settlement report's
  // deposit as well):
  //   main history FUND entries: one, amount 10630 -> traced 10630
  // The failure half runs on a fixed detached copy of the same
  // history with every FUND entry removed (the remaining entries
  // are SUBMIT_MILESTONE / VERIFY_PASS / RELEASE): with no FUND
  // event at all, the function must throw the explicit
  // `settlement requires a FUND amount` error instead of returning
  // undefined / NaN and poisoning settlement math downstream. The
  // throw is asserted outside the printing (captured as a string),
  // and the escrow's own history is never touched — the copy is
  // built by filtering the frozen entries the history getter hands
  // out. Pure: no dispatch, no network, no randomness, no wall clock.
  const tracedDepositAmount = depositAmountFromHistory(
    escrow.history,
    escrow.id,
  );
  const noFundHistory = escrow.history.filter(
    (entry) => entry.event !== "FUND",
  );
  let noFundDepositError = "";
  try {
    depositAmountFromHistory(noFundHistory, escrow.id);
  } catch (err) {
    noFundDepositError = err instanceof Error ? err.message : String(err);
  }
  lines.push(
    "",
    "Deposit provenance (depositAmountFromHistory on the main escrow history):",
    `  main escrow ${escrow.id}: depositAmountFromHistory -> ${tracedDepositAmount} (the sum of every FUND amount in the audit trail — matches the settlement report deposit 10630)`,
    `  no-FUND copy (${noFundHistory.length} entries, every FUND entry removed): depositAmountFromHistory FAILED — ${noFundDepositError} (a history with no FUND event cannot corroborate a deposit, so settlement refuses rather than guessing)`,
  );

  // --- Settlement split: settleRelease (closing) ---
  // The settlement report printed at the top of the demo derives
  // its RELEASE payout from settleRelease internally, so a reader
  // sees the split only as report party rows and never as the pure
  // function's own input -> output — yet this gross-to-net step is
  // the core money step of the RELEASE path. Here it runs in
  // isolation on the main escrow's own fixed inputs: the golden
  // deposit (fees.deposit, the calculateDeposit result already
  // corroborated by the provenance segment above) as gross, the
  // main escrow's DEMO_PRO_FEE_BPS as the fee rate, and no referral
  // credits — exactly the parameters the report was built with.
  // Hand-pinned expectations — written out here from settlement.ts's
  // documented arithmetic (proFee = round2(gross * bps / 10000);
  // net = round2(gross - proFee - referralCredits)), never derived
  // by calling settleRelease itself (the demo tests cross-check the
  // printed split against economics.test.ts's pinned vectors —
  // 1,000 at 500 bps -> proFee 50 / net 950 — and against the bench
  // fixture, which pins this same golden input independently):
  //   gross 10630, proFeeBps 500 -> proFee 531.5
  //   referralCredits 0 (the report passes none) -> net 10098.5
  //   conservation: net 10098.5 + proFee 531.5 + credits 0 = 10630
  // Pure: no dispatch, no network, no randomness, no wall clock.
  const releaseSettlement = settleRelease({
    gross: fees.deposit,
    proFeeBps: DEMO_PRO_FEE_BPS,
  });
  const releaseSplitSum =
    releaseSettlement.net +
    releaseSettlement.proFee +
    releaseSettlement.referralCredits;
  lines.push(
    "",
    "Settlement split (settleRelease on the main escrow deposit):",
    `  main escrow ${escrow.id}: settleRelease(gross ${releaseSettlement.gross}, proFeeBps ${DEMO_PRO_FEE_BPS}, referralCredits ${releaseSettlement.referralCredits}) -> net ${releaseSettlement.net}, proFee ${releaseSettlement.proFee}`,
    `  conservation: net ${releaseSettlement.net} + proFee ${releaseSettlement.proFee} + referralCredits ${releaseSettlement.referralCredits} = ${releaseSplitSum} — equals gross ${releaseSettlement.gross}, the main escrow deposit (every part of the deposit is accounted for)`,
    `  cross-check: the settlement report above is this same split — creator net ${releaseSettlement.net} (= net), platform net ${releaseSettlement.proFee} (= proFee), referrer net ${releaseSettlement.referralCredits} (= referralCredits)`,
  );

  // --- Audit history NDJSON round-trip: historyToNdjson /
  // historyFromNdjson (closing) ---
  // The audit history printed at the top of the demo lives in
  // memory; shipping it to disk, appending it line by line, or
  // feeding it to a reconciliation pipeline is the NDJSON
  // transport's job — one canonical JSON entry per line, line
  // order = seq order, every line `\n`-terminated. Hand-pinned
  // expectations — written out here from the main escrow's fixed
  // steps above, never derived by calling the NDJSON functions
  // themselves (the demo tests cross-check them against independent
  // calls and against test/ndjson.test.ts's pinned behaviour):
  //   4 entries -> 4 lines; seq 1 (FUND, CREATED -> FUNDED),
  //   2 (SUBMIT_MILESTONE), 3 (VERIFY_PASS), 4 (RELEASE, -> RELEASED)
  // The round-trip is asserted HERE, outside the printing: entry
  // count, seq continuity, from/to chain continuity, the final
  // entry's state, and verbatim equality with the original history
  // — a mismatch throws instead of printing a false verdict. Pure:
  // no dispatch, no network, no randomness, no wall clock.
  const historyNdjson = historyToNdjson(escrow.history);
  const historyNdjsonRoundTripped = historyFromNdjson(historyNdjson);
  const historyNdjsonLines = historyNdjson.replace(/\n$/, "").split("\n");
  const historyNdjsonLineCount = historyNdjsonLines.length;
  const historyNdjsonFirstLine = historyNdjsonLines[0];
  if (historyNdjsonRoundTripped.length !== escrow.history.length) {
    throw new Error("demo fixture broken: NDJSON round-trip entry count differs");
  }
  for (const [i, entry] of historyNdjsonRoundTripped.entries()) {
    if (entry.seq !== i + 1) {
      throw new Error("demo fixture broken: NDJSON round-trip seq chain is not continuous");
    }
    if (i > 0 && entry.from !== historyNdjsonRoundTripped[i - 1].to) {
      throw new Error("demo fixture broken: NDJSON round-trip from/to chain is not continuous");
    }
  }
  const ndjsonLastEntry =
    historyNdjsonRoundTripped[historyNdjsonRoundTripped.length - 1];
  if (ndjsonLastEntry.to !== escrow.state) {
    throw new Error("demo fixture broken: NDJSON round-trip final state differs");
  }
  if (
    JSON.stringify(historyNdjsonRoundTripped) !==
    JSON.stringify([...escrow.history])
  ) {
    throw new Error("demo fixture broken: NDJSON round-trip entries differ from the original history");
  }
  if (historyToNdjson(historyNdjsonRoundTripped) !== historyNdjson) {
    throw new Error("demo fixture broken: NDJSON re-export differs from the original export");
  }
  lines.push(
    "",
    "Audit history NDJSON round-trip (historyToNdjson / historyFromNdjson on the main escrow history):",
    `  main escrow ${escrow.id}: historyToNdjson -> ${historyNdjsonLineCount} lines (one JSON entry per line, seq order, every line terminated)`,
    `  first line: ${historyNdjsonFirstLine}`,
    `  historyFromNdjson -> ${historyNdjsonRoundTripped.length} entries — round-trip identical: seq chain 1 -> ${ndjsonLastEntry.seq} continuous, final entry lands in ${ndjsonLastEntry.to}, every entry matches the original history verbatim`,
    `  re-export: historyToNdjson(round-tripped entries) reproduces the NDJSON text byte-for-byte`,
  );

  // --- Overdue judgement: isOverdue at three fixed instants (closing) ---
  // Every watchdog section above reaches the deadline axis only
  // through the batch helpers (`expiredEscrows` /
  // `expireOverdueEscrows`), so a reader never sees the single-
  // escrow boolean those helpers are built on — yet that boolean
  // is the SLA question every escrow row answers before any
  // EXPIRE / refund decision: "is this one escrow past its
  // deadline right now?" A further funded escrow with a fixed
  // deadline is judged at three fixed instants. Hand-pinned
  // expectations — written out in the fixture comment above from
  // src/stateMachine.ts (`now >= deadline` for a non-terminal
  // escrow with a deadline), never derived by calling isOverdue
  // itself (test/deadline.test.ts pins the same boundary case
  // independently — now exactly at the deadline is true):
  //   before (2026-03-09) -> false
  //   at deadline (2026-03-10) -> true
  //   after (2026-03-11) -> true
  // The three verdicts are asserted HERE, outside the printing —
  // a mismatch throws instead of printing a false verdict. Pure:
  // isOverdue reads the escrow and never dispatches, so the
  // escrow stays FUNDED with its one FUND entry; no network, no
  // randomness, no wall clock (every `now` is a fixed constant).
  const overdueCheckEscrow = new Escrow(DEMO_OVERDUE_CHECK_ESCROW_ID);
  overdueCheckEscrow.dispatch("FUND", "Deposit locked (wire received)", 10630, {
    actor: "sponsor",
    at: DEMO_OVERDUE_CHECK_FUND_AT,
  });
  overdueCheckEscrow.setDeadline(DEMO_OVERDUE_CHECK_DEADLINE);
  const overdueCheckAts = [
    DEMO_OVERDUE_CHECK_BEFORE_AT,
    DEMO_OVERDUE_CHECK_AT_DEADLINE,
    DEMO_OVERDUE_CHECK_AFTER_AT,
  ] as const;
  const overdueChecks = overdueCheckAts.map((at) => ({
    at,
    overdue: isOverdue(overdueCheckEscrow, new Date(at)),
  }));
  const overdueExpected: readonly boolean[] = [false, true, true];
  for (const [i, check] of overdueChecks.entries()) {
    if (check.overdue !== overdueExpected[i]) {
      throw new Error(
        `demo fixture broken: isOverdue at ${check.at} is ${check.overdue}, expected ${overdueExpected[i]}`,
      );
    }
  }
  if (
    overdueCheckEscrow.state !== "FUNDED" ||
    overdueCheckEscrow.history.length !== 1
  ) {
    throw new Error(
      "demo fixture broken: isOverdue mutated the escrow it judged",
    );
  }
  lines.push(
    "",
    "Overdue judgement (isOverdue on a funded escrow at three fixed instants):",
    `  escrow ${overdueCheckEscrow.id}: state ${overdueCheckEscrow.state}, deadline ${overdueCheckEscrow.getDeadline()} — isOverdue is advisory only (it reads the escrow, dispatches nothing)`,
    `  before deadline (${overdueChecks[0].at}): isOverdue -> ${overdueChecks[0].overdue}`,
    `  at deadline (${overdueChecks[1].at}): isOverdue -> ${overdueChecks[1].overdue} (boundary: now >= deadline counts as overdue)`,
    `  after deadline (${overdueChecks[2].at}): isOverdue -> ${overdueChecks[2].overdue}`,
    `  escrow unchanged after the three judgements: still ${overdueCheckEscrow.state} (${overdueCheckEscrow.history.length} history entry) — a watchdog dispatches EXPIRE explicitly`,
  );

  // --- State diagram generation: stateDiagram ---
  // Every section above walks the transition table one dispatch
  // at a time, so a reader never sees the table rendered the way
  // the README presents it — `stateDiagram()` generates the
  // Mermaid stateDiagram-v2 block from transitionTable() (the
  // single source of truth), the exact block the README embeds
  // verbatim and test/diagram.test.ts guards against drift.
  // The demo prints a summary, not the 21-line block: the line
  // total and edge count plus the first, second, initial,
  // first-edge, last-edge, terminal, and last lines.
  // Hand-pinned expectations — written out here from
  // TRANSITIONS in src/stateMachine.ts, never derived by calling
  // stateDiagram itself (the demo tests cross-check the full
  // generated block line by line as well, and bench's
  // stateDiagram fixture pins the same shape independently):
  //   21 lines in total, 14 of them edge lines
  //   line 1:  ```mermaid (the opening fence)
  //   line 2:  stateDiagram-v2
  //   line 3:      [*] --> CREATED (the initial transition)
  //   line 4:      CREATED --> FUNDED : FUND (the first edge)
  //   line 17:     DISPUTED --> REFUNDED : ARBITRATE_REFUND (last edge)
  //   lines 18-20: RELEASED / REFUNDED / EXPIRED --> [*] (terminals)
  //   line 21: ``` (the closing fence)
  // The edge-line count must equal the transition table's edge
  // count — the same 14 the committed snapshot pins — and the
  // segment asserts that here, outside the printed summary: a
  // diagram whose shape broke would fail the demo itself, not
  // just a test. The segment is pure: no escrow instance, no
  // dispatch, no network, no randomness, no wall clock.
  const stateDiagramText = stateDiagram();
  const stateDiagramLines = stateDiagramText.split("\n");
  const stateDiagramEdgeLines = stateDiagramLines.slice(3, -4);
  const stateDiagramEdgeCount = stateDiagramEdgeLines.length;
  const stateDiagramTerminalLines = stateDiagramLines.slice(-4, -1);
  if (
    stateDiagramLines.length !== 21 ||
    stateDiagramLines[0] !== "```mermaid" ||
    stateDiagramLines[1] !== "stateDiagram-v2" ||
    stateDiagramLines[2] !== "    [*] --> CREATED" ||
    stateDiagramEdgeCount !== transitionTable().length ||
    stateDiagramEdgeLines[0] !== "    CREATED --> FUNDED : FUND" ||
    stateDiagramEdgeLines[stateDiagramEdgeLines.length - 1] !==
      "    DISPUTED --> REFUNDED : ARBITRATE_REFUND" ||
    stateDiagramTerminalLines.join("\n") !==
      "    RELEASED --> [*]\n    REFUNDED --> [*]\n    EXPIRED --> [*]" ||
    stateDiagramLines[stateDiagramLines.length - 1] !== "```"
  ) {
    throw new Error(
      "demo fixture broken: stateDiagram() output does not have the pinned shape (21 lines, mermaid fence, stateDiagram-v2 header, CREATED start, one edge line per transition-table edge, RELEASED/REFUNDED/EXPIRED terminals, closing fence)",
    );
  }
  lines.push(
    "",
    "State diagram generation (stateDiagram from the transition table):",
    `  stateDiagram(): ${stateDiagramLines.length} lines, ${stateDiagramEdgeCount} edges (generated from transitionTable() — the Mermaid block the README embeds verbatim)`,
    `  first line: ${stateDiagramLines[0]}`,
    `  second line: ${stateDiagramLines[1]}`,
    `  initial transition (line 3): ${stateDiagramLines[2].trim()}`,
    `  first edge (line 4): ${stateDiagramEdgeLines[0].trim()}`,
    `  last edge (line 17): ${stateDiagramEdgeLines.at(-1)!.trim()}`,
    `  terminal lines (lines 18-20): ${stateDiagramTerminalLines.map((line) => line.trim()).join(", ")}`,
    `  last line: ${stateDiagramLines.at(-1)}`,
  );

  // --- Standalone history parsing: parseEscrowHistory (closing) ---
  // Every segment above either drives an Escrow or reads its
  // history back through one (the NDJSON segment's
  // historyFromNdjson feeds a transport parser; fromHistory /
  // fromJSON rebuild an instance). A recovery or reconciliation
  // tool often holds only a bare history value — JSON text from
  // a log shipper or another store — and needs it validated on
  // its own, with no Escrow instance at all, before anything
  // rebuilds from it. That is `parseEscrowHistory(history)`: the
  // exact parseEscrowSnapshot validation (seq from 1 with no
  // gaps, from/to chain continuous from CREATED, every edge
  // legal, canonical non-decreasing timestamps, amount only on
  // FUND, evidence only on VERIFY_PASS, unknown fields rejected,
  // and a fully chained history's hash chain re-verified),
  // returning sanitized detached copies in canonical field
  // order. The corpus here is the main escrow's own history,
  // serialized with JSON.stringify and parsed back from plain
  // JSON values (no network, no randomness, no wall clock).
  // Hand-pinned expectations — written out in the fixture
  // comment above from src/stateMachine.ts, never derived by
  // calling parseEscrowHistory itself (test/historyParserFuzz
  // pins the same parser independently):
  //   4 entries -> seq 1 FUND / 2 SUBMIT_MILESTONE /
  //   3 VERIFY_PASS / 4 RELEASE, final entry lands in RELEASED,
  //   every entry identical to the original history verbatim
  // The success parse is asserted HERE, outside the printing.
  // The tamper check then runs on a detached copy whose middle
  // entry (seq 2) carries a rewritten note: structurally
  // well-formed, but its stored hash no longer recomputes from
  // the altered canonical content, so the parse must throw
  // DEMO_PARSED_HISTORY_TAMPER_ERROR exactly — and the escrow's
  // own history (original note intact) still parses afterwards.
  const parsedHistoryEntries = parseEscrowHistory(
    JSON.parse(JSON.stringify(escrow.history)) as unknown,
  );
  if (
    parsedHistoryEntries.length !== escrow.history.length ||
    JSON.stringify(parsedHistoryEntries) !==
      JSON.stringify([...escrow.history])
  ) {
    throw new Error(
      "demo fixture broken: parseEscrowHistory round-trip entries differ from the original history",
    );
  }
  const parsedHistoryLast = parsedHistoryEntries.at(-1)!;
  if (
    parsedHistoryLast.seq !== 4 ||
    parsedHistoryLast.event !== "RELEASE" ||
    parsedHistoryLast.to !== escrow.state
  ) {
    throw new Error(
      "demo fixture broken: parseEscrowHistory final entry does not land in the main escrow state",
    );
  }
  const tamperedParsedHistory = (
    JSON.parse(JSON.stringify(escrow.history)) as Array<
      Record<string, unknown>
    >
  ).map((entry) => ({ ...entry }));
  const tamperedParsedEntry = tamperedParsedHistory.find(
    (entry) => entry.seq === DEMO_PARSED_HISTORY_TAMPERED_SEQ,
  );
  if (tamperedParsedEntry === undefined) {
    throw new Error(
      "demo fixture broken: serialized history has no entry at the tamper seq",
    );
  }
  tamperedParsedEntry.note = DEMO_PARSED_HISTORY_TAMPERED_NOTE;
  let parsedHistoryTamperError = "";
  try {
    parseEscrowHistory(tamperedParsedHistory);
  } catch (err) {
    parsedHistoryTamperError =
      err instanceof Error ? err.message : String(err);
  }
  if (parsedHistoryTamperError !== DEMO_PARSED_HISTORY_TAMPER_ERROR) {
    throw new Error(
      `demo fixture broken: tampered history parse error is ${JSON.stringify(parsedHistoryTamperError)}, expected ${JSON.stringify(DEMO_PARSED_HISTORY_TAMPER_ERROR)}`,
    );
  }
  if (
    parseEscrowHistory(
      JSON.parse(JSON.stringify(escrow.history)) as unknown,
    ).length !== escrow.history.length ||
    escrow.history[DEMO_PARSED_HISTORY_TAMPERED_SEQ - 1].note ===
      DEMO_PARSED_HISTORY_TAMPERED_NOTE
  ) {
    throw new Error(
      "demo fixture broken: the tamper check touched the escrow's own history",
    );
  }
  lines.push(
    "",
    "Standalone history parsing (parseEscrowHistory on the main escrow history):",
    `  main escrow ${escrow.id}: history serialized to JSON, parsed standalone (no Escrow instance) -> ${parsedHistoryEntries.length} entries, final entry lands in ${parsedHistoryLast.to} (seq ${parsedHistoryLast.seq} ${parsedHistoryLast.event} ${parsedHistoryLast.from} -> ${parsedHistoryLast.to})`,
    `  parsed entries match the original history verbatim: every entry identical (seq chain 1 -> ${parsedHistoryLast.seq} continuous, hash chain re-verified)`,
    `  tampered copy: entry seq ${DEMO_PARSED_HISTORY_TAMPERED_SEQ} (SUBMIT_MILESTONE) note rewritten — parseEscrowHistory FAILED — ${parsedHistoryTamperError}`,
    `  original history after the tamper check: parseEscrowHistory still returns ${parsedHistoryEntries.length} entries (detached copy — the escrow's own history is untouched)`,
  );

  // --- Event-sourced rebuild: Escrow.fromHistory (closing) ---
  // Every segment above either drives an Escrow or reads its
  // history back through a parser (the closing segment above
  // validates the bare history on its own) — none of them shows
  // the event-sourcing payoff itself: rebuilding the escrow
  // from the audit log alone, with no snapshot envelope at all.
  // That is `Escrow.fromHistory(id, history)`: the history is
  // validated exactly as `parseEscrowHistory` validates it
  // (seq chain, legal edges, canonical timestamps, hash-chain
  // re-verification) and the final entry's `to` becomes the
  // rebuilt state. To make the rebuild trade-off visible, a
  // fixed advisory deadline is attached to the main escrow
  // first: the deadline lives only in the snapshot envelope,
  // never in the history, so it cannot come back.
  // Hand-pinned expectations — written out in the fixture
  // comment above from the `fromHistory` doc comment in
  // src/stateMachine.ts, never derived by calling fromHistory
  // itself (test/fromHistory.test.ts pins the same semantics
  // independently, including the honest-limits deadline case):
  //   rebuilt state RELEASED, 4 history entries identical to
  //   the original verbatim, rebuilt deadline undefined while
  //   the original keeps DEMO_REBUILT_DEADLINE
  // The rebuild is asserted HERE, outside the printing — a
  // mismatch throws instead of printing a false verdict. Pure:
  // the rebuild only reads the history (setDeadline is the
  // advisory setter, it appends no history entry), no network,
  // no randomness, no wall clock.
  escrow.setDeadline(DEMO_REBUILT_DEADLINE);
  const historyRebuiltEscrow = Escrow.fromHistory(escrow.id, escrow.history);
  const historyRebuiltDeadline = historyRebuiltEscrow.getDeadline();
  if (
    historyRebuiltEscrow.id !== escrow.id ||
    historyRebuiltEscrow.state !== "RELEASED" ||
    historyRebuiltEscrow.state !== escrow.state
  ) {
    throw new Error(
      "demo fixture broken: Escrow.fromHistory rebuild does not land in the main escrow state",
    );
  }
  if (
    historyRebuiltEscrow.history.length !== escrow.history.length ||
    JSON.stringify(historyRebuiltEscrow.history) !==
      JSON.stringify([...escrow.history])
  ) {
    throw new Error(
      "demo fixture broken: Escrow.fromHistory rebuilt history differs from the original history",
    );
  }
  if (
    historyRebuiltDeadline !== undefined ||
    escrow.getDeadline() !== DEMO_REBUILT_DEADLINE
  ) {
    throw new Error(
      "demo fixture broken: Escrow.fromHistory restored a deadline a bare history cannot carry",
    );
  }
  lines.push(
    "",
    "Event-sourced rebuild (Escrow.fromHistory on the main escrow history):",
    `  main escrow ${escrow.id}: Escrow.fromHistory(id, history) -> rebuilt escrow in state ${historyRebuiltEscrow.state} with ${historyRebuiltEscrow.history.length} history entries (history alone — no snapshot envelope)`,
    `  rebuilt history matches the original verbatim: every entry identical (seq chain 1 -> ${historyRebuiltEscrow.history.length} continuous, hash chain re-verified on rebuild)`,
    `  deadline NOT restored: main escrow deadline is ${DEMO_REBUILT_DEADLINE}, rebuilt escrow deadline is ${String(historyRebuiltDeadline)} — a bare history carries no deadline (nor the consumed idempotency keys); use fromJSON when those must survive`,
    `  original escrow after the rebuild: still ${escrow.state} with its deadline ${escrow.getDeadline()} intact (the rebuild reads the history and dispatches nothing)`,
  );

  // --- Snapshot round-trip: toJSON / fromJSON (closing) ---
  // The rebuild segment above shows what a bare history can
  // restore — and what it cannot: the deadline (and the
  // consumed idempotency-key set) live only in the snapshot
  // envelope, never in the history. This closing segment
  // shows that envelope itself: the persistence channel an
  // escrow actually lands in when a service stores it in a
  // document store and rehydrates it after a restart.
  // `toJSON()` exports v + id + state + history, plus the
  // deadline when one is set (the main escrow carries
  // DEMO_REBUILT_DEADLINE from the rebuild segment); the
  // consumed idempotency keys and the RBAC policy are
  // exported only when non-empty, and the main escrow has
  // neither, so neither field appears. The snapshot is
  // serialized with JSON.stringify (its UTF-8 byte count is
  // printed — the size a store would keep), parsed back
  // from plain JSON, and restored with `Escrow.fromJSON()`,
  // which re-validates the envelope strictly and
  // re-verifies the hash chain on the way in.
  // Hand-pinned expectations — written out in the fixture
  // comment above from src/stateMachine.ts, never derived
  // by calling toJSON itself (test/serialization.test.ts
  // and test/deadline.test.ts pin the same round-trip
  // independently):
  //   snapshot v 1, RELEASED, 4 entries, deadline
  //   DEMO_REBUILT_DEADLINE, serialized to exactly
  //   DEMO_SNAPSHOT_SERIALIZED_BYTES bytes; restored
  //   escrow RELEASED with the same 4 entries verbatim
  //   and the deadline restored
  // The round-trip is asserted HERE, outside the printing
  // — a mismatch throws instead of printing a false
  // verdict. Pure: toJSON only reads the escrow and
  // fromJSON only builds a new one; no dispatch, no
  // network, no randomness, no wall clock.
  const escrowSnapshot = escrow.toJSON();
  const snapshotJson = JSON.stringify(escrowSnapshot);
  const snapshotJsonBytes = Buffer.byteLength(snapshotJson, "utf8");
  const snapshotRestoredEscrow = Escrow.fromJSON(
    JSON.parse(snapshotJson) as unknown,
  );
  const snapshotRestoredDeadline = snapshotRestoredEscrow.getDeadline();
  if (
    escrowSnapshot.v !== 1 ||
    escrowSnapshot.id !== escrow.id ||
    escrowSnapshot.state !== "RELEASED" ||
    escrowSnapshot.history.length !== 4 ||
    escrowSnapshot.deadline !== DEMO_REBUILT_DEADLINE ||
    escrowSnapshot.idempotencyKeys !== undefined ||
    escrowSnapshot.rolePolicy !== undefined
  ) {
    throw new Error(
      "demo fixture broken: toJSON snapshot envelope does not have the pinned shape (v 1, main id, RELEASED, 4 entries, fixed deadline, no key/policy fields)",
    );
  }
  if (snapshotJsonBytes !== DEMO_SNAPSHOT_SERIALIZED_BYTES) {
    throw new Error(
      `demo fixture broken: serialized snapshot is ${snapshotJsonBytes} bytes, expected ${DEMO_SNAPSHOT_SERIALIZED_BYTES}`,
    );
  }
  if (
    snapshotRestoredEscrow.id !== escrow.id ||
    snapshotRestoredEscrow.state !== "RELEASED" ||
    snapshotRestoredEscrow.state !== escrow.state
  ) {
    throw new Error(
      "demo fixture broken: Escrow.fromJSON restored escrow does not land in the main escrow state",
    );
  }
  if (
    snapshotRestoredEscrow.history.length !== escrow.history.length ||
    JSON.stringify(snapshotRestoredEscrow.history) !==
      JSON.stringify([...escrow.history])
  ) {
    throw new Error(
      "demo fixture broken: Escrow.fromJSON restored history differs from the original history",
    );
  }
  if (
    snapshotRestoredDeadline !== DEMO_REBUILT_DEADLINE ||
    escrow.getDeadline() !== DEMO_REBUILT_DEADLINE ||
    escrow.state !== "RELEASED" ||
    escrow.history.length !== 4
  ) {
    throw new Error(
      "demo fixture broken: Escrow.fromJSON did not restore the deadline the snapshot envelope carries, or the original escrow changed",
    );
  }
  lines.push(
    "",
    "Snapshot round-trip (Escrow.toJSON / Escrow.fromJSON on the main escrow):",
    `  main escrow ${escrow.id}: toJSON() -> snapshot v ${escrowSnapshot.v} (id + state + ${escrowSnapshot.history.length} history entries + deadline) serialized to ${snapshotJsonBytes} bytes — the persistence envelope a document store keeps`,
    `  Escrow.fromJSON(parsed snapshot) -> restored escrow in state ${snapshotRestoredEscrow.state} with ${snapshotRestoredEscrow.history.length} history entries — state and every entry identical to the original verbatim`,
    `  deadline restored: main escrow deadline is ${DEMO_REBUILT_DEADLINE}, restored escrow deadline is ${String(snapshotRestoredDeadline)} — the envelope carries the deadline (and the consumed idempotency keys) that a bare history cannot`,
    `  original escrow after the round-trip: still ${escrow.state} with its deadline ${escrow.getDeadline()} intact (the round-trip reads the escrow and dispatches nothing)`,
  );

  // --- Machine-readable transition table: transitionTableJson (closing) ---
  // The state-diagram segment above shows the transition
  // table rendered for humans (the Mermaid block the README
  // embeds), but a caller doing static validation or code
  // generation never parses a diagram — it consumes the same
  // table as data. That is `transitionTableJson()`: canonical
  // JSON (declaration order, 2-space indent, exactly one
  // trailing newline), byte-identical to the committed
  // snapshot test/__snapshots__/transitionTable.snapshot.json
  // that test/transitionSnapshot.test.ts guards against
  // drift. The demo prints the serialized byte count and the
  // edge total, not the 1,160-byte text itself.
  // Hand-pinned expectations — written out here from
  // TRANSITIONS in src/stateMachine.ts, never derived by
  // calling transitionTableJson itself (the transition
  // snapshot tests and bench's transitionTableJson fixture
  // pin the same shape independently):
  //   14 edges, 1,160 serialized bytes, first edge
  //   CREATED --FUND--> FUNDED, last edge
  //   DISPUTED --ARBITRATE_REFUND--> REFUNDED, every parsed
  //   edge carrying exactly the keys from/event/to in order
  // The parse-back is asserted HERE, outside the printing:
  // the triples parsed from the JSON must equal the
  // transitionTable() triples as a set and edge for edge in
  // order — a serialization whose shape broke would fail
  // the demo itself, not just a test. The segment is pure:
  // no escrow instance, no dispatch, no network, no
  // randomness, no wall clock.
  const transitionTableJsonText = transitionTableJson();
  const transitionTableJsonBytes = Buffer.byteLength(
    transitionTableJsonText,
    "utf8",
  );
  const transitionTableEdges = JSON.parse(
    transitionTableJsonText,
  ) as TransitionEdge[];
  const transitionTableEdgeCount = transitionTableEdges.length;
  const transitionTableExpected = transitionTable();
  const transitionTableTriple = (edge: TransitionEdge): string =>
    `${edge.from}:${edge.event}:${edge.to}`;
  const parsedTripleSet = new Set(
    transitionTableEdges.map(transitionTableTriple),
  );
  const expectedTripleSet = new Set(
    transitionTableExpected.map(transitionTableTriple),
  );
  if (
    transitionTableJsonBytes !== DEMO_TRANSITION_TABLE_JSON_BYTES ||
    !transitionTableJsonText.endsWith("]\n") ||
    transitionTableJsonText.endsWith("]\n\n") ||
    transitionTableEdgeCount !== DEMO_TRANSITION_TABLE_EDGE_COUNT ||
    transitionTableEdgeCount !== transitionTableExpected.length ||
    parsedTripleSet.size !== transitionTableEdgeCount ||
    parsedTripleSet.size !== expectedTripleSet.size ||
    [...expectedTripleSet].some((triple) => !parsedTripleSet.has(triple)) ||
    JSON.stringify(transitionTableEdges) !==
      JSON.stringify(transitionTableExpected) ||
    transitionTableEdges.some(
      (edge) =>
        JSON.stringify(Object.keys(edge)) !==
        JSON.stringify(["from", "event", "to"]),
    ) ||
    transitionTableTriple(transitionTableEdges[0]) !==
      "CREATED:FUND:FUNDED" ||
    transitionTableTriple(transitionTableEdges.at(-1)!) !==
      "DISPUTED:ARBITRATE_REFUND:REFUNDED"
  ) {
    throw new Error(
      "demo fixture broken: transitionTableJson() output does not have the pinned shape (1,160 bytes, 14 edges matching transitionTable() edge for edge, pinned key order, first CREATED --FUND--> FUNDED, last DISPUTED --ARBITRATE_REFUND--> REFUNDED, exactly one trailing newline)",
    );
  }
  lines.push(
    "",
    "Machine-readable transition table (transitionTableJson from the transition table):",
    `  transitionTableJson(): ${transitionTableJsonBytes} bytes, ${transitionTableEdgeCount} edges (canonical JSON — the machine-readable form of the same table stateDiagram() renders for humans, byte-identical to the committed transition-table snapshot)`,
    `  parsed back: ${transitionTableEdges.length} edges, every (from, event, to) triple matches transitionTable() edge for edge`,
    `  first edge: ${transitionTableEdges[0].from} --${transitionTableEdges[0].event}--> ${transitionTableEdges[0].to}`,
    `  last edge: ${transitionTableEdges.at(-1)!.from} --${transitionTableEdges.at(-1)!.event}--> ${transitionTableEdges.at(-1)!.to}`,
  );

  // --- Money guard: assertNonNegativeMoney (closing) ---
  // Every amount entry point in the segments above — a
  // FUND dispatch, a maxDeposit cap, a settlement input —
  // funnels through one shared boundary check:
  // `assertNonNegativeMoney(name, value)` requires a
  // finite, non-negative number and throws
  // `${name} must be a finite non-negative number` on
  // anything else, so illegal money fails fast at the
  // boundary instead of silently poisoning downstream
  // accounting. The demo runs the guard directly, under
  // the name "amount", over the fixed legal corpus the
  // bench fixture also pins (0, a cent, the golden
  // deposit, a large amount with cents) and over a fixed
  // illegal pair (a negative amount and NaN).
  // Hand-pinned expectations — written from the
  // documented semantics in src/stateMachine.ts and
  // cross-checked against test/inputValidation.test.ts,
  // never derived by calling the guard itself: the legal
  // corpus passes without throwing, and each illegal
  // value throws exactly DEMO_MONEY_GUARD_ERROR. Both
  // sides are asserted HERE, outside the printing — a
  // guard that started accepting a negative amount, or
  // whose error wording drifted, would fail the demo
  // itself, not just a test. The segment is pure: no
  // escrow instance, no dispatch, no network, no
  // randomness, no wall clock.
  const moneyGuardLegalAmounts = DEMO_MONEY_GUARD_LEGAL_AMOUNTS;
  for (const value of moneyGuardLegalAmounts) {
    assertNonNegativeMoney("amount", value);
  }
  const moneyGuardRejections: Array<{ value: number; message: string }> = [];
  for (const value of DEMO_MONEY_GUARD_ILLEGAL_AMOUNTS) {
    let message: string | undefined;
    try {
      assertNonNegativeMoney("amount", value);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    if (message !== DEMO_MONEY_GUARD_ERROR) {
      throw new Error(
        "demo fixture broken: assertNonNegativeMoney did not reject an illegal amount with the pinned error (amount must be a finite non-negative number)",
      );
    }
    moneyGuardRejections.push({ value, message });
  }
  lines.push(
    "",
    "Money guard (assertNonNegativeMoney on the shared amount boundary):",
    `  accepted: ${moneyGuardLegalAmounts.join(", ")} — every legal amount passes without throwing (zero, a cent, the golden deposit, a large amount with cents)`,
    ...moneyGuardRejections.map(
      (rejection) =>
        `  rejected: ${String(rejection.value)} -> "${rejection.message}"`,
    ),
  );

  // --- Subscription notifications: Escrow.subscribe (closing) ---
  // dispatch() appends to the audit history and then fans out to
  // subscribers: the seam a reconciliation or notification side
  // wires into. A branch escrow carries one fixed collecting
  // listener, subscribed before any dispatch, so it receives
  // (event, from, to, entry) after each of the first two fixed
  // dispatches, in order. The listener is then unsubscribed —
  // twice, because unsubscribe is idempotent — and a third
  // fixed dispatch still moves the escrow while producing zero
  // new notifications. Hand-pinned expectations (see the fixture
  // comment above), asserted HERE, outside the printing: the
  // two notifications match the escrow's first two audit
  // entries seq for seq, the count stays 2 after the third
  // dispatch, and listenerCount reads 0 — a fan-out that
  // dropped, reordered, or kept firing after unsubscribe
  // would fail the demo itself, not just a test. Zero
  // network, zero randomness, fixed timestamps throughout.
  const subscribeEscrow = new Escrow(DEMO_SUBSCRIBE_ESCROW_ID);
  const subscribeNotifications: Array<{
    event: EscrowEvent;
    from: EscrowState;
    to: EscrowState;
    seq: number;
  }> = [];
  const unsubscribeSubscribe = subscribeEscrow.subscribe(
    (event, from, to, entry) => {
      subscribeNotifications.push({ event, from, to, seq: entry.seq });
    },
  );
  subscribeEscrow.dispatch("FUND", "Deposit locked (wire received)", 10630, {
    actor: "sponsor",
    at: DEMO_SUBSCRIBE_FUND_AT,
  });
  subscribeEscrow.dispatch(
    "SUBMIT_MILESTONE",
    "Deliverable URLs + IPFS metadata hash",
    undefined,
    { actor: "creator", at: DEMO_SUBSCRIBE_SUBMIT_AT },
  );
  const subscribeMatchesHistory =
    subscribeNotifications.length === 2 &&
    subscribeNotifications.every((n) => {
      const entry = subscribeEscrow.history[n.seq - 1];
      return (
        entry !== undefined &&
        entry.seq === n.seq &&
        entry.event === n.event &&
        entry.from === n.from &&
        entry.to === n.to
      );
    });
  unsubscribeSubscribe();
  unsubscribeSubscribe(); // idempotent: second call is a no-op
  const subscribeFrom = subscribeEscrow.state;
  const subscribeTo = subscribeEscrow.dispatch(
    "VERIFY_PASS",
    "KPIs validated by oracle",
    undefined,
    {
      actor: "oracle",
      at: DEMO_SUBSCRIBE_VERIFY_AT,
      evidence: DEMO_SUBSCRIBE_VERIFY_EVIDENCE,
    },
  );
  const subscribeCountAfterUnsubscribe = subscribeNotifications.length;
  if (
    !subscribeMatchesHistory ||
    subscribeNotifications[0]?.event !== "FUND" ||
    subscribeNotifications[0]?.from !== "CREATED" ||
    subscribeNotifications[0]?.to !== "FUNDED" ||
    subscribeNotifications[0]?.seq !== 1 ||
    subscribeNotifications[1]?.event !== "SUBMIT_MILESTONE" ||
    subscribeNotifications[1]?.from !== "FUNDED" ||
    subscribeNotifications[1]?.to !== "MILESTONE_SUBMITTED" ||
    subscribeNotifications[1]?.seq !== 2 ||
    subscribeCountAfterUnsubscribe !== 2 ||
    subscribeEscrow.listenerCount !== 0 ||
    subscribeEscrow.state !== "VERIFIED" ||
    subscribeEscrow.history.length !== 3
  ) {
    throw new Error(
      "demo fixture broken: Escrow.subscribe notifications do not match the pinned shape (FUND seq 1 + SUBMIT_MILESTONE seq 2 matching history, zero new notifications after idempotent unsubscribe, escrow VERIFIED with 3 entries)",
    );
  }
  lines.push(
    "",
    "Subscription notifications (Escrow.subscribe on a branch escrow):",
    `  escrow ${subscribeEscrow.id}: subscribed 1 collecting listener (notified after each audit append, in subscription order)`,
    ...subscribeNotifications.map(
      (n, i) =>
        `  notification ${i + 1}: ${n.event} ${n.from} -> ${n.to} (entry seq ${n.seq})`,
    ),
    `  notifications match history: ${subscribeMatchesHistory} (each (event, from, to) equals the history entry with the same seq)`,
    `  unsubscribed: listenerCount ${subscribeEscrow.listenerCount} (second unsubscribe call is a no-op — idempotent)`,
    `  ${"VERIFY_PASS".padEnd(18)} ${subscribeFrom.padEnd(19)} -> ${subscribeTo}  (oracle)`,
    `  listener received after unsubscribe: ${subscribeCountAfterUnsubscribe} notification(s) (unchanged — VERIFY_PASS produced no new notification)`,
  );

  // --- Deadline clearing: clearDeadline (closing) ---
  // A deadline is advisory only, and clearDeadline() is the
  // sole entry point that removes one — the shape a deadline
  // cancelled by an extension agreement takes. A funded
  // escrow carries a fixed deadline already past at the
  // fixed check instant, so it reads overdue; clearing
  // removes the deadline, getDeadline() reads back
  // undefined, and the same judgement at the same instant
  // turns false. A second funded escrow never carried a
  // deadline, so the same call is a harmless no-op there.
  // Hand-pinned expectations (see the fixture comment
  // above), asserted HERE, outside the printing: the
  // before/after deadline reads and overdue verdicts match
  // the pinned values exactly, and both escrows stay FUNDED
  // with their single FUND entry — clearing dispatches
  // nothing, so a clear that moved state, appended history,
  // or left the deadline behind would fail the demo itself,
  // not just a test. Zero network, zero randomness, fixed
  // timestamps throughout.
  const deadlineClearEscrow = new Escrow(DEMO_CLEAR_DEADLINE_ESCROW_ID);
  deadlineClearEscrow.dispatch(
    "FUND",
    "Deposit locked (wire received)",
    10630,
    { actor: "sponsor", at: DEMO_CLEAR_DEADLINE_FUND_AT },
  );
  deadlineClearEscrow.setDeadline(DEMO_CLEAR_DEADLINE_DEADLINE);
  const deadlineClearDeadlineBefore = deadlineClearEscrow.getDeadline();
  const deadlineClearOverdueBefore = isOverdue(
    deadlineClearEscrow,
    new Date(DEMO_CLEAR_DEADLINE_CHECK_AT),
  );
  deadlineClearEscrow.clearDeadline();
  const deadlineClearDeadlineAfter = deadlineClearEscrow.getDeadline();
  const deadlineClearOverdueAfter = isOverdue(
    deadlineClearEscrow,
    new Date(DEMO_CLEAR_DEADLINE_CHECK_AT),
  );
  const deadlineClearNoDeadlineEscrow = new Escrow(
    DEMO_CLEAR_DEADLINE_NO_DEADLINE_ESCROW_ID,
  );
  deadlineClearNoDeadlineEscrow.dispatch(
    "FUND",
    "Deposit locked (wire received)",
    10630,
    { actor: "sponsor", at: DEMO_CLEAR_DEADLINE_NO_DEADLINE_FUND_AT },
  );
  deadlineClearNoDeadlineEscrow.clearDeadline();
  const deadlineClearNoDeadlineOverdue = isOverdue(
    deadlineClearNoDeadlineEscrow,
    new Date(DEMO_CLEAR_DEADLINE_CHECK_AT),
  );
  if (
    deadlineClearDeadlineBefore !== DEMO_CLEAR_DEADLINE_DEADLINE ||
    deadlineClearOverdueBefore !== true ||
    deadlineClearDeadlineAfter !== undefined ||
    deadlineClearOverdueAfter !== false ||
    deadlineClearEscrow.state !== "FUNDED" ||
    deadlineClearEscrow.history.length !== 1 ||
    deadlineClearNoDeadlineEscrow.getDeadline() !== undefined ||
    deadlineClearNoDeadlineOverdue !== false ||
    deadlineClearNoDeadlineEscrow.state !== "FUNDED" ||
    deadlineClearNoDeadlineEscrow.history.length !== 1
  ) {
    throw new Error(
      "demo fixture broken: clearDeadline does not match the pinned shape (deadline read back, overdue true before and false after at the fixed check instant, no-deadline clear a no-op, both escrows FUNDED with 1 entry)",
    );
  }
  lines.push(
    "",
    "Deadline clearing (clearDeadline on funded escrows):",
    `  escrow ${deadlineClearEscrow.id}: state ${deadlineClearEscrow.state}, deadline ${deadlineClearDeadlineBefore} — at ${DEMO_CLEAR_DEADLINE_CHECK_AT} isOverdue -> ${deadlineClearOverdueBefore} (past the deadline, non-terminal)`,
    `  after clearDeadline(): getDeadline() -> ${String(deadlineClearDeadlineAfter)}, isOverdue at ${DEMO_CLEAR_DEADLINE_CHECK_AT} -> ${deadlineClearOverdueAfter} (deadline removed — clearing dispatches nothing, escrow still ${deadlineClearEscrow.state})`,
    `  escrow ${deadlineClearNoDeadlineEscrow.id} (no deadline set): clearDeadline() is a no-op — getDeadline() -> ${String(deadlineClearNoDeadlineEscrow.getDeadline())}, isOverdue at ${DEMO_CLEAR_DEADLINE_CHECK_AT} -> ${deadlineClearNoDeadlineOverdue}, state still ${deadlineClearNoDeadlineEscrow.state} (${deadlineClearNoDeadlineEscrow.history.length} history entry)`,
  );

  // --- Quorum approval log: approvalLog (final closing) ---
  // The dispute branch above printed only the quorum's
  // counting views (approvalCount / hasQuorum); the audit
  // face of the same quorum is its approvalLog(): who
  // approved and when, in record order. The dispute
  // quorum's trail must be exactly the two fixed votes —
  // the pre-restart vote kept its original timestamp
  // through the snapshot -> JSON -> restoreQuorum
  // round-trip, and the post-restore vote follows it.
  // A separate expiring quorum (same signer ids and
  // threshold, fixed maxApprovalAgeMs window) then shows
  // the expiry contrast on a fixed clock: two votes land
  // inside the window (count 2, quorum reached); the
  // clock advances past the window for the first vote
  // only, so that vote stops counting (count 1, quorum
  // lost, approvals() exactly [arb-2]) — yet approvalLog()
  // still returns both entries with their original
  // timestamps, because expiry never deletes the audit
  // trail (only revoke() removes a signer's entries).
  // Hand-pinned expectations (see the fixture comment
  // above), asserted HERE, outside the printing: a trail
  // that dropped, reordered, or re-stamped a vote, or an
  // expiry that deleted the expired entry, would fail
  // the demo itself, not just a test. Zero network, zero
  // randomness; the expiring quorum's clock is set to
  // fixed instants only.
  const approvalLogEntries = disputeQuorum.approvalLog();
  let approvalLogNowMs = Date.parse(DEMO_APPROVAL_LOG_FIRST_AT);
  const approvalLogExpiryQuorum = createQuorum({
    threshold: DEMO_QUORUM_THRESHOLD,
    signers: [...DEMO_QUORUM_SIGNERS],
    now: () => approvalLogNowMs,
    maxApprovalAgeMs: DEMO_APPROVAL_LOG_WINDOW_MS,
  });
  approvalLogExpiryQuorum.approve(DEMO_QUORUM_SIGNERS[0]);
  approvalLogNowMs = Date.parse(DEMO_APPROVAL_LOG_SECOND_AT);
  approvalLogExpiryQuorum.approve(DEMO_QUORUM_SIGNERS[1]);
  const approvalLogExpiryCountBefore = approvalLogExpiryQuorum.approvalCount();
  const approvalLogExpiryHasQuorumBefore =
    approvalLogExpiryQuorum.hasQuorum();
  approvalLogNowMs = Date.parse(DEMO_APPROVAL_LOG_CHECK_AT);
  const approvalLogExpiryCountAfter = approvalLogExpiryQuorum.approvalCount();
  const approvalLogExpiryHasQuorumAfter = approvalLogExpiryQuorum.hasQuorum();
  const approvalLogExpiryLogAfter = approvalLogExpiryQuorum.approvalLog();
  const sameApprovalEntries = (
    actual: ReadonlyArray<ApprovalLogEntry>,
    expected: readonly ApprovalLogEntry[],
  ): boolean =>
    actual.length === expected.length &&
    actual.every(
      (e, i) => e.signerId === expected[i].signerId && e.at === expected[i].at,
    );
  if (
    !sameApprovalEntries(approvalLogEntries, DEMO_DISPUTE_APPROVAL_LOG_ENTRIES) ||
    approvalLogExpiryCountBefore !== 2 ||
    approvalLogExpiryHasQuorumBefore !== true ||
    approvalLogExpiryCountAfter !== 1 ||
    approvalLogExpiryHasQuorumAfter !== false ||
    approvalLogExpiryQuorum.approvals().length !== 1 ||
    approvalLogExpiryQuorum.approvals()[0] !== DEMO_QUORUM_SIGNERS[1] ||
    !sameApprovalEntries(approvalLogExpiryLogAfter, DEMO_APPROVAL_LOG_ENTRIES)
  ) {
    throw new Error(
      "demo fixture broken: approvalLog does not match the pinned shape (dispute trail exactly the two fixed votes in record order, expiring quorum 2 counted / quorum before and 1 counted / no quorum after the fixed advance, expired entry retained in the trail)",
    );
  }
  lines.push(
    "",
    "Quorum approval log (approvalLog audit trail):",
    `  dispute quorum (${DEMO_QUORUM_THRESHOLD}-of-${DEMO_QUORUM_SIGNERS.length}): approvalLog() — the full audit trail in record order, one line per vote`,
    ...approvalLogEntries.map(
      (e, i) => `  approval ${i + 1}: ${e.signerId} at ${e.at}`,
    ),
    `  trail survives the restart: the pre-restart vote (${DEMO_QUORUM_SIGNERS[0]}) kept its original timestamp ${DEMO_QUORUM_APPROVAL_ATS[0]} through the snapshot round-trip`,
    `  expiring quorum (maxApprovalAgeMs ${DEMO_APPROVAL_LOG_WINDOW_MS}): approvals at ${DEMO_APPROVAL_LOG_FIRST_AT} and ${DEMO_APPROVAL_LOG_SECOND_AT} — approvalCount ${approvalLogExpiryCountBefore}, hasQuorum: ${approvalLogExpiryHasQuorumBefore}`,
    `  at ${DEMO_APPROVAL_LOG_CHECK_AT} the first vote is ${Date.parse(DEMO_APPROVAL_LOG_CHECK_AT) - Date.parse(DEMO_APPROVAL_LOG_FIRST_AT)} ms old — past the window: approvalCount ${approvalLogExpiryCountAfter}, hasQuorum: ${approvalLogExpiryHasQuorumAfter}`,
    `  approvalLog() after expiry: ${approvalLogExpiryLogAfter.length} entries retained (${approvalLogExpiryLogAfter.map((e) => e.signerId).join(", ")}) — expiry never deletes the audit trail; only revoke() removes a signer's entries`,
  );

  // --- Single-target delivery: deliverSettlementWebhook (final closing) ---
  // Every delivery shown so far went through the fan-out
  // wrapper; the single-endpoint entry point underneath it
  // — the one most integrators call first — never ran on
  // its own, and no demo delivery ever took the retry path
  // (the fan-out fake answers 200 immediately). Here the
  // main escrow's signed webhook (built in the webhook
  // segment above) is delivered alone to one fixed
  // endpoint through a scripted fake fetch installed on
  // `globalThis` for this segment only (the library calls
  // the global `fetch`; the original is restored in the
  // `finally`): attempt 1 answers 500 — a retryable 5xx —
  // and attempt 2 answers 200, so the delivery resolves
  // {status: 200, attempts: 2}. backoffMs 0 keeps the one
  // retry wait at zero. Hand-pinned expectations (see the
  // fixture comment above), asserted HERE, outside the
  // printing: both captured requests are POSTs to the
  // pinned URL carrying byte-identical bodies equal to
  // the canonical body of the demo webhook, and the
  // captured X-Signature equals the webhook's signature
  // and verifies over the captured body under the demo
  // secret — a delivery that dropped the retry, altered
  // the body between attempts, or sent an unverifiable
  // signature would fail the demo itself. Zero network,
  // zero real waiting, no wall clock.
  const singleDeliveryCalls: Array<{
    url: string;
    method: string;
    body: string;
    signature: string;
  }> = [];
  const singleDeliveryFetch: typeof fetch = async (input, init) => {
    singleDeliveryCalls.push({
      url: String(input),
      method: String(init?.method ?? ""),
      body: String(init?.body ?? ""),
      signature: String(
        new Headers(init?.headers).get("x-signature") ?? "",
      ),
    });
    const status =
      DEMO_SINGLE_DELIVERY_SCRIPTED_STATUSES[
        Math.min(
          singleDeliveryCalls.length - 1,
          DEMO_SINGLE_DELIVERY_SCRIPTED_STATUSES.length - 1,
        )
      ];
    return new Response(status === 200 ? "{}" : "boom", {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  const originalFetchForSingle = globalThis.fetch;
  let singleDeliveryResult: WebhookDeliveryResult;
  globalThis.fetch = singleDeliveryFetch;
  try {
    singleDeliveryResult = await deliverSettlementWebhook(
      DEMO_SINGLE_DELIVERY_URL,
      webhook,
      { backoffMs: 0 },
    );
  } finally {
    globalThis.fetch = originalFetchForSingle;
  }
  const singleDeliveryFinalCall =
    singleDeliveryCalls[singleDeliveryCalls.length - 1];
  const singleDeliverySignatureVerified =
    singleDeliveryFinalCall !== undefined &&
    verifySettlementWebhook(
      singleDeliveryFinalCall.body,
      singleDeliveryFinalCall.signature,
      DEMO_WEBHOOK_SECRET,
    );
  if (
    singleDeliveryResult.status !== 200 ||
    singleDeliveryResult.attempts !== 2 ||
    singleDeliveryCalls.length !== 2 ||
    singleDeliveryCalls.some(
      (call) =>
        call.url !== DEMO_SINGLE_DELIVERY_URL ||
        call.method !== "POST" ||
        call.body !== JSON.stringify(webhook.payload) ||
        call.signature !== webhook.signature,
    ) ||
    !singleDeliverySignatureVerified
  ) {
    throw new Error(
      "demo fixture broken: deliverSettlementWebhook single-target delivery does not match the pinned shape (scripted 500 then 200, result {status: 200, attempts: 2}, two POSTs with byte-identical signed bodies, captured X-Signature verifiable under the demo secret)",
    );
  }
  lines.push(
    "",
    "Single-target webhook delivery (deliverSettlementWebhook via scripted fake fetch, zero network):",
    `  endpoint: ${DEMO_SINGLE_DELIVERY_URL} — the main escrow's signed webhook (eventId ${webhook.payload.eventId}) delivered alone, the single-endpoint entry point under the fan-out wrapper`,
    `  attempt 1: scripted 500 (retryable 5xx) — attempt 2: scripted 200; result: status ${singleDeliveryResult.status}, attempts ${singleDeliveryResult.attempts} (succeeded after exactly one retry, backoffMs 0 — no real waiting)`,
    `  wire check: ${singleDeliveryCalls.length} captured POSTs, bodies byte-identical across attempts and equal to the signed payload body; the X-Signature the endpoint received verifies over the captured body: verifySettlementWebhook: ${singleDeliverySignatureVerified ? "ok" : "FAILED"}`,
  );

  return {
    escrow,
    report,
    historyChainVerified,
    tamperedChainVerified,
    tamperedFundAmount,
    webhook,
    webhookVerified,
    webhookDedupe,
    retryAfterParsed,
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
    fanoutResult,
    fanoutCalls,
    watchdogEscrows,
    staleSelected,
    expiredSelected,
    staleActionResults,
    deadlineEscrows,
    deadlineExpiredSelected,
    deadlineStaleSelected,
    deadlineExpireResults,
    allowedEventsByState,
    mainEscrowAllowedEvents,
    tracedDepositAmount,
    noFundDepositError,
    releaseSettlement,
    historyNdjson,
    historyNdjsonLineCount,
    historyNdjsonFirstLine,
    historyNdjsonRoundTripped,
    overdueCheckEscrow,
    overdueChecks,
    stateDiagramText,
    stateDiagramEdgeCount,
    parsedHistoryEntries,
    parsedHistoryTamperError,
    historyRebuiltEscrow,
    historyRebuiltDeadline,
    escrowSnapshot,
    snapshotJsonBytes,
    snapshotRestoredEscrow,
    snapshotRestoredDeadline,
    transitionTableJsonText,
    transitionTableJsonBytes,
    transitionTableEdges,
    transitionTableEdgeCount,
    moneyGuardLegalAmounts,
    moneyGuardRejections,
    subscribeEscrow,
    subscribeNotifications,
    subscribeMatchesHistory,
    subscribeCountAfterUnsubscribe,
    deadlineClearEscrow,
    deadlineClearDeadlineBefore,
    deadlineClearOverdueBefore,
    deadlineClearDeadlineAfter,
    deadlineClearOverdueAfter,
    deadlineClearNoDeadlineEscrow,
    deadlineClearNoDeadlineOverdue,
    approvalLogEntries,
    approvalLogExpiryQuorum,
    approvalLogExpiryCountBefore,
    approvalLogExpiryHasQuorumBefore,
    approvalLogExpiryCountAfter,
    approvalLogExpiryHasQuorumAfter,
    approvalLogExpiryLogAfter,
    singleDeliveryResult,
    singleDeliveryCalls,
    singleDeliverySignatureVerified,
    lines,
  };
}

async function main(): Promise<void> {
  console.log((await runDemo()).lines.join("\n"));
}

// Run only when executed directly (`node dist/src/demo.js`), not when
// imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
