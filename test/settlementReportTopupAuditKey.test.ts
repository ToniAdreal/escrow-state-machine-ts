import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  calculateDeposit,
  verifyHistoryChain,
  type EscrowHistoryEntry,
} from "../src/index.js";

/**
 * Settlement report over a keyed (HMAC) audit chain after a top-up
 * (backlog #821): the combination the audit-key suite and the top-up
 * suite never tested together. `test/settlementReportAuditKey.test.ts`
 * only ever funded a keyed escrow once (10630), and
 * `test/settlementReportTopup.test.ts` never mentions `auditKey` —
 * so whether a report over a keyed history with several FUND entries
 * sums every FUND into the deposit, and whether a wrong key, a missing
 * key, or a tampered second FUND refuses the whole report, had no
 * backing. There is no TOPUP event in this repo: a top-up is a second
 * FUND on the FUNDED self-loop, and the report's deposit is the FUND
 * total, not the first FUND alone.
 */

const KEY = "audit-key-for-topup-settlement-reports";
const WRONG_KEY = "a-different-audit-key";

function toppedUpDeposit() {
  // 10630 + 2000 = 12630: pool $12,000, base $600 × 1.0,
  // loyalty −$30, oracle +$60 → deposit $12,630.
  return calculateDeposit({
    creatorPool: 12000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

function keyedToppedUpReleasedEscrow() {
  const e = new Escrow("esc-topup-audit-key", { auditKey: KEY });
  e.dispatch("FUND", "initial wire", 10630);
  e.dispatch("FUND", "top-up wire", 2000);
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
      deposit: toppedUpDeposit(),
      settlement: { proFeeBps: 500 },
      ...(auditKey !== undefined ? { auditKey } : {}),
    });
}

/** Deep-clone chained entries (the live history is frozen, so mutate clones). */
function cloneHistory(
  history: readonly EscrowHistoryEntry[],
): EscrowHistoryEntry[] {
  return JSON.parse(JSON.stringify(history)) as EscrowHistoryEntry[];
}

test("keyed topped-up released report sums both FUNDs under the correct key", () => {
  const e = keyedToppedUpReleasedEscrow();
  const report = buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: toppedUpDeposit(),
    settlement: { proFeeBps: 500 },
    auditKey: KEY,
  });
  assert.equal(report.outcome, "released");
  assert.equal(report.deposit.deposit, 12630);
  assert.equal(report.eventCount, 5);
  assert.equal(report.releasePath, "VERIFY_PASS → RELEASE");
  // 5% of 12630 = 631.50 pro fee; creator net = 12630 − 631.50 = 11998.50.
  assert.deepEqual(
    report.parties.map((p) => [p.party, p.inflow, p.outflow, p.net]),
    [
      ["sponsor", 0, 12630, -12630],
      ["creator", 11998.5, 0, 11998.5],
      ["platform", 631.5, 0, 631.5],
      ["referrer", 0, 0, 0],
    ],
  );
  assert.equal(report.totalInflow, 12630);
  assert.equal(report.totalOutflow, 12630);
  assert.equal(report.balanced, true);
});

test("keyed topped-up escrow without a key is refused, not misreported", () => {
  const e = keyedToppedUpReleasedEscrow();
  assert.throws(buildFor(e.history, e.id), /hash chain/);
});

test("keyed topped-up escrow with the wrong key is refused", () => {
  const e = keyedToppedUpReleasedEscrow();
  assert.throws(buildFor(e.history, e.id, WRONG_KEY), /hash chain/);
});

test("tampered second FUND amount with the correct key is still refused", () => {
  const history = cloneHistory(keyedToppedUpReleasedEscrow().history);
  history[1].amount = 2001; // attacker inflates only the top-up
  assert.throws(buildFor(history, "esc-topup-audit-key", KEY), /hash chain/);
});

test("unkeyed chain check on a keyed history fails closed", () => {
  const e = keyedToppedUpReleasedEscrow();
  assert.equal(verifyHistoryChain(e.history), false);
  assert.equal(verifyHistoryChain(e.history, WRONG_KEY), false);
  assert.equal(verifyHistoryChain(e.history, KEY), true);
});
