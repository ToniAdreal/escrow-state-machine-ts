/**
 * Local micro-benchmark for the escrow-state-machine-ts state machine.
 *
 * Measures real, locally-observed throughput for the hot paths a
 * batch escrow reconciliation / watchdog deployment actually hammers:
 *
 *   1. dispatch — one full CREATED -> RELEASED lifecycle (4 dispatches,
 *      each appending a hash-chained audit entry) on a fresh escrow;
 *   2. `verifyHistoryChain(history)` — full SHA-256 hash-chain
 *      re-verification of that fixed history;
 *   3. `buildSettlementReport(...)` — settlement accounting derived
 *      from the audit history (which itself re-verifies the chain);
 *   4. settlement webhook build / verify — `buildSettlementWebhook`
 *      (HMAC-SHA256 signing) and `verifySettlementWebhook` over the
 *      signed body;
 *   5. `buildSettlementReports(...)` — the batch settlement-reporting
 *      path a reconciliation job actually runs: one call over a fixed
 *      batch of 4 inputs (released / refunded / released, each a
 *      4-entry history comparable to the single-report fixture, plus
 *      one deliberately mismatched input whose report must land as a
 *      per-item `{ escrowId, error }` without aborting the batch).
 *      This measures the per-item try/catch and order-preserving
 *      mapping overhead the single-report path never exercises;
 *   6. NDJSON export / import — `historyToNdjson` (validated export)
 *      and `historyFromNdjson` (per-line JSON parsing interleaved with
 *      a full `parseEscrowHistory` hash-chain re-verification) over a
 *      fixed 8-entry chained history: the same lifecycle funded in
 *      five staged FUND dispatches (initial deposit + four top-ups
 *      summing to the golden 10,630), then milestone, verification,
 *      and release. This is the line-oriented audit-log transport a
 *      batch reconciliation / forwarding pipeline streams, shaped
 *      comparably to the dataquest lifecycle's 8-entry NDJSON bench;
 *   7. quorum approval — `createQuorum` with a fixed 9-signer set and
 *      threshold 5 (the 5/9 multi-sig arbitration shape), approving
 *      one signer at a time until the threshold is reached and calling
 *      `hasQuorum()` after each vote. This is the pre-check
 *      `dispatchArbitration` runs before any arbitration dispatch, so
 *      its per-vote accumulation cost is on the arbitration hot path.
 *   8. settlement webhook fan-out delivery —
 *      `deliverSettlementWebhookToMany()` to 4 fixed endpoints, each
 *      with its own signing secret, through a fake `fetch` installed
 *      on `globalThis` (this library's delivery layer calls the
 *      global `fetch`; the fake records each call and answers 200
 *      immediately). Zero network: the numbers measure the library's
 *      fan-out overhead only — not network throughput;
 *   9. settlement event dedupe — `SettlementEventDedupe.checkAndRecord()`
 *      duplicate hits cycling over 1,000 `eventId`s pre-recorded under
 *      an injected fixed clock, so no entry can expire or be evicted
 *      during the timed loop: the measured path is the pure
 *      steady-state duplicate hit, LRU recency refresh included;
 *  10. event-sourced replay — `Escrow.fromHistory(id, history)`
 *      rebuilding a live escrow from the same detached 4-entry chained
 *      history fixture the dispatch path produces (full
 *      `parseEscrowHistory` validation + hash-chain re-verification +
 *      state derivation on every call). This is the rebuild a
 *      reconciliation holder of a bare audit log pays per escrow.
 *      The fixture ends RELEASED (terminal, no legal next event), so
 *      the continuation self-check outside the timed loop rebuilds
 *      from the fixture's 3-entry VERIFIED prefix and dispatches the
 *      fixture's own RELEASE step: the rebuilt history must then
 *      equal the full fixture entry for entry, seq 1-4 with no gap.
 *  11. settlement batch summary — `summarizeSettlementReports(results)`
 *      aggregating the batch path's fixed 4-item result list (built
 *      once, outside the timed loop) into outcome counts, deposit /
 *      inflow / outflow totals, and per-party nets: the day-end
 *      reconciliation roll-up a settlement holder runs over a whole
 *      batch after the per-item reports are built. The summarizer is
 *      pure (it only reads the results), so the same pre-built result
 *      list is re-summarized on every iteration.
 *  12. settlement batch webhook building — `buildSettlementWebhooks(
 *      results, ...)` over that same fixed 4-item result list (built
 *      once, outside the timed loop): the second half of the day-end
 *      pipeline, batch reports -> batch webhooks. The 3 successful
 *      reports are signed under the shared bench secret at the shared
 *      fixed `WEBHOOK_NOW`, each with a DISTINCT `eventId` from a
 *      deterministic counter factory (fresh per iteration, so the
 *      expected ids are hand-known: bench-batch-event-1..3, in input
 *      order); the batch's one per-item error entry is forwarded as
 *      `{ escrowId, error }` untouched and consumes no `eventId`.
 *      Every built webhook is re-verified with
 *      `verifySettlementWebhook` on every iteration.
 *  13. watchdog screening — `expiredEscrows(escrows, fixedNow)` and
 *      `staleEscrows(escrows, maxAgeByState, fixedNow)` over one fixed
 *      mixed batch of 100 escrows (composition hand-counted in the
 *      fixture comment below: 40 past-deadline non-terminal, 70 stale
 *      under the bench budgets). This is the periodic poll the README
 *      documents as the production watchdog wiring; both filters are
 *      pure, so the same batch is re-screened on every iteration and
 *      each result is checked against the hand-counted expected id
 *      list (in batch order) on every iteration.
 *  14. quorum snapshot restore — `restoreQuorum(config, snapshot)`
 *      rebuilding a live quorum from a persisted snapshot (the JSON
 *      round-tripped form of `snapshot()`), over the bench's fixed
 *      9-signer / threshold-5 quorum shape carrying 7 recorded
 *      approvals (dao-1..dao-7, one second apart on the fixed
 *      clock). This is the restart path an arbitration service runs
 *      for every undecided quorum at startup: strict snapshot
 *      validation (signer set, threshold, per-entry audit-trail
 *      re-checks) plus the rebuild, on every call. The restored
 *      quorum is checked against hand-written expectations (quorum
 *      reached, 7 counted approvals in record order, 7 audit-log
 *      entries) on every iteration.
 *  15. release settlement netting — `settleRelease(inputs)` over one
 *      fixed set of 4 representative inputs (composition and
 *      hand-computed expectations in the fixture comment below: the
 *      golden-deposit case at the case study's 5% fee, a mid-size
 *      case with referral credits, one large-gross case, and one
 *      half-cent bps rounding edge). This is the amount origin of
 *      the whole settlement chain — gross minus pro fee (bps, via
 *      round2) minus referral credits, with the negative-net guard —
 *      that every report / webhook path downstream starts from, and
 *      the one step that previously had no measured baseline. Every
 *      timed iteration checks each result's proFee / net against
 *      the hand-written expectations (never re-derived through the
 *      implementation under test).
 *  16. watchdog execution — `expireOverdueEscrows(escrows, fixedNow)`
 *      and `actOnStaleEscrows(escrows, action, budgets, fixedNow)`
 *      with the production action `(e) => e.dispatch("EXPIRE")`, over
 *      the SAME mixed batch of 100 escrows as the screening paths —
 *      but rebuilt fresh on every iteration, because the executors
 *      mutate the escrows they act on (each successful EXPIRE
 *      dispatch appends a hash-chained audit entry). The rebuild
 *      cost is therefore inside the timed region, unlike screening.
 *      Hand-counted from the fixture composition and the transition
 *      table (never derived by calling the executors):
 *      expireOverdueEscrows attempts the 40 expired ids and ALL 40
 *      succeed (FUNDED and MILESTONE_SUBMITTED both carry an EXPIRE
 *      edge), ending EXPIRED with one extra audit entry each;
 *      actOnStaleEscrows attempts the 70 stale ids and ALL 70
 *      EXPIRE actions succeed for the same reason. Every timed
 *      iteration checks result ids in batch order, the success
 *      flags, the absence of errors, the post-states, and the
 *      appended EXPIRE audit entries against those expectations.
 *      (The executors dispatch EXPIRE without an injectable audit
 *      timestamp, so the bench checks states / flags / history
 *      shape — never the appended entry's timestamp, and the
 *      selections themselves use only the injected fixed `now`.)
 *  17. settlement event dedupe snapshot restore —
 *      `SettlementEventDedupe.restore(snapshot)` rebuilding a
 *      receiver-side dedupe from a persisted snapshot (the JSON
 *      round-tripped form of `exportSnapshot()`), over a fixed
 *      1,000-entry snapshot (see the restore fixture below for its
 *      composition and the hand-written expectations). This is the
 *      restart path a settlement receiver runs at startup before
 *      the first duplicate check: strict snapshot validation plus
 *      the rebuild, on every call. The restored dedupe is checked
 *      against hand-written expectations (1,000 live entries,
 *      observability counters restarting at zero, spot-checked
 *      first / middle / last ids all duplicates) on every
 *      iteration, and exhaustively (all 1,000 ids) once outside
 *      the timed loop.
 *  18. retry-after parsing — `parseRetryAfter(value, nowMs)` over
 *      a fixed 11-value corpus (delay-seconds, a fractional
 *      delay-seconds, a whitespace-padded value, zero, a future
 *      HTTP-date, a past HTTP-date, signed numbers, a garbage
 *      string, and null / undefined), always against the same
 *      injected fixed `nowMs`. This is the parse every 429
 *      settlement-webhook response pays before the retry delay is
 *      chosen, previously visible only inside the end-to-end
 *      delivery numbers. Every timed iteration re-checks each
 *      parsed result against the hand-pinned expectations in the
 *      corpus comment below.
 *  19. funded-total summation — `depositAmountFromHistory(history,
 *      escrowId)` over a fixed 4-shape corpus (a single FUND, a
 *      two-FUND top-up sequence, a FUND recorded without an amount,
 *      and a history with no FUND at all; composition and
 *      hand-pinned totals / error messages in the fixture comment
 *      below). This is the audit-trail scan every settlement
 *      reconciliation pays per escrow to establish the locked
 *      total (top-ups included) before any report math runs,
 *      previously visible only inside the `buildSettlementReport`
 *      numbers. Every timed iteration re-checks each returned
 *      total against its hand-written expectation and each
 *      fail-fast shape against its exact hand-written error
 *      message.
 *  20. settlement report rendering — `renderReport(report)` over
 *      the fixed golden released report built once outside the
 *      timed loop (deposit 10,630, released via
 *      VERIFY_PASS -> RELEASE, 4 party rows). This is the final
 *      day-end reconciliation step that turns a report into the
 *      fixed-width text ledger a human reads — per-party
 *      inflow / outflow / net rows plus the deposit formula line —
 *      previously visible only inside the `buildSettlementReport`
 *      numbers. Every timed iteration re-checks the rendered text
 *      against hand-written expected lines (header / outcome,
 *      deposit formula, and one party's net row).
 *  21. allowed-events lookup — `allowedEvents(state)` over all
 *      8 states of the transition table (one pass = every state
 *      queried once, in declaration order). This is the per-row
 *      primitive a UI or watchdog pays to decide what an escrow
 *      can do next — the demo's no-dead-end narrative and the
 *      state diagram both rest on it — previously visible only
 *      inside the dispatch numbers. Expected event lists are
 *      hand-pinned in the fixture comment below (declaration
 *      order; the three terminal states expect the empty list),
 *      and every timed iteration re-checks each state's result
 *      against them. (The backlog item that commissioned this
 *      path said "all 6 states"; the table in fact declares 8 —
 *      this path covers all 8.)
 *  22. fee calculation — `calculateDeposit(inputs)` over a fixed
 *      3-shape corpus (the golden vector, a complexity-multiplier
 *      case, and a large-pool case; composition and hand-computed
 *      `adjustedBaseFee` / `deposit` expectations in the fixture
 *      comment below). This is the deposit preview every escrow
 *      funding pays first — deposit = creatorPool + baseFee x
 *      complexityMultiplier - loyaltyDiscount + oracleFee, with
 *      per-field money validation and `round2` on both derived
 *      figures — previously visible only as one fixture-construction
 *      call at module scope. Every timed iteration re-checks each
 *      returned breakdown against its hand-written expectation.
 *  23. arbitration dispatch — `dispatchArbitration(escrow, quorum,
 *      "refund")` over a fixed DISPUTED escrow and a threshold-reached
 *      5/9 quorum: the combined cost of the `hasQuorum()` gate, the
 *      `Escrow.dispatch` transition, the hash-chained audit entry
 *      append, and the quorum-count note assembly that every disputed
 *      escrow pays once the vote reaches threshold. Because the
 *      dispatch mutates the escrow, every iteration rebuilds both
 *      sides from fixed prefixes first — the escrow via
 *      `Escrow.fromHistory` from its detached 2-entry prefix
 *      (FUND 10,630 at BASE, then DISPUTE at BASE + 1s) and the
 *      quorum via `createQuorum` approving dao-1..dao-5 on the
 *      fixed clock — so the reported number INCLUDES that rebuild
 *      cost and is a conservative lower bound on the dispatch-only
 *      throughput, the same accounting the watchdog-execution paths
 *      use. The dispatch itself is pinned to a fixed audit
 *      timestamp (BASE + 2s), so no wall clock enters the checks.
 *      Every timed iteration checks the returned and stored state
 *      is REFUNDED, the history grew by exactly one entry, and that
 *      entry is the ARBITRATE_REFUND from DISPUTED carrying the
 *      hand-pinned note `quorum 5/5`.
 *  24. deadline judgement — `isOverdue(escrow, now)` over a fixed
 *      4-case corpus (a past-deadline FUNDED escrow, a
 *      future-deadline FUNDED escrow, a deadline-less FUNDED
 *      escrow, and a past-deadline terminal RELEASED escrow),
 *      always against one injected fixed `now`. This is the
 *      per-escrow primitive the watchdog screening paths pay for
 *      every escrow in a batch — `expiredEscrows` is this check
 *      over a list — previously visible only inside the batch-100
 *      screening numbers. The function is pure (it reads the
 *      deadline and the terminal flag, never mutates or
 *      dispatches), so the same four escrows are re-judged on
 *      every iteration. Expected booleans are hand-pinned in the
 *      fixture comment below (true / false / false / false,
 *      written from the documented semantics — no deadline means
 *      never overdue, and a terminal escrow is never overdue even
 *      past its deadline), and every timed iteration re-checks
 *      each result against them.
 *  25. money guard — `assertNonNegativeMoney(name, value)` over a
 *      fixed legal corpus (zero, a cent, the golden 10,630, and a
 *      large amount), measuring only the legal branch's steady-state
 *      throughput: this is the boundary check every dispatch pays
 *      for its monetary inputs (the #15 input validation), previously
 *      visible only inside the dispatch numbers. The illegal branch
 *      (negative, NaN, ±Infinity, a numeric string, undefined, and
 *      null — each throwing the exact hand-pinned message
 *      `amount must be a finite non-negative number`) is asserted
 *      for correctness ONCE, outside the timed loop, never timed.
 *      Every timed iteration re-checks that the whole legal corpus
 *      passes without throwing.
 *  26. transition-table JSON export — `transitionTableJson()` with
 *      no arguments: the canonical JSON form (declaration order,
 *      2-space indent, trailing newline) that front-end and docs
 *      tooling consumes instead of re-deriving the state machine.
 *      This is the full-edge enumeration plus JSON assembly a docs
 *      or UI build pays per export, previously unmeasured. Every
 *      timed iteration parses the output back and checks it against
 *      hand-pinned expectations (14 edges, pinned first / release /
 *      last edges, pinned per-edge key order — expectations written
 *      from the committed snapshot, never derived by calling
 *      `transitionTable()` or the function under test).
 *
 *  27. state diagram generation — `stateDiagram()` with no
 *      arguments: the Mermaid stateDiagram-v2 block (fenced) that
 *      the README embeds verbatim and docs tooling regenerates via
 *      `npm run diagram`. This is the full-edge enumeration plus
 *      text assembly a docs build pays per render, previously
 *      unmeasured. Every timed iteration checks the output against
 *      hand-pinned expectations (21 lines, 14 edge lines written
 *      out in full, the start line, the 3 terminal lines, and all
 *      8 states present — expectations written from the committed
 *      snapshot and test/diagram.test.ts, never derived by calling
 *      `transitionTable()` or the function under test).
 *
 *  28. README diagram sync check — `readmeDiagramInSync()` with
 *      no arguments: reads this repo's README.md, regenerates the
 *      diagram from the transition table, and checks the exact
 *      generated block is embedded in the README. This is the
 *      documentation-sync check a docs CI pays per run (one README
 *      read plus a full diagram regeneration and byte inclusion
 *      check), previously unmeasured. File reading is limited to
 *      this repo's own README.md; no network, no randomness, and
 *      no wall-clock assertion enters the check. Every timed
 *      iteration checks the result against the hand-pinned
 *      expectation `true` — the same expectation the test suite
 *      pins (test/diagram.test.ts: README embeds the exact
 *      generated diagram block, and the diagram CLI `--check`
 *      passes), never derived by reading the README in the bench
 *      itself.
 *
 *  29. dispatch subscription notification — `subscribe()` with
 *      one fixed collecting listener on a fresh escrow, driven
 *      through the same fixed full CREATED -> RELEASED lifecycle
 *      as group 1 (see the subscribe fixture below). This is the
 *      in-process fan-out every successful dispatch pays after
 *      its audit entry is appended: listeners run in
 *      subscription order, and a throwing listener is isolated
 *      (the dispatch still succeeds and its peers still run).
 *      One timed pass is one full subscribed lifecycle of 4
 *      dispatches + 4 notifications; its per-iteration
 *      self-check pins the notification sequence to the
 *      hand-written (event, from, to) expectations and to the
 *      escrow's own history, entry for entry. Outside the timed
 *      loop, an unsubscribe check pins that a further dispatch
 *      notifies nobody, and an isolation check pins that a
 *      throwing listener neither breaks a dispatch nor starves
 *      its peer. No network, no randomness, and no wall
 *      clock: every dispatch timestamp is fixed.
 *
 * Fixtures are fully deterministic: fixed escrow id, the portfolio
 * golden deposit (10,000 / 600 / 1.0x / -30 / +60 -> 10,630), fixed
 * dispatch timestamps (a fixed base instant plus per-step offsets),
 * webhook secret, payload timestamp and `eventId`. Nothing here reads
 * the network, a random source, or the wall clock for fixture data —
 * only the timing loop itself uses `process.hrtime`. Numbers vary with
 * hardware — do not treat them as guaranteed throughput.
 *
 * Run: `npm run bench`
 */
import { cpus } from "node:os";
import {
  actOnStaleEscrows,
  allowedEvents,
  assertNonNegativeMoney,
  buildSettlementReport,
  buildSettlementReports,
  buildSettlementWebhook,
  buildSettlementWebhooks,
  calculateDeposit,
  createQuorum,
  deliverSettlementWebhookToMany,
  depositAmountFromHistory,
  dispatchArbitration,
  Escrow,
  expiredEscrows,
  expireOverdueEscrows,
  historyFromNdjson,
  historyToNdjson,
  isOverdue,
  parseRetryAfter,
  renderReport,
  restoreQuorum,
  settleRelease,
  SettlementEventDedupe,
  staleEscrows,
  stateDiagram,
  transitionTableJson,
  summarizeSettlementReports,
  verifyHistoryChain,
  verifySettlementWebhook,
  type EscrowEvent,
  type EscrowHistoryEntry,
  type EscrowState,
  type Quorum,
  type QuorumSnapshot,
  type SettlementInputs,
  type SettlementReportInputs,
  type SettlementWebhookEndpoint,
} from "../src/index.js";
import { readmeDiagramInSync } from "../src/diagram.js";

const ITERATIONS = 3000;
const WARMUP = 200;

/** Fixed base instant for every dispatch timestamp (deterministic). */
const BASE_MS = Date.parse("2026-01-01T00:00:00.000Z");
const WEBHOOK_SECRET = "bench-settlement-secret-2026";
const WEBHOOK_NOW = new Date(BASE_MS + 60_000);
const WEBHOOK_EVENT_ID = "bench-event-001";
const DEPOSIT_AMOUNT = 10630;

const LIFECYCLE: Array<{ event: EscrowEvent; amount?: number }> = [
  { event: "FUND", amount: DEPOSIT_AMOUNT },
  { event: "SUBMIT_MILESTONE" },
  { event: "VERIFY_PASS" },
  { event: "RELEASE" },
];

/** One full deterministic CREATED -> RELEASED lifecycle on a fresh escrow. */
function runLifecycle(): Escrow {
  const escrow = new Escrow("BENCH-001");
  LIFECYCLE.forEach(({ event, amount }, i) => {
    escrow.dispatch(event, undefined, amount, {
      at: new Date(BASE_MS + i * 1000).toISOString(),
    });
  });
  return escrow;
}

const REFUNDED_LIFECYCLE: Array<{ event: EscrowEvent; amount?: number }> = [
  { event: "FUND", amount: DEPOSIT_AMOUNT },
  { event: "SUBMIT_MILESTONE" },
  { event: "VERIFY_FAIL" },
  { event: "ARBITRATE_REFUND" },
];

/** One full deterministic CREATED -> REFUNDED lifecycle (4 entries). */
function runRefundedLifecycle(id: string): Escrow {
  const escrow = new Escrow(id);
  REFUNDED_LIFECYCLE.forEach(({ event, amount }, i) => {
    escrow.dispatch(event, undefined, amount, {
      at: new Date(BASE_MS + i * 1000).toISOString(),
    });
  });
  return escrow;
}

/** One full deterministic CREATED -> RELEASED lifecycle under a given id. */
function runReleasedLifecycle(id: string): Escrow {
  const escrow = new Escrow(id);
  LIFECYCLE.forEach(({ event, amount }, i) => {
    escrow.dispatch(event, undefined, amount, {
      at: new Date(BASE_MS + i * 1000).toISOString(),
    });
  });
  return escrow;
}

function settlementInputsFor(
  escrow: Escrow,
): SettlementReportInputs {
  return {
    escrowId: escrow.id,
    history: escrow.history.map((e) => ({ ...e })),
    finalState: escrow.state,
    deposit,
    settlement: { proFeeBps: 500 },
  };
}

/**
 * The NDJSON fixture lifecycle: the golden deposit funded in five
 * staged FUND dispatches (10,000 + 300 + 150 + 100 + 80 = 10,630),
 * then milestone submission, verification, and release — 8 chained
 * audit entries ending RELEASED, comparable in size to the dataquest
 * lifecycle's 8-entry NDJSON bench fixture.
 */
const NDJSON_LIFECYCLE: Array<{ event: EscrowEvent; amount?: number }> = [
  { event: "FUND", amount: 10000 },
  { event: "FUND", amount: 300 },
  { event: "FUND", amount: 150 },
  { event: "FUND", amount: 100 },
  { event: "FUND", amount: 80 },
  { event: "SUBMIT_MILESTONE" },
  { event: "VERIFY_PASS" },
  { event: "RELEASE" },
];

/** One full deterministic 8-entry staged-funding lifecycle. */
function runNdjsonLifecycle(): Escrow {
  const escrow = new Escrow("BENCH-NDJSON-001");
  NDJSON_LIFECYCLE.forEach(({ event, amount }, i) => {
    escrow.dispatch(event, undefined, amount, {
      at: new Date(BASE_MS + i * 1000).toISOString(),
    });
  });
  return escrow;
}

const QUORUM_SIGNERS: readonly string[] = [
  "dao-1",
  "dao-2",
  "dao-3",
  "dao-4",
  "dao-5",
  "dao-6",
  "dao-7",
  "dao-8",
  "dao-9",
];
const QUORUM_THRESHOLD = 5;

/**
 * One deterministic 5/9 quorum accumulation: a fresh quorum on a fixed
 * injected clock, approving signers in order until the threshold is
 * reached, checking `hasQuorum()` after each vote.
 */
function runQuorumToThreshold(): Quorum {
  const quorum = createQuorum({
    threshold: QUORUM_THRESHOLD,
    signers: QUORUM_SIGNERS,
    now: () => BASE_MS,
  });
  for (let i = 0; i < QUORUM_THRESHOLD; i++) {
    quorum.approve(QUORUM_SIGNERS[i]);
    quorum.hasQuorum();
  }
  return quorum;
}

function measure(fn: () => void, iterations: number): number {
  for (let i = 0; i < WARMUP; i++) fn(); // warmup: JIT, module caches
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
  const elapsedSec = Number(process.hrtime.bigint() - start) / 1e9;
  return iterations / elapsedSec;
}

async function measureAsync(
  fn: () => Promise<void>,
  iterations: number,
): Promise<number> {
  for (let i = 0; i < WARMUP; i++) await fn(); // warmup: JIT, module caches
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) await fn();
  const elapsedSec = Number(process.hrtime.bigint() - start) / 1e9;
  return iterations / elapsedSec;
}

function fmt(ops: number): string {
  const s =
    ops >= 1000
      ? ops.toLocaleString("en-US", { maximumFractionDigits: 0 })
      : ops.toFixed(1);
  const perOpUs = (1e6 / ops).toFixed(2);
  return `${s} ops/sec (${perOpUs} µs/op)`;
}

// ---------------------------------------------------------------------
// Deterministic fixtures, built once outside the timed loops.
// ---------------------------------------------------------------------
const deposit = calculateDeposit({
  creatorPool: 10000,
  baseFee: 600,
  complexityMultiplier: 1.0,
  loyaltyDiscount: 30,
  oracleFee: 60,
});
if (deposit.deposit !== DEPOSIT_AMOUNT) {
  throw new Error("benchmark fixture failed: golden deposit mismatch");
}
const releasedEscrow = runLifecycle();
if (releasedEscrow.state !== "RELEASED" || releasedEscrow.history.length !== 4) {
  throw new Error("benchmark fixture failed: lifecycle did not reach RELEASED");
}
// Detached plain copies, exactly what a persisted audit log looks like.
const historyFixture: EscrowHistoryEntry[] = releasedEscrow.history.map((e) => ({
  ...e,
}));
if (!verifyHistoryChain(historyFixture)) {
  throw new Error("benchmark fixture failed: history chain does not verify");
}
const report = buildSettlementReport({
  escrowId: releasedEscrow.id,
  history: historyFixture,
  finalState: "RELEASED",
  deposit,
  settlement: { proFeeBps: 500 },
});
if (!report.balanced || report.outcome !== "released") {
  throw new Error("benchmark fixture failed: settlement report not balanced");
}
// Batch fixture: 4 inputs, each a 4-entry history comparable to the
// single-report fixture — released / refunded / released, plus one
// deliberately mismatched input (a RELEASED history claimed as
// REFUNDED) that must land as a per-item error without aborting the
// batch. Expected outcomes are hand-derived from those lifecycles.
const batchEscrows = [
  runReleasedLifecycle("BENCH-BATCH-001"),
  runRefundedLifecycle("BENCH-BATCH-002"),
  runReleasedLifecycle("BENCH-BATCH-003"),
  runReleasedLifecycle("BENCH-BATCH-004"),
];
const batchInputs: SettlementReportInputs[] = [
  settlementInputsFor(batchEscrows[0]),
  settlementInputsFor(batchEscrows[1]),
  settlementInputsFor(batchEscrows[2]),
  { ...settlementInputsFor(batchEscrows[3]), finalState: "REFUNDED" },
];
const BATCH_EXPECTED_OUTCOMES: Array<string | undefined> = [
  "released",
  "refunded",
  "released",
  undefined,
];
function checkBatchResults(
  results: ReturnType<typeof buildSettlementReports>,
): void {
  if (results.length !== batchInputs.length) {
    throw new Error("benchmark batch check failed: result count mismatch");
  }
  for (let i = 0; i < results.length; i++) {
    if (results[i].escrowId !== batchInputs[i].escrowId) {
      throw new Error("benchmark batch check failed: order not preserved");
    }
    const expected = BATCH_EXPECTED_OUTCOMES[i];
    if (expected === undefined) {
      const err = results[i].error;
      if (
        results[i].report !== undefined ||
        typeof err !== "string" ||
        !err.includes(
          "state is REFUNDED but the last audit event is RELEASE",
        )
      ) {
        throw new Error("benchmark batch check failed: bad item shape");
      }
    } else if (
      results[i].error !== undefined ||
      results[i].report?.outcome !== expected ||
      !results[i].report?.balanced
    ) {
      throw new Error("benchmark batch check failed: outcome mismatch");
    }
  }
}
checkBatchResults(buildSettlementReports(batchInputs));
// Summary fixture: the batch results above, built ONCE outside the
// timed loop (the summarizer only reads them, so every timed iteration
// re-summarizes this same list). Expected summary, hand-derived from
// the batch composition — NOT produced by the implementation:
//   items: released / refunded / released / error (mismatched input)
//   each successful report locks the golden deposit 10,630 and is
//   internally balanced at 10,630 in = 10,630 out; a released report
//   at proFeeBps 500 pays proFee = 10,630 * 5% = 531.50 to the
//   platform and creator net = 10,630 - 531.50 = 10,098.50; a
//   refunded report returns the full 10,630 to the sponsor.
//   total = 4, reports = 3, errors = 1 (the error counts, but
//   contributes nothing to any money figure)
//   outcomes = { released: 2, refunded: 1, expired: 0 }
//   totalDeposit = totalInflow = totalOutflow = 3 * 10,630 = 31,890
//   sponsor:  inflow 10,630 (refund only), outflow 3 * 10,630 =
//             31,890, net = 10,630 - 31,890 = -21,260
//   creator:  inflow 2 * 10,098.50 = 20,197, outflow 0, net 20,197
//   platform: inflow 2 * 531.50 = 1,063, outflow 0, net 1,063
//   referrer: inflow 0, outflow 0, net 0
//   balanced = true (every successful report is balanced)
const batchResults = buildSettlementReports(batchInputs);
function checkBatchSummary(
  summary: ReturnType<typeof summarizeSettlementReports>,
): void {
  const parties: Array<[string, number, number, number]> = [
    ["sponsor", 10630, 31890, -21260],
    ["creator", 20197, 0, 20197],
    ["platform", 1063, 0, 1063],
    ["referrer", 0, 0, 0],
  ];
  if (
    summary.total !== 4 ||
    summary.reports !== 3 ||
    summary.errors !== 1 ||
    summary.outcomes.released !== 2 ||
    summary.outcomes.refunded !== 1 ||
    summary.outcomes.expired !== 0 ||
    summary.totalDeposit !== 31890 ||
    summary.totalInflow !== 31890 ||
    summary.totalOutflow !== 31890 ||
    summary.balanced !== true ||
    summary.parties.length !== parties.length ||
    summary.parties.some(
      (p, i) =>
        p.party !== parties[i][0] ||
        p.inflow !== parties[i][1] ||
        p.outflow !== parties[i][2] ||
        p.net !== parties[i][3],
    )
  ) {
    throw new Error("benchmark summary check failed: summarize mismatch");
  }
}
checkBatchSummary(summarizeSettlementReports(batchResults));
// Batch-webhook fixture: the pre-built batch results above are piped
// straight into `buildSettlementWebhooks` — the reports -> webhooks
// hand-off the batch API is designed for. Expectations are hand-derived
// from the batch composition (NOT produced by the implementation):
// entries 1..3 (released / refunded / released) each build a webhook
// whose payload carries that entry's escrowId and the hand-known
// outcome, signed under the shared bench secret at the shared fixed
// WEBHOOK_NOW, with eventIds bench-batch-event-1..3 in input order
// (the deterministic counter factory below is created fresh for every
// call, so the sequence restarts per call); entry 4 is the batch's
// per-item error: it must come back as { escrowId, error } with the
// error forwarded byte-identical from batchResults and NO webhook,
// and it must not consume an eventId. Every built webhook must
// re-verify under the bench secret.
const BATCH_WEBHOOK_EVENT_IDS = [
  "bench-batch-event-1",
  "bench-batch-event-2",
  "bench-batch-event-3",
];
function batchWebhookEventIdFactory(): () => string {
  let n = 0;
  return () => `bench-batch-event-${++n}`;
}
function checkBatchWebhooks(
  built: ReturnType<typeof buildSettlementWebhooks>,
): void {
  if (built.length !== batchResults.length) {
    throw new Error("benchmark batch webhook check failed: count mismatch");
  }
  const seenEventIds = new Set<string>();
  for (let i = 0; i < built.length; i++) {
    if (built[i].escrowId !== batchResults[i].escrowId) {
      throw new Error("benchmark batch webhook check failed: order not preserved");
    }
    const expectedOutcome = BATCH_EXPECTED_OUTCOMES[i];
    if (expectedOutcome === undefined) {
      const entryError = built[i].error;
      if (
        built[i].webhook !== undefined ||
        entryError !== batchResults[i].error ||
        typeof entryError !== "string" ||
        entryError.length === 0
      ) {
        throw new Error("benchmark batch webhook check failed: error not forwarded");
      }
    } else {
      const webhook = built[i].webhook;
      if (
        built[i].error !== undefined ||
        webhook === undefined ||
        webhook.payload.escrowId !== batchResults[i].escrowId ||
        webhook.payload.outcome !== expectedOutcome ||
        webhook.payload.eventId !==
          BATCH_WEBHOOK_EVENT_IDS[seenEventIds.size] ||
        seenEventIds.has(webhook.payload.eventId) ||
        !verifySettlementWebhook(
          JSON.stringify(webhook.payload),
          webhook.signature,
          WEBHOOK_SECRET,
        )
      ) {
        throw new Error("benchmark batch webhook check failed: webhook mismatch");
      }
      seenEventIds.add(webhook.payload.eventId);
    }
  }
  if (seenEventIds.size !== BATCH_WEBHOOK_EVENT_IDS.length) {
    throw new Error("benchmark batch webhook check failed: eventId set mismatch");
  }
}
checkBatchWebhooks(
  buildSettlementWebhooks(batchResults, {
    secret: WEBHOOK_SECRET,
    now: WEBHOOK_NOW,
    eventIdFactory: batchWebhookEventIdFactory(),
  }),
);
const webhook = buildSettlementWebhook(report, {
  secret: WEBHOOK_SECRET,
  now: WEBHOOK_NOW,
  eventId: WEBHOOK_EVENT_ID,
});
const webhookBody = JSON.stringify(webhook.payload);
if (!verifySettlementWebhook(webhookBody, webhook.signature, WEBHOOK_SECRET)) {
  throw new Error("benchmark fixture failed: webhook does not verify");
}
const ndjsonEscrow = runNdjsonLifecycle();
if (ndjsonEscrow.state !== "RELEASED" || ndjsonEscrow.history.length !== 8) {
  throw new Error("benchmark fixture failed: NDJSON lifecycle shape");
}
// Detached plain copies, exactly what a persisted audit log looks like.
const ndjsonHistoryFixture: EscrowHistoryEntry[] = ndjsonEscrow.history.map(
  (e) => ({ ...e }),
);
if (!verifyHistoryChain(ndjsonHistoryFixture)) {
  throw new Error("benchmark fixture failed: NDJSON history chain");
}
// Quorum fixture self-check, outside the timed loop: the threshold
// boundary must be exact (4/9 does not reach quorum, 5/9 does), the
// counted approvals must match the votes cast, and a duplicate
// approval must be idempotent (no double count).
{
  const quorum = createQuorum({
    threshold: QUORUM_THRESHOLD,
    signers: QUORUM_SIGNERS,
    now: () => BASE_MS,
  });
  for (let i = 0; i < QUORUM_THRESHOLD - 1; i++) {
    quorum.approve(QUORUM_SIGNERS[i]);
  }
  if (quorum.hasQuorum() || quorum.approvalCount() !== QUORUM_THRESHOLD - 1) {
    throw new Error("benchmark fixture failed: quorum below threshold");
  }
  quorum.approve(QUORUM_SIGNERS[QUORUM_THRESHOLD - 1]);
  if (!quorum.hasQuorum() || quorum.approvalCount() !== QUORUM_THRESHOLD) {
    throw new Error("benchmark fixture failed: quorum at threshold");
  }
  quorum.approve(QUORUM_SIGNERS[0]);
  if (
    quorum.approvalCount() !== QUORUM_THRESHOLD ||
    quorum.approvals().length !== QUORUM_THRESHOLD
  ) {
    throw new Error("benchmark fixture failed: duplicate approve double-counted");
  }
  const measured = runQuorumToThreshold();
  if (!measured.hasQuorum() || measured.approvalCount() !== QUORUM_THRESHOLD) {
    throw new Error("benchmark fixture failed: quorum accumulation shape");
  }
}

// Restore fixture: a snapshot of that same 9-signer / threshold-5
// quorum shape, carrying 7 recorded approvals — dao-1..dao-7 approving
// in order, one second apart on a stepped fixed clock starting at
// BASE_MS (approval i at BASE_MS + i * 1000). Built once, outside the
// timed loop, then pushed through a JSON stringify/parse round-trip
// so the timed path restores exactly the plain-data form a persisted
// snapshot has after a restart. Hand-written expectations (NOT
// produced by the implementation): 7 approvals recorded, all 7 count
// (no expiry window is configured), the threshold of 5 is reached,
// the counted approvals are dao-1..dao-7 in record order, and the
// audit log holds exactly those 7 entries.
const RESTORE_APPROVAL_COUNT = 7;
const RESTORE_EXPECTED_APPROVALS: readonly string[] = QUORUM_SIGNERS.slice(
  0,
  RESTORE_APPROVAL_COUNT,
);
const RESTORE_CONFIG = {
  threshold: QUORUM_THRESHOLD,
  signers: QUORUM_SIGNERS,
  now: () => BASE_MS,
};
const restoreSnapshot: QuorumSnapshot = ((): QuorumSnapshot => {
  let clockMs = BASE_MS;
  const source = createQuorum({
    threshold: QUORUM_THRESHOLD,
    signers: QUORUM_SIGNERS,
    now: () => clockMs,
  });
  for (let i = 0; i < RESTORE_APPROVAL_COUNT; i++) {
    clockMs = BASE_MS + i * 1000;
    source.approve(QUORUM_SIGNERS[i]);
  }
  return source.snapshot();
})();
const restorePersisted: unknown = JSON.parse(JSON.stringify(restoreSnapshot));
function checkRestoredQuorum(restored: Quorum): void {
  const approvals = restored.approvals();
  if (
    !restored.hasQuorum() ||
    restored.approvalCount() !== RESTORE_APPROVAL_COUNT ||
    approvals.length !== RESTORE_APPROVAL_COUNT ||
    approvals.some((s, i) => s !== RESTORE_EXPECTED_APPROVALS[i]) ||
    restored.approvalLog().length !== RESTORE_APPROVAL_COUNT
  ) {
    throw new Error("benchmark restore check failed: restored quorum shape");
  }
}
// Restore pre-checks (outside the timed loop): the restored quorum
// matches the hand-written expectations, and re-snapshotting it
// reproduces the persisted snapshot byte-for-byte (canonical JSON),
// so the timed path restores a snapshot that itself round-trips.
{
  const restored = restoreQuorum(RESTORE_CONFIG, restorePersisted);
  checkRestoredQuorum(restored);
  if (JSON.stringify(restored.snapshot()) !== JSON.stringify(restoreSnapshot)) {
    throw new Error("benchmark fixture failed: restored snapshot mismatch");
  }
}
// Fan-out delivery fixture: the same settled report fanned out to 4
// fixed endpoints, each with its own signing secret, under the shared
// fixed `WEBHOOK_NOW` / `WEBHOOK_EVENT_ID` above. This library's
// delivery layer calls the global `fetch` (there is no fetchImpl
// option), so the fake is installed on `globalThis`: it records the
// calls of the current fan-out, then answers 200 immediately — no
// network, no randomness, and no retry sleep is ever reached on a 200.
const FANOUT_ENDPOINTS: SettlementWebhookEndpoint[] = [
  { url: "https://billing.example.com/hooks/settlement", secret: "bench-fanout-secret-billing" },
  { url: "https://risk.example.com/hooks/settlement", secret: "bench-fanout-secret-risk" },
  { url: "https://notifications.example.com/hooks/settlement", secret: "bench-fanout-secret-notifications" },
  { url: "https://ledger.example.com/hooks/settlement", secret: "bench-fanout-secret-ledger" },
];
let fanoutCalls: Array<{ url: string; body: string; signature: string }> = [];
const fanoutFetch: typeof fetch = async (input, init) => {
  fanoutCalls.push({
    url: String(input),
    body: String(init?.body ?? ""),
    signature: String(new Headers(init?.headers).get("x-signature") ?? ""),
  });
  return new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

async function runFanout() {
  fanoutCalls = [];
  globalThis.fetch = fanoutFetch;
  const out = await deliverSettlementWebhookToMany(report, FANOUT_ENDPOINTS, {
    now: WEBHOOK_NOW,
    eventId: WEBHOOK_EVENT_ID,
  });
  if (
    out.results.length !== FANOUT_ENDPOINTS.length ||
    out.delivered !== FANOUT_ENDPOINTS.length ||
    out.failed !== 0 ||
    out.results.some((r, i) => !r.ok || r.attempts !== 1 || r.status !== 200 || r.url !== FANOUT_ENDPOINTS[i].url) ||
    fanoutCalls.length !== FANOUT_ENDPOINTS.length ||
    fanoutCalls.some((c) => c.body !== fanoutCalls[0].body) ||
    JSON.parse(fanoutCalls[0].body).eventId !== WEBHOOK_EVENT_ID
  ) {
    throw new Error("benchmark self-check failed: deliverSettlementWebhookToMany");
  }
  return out;
}

// One-time fixture validation (outside the timed loop): every endpoint
// received a copy signed with its OWN secret.
await runFanout();
for (const [i, endpoint] of FANOUT_ENDPOINTS.entries()) {
  const call = fanoutCalls.find((c) => c.url === endpoint.url);
  if (!call || !verifySettlementWebhook(call.body, call.signature, endpoint.secret)) {
    throw new Error(
      `benchmark fixture failed: fan-out endpoint ${i} signature does not verify`,
    );
  }
}

// Dedupe fixture: 1,000 fixed `eventId`s pre-recorded in a
// `SettlementEventDedupe` under an injected FIXED clock — the clock
// never advances, so in the timed loop no entry can expire (default
// TTL is 1 hour) and none is evicted (1,001 live entries, far under
// the default 10,000 cap): the measured path is the pure steady-state
// duplicate hit, LRU recency refresh included. No network, no
// randomness, no wall clock.
const DEDUPE_PREFILL = 1000;
const DEDUPE_NOW_MS = BASE_MS + 120_000;
const dedupeIds: string[] = Array.from(
  { length: DEDUPE_PREFILL },
  (_, i) => `bench-dedupe-${String(i).padStart(4, "0")}`,
);
const dedupe = new SettlementEventDedupe({ now: () => DEDUPE_NOW_MS });
for (const id of dedupeIds) {
  if (dedupe.checkAndRecord(id)) {
    throw new Error("benchmark fixture failed: dedupe prefill saw a duplicate");
  }
}
// Semantics self-checks (outside the timed loop): an already-recorded
// id is a duplicate; an unseen id is admitted on first sight and
// judged a duplicate on the second; and the stats counters agree
// exactly with the calls made so far (1,000 prefill misses, then
// hit + miss + hit, no evictions).
if (!dedupe.checkAndRecord(dedupeIds[0])) {
  throw new Error("benchmark fixture failed: dedupe missed a recorded id");
}
if (dedupe.checkAndRecord("bench-dedupe-unseen")) {
  throw new Error("benchmark fixture failed: dedupe flagged a first sighting");
}
if (!dedupe.checkAndRecord("bench-dedupe-unseen")) {
  throw new Error("benchmark fixture failed: dedupe missed a second sighting");
}
const dedupeStatsFixture = dedupe.stats();
if (
  dedupeStatsFixture.size !== DEDUPE_PREFILL + 1 ||
  dedupeStatsFixture.hits !== 2 ||
  dedupeStatsFixture.misses !== DEDUPE_PREFILL + 1 ||
  dedupeStatsFixture.evictions !== 0
) {
  throw new Error("benchmark fixture failed: dedupe stats do not match calls");
}
let dedupeCursor = 0;

// Dedupe-restore fixture: a 1,000-entry snapshot of a dedupe that
// recorded the fixed ids `bench-restore-0000` ..
// `bench-restore-0999`, in that order, under an injected FIXED clock
// (`DEDUPE_RESTORE_NOW_MS`, a fixed instant after BASE_MS — the
// clock never advances). The snapshot goes through a JSON
// stringify/parse round-trip, exactly the persisted form a receiver
// reloads at startup. Restore runs under the default TTL (1 hour)
// and the default capacity (10,000): every entry was first seen at
// the restore instant itself (age 0), so no entry is expired at
// load and none is evicted for capacity. Hand-written expectations
// — written out here from the composition above, never derived by
// calling `restore` itself:
//   - the snapshot is `{ v: 1, entries }` with exactly 1,000 pairs,
//     in prefill order, each `seenAtMs` exactly
//     DEDUPE_RESTORE_NOW_MS;
//   - a restored dedupe reports size 1,000 with all observability
//     counters at zero (counters are not part of a snapshot);
//   - `checkAndRecord` on every snapshot id is a duplicate (true):
//     1,000 hits in total, the size stays 1,000, and an unseen id is
//     still a first sighting (false) followed by a duplicate (true).
// The exhaustive 1,000-id check runs ONCE, outside the timed loop,
// below; the timed path re-checks the counters and spot-checks the
// first / middle / last ids on every iteration (see
// `benchSettlementEventDedupeRestore`).
const DEDUPE_RESTORE_PREFILL = 1000;
const DEDUPE_RESTORE_NOW_MS = BASE_MS + 180_000;
const dedupeRestoreIds: string[] = Array.from(
  { length: DEDUPE_RESTORE_PREFILL },
  (_, i) => `bench-restore-${String(i).padStart(4, "0")}`,
);
const dedupeRestoreSource = new SettlementEventDedupe({
  now: () => DEDUPE_RESTORE_NOW_MS,
});
for (const id of dedupeRestoreIds) {
  if (dedupeRestoreSource.checkAndRecord(id)) {
    throw new Error(
      "benchmark fixture failed: dedupe restore prefill saw a duplicate",
    );
  }
}
const dedupeRestoreSnapshot = JSON.parse(
  JSON.stringify(dedupeRestoreSource.exportSnapshot()),
) as { v: unknown; entries: Array<[string, number]> };
if (
  dedupeRestoreSnapshot.v !== 1 ||
  !Array.isArray(dedupeRestoreSnapshot.entries) ||
  dedupeRestoreSnapshot.entries.length !== DEDUPE_RESTORE_PREFILL ||
  dedupeRestoreSnapshot.entries.some(
    (pair, i) =>
      pair[0] !== dedupeRestoreIds[i] || pair[1] !== DEDUPE_RESTORE_NOW_MS,
  )
) {
  throw new Error("benchmark fixture failed: dedupe restore snapshot shape");
}
// Exhaustive validation (outside the timed loop): every snapshot id
// restores as a duplicate, the counts agree exactly with the calls
// made, and an unseen id keeps first-sighting semantics.
const dedupeRestoreProbe = SettlementEventDedupe.restore(dedupeRestoreSnapshot, {
  now: () => DEDUPE_RESTORE_NOW_MS,
});
const dedupeRestoreProbeFresh = dedupeRestoreProbe.stats();
if (
  dedupeRestoreProbeFresh.size !== DEDUPE_RESTORE_PREFILL ||
  dedupeRestoreProbeFresh.hits !== 0 ||
  dedupeRestoreProbeFresh.misses !== 0 ||
  dedupeRestoreProbeFresh.evictions !== 0
) {
  throw new Error(
    "benchmark fixture failed: restored dedupe counters do not start at zero",
  );
}
for (const id of dedupeRestoreIds) {
  if (!dedupeRestoreProbe.checkAndRecord(id)) {
    throw new Error(
      "benchmark fixture failed: restored dedupe missed a snapshot id",
    );
  }
}
const dedupeRestoreProbeHits = dedupeRestoreProbe.stats();
if (
  dedupeRestoreProbeHits.size !== DEDUPE_RESTORE_PREFILL ||
  dedupeRestoreProbeHits.hits !== DEDUPE_RESTORE_PREFILL ||
  dedupeRestoreProbeHits.misses !== 0 ||
  dedupeRestoreProbeHits.evictions !== 0
) {
  throw new Error(
    "benchmark fixture failed: restored dedupe hit count differs from the hand-written expectation",
  );
}
if (dedupeRestoreProbe.checkAndRecord("bench-restore-unseen")) {
  throw new Error(
    "benchmark fixture failed: restored dedupe flagged a first sighting",
  );
}
if (!dedupeRestoreProbe.checkAndRecord("bench-restore-unseen")) {
  throw new Error(
    "benchmark fixture failed: restored dedupe missed a second sighting",
  );
}

// Watchdog screening fixture: one fixed mixed batch of 100 escrows,
// screened at the fixed WATCHDOG_NOW = BASE + 90 days. Composition,
// hand-counted group by group (ids are BENCH-WD-<group>-<nn>):
//   A x30  FUNDED, funded at BASE (90d ago), deadline BASE+30d (past)
//          -> expired YES, stale YES (dwell 90d > FUNDED budget 7d)
//   B x20  FUNDED, funded at BASE+80d (10d ago), deadline BASE+120d
//          (future) -> expired no, stale YES (dwell 10d > 7d)
//   C x10  FUNDED, funded at BASE+88d (2d ago), deadline BASE+120d
//          -> expired no, stale no (dwell 2d < 7d)
//   D x10  MILESTONE_SUBMITTED, funded at BASE, milestone at BASE+50d
//          (40d ago), deadline BASE+30d (past)
//          -> expired YES, stale YES (dwell 40d > MILESTONE budget 30d)
//   E x10  MILESTONE_SUBMITTED, funded at BASE, milestone at BASE+85d
//          (5d ago), deadline BASE+120d -> expired no, stale no (5d < 30d)
//   F x10  RELEASED (terminal; funded/milestone/verify/release at
//          BASE/+1d/+2d/+3d), deadline BASE+30d (past)
//          -> expired no (terminal), stale no (terminal)
//   G x10  FUNDED, funded at BASE (90d ago), NO deadline
//          -> expired no (no deadline), stale YES (dwell 90d > 7d)
// Hand-counted expectations (NOT produced by the implementation):
//   expiredEscrows -> 40 ids: all of A (30) + all of D (10), batch order
//   staleEscrows under WATCHDOG_BUDGETS -> 70 ids: A (30) + B (20) +
//     D (10) + G (10), batch order
const DAY_MS = 24 * 3600_000;
const WATCHDOG_NOW = new Date(BASE_MS + 90 * DAY_MS);
const WATCHDOG_BUDGETS: Partial<Record<EscrowState, number>> = {
  FUNDED: 7 * DAY_MS,
  MILESTONE_SUBMITTED: 30 * DAY_MS,
};
const isoAt = (ms: number): string => new Date(ms).toISOString();
function watchdogFunded(
  id: string,
  fundedMs: number,
  deadlineMs?: number,
): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", undefined, 1000, { at: isoAt(fundedMs) });
  if (deadlineMs !== undefined) escrow.setDeadline(new Date(deadlineMs));
  return escrow;
}
function watchdogMilestone(
  id: string,
  milestoneMs: number,
  deadlineMs: number,
): Escrow {
  const escrow = watchdogFunded(id, BASE_MS);
  escrow.dispatch("SUBMIT_MILESTONE", undefined, undefined, {
    at: isoAt(milestoneMs),
  });
  escrow.setDeadline(new Date(deadlineMs));
  return escrow;
}
function watchdogIds(group: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) => `BENCH-WD-${group}-${String(i + 1).padStart(2, "0")}`,
  );
}
function buildWatchdogBatch(): Escrow[] {
  return [
  ...watchdogIds("A", 30).map((id) =>
    watchdogFunded(id, BASE_MS, BASE_MS + 30 * DAY_MS),
  ),
  ...watchdogIds("B", 20).map((id) =>
    watchdogFunded(id, BASE_MS + 80 * DAY_MS, BASE_MS + 120 * DAY_MS),
  ),
  ...watchdogIds("C", 10).map((id) =>
    watchdogFunded(id, BASE_MS + 88 * DAY_MS, BASE_MS + 120 * DAY_MS),
  ),
  ...watchdogIds("D", 10).map((id) =>
    watchdogMilestone(id, BASE_MS + 50 * DAY_MS, BASE_MS + 30 * DAY_MS),
  ),
  ...watchdogIds("E", 10).map((id) =>
    watchdogMilestone(id, BASE_MS + 85 * DAY_MS, BASE_MS + 120 * DAY_MS),
  ),
  ...watchdogIds("F", 10).map((id) => {
    const escrow = watchdogFunded(id, BASE_MS, BASE_MS + 30 * DAY_MS);
    escrow.dispatch("SUBMIT_MILESTONE", undefined, undefined, {
      at: isoAt(BASE_MS + 1 * DAY_MS),
    });
    escrow.dispatch("VERIFY_PASS", undefined, undefined, {
      at: isoAt(BASE_MS + 2 * DAY_MS),
    });
    escrow.dispatch("RELEASE", undefined, undefined, {
      at: isoAt(BASE_MS + 3 * DAY_MS),
    });
    return escrow;
  }),
  ...watchdogIds("G", 10).map((id) => watchdogFunded(id, BASE_MS)),
  ];
}
const watchdogBatch: Escrow[] = buildWatchdogBatch();
if (watchdogBatch.length !== 100) {
  throw new Error("benchmark fixture failed: watchdog batch size");
}
const WATCHDOG_EXPIRED_IDS: string[] = [
  ...watchdogIds("A", 30),
  ...watchdogIds("D", 10),
];
const WATCHDOG_STALE_IDS: string[] = [
  ...watchdogIds("A", 30),
  ...watchdogIds("B", 20),
  ...watchdogIds("D", 10),
  ...watchdogIds("G", 10),
];
function checkWatchdogIds(
  found: Escrow[],
  expected: string[],
  label: string,
): void {
  if (
    found.length !== expected.length ||
    found.some((e, i) => e.id !== expected[i])
  ) {
    throw new Error(`benchmark watchdog check failed: ${label}`);
  }
}
checkWatchdogIds(
  expiredEscrows(watchdogBatch, WATCHDOG_NOW),
  WATCHDOG_EXPIRED_IDS,
  "expiredEscrows",
);
checkWatchdogIds(
  staleEscrows(watchdogBatch, WATCHDOG_BUDGETS, WATCHDOG_NOW),
  WATCHDOG_STALE_IDS,
  "staleEscrows",
);

// Watchdog-executor expectations, hand-counted from the fixture
// composition above and the transition table — never derived by
// calling the executors:
//   expireOverdueEscrows attempts the 40 expired ids (A x30 FUNDED +
//   D x10 MILESTONE_SUBMITTED), in batch order. EXPIRE has an edge
//   from both states, so expired = true for all 40, no entry carries
//   an error, every attempted escrow ends EXPIRED, and its history
//   grows by exactly the EXPIRE entry (A: 1 -> 2 entries, D: 2 -> 3).
//   actOnStaleEscrows with the action (e) => e.dispatch("EXPIRE")
//   attempts the 70 stale ids (A x30 + B x20 + D x10 + G x10), in
//   batch order. The stale states are FUNDED (A/B/G) and
//   MILESTONE_SUBMITTED (D) — both carry an EXPIRE edge, so acted =
//   true for all 70, no entry carries an error, every attempted
//   escrow ends EXPIRED, and its history grows by the EXPIRE entry
//   (A/B/G: 1 -> 2 entries, D: 2 -> 3).
// Non-attempted escrows are not checked here (they are untouched by
// construction: the checks below run on fresh batches and the
// result lists name exactly the attempted ids).
function checkExpireOverdueResults(
  results: ReturnType<typeof expireOverdueEscrows>,
  label: string,
): void {
  const expectedHistoryLengths = [
    ...Array<number>(30).fill(2),
    ...Array<number>(10).fill(3),
  ];
  if (
    results.length !== WATCHDOG_EXPIRED_IDS.length ||
    results.some(
      (r, i) =>
        r.escrow.id !== WATCHDOG_EXPIRED_IDS[i] ||
        r.expired !== true ||
        r.error !== undefined ||
        r.escrow.state !== "EXPIRED" ||
        r.escrow.history.length !== expectedHistoryLengths[i] ||
        r.escrow.history[r.escrow.history.length - 1].event !== "EXPIRE" ||
        r.escrow.history[r.escrow.history.length - 1].to !== "EXPIRED",
    )
  ) {
    throw new Error(`benchmark watchdog check failed: ${label}`);
  }
}
function checkActOnStaleResults(
  results: ReturnType<typeof actOnStaleEscrows>,
  label: string,
): void {
  const expectedHistoryLengths = [
    ...Array<number>(30).fill(2),
    ...Array<number>(20).fill(2),
    ...Array<number>(10).fill(3),
    ...Array<number>(10).fill(2),
  ];
  if (
    results.length !== WATCHDOG_STALE_IDS.length ||
    results.some(
      (r, i) =>
        r.escrow.id !== WATCHDOG_STALE_IDS[i] ||
        r.acted !== true ||
        r.error !== undefined ||
        r.escrow.state !== "EXPIRED" ||
        r.escrow.history.length !== expectedHistoryLengths[i] ||
        r.escrow.history[r.escrow.history.length - 1].event !== "EXPIRE" ||
        r.escrow.history[r.escrow.history.length - 1].to !== "EXPIRED",
    )
  ) {
    throw new Error(`benchmark watchdog check failed: ${label}`);
  }
}
// One-time executor validation (outside the timed loops), each on a
// throwaway fresh batch so the module-scope screening batch above
// stays unmutated for its own paths.
checkExpireOverdueResults(
  expireOverdueEscrows(buildWatchdogBatch(), WATCHDOG_NOW),
  "expireOverdueEscrows fixture",
);
checkActOnStaleResults(
  actOnStaleEscrows(
    buildWatchdogBatch(),
    (e) => e.dispatch("EXPIRE"),
    WATCHDOG_BUDGETS,
    WATCHDOG_NOW,
  ),
  "actOnStaleEscrows fixture",
);

const ndjsonFixture = historyToNdjson(ndjsonHistoryFixture);
const ndjsonRoundTrip = historyFromNdjson(ndjsonFixture);
// parseEscrowHistory returns entries in canonical key order, so compare
// the round-trip through the canonical serializer (historyToNdjson)
// rather than raw object stringification.
if (
  ndjsonRoundTrip.length !== 8 ||
  ndjsonRoundTrip[7].to !== "RELEASED" ||
  historyToNdjson(ndjsonRoundTrip) !== ndjsonFixture
) {
  throw new Error("benchmark fixture failed: NDJSON round-trip mismatch");
}

// ---------------------------------------------------------------------
// parseRetryAfter fixture: a fixed 11-value corpus parsed against one
// injected fixed instant RETRY_AFTER_NOW_MS = BASE_MS + 300,000 ms
// (2026-01-01T00:05:00.000Z, second-aligned so the HTTP-date strings
// below — which carry one-second precision — land exactly).
// Hand-pinned expectations, written from the documented semantics
// (delay-seconds -> seconds * 1000; an HTTP-date -> max(0, date -
// now); signed numbers, garbage, and absent values -> undefined, the
// caller's cue to fall back to exponential backoff), never derived
// by calling parseRetryAfter itself:
//   "2"                                  -> 2000
//   "1.5"                                -> 1500
//   " 30 " (whitespace is trimmed)      -> 30000
//   "0"                                  -> 0
//   HTTP-date at now + 5 s               -> 5000
//   HTTP-date at now - 1 s (past)        -> 0
//   "-5" (signed)                        -> undefined
//   "+5" (signed)                        -> undefined
//   "banana"                             -> undefined
//   null                                 -> undefined
//   undefined                            -> undefined
// ---------------------------------------------------------------------
const RETRY_AFTER_NOW_MS = BASE_MS + 300_000;
const RETRY_AFTER_CASES: ReadonlyArray<{
  value: string | null | undefined;
  expected: number | undefined;
}> = [
  { value: "2", expected: 2000 },
  { value: "1.5", expected: 1500 },
  { value: " 30 ", expected: 30_000 },
  { value: "0", expected: 0 },
  {
    value: new Date(RETRY_AFTER_NOW_MS + 5000).toUTCString(),
    expected: 5000,
  },
  {
    value: new Date(RETRY_AFTER_NOW_MS - 1000).toUTCString(),
    expected: 0,
  },
  { value: "-5", expected: undefined },
  { value: "+5", expected: undefined },
  { value: "banana", expected: undefined },
  { value: null, expected: undefined },
  { value: undefined, expected: undefined },
];

function checkRetryAfterCorpus(): void {
  for (const c of RETRY_AFTER_CASES) {
    if (parseRetryAfter(c.value, RETRY_AFTER_NOW_MS) !== c.expected) {
      throw new Error("benchmark self-check failed: parseRetryAfter");
    }
  }
}
// Pre-check outside the timed loop: the whole corpus parses to its
// hand-pinned expectations before any number is reported.
checkRetryAfterCorpus();

// ---------------------------------------------------------------------
// depositAmountFromHistory fixture: a fixed 4-shape corpus of audit
// histories, built once outside the timed loop by driving real
// escrows on the shared fixed clock (BASE_MS plus per-step offsets)
// and detaching plain copies — exactly what a persisted audit log
// looks like. Hand-pinned expectations, written out here from the
// documented semantics (the locked total is the SUM of every FUND
// entry's amount, top-ups included; a total that cannot be
// established in full is never silently treated as zero), never
// derived by calling depositAmountFromHistory itself:
//   1. single FUND — one FUND of the golden 10,630
//      (BENCH-DEPOSIT-SINGLE) -> total 10,630.
//   2. top-up sum — FUND 10,630 then a second FUND of 2,000 while
//      still FUNDED (BENCH-DEPOSIT-TOPUP, the #43 top-up shape)
//      -> total 12,630.
//   3. FUND without an amount (BENCH-DEPOSIT-NOAMT) -> throws
//      exactly "settlement requires a FUND amount for
//      BENCH-DEPOSIT-NOAMT: a FUND event was recorded without an
//      amount".
//   4. no FUND at all — the empty history (BENCH-DEPOSIT-NOFUND)
//      -> throws exactly "settlement requires a FUND amount for
//      BENCH-DEPOSIT-NOFUND: no FUND event in the audit history".
// One bench iteration runs all four shapes: the two totals are the
// steady-state scan cost, and the two fail-fast shapes pin the
// error boundary on every iteration at the same time.
// ---------------------------------------------------------------------
function depositCorpusEscrow(
  id: string,
  steps: Array<{ event: EscrowEvent; amount?: number }>,
): EscrowHistoryEntry[] {
  const escrow = new Escrow(id);
  steps.forEach(({ event, amount }, i) => {
    escrow.dispatch(event, undefined, amount, {
      at: new Date(BASE_MS + i * 1000).toISOString(),
    });
  });
  return escrow.history.map((e) => ({ ...e }));
}

const DEPOSIT_CASES: ReadonlyArray<{
  escrowId: string;
  history: EscrowHistoryEntry[];
  total?: number;
  error?: string;
}> = [
  {
    escrowId: "BENCH-DEPOSIT-SINGLE",
    history: depositCorpusEscrow("BENCH-DEPOSIT-SINGLE", [
      { event: "FUND", amount: 10630 },
    ]),
    total: 10630,
  },
  {
    escrowId: "BENCH-DEPOSIT-TOPUP",
    history: depositCorpusEscrow("BENCH-DEPOSIT-TOPUP", [
      { event: "FUND", amount: 10630 },
      { event: "FUND", amount: 2000 },
    ]),
    total: 12630,
  },
  {
    escrowId: "BENCH-DEPOSIT-NOAMT",
    history: depositCorpusEscrow("BENCH-DEPOSIT-NOAMT", [
      { event: "FUND" },
    ]),
    error:
      "settlement requires a FUND amount for BENCH-DEPOSIT-NOAMT: " +
      "a FUND event was recorded without an amount",
  },
  {
    escrowId: "BENCH-DEPOSIT-NOFUND",
    history: [],
    error:
      "settlement requires a FUND amount for BENCH-DEPOSIT-NOFUND: " +
      "no FUND event in the audit history",
  },
];

function checkDepositCorpus(): void {
  for (const c of DEPOSIT_CASES) {
    if (c.error === undefined) {
      if (depositAmountFromHistory(c.history, c.escrowId) !== c.total) {
        throw new Error(
          "benchmark self-check failed: depositAmountFromHistory total",
        );
      }
    } else {
      let thrown: unknown;
      try {
        depositAmountFromHistory(c.history, c.escrowId);
      } catch (err) {
        thrown = err;
      }
      if (!(thrown instanceof Error) || thrown.message !== c.error) {
        throw new Error(
          "benchmark self-check failed: depositAmountFromHistory error",
        );
      }
    }
  }
}
// Pre-check outside the timed loop: the whole corpus sums / fails
// to its hand-pinned expectations before any number is reported.
checkDepositCorpus();

// ---------------------------------------------------------------------
// renderReport fixture: the module-scope `report` above, built once
// outside the timed loop — the fixed golden released report
// (escrow BENCH-001, 4-entry history, deposit 10,630 = pool 10,000 +
// base 600 x1.0 - loyalty 30 + oracle 60, settled at proFeeBps 500:
// platform pro fee 531.50, creator net 10,098.50, sponsor net
// -10,630, referrer 0). renderReport is pure (it only reads the
// report), so the same report is re-rendered on every iteration.
// Hand-written expected lines, written out from the documented
// ledger layout (party label padded to 30 chars, each money column
// padded to 14 chars) and the golden figures above — never produced
// by calling renderReport itself:
//   header:  "Escrow settlement report — BENCH-001"
//   outcome: "Outcome: released (via VERIFY_PASS → RELEASE)"
//   deposit: "Deposit: $10,630.00 (pool $10,000.00 + base
//             $600.00×1 − loyalty $30.00 + oracle $60.00)"
//   creator: label "Creator (payee)", inflow $10,098.50, outflow
//            $0.00, net $10,098.50 in the 30/14/14/14 columns.
// ---------------------------------------------------------------------
const RENDER_EXPECTED_LINES: readonly string[] = [
  "Escrow settlement report — BENCH-001",
  "Outcome: released (via VERIFY_PASS → RELEASE)",
  "Deposit: $10,630.00 (pool $10,000.00 + base $600.00×1 − loyalty $30.00 + oracle $60.00)",
  "Creator (payee)                   $10,098.50         $0.00    $10,098.50",
];

function checkRenderReport(text: string): void {
  for (const line of RENDER_EXPECTED_LINES) {
    if (!text.includes(line)) {
      throw new Error("benchmark self-check failed: renderReport");
    }
  }
}
// Pre-check outside the timed loop: the rendered ledger carries
// every hand-written expected line before any number is reported.
checkRenderReport(renderReport(report));

// ---------------------------------------------------------------------
// allowedEvents fixture: every state of the transition table, in
// declaration order, with its hand-pinned expected event list
// (declaration order within each row; never derived by calling
// allowedEvents itself — read off TRANSITIONS in src/stateMachine.ts
// and cross-checked against test/stateMachine.test.ts):
//   CREATED:             FUND, EXPIRE
//   FUNDED:              FUND, SUBMIT_MILESTONE, DISPUTE, EXPIRE
//   MILESTONE_SUBMITTED: VERIFY_PASS, VERIFY_FAIL, DISPUTE, EXPIRE
//   VERIFIED:            RELEASE, DISPUTE
//   DISPUTED:            ARBITRATE_RELEASE, ARBITRATE_REFUND
//   RELEASED:            (none — terminal)
//   REFUNDED:            (none — terminal)
//   EXPIRED:             (none — terminal)
// One bench pass queries all 8 states once.
// ---------------------------------------------------------------------
const ALLOWED_EVENTS_CASES: ReadonlyArray<{
  state: EscrowState;
  expected: readonly EscrowEvent[];
}> = [
  { state: "CREATED", expected: ["FUND", "EXPIRE"] },
  {
    state: "FUNDED",
    expected: ["FUND", "SUBMIT_MILESTONE", "DISPUTE", "EXPIRE"],
  },
  {
    state: "MILESTONE_SUBMITTED",
    expected: ["VERIFY_PASS", "VERIFY_FAIL", "DISPUTE", "EXPIRE"],
  },
  { state: "VERIFIED", expected: ["RELEASE", "DISPUTE"] },
  {
    state: "DISPUTED",
    expected: ["ARBITRATE_RELEASE", "ARBITRATE_REFUND"],
  },
  { state: "RELEASED", expected: [] },
  { state: "REFUNDED", expected: [] },
  { state: "EXPIRED", expected: [] },
];

function checkAllowedEventsPass(): void {
  for (const c of ALLOWED_EVENTS_CASES) {
    const got = allowedEvents(c.state);
    if (
      got.length !== c.expected.length ||
      got.some((e, i) => e !== c.expected[i])
    ) {
      throw new Error("benchmark self-check failed: allowedEvents");
    }
  }
}
// Pre-check outside the timed loop: every state's allowed-event list
// matches its hand-pinned expectation before any number is reported.
checkAllowedEventsPass();

// ---------------------------------------------------------------------
// calculateDeposit fixture: a fixed 3-shape corpus, built once
// outside the timed loop. Expectations are hand-computed from the
// documented formula (adjustedBaseFee = round2(baseFee x
// complexityMultiplier); deposit = round2(creatorPool +
// adjustedBaseFee - loyaltyDiscount + oracleFee)) — written out as
// arithmetic here, never derived by calling calculateDeposit itself:
//   1. golden vector — pool 10,000, base 600, complexity 1.0,
//      loyalty 30, oracle 60: adjusted = 600 x 1.0 = 600;
//      deposit = 10,000 + 600 - 30 + 60 = 10,630.
//   2. complexity != 1 — pool 5,000, base 800, complexity 1.5,
//      loyalty 50, oracle 40: adjusted = 800 x 1.5 = 1,200;
//      deposit = 5,000 + 1,200 - 50 + 40 = 6,190.
//   3. large pool — pool 1,000,000, base 2,500, complexity 2.25,
//      loyalty 500, oracle 250: adjusted = 2,500 x 2.25 = 5,625;
//      deposit = 1,000,000 + 5,625 - 500 + 250 = 1,005,375.
// One bench pass runs the whole corpus (all 3 shapes).
// ---------------------------------------------------------------------
const CALCULATE_DEPOSIT_CASES: ReadonlyArray<{
  inputs: Parameters<typeof calculateDeposit>[0];
  adjustedBaseFee: number;
  deposit: number;
}> = [
  {
    inputs: {
      creatorPool: 10000,
      baseFee: 600,
      complexityMultiplier: 1.0,
      loyaltyDiscount: 30,
      oracleFee: 60,
    },
    adjustedBaseFee: 600,
    deposit: 10630,
  },
  {
    inputs: {
      creatorPool: 5000,
      baseFee: 800,
      complexityMultiplier: 1.5,
      loyaltyDiscount: 50,
      oracleFee: 40,
    },
    adjustedBaseFee: 1200,
    deposit: 6190,
  },
  {
    inputs: {
      creatorPool: 1000000,
      baseFee: 2500,
      complexityMultiplier: 2.25,
      loyaltyDiscount: 500,
      oracleFee: 250,
    },
    adjustedBaseFee: 5625,
    deposit: 1005375,
  },
];

function checkCalculateDepositCorpus(): void {
  for (const c of CALCULATE_DEPOSIT_CASES) {
    const got = calculateDeposit(c.inputs);
    if (
      got.creatorPool !== c.inputs.creatorPool ||
      got.baseFee !== c.inputs.baseFee ||
      got.complexityMultiplier !== c.inputs.complexityMultiplier ||
      got.loyaltyDiscount !== c.inputs.loyaltyDiscount ||
      got.oracleFee !== c.inputs.oracleFee ||
      got.adjustedBaseFee !== c.adjustedBaseFee ||
      got.deposit !== c.deposit
    ) {
      throw new Error("benchmark self-check failed: calculateDeposit");
    }
  }
}
// Pre-check outside the timed loop: the whole corpus computes to
// its hand-computed expectations before any number is reported.
checkCalculateDepositCorpus();

// ---------------------------------------------------------------------
// dispatchArbitration fixture: a fixed DISPUTED escrow prefix and a
// threshold-reached 5/9 quorum, both rebuilt on every iteration
// because the dispatch mutates the escrow (see the header: the
// rebuild cost is inside the timed region, so the reported number
// is a conservative lower bound on the dispatch-only throughput).
// The prefix is built once, outside the timed loop, by driving a
// real escrow on the shared fixed clock — FUND the golden 10,630
// at BASE_MS, then DISPUTE at BASE_MS + 1s — and detaching plain
// copies, exactly what a persisted audit log looks like (2 entries,
// ending DISPUTED). The quorum is rebuilt per iteration by
// `runQuorumToThreshold` above (a fresh `createQuorum` on the fixed
// clock approving dao-1..dao-5). Hand-pinned expectations, written
// from the documented arbitration semantics — never derived by
// calling dispatchArbitration itself: the call returns REFUNDED,
// the history grows by exactly one entry, and that entry is
// ARBITRATE_REFUND from DISPUTED to REFUNDED carrying the note
// "quorum 5/5" (approvalCount 5 over threshold 5, no caller note)
// at the pinned dispatch timestamp BASE_MS + 2s.
// ---------------------------------------------------------------------
const ARBITRATION_ESCROW_ID = "BENCH-ARB-001";
const ARBITRATION_AT = new Date(BASE_MS + 2000).toISOString();
const arbitrationPrefix: EscrowHistoryEntry[] = ((): EscrowHistoryEntry[] => {
  const escrow = new Escrow(ARBITRATION_ESCROW_ID);
  escrow.dispatch("FUND", undefined, DEPOSIT_AMOUNT, {
    at: new Date(BASE_MS).toISOString(),
  });
  escrow.dispatch("DISPUTE", undefined, undefined, {
    at: new Date(BASE_MS + 1000).toISOString(),
  });
  if (escrow.state !== "DISPUTED" || escrow.history.length !== 2) {
    throw new Error("benchmark fixture failed: arbitration prefix shape");
  }
  return escrow.history.map((e) => ({ ...e }));
})();

function checkDispatchArbitration(): void {
  const escrow = Escrow.fromHistory(
    ARBITRATION_ESCROW_ID,
    arbitrationPrefix.map((e) => ({ ...e })),
  );
  const quorum = runQuorumToThreshold();
  const historyBefore = escrow.history.length;
  const state = dispatchArbitration(escrow, quorum, "refund", undefined, {
    at: ARBITRATION_AT,
  });
  const last = escrow.history[escrow.history.length - 1];
  if (
    escrow.state !== "REFUNDED" ||
    state !== "REFUNDED" ||
    historyBefore !== arbitrationPrefix.length ||
    escrow.history.length !== historyBefore + 1 ||
    last.event !== "ARBITRATE_REFUND" ||
    last.from !== "DISPUTED" ||
    last.to !== "REFUNDED" ||
    last.note !== "quorum 5/5" ||
    last.at !== ARBITRATION_AT
  ) {
    throw new Error("benchmark self-check failed: dispatchArbitration");
  }
}
// Pre-check outside the timed loop: the rebuilt disputed escrow and
// threshold quorum dispatch to the hand-pinned refund outcome
// before any number is reported.
checkDispatchArbitration();

// ---------------------------------------------------------------------
// isOverdue fixture: a fixed 4-case corpus judged against one
// injected fixed instant IS_OVERDUE_NOW = BASE + 90 days (the same
// screening instant as the watchdog batch). The four escrows are
// built once, outside the timed loop, by driving real escrows on
// the shared fixed clock; `isOverdue` is pure, so the same four
// instances are re-judged on every iteration. Hand-pinned
// expectations, written from the documented semantics in
// src/stateMachine.ts — never derived by calling isOverdue
// itself (cross-checked against test/deadline.test.ts):
//   1. FUNDED, deadline BASE+30d (past)               -> true
//   2. FUNDED, deadline BASE+120d (future)            -> false
//   3. FUNDED, no deadline                            -> false
//   4. RELEASED (terminal), deadline BASE+30d (past) -> false
// One bench pass judges all 4 cases once.
// ---------------------------------------------------------------------
const IS_OVERDUE_NOW = new Date(BASE_MS + 90 * DAY_MS);
const IS_OVERDUE_CASES: ReadonlyArray<{
  escrow: Escrow;
  expected: boolean;
}> = (() => {
  const overdue = watchdogFunded(
    "BENCH-OVERDUE-001",
    BASE_MS,
    BASE_MS + 30 * DAY_MS,
  );
  const future = watchdogFunded(
    "BENCH-OVERDUE-002",
    BASE_MS,
    BASE_MS + 120 * DAY_MS,
  );
  const noDeadline = watchdogFunded("BENCH-OVERDUE-003", BASE_MS);
  const terminal = watchdogFunded(
    "BENCH-OVERDUE-004",
    BASE_MS,
    BASE_MS + 30 * DAY_MS,
  );
  terminal.dispatch("SUBMIT_MILESTONE", undefined, undefined, {
    at: isoAt(BASE_MS + 1 * DAY_MS),
  });
  terminal.dispatch("VERIFY_PASS", undefined, undefined, {
    at: isoAt(BASE_MS + 2 * DAY_MS),
  });
  terminal.dispatch("RELEASE", undefined, undefined, {
    at: isoAt(BASE_MS + 3 * DAY_MS),
  });
  if (terminal.state !== "RELEASED" || !terminal.isTerminal) {
    throw new Error("benchmark fixture failed: isOverdue terminal shape");
  }
  return [
    { escrow: overdue, expected: true },
    { escrow: future, expected: false },
    { escrow: noDeadline, expected: false },
    { escrow: terminal, expected: false },
  ];
})();

function checkIsOverdueCorpus(): void {
  for (const c of IS_OVERDUE_CASES) {
    if (isOverdue(c.escrow, IS_OVERDUE_NOW) !== c.expected) {
      throw new Error("benchmark self-check failed: isOverdue");
    }
  }
}
// Pre-check outside the timed loop: every case judges to its
// hand-pinned expectation before any number is reported.
checkIsOverdueCorpus();

// ---------------------------------------------------------------------
// assertNonNegativeMoney fixture: a fixed legal corpus and a fixed
// illegal corpus, both hand-pinned from the documented semantics in
// src/stateMachine.ts (a monetary input must be a finite,
// non-negative number; anything else throws
// `${name} must be a finite non-negative number`) — cross-checked
// against test/inputValidation.test.ts, never derived by calling
// the guard itself:
//   legal (must pass without throwing): 0, 0.01, 10630 (the golden
//     deposit), 1000000.25 (a large amount with cents)
//   illegal (must throw the exact message below, with name
//     "amount"): -1, NaN, Infinity, -Infinity, "10630" (a numeric
//     string), undefined, null
// One bench pass runs the whole legal corpus once. The illegal
// corpus is asserted ONCE, outside the timed loop (see
// checkMoneyGuardIllegalCorpus below) — only the legal branch is
// timed, so the reported number is the steady-state cost a valid
// dispatch pays, with no exception construction in the timed
// region.
// ---------------------------------------------------------------------
const MONEY_GUARD_NAME = "amount";
const MONEY_GUARD_ERROR = "amount must be a finite non-negative number";
const MONEY_GUARD_LEGAL: readonly unknown[] = [0, 0.01, 10630, 1000000.25];
const MONEY_GUARD_ILLEGAL: readonly unknown[] = [
  -1,
  NaN,
  Infinity,
  -Infinity,
  "10630",
  undefined,
  null,
];

function checkMoneyGuardLegalCorpus(): void {
  for (const value of MONEY_GUARD_LEGAL) {
    assertNonNegativeMoney(MONEY_GUARD_NAME, value);
  }
}

function checkMoneyGuardIllegalCorpus(): void {
  for (const value of MONEY_GUARD_ILLEGAL) {
    let message: string | undefined;
    try {
      assertNonNegativeMoney(MONEY_GUARD_NAME, value);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    if (message !== MONEY_GUARD_ERROR) {
      throw new Error("benchmark self-check failed: assertNonNegativeMoney");
    }
  }
}
// Pre-checks outside the timed loop: the legal corpus passes and
// every illegal value throws the exact hand-pinned message before
// any number is reported.
checkMoneyGuardLegalCorpus();
checkMoneyGuardIllegalCorpus();

// ---------------------------------------------------------------------
// transitionTableJson fixture: no input — the function exports the
// whole transition table. Expectations are hand-pinned from the
// committed snapshot test/__snapshots__/transitionTable.snapshot.json
// (cross-checked against test/transitionSnapshot.test.ts, which pins
// the same 14-edge count and trailing-newline shape), never derived
// by calling transitionTable() or transitionTableJson() itself:
//   edge count 14; first edge CREATED / FUND / FUNDED; the release
//   edge VERIFIED / RELEASE / RELEASED at index 10; last edge
//   DISPUTED / ARBITRATE_REFUND / REFUNDED; every edge's keys in the
//   pinned order from,event,to; the raw text ends with "]\n" and
//   not "]\n\n".
// ---------------------------------------------------------------------
const TRANSITION_TABLE_JSON_EDGE_COUNT = 14;
const TRANSITION_TABLE_JSON_FIRST = { from: "CREATED", event: "FUND", to: "FUNDED" };
const TRANSITION_TABLE_JSON_RELEASE_INDEX = 10;
const TRANSITION_TABLE_JSON_RELEASE = { from: "VERIFIED", event: "RELEASE", to: "RELEASED" };
const TRANSITION_TABLE_JSON_LAST = { from: "DISPUTED", event: "ARBITRATE_REFUND", to: "REFUNDED" };

function checkTransitionTableJson(): void {
  const text = transitionTableJson();
  if (!text.endsWith("]\n") || text.endsWith("]\n\n")) {
    throw new Error("benchmark self-check failed: transitionTableJson shape");
  }
  const edges = JSON.parse(text) as Array<{ from: string; event: string; to: string }>;
  const pinned = (edge: { from: string; event: string; to: string }, expected: typeof TRANSITION_TABLE_JSON_FIRST) =>
    edge.from === expected.from && edge.event === expected.event && edge.to === expected.to;
  if (
    edges.length !== TRANSITION_TABLE_JSON_EDGE_COUNT ||
    !pinned(edges[0], TRANSITION_TABLE_JSON_FIRST) ||
    !pinned(edges[TRANSITION_TABLE_JSON_RELEASE_INDEX], TRANSITION_TABLE_JSON_RELEASE) ||
    !pinned(edges[edges.length - 1], TRANSITION_TABLE_JSON_LAST) ||
    edges.some((edge) => Object.keys(edge).join(",") !== "from,event,to")
  ) {
    throw new Error("benchmark self-check failed: transitionTableJson");
  }
}
// Pre-check outside the timed loop: the export parses and matches
// every hand-pinned expectation before any number is reported.
checkTransitionTableJson();

// ---------------------------------------------------------------------
// stateDiagram fixture: no input — the function renders the whole
// transition table as a fenced Mermaid block. Expectations are
// hand-pinned from the committed snapshot
// test/__snapshots__/transitionTable.snapshot.json (14 edges) and
// test/diagram.test.ts (21 lines: 2 header lines + the start line
// + 14 edges + 3 terminal lines + the closing fence), never derived
// by calling transitionTable() or stateDiagram() itself:
//   all 14 edge lines, written out in full in declaration order;
//   the start line pins CREATED as the first declared state; the
//   terminal lines pin RELEASED / REFUNDED / EXPIRED (the states
//   with no outgoing edges, in declaration order); and all 8
//   declared states appear as a source or target of an edge line
//   or as the start / a terminal line.
// ---------------------------------------------------------------------
const STATE_DIAGRAM_EDGE_LINES: readonly string[] = [
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
];
const STATE_DIAGRAM_STATES: readonly string[] = [
  "CREATED",
  "FUNDED",
  "MILESTONE_SUBMITTED",
  "VERIFIED",
  "DISPUTED",
  "RELEASED",
  "REFUNDED",
  "EXPIRED",
];
const STATE_DIAGRAM_TERMINAL_LINES: readonly string[] = [
  "    RELEASED --> [*]",
  "    REFUNDED --> [*]",
  "    EXPIRED --> [*]",
];

function checkStateDiagram(): void {
  const lines = stateDiagram().split("\n");
  if (
    lines.length !== 21 ||
    lines[0] !== "```mermaid" ||
    lines[1] !== "stateDiagram-v2" ||
    lines[2] !== "    [*] --> CREATED" ||
    lines[lines.length - 1] !== "```"
  ) {
    throw new Error("benchmark self-check failed: stateDiagram shape");
  }
  const edgeLines = lines.slice(3, 3 + STATE_DIAGRAM_EDGE_LINES.length);
  if (
    edgeLines.length !== STATE_DIAGRAM_EDGE_LINES.length ||
    edgeLines.some((line, i) => line !== STATE_DIAGRAM_EDGE_LINES[i])
  ) {
    throw new Error("benchmark self-check failed: stateDiagram edges");
  }
  const terminalLines = lines.slice(
    3 + STATE_DIAGRAM_EDGE_LINES.length,
    3 + STATE_DIAGRAM_EDGE_LINES.length + STATE_DIAGRAM_TERMINAL_LINES.length,
  );
  if (
    terminalLines.some((line, i) => line !== STATE_DIAGRAM_TERMINAL_LINES[i])
  ) {
    throw new Error("benchmark self-check failed: stateDiagram terminals");
  }
  for (const state of STATE_DIAGRAM_STATES) {
    if (
      !edgeLines.some(
        (line) => line.startsWith(`    ${state} -->`) || line.includes(`--> ${state} `) || line.includes(`--> ${state} :`),
      ) &&
      lines[2] !== `    [*] --> ${state}` &&
      !terminalLines.includes(`    ${state} --> [*]`)
    ) {
      throw new Error("benchmark self-check failed: stateDiagram states");
    }
  }
}
// Pre-check outside the timed loop: the rendering matches every
// hand-pinned expectation before any number is reported.
checkStateDiagram();

// ---------------------------------------------------------------------
// readmeDiagramInSync fixture: no input — the checker reads this
// repo's README.md (the only file this bench reads), regenerates the
// diagram, and reports whether the exact block is embedded. The
// expectation is hand-pinned as `true` from the test suite's own
// sync assertions (test/diagram.test.ts: "README embeds the exact
// generated diagram block" and the CLI `--check` pass), never
// derived by reading the README in the bench itself.
// ---------------------------------------------------------------------
const README_DIAGRAM_IN_SYNC_EXPECTED = true;

function checkReadmeDiagramInSync(): void {
  if (readmeDiagramInSync() !== README_DIAGRAM_IN_SYNC_EXPECTED) {
    throw new Error("benchmark self-check failed: readmeDiagramInSync");
  }
}
// Pre-check outside the timed loop: the README is in sync before any
// number is reported.
checkReadmeDiagramInSync();

// ---------------------------------------------------------------------
// Subscribe fixture: one fixed collecting listener subscribed to a
// fresh escrow BEFORE any dispatch, then the escrow is driven through
// the same fixed full lifecycle as `runLifecycle()` (the LIFECYCLE
// table above: same events, amounts, and per-step timestamp offsets
// from BASE_MS).
// Hand-written expectations — written out here from the transition
// table in src/stateMachine.ts and cross-checked against
// test/subscribe.test.ts, never derived by calling subscribe itself:
//   - exactly 4 notifications, one per successful dispatch, in
//     dispatch order, with these (event, from, to) triples:
//       FUND             CREATED            -> FUNDED
//       SUBMIT_MILESTONE FUNDED             -> MILESTONE_SUBMITTED
//       VERIFY_PASS      MILESTONE_SUBMITTED -> VERIFIED
//       RELEASE          VERIFIED           -> RELEASED
//   - notification i carries the audit entry appended by dispatch i:
//     its seq is i + 1 and every recorded field (event, from, to,
//     at, actor, note, amount, evidence, hash-chain links) equals
//     history[i] field for field;
//   - the escrow has exactly 1 listener while subscribed.
// ---------------------------------------------------------------------
const SUBSCRIBE_EXPECTED: Array<{
  event: EscrowEvent;
  from: EscrowState;
  to: EscrowState;
}> = [
  { event: "FUND", from: "CREATED", to: "FUNDED" },
  { event: "SUBMIT_MILESTONE", from: "FUNDED", to: "MILESTONE_SUBMITTED" },
  { event: "VERIFY_PASS", from: "MILESTONE_SUBMITTED", to: "VERIFIED" },
  { event: "RELEASE", from: "VERIFIED", to: "RELEASED" },
];
type SubscribeNotification = {
  event: EscrowEvent;
  from: EscrowState;
  to: EscrowState;
  entry: EscrowHistoryEntry;
};
function runSubscribedLifecycle(): {
  escrow: Escrow;
  notifications: SubscribeNotification[];
} {
  const escrow = new Escrow("BENCH-SUB-001");
  const notifications: SubscribeNotification[] = [];
  escrow.subscribe((event, from, to, entry) => {
    notifications.push({ event, from, to, entry });
  });
  LIFECYCLE.forEach(({ event, amount }, i) => {
    escrow.dispatch(event, undefined, amount, {
      at: new Date(BASE_MS + i * 1000).toISOString(),
    });
  });
  return { escrow, notifications };
}
function checkSubscribe(
  escrow: Escrow,
  notifications: SubscribeNotification[],
  where: string,
): void {
  if (
    escrow.state !== "RELEASED" ||
    escrow.listenerCount !== 1 ||
    escrow.history.length !== SUBSCRIBE_EXPECTED.length ||
    notifications.length !== SUBSCRIBE_EXPECTED.length
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
  for (let i = 0; i < SUBSCRIBE_EXPECTED.length; i++) {
    const n = notifications[i];
    const expected = SUBSCRIBE_EXPECTED[i];
    const entry = escrow.history[i];
    if (
      n.event !== expected.event ||
      n.from !== expected.from ||
      n.to !== expected.to ||
      n.entry.seq !== i + 1 ||
      n.entry.event !== entry.event ||
      n.entry.from !== entry.from ||
      n.entry.to !== entry.to ||
      n.entry.at !== entry.at ||
      n.entry.actor !== entry.actor ||
      n.entry.note !== entry.note ||
      n.entry.amount !== entry.amount ||
      n.entry.evidence !== entry.evidence ||
      n.entry.prevHash !== entry.prevHash ||
      n.entry.hash !== entry.hash
    ) {
      throw new Error(`benchmark self-check failed: ${where}`);
    }
  }
}
// One-time validation (outside the timed loop): a subscribed
// lifecycle produces exactly the hand-written notification
// sequence, entry for entry against the escrow's history.
{
  const { escrow, notifications } = runSubscribedLifecycle();
  checkSubscribe(escrow, notifications, "subscribe fixture");
}
// One-time unsubscribe validation (outside the timed loop): after
// unsubscribe, a further successful dispatch notifies nobody —
// the count stays at the 1 notification collected before it,
// while the escrow itself still moves (hand-written expectations
// from test/subscribe.test.ts: unsubscribe stops delivery and is
// idempotent).
{
  const escrow = new Escrow("BENCH-SUB-002");
  let count = 0;
  const unsubscribe = escrow.subscribe(() => {
    count++;
  });
  escrow.dispatch("FUND", undefined, DEPOSIT_AMOUNT, {
    at: new Date(BASE_MS).toISOString(),
  });
  unsubscribe();
  unsubscribe();
  escrow.dispatch("SUBMIT_MILESTONE", undefined, undefined, {
    at: new Date(BASE_MS + 1000).toISOString(),
  });
  if (
    count !== 1 ||
    escrow.listenerCount !== 0 ||
    escrow.state !== "MILESTONE_SUBMITTED" ||
    escrow.history.length !== 2
  ) {
    throw new Error("benchmark self-check failed: subscribe unsubscribe");
  }
}
// One-time isolation validation (outside the timed loop): a
// throwing listener neither breaks the dispatch nor starves its
// peer — the dispatch returns the new state, the audit entry is
// appended, and the peer still receives the notification
// (hand-written expectations from test/subscribe.test.ts).
{
  const escrow = new Escrow("BENCH-SUB-003");
  const seen: string[] = [];
  escrow.subscribe(() => {
    throw new Error("bench: bad fan-out consumer");
  });
  escrow.subscribe(() => {
    seen.push("peer");
  });
  const to = escrow.dispatch("FUND", undefined, DEPOSIT_AMOUNT, {
    at: new Date(BASE_MS).toISOString(),
  });
  if (
    to !== "FUNDED" ||
    escrow.history.length !== 1 ||
    escrow.history[0].event !== "FUND" ||
    seen.length !== 1
  ) {
    throw new Error("benchmark self-check failed: subscribe isolation");
  }
}

// ---------------------------------------------------------------------
// Scenarios (each with a self-check so a broken path cannot report a
// plausible-looking number).
// ---------------------------------------------------------------------
function benchDispatchLifecycle(): number {
  return measure(() => {
    const escrow = runLifecycle();
    if (escrow.state !== "RELEASED") {
      throw new Error("benchmark self-check failed: dispatch lifecycle");
    }
  }, ITERATIONS);
}

// Replay self-checks (outside the timed loop): a rebuild from the
// full fixture must reproduce the original escrow's state and history
// exactly, and a rebuild from the fixture's 3-entry VERIFIED prefix
// must accept the fixture's own RELEASE step with no seq gap,
// landing byte-identical to the full fixture.
{
  const rebuilt = Escrow.fromHistory(releasedEscrow.id, historyFixture);
  if (
    rebuilt.state !== releasedEscrow.state ||
    rebuilt.history.length !== historyFixture.length ||
    historyToNdjson(rebuilt.history) !== historyToNdjson(historyFixture)
  ) {
    throw new Error("benchmark fixture failed: fromHistory rebuild mismatch");
  }
  const continued = Escrow.fromHistory(
    releasedEscrow.id,
    historyFixture.slice(0, 3),
  );
  if (continued.state !== "VERIFIED" || continued.history.length !== 3) {
    throw new Error("benchmark fixture failed: fromHistory prefix shape");
  }
  continued.dispatch("RELEASE", undefined, undefined, {
    at: new Date(BASE_MS + 3 * 1000).toISOString(),
  });
  const continuedState: string = continued.state;
  const continuedLength: number = continued.history.length;
  if (
    continuedState !== "RELEASED" ||
    continuedLength !== 4 ||
    continued.history[3].seq !== 4 ||
    historyToNdjson(continued.history) !== historyToNdjson(historyFixture)
  ) {
    throw new Error("benchmark fixture failed: fromHistory continuation gap");
  }
}

function benchFromHistory(): number {
  return measure(() => {
    const rebuilt = Escrow.fromHistory(releasedEscrow.id, historyFixture);
    if (
      rebuilt.state !== "RELEASED" ||
      rebuilt.history.length !== historyFixture.length
    ) {
      throw new Error("benchmark self-check failed: Escrow.fromHistory");
    }
  }, ITERATIONS);
}

function benchVerifyHistoryChain(): number {
  return measure(() => {
    if (!verifyHistoryChain(historyFixture)) {
      throw new Error("benchmark self-check failed: verifyHistoryChain");
    }
  }, ITERATIONS);
}

function benchBuildSettlementReport(): number {
  return measure(() => {
    const built = buildSettlementReport({
      escrowId: releasedEscrow.id,
      history: historyFixture,
      finalState: "RELEASED",
      deposit,
      settlement: { proFeeBps: 500 },
    });
    if (!built.balanced) {
      throw new Error("benchmark self-check failed: buildSettlementReport");
    }
  }, ITERATIONS);
}

function benchRenderReport(): number {
  return measure(() => {
    checkRenderReport(renderReport(report));
  }, ITERATIONS);
}

function benchDepositAmountFromHistory(): number {
  return measure(() => {
    checkDepositCorpus();
  }, ITERATIONS);
}

function benchBuildSettlementReports(): number {
  return measure(() => {
    checkBatchResults(buildSettlementReports(batchInputs));
  }, ITERATIONS);
}

function benchSummarizeSettlementReports(): number {
  return measure(() => {
    checkBatchSummary(summarizeSettlementReports(batchResults));
  }, ITERATIONS);
}

function benchBuildSettlementWebhooks(): number {
  return measure(() => {
    checkBatchWebhooks(
      buildSettlementWebhooks(batchResults, {
        secret: WEBHOOK_SECRET,
        now: WEBHOOK_NOW,
        eventIdFactory: batchWebhookEventIdFactory(),
      }),
    );
  }, ITERATIONS);
}

function benchBuildSettlementWebhook(): number {
  return measure(() => {
    const built = buildSettlementWebhook(report, {
      secret: WEBHOOK_SECRET,
      now: WEBHOOK_NOW,
      eventId: WEBHOOK_EVENT_ID,
    });
    if (built.signature !== webhook.signature) {
      throw new Error("benchmark self-check failed: buildSettlementWebhook");
    }
  }, ITERATIONS);
}

function benchVerifySettlementWebhook(): number {
  return measure(() => {
    if (!verifySettlementWebhook(webhookBody, webhook.signature, WEBHOOK_SECRET)) {
      throw new Error("benchmark self-check failed: verifySettlementWebhook");
    }
  }, ITERATIONS);
}

function benchParseRetryAfter(): number {
  return measure(() => {
    checkRetryAfterCorpus();
  }, ITERATIONS);
}

function benchHistoryToNdjson(): number {
  return measure(() => {
    if (historyToNdjson(ndjsonHistoryFixture) !== ndjsonFixture) {
      throw new Error("benchmark self-check failed: historyToNdjson");
    }
  }, ITERATIONS);
}

function benchQuorumApproveToThreshold(): number {
  return measure(() => {
    const quorum = runQuorumToThreshold();
    if (!quorum.hasQuorum() || quorum.approvalCount() !== QUORUM_THRESHOLD) {
      throw new Error("benchmark self-check failed: quorum approve to threshold");
    }
  }, ITERATIONS);
}

function benchRestoreQuorum(): number {
  return measure(() => {
    checkRestoredQuorum(restoreQuorum(RESTORE_CONFIG, restorePersisted));
  }, ITERATIONS);
}

async function benchDeliverSettlementWebhookToMany(): Promise<number> {
  return measureAsync(async () => {
    await runFanout();
  }, ITERATIONS);
}

function benchSettlementEventDedupe(): number {
  const hitsBefore = dedupe.stats().hits;
  const ops = measure(() => {
    const id = dedupeIds[dedupeCursor];
    dedupeCursor = (dedupeCursor + 1) % dedupeIds.length;
    if (!dedupe.checkAndRecord(id)) {
      throw new Error("benchmark self-check failed: SettlementEventDedupe hit");
    }
  }, ITERATIONS);
  // Stats consistency across the timed loop: every warmup + timed
  // call was a duplicate hit on a pre-recorded id, nothing else.
  const after = dedupe.stats();
  if (
    after.hits !== hitsBefore + WARMUP + ITERATIONS ||
    after.misses !== DEDUPE_PREFILL + 1 ||
    after.evictions !== 0 ||
    after.size !== DEDUPE_PREFILL + 1
  ) {
    throw new Error("benchmark self-check failed: SettlementEventDedupe stats");
  }
  return ops;
}

function benchSettlementEventDedupeRestore(): number {
  return measure(() => {
    const restored = SettlementEventDedupe.restore(dedupeRestoreSnapshot, {
      now: () => DEDUPE_RESTORE_NOW_MS,
    });
    // Per-iteration self-check against the hand-written
    // expectations above: the restore kept all 1,000 entries, the
    // observability counters restarted at zero, and the first /
    // middle / last snapshot ids are all duplicates (3 hits). The
    // exhaustive all-ids check runs once, outside the timed loop,
    // in the fixture validation.
    const fresh = restored.stats();
    if (
      fresh.size !== DEDUPE_RESTORE_PREFILL ||
      fresh.hits !== 0 ||
      fresh.misses !== 0 ||
      fresh.evictions !== 0 ||
      !restored.checkAndRecord(dedupeRestoreIds[0]) ||
      !restored.checkAndRecord(
        dedupeRestoreIds[DEDUPE_RESTORE_PREFILL / 2],
      ) ||
      !restored.checkAndRecord(
        dedupeRestoreIds[DEDUPE_RESTORE_PREFILL - 1],
      ) ||
      restored.stats().hits !== 3
    ) {
      throw new Error(
        "benchmark self-check failed: SettlementEventDedupe restore",
      );
    }
  }, ITERATIONS);
}

function benchHistoryFromNdjson(): number {
  return measure(() => {
    const entries = historyFromNdjson(ndjsonFixture);
    if (
      entries.length !== 8 ||
      entries[7].to !== "RELEASED" ||
      historyToNdjson(entries) !== ndjsonFixture
    ) {
      throw new Error("benchmark self-check failed: historyFromNdjson");
    }
  }, ITERATIONS);
}


// ---------------------------------------------------------------------
// settleRelease fixture: 4 fixed representative settlement inputs.
// Hand-computed expectations (formula: proFee = round2(gross *
// proFeeBps / 10000); net = round2(gross - proFee - referralCredits);
// expectations written by hand here, never re-derived through
// settleRelease itself — the same hand-calc tradition as the golden
// 10630 deposit and the economicsRounding tests):
//   1. golden case: gross 10630, 500 bps (the case study's 5%),
//      no credits -> proFee 531.50, net 10098.50.
//   2. mid-size with credits: gross 1000, 500 bps, credits 100
//      -> proFee 50, net 850.
//   3. large gross: gross 1000000, 250 bps, credits 1250.25
//      -> proFee 25000, net 973749.75.
//   4. half-cent rounding edge: gross 10, 125 bps, no credits
//      -> proFee round2(0.125) = 0.13 (half rounds up), net 9.87.
// ---------------------------------------------------------------------
const SETTLE_RELEASE_CASES: ReadonlyArray<{
  inputs: SettlementInputs;
  proFee: number;
  net: number;
}> = [
  { inputs: { gross: 10630, proFeeBps: 500 }, proFee: 531.5, net: 10098.5 },
  {
    inputs: { gross: 1000, proFeeBps: 500, referralCredits: 100 },
    proFee: 50,
    net: 850,
  },
  {
    inputs: { gross: 1000000, proFeeBps: 250, referralCredits: 1250.25 },
    proFee: 25000,
    net: 973749.75,
  },
  { inputs: { gross: 10, proFeeBps: 125 }, proFee: 0.13, net: 9.87 },
];

function checkSettleReleaseCase(
  result: { gross: number; proFee: number; referralCredits: number; net: number },
  expected: (typeof SETTLE_RELEASE_CASES)[number],
): void {
  if (
    result.gross !== expected.inputs.gross ||
    result.proFee !== expected.proFee ||
    result.referralCredits !== (expected.inputs.referralCredits ?? 0) ||
    result.net !== expected.net ||
    result.net + result.proFee + result.referralCredits !== result.gross
  ) {
    throw new Error("benchmark self-check failed: settleRelease");
  }
}

// Pre-check outside timing: every fixture case nets to its
// hand-written expectation before any number is reported.
for (const c of SETTLE_RELEASE_CASES) {
  checkSettleReleaseCase(settleRelease(c.inputs), c);
}

function benchSettleRelease(): number {
  return measure(() => {
    for (const c of SETTLE_RELEASE_CASES) {
      checkSettleReleaseCase(settleRelease(c.inputs), c);
    }
  }, ITERATIONS);
}

function benchExpiredEscrows(): number {
  return measure(() => {
    checkWatchdogIds(
      expiredEscrows(watchdogBatch, WATCHDOG_NOW),
      WATCHDOG_EXPIRED_IDS,
      "expiredEscrows",
    );
  }, ITERATIONS);
}

function benchStaleEscrows(): number {
  return measure(() => {
    checkWatchdogIds(
      staleEscrows(watchdogBatch, WATCHDOG_BUDGETS, WATCHDOG_NOW),
      WATCHDOG_STALE_IDS,
      "staleEscrows",
    );
  }, ITERATIONS);
}

function benchExpireOverdueEscrows(): number {
  return measure(() => {
    // Fresh fixture per iteration: the executor dispatches EXPIRE on
    // the escrows it expires, so no batch can be reused across calls.
    // The rebuild cost is inside the timed region (see the header).
    const batch = buildWatchdogBatch();
    checkExpireOverdueResults(
      expireOverdueEscrows(batch, WATCHDOG_NOW),
      "expireOverdueEscrows",
    );
  }, ITERATIONS);
}

function benchActOnStaleEscrows(): number {
  return measure(() => {
    // Fresh fixture per iteration, same reason as above: the action
    // dispatches EXPIRE on every stale escrow it can act on.
    const batch = buildWatchdogBatch();
    checkActOnStaleResults(
      actOnStaleEscrows(
        batch,
        (e) => e.dispatch("EXPIRE"),
        WATCHDOG_BUDGETS,
        WATCHDOG_NOW,
      ),
      "actOnStaleEscrows",
    );
  }, ITERATIONS);
}

function benchAllowedEvents(): number {
  return measure(() => {
    checkAllowedEventsPass();
  }, ITERATIONS);
}

function benchCalculateDeposit(): number {
  return measure(() => {
    checkCalculateDepositCorpus();
  }, ITERATIONS);
}

function benchDispatchArbitration(): number {
  return measure(() => {
    checkDispatchArbitration();
  }, ITERATIONS);
}

function benchIsOverdue(): number {
  return measure(() => {
    checkIsOverdueCorpus();
  }, ITERATIONS);
}

function benchAssertNonNegativeMoney(): number {
  return measure(() => {
    checkMoneyGuardLegalCorpus();
  }, ITERATIONS);
}

function benchTransitionTableJson(): number {
  return measure(() => {
    checkTransitionTableJson();
  }, ITERATIONS);
}

function benchStateDiagram(): number {
  return measure(() => {
    checkStateDiagram();
  }, ITERATIONS);
}

function benchReadmeDiagramInSync(): number {
  return measure(() => {
    checkReadmeDiagramInSync();
  }, ITERATIONS);
}

function benchSubscribe(): number {
  return measure(() => {
    // Fresh escrow per iteration: dispatch mutates the escrow, so no
    // subscribed lifecycle can be reused across calls. The
    // fixture rebuild cost is inside the timed region.
    // Per-iteration self-check: the notification sequence matches
    // the hand-written expectations and the escrow's own history,
    // entry for entry (see the fixture above).
    const { escrow, notifications } = runSubscribedLifecycle();
    checkSubscribe(escrow, notifications, "subscribe");
  }, ITERATIONS);
}

console.log("escrow-state-machine-ts benchmark");
console.log(`Node: ${process.version} on ${process.platform}/${process.arch}`);
console.log(`CPU: ${cpus()[0]?.model ?? "unknown"}`);
console.log(
  "Fixture: one escrow, full CREATED -> RELEASED lifecycle (4 hash-chained audit entries), golden deposit 10630; settlement webhook HMAC-SHA256 with fixed secret/timestamp/eventId; batch of 4 settlement-report inputs (released/refunded/released, 4 entries each, plus 1 mismatched input expected to land as a per-item error); settlement batch summary over that batch's 4 pre-built results (3 reports + 1 error); settlement batch webhooks over that same batch (3 signed webhooks with distinct deterministic eventIds bench-batch-event-1..3 plus the 1 forwarded per-item error); NDJSON text exported from a fixed 8-entry staged-funding history (5 FUND dispatches summing to 10630, then milestone/verify/release); quorum of 9 signers with threshold 5 on a fixed injected clock, approved one vote at a time to the threshold; settlement webhook fan-out to 4 endpoints through a fake global fetch (immediate 200, no network); settlement event dedupe duplicate hits cycling over 1,000 pre-recorded eventIds under a fixed injected clock; settlement event dedupe restore from a 1,000-entry JSON-round-tripped snapshot under a fixed injected clock (all entries live at load, default TTL and capacity, observability counters restarting at zero); Escrow.fromHistory replay over the same detached 4-entry history; watchdog screening over a fixed mixed batch of 100 escrows (40 hand-counted expired, 70 hand-counted stale under FUNDED 7d / MILESTONE_SUBMITTED 30d budgets) at a fixed screening instant; watchdog execution (expireOverdueEscrows / actOnStaleEscrows with an EXPIRE-dispatch action) over fresh rebuilds of that same 100-escrow batch on every iteration because the executors mutate their inputs (40 of 40 expire attempts and 70 of 70 stale actions succeed — both selected states carry an EXPIRE edge); quorum snapshot restore from a persisted (JSON round-tripped) snapshot of the 9-signer / threshold-5 quorum carrying 7 recorded approvals; settleRelease netting over 4 fixed representative inputs (golden 10630 at 500 bps, 1000 at 500 bps with 100 credits, large gross 1000000 at 250 bps with 1250.25 credits, rounding edge 10 at 125 bps) checked against hand-computed proFee/net on every iteration; parseRetryAfter over a fixed 11-value corpus (delay-seconds, fractional and whitespace-padded values, zero, future and past HTTP-dates, signed numbers, a garbage string, null and undefined) against one injected fixed now, every result checked against hand-pinned expectations on every iteration; depositAmountFromHistory over a fixed 4-shape corpus (a single FUND of the golden 10630, a two-FUND top-up sequence summing to 12630, a FUND recorded without an amount, and an empty no-FUND history) checked against hand-pinned totals and exact fail-fast error messages on every iteration; renderReport rendering of the fixed golden released report (deposit 10630, released via VERIFY_PASS -> RELEASE, 4 party rows) checked against hand-written expected lines (header/outcome, deposit formula, creator net row) on every iteration; allowedEvents over all 8 states of the transition table (one pass = every state queried once in declaration order — CREATED, FUNDED, MILESTONE_SUBMITTED, VERIFIED, DISPUTED, RELEASED, REFUNDED, EXPIRED — with each result checked against its hand-pinned expected event list in declaration order, the three terminal states expecting the empty list) on every iteration; calculateDeposit over a fixed 3-shape corpus (the golden vector pool 10000 / base 600 / complexity 1.0 / loyalty 30 / oracle 60 -> deposit 10630, a complexity 1.5 case -> deposit 6190, and a large-pool 1000000 case -> deposit 1005375) checked against hand-computed adjustedBaseFee and deposit expectations on every iteration; arbitration dispatch (dispatchArbitration with outcome \"refund\", rebuilding a DISPUTED escrow from its fixed 2-entry history prefix via Escrow.fromHistory and a threshold-reached 5/9 quorum via createQuorum on every iteration — rebuild cost inside the timed region — pinned to a fixed audit timestamp, checked for the REFUNDED terminal state, exactly one appended ARBITRATE_REFUND entry, and its \"quorum 5/5\" note on every iteration; isOverdue over a fixed 4-case corpus (past-deadline FUNDED, future-deadline FUNDED, deadline-less FUNDED, and past-deadline terminal RELEASED escrows) checked against hand-pinned booleans (true/false/false/false) against one injected fixed now on every iteration; assertNonNegativeMoney over a fixed legal corpus (0, 0.01, the golden 10630, and 1000000.25) checked to pass without throwing on every iteration, with the illegal corpus (negative, NaN, Infinity, -Infinity, a numeric string, undefined, and null — each throwing the exact message \"amount must be a finite non-negative number\") asserted once outside the timed loop and never timed); transitionTableJson (fixed no-arg transition-table JSON export, parsed back and checked against hand-pinned expectations — 14 edges, first CREATED/FUND/FUNDED, release edge VERIFIED/RELEASE/RELEASED at index 10, last DISPUTED/ARBITRATE_REFUND/REFUNDED, per-edge key order from,event,to, and a single trailing newline — on every iteration); stateDiagram (fixed no-arg Mermaid rendering, checked against hand-pinned expectations — 21 lines, all 14 edge lines written out in full in declaration order, the start line pinning CREATED, the 3 terminal lines RELEASED/REFUNDED/EXPIRED, and all 8 states present — on every iteration); readmeDiagramInSync (fixed no-arg README diagram sync check — reads only this repo's README.md, regenerates the diagram, and checks the exact block is embedded, checked against the hand-pinned expectation true on every iteration); subscribe (full lifecycle, 1 collecting listener) over the same full 4-dispatch lifecycle on a fresh escrow per iteration, self-checked per iteration against the hand-written (event, from, to) sequence and the escrow's own history entry for entry, with unsubscribe and throwing-listener isolation checks outside the timed loop",
);
console.log(`Iterations per op: ${ITERATIONS} (after ${WARMUP} warmup)`);
console.log("");

const results: Array<{ path: string; ops: number }> = [
  { path: "dispatch (full lifecycle, 4 dispatches)", ops: benchDispatchLifecycle() },
  { path: "verifyHistoryChain (4 entries)", ops: benchVerifyHistoryChain() },
  { path: "Escrow.fromHistory (4 entries)", ops: benchFromHistory() },
  { path: "settleRelease (4 fixed inputs)", ops: benchSettleRelease() },
  { path: "buildSettlementReport (4 entries)", ops: benchBuildSettlementReport() },
  { path: "renderReport (released report, 4 parties)", ops: benchRenderReport() },
  { path: "depositAmountFromHistory (4-shape corpus)", ops: benchDepositAmountFromHistory() },
  { path: "buildSettlementReports (batch 4 x 4 entries)", ops: benchBuildSettlementReports() },
  { path: "summarizeSettlementReports (batch 4 results)", ops: benchSummarizeSettlementReports() },
  { path: "buildSettlementWebhooks (batch 4 results)", ops: benchBuildSettlementWebhooks() },
  { path: "buildSettlementWebhook (sign)", ops: benchBuildSettlementWebhook() },
  { path: "verifySettlementWebhook", ops: benchVerifySettlementWebhook() },
  { path: "parseRetryAfter (11-value corpus)", ops: benchParseRetryAfter() },
  { path: "historyToNdjson (8 entries)", ops: benchHistoryToNdjson() },
  { path: "historyFromNdjson (8 entries, chain re-verify)", ops: benchHistoryFromNdjson() },
  { path: "quorum approve to threshold (5 of 9)", ops: benchQuorumApproveToThreshold() },
  { path: "restoreQuorum (snapshot, 7 approvals of 9)", ops: benchRestoreQuorum() },
  { path: "deliverSettlementWebhookToMany (4 endpoints)", ops: await benchDeliverSettlementWebhookToMany() },
  { path: "SettlementEventDedupe checkAndRecord (hit, 1k)", ops: benchSettlementEventDedupe() },
  { path: "SettlementEventDedupe.restore (1,000-entry snapshot)", ops: benchSettlementEventDedupeRestore() },
  { path: "expiredEscrows (batch 100 escrows)", ops: benchExpiredEscrows() },
  { path: "staleEscrows (batch 100 escrows)", ops: benchStaleEscrows() },
  { path: "expireOverdueEscrows (batch 100 escrows)", ops: benchExpireOverdueEscrows() },
  { path: "actOnStaleEscrows (batch 100 escrows)", ops: benchActOnStaleEscrows() },
  { path: "allowedEvents (all 8 states)", ops: benchAllowedEvents() },
  { path: "calculateDeposit (3-shape corpus)", ops: benchCalculateDeposit() },
  { path: "dispatchArbitration (refund, rebuilt fixture)", ops: benchDispatchArbitration() },
  { path: "isOverdue (4-case corpus)", ops: benchIsOverdue() },
  { path: "assertNonNegativeMoney (legal corpus)", ops: benchAssertNonNegativeMoney() },
  { path: "transitionTableJson (14 edges)", ops: benchTransitionTableJson() },
  { path: "stateDiagram (14 edges, 21 lines)", ops: benchStateDiagram() },
  { path: "readmeDiagramInSync (README sync check)", ops: benchReadmeDiagramInSync() },
  { path: "subscribe (full lifecycle, 1 collecting listener)", ops: benchSubscribe() },
];

console.log("path                                              throughput");
console.log("---------------------------------------------------------------------");
for (const r of results) {
  console.log(`${r.path.padEnd(50)} ${fmt(r.ops)}`);
}
console.log("");
console.log("Numbers are machine-local measurements, not guarantees.");
