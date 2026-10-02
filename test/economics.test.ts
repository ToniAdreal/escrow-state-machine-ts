import test from "node:test";
import assert from "node:assert/strict";
import { calculateDeposit, settleRelease } from "../src/index.js";

test("golden vector from the ALLWEB3 portfolio case study", () => {
  // "Deterministic Fee Calculator & Escrow Preview":
  // Creator Pool $10,000, Base Fee $600, Complexity 1.0x,
  // Loyalty −$30, Oracle $60, Deposit $10,630.
  const r = calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
  assert.equal(r.adjustedBaseFee, 600);
  assert.equal(r.deposit, 10630);
});

test("complexity multiplier scales the base fee", () => {
  const r = calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.5,
    loyaltyDiscount: 0,
    oracleFee: 60,
  });
  assert.equal(r.adjustedBaseFee, 900);
  assert.equal(r.deposit, 10960);
});

test("invalid inputs throw", () => {
  const base = {
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1,
    loyaltyDiscount: 0,
    oracleFee: 60,
  };
  assert.throws(() => calculateDeposit({ ...base, baseFee: -1 }), /non-negative/);
  assert.throws(
    () => calculateDeposit({ ...base, complexityMultiplier: 0 }),
    /positive/,
  );
  assert.throws(
    () =>
      calculateDeposit({ ...base, creatorPool: 0, loyaltyDiscount: 20000 }),
    /negative/,
  );
});

test("settlement: 5% pro fee golden", () => {
  const s = settleRelease({ gross: 1000, proFeeBps: 500 });
  assert.equal(s.proFee, 50);
  assert.equal(s.net, 950);
});

test("settlement: referral credits reduce net", () => {
  const s = settleRelease({ gross: 1000, proFeeBps: 500, referralCredits: 100 });
  assert.equal(s.net, 850);
});

test("settlement: invalid inputs throw", () => {
  assert.throws(() => settleRelease({ gross: -5, proFeeBps: 500 }), /gross/);
  assert.throws(() => settleRelease({ gross: 100, proFeeBps: 10001 }), /proFeeBps/);
  assert.throws(
    () => settleRelease({ gross: 100, proFeeBps: 500, referralCredits: 1000 }),
    /negative/,
  );
});
