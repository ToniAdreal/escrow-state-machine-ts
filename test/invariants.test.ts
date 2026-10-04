import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  calculateDeposit,
  settleRelease,
  type FeeInputs,
} from "../src/index.js";

/**
 * Accounting invariants for the escrow economics.
 *
 * These guard the money model itself, not individual fixtures:
 *  1. no fee is ever negative (adjusted base fee, pro fee, referral credits);
 *  2. the deposit always equals the sum of its parts;
 *  3. cumulative payout never exceeds the deposit.
 *
 * Each invariant is checked over a spread of valid inputs, including
 * edge values where 2-decimal rounding is most likely to leak a cent.
 */

/** Asserts two money amounts are equal within one cent. */
function assertCents(actual: number, expected: number, msg: string) {
  assert.ok(
    Math.abs(actual - expected) <= 0.01,
    `${msg}: expected ~${expected.toFixed(2)}, got ${actual.toFixed(2)}`,
  );
}

const DEPOSIT_INPUTS: { name: string; inputs: FeeInputs }[] = [
  {
    name: "golden vector",
    inputs: {
      creatorPool: 10000,
      baseFee: 600,
      complexityMultiplier: 1.0,
      loyaltyDiscount: 30,
      oracleFee: 60,
    },
  },
  {
    name: "zero pool, only fees",
    inputs: {
      creatorPool: 0,
      baseFee: 100,
      complexityMultiplier: 1.0,
      loyaltyDiscount: 0,
      oracleFee: 25,
    },
  },
  {
    name: "high complexity multiplier",
    inputs: {
      creatorPool: 500,
      baseFee: 300,
      complexityMultiplier: 4.75,
      loyaltyDiscount: 10,
      oracleFee: 15,
    },
  },
  {
    name: "fractional cents (rounding stress)",
    inputs: {
      creatorPool: 999.99,
      baseFee: 333.335,
      complexityMultiplier: 1.333,
      loyaltyDiscount: 11.11,
      oracleFee: 22.22,
    },
  },
  {
    name: "loyalty discount equals almost everything",
    inputs: {
      creatorPool: 100,
      baseFee: 50,
      complexityMultiplier: 1.0,
      loyaltyDiscount: 145,
      oracleFee: 5,
    },
  },
  {
    name: "large amounts",
    inputs: {
      creatorPool: 2500000,
      baseFee: 99999.99,
      complexityMultiplier: 2.5,
      loyaltyDiscount: 1234.56,
      oracleFee: 999.99,
    },
  },
];

const SETTLEMENT_INPUTS: { name: string; gross: number; proFeeBps: number; referralCredits: number }[] = [
  { name: "golden 5% no referrals", gross: 10630, proFeeBps: 500, referralCredits: 0 },
  { name: "5% with referrals", gross: 10630, proFeeBps: 500, referralCredits: 250 },
  { name: "zero fee", gross: 1000, proFeeBps: 0, referralCredits: 0 },
  { name: "full 100% fee", gross: 1000, proFeeBps: 10000, referralCredits: 0 },
  { name: "tiny gross, fractional bps", gross: 10.55, proFeeBps: 333, referralCredits: 0 },
  { name: "referrals eat the rest", gross: 500, proFeeBps: 500, referralCredits: 475 },
  { name: "sub-cent gross", gross: 0.01, proFeeBps: 500, referralCredits: 0 },
  { name: "rounding stress", gross: 999.99, proFeeBps: 2777, referralCredits: 12.34 },
];

test("invariant: deposit equals the sum of its parts", () => {
  for (const { name, inputs } of DEPOSIT_INPUTS) {
    const r = calculateDeposit(inputs);
    const expected =
      r.creatorPool + r.adjustedBaseFee - r.loyaltyDiscount + r.oracleFee;
    assertCents(
      r.deposit,
      expected,
      `deposit == pool + adjustedBaseFee − loyalty + oracle [${name}]`,
    );
    assert.equal(
      r.adjustedBaseFee,
      Math.round(r.baseFee * r.complexityMultiplier * 100) / 100,
      `adjustedBaseFee == round2(base × multiplier) [${name}]`,
    );
  }
});

test("invariant: no fee is ever negative", () => {
  for (const { name, inputs } of DEPOSIT_INPUTS) {
    const r = calculateDeposit(inputs);
    assert.ok(r.adjustedBaseFee >= 0, `adjustedBaseFee non-negative [${name}]`);
    assert.ok(r.deposit >= 0, `deposit non-negative [${name}]`);
  }
  for (const { name, gross, proFeeBps, referralCredits } of SETTLEMENT_INPUTS) {
    const s = settleRelease({ gross, proFeeBps, referralCredits });
    assert.ok(s.proFee >= 0, `proFee non-negative [${name}]`);
    assert.ok(s.referralCredits >= 0, `referralCredits non-negative [${name}]`);
    assert.ok(s.net >= 0, `net non-negative [${name}]`);
  }
});

test("invariant: settlement parts always sum to gross (money conserved)", () => {
  for (const { name, gross, proFeeBps, referralCredits } of SETTLEMENT_INPUTS) {
    const s = settleRelease({ gross, proFeeBps, referralCredits });
    assertCents(
      s.net + s.proFee + s.referralCredits,
      gross,
      `net + proFee + referralCredits == gross [${name}]`,
    );
  }
});

test("invariant: cumulative payout never exceeds the deposit", () => {
  for (const { name, inputs } of DEPOSIT_INPUTS) {
    const d = calculateDeposit(inputs);
    const cases = [
      { proFeeBps: 500, referralCredits: 0 },
      // 10% of the deposit in referrals: net stays safely positive.
      { proFeeBps: 500, referralCredits: Math.round(d.deposit * 10) / 100 },
      { proFeeBps: 2777, referralCredits: 0 },
      { proFeeBps: 10000, referralCredits: 0 },
    ];
    for (const c of cases) {
      const s = settleRelease({ gross: d.deposit, ...c });
      // Each recipient's payout is non-negative, and the total handed out
      // (creator net + platform fee + referrer credits) stays within a cent
      // of — never above — the deposit that was locked in.
      assert.ok(
        s.net + s.proFee + s.referralCredits <= d.deposit + 0.01,
        `payout ≤ deposit [${name}, bps=${c.proFeeBps}, credits=${c.referralCredits}]`,
      );
    }
  }
});

test("invariant: release report keeps the deposit conserved across parties", () => {
  for (const { name, inputs } of DEPOSIT_INPUTS) {
    const d = calculateDeposit(inputs);
    const escrow = new Escrow(`inv-${name}`);
    escrow.dispatch("FUND");
    escrow.dispatch("SUBMIT_MILESTONE");
    escrow.dispatch("VERIFY_PASS");
    escrow.dispatch("RELEASE");

    const report = buildSettlementReport({
      escrowId: escrow.id,
      history: escrow.history,
      finalState: escrow.state,
      deposit: d,
      settlement: {
        proFeeBps: 500,
        // 1% of the deposit: meaningful referral slice, net always ≥ 0.
        referralCredits: Math.round(d.deposit) / 100,
      },
    });

    assert.ok(report.balanced, `report balanced [${name}]`);
    assertCents(report.totalInflow, d.deposit, `totalInflow == deposit [${name}]`);
    assertCents(report.totalOutflow, d.deposit, `totalOutflow == deposit [${name}]`);
    for (const p of report.parties) {
      assert.ok(p.inflow >= 0, `${p.party} inflow non-negative [${name}]`);
      assert.ok(p.outflow >= 0, `${p.party} outflow non-negative [${name}]`);
    }
    const sponsor = report.parties.find((p) => p.party === "sponsor")!;
    assertCents(sponsor.outflow, d.deposit, `sponsor locked the full deposit [${name}]`);
  }
});

test("invariant: refunded report returns the full deposit to the sponsor", () => {
  for (const { name, inputs } of DEPOSIT_INPUTS) {
    const d = calculateDeposit(inputs);
    const escrow = new Escrow(`inv-refund-${name}`);
    escrow.dispatch("FUND");
    escrow.dispatch("EXPIRE");

    const report = buildSettlementReport({
      escrowId: escrow.id,
      history: escrow.history,
      finalState: escrow.state,
      deposit: d,
    });

    assert.ok(report.balanced, `report balanced [${name}]`);
    const sponsor = report.parties.find((p) => p.party === "sponsor")!;
    assertCents(sponsor.inflow, d.deposit, `sponsor refund inflow == deposit [${name}]`);
    for (const p of report.parties) {
      if (p.party === "sponsor") continue;
      assert.equal(p.inflow, 0, `${p.party} inflow is zero on refund [${name}]`);
      assert.equal(p.outflow, 0, `${p.party} outflow is zero on refund [${name}]`);
    }
  }
});
