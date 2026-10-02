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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function assertMoney(name: string, v: number): void {
  if (!Number.isFinite(v) || v < 0)
    throw new Error(`${name} must be a finite non-negative number`);
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
  return { ...inputs, adjustedBaseFee, deposit };
}
