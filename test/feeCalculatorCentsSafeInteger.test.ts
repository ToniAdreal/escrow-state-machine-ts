import test from "node:test";
import assert from "node:assert/strict";
import { calculateDepositCents } from "../src/index.js";

// Backlog #1417: `calculateDepositCents` promised "integer cents in
// and out, never leaves the integer domain", but the product
// (`Math.round(baseFeeCents * complexityMultiplier)`) and the sum ran
// in float with only a finiteness guard — near
// `Number.MAX_SAFE_INTEGER` the results came back off by a cent and
// non-safe, silently. The arithmetic below is now exact `BigInt`
// (multiplier read as the rational named by its shortest decimal
// string), and any exact result past the safe-integer ceiling throws
// `deposit computation overflowed: inputs too large` instead.

const MAX = Number.MAX_SAFE_INTEGER;

test("MAX_SAFE_INTEGER x 1.5 throws overflow instead of returning an off-by-one cent", () => {
  // Exact product: 9,007,199,254,740,991 x 1.5 = 13,510,798,882,111,486.5
  // -> half-up 13,510,798,882,111,487, which no double can hold. The
  // old float code returned 13,510,798,882,111,486 (one cent short,
  // and not a safe integer) with no complaint.
  assert.throws(
    () =>
      calculateDepositCents({
        creatorPoolCents: 0,
        baseFeeCents: MAX,
        complexityMultiplier: 1.5,
        loyaltyDiscountCents: 0,
        oracleFeeCents: 0,
      }),
    (err: unknown) =>
      err instanceof Error &&
      err.message === "deposit computation overflowed: inputs too large",
  );
});

test("MAX_SAFE_INTEGER pool plus 2 oracle cents throws overflow on the exact sum", () => {
  // Exact sum 9,007,199,254,740,993 is unrepresentable; the old float
  // sum returned 9,007,199,254,740,992 (one cent short, not safe).
  assert.throws(
    () =>
      calculateDepositCents({
        creatorPoolCents: MAX,
        baseFeeCents: 0,
        complexityMultiplier: 1,
        loyaltyDiscountCents: 0,
        oracleFeeCents: 2,
      }),
    /deposit computation overflowed: inputs too large/,
  );
});

test("MAX_SAFE_INTEGER itself plus zero passes and stays exactly representable", () => {
  const r = calculateDepositCents({
    creatorPoolCents: MAX,
    baseFeeCents: 0,
    complexityMultiplier: 1,
    loyaltyDiscountCents: 0,
    oracleFeeCents: 0,
  });
  assert.equal(r.depositCents, MAX);
  assert.ok(Number.isSafeInteger(r.depositCents));
});

test("baseFeeCents at MAX_SAFE_INTEGER with multiplier 1.0 stays exact", () => {
  const r = calculateDepositCents({
    creatorPoolCents: 0,
    baseFeeCents: MAX,
    complexityMultiplier: 1.0,
    loyaltyDiscountCents: 0,
    oracleFeeCents: 0,
  });
  assert.equal(r.adjustedBaseFeeCents, MAX);
  assert.equal(r.depositCents, MAX);
  assert.ok(Number.isSafeInteger(r.adjustedBaseFeeCents));
});

test("golden vector is unchanged: deposit 1,063,000 cents", () => {
  const r = calculateDepositCents({
    creatorPoolCents: 1_000_000,
    baseFeeCents: 60_000,
    complexityMultiplier: 1.0,
    loyaltyDiscountCents: 3_000,
    oracleFeeCents: 6_000,
  });
  assert.deepEqual(r, {
    creatorPoolCents: 1_000_000,
    baseFeeCents: 60_000,
    complexityMultiplier: 1.0,
    loyaltyDiscountCents: 3_000,
    oracleFeeCents: 6_000,
    adjustedBaseFeeCents: 60_000,
    depositCents: 1_063_000,
  });
});

test("multiplier 1.005 is exact decimal arithmetic: 100 cents x 1.005 = 101", () => {
  // The discriminator: the exact product is 100.5, half-up 101. The
  // old float product (100 * 1.005 === 100.49999999999999) rounded
  // down to 100, so a caller holding cents lost a cent to binary dust.
  const r = calculateDepositCents({
    creatorPoolCents: 0,
    baseFeeCents: 100,
    complexityMultiplier: 1.005,
    loyaltyDiscountCents: 0,
    oracleFeeCents: 0,
  });
  assert.equal(r.adjustedBaseFeeCents, 101);
  assert.equal(r.depositCents, 101);
});

test("scientific-notation multipliers parse exactly and overflow loudly", () => {
  // 1e-7 reaches the parser as "1e-7" (exponent branch): 10,000,000
  // x 1e-7 is exactly 1 cent, no float dust.
  const tiny = calculateDepositCents({
    creatorPoolCents: 0,
    baseFeeCents: 10_000_000,
    complexityMultiplier: 1e-7,
    loyaltyDiscountCents: 0,
    oracleFeeCents: 0,
  });
  assert.equal(tiny.adjustedBaseFeeCents, 1);
  // 1e21 reaches it as "1e+21": the exact adjusted fee is astronomically
  // past the safe-integer ceiling, so it overflows instead of rounding.
  assert.throws(
    () =>
      calculateDepositCents({
        creatorPoolCents: 1_000_000,
        baseFeeCents: 60_000,
        complexityMultiplier: 1e21,
        loyaltyDiscountCents: 3_000,
        oracleFeeCents: 6_000,
      }),
    /deposit computation overflowed: inputs too large/,
  );
});

test("a MAX_SAFE_INTEGER loyalty discount still takes the negative route, not overflow", () => {
  assert.throws(
    () =>
      calculateDepositCents({
        creatorPoolCents: 1_000_000,
        baseFeeCents: 60_000,
        complexityMultiplier: 1.0,
        loyaltyDiscountCents: MAX,
        oracleFeeCents: 6_000,
      }),
    /deposit would be negative/,
  );
});

test("non-safe-integer money inputs fail at the input gate with the integer error", () => {
  // The literal 9007199254740993 arrives as 9007199254740992 (2^53):
  // an integer, but not a safe one — it no longer names a single cent
  // value, so it is rejected like any other non-integer-cent input.
  assert.throws(
    () =>
      calculateDepositCents({
        creatorPoolCents: 1_000_000,
        baseFeeCents: 9007199254740993,
        complexityMultiplier: 1.0,
        loyaltyDiscountCents: 3_000,
        oracleFeeCents: 6_000,
      }),
    /must be a finite non-negative integer number of cents/,
  );
  assert.throws(
    () =>
      calculateDepositCents({
        creatorPoolCents: 1_000_000,
        baseFeeCents: 60_000,
        complexityMultiplier: 1.0,
        loyaltyDiscountCents: 3_000,
        oracleFeeCents: Number.MAX_SAFE_INTEGER + 1,
      }),
    /must be a finite non-negative integer number of cents/,
  );
});

test("an Infinity multiplier still fails on the finite-positive guard", () => {
  // The pre-existing guard rejects non-finite multipliers before any
  // arithmetic runs; this pins that the guard (and its message) did
  // not move when the arithmetic went exact.
  assert.throws(
    () =>
      calculateDepositCents({
        creatorPoolCents: 1_000_000,
        baseFeeCents: 60_000,
        complexityMultiplier: Infinity,
        loyaltyDiscountCents: 3_000,
        oracleFeeCents: 6_000,
      }),
    /complexityMultiplier must be a finite positive number/,
  );
});
