# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the version below is the version declared in `package.json`. Every entry
summarizes one or more commits in this repository's `git log`, grouped by
capability; no entry describes a feature that is not in the history. Dates
and short commit hashes are the `git log` dates and hashes for the commits
each entry summarizes.

Maintenance convention: when a later change lands, add one line for it
under `## [Unreleased]` below (with its date and commit hash once pushed);
move those lines into a versioned section only when `package.json`'s
version changes.

## [Unreleased]

### Added

- Test `buildSettlementWebhooks` batch x `SettlementEventDedupe`
  combination (2026-10-31, backlog #763):
  `test/settlementWebhooksBatchDedupe.test.ts` closes the gap between
  the batch file (distinct eventId per report, duplicate factory ids
  fail unsigned) and the dedupe file (no batch coverage) — a 3-report
  batch verifies and all 3 eventIds are first sightings, a whole-batch
  re-delivery reports duplicate for all 3 with the store unchanged, a
  duplicate factory id leaves the later report unsigned and adds no
  dedupe entry (the failed settlement still delivers under a fresh id,
  while a rebuild under the delivered twin's id is correctly a
  duplicate), and a failed build does not claim its factory id, so a
  later true report reusing that id is a first sighting. No source
  change: the combination was previously untested, not unimplemented.
  README test counts 1040 to 1044.

- Test top-up settlement webhook x `SettlementEventDedupe` combination
  (2026-10-31, backlog #760): `test/webhookTopupDedupe.test.ts`
  closes the gap between the #671 top-up webhook file (summed deposit,
  no dedupe) and the #741 fan-out dedupe file (no top-up settlement) —
  a top-up settlement webhook built with a fixed eventId is a first
  sighting on first delivery and a duplicate on re-delivery, a tampered
  delivery verifies false and records nothing so the true delivery is
  still first-seen, and a second top-up event with a different eventId
  is still a first sighting. No source change: the combination was
  previously untested, not unimplemented. README test counts 1036 to
  1040.

- Test `webhookFanoutLimits` x `SettlementEventDedupe` combination
  (2026-10-31, backlog #758): `test/webhookFanoutLimitsDedupe.test.ts`
  closes the gap between the #630 limits file (no dedupe) and the
  #741 fan-out dedupe file (no endpoint cap) — an over-`maxEndpoints`
  batch is refused before any request, so all four receivers' dedupes
  stay empty; in a 3-endpoint batch where one endpoint keeps returning
  500 until its retries are exhausted, the two healthy endpoints'
  first deliveries are first sightings (re-delivery a duplicate) while
  the failed endpoint's dedupe stays empty, and that endpoint's later
  true delivery of the same eventId is still a first sighting. No
  source change: the combination was previously untested, not
  unimplemented. README test counts 1034 to 1036.

- Test `webhookFanoutDedupe` x secret rotation combination
  (2026-10-31, backlog #755): `test/webhookFanoutDedupeRotation.test.ts`
  closes the gap between the #741 fan-out dedupe file (one secret per
  endpoint, no rotation list) and the #681 fan-out rotation file (a
  `[new, old]` candidate list, no dedupe) — one old-signed eventId
  fanned out to 4 loopback endpoints, each receiver verifying under
  `[new, old]` and recording a first sighting in its own
  `SettlementEventDedupe`; re-deliveries duplicate on all four;
  a tampered delivery records nothing and the true delivery is
  still first-seen; a post-rotation new-signed copy of the same
  eventId is still a duplicate (dedupe is keyed by eventId, not by
  signature version) while a new-signed fresh eventId is
  processed; an unrelated-secret copy is rejected with the dedupe
  untouched. No source change: the combination was previously
  untested, not unimplemented. README test counts 1029 to 1034.

- Benchmark `expireOverdueEscrows` x `subscribe` notification row
  (2026-10-31, backlog #750): `bench/bench.ts` measures the #739
  test row as a cost path — one measured op is one batch execution
  over fresh rebuilds of the same 100-escrow watchdog batch, with
  one collecting listener subscribed to every escrow: 40 overdue
  escrows EXPIRE and exactly 40 notifications arrive, each
  carrying the appended EXPIRE entry field for field against that
  escrow's history tail and the executor's report entry. Outside
  the timed loop, a failure-isolated VERIFIED overdue escrow is
  pinned to zero notifications with the batch still expiring the
  rest, and an unsubscribe-before-the-executor run is pinned to
  zero notifications with all 40 still expiring. README Benchmarks
  prose and the full 76-row table refreshed from this run (new
  row ~535.8 ops/sec, Node v24.22.1). No source change: the
  combination was previously unmeasured, not unimplemented.
  README test counts unchanged (1029).

- Benchmark `actOnStaleEscrows` x `subscribe` notification row
  (2026-10-31, backlog #749): `bench/bench.ts` measures the #735
  test row as a cost path — one measured op is one batch action
  over fresh rebuilds of the same 100-escrow watchdog batch, with
  one collecting listener subscribed to every escrow: 70 stale
  escrows EXPIRE and exactly 70 notifications arrive, each
  carrying the appended EXPIRE entry field for field against that
  escrow's history tail and the executor's report entry. Outside
  the timed loop, a notify-only action is pinned to zero
  notifications with all 70 stale escrows still acted, and an
  unsubscribe-before-the-executor run is pinned to zero
  notifications with all 70 still expiring. README Benchmarks
  prose and the full 75-row table refreshed from this run (new
  row ~365.7 ops/sec, Node v24.22.1). No source change: the
  combination was previously unmeasured, not unimplemented.
  README test counts unchanged (1029).

- Benchmark `deliverSettlementWebhookToMany` fan-out x
  `SettlementEventDedupe` receiver-flow row (2026-10-30, backlog
  #745): `bench/bench.ts` measures the #741 test row as a cost
  path and the escrow-side peer of dataquest #744 — one measured
  op is two fan-outs of the same fresh eventId to the 4 fixed
  endpoints through a fake global fetch (immediate 200, no
  network): the first fan-out delivers 4 / fails 0 with every
  endpoint's copy verifying under its own secret and recording as
  a first sighting in that endpoint's own dedupe, and the
  redelivery delivers 4 / fails 0 again, verifies again, and
  reports duplicate on all four dedupes. One measured op records
  exactly one id per dedupe under a fixed injected clock at
  capacity 100,000, so 3,200 warmup + timed ops stay far under
  the cap with nothing expiring or evicted in the timed loop.
  README Benchmarks prose and the full 74-row table refreshed
  from this run (new row ~2,238 ops/sec, Node v24.22.1). No
  source change: the combination was previously unmeasured, not
  unimplemented. README test counts unchanged (1029).

- `deliverSettlementWebhookToMany` x `SettlementEventDedupe`
  endpoint-isolation coverage (2026-10-30, backlog #741):
  `test/webhookFanoutDedupe.test.ts` pins the fan-out receiver
  semantics, mirroring dataquest #740: one fan-out to 4 loopback
  endpoints leaves every receiver accepting its own
  per-endpoint-signed copy as a first sighting with each dedupe at
  size 1 despite the shared eventId, re-delivery to the same
  endpoint reports duplicate on all four receivers with per-receiver
  stats hits 1 / misses 1, an eventId recorded at endpoint A alone
  does not make the same eventId a duplicate at endpoint B while
  untouched endpoints C and D stay at size 0, a tampered delivery
  verifies false and records nothing so the true delivery is still
  first-seen, and A's wire body presented to B's receiver is
  rejected and leaves B's dedupe untouched. No source change: the
  combination was previously untested, not unimplemented. README
  test counts realigned to the true suite total (1024 → 1029).

- `expireOverdueEscrows` x `subscribe` combination coverage
  (2026-10-30, backlog #739): `test/expireOverdueSubscribe.test.ts`
  pins the deadline-watchdog executor's notification behaviour,
  mirroring #735 on the deadline path (the executor dispatches
  `EXPIRE` itself, with no actor, rather than running a caller
  supplied action): a successful executor EXPIRE notifies exactly
  once with an entry equal to the history tail and the executor
  report entry, a batch notifies only its attempted escrows while
  not-overdue, deadline-free and terminal escrows stay silent, a
  VERIFIED or DISPUTED overdue escrow fails per-escrow with zero
  notifications and untouched state/history while the batch keeps
  going, a gated escrow reports the no-actor policy error with zero
  notifications, unsubscribing before the executor still expires
  silently, a throwing listener stays isolated with its peer still
  notified, an authorized manual dispatch after a refusal still
  notifies, and a notification entry is a frozen detached copy that
  cannot rewrite the audit history. No source change: the
  combination was previously untested, not unimplemented. README
  test counts realigned to the true suite total (1015 → 1024).

- `actOnStaleEscrows` x `subscribe` combination coverage
  (2026-10-30, backlog #735): `test/staleActionSubscribe.test.ts`
  pins the watchdog executor's notification behaviour, mirroring
  dataquest #732 with no default action (the action is caller
  supplied): an executor EXPIRE notifies exactly once with an entry
  equal to the history tail and the executor report entry, a batch
  notifies only its acted escrows while fresh and terminal escrows
  stay silent, a policy refusal and a failed VERIFIED transition
  report per-escrow errors with zero notifications and untouched
  state/history, a notify-only action acts with no entry and no
  notification, unsubscribing before the executor still expires
  silently, a throwing listener stays isolated with its peer still
  notified, and an authorized manual dispatch after a refusal still
  notifies. No source change: the combination was previously
  untested, not unimplemented. README test counts realigned to the
  true suite total (1004 was 3 behind after backlog #734).

- Benchmark `verifySettlementWebhook` x `SettlementEventDedupe`
  receiver-flow row (2026-10-30, backlog #731): `bench/bench.ts` now
  measures the #725 test row as a cost path — one measured op is
  three deliveries against a dedicated dedupe under a fixed injected
  clock at capacity 100,000: a first sighting that verifies and
  records as new, a redelivery that verifies again but reports
  duplicate, and a tampered body that fails verification and never
  reaches the dedupe step, proven by the tampered delivery's claimed
  id still recording as new afterwards. The verify step reuses the
  fixed signed webhook and its signature; the dedupe step uses
  per-iteration synthetic ids standing in for `payload.eventId`,
  because the fixed body's own id can only be first-seen once. New
  row measured at 33,139 ops/sec (30.18 µs/op) on Node v24.22.1;
  README Benchmarks prose and the full 73-row table refreshed from
  this run. Bench-only change: no source change.

- Benchmark `dispatchArbitration` x rolePolicy row (2026-10-30,
  backlog #728): `bench/bench.ts` now measures the #719 combination
  as a cost path — a DISPUTED escrow with `ARBITRATE_RELEASE`
  allowlisted to moderator, rebuilt via `Escrow.fromHistory` from
  its fixed 2-entry prefix with the policy installed through the
  `fromHistory` opts, plus a threshold-reached 5/9 quorum rebuilt
  on every iteration. Every timed iteration pins a contributor
  arbitration dispatch rejected with the exact
  actor-not-authorized error leaving state, history, and quorum
  count untouched, and a moderator arbitration dispatch advancing
  to RELEASED with one pinned entry and an intact hash chain;
  a below-threshold quorum is pinned once outside the timed loop
  to the quorum error, never the policy error. New row measured
  at 2,662 ops/sec (375.68 µs/op) on Node v24.22.1; README
  Benchmarks prose and the full 72-row table refreshed from this
  run. Bench-only change: no source change.

- Receiver-flow coverage for `verifySettlementWebhook` +
  `SettlementEventDedupe` (2026-10-30, backlog #725):
  `test/webhookVerifyDedupe.test.ts` pins the README receiver order —
  verify the raw body first, only then `checkAndRecord(eventId)`: a
  first delivery processes, a re-delivery verifies but is dropped as a
  duplicate, a tampered or wrong-secret delivery is rejected without
  touching the dedupe store (so the genuine delivery of that `eventId`
  afterwards is still a first sighting), and the same `eventId` counts
  as unseen again once its TTL expires. No source change: the
  combination was previously untested, not unimplemented.

- Benchmark `deliverSettlementWebhookToMany` fan-out maxRetryDelayMs row
  (2026-10-30, backlog #722): `bench/bench.ts` now measures the #716
  combination as a cost path — one fan-out to 4 endpoints under a
  call-level `maxRetryDelayMs` of 50, with one endpoint answering 429
  with a one-year `Retry-After: 31536000` hint on its first attempt and
  200 on the retry while the other three answer 200 immediately. Every
  timed iteration pins the aggregate (delivered 4 / failed 0),
  per-endpoint results in input order (hinted attempts 2 / status 200,
  healthy attempts 1 / status 200), per-endpoint fetch call counts
  (2 / 1 / 1 / 1), and exactly one recorded backoff wait equal to the
  50 ms cap, proving the call-level cap passes through the fan-out to
  the per-endpoint delivery. Bench-only change: no source change.
- `deliverSettlementWebhookToMany` x maxRetryDelayMs combination tests
  (2026-10-29, backlog #716):
  `test/webhookFanoutMaxRetryDelay.test.ts` pins the combination the
  fan-out and single-endpoint cap suites never tested together — a
  call-level cap clamps a runaway `Retry-After` hint on the one hinted
  endpoint while the other three answer 200 on their first attempt, a
  per-endpoint cap overrides the call-level cap for that endpoint only,
  two hinted endpoints clamp independently to their own caps with
  results in input order and per-endpoint attempt counts, and a
  hint-less 500 follows the exponential backoff schedule (100ms, then
  200ms) even with a 10ms cap, proving the cap clamps hints only.
  Pure test commit: no source change.
- `actOnStaleEscrows` x rolePolicy combination tests (2026-10-29,
  backlog #713): `test/actOnStaleRolePolicy.test.ts` pins the
  combination the batch-executor and RBAC suites never tested together
  — a stale batch where a no-policy escrow and a RELEASE-only-policy
  escrow expire normally while an EXPIRE-listed escrow fails per-item
  with the verbatim actor wording
  `actor not authorized for EXPIRE: "watchdog" is not in [ops-lead]`
  (the stale executor runs the caller's action verbatim, so the
  wording tracks the action's actor — unlike #706, where the executor
  itself dispatches with no actor and the failure is the missing-actor
  wording, and unlike dataquest's executor, which dispatches with a
  `system` actor); an allowlisted actor expires the gated escrow with
  its audit entry intact, a blocked run consumes no sequence number
  and leaves the policy in place, an action throw and a policy
  rejection carry distinguishable errors, and transition legality
  still runs before RBAC (a VERIFIED stale escrow fails with the
  transition error, not the authorization error). Pure test commit:
  no source change.
- Settlement report x CSV after a top-up (2026-10-29, backlog #708):
  `test/settlementReportTopup.test.ts` pins the combination the
  top-up and CSV suites never tested together — a released escrow
  funded 10000 + 630 renders a report and CSV on the FUND total
  10630 (creator 10098.50 / platform 531.50 at 5% pro fee), the CSV
  parses back to the same subset and re-renders byte-identically,
  a deposit disagreeing with the FUND total never reaches CSV
  rendering, and an amount-less FUND pins the honest split:
  `depositAmountFromHistory` refuses fail-fast while
  `buildSettlementReport` keeps its documented caller-responsible
  fallback, so such a CSV TOTAL is the caller's number, not an
  audit-proven sum. Pure test commit: no source change.
- `expireOverdueEscrows` x rolePolicy combination tests (2026-10-29,
  backlog #706): `test/expireOverdueRolePolicy.test.ts` pins the
  combination the batch-executor and RBAC suites never tested together
  — a mixed overdue batch where a no-policy escrow and a
  RELEASE-only-policy escrow expire normally while an EXPIRE-listed
  escrow fails per-item with the verbatim missing-actor error
  `actor not authorized for EXPIRE: policy requires an actor in
  [ops-lead]` (the escrow executor dispatches with `{ at: now }` and
  no actor, unlike dataquest's `system`-actor executor, so the
  wording is deliberately not dataquest's `"system" is not in [...]`);
  the blocked escrow leaves no history residue and does not block
  later escrows, can still be expired manually by an allowlisted
  actor with no sequence gap, a multi-role EXPIRE policy blocks the
  executor but admits either listed role manually, a policy-listed
  escrow that is not overdue is never attempted, and a VERIFIED
  overdue escrow with an EXPIRE policy still fails with the
  transition error because RBAC runs after transition legality.
  Pure test commit: no source change.
- Benchmark `deliverSettlementWebhookToMany` fan-out jitterMs row
  (2026-10-29, backlog #694): `bench/bench.ts` now measures the
  #665 `jitterMs` option crossed with fan-out as a cost path — every
  timed pass runs two fan-outs to 4 endpoints (one flaky endpoint on
  a 500, 500, 200 script plus three endpoints answering 200
  immediately; backoffMs 100, retries 2), the jittered fan-out with
  its two backoff waits inside [100, 1100] and [200, 1200] and the
  zero-jitter control with waits exactly [100, 200]. Every timed
  iteration also pins the aggregate (delivered 4 / failed 0),
  per-endpoint results in input order (flaky attempts 3 / status 200,
  healthy attempts 1 / status 200), per-endpoint fetch call counts
  (3 / 1 / 1 / 1), and per-endpoint signature verification under each
  endpoint's own secret. The waits are recorded with the same
  `setTimeout` wrapper as the #680 row (only timers created inside
  `sleepAbortable` count, shortened to 0 ms, wrapper restored after
  every fan-out). Outside the timed loop a stubbed `Math.random`
  sequence [0, 0.5] pins the jittered waits to exactly [100, 700] and
  the zero-jitter waits to exactly [100, 200], with the stub's restore
  asserted. This run: 118.3 ops/sec (8451.07 µs/op). The README
  Benchmarks table is refreshed from this run. Bench item only: no
  unit tests added, no source change.
- Top-up x maxDeposit combination tests (2026-10-28, backlog
  #682): `test/topupMaxDeposit.test.ts` pins the combination at a
  realistic scale — cap 10000, initial FUND 9000, an over-cap top-up
  of 2000 rejected with the verbatim `deposit cap exceeded` error and
  no locked/history residue, then an exact-cap top-up of 1000
  recovering cleanly (rejected attempts consume no sequence number);
  once at the cap any further positive top-up is rejected, and the
  cap is cumulative across several top-ups (5000 + 3000, then 3000
  rejected, then 2000 to the cap). Pure test commit: no source
  change. Honest correction to the backlog note: `maxDeposit.test.ts`
  already pinned an exact-cap top-up at 700 + 300, so the new
  coverage is the rejection-then-exact-cap-recovery order and the
  multi-top-up cumulative path, not the exact-cap top-up itself.
- Fan-out x secret rotation combination tests (2026-10-28, backlog
  #681): `test/webhookFanoutRotation.test.ts` pins the combination the
  fan-out and rotation suites never tested together — one settlement
  event fanned out via `deliverSettlementWebhookToMany` to a legacy
  endpoint (old secret) and a migrated endpoint (new secret) carries
  byte-identical bodies with per-endpoint signatures, and both copies
  verify under the receiver's `{ secrets: [new, old] }` candidate list
  in either order; a new-only list rejects the legacy copy while still
  accepting the migrated copy (no masking), all-wrong candidates and
  malformed signatures fail closed for both copies, tampered bodies
  fail on both the raw-wire and object paths, and a failing legacy
  endpoint (500, retried) neither blocks nor masks the migrated
  endpoint's verification. Pure test commit: no source change.
- Benchmark `deliverSettlementWebhook` jitterMs backoff row (2026-10-28,
  backlog #680): `bench/bench.ts` now measures the #665 `jitterMs` option
  as a cost path — every timed pass runs two deliveries over a fake fetch
  answering 500, 500, 200 (backoffMs 100, retries 2), the jittered delivery
  with its two backoff waits inside [100, 1100] and [200, 1200] and the
  zero-jitter control with waits exactly [100, 200]. The delivery layer
  exposes no sleep injection, so the waits are recorded by a `setTimeout`
  wrapper installed for each delivery only (the #679 demo technique): it
  keeps only timers created inside `sleepAbortable` and shortens those
  timers to 0 ms, so the row measures delivery logic, not a wall-clock
  backoff, and the wrapper is restored after every delivery. Outside the
  timed loop a stubbed `Math.random` sequence [0, 0.5] pins the jittered
  waits to exactly [100, 700] and the zero-jitter waits to exactly
  [100, 200], with the stub's restore asserted. The README Benchmarks
  table is refreshed from this run. Bench item only: no unit tests added,
  no source change.
- CLI demo `deliverSettlementWebhook` jitter backoff segment (2026-10-28, backlog
  #679): the demo now shows the #665 `jitterMs` option over a loopback
  server - the main webhook delivered on a 500/500/200 script under
  `backoffMs: 10, jitterMs: 50` succeeds in 3 attempts with the 2 backoff
  waits inside [10, 60] and [20, 70], and the same script under `jitterMs: 0`
  succeeds in 3 attempts with waits exactly [10, 20]; both paths capture 3
  byte-identical bodies whose signature verifies under the demo secret, so
  jitter is shown spreading waits only, never changing the signed payload
  or the eventId. The waits are recorded by a `setTimeout` wrapper that
  keeps only timers created inside `sleepAbortable` (per-attempt timeout
  timers and transport timers are filtered out by their creation stack),
  installed for the two deliveries only and restored afterwards, and the
  random draws are never printed - only their intervals - so the new
  closing section prints byte-identically across runs. `DemoResult` gains
  `jitterResult`, `jitterSleeps`, `jitterCalls`, `jitterBodyVerifies`,
  `jitterExactResult`, `jitterExactSleeps`, `jitterExactCalls`, and
  `jitterExactBodyVerifies`, guarded by a fail-fast demo self-check; the
  fan-out limit segment is no longer the demo's last section.
  `test/demo.test.ts` (2 cases).
- Settlement webhook payload × top-up coverage (2026-10-28, backlog
  #671): `test/webhookTopup.test.ts` (7 cases) pins the combination the
  `webhooks` and `settlementWebhooksBatch` suites never exercised — that
  after two FUNDs (10000 + 630 top-up) the webhook payload `deposit`
  equals the summed locked total (10630), matching the report and the
  ledger parties, that a caller deposit equal to the first FUND only or
  the last FUND only is rejected with the FUND-total mismatch error, that
  a single-FUND escrow is unchanged, that a FUND recorded without an
  amount keeps the report's caller-deposit behavior while
  `depositAmountFromHistory` still fails fast, and that tampering the
  summed deposit breaks signature verification. No source change: the
  sum semantics landed with #43.
- Arbitration dispatch × quorum approval expiry coverage (2026-10-28, backlog
  #668): `test/arbitrationQuorumExpiry.test.ts` (6 cases) pins the
  interaction the separate `quorumExpiry` and `arbitrationQuorum` suites
  left untested — that `dispatchArbitration` reads the quorum's live
  counting views, so approvals aging out of `maxApprovalAgeMs` refuse
  arbitration with `arbitration requires quorum: <counted>/<threshold>
  approvals` and leave state/history untouched (full expiry 0/5 and
  staggered expiry 4/5), that re-approval after expiry restores the
  dispatch, that the inclusive expiry boundary still allows it, that an
  expiry-gated rejection does not consume an `idempotencyKey`, and that
  a windowless quorum is unaffected by clock advances. No source change:
  the gate already delegated to `hasQuorum()` / `approvalCount()`.
- Settlement webhook delivery `jitterMs` retry jitter (2026-10-28, backlog
  #665): `DeliverWebhookOptions.jitterMs` (default 0, preserving the exact
  deterministic backoff schedule) adds a `Math.random() * jitterMs` spread
  on top of each exponential backoff wait, so endpoints that failed
  together do not retry in lockstep; a 429 `Retry-After` hint is still
  waited exactly with no jitter added. `deliverSettlementWebhookToMany`
  forwards the option call-level and per endpoint (a per-endpoint
  `jitterMs` overrides the call-level value, including 0 cancelling it),
  an invalid value throws the existing `cannot deliver settlement
  webhook: …` configuration error before any request (call-level) or
  fails only its own endpoint (per-endpoint), and the README delivery
  section documents the default-0, no-uniformity-guarantee, and
  no-cross-process-coordination limits. `test/webhookDeliveryJitter.test.ts`
  (10 cases: default-0 schedules on the 5xx and network-error paths,
  stubbed-`Math.random` spread, exact `Retry-After` hint, invalid values,
  and fan-out overrides).
- Benchmark `deliverSettlementWebhook` loopback header-check path (2026-10-27, backlog
  #651): the bench now times the #567/#576 delivery-header contract over a real
  loopback HTTP server instead of a fake fetch — every iteration delivers the fixed
  signed webhook with a 500-then-200 script (retries 1, backoffMs 0) and pins both
  attempts' `X-Event-Id` and `Idempotency-Key` equal to the body `eventId` and
  identical across the retry, with the signed body and `X-Signature` unchanged;
  outside the timed loop a forged header value is pinned not to break body
  verification (headers are transport hints, not signature-covered) and a body with
  a mutated `eventId` is pinned to fail verification. The README benchmark table is
  refreshed from this run with the new row added
  (281.5 ops/sec, 3552.63 µs/op).
- Benchmark `deliverSettlementWebhookToMany` fan-out limits path (2026-10-27, backlog
  #650): the bench now times the #630 `maxEndpoints` / `overallDeadlineMs`
  guards as a cost path — every iteration runs a 3-endpoint batch under
  `maxEndpoints: 2` (pinned cap error before any request, 0 fetch calls)
  and a fast + hanging pair under a bench-local `overallDeadlineMs: 50`
  with a 10,000 ms per-attempt timeout and retries 0 (fast result kept,
  hanging endpoint reports the pinned deadline error after exactly 1
  attempt, aggregate delivered 1 / failed 1 with `deadlineExceeded: true`),
  with an invalid `maxEndpoints: 0` and a cap-equal batch pinned once
  outside the timed loop. The README benchmark table is refreshed from
  this run with the new row added
  (18.7 ops/sec, 53523.05 µs/op).
- CLI demo `deliverSettlementWebhookToMany` fan-out limit segment (2026-10-27, backlog
  #649): the demo now shows the #630 guards over a loopback server - 3
  endpoints under `maxEndpoints: 2` throw the pinned cap error before any
  request (0 loopback requests), and under `overallDeadlineMs: 100` with a
  10,000 ms per-attempt timeout a fast endpoint keeps
  `{ok: true, attempts: 1, status: 200}` while a hanging endpoint reports
  the pinned deadline error after 1 attempt, aggregate delivered 1 /
  failed 1 with `deadlineExceeded: true`. `DemoResult` gains
  `fanoutLimitCapError`, `fanoutLimitDeadlineResult`, and
  `fanoutLimitCalls`, guarded by a fail-fast demo self-check; the new
  segment is the demo's last section and prints byte-identically across
  runs (ports are never printed). `test/demo.test.ts` (2 cases).
- Benchmark `dispatch rolePolicy` RBAC path (2026-10-27, backlog
  #632): the bench now times the gated-arbitration dispatch a
  webhook-driven dispatcher actually pays — a fresh DISPUTED
  escrow with `ARBITRATE_RELEASE` allowlisted to `moderator`,
  rebuilt on every iteration (dispatch mutates it), with a
  `contributor` dispatch rejected by the exact
  `actor not authorized for ARBITRATE_RELEASE` error leaving
  the history at 2 entries and a `moderator` dispatch then
  advancing to RELEASED with one entry pinned field for field
  (seq 3, DISPUTED -> RELEASED, actor `moderator`) and an
  intact hash chain, plus an actor-less rejection pinned once
  outside the timed loop. The README benchmark table is
  refreshed from this run with the new row added
  (4,346 ops/sec, 230.09 µs/op).
- Settlement webhook fan-out limits (2026-10-26, backlog #630):
  `DeliverSettlementWebhookToManyOptions` gains `maxEndpoints` (more
  endpoints than the cap throws before any request, zero fetch calls)
  and `overallDeadlineMs` (one wall-clock budget for the whole
  fan-out: the timer aborts every in-flight endpoint through a
  deadline signal composed with each endpoint's own signal, so a
  per-endpoint signal override cannot outrun the deadline; a
  deadline-stopped endpoint reports the deadline timeout error and
  the aggregate result gains `deadlineExceeded: true`, while
  already-completed endpoints keep their results). Invalid values
  fail fast as caller configuration errors. `test/webhookFanoutLimits.test.ts`
  (8 cases).
- Benchmark `expireOverdueEscrows` result-entry audit check (2026-10-26,
  backlog #625): `checkExpireOverdueResults` now also verifies each
  successful result's `entry` against that escrow's history last entry
  field for field (seq/event/from/to/at), so the cited audit record
  cannot drift from the history itself. The benchmark table is not
  refreshed for this change: the added assertion does not change the
  measured paths, only strengthens the per-iteration self-check.
- Benchmark `renderReportJson` rendering path (2026-10-26, backlog
  #619): the bench now times the API/storage export over the same
  golden released report the CSV row renders — the structural shape
  check plus `JSON.stringify`, with every iteration re-checking the
  parsed JSON against the golden report's amount fields and pinning
  amounts as numbers (creator inflow `10098.5`, not the CSV's
  two-decimal text), and a non-finite creator inflow pinned to the
  exact render error outside the timed loop. The README benchmark
  table is refreshed from this run with the new row added.
- CLI demo `expireOverdueEscrows` audit-entry segment (2026-10-26,
  backlog #615): the deadline watchdog section now prints each
  result's `entry` citation — the successful FUNDED expiry cites
  `entry seq 2 EXPIRE FUNDED -> EXPIRED at 2026-03-09T09:00:00.000Z`
  (identical to the escrow history's last entry), the failed VERIFIED
  attempt explicitly cites no entry — and `DemoResult` gains
  `deadlineExpireEntryRefs` carrying those citations, guarded by a
  fail-fast demo self-check that fails the demo if any entry drifts
  from the history's last entry. The previously printed outcome lines
  are unchanged.
- CLI demo settlement report CSV import segment (2026-10-26, backlog
  #609): the demo now shows `parseSettlementReportCsv` reading the
  just-exported report CSV back — the parsed CSV-carried subset
  matches the report's party ledgers field for field and re-renders
  byte-identically — and a damaged copy whose TOTAL inflow is 1
  higher than the party-row sum is rejected with the pinned
  `cannot parse settlement report CSV: TOTAL row inflow 10631 does
  not equal the sum over party rows 10630` message. The segment
  states the honest limit plainly: the CSV never carried the deposit
  breakdown, settlement parameters, `releasePath`, `eventCount`, or
  audit window, so the import does not reconstruct them, and the
  import is structural validation only, not a re-verification of the
  audit chain.
- Benchmark `parseSettlementReportCsv` round-trip import path
  (2026-10-26, backlog #610): the bench now times the receiving end
  of the spreadsheet hop over the same golden released report CSV
  the demo round-trips — RFC 4180 record parsing plus the structural
  and TOTAL-row self-consistency checks, with every iteration
  re-checking the parsed subset field for field against the golden
  report's CSV-carried fields and re-rendering byte-identically
  through `renderReportCsv`, a TOTAL-mismatched copy pinned to the
  exact import error and two parses pinned to independent object
  graphs outside the timed loop. The README benchmark table is
  refreshed from this run with the new row added.
- Benchmark `parseSettlementReportJson` round-trip import path
  (2026-10-26, backlog #606): the bench now times the receiving end
  of the API/storage hop over the same golden released report JSON
  the demo round-trips — JSON parsing plus the structural shape
  check, with every iteration re-checking the parsed report
  deep-equals the golden report and re-renders byte-identically
  through `renderReportJson`, a parties-less copy pinned to the
  exact import error and two parses pinned to independent object
  graphs outside the timed loop. The README benchmark table is
  refreshed from this run with the new row added.
- CLI demo `Idempotency-Key` header segment (2026-10-26, backlog
  #603): the demo now shows the standard payment-gateway header
  `deliverSettlementWebhook` carries, over a real loopback server
  instead of a scripted fake — the main webhook delivered to a
  500-then-200 endpoint succeeds after exactly one retry with
  `Idempotency-Key` identical to the body `eventId` on both attempts,
  and the same two requests carry `X-Event-Id` equal to that same
  body `eventId`, so the two headers coexist on one wire keyed to
  the one logical event. The loopback port is never printed, so
  demo output stays byte-identical across runs; the header's
  transport-hint-only status (not covered by the signature) is
  stated in the segment's note line.
- Settlement report CSV round-trip import `parseSettlementReportCsv`
  (2026-10-25, backlog #600): the inverse of `renderReportCsv`, with an
  RFC 4180 record parser and cross-checks (exact header, one row per
  party role, same `escrowId`/`outcome` on every row, finite two-decimal
  amounts, party `net` equal to `inflow − outflow`, `TOTAL` row equal to
  the party-row sums) — anything else throws
  `cannot parse settlement report CSV: …`. Deliberate, documented limit:
  the CSV carries no deposit breakdown, settlement parameters,
  `releasePath`, `eventCount`, or audit window, so the import returns
  the CSV-carried subset (`SettlementReportCsv`) and does not invent
  those fields; a parsed value re-renders byte-identically through
  `renderReportCsv`, whose parameter type now also accepts that subset.
  Import is structural validation only, not a re-verification of the
  audit chain.
- CLI demo settlement report JSON import segment (2026-10-25, backlog
  #597): the demo now shows `parseSettlementReportJson` reading the
  just-exported report JSON back — the parsed report deep-equals the
  original and re-renders byte-identically — and a damaged copy with
  the `parties` field removed rejected with `cannot parse settlement
  report JSON: parties must be a non-empty array`, so a party-less
  document never becomes a plausible-looking report. The import is
  structural validation only, not a re-verification of the audit chain.
- CLI demo `X-Event-Id` header segment (2026-10-25, backlog #594):
  the demo now shows the transport header `deliverSettlementWebhook`
  carries, over a real loopback server instead of a scripted fake —
  the main webhook delivered to a 500-then-200 endpoint succeeds
  after exactly one retry with `X-Event-Id` identical to the body
  `eventId` on both attempts, and a two-endpoint fan-out shows each
  endpoint's header equal to the one shared body `eventId` (one
  logical event, not one eventId per endpoint). The loopback port
  is never printed, so demo output stays byte-identical across
  runs; the header's transport-hint-only status (not covered by
  the signature) is stated in the segment's note line.
- Settlement report JSON round-trip import `parseSettlementReportJson`
  (2026-10-25, commit 734dcc4, backlog #591): the inverse of
  `renderReportJson`, applying the same structural shape check in the
  other direction — unparseable text, non-report JSON values, empty
  `escrowId`, illegal `outcome`, empty `parties`, unknown party roles,
  and non-finite money figures (including `null`, which is what
  non-finite figures become after a plain `JSON.stringify`) all throw
  `cannot parse settlement report JSON: …`; a parsed report re-renders
  byte-identically. Import is structural validation only, not a
  re-verification of the audit chain (chain verification still belongs
  to `verifyHistoryChain`). The shared shape check was hardened in the
  same change: a `null` settlement/deposit figure previously slipped
  through (only non-finite numbers were rejected); every money field
  must now be a finite number.

- New benchmark path `renderReportCsv (released report, 4 parties)`:
  the same fixed golden released report the `#582` demo section
  prints as CSV (deposit 10,630, released via VERIFY_PASS → RELEASE,
  4 party rows) rendered on every iteration and checked against the
  hand-written 6 lines — header
  `escrowId,outcome,role,inflow,outflow,net`, one row per party in
  report order, and the TOTAL row — with the TOTAL columns
  additionally re-derived from the party rows themselves on every
  iteration, so the check pins the CSV's self-consistency claim (the
  TOTAL row sums the rows above it) rather than only the pinned
  TOTAL line. A premise correction, pinned in the bench rather than
  assumed: `renderReportCsv` itself performs no shape validation
  (unlike `renderReportJson`'s `assertReportShape`) — a hand-built
  report with a non-finite party amount renders the literal string
  `Infinity`, it does not throw — so the illegal-report fail-fast
  probe pins the gate that actually guards the CSV path, at report
  construction: `buildSettlementReport` refuses a deposit that
  disagrees with the FUND total recorded in the audit history, with
  the exact message pinned
  (`cannot build settlement report for BENCH-001: deposit 10631 does
  not match the FUND total 10630 recorded in the audit history`).
  The renderer's missing shape check is a real gap, left for a
  follow-up item rather than papered over by this bench. A mutation
  probe (corrupting the hand-pinned TOTAL row expectation) fails the
  bench at fixture load with the exact self-check error, confirming
  the pin is live. The run measured ~120,096 ops/sec (~8.33 µs/op)
  for this row. The new row joins the README benchmark table, with
  the whole table refreshed from the same real run. No network, no
  randomness, no wall clock.

- The CLI demo now prints the main settlement report as JSON next to
  its CSV form: `renderReportJson(report)` on the same released
  report, with the demo asserting the parsed JSON matches the report
  field for field with amounts as JSON numbers (not CSV strings) and
  that a copy with a non-finite `totalInflow` is rejected with
  `cannot render settlement report as JSON: …` before printing — a
  mismatch fails the demo instead of printing an inconsistent export.
  `test/demo.test.ts` (2 cases).

- The CLI demo now prints the main settlement report as CSV next to
  its prose form: `renderReportCsv(report)` on the same released
  report, with the demo asserting the header
  `escrowId,outcome,role,inflow,outflow,net`, one row per party, and a
  `TOTAL` row summing the party rows to the report totals before
  printing — a mismatch fails the demo instead of printing an
  inconsistent export. `test/demo.test.ts` (2 cases).

- `renderReportJson(report)` renders a settlement report as JSON for
  programmatic consumers (bookkeeping APIs, databases): `JSON.stringify`
  of the report itself, carrying exactly the `SettlementReport` fields
  with amounts as JSON numbers, not two-decimal strings as in
  `renderReportCsv`; a non-report value or a non-finite money figure
  throws `cannot render settlement report as JSON: …` instead of
  serializing (`JSON.stringify` alone would silently turn
  `Infinity`/`NaN` into `null`). `test/settlementReportJson.test.ts`
  (10 cases).

- `deliverSettlementWebhook` now sends an `Idempotency-Key` header on
  every attempt, equal to the payload's `eventId` (identical across
  retries; fan-out endpoints share the same logical eventId, so they
  share the same header value). There is no opt-out. Like
  `X-Event-Id`, it is a transport-layer idempotency hint only — it is
  not covered by the signature, so receivers must verify the signature
  and then trust the body's `eventId`, never the header.
  `test/webhookIdempotencyKeyHeader.test.ts` (8 cases).

- `StaleEscrowActionResult` now carries the appended audit entry on
  success: `actOnStaleEscrows()` fills `entry` with a frozen,
  detached copy of the escrow's last history entry when the action
  appended to the history (history growth across the action is the
  test, mirroring dataquest's `StaleActionResult`); notify-only
  actions leave the field absent, and failed actions leave it absent
  even if the action dispatched before throwing, preserving the
  previous result shape. `test/staleEscrowActionEntry.test.ts`
  (10 cases).

- `deliverSettlementWebhook` now sends an `X-Event-Id` header on every
  attempt, equal to the payload's `eventId` (identical across retries;
  fan-out endpoints each carry the shared logical event's id). The
  header is a transport-layer deduplication hint only — it is not
  covered by the signature, so receivers must verify the signature and
  then trust the body's `eventId`, never the header.
  `test/webhookEventIdHeader.test.ts` (6 cases).

- `renderReportCsv(report)` renders a settlement report as CSV for
  bookkeeping/reconciliation imports: header
  `escrowId,outcome,role,inflow,outflow,net`, one row per party in fixed
  sponsor/creator/platform/referrer order (zero-amount parties included),
  amounts at exactly two decimals with no thousands separators, and a
  final `TOTAL` row summing the party rows; string fields use RFC 4180
  escaping. `test/settlementReportCsv.test.ts` (10 cases).

- `ExpireOverdueResult` now carries the appended EXPIRE audit entry on
  success: `expireOverdueEscrows()` fills `entry` with a frozen,
  detached copy of the escrow's last history entry (the history getter
  already returns frozen copies), so an expiry operations report can
  cite the entry without re-reading `escrow.history`; failed outcomes
  leave the field absent, preserving the previous result shape.
  `test/expireOverdueEntry.test.ts` (6 cases).

- `buildSettlementWebhooks` now detects a repeated `eventId` inside a
  batch: the batch records the `eventId`s it has successfully signed,
  and a later report whose factory returns an already-issued id fails
  as `{ escrowId, error }` with
  `duplicate eventId "<id>" in batch: eventIds must be unique within
  a batch` — it is never signed, and later reports are still
  attempted (per-item isolation). Only issued ids are recorded, so a
  report whose build fails (empty/non-string factory value,
  structurally broken report) never claims its id, and forwarded
  error entries from `buildSettlementReports` consume no id.
  Previously a factory bug (counter reset, fixed value) shipped two
  signed webhooks under one `eventId`, and the receiver's
  `SettlementEventDedupe` would drop the second settlement as an
  apparent duplicate while the sender believed it delivered.
  `test/settlementWebhooksBatch.test.ts` (8 cases).

### Fixed

- `renderReportCsv` now shape-checks its input before rendering
  (2026-10-26, backlog #608): the CSV renderer reuses the shared
  carried-fields core of `assertReportShape` (new internal helper
  `assertReportCsvFields`) under the direction prefix
  `cannot render settlement report as CSV: …`, so a non-object report,
  an empty `escrowId`, an illegal `outcome`, an empty `parties` array,
  an unknown party role, or a non-finite party amount fails fast
  instead of emitting a literal `Infinity`/`NaN` row — the gap the JSON
  renderer (#579/#591) already closed. Only the CSV-carried fields are
  required, and totals/`balanced` are checked when present, so a parsed
  `SettlementReportCsv` still re-renders byte-identically and golden
  released/refunded/expired CSVs are unchanged.
  `test/renderReportCsvShape.test.ts` (13 cases).
- `verifyHistoryChain` now compares keyed (HMAC) audit-chain digests in
  constant time (`timingSafeEqual` with a length guard, via a new
  `constantTimeHexEqual` helper), matching the webhook signature
  verification in `src/webhooks.ts` and the dataquest-side fix (#541):
  an online verifier no longer leaks a per-byte timing signal, and a
  forged digest of the wrong shape (short, long, odd-length, empty, or
  non-hex) fails verification instead of throwing. Unkeyed chains keep
  plain `===` (tamper evidence, not a MAC). SECURITY.md keyed-chain
  section documents the constant-time comparison.
  `test/historyChainTimingSafe.test.ts` (9 cases).

- `expireOverdueEscrows` now pins the screening `now` as the `at` of
  every `EXPIRE` audit entry it dispatches
  (`dispatch("EXPIRE", undefined, undefined, { at: now })`): a fixed
  screening instant yields identical entries across the batch and across
  replays — the dispatch-time wall clock no longer leaks into the audit
  history, closing the honest caveat the demo documented in its source.
  Pinning inherits dispatch's no-backward-clock rule: a `now` earlier
  than an escrow's last history entry lands as per-escrow
  `{ expired: false, error }` and the batch continues (this is the
  documented behavior of the pinned `at`). JSDoc, README Deadlines
  section and demo walkthrough updated; the stale caveats in the demo
  source and tests were replaced with a pinned-`at` assertion
  (`expireEntry.at === DEMO_STALE_NOW`). `test/expireOverdueAt.test.ts`
  (10 cases).

### Added

- `deliverSettlementWebhook` refuses plaintext `http:` by default
  (`DeliverWebhookOptions.allowInsecureHttp`, opt-in): an `http:`
  endpoint URL throws `refusing to POST over plaintext http` before any
  request is made — the signed payload plus the `X-Signature` header are
  replayable over the clear, the remaining transport-layer gap after #84
  closed the 3xx redirect leak. Check order is URL parse -> protocol
  whitelist -> https gate; `https:` URLs are never gated; a non-boolean
  opt-in is a config error. `deliverSettlementWebhookToMany` supports the
  flag per endpoint (`SettlementWebhookEndpoint.allowInsecureHttp`
  overrides the call-level value). Honest limit: the refusal only blocks
  plaintext — no certificate validation, no TLS pinning (README Webhooks
  and SECURITY.md say so). All loopback-http delivery tests opt in
  explicitly; `test/webhookHttpsEnforcement.test.ts` (8 cases).

- Constructor `EscrowOptions` unknown-field fail-closed: `new Escrow(id,
  opts)` now rejects any option key outside
  `requireVerifyEvidence`/`maxDeposit`/`auditKey`/`rolePolicy` with
  `invalid escrow options: unknown option "<name>"`, checked before any
  field is consumed — a typo'd `maxDeposit` (e.g. `maxDepost`) can no
  longer silently disable the deposit-cap risk control. Mirrors the
  snapshot-side whitelist from #132 on the more dangerous side
  (constructor options are live risk controls). `Escrow.fromJSON`'s
  `opts` go through the same constructor, so the restore path is
  covered too. `test/escrowOptionsUnknownFields.test.ts` (10 cases).
  README test count updated to the true 739.

- New demo segment "Deposit cap (maxDeposit risk control)": a branch
  escrow (`demo-cap`, `maxDeposit: 10000`) accepts FUND 9000 (locked
  9000), rejects an over-cap FUND 2000 with the exact pinned error
  `deposit cap exceeded: locked 9000 + new funding 2000 would exceed
  maxDeposit 10000` and zero history residue (state and locked total
  unchanged), then accepts a boundary top-up of 1000 that lands
  exactly on the cap (cent-precision comparison). All three outcomes
  are asserted inside the demo against hand-pinned fixtures
  (`DEMO_DEPOSIT_CAP_*`), `DemoResult` gains `depositCapEscrow`,
  `depositCapLockedTotal`, and `depositCapOverfundError`, and two new
  demo tests pin the printed lines and two-run byte-identical output.
  README test count updated to the true 711.

- New benchmark path `renderReport (refunded + expired, 2 reports)`:
  two fixed non-released reports rendered on every iteration — a
  refunded report over a 4-entry
  FUND/SUBMIT_MILESTONE/DISPUTE/ARBITRATE_REFUND history (escrow
  BENCH-RENDER-REFUND) and an expired report over a 2-entry
  FUND/EXPIRE history (escrow BENCH-RENDER-EXPIRE). Each carries the
  full deposit refunded (sponsor inflow = outflow = 10,630, every party
  net 0, no `releasePath`, balanced, the `Audit:` window line verbatim)
  and both rendered texts are checked against hand-written expected
  lines — header / outcome, the deposit formula line, the sponsor and
  creator rows, the balanced totals line, the `Audit:` window line —
  with the released-only oracle-fee note line pinned absent, so a drift
  in the refunded/expired ledger shapes fails the bench instead of
  silently re-timing a changed output. A mutation probe (corrupting the
  hand-pinned creator net row expectation to a non-0 value) fails the
  bench at fixture load with the exact self-check error, confirming the
  pin is live. The run measured ~522.2 ops/sec (~1,914.88 µs/op) for
  this row. The new row joins the README benchmark table, with the
  whole table refreshed from the same real run. No network, no
  randomness, no wall clock.

- New benchmark path for `dispatch` with `idempotencyKey`: on a
  fresh escrow rebuilt every iteration, FUND of the golden 10630
  with a fresh key k1 at the base instant, the same FUND with k1
  again (the duplicate delivery — the same state returned, the
  history untouched at exactly 1 entry, no seq advance), then
  SUBMIT_MILESTONE with a fresh key k2 (the run measured
  ~17,068 ops/sec, ~58.59 µs/op for this row). Every iteration
  checks both k1 dispatches returning FUNDED, the pinned
  SUBMIT_MILESTONE entry field for field, a history of exactly 2
  entries, and an intact hash chain. Outside the timed loop, a
  cross-event key reuse (a SUBMIT_MILESTONE reusing the FUND key)
  is pinned to the same no-op, and a failed (negative-amount)
  dispatch is pinned to consume no key — the same key retries
  successfully after the input is fixed. A mutation probe
  (corrupting the pinned history-length expectation) fails the
  bench at fixture load, confirming the pin is live. No network,
  no randomness and no wall clock. The
  `dispatch idempotencyKey (key hit/miss)` row joins the README
  benchmark table, with the whole table refreshed from one real
  run.

- New demo segment for staged top-up funding: a separate escrow
  (DEMO-ESC-025) is funded in two instalments — the golden 10630
  first, then a 2000 top-up on the FUNDED self-loop — so
  `depositAmountFromHistory` traces 12630 from the two FUND audit
  entries alone, and the escrow then walks SUBMIT_MILESTONE ->
  VERIFY_PASS -> RELEASE and is settled at 500 bps with no
  referral credits, pinning pro fee 631.50 and net 11998.50 with
  conservation, plus the released report's four party nets
  (sponsor −12630 / creator +11998.50 / platform +631.50 /
  referrer 0, inflows 12630, outflows 12630, balanced). The
  single-FUND golden path never showed staged funding — the
  payment reality top-ups model — and the summation the audit
  trail corroborates is asserted by the demo itself (hand-pinned)
  before printing; the segment sits between the settlement-split
  and NDJSON round-trip segments, the main chain is untouched,
  and `DemoResult` gains `topupEscrow`, `topupTracedDeposit`,
  `topupSettlement` and `topupReport`. Zero network, zero
  randomness, fixed timestamps. README test count 703 → 705.

- New demo segment for the `calculateDeposit` fee-breakdown
  intermediate: the deposit preview line inlines
  `base × multiplier` as a bare product, so this segment shows
  the README formula field by field — the golden vector pins
  `adjustedBaseFee = round2(600 × 1) = 600` with deposit 10630
  as the exact sum of its components, and a second pinned
  fractional-multiplier vector (base 599.99 × 1.25, raw product
  749.9875) pins `adjustedBaseFee = 749.99` with deposit 10779.99
  as the exact components sum, exercising the `round2`
  rounding on the intermediate. The demo itself asserts every
  pinned field before printing (a changed formula or rounding
  regression fails the demo, not just a test), the segment sits
  between the deposit preview and the dispatch steps, and
  `DemoResult` gains `depositBreakdown`, `fractionalFeeInputs`
  and `fractionalDepositBreakdown`. Zero network, zero
  randomness, fixed inputs. README test count 701 → 703.

- New demo segment for the receiver-side dedupe capacity
  bound: a `SettlementEventDedupe` with `maxEntries: 3` on a
  fixed clock records four fixed eventIds — the fourth
  distinct id forces the LRU eviction of the oldest entry
  (counted in `stats().evictions`), and the evicted id
  counts as a new event when seen again, evicting the next
  oldest in turn — pinning verdict order
  `[false, true, false, false, false, false]` and stats
  `{size: 3, hits: 1, misses: 4, evictions: 1}` after the
  first eviction and `{size: 3, hits: 1, misses: 5,
  evictions: 2}` after the re-record; a
  `maxEntries: 0` construction is pinned to throw exactly
  `SettlementEventDedupe: maxEntries must be a positive
  integer`. The segment sits between the dedupe clear
  segment and the subscribe onError segment, every id stays
  inside its TTL (the evictions shown are capacity
  evictions only), and zero network, zero randomness and
  no wall clock enter it. README test count 699 → 701.

- New benchmark path for the settlement webhook fan-out
  per-endpoint `timeoutMs` override:
  `deliverSettlementWebhookToMany` to 3 fixed endpoints where
  one pins its own tiny `timeoutMs` (10 ms, retries 0) and hangs
  — the fake `fetch` installed on `globalThis` only rejects its
  request when the per-attempt timer aborts — while the other two
  answer 200 immediately under the call-level `timeoutMs: 5000`.
  Every iteration checks the results keep input order, the slow
  endpoint fails with the pinned timeout text (`webhook delivery
  to https://slow.example.com/hooks/settlement failed after 1
  attempt: webhook delivery timed out after 10ms`,
  `attempts: 1`), and the two fast endpoints keep the normal
  success shape (the run measured ~95.7 ops/sec,
  ~10452.04 µs/op for this row — the pinned 10 ms timeout wait
  itself is the object under test, so no elapsed-time assertion
  is made anywhere). Outside the timed loop, an illegal
  per-endpoint `timeoutMs` (0) is pinned to fail only its own
  endpoint with the exact configuration error and `attempts` 0
  (zero fetch calls), and the same three endpoints without
  overrides are pinned to keep the normal fan-out success shape
  (the override is opt-in, the pre-override behavior
  unchanged). No network, no randomness and no wall clock. The
  `deliverSettlementWebhookToMany (per-endpoint timeoutMs
  override)` row joins the README benchmark table, with the
  whole table refreshed from one real run.

- New benchmark path for the settlement report audit time
  window: `buildSettlementReport` over the fixed released
  history (built on fixed timestamps) is checked on every
  iteration for the three audit time-window fields verbatim —
  `eventCount` 4, `firstEventAt` `2026-01-01T00:00:00.000Z`,
  and `lastEventAt` `2026-01-01T00:00:03.000Z` (the run
  measured ~40,629 ops/sec, ~24.61 µs/op for this row). Outside the
  timed loop, the golden released report's rendered
  `Audit: 4 events, 2026-01-01T00:00:00.000Z → 2026-01-01T00:00:03.000Z`
  line is pinned word for word, and the degenerate empty-history
  shape (`eventCount` 0, no `firstEventAt` / `lastEventAt` at all —
  the public API fail-fasts on empty histories by design, so the
  shape is pinned via a hand-built report object) is pinned to
  render exactly `Audit: 0 events` with the arrow span omitted. A
  mutation probe (corrupting the pinned `firstEventAt` expectation)
  fails the bench at fixture load, confirming the pin is live. No
  network, no randomness and no wall clock. The
  `buildSettlementReport audit window
  (eventCount/firstEventAt/lastEventAt)` row joins the README
  benchmark table, with the whole table refreshed from one real
  run.

- New benchmark path for the settlement report
  `releasePath` settlement path: `buildSettlementReport`
  over the fixed released history (built on fixed
  timestamps) is checked on every iteration for outcome
  `released` and `releasePath` verbatim
  `VERIFY_PASS → RELEASE` (the run measured ~52,452
  ops/sec, ~19.06 µs/op for this row). Outside the timed
  loop, the rendered line
  `Outcome: released (via VERIFY_PASS → RELEASE)` is
  pinned, a refunded report is pinned to carry no
  `releasePath` field at all, its webhook serialization
  is pinned to contain no `releasePath` key, and the
  released webhook's key order is pinned to the
  canonical order with `releasePath` between `outcome`
  and `deposit`. No network, no randomness and no
  wall clock. The
  `buildSettlementReport releasePath (released report)`
  row joins the README benchmark table, with the whole
  table refreshed from one real run.

- The CLI demo now shows a dedicated stale patrol over five
  further escrows screened by `staleEscrows` alone on the
  demo's fixed `now` under a patrol `maxAgeByState` map
  (CREATED / FUNDED / RELEASED at 7 days each, VERIFIED
  deliberately unmapped): only the FUNDED escrow stuck for
  17 days is selected, while four escrows are each excluded
  for a different pinned reason — one exactly at its 7-day
  budget (staleness is strictly past the budget), one
  RELEASED terminal escrow whose last entry is 22 days old
  (terminal states are never stale, even with a budget in
  the map), one CREATED escrow with no history (no
  measurable dwell), and one VERIFIED escrow 22 days into
  its state with no budget in the map (no budget = no
  staleness). The selection is asserted outside the printing
  against the hand-pinned expectation, `actOnStaleEscrows`
  then runs a notify-only action over it (one attempted,
  acted true, the notified id recorded, nothing dispatched
  — every patrol escrow keeps its state and history), and
  an unknown state name in the map is shown failing fast
  with the exact error `invalid maxAgeByState: unknown
  state "BOGUS"` before any escrow is read. `DemoResult`
  gains the patrol batch, selection, action results,
  notified ids and config-error fields; the demo tests grow
  by two (699 total). Fixed timestamps throughout, zero
  network, zero randomness.

- New benchmark path for the settlement webhook
  `timeoutMs` per-attempt timeout: the fixed signed
  webhook is delivered with `timeoutMs: 10` and
  `retries: 0` through a hanging fake global `fetch`
  (the fake only ever rejects when its request signal
  aborts, so the pinned short timeout is the only thing
  that can end the attempt), checked on every iteration
  to reject with the exact error `webhook delivery to
  https://settlement.example.com/hooks/settlement failed
  after 1 attempt: webhook delivery timed out after
  10ms`, the annotated attempt count 1, and exactly one
  fetch call (the run measured ~96.3 ops/sec,
  ~10389.31 µs/op for this row — the pinned 10 ms wait
  dominates it by design). Outside the timed loop, an
  illegal `timeoutMs` of 0 is pinned to throw the exact
  configuration error `cannot deliver settlement
  webhook: timeoutMs must be a positive number, got 0`
  before any request at zero fetch calls, and a generous
  `timeoutMs` of 5000 over an immediate 200 is pinned
  to keep the normal `{ status: 200, attempts: 1 }`
  success shape after exactly one fetch. Honest limit:
  the timeout wait itself is the object under test and
  is the pinned short 10 ms — no elapsed-time
  (wall-clock) assertion is made anywhere. No network
  and no randomness. The
  `deliverSettlementWebhook (timeoutMs timeout)` row
  joins the README benchmark table, with the whole
  table refreshed from one real run.

- New benchmark path for the `dispatch` `expectedSeq`
  optimistic-concurrency guard: a fresh escrow is rebuilt
  on every iteration and driven on fixed timestamps —
  FUND of the golden 10,630 at the fixed base instant and
  SUBMIT_MILESTONE one second later, so the history holds
  exactly two entries — then `dispatch("VERIFY_PASS")`
  with `expectedSeq: 2` is checked for the VERIFIED
  state, a history grown by exactly one entry (2 -> 3),
  and the appended entry pinned field for field (the run
  measured ~39,197 ops/sec, ~25.51 µs/op for this row).
  Outside the timed loop, a stale `expectedSeq` is
  pinned to throw the exact error `dispatch conflict:
  expected seq 1 but escrow is at seq 2` and to leave
  state and history unchanged entry for entry, an
  empty-history escrow is pinned to advance with
  `expectedSeq: 0`, illegal values (-1 and 1.5) are
  pinned to their exact configuration errors, and a
  dispatch without `expectedSeq` is pinned to keep the
  pre-guard behavior. No network, no randomness and no
  wall clock. The
  `dispatch expectedSeq (optimistic concurrency)` row
  joins the README benchmark table, with the whole
  table refreshed from one real run.

- New benchmark path for the `maxDeposit` deposit cap:
  a fresh capped escrow (`maxDeposit: 10630`, the golden
  deposit as the cap) is rebuilt on every iteration and
  funded in two dispatches on fixed timestamps — an
  initial FUND of 7,000 at the fixed base instant and a
  3,630 top-up one second later — landing the locked
  total exactly on the cap, checked for the FUNDED
  state, a history of exactly two entries, and the two
  pinned amounts summing to the cap (the run measured
  ~73,202 ops/sec, ~13.66 µs/op for this row). Outside
  the timed loop, a FUND one cent over the cap is
  pinned to throw the exact error `deposit cap
  exceeded: locked 10630 + new funding 0.01 would
  exceed maxDeposit 10630` and to leave state and
  history unchanged entry for entry, a FUND without an
  amount is pinned to stay uncapped even at the cap
  (it carries no money and contributes nothing to the
  locked total, so a later one-cent FUND still reports
  the same locked total), and an escrow without the
  option is pinned to keep the pre-cap behavior. No
  network, no randomness and no wall clock. The
  `maxDeposit FUND (deposit cap, funds to cap)` row
  joins the README benchmark table, with the whole
  table refreshed from one real run.

- New benchmark path for the `requireVerifyEvidence`
  evidence gate: a fresh strict escrow is rebuilt on every
  iteration (FUND of the golden 10,630 at the fixed base
  instant, SUBMIT_MILESTONE one second later), then
  `dispatch("VERIFY_PASS")` with the pinned evidence
  reference is checked for the VERIFIED state, a history
  grown by exactly one entry (2 -> 3), and the evidence
  recorded verbatim on the appended entry (the run
  measured ~34,889 ops/sec, ~28.66 µs/op for this row).
  Outside the timed loop, an evidence-free VERIFY_PASS is
  pinned to throw the exact gate error and to leave state
  and history unchanged entry for entry before the same
  escrow passes with evidence, a default escrow is pinned
  to keep the pre-gate evidence-free behavior, and a
  non-boolean flag value is pinned to its exact
  constructor configuration error. The library records
  the caller's evidence reference; it does not verify
  the attestation behind it. No network, no randomness
  and no wall clock. The
  `requireVerifyEvidence VERIFY_PASS (evidence gate)` row
  joins the README benchmark table, with the whole table
  refreshed from one real run.

- New benchmark path for the `deliverSettlementWebhook`
  `maxRetryDelayMs` retry-delay clamp: a counting fake global
  `fetch` answers 429 with `Retry-After: 31536000` — a one-year
  hint a faulty or hostile server could send — first and 200
  second, and every iteration delivers with `maxRetryDelayMs: 0`
  and checks the result is exactly `{ status: 200, attempts: 2 }`
  after exactly two fetch calls, so the hint is parsed and then
  clamped to zero by `Math.min` and the retry is immediate (the
  run measured ~1321.86 µs/op, dominated by the zero-delay
  timer). An illegal `maxRetryDelayMs` of -1 is pinned once
  outside the timed loop to its exact configuration error before
  any request, and a hint-less 500-then-200 script pinned to the
  exponential-backoff fallback shape. No real network, no
  randomness, no real waiting and no wall clock. The
  `deliverSettlementWebhook (maxRetryDelayMs clamp, 429 hint)`
  row joins the README benchmark table, with the whole table
  refreshed from one real run.

- CLI demo coverage for the settlement-webhook
  per-attempt `timeoutMs` bound: the main escrow's
  signed webhook is delivered three more times against
  scripted fake global `fetch` seams — a hanging fake
  (it only ever rejects when its request signal aborts)
  with the pinned short `timeoutMs` of 50 ms and
  `retries: 0` fails the delivery after exactly 1
  attempt with the exact error `webhook delivery to
  https://hooks.example.com/settlement-timeout failed
  after 1 attempt: webhook delivery timed out after
  50ms` and exactly 1 fetch call; `timeoutMs: 0` throws
  the exact configuration error `cannot deliver
  settlement webhook: timeoutMs must be a positive
  number, got 0` before any request (0 fetch calls);
  and a generous 5000 ms timeout over an immediately
  200 fake resolves the unchanged success shape
  `{ status: 200, attempts: 1 }`. Honest limit: the
  timeout wait is the object under test itself and is
  the pinned short duration — no elapsed-time
  (wall-clock) assertion is made and no duration is
  printed, so the demo output stays byte-identical
  across runs. Zero real network, zero randomness.
- Benchmark coverage for the settlement-webhook
  pre-aborted `AbortSignal` delivery path:
  `deliverSettlementWebhook` with a pre-aborted
  `signal` over the fixed webhook fixture, through a
  counting fake global `fetch`, checked on every
  iteration to reject with the exact error
  `webhook delivery aborted` and to leave the fetch
  call count at exactly zero. This separates the
  deterministic cancel-before-dispatch guard (the
  aborted check runs before any request is made)
  from the single-target delivery row, which never
  sets a signal. Outside the timed loop, a
  non-`AbortSignal` `signal` value is pinned to
  throw its exact configuration error before any
  request, and a signal that never aborts is pinned
  to leave the normal delivery path untouched
  (`{ status: 200, attempts: 1 }` after exactly one
  fetch). The README Benchmarks table was refreshed
  from one real run and gained the
  `deliverSettlementWebhook (pre-aborted signal)`
  row.
- Benchmark coverage for the settlement-webhook
  `maxFutureSkewMs` future-skew verification path:
  `verifySettlementWebhook` with
  `{ secrets: [secret], maxFutureSkewMs: 300000, now }`
  over the fixed webhook fixture (signed at the fixed
  timestamp / `eventId`, so its payload `at` is
  pinned), with the injected `now` pinned at
  `at - 120s` so the payload sits 120 s in the future,
  inside the skew window — checked to return exactly
  `true` on every iteration. This separates the
  future side of the two-sided freshness window
  (signature check first, freshness gate only after a
  match) from the plain, secret-rotation, and
  `maxAgeMs` verify rows, none of which bounds a
  future timestamp. Outside the timed loop, an
  over-skew payload (`now` at
  `at - maxFutureSkewMs - 1`) is pinned to return
  `false`, a payload skewed exactly to the boundary
  is pinned to still verify (the boundary is
  inclusive), both bounds set together are pinned to
  reject on each side while a payload inside both
  windows still verifies, and an illegal
  `maxFutureSkewMs` of -1 is pinned to throw its
  exact configuration error. The README Benchmarks
  table was refreshed from one real run and gained
  the `verifySettlementWebhook (maxFutureSkewMs future-skew window)`
  row.
- Benchmark coverage for the settlement-webhook
  `maxAgeMs` freshness verification path:
  `verifySettlementWebhook` with
  `{ secrets: [secret], maxAgeMs: 300000, now }` over
  the fixed webhook fixture (signed at the fixed
  timestamp / `eventId`, so its payload `at` is
  pinned), with the injected `now` pinned at
  `at + 120s` inside the window — checked to return
  exactly `true` on every iteration. This separates
  the opt-in replay-bound receiver cost (signature
  check first, freshness gate only after a match)
  from the plain and secret-rotation verify rows,
  which never set a window. Outside the timed loop,
  an over-age payload (`now` at `at + maxAgeMs + 1`)
  is pinned to return `false`, a payload aged
  exactly to the boundary is pinned to still verify
  (the boundary is inclusive), and an illegal
  `maxAgeMs` of -1 is pinned to throw its exact
  configuration error. The README Benchmarks table
  was refreshed from one real run and gained the
  `verifySettlementWebhook (maxAgeMs freshness window)`
  row.
- CLI demo coverage for the keyed audit chain: a
  fresh branch escrow (DEMO-ESC-019, constructed with
  the pinned `auditKey`) is driven on fixed timestamps
  through the full lifecycle (FUND / SUBMIT_MILESTONE /
  VERIFY_PASS / RELEASE, 4 entries), and
  `verifyHistoryChain` is exercised in every shape —
  the correct key verifies the HMAC-SHA256-chained
  history; a wrong key returns `false`; no key returns
  `false` (the keyed and unkeyed modes fail closed
  against each other); and a detached copy whose
  middle (SUBMIT_MILESTONE) entry's note is rewritten
  returns `false` even under the correct key, with the
  escrow's own history still verifying afterwards.
  The entry is honest about the limit: both demo keys
  are printed placeholders, not real secrets, and key
  management stays the caller's problem — the key is
  per-instance configuration and is never written
  into snapshots. All shapes are asserted outside the
  printing against hand-pinned expectations, and an
  independent re-verification in the demo tests drives
  fresh keyed and unkeyed escrows through the same
  shapes and agrees. `DemoResult` exposes the branch
  escrow, the four verdicts, the tampered note, and
  the history length. Demo and tests only; no library
  behavior change.
- CLI demo coverage for the verify-evidence gate: two
  fresh branch escrows (DEMO-ESC-017 with
  `requireVerifyEvidence: true` and DEMO-ESC-018 with
  the flag off) are driven on fixed timestamps through
  `dispatch("VERIFY_PASS")` in every shape — the
  strict escrow's evidence-free VERIFY_PASS throws the
  pinned `verify evidence required: dispatch("VERIFY_PASS")
  requires a non-empty evidence reference when
  requireVerifyEvidence is enabled` error and leaves
  state and history untouched; the same dispatch
  carrying the pinned evidence reference succeeds and
  records the reference verbatim on the audit entry;
  and the default escrow's evidence-free VERIFY_PASS
  succeeds, preserving the pre-gate behavior. The
  entry is honest about the limit: the library records
  the caller's reference and does not verify the
  oracle signature, zk proof, or TEE attestation
  behind it. All shapes are asserted outside the
  printing against hand-pinned expectations, and an
  independent re-verification in the demo tests drives
  fresh escrows through the same shapes and agrees.
  `DemoResult` exposes both branch escrows, the thrown
  error message, the post-rejection state/history, the
  verified state, the recorded reference, and the
  default result. Demo and tests only; no library
  behavior change.
- CLI demo coverage for the dispatch optimistic-
  concurrency guard: a fresh branch escrow
  (DEMO-ESC-016) is driven on fixed timestamps through
  `dispatch(..., { expectedSeq })` in every shape —
  FUND with `expectedSeq: 0` and SUBMIT_MILESTONE with
  `expectedSeq: 1` succeed, each advancing the seq by
  exactly one entry; a VERIFY_PASS retried with the
  stale `expectedSeq: 1` pin throws the pinned
  `dispatch conflict: expected seq 1 but escrow is at seq 2`
  error and leaves state and history untouched; pins
  of `-1` and `1.5` throw the pinned
  non-negative-integer validation error; and a final
  VERIFY_PASS with no pin succeeds, preserving the
  pre-guard behavior. All shapes are asserted outside
  the printing against hand-pinned expectations, and
  an independent re-verification in the demo tests
  drives a fresh escrow through the same shapes and
  agrees. `DemoResult` exposes the branch escrow, both
  guarded states and seqs, the three thrown error
  messages, the post-conflict state/history, and the
  unguarded result. Demo and tests only; no library
  behavior change.
- Benchmark coverage for the keyed audit-chain
  verification path: `verifyHistoryChain` with the
  pinned `auditKey` over a fixed 4-entry history
  produced by an escrow constructed with that key
  (the same lifecycle, id, and fixed dispatch
  timestamps as the unkeyed bench fixture, so the two
  chains differ only in their hash function —
  HMAC-SHA256 instead of plain SHA-256), checked to
  return exactly `true` on every iteration with the
  genesis and successor links pinned on every
  iteration as well. Outside the timed loop, a wrong
  key is pinned to return `false`, verification with
  no key is pinned to return `false` (the keyed and
  unkeyed modes fail closed against each other), and
  a detached tampered copy (the middle entry gaining
  a note it never carried) is pinned to return
  `false` under the correct key. This separates the
  keyed (MAC) audit-chain cost from the unkeyed
  verify row, which never exercises the HMAC form.
  The README Benchmarks table was refreshed from one
  real run and gained the
  `verifyHistoryChain auditKey (4 entries, keyed)`
  row.
- Benchmark coverage for the settlement-webhook
  secret-rotation verification path:
  `verifySettlementWebhook` with the rotation candidate
  set `{ secrets: [new, old] }` over the fixed webhook
  fixture signed with the OLD secret (fixed timestamp /
  `eventId`), so the matching candidate is the second
  one tried and every iteration pays one failed HMAC
  trial before the match — checked to return exactly
  `true` on every iteration. Outside the timed loop, a
  candidate pair in which neither secret matches is
  pinned to return `false` (all-mismatch fails closed,
  no throw) and an empty `secrets` array is pinned to
  throw the exact `secrets must be a non-empty array`
  configuration error. This separates the rotation-window
  receiver cost from the single-secret verify row, which
  never exercises a candidate list. The README
  Benchmarks table was refreshed from one real run and
  gained the
  `verifySettlementWebhook (secrets rotation, 2 candidates)`
  row.
- Benchmark coverage for the quorum approval-expiry
  path: the counting views (`approvalCount()` /
  `hasQuorum()` / `approvals()`) of a fresh 5/9 quorum
  configured with `maxApprovalAgeMs` (60-second window)
  on an advancing injected clock, checked on every
  iteration against hand-pinned expectations (approvals
  staggered at BASE, BASE + 30s, and BASE + 60s — all
  five counted with dao-1 exactly at the inclusive
  boundary, then expiring one at a time as the clock
  crosses each window, dao-2 pinned at its own boundary
  on the way, `approvalLog()` held at its full 5 entries
  throughout, and the two expired signers re-approving
  to restore the quorum with the log grown to 7), with
  the fully-expired log retention and the re-approval's
  fresh timestamp pinned once outside the timed loop.
  This separates the approval-freshness cost from the
  approve / revoke / snapshot rows, which never set an
  expiry window. The README Benchmarks table was
  refreshed from one real run and gained the
  `quorum maxApprovalAgeMs expiry (5 of 9, 60s window)`
  row.
- CLI demo coverage for settlement-webhook secret
  rotation: the main escrow's signed webhook (signed with
  the demo secret, playing the old secret) is re-verified
  under the rotation candidate set
  `{ secrets: [new, old] }` — the old-signed body verifies,
  a twin signed with the rotated-in secret over the
  identical payload (same fixed `now` / `eventId`) verifies
  too, a twin signed with an unrelated secret is refused
  (`false`, no throw — all-mismatch fails closed), and an
  empty `secrets` array throws the pinned
  `secrets must be a non-empty array` configuration error.
  All four shapes are asserted outside the printing against
  hand-pinned expectations, and an independent
  re-verification in the demo tests rebuilds the twins by
  hand and agrees. `DemoResult` exposes all three verdicts
  and the thrown error message; the demo tests pin the
  segment's lines and its order between the freshness and
  dedupe sections. Demo and tests only; no library
  behavior change.
- CLI demo coverage for `deliverSettlementWebhook`
  caller cancellation: the main escrow's signed webhook is
  delivered with an `AbortSignal` in two shapes — a
  pre-aborted signal throws `webhook delivery aborted`
  with the counting fake fetch called zero times, and an
  abort landing during the pinned 60-second backoff sleep
  after a scripted 500 rejects with the same error after
  exactly one fetch and no retry. Both shapes are asserted
  outside the printing against hand-pinned expectations
  (fake fetch only, zero network, zero real waiting).
- CLI demo coverage for the settlement-webhook freshness
  window: the main escrow's signed webhook is re-verified
  under the opt-in `maxAgeMs` bound (1 hour) at three
  injected instants — inside the window and exactly at its
  inclusive boundary it verifies, past the window the
  still-valid signature is refused fail-closed — and under
  a 5-minute `maxFutureSkewMs` bound with the payload's
  `at` 10 minutes ahead of the injected `now`, which is
  refused as sender-clock skew beyond the bound. All four
  verdicts are asserted outside the printing against
  hand-pinned expectations, and an independent
  re-verification in the demo tests confirms the expired
  verdict comes from the window, not the signature (the
  same body verifies with no window configured).
  `DemoResult` exposes both bounds and all four verdicts;
  the demo tests pin the segment's lines, its order, and
  its fixture instants. Demo and tests only; no library
  behavior change.
- Benchmark coverage for the quorum snapshot export
  path: `snapshot()` on the fixed 9-signer / threshold-5
  quorum carrying 7 recorded approvals (dao-1..dao-7, one
  second apart on a stepped fixed clock — the same shape
  the snapshot-restore row persists) — the checkpoint
  export an arbitration service pays on every persist,
  previously visible only as the restore fixture's one
  construction call. Its per-iteration self-check pins
  the exported envelope against hand-written expectations
  (the `{ v: 1, ... }` envelope in its pinned key order,
  threshold 5, the 9 signers in config order, no
  `maxApprovalAgeMs` key, and the 7 approval entries in
  record order with their pinned canonical timestamps);
  outside the timed loop, a detached-copy mutation is
  pinned to leave a re-export unchanged and the
  JSON round-tripped export is pinned to restore via
  `restoreQuorum` into a quorum re-exporting the restore
  fixture's persisted snapshot byte-for-byte. The README
  Benchmarks table was refreshed from one real run and
  gained the `quorum snapshot export (7 approvals of 9)`
  row (51,679 ops/sec in that run). Benchmark only; no
  library behavior change.
- CLI demo coverage for the quorum `revoke()`
  vote-change path: a fresh 2-of-3 quorum on a fixed
  clock collects two approvals and reaches its
  threshold, one signer revokes (approvalCount drops
  to 1, `hasQuorum()` turns false, `approvals()` is
  exactly [arb-2] and the audit trail keeps only that
  signer's entry), and the same signer re-approves —
  the threshold is restored with the re-voter last in
  `approvals()` order. Revoking an unknown signer and
  revoking a signer that never approved are both
  rejected with their exact errors and leave the
  quorum untouched; all sides are asserted outside
  the printing against hand-pinned expectations.
  `DemoResult` exposes the quorum, the before / after
  counts and quorum verdicts, the approval orders,
  the final audit trail, and both error messages; the
  demo tests pin the segment's lines, its order, and
  its determinism. Demo and tests only; no library
  behavior change.
- CLI demo coverage for the 429 Retry-After delivery
  retry path: the main escrow's signed webhook is
  delivered with `deliverSettlementWebhook()` to a
  scripted fake endpoint that answers 429 with a pinned
  `Retry-After: 120` header first and 200 on the retry —
  the first demo delivery to run the rate-limit retry
  end to end (the parsing segment only ever parsed
  hints; no earlier delivery took the 429 path). The
  segment prints the parsed hint (120,000 ms) and the
  clamp: `maxRetryDelayMs: 0` clamps the parsed wait to
  zero, so the hint is parsed and applied with no real
  waiting. Outside the printing it asserts the result
  is exactly `{status: 200, attempts: 2}`, exactly two
  POSTs were captured with byte-identical signed
  bodies, and the re-delivered attempt's `X-Signature`
  verifies over the captured body under the demo
  secret. `DemoResult` exposes the delivery result, the
  parsed hint milliseconds, the captured calls, and the
  signature-verified verdict; the demo tests pin the
  segment's lines, its order, and its determinism.
  Demo and tests only; no library behavior change.
- Benchmark coverage for the settlement-event dedupe
  stats snapshot path: `SettlementEventDedupe.stats()` on a
  fixed dedupe (7 ids recorded under an injectable clock
  that advances only while the fixture is built, with a
  60-second TTL and a capacity of 6 — one id LRU-evicted
  during construction, one id expired at the stats instant
  but still sitting in the map, and 5 live ids) — the
  observability snapshot a receiver's monitoring polls on
  every tick, previously read only as an incidental fixture
  self-check inside the other dedupe paths. Its
  per-iteration self-check pins the snapshot to the
  hand-written expectation (`{ size: 5, hits: 1, misses: 7,
  evictions: 1 }` — size counts only the live ids, so the
  expired id still sitting in the map is excluded); outside
  the timed loop, a mutated detached snapshot is pinned to
  leave a re-read unchanged and an empty dedupe is pinned
  to report all-zero stats. The README Benchmarks table was
  refreshed from one real run and gained the
  `SettlementEventDedupe.stats (5 live entries, 1 expired)`
  row (4,077,272 ops/sec in that run). Benchmark only; no
  library behavior change.
- Benchmark coverage for the settlement-event dedupe
  clear reset path: `SettlementEventDedupe.clear()` on a
  fresh dedupe rebuilt on every iteration (1,000 fixed
  ids recorded under an injected fixed clock, plus one
  duplicate hit on the first id, so the counters about to
  be zeroed are non-trivial), checked on every iteration
  against hand-pinned expectations (the size and every
  observability counter at zero right after the clear,
  the first id recording as a new event again with the
  counters re-accumulating from zero), with clearing an
  empty dedupe pinned as a harmless no-op once outside
  the timed loop. This separates the reset cost from the
  checkAndRecord / restore / exportSnapshot rows, which
  never drop the recorded ids. The README Benchmarks
  table was refreshed from one real run and gained the
  `SettlementEventDedupe.clear (1,000 recorded ids, fresh fixture)`
  row (6,635 ops/sec in that run).
- CLI demo coverage for the README diagram sync check:
  `readmeDiagramInSync()` (imported directly from
  `src/diagram.ts`, as the benchmark does) reads this
  repo's README and the demo prints its verdict — `true`,
  the README embeds the exact `stateDiagram()` block
  generated in the preceding segment, with no diagram
  drift — alongside the checked file and the
  `node dist/src/diagram.js --check` CLI equivalent.
  The verdict is asserted outside the printing against
  the hand-pinned `true` expectation the diagram tests
  pin, and the failure message says how to repair drift
  (regenerate with `npm run diagram` and paste the
  generated block into README.md).
- CLI demo coverage for the settlement-event dedupe
  clear reset path: a fresh `SettlementEventDedupe` on a
  fixed clock records one fixed eventId (new on first
  sight, a duplicate on immediate redelivery, with stats
  pinned at `{size: 1, hits: 1, misses: 1, evictions: 0}`),
  is reset with `clear()` — the printed size and stats
  read all zero — and the same eventId then counts as
  new again and is re-recorded, its stats counting up
  from zero (`{size: 1, hits: 0, misses: 1, evictions: 0}`).
  The segment shows the explicit window reset a receiver
  uses at key rotation, in test isolation, or at a window
  reset, as the deliberate opposite of the snapshot
  segment, where the recorded ids survive a restart.
- Benchmark coverage for the settlement-event dedupe
  snapshot export path: `SettlementEventDedupe.exportSnapshot()`
  over a dedupe holding 1,001 recorded ids (1,000 live ids
  plus one entry aged exactly to its TTL boundary, so it is
  excluded) under a stepped fixed injected clock, checked on
  every iteration against hand-pinned expectations (the
  `{ v: 1, entries }` envelope, exactly the 1,000 live entries
  in record order with their pinned first-seen timestamps,
  the expired entry absent), with a detached-copy mutation
  pinned to leave a re-export unchanged and an empty dedupe
  pinned to export exactly `{ v: 1, entries: [] }` once
  outside the timed loop. This separates the export cost
  from the snapshot-restore row, which measures only the
  rebuild direction. The README Benchmarks table was
  refreshed from one real run and gained the
  `SettlementEventDedupe.exportSnapshot (1,000-entry snapshot)`
  row (18,885 ops/sec in that run).
- Benchmark coverage for the subscribe `onError` error
  routing path: `subscribe()` with one pinned throwing
  listener and a collecting `onError` on a fresh escrow,
  driven through a fixed short chain (FUND,
  SUBMIT_MILESTONE, VERIFY_PASS to VERIFIED), checked on
  every iteration against hand-pinned expectations
  (every dispatch succeeds, the history holds exactly 3
  entries, and `onError` receives exactly 3 reports —
  one per dispatch — each carrying the pinned listener
  error message with its dispatch context, the first
  report's context included), with an `onError` that
  itself throws pinned to being swallowed and a
  non-function `onError` pinned to its exact
  invalid-subscribe rejection message once outside the
  timed loop. This separates the error-routing cost from
  the collecting-listener subscribe row, which never
  throws. The README Benchmarks table was refreshed
  from one real run and gained the
  `subscribe onError (short chain, 1 throwing listener)`
  row (3,474 ops/sec in that run).
- CLI demo coverage for the subscribe `onError` error
  routing path: a branch escrow subscribes one pinned
  throwing listener with a collecting `onError` and runs
  a fixed-timestamp chain (FUND, SUBMIT_MILESTONE,
  VERIFY_PASS) to VERIFIED — every dispatch succeeds and
  the audit history stays complete while `onError`
  receives one report per dispatch, the caught error
  travelling with its dispatch context (event / from /
  to); a probe escrow whose `onError` itself throws
  still dispatches successfully, and a non-function
  `onError` is rejected at subscribe time with the exact
  invalid-subscribe error. Expectations are hand-pinned
  and asserted outside the printing, so a routing that
  dropped or mislabelled a report, or a throw that broke
  a dispatch, fails the demo itself.
- CLI demo coverage for the settlement-event dedupe
  snapshot persistence path: a fresh
  `SettlementEventDedupe` on a fixed clock records two
  fixed eventIds (each new on first sight, a duplicate
  on immediate redelivery), exports them with
  `exportSnapshot()` (only the snapshot version and
  entry count are printed, never the full entries), and
  restores them through a JSON text round-trip with
  `SettlementEventDedupe.restore()` — the restored
  store starts its observability counters at zero yet
  still reports both ids as duplicates, while a
  never-seen id counts as new; a detached copy of the
  snapshot with its version rewritten to 2 is rejected
  with the exact invalid-snapshot error. Expectations
  are hand-pinned and asserted outside the printing, so
  a snapshot that dropped or re-stamped an entry, or a
  restore that reopened the dedupe window, fails the
  demo itself.
- Benchmark coverage for the quorum revoke path:
  `revoke()` on a fresh 5/9 quorum (fixed injected clock),
  checked on every iteration against hand-pinned
  expectations (approve dao-1..dao-5 to the threshold,
  revoke dao-3 to drop to 4/5 below the threshold, then
  re-approve dao-3 to return to 5/5, with
  `approvalCount()` / `hasQuorum()` / `approvals()`
  checked at every stage and the re-approved signer
  returning last in `approvals()` order), with the
  unknown-signer and not-approved revoke rejections
  (`unknown quorum signer: "mallory"` and
  `cannot revoke: signer "dao-6" has not approved`)
  pinned once outside the timed loop to their exact
  messages and to leaving the quorum unchanged. This
  separates the change-of-vote cost from the
  approve-to-threshold and snapshot-restore rows, which
  never revoke. The README Benchmarks table was
  refreshed from one real run and gained the
  `quorum revoke cycle (5 of 9, revoke + re-approve)`
  row.
- Benchmark coverage for the deadline write-cycle path:
  `setDeadline` + `clearDeadline` on one shared FUNDED
  escrow, checked on every iteration against hand-pinned
  expectations (set via a `Date` to
  2026-01-31T00:00:00.000Z and read back pinned, overwritten
  via a string to 2026-05-01T00:00:00.000Z and read back
  pinned, then cleared to `undefined` so the escrow returns
  to its initial deadline-less state for the next iteration,
  with state and history unchanged — a deadline write is
  configuration, not a dispatch), with illegal-input
  rejection (`invalid deadline: not-a-date` and
  `invalid deadline: Invalid Date`, leaving any stored value
  untouched), non-canonical normalization, and terminal
  behaviour (a RELEASED probe stores a past deadline yet
  never judges overdue) pinned once outside the timed loop.
  This separates the deadline write cost from the
  `isOverdue` judgement row, whose escrows previously only
  ever had deadlines set once in fixture construction. The
  README Benchmarks table was refreshed from one real run
  and gained the
  `setDeadline + clearDeadline (FUNDED escrow write cycle)`
  row.
- Benchmark coverage for the single-target settlement
  webhook delivery path: `deliverSettlementWebhook()` to
  one fixed endpoint through a fake global `fetch`
  answering 200 immediately (zero network, `backoffMs` 0),
  checked on every iteration against hand-pinned
  expectations (result `{ status: 200, attempts: 1 }`,
  exactly one captured call to the pinned URL, and the
  captured `X-Signature` equal to the
  `buildSettlementWebhook` signature and verifiable over
  the captured body), with a persistent-500
  retry-exhaustion check outside the timed loop pinning
  the exact `failed after 3 attempts` error at retries 2.
  This separates the single-target delivery cost from
  the 4-endpoint fan-out row that previously subsumed it.
  The README Benchmarks table was refreshed from one
  real run and gained the
  `deliverSettlementWebhook (single endpoint, fake fetch)`
  row.
- A single-target delivery segment closing the CLI demo:
  the main escrow's signed settlement webhook is delivered
  alone with `deliverSettlementWebhook()` — the
  single-endpoint entry point the fan-out segment only
  ever runs wrapped — to one fixed endpoint through a
  scripted fake `fetch` (zero network) that answers 500
  on the first attempt and 200 on the second, so the
  delivery succeeds after exactly one retry with
  `backoffMs: 0` (no real waiting); every captured request
  is asserted, outside the printing, to be a POST to the
  pinned endpoint carrying the byte-identical signed body,
  and the captured `X-Signature` verifies over the wire
  body under the demo secret, all pinned against
  hand-written expectations cross-checked against the
  webhook-delivery tests. `DemoResult` exposes the
  delivery result, the captured calls, and the
  signature-verified verdict; the demo tests pin the
  segment, the printed lines, and its closing position.
  Demo and tests only; no library behavior change.
- Benchmark coverage for the transition-table pure object
  construction path: `transitionTable()` with no arguments,
  checked on every iteration against hand-pinned
  expectations (all 14 edges written out in full in
  declaration order; every edge's keys in from / event / to
  order; spot-checked against the `transitionTableJson`
  edge set through the shared pinned first / release
  (index 10) / last edges), with an exhaustive check
  outside the timed loop comparing the full edge set to
  the parsed JSON edge set edge for edge and confirming a
  hand-pinned non-existent edge (CREATED / RELEASE /
  RELEASED) is absent from both. This separates the pure
  construction cost from the JSON row's construction-plus-
  serialization cost. The README Benchmarks table was
  refreshed from one real run and gained the
  `transitionTable (14 edges)` row.
- A quorum approval-log segment closing the CLI demo:
  `approvalLog()` on the dispute quorum prints the full
  approval audit trail in record order (each arbitrator
  with the fixed timestamp of their vote — the
  pre-restart vote kept its original timestamp through
  the snapshot round-trip), and a separate quorum with
  a fixed `maxApprovalAgeMs` window shows the expiry
  contrast on a fixed clock: past the window the oldest
  vote stops counting (approvalCount 2 → 1, quorum lost)
  while `approvalLog()` still retains the expired entry,
  all asserted outside the printing against hand-pinned
  expectations cross-checked against the approval-log
  and quorum-expiry tests. `DemoResult` exposes the
  dispute trail, the expiring quorum, and its
  before/after counts, quorum verdicts, and retained
  trail; the demo tests pin the trail, the printed
  lines, and the segment's closing position. Demo and
  tests only; no library behavior change.
- A deadline-clearing segment in the CLI demo: a
  funded escrow (DEMO-ESC-012) carrying a fixed past
  deadline reads overdue at a fixed later instant, then
  `clearDeadline()` removes the deadline so
  `getDeadline()` reads back `undefined` and the overdue
  judgement at the same instant turns false, while a
  second funded escrow (DEMO-ESC-013) that never carried
  a deadline shows the same call as a harmless no-op,
  all asserted outside the printing against hand-pinned
  expectations cross-checked against the deadline tests.
  `DemoResult` exposes both escrows and the before/after
  deadline reads and overdue verdicts; the demo tests
  pin the clearing sequence, the printed lines, and the
  segment's position. Demo and tests only; no
  library behavior change.
- A subscription segment in the CLI demo: a branch
  escrow (DEMO-ESC-011) carries one fixed collecting
  listener subscribed via `Escrow.subscribe()`, which
  receives `(event, from, to, entry)` after two fixed
  dispatches (FUND seq 1, SUBMIT_MILESTONE seq 2), in
  order and matching the audit history entry for entry;
  the listener is then unsubscribed twice (idempotent)
  and a third fixed dispatch (VERIFY_PASS) moves the
  escrow to VERIFIED while producing zero new
  notifications, all asserted outside the printing
  against hand-pinned expectations cross-checked against
  the subscribe tests. `DemoResult` exposes the branch
  escrow, the notifications, the history-match verdict,
  and the post-unsubscribe count; the demo tests pin the
  notification sequence, the printed lines, and the
  segment's closing position. Demo and tests only; no
  library behavior change.
- A standalone history-parsing path in the benchmark:
  `parseEscrowHistory()` over the JSON-serialized text of
  the fixed 4-entry RELEASED history, parsed back from the
  text and validated standalone (no Escrow instance) on
  every timed iteration, with the parsed entries checked
  entry for entry against the original history (`hash` /
  `prevHash` chain included, field-wise and through the
  canonical NDJSON serializer) — and a detached tampered
  text (the middle `SUBMIT_MILESTONE` entry's note
  rewritten and re-serialized) rejected with the exact
  hash-chain error once, outside the timed loop, the
  original text still parsing afterwards. Bench only; no
  library behavior change. The README Benchmarks table is
  refreshed from one real run.
- A snapshot round-trip path in the benchmark:
  `Escrow.fromJSON()` restoring the fixed `toJSON()` snapshot
  of the full-lifecycle escrow carrying a fixed deadline
  (2026-01-31T00:00:00.000Z), checked on every timed
  iteration for the restored id, state, and deadline and
  the full history entry for entry (`hash` / `prevHash`
  chain included), and for a re-export identical to the
  source snapshot — with the serialized snapshot text
  additionally restored unchanged after a
  JSON.parse/stringify round-trip once, outside the timed
  loop. Bench only; no library behavior change. The README
  Benchmarks table is refreshed from one real run.
- A strengthened self-check for the benchmark's hash-chain
  verification path: `verifyHistoryChain` is now checked on
  every timed iteration for the linkage its verdict rests
  on — the first entry's `prevHash` is
  `GENESIS_PREV_HASH` and every later entry's `prevHash`
  equals its predecessor's `hash` — and a detached tampered
  copy (the middle `SUBMIT_MILESTONE` entry gaining a note
  it never carried) returns `false` once, outside the timed
  loop, with the intact fixture still verifying afterwards.
  Bench only; no library behavior change. The README
  Benchmarks table is refreshed from one real run.
- A strengthened self-check for the benchmark's
  event-sourced replay path: `Escrow.fromHistory` is now
  checked on every timed iteration for rebuild fidelity —
  the rebuilt escrow's id and state and every history
  entry field for field (`hash` / `prevHash` included),
  compared field-wise and through the canonical NDJSON
  serializer — and a detached tampered copy (the FUND
  entry's amount altered from 10630 to 10631) is rejected
  with the hash-chain error once, outside the timed loop,
  with the intact fixture still rebuilding afterwards.
  Bench only; no library behavior change. The README
  Benchmarks table is refreshed from one real run.
- A money-guard segment closing the CLI demo:
  `assertNonNegativeMoney()` — the boundary check every
  amount entry point shares — is run over a fixed legal
  corpus (0, 0.01, the golden deposit 10630,
  1000000.25), which passes without throwing, and over
  a fixed illegal pair (-1 and NaN), each rejected with
  the exact `amount must be a finite non-negative
  number` error, both sides asserted outside the
  printing against hand-pinned expectations
  cross-checked against the input-validation tests and
  the bench money-guard fixture. `DemoResult` exposes
  the legal corpus and the rejections; the demo tests
  pin the corpora, the exact error message, the printed
  lines, and the segment's closing position. Demo and
  tests only; no library behavior change.
- A machine-readable transition-table segment closing
  the CLI demo: `transitionTableJson()` serializes the
  transition table as canonical JSON — 1,160 bytes, 14
  edges, byte-identical to the committed transition-table
  snapshot — and the parsed-back edges are asserted
  outside the printing to match `transitionTable()` edge
  for edge (every `from` / `event` / `to` triple, pinned
  key order, first edge CREATED --FUND--> FUNDED, last
  edge DISPUTED --ARBITRATE_REFUND--> REFUNDED),
  cross-checked against the transition-snapshot and
  diagram tests. `DemoResult` exposes the JSON text, its
  byte count, and the parsed edges with their count; the
  demo tests pin the byte count, the edge set, the
  printed lines, and the segment's closing position.
  Demo and tests only; no library behavior change.
- A snapshot round-trip segment closing the CLI demo:
  the main escrow (still carrying the fixed advisory
  deadline from the rebuild segment) is exported with
  `toJSON()` — snapshot v 1, id + RELEASED state + the 4
  history entries + deadline, serialized to 1,344 bytes —
  and restored with `Escrow.fromJSON()` from the parsed
  serialization: the restored escrow lands in RELEASED
  with the same 4 history entries verbatim and its
  deadline IS restored, the envelope contrast with the
  bare-history rebuild, all asserted outside the printing
  against hand-pinned expectations cross-checked against
  the serialization and deadline round-trip tests.
  `DemoResult` exposes the snapshot, its serialized byte
  count, and the restored escrow with its deadline; the
  demo tests pin the snapshot shape, the exact byte count,
  the restored state/history/deadline, the printed lines,
  and the segment's closing position. Demo and tests
  only; no library behavior change.
- An event-sourced rebuild segment in the CLI demo:
  a fixed advisory deadline is attached to the main escrow
  and the escrow is then rebuilt from its history alone with
  `Escrow.fromHistory()` — the rebuilt escrow lands in
  RELEASED with the same 4 history entries verbatim, while
  its deadline is not restored (`undefined`), because a bare
  history carries no deadline (nor the consumed
  idempotency keys), all asserted outside the printing
  against hand-pinned expectations cross-checked against
  the `fromHistory` honest-limits tests. `DemoResult`
  exposes the rebuilt escrow and its (absent) deadline; the
  demo tests pin the rebuilt state and history, the exact
  deadline trade-off, the printed lines, and the segment's
  closing position. Demo and tests only; no library
  behavior change.
- A standalone history-parsing segment in the CLI demo:
  the main escrow's history is serialized to JSON and parsed
  back on its own with `parseEscrowHistory()` (no `Escrow`
  instance involved) — 4 entries identical to the original
  history verbatim, the final entry landing in RELEASED —
  and a detached copy whose middle entry (seq 2,
  SUBMIT_MILESTONE) carries a rewritten note is rejected with
  the exact hash-chain-broken error, while the escrow's own
  history stays untouched and still parses, all asserted
  outside the printing against hand-pinned expectations
  cross-checked against the history-parser fuzz tests.
  `DemoResult` exposes the parsed entries and the tamper
  error; the demo tests pin the entries, the exact error, the
  printed lines, and the segment's closing position. Demo and
  tests only; no library behavior change.
- Benchmark coverage for the dispatch subscription
  notification path: `subscribe()` with one fixed collecting
  listener on a fresh escrow driven through the full
  CREATED → RELEASED lifecycle (4 dispatches + 4 notifications
  per pass), checked on every iteration against hand-written
  (event, from, to) expectations and the escrow's own history,
  entry for entry; unsubscribe (idempotent — a further dispatch
  notifies nobody) and throwing-listener isolation (the dispatch
  still succeeds and its peer still runs) are pinned once,
  outside the timed loop. Bench only; no library behavior
  change.
- A settlement webhook fan-out delivery segment in the CLI
  demo (after the batch webhooks section):
  `deliverSettlementWebhookToMany` delivers the main escrow's
  settlement report as one logical event (shared fixed
  `eventId` / `at`) to three fixed endpoints through an
  injected deterministic fake `fetch` installed on
  `globalThis` for the segment only (zero network, the
  original restored afterwards), each endpoint with its own
  demo-only secret — 3 delivered / 0 failed, one attempt at
  status 200 per endpoint, byte-identical captured bodies,
  and each signature verifiable only under its own endpoint's
  secret, all asserted outside the printing against
  hand-pinned expectations cross-checked against the fan-out
  tests and the bench fixture. Because delivery is
  asynchronous, `runDemo` is now async (its tests await it).
  `DemoResult` exposes the aggregate result and the captured
  calls; the demo tests pin the aggregate, the shared body,
  the per-endpoint signatures, the exact printed lines, and
  the segment's position. Demo and tests only; no library
  behavior change.
- A state-diagram generation segment closing the CLI demo:
  `stateDiagram()` renders the transition table as the
  Mermaid stateDiagram-v2 block the README embeds verbatim
  (21 lines, 14 edge lines), printed as a summary — line
  total, edge count, and the first, second, initial,
  first-edge, last-edge, terminal, and last lines — and
  asserted outside the printing that the edge count equals
  `transitionTable()`'s edge count against hand-pinned
  expectations cross-checked against the diagram tests and
  the bench fixture. `DemoResult` exposes the full diagram
  text and its edge count; the demo tests pin the generated
  block line by line against a hand-written diagram, the
  exact printed lines, the segment's closing position, and
  its determinism across two runs. Demo and tests only; no
  library behavior change.
- Benchmark coverage for the README diagram sync check
  path: `readmeDiagramInSync()` with no arguments (imported
  directly from `src/diagram.ts`), checked on every iteration
  against the hand-pinned expectation `true` — the same
  expectation the diagram tests and the diagram CLI
  `--check` pin; file reading is limited to this repo's
  README. To make that import side-effect free, the diagram
  CLI entry now runs only when the file is executed directly
  (the same guard `src/demo.ts` uses); the CLI's print /
  `--check` / `--write` behavior is unchanged. The README
  Benchmarks table was refreshed from one real run and
  gained the `readmeDiagramInSync (README sync check)` row.
- An overdue-judgement segment closing the CLI demo: a funded
  escrow with a fixed deadline is judged by `isOverdue` at
  three fixed instants — before the deadline (false), exactly
  at the deadline (true: the `>=` boundary counts as overdue),
  and after it (true) — asserted outside the printing against
  hand-pinned expectations cross-checked against the deadline
  tests' boundary case, with the escrow shown unchanged
  (still FUNDED) because the judgement is advisory only.
  `DemoResult` exposes the escrow and the three verdicts; the
  demo tests pin them against hand-pinned expectations
  cross-checked by independent calls, the exact printed
  lines, and the segment's determinism across two runs. Demo
  and tests only; no library behavior change.
- An audit-history NDJSON round-trip segment closing the CLI
  demo: the main escrow's history is exported with
  `historyToNdjson` (4 lines, one JSON entry per line in seq
  order) and read back with `historyFromNdjson`, asserted
  outside the printing to match the original history verbatim
  (entry count, continuous seq chain, final entry landing in
  RELEASED, re-export byte-identical). `DemoResult` exposes
  the NDJSON text, its line count and first line, and the
  round-tripped entries; the demo tests pin them against
  hand-pinned expectations cross-checked by independent calls,
  the exact printed lines, and the segment's determinism
  across two runs. Demo and tests only; no library behavior
  change.
- A settlement-split segment closing the CLI demo:
  `settleRelease` splits the main escrow's golden deposit in
  isolation (gross 10630 at 500 bps → proFee 531.5,
  referralCredits 0, net 10098.5), prints a conservation line
  whose parts sum back to the gross exactly, and cross-checks
  the split against the settlement report's party nets.
  `DemoResult` exposes the split as `releaseSettlement`; the
  demo tests pin it against hand-pinned expectations
  cross-checked by independent calls, the exact printed lines,
  and the segment's determinism across two runs. Demo and tests
  only; no library behavior change.
- Benchmark coverage for the state-diagram generation
  path: `stateDiagram()` with no arguments, checked on every
  iteration against hand-pinned expectations (21 lines in
  total; all 14 edge lines written out in full in declaration
  order; the start line pinning CREATED; the 3 terminal lines
  RELEASED / REFUNDED / EXPIRED; all 8 declared states present
  as an edge source or target). The README Benchmarks table
  was refreshed from one real run and gained the
  `stateDiagram (14 edges, 21 lines)` row.
- A deposit-provenance segment closing the CLI demo:
  `depositAmountFromHistory` traces the locked deposit back out
  of the main escrow's audit history alone (10630, the sum of
  every FUND amount, matching the settlement report's deposit),
  and a fixed copy of that history with every FUND entry removed
  is shown failing with the explicit
  `settlement requires a FUND amount` error on one FAILED line.
  `DemoResult` exposes the traced amount and the captured error;
  the demo tests pin them against hand-pinned expectations
  cross-checked by independent calls, the exact printed lines,
  and the segment's determinism across two runs. Demo and tests
  only; no library behavior change.
- Benchmark coverage for the transition-table JSON export
  path: `transitionTableJson()` with no arguments, parsed back
  on every iteration and checked against hand-pinned
  expectations (14 edges; first edge CREATED / FUND / FUNDED;
  the release edge VERIFIED / RELEASE / RELEASED at index 10;
  last edge DISPUTED / ARBITRATE_REFUND / REFUNDED; every
  edge's keys in from / event / to order; a single trailing
  newline). The README Benchmarks table was refreshed from
  one real run and gained the `transitionTableJson (14 edges)`
  row.
- Benchmark coverage for the money-guard path:
  `assertNonNegativeMoney(name, value)` over a fixed legal
  corpus (0, 0.01, the golden 10,630, and 1,000,000.25), with
  the whole corpus checked to pass without throwing on every
  iteration. Only the legal branch is timed; the illegal branch
  (a negative, NaN, ±Infinity, a numeric string, undefined, and
  null — each throwing the exact `amount must be a finite
  non-negative number` message) is asserted once, outside the
  timed loop. The README Benchmarks table was refreshed from
  one real run and gained the `assertNonNegativeMoney (legal
  corpus)` row.
- A Retry-After parsing segment in the CLI demo, between the
  receiver-dedupe segment and the dispute branch: a fixed
  7-value corpus (`"2"`, `" 30 "`, a future HTTP-date, a past
  HTTP-date, `"-5"`, `"banana"`, and null) is parsed with
  `parseRetryAfter` against one injected fixed now (the
  webhook's `at`) and printed value by value — delay-seconds
  and HTTP-date hints normalize to milliseconds (2000 /
  30000 / 5000), a past date yields 0, and the signed, garbage,
  and absent values yield `undefined`. A closing line ties the
  parsed hint back to the delivery retry context: on a 429 the
  hint, clamped by `maxRetryDelayMs`, sets the wait before the
  next attempt, and `undefined` falls back to exponential
  backoff. `DemoResult` exposes the structured
  `retryAfterParsed` results; the demo tests pin them against
  hand-pinned expectations cross-checked by re-parsing, the
  exact printed lines, and the segment's determinism across
  two runs. Demo and tests only; no library behavior change.
- Benchmark coverage for the single-escrow deadline judgement
  path: `isOverdue(escrow, now)` over a fixed 4-case corpus
  (past-deadline FUNDED, future-deadline FUNDED, deadline-less
  FUNDED, and past-deadline terminal RELEASED escrows) against
  one injected fixed `now`, with every result checked against
  hand-pinned booleans (true / false / false / false) on every
  iteration. The README Benchmarks table was refreshed from
  one real run and gained the `isOverdue (4-case corpus)` row.
- An allowed-events listing segment closing the CLI demo:
  `allowedEvents(state)` is run over all 8 states in
  transition-table order and printed as one line per state — the
  query an escrow-list UI or a watchdog consults to decide what an
  escrow can do next. The three terminal states (RELEASED /
  REFUNDED / EXPIRED) return the empty list, and the main escrow's
  own RELEASED state is called out on its own line as that same
  empty set. The query is pure — no escrow instance, no dispatch,
  no mutation — so the segment adds no network, no randomness, and
  no wall clock. `DemoResult` exposes the per-state listing plus
  the main escrow's (empty) allowed set; the demo tests pin the
  structured results against hand-pinned expectations
  cross-checked against the transition table, the exact printed
  lines, and the segment's determinism across two runs. Demo and
  tests only; no library behavior change.
- Benchmark coverage for the arbitration dispatch path:
  `dispatchArbitration(escrow, quorum, "refund")` over a
  DISPUTED escrow rebuilt from its fixed 2-entry history prefix
  via `Escrow.fromHistory` and a threshold-reached 5/9 quorum
  rebuilt via `createQuorum` on every timed iteration (the
  dispatch mutates the escrow, so the rebuild cost is inside
  the timed region and the number is a conservative lower
  bound), pinned to a fixed audit timestamp, with the REFUNDED
  terminal state, exactly one appended `ARBITRATE_REFUND`
  entry, and its `quorum 5/5` note checked on every iteration.
  The README Benchmarks table was refreshed from one real run
  and gained the `dispatchArbitration (refund, rebuilt
  fixture)` row.
- CLI demo coverage for the deadline watchdog: after the
  stale-watchdog screening, the demo closes with three more
  escrows screened by `expiredEscrows` on the same fixed `now`
  and executed through `expireOverdueEscrows` — the past-deadline
  `VERIFIED` escrow (no `EXPIRE` edge) lands as a per-item error
  without blocking the past-deadline `FUNDED` escrow after it,
  which expires, and the stale-only escrow (deadline still ahead)
  is never attempted, so the deadline and stale axes pick
  disjoint subsets of this batch too. The demo documents one
  honest caveat in its source: the executor dispatches `EXPIRE`
  without a pinned `at`, so its audit entries carry the
  dispatch-time wall clock and the demo prints no timestamp for
  them. `DemoResult` exposes the deadline batch, both pre-action
  selections, and the per-escrow executor results; the demo tests
  pin the selections, the per-item outcomes, and the printed
  section.
- Benchmark coverage for the fee-calculation path:
  `calculateDeposit(inputs)` over a fixed 3-shape corpus (the
  golden vector, a complexity-1.5 case, and a large-pool case),
  with each returned `adjustedBaseFee` / `deposit` checked
  against hand-computed expectations on every timed iteration.
  The README Benchmarks table was refreshed from one real run
  and gained the `calculateDeposit (3-shape corpus)` row.
- CLI demo coverage for the stale-watchdog screening: the demo
  closes with three further escrows screened on one fixed `now`
  under both watchdog axes — `staleEscrows` (dwell in the current
  state against 7-day per-state budgets) selects the escrow funded
  17 days earlier whose deadline is still ahead, while
  `expiredEscrows` (absolute deadline) selects the escrow whose
  milestone was submitted 1 day earlier but whose deadline has
  passed, and a third fresh escrow is in neither subset — then
  `actOnStaleEscrows` expires the stale escrow with the EXPIRE
  dispatch pinned to the same fixed `now` (actor `watchdog`), so
  no wall clock enters the audit history. `DemoResult` exposes
  the watchdog batch, both pre-action selections, and the
  per-escrow action results; the demo tests pin the disjoint
  subsets, the hand-computed dwell days, the printed lines and
  their closing position, and the EXPIRE entry's fixed timestamp.
- Benchmark coverage for the allowed-events lookup path:
  `allowedEvents(state)` over all 8 states of the transition
  table (one pass queries every state once, in declaration
  order), with each result checked against its hand-pinned
  expected event list (declaration order within each row; the
  three terminal states — RELEASED, REFUNDED, EXPIRED — expect
  the empty list) on every timed iteration. The README
  Benchmarks table was refreshed from one real run and gained
  the `allowedEvents (all 8 states)` row.
- CLI demo coverage for the audit hash chain: after the main
  escrow's settlement report, the demo runs `verifyHistoryChain`
  on its history — the intact, genesis-linked chain passes
  (`true`) — then verifies a detached copy whose FUND entry's
  amount is altered by 1 (10,630 → 10,631), which fails (`false`:
  the stored hash no longer recomputes from the altered content),
  and re-verifies the escrow's own untouched history. `DemoResult`
  exposes the two verdicts and the tampered amount; the demo tests
  pin them with an independent hand-built tamper cross-check and
  the printed lines and their position.
- Benchmark coverage for the settlement report rendering path:
  `renderReport(report)` over the fixed golden released report
  (escrow BENCH-001, deposit 10,630, released via
  VERIFY_PASS → RELEASE, 4 party rows), built once outside the
  timed loop. Every timed iteration re-renders the report and
  re-checks the text against hand-written expected lines — the
  header / outcome line, the deposit formula line, and the
  creator net row (inflow $10,098.50, outflow $0.00, net
  $10,098.50 in the fixed-width ledger columns). The README
  Benchmarks table was refreshed from one real run and gained
  the `renderReport (released report, 4 parties)` row
  (commit 5d15360, 2026-10-15).
- Benchmark coverage for the funded-total summation path:
  `depositAmountFromHistory(history, escrowId)` over a fixed
  4-shape corpus (a single FUND of the golden 10,630, a two-FUND
  top-up sequence summing to 12,630, a FUND recorded without an
  amount, and an empty no-FUND history), built once outside the
  timed loop from real escrows on the fixed bench clock.
  Hand-pinned expectations: the two totals are the sums of every
  FUND entry's amount (top-ups included), and both fail-fast
  shapes throw their exact `settlement requires a FUND amount`
  messages. Every timed iteration re-checks each total and each
  error message against those expectations. The README Benchmarks
  table was refreshed from one real run and gained the
  `depositAmountFromHistory (4-shape corpus)` row.
- CLI demo coverage for quorum snapshot restore: in the dispute
  branch, after the first arbitrator approval the demo snapshots
  the 2-of-3 quorum, round-trips the snapshot through JSON, and
  restores it with `restoreQuorum` under the same config object
  (shared injected clock, so approval timestamps stay on the fixed
  sequence across the restore) — printing the restored approval
  count / `hasQuorum` matching the pre-snapshot state — then runs
  the below-threshold refusal, the second approval, and the refund
  arbitration on the restored quorum. `DemoResult` exposes the
  snapshot and the restored counting state; the demo tests pin the
  snapshot shape, an independent re-restore that continues to
  threshold, and the printed lines and their position.
- Benchmark coverage for the `Retry-After` parsing path:
  `parseRetryAfter(value, nowMs)` over a fixed 11-value corpus
  (delay-seconds, a fractional value, a whitespace-padded value,
  zero, a future HTTP-date, a past HTTP-date, signed numbers, a
  garbage string, and null / undefined) against one injected fixed
  instant, built once outside the timed loop. Hand-pinned
  expectations: delay-seconds parse to seconds × 1000, a past
  HTTP-date clamps to 0, and signed / garbage / absent values parse
  to `undefined` (the caller's exponential-backoff fallback). Every
  timed iteration re-checks each parsed result against those
  expectations. The README Benchmarks table was refreshed from one
  real run and gained the `parseRetryAfter (11-value corpus)` row.
- CLI demo coverage for receiver-side webhook deduplication: after
  the signed settlement webhook is built and verified, the demo runs
  its `eventId` through `SettlementEventDedupe` on a fixed clock
  (explicit 1-hour TTL, starting at the webhook's `at`) — the first
  delivery is new and booked, an immediate redelivery is a duplicate
  and skipped (no second booking), and after the clock advances by
  exactly the TTL the same id counts as new again, closing with the
  dedupe stats (size 1, hits 1, misses 2, evictions 0). `DemoResult`
  exposes the dedupe store; the demo tests pin the stats and the
  printed delivery lines and their position between the webhook and
  dispute sections.
- CLI demo coverage for the batch settlement webhook pipeline:
  the demo's closing batch section now feeds its
  `buildSettlementReports` results straight into
  `buildSettlementWebhooks` (shared demo secret, one shared fixed
  batch timestamp `2026-03-08T09:00:00.000Z`), printing one signed
  webhook per successful report — the released and refunded
  webhooks carry the deterministic factory `eventId`s
  `evt_demo_batch_001` / `evt_demo_batch_002` (one fresh id per
  report, never reused, so a receiver deduplicating on `eventId`
  keeps both) and a receiver-side `verifySettlementWebhook: ok`
  verdict per built webhook — while the still-`FUNDED` entry is
  forwarded as `{escrowId, error}` in the middle of the batch
  without blocking the refunded webhook after it (and consumes no
  factory id). `DemoResult` exposes the batch webhooks and the
  all-verified flag; the demo tests pin the per-item shapes, the
  forwarded error, the distinct ids, and the printed section.
- Benchmark coverage for the settlement event dedupe
  snapshot-restore path: `SettlementEventDedupe.restore`
  rebuilding a receiver-side dedupe from a persisted (JSON
  round-tripped) snapshot of 1,000 fixed ids
  (`bench-restore-0000`..`bench-restore-0999`, all first seen at
  the restore instant on a fixed clock), restored under the
  default TTL and capacity, built once outside the timed loop.
  Hand-written expectations: 1,000 live entries with the
  observability counters restarting at zero. The exhaustive
  check runs once outside the timed loop (all 1,000 ids judged
  duplicates, an unseen id keeping first-sighting semantics);
  every timed iteration re-checks the counters and spot-checks
  the first / middle / last ids. The README Benchmarks table
  was refreshed from one real run (taken under parallel
  shared-host load, as the README environment note records) and
  gained the row.
- CLI demo coverage for the batch settlement pipeline: the demo
  now closes by running `buildSettlementReports` over its three
  fixed escrows in released -> still-`FUNDED` -> refunded order,
  printing each per-item result (the `FUNDED` escrow lands as
  `{escrowId, error}` in the middle of the batch and does not
  block the refunded report after it), then
  `summarizeSettlementReports` prints the reconciliation summary
  (2 reports, 1 error; deposit / inflow / outflow totals of
  21,260 over the two golden 10,630 deposits; per-party nets
  sponsor -10,630, creator 10,098.50, platform 531.50, referrer
  0). `DemoResult` exposes the pending escrow, the batch
  results, and the summary; the demo tests pin the batch shapes,
  the exact error message, and the hand-computed summary totals.
- Benchmark coverage for the watchdog execution paths:
  `expireOverdueEscrows` and `actOnStaleEscrows` (with the
  production action `(e) => e.dispatch("EXPIRE")`) over the
  bench's fixed mixed batch of 100 escrows — the execution layer
  behind the existing screening rows, rebuilt fresh on every
  iteration because the executors mutate their inputs (the
  rebuild cost is inside the timed region). Every timed
  iteration self-checks result ids in batch order, success
  flags, post-states, and the appended EXPIRE audit entries
  against hand-counted expectations (40 of 40 expire attempts
  and 70 of 70 stale actions succeed — FUNDED and
  MILESTONE_SUBMITTED both carry an EXPIRE edge), never derived
  by calling the executors. The README Benchmarks table was
  refreshed from one real run (taken under heavy shared-host
  load, as the README environment note records) and gained
  the two rows.
- Benchmark coverage for the release settlement netting path:
  `settleRelease` over 4 fixed representative inputs (the golden
  10,630 at 500 bps, 1,000 at 500 bps with 100 referral credits, a
  large gross of 1,000,000 at 250 bps with 1,250.25 credits, and a
  10-at-125-bps half-cent rounding edge), built once outside the
  timed loop. Every timed iteration self-checks each result's
  proFee / net against hand-computed expectations (531.50 /
  10,098.50; 50 / 850; 25,000 / 973,749.75; 0.13 / 9.87), never
  re-derived through the implementation under test. The README
  Benchmarks table was refreshed from one real run (taken under
  parallel shared-host load, as the README environment note
  records) and gained the row.
- Benchmark coverage for the quorum snapshot-restore path:
  `restoreQuorum` rebuilding a live quorum from a persisted
  (JSON round-tripped) snapshot of the bench's fixed 9-signer /
  threshold-5 quorum carrying 7 recorded approvals (dao-1..dao-7,
  one second apart on a stepped fixed clock), built once outside
  the timed loop. Every timed iteration self-checks the restored
  quorum against hand-written expectations (quorum reached, 7
  counted approvals in record order, 7 audit-log entries), and a
  pre-check outside timing verifies that re-snapshotting the
  restored quorum reproduces the persisted snapshot byte-for-byte.
  The README Benchmarks table was refreshed from one real run
  (taken under heavy shared-host load, as the README environment
  note records) and gained the row.
- Benchmark coverage for the settlement batch webhook path:
  `buildSettlementWebhooks` over the bench's fixed batch of 4
  pre-built results (released / refunded / released reports plus one
  per-item error), timed after the batch reports are built outside
  the loop, with a shared fixed `now` and a deterministic counter
  `eventIdFactory`. Every timed iteration self-checks the result
  shape against hand-derived expectations (3 signed webhooks with
  distinct eventIds `bench-batch-event-1..3` in input order, each
  re-verified with `verifySettlementWebhook`; the error entry
  forwarded byte-identical with no webhook and no eventId consumed).
  The README Benchmarks table was refreshed from one real run and
  gained the row.
- Benchmark coverage for the settlement batch summary path:
  `summarizeSettlementReports` aggregating the bench's fixed batch
  of 4 pre-built results (released / refunded / released reports
  plus one per-item error) into outcome counts, deposit / inflow /
  outflow totals, and per-party nets, self-checked on every timed
  iteration against hand-derived expectations (3 reports + 1 error,
  total deposit 31,890, sponsor net −21,260, creator net 20,197,
  platform net 1,063). The README Benchmarks table was refreshed
  from one real run and gained the row.
- The CLI demo now walks a second escrow through the dispute branch:
  `VERIFY_FAIL` into `DISPUTED`, a 2-of-3 arbitrator quorum (demo scale
  of the FAQ's 5/9 DAO multi-sig, same M-of-N rule) collected vote by
  vote on a fixed injected clock — a below-threshold
  `dispatchArbitration` attempt is refused (`arbitration requires
  quorum: 1/2 approvals`) with the escrow's state and history
  untouched, then the reached quorum dispatches `ARBITRATE_REFUND` to
  `REFUNDED` and the branch closes with the refund settlement report
  (full deposit back to the sponsor, balanced). `runDemo()` returns
  the dispute escrow, its report, the quorum, and the refusal message;
  the demo tests pin the branch chain, quorum log, and refund figures.
  To keep that branch deterministic, `dispatchArbitration` gained an
  optional final `ArbitrationDispatchOptions` argument forwarding an
  injectable audit timestamp / actor to the arbitration entry.
- The CLI demo includes a settlement webhook step: after the
  settlement report it builds the signed `escrow.settled` webhook
  from the report via `buildSettlementWebhook` (fixed `eventId`/`at`
  and a demo-only secret printed in `src/demo.ts`, not a real
  credential), prints the payload fields and `sha256=` signature,
  and self-verifies with `verifySettlementWebhook` over the raw body
  bytes. `runDemo()` returns the webhook and its verification result;
  the demo tests pin the payload field set/values against the
  webhooks fixture shape and assert a tampered deposit fails
  verification.
- Benchmark coverage for the event-sourced replay path:
  `Escrow.fromHistory` rebuilding a live escrow from the bench's
  detached 4-entry chained history fixture (full validation and
  hash-chain re-verification per call), self-checked outside the
  timed loop — the rebuild reproduces the original escrow's state
  and history exactly, and a rebuild from the fixture's 3-entry
  VERIFIED prefix accepts the fixture's own RELEASE step with no
  seq gap, landing entry-for-entry identical to the full fixture.
  The README Benchmarks table was refreshed from one real run and
  gained the row.
- Benchmark coverage for two payments hot paths: settlement webhook
  fan-out delivery (`deliverSettlementWebhookToMany` to 4 endpoints
  through a fake global `fetch`, zero network, with per-endpoint
  signature verification as a self-check) and receiver-side event
  dedupe (`SettlementEventDedupe.checkAndRecord` duplicate hits over
  1,000 pre-recorded `eventId`s under a fixed injected clock, with
  stats counters cross-checked against the calls made). The README
  Benchmarks table was refreshed from one real run and gained both
  rows.
- Quorum snapshot export/restore: `quorum.snapshot()` exports the full
  approval audit trail plus the configuration it was collected under
  as plain JSON, and `restoreQuorum(config, snapshot)` rebuilds the
  quorum after a restart under strict validation (unknown signer,
  exact duplicate entry, bad timestamp, or any threshold/signer/expiry
  mismatch with the supplied config is rejected). Expiry keeps aging
  from the original timestamps — restoring never refreshes an approval.
- `buildSettlementReports(inputsList)` batch settlement reporting: the
  same per-escrow inputs as `buildSettlementReport`, returning one
  `{ escrowId, report }` or `{ escrowId, error }` result per input in
  input order, so one non-terminal or corrupted escrow never aborts the
  whole batch. Pure — no escrow state or history is mutated.
- `transitionTableJson()` exports the transition table as canonical JSON
  (declaration order, pinned `{ from, event, to }` key order), with the
  committed snapshot `test/__snapshots__/transitionTable.snapshot.json`
  cross-checked against `transition()` / `allowedEvents()`.
- `SECURITY.md` now has a "Reporting a security issue" section matching
  the other demo repositories: open an issue, never include secrets or
  credentials, with webhook-signing, audit-hash-chain, and
  money-conservation reports especially welcome.
- `dispatchArbitration` now forwards the full retry-safety surface:
  `ArbitrationDispatchOptions` widens from `Pick<DispatchOptions,
  "at" | "actor">` to include `idempotencyKey` and `expectedSeq`, both
  passed straight through to `Escrow.dispatch`. A timed-out caller can
  now retry the funds-terminal arbitration call with the same
  `idempotencyKey` and get a pure no-op instead of
  `invalid transition: ARBITRATE_RELEASE from RELEASED`. The key is
  consumed only by a *successful* dispatch — the quorum gate throws
  before the escrow is touched, so gathering the missing approvals and
  retrying with the same key works. `expectedSeq` is checked first
  inside dispatch (before the dedupe), so a stale seq is a loud
  `dispatch conflict`, never a silent no-op. README FAQ multi-sig
  options section and JSDoc updated with the guard ordering.
  `test/arbitrationDispatchOptions.test.ts` (12 cases). README test
  count updated to the true 769.

### Fixed

- `calculateDeposit` now rejects non-finite deposit computations (backlog
  #545): finite-but-huge inputs (e.g. `complexityMultiplier: 1e308`, which
  passes the per-field finiteness guard) could overflow the intermediate
  arithmetic to `Infinity`, and `round2(Infinity)` stays `Infinity` — the
  old code only checked `deposit < 0` and returned
  `{ deposit: Infinity }`, which would poison every downstream money sum
  (settlement ledgers, webhook payloads). The new `!Number.isFinite(deposit)`
  check fails fast with the explicit error
  `deposit computation overflowed: inputs too large` (pure function, no
  partial breakdown escapes). The negative-deposit guard keeps its own
  error, so the two failure modes stay distinct. README "How precise is
  the money math?" documents the rejection; eight new tests cover the
  overflow via multiplier/creatorPool/baseFee, the exact error message,
  large-but-finite deposits (1e15, 1e306) still accepted, and the golden
  10630 vector unchanged. README test count updated to the true 729.

- De-flaked the history parser fuzz timing guard: the per-call 50ms
  wall-clock assertion in `historyParserFuzz` shared the load-sensitive
  construction that failed for real in the sibling repos (a 101.6ms
  scheduler pause on sub-millisecond work in dataquest). The guard now
  asserts the corpus median against the same 50ms budget, plus a
  1000ms catastrophic worst-case bound, so a systematic per-call
  slowdown still fails while a single pause does not. Tests only; no
  behavior change.

- FUND amounts are normalized to cents at dispatch (backlog #542):
  `dispatch("FUND", …, amount)` now applies the library's `round2` after
  `assertNonNegativeMoney` and before the deposit-cap check, so the recorded
  audit entry, the cap comparison, and downstream settlement math all see
  the same cent value — the README "all amounts are rounded to cents" claim
  is now true at the dispatch boundary. Parsers (`fromJSON`/`fromHistory`/
  NDJSON) still accept legacy sub-cent snapshots without re-normalizing
  them.

## [0.1.0]

The only version declared in `package.json`. Entries cover the commit
history from the initial commit (2026-10-02) through 2026-10-11.

### Added

- Deterministic escrow state machine and campaign fee calculator
  (ALLWEB3 reproduction): typed states, events, transition table, and
  the golden deposit vector (2026-10-02, `c0b89ab`).
- Settlement report built from the append-only audit history, with
  per-party inflow/outflow/net accounting and a conservation check
  (2026-10-03, `8e0b1dc`).
- Dispatch-boundary `FUND` amount validation (finite, non-negative),
  and escrow top-ups via the `FUND` self-loop from `FUNDED`
  (2026-10-05, `567f35d`; 2026-10-06, `528d85e`).
- JSON snapshot persistence (`toJSON` / `fromJSON`) with strict
  validation, a snapshot schema version (`v: 1`) with legacy
  pass-through, and `Escrow.fromJSON` accepting `EscrowOptions` so a
  restored escrow keeps its guardrails (2026-10-05, `5a8d51a`;
  2026-10-08, `6b4bd2f`; 2026-10-09, `58badf6`).
- M-of-N arbitration quorum: approval counting, approval revocation
  before the threshold is reached, `dispatchArbitration` wiring quorum
  to the arbitration dispatch, quorum approval audit timestamps
  (`approvalLog`), and an optional `maxApprovalAgeMs` expiry window
  for approvals (2026-10-05, `3b2409c`; 2026-10-06, `cf2011c`,
  `0209fdc`; 2026-10-07, `d1d84c4`; 2026-10-10, `79ba27d`).
- Settlement webhooks: signed settlement notification payload,
  delivery with retries and backoff, retry on HTTP 429 honoring
  `Retry-After`, multi-secret rotation on verification, a unique
  `eventId` delivery ID on the payload, an opt-in `maxAgeMs`
  freshness check and a `maxFutureSkewMs` future-timestamp bound on
  verification, a `releasePath` field on the payload, multi-endpoint
  fan-out delivery, external `AbortSignal` support, and the
  `SettlementEventDedupe` receiver-side `eventId` deduplication
  helper with snapshot export/restore (2026-10-06, `45d0649`,
  `784fe38`; 2026-10-07, `e982569`, `74d924c`; 2026-10-08, `058f396`,
  `d23330a`, `86badce`; 2026-10-09, `4599fdf`; 2026-10-10, `eacf048`,
  `46377ab`, `fa668ab`, `7158ae8`).
- Dispatch idempotency keys for retry safety, persisted in snapshots
  so a restored escrow still rejects an already-consumed key
  (2026-10-06, `d6a9bc3`; 2026-10-09, `ffe879f`).
- Deadlines and watchdogs: escrow deadlines with `expiredEscrows`
  screening, the `expireOverdueEscrows` batch executor, dwell-time
  `staleEscrows` screening, and the `actOnStaleEscrows` watchdog
  executor (2026-10-07, `62a2e6a`; 2026-10-08, `fd99218`;
  2026-10-09, `b79ba5f`; 2026-10-11, `b70b61e`).
- Audit-history SHA-256 hash chain for tamper evidence, with an
  optional keyed HMAC mode (2026-10-08, `29c9dee`;
  2026-10-09, `25c9bd4`).
- Deposit risk controls: `EscrowOptions.maxDeposit` deposit cap
  (2026-10-08, `7841bcd`), opt-in evidence reference on
  `VERIFY_PASS` (`requireVerifyEvidence`) (2026-10-07, `30d99a4`),
  and event-level RBAC with an actor allowlist (2026-10-09,
  `d0ccfd2`).
- Dispatch observability and concurrency: a `subscribe()` dispatch
  hook for in-process notification fan-out, an injectable audit
  timestamp via `DispatchOptions.at`, and an optimistic-concurrency
  guard via `DispatchOptions.expectedSeq` (2026-10-07, `8b13608`;
  2026-10-09, `d7383df`; 2026-10-10, `9a9da80`).
- NDJSON audit-log export/import (2026-10-09, `9dceccd`).
- Mermaid state diagram generated from the transition table
  (`npm run diagram`) (2026-10-10, `19a09bf`), a benchmark script
  (`npm run bench`) for the dispatch, chain, report, and webhook
  paths (2026-10-10, `f5d3ea8`), and a deterministic CLI demo
  (`npm run demo`) (2026-10-10, `95612b3`).

### Fixed

- Fail fast when the `FUND` amount is missing or mismatched on the
  settlement path, and validate the terminal event on the
  refunded/expired settlement paths (2026-10-05, `de0afcf`,
  `a592b2f`).
- Validate the `dispatch` note type and the constructor `id`, and
  return a frozen snapshot from the `history` getter so the audit
  log cannot be tampered with through it (2026-10-07, `9e0e673`,
  `6963335`).
- Compare `FUND` totals and the `maxDeposit` cap at cent precision
  (2026-10-07, `aa7d983`; 2026-10-08, `dc5fe45`).
- `buildSettlementReport` verifies the audit history hash chain
  before producing any accounting (2026-10-08, `ada0b9a`).
- Reject unknown fields in the escrow snapshot parser (fail-closed)
  (2026-10-09, `36786ac`).
- Webhook delivery never follows 3xx redirects, and the 429
  `Retry-After` wait is capped with `maxRetryDelayMs`
  (2026-10-07, `b344e38`; 2026-10-08, `881aa7d`).
- Keep the webhook backoff timer and the per-attempt timeout timer
  ref'd so an awaited delivery always settles (2026-10-10,
  `402e8b6`, `d17b5e4`).
- Point the package `main`/`types` entry points at the real
  `dist/src` entry, and add a `package.json` `exports` map for it
  (2026-10-11, `f5adfcc`, `fc92b9b`).

### Tests

- Accounting invariants: fees never negative, deposit equals the sum
  of its parts, payout never exceeds the deposit (2026-10-04,
  `77bb125`).
- Deterministic seeded random walks over legal events (seed
  20261005, 200 walks) asserting no deadlock, history integrity,
  payout at most the funded amount, and seed reproducibility
  (2026-10-04, `1ba2a40`).
- Seeded fuzz coverage for the NDJSON, history, and snapshot parsers
  (2026-10-11, `ac807f6`).
- Webhook abort tests triggered from server events instead of
  wall-clock timers, and a test that executes the README Quickstart
  code block against the built entry point (2026-10-11, `7dcca3f`,
  `0d7c9f6`).

### Documentation

- Mermaid state diagram synced with the code via `transitionTable()`
  (2026-10-03, `8ffe022`).
- An honest FAQ covering the off-chain scope, the fee formula source,
  and the gaps against a real on-chain stack (2026-10-05, `627e237`).
- `SECURITY.md` describing trust boundaries for quorum, money, and
  webhooks (2026-10-06, `0d19b31`).
- README test-count alignment with the actual `npm test` output, and
  `expiredEscrows` JSDoc pointing at the `expireOverdueEscrows`
  executor instead of a bare-loop pattern (2026-10-06, `adcf377`;
  2026-10-09, `1222d89`).

### CI and packaging

- An MIT `LICENSE` file (2026-10-10, `3264e00`).
- Publishing to GitHub Packages as the scoped
  `@toniadreal/escrow-state-machine-ts` package, with the publish
  workflow running on Node 22 (2026-10-10, `2735849`, `d1885a6`).
- A GitHub Actions workflow running the test suite on push and pull
  requests (Node 20/22) (2026-10-11, `f4d1c46`).
