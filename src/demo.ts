/**
 * Demo: drive one escrow through the full happy path
 * CREATED -> FUNDED -> MILESTONE_SUBMITTED -> VERIFIED -> RELEASED,
 * print the append-only audit history plus the final settlement report,
 * verify that history's hash chain with `verifyHistoryChain` — the
 * intact chain passes, and a detached copy whose FUND entry's amount
 * is altered fails, while the escrow's own history stays untouched —
 * then build the signed settlement webhook for the released escrow and
 * verify it the way a receiver would. That same webhook is then
 * re-verified under the opt-in freshness window (`maxAgeMs` /
 * `maxFutureSkewMs` on an injected `now`): inside the window and
 * exactly at its inclusive boundary it passes, past the window the
 * still-valid signature is refused fail-closed, and a payload whose
 * `at` runs ahead of the receiver's clock beyond the skew bound is
 * refused too. That same webhook is then re-verified under secret
 * rotation (`{ secrets: [newSecret, oldSecret] }`): the main
 * webhook — signed with the demo secret, which plays the old
 * secret — verifies, a twin signed with the rotated-in secret over
 * the identical payload (same fixed `now` / `eventId`) verifies
 * too, a twin signed with an unrelated secret is refused (`false`,
 * no throw — all-mismatch fails closed), and an empty `secrets`
 * array throws the pinned configuration error instead of silently
 * passing. The receiver side then runs
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
 * two watchdog axes pick disjoint subsets of this batch too. The
 * executor pins the fixed screening `now` as each EXPIRE entry's `at`
 * (no wall clock enters the audit history); the demo prints each
 * result's entry citation (seq/from/to/at, all pinned to the fixed
 * now), so its printed output stays byte-identical across runs. A stale-patrol section
 * then screens five more escrows with `staleEscrows` alone under a
 * patrol budget map (CREATED / FUNDED / RELEASED at 7 days, VERIFIED
 * unmapped): only the long-stuck FUNDED escrow is selected — the
 * exactly-at-budget, terminal, no-history and unmapped-state escrows
 * are each excluded for a different pinned reason — and a
 * notify-only `actOnStaleEscrows` action records it without
 * dispatching anything; an unknown state name in the map is shown
 * failing fast with the exact `invalid maxAgeByState` error. The
 * demo then prints an
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
 * The demo then shows a staged top-up segment: a separate escrow
 * (DEMO-ESC-025) is funded in two instalments — the golden 10,630
 * first, then a 2,000 top-up on the FUNDED self-loop the state
 * machine has carried since the top-up feature landed — so
 * `depositAmountFromHistory` traces 12,630 from the two FUND audit
 * entries alone, and the escrow then walks the same happy path to
 * RELEASED and is settled at 500 bps: pro fee 631.50, net
 * 11,998.50, and the released report's four party nets (sponsor
 * −12,630 / creator +11,998.50 / platform +631.50 / referrer 0)
 * conserving the deposit exactly. Staged funding is the payment
 * reality the single-FUND golden path never shows; the deposit
 * summation the audit trail corroborates is asserted outside the
 * printing, hand-pinned, and the main escrow's chain is untouched.
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
 * The demo then shows a README diagram sync check
 * segment: `readmeDiagramInSync()` (imported directly
 * from `src/diagram.ts`, as the benchmark does — it is not
 * re-exported from the package entry) reads this repo's
 * README and reports whether it embeds the exact
 * generated block, and the demo prints that verdict
 * (hand-pinned to `true` and cross-checked against the
 * diagram tests) — the sync conclusion itself, shown
 * instead of only asserted by the test suite; on drift
 * the segment's failure message says how to repair it
 * (regenerate with `npm run diagram` and paste the
 * generated block into README.md).
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
 * The demo then shows a deposit-cap segment: a separate
 * risk control (`EscrowOptions.maxDeposit`) — a branch
 * escrow capped at 10000 accepts FUND 9000, rejects an
 * over-cap FUND 2000 with the exact `deposit cap exceeded`
 * wording and zero history residue, then accepts a
 * boundary top-up of 1000 that lands exactly on the cap
 * (cent-precision comparison); all three outcomes are
 * asserted against hand-pinned fixtures.
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
 * The demo then shows a single-target delivery
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
 * The demo then shows a 429 Retry-After delivery
 * segment: the same signed webhook is delivered again
 * with `deliverSettlementWebhook()` alone, this time to
 * a fixed endpoint whose fake `fetch` answers 429 with
 * a pinned `Retry-After: 120` header on the first
 * attempt and 200 on the second — the first demo
 * delivery that actually runs the rate-limit retry
 * path the parsing segment above only ever described
 * (its text concedes the demo never runs a live
 * delivery, and no delivery segment calls `sleep` at
 * all). The hint is parsed by `retryDelayMs` to
 * 120,000 ms and clamped by `maxRetryDelayMs: 0` to a
 * zero wait, so the retry fires immediately with no
 * real waiting, and the delivery resolves
 * `{status: 200, attempts: 2}`; the re-delivered body
 * is byte-identical to the first attempt's and its
 * `X-Signature` verifies over that body under the demo
 * secret; all sides are asserted outside the printing
 * against hand-pinned expectations.
 * The demo then shows a dedupe snapshot
 * persistence segment: a fresh `SettlementEventDedupe`
 * on a fixed clock records two fixed eventIds (each new
 * on first sight, a duplicate on immediate redelivery),
 * is exported with `exportSnapshot()` — only the
 * snapshot's version and entry count are printed, never
 * the full entries — and, after a JSON text round-trip,
 * is read back with `SettlementEventDedupe.restore()`:
 * the restored store starts its observability counters
 * at zero yet still reports both recorded ids as
 * duplicates (the restart did not reopen the dedupe
 * window) while a never-seen id counts as new; a
 * detached copy of the snapshot with its version
 * rewritten to 2 is rejected with the exact
 * invalid-snapshot error — a corrupt snapshot fails
 * loudly at startup instead of silently disabling
 * deduplication; all sides are asserted outside the
 * printing against hand-pinned expectations.
 * The demo then shows a dedupe clear segment: a fresh
 * `SettlementEventDedupe` on a fixed clock records one
 * fixed eventId (new on first sight, a duplicate on
 * immediate redelivery, its stats pinned), is reset with
 * `clear()` — the printed size and stats read all zero —
 * and the same eventId then counts as new again and is
 * re-recorded, its stats counting up from zero; the
 * explicit reset a receiver uses at key rotation, in
 * test isolation, or at a window reset, shown as the
 * deliberate opposite of the snapshot segment above
 * (there the recorded ids survive, here they are dropped
 * on purpose); all sides are asserted outside the
 * printing against hand-pinned expectations.
 * The demo then shows a dedupe capacity-eviction
 * segment: a `SettlementEventDedupe` with a tiny
 * `maxEntries: 3` on a fixed clock records four fixed
 * eventIds — the fourth distinct id forces the LRU
 * eviction of the oldest entry (counted in
 * `stats().evictions`), and the evicted id counts as a
 * new event when seen again, evicting the next oldest in
 * turn; `maxEntries: 0` is rejected at construction with
 * the exact configuration error; all sides are asserted
 * outside the printing against hand-pinned expectations.
 * The demo then shows a subscribe `onError`
 * error-routing segment: a branch escrow subscribes one
 * pinned throwing listener with a collecting `onError`,
 * and a short fixed-timestamp chain (FUND,
 * SUBMIT_MILESTONE, VERIFY_PASS) runs to VERIFIED — every
 * dispatch succeeds and the audit history stays complete
 * while `onError` receives one report per dispatch, the
 * caught error travelling with its `ListenerErrorContext`
 * (event / from / to); a probe escrow whose `onError`
 * itself throws still dispatches successfully (the broken
 * hook is swallowed too), and a non-function `onError` is
 * rejected at subscribe time with the exact
 * invalid-subscribe error; all sides are asserted outside
 * the printing against hand-pinned expectations.
 * The demo finally closes with a quorum revoke segment:
 * a fresh quorum on a fixed clock (2-of-3, same signer ids
 * as the dispute quorum) collects two approvals and
 * reaches its threshold, then one signer `revoke()`s —
 * the count drops below the threshold and `hasQuorum()`
 * turns false — and the same signer re-approves, so the
 * threshold is reached again with the re-voter last in
 * `approvals()` order (order follows each signer's latest
 * approval); revoking an unknown signer and revoking a
 * signer that never approved are both rejected with their
 * exact errors and leave the quorum untouched; all sides
 * are asserted outside the printing against hand-pinned
 * expectations.
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

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { readmeDiagramInSync } from "./diagram.js";
import {
  Escrow,
  GENESIS_PREV_HASH,
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
  parseSettlementReportCsv,
  parseSettlementReportJson,
  renderReport,
  renderReportCsv,
  renderReportJson,
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
  type FeeBreakdown,
  type FeeInputs,
  type Quorum,
  type QuorumConfig,
  type QuorumSnapshot,
  type Settlement,
  type SettlementEventDedupeSnapshot,
  type SettlementEventDedupeStats,
  type SettlementReport,
  type SettlementReportCsv,
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

/**
 * Webhook freshness-window fixtures: the opt-in replay bound on the
 * main webhook (whose `at` is {@link DEMO_WEBHOOK_AT}). A 1-hour
 * `maxAgeMs` window is evaluated at three injected instants — half
 * the window after `at` (inside), exactly the window after `at`
 * (the inclusive boundary: only `now - at > maxAgeMs` fails), and
 * twice the window after `at` (expired) — plus a 5-minute
 * `maxFutureSkewMs` bound evaluated with `now` 10 minutes before
 * `at`, so the sender's clock reads 10 minutes ahead and the skew
 * exceeds the bound. Every instant derives from the pinned `at`;
 * no wall clock enters the segment.
 */
export const DEMO_WEBHOOK_FRESHNESS_MAX_AGE_MS = 3_600_000;
export const DEMO_WEBHOOK_FRESHNESS_MAX_FUTURE_SKEW_MS = 300_000;
export const DEMO_WEBHOOK_FRESHNESS_WITHIN_NOW_MS =
  DEMO_DEDUPE_START_MS + DEMO_WEBHOOK_FRESHNESS_MAX_AGE_MS / 2;
export const DEMO_WEBHOOK_FRESHNESS_BOUNDARY_NOW_MS =
  DEMO_DEDUPE_START_MS + DEMO_WEBHOOK_FRESHNESS_MAX_AGE_MS;
export const DEMO_WEBHOOK_FRESHNESS_EXPIRED_NOW_MS =
  DEMO_DEDUPE_START_MS + 2 * DEMO_WEBHOOK_FRESHNESS_MAX_AGE_MS;
export const DEMO_WEBHOOK_FRESHNESS_FUTURE_NOW_MS =
  DEMO_DEDUPE_START_MS - 2 * DEMO_WEBHOOK_FRESHNESS_MAX_FUTURE_SKEW_MS;

/**
 * Webhook secret-rotation fixtures: the receiver-side rotation
 * window on the main webhook. {@link DEMO_WEBHOOK_SECRET} plays
 * the OLD secret — the main webhook above is signed with it — and
 * this constant is the NEW secret rotated in: a twin of the main
 * webhook is built over the identical payload (same fixed
 * `now` / `eventId`, so the body bytes are byte-identical and
 * only the signature differs) signed with the new secret. Both
 * signatures must verify under
 * `{ secrets: [newSecret, oldSecret] }` — the rotation form of
 * `verifySettlementWebhook()` (src/webhooks.ts) in which the
 * first matching candidate wins and all-mismatch fails closed.
 * A third twin signed with the unrelated secret below must NOT
 * verify under that candidate set (`false`, never a throw), and
 * an empty `secrets` array must throw exactly
 * {@link DEMO_WEBHOOK_ROTATION_EMPTY_SECRETS_ERROR} — a caller
 * configuration error, never a silent pass. All three secrets
 * carry the same placeholder status as
 * {@link DEMO_WEBHOOK_SECRET}: printed in the source, NOT real
 * credentials. Hand-pinned expectations, cross-checked against
 * test/webhookSecretRotation.test.ts, which pins the same four
 * shapes. Fixed secrets, fixed timestamps: no network, no
 * randomness, no wall clock.
 */
export const DEMO_WEBHOOK_ROTATION_NEW_SECRET =
  "whsec_demo_settlement_notifications_rotated_not_a_real_secret";
export const DEMO_WEBHOOK_ROTATION_UNRELATED_SECRET =
  "whsec_demo_settlement_notifications_unrelated_not_a_real_secret";
export const DEMO_WEBHOOK_ROTATION_EMPTY_SECRETS_ERROR =
  "cannot verify settlement webhook: secrets must be a non-empty array";

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
 * Fan-out limit fixtures for the closing demo section: the
 * `maxEndpoints` / `overallDeadlineMs` options that backlog #630
 * landed on `deliverSettlementWebhookToMany` had no demo segment -
 * a caller reading the demo learned the fan-out shape but never
 * saw the two guards that keep one settlement event from turning
 * into an endpoint explosion or an unbounded wait. Hand-pinned
 * expectations - written from src/webhooks.ts's documented
 * fan-out-limit semantics and cross-checked against
 * test/webhookFanoutLimits.test.ts:
 * - 3 endpoints under `maxEndpoints: 2` throws
 *   `cannot deliver settlement webhook to many endpoints: 3
 *   endpoints exceed maxEndpoints 2` before any request, so the
 *   loopback server records 0 requests
 * - under `overallDeadlineMs: 100` (per-attempt `timeoutMs`
 *   10,000, so the deadline - not the per-attempt timeout - is
 *   what can stop the call) a fast endpoint delivers
 *   `{ok: true, attempts: 1, status: 200}` and a hanging
 *   endpoint reports the pinned deadline error with
 *   `deadlineExceeded: true`, aggregate delivered 1 / failed 1
 * The loopback paths are fixed; the port is ephemeral and never
 * printed, so the output stays byte-identical across runs. The
 * 100 ms deadline is the object under test itself - no elapsed
 * time is asserted or printed.
 */
export const DEMO_FANOUT_LIMIT_AT = "2026-03-08T12:00:00.000Z";
export const DEMO_FANOUT_LIMIT_EVENT_ID = "evt_demo_fanout_limit_001";
export const DEMO_FANOUT_LIMIT_FAST_A_PATH = "/fanout-limit-fast-a";
export const DEMO_FANOUT_LIMIT_FAST_B_PATH = "/fanout-limit-fast-b";
export const DEMO_FANOUT_LIMIT_HANG_PATH = "/fanout-limit-hang";
export const DEMO_FANOUT_LIMIT_SECRET_A =
  "demo-fanout-limit-secret-a-not-a-real-secret";
export const DEMO_FANOUT_LIMIT_SECRET_B =
  "demo-fanout-limit-secret-b-not-a-real-secret";
export const DEMO_FANOUT_LIMIT_SECRET_C =
  "demo-fanout-limit-secret-c-not-a-real-secret";
export const DEMO_FANOUT_LIMIT_CAP = 2;
export const DEMO_FANOUT_LIMIT_DEADLINE_MS = 100;
export const DEMO_FANOUT_LIMIT_TIMEOUT_MS = 10_000;
export const DEMO_FANOUT_LIMIT_CAP_ERROR =
  "cannot deliver settlement webhook to many endpoints: 3 endpoints exceed maxEndpoints 2";
export const DEMO_FANOUT_LIMIT_DEADLINE_ERROR =
  "settlement webhook delivery timed out: overall deadline of 100ms exceeded";

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
 * The executor pins the fixed screening `now` (DEMO_STALE_NOW) as the
 * `at` of every EXPIRE audit entry it dispatches, so those entries are
 * deterministic too — the demo prints each result's entry citation
 * (seq/from/to/at, all pinned) and its printed output stays
 * byte-identical across runs.
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
 * Stale-patrol fixtures (backlog #506): five further escrows screened
 * by `staleEscrows` alone on the SAME fixed `now` (DEMO_STALE_NOW)
 * under a patrol budget map that deliberately covers three states —
 * CREATED, FUNDED and RELEASED, each 7 days — while VERIFIED carries
 * no budget at all. Hand-computed expectations (dwell is `now` minus
 * the last history entry's `at`; stale only when STRICTLY past the
 * budget):
 * - DEMO-ESC-020 (stale): FUNDED at 2026-02-20T09:00 — dwell 17 days
 *   > the 7-day FUNDED budget, so it is the ONLY selection.
 * - DEMO-ESC-021 (exactly at budget): FUNDED at 2026-03-02T09:00 —
 *   dwell exactly 7 days; exactly at the budget is NOT stale.
 * - DEMO-ESC-022 (terminal): RELEASED, last entry at
 *   2026-02-15T09:00 — dwell 22 days and RELEASED even carries a
 *   patrol budget, but terminal states are never stale.
 * - DEMO-ESC-023 (no history): a fresh CREATED escrow that was never
 *   dispatched — CREATED carries a patrol budget, but with no history
 *   there is no measurable dwell, so it is never stale.
 * - DEMO-ESC-024 (unmapped state): VERIFIED, last entry at
 *   2026-02-15T09:00 — dwell 22 days, but VERIFIED is absent from the
 *   patrol map (no budget = no staleness), so it is never stale.
 * The patrol disposition is a notify-only action through
 * `actOnStaleEscrows` (recording the notified ids, dispatching
 * nothing), so every patrol escrow keeps its state and history.
 * A separate fail-fast check calls `staleEscrows` with an unknown
 * state name in the map and pins the exact configuration error.
 */
export const DEMO_PATROL_STALE_ESCROW_ID = "DEMO-ESC-020";
export const DEMO_PATROL_STALE_FUND_AT = "2026-02-20T09:00:00.000Z";
export const DEMO_PATROL_EXACT_ESCROW_ID = "DEMO-ESC-021";
export const DEMO_PATROL_EXACT_FUND_AT = "2026-03-02T09:00:00.000Z";
export const DEMO_PATROL_TERMINAL_ESCROW_ID = "DEMO-ESC-022";
export const DEMO_PATROL_TERMINAL_FUND_AT = "2026-02-10T09:00:00.000Z";
export const DEMO_PATROL_TERMINAL_SUBMIT_AT = "2026-02-12T09:00:00.000Z";
export const DEMO_PATROL_TERMINAL_VERIFY_AT = "2026-02-14T09:00:00.000Z";
export const DEMO_PATROL_TERMINAL_RELEASE_AT = "2026-02-15T09:00:00.000Z";
export const DEMO_PATROL_NO_HISTORY_ESCROW_ID = "DEMO-ESC-023";
export const DEMO_PATROL_UNMAPPED_ESCROW_ID = "DEMO-ESC-024";
export const DEMO_PATROL_UNMAPPED_FUND_AT = "2026-02-10T09:00:00.000Z";
export const DEMO_PATROL_UNMAPPED_SUBMIT_AT = "2026-02-12T09:00:00.000Z";
export const DEMO_PATROL_UNMAPPED_VERIFY_AT = "2026-02-15T09:00:00.000Z";
export const DEMO_PATROL_STALE_CONFIG_ERROR =
  'invalid maxAgeByState: unknown state "BOGUS"';

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
 * Deposit-cap fixtures for the closing segment: a separate risk
 * control from the money guard above. `EscrowOptions.maxDeposit`
 * caps the total locked deposit at cent precision — a FUND dispatch
 * that would push the running locked total (sum of all FUND amounts)
 * above the cap throws a `deposit cap exceeded` error and appends
 * nothing (zero history residue). Hand-pinned expectations — written
 * from the documented semantics in src/stateMachine.ts
 * (deposit-cap block: `round2(funded + amount) > round2(cap)`
 * throws) and cross-checked against test/maxDeposit.test.ts, never
 * derived by running the cap check itself:
 * - a branch escrow ("demo-cap") constructed with maxDeposit 10000
 * - FUND 9000 (initial instalment) is accepted: state FUNDED,
 *   history length 1, locked total 9000
 * - FUND 2000 (second instalment) is rejected with exactly
 *   {@link DEMO_DEPOSIT_CAP_OVERFUND_ERROR}: history stays at
 *   length 1 (no residue), locked total stays 9000
 * - FUND 1000 (boundary top-up) is accepted: locked total 10000,
 *   exactly on the cap passes (cent-precision comparison)
 * All dispatch timestamps are injected so the printed audit trail
 * stays byte-identical across runs. The segment is pure: no
 * network, no randomness, no wall clock.
 */
export const DEMO_DEPOSIT_CAP_ESCROW_ID = "demo-cap";
export const DEMO_DEPOSIT_CAP_MAX = 10000;
export const DEMO_DEPOSIT_CAP_FIRST_FUND_AT = "2026-03-10T09:00:00.000Z";
export const DEMO_DEPOSIT_CAP_FIRST_FUND_AMOUNT = 9000;
export const DEMO_DEPOSIT_CAP_OVERFUND_AT = "2026-03-10T09:01:00.000Z";
export const DEMO_DEPOSIT_CAP_OVERFUND_AMOUNT = 2000;
export const DEMO_DEPOSIT_CAP_OVERFUND_ERROR =
  "deposit cap exceeded: locked 9000 + new funding 2000 would exceed maxDeposit 10000";
export const DEMO_DEPOSIT_CAP_TOPUP_AT = "2026-03-10T09:02:00.000Z";
export const DEMO_DEPOSIT_CAP_TOPUP_AMOUNT = 1000;
export const DEMO_DEPOSIT_CAP_LOCKED_TOTAL = 10000;

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

/**
 * X-Event-Id header fixtures for the closing segment
 * after the single-target delivery: the transport header
 * `deliverSettlementWebhook()` carries on every attempt
 * (see src/webhooks.ts — the header value is exactly the
 * payload's `eventId`, identical on every retry, and it is
 * a transport hint only, NOT covered by the signature).
 * Hand-pinned expectations — written from those documented
 * semantics, never derived by calling the delivery itself,
 * and cross-checked against
 * test/webhookEventIdHeader.test.ts, whose loopback cases
 * pin the same shape (a 500-then-200 endpoint succeeds on
 * the retry with the same header on both attempts; a
 * fan-out carries one shared eventId, not one per
 * endpoint):
 * - the retry endpoint answers 500 on attempt 1 and 200
 *   on attempt 2 -> the result is exactly
 *   `{status: 200, attempts: 2}`, and both captured
 *   requests carry `X-Event-Id` equal to the main
 *   webhook's body eventId ({@link DEMO_WEBHOOK_EVENT_ID})
 * - the fan-out delivers the main report as ONE logical
 *   event ({@link DEMO_EVENT_ID_HEADER_FANOUT_EVENT_ID} /
 *   {@link DEMO_EVENT_ID_HEADER_FANOUT_AT}) to two
 *   loopback endpoints -> delivered 2 / failed 0, and
 *   each endpoint's captured `X-Event-Id` equals that
 *   shared body eventId (a fan-out that minted one
 *   eventId per endpoint would break receiver dedupe)
 * The endpoints are loopback paths, served by a real
 * local HTTP server on an ephemeral port: unlike the
 * scripted-fake delivery segments, this one proves the
 * header survives a genuine HTTP round-trip. The port
 * is never printed — only the paths — so the demo output
 * stays byte-identical across runs. `allowInsecureHttp`
 * is passed explicitly: loopback plaintext is a dev-only
 * opt-out, never the default.
 */
export const DEMO_EVENT_ID_HEADER_RETRY_PATH = "/settlement-event-id-retry";
export const DEMO_EVENT_ID_HEADER_RETRY_STATUSES: readonly number[] = [
  500, 200,
];
export const DEMO_EVENT_ID_HEADER_FANOUT_PATHS: readonly string[] = [
  "/settlement-event-id-a",
  "/settlement-event-id-b",
];
export const DEMO_EVENT_ID_HEADER_FANOUT_EVENT_ID =
  "evt_demo_event_id_fanout_001";
export const DEMO_EVENT_ID_HEADER_FANOUT_AT = "2026-03-08T11:00:00.000Z";
export const DEMO_EVENT_ID_HEADER_FANOUT_SECRET_A =
  "demo-event-id-fanout-secret-a";
export const DEMO_EVENT_ID_HEADER_FANOUT_SECRET_B =
  "demo-event-id-fanout-secret-b";

/**
 * Idempotency-Key header fixtures for the closing
 * segment after the timeout segment: the transport
 * header `deliverSettlementWebhook()` carries on every
 * attempt (see src/webhooks.ts — the header value is
 * exactly the payload's `eventId`, identical on every
 * retry, and it is a transport hint only, NOT covered
 * by the signature). Hand-pinned expectations —
 * written from those documented semantics, never
 * derived by calling the delivery itself, and
 * cross-checked against
 * test/webhookIdempotencyKeyHeader.test.ts, whose
 * loopback cases pin the same shape (a 500-then-200
 * endpoint succeeds on the retry with the same header
 * on both attempts; re-delivery of the same webhook
 * reuses the same key):
 * - the retry endpoint answers 500 on attempt 1 and
 *   200 on attempt 2 -> the result is exactly
 *   `{status: 200, attempts: 2}`, and both captured
 *   requests carry `Idempotency-Key` equal to the main
 *   webhook's body eventId ({@link DEMO_WEBHOOK_EVENT_ID})
 * - the same two requests also carry `X-Event-Id`
 *   equal to that same body eventId: the standard
 *   idempotency header coexists with the vendor
 *   header on one wire, both keyed to the one logical
 *   event, so a receiver deduplicating on either
 *   header sees the same key
 * The endpoint is a loopback path, served by a real
 * local HTTP server on an ephemeral port: unlike the
 * scripted-fake delivery segments, this one proves the
 * header survives a genuine HTTP round-trip. The port
 * is never printed — only the path — so the demo
 * output stays byte-identical across runs.
 * `allowInsecureHttp` is passed explicitly: loopback
 * plaintext is a dev-only opt-out, never the default.
 */
export const DEMO_IDEMPOTENCY_HEADER_RETRY_PATH =
  "/settlement-idempotency-retry";
export const DEMO_IDEMPOTENCY_HEADER_RETRY_STATUSES: readonly number[] = [
  500, 200,
];

/**
 * 429 Retry-After delivery fixtures for the closing
 * segment after the single-target delivery: the main
 * escrow's already-built signed webhook is delivered
 * alone once more, to ONE fixed endpoint whose scripted
 * fake answers 429 — carrying the pinned
 * {@link DEMO_RETRY_AFTER_DELIVERY_HINT} header — on
 * attempt 1 and 200 on attempt 2. Hand-pinned
 * expectations — written from the documented
 * `deliverSettlementWebhook()` semantics in
 * src/webhooks.ts (a 429 is retried; `retryDelayMs`
 * parses the `Retry-After` hint through
 * `parseRetryAfter` and clamps it with `Math.min` to
 * `maxRetryDelayMs` before `sleepAbortable` waits;
 * delay-seconds "120" parses to 120,000 ms), never
 * derived by calling the delivery itself, and
 * cross-checked against test/maxRetryDelay.test.ts and
 * test/webhookDelivery.test.ts, which pin the same
 * clamp and the same 429-then-200 retry shape:
 * - the result is exactly `{status: 200, attempts: 2}`
 * - `parseRetryAfter(DEMO_RETRY_AFTER_DELIVERY_HINT)`
 *   is exactly 120,000 — the hint is genuinely parsed
 *   before it is clamped
 * - exactly 2 requests are captured, both POSTs to
 *   {@link DEMO_RETRY_AFTER_DELIVERY_URL}, bodies
 *   byte-identical to each other and to the canonical
 *   body of the demo webhook, and the captured
 *   `X-Signature` equals the webhook's signature and
 *   verifies over the captured body under
 *   {@link DEMO_WEBHOOK_SECRET}
 * The endpoint is an example.com URL that is never
 * really fetched (scripted fake on `globalThis` for
 * this segment only, the original restored afterwards,
 * the same seam the single-target segment uses).
 * `maxRetryDelayMs: 0` clamps the parsed 120,000 ms
 * hint to a zero wait — the hint is still parsed and
 * applied, the retry just fires immediately — so no
 * real waiting and no wall clock enter the segment.
 */
export const DEMO_RETRY_AFTER_DELIVERY_URL =
  "https://hooks.example.com/settlement-retry-after";
export const DEMO_RETRY_AFTER_DELIVERY_HINT = "120";
export const DEMO_RETRY_AFTER_DELIVERY_HINT_MS = 120_000;
export const DEMO_RETRY_AFTER_DELIVERY_SCRIPTED_STATUSES: readonly number[] =
  [429, 200];

/**
 * Dedupe snapshot-persistence fixtures for the final
 * closing segment: a fresh `SettlementEventDedupe` on a
 * fixed clock (starting at {@link DEMO_DEDUPE_START_MS},
 * the webhook's own `at`, under the same 1-hour TTL the
 * receiver-dedupe segment above uses) records two fixed
 * eventIds, is snapshotted, and is restored after a JSON
 * text round-trip — the receiver-restart path.
 * Hand-pinned expectations — written from the documented
 * `exportSnapshot()` / `restore()` semantics in
 * src/webhooks.ts (the snapshot is `{v: 1, entries}` with
 * only the entries still live at export time, in record
 * order, carrying their original first-seen timestamps;
 * a restored store starts its observability counters at
 * zero; an unsupported version is rejected instead of
 * guessed), never derived by calling the snapshot pair
 * itself, and cross-checked against
 * test/settlementEventDedupeSnapshot.test.ts, whose cases
 * pin the same shapes (exported entries verbatim, ids
 * still duplicate after restore, counters zeroed, the
 * `unsupported snapshot version 2` rejection):
 * - each fixed id's first `checkAndRecord` is `false`
 *   (new event) and its immediate second is `true`
 *   (duplicate)
 * - `exportSnapshot()` is exactly
 *   `{v: 1, entries: [[id1, START], [id2, START]]}`
 * - the restored store's `stats()` read immediately
 *   after restore is exactly
 *   `{size: 2, hits: 0, misses: 0, evictions: 0}`
 * - on the restored store both fixed ids read `true`
 *   (duplicate) and the unseen id reads `false` (new)
 * - a detached copy of the snapshot with `v` rewritten
 *   to 2 throws exactly
 *   {@link DEMO_DEDUPE_SNAPSHOT_TAMPERED_ERROR}, and the
 *   original snapshot object still reads `v: 1`
 * The clock never advances inside the segment, so every
 * recorded id stays inside its TTL for the whole segment
 * and no wall clock, randomness, or network enters it.
 */
export const DEMO_DEDUPE_SNAPSHOT_EVENT_IDS = [
  "evt_demo_dedupe_001",
  "evt_demo_dedupe_002",
] as const;
export const DEMO_DEDUPE_SNAPSHOT_UNSEEN_EVENT_ID = "evt_demo_dedupe_003";
export const DEMO_DEDUPE_SNAPSHOT_START_MS = DEMO_DEDUPE_START_MS;
export const DEMO_DEDUPE_SNAPSHOT_ENTRIES: ReadonlyArray<
  readonly [string, number]
> = [
  [DEMO_DEDUPE_SNAPSHOT_EVENT_IDS[0], DEMO_DEDUPE_SNAPSHOT_START_MS],
  [DEMO_DEDUPE_SNAPSHOT_EVENT_IDS[1], DEMO_DEDUPE_SNAPSHOT_START_MS],
];
export const DEMO_DEDUPE_SNAPSHOT_TAMPERED_ERROR =
  "SettlementEventDedupe: invalid snapshot: unsupported snapshot version 2 (expected 1)";

/**
 * Dedupe clear fixtures for the segment after the dedupe
 * snapshot segment: a fresh `SettlementEventDedupe` on a
 * fixed clock (starting at {@link DEMO_DEDUPE_START_MS},
 * the webhook's own `at`, under the same 1-hour TTL the
 * receiver-dedupe segment above uses) records one fixed
 * eventId twice, is reset with `clear()`, and records the
 * same id once more — the explicit window-reset path a
 * receiver uses at key rotation, in test isolation, or at
 * a window reset.
 * Hand-pinned expectations — written from the documented
 * `clear()` semantics in src/webhooks.ts (drop all tracked
 * ids and reset the observability counters to zero),
 * never derived by calling `clear()` itself, and
 * cross-checked against test/settlementEventDedupe.test.ts,
 * whose clear case pins the same shape (record, duplicate,
 * clear to size 0 with zeroed stats, the same id new again):
 * - the fixed id's first `checkAndRecord` is `false`
 *   (new event) and its immediate second is `true`
 *   (duplicate); stats before the clear are exactly
 *   `{size: 1, hits: 1, misses: 1, evictions: 0}`
 * - immediately after `clear()` the size is 0 and stats
 *   are exactly `{size: 0, hits: 0, misses: 0, evictions: 0}`
 * - the same id's `checkAndRecord` after the clear is
 *   `false` (new event again, re-recorded) and stats after
 *   it are exactly `{size: 1, hits: 0, misses: 1, evictions: 0}`
 * The clock never advances inside the segment, so the
 * recorded id stays inside its TTL for the whole segment
 * and no wall clock, randomness, or network enters it.
 */
export const DEMO_DEDUPE_CLEAR_EVENT_ID = "evt_demo_dedupe_clear_001";
export const DEMO_DEDUPE_CLEAR_START_MS = DEMO_DEDUPE_START_MS;

/**
 * Dedupe capacity-eviction fixtures for the segment after
 * the dedupe clear segment: a `SettlementEventDedupe` on a
 * fixed clock (starting at {@link DEMO_DEDUPE_START_MS},
 * the webhook's own `at`, under the same 1-hour TTL the
 * receiver-dedupe segments above use) is built with a tiny
 * `maxEntries: 3`, recording four fixed eventIds: the
 * fourth record forces the LRU eviction of the oldest
 * entry, and the evicted id then counts as a new event
 * when seen again. A `maxEntries: 0` construction is
 * rejected with the pinned configuration error.
 * Hand-pinned expectations — written from the documented
 * `checkAndRecord` / `prune` / constructor semantics in
 * src/webhooks.ts (LRU eviction of the least-recently-seen
 * id when the store is at capacity, evictions counted in
 * `stats().evictions`, non-positive maxEntries rejected at
 * construction), never derived by calling the dedupe
 * itself, and cross-checked against
 * test/settlementEventDedupe.test.ts, whose capacity case
 * pins the same shape (full store, oldest evicted, evicted
 * id new again, invalid maxEntries rejected):
 * - the four fixed ids' first `checkAndRecord` verdicts
 *   are all `false` (new events); an immediate re-record
 *   of the first id before the store fills is `true`
 *   (duplicate, and its LRU recency is refreshed)
 * - the full call order is
 *   `[false, true, false, false, false, false]` —
 *   the fifth call (fourth distinct id) evicts the
 *   oldest id, the sixth call re-records the evicted id
 *   and is a new event (`false`), evicting the next
 *   oldest
 * - `stats()` after the fifth call is exactly
 *   `{size: 3, hits: 1, misses: 4, evictions: 1}`;
 *   after the sixth call exactly
 *   `{size: 3, hits: 1, misses: 5, evictions: 2}`
 * - `new SettlementEventDedupe({ maxEntries: 0 })`
 *   throws exactly
 *   {@link DEMO_DEDUPE_CAPACITY_INVALID_MAX_ENTRIES_ERROR}
 * The clock never advances inside the segment, so every
 * id stays inside its TTL and the evictions shown are
 * capacity evictions only — no TTL expiry, no wall clock,
 * no randomness, no network.
 */
export const DEMO_DEDUPE_CAPACITY_MAX_ENTRIES = 3;
export const DEMO_DEDUPE_CAPACITY_EVENT_IDS = [
  "evt_demo_dedupe_cap_001",
  "evt_demo_dedupe_cap_002",
  "evt_demo_dedupe_cap_003",
  "evt_demo_dedupe_cap_004",
] as const;
export const DEMO_DEDUPE_CAPACITY_START_MS = DEMO_DEDUPE_START_MS;
export const DEMO_DEDUPE_CAPACITY_INVALID_MAX_ENTRIES_ERROR =
  "SettlementEventDedupe: maxEntries must be a positive integer";

/**
 * Fee-breakdown fixtures for the `adjustedBaseFee` demo segment: the
 * portfolio golden vector's pinned intermediate (`round2(600 × 1) =
 * 600`, deposit 10630) plus a fractional-multiplier vector whose raw
 * product 599.99 × 1.25 = 749.9875 exercises the `round2` rounding on
 * the intermediate. Hand-pinned expectations — written from the
 * documented formula in src/feeCalculator.ts:
 *   adjustedBaseFee = round2(baseFee × complexityMultiplier)
 *   deposit = round2(creatorPool + adjustedBaseFee − loyaltyDiscount + oracleFee)
 * The demo itself asserts every field below, outside the printing.
 */
export const DEMO_FEE_GOLDEN_ADJUSTED_BASE_FEE = 600;
export const DEMO_FEE_GOLDEN_DEPOSIT = 10630;
export const DEMO_FEE_FRACTIONAL_INPUTS: FeeInputs = {
  creatorPool: 10000,
  baseFee: 599.99,
  complexityMultiplier: 1.25,
  loyaltyDiscount: 30,
  oracleFee: 60,
};
export const DEMO_FEE_FRACTIONAL_ADJUSTED_BASE_FEE = 749.99;
export const DEMO_FEE_FRACTIONAL_DEPOSIT = 10779.99;

/**
 * Subscribe onError fixtures for the final closing segment:
 * one branch escrow carrying a single pinned throwing
 * listener with a collecting `onError`, plus a probe escrow
 * whose `onError` itself throws. Hand-pinned expectations —
 * written from the documented `subscribe()` semantics in
 * src/stateMachine.ts (a listener's throw is caught and
 * swallowed so dispatch and the audit trail are never
 * broken; `subscribe(listener, { onError })` routes each
 * caught error to `onError` with the dispatch context
 * `{event, from, to}`; a throwing `onError` is swallowed
 * as well; a non-function `onError` is rejected at
 * subscribe time), never derived by calling `subscribe()`
 * itself, and cross-checked against test/subscribe.test.ts,
 * whose onError case pins the same shapes (the caught error
 * object reaches `onError` with context
 * `{event: "FUND", from: "CREATED", to: "FUNDED"}`, a
 * throwing `onError` still lets dispatch complete, and
 * `onError: "x"` throws the invalid-subscribe error):
 * - the three fixed dispatches FUND (CREATED -> FUNDED),
 *   SUBMIT_MILESTONE (FUNDED -> MILESTONE_SUBMITTED) and
 *   VERIFY_PASS (MILESTONE_SUBMITTED -> VERIFIED) all
 *   succeed — the escrow ends VERIFIED with 3 history
 *   entries — and `onError` receives exactly 3 reports,
 *   each carrying the pinned listener error message and
 *   the context of its dispatch, in dispatch order
 * - the probe escrow's FUND dispatch still returns FUNDED
 *   (1 history entry) even though its `onError` throws
 * - subscribing with `onError: "x"` on the branch escrow
 *   throws exactly {@link DEMO_ONERROR_INVALID_ERROR} and
 *   registers nothing (`listenerCount` stays 1)
 * Every timestamp is a fixed literal: no network, no
 * randomness, no wall clock.
 */
export const DEMO_ONERROR_ESCROW_ID = "DEMO-ESC-014";
export const DEMO_ONERROR_PROBE_ESCROW_ID = "DEMO-ESC-015";
export const DEMO_ONERROR_FUND_AT = "2026-03-13T09:00:00.000Z";
export const DEMO_ONERROR_SUBMIT_AT = "2026-03-13T10:00:00.000Z";
export const DEMO_ONERROR_VERIFY_AT = "2026-03-13T11:00:00.000Z";
export const DEMO_ONERROR_VERIFY_EVIDENCE = "demo-oracle-attestation-014";
export const DEMO_ONERROR_LISTENER_ERROR = "demo fan-out consumer blew up";
export const DEMO_ONERROR_EXPECTED_REPORTS: ReadonlyArray<{
  message: string;
  event: EscrowEvent;
  from: EscrowState;
  to: EscrowState;
}> = [
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
];
export const DEMO_ONERROR_INVALID_ERROR =
  "invalid subscribe: onError must be a function, got string";

/**
 * Quorum revoke fixtures for the final closing segment: a
 * fresh quorum (2-of-3, same signer ids as the dispute
 * quorum) on a fixed clock. Hand-pinned expectations —
 * written from the documented `revoke()` semantics in
 * src/quorum.ts (revoking removes all of the signer's log
 * entries; re-approving appends a fresh entry, so the
 * re-voter sorts last in `approvals()`; unknown signers
 * and signers that have not approved throw), never derived
 * by calling `revoke()` itself, and cross-checked against
 * test/revoke.test.ts:
 * - arb-1 approves at {@link DEMO_REVOKE_FIRST_AT} and
 *   arb-2 at {@link DEMO_REVOKE_SECOND_AT}: approvalCount
 *   2, hasQuorum true, approvals [arb-1, arb-2]
 * - arb-1 revokes: approvalCount 1, hasQuorum false,
 *   approvals exactly [arb-2], and the audit trail keeps
 *   only arb-2's entry
 * - arb-1 re-approves at {@link DEMO_REVOKE_REAPPROVE_AT}:
 *   approvalCount 2, hasQuorum true, approvals exactly
 *   [arb-2, arb-1] — the re-voter is last
 * - revoking {@link DEMO_REVOKE_UNKNOWN_SIGNER} throws
 *   exactly {@link DEMO_REVOKE_UNKNOWN_ERROR}, and
 *   revoking arb-3 (a signer that never approved) throws
 *   exactly {@link DEMO_REVOKE_NOT_APPROVED_ERROR}; both
 *   failed revokes leave the quorum untouched
 * Every timestamp is a fixed literal: no network, no
 * randomness, no wall clock (the quorum's clock is a
 * variable the segment sets to fixed instants only).
 */
export const DEMO_REVOKE_FIRST_AT = "2026-03-17T09:00:00.000Z";
export const DEMO_REVOKE_SECOND_AT = "2026-03-17T09:01:00.000Z";
export const DEMO_REVOKE_REAPPROVE_AT = "2026-03-17T09:02:00.000Z";
export const DEMO_REVOKE_UNKNOWN_SIGNER = "mallory";
export const DEMO_REVOKE_UNKNOWN_ERROR =
  'unknown quorum signer: "mallory"';
export const DEMO_REVOKE_NOT_APPROVED_ERROR =
  'cannot revoke: signer "arb-3" has not approved';
export const DEMO_REVOKE_LOG_AFTER_REVOKE: readonly ApprovalLogEntry[] = [
  { signerId: "arb-2", at: "2026-03-17T09:01:00.000Z" },
];
export const DEMO_REVOKE_LOG_FINAL: readonly ApprovalLogEntry[] = [
  { signerId: "arb-2", at: "2026-03-17T09:01:00.000Z" },
  { signerId: "arb-1", at: "2026-03-17T09:02:00.000Z" },
];

/**
 * Webhook AbortSignal fixtures for the final closing
 * segment: the main escrow's signed webhook is delivered
 * twice more against scripted fake `fetch` seams, each
 * time with a caller-owned `AbortSignal` (the
 * `DeliverWebhookOptions.signal` of feat #112). Hand-pinned
 * expectations — written from the documented
 * `deliverSettlementWebhook()` abort semantics in
 * src/webhooks.ts (a pre-aborted signal throws
 * `webhook delivery aborted` before any request; an abort
 * during the backoff sleep rejects the pending sleep with
 * the same error and no further attempt fires), never
 * derived by calling the delivery itself, and
 * cross-checked against test/webhookAbortSignal.test.ts,
 * which pins the same two shapes:
 * - pre-aborted: the delivery throws exactly
 *   {@link DEMO_ABORT_ERROR} and the counting fake fetch
 *   is called exactly 0 times (zero attempts)
 * - abort during backoff: the fake answers 500 on the
 *   first attempt and schedules the abort for the next
 *   macrotask; the delivery rejects with exactly
 *   {@link DEMO_ABORT_ERROR} and the fake fetch is called
 *   exactly 1 time — the pinned
 *   {@link DEMO_ABORT_BACKOFF_MS} wait never elapses and
 *   no second attempt fires
 * Both endpoints are example.com URLs that are never
 * really fetched (scripted fakes on `globalThis` for this
 * segment only, the original restored afterwards). The
 * abort in the second shape is scheduled with a zero-ms
 * timer from inside the fake fetch: the delivery registers
 * its abort listener on the backoff sleep synchronously
 * after the response settles (microtasks run before
 * timers), so the abort lands inside the pending sleep
 * deterministically — zero real waiting, zero network,
 * zero randomness, no wall clock.
 */
export const DEMO_ABORT_PRE_URL =
  "https://hooks.example.com/settlement-abort-pre";
export const DEMO_ABORT_BACKOFF_URL =
  "https://hooks.example.com/settlement-abort-backoff";
export const DEMO_ABORT_ERROR = "webhook delivery aborted";
export const DEMO_ABORT_BACKOFF_MS = 60_000;

/**
 * Optimistic-concurrency fixtures for the final closing
 * segment: a fresh branch escrow driven through three
 * fixed-timestamp dispatches while the `expectedSeq`
 * guard of `DispatchOptions` (src/stateMachine.ts) is
 * exercised in every shape. Hand-pinned expectations —
 * written from the documented guard semantics there
 * (`expectedSeq` asserts the current history length,
 * which is also the last entry's `seq`, `0` for an empty
 * history; the guard is checked before every other
 * dispatch validation, so a mismatch changes nothing —
 * no state move, no history entry), never derived by
 * calling the guarded dispatch itself, and
 * cross-checked against test/expectedSeq.test.ts, which
 * pins the same shapes:
 * - FUND with `expectedSeq: 0` on the empty history
 *   succeeds: state FUNDED, seq 0 -> 1 (exactly +1)
 * - SUBMIT_MILESTONE with `expectedSeq: 1` succeeds:
 *   state MILESTONE_SUBMITTED, seq 1 -> 2
 * - VERIFY_PASS retried with the now-stale
 *   `expectedSeq: 1` (a second writer still holding the
 *   seq-1 snapshot) throws exactly
 *   {@link DEMO_EXPECTED_SEQ_STALE_ERROR} and leaves
 *   state (MILESTONE_SUBMITTED) and history (2 entries)
 *   untouched
 * - VERIFY_PASS with `expectedSeq: -1` throws exactly
 *   {@link DEMO_EXPECTED_SEQ_INVALID_NEGATIVE_ERROR}
 *   and with `expectedSeq: 1.5` exactly
 *   {@link DEMO_EXPECTED_SEQ_INVALID_FRACTION_ERROR} —
 *   a non-negative-integer caller configuration error,
 *   checked before the transition itself
 * - VERIFY_PASS with NO `expectedSeq` then succeeds:
 *   state VERIFIED, seq 2 -> 3 — omitting the guard
 *   preserves the exact pre-guard behavior
 * Fixed escrow id, fixed amount (the golden deposit),
 * fixed timestamps: no network, no randomness, no
 * wall clock.
 */
export const DEMO_EXPECTED_SEQ_ESCROW_ID = "DEMO-ESC-016";
export const DEMO_EXPECTED_SEQ_FUND_AT = "2026-03-18T09:00:00.000Z";
export const DEMO_EXPECTED_SEQ_SUBMIT_AT = "2026-03-18T10:00:00.000Z";
export const DEMO_EXPECTED_SEQ_VERIFY_AT = "2026-03-18T11:00:00.000Z";
export const DEMO_EXPECTED_SEQ_VERIFY_EVIDENCE =
  "demo-oracle-attestation-016";
export const DEMO_EXPECTED_SEQ_STALE_ERROR =
  "dispatch conflict: expected seq 1 but escrow is at seq 2";
export const DEMO_EXPECTED_SEQ_INVALID_NEGATIVE_ERROR =
  "invalid dispatch options: expectedSeq must be a non-negative integer, got -1";
export const DEMO_EXPECTED_SEQ_INVALID_FRACTION_ERROR =
  "invalid dispatch options: expectedSeq must be a non-negative integer, got 1.5";

/**
 * Verify-evidence fixtures for the final closing segment:
 * two fresh branch escrows driven on fixed timestamps
 * while the `requireVerifyEvidence` gate of
 * `EscrowOptions` (src/stateMachine.ts) is exercised in
 * every shape. Hand-pinned expectations — written from
 * the documented gate semantics there (with the flag on,
 * a VERIFY_PASS dispatch without a non-empty `evidence`
 * reference throws the pinned error BEFORE anything is
 * appended; with evidence it proceeds and the reference
 * is recorded verbatim on the audit entry; the library
 * records the caller's claim and does NOT verify the
 * oracle signature, zk proof, or TEE attestation behind
 * it), never derived by calling the gated dispatch
 * itself, and cross-checked against
 * test/verifyEvidence.test.ts, which pins the same
 * shapes:
 * - DEMO-ESC-017 (flag on): FUND + SUBMIT_MILESTONE on
 *   fixed timestamps reach MILESTONE_SUBMITTED (2
 *   entries)
 * - VERIFY_PASS with NO evidence throws exactly
 *   {@link DEMO_VERIFY_EVIDENCE_ERROR} and leaves state
 *   (MILESTONE_SUBMITTED) and history (2 entries)
 *   untouched
 * - VERIFY_PASS with evidence
 *   {@link DEMO_VERIFY_EVIDENCE_REF} then succeeds:
 *   state VERIFIED, and the last audit entry carries
 *   the reference verbatim
 * - DEMO-ESC-018 (flag off, the default): the same
 *   chain with an evidence-free VERIFY_PASS succeeds —
 *   omitting the flag preserves the exact pre-gate
 *   behavior, and its VERIFY_PASS entry carries no
 *   evidence field
 * Fixed escrow ids, fixed amount (the golden deposit),
 * fixed timestamps: no network, no randomness, no
 * wall clock.
 */
export const DEMO_VERIFY_EVIDENCE_ESCROW_ID = "DEMO-ESC-017";
export const DEMO_VERIFY_EVIDENCE_DEFAULT_ESCROW_ID = "DEMO-ESC-018";
export const DEMO_VERIFY_EVIDENCE_FUND_AT = "2026-03-19T09:00:00.000Z";
export const DEMO_VERIFY_EVIDENCE_SUBMIT_AT = "2026-03-19T10:00:00.000Z";
export const DEMO_VERIFY_EVIDENCE_VERIFY_AT = "2026-03-19T11:00:00.000Z";
export const DEMO_VERIFY_EVIDENCE_REF = "demo-oracle-attestation-017";
export const DEMO_VERIFY_EVIDENCE_ERROR =
  'verify evidence required: dispatch("VERIFY_PASS") requires a non-empty evidence reference when requireVerifyEvidence is enabled';

/**
 * Keyed audit-chain fixtures for the final closing segment:
 * one fresh branch escrow driven on fixed timestamps while
 * the keyed (HMAC) mode of the audit hash chain —
 * `EscrowOptions.auditKey` (src/stateMachine.ts) — is
 * exercised in every shape. Hand-pinned expectations —
 * written from the documented keyed-mode semantics there
 * (with a key set, every entry's `hash` is HMAC-SHA256
 * over the canonical entry plus its `prevHash`;
 * `verifyHistoryChain(history, key)` recomputes every
 * link under that key; the two modes are fail-closed
 * against each other — a keyed chain verifies neither
 * without its key nor under a wrong key, exactly as
 * test/keyedHashChain.test.ts pins), never derived by
 * calling the verifier itself:
 * - DEMO-ESC-019 (auditKey set): FUND +
 *   SUBMIT_MILESTONE + VERIFY_PASS + RELEASE on fixed
 *   timestamps reach RELEASED (4 entries, genesis-linked
 *   to GENESIS_PREV_HASH, every successor's `prevHash`
 *   equal to its predecessor's `hash`)
 * - `verifyHistoryChain(history, DEMO_AUDIT_KEY)` is
 *   `true` — the correct key recomputes every link
 * - `verifyHistoryChain(history, DEMO_AUDIT_WRONG_KEY)`
 *   is `false` — a wrong key recomputes nothing
 * - `verifyHistoryChain(history)` with NO key is
 *   `false` — a keyed chain never verifies keylessly
 * - a detached copy whose middle (SUBMIT_MILESTONE)
 *   entry's note is rewritten to
 *   {@link DEMO_AUDIT_KEY_TAMPERED_NOTE} verifies
 *   `false` even under the correct key, and the
 *   escrow's own history still verifies afterwards
 * Both keys carry the same placeholder status as
 * {@link DEMO_WEBHOOK_SECRET}: printed in the source,
 * NOT real credentials. Fixed escrow id, fixed amount
 * (the golden deposit), fixed timestamps: no network,
 * no randomness, no wall clock.
 */
export const DEMO_AUDIT_KEY_ESCROW_ID = "DEMO-ESC-019";
export const DEMO_AUDIT_KEY = "demo-audit-key-019-not-a-real-secret";
export const DEMO_AUDIT_WRONG_KEY = "demo-audit-key-wrong-not-a-real-secret";
export const DEMO_AUDIT_KEY_FUND_AT = "2026-03-20T09:00:00.000Z";
export const DEMO_AUDIT_KEY_SUBMIT_AT = "2026-03-20T10:00:00.000Z";
export const DEMO_AUDIT_KEY_VERIFY_AT = "2026-03-20T11:00:00.000Z";
export const DEMO_AUDIT_KEY_RELEASE_AT = "2026-03-20T11:01:00.000Z";
export const DEMO_AUDIT_KEY_VERIFY_EVIDENCE = "demo-oracle-attestation-019";
export const DEMO_AUDIT_KEY_SUBMIT_NOTE =
  "Deliverable URLs + IPFS metadata hash";
export const DEMO_AUDIT_KEY_TAMPERED_NOTE =
  "Deliverable URLs + IPFS metadata hash (rewritten)";

/**
 * Webhook timeout fixtures for the final closing segment:
 * the main escrow's signed webhook is delivered three
 * more times while the per-attempt `timeoutMs` bound of
 * `DeliverWebhookOptions` (src/webhooks.ts) is exercised
 * in every shape. Hand-pinned expectations — written from
 * the documented `deliverSettlementWebhook()` timeout
 * semantics there (each attempt is aborted after
 * `timeoutMs`; a timeout surfaces as
 * `webhook delivery timed out after <timeoutMs>ms` and is
 * then handled by the retry policy, so with `retries: 0`
 * the delivery fails after exactly 1 attempt with that
 * text as its last cause; an illegal `timeoutMs` throws
 * the pinned configuration error before any request is
 * made), never derived by calling the delivery itself,
 * and cross-checked against test/webhookDelivery.test.ts,
 * which pins the same timeout and configuration shapes:
 * - hanging fake with `timeoutMs`
 *   {@link DEMO_TIMEOUT_MS} and `retries: 0`: the delivery
 *   throws exactly {@link DEMO_TIMEOUT_DELIVERY_ERROR}
 *   and the hanging fake fetch is called exactly 1 time —
 *   it only ever rejects when its request signal aborts,
 *   so the pinned timeout is what ends the attempt
 * - `timeoutMs: 0`: the delivery throws exactly
 *   {@link DEMO_TIMEOUT_INVALID_ERROR} and the counting
 *   fake fetch is called exactly 0 times
 * - generous `timeoutMs`
 *   {@link DEMO_TIMEOUT_GENEROUS_MS} with an immediately
 *   200 fake fetch: the delivery resolves exactly
 *   `{status: 200, attempts: 1}` — the result shape is
 *   unchanged under a generous timeout
 * Both endpoints are example.com URLs that are never
 * really fetched (scripted fakes on `globalThis` for this
 * segment only, the original restored afterwards). The
 * timeout wait itself is the object under test and is the
 * pinned short {@link DEMO_TIMEOUT_MS}: no elapsed-time
 * (wall-clock) assertion is made anywhere in the segment,
 * and the printed lines carry no duration, so the output
 * stays byte-identical across runs. Zero real network,
 * zero randomness.
 */
export const DEMO_TIMEOUT_URL =
  "https://hooks.example.com/settlement-timeout";
export const DEMO_TIMEOUT_OK_URL =
  "https://hooks.example.com/settlement-timeout-ok";
export const DEMO_TIMEOUT_MS = 50;
export const DEMO_TIMEOUT_GENEROUS_MS = 5000;
export const DEMO_TIMEOUT_TIMED_OUT_ERROR =
  "webhook delivery timed out after 50ms";
export const DEMO_TIMEOUT_DELIVERY_ERROR =
  "webhook delivery to https://hooks.example.com/settlement-timeout failed after 1 attempt: webhook delivery timed out after 50ms";
export const DEMO_TIMEOUT_INVALID_ERROR =
  "cannot deliver settlement webhook: timeoutMs must be a positive number, got 0";

/**
 * Staged top-up fixtures for the demo's staged-funding segment: a
 * separate escrow (DEMO-ESC-025) funded in two instalments rather
 * than once. Hand-pinned expectations — written from
 * src/stateMachine.ts (FUND on FUNDED is the self-loop the top-up
 * feature added: from == to == FUNDED), from
 * src/settlementReport.ts's `depositAmountFromHistory` (the sum of
 * every FUND amount in the audit trail — here the two instalments,
 * 10630 + 2000), and from src/settlement.ts's documented
 * arithmetic (proFee = round2(gross * bps / 10000);
 * net = round2(gross - proFee - referralCredits)), never derived by
 * calling the functions themselves, and cross-checked against
 * test/topup.test.ts (the self-loop shape) and
 * test/fundTotalCentsComparison.test.ts (the FUND-total corroboration
 * the report build requires):
 * - 10630 + 2000 = 12630 — the deposit `depositAmountFromHistory`
 *   traces from the two FUND entries, and the fee inputs below are
 *   built so `calculateDeposit` yields exactly 12630 as well, so
 *   the report's FUND-total check corroborates
 * - gross 12630 at 500 bps -> proFee round2(12630 × 500 / 10000)
 *   = 631.50; referralCredits 0 -> net round2(12630 − 631.50)
 *   = 11998.50
 * - released-report party nets: sponsor −12630 / creator +11998.50 /
 *   platform +631.50 / referrer 0 — the four nets sum to zero and
 *   the inflows sum to the deposit (conservation)
 * Every timestamp is a fixed literal: no network, no randomness,
 * no wall clock.
 */
export const DEMO_TOPUP_ESCROW_ID = "DEMO-ESC-025";
export const DEMO_TOPUP_FEE_INPUTS: FeeInputs = {
  creatorPool: 12000,
  baseFee: 600,
  complexityMultiplier: 1.0,
  loyaltyDiscount: 30,
  oracleFee: 60,
};
export const DEMO_TOPUP_FIRST_FUND_AT = "2026-03-04T09:00:00.000Z";
export const DEMO_TOPUP_FIRST_FUND_AMOUNT = 10630;
export const DEMO_TOPUP_SECOND_FUND_AT = "2026-03-05T09:00:00.000Z";
export const DEMO_TOPUP_SECOND_FUND_AMOUNT = 2000;
export const DEMO_TOPUP_DEPOSIT = 12630;
export const DEMO_TOPUP_PRO_FEE = 631.5;
export const DEMO_TOPUP_NET = 11998.5;
export const DEMO_TOPUP_SUBMIT_AT = "2026-03-06T12:30:00.000Z";
export const DEMO_TOPUP_VERIFY_AT = "2026-03-07T08:15:00.000Z";
export const DEMO_TOPUP_VERIFY_EVIDENCE = "demo-oracle-attestation-topup";
export const DEMO_TOPUP_RELEASE_AT = "2026-03-07T08:16:00.000Z";

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
   * `renderReportCsv(report)` on the main settlement report: the same
   * released report as CSV — header
   * `escrowId,outcome,role,inflow,outflow,net`, one row per party in
   * fixed sponsor/creator/platform/referrer order, and a final `TOTAL`
   * row whose inflow/outflow/net columns sum the party rows.
   */
  reportCsv: string;
  /**
   * `renderReportJson(report)` on the main settlement report: the same
   * released report as JSON — exactly the `SettlementReport` fields,
   * with amounts as JSON numbers (not the CSV's two-decimal strings).
   */
  reportJson: string;
  /**
   * `parseSettlementReportJson(reportJson)` on the main settlement
   * report: the same released report read back from its JSON form —
   * deep-equal to `report` and re-rendering byte-identically through
   * `renderReportJson`, as an independent object graph (mutating it
   * never touches `report`).
   */
  reportJsonImported: SettlementReport;
  /**
   * The pinned rejection for a damaged report JSON whose `parties`
   * field is missing: `cannot parse settlement report JSON: parties
   * must be a non-empty array` — the import fails fast instead of
   * returning a party-less report.
   */
  reportJsonDamagedError: string;
  /**
   * `parseSettlementReportCsv(reportCsv)` on the main settlement
   * report: the same released report read back from its CSV form —
   * the CSV-carried subset (`SettlementReportCsv`: escrowId,
   * outcome, the four party ledgers, the TOTAL row's totals, and
   * `balanced`), re-rendering byte-identically through
   * `renderReportCsv`, as an independent object graph (mutating it
   * never touches `report`).
   */
  reportCsvImported: SettlementReportCsv;
  /**
   * The pinned rejection for a damaged report CSV whose TOTAL row
   * no longer sums the party rows: `cannot parse settlement report
   * CSV: TOTAL row inflow 10631 does not equal the sum over party
   * rows 10630` — the import fails fast instead of returning a
   * self-inconsistent report.
   */
  reportCsvDamagedError: string;
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
  /** The `maxAgeMs` freshness window of the demo segment: 3,600,000. */
  webhookFreshnessMaxAgeMs: number;
  /**
   * Freshness verdict on the main webhook at the injected
   * within-window instant (at + half the window): `true`.
   */
  webhookFreshnessWithinWindow: boolean;
  /**
   * Freshness verdict at exactly `at + maxAgeMs`: `true` — the
   * boundary is inclusive (only `now - at > maxAgeMs` fails).
   */
  webhookFreshnessBoundary: boolean;
  /**
   * Freshness verdict at `at + 2 * maxAgeMs`: `false` — the
   * signature itself stays valid; the opt-in window is a replay
   * bound, not a signature check, and it refuses fail-closed.
   */
  webhookFreshnessExpired: boolean;
  /** The `maxFutureSkewMs` freshness bound of the demo segment: 300,000. */
  webhookFreshnessMaxFutureSkewMs: number;
  /**
   * Freshness verdict with the payload's `at` 10 minutes ahead of
   * the injected `now` under the 5-minute skew bound: `false`.
   */
  webhookFreshnessFutureSkewExceeded: boolean;
  /**
   * Rotation verdict on the main webhook (signed with
   * {@link DEMO_WEBHOOK_SECRET}, the old secret) under the
   * rotation candidate set
   * `{ secrets: [DEMO_WEBHOOK_ROTATION_NEW_SECRET, DEMO_WEBHOOK_SECRET] }`:
   * `true` — the old secret still verifies inside the window.
   */
  webhookRotationOldVerified: boolean;
  /**
   * Rotation verdict on a twin of the main webhook signed with
   * {@link DEMO_WEBHOOK_ROTATION_NEW_SECRET} over the identical
   * payload under the same candidate set: `true` — the new
   * secret verifies too.
   */
  webhookRotationNewVerified: boolean;
  /**
   * Rotation verdict on a twin signed with
   * {@link DEMO_WEBHOOK_ROTATION_UNRELATED_SECRET} under the
   * same candidate set: `false` — all-mismatch fails closed,
   * without throwing.
   */
  webhookRotationUnrelatedVerified: boolean;
  /**
   * Error message of verifying the main webhook with an empty
   * `secrets` array: exactly
   * {@link DEMO_WEBHOOK_ROTATION_EMPTY_SECRETS_ERROR} — an empty
   * candidate set is a caller configuration error, never a
   * silent pass.
   */
  webhookRotationEmptySecretsError: string;
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
  /**
   * Audit-entry citations for the deadline watchdog execution
   * (backlog #615): one per attempted escrow, in batch order — the
   * successful FUNDED expiry cites its EXPIRE entry (seq/from/to/at,
   * identical to the escrow history's last entry); the failed
   * VERIFIED attempt cites no entry, because a failed dispatch
   * appends nothing. A reader can cite the expiry from this field
   * alone, without re-reading `escrow.history`.
   */
  deadlineExpireEntryRefs: Array<{
    escrowId: string;
    entry: EscrowHistoryEntry | undefined;
  }>;
  /**
   * The five stale-patrol escrows (backlog #506), in patrol order
   * (stale, exactly-at-budget, terminal, no-history, unmapped):
   * FUNDED, FUNDED, RELEASED, CREATED, VERIFIED — the notify-only
   * patrol action dispatched nothing, so states and histories are
   * exactly as constructed.
   */
  patrolEscrows: Escrow[];
  /**
   * `staleEscrows` selection over {@link DemoResult.patrolEscrows}
   * under the patrol budgets (CREATED / FUNDED / RELEASED, 7 days
   * each) on the fixed demo `now`: just the stale FUNDED escrow —
   * exactly-at-budget, terminal, no-history and unmapped-state
   * escrows are all excluded, each for a different pinned reason.
   */
  patrolStaleSelected: Escrow[];
  /**
   * Per-escrow outcomes of `actOnStaleEscrows` running the
   * notify-only patrol action over the patrol batch: one entry, for
   * the stale escrow, acted true.
   */
  patrolStaleActionResults: StaleEscrowActionResult[];
  /** Ids the notify-only patrol action recorded, in action order: just the stale escrow's id. */
  patrolStaleNotifiedIds: string[];
  /**
   * Exact error of `staleEscrows` called with an unknown state name
   * in the budget map (`invalid maxAgeByState: unknown state
   * "BOGUS"`) — configuration is validated fail-fast before any
   * escrow is read.
   */
  patrolStaleConfigError: string;
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
   * The staged top-up escrow (DEMO-ESC-025) after the segment's
   * chain ran: funded twice (the golden 10630, then the 2000
   * top-up on the FUNDED self-loop), then SUBMIT_MILESTONE ->
   * VERIFY_PASS -> RELEASE — RELEASED with 5 audit entries.
   */
  topupEscrow: Escrow;
  /**
   * Deposit traced from the top-up escrow's audit history alone by
   * `depositAmountFromHistory`: the sum of the two FUND amounts,
   * {@link DEMO_TOPUP_DEPOSIT} (12630) — the staged-funding
   * deposit the report build corroborates.
   */
  topupTracedDeposit: number;
  /**
   * Pure settlement split of the staged deposit by
   * `settleRelease` at {@link DEMO_PRO_FEE_BPS} with no referral
   * credits: gross 12630, proFee 631.5, referralCredits 0, net
   * 11998.5 — the same split the top-up settlement report below
   * was built on.
   */
  topupSettlement: Settlement;
  /**
   * Released settlement report of the staged top-up escrow: the
   * four party nets (sponsor −12630 / creator +11998.50 /
   * platform +631.50 / referrer 0) conserve the deposit exactly
   * — inflows sum to 12630 and every part of the deposit is
   * accounted for.
   */
  topupReport: SettlementReport;
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
   * `readmeDiagramInSync()` verdict on this repo's README:
   * `true` — README.md embeds the exact `stateDiagram()`
   * block generated in the segment above (no diagram drift).
   * Hand-pinned in the segment comment and cross-checked
   * against test/diagram.test.ts.
   */
  readmeDiagramInSync: boolean;
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
   * The closing deposit-cap segment's branch escrow
   * ({@link DEMO_DEPOSIT_CAP_ESCROW_ID}, `maxDeposit` pinned at
   * {@link DEMO_DEPOSIT_CAP_MAX}), after all three fixed
   * dispatches ran: FUNDED with 2 history entries — the
   * over-cap attempt left no audit residue.
   */
  depositCapEscrow: Escrow;
  /**
   * Locked total on {@link DemoResult.depositCapEscrow} after the
   * segment: {@link DEMO_DEPOSIT_CAP_LOCKED_TOTAL} — the
   * boundary top-up landed exactly on the cap (cent-precision
   * comparison), and the rejected attempt contributed nothing.
   */
  depositCapLockedTotal: number;
  /**
   * The exact error message the rejected over-cap FUND dispatch
   * threw ({@link DEMO_DEPOSIT_CAP_OVERFUND_ERROR}), hand-pinned
   * from the documented deposit-cap wording in
   * src/stateMachine.ts and cross-checked against
   * test/maxDeposit.test.ts.
   */
  depositCapOverfundError: string;
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
  /**
   * Result of delivering the main escrow's signed webhook
   * to the loopback retry endpoint with
   * `deliverSettlementWebhook()`: exactly
   * `{status: 200, attempts: 2}` — the loopback endpoint
   * answered 500 first, so the delivery succeeded only
   * after one genuine HTTP retry.
   */
  eventIdHeaderRetryResult: WebhookDeliveryResult;
  /**
   * The requests the loopback server captured during the
   * X-Event-Id retry delivery, in attempt order: exactly
   * 2, each carrying `X-Event-Id` equal to the main
   * webhook's body eventId, with the raw body and its
   * parsed eventId alongside for the header/body
   * comparison the segment prints.
   */
  eventIdHeaderRetryCalls: Array<{
    path: string;
    status: number;
    eventIdHeader: string;
    body: string;
    bodyEventId: string;
  }>;
  /**
   * Aggregate fan-out outcome of delivering the main
   * report via `deliverSettlementWebhookToMany` to the
   * two loopback endpoints as ONE logical event: 2
   * results in endpoint order, delivered 2 / failed 0 —
   * every endpoint answered 200 on its first attempt.
   */
  eventIdHeaderFanoutResult: DeliverSettlementWebhookToManyResult;
  /**
   * The requests the loopback server captured during the
   * X-Event-Id fan-out, in endpoint order: one per
   * endpoint, each carrying `X-Event-Id` equal to the
   * shared body eventId — the per-endpoint comparison
   * the segment prints.
   */
  eventIdHeaderFanoutCalls: Array<{
    path: string;
    eventIdHeader: string;
    body: string;
    bodyEventId: string;
  }>;
  /**
   * Result of delivering the main escrow's signed webhook
   * alone to {@link DEMO_RETRY_AFTER_DELIVERY_URL} with
   * `deliverSettlementWebhook()`: exactly
   * `{status: 200, attempts: 2}` — the scripted endpoint
   * answered 429 (with the pinned `Retry-After` hint)
   * first, so the delivery succeeded only after the
   * rate-limit retry.
   */
  retryAfterDeliveryResult: WebhookDeliveryResult;
  /**
   * `parseRetryAfter()` on the pinned hint the scripted
   * 429 carried ({@link DEMO_RETRY_AFTER_DELIVERY_HINT}):
   * exactly {@link DEMO_RETRY_AFTER_DELIVERY_HINT_MS} —
   * the hint is genuinely parsed before
   * `maxRetryDelayMs: 0` clamps the wait to zero.
   */
  retryAfterDeliveryHintMs: number | undefined;
  /**
   * The requests the scripted fake fetch captured during
   * the 429 Retry-After delivery, in call order: exactly
   * 2, both POSTs to {@link DEMO_RETRY_AFTER_DELIVERY_URL}
   * with byte-identical bodies (the canonical body of
   * the demo webhook) and the webhook's signature in
   * `x-signature`.
   */
  retryAfterDeliveryCalls: Array<{
    url: string;
    method: string;
    body: string;
    signature: string;
  }>;
  /**
   * True when the `X-Signature` header captured on the
   * re-delivered (successful) attempt verifies over that
   * attempt's captured raw body under the demo secret.
   */
  retryAfterDeliverySignatureVerified: boolean;
  /**
   * The final closing segment's source dedupe, after both
   * fixed ids were recorded twice (new, then duplicate):
   * 2 live entries on the fixed clock.
   */
  dedupeSnapshotSource: SettlementEventDedupe;
  /**
   * `checkAndRecord` verdicts of the source dedupe's
   * first sighting of each fixed id, in fixture order:
   * `[false, false]` — both new events.
   */
  dedupeSnapshotFirst: boolean[];
  /**
   * `checkAndRecord` verdicts of the source dedupe's
   * immediate redelivery of each fixed id, in fixture
   * order: `[true, true]` — both duplicates.
   */
  dedupeSnapshotDuplicate: boolean[];
  /**
   * Snapshot exported from the source dedupe by
   * `exportSnapshot()`: exactly `{v: 1, entries}` with
   * the two fixed ids at their original first-seen
   * timestamp ({@link DEMO_DEDUPE_SNAPSHOT_ENTRIES}).
   */
  dedupeSnapshot: SettlementEventDedupeSnapshot;
  /**
   * The dedupe rebuilt by `SettlementEventDedupe.restore()`
   * from the JSON round-trip of
   * {@link DemoResult.dedupeSnapshot}, after the segment's
   * three probe checks ran on it: both fixed ids read as
   * duplicates and the unseen id was recorded — 3 live
   * entries.
   */
  dedupeSnapshotRestored: SettlementEventDedupe;
  /**
   * `stats()` of the restored dedupe captured immediately
   * after the restore, before any probe check ran on it:
   * exactly `{size: 2, hits: 0, misses: 0, evictions: 0}`
   * — the counters restart at zero even though the
   * recorded ids survive.
   */
  dedupeSnapshotStatsAfterRestore: SettlementEventDedupeStats;
  /**
   * `checkAndRecord` verdicts of the restored dedupe for
   * each fixed id, in fixture order: `[true, true]` —
   * the restart did not reopen the dedupe window.
   */
  dedupeSnapshotRestoredSeen: boolean[];
  /**
   * `checkAndRecord` verdict of the restored dedupe for
   * the never-seen id: `false` — a genuinely new event,
   * recorded by the probe.
   */
  dedupeSnapshotRestoredUnseen: boolean;
  /**
   * Error message of `SettlementEventDedupe.restore()` on
   * a detached copy of the snapshot whose `v` was
   * rewritten to 2: exactly
   * {@link DEMO_DEDUPE_SNAPSHOT_TAMPERED_ERROR}. The
   * exported snapshot object itself still reads `v: 1`.
   */
  dedupeSnapshotTamperedError: string;
  /**
   * The dedupe-clear segment's dedupe, after its final
   * probe ran: the fixed id was re-recorded after the
   * clear — 1 live entry on the fixed clock.
   */
  dedupeClearDedupe: SettlementEventDedupe;
  /**
   * `checkAndRecord` verdict of the clear segment's first
   * sighting of the fixed id: `false` — a new event.
   */
  dedupeClearFirst: boolean;
  /**
   * `checkAndRecord` verdict of the clear segment's
   * immediate redelivery of the fixed id: `true` — a
   * duplicate.
   */
  dedupeClearDuplicate: boolean;
  /**
   * `stats()` of the clear segment's dedupe captured
   * immediately before `clear()`: exactly
   * `{size: 1, hits: 1, misses: 1, evictions: 0}`.
   */
  dedupeClearStatsBefore: SettlementEventDedupeStats;
  /**
   * `stats()` of the clear segment's dedupe captured
   * immediately after `clear()`, before the re-record
   * probe ran: exactly
   * `{size: 0, hits: 0, misses: 0, evictions: 0}` — every
   * recorded id dropped, every counter reset to zero.
   */
  dedupeClearStatsAfterClear: SettlementEventDedupeStats;
  /**
   * `size` of the clear segment's dedupe captured
   * immediately after `clear()`: 0.
   */
  dedupeClearSizeAfterClear: number;
  /**
   * `checkAndRecord` verdict of the clear segment's dedupe
   * for the same fixed id after `clear()`: `false` — the
   * reset made it a new event again, and the probe
   * re-recorded it.
   */
  dedupeClearRerecord: boolean;
  /**
   * `stats()` of the clear segment's dedupe captured after
   * the re-record probe: exactly
   * `{size: 1, hits: 0, misses: 1, evictions: 0}` —
   * counting restarted from zero after the clear.
   */
  dedupeClearStatsAfterRerecord: SettlementEventDedupeStats;
  /**
   * The dedupe-capacity segment's dedupe (maxEntries 3 on
   * a fixed clock), after the segment's six
   * `checkAndRecord` calls: 3 live entries, with the two
   * oldest ids evicted during the segment.
   */
  dedupeCapacityDedupe: SettlementEventDedupe;
  /**
   * `checkAndRecord` verdicts of the capacity segment's
   * six calls, in call order: `[false, true, false,
   * false, false, false]` — the fourth distinct id
   * evicts the oldest, and the evicted id then counts as
   * a new event when seen again (evicting the next
   * oldest).
   */
  dedupeCapacityVerdicts: boolean[];
  /**
   * `stats()` of the capacity segment's dedupe captured
   * after the fifth call (the fourth distinct id,
   * triggering the first eviction): exactly
   * `{size: 3, hits: 1, misses: 4, evictions: 1}`.
   */
  dedupeCapacityStatsAfterEviction: SettlementEventDedupeStats;
  /**
   * `checkAndRecord` verdict of the capacity segment's
   * dedupe for the evicted id after its eviction: `false`
   * — the eviction reopened the window for that id, and
   * the call re-recorded it.
   */
  dedupeCapacityEvictedRerecord: boolean;
  /**
   * `stats()` of the capacity segment's dedupe captured
   * after the final call: exactly
   * `{size: 3, hits: 1, misses: 5, evictions: 2}` —
   * capacity stayed 3, the two oldest ids were evicted.
   */
  dedupeCapacityStatsFinal: SettlementEventDedupeStats;
  /**
   * Error message of constructing a
   * `SettlementEventDedupe` with `maxEntries: 0`:
   * exactly
   * {@link DEMO_DEDUPE_CAPACITY_INVALID_MAX_ENTRIES_ERROR}.
   */
  dedupeCapacityInvalidMaxEntriesError: string;
  /**
   * The final closing segment's branch escrow
   * ({@link DEMO_ONERROR_ESCROW_ID}), after its three
   * fixed dispatches ran under a throwing listener:
   * VERIFIED with 3 history entries — no dispatch failed.
   */
  onErrorEscrow: Escrow;
  /**
   * Reports the collecting `onError` received, in dispatch
   * order: exactly {@link DEMO_ONERROR_EXPECTED_REPORTS} —
   * one per dispatch, each carrying the pinned listener
   * error message and that dispatch's context.
   */
  onErrorReports: Array<{
    message: string;
    event: EscrowEvent;
    from: EscrowState;
    to: EscrowState;
  }>;
  /**
   * The final closing segment's probe escrow
   * ({@link DEMO_ONERROR_PROBE_ESCROW_ID}), whose
   * `onError` itself throws: still FUNDED with 1 history
   * entry after its single fixed dispatch.
   */
  onErrorProbeEscrow: Escrow;
  /**
   * State returned by the probe escrow's FUND dispatch:
   * `"FUNDED"` — a throwing `onError` is swallowed too.
   */
  onErrorProbeState: EscrowState;
  /**
   * Error message of subscribing with a non-function
   * `onError` on the branch escrow: exactly
   * {@link DEMO_ONERROR_INVALID_ERROR}. Nothing was
   * registered — the branch escrow's `listenerCount`
   * still reads 1.
   */
  onErrorInvalidError: string;
  /**
   * The final closing segment's fresh quorum (2-of-3, same
   * signer ids as the dispute quorum), after the revoke /
   * re-approve cycle and both failed revoke probes:
   * approvalCount 2, hasQuorum true, approvals exactly
   * [arb-2, arb-1].
   */
  quorumRevokeQuorum: Quorum;
  /** Counted approvals before the revoke: 2 — threshold reached. */
  quorumRevokeCountBefore: number;
  /** `hasQuorum()` before the revoke: `true`. */
  quorumRevokeHasQuorumBefore: boolean;
  /** Counted approvals after arb-1 revokes: 1 — below threshold. */
  quorumRevokeCountAfterRevoke: number;
  /** `hasQuorum()` after the revoke: `false`. */
  quorumRevokeHasQuorumAfterRevoke: boolean;
  /**
   * `approvals()` after the revoke: exactly [arb-2]; the
   * audit trail likewise keeps only arb-2's entry
   * ({@link DEMO_REVOKE_LOG_AFTER_REVOKE}).
   */
  quorumRevokeApprovalsAfterRevoke: readonly string[];
  /** Counted approvals after arb-1 re-approves: 2 — threshold restored. */
  quorumRevokeCountAfterReapprove: number;
  /** `hasQuorum()` after the re-approval: `true`. */
  quorumRevokeHasQuorumAfterReapprove: boolean;
  /**
   * `approvals()` after the re-approval: exactly
   * [arb-2, arb-1] — the re-voter sorts last, by latest
   * approval.
   */
  quorumRevokeApprovalsAfterReapprove: readonly string[];
  /**
   * `approvalLog()` after the re-approval: exactly
   * {@link DEMO_REVOKE_LOG_FINAL} — arb-2's original entry
   * plus arb-1's fresh re-approval entry.
   */
  quorumRevokeLogFinal: ReadonlyArray<ApprovalLogEntry>;
  /**
   * Error message of revoking the unknown signer
   * {@link DEMO_REVOKE_UNKNOWN_SIGNER}: exactly
   * {@link DEMO_REVOKE_UNKNOWN_ERROR}.
   */
  quorumRevokeUnknownError: string;
  /**
   * Error message of revoking arb-3, a signer that never
   * approved: exactly {@link DEMO_REVOKE_NOT_APPROVED_ERROR}.
   */
  quorumRevokeNotApprovedError: string;
  /**
   * Error message of delivering with an already-aborted
   * signal: exactly {@link DEMO_ABORT_ERROR}.
   */
  abortPreAbortedError: string;
  /**
   * Fake-fetch call count of the pre-aborted delivery:
   * exactly 0 — the abort lands before any attempt.
   */
  abortPreAbortedFetchCalls: number;
  /**
   * Error message of the delivery aborted during its
   * backoff sleep: exactly {@link DEMO_ABORT_ERROR}.
   */
  abortDuringBackoffError: string;
  /**
   * Fake-fetch call count of the backoff-aborted
   * delivery: exactly 1 — the first (500) attempt stands
   * and no retry fires after the abort.
   */
  abortDuringBackoffFetchCalls: number;
  /**
   * The final closing segment's branch escrow
   * (DEMO-ESC-016), after the guarded chain and the
   * unguarded VERIFY_PASS: VERIFIED with 3 history
   * entries.
   */
  expectedSeqEscrow: Escrow;
  /**
   * State returned by the guarded FUND dispatch
   * (`expectedSeq: 0` on the empty history): `"FUNDED"`.
   */
  expectedSeqFundState: EscrowState;
  /** History length after the guarded FUND: exactly 1 (seq 0 -> 1). */
  expectedSeqSeqAfterFund: number;
  /**
   * State returned by the guarded SUBMIT_MILESTONE
   * dispatch (`expectedSeq: 1`): `"MILESTONE_SUBMITTED"`.
   */
  expectedSeqSubmitState: EscrowState;
  /** History length after the guarded SUBMIT_MILESTONE: exactly 2. */
  expectedSeqSeqAfterSubmit: number;
  /**
   * Error message of the stale VERIFY_PASS retry
   * (`expectedSeq: 1` at seq 2): exactly
   * {@link DEMO_EXPECTED_SEQ_STALE_ERROR}.
   */
  expectedSeqStaleError: string;
  /**
   * The branch escrow's state after the stale retry:
   * `"MILESTONE_SUBMITTED"` — the conflict changed
   * nothing.
   */
  expectedSeqStateAfterStale: EscrowState;
  /**
   * The branch escrow's history length after the stale
   * retry: exactly 2 — nothing was appended.
   */
  expectedSeqHistoryLengthAfterStale: number;
  /**
   * Error message of the negative-guard probe
   * (`expectedSeq: -1`): exactly
   * {@link DEMO_EXPECTED_SEQ_INVALID_NEGATIVE_ERROR}.
   */
  expectedSeqInvalidNegativeError: string;
  /**
   * Error message of the non-integer-guard probe
   * (`expectedSeq: 1.5`): exactly
   * {@link DEMO_EXPECTED_SEQ_INVALID_FRACTION_ERROR}.
   */
  expectedSeqInvalidFractionError: string;
  /**
   * State returned by the final VERIFY_PASS dispatched
   * with NO `expectedSeq`: `"VERIFIED"` — omitting the
   * guard preserves the pre-guard behavior.
   */
  expectedSeqUnguardedState: EscrowState;
  /** Final history length of the branch escrow: exactly 3. */
  expectedSeqFinalHistoryLength: number;
  /**
   * The final closing segment's strict branch escrow
   * (DEMO-ESC-017, `requireVerifyEvidence: true`), after
   * the rejected evidence-free VERIFY_PASS and the
   * accepted evidence-carrying one: VERIFIED with 3
   * history entries, the last carrying the pinned
   * evidence reference verbatim.
   */
  verifyEvidenceEscrow: Escrow;
  /**
   * Error message of the evidence-free VERIFY_PASS on
   * the strict escrow: exactly
   * {@link DEMO_VERIFY_EVIDENCE_ERROR}.
   */
  verifyEvidenceError: string;
  /**
   * The strict escrow's state after the rejection:
   * `"MILESTONE_SUBMITTED"` — the gate changed nothing.
   */
  verifyEvidenceStateAfterReject: EscrowState;
  /**
   * The strict escrow's history length after the
   * rejection: exactly 2 — nothing was appended.
   */
  verifyEvidenceHistoryLengthAfterReject: number;
  /**
   * State returned by the VERIFY_PASS dispatched with
   * the pinned evidence reference: `"VERIFIED"`.
   */
  verifyEvidenceVerifiedState: EscrowState;
  /**
   * The evidence recorded verbatim on the strict
   * escrow's VERIFY_PASS audit entry: exactly
   * {@link DEMO_VERIFY_EVIDENCE_REF}.
   */
  verifyEvidenceRecordedEvidence: string;
  /**
   * The default branch escrow (DEMO-ESC-018, flag off),
   * after its evidence-free VERIFY_PASS: VERIFIED with
   * 3 history entries, the last carrying no evidence
   * field — the pre-gate behavior.
   */
  verifyEvidenceDefaultEscrow: Escrow;
  /**
   * State returned by the default escrow's
   * evidence-free VERIFY_PASS: `"VERIFIED"`.
   */
  verifyEvidenceDefaultState: EscrowState;
  /**
   * The final closing segment's keyed branch escrow
   * (DEMO-ESC-019, `auditKey` set), after the full
   * lifecycle: RELEASED with 4 history entries, every
   * hash an HMAC-SHA256 link under the pinned key.
   */
  auditKeyEscrow: Escrow;
  /**
   * `verifyHistoryChain` verdict on the keyed history
   * under the correct key ({@link DEMO_AUDIT_KEY}):
   * `true` — every HMAC link recomputes.
   */
  auditKeyChainVerified: boolean;
  /**
   * `verifyHistoryChain` verdict on the keyed history
   * under the wrong key ({@link DEMO_AUDIT_WRONG_KEY}):
   * `false` — fail-closed.
   */
  auditKeyWrongKeyVerified: boolean;
  /**
   * `verifyHistoryChain` verdict on the keyed history
   * with NO key: `false` — a keyed chain never
   * verifies keylessly; the two modes fail closed
   * against each other.
   */
  auditKeyNoKeyVerified: boolean;
  /**
   * `verifyHistoryChain` verdict, under the correct
   * key, on a detached copy whose middle
   * (SUBMIT_MILESTONE) entry's note was rewritten:
   * `false` — the stored HMAC no longer recomputes,
   * even for the key holder. The escrow's own history
   * is untouched by the tamper.
   */
  auditKeyTamperedVerified: boolean;
  /** The rewritten note on the tampered copy. */
  auditKeyTamperedNote: string;
  /** History length of the keyed escrow: exactly 4. */
  auditKeyHistoryLength: number;
  /**
   * Error message of delivering the main webhook to a
   * hanging endpoint with `timeoutMs`
   * {@link DEMO_TIMEOUT_MS} and `retries: 0`: exactly
   * {@link DEMO_TIMEOUT_DELIVERY_ERROR} — the pinned
   * per-attempt timeout text as the last cause after
   * exactly 1 attempt.
   */
  timeoutDeliveryError: string;
  /**
   * Hanging fake-fetch call count of the timed-out
   * delivery: exactly 1 — one attempt, no retries.
   */
  timeoutDeliveryFetchCalls: number;
  /**
   * Error message of delivering with `timeoutMs: 0`:
   * exactly {@link DEMO_TIMEOUT_INVALID_ERROR} — a caller
   * configuration error, thrown before any request.
   */
  timeoutInvalidError: string;
  /**
   * Fake-fetch call count of the illegal-timeout
   * delivery: exactly 0 — validation precedes fetching.
   */
  timeoutInvalidFetchCalls: number;
  /**
   * Result of delivering with the generous
   * {@link DEMO_TIMEOUT_GENEROUS_MS} timeout to an
   * immediately-200 fake: exactly
   * `{status: 200, attempts: 1}` — the unchanged success
   * shape.
   */
  timeoutOkResult: WebhookDeliveryResult;
  /**
   * Fake-fetch call count of the generous-timeout
   * delivery: exactly 1.
   */
  timeoutOkFetchCalls: number;
  /**
   * Result of delivering the main escrow's signed webhook
   * to the loopback retry endpoint with
   * `deliverSettlementWebhook()`: exactly
   * `{status: 200, attempts: 2}` — the loopback endpoint
   * answered 500 first, so the delivery succeeded only
   * after one genuine HTTP retry.
   */
  idempotencyHeaderRetryResult: WebhookDeliveryResult;
  /**
   * The requests the loopback server captured during the
   * Idempotency-Key retry delivery, in attempt order:
   * exactly 2, each carrying `Idempotency-Key` and
   * `X-Event-Id` both equal to the main webhook's body
   * eventId, with the raw body and its parsed eventId
   * alongside for the header/body comparison the
   * segment prints.
   */
  idempotencyHeaderRetryCalls: Array<{
    path: string;
    status: number;
    idempotencyKeyHeader: string;
    eventIdHeader: string;
    body: string;
    bodyEventId: string;
  }>;
  /**
   * The `FeeBreakdown` of the portfolio golden vector
   * (pool 10000, base 600, multiplier 1.0x, loyalty 30,
   * oracle 60): `adjustedBaseFee` 600, `deposit` 10630 —
   * the intermediate the deposit preview line inlines as
   * a bare product, shown here field by field.
   */
  depositBreakdown: FeeBreakdown;
  /**
   * The pinned `FeeInputs` of the fractional-multiplier
   * vector: base 599.99 × 1.25 — raw product 749.9875 —
   * exercising the `round2` rounding on the intermediate.
   */
  fractionalFeeInputs: FeeInputs;
  /**
   * The `FeeBreakdown` of the fractional vector:
   * `adjustedBaseFee` 749.99, `deposit` 10779.99.
   */
  fractionalDepositBreakdown: FeeBreakdown;
  /**
   * The pinned rejection when the fan-out limit demo calls
   * `deliverSettlementWebhookToMany` with 3 endpoints under
   * `maxEndpoints: 2`: exactly
   * {@link DEMO_FANOUT_LIMIT_CAP_ERROR} - the cap throws
   * before any request, so the loopback server records 0
   * requests.
   */
  fanoutLimitCapError: string;
  /**
   * Aggregate fan-out outcome of delivering the main report
   * via `deliverSettlementWebhookToMany` to a fast and a
   * hanging loopback endpoint under
   * `overallDeadlineMs: 100`: 2 results in endpoint order,
   * delivered 1 / failed 1, `deadlineExceeded: true` - the
   * fast endpoint keeps `{ok: true, attempts: 1, status:
   * 200}` and the hanging endpoint reports the pinned
   * deadline error.
   */
  fanoutLimitDeadlineResult: DeliverSettlementWebhookToManyResult;
  /**
   * The requests the loopback server captured during the
   * fan-out limit segment, in arrival order: exactly 0 for
   * the over-cap call, then exactly 1 fast and 1 hanging
   * request for the deadline call.
   */
  fanoutLimitCalls: Array<{ path: string }>;
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

  // --- Fee breakdown: the adjustedBaseFee intermediate (payments) ---
  // The preview line above inlines `base × multiplier` as a bare
  // product, but the README's fee formula names the rounded
  // intermediate `adjustedBaseFee = round2(baseFee ×
  // complexityMultiplier)` (src/feeCalculator.ts) and the reader can
  // never match the README formula to the breakdown's fields one by
  // one from the preview alone. This segment calls `calculateDeposit`
  // twice: the portfolio golden vector (multiplier 1.0x, no rounding
  // exercised) and a pinned fractional-multiplier vector (1.25x, raw
  // product 599.99 × 1.25 = 749.9875, so `round2` actually rounds).
  // Hand-pinned expectations (see the fixture comment above),
  // asserted HERE, outside the printing: the golden breakdown's
  // `adjustedBaseFee` is exactly 600 and its `deposit` is exactly the
  // sum of its components (10630); the fractional breakdown's
  // `adjustedBaseFee` is exactly 749.99 and its `deposit` is exactly
  // the sum of its components (10779.99) — a changed formula, a
  // rounding regression, or an input drift would fail the demo
  // itself, not just a test. All inputs pinned, no wall clock, no
  // randomness, no network.
  const fractionalFees = calculateDeposit(DEMO_FEE_FRACTIONAL_INPUTS);
  if (
    fees.adjustedBaseFee !== DEMO_FEE_GOLDEN_ADJUSTED_BASE_FEE ||
    fees.deposit !== DEMO_FEE_GOLDEN_DEPOSIT ||
    fees.creatorPool +
      fees.adjustedBaseFee -
      fees.loyaltyDiscount +
      fees.oracleFee !==
      fees.deposit ||
    fractionalFees.adjustedBaseFee !== DEMO_FEE_FRACTIONAL_ADJUSTED_BASE_FEE ||
    fractionalFees.deposit !== DEMO_FEE_FRACTIONAL_DEPOSIT ||
    fractionalFees.creatorPool +
      fractionalFees.adjustedBaseFee -
      fractionalFees.loyaltyDiscount +
      fractionalFees.oracleFee !==
      fractionalFees.deposit
  ) {
    throw new Error(
      "demo fixture broken: calculateDeposit fee breakdown does not match the pinned shape (golden adjustedBaseFee 600 with deposit 10630 as the exact components sum; fractional 1.25x adjustedBaseFee 749.99 with deposit 10779.99 as the exact components sum)",
    );
  }
  lines.push(
    "",
    "Fee breakdown (calculateDeposit adjustedBaseFee — the intermediate the preview line inlines as a bare product):",
    `  golden 1.0x: inputs { pool ${fees.creatorPool}, base ${fees.baseFee}, mult ${fees.complexityMultiplier}, loyalty ${fees.loyaltyDiscount}, oracle ${fees.oracleFee} } -> adjustedBaseFee = round2(600 × 1) = ${fees.adjustedBaseFee}; deposit = round2(${fees.creatorPool} + ${fees.adjustedBaseFee} − ${fees.loyaltyDiscount} + ${fees.oracleFee}) = ${fees.deposit} (equals the components sum, exactly)`,
    `  fractional 1.25x: inputs { pool ${fractionalFees.creatorPool}, base ${fractionalFees.baseFee}, mult ${fractionalFees.complexityMultiplier}, loyalty ${fractionalFees.loyaltyDiscount}, oracle ${fractionalFees.oracleFee} } -> raw 599.99 × 1.25 = 749.9875, round2 -> adjustedBaseFee = ${fractionalFees.adjustedBaseFee}; deposit = round2(${fractionalFees.creatorPool} + ${fractionalFees.adjustedBaseFee} − ${fractionalFees.loyaltyDiscount} + ${fractionalFees.oracleFee}) = ${fractionalFees.deposit} (equals the components sum, exactly)`,
  );

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

  // --- Settlement report as CSV: renderReportCsv ---
  // The prose report above is for humans; a bookkeeping import must
  // never have to parse it. The same released report renders as CSV
  // next to it, so a caller sees the header, the fixed party row
  // order, and the TOTAL summary row in one place. The demo asserts the
  // CSV's own shape before printing it: the header verbatim, one row
  // per party plus header and TOTAL, and a TOTAL row whose three
  // money columns equal the report's totals (inflow/outflow) and the
  // party nets' sum — a mismatch fails the demo outright instead of
  // printing a plausible-looking but inconsistent export.
  const reportCsv = renderReportCsv(report);
  const reportCsvLines = reportCsv.split("\n");
  const reportCsvTotal = reportCsvLines[reportCsvLines.length - 1].split(",");
  const reportCsvNetSum =
    Math.round(report.parties.reduce((sum, p) => sum + p.net, 0) * 100) / 100;
  if (
    reportCsvLines[0] !== "escrowId,outcome,role,inflow,outflow,net" ||
    reportCsvLines.length !== report.parties.length + 2 ||
    reportCsvTotal[2] !== "TOTAL" ||
    reportCsvTotal[3] !== report.totalInflow.toFixed(2) ||
    reportCsvTotal[4] !== report.totalOutflow.toFixed(2) ||
    reportCsvTotal[5] !== reportCsvNetSum.toFixed(2)
  ) {
    throw new Error(
      "demo fixture broken: renderReportCsv on the main settlement report does not match the pinned shape (header escrowId,outcome,role,inflow,outflow,net, one row per party, and a TOTAL row summing the party rows to the report totals)",
    );
  }
  lines.push(
    "",
    "Settlement report as CSV (renderReportCsv — the same released report, for bookkeeping imports):",
    ...reportCsvLines.map((line) => `  ${line}`),
    `  TOTAL row check: inflow ${reportCsvTotal[3]} = report totalInflow ${report.totalInflow.toFixed(2)}, outflow ${reportCsvTotal[4]} = report totalOutflow ${report.totalOutflow.toFixed(2)}, net ${reportCsvTotal[5]} = party nets sum ${reportCsvNetSum.toFixed(2)} (the CSV sums its own party rows — an importer reads columns, never the prose report above)`,
  );

  // --- Settlement report as JSON: renderReportJson ---
  // The CSV above is for spreadsheet imports; an API or database wants
  // the same report as typed JSON instead. The JSON form carries exactly
  // the report's fields with amounts as numbers — a consumer parses
  // 10098.5, never the string "10098.50" — and the shape check fails
  // fast on a malformed report rather than serializing a non-finite
  // amount as null. The demo asserts both properties before printing:
  // the parsed JSON matches the report field for field with every money
  // figure a number, and a copy with totalInflow set to Infinity is
  // rejected with the pinned `cannot render settlement report as
  // JSON: …` message (the backlog item's shorter quoted wording is
  // stale; the real #579 message carries the full function name).
  const reportJson = renderReportJson(report);
  const parsedReport = JSON.parse(reportJson) as Record<string, unknown>;
  const parsedParties = parsedReport.parties as Array<Record<string, unknown>>;
  const parsedDeposit = parsedReport.deposit as Record<string, unknown>;
  const amountsAreNumbers =
    typeof parsedDeposit.deposit === "number" &&
    Array.isArray(parsedParties) &&
    parsedParties.length === report.parties.length &&
    parsedParties.every(
      (p) =>
        typeof p.inflow === "number" &&
        typeof p.outflow === "number" &&
        typeof p.net === "number",
    ) &&
    typeof parsedReport.totalInflow === "number" &&
    typeof parsedReport.totalOutflow === "number";
  let illegalReportError = "";
  try {
    renderReportJson({ ...report, totalInflow: Number.POSITIVE_INFINITY });
  } catch (error) {
    illegalReportError = error instanceof Error ? error.message : String(error);
  }
  if (
    parsedReport.escrowId !== report.escrowId ||
    parsedReport.outcome !== report.outcome ||
    !amountsAreNumbers ||
    JSON.stringify(parsedReport) !== reportJson ||
    !illegalReportError.startsWith("cannot render settlement report as JSON: ")
  ) {
    throw new Error(
      "demo fixture broken: renderReportJson on the main settlement report does not match the pinned shape (parsed JSON equals the report with amounts as numbers, and a non-finite totalInflow is rejected with 'cannot render settlement report as JSON: …')",
    );
  }
  lines.push(
    "",
    "Settlement report as JSON (renderReportJson — the same released report, for APIs and storage):",
    `  ${reportJson}`,
    `  amounts are JSON numbers, not CSV strings: deposit ${parsedDeposit.deposit}, totalInflow ${parsedReport.totalInflow} (a consumer parses numbers, never two-decimal strings)`,
    `  illegal report rejected: totalInflow Infinity -> "${illegalReportError}" (the shape check fails fast instead of serializing Infinity as null)`,
  );

  // --- Settlement report as JSON, imported back: parseSettlementReportJson ---
  // The JSON above is the export side; a caller that stored it must be
  // able to read it back without hand-writing a parser per field. The
  // import side applies exactly the same shape check in the other
  // direction, so the demo asserts the full round-trip before printing
  // it: parsing the exported JSON yields a report deep-equal to the
  // original that re-renders byte-identically, and a damaged copy with
  // the `parties` field removed is rejected with the pinned
  // `cannot parse settlement report JSON: parties must be a non-empty
  // array` message — a party-less document never becomes a
  // plausible-looking report. The import is structural validation only,
  // not a re-verification of the audit chain (that stays with
  // verifyHistoryChain below); a hand-built document with internally
  // consistent fields would parse, and the demo does not pretend
  // otherwise.
  const importedReport = parseSettlementReportJson(reportJson);
  const importedReportJson = renderReportJson(importedReport);
  const damagedParsed = JSON.parse(reportJson) as Record<string, unknown>;
  delete damagedParsed.parties;
  const damagedReportJson = JSON.stringify(damagedParsed);
  let damagedReportError = "";
  try {
    parseSettlementReportJson(damagedReportJson);
  } catch (error) {
    damagedReportError = error instanceof Error ? error.message : String(error);
  }
  if (
    JSON.stringify(importedReport) !== reportJson ||
    importedReportJson !== reportJson ||
    damagedReportError !==
      "cannot parse settlement report JSON: parties must be a non-empty array"
  ) {
    throw new Error(
      "demo fixture broken: parseSettlementReportJson on the main settlement report does not match the pinned shape (parsed JSON deep-equals the report and re-renders byte-identically, and a copy with the parties field missing is rejected with 'cannot parse settlement report JSON: parties must be a non-empty array')",
    );
  }
  lines.push(
    "",
    "Settlement report as JSON, imported back (parseSettlementReportJson — the same released report, read back from storage):",
    `  round-trip: parseSettlementReportJson(reportJson) deep-equals the report and re-renders byte-identically (escrowId ${importedReport.escrowId}, outcome ${importedReport.outcome})`,
    `  damaged JSON rejected: parties field missing -> "${damagedReportError}" (the import fails fast instead of returning a party-less report)`,
  );

  // --- Settlement report as CSV, imported back: parseSettlementReportCsv ---
  // The CSV above is the export side; a bookkeeping importer that
  // received it must be able to read it back without hand-writing a
  // CSV parser per row. The import side applies the same shape check
  // in the other direction, so the demo asserts the full round-trip
  // before printing it: parsing the exported CSV yields the
  // CSV-carried subset (escrowId, outcome, the four party ledgers,
  // the TOTAL row's totals, `balanced`) whose party ledgers match the
  // report's field for field and which re-renders byte-identically —
  // and a damaged copy whose TOTAL inflow is 1 higher than the
  // party-row sum is rejected with the pinned `cannot parse
  // settlement report CSV: TOTAL row inflow …` message, so a
  // self-inconsistent export never becomes a plausible-looking
  // import. The honest limit is printed, not hidden: the CSV never
  // carried the deposit breakdown, settlement parameters,
  // `releasePath`, `eventCount`, or audit window, so the import does
  // not reconstruct them — and, as with the JSON import, the import
  // is structural validation only, not a re-verification of the audit
  // chain (that stays with verifyHistoryChain below); a hand-built
  // CSV with internally consistent rows would parse, and the demo
  // does not pretend otherwise.
  const importedReportCsv = parseSettlementReportCsv(reportCsv);
  const importedReportCsvText = renderReportCsv(importedReportCsv);
  const damagedCsvLines = reportCsv.split("\n");
  const damagedCsvTotal = damagedCsvLines[damagedCsvLines.length - 1].split(",");
  damagedCsvTotal[3] = "10631.00";
  damagedCsvLines[damagedCsvLines.length - 1] = damagedCsvTotal.join(",");
  const damagedReportCsv = damagedCsvLines.join("\n");
  let damagedReportCsvError = "";
  try {
    parseSettlementReportCsv(damagedReportCsv);
  } catch (error) {
    damagedReportCsvError =
      error instanceof Error ? error.message : String(error);
  }
  const importedCsvPartiesMatch =
    importedReportCsv.parties.length === report.parties.length &&
    importedReportCsv.parties.every(
      (p, i) =>
        p.party === report.parties[i].party &&
        p.inflow === report.parties[i].inflow &&
        p.outflow === report.parties[i].outflow &&
        p.net === report.parties[i].net,
    );
  if (
    importedReportCsv.escrowId !== report.escrowId ||
    importedReportCsv.outcome !== report.outcome ||
    !importedCsvPartiesMatch ||
    importedReportCsv.totalInflow !== report.totalInflow ||
    importedReportCsv.totalOutflow !== report.totalOutflow ||
    importedReportCsv.balanced !== true ||
    importedReportCsvText !== reportCsv ||
    damagedReportCsvError !==
      "cannot parse settlement report CSV: TOTAL row inflow 10631 does not equal the sum over party rows 10630"
  ) {
    throw new Error(
      "demo fixture broken: parseSettlementReportCsv on the main settlement report does not match the pinned shape (parsed CSV subset matches the report's carried fields and re-renders byte-identically, and a copy with a TOTAL row inconsistent with the party rows is rejected with 'cannot parse settlement report CSV: TOTAL row inflow 10631 does not equal the sum over party rows 10630')",
    );
  }
  lines.push(
    "",
    "Settlement report as CSV, imported back (parseSettlementReportCsv — the same released report, read back from a bookkeeping import):",
    `  round-trip: parseSettlementReportCsv(reportCsv) recovers the CSV-carried subset and re-renders byte-identically (escrowId ${importedReportCsv.escrowId}, outcome ${importedReportCsv.outcome}, ${importedReportCsv.parties.length} party rows, TOTAL ${importedReportCsv.totalInflow.toFixed(2)}/${importedReportCsv.totalOutflow.toFixed(2)}, balanced ${importedReportCsv.balanced})`,
    `  carried fields only: the deposit breakdown, settlement parameters, releasePath, eventCount and audit window are not in the CSV and are not reconstructed (the import is structural validation, not a re-verification of the audit chain)`,
    `  damaged CSV rejected: TOTAL inflow 10631.00 against party-row sum 10630.00 -> "${damagedReportCsvError}" (the import fails fast instead of returning a self-inconsistent report)`,
  );

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

  // --- Webhook freshness window: the opt-in replay bound ---
  // The signature check above proves authenticity, but a captured
  // authentic notification could be replayed later. The opt-in
  // freshness window is the receiver's replay bound: with
  // `maxAgeMs` set, verification additionally requires the
  // payload's `at` to sit inside the window ending at the injected
  // `now` — the boundary is inclusive (only `now - at > maxAgeMs`
  // fails). The main webhook's body bytes and signature are reused
  // verbatim at three injected instants (inside / boundary /
  // expired), and a fourth call bounds the other direction: with
  // `now` 10 minutes before `at`, the sender's clock reads ahead
  // by more than the 5-minute `maxFutureSkewMs`, so that call
  // fails too. All four verdicts are asserted outside the printing.
  const webhookBody = JSON.stringify(webhook.payload);
  const webhookFreshnessOpts = {
    secrets: [DEMO_WEBHOOK_SECRET],
    maxAgeMs: DEMO_WEBHOOK_FRESHNESS_MAX_AGE_MS,
  };
  const webhookFreshnessWithinWindow = verifySettlementWebhook(
    webhookBody,
    webhook.signature,
    { ...webhookFreshnessOpts, now: DEMO_WEBHOOK_FRESHNESS_WITHIN_NOW_MS },
  );
  const webhookFreshnessBoundary = verifySettlementWebhook(
    webhookBody,
    webhook.signature,
    { ...webhookFreshnessOpts, now: DEMO_WEBHOOK_FRESHNESS_BOUNDARY_NOW_MS },
  );
  const webhookFreshnessExpired = verifySettlementWebhook(
    webhookBody,
    webhook.signature,
    { ...webhookFreshnessOpts, now: DEMO_WEBHOOK_FRESHNESS_EXPIRED_NOW_MS },
  );
  const webhookFreshnessFutureSkewExceeded = verifySettlementWebhook(
    webhookBody,
    webhook.signature,
    {
      secrets: [DEMO_WEBHOOK_SECRET],
      maxFutureSkewMs: DEMO_WEBHOOK_FRESHNESS_MAX_FUTURE_SKEW_MS,
      now: DEMO_WEBHOOK_FRESHNESS_FUTURE_NOW_MS,
    },
  );
  if (
    webhookFreshnessWithinWindow !== true ||
    webhookFreshnessBoundary !== true ||
    webhookFreshnessExpired !== false ||
    webhookFreshnessFutureSkewExceeded !== false
  ) {
    throw new Error(
      "demo fixture broken: webhook freshness window does not match the pinned shape (inside the 1-hour maxAgeMs window and at its inclusive boundary the main webhook verifies; past the window and beyond the 5-minute future-skew bound the same signed body is refused)",
    );
  }
  lines.push(
    "",
    "Webhook freshness window (verifySettlementWebhook maxAgeMs / maxFutureSkewMs on the main webhook, injected now):",
    `  payload at ${webhook.payload.at}, maxAgeMs ${DEMO_WEBHOOK_FRESHNESS_MAX_AGE_MS} ms: now at +${DEMO_WEBHOOK_FRESHNESS_WITHIN_NOW_MS - DEMO_DEDUPE_START_MS} ms — verifySettlementWebhook: ${webhookFreshnessWithinWindow} (signature valid and inside the window)`,
    `  boundary: now at exactly +${DEMO_WEBHOOK_FRESHNESS_BOUNDARY_NOW_MS - DEMO_DEDUPE_START_MS} ms = maxAgeMs — verifySettlementWebhook: ${webhookFreshnessBoundary} (inclusive boundary — only a larger age fails)`,
    `  expired: now at +${DEMO_WEBHOOK_FRESHNESS_EXPIRED_NOW_MS - DEMO_DEDUPE_START_MS} ms — verifySettlementWebhook: ${webhookFreshnessExpired} (signature still valid, but the replay window has closed — fail-closed)`,
    `  sender clock ahead: payload at is ${DEMO_DEDUPE_START_MS - DEMO_WEBHOOK_FRESHNESS_FUTURE_NOW_MS} ms ahead of now, maxFutureSkewMs ${DEMO_WEBHOOK_FRESHNESS_MAX_FUTURE_SKEW_MS} ms — verifySettlementWebhook: ${webhookFreshnessFutureSkewExceeded} (future skew beyond the bound)`,
  );

  // --- Webhook secret rotation: the { secrets: [new, old] } window ---
  // Freshness bounds WHEN a signed notification may be replayed;
  // rotation is the receiver's other operational move: rolling the
  // HMAC secret without dropping notifications signed just before
  // the roll. The main webhook above is signed with
  // DEMO_WEBHOOK_SECRET, which plays the OLD secret here. Two twins
  // are built over the identical payload (same fixed now/eventId,
  // so the body bytes are byte-identical and only the signature
  // differs): one signed with the rotated-in NEW secret, one with
  // an UNRELATED secret. Under the candidate set
  // `{ secrets: [new, old] }` the old-signed and new-signed bodies
  // both verify (the first matching candidate wins), the
  // unrelated-signed body returns false without throwing
  // (all-mismatch fails closed), and an empty candidate set throws
  // the pinned configuration error instead of silently passing.
  // All four shapes are asserted outside the printing.
  const webhookRotationOpts = {
    secrets: [DEMO_WEBHOOK_ROTATION_NEW_SECRET, DEMO_WEBHOOK_SECRET],
  };
  const webhookRotationOldVerified = verifySettlementWebhook(
    webhookBody,
    webhook.signature,
    webhookRotationOpts,
  );
  const webhookRotationNewWebhook = buildSettlementWebhook(report, {
    secret: DEMO_WEBHOOK_ROTATION_NEW_SECRET,
    now: DEMO_WEBHOOK_AT,
    eventId: DEMO_WEBHOOK_EVENT_ID,
  });
  const webhookRotationNewVerified = verifySettlementWebhook(
    JSON.stringify(webhookRotationNewWebhook.payload),
    webhookRotationNewWebhook.signature,
    webhookRotationOpts,
  );
  const webhookRotationUnrelatedWebhook = buildSettlementWebhook(report, {
    secret: DEMO_WEBHOOK_ROTATION_UNRELATED_SECRET,
    now: DEMO_WEBHOOK_AT,
    eventId: DEMO_WEBHOOK_EVENT_ID,
  });
  const webhookRotationUnrelatedVerified = verifySettlementWebhook(
    JSON.stringify(webhookRotationUnrelatedWebhook.payload),
    webhookRotationUnrelatedWebhook.signature,
    webhookRotationOpts,
  );
  let webhookRotationEmptySecretsError = "";
  try {
    verifySettlementWebhook(webhookBody, webhook.signature, { secrets: [] });
  } catch (err) {
    webhookRotationEmptySecretsError =
      err instanceof Error ? err.message : String(err);
  }
  if (
    JSON.stringify(webhookRotationNewWebhook.payload) !== webhookBody ||
    JSON.stringify(webhookRotationUnrelatedWebhook.payload) !== webhookBody ||
    webhookRotationNewWebhook.signature === webhook.signature ||
    webhookRotationUnrelatedWebhook.signature === webhook.signature ||
    webhookRotationOldVerified !== true ||
    webhookRotationNewVerified !== true ||
    webhookRotationUnrelatedVerified !== false ||
    webhookRotationEmptySecretsError !==
      DEMO_WEBHOOK_ROTATION_EMPTY_SECRETS_ERROR
  ) {
    throw new Error(
      "demo fixture broken: webhook secret rotation does not match the pinned shape (the old-signed and new-signed bodies verify under { secrets: [new, old] }, the unrelated-signed body is refused without throwing, and an empty secrets array throws the pinned configuration error)",
    );
  }
  lines.push(
    "",
    "Webhook secret rotation (verifySettlementWebhook { secrets: [new, old] } on the main webhook):",
    `  signed with the old secret (the main webhook): verifySettlementWebhook { secrets: [new, old] }: ${webhookRotationOldVerified} (the old secret still verifies inside the rotation window)`,
    `  signed with the new secret (identical payload, same fixed at / eventId): verifySettlementWebhook { secrets: [new, old] }: ${webhookRotationNewVerified} (the rotated-in secret verifies too)`,
    `  signed with an unrelated secret: verifySettlementWebhook { secrets: [new, old] }: ${webhookRotationUnrelatedVerified} (no candidate matches — fail-closed, returns false without throwing)`,
    `  empty candidate set: verifySettlementWebhook { secrets: [] } throws "${webhookRotationEmptySecretsError}" (a caller configuration error, never a silent pass)`,
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
  // FUNDED escrow after it, which expires. (The executor pins the
  // fixed screening `now` as each EXPIRE entry's `at`, so no wall
  // clock enters the audit history; see the fixture comment.)
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
  // Backlog #615 self-check: a successful result's `entry` must be
  // exactly the escrow history's last entry (the EXPIRE record just
  // appended, stamped with the pinned screening `now`); a failed
  // result must carry no entry, because a failed dispatch appends
  // nothing. Any drift fails the demo outright, so the printed
  // entry citations below can never disagree with the audit log.
  for (const result of deadlineExpireResults) {
    const lastEntry =
      result.escrow.history[result.escrow.history.length - 1];
    if (result.expired) {
      if (
        result.entry === undefined ||
        result.entry.seq !== lastEntry.seq ||
        result.entry.event !== "EXPIRE" ||
        result.entry.from !== lastEntry.from ||
        result.entry.to !== lastEntry.to ||
        result.entry.at !== lastEntry.at ||
        result.entry.at !== DEMO_STALE_NOW
      ) {
        throw new Error(
          `demo fixture broken: expireOverdueEscrows entry for ${result.escrow.id} does not match the escrow history's last entry (expected the EXPIRE entry at ${DEMO_STALE_NOW})`,
        );
      }
    } else if (result.entry !== undefined) {
      throw new Error(
        `demo fixture broken: failed expireOverdueEscrows outcome for ${result.escrow.id} must carry no entry`,
      );
    }
  }
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
    "  expireOverdueEscrows audit entries (result.entry — the EXPIRE audit record, cited without re-reading escrow.history):",
  );
  for (const result of deadlineExpireResults) {
    lines.push(
      result.entry === undefined
        ? `  ${result.escrow.id}: no entry — failed dispatch appends nothing`
        : `  ${result.escrow.id}: entry seq ${result.entry.seq} EXPIRE ${result.entry.from} -> ${result.entry.to} at ${result.entry.at} — matches escrow history last entry`,
    );
  }
  lines.push(
    `  deadline vs stale on the same batch: expired [${deadlineExpiredSelected.map((e) => e.id).join(", ")}], stale [${deadlineStaleSelected.map((e) => e.id).join(", ")}] — different axes, different subsets (absolute deadline vs dwell in the current state)`,
    `  non-expired escrows untouched: ${deadlineStaleEscrow.id} still ${deadlineStaleEscrow.state}`,
  );

  // --- Stale patrol: staleEscrows / maxAgeByState edge forms ---
  // A dedicated patrol over five further escrows on the same fixed
  // `now`, screened by `staleEscrows` ALONE under a patrol budget map
  // (CREATED / FUNDED / RELEASED at 7 days each; VERIFIED deliberately
  // absent) — see the fixture comment above for the hand-computed
  // expectations. Exactly one escrow is stale; the other four are each
  // excluded for a different pinned reason (exactly at the budget,
  // terminal, no history, unmapped state). The disposition is a
  // notify-only action through actOnStaleEscrows: it records the
  // notified ids and dispatches nothing, so the patrol changes no
  // escrow. A fail-fast check then pins the exact configuration error
  // for an unknown state name in the map.
  const patrolStaleEscrow = new Escrow(DEMO_PATROL_STALE_ESCROW_ID);
  patrolStaleEscrow.dispatch("FUND", "Deposit locked (wire received)", 10630, {
    actor: "sponsor",
    at: DEMO_PATROL_STALE_FUND_AT,
  });
  const patrolExactEscrow = new Escrow(DEMO_PATROL_EXACT_ESCROW_ID);
  patrolExactEscrow.dispatch("FUND", "Deposit locked (wire received)", 10630, {
    actor: "sponsor",
    at: DEMO_PATROL_EXACT_FUND_AT,
  });
  const patrolTerminalEscrow = new Escrow(DEMO_PATROL_TERMINAL_ESCROW_ID);
  patrolTerminalEscrow.dispatch(
    "FUND",
    "Deposit locked (wire received)",
    10630,
    { actor: "sponsor", at: DEMO_PATROL_TERMINAL_FUND_AT },
  );
  patrolTerminalEscrow.dispatch(
    "SUBMIT_MILESTONE",
    "Deliverable URLs + IPFS metadata hash",
    undefined,
    { actor: "creator", at: DEMO_PATROL_TERMINAL_SUBMIT_AT },
  );
  patrolTerminalEscrow.dispatch(
    "VERIFY_PASS",
    "KPIs validated by oracle",
    undefined,
    {
      actor: "oracle",
      at: DEMO_PATROL_TERMINAL_VERIFY_AT,
      evidence: "demo-oracle-attestation-patrol",
    },
  );
  patrolTerminalEscrow.dispatch(
    "RELEASE",
    "Verification passed — release funds",
    undefined,
    { actor: "system", at: DEMO_PATROL_TERMINAL_RELEASE_AT },
  );
  const patrolNoHistoryEscrow = new Escrow(DEMO_PATROL_NO_HISTORY_ESCROW_ID);
  const patrolUnmappedEscrow = new Escrow(DEMO_PATROL_UNMAPPED_ESCROW_ID);
  patrolUnmappedEscrow.dispatch(
    "FUND",
    "Deposit locked (wire received)",
    10630,
    { actor: "sponsor", at: DEMO_PATROL_UNMAPPED_FUND_AT },
  );
  patrolUnmappedEscrow.dispatch(
    "SUBMIT_MILESTONE",
    "Deliverable URLs + IPFS metadata hash",
    undefined,
    { actor: "creator", at: DEMO_PATROL_UNMAPPED_SUBMIT_AT },
  );
  patrolUnmappedEscrow.dispatch(
    "VERIFY_PASS",
    "KPIs validated by oracle",
    undefined,
    {
      actor: "oracle",
      at: DEMO_PATROL_UNMAPPED_VERIFY_AT,
      evidence: "demo-oracle-attestation-patrol",
    },
  );
  const patrolEscrows = [
    patrolStaleEscrow,
    patrolExactEscrow,
    patrolTerminalEscrow,
    patrolNoHistoryEscrow,
    patrolUnmappedEscrow,
  ];
  const patrolMaxAgeByState = {
    CREATED: DEMO_STALE_MAX_AGE_MS,
    FUNDED: DEMO_STALE_MAX_AGE_MS,
    RELEASED: DEMO_STALE_MAX_AGE_MS,
  };
  const patrolStaleSelected = staleEscrows(
    patrolEscrows,
    patrolMaxAgeByState,
    staleNow,
  );
  const patrolStaleNotifiedIds: string[] = [];
  const patrolStaleActionResults = actOnStaleEscrows(
    patrolEscrows,
    (e) => {
      patrolStaleNotifiedIds.push(e.id);
    },
    patrolMaxAgeByState,
    staleNow,
  );
  let patrolStaleConfigError = "";
  try {
    staleEscrows(patrolEscrows, { BOGUS: 1000 } as never, staleNow);
  } catch (err) {
    patrolStaleConfigError = err instanceof Error ? err.message : String(err);
  }
  if (
    patrolStaleSelected.length !== 1 ||
    patrolStaleSelected[0] !== patrolStaleEscrow ||
    patrolStaleActionResults.length !== 1 ||
    patrolStaleActionResults[0].escrow !== patrolStaleEscrow ||
    patrolStaleActionResults[0].acted !== true ||
    patrolStaleActionResults[0].error !== undefined ||
    patrolStaleNotifiedIds.length !== 1 ||
    patrolStaleNotifiedIds[0] !== DEMO_PATROL_STALE_ESCROW_ID ||
    patrolStaleConfigError !== DEMO_PATROL_STALE_CONFIG_ERROR ||
    patrolEscrows.map((e) => e.state).join(",") !==
      "FUNDED,FUNDED,RELEASED,CREATED,VERIFIED" ||
    patrolEscrows.map((e) => e.history.length).join(",") !== "1,1,4,0,3"
  ) {
    throw new Error(
      "demo fixture broken: stale patrol does not have the pinned shape (only the stale FUNDED escrow selected and notified; exactly-at-budget, terminal, no-history and unmapped escrows excluded; unknown-state config error pinned)",
    );
  }
  const patrolSelectedIds = new Set(patrolStaleSelected.map((e) => e.id));
  lines.push(
    "",
    "Stale patrol (staleEscrows / maxAgeByState screening, notify-only action):",
    `  fixed now: ${DEMO_STALE_NOW} — patrol budgets: CREATED 7 days, FUNDED 7 days, RELEASED 7 days (VERIFIED has no budget; dwell from the last history entry, strictly past the budget)`,
  );
  for (const patrolEscrow of patrolEscrows) {
    const lastEntry = patrolEscrow.history[patrolEscrow.history.length - 1];
    const dwellText =
      lastEntry === undefined
        ? "no history (no measurable dwell)"
        : `entered ${lastEntry.at}, dwell ${(staleNowMs - Date.parse(lastEntry.at)) / DEMO_STALE_DAY_MS} days`;
    lines.push(
      `  ${patrolEscrow.id}: state ${patrolEscrow.state}, ${dwellText} — stale: ${patrolSelectedIds.has(patrolEscrow.id)}`,
    );
  }
  lines.push(
    `  staleEscrows selection: [${patrolStaleSelected.map((e) => e.id).join(", ")}] — exactly-at-budget (${DEMO_PATROL_EXACT_ESCROW_ID}), terminal (${DEMO_PATROL_TERMINAL_ESCROW_ID}), no-history (${DEMO_PATROL_NO_HISTORY_ESCROW_ID}) and unmapped-state (${DEMO_PATROL_UNMAPPED_ESCROW_ID}) escrows are not selected`,
    `  actOnStaleEscrows (action: notify the parties, dispatch nothing): ${patrolStaleActionResults.length} attempted`,
  );
  for (const result of patrolStaleActionResults) {
    lines.push(
      result.acted
        ? `  ${result.escrow.id}: acted true — notified, escrow unchanged at ${result.escrow.state}`
        : `  ${result.escrow.id}: acted false — error: ${result.error}`,
    );
  }
  lines.push(
    `  invalid patrol configuration fails fast: staleEscrows with an unknown state name throws ${patrolStaleConfigError} before any escrow is read`,
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

  // --- Staged top-up: two FUND instalments, then the happy path (closing) ---
  // The golden path above funds once. Real escrows are often funded
  // in instalments, and the FUNDED self-loop (#43) plus
  // depositAmountFromHistory's sum-of-every-FUND semantics exist for
  // exactly that — but the demo never walked the path. This segment
  // is a separate escrow (DEMO-ESC-025) and never touches the main
  // chain: 10630 first, then a 2,000 top-up on the FUNDED self-loop,
  // then SUBMIT_MILESTONE -> VERIFY_PASS -> RELEASE, settled at
  // DEMO_PRO_FEE_BPS with no referral credits.
  // Hand-pinned expectations — written out here from the
  // documented semantics (stateMachine.ts's FUNDED self-loop,
  // settlementReport.ts's FUND-total corroboration, settlement.ts's
  // settleRelease arithmetic), never derived by calling the
  // functions themselves (the demo tests cross-check the same
  // numbers against test/topup.test.ts's self-loop shape and
  // test/fundTotalCentsComparison.test.ts's corroboration shape):
  //   FUND 10630 (seq 1, CREATED -> FUNDED) +
  //   FUND 2000 (seq 2, FUNDED -> FUNDED, the top-up edge)
  //   -> depositAmountFromHistory = 12630
  //   calculateDeposit on DEMO_TOPUP_FEE_INPUTS -> deposit 12630
  //   (so the report's FUND-total check corroborates, cent-exact)
  //   settleRelease(gross 12630, 500 bps) ->
  //     proFee round2(12630 × 500 / 10000) = 631.5,
  //     net round2(12630 − 631.5 − 0) = 11998.5
  //   released report party nets: sponsor −12630 (outflow 12630) /
  //     creator +11998.5 (inflow net) / platform +631.5 (inflow
  //     proFee) / referrer 0 — inflows 12630, outflows 12630,
  //     the four nets summing to zero (conservation)
  // All dispatches carry fixed `at` literals — no wall clock, no
  // randomness, no network.
  const topupFees = calculateDeposit(DEMO_TOPUP_FEE_INPUTS);
  if (topupFees.deposit !== DEMO_TOPUP_DEPOSIT) {
    throw new Error(
      "demo fixture broken: top-up fee inputs do not yield the pinned deposit 12630",
    );
  }
  const topupEscrow = new Escrow(DEMO_TOPUP_ESCROW_ID);
  const topupSteps: Array<{
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
      note: "Deposit locked — first instalment",
      at: DEMO_TOPUP_FIRST_FUND_AT,
      amount: DEMO_TOPUP_FIRST_FUND_AMOUNT,
    },
    {
      event: "FUND",
      actor: "sponsor",
      note: "Staged top-up — second instalment",
      at: DEMO_TOPUP_SECOND_FUND_AT,
      amount: DEMO_TOPUP_SECOND_FUND_AMOUNT,
    },
    {
      event: "SUBMIT_MILESTONE",
      actor: "creator",
      note: "Deliverable URLs + IPFS metadata hash",
      at: DEMO_TOPUP_SUBMIT_AT,
    },
    {
      event: "VERIFY_PASS",
      actor: "oracle",
      note: "KPIs validated by oracle",
      at: DEMO_TOPUP_VERIFY_AT,
      evidence: DEMO_TOPUP_VERIFY_EVIDENCE,
    },
    {
      event: "RELEASE",
      actor: "system",
      note: "Verification passed — release funds",
      at: DEMO_TOPUP_RELEASE_AT,
    },
  ];
  for (const { event, actor, note, at, amount, evidence } of topupSteps) {
    topupEscrow.dispatch(event, note, amount, { actor, at, evidence });
  }
  if (topupEscrow.state !== "RELEASED" || topupEscrow.history.length !== 5) {
    throw new Error(
      "demo fixture broken: top-up escrow did not reach RELEASED with 5 audit entries",
    );
  }
  const [topupFundOne, topupFundTwo] = topupEscrow.history;
  if (
    topupFundOne.event !== "FUND" ||
    topupFundOne.from !== "CREATED" ||
    topupFundOne.to !== "FUNDED" ||
    topupFundOne.amount !== DEMO_TOPUP_FIRST_FUND_AMOUNT ||
    topupFundTwo.event !== "FUND" ||
    topupFundTwo.from !== "FUNDED" ||
    topupFundTwo.to !== "FUNDED" ||
    topupFundTwo.amount !== DEMO_TOPUP_SECOND_FUND_AMOUNT
  ) {
    throw new Error(
      "demo fixture broken: top-up FUND audit entries do not pin the staged shape (10630 then 2000 on the FUNDED self-loop)",
    );
  }
  const topupTracedDeposit = depositAmountFromHistory(topupEscrow.history);
  if (topupTracedDeposit !== DEMO_TOPUP_DEPOSIT) {
    throw new Error(
      "demo fixture broken: depositAmountFromHistory on the top-up history is not the pinned 12630",
    );
  }
  const topupSettlement = settleRelease({
    gross: topupTracedDeposit,
    proFeeBps: DEMO_PRO_FEE_BPS,
  });
  if (
    topupSettlement.gross !== DEMO_TOPUP_DEPOSIT ||
    topupSettlement.proFee !== DEMO_TOPUP_PRO_FEE ||
    topupSettlement.referralCredits !== 0 ||
    topupSettlement.net !== DEMO_TOPUP_NET ||
    topupSettlement.net + topupSettlement.proFee + topupSettlement.referralCredits !==
      DEMO_TOPUP_DEPOSIT
  ) {
    throw new Error(
      "demo fixture broken: settleRelease on the staged deposit does not pin proFee 631.5 / net 11998.5 with conservation",
    );
  }
  const topupReport = buildSettlementReport({
    escrowId: topupEscrow.id,
    history: topupEscrow.history,
    finalState: topupEscrow.state,
    deposit: topupFees,
    settlement: { proFeeBps: DEMO_PRO_FEE_BPS },
  });
  const topupByParty = Object.fromEntries(
    topupReport.parties.map((p) => [p.party, p.net]),
  );
  if (
    topupReport.outcome !== "released" ||
    topupReport.balanced !== true ||
    topupByParty.sponsor !== -DEMO_TOPUP_DEPOSIT ||
    topupByParty.creator !== DEMO_TOPUP_NET ||
    topupByParty.platform !== DEMO_TOPUP_PRO_FEE ||
    topupByParty.referrer !== 0 ||
    topupReport.totalInflow !== DEMO_TOPUP_DEPOSIT ||
    topupReport.totalOutflow !== DEMO_TOPUP_DEPOSIT
  ) {
    throw new Error(
      "demo fixture broken: top-up released report party nets do not pin sponsor -12630 / creator 11998.5 / platform 631.5 / referrer 0 with conservation",
    );
  }
  lines.push(
    "",
    "Staged top-up (a separate escrow, funded in two instalments — the main chain untouched):",
    `  escrow ${topupEscrow.id}: FUND ${DEMO_TOPUP_FIRST_FUND_AMOUNT} (seq 1, CREATED -> FUNDED) + FUND ${DEMO_TOPUP_SECOND_FUND_AMOUNT} (seq 2, FUNDED -> FUNDED, the top-up self-loop) — two FUND audit entries in one trail`,
    `  depositAmountFromHistory -> ${topupTracedDeposit} (the sum of every FUND amount; the report corroborates against the caller's deposit ${topupFees.deposit} at cent precision)`,
    `  then SUBMIT_MILESTONE -> VERIFY_PASS -> RELEASE: final state ${topupEscrow.state} (${topupEscrow.history.length} audit entries)`,
    `  settleRelease(gross ${topupSettlement.gross}, proFeeBps ${DEMO_PRO_FEE_BPS}, referralCredits ${topupSettlement.referralCredits}) -> net ${topupSettlement.net}, proFee ${topupSettlement.proFee}`,
    `  conservation: net ${topupSettlement.net} + proFee ${topupSettlement.proFee} + referralCredits ${topupSettlement.referralCredits} = ${topupSettlement.net + topupSettlement.proFee + topupSettlement.referralCredits} — equals gross ${topupSettlement.gross} (every part of the staged deposit is accounted for)`,
    `  released report party nets: sponsor ${topupByParty.sponsor} / creator ${topupByParty.creator} / platform ${topupByParty.platform} / referrer ${topupByParty.referrer} — inflows ${topupReport.totalInflow}, outflows ${topupReport.totalOutflow}, balanced ${topupReport.balanced}`,
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

  // --- README diagram sync check: readmeDiagramInSync ---
  // The segment above generates the diagram block; this one
  // reports the conclusion the whole docs-drift guard exists
  // for — `readmeDiagramInSync()` (imported directly from
  // src/diagram.ts, as the benchmark does — it is not
  // re-exported from the package entry) reads this repo's
  // README.md and returns true iff it embeds the exact
  // generated block. Hand-pinned expectation — written out
  // here from the state the test suite pins, never derived
  // by calling readmeDiagramInSync itself:
  //   - the return value is exactly true: test/diagram.test.ts
  //     asserts the README embeds the exact generated diagram
  //     and runs the CLI `--check` form of this same function
  //     requiring the in-sync outcome. A drifted README would
  //     fail the test suite before it could fail here, so true
  //     is the only expectation consistent with a green suite.
  // The segment asserts that here, outside the printed
  // verdict: a drifted README would fail the demo itself, not
  // just a test, and the failure message says how to repair
  // the drift. The only file read is this repo's README.md;
  // no network, no randomness, no wall clock.
  const readmeDiagramInSyncValue = readmeDiagramInSync();
  if (readmeDiagramInSyncValue !== true) {
    throw new Error(
      "demo fixture broken: readmeDiagramInSync() returned false — README.md diagram drifted from stateDiagram(); regenerate with `npm run diagram` and paste the generated block into README.md",
    );
  }
  lines.push(
    "",
    "README diagram sync check (readmeDiagramInSync on this repo's README):",
    `  readmeDiagramInSync(): ${readmeDiagramInSyncValue} (README.md embeds the exact stateDiagram() block generated above — no diagram drift)`,
    "  checked file: README.md (this repo only — the sole file read by the check; no network, no wall clock)",
    "  if drifted: run `npm run diagram`, paste the generated block into README.md, and re-run — the demo fails here until the README matches the code again",
    "  CLI equivalent: node dist/src/diagram.js --check (exit 0 in sync, exit 1 on drift — the same check test/diagram.test.ts runs)",
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

  // --- Deposit cap (maxDeposit risk control, closing) ---
  // A separate risk control from the money guard above: the cap is a
  // per-instance constructor configuration, not a boundary shape
  // check. A branch escrow is constructed with maxDeposit 10000, so
  // a FUND that would push the running locked total (sum of all FUND
  // amounts, compared at cent precision per the library's money
  // model) above the cap throws and appends nothing — the rejected
  // attempt leaves zero history residue, mirroring the budget
  // exhaustion semantics of the dataquest lifecycle. All three
  // dispatches are asserted HERE, outside the printing, against the
  // hand-pinned fixtures above: a guard that silently passed an
  // over-cap FUND, or whose error wording drifted, would fail the
  // demo itself, not just a test. The segment is pure: no network,
  // no randomness, no wall clock (dispatch timestamps injected).
  const depositCapEscrow = new Escrow(DEMO_DEPOSIT_CAP_ESCROW_ID, {
    maxDeposit: DEMO_DEPOSIT_CAP_MAX,
  });
  depositCapEscrow.dispatch(
    "FUND",
    "Initial instalment",
    DEMO_DEPOSIT_CAP_FIRST_FUND_AMOUNT,
    { actor: "sponsor", at: DEMO_DEPOSIT_CAP_FIRST_FUND_AT },
  );
  if (depositCapEscrow.state !== "FUNDED") {
    throw new Error(
      "demo fixture broken: deposit-cap escrow did not reach FUNDED after the initial FUND",
    );
  }
  // TypeScript narrows the `history` getter's length across checks, so
  // each assertion reads its own snapshot into a local.
  const depositCapAfterFirstLen = depositCapEscrow.history.length;
  if (depositCapAfterFirstLen !== 1) {
    throw new Error(
      "demo fixture broken: deposit-cap escrow history is not 1 entry after the initial FUND",
    );
  }
  const depositCapLockedAfterFirst = depositAmountFromHistory(
    depositCapEscrow.history,
  );
  if (depositCapLockedAfterFirst !== DEMO_DEPOSIT_CAP_FIRST_FUND_AMOUNT) {
    throw new Error(
      "demo fixture broken: locked total is not 9000 after the initial FUND",
    );
  }
  // The over-cap attempt: 9000 locked + 2000 new funding would exceed
  // the 10000 cap. The error wording is pinned verbatim.
  let depositCapOverfundError: string | undefined;
  try {
    depositCapEscrow.dispatch(
      "FUND",
      "Second instalment",
      DEMO_DEPOSIT_CAP_OVERFUND_AMOUNT,
      { actor: "sponsor", at: DEMO_DEPOSIT_CAP_OVERFUND_AT },
    );
  } catch (err) {
    depositCapOverfundError =
      err instanceof Error ? err.message : String(err);
  }
  if (depositCapOverfundError !== DEMO_DEPOSIT_CAP_OVERFUND_ERROR) {
    throw new Error(
      `demo fixture broken: over-cap FUND did not throw the pinned deposit cap exceeded error (got ${JSON.stringify(
        depositCapOverfundError,
      )})`,
    );
  }
  // Zero residue: the rejected attempt appended nothing and changed
  // neither the state nor the locked total.
  const depositCapAfterRejectLen = depositCapEscrow.history.length;
  if (depositCapAfterRejectLen !== 1) {
    throw new Error(
      "demo fixture broken: rejected over-cap FUND left history residue",
    );
  }
  if (
    depositAmountFromHistory(depositCapEscrow.history) !==
    DEMO_DEPOSIT_CAP_FIRST_FUND_AMOUNT
  ) {
    throw new Error(
      "demo fixture broken: locked total moved after the rejected over-cap FUND",
    );
  }
  // Boundary top-up: 9000 locked + 1000 = exactly the cap — cent
  // precision, so this passes.
  depositCapEscrow.dispatch(
    "FUND",
    "Boundary top-up",
    DEMO_DEPOSIT_CAP_TOPUP_AMOUNT,
    { actor: "sponsor", at: DEMO_DEPOSIT_CAP_TOPUP_AT },
  );
  const depositCapLockedTotal = depositAmountFromHistory(
    depositCapEscrow.history,
  );
  const depositCapAfterTopupLen = depositCapEscrow.history.length;
  if (depositCapEscrow.state !== "FUNDED" || depositCapAfterTopupLen !== 2) {
    throw new Error(
      "demo fixture broken: deposit-cap escrow did not reach FUNDED with 2 history entries after the boundary top-up",
    );
  }
  if (depositCapLockedTotal !== DEMO_DEPOSIT_CAP_LOCKED_TOTAL) {
    throw new Error(
      `demo fixture broken: locked total is not 10000 after the boundary top-up (got ${depositCapLockedTotal})`,
    );
  }
  lines.push(
    "",
    "Deposit cap (maxDeposit risk control):",
    `  cap: ${DEMO_DEPOSIT_CAP_MAX} — FUND ${DEMO_DEPOSIT_CAP_FIRST_FUND_AMOUNT} accepted (locked ${DEMO_DEPOSIT_CAP_FIRST_FUND_AMOUNT})`,
    `  rejected: FUND ${DEMO_DEPOSIT_CAP_OVERFUND_AMOUNT} -> "${depositCapOverfundError}" — history unchanged, locked still ${DEMO_DEPOSIT_CAP_FIRST_FUND_AMOUNT}`,
    `  accepted: FUND ${DEMO_DEPOSIT_CAP_TOPUP_AMOUNT} -> locked ${depositCapLockedTotal} (exactly on cap passes, cent-precision comparison)`,
  );
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

  // --- X-Event-Id header: deliverSettlementWebhook retry + fan-out (closing) ---
  // The delivery segments so far prove the signature
  // header (`X-Signature`) end to end, but no demo
  // delivery ever showed the transport header that
  // receivers deduplicate on: `X-Event-Id`. Here the
  // main escrow's signed webhook is delivered for real
  // over HTTP to a loopback server (ephemeral port,
  // paths pinned below — the port itself is never
  // printed, so the output stays byte-identical across
  // runs). The loopback endpoint answers 500 on the
  // first attempt and 200 on the retry, so the delivery
  // resolves {status: 200, attempts: 2} through a
  // genuine retry, not a scripted fake. Hand-pinned
  // expectations (see the fixture comment above),
  // asserted HERE, outside the printing: both captured
  // requests carry X-Event-Id exactly equal to the
  // body's eventId — the header does not drift across
  // the retry — and the fan-out comparison below shows the
  // same rule per endpoint: one logical event means one
  // shared eventId, so each endpoint's header equals
  // the shared body eventId rather than a per-endpoint
  // value. A delivery that minted a fresh eventId per
  // attempt or per endpoint would fail the demo
  // itself. `backoffMs: 0` keeps the retry wait at zero
  // and `allowInsecureHttp: true` is the explicit
  // loopback opt-out (plaintext is refused by default).
  const eventIdHeaderRetryCalls: Array<{
    path: string;
    status: number;
    eventIdHeader: string;
    body: string;
    bodyEventId: string;
  }> = [];
  const eventIdHeaderFanoutCalls: Array<{
    path: string;
    eventIdHeader: string;
    body: string;
    bodyEventId: string;
  }> = [];
  const eventIdHeaderServer = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const body = Buffer.concat(chunks).toString("utf8");
      let bodyEventId = "";
      try {
        const parsed = JSON.parse(body) as { eventId?: unknown };
        bodyEventId =
          typeof parsed.eventId === "string" ? parsed.eventId : "";
      } catch {
        bodyEventId = "";
      }
      const eventIdHeader = String(req.headers["x-event-id"] ?? "");
      if (req.url === DEMO_EVENT_ID_HEADER_RETRY_PATH) {
        const status =
          DEMO_EVENT_ID_HEADER_RETRY_STATUSES[
            Math.min(
              eventIdHeaderRetryCalls.length,
              DEMO_EVENT_ID_HEADER_RETRY_STATUSES.length - 1,
            )
          ];
        eventIdHeaderRetryCalls.push({
          path: DEMO_EVENT_ID_HEADER_RETRY_PATH,
          status,
          eventIdHeader,
          body,
          bodyEventId,
        });
        res.writeHead(status, { "content-type": "application/json" });
        res.end(status === 200 ? "{}" : "boom");
        return;
      }
      if (
        (DEMO_EVENT_ID_HEADER_FANOUT_PATHS as readonly string[]).includes(
          req.url ?? "",
        )
      ) {
        eventIdHeaderFanoutCalls.push({
          path: req.url ?? "",
          eventIdHeader,
          body,
          bodyEventId,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    })();
  });
  await new Promise<void>((resolve, reject) => {
    eventIdHeaderServer.once("error", reject);
    eventIdHeaderServer.listen(0, "127.0.0.1", () => resolve());
  });
  const eventIdHeaderAddress = eventIdHeaderServer.address();
  if (
    eventIdHeaderAddress === null ||
    typeof eventIdHeaderAddress === "string"
  ) {
    eventIdHeaderServer.close();
    throw new Error(
      "demo fixture broken: X-Event-Id loopback server did not bind to a TCP port",
    );
  }
  const eventIdHeaderBase = `http://127.0.0.1:${eventIdHeaderAddress.port}`;
  let eventIdHeaderRetryResult: WebhookDeliveryResult;
  let eventIdHeaderFanoutResult: DeliverSettlementWebhookToManyResult;
  try {
    eventIdHeaderRetryResult = await deliverSettlementWebhook(
      `${eventIdHeaderBase}${DEMO_EVENT_ID_HEADER_RETRY_PATH}`,
      webhook,
      { backoffMs: 0, allowInsecureHttp: true },
    );
    eventIdHeaderFanoutResult = await deliverSettlementWebhookToMany(
      report,
      [
        {
          url: `${eventIdHeaderBase}${DEMO_EVENT_ID_HEADER_FANOUT_PATHS[0]}`,
          secret: DEMO_EVENT_ID_HEADER_FANOUT_SECRET_A,
        },
        {
          url: `${eventIdHeaderBase}${DEMO_EVENT_ID_HEADER_FANOUT_PATHS[1]}`,
          secret: DEMO_EVENT_ID_HEADER_FANOUT_SECRET_B,
        },
      ],
      {
        now: DEMO_EVENT_ID_HEADER_FANOUT_AT,
        eventId: DEMO_EVENT_ID_HEADER_FANOUT_EVENT_ID,
        backoffMs: 0,
        allowInsecureHttp: true,
      },
    );
  } finally {
    eventIdHeaderServer.closeAllConnections();
    await new Promise<void>((resolve) => {
      eventIdHeaderServer.close(() => resolve());
    });
  }
  if (
    eventIdHeaderRetryResult.status !== 200 ||
    eventIdHeaderRetryResult.attempts !== 2 ||
    eventIdHeaderRetryCalls.length !== 2 ||
    eventIdHeaderRetryCalls.some(
      (call, i) =>
        call.path !== DEMO_EVENT_ID_HEADER_RETRY_PATH ||
        call.status !== DEMO_EVENT_ID_HEADER_RETRY_STATUSES[i] ||
        call.eventIdHeader !== DEMO_WEBHOOK_EVENT_ID ||
        call.bodyEventId !== DEMO_WEBHOOK_EVENT_ID ||
        call.body !== JSON.stringify(webhook.payload),
    ) ||
    eventIdHeaderFanoutResult.results.length !== 2 ||
    eventIdHeaderFanoutResult.delivered !== 2 ||
    eventIdHeaderFanoutResult.failed !== 0 ||
    eventIdHeaderFanoutResult.results.some(
      (result) =>
        !result.ok || result.attempts !== 1 || result.status !== 200,
    ) ||
    eventIdHeaderFanoutCalls.length !== 2 ||
    eventIdHeaderFanoutCalls.some(
      (call, i) =>
        call.path !== DEMO_EVENT_ID_HEADER_FANOUT_PATHS[i] ||
        call.eventIdHeader !== DEMO_EVENT_ID_HEADER_FANOUT_EVENT_ID ||
        call.bodyEventId !== DEMO_EVENT_ID_HEADER_FANOUT_EVENT_ID,
    ) ||
    eventIdHeaderFanoutCalls[0].body !== eventIdHeaderFanoutCalls[1].body
  ) {
    throw new Error(
      "demo fixture broken: deliverSettlementWebhook X-Event-Id header does not match the pinned shape (loopback 500 then 200, result {status: 200, attempts: 2}, both attempts' X-Event-Id equal to the body eventId; fan-out 2 endpoints delivered / 0 failed, each endpoint's X-Event-Id equal to the shared body eventId, bodies byte-identical)",
    );
  }
  lines.push(
    "",
    "Settlement webhook X-Event-Id header (deliverSettlementWebhook retry + fan-out over a loopback server):",
    `  retry: the main escrow's signed webhook (body eventId ${DEMO_WEBHOOK_EVENT_ID}) delivered to ${DEMO_EVENT_ID_HEADER_RETRY_PATH} — attempt 1 answered 500, attempt 2 answered 200; result: status ${eventIdHeaderRetryResult.status}, attempts ${eventIdHeaderRetryResult.attempts} (succeeded after exactly one retry, backoffMs 0 — no real waiting)`,
    `  retry wire check: ${eventIdHeaderRetryCalls.length} captured POSTs — the X-Event-Id header on attempt 1 and on the retry are both ${DEMO_WEBHOOK_EVENT_ID}, identical to each other and to the body eventId on both attempts`,
    `  fan-out: the same report fanned out as one logical event (eventId ${DEMO_EVENT_ID_HEADER_FANOUT_EVENT_ID}, at ${DEMO_EVENT_ID_HEADER_FANOUT_AT}) — one shared body eventId, not one per endpoint:`,
    `  ${DEMO_EVENT_ID_HEADER_FANOUT_PATHS[0]}: X-Event-Id ${DEMO_EVENT_ID_HEADER_FANOUT_EVENT_ID} = body eventId ${DEMO_EVENT_ID_HEADER_FANOUT_EVENT_ID}`,
    `  ${DEMO_EVENT_ID_HEADER_FANOUT_PATHS[1]}: X-Event-Id ${DEMO_EVENT_ID_HEADER_FANOUT_EVENT_ID} = body eventId ${DEMO_EVENT_ID_HEADER_FANOUT_EVENT_ID}`,
    "  note: the header is a transport hint only — it is NOT covered by the signature, so a receiver verifies the signature first and then trusts the body's eventId, never the header, as the deduplication key",
  );

  // --- 429 Retry-After delivery: deliverSettlementWebhook (closing) ---
  // The Retry-After parsing segment above only ever
  // parsed hints on a fixed clock — its own text concedes
  // the demo never runs a live delivery, and no delivery
  // segment so far has taken the 429 path at all (the
  // fan-out fake answers 200 immediately, the
  // single-target fake answers 500 then 200). Here the
  // same signed webhook is delivered alone once more,
  // through a scripted fake fetch installed on
  // `globalThis` for this segment only (the original is
  // restored in the `finally`): attempt 1 answers 429
  // carrying the pinned `Retry-After` hint, and
  // `deliverSettlementWebhook` runs it through
  // `retryDelayMs` — parsed to the pinned hint ms, then
  // clamped by `maxRetryDelayMs: 0` to a zero wait, so
  // the hint is genuinely parsed and applied yet no real
  // waiting happens — and `sleepAbortable`, after which
  // attempt 2 answers 200 and the delivery resolves
  // {status: 200, attempts: 2}. Hand-pinned expectations
  // (see the fixture comment above), asserted HERE,
  // outside the printing: the parsed hint equals the
  // pinned hint ms, exactly 2 requests are captured,
  // both POSTs to the pinned URL carrying byte-identical
  // bodies equal to the canonical body of the demo
  // webhook, and the re-delivered attempt's X-Signature
  // equals the webhook's signature and verifies over
  // the captured body under the demo secret — a delivery
  // that skipped the retry, waited on the unclamped
  // hint, or altered the body between attempts would
  // fail (or visibly stall) the demo itself. Zero
  // network, zero real waiting, no wall clock.
  const retryAfterDeliveryHintMs = parseRetryAfter(
    DEMO_RETRY_AFTER_DELIVERY_HINT,
  );
  const retryAfterDeliveryCalls: Array<{
    url: string;
    method: string;
    body: string;
    signature: string;
  }> = [];
  const retryAfterDeliveryFetch: typeof fetch = async (input, init) => {
    retryAfterDeliveryCalls.push({
      url: String(input),
      method: String(init?.method ?? ""),
      body: String(init?.body ?? ""),
      signature: String(
        new Headers(init?.headers).get("x-signature") ?? "",
      ),
    });
    const status =
      DEMO_RETRY_AFTER_DELIVERY_SCRIPTED_STATUSES[
        Math.min(
          retryAfterDeliveryCalls.length - 1,
          DEMO_RETRY_AFTER_DELIVERY_SCRIPTED_STATUSES.length - 1,
        )
      ];
    return new Response(status === 200 ? "{}" : "rate limited", {
      status,
      headers:
        status === 429
          ? { "retry-after": DEMO_RETRY_AFTER_DELIVERY_HINT }
          : { "content-type": "application/json" },
    });
  };
  const originalFetchForRetryAfter = globalThis.fetch;
  let retryAfterDeliveryResult: WebhookDeliveryResult;
  globalThis.fetch = retryAfterDeliveryFetch;
  try {
    retryAfterDeliveryResult = await deliverSettlementWebhook(
      DEMO_RETRY_AFTER_DELIVERY_URL,
      webhook,
      { maxRetryDelayMs: 0 },
    );
  } finally {
    globalThis.fetch = originalFetchForRetryAfter;
  }
  const retryAfterDeliveryFinalCall =
    retryAfterDeliveryCalls[retryAfterDeliveryCalls.length - 1];
  const retryAfterDeliverySignatureVerified =
    retryAfterDeliveryFinalCall !== undefined &&
    verifySettlementWebhook(
      retryAfterDeliveryFinalCall.body,
      retryAfterDeliveryFinalCall.signature,
      DEMO_WEBHOOK_SECRET,
    );
  if (
    retryAfterDeliveryResult.status !== 200 ||
    retryAfterDeliveryResult.attempts !== 2 ||
    retryAfterDeliveryHintMs !== DEMO_RETRY_AFTER_DELIVERY_HINT_MS ||
    retryAfterDeliveryCalls.length !== 2 ||
    retryAfterDeliveryCalls.some(
      (call) =>
        call.url !== DEMO_RETRY_AFTER_DELIVERY_URL ||
        call.method !== "POST" ||
        call.body !== JSON.stringify(webhook.payload) ||
        call.signature !== webhook.signature,
    ) ||
    !retryAfterDeliverySignatureVerified
  ) {
    throw new Error(
      "demo fixture broken: deliverSettlementWebhook 429 Retry-After delivery does not match the pinned shape (scripted 429 with the pinned Retry-After hint then 200, hint parsed to the pinned ms, result {status: 200, attempts: 2}, two POSTs with byte-identical signed bodies, captured X-Signature verifiable under the demo secret)",
    );
  }
  lines.push(
    "",
    "429 Retry-After webhook delivery (deliverSettlementWebhook via scripted fake fetch, zero network):",
    `  endpoint: ${DEMO_RETRY_AFTER_DELIVERY_URL} — the main escrow's signed webhook (eventId ${webhook.payload.eventId}) delivered alone against a rate-limiting endpoint, the first demo delivery to run the 429 retry path end to end`,
    `  attempt 1: scripted 429 with Retry-After: ${DEMO_RETRY_AFTER_DELIVERY_HINT} (parseRetryAfter -> ${retryAfterDeliveryHintMs} ms) — attempt 2: scripted 200; result: status ${retryAfterDeliveryResult.status}, attempts ${retryAfterDeliveryResult.attempts}`,
    `  wait: retryDelayMs parses the hint and maxRetryDelayMs 0 clamps the parsed ${DEMO_RETRY_AFTER_DELIVERY_HINT_MS} ms to 0 — the hint is parsed and applied, and the retry fires with zero real waiting`,
    `  wire check: ${retryAfterDeliveryCalls.length} captured POSTs, bodies byte-identical across attempts and equal to the signed payload body; the X-Signature the endpoint received on the re-delivery verifies over the captured body: verifySettlementWebhook: ${retryAfterDeliverySignatureVerified ? "ok" : "FAILED"}`,
  );

  // --- Dedupe snapshot persistence: exportSnapshot / restore (closing) ---
  // The receiver-dedupe segment above ran entirely in
  // memory: a receiver restart would forget every id
  // inside its TTL and reopen exactly the
  // double-settlement window the store exists to close —
  // at deploy time. Here a FRESH dedupe on the same
  // fixed clock records two fixed ids (each new on first
  // sight, a duplicate on immediate redelivery), exports
  // them with exportSnapshot(), round-trips the snapshot
  // through JSON text — the persistence channel a real
  // receiver writes before shutdown — and restores it
  // with SettlementEventDedupe.restore(): the restored
  // store's counters start at zero (captured before any
  // probe runs), yet both ids still read as duplicates,
  // while a never-seen id reads as new. A detached copy
  // of the snapshot with its version rewritten to 2 is
  // then rejected with the exact invalid-snapshot error.
  // Hand-pinned expectations (see the fixture comment
  // above), asserted HERE, outside the printing: a
  // snapshot that dropped or re-stamped an entry, a
  // restore that reopened the window or carried the
  // counters across, or a tampered version that slipped
  // through would fail the demo itself, not just a test.
  // Only the snapshot's version and entry count are
  // printed — never the full entries. The clock never
  // advances, so zero network, zero randomness, and no
  // wall clock enter the segment.
  const dedupeSnapshotSource = new SettlementEventDedupe({
    ttlMs: DEMO_DEDUPE_TTL_MS,
    now: () => DEMO_DEDUPE_SNAPSHOT_START_MS,
  });
  const dedupeSnapshotFirst = DEMO_DEDUPE_SNAPSHOT_EVENT_IDS.map((eventId) =>
    dedupeSnapshotSource.checkAndRecord(eventId),
  );
  const dedupeSnapshotDuplicate = DEMO_DEDUPE_SNAPSHOT_EVENT_IDS.map(
    (eventId) => dedupeSnapshotSource.checkAndRecord(eventId),
  );
  const dedupeSnapshot = dedupeSnapshotSource.exportSnapshot();
  const dedupeSnapshotRestored = SettlementEventDedupe.restore(
    JSON.parse(JSON.stringify(dedupeSnapshot)) as unknown,
    {
      ttlMs: DEMO_DEDUPE_TTL_MS,
      now: () => DEMO_DEDUPE_SNAPSHOT_START_MS,
    },
  );
  const dedupeSnapshotStatsAfterRestore = dedupeSnapshotRestored.stats();
  const dedupeSnapshotRestoredSeen = DEMO_DEDUPE_SNAPSHOT_EVENT_IDS.map(
    (eventId) => dedupeSnapshotRestored.checkAndRecord(eventId),
  );
  const dedupeSnapshotRestoredUnseen = dedupeSnapshotRestored.checkAndRecord(
    DEMO_DEDUPE_SNAPSHOT_UNSEEN_EVENT_ID,
  );
  let dedupeSnapshotTamperedError = "";
  try {
    SettlementEventDedupe.restore(
      { ...dedupeSnapshot, v: 2 },
      {
        ttlMs: DEMO_DEDUPE_TTL_MS,
        now: () => DEMO_DEDUPE_SNAPSHOT_START_MS,
      },
    );
  } catch (err) {
    dedupeSnapshotTamperedError =
      err instanceof Error ? err.message : String(err);
  }
  if (
    dedupeSnapshotFirst.length !== 2 ||
    dedupeSnapshotFirst.some((seen) => seen !== false) ||
    dedupeSnapshotDuplicate.length !== 2 ||
    dedupeSnapshotDuplicate.some((seen) => seen !== true) ||
    dedupeSnapshot.v !== 1 ||
    dedupeSnapshot.entries.length !==
      DEMO_DEDUPE_SNAPSHOT_ENTRIES.length ||
    dedupeSnapshot.entries.some(
      (entry, i) =>
        entry[0] !== DEMO_DEDUPE_SNAPSHOT_ENTRIES[i][0] ||
        entry[1] !== DEMO_DEDUPE_SNAPSHOT_ENTRIES[i][1],
    ) ||
    dedupeSnapshotStatsAfterRestore.size !== 2 ||
    dedupeSnapshotStatsAfterRestore.hits !== 0 ||
    dedupeSnapshotStatsAfterRestore.misses !== 0 ||
    dedupeSnapshotStatsAfterRestore.evictions !== 0 ||
    dedupeSnapshotRestoredSeen.length !== 2 ||
    dedupeSnapshotRestoredSeen.some((seen) => seen !== true) ||
    dedupeSnapshotRestoredUnseen !== false ||
    dedupeSnapshotRestored.size !== 3 ||
    dedupeSnapshotTamperedError !== DEMO_DEDUPE_SNAPSHOT_TAMPERED_ERROR
  ) {
    throw new Error(
      "demo fixture broken: SettlementEventDedupe snapshot persistence does not match the pinned shape (two ids new then duplicate, snapshot exactly the pinned v1 entries, restored counters at zero, both ids still duplicates and the unseen id new after restore, the v:2 copy rejected with the pinned error)",
    );
  }
  lines.push(
    "",
    "Dedupe snapshot persistence (SettlementEventDedupe exportSnapshot / restore across a restart):",
    `  source dedupe (fixed clock ${DEMO_WEBHOOK_AT}, TTL ${DEMO_DEDUPE_TTL_MS} ms): eventId ${DEMO_DEDUPE_SNAPSHOT_EVENT_IDS[0]} — checkAndRecord: ${dedupeSnapshotFirst[0]} (new event), again: ${dedupeSnapshotDuplicate[0]} (duplicate); eventId ${DEMO_DEDUPE_SNAPSHOT_EVENT_IDS[1]} — checkAndRecord: ${dedupeSnapshotFirst[1]} (new event), again: ${dedupeSnapshotDuplicate[1]} (duplicate)`,
    `  exportSnapshot(): v ${dedupeSnapshot.v}, ${dedupeSnapshot.entries.length} entries — only the version and entry count are printed, never the full entries (persist the JSON before shutdown)`,
    `  after JSON round-trip + SettlementEventDedupe.restore(): stats size ${dedupeSnapshotStatsAfterRestore.size}, hits ${dedupeSnapshotStatsAfterRestore.hits}, misses ${dedupeSnapshotStatsAfterRestore.misses}, evictions ${dedupeSnapshotStatsAfterRestore.evictions} — counters restart at zero, the recorded ids do not`,
    `  restored dedupe: eventId ${DEMO_DEDUPE_SNAPSHOT_EVENT_IDS[0]} — checkAndRecord: ${dedupeSnapshotRestoredSeen[0]} (duplicate — the restart did not reopen the dedupe window); eventId ${DEMO_DEDUPE_SNAPSHOT_EVENT_IDS[1]} — checkAndRecord: ${dedupeSnapshotRestoredSeen[1]} (duplicate); eventId ${DEMO_DEDUPE_SNAPSHOT_UNSEEN_EVENT_ID} — checkAndRecord: ${dedupeSnapshotRestoredUnseen} (new event, recorded)`,
    `  tampered snapshot rejected: a detached copy with v changed to 2 throws "${dedupeSnapshotTamperedError}" — a corrupt snapshot fails loudly at startup instead of silently disabling deduplication`,
  );

  // --- Dedupe clear: clear() (explicit window reset) ---
  // The snapshot segment above carries the recorded ids
  // across a restart on purpose; this segment shows the
  // deliberate opposite. A FRESH dedupe on the same
  // fixed clock records one fixed id (new on first
  // sight, a duplicate on immediate redelivery, stats
  // captured), then clear() drops every recorded id and
  // resets every observability counter to zero (size and
  // stats captured immediately after, before any probe),
  // and the same id then counts as new again and is
  // re-recorded, its stats counting up from zero. That
  // is the explicit reset a receiver reaches for at key
  // rotation, in test isolation, or at a window reset.
  // Hand-pinned expectations (see the fixture comment
  // above), asserted HERE, outside the printing: a clear
  // that kept an id, left a counter standing, or a
  // re-record that still read as a duplicate would fail
  // the demo itself, not just a test. The clock never
  // advances, so zero network, zero randomness, and no
  // wall clock enter the segment.
  const dedupeClearDedupe = new SettlementEventDedupe({
    ttlMs: DEMO_DEDUPE_TTL_MS,
    now: () => DEMO_DEDUPE_CLEAR_START_MS,
  });
  const dedupeClearFirst = dedupeClearDedupe.checkAndRecord(
    DEMO_DEDUPE_CLEAR_EVENT_ID,
  );
  const dedupeClearDuplicate = dedupeClearDedupe.checkAndRecord(
    DEMO_DEDUPE_CLEAR_EVENT_ID,
  );
  const dedupeClearStatsBefore = dedupeClearDedupe.stats();
  dedupeClearDedupe.clear();
  const dedupeClearSizeAfterClear = dedupeClearDedupe.size;
  const dedupeClearStatsAfterClear = dedupeClearDedupe.stats();
  const dedupeClearRerecord = dedupeClearDedupe.checkAndRecord(
    DEMO_DEDUPE_CLEAR_EVENT_ID,
  );
  const dedupeClearStatsAfterRerecord = dedupeClearDedupe.stats();
  if (
    dedupeClearFirst !== false ||
    dedupeClearDuplicate !== true ||
    dedupeClearStatsBefore.size !== 1 ||
    dedupeClearStatsBefore.hits !== 1 ||
    dedupeClearStatsBefore.misses !== 1 ||
    dedupeClearStatsBefore.evictions !== 0 ||
    dedupeClearSizeAfterClear !== 0 ||
    dedupeClearStatsAfterClear.size !== 0 ||
    dedupeClearStatsAfterClear.hits !== 0 ||
    dedupeClearStatsAfterClear.misses !== 0 ||
    dedupeClearStatsAfterClear.evictions !== 0 ||
    dedupeClearRerecord !== false ||
    dedupeClearStatsAfterRerecord.size !== 1 ||
    dedupeClearStatsAfterRerecord.hits !== 0 ||
    dedupeClearStatsAfterRerecord.misses !== 1 ||
    dedupeClearStatsAfterRerecord.evictions !== 0 ||
    dedupeClearDedupe.size !== 1
  ) {
    throw new Error(
      "demo fixture broken: SettlementEventDedupe clear reset does not match the pinned shape (one id new then duplicate with stats 1/1/1/0, clear to size 0 with stats all zero, the same id new again after the clear with stats counting from zero)",
    );
  }
  lines.push(
    "",
    "Dedupe clear reset (SettlementEventDedupe.clear() — explicit window reset):",
    `  dedupe (fixed clock ${DEMO_WEBHOOK_AT}, TTL ${DEMO_DEDUPE_TTL_MS} ms): eventId ${DEMO_DEDUPE_CLEAR_EVENT_ID} — checkAndRecord: ${dedupeClearFirst} (new event), again: ${dedupeClearDuplicate} (duplicate); stats before clear: size ${dedupeClearStatsBefore.size}, hits ${dedupeClearStatsBefore.hits}, misses ${dedupeClearStatsBefore.misses}, evictions ${dedupeClearStatsBefore.evictions}`,
    `  clear(): size ${dedupeClearSizeAfterClear} — stats size ${dedupeClearStatsAfterClear.size}, hits ${dedupeClearStatsAfterClear.hits}, misses ${dedupeClearStatsAfterClear.misses}, evictions ${dedupeClearStatsAfterClear.evictions} (every recorded id dropped, every counter reset to zero)`,
    `  same eventId after clear — checkAndRecord: ${dedupeClearRerecord} (new event again, recorded — the reset reopened the window on purpose); stats after re-record: size ${dedupeClearStatsAfterRerecord.size}, hits ${dedupeClearStatsAfterRerecord.hits}, misses ${dedupeClearStatsAfterRerecord.misses}, evictions ${dedupeClearStatsAfterRerecord.evictions} (counting restarts from zero)`,
  );

  // --- Dedupe capacity eviction: maxEntries LRU eviction ---
  // The snapshot segment carried recorded ids across a
  // restart, the clear segment reset them on purpose; this
  // segment shows the third memory bound of the dedupe:
  // the capacity limit. A dedupe with a tiny
  // `maxEntries: 3` on the same fixed clock records four
  // fixed eventIds in order: the fourth distinct id
  // forces the LRU eviction of the oldest entry (its
  // eviction is counted in `stats().evictions`), and when
  // the evicted id is seen again it counts as a new event
  // — an eviction reopens the dedupe window for that id,
  // which is exactly the memory-vs-duplication trade-off
  // a receiver operator must understand at capacity.
  // An immediate re-record of the first id before the
  // store fills is a duplicate (its LRU recency is
  // refreshed); a `maxEntries: 0` construction is
  // rejected with the exact configuration error.
  // Hand-pinned expectations (see the fixture comment
  // above), asserted HERE, outside the printing: call
  // order [new, duplicate, new, new, new (evicts the
  // oldest), new again (the evicted id, evicting the next
  // oldest)] with stats `{size: 3, hits: 1, misses: 4,
  // evictions: 1}` after the fifth call and `{size: 3,
  // hits: 1, misses: 5, evictions: 2}` after the sixth —
  // a different eviction order, a miscounted eviction, or
  // an accepted maxEntries: 0 would fail the demo itself,
  // not just a test. The clock never advances, so every
  // id stays inside its TTL and the evictions shown are
  // capacity evictions only — zero network, zero
  // randomness, no wall clock.
  const dedupeCapacityDedupe = new SettlementEventDedupe({
    ttlMs: DEMO_DEDUPE_TTL_MS,
    maxEntries: DEMO_DEDUPE_CAPACITY_MAX_ENTRIES,
    now: () => DEMO_DEDUPE_CAPACITY_START_MS,
  });
  const [capId1, capId2, capId3, capId4] = DEMO_DEDUPE_CAPACITY_EVENT_IDS;
  const dedupeCapacityVerdicts: boolean[] = [
    dedupeCapacityDedupe.checkAndRecord(capId1), // new
    dedupeCapacityDedupe.checkAndRecord(capId1), // duplicate
    dedupeCapacityDedupe.checkAndRecord(capId2), // new
    dedupeCapacityDedupe.checkAndRecord(capId3), // new (store now full: 3)
    dedupeCapacityDedupe.checkAndRecord(capId4), // new — evicts capId1
  ];
  const dedupeCapacityStatsAfterEviction = dedupeCapacityDedupe.stats();
  const dedupeCapacityEvictedRerecord =
    dedupeCapacityDedupe.checkAndRecord(capId1); // new again — evicts capId2
  dedupeCapacityVerdicts.push(dedupeCapacityEvictedRerecord);
  const dedupeCapacityStatsFinal = dedupeCapacityDedupe.stats();
  let dedupeCapacityInvalidMaxEntriesError = "";
  try {
    new SettlementEventDedupe({ maxEntries: 0 });
  } catch (err) {
    dedupeCapacityInvalidMaxEntriesError =
      err instanceof Error ? err.message : String(err);
  }
  if (
    dedupeCapacityVerdicts.length !== 6 ||
    dedupeCapacityVerdicts.join(",") !== "false,true,false,false,false,false" ||
    dedupeCapacityStatsAfterEviction.size !== 3 ||
    dedupeCapacityStatsAfterEviction.hits !== 1 ||
    dedupeCapacityStatsAfterEviction.misses !== 4 ||
    dedupeCapacityStatsAfterEviction.evictions !== 1 ||
    dedupeCapacityEvictedRerecord !== false ||
    dedupeCapacityStatsFinal.size !== 3 ||
    dedupeCapacityStatsFinal.hits !== 1 ||
    dedupeCapacityStatsFinal.misses !== 5 ||
    dedupeCapacityStatsFinal.evictions !== 2 ||
    dedupeCapacityDedupe.size !== 3 ||
    dedupeCapacityInvalidMaxEntriesError !==
      DEMO_DEDUPE_CAPACITY_INVALID_MAX_ENTRIES_ERROR
  ) {
    throw new Error(
      "demo fixture broken: SettlementEventDedupe capacity eviction does not match the pinned shape (four distinct ids under maxEntries 3 with the oldest evicted at the fourth id and the evicted id new again when seen once more, stats 3/1/4/1 then 3/1/5/2, maxEntries 0 rejected with the pinned configuration error)",
    );
  }
  lines.push(
    "",
    "Dedupe capacity eviction (SettlementEventDedupe maxEntries — bounded memory at the receiver):",
    `  dedupe (fixed clock ${DEMO_WEBHOOK_AT}, TTL ${DEMO_DEDUPE_TTL_MS} ms, maxEntries ${DEMO_DEDUPE_CAPACITY_MAX_ENTRIES}): eventId ${capId1} — checkAndRecord: ${dedupeCapacityVerdicts[0]} (new event), again: ${dedupeCapacityVerdicts[1]} (duplicate); eventIds ${capId2}, ${capId3} — checkAndRecord: ${dedupeCapacityVerdicts[2]}, ${dedupeCapacityVerdicts[3]} (new events; the store is now full at 3)`,
    `  eventId ${capId4} — checkAndRecord: ${dedupeCapacityVerdicts[4]} (new event; capacity exceeded, oldest entry ${capId1} evicted by LRU); stats: size ${dedupeCapacityStatsAfterEviction.size}, hits ${dedupeCapacityStatsAfterEviction.hits}, misses ${dedupeCapacityStatsAfterEviction.misses}, evictions ${dedupeCapacityStatsAfterEviction.evictions}`,
    `  evicted eventId ${capId1} seen again — checkAndRecord: ${dedupeCapacityEvictedRerecord} (new event again — the eviction reopened its dedupe window, the next oldest entry ${capId2} evicted in turn); stats: size ${dedupeCapacityStatsFinal.size}, hits ${dedupeCapacityStatsFinal.hits}, misses ${dedupeCapacityStatsFinal.misses}, evictions ${dedupeCapacityStatsFinal.evictions} (bounded memory, visible in the counters)`,
    `  invalid capacity rejected: new SettlementEventDedupe({ maxEntries: 0 }) throws "${dedupeCapacityInvalidMaxEntriesError}"`,
  );

  // --- Subscribe onError routing: subscribe(listener, { onError }) (final closing) ---
  // The subscription segment above used a well-behaved
  // collecting listener; the error path never ran. Here a
  // branch escrow subscribes ONE pinned throwing listener
  // with a collecting onError and runs a short fixed-
  // timestamp chain — FUND, SUBMIT_MILESTONE, VERIFY_PASS:
  // every dispatch succeeds (the throw is caught and
  // swallowed, so dispatch and the audit trail are never
  // broken) and onError receives exactly one report per
  // dispatch, the caught error travelling with its
  // ListenerErrorContext (event / from / to). A probe
  // escrow whose onError ITSELF throws still dispatches
  // successfully — a broken error hook is isolated the
  // same way — and a non-function onError is rejected at
  // subscribe time with the exact invalid-subscribe error,
  // registering nothing. Hand-pinned expectations (see the
  // fixture comment above), asserted HERE, outside the
  // printing: the three reports equal the pinned contexts
  // in order and match the escrow's audit entries seq for
  // seq — a routing that dropped, reordered, or mislabelled
  // a report, or a throw that broke a dispatch, would fail
  // the demo itself, not just a test. Zero network, zero
  // randomness, fixed timestamps throughout.
  const onErrorEscrow = new Escrow(DEMO_ONERROR_ESCROW_ID);
  const onErrorReports: Array<{
    message: string;
    event: EscrowEvent;
    from: EscrowState;
    to: EscrowState;
  }> = [];
  onErrorEscrow.subscribe(
    () => {
      throw new Error(DEMO_ONERROR_LISTENER_ERROR);
    },
    {
      onError: (err, ctx) => {
        onErrorReports.push({
          message: err instanceof Error ? err.message : String(err),
          event: ctx.event,
          from: ctx.from,
          to: ctx.to,
        });
      },
    },
  );
  const onErrorStates: EscrowState[] = [];
  onErrorStates.push(
    onErrorEscrow.dispatch("FUND", "Deposit locked (wire received)", 10630, {
      actor: "sponsor",
      at: DEMO_ONERROR_FUND_AT,
    }),
  );
  onErrorStates.push(
    onErrorEscrow.dispatch(
      "SUBMIT_MILESTONE",
      "Deliverable URLs + IPFS metadata hash",
      undefined,
      { actor: "creator", at: DEMO_ONERROR_SUBMIT_AT },
    ),
  );
  onErrorStates.push(
    onErrorEscrow.dispatch(
      "VERIFY_PASS",
      "KPIs validated by oracle",
      undefined,
      {
        actor: "oracle",
        at: DEMO_ONERROR_VERIFY_AT,
        evidence: DEMO_ONERROR_VERIFY_EVIDENCE,
      },
    ),
  );
  const onErrorProbeEscrow = new Escrow(DEMO_ONERROR_PROBE_ESCROW_ID);
  onErrorProbeEscrow.subscribe(
    () => {
      throw new Error(DEMO_ONERROR_LISTENER_ERROR);
    },
    {
      onError: () => {
        throw new Error("demo error hook blew up");
      },
    },
  );
  const onErrorProbeState = onErrorProbeEscrow.dispatch(
    "FUND",
    "Deposit locked (wire received)",
    500,
    { actor: "sponsor", at: DEMO_ONERROR_FUND_AT },
  );
  let onErrorInvalidError = "";
  try {
    onErrorEscrow.subscribe(() => {}, {
      onError: "x" as never,
    });
  } catch (err) {
    onErrorInvalidError = err instanceof Error ? err.message : String(err);
  }
  if (
    onErrorStates.join(",") !== "FUNDED,MILESTONE_SUBMITTED,VERIFIED" ||
    onErrorReports.length !== DEMO_ONERROR_EXPECTED_REPORTS.length ||
    onErrorReports.some((report, i) => {
      const expected = DEMO_ONERROR_EXPECTED_REPORTS[i];
      const entry = onErrorEscrow.history[i];
      return (
        report.message !== expected.message ||
        report.event !== expected.event ||
        report.from !== expected.from ||
        report.to !== expected.to ||
        entry === undefined ||
        entry.event !== report.event ||
        entry.from !== report.from ||
        entry.to !== report.to
      );
    }) ||
    onErrorEscrow.state !== "VERIFIED" ||
    onErrorEscrow.history.length !== 3 ||
    onErrorProbeState !== "FUNDED" ||
    onErrorProbeEscrow.state !== "FUNDED" ||
    onErrorProbeEscrow.history.length !== 1 ||
    onErrorInvalidError !== DEMO_ONERROR_INVALID_ERROR ||
    onErrorEscrow.listenerCount !== 1
  ) {
    throw new Error(
      "demo fixture broken: Escrow.subscribe onError routing does not match the pinned shape (three successful dispatches to VERIFIED with 3 history entries, one report per dispatch with the pinned message and context matching history, throwing onError swallowed on the probe escrow, non-function onError rejected with the pinned error and nothing registered)",
    );
  }
  lines.push(
    "",
    "Subscribe onError error routing (Escrow.subscribe(listener, { onError }) on a branch escrow):",
    `  escrow ${onErrorEscrow.id}: 1 throwing listener + 1 collecting onError — 3 fixed dispatches (FUND, SUBMIT_MILESTONE, VERIFY_PASS) all succeeded: state ${onErrorEscrow.state}, ${onErrorEscrow.history.length} history entries (a throwing listener never breaks dispatch or the audit trail)`,
    `  onError received: ${onErrorReports.length} report(s) — first: "${onErrorReports[0].message}" on ${onErrorReports[0].event} ${onErrorReports[0].from} -> ${onErrorReports[0].to} (the error travels with its dispatch context)`,
    `  all contexts: ${onErrorReports.map((r) => `${r.event} ${r.from} -> ${r.to}`).join("; ")}`,
    `  probe escrow ${onErrorProbeEscrow.id}: an onError that itself throws is swallowed too — dispatch FUND still returned ${onErrorProbeState} (${onErrorProbeEscrow.history.length} history entry)`,
    `  non-function onError rejected at subscribe time: "${onErrorInvalidError}" — nothing was registered (listenerCount still ${onErrorEscrow.listenerCount})`,
  );

  // --- Quorum revoke: revoke() vote change (final closing) ---
  // The approval-log segment above narrates that only
  // revoke() removes a signer's entries, but no demo
  // segment ever called it: the change-of-vote semantics
  // lived only in the unit tests and the bench. Here a
  // fresh quorum (2-of-3, same signer ids, fixed clock)
  // collects arb-1 and arb-2 and reaches its threshold;
  // arb-1 then revokes — the count drops to 1, hasQuorum
  // turns false, approvals() is exactly [arb-2], and the
  // audit trail keeps only arb-2's entry — and arb-1
  // re-approves at a later fixed instant, restoring the
  // threshold with the re-voter last in approvals()
  // order. Two failed revokes close the segment: an
  // unknown signer and a signer that never approved
  // (arb-3) are each rejected with their exact error and
  // leave the quorum untouched. Hand-pinned expectations
  // (see the fixture comment above), asserted HERE,
  // outside the printing: a revoke that left the entry in
  // the trail, a re-approval that kept the old order, or
  // a failed revoke that mutated the quorum would fail
  // the demo itself, not just a test. Zero network, zero
  // randomness; the quorum clock is set to fixed instants
  // only.
  let quorumRevokeNowMs = Date.parse(DEMO_REVOKE_FIRST_AT);
  const quorumRevokeQuorum = createQuorum({
    threshold: DEMO_QUORUM_THRESHOLD,
    signers: [...DEMO_QUORUM_SIGNERS],
    now: () => quorumRevokeNowMs,
  });
  quorumRevokeQuorum.approve(DEMO_QUORUM_SIGNERS[0]);
  quorumRevokeNowMs = Date.parse(DEMO_REVOKE_SECOND_AT);
  quorumRevokeQuorum.approve(DEMO_QUORUM_SIGNERS[1]);
  const quorumRevokeCountBefore = quorumRevokeQuorum.approvalCount();
  const quorumRevokeHasQuorumBefore = quorumRevokeQuorum.hasQuorum();
  quorumRevokeQuorum.revoke(DEMO_QUORUM_SIGNERS[0]);
  const quorumRevokeCountAfterRevoke = quorumRevokeQuorum.approvalCount();
  const quorumRevokeHasQuorumAfterRevoke = quorumRevokeQuorum.hasQuorum();
  const quorumRevokeApprovalsAfterRevoke = quorumRevokeQuorum.approvals();
  const quorumRevokeLogAfterRevoke = quorumRevokeQuorum.approvalLog();
  quorumRevokeNowMs = Date.parse(DEMO_REVOKE_REAPPROVE_AT);
  quorumRevokeQuorum.approve(DEMO_QUORUM_SIGNERS[0]);
  const quorumRevokeCountAfterReapprove = quorumRevokeQuorum.approvalCount();
  const quorumRevokeHasQuorumAfterReapprove = quorumRevokeQuorum.hasQuorum();
  const quorumRevokeApprovalsAfterReapprove = quorumRevokeQuorum.approvals();
  const quorumRevokeLogFinal = quorumRevokeQuorum.approvalLog();
  let quorumRevokeUnknownError = "";
  try {
    quorumRevokeQuorum.revoke(DEMO_REVOKE_UNKNOWN_SIGNER);
  } catch (err) {
    quorumRevokeUnknownError = err instanceof Error ? err.message : String(err);
  }
  let quorumRevokeNotApprovedError = "";
  try {
    quorumRevokeQuorum.revoke(DEMO_QUORUM_SIGNERS[2]);
  } catch (err) {
    quorumRevokeNotApprovedError =
      err instanceof Error ? err.message : String(err);
  }
  const sameStringList = (
    actual: readonly string[],
    expected: readonly string[],
  ): boolean =>
    actual.length === expected.length &&
    actual.every((v, i) => v === expected[i]);
  if (
    quorumRevokeCountBefore !== 2 ||
    quorumRevokeHasQuorumBefore !== true ||
    quorumRevokeCountAfterRevoke !== 1 ||
    quorumRevokeHasQuorumAfterRevoke !== false ||
    !sameStringList(quorumRevokeApprovalsAfterRevoke, [
      DEMO_QUORUM_SIGNERS[1],
    ]) ||
    !sameApprovalEntries(
      quorumRevokeLogAfterRevoke,
      DEMO_REVOKE_LOG_AFTER_REVOKE,
    ) ||
    quorumRevokeCountAfterReapprove !== 2 ||
    quorumRevokeHasQuorumAfterReapprove !== true ||
    !sameStringList(quorumRevokeApprovalsAfterReapprove, [
      DEMO_QUORUM_SIGNERS[1],
      DEMO_QUORUM_SIGNERS[0],
    ]) ||
    !sameApprovalEntries(quorumRevokeLogFinal, DEMO_REVOKE_LOG_FINAL) ||
    quorumRevokeUnknownError !== DEMO_REVOKE_UNKNOWN_ERROR ||
    quorumRevokeNotApprovedError !== DEMO_REVOKE_NOT_APPROVED_ERROR ||
    quorumRevokeQuorum.approvalCount() !== 2 ||
    quorumRevokeQuorum.hasQuorum() !== true
  ) {
    throw new Error(
      "demo fixture broken: quorum revoke does not match the pinned shape (2 counted / quorum before, revoke drops to 1 counted / no quorum with approvals [arb-2] and only arb-2 in the trail, re-approval restores 2 counted / quorum with the re-voter last, unknown-signer and never-approved revokes rejected with the pinned errors and the quorum untouched)",
    );
  }
  lines.push(
    "",
    "Quorum revoke (Quorum.revoke() — a signer changes their vote):",
    `  quorum (${DEMO_QUORUM_THRESHOLD}-of-${DEMO_QUORUM_SIGNERS.length}): approvals at ${DEMO_REVOKE_FIRST_AT} (${DEMO_QUORUM_SIGNERS[0]}) and ${DEMO_REVOKE_SECOND_AT} (${DEMO_QUORUM_SIGNERS[1]}) — approvalCount ${quorumRevokeCountBefore}, hasQuorum: ${quorumRevokeHasQuorumBefore}`,
    `  revoke ${DEMO_QUORUM_SIGNERS[0]}: approvalCount ${quorumRevokeCountAfterRevoke}, hasQuorum: ${quorumRevokeHasQuorumAfterRevoke} — approvals now [${quorumRevokeApprovalsAfterRevoke.join(", ")}], approvalLog keeps ${quorumRevokeLogAfterRevoke.length} entry (revoke removes the signer's entries; expiry never does)`,
    `  re-approve ${DEMO_QUORUM_SIGNERS[0]} at ${DEMO_REVOKE_REAPPROVE_AT}: approvalCount ${quorumRevokeCountAfterReapprove}, hasQuorum: ${quorumRevokeHasQuorumAfterReapprove} — approvals [${quorumRevokeApprovalsAfterReapprove.join(", ")}] (the re-voter sorts last, by latest approval)`,
    `  revoke unknown signer "${DEMO_REVOKE_UNKNOWN_SIGNER}" rejected: "${quorumRevokeUnknownError}"`,
    `  revoke ${DEMO_QUORUM_SIGNERS[2]} (never approved) rejected: "${quorumRevokeNotApprovedError}" — both failed revokes leave the quorum untouched (approvalCount still ${quorumRevokeQuorum.approvalCount()}, hasQuorum: ${quorumRevokeQuorum.hasQuorum()})`,
  );

  // --- Webhook AbortSignal: deliverSettlementWebhook(signal) (final closing) ---
  // Every delivery segment above ran to completion (or
  // retried to completion): the caller's power to CANCEL a
  // delivery lived only in the unit tests. Here the main
  // escrow's signed webhook is delivered twice more, each
  // time with a caller-owned AbortSignal wired into both
  // the in-flight request and the backoff sleep. Shape one
  // is pre-aborted: the controller aborts BEFORE the call,
  // and the delivery throws the pinned abort error with
  // the counting fake fetch never called — zero attempts,
  // exactly the shape a caller cancelling a queued webhook
  // needs. Shape two aborts DURING the backoff sleep: the
  // fake answers 500 on attempt 1 and schedules the abort
  // for the next macrotask from inside the fetch itself;
  // the pending 60-second sleep is rejected the moment the
  // abort lands, the delivery rejects with the same pinned
  // error, and no second fetch ever fires (the timer is
  // cleared, so the demo does not actually wait).
  // Hand-pinned expectations (see the fixture comment
  // above), asserted HERE, outside the printing: a delivery
  // that fetched despite a pre-abort, retried after a
  // backoff abort, or surfaced a different error would fail
  // the demo itself, not just a test. Scripted fakes on
  // `globalThis` only, restored afterwards: zero network,
  // zero real waiting, zero randomness, no wall clock.
  const abortPreController = new AbortController();
  abortPreController.abort();
  let abortPreAbortedFetchCalls = 0;
  const abortPreFetch: typeof fetch = async () => {
    abortPreAbortedFetchCalls += 1;
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const originalFetchForAbortPre = globalThis.fetch;
  let abortPreAbortedError = "";
  globalThis.fetch = abortPreFetch;
  try {
    await deliverSettlementWebhook(DEMO_ABORT_PRE_URL, webhook, {
      signal: abortPreController.signal,
    });
  } catch (err) {
    abortPreAbortedError = err instanceof Error ? err.message : String(err);
  } finally {
    globalThis.fetch = originalFetchForAbortPre;
  }
  const abortBackoffController = new AbortController();
  let abortDuringBackoffFetchCalls = 0;
  const abortBackoffFetch: typeof fetch = async () => {
    abortDuringBackoffFetchCalls += 1;
    setTimeout(() => abortBackoffController.abort(), 0);
    return new Response("boom", { status: 500 });
  };
  const originalFetchForAbortBackoff = globalThis.fetch;
  let abortDuringBackoffError = "";
  globalThis.fetch = abortBackoffFetch;
  try {
    await deliverSettlementWebhook(DEMO_ABORT_BACKOFF_URL, webhook, {
      signal: abortBackoffController.signal,
      backoffMs: DEMO_ABORT_BACKOFF_MS,
    });
  } catch (err) {
    abortDuringBackoffError =
      err instanceof Error ? err.message : String(err);
  } finally {
    globalThis.fetch = originalFetchForAbortBackoff;
  }
  if (
    abortPreAbortedError !== DEMO_ABORT_ERROR ||
    abortPreAbortedFetchCalls !== 0 ||
    abortDuringBackoffError !== DEMO_ABORT_ERROR ||
    abortDuringBackoffFetchCalls !== 1
  ) {
    throw new Error(
      "demo fixture broken: deliverSettlementWebhook AbortSignal does not match the pinned shape (pre-aborted signal throws the pinned abort error with zero fetch calls; abort during the pinned backoff rejects with the same error after exactly one fetch and no retry)",
    );
  }
  lines.push(
    "",
    "Webhook delivery abort (deliverSettlementWebhook with an AbortSignal, scripted fake fetch, zero network):",
    `  pre-aborted signal: endpoint ${DEMO_ABORT_PRE_URL} — delivery throws "${abortPreAbortedError}" before any request: fake fetch called ${abortPreAbortedFetchCalls} time(s), zero attempts made`,
    `  abort during backoff: endpoint ${DEMO_ABORT_BACKOFF_URL} — attempt 1 answered scripted 500, the caller aborts during the pinned ${DEMO_ABORT_BACKOFF_MS} ms backoff sleep: delivery rejects "${abortDuringBackoffError}", fake fetch called ${abortDuringBackoffFetchCalls} time(s) — no retry fires and the wait never elapses`,
    "  an abort is a caller request to stop, never a retryable failure: neither shape retries, sleeps it off, or reports success",
  );

  // --- Optimistic concurrency: dispatch expectedSeq guard (final closing) ---
  // Two writers that read the same escrow snapshot and
  // then race to dispatch off it are the payment
  // state-machine hazard the `expectedSeq` guard exists
  // for: the caller pins the seq it based its decision
  // on, and a stale pin fails loudly instead of silently
  // advancing a state it never saw. A fresh branch
  // escrow walks the guard in every shape on fixed
  // timestamps: two guarded dispatches whose pins match
  // the current seq advance exactly one entry each; a
  // VERIFY_PASS retried with the now-stale seq-1 pin (the
  // second writer's view) throws the pinned conflict
  // error and leaves state and history untouched; a
  // negative pin and a non-integer pin each throw the
  // pinned validation error — a caller configuration
  // error, checked before the transition itself; and a
  // final VERIFY_PASS with no pin at all succeeds,
  // because omitting the guard preserves the exact
  // pre-guard behavior. Hand-pinned expectations (see
  // the fixture comment above), asserted HERE, outside
  // the printing: a guarded dispatch that appended
  // anything but exactly one entry, a conflict that
  // moved the escrow, or a different error message
  // would fail the demo itself, not just a test. Zero
  // network, zero randomness, fixed timestamps.
  const expectedSeqEscrow = new Escrow(DEMO_EXPECTED_SEQ_ESCROW_ID);
  const expectedSeqFundState = expectedSeqEscrow.dispatch(
    "FUND",
    "Deposit locked (wire received)",
    10630,
    {
      actor: "sponsor",
      at: DEMO_EXPECTED_SEQ_FUND_AT,
      expectedSeq: 0,
    },
  );
  const expectedSeqSeqAfterFund = expectedSeqEscrow.history.length;
  const expectedSeqSubmitState = expectedSeqEscrow.dispatch(
    "SUBMIT_MILESTONE",
    "Deliverable URLs + IPFS metadata hash",
    undefined,
    {
      actor: "creator",
      at: DEMO_EXPECTED_SEQ_SUBMIT_AT,
      expectedSeq: 1,
    },
  );
  const expectedSeqSeqAfterSubmit = expectedSeqEscrow.history.length;
  let expectedSeqStaleError = "";
  try {
    expectedSeqEscrow.dispatch("VERIFY_PASS", undefined, undefined, {
      expectedSeq: 1,
    });
  } catch (err) {
    expectedSeqStaleError =
      err instanceof Error ? err.message : String(err);
  }
  const expectedSeqStateAfterStale = expectedSeqEscrow.state;
  const expectedSeqHistoryLengthAfterStale =
    expectedSeqEscrow.history.length;
  let expectedSeqInvalidNegativeError = "";
  try {
    expectedSeqEscrow.dispatch("VERIFY_PASS", undefined, undefined, {
      expectedSeq: -1,
    });
  } catch (err) {
    expectedSeqInvalidNegativeError =
      err instanceof Error ? err.message : String(err);
  }
  let expectedSeqInvalidFractionError = "";
  try {
    expectedSeqEscrow.dispatch("VERIFY_PASS", undefined, undefined, {
      expectedSeq: 1.5,
    });
  } catch (err) {
    expectedSeqInvalidFractionError =
      err instanceof Error ? err.message : String(err);
  }
  const expectedSeqUnguardedState = expectedSeqEscrow.dispatch(
    "VERIFY_PASS",
    "KPIs validated by oracle",
    undefined,
    {
      actor: "oracle",
      at: DEMO_EXPECTED_SEQ_VERIFY_AT,
      evidence: DEMO_EXPECTED_SEQ_VERIFY_EVIDENCE,
    },
  );
  const expectedSeqFinalHistoryLength = expectedSeqEscrow.history.length;
  if (
    expectedSeqFundState !== "FUNDED" ||
    expectedSeqSeqAfterFund !== 1 ||
    expectedSeqSubmitState !== "MILESTONE_SUBMITTED" ||
    expectedSeqSeqAfterSubmit !== 2 ||
    expectedSeqStaleError !== DEMO_EXPECTED_SEQ_STALE_ERROR ||
    expectedSeqStateAfterStale !== "MILESTONE_SUBMITTED" ||
    expectedSeqHistoryLengthAfterStale !== 2 ||
    expectedSeqInvalidNegativeError !==
      DEMO_EXPECTED_SEQ_INVALID_NEGATIVE_ERROR ||
    expectedSeqInvalidFractionError !==
      DEMO_EXPECTED_SEQ_INVALID_FRACTION_ERROR ||
    expectedSeqUnguardedState !== "VERIFIED" ||
    expectedSeqFinalHistoryLength !== 3 ||
    expectedSeqEscrow.state !== "VERIFIED"
  ) {
    throw new Error(
      "demo fixture broken: dispatch expectedSeq guard does not match the pinned shape (matching pins advance exactly one entry each, a stale pin throws the pinned conflict and changes nothing, negative and non-integer pins throw the pinned validation errors, and an unguarded dispatch keeps the pre-guard behavior)",
    );
  }
  lines.push(
    "",
    "Optimistic concurrency (dispatch expectedSeq guard on a branch escrow):",
    `  escrow ${expectedSeqEscrow.id}: FUND with expectedSeq 0 (the empty history): -> ${expectedSeqFundState}, seq 0 -> ${expectedSeqSeqAfterFund} (a matching guard advances exactly one entry)`,
    `  SUBMIT_MILESTONE with expectedSeq 1: -> ${expectedSeqSubmitState}, seq 1 -> ${expectedSeqSeqAfterSubmit} (the fresh pin matches again)`,
    `  VERIFY_PASS retried with stale expectedSeq 1 (a second writer still holding the seq-1 snapshot): throws "${expectedSeqStaleError}" — state stays ${expectedSeqStateAfterStale}, history stays ${expectedSeqHistoryLengthAfterStale} entries (nothing appended, nothing overwritten)`,
    `  VERIFY_PASS with expectedSeq -1: throws "${expectedSeqInvalidNegativeError}" (a caller configuration error, checked before the transition)`,
    `  VERIFY_PASS with expectedSeq 1.5: throws "${expectedSeqInvalidFractionError}" (a non-integer pin is rejected the same way)`,
    `  VERIFY_PASS without expectedSeq: -> ${expectedSeqUnguardedState}, seq 2 -> ${expectedSeqFinalHistoryLength} (omitting the guard preserves the pre-guard behavior)`,
  );

  // --- Verify evidence gate: requireVerifyEvidence (final closing) ---
  // VERIFY_PASS is a caller trust decision: nothing in
  // this library verifies an oracle signature, a zk
  // proof, or a TEE attestation. The opt-in
  // `requireVerifyEvidence` flag is the audit guardrail
  // on top of that decision — it makes the caller cite
  // the evidence reference it relied on, recorded
  // verbatim on the audit entry, and refuses the
  // dispatch outright when no reference is given. Two
  // fresh branch escrows walk the gate in every shape
  // on fixed timestamps: the strict escrow
  // (DEMO-ESC-017, flag on) is driven to
  // MILESTONE_SUBMITTED, its evidence-free VERIFY_PASS
  // throws the pinned error and leaves state and
  // history untouched, and the same dispatch carrying
  // the pinned evidence reference then succeeds with
  // the reference on the audit entry; the default
  // escrow (DEMO-ESC-018, flag off) dispatches the
  // same evidence-free VERIFY_PASS successfully,
  // because omitting the flag preserves the exact
  // pre-gate behavior. Hand-pinned expectations (see
  // the fixture comment above), asserted HERE, outside
  // the printing: a rejection that appended anything,
  // a recorded reference that differed, or a default
  // escrow that behaved differently would fail the
  // demo itself, not just a test. Zero network, zero
  // randomness, fixed timestamps.
  const verifyEvidenceEscrow = new Escrow(DEMO_VERIFY_EVIDENCE_ESCROW_ID, {
    requireVerifyEvidence: true,
  });
  verifyEvidenceEscrow.dispatch(
    "FUND",
    "Deposit locked (wire received)",
    10630,
    {
      actor: "sponsor",
      at: DEMO_VERIFY_EVIDENCE_FUND_AT,
    },
  );
  verifyEvidenceEscrow.dispatch(
    "SUBMIT_MILESTONE",
    "Deliverable URLs + IPFS metadata hash",
    undefined,
    {
      actor: "creator",
      at: DEMO_VERIFY_EVIDENCE_SUBMIT_AT,
    },
  );
  let verifyEvidenceError = "";
  try {
    verifyEvidenceEscrow.dispatch("VERIFY_PASS", "KPIs validated by oracle", undefined, {
      actor: "oracle",
      at: DEMO_VERIFY_EVIDENCE_VERIFY_AT,
    });
  } catch (err) {
    verifyEvidenceError =
      err instanceof Error ? err.message : String(err);
  }
  const verifyEvidenceStateAfterReject = verifyEvidenceEscrow.state;
  const verifyEvidenceHistoryLengthAfterReject =
    verifyEvidenceEscrow.history.length;
  const verifyEvidenceVerifiedState = verifyEvidenceEscrow.dispatch(
    "VERIFY_PASS",
    "KPIs validated by oracle",
    undefined,
    {
      actor: "oracle",
      at: DEMO_VERIFY_EVIDENCE_VERIFY_AT,
      evidence: DEMO_VERIFY_EVIDENCE_REF,
    },
  );
  const verifyEvidenceRecordedEvidence =
    verifyEvidenceEscrow.history[verifyEvidenceEscrow.history.length - 1]
      .evidence ?? "";
  const verifyEvidenceDefaultEscrow = new Escrow(
    DEMO_VERIFY_EVIDENCE_DEFAULT_ESCROW_ID,
  );
  verifyEvidenceDefaultEscrow.dispatch(
    "FUND",
    "Deposit locked (wire received)",
    10630,
    {
      actor: "sponsor",
      at: DEMO_VERIFY_EVIDENCE_FUND_AT,
    },
  );
  verifyEvidenceDefaultEscrow.dispatch(
    "SUBMIT_MILESTONE",
    "Deliverable URLs + IPFS metadata hash",
    undefined,
    {
      actor: "creator",
      at: DEMO_VERIFY_EVIDENCE_SUBMIT_AT,
    },
  );
  const verifyEvidenceDefaultState = verifyEvidenceDefaultEscrow.dispatch(
    "VERIFY_PASS",
    "KPIs validated by oracle",
    undefined,
    {
      actor: "oracle",
      at: DEMO_VERIFY_EVIDENCE_VERIFY_AT,
    },
  );
  if (
    verifyEvidenceError !== DEMO_VERIFY_EVIDENCE_ERROR ||
    verifyEvidenceStateAfterReject !== "MILESTONE_SUBMITTED" ||
    verifyEvidenceHistoryLengthAfterReject !== 2 ||
    verifyEvidenceVerifiedState !== "VERIFIED" ||
    verifyEvidenceRecordedEvidence !== DEMO_VERIFY_EVIDENCE_REF ||
    verifyEvidenceEscrow.state !== "VERIFIED" ||
    verifyEvidenceEscrow.history.length !== 3 ||
    verifyEvidenceDefaultState !== "VERIFIED" ||
    verifyEvidenceDefaultEscrow.history.length !== 3 ||
    "evidence" in
      verifyEvidenceDefaultEscrow.history[
        verifyEvidenceDefaultEscrow.history.length - 1
      ]
  ) {
    throw new Error(
      "demo fixture broken: requireVerifyEvidence gate does not match the pinned shape (an evidence-free VERIFY_PASS on the strict escrow throws the pinned error and changes nothing, the same dispatch with evidence succeeds and records the reference verbatim, and a default escrow keeps the pre-gate behavior)",
    );
  }
  lines.push(
    "",
    "Verify evidence gate (EscrowOptions.requireVerifyEvidence on branch escrows):",
    `  escrow ${verifyEvidenceEscrow.id} (requireVerifyEvidence: true): FUND 10630 -> FUNDED, SUBMIT_MILESTONE -> MILESTONE_SUBMITTED on fixed timestamps (the gate is armed)`,
    `  VERIFY_PASS without evidence: throws "${verifyEvidenceError}" — state stays ${verifyEvidenceStateAfterReject}, history stays ${verifyEvidenceHistoryLengthAfterReject} entries (nothing appended)`,
    `  VERIFY_PASS with evidence "${DEMO_VERIFY_EVIDENCE_REF}": -> ${verifyEvidenceVerifiedState}, evidence recorded verbatim on the audit entry (the library records the caller's reference; it does not verify the oracle or proof itself)`,
    `  escrow ${verifyEvidenceDefaultEscrow.id} (default, flag off): VERIFY_PASS without evidence -> ${verifyEvidenceDefaultState} (omitting the flag preserves the pre-gate behavior)`,
  );

  // --- Keyed audit chain: verifyHistoryChain auditKey (final closing) ---
  // The main escrow's audit chain above is the UNKEYED
  // form: plain SHA-256 links are tamper evidence, but
  // anyone who rewrites the whole log can recompute
  // them. The opt-in keyed mode is the upgrade to a
  // real MAC: an escrow constructed with
  // `EscrowOptions.auditKey` links every entry with
  // HMAC-SHA256 under that key, so a full-log rewrite
  // is detected without the key. One fresh branch
  // escrow walks the keyed chain in every shape on
  // fixed timestamps: the full lifecycle lands on
  // RELEASED with 4 HMAC-linked entries; the correct
  // key verifies; a wrong key and no key at all both
  // fail closed (the two modes reject each other); a
  // detached copy with its middle entry's note
  // rewritten fails even under the correct key; and
  // the escrow's own history still verifies after the
  // tamper check. The key is per-instance
  // configuration — never written into snapshots —
  // and key management stays the caller's problem.
  // Hand-pinned expectations (see the fixture comment
  // above), asserted HERE, outside the printing: a
  // keyed chain that verified keylessly, under a wrong
  // key, or after a rewrite would fail the demo
  // itself, not just a test. Zero network, zero
  // randomness, fixed timestamps.
  const auditKeyEscrow = new Escrow(DEMO_AUDIT_KEY_ESCROW_ID, {
    auditKey: DEMO_AUDIT_KEY,
  });
  auditKeyEscrow.dispatch(
    "FUND",
    "Deposit locked (wire received)",
    10630,
    {
      actor: "sponsor",
      at: DEMO_AUDIT_KEY_FUND_AT,
    },
  );
  auditKeyEscrow.dispatch(
    "SUBMIT_MILESTONE",
    DEMO_AUDIT_KEY_SUBMIT_NOTE,
    undefined,
    {
      actor: "creator",
      at: DEMO_AUDIT_KEY_SUBMIT_AT,
    },
  );
  auditKeyEscrow.dispatch(
    "VERIFY_PASS",
    "KPIs validated by oracle",
    undefined,
    {
      actor: "oracle",
      at: DEMO_AUDIT_KEY_VERIFY_AT,
      evidence: DEMO_AUDIT_KEY_VERIFY_EVIDENCE,
    },
  );
  auditKeyEscrow.dispatch(
    "RELEASE",
    "Verification passed — release funds",
    undefined,
    {
      actor: "system",
      at: DEMO_AUDIT_KEY_RELEASE_AT,
    },
  );
  const auditKeyHistoryLength = auditKeyEscrow.history.length;
  const auditKeyChainVerified = verifyHistoryChain(
    auditKeyEscrow.history,
    DEMO_AUDIT_KEY,
  );
  const auditKeyWrongKeyVerified = verifyHistoryChain(
    auditKeyEscrow.history,
    DEMO_AUDIT_WRONG_KEY,
  );
  const auditKeyNoKeyVerified = verifyHistoryChain(auditKeyEscrow.history);
  const auditKeyTamperedHistory = auditKeyEscrow.history.map((entry) => ({
    ...entry,
  }));
  const auditKeyTamperedEntry = auditKeyTamperedHistory[1];
  if (
    auditKeyTamperedEntry === undefined ||
    auditKeyTamperedEntry.event !== "SUBMIT_MILESTONE"
  ) {
    throw new Error(
      "demo fixture broken: keyed history has no SUBMIT_MILESTONE middle entry",
    );
  }
  auditKeyTamperedEntry.note = DEMO_AUDIT_KEY_TAMPERED_NOTE;
  const auditKeyTamperedNote = auditKeyTamperedEntry.note;
  const auditKeyTamperedVerified = verifyHistoryChain(
    auditKeyTamperedHistory,
    DEMO_AUDIT_KEY,
  );
  const auditKeyRecheckVerified = verifyHistoryChain(
    auditKeyEscrow.history,
    DEMO_AUDIT_KEY,
  );
  if (
    auditKeyEscrow.state !== "RELEASED" ||
    auditKeyHistoryLength !== 4 ||
    auditKeyChainVerified !== true ||
    auditKeyWrongKeyVerified !== false ||
    auditKeyNoKeyVerified !== false ||
    auditKeyTamperedVerified !== false ||
    auditKeyTamperedNote !== DEMO_AUDIT_KEY_TAMPERED_NOTE ||
    auditKeyRecheckVerified !== true ||
    auditKeyEscrow.history[0].prevHash !== GENESIS_PREV_HASH ||
    auditKeyEscrow.history.some(
      (entry, i) =>
        i > 0 &&
        entry.prevHash !== auditKeyEscrow.history[i - 1].hash,
    )
  ) {
    throw new Error(
      "demo fixture broken: verifyHistoryChain auditKey does not match the pinned shape (the correct key verifies the intact keyed chain, a wrong key and no key both fail closed, a rewritten middle entry fails even under the correct key, and the escrow's own history is untouched)",
    );
  }
  lines.push(
    "",
    "Keyed audit chain (verifyHistoryChain with EscrowOptions.auditKey on a branch escrow):",
    `  escrow ${auditKeyEscrow.id} (auditKey set): FUND 10630 -> FUNDED, SUBMIT_MILESTONE -> MILESTONE_SUBMITTED, VERIFY_PASS -> VERIFIED, RELEASE -> RELEASED on fixed timestamps (${auditKeyHistoryLength} entries, every hash an HMAC-SHA256 link under the pinned key)`,
    `  verifyHistoryChain(history, auditKey): ${auditKeyChainVerified} (the correct key recomputes every HMAC link)`,
    `  verifyHistoryChain(history, wrong key): ${auditKeyWrongKeyVerified} (a wrong key recomputes nothing — fail-closed)`,
    `  verifyHistoryChain(history) without a key: ${auditKeyNoKeyVerified} (a keyed chain never verifies keylessly — the two modes fail closed against each other)`,
    `  tampered copy: SUBMIT_MILESTONE note rewritten to "${auditKeyTamperedNote}" — verifyHistoryChain(tampered, auditKey): ${auditKeyTamperedVerified} (tamper detected even for the key holder: the stored HMAC no longer recomputes)`,
    `  original history after the tamper check: verifyHistoryChain: ${auditKeyRecheckVerified} (detached copy — the escrow's own history is untouched; the demo key is a printed placeholder, not a real secret)`,
  );

  // --- Webhook delivery timeout: deliverSettlementWebhook timeoutMs (final closing) ---
  // Every delivery segment above answered promptly (or
  // was cancelled by the caller): a SLOW endpoint that
  // never answers — the failure the per-attempt
  // `timeoutMs` bound exists for — lived only in the
  // unit tests. Here the main escrow's signed webhook is
  // delivered three more times against scripted fake
  // `fetch` seams installed on `globalThis` for this
  // segment only (the original restored afterwards).
  // Shape one hangs: the fake only ever rejects when its
  // request signal aborts, so with the pinned short
  // `timeoutMs` and `retries: 0` the per-attempt timeout
  // is the only thing that can end the attempt — the
  // delivery fails after exactly 1 attempt with the
  // pinned timeout text as its last cause, and the fake
  // is called exactly once. Shape two is configuration:
  // `timeoutMs: 0` throws the pinned configuration error
  // before any request, with the counting fake never
  // called. Shape three is the control: under the
  // generous pinned timeout an immediately-200 fake
  // delivers successfully with the unchanged
  // `{status: 200, attempts: 1}` shape. Hand-pinned
  // expectations (see the fixture comment above),
  // asserted HERE, outside the printing: a delivery that
  // hung past its timeout, retried despite `retries: 0`,
  // fetched despite the illegal value, or changed its
  // success shape would fail the demo itself, not just a
  // test. Honest limit: the timeout wait is the object
  // under test and is the pinned short duration — no
  // elapsed-time (wall-clock) assertion is made, and no
  // duration is printed, so the output stays
  // byte-identical across runs. Zero real network, zero
  // randomness.
  let timeoutDeliveryFetchCalls = 0;
  const timeoutHangingFetch: typeof fetch = async (_input, init) => {
    timeoutDeliveryFetchCalls += 1;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal === null || signal === undefined) {
        reject(new Error("demo hanging fetch received no request signal"));
        return;
      }
      if (signal.aborted) {
        reject(new Error("demo hanging fetch aborted"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => reject(new Error("demo hanging fetch aborted")),
        { once: true },
      );
    });
  };
  const originalFetchForTimeout = globalThis.fetch;
  let timeoutDeliveryError = "";
  globalThis.fetch = timeoutHangingFetch;
  try {
    await deliverSettlementWebhook(DEMO_TIMEOUT_URL, webhook, {
      timeoutMs: DEMO_TIMEOUT_MS,
      retries: 0,
    });
  } catch (err) {
    timeoutDeliveryError = err instanceof Error ? err.message : String(err);
  } finally {
    globalThis.fetch = originalFetchForTimeout;
  }
  let timeoutInvalidFetchCalls = 0;
  const timeoutCountingFetch: typeof fetch = async () => {
    timeoutInvalidFetchCalls += 1;
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const originalFetchForTimeoutInvalid = globalThis.fetch;
  let timeoutInvalidError = "";
  globalThis.fetch = timeoutCountingFetch;
  try {
    await deliverSettlementWebhook(DEMO_TIMEOUT_URL, webhook, {
      timeoutMs: 0,
      retries: 0,
    });
  } catch (err) {
    timeoutInvalidError = err instanceof Error ? err.message : String(err);
  } finally {
    globalThis.fetch = originalFetchForTimeoutInvalid;
  }
  let timeoutOkFetchCalls = 0;
  const timeoutOkFetch: typeof fetch = async () => {
    timeoutOkFetchCalls += 1;
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const originalFetchForTimeoutOk = globalThis.fetch;
  let timeoutOkResult: WebhookDeliveryResult;
  globalThis.fetch = timeoutOkFetch;
  try {
    timeoutOkResult = await deliverSettlementWebhook(DEMO_TIMEOUT_OK_URL, webhook, {
      timeoutMs: DEMO_TIMEOUT_GENEROUS_MS,
      retries: 0,
    });
  } finally {
    globalThis.fetch = originalFetchForTimeoutOk;
  }
  if (
    timeoutDeliveryError !== DEMO_TIMEOUT_DELIVERY_ERROR ||
    timeoutDeliveryFetchCalls !== 1 ||
    timeoutInvalidError !== DEMO_TIMEOUT_INVALID_ERROR ||
    timeoutInvalidFetchCalls !== 0 ||
    timeoutOkResult.status !== 200 ||
    timeoutOkResult.attempts !== 1 ||
    timeoutOkFetchCalls !== 1
  ) {
    throw new Error(
      "demo fixture broken: deliverSettlementWebhook timeoutMs does not match the pinned shape (hanging fetch with the pinned short timeout and retries 0 fails after exactly 1 attempt with the pinned timeout text and exactly 1 fetch call, timeoutMs 0 throws the pinned configuration error with zero fetch calls, and a generous timeout over an immediate 200 resolves {status: 200, attempts: 1} after exactly 1 fetch call)",
    );
  }
  lines.push(
    "",
    "Webhook delivery timeout (deliverSettlementWebhook timeoutMs via hanging fake fetch, zero network):",
    `  timed out: endpoint ${DEMO_TIMEOUT_URL} never answers (the hanging fake fetch only rejects on abort), timeoutMs ${DEMO_TIMEOUT_MS} ms, retries 0 — delivery fails "${timeoutDeliveryError}": fake fetch called ${timeoutDeliveryFetchCalls} time(s), exactly 1 attempt`,
    `  illegal timeoutMs 0: delivery throws "${timeoutInvalidError}" before any request: fake fetch called ${timeoutInvalidFetchCalls} time(s)`,
    `  generous timeout: endpoint ${DEMO_TIMEOUT_OK_URL} answers 200 immediately, timeoutMs ${DEMO_TIMEOUT_GENEROUS_MS} ms — result: status ${timeoutOkResult.status}, attempts ${timeoutOkResult.attempts} (the success shape is unchanged under a generous timeout), fake fetch called ${timeoutOkFetchCalls} time(s)`,
    "  a timeout is a per-attempt bound, handled by the retry policy like any network error: the pinned short wait above is the object under test itself — no elapsed time is asserted or printed",
  );

  // --- Idempotency-Key header: deliverSettlementWebhook retry (closing) ---
  // The X-Event-Id segment proved the vendor header
  // survives a genuine retry, but no demo delivery ever
  // showed the standard payment-gateway header receivers
  // deduplicate on: `Idempotency-Key`. Here the main
  // escrow's signed webhook is delivered for real over
  // HTTP to a loopback server (ephemeral port, path
  // pinned above — the port itself is never printed, so
  // the output stays byte-identical across runs). The
  // loopback endpoint answers 500 on the first attempt
  // and 200 on the retry, so the delivery resolves
  // {status: 200, attempts: 2} through a genuine retry,
  // not a scripted fake. Hand-pinned expectations (see
  // the fixture comment above), asserted HERE, outside
  // the printing: both captured requests carry
  // Idempotency-Key exactly equal to the body's
  // eventId — the header does not drift across the
  // retry, so a retried delivery is not mistaken for a
  // second event — and both carry X-Event-Id equal to
  // that same body eventId, so the two headers coexist
  // on one wire keyed to the one logical event. A
  // delivery that minted a fresh key per attempt would
  // fail the demo itself. `backoffMs: 0` keeps the
  // retry wait at zero and `allowInsecureHttp: true`
  // is the explicit loopback opt-out (plaintext is
  // refused by default).
  const idempotencyHeaderRetryCalls: Array<{
    path: string;
    status: number;
    idempotencyKeyHeader: string;
    eventIdHeader: string;
    body: string;
    bodyEventId: string;
  }> = [];
  const idempotencyHeaderServer = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const body = Buffer.concat(chunks).toString("utf8");
      let bodyEventId = "";
      try {
        const parsed = JSON.parse(body) as { eventId?: unknown };
        bodyEventId =
          typeof parsed.eventId === "string" ? parsed.eventId : "";
      } catch {
        bodyEventId = "";
      }
      const idempotencyKeyHeader = String(
        req.headers["idempotency-key"] ?? "",
      );
      const eventIdHeader = String(req.headers["x-event-id"] ?? "");
      if (req.url === DEMO_IDEMPOTENCY_HEADER_RETRY_PATH) {
        const status =
          DEMO_IDEMPOTENCY_HEADER_RETRY_STATUSES[
            Math.min(
              idempotencyHeaderRetryCalls.length,
              DEMO_IDEMPOTENCY_HEADER_RETRY_STATUSES.length - 1,
            )
          ];
        idempotencyHeaderRetryCalls.push({
          path: DEMO_IDEMPOTENCY_HEADER_RETRY_PATH,
          status,
          idempotencyKeyHeader,
          eventIdHeader,
          body,
          bodyEventId,
        });
        res.writeHead(status, { "content-type": "application/json" });
        res.end(status === 200 ? "{}" : "boom");
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    })();
  });
  await new Promise<void>((resolve, reject) => {
    idempotencyHeaderServer.once("error", reject);
    idempotencyHeaderServer.listen(0, "127.0.0.1", () => resolve());
  });
  const idempotencyHeaderAddress = idempotencyHeaderServer.address();
  if (
    idempotencyHeaderAddress === null ||
    typeof idempotencyHeaderAddress === "string"
  ) {
    idempotencyHeaderServer.close();
    throw new Error(
      "demo fixture broken: Idempotency-Key loopback server did not bind to a TCP port",
    );
  }
  const idempotencyHeaderBase = `http://127.0.0.1:${idempotencyHeaderAddress.port}`;
  let idempotencyHeaderRetryResult: WebhookDeliveryResult;
  try {
    idempotencyHeaderRetryResult = await deliverSettlementWebhook(
      `${idempotencyHeaderBase}${DEMO_IDEMPOTENCY_HEADER_RETRY_PATH}`,
      webhook,
      { backoffMs: 0, allowInsecureHttp: true },
    );
  } finally {
    idempotencyHeaderServer.closeAllConnections();
    await new Promise<void>((resolve) => {
      idempotencyHeaderServer.close(() => resolve());
    });
  }
  if (
    idempotencyHeaderRetryResult.status !== 200 ||
    idempotencyHeaderRetryResult.attempts !== 2 ||
    idempotencyHeaderRetryCalls.length !== 2 ||
    idempotencyHeaderRetryCalls.some(
      (call, i) =>
        call.path !== DEMO_IDEMPOTENCY_HEADER_RETRY_PATH ||
        call.status !== DEMO_IDEMPOTENCY_HEADER_RETRY_STATUSES[i] ||
        call.idempotencyKeyHeader !== DEMO_WEBHOOK_EVENT_ID ||
        call.eventIdHeader !== DEMO_WEBHOOK_EVENT_ID ||
        call.bodyEventId !== DEMO_WEBHOOK_EVENT_ID ||
        call.body !== JSON.stringify(webhook.payload),
    )
  ) {
    throw new Error(
      "demo fixture broken: deliverSettlementWebhook Idempotency-Key header does not match the pinned shape (loopback 500 then 200, result {status: 200, attempts: 2}, both attempts' Idempotency-Key equal to the body eventId, both attempts' X-Event-Id equal to that same body eventId, bodies byte-identical)",
    );
  }
  lines.push(
    "",
    "Settlement webhook Idempotency-Key header (deliverSettlementWebhook retry over a loopback server):",
    `  retry: the main escrow's signed webhook (body eventId ${DEMO_WEBHOOK_EVENT_ID}) delivered to ${DEMO_IDEMPOTENCY_HEADER_RETRY_PATH} — attempt 1 answered 500, attempt 2 answered 200; result: status ${idempotencyHeaderRetryResult.status}, attempts ${idempotencyHeaderRetryResult.attempts} (succeeded after exactly one retry, backoffMs 0 — no real waiting)`,
    `  retry wire check: ${idempotencyHeaderRetryCalls.length} captured POSTs — the Idempotency-Key header on attempt 1 and on the retry are both ${DEMO_WEBHOOK_EVENT_ID}, identical to each other and to the body eventId on both attempts`,
    `  coexistence: the same 2 captured POSTs also carry X-Event-Id ${DEMO_WEBHOOK_EVENT_ID} = body eventId ${DEMO_WEBHOOK_EVENT_ID} — the standard idempotency header and the vendor header travel on one wire, both keyed to the one logical event, so a receiver deduplicating on either header sees the same key`,
    "  note: the header is a transport hint only — it is NOT covered by the signature, so a receiver verifies the signature first and then trusts the body's eventId, never the header, as the deduplication key",
  );

  // --- Fan-out limits: deliverSettlementWebhookToMany maxEndpoints / overallDeadlineMs (closing) ---
  // The fan-out segment above proved one logical event reaches
  // every endpoint, and the unit tests proved the two fan-out
  // guards - but no demo segment ever showed them: a caller
  // reading the demo learned the fan-out shape and never saw
  // the cap that keeps one settlement event from turning into
  // an endpoint explosion, nor the wall-clock budget that keeps
  // one hanging endpoint from holding the whole fan-out open.
  // Here the main escrow's report is fanned out over a real
  // loopback server (ephemeral port, paths pinned above - the
  // port itself is never printed, so the output stays
  // byte-identical across runs). Shape one is the cap: 3
  // endpoints under `maxEndpoints: 2` throw the pinned
  // configuration error before any request, so the loopback
  // server records 0 requests. Shape two is the deadline:
  // the same report goes to one fast endpoint and one endpoint
  // that never answers, under `overallDeadlineMs: 100` with a
  // 10,000 ms per-attempt timeout and `retries: 0` - so the
  // deadline, not the per-attempt timeout, is the only thing
  // that can stop the hanging delivery, and no retry can
  // mask it. Hand-pinned expectations (see the fixture comment
  // above), asserted HERE, outside the printing: the cap error
  // equals the pinned text and the server recorded 0 requests
  // at that point; the deadline call then records exactly one
  // fast and one hanging request and no second fast request,
  // the fast result is `{ok: true, attempts: 1, status: 200}`,
  // the hanging result is `{ok: false, attempts: 1}` with the
  // pinned deadline error, and the aggregate reads delivered
  // 1 / failed 1 with `deadlineExceeded: true`. A cap that
  // fetched, a deadline that waited out the per-attempt
  // timeout, or a completed endpoint dropped by the deadline
  // would fail the demo itself. Honest limit: the 100 ms
  // deadline is the object under test - no elapsed time is
  // asserted or printed.
  const fanoutLimitCalls: Array<{ path: string }> = [];
  const fanoutLimitServer = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const path = req.url ?? "";
      if (
        path === DEMO_FANOUT_LIMIT_FAST_A_PATH ||
        path === DEMO_FANOUT_LIMIT_FAST_B_PATH
      ) {
        fanoutLimitCalls.push({ path });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      if (path === DEMO_FANOUT_LIMIT_HANG_PATH) {
        fanoutLimitCalls.push({ path });
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    })();
  });
  await new Promise<void>((resolve, reject) => {
    fanoutLimitServer.once("error", reject);
    fanoutLimitServer.listen(0, "127.0.0.1", () => resolve());
  });
  const fanoutLimitAddress = fanoutLimitServer.address();
  if (
    fanoutLimitAddress === null ||
    typeof fanoutLimitAddress === "string"
  ) {
    fanoutLimitServer.close();
    throw new Error(
      "demo fixture broken: fan-out limit loopback server did not bind to a TCP port",
    );
  }
  const fanoutLimitBase = `http://127.0.0.1:${fanoutLimitAddress.port}`;
  let fanoutLimitCapError = "";
  let fanoutLimitCallsAfterCap = -1;
  let fanoutLimitDeadlineResult: DeliverSettlementWebhookToManyResult;
  try {
    try {
      await deliverSettlementWebhookToMany(
        report,
        [
          {
            url: `${fanoutLimitBase}${DEMO_FANOUT_LIMIT_FAST_A_PATH}`,
            secret: DEMO_FANOUT_LIMIT_SECRET_A,
          },
          {
            url: `${fanoutLimitBase}${DEMO_FANOUT_LIMIT_FAST_B_PATH}`,
            secret: DEMO_FANOUT_LIMIT_SECRET_B,
          },
          {
            url: `${fanoutLimitBase}${DEMO_FANOUT_LIMIT_HANG_PATH}`,
            secret: DEMO_FANOUT_LIMIT_SECRET_C,
          },
        ],
        {
          now: DEMO_FANOUT_LIMIT_AT,
          eventId: DEMO_FANOUT_LIMIT_EVENT_ID,
          maxEndpoints: DEMO_FANOUT_LIMIT_CAP,
          backoffMs: 0,
          allowInsecureHttp: true,
        },
      );
    } catch (err) {
      fanoutLimitCapError = err instanceof Error ? err.message : String(err);
    }
    fanoutLimitCallsAfterCap = fanoutLimitCalls.length;
    fanoutLimitDeadlineResult = await deliverSettlementWebhookToMany(
      report,
      [
        {
          url: `${fanoutLimitBase}${DEMO_FANOUT_LIMIT_FAST_A_PATH}`,
          secret: DEMO_FANOUT_LIMIT_SECRET_A,
        },
        {
          url: `${fanoutLimitBase}${DEMO_FANOUT_LIMIT_HANG_PATH}`,
          secret: DEMO_FANOUT_LIMIT_SECRET_B,
        },
      ],
      {
        now: DEMO_FANOUT_LIMIT_AT,
        eventId: DEMO_FANOUT_LIMIT_EVENT_ID,
        backoffMs: 0,
        retries: 0,
        timeoutMs: DEMO_FANOUT_LIMIT_TIMEOUT_MS,
        overallDeadlineMs: DEMO_FANOUT_LIMIT_DEADLINE_MS,
        allowInsecureHttp: true,
      },
    );
  } finally {
    fanoutLimitServer.closeAllConnections();
    await new Promise<void>((resolve) => {
      fanoutLimitServer.close(() => resolve());
    });
  }
  const fanoutLimitFastCalls = fanoutLimitCalls.filter(
    (call) => call.path === DEMO_FANOUT_LIMIT_FAST_A_PATH,
  ).length;
  const fanoutLimitFastBCalls = fanoutLimitCalls.filter(
    (call) => call.path === DEMO_FANOUT_LIMIT_FAST_B_PATH,
  ).length;
  const fanoutLimitHangCalls = fanoutLimitCalls.filter(
    (call) => call.path === DEMO_FANOUT_LIMIT_HANG_PATH,
  ).length;
  if (
    fanoutLimitCapError !== DEMO_FANOUT_LIMIT_CAP_ERROR ||
    fanoutLimitCallsAfterCap !== 0 ||
    fanoutLimitFastCalls !== 1 ||
    fanoutLimitFastBCalls !== 0 ||
    fanoutLimitHangCalls !== 1 ||
    fanoutLimitDeadlineResult.results.length !== 2 ||
    fanoutLimitDeadlineResult.delivered !== 1 ||
    fanoutLimitDeadlineResult.failed !== 1 ||
    fanoutLimitDeadlineResult.deadlineExceeded !== true ||
    fanoutLimitDeadlineResult.results[0].url !==
      `${fanoutLimitBase}${DEMO_FANOUT_LIMIT_FAST_A_PATH}` ||
    fanoutLimitDeadlineResult.results[0].ok !== true ||
    fanoutLimitDeadlineResult.results[0].attempts !== 1 ||
    fanoutLimitDeadlineResult.results[0].status !== 200 ||
    fanoutLimitDeadlineResult.results[1].url !==
      `${fanoutLimitBase}${DEMO_FANOUT_LIMIT_HANG_PATH}` ||
    fanoutLimitDeadlineResult.results[1].ok !== false ||
    fanoutLimitDeadlineResult.results[1].attempts !== 1 ||
    fanoutLimitDeadlineResult.results[1].error !==
      DEMO_FANOUT_LIMIT_DEADLINE_ERROR
  ) {
    throw new Error(
      "demo fixture broken: deliverSettlementWebhookToMany fan-out limits do not match the pinned shape (3 endpoints under maxEndpoints 2 throw the pinned cap error with 0 loopback requests; under overallDeadlineMs 100 the fast endpoint delivers {ok: true, attempts: 1, status: 200}, the hanging endpoint reports the pinned deadline error after 1 attempt, aggregate delivered 1 / failed 1 with deadlineExceeded true)",
    );
  }
  lines.push(
    "",
    "Settlement webhook fan-out limits (deliverSettlementWebhookToMany maxEndpoints / overallDeadlineMs over a loopback server):",
    `  over-cap: 3 endpoints under maxEndpoints ${DEMO_FANOUT_LIMIT_CAP} - throws "${fanoutLimitCapError}" before any request: loopback server recorded ${fanoutLimitCallsAfterCap} request(s)`,
    `  deadline: the same report fanned out as one logical event (eventId ${DEMO_FANOUT_LIMIT_EVENT_ID}, at ${DEMO_FANOUT_LIMIT_AT}) to ${DEMO_FANOUT_LIMIT_FAST_A_PATH} and ${DEMO_FANOUT_LIMIT_HANG_PATH} under overallDeadlineMs ${DEMO_FANOUT_LIMIT_DEADLINE_MS} ms, per-attempt timeoutMs ${DEMO_FANOUT_LIMIT_TIMEOUT_MS} ms, retries 0 - the deadline, not the per-attempt timeout, is what can stop the call`,
    `  fast: ${DEMO_FANOUT_LIMIT_FAST_A_PATH} answered 200 - result: ok ${fanoutLimitDeadlineResult.results[0].ok}, attempts ${fanoutLimitDeadlineResult.results[0].attempts}, status ${fanoutLimitDeadlineResult.results[0].status} (the completed endpoint keeps its result)`,
    `  hanging: ${DEMO_FANOUT_LIMIT_HANG_PATH} never answered - result: ok ${fanoutLimitDeadlineResult.results[1].ok}, attempts ${fanoutLimitDeadlineResult.results[1].attempts}, error "${fanoutLimitDeadlineResult.results[1].error}" (the deadline error, not the per-attempt timeout text and not the plain abort text)`,
    `  aggregate: ${fanoutLimitDeadlineResult.delivered} delivered, ${fanoutLimitDeadlineResult.failed} failed, deadlineExceeded ${fanoutLimitDeadlineResult.deadlineExceeded} - the cap and the deadline are caller-side guards: the cap fails the call before any request, the deadline stops only the in-flight endpoints`,
  );

  return {
    escrow,
    report,
    reportCsv,
    reportJson,
    reportJsonImported: importedReport,
    reportJsonDamagedError: damagedReportError,
    reportCsvImported: importedReportCsv,
    reportCsvDamagedError: damagedReportCsvError,
    depositBreakdown: fees,
    fractionalFeeInputs: DEMO_FEE_FRACTIONAL_INPUTS,
    fractionalDepositBreakdown: fractionalFees,
    historyChainVerified,
    tamperedChainVerified,
    tamperedFundAmount,
    webhook,
    webhookVerified,
    webhookFreshnessMaxAgeMs: DEMO_WEBHOOK_FRESHNESS_MAX_AGE_MS,
    webhookFreshnessWithinWindow,
    webhookFreshnessBoundary,
    webhookFreshnessExpired,
    webhookFreshnessMaxFutureSkewMs: DEMO_WEBHOOK_FRESHNESS_MAX_FUTURE_SKEW_MS,
    webhookFreshnessFutureSkewExceeded,
    webhookRotationOldVerified,
    webhookRotationNewVerified,
    webhookRotationUnrelatedVerified,
    webhookRotationEmptySecretsError,
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
    deadlineExpireEntryRefs: deadlineExpireResults.map((result) => ({
      escrowId: result.escrow.id,
      entry: result.entry,
    })),
    patrolEscrows,
    patrolStaleSelected,
    patrolStaleActionResults,
    patrolStaleNotifiedIds,
    patrolStaleConfigError,
    allowedEventsByState,
    mainEscrowAllowedEvents,
    tracedDepositAmount,
    noFundDepositError,
    releaseSettlement,
    topupEscrow,
    topupTracedDeposit,
    topupSettlement,
    topupReport,
    historyNdjson,
    historyNdjsonLineCount,
    historyNdjsonFirstLine,
    historyNdjsonRoundTripped,
    overdueCheckEscrow,
    overdueChecks,
    stateDiagramText,
    stateDiagramEdgeCount,
    readmeDiagramInSync: readmeDiagramInSyncValue,
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
    depositCapEscrow,
    depositCapLockedTotal,
    depositCapOverfundError,
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
    eventIdHeaderRetryResult,
    eventIdHeaderRetryCalls,
    eventIdHeaderFanoutResult,
    eventIdHeaderFanoutCalls,
    retryAfterDeliveryResult,
    retryAfterDeliveryHintMs,
    retryAfterDeliveryCalls,
    retryAfterDeliverySignatureVerified,
    dedupeSnapshotSource,
    dedupeSnapshotFirst,
    dedupeSnapshotDuplicate,
    dedupeSnapshot,
    dedupeSnapshotRestored,
    dedupeSnapshotStatsAfterRestore,
    dedupeSnapshotRestoredSeen,
    dedupeSnapshotRestoredUnseen,
    dedupeSnapshotTamperedError,
    dedupeClearDedupe,
    dedupeClearFirst,
    dedupeClearDuplicate,
    dedupeClearStatsBefore,
    dedupeClearStatsAfterClear,
    dedupeClearSizeAfterClear,
    dedupeClearRerecord,
    dedupeClearStatsAfterRerecord,
    dedupeCapacityDedupe,
    dedupeCapacityVerdicts,
    dedupeCapacityStatsAfterEviction,
    dedupeCapacityEvictedRerecord,
    dedupeCapacityStatsFinal,
    dedupeCapacityInvalidMaxEntriesError,
    onErrorEscrow,
    onErrorReports,
    onErrorProbeEscrow,
    onErrorProbeState,
    onErrorInvalidError,
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
    abortPreAbortedError,
    abortPreAbortedFetchCalls,
    abortDuringBackoffError,
    abortDuringBackoffFetchCalls,
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
    verifyEvidenceEscrow,
    verifyEvidenceError,
    verifyEvidenceStateAfterReject,
    verifyEvidenceHistoryLengthAfterReject,
    verifyEvidenceVerifiedState,
    verifyEvidenceRecordedEvidence,
    verifyEvidenceDefaultEscrow,
    verifyEvidenceDefaultState,
    auditKeyEscrow,
    auditKeyChainVerified,
    auditKeyWrongKeyVerified,
    auditKeyNoKeyVerified,
    auditKeyTamperedVerified,
    auditKeyTamperedNote,
    auditKeyHistoryLength,
    timeoutDeliveryError,
    timeoutDeliveryFetchCalls,
    timeoutInvalidError,
    timeoutInvalidFetchCalls,
    timeoutOkResult,
    timeoutOkFetchCalls,
    idempotencyHeaderRetryResult,
    idempotencyHeaderRetryCalls,
    fanoutLimitCapError,
    fanoutLimitDeadlineResult,
    fanoutLimitCalls,
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
