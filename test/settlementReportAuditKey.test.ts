import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementReports,
  calculateDeposit,
  type EscrowHistoryEntry,
} from "../src/index.js";

/**
 * Settlement reports over keyed (HMAC) audit chains (backlog #811).
 *
 * Before this item the report path had no way to pass an audit key
 * through: `buildSettlementReport` always verified the chain unkeyed,
 * so a legitimately keyed escrow was misreported as "hash chain is
 * broken" and could never produce a settlement report. The fix threads
 * `SettlementReportInputs.auditKey` into `verifyHistoryChain`; the
 * batch wrapper inherits it by delegating to the single-escrow builder.
 */

const KEY = "audit-key-for-settlement-reports";
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

function keyedReleasedEscrow() {
  const e = new Escrow("esc-audit-key", { auditKey: KEY });
  e.dispatch("FUND", undefined, 10630);
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return e;
}

function unkeyedReleasedEscrow() {
  const e = new Escrow("esc-audit-plain");
  e.dispatch("FUND", undefined, 10630);
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return e;
}

function buildFor(
  history: readonly EscrowHistoryEntry[],
  escrowId: string,
  auditKey?: string | Buffer,
) {
  return () =>
    buildSettlementReport({
      escrowId,
      history,
      finalState: "RELEASED",
      deposit: goldenDeposit(),
      settlement: { proFeeBps: 500 },
      ...(auditKey !== undefined ? { auditKey } : {}),
    });
}

/** Deep-clone chained entries (the live history is frozen, so mutate clones). */
function cloneHistory(history: readonly EscrowHistoryEntry[]): EscrowHistoryEntry[] {
  return JSON.parse(JSON.stringify(history)) as EscrowHistoryEntry[];
}

test("keyed released escrow reports with the correct key, split correct", () => {
  const e = keyedReleasedEscrow();
  const report = buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500 },
    auditKey: KEY,
  });
  assert.equal(report.outcome, "released");
  assert.ok(report.balanced);
  assert.equal(report.totalInflow, 10630);
  assert.equal(report.totalOutflow, 10630);
  // 5% of 10630 = 531.50 pro fee, no referral credits.
  const byRole = new Map(report.parties.map((p) => [p.party, p]));
  assert.equal(byRole.get("sponsor")!.outflow, 10630);
  assert.equal(byRole.get("creator")!.inflow, 10098.5);
  assert.equal(byRole.get("platform")!.inflow, 531.5);
  assert.equal(byRole.get("referrer")!.inflow, 0);
});

test("keyed escrow without a key is refused, not misreported", () => {
  const e = keyedReleasedEscrow();
  assert.throws(buildFor(e.history, e.id), /hash chain/);
});

test("keyed escrow with the wrong key is refused", () => {
  const e = keyedReleasedEscrow();
  assert.throws(buildFor(e.history, e.id, WRONG_KEY), /hash chain/);
});

test("tampered entry with the correct key is still refused", () => {
  const history = cloneHistory(keyedReleasedEscrow().history);
  history[0].amount = 1; // attacker shrinks the locked deposit
  assert.throws(buildFor(history, "esc-audit-key", KEY), /hash chain/);
});

test("invalid audit keys fail fast with the audit-key wording", () => {
  const e = keyedReleasedEscrow();
  assert.throws(buildFor(e.history, e.id, ""), /invalid audit key/);
  assert.throws(
    buildFor(e.history, e.id, Buffer.alloc(0)),
    /invalid audit key/,
  );
  assert.throws(
    buildFor(e.history, e.id, 42 as unknown as string),
    /invalid audit key/,
  );
});

test("unkeyed escrow without a key keeps the old behavior", () => {
  const e = unkeyedReleasedEscrow();
  const report = buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500 },
  });
  assert.equal(report.outcome, "released");
  assert.ok(report.balanced);
});

test("unkeyed escrow with a key is refused (fail-closed both ways)", () => {
  const e = unkeyedReleasedEscrow();
  assert.throws(buildFor(e.history, e.id, KEY), /hash chain/);
});

test("Buffer-built keyed escrow reports under the same string key", () => {
  const e = new Escrow("esc-audit-buffer", { auditKey: Buffer.from(KEY) });
  e.dispatch("FUND", undefined, 10630);
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  const report = buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500 },
    auditKey: KEY,
  });
  assert.equal(report.outcome, "released");
  assert.ok(report.balanced);
});

test("batch wrapper inherits auditKey per escrow without its own path", () => {
  const keyed = keyedReleasedEscrow();
  const plain = unkeyedReleasedEscrow();
  const results = buildSettlementReports([
    {
      escrowId: keyed.id,
      history: keyed.history,
      finalState: keyed.state,
      deposit: goldenDeposit(),
      settlement: { proFeeBps: 500 },
      auditKey: KEY,
    },
    {
      escrowId: keyed.id,
      history: keyed.history,
      finalState: keyed.state,
      deposit: goldenDeposit(),
      settlement: { proFeeBps: 500 },
      // No key: this entry fails alone, never blocks the batch.
    },
    {
      escrowId: plain.id,
      history: plain.history,
      finalState: plain.state,
      deposit: goldenDeposit(),
      settlement: { proFeeBps: 500 },
    },
  ]);
  assert.equal(results.length, 3);
  assert.equal(results[0].report?.outcome, "released");
  assert.ok(results[0].report?.balanced);
  assert.match(results[1].error ?? "", /hash chain/);
  assert.equal(results[1].report, undefined);
  assert.equal(results[2].report?.outcome, "released");
});
