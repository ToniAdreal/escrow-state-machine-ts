/**
 * Gross-to-net settlement on release.
 *
 * From the ALLWEB3 case study's "Creator Earnings Dashboard & Ledger":
 * gross earnings minus the platform pro fee (5% in the case study) and any
 * referral credits, paid out on escrow release.
 */

export interface SettlementInputs {
  gross: number;
  /** Platform fee in basis points, e.g. 500 = 5% */
  proFeeBps: number;
  referralCredits?: number;
}

export interface Settlement {
  gross: number;
  proFee: number;
  referralCredits: number;
  net: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function settleRelease(inputs: SettlementInputs): Settlement {
  const { gross, proFeeBps, referralCredits = 0 } = inputs;
  if (!Number.isFinite(gross) || gross < 0)
    throw new Error("gross must be a finite non-negative number");
  if (!Number.isInteger(proFeeBps) || proFeeBps < 0 || proFeeBps > 10000)
    throw new Error("proFeeBps must be an integer in [0, 10000]");
  if (!Number.isFinite(referralCredits) || referralCredits < 0)
    throw new Error("referralCredits must be a finite non-negative number");

  const proFee = round2((gross * proFeeBps) / 10000);
  const net = round2(gross - proFee - referralCredits);
  if (net < 0) throw new Error("net payout would be negative");
  return { gross, proFee, referralCredits, net };
}
