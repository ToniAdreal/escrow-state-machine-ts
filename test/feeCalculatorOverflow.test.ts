import test from "node:test";
import assert from "node:assert/strict";
import { calculateDeposit } from "../src/index.js";

const GOLDEN = {
  creatorPool: 10000,
  baseFee: 600,
  complexityMultiplier: 1.0,
  loyaltyDiscount: 30,
  oracleFee: 60,
} as const;

test("golden vector is unchanged: deposit 10630", () => {
  const r = calculateDeposit({ ...GOLDEN });
  assert.equal(r.adjustedBaseFee, 600);
  assert.equal(r.deposit, 10630);
});

test("complexityMultiplier 1e308 overflows the deposit computation and throws", () => {
  assert.throws(
    () => calculateDeposit({ ...GOLDEN, complexityMultiplier: 1e308 }),
    /deposit computation overflowed: inputs too large/,
  );
});

test("overflow also triggers via a huge creatorPool (finite input)", () => {
  // 1e307 is a finite, non-negative input: it passes the per-field assertMoney
  // guard, but round2(1e307 + …) itself overflows to Infinity.
  assert.throws(
    () => calculateDeposit({ ...GOLDEN, creatorPool: 1e307 }),
    /deposit computation overflowed: inputs too large/,
  );
});

test("overflow also triggers via a huge baseFee (adjustedBaseFee overflows first)", () => {
  assert.throws(
    () => calculateDeposit({ ...GOLDEN, baseFee: 1e308 }),
    /deposit computation overflowed: inputs too large/,
  );
});

test("the error message is exact and no partial breakdown escapes", () => {
  let result: unknown;
  let thrown: unknown;
  try {
    result = calculateDeposit({ ...GOLDEN, complexityMultiplier: 1e308 });
  } catch (err) {
    thrown = err;
  }
  assert.equal(result, undefined);
  assert.ok(thrown instanceof Error);
  assert.equal(thrown.message, "deposit computation overflowed: inputs too large");
});

test("a 1e15-scale deposit is large but finite and still accepted", () => {
  // The point is that the guard rejects non-finite deposits, not
  // merely-huge ones: no exact-cent equality here, since integer precision
  // above 2^53 is a separate (documented) limitation.
  const r = calculateDeposit({ ...GOLDEN, creatorPool: 1e15, loyaltyDiscount: 0 });
  assert.ok(Number.isFinite(r.deposit));
  assert.ok(r.deposit > 1e15);
});

test("a 1e306 creatorPool is finite through round2 and still accepted", () => {
  // round2 stays finite up to ~1.8e306; this input is representable, so the
  // guard must not fire on merely-huge-but-finite numbers.
  const r = calculateDeposit({ ...GOLDEN, creatorPool: 1e306, baseFee: 0, oracleFee: 0 });
  assert.ok(Number.isFinite(r.deposit));
});

test("a huge loyaltyDiscount goes the negative route, not the overflow route", () => {
  // Keeps the two guards distinct: negative deposit → "would be negative";
  // non-finite deposit → "overflowed".
  assert.throws(
    () => calculateDeposit({ ...GOLDEN, loyaltyDiscount: 1e308 }),
    /deposit would be negative/,
  );
});
