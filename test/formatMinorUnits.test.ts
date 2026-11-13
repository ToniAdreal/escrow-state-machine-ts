import test from "node:test";
import assert from "node:assert/strict";
import { calculateDepositCents, formatMinorUnits, parseMinorUnits } from "../src/index.js";

/**
 * Fixed-format display for integer minor units (backlog #1095).
 *
 * `calculateDepositCents` produces integer cents, but a caller
 * printing an amount for a statement had to build the string itself
 * (or hand-roll `toFixed` / `/100`), so decimal places, the minus
 * sign and separators drifted per caller — and the only in-repo
 * stringification was the private CSV `round2` + `toFixed(2)` float
 * path. `formatMinorUnits` pins one bare format: exactly two
 * decimals, no thousands separator, no currency symbol.
 * Semantics mirror the dataquest sibling (`formatMinorUnits` there).
 */

test("formatMinorUnits formats positive amounts with exactly two decimals", () => {
  assert.equal(formatMinorUnits(10098), "100.98");
  assert.equal(formatMinorUnits(1), "0.01");
  assert.equal(formatMinorUnits(99), "0.99");
  assert.equal(formatMinorUnits(100), "1.00");
  assert.equal(formatMinorUnits(101), "1.01");
  assert.equal(formatMinorUnits(250000), "2500.00");
});

test("formatMinorUnits formats zero without a minus sign", () => {
  assert.equal(formatMinorUnits(0), "0.00");
  assert.equal(formatMinorUnits(-0), "0.00");
});

test("formatMinorUnits keeps the leading minus on negative amounts", () => {
  assert.equal(formatMinorUnits(-100), "-1.00");
  assert.equal(formatMinorUnits(-1), "-0.01");
  assert.equal(formatMinorUnits(-10098), "-100.98");
  assert.equal(formatMinorUnits(-99), "-0.99");
});

test("formatMinorUnits never adds separators or a currency symbol", () => {
  for (const value of [1000000, 123456789, -123456789]) {
    const formatted = formatMinorUnits(value);
    assert.match(formatted, /^-?\d+\.\d{2}$/);
    assert.equal(formatted.includes(","), false);
    assert.equal(formatted.includes("$"), false);
  }
  assert.equal(formatMinorUnits(1000000), "10000.00");
});

test("formatMinorUnits formats large amounts without precision drift", () => {
  // At and above 10^9 minor units, the range the sibling item calls out.
  assert.equal(formatMinorUnits(1000000000), "10000000.00");
  assert.equal(formatMinorUnits(1234567890123), "12345678901.23");
  // Integer arithmetic, not float division + rounding: the largest
  // safe integer formats exactly (remainder 91, whole 90071992547409).
  assert.equal(
    formatMinorUnits(Number.MAX_SAFE_INTEGER),
    "90071992547409.91",
  );
  assert.equal(
    formatMinorUnits(-Number.MAX_SAFE_INTEGER),
    "-90071992547409.91",
  );
});

test("formatMinorUnits rejects non-integers", () => {
  for (const value of [10.5, -0.5, Number.NaN, Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY]) {
    assert.throws(
      () => formatMinorUnits(value),
      new RegExp(
        `minor units must be an integer, got ${String(value).replace(".", "\\.")}`,
      ),
      `expected ${String(value)} to be rejected`,
    );
  }
});

test("formatMinorUnits agrees with the cents fee calculator", () => {
  // The golden vector's deposit, 1,063,000 cents, formats exactly.
  const { depositCents } = calculateDepositCents({
    creatorPoolCents: 1000000,
    baseFeeCents: 60000,
    complexityMultiplier: 1.0,
    loyaltyDiscountCents: 3000,
    oracleFeeCents: 6000,
  });
  assert.equal(formatMinorUnits(depositCents), "10630.00");
  assert.equal(parseMinorUnits(formatMinorUnits(depositCents)), depositCents);
});

test("formatMinorUnits is exported from the package entry point", async () => {
  const mod = await import("../src/index.js");
  assert.equal(typeof mod.formatMinorUnits, "function");
  assert.equal(mod.formatMinorUnits(10098), "100.98");
});
