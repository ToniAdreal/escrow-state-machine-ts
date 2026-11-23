import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateDeposit,
  calculateDepositCents,
} from "../src/index.js";

// Backlog #1356: both fee calculators started with `Object.entries(inputs)`
// and no shape guard, so a null input died as a bare TypeError ("Cannot
// convert undefined or null to object") and a string input died as a
// misleading field error (`Object.entries("x")` yields `[["0", "x"]]`, so
// the caller saw `0 must be a finite non-negative number`). Each function
// now guards the shape first with the fn-prefixed `assertFeeInputs`
// (`<fn>: inputs must be an object, got ...`, `got` rendered via
// `JSON.stringify` like `buildSettlementReport`).

const GOLDEN = {
  creatorPool: 10000,
  baseFee: 600,
  complexityMultiplier: 1.0,
  loyaltyDiscount: 30,
  oracleFee: 60,
};

const GOLDEN_CENTS = {
  creatorPoolCents: 1000000,
  baseFeeCents: 60000,
  complexityMultiplier: 1.0,
  loyaltyDiscountCents: 3000,
  oracleFeeCents: 6000,
};

const badInputs: Array<{ label: string; value: unknown; got: string }> = [
  { label: "null", value: null, got: "null" },
  { label: '"x"', value: "x", got: '"x"' },
  { label: "42", value: 42, got: "42" },
  { label: "[]", value: [], got: "[]" },
  { label: "undefined", value: undefined, got: "undefined" },
];

for (const { label, value, got } of badInputs) {
  test(`calculateDeposit rejects ${label} inputs with a named error, not a bare TypeError`, () => {
    assert.throws(
      () => calculateDeposit(value as never),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(!(err instanceof TypeError));
        assert.equal(
          err.message,
          `calculateDeposit: inputs must be an object, got ${got}`,
        );
        return true;
      },
    );
  });

  test(`calculateDepositCents rejects ${label} inputs with a named error, not a bare TypeError`, () => {
    assert.throws(
      () => calculateDepositCents(value as never),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(!(err instanceof TypeError));
        assert.equal(
          err.message,
          `calculateDepositCents: inputs must be an object, got ${got}`,
        );
        return true;
      },
    );
  });
}

test("calculateDeposit with {} still fails with the pre-guard named error, not the shape guard", () => {
  // An empty object passes the shape guard (it is an object) and skips
  // the entries loop, so the NaN deposit trips the pre-existing overflow
  // guard — exactly as before this change.
  assert.throws(
    () => calculateDeposit({} as never),
    /deposit computation overflowed: inputs too large/,
  );
});

test("calculateDepositCents with {} still fails on the named field error, not the shape guard", () => {
  assert.throws(
    () => calculateDepositCents({} as never),
    /complexityMultiplier must be a finite positive number/,
  );
});

test("calculateDeposit golden vector is unchanged by the guard", () => {
  const r = calculateDeposit(GOLDEN);
  assert.equal(r.adjustedBaseFee, 600);
  assert.equal(r.deposit, 10630);
  assert.equal(r.creatorPool, 10000);
});

test("calculateDepositCents golden vector is unchanged by the guard", () => {
  const r = calculateDepositCents(GOLDEN_CENTS);
  assert.equal(r.adjustedBaseFeeCents, 60000);
  assert.equal(r.depositCents, 1063000);
  assert.equal(r.creatorPoolCents, 1000000);
});
