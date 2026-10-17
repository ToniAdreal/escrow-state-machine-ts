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

### Fixed

- De-flaked the history parser fuzz timing guard: the per-call 50ms
  wall-clock assertion in `historyParserFuzz` shared the load-sensitive
  construction that failed for real in the sibling repos (a 101.6ms
  scheduler pause on sub-millisecond work in dataquest). The guard now
  asserts the corpus median against the same 50ms budget, plus a
  1000ms catastrophic worst-case bound, so a systematic per-call
  slowdown still fails while a single pause does not. Tests only; no
  behavior change.

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
