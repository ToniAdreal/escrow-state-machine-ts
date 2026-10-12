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
 *      comparably to the dataquest lifecycle's 8-entry NDJSON bench.
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
  calculateDeposit,
  Escrow,
  historyFromNdjson,
  historyToNdjson,
  verifyHistoryChain,
  verifySettlementWebhook,
  type EscrowEvent,
  type EscrowHistoryEntry,
  type SettlementReportInputs,
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

function measure(fn: () => void, iterations: number): number {
  for (let i = 0; i < WARMUP; i++) fn(); // warmup: JIT, module caches
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
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
  "Fixture: one escrow, full CREATED -> RELEASED lifecycle (4 hash-chained audit entries), golden deposit 10630; settlement webhook HMAC-SHA256 with fixed secret/timestamp/eventId; batch of 4 settlement-report inputs (released/refunded/released, 4 entries each, plus 1 mismatched input expected to land as a per-item error); NDJSON text exported from a fixed 8-entry staged-funding history (5 FUND dispatches summing to 10630, then milestone/verify/release)",
);
console.log(`Iterations per op: ${ITERATIONS} (after ${WARMUP} warmup)`);
console.log("");

const results: Array<{ path: string; ops: number }> = [
  { path: "dispatch (full lifecycle, 4 dispatches)", ops: benchDispatchLifecycle() },
  { path: "verifyHistoryChain (4 entries)", ops: benchVerifyHistoryChain() },
  { path: "buildSettlementReport (4 entries)", ops: benchBuildSettlementReport() },
  { path: "buildSettlementReports (batch 4 x 4 entries)", ops: benchBuildSettlementReports() },
  { path: "buildSettlementWebhook (sign)", ops: benchBuildSettlementWebhook() },
  { path: "verifySettlementWebhook", ops: benchVerifySettlementWebhook() },
  { path: "historyToNdjson (8 entries)", ops: benchHistoryToNdjson() },
  { path: "historyFromNdjson (8 entries, chain re-verify)", ops: benchHistoryFromNdjson() },
];

console.log("path                                              throughput");
console.log("---------------------------------------------------------------------");
for (const r of results) {
  console.log(`${r.path.padEnd(50)} ${fmt(r.ops)}`);
}
console.log("");
console.log("Numbers are machine-local measurements, not guarantees.");
