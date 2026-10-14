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
  buildSettlementReport,
  buildSettlementReports,
  buildSettlementWebhook,
  buildSettlementWebhooks,
  calculateDeposit,
  createQuorum,
  deliverSettlementWebhookToMany,
  Escrow,
  historyFromNdjson,
  historyToNdjson,
  SettlementEventDedupe,
  summarizeSettlementReports,
  verifyHistoryChain,
  verifySettlementWebhook,
  type EscrowEvent,
  type EscrowHistoryEntry,
  type Quorum,
  type SettlementReportInputs,
  type SettlementWebhookEndpoint,
} from "../src/index.js";

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

console.log("escrow-state-machine-ts benchmark");
console.log(`Node: ${process.version} on ${process.platform}/${process.arch}`);
console.log(`CPU: ${cpus()[0]?.model ?? "unknown"}`);
console.log(
  "Fixture: one escrow, full CREATED -> RELEASED lifecycle (4 hash-chained audit entries), golden deposit 10630; settlement webhook HMAC-SHA256 with fixed secret/timestamp/eventId; batch of 4 settlement-report inputs (released/refunded/released, 4 entries each, plus 1 mismatched input expected to land as a per-item error); settlement batch summary over that batch's 4 pre-built results (3 reports + 1 error); settlement batch webhooks over that same batch (3 signed webhooks with distinct deterministic eventIds bench-batch-event-1..3 plus the 1 forwarded per-item error); NDJSON text exported from a fixed 8-entry staged-funding history (5 FUND dispatches summing to 10630, then milestone/verify/release); quorum of 9 signers with threshold 5 on a fixed injected clock, approved one vote at a time to the threshold; settlement webhook fan-out to 4 endpoints through a fake global fetch (immediate 200, no network); settlement event dedupe duplicate hits cycling over 1,000 pre-recorded eventIds under a fixed injected clock; Escrow.fromHistory replay over the same detached 4-entry history",
);
console.log(`Iterations per op: ${ITERATIONS} (after ${WARMUP} warmup)`);
console.log("");

const results: Array<{ path: string; ops: number }> = [
  { path: "dispatch (full lifecycle, 4 dispatches)", ops: benchDispatchLifecycle() },
  { path: "verifyHistoryChain (4 entries)", ops: benchVerifyHistoryChain() },
  { path: "Escrow.fromHistory (4 entries)", ops: benchFromHistory() },
  { path: "buildSettlementReport (4 entries)", ops: benchBuildSettlementReport() },
  { path: "buildSettlementReports (batch 4 x 4 entries)", ops: benchBuildSettlementReports() },
  { path: "summarizeSettlementReports (batch 4 results)", ops: benchSummarizeSettlementReports() },
  { path: "buildSettlementWebhooks (batch 4 results)", ops: benchBuildSettlementWebhooks() },
  { path: "buildSettlementWebhook (sign)", ops: benchBuildSettlementWebhook() },
  { path: "verifySettlementWebhook", ops: benchVerifySettlementWebhook() },
  { path: "historyToNdjson (8 entries)", ops: benchHistoryToNdjson() },
  { path: "historyFromNdjson (8 entries, chain re-verify)", ops: benchHistoryFromNdjson() },
  { path: "quorum approve to threshold (5 of 9)", ops: benchQuorumApproveToThreshold() },
  { path: "deliverSettlementWebhookToMany (4 endpoints)", ops: await benchDeliverSettlementWebhookToMany() },
  { path: "SettlementEventDedupe checkAndRecord (hit, 1k)", ops: benchSettlementEventDedupe() },
];

console.log("path                                              throughput");
console.log("---------------------------------------------------------------------");
for (const r of results) {
  console.log(`${r.path.padEnd(50)} ${fmt(r.ops)}`);
}
console.log("");
console.log("Numbers are machine-local measurements, not guarantees.");
