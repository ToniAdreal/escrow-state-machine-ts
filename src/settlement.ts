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
  referralCredits?: number | undefined;
}

export interface Settlement {
  gross: number;
  proFee: number;
  referralCredits: number;
  net: number;
}

export interface PartialSettlementInputs {
  gross: number;
  /** Amount released now; the rest stays locked (remaining = gross - released). */
  released: number;
  /** Platform fee in basis points, e.g. 500 = 5%; charged on the released amount only. */
  proFeeBps: number;
  referralCredits?: number | undefined;
}

export interface PartialSettlement {
  released: number;
  proFee: number;
  referralCredits: number;
  net: number;
  remaining: number;
}

/**
 * Partial-release settlement: split out one release from a larger locked
 * gross without touching escrow state. The fee is charged on the released
 * amount only (not on the whole gross), so a second partial release later
 * charges its own fee on its own amount and the fees never double-count.
 * Validation, rounding, overflow, and negative-net guards are delegated to
 * {@link settleRelease} with gross = released, so the two paths cannot drift
 * apart on fee or net semantics. State advancement still goes through
 * `dispatch`; this function is a pure arithmetic helper only.
 */
export function settlePartialRelease(
  inputs: PartialSettlementInputs,
): PartialSettlement {
  const { gross, released, proFeeBps, referralCredits = 0 } = inputs;
  if (!Number.isFinite(gross) || gross < 0)
    throw new Error("gross must be a finite non-negative number");
  if (!Number.isFinite(released) || released < 0)
    throw new Error("released must be a finite non-negative number");
  if (released > gross)
    throw new Error("released must not exceed gross");
  // settleRelease re-validates proFeeBps / referralCredits, rounds the fee
  // to cents, guards overflow, and rejects a negative net.
  const { proFee, net } = settleRelease({
    gross: released,
    proFeeBps,
    referralCredits,
  });
  const remaining = round2(gross - released);
  if (!Number.isFinite(remaining))
    throw new Error("settlement computation overflowed: inputs too large");
  return { released, proFee, referralCredits, net, remaining };
}

export interface PartialReleasesInputs {
  gross: number;
  /**
   * Release amounts in order; each tranche settles against the balance
   * still locked after the previous ones.
   */
  releases: number[];
  /** Platform fee in basis points, e.g. 500 = 5%; charged on each released amount, never on the whole gross. */
  proFeeBps: number;
  /**
   * Referral credits for the batch, applied to the first tranche only.
   * Credits are a per-payout concept in `settlePartialRelease` (they
   * reduce that payout's net); the batch takes one batch-level figure
   * and lands it on the first tranche so the total is never
   * double-counted and per-tranche fee/net still match the single
   * helper exactly. Credits with no releases throw instead of being
   * silently dropped.
   */
  referralCredits?: number | undefined;
}

export interface PartialReleases {
  gross: number;
  /** Per-tranche ledger, in the order the releases were given. */
  releases: PartialSettlement[];
  totalReleased: number;
  totalProFee: number;
  totalReferralCredits: number;
  totalNet: number;
  remaining: number;
}

/**
 * Cumulative partial-release settlement: settle a whole list of releases
 * against one locked gross in a single call, with a cumulative guard.
 *
 * `settlePartialRelease` only guards one release at a time, so a caller
 * releasing 600 and then 600 again against a gross of 1000 passed both
 * checks and over-paid by 200 in total. This function closes that gap:
 * the running total is checked against the gross before each tranche
 * settles, and a batch that would over-pay fails as a whole with the
 * cumulative figures in the error instead of settling the early
 * tranches and dying halfway.
 *
 * Design choice (backlog #972): the batch takes the full `releases`
 * array rather than an `alreadyReleased` running total. An
 * `alreadyReleased` parameter would still leave every call site
 * responsible for passing the right running total — the same bug one
 * argument away. Taking the list lets this function own the running
 * total and return the per-tranche ledger plus totals, so callers
 * never track it themselves. Each tranche delegates to
 * {@link settlePartialRelease} against the still-locked balance, so
 * fee, net, and rounding semantics cannot drift from the single
 * path. Pure arithmetic only: it does not change escrow state — state
 * advancement still goes through `dispatch`.
 */
export function settlePartialReleases(
  inputs: PartialReleasesInputs,
): PartialReleases {
  const { gross, releases, proFeeBps, referralCredits = 0 } = inputs;
  if (!Number.isFinite(gross) || gross < 0)
    throw new Error("gross must be a finite non-negative number");
  if (!Array.isArray(releases))
    throw new Error("releases must be an array of numbers");
  if (!Number.isInteger(proFeeBps) || proFeeBps < 0 || proFeeBps > 10000)
    throw new Error("proFeeBps must be an integer in [0, 10000]");
  if (!Number.isFinite(referralCredits) || referralCredits < 0)
    throw new Error("referralCredits must be a finite non-negative number");
  if (releases.length === 0 && referralCredits !== 0)
    throw new Error(
      "referralCredits require at least one release: credits are applied to the first tranche and there is none",
    );
  let cumulative = 0;
  let totalProFee = 0;
  let totalNet = 0;
  const settled: PartialSettlement[] = [];
  for (let i = 0; i < releases.length; i++) {
    const released = releases[i];
    if (!Number.isFinite(released) || released < 0)
      throw new Error(`releases[${i}] must be a finite non-negative number`);
    // Cumulative guard, checked before any per-tranche math so the batch
    // fails as a whole. Amounts accumulate through round2 (the repo's
    // cent model) so 0.1 + 0.2 settles exactly at 0.3.
    const nextCumulative = round2(cumulative + released);
    if (nextCumulative > gross)
      throw new Error(
        `cumulative released ${nextCumulative} exceeds gross ${gross} (release ${i + 1} of ${releases.length}: ${released} would bring the total to ${nextCumulative})`,
      );
    const tranche = settlePartialRelease({
      gross: round2(gross - cumulative),
      released,
      proFeeBps,
      referralCredits: i === 0 ? referralCredits : 0,
    });
    settled.push(tranche);
    cumulative = nextCumulative;
    totalProFee = round2(totalProFee + tranche.proFee);
    totalNet = round2(totalNet + tranche.net);
  }
  return {
    gross,
    releases: settled,
    totalReleased: cumulative,
    totalProFee,
    totalReferralCredits: releases.length === 0 ? 0 : referralCredits,
    totalNet,
    remaining: round2(gross - cumulative),
  };
}

export interface RefundSettlementInputs {
  /** Locked deposit to return in full, e.g. the deposit from `calculateDeposit`. */
  deposit: number;
}

export interface RefundSettlement {
  deposit: number;
  /** Full deposit returned to the sponsor (depositor). */
  sponsor: number;
  /** Always 0 on a refund: no creator payout on this path. */
  creator: number;
  /** Always 0 on a refund: no platform fee is charged on this path. */
  platform: number;
  /** Always 0 on a refund: no referral credit is paid out on this path. */
  referrer: number;
  /** Sum of the party amounts; equals `deposit` when balanced. */
  totalOutflow: number;
  /** True when `totalOutflow` equals `deposit` exactly. */
  balanced: boolean;
}

/**
 * Refund settlement: return the locked deposit to the sponsor in full.
 *
 * This is the pure-arithmetic counterpart of the REFUNDED branch of
 * `buildSettlementReport`, which likewise credits the sponsor with the
 * whole deposit and every other party with 0. No platform fee is charged
 * here: the case study's 5% pro fee is a release-time charge
 * (`settleRelease`), and `feeCalculator` defines how a deposit is built,
 * not a refund fee — so a refund deducts nothing. If a future product
 * ever charges a refund fee, it needs an explicit new parameter, not a
 * silent deduction inside this function. Amounts pass through exactly
 * (no cent rounding), so the result can never drift from the deposit
 * recorded in the audit history. Pure arithmetic only: it does not
 * change escrow state — state advancement still goes through `dispatch`.
 */
export function settleRefund(inputs: RefundSettlementInputs): RefundSettlement {
  const { deposit } = inputs;
  if (!Number.isFinite(deposit) || deposit < 0)
    throw new Error("deposit must be a finite non-negative number");
  const sponsor = deposit;
  const creator = 0;
  const platform = 0;
  const referrer = 0;
  const totalOutflow = sponsor + creator + platform + referrer;
  return {
    deposit,
    sponsor,
    creator,
    platform,
    referrer,
    totalOutflow,
    balanced: totalOutflow === deposit,
  };
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
  // Overflow: finite-but-huge inputs can push the intermediate arithmetic
  // past Number.MAX_VALUE, and round2(Infinity) is still Infinity. With
  // proFeeBps 0 the net itself overflows (gross 1e308 -> net Infinity, and
  // `Infinity < 0` is false, so the negative check below would silently let
  // it escape); with proFeeBps > 0 the fee overflows first and the net goes
  // to -Infinity, which the negative check would mislabel as a negative
  // payout. An infinite net would poison every downstream money sum
  // (buildSettlementReport party ledgers, webhook payloads), so fail fast
  // with an explicit overflow error instead of returning { net: Infinity }.
  // This check runs before the negative check on purpose: a non-finite
  // result is an overflow, not a merely-negative payout.
  if (!Number.isFinite(proFee) || !Number.isFinite(net))
    throw new Error("settlement computation overflowed: inputs too large");
  if (net < 0) throw new Error("net payout would be negative");
  return { gross, proFee, referralCredits, net };
}
