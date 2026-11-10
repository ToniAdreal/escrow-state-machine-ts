import test from "node:test";
import assert from "node:assert/strict";
import { calculateDeposit, calculateDepositCents } from "../src/index.js";

const GOLDEN_CENTS = {
  creatorPoolCents: 1_000_000,
  baseFeeCents: 60_000,
  complexityMultiplier: 1.0,
  loyaltyDiscountCents: 3_000,
  oracleFeeCents: 6_000,
} as const;

test("golden vector is unchanged: deposit 1,063,000 cents", () => {
  const r = calculateDepositCents({ ...GOLDEN_CENTS });
  assert.equal(r.adjustedBaseFeeCents, 60_000);
  assert.equal(r.depositCents, 1_063_000);
  // The breakdown echoes the inputs verbatim.
  assert.equal(r.creatorPoolCents, 1_000_000);
  assert.equal(r.baseFeeCents, 60_000);
  assert.equal(r.loyaltyDiscountCents, 3_000);
  assert.equal(r.oracleFeeCents, 6_000);
});

test("dollar and cents APIs agree to the cent on the golden vector", () => {
  const dollars = calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
  const cents = calculateDepositCents({ ...GOLDEN_CENTS });
  assert.equal(cents.adjustedBaseFeeCents / 100, dollars.adjustedBaseFee);
  assert.equal(cents.depositCents / 100, dollars.deposit);
});

test("dollar and cents APIs agree to the cent on fractional vectors", () => {
  const vectors = [
    { pool: 10000, base: 600.03, mult: 1.25, disc: 0, oracle: 60 },
    { pool: 10000, base: 600, mult: 1.5, disc: 30, oracle: 60 },
    { pool: 2500.5, base: 199.99, mult: 1.1, disc: 12.34, oracle: 5 },
    { pool: 100, base: 6.03, mult: 1.5, disc: 0, oracle: 0 },
  ];
  for (const v of vectors) {
    const dollars = calculateDeposit({
      creatorPool: v.pool,
      baseFee: v.base,
      complexityMultiplier: v.mult,
      loyaltyDiscount: v.disc,
      oracleFee: v.oracle,
    });
    const cents = calculateDepositCents({
      creatorPoolCents: Math.round(v.pool * 100),
      baseFeeCents: Math.round(v.base * 100),
      complexityMultiplier: v.mult,
      loyaltyDiscountCents: Math.round(v.disc * 100),
      oracleFeeCents: Math.round(v.oracle * 100),
    });
    assert.equal(cents.adjustedBaseFeeCents / 100, dollars.adjustedBaseFee);
    assert.equal(cents.depositCents / 100, dollars.deposit);
  }
});

test("multiplier rounds half-up once: 603 cents x 1.5 = 904.5 -> 905", () => {
  // 904.5 is the discriminator: half-up gives 905, banker's rounding
  // would give 904. A single final rounding also means no per-item
  // error can accumulate: the deposit uses the rounded adjusted fee.
  const r = calculateDepositCents({
    creatorPoolCents: 10000,
    baseFeeCents: 603,
    complexityMultiplier: 1.5,
    loyaltyDiscountCents: 0,
    oracleFeeCents: 0,
  });
  assert.equal(r.adjustedBaseFeeCents, 905);
  assert.equal(r.depositCents, 10905);
});

test("one-cent dust boundary: 1 cent x 1.5 rounds up to 2 cents", () => {
  const r = calculateDepositCents({
    creatorPoolCents: 0,
    baseFeeCents: 1,
    complexityMultiplier: 1.5,
    loyaltyDiscountCents: 0,
    oracleFeeCents: 0,
  });
  assert.equal(r.adjustedBaseFeeCents, 2);
  assert.equal(r.depositCents, 2);
});

test("integer-cent inputs have no float dust to mop up", () => {
  // The dollar version needs round2 to hide 0.1 + 0.2 dust; the cents
  // version never leaves the integer domain, so repeated small fees add
  // up exactly. (0.1 + 0.2 in dollars is 0.30000000000000004.)
  const r = calculateDepositCents({
    creatorPoolCents: 10,
    baseFeeCents: 20,
    complexityMultiplier: 1.0,
    loyaltyDiscountCents: 0,
    oracleFeeCents: 0,
  });
  assert.equal(r.depositCents, 30);
  assert.ok(Number.isInteger(r.depositCents));
});

test("non-integer cent inputs fail fast", () => {
  assert.throws(
    () => calculateDepositCents({ ...GOLDEN_CENTS, creatorPoolCents: 100.5 }),
    /must be a finite non-negative integer number of cents/,
  );
  assert.throws(
    () => calculateDepositCents({ ...GOLDEN_CENTS, baseFeeCents: 60000.1 }),
    /must be a finite non-negative integer number of cents/,
  );
});

test("negative and non-finite cent inputs fail fast", () => {
  assert.throws(
    () => calculateDepositCents({ ...GOLDEN_CENTS, creatorPoolCents: -1 }),
    /must be a finite non-negative integer number of cents/,
  );
  assert.throws(
    () => calculateDepositCents({ ...GOLDEN_CENTS, oracleFeeCents: NaN }),
    /must be a finite non-negative integer number of cents/,
  );
  assert.throws(
    () =>
      calculateDepositCents({ ...GOLDEN_CENTS, loyaltyDiscountCents: Infinity }),
    /must be a finite non-negative integer number of cents/,
  );
});

test("non-positive and non-finite multipliers fail fast", () => {
  assert.throws(
    () => calculateDepositCents({ ...GOLDEN_CENTS, complexityMultiplier: 0 }),
    /complexityMultiplier must be a finite positive number/,
  );
  assert.throws(
    () => calculateDepositCents({ ...GOLDEN_CENTS, complexityMultiplier: -1.5 }),
    /complexityMultiplier must be a finite positive number/,
  );
  assert.throws(
    () => calculateDepositCents({ ...GOLDEN_CENTS, complexityMultiplier: NaN }),
    /complexityMultiplier must be a finite positive number/,
  );
});

test("complexityMultiplier 1e308 overflows the deposit computation and throws", () => {
  assert.throws(
    () => calculateDepositCents({ ...GOLDEN_CENTS, complexityMultiplier: 1e308 }),
    /deposit computation overflowed: inputs too large/,
  );
});

test("overflow also triggers via huge pool plus huge base fee (finite inputs)", () => {
  // Unlike the dollar version there is no x100 step here, so a single
  // 1e307-scale input stays finite; overflow needs the *sum* past
  // Number.MAX_VALUE: 1.7e308 + 1e308 is Infinity.
  assert.throws(
    () =>
      calculateDepositCents({
        ...GOLDEN_CENTS,
        creatorPoolCents: 1.7e308,
        baseFeeCents: 1e308,
      }),
    /deposit computation overflowed: inputs too large/,
  );
});

test("overflow also triggers via a huge baseFeeCents (adjusted fee overflows first)", () => {
  // 1e308 cents x a 1e308 multiplier overflows the product to Infinity,
  // so the adjusted fee — and then the deposit — is non-finite.
  assert.throws(
    () =>
      calculateDepositCents({
        ...GOLDEN_CENTS,
        baseFeeCents: 1e308,
        complexityMultiplier: 1e308,
      }),
    /deposit computation overflowed: inputs too large/,
  );
});

test("the overflow error message is exact and no partial breakdown escapes", () => {
  let result: unknown;
  let thrown: unknown;
  try {
    result = calculateDepositCents({ ...GOLDEN_CENTS, complexityMultiplier: 1e308 });
  } catch (err) {
    thrown = err;
  }
  assert.equal(result, undefined);
  assert.ok(thrown instanceof Error);
  assert.equal(thrown.message, "deposit computation overflowed: inputs too large");
});

test("a huge loyaltyDiscountCents goes the negative route, not the overflow route", () => {
  assert.throws(
    () =>
      calculateDepositCents({ ...GOLDEN_CENTS, loyaltyDiscountCents: 1e308 }),
    /deposit would be negative/,
  );
});

test("zero fee and zero discount boundary: all-zero inputs deposit zero", () => {
  const r = calculateDepositCents({
    creatorPoolCents: 0,
    baseFeeCents: 0,
    complexityMultiplier: 1.0,
    loyaltyDiscountCents: 0,
    oracleFeeCents: 0,
  });
  assert.equal(r.adjustedBaseFeeCents, 0);
  assert.equal(r.depositCents, 0);
});

test("a 1e15-scale deposit is large but finite and still accepted", () => {
  // Mirrors the dollar version's stance: the guard rejects non-finite
  // deposits, not merely-huge ones.
  const r = calculateDepositCents({
    ...GOLDEN_CENTS,
    creatorPoolCents: 1e15,
    loyaltyDiscountCents: 0,
  });
  assert.ok(Number.isFinite(r.depositCents));
  assert.ok(r.depositCents > 1e15);
});
