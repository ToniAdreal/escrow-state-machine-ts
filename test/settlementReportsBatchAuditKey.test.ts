import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementReports,
  calculateDeposit,
  summarizeSettlementReports,
  type SettlementReportInputs,
} from "../src/index.js";

/**
 * Batch settlement reports over mixed audit keys (backlog #818).
 *
 * Backlog #811 threaded `auditKey` through the single-escrow builder and
 * showed, in one batch test, that a keyed escrow without a key fails alone
 * without blocking the batch. What it did not cover is the mixed-key batch
 * itself: a wrong key (not just a missing key) failing in isolation, two
 * escrows under two different keys succeeding side by side with no key
 * leakage between items, a Buffer-form per-item key, and the summary
 * excluding the failed item's money. Those are the cases pinned here.
 * The batch wrapper has no key logic of its own — it delegates per entry
 * to `buildSettlementReport` — so every assertion below is about that
 * per-item isolation holding in batch order, not about a new feature.
 */

const KEY_A = "audit-key-batch-alpha";
const KEY_B = "audit-key-batch-beta";
const WRONG_KEY = "a-different-audit-key";

function goldenDeposit() {
  // Portfolio golden vector: pool $10,000, base $600 × 1.0, loyalty −$30,
  // oracle +$60 → deposit $10,630.
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

function keyedReleased(id: string, key: string | Buffer) {
  const e = new Escrow(id, { auditKey: key });
  e.dispatch("FUND", undefined, 10630);
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return e;
}

function unkeyedReleased(id: string) {
  const e = new Escrow(id);
  e.dispatch("FUND", undefined, 10630);
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return e;
}

function inputsFor(
  e: Escrow,
  auditKey?: string | Buffer,
): SettlementReportInputs {
  return {
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500 },
    ...(auditKey !== undefined ? { auditKey } : {}),
  };
}

function assertGoldenSplit(report: NonNullable<ReturnType<typeof buildSettlementReport>> | undefined) {
  assert.equal(report?.outcome, "released");
  assert.ok(report?.balanced);
  assert.equal(report?.totalInflow, 10630);
  assert.equal(report?.totalOutflow, 10630);
  // 5% of 10630 = 531.50 pro fee, no referral credits.
  const byRole = new Map(report!.parties.map((p) => [p.party, p]));
  assert.equal(byRole.get("sponsor")!.outflow, 10630);
  assert.equal(byRole.get("creator")!.inflow, 10098.5);
  assert.equal(byRole.get("platform")!.inflow, 531.5);
  assert.equal(byRole.get("referrer")!.inflow, 0);
}

test("mixed batch: correct key, wrong key, unkeyed — wrong key fails alone in the middle", () => {
  const keyed = keyedReleased("batch-key-good", KEY_A);
  const wrongKeyed = keyedReleased("batch-key-wrong", KEY_A);
  const plain = unkeyedReleased("batch-key-plain");
  const results = buildSettlementReports([
    inputsFor(keyed, KEY_A),
    inputsFor(wrongKeyed, WRONG_KEY),
    inputsFor(plain),
  ]);
  assert.deepEqual(
    results.map((r) => r.escrowId),
    ["batch-key-good", "batch-key-wrong", "batch-key-plain"],
  );
  assertGoldenSplit(results[0].report);
  assert.equal(results[0].error, undefined);
  assert.equal(results[1].report, undefined);
  assert.match(results[1].error ?? "", /hash chain/);
  // The item after the failure still reports: one bad key never aborts.
  assertGoldenSplit(results[2].report);
  assert.equal(results[2].error, undefined);
});

test("mixed batch: keyed escrow given no key fails alone, batch continues", () => {
  const keyed = keyedReleased("batch-key-missing", KEY_A);
  const plain = unkeyedReleased("batch-key-after-missing");
  const results = buildSettlementReports([
    inputsFor(keyed),
    inputsFor(plain),
  ]);
  assert.match(results[0].error ?? "", /hash chain/);
  assert.equal(results[0].report, undefined);
  assertGoldenSplit(results[1].report);
});

test("mixed batch: two escrows under two different keys, no key leakage", () => {
  const first = keyedReleased("batch-key-a", KEY_A);
  const second = keyedReleased("batch-key-b", KEY_B);
  const results = buildSettlementReports([
    inputsFor(first, KEY_A),
    inputsFor(second, KEY_B),
  ]);
  assertGoldenSplit(results[0].report);
  assertGoldenSplit(results[1].report);
  // Swapped keys fail both ways: neither item borrows the other's key.
  const swapped = buildSettlementReports([
    inputsFor(first, KEY_B),
    inputsFor(second, KEY_A),
  ]);
  assert.match(swapped[0].error ?? "", /hash chain/);
  assert.match(swapped[1].error ?? "", /hash chain/);
});

test("mixed batch: Buffer-form per-item key matches a string-built chain", () => {
  const keyed = keyedReleased("batch-key-buffer", KEY_A);
  const plain = unkeyedReleased("batch-key-buffer-plain");
  const results = buildSettlementReports([
    inputsFor(keyed, Buffer.from(KEY_A)),
    inputsFor(plain),
  ]);
  assertGoldenSplit(results[0].report);
  assertGoldenSplit(results[1].report);
});

test("mixed batch: summary counts and sums only the successful reports", () => {
  const keyed = keyedReleased("batch-sum-good", KEY_A);
  const wrongKeyed = keyedReleased("batch-sum-wrong", KEY_A);
  const plain = unkeyedReleased("batch-sum-plain");
  const results = buildSettlementReports([
    inputsFor(keyed, KEY_A),
    inputsFor(wrongKeyed, WRONG_KEY),
    inputsFor(plain),
  ]);
  const summary = summarizeSettlementReports(results);
  assert.equal(summary.total, 3);
  assert.equal(summary.reports, 2);
  assert.equal(summary.errors, 1);
  assert.deepEqual(summary.outcomes, {
    released: 2,
    refunded: 0,
    expired: 0,
  });
  // Two golden reports only; the failed item contributes no money.
  assert.equal(summary.totalDeposit, 21260);
  assert.equal(summary.totalInflow, 21260);
  assert.equal(summary.totalOutflow, 21260);
  assert.equal(summary.balanced, true);
  const byRole = new Map(summary.parties.map((p) => [p.party, p]));
  assert.equal(byRole.get("sponsor")!.outflow, 21260);
  assert.equal(byRole.get("creator")!.inflow, 20197);
  assert.equal(byRole.get("platform")!.inflow, 1063);
  assert.equal(byRole.get("referrer")!.inflow, 0);
});

test("mixed batch: results match the single-escrow builder entry for entry", () => {
  const keyed = keyedReleased("batch-eq-keyed", KEY_A);
  const plain = unkeyedReleased("batch-eq-plain");
  const inputs = [inputsFor(keyed, KEY_A), inputsFor(plain)];
  const results = buildSettlementReports(inputs);
  for (let i = 0; i < inputs.length; i++) {
    assert.deepEqual(results[i].report, buildSettlementReport(inputs[i]));
  }
  // And the batch error text is exactly the single builder's throw.
  const wrongInputs = inputsFor(keyedReleased("batch-eq-wrong", KEY_A), WRONG_KEY);
  const [batchWrong] = buildSettlementReports([wrongInputs]);
  assert.throws(
    () => buildSettlementReport(wrongInputs),
    (err: unknown) =>
      err instanceof Error && err.message === batchWrong.error,
  );
});
