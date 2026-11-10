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
