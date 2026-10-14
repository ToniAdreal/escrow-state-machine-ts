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
