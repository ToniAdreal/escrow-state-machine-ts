/**
 * Local micro-benchmark for the escrow-state-machine-ts state machine.
 *
 * Measures real, locally-observed throughput for the four hot paths a
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
 *      signed body.
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
  buildSettlementWebhook,
  calculateDeposit,
  Escrow,
  verifyHistoryChain,
  verifySettlementWebhook,
  type EscrowEvent,
  type EscrowHistoryEntry,
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
const webhook = buildSettlementWebhook(report, {
  secret: WEBHOOK_SECRET,
  now: WEBHOOK_NOW,
  eventId: WEBHOOK_EVENT_ID,
});
const webhookBody = JSON.stringify(webhook.payload);
if (!verifySettlementWebhook(webhookBody, webhook.signature, WEBHOOK_SECRET)) {
  throw new Error("benchmark fixture failed: webhook does not verify");
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

console.log("escrow-state-machine-ts benchmark");
console.log(`Node: ${process.version} on ${process.platform}/${process.arch}`);
console.log(`CPU: ${cpus()[0]?.model ?? "unknown"}`);
console.log(
  "Fixture: one escrow, full CREATED -> RELEASED lifecycle (4 hash-chained audit entries), golden deposit 10630; settlement webhook HMAC-SHA256 with fixed secret/timestamp/eventId",
);
console.log(`Iterations per op: ${ITERATIONS} (after ${WARMUP} warmup)`);
console.log("");

const results: Array<{ path: string; ops: number }> = [
  { path: "dispatch (full lifecycle, 4 dispatches)", ops: benchDispatchLifecycle() },
  { path: "verifyHistoryChain (4 entries)", ops: benchVerifyHistoryChain() },
  { path: "buildSettlementReport (4 entries)", ops: benchBuildSettlementReport() },
  { path: "buildSettlementWebhook (sign)", ops: benchBuildSettlementWebhook() },
  { path: "verifySettlementWebhook", ops: benchVerifySettlementWebhook() },
];

console.log("path                                      throughput");
console.log("-------------------------------------------------------------");
for (const r of results) {
  console.log(`${r.path.padEnd(42)} ${fmt(r.ops)}`);
}
console.log("");
console.log("Numbers are machine-local measurements, not guarantees.");
