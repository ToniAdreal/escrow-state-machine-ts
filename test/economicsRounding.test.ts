import test from "node:test";
import assert from "node:assert/strict";
import { calculateDeposit, settleRelease } from "../src/index.js";

// Rounding-boundary pins for the two independent round2() copies
// (feeCalculator.ts: Math.round(n * 100) / 100 on adjustedBaseFee and on
// deposit; settlement.ts: same formula on proFee and on net).
// Every expected value below was computed BY HAND from the round2 rule
// "multiply by 100, round half up (Math.round), divide by 100" — never by
// running the implementation. Inputs are chosen as exact binary fractions
// (denominators 8/16) wherever a value must sit exactly on a half-cent, so
// floating-point representation cannot flip the intended boundary.

test("rounding: multiplier product exactly on a half-cent rounds up", () => {
  // Hand calc: 20.25 × 1.5 = 30.375 exactly → 3037.5 → round half up 3038
  // → adjustedBaseFee 30.38. A floor/truncating round2 would give 30.37.
  const r = calculateDeposit({
    creatorPool: 0,
    baseFee: 20.25,
    complexityMultiplier: 1.5,
    loyaltyDiscount: 0,
    oracleFee: 0,
  });
  assert.equal(r.adjustedBaseFee, 30.38);
  // deposit = round2(0 + 30.38 − 0 + 0) = 30.38 (already at cents).
  assert.equal(r.deposit, 30.38);
});

test("rounding: multiplier product below a half-cent rounds down", () => {
  // Hand calc: 10.0625 × 1 = 10.0625 → 1006.25 → round 1006
  // → adjustedBaseFee 10.06. A ceil-ing round2 would give 10.07.
  const r = calculateDeposit({
    creatorPool: 0,
    baseFee: 10.0625,
    complexityMultiplier: 1,
    loyaltyDiscount: 0,
    oracleFee: 0,
  });
  assert.equal(r.adjustedBaseFee, 10.06);
  assert.equal(r.deposit, 10.06);
});

test("rounding: deposit sum exactly on a half-cent rounds up", () => {
  // Hand calc: adjustedBaseFee = round2(0 × 1) = 0;
  // deposit = round2(0.125 + 0 − 0 + 0): 0.125 × 100 = 12.5 → 13 → 0.13.
  // A floor round2 on the deposit step would give 0.12.
  const r = calculateDeposit({
    creatorPool: 0.125,
    baseFee: 0,
    complexityMultiplier: 1,
    loyaltyDiscount: 0,
    oracleFee: 0,
  });
  assert.equal(r.adjustedBaseFee, 0);
  assert.equal(r.deposit, 0.13);
});

test("rounding: loyalty discount exactly offsets the total (deposit 0, no throw)", () => {
  // Hand calc (integers): pool 100 + adjusted round2(600 × 1) = 600
  // + oracle 60 = 760; discount 760 → deposit = round2(0) = 0, which is not
  // negative, so calculateDeposit must NOT throw.
  const r = calculateDeposit({
    creatorPool: 100,
    baseFee: 600,
    complexityMultiplier: 1,
    loyaltyDiscount: 760,
    oracleFee: 60,
  });
  assert.equal(r.deposit, 0);
});

test("rounding: loyalty discount exactly offsets a rounded total (deposit 0)", () => {
  // Hand calc: adjustedBaseFee = round2(20.25 × 1.5) = 30.38 (case above);
  // deposit = round2(100 + 30.38 − 130.38 + 0) = round2(0) = 0, no throw.
  // This pins the discount check against the ROUNDED fee, not the raw 30.375:
  // against the raw product the sum would be 100 + 30.375 − 130.38 = −0.005.
  const r = calculateDeposit({
    creatorPool: 100,
    baseFee: 20.25,
    complexityMultiplier: 1.5,
    loyaltyDiscount: 130.38,
    oracleFee: 0,
  });
  assert.equal(r.adjustedBaseFee, 30.38);
  assert.equal(r.deposit, 0);
});

test("rounding: loyalty discount one cent past the rounded total throws", () => {
  // Hand calc: deposit = round2(100 + 30.38 − 130.39 + 0) = round2(−0.01)
  // = −0.01 < 0 → must throw /negative/.
  assert.throws(
    () =>
      calculateDeposit({
        creatorPool: 100,
        baseFee: 20.25,
        complexityMultiplier: 1.5,
        loyaltyDiscount: 130.39,
        oracleFee: 0,
      }),
    /negative/,
  );
});

test("rounding: bps fee exactly on a half-cent rounds up", () => {
  // Hand calc: proFee = round2(10 × 125 / 10000) = round2(0.125):
  // 12.5 → 13 → 0.13. A floor round2 would give 0.12.
  // net = round2(10 − 0.13 − 0) = 9.87.
  const s = settleRelease({ gross: 10, proFeeBps: 125 });
  assert.equal(s.proFee, 0.13);
  assert.equal(s.net, 9.87);
});

test("rounding: bps fee just below a half-cent rounds down", () => {
  // Hand calc: proFee = round2(10 × 124 / 10000) = round2(0.124):
  // 12.4 → 12 → 0.12. net = round2(10 − 0.12) = 9.88.
  const s = settleRelease({ gross: 10, proFeeBps: 124 });
  assert.equal(s.proFee, 0.12);
  assert.equal(s.net, 9.88);
});

test("rounding: proFeeBps = 0 charges no fee", () => {
  // Hand calc: proFee = round2(123.45 × 0 / 10000) = 0;
  // net = round2(123.45 − 0 − 0) = 123.45.
  const s = settleRelease({ gross: 123.45, proFeeBps: 0 });
  assert.equal(s.proFee, 0);
  assert.equal(s.net, 123.45);
});

test("rounding: proFeeBps = 10000 takes the whole gross (net 0, no throw)", () => {
  // Hand calc: proFee = round2(123.45 × 10000 / 10000) = round2(123.45)
  // = 123.45; net = round2(123.45 − 123.45) = 0, not negative → no throw.
  const s = settleRelease({ gross: 123.45, proFeeBps: 10000 });
  assert.equal(s.proFee, 123.45);
  assert.equal(s.net, 0);
});

test("rounding: referral credits exactly equal gross − proFee (net 0, no throw)", () => {
  // Hand calc: proFee = round2(1000 × 500 / 10000) = round2(50) = 50;
  // gross − proFee = 950; referralCredits 950 → net = round2(0) = 0.
  const s = settleRelease({ gross: 1000, proFeeBps: 500, referralCredits: 950 });
  assert.equal(s.proFee, 50);
  assert.equal(s.net, 0);
});

test("rounding: referral credits exactly equal a half-cent-rounded remainder (net 0)", () => {
  // Hand calc: proFee = round2(10 × 125 / 10000) = 0.13 (half-cent case);
  // gross − proFee = 9.87; referralCredits 9.87 → net = round2(0) = 0.
  // If proFee were floored to 0.12, net would be 0.01, not 0 — so this also
  // catches a floor mutation in settlement's round2.
  const s = settleRelease({ gross: 10, proFeeBps: 125, referralCredits: 9.87 });
  assert.equal(s.proFee, 0.13);
  assert.equal(s.net, 0);
});

test("rounding: referral credits one cent past gross − proFee throw", () => {
  // Hand calc: net = round2(1000 − 50 − 950.01) = round2(−0.01) = −0.01 < 0
  // → must throw /negative/.
  assert.throws(
    () => settleRelease({ gross: 1000, proFeeBps: 500, referralCredits: 950.01 }),
    /negative/,
  );
});

test("rounding: net itself on a half-cent rounds up", () => {
  // Hand calc: proFee = round2(10 × 0 / 10000) = 0;
  // net = round2(10 − 0 − 9.875) = round2(0.125): 12.5 → 13 → 0.13.
  // A floor round2 on the net step would give 0.12. (referralCredits is not
  // itself rounded before the subtraction — 9.875 enters the sum as-is.)
  const s = settleRelease({ gross: 10, proFeeBps: 0, referralCredits: 9.875 });
  assert.equal(s.proFee, 0);
  assert.equal(s.net, 0.13);
});

test("rounding: both round2 copies agree on the same half-cent input", () => {
  // Drift guard: feeCalculator and settlement each embed their own round2.
  // The same exact half-cent value 0.125 must round to 0.13 through BOTH:
  // via calculateDeposit (0.125 × 1) and via settleRelease (10 × 125 / 10000).
  const r = calculateDeposit({
    creatorPool: 0,
    baseFee: 0.125,
    complexityMultiplier: 1,
    loyaltyDiscount: 0,
    oracleFee: 0,
  });
  const s = settleRelease({ gross: 10, proFeeBps: 125 });
  assert.equal(r.adjustedBaseFee, 0.13);
  assert.equal(s.proFee, 0.13);
  assert.equal(r.adjustedBaseFee, s.proFee);
});
