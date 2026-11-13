/**
 * Deterministic campaign fee calculator.
 *
 * Reproduces the "Deterministic Fee Calculator & Escrow Preview" from the
 * ALLWEB3 portfolio case study:
 *
 *   deposit = creatorPool + (baseFee × complexityMultiplier)
 *             − loyaltyDiscount + oracleFee
 *
 * Portfolio golden vector: pool $10,000, base $600, complexity 1.0x,
 * loyalty −$30, oracle $60 → deposit $10,630.
 */

export interface FeeInputs {
  /** Creator pool, e.g. 10000 */
  creatorPool: number;
  /** Base service fee, e.g. 600 */
  baseFee: number;
  /** Complexity multiplier, e.g. 1.0 */
  complexityMultiplier: number;
  /** Loyalty discount subtracted, e.g. 30 */
  loyaltyDiscount: number;
  /** Oracle verification fee added, e.g. 60 */
  oracleFee: number;
}

export interface FeeBreakdown extends FeeInputs {
  adjustedBaseFee: number;
  deposit: number;
}

/**
 * Integer-cents version of {@link FeeInputs}: every money field is a whole
 * number of cents, so callers that already keep money as integer cents
 * (like `maxDepositCents`) never have to round-trip through float dollars.
 * `complexityMultiplier` stays a plain multiplier, exactly as in the
 * dollar version.
 */
export interface FeeInputsCents {
  /** Creator pool in integer cents, e.g. 1000000 */
  creatorPoolCents: number;
  /** Base service fee in integer cents, e.g. 60000 */
  baseFeeCents: number;
  /** Complexity multiplier, e.g. 1.0 */
  complexityMultiplier: number;
  /** Loyalty discount in integer cents, subtracted, e.g. 3000 */
  loyaltyDiscountCents: number;
  /** Oracle verification fee in integer cents, added, e.g. 6000 */
  oracleFeeCents: number;
}

export interface FeeBreakdownCents extends FeeInputsCents {
  adjustedBaseFeeCents: number;
  depositCents: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function assertMoney(name: string, v: number): void {
  if (!Number.isFinite(v) || v < 0)
    throw new Error(`${name} must be a finite non-negative number`);
}

function assertMoneyCents(name: string, v: number): void {
  if (!Number.isInteger(v) || v < 0)
    throw new Error(`${name} must be a finite non-negative integer number of cents`);
}

export function calculateDeposit(inputs: FeeInputs): FeeBreakdown {
  for (const [k, v] of Object.entries(inputs)) assertMoney(k, v as number);
  if (inputs.complexityMultiplier <= 0)
    throw new Error("complexityMultiplier must be positive");

  const adjustedBaseFee = round2(inputs.baseFee * inputs.complexityMultiplier);
  const deposit = round2(
    inputs.creatorPool + adjustedBaseFee - inputs.loyaltyDiscount + inputs.oracleFee,
  );
  if (deposit < 0) throw new Error("deposit would be negative");
  // Overflow: finite-but-huge inputs (e.g. complexityMultiplier 1e308) can
  // push the intermediate arithmetic past Number.MAX_VALUE, and
  // round2(Infinity) is still Infinity. An infinite deposit would poison
  // every downstream money sum (buildSettlementReport ledgers, webhook
  // payloads), so fail fast with an explicit error instead of returning
  // { deposit: Infinity }.
  if (!Number.isFinite(deposit))
    throw new Error("deposit computation overflowed: inputs too large");
  return { ...inputs, adjustedBaseFee, deposit };
}

/**
 * Integer-cents version of {@link calculateDeposit}: the same formula,
 * but every money field is a whole number of cents in and out.
 *
 *   depositCents = creatorPoolCents
 *     + roundHalfUp(baseFeeCents × complexityMultiplier)
 *     − loyaltyDiscountCents + oracleFeeCents
 *
 * The multiplier is applied once and rounded a single time, half-up to
 * the nearest cent — the same single-final-rounding shape as the dollar
 * version's `round2`, so the two APIs agree to the cent on the same
 * inputs (no per-item rounding, no accumulated error). With integer-cent
 * inputs there is no `0.1 + 0.2` dust to mop up afterwards: a caller
 * holding cents end to end never leaves the integer domain.
 *
 * This is the recommended path for new callers; `calculateDeposit`
 * stays unchanged for existing dollar-denominated callers. Inputs that
 * are not whole cents, negative, or non-finite fail fast, as do a
 * non-positive multiplier, a negative deposit, and an overflowing
 * computation (same error messages as the dollar version).
 *
 * Golden vector: pool 1,000,000¢, base 60,000¢, complexity 1.0x,
 * loyalty −3,000¢, oracle +6,000¢ → deposit 1,063,000¢.
 */
export function calculateDepositCents(inputs: FeeInputsCents): FeeBreakdownCents {
  for (const [k, v] of Object.entries(inputs)) {
    if (k === "complexityMultiplier") continue;
    assertMoneyCents(k, v as number);
  }
  if (!Number.isFinite(inputs.complexityMultiplier) || inputs.complexityMultiplier <= 0)
    throw new Error("complexityMultiplier must be a finite positive number");

  // Inputs are non-negative integers and the multiplier is positive, so
  // the product is non-negative and Math.round is half-up here.
  const adjustedBaseFeeCents = Math.round(
    inputs.baseFeeCents * inputs.complexityMultiplier,
  );
  const depositCents =
    inputs.creatorPoolCents +
    adjustedBaseFeeCents -
    inputs.loyaltyDiscountCents +
    inputs.oracleFeeCents;
  if (depositCents < 0) throw new Error("deposit would be negative");
  // Same overflow guard as the dollar version: finite-but-huge inputs can
  // push the intermediate arithmetic past Number.MAX_VALUE. An infinite
  // deposit would poison every downstream money sum, so fail fast.
  if (!Number.isFinite(depositCents))
    throw new Error("deposit computation overflowed: inputs too large");
  return { ...inputs, adjustedBaseFeeCents, depositCents };
}

/**
 * Format integer minor units (cents) as a fixed two-decimal string for
 * display on statements and reconciliation output: `10098` becomes
 * `"100.98"`, `0` becomes `"0.00"`, and a negative amount keeps its
 * leading minus (`-100` becomes `"-1.00"`). The format is deliberately
 * bare — exactly two decimal places, no thousands separator, no
 * currency symbol — because the currency is the caller's context (the
 * same no-currency convention as {@link calculateDepositCents}), and a
 * bare string keeps statement text stable across callers instead of
 * each one inventing its own decimal/separator convention.
 *
 * This is the public, exact counterpart to the private `csvMoney`
 * (`round2` + `toFixed(2)` float path) used only by the CSV renderer:
 * callers that hold integer cents — the output of
 * {@link calculateDepositCents} or a settlement ledger — should format
 * through here, not hand-roll `toFixed` or `/100`.
 *
 * The input must be an integer — a fractional "minor unit" is a caller
 * error, not a representable amount — so anything else throws. The
 * split is done in integer arithmetic
 * (`whole = (abs - cents) / 100`), never through a float division
 * followed by rounding, so large amounts (including
 * `Number.MAX_SAFE_INTEGER`) format exactly, with no precision drift.
 */
export function formatMinorUnits(minorUnits: number): string {
  if (!Number.isInteger(minorUnits)) {
    throw new Error(
      `minor units must be an integer, got ${String(minorUnits)}`,
    );
  }
  const sign = minorUnits < 0 ? "-" : "";
  const abs = Math.abs(minorUnits);
  const cents = abs % 100;
  const whole = (abs - cents) / 100;
  return `${sign}${whole}.${String(cents).padStart(2, "0")}`;
}

/**
 * Parse a strict decimal amount string into integer minor units
 * (cents): `"12.34"` becomes `1234`, `"-0.50"` becomes `-50`. This is
 * the string counterpart to {@link calculateDepositCents} for
 * reconciliation and CSV-import callers, who receive amounts as text
 * and previously had to go through `Number()` first — a step that
 * silently accepted `"12.345"` (sub-cent, then rounded by the
 * converter), `"1,234.56"` (thousands separator), and `"1.2e3"`
 * (scientific notation) with no single answer for any of them.
 *
 * The grammar is deliberately narrow: an optional minus sign, at
 * least one digit, and an optional fraction of one or two digits.
 * Surrounding whitespace is trimmed; anything else fails fast —
 * thousands separators, scientific notation, a leading `+`, a bare
 * decimal point (`".5"`), a trailing point (`"12."`), internal
 * whitespace, or any other impurity. An empty (or whitespace-only)
 * string and a non-string input fail fast too. The conversion itself
 * is exact integer arithmetic (via `BigInt`), never a float
 * multiply-and-round, so `"0.29"` is exactly `29` and a value whose
 * minor units exceed `Number.MAX_SAFE_INTEGER` throws instead of
 * returning a rounded-off integer. A zero result is always `0`,
 * never `-0`, so `parseMinorUnits("-0.00") === 0`.
 *
 * Round-trip: `parseMinorUnits(formatMinorUnits(n)) === n` for every
 * integer `n` in the safe range, including negatives.
 */
export function parseMinorUnits(text: string): number {
  if (typeof text !== "string") {
    throw new Error(
      `invalid minor units amount: expected a string, got ${JSON.stringify(text)}`,
    );
  }
  const trimmed = text.trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (match === null) {
    throw new Error(
      `invalid minor units amount: ${JSON.stringify(text)} is not a strict decimal amount (optional minus, at most 2 decimal places, no thousands separator, no scientific notation)`,
    );
  }
  const fraction = (match[3] ?? "").padEnd(2, "0");
  const total =
    BigInt(match[2]) * 100n + BigInt(fraction === "" ? "0" : fraction);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `minor units conversion overflowed: ${JSON.stringify(text)} is too large to represent in minor units`,
    );
  }
  const minorUnits = Number(total);
  if (minorUnits === 0) return 0;
  return match[1] === "-" ? -minorUnits : minorUnits;
}
