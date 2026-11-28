/**
 * Gross-to-net settlement on release.
 *
 * From the ALLWEB3 case study's "Creator Earnings Dashboard & Ledger":
 * gross earnings minus the platform pro fee (5% in the case study) and any
 * referral credits, paid out on escrow release.
 */

/**
 * Shape guard shared by the four pure settlement helpers: a non-object
 * `inputs` is the caller's bug and must fail as a named error, not as a
 * bare TypeError from the destructure on the first line of each function.
 * Arrays are rejected too: destructuring an array would only yield
 * `undefined` fields and fail later with a misleading field error.
 */
function assertSettlementInputs(
  fn: string,
  inputs: unknown,
): asserts inputs is Record<string, unknown> {
  if (typeof inputs !== "object" || inputs === null || Array.isArray(inputs)) {
    throw new Error(
      `${fn}: invalid settlement inputs: inputs must be an object`,
    );
  }
}

/**
 * Unknown-field fail-closed for the settlement helpers: every helper
 * below destructures only the fields it knows, so a typo'd key
 * (`proFeeBp` for `proFeeBps`, `grosss` for `gross`) used to be silently
 * ignored — the misspelled value never reached the math, and the
 * missing real field then failed later with a misleading value error
 * (or, when the field was optional, the default quietly applied).
 * Unknown keys now throw `${fn}: unknown field "<name>"` before any
 * value is consumed. Each helper passes its own allowed set; the cents
 * variants use the `*Cents` spellings.
 */
function assertKnownSettlementFields(
  fn: string,
  inputs: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): void {
  for (const key of Object.keys(inputs)) {
    if (!allowed.has(key)) {
      throw new Error(`${fn}: unknown field "${key}"`);
    }
  }
}

const SETTLEMENT_FIELDS = new Set(["gross", "proFeeBps", "referralCredits"]);
const SETTLEMENT_CENTS_FIELDS = new Set([
  "grossCents",
  "proFeeBps",
  "referralCreditsCents",
]);
const PARTIAL_SETTLEMENT_FIELDS = new Set([
  "gross",
  "released",
  "proFeeBps",
  "referralCredits",
]);
const PARTIAL_SETTLEMENT_CENTS_FIELDS = new Set([
  "grossCents",
  "releasedCents",
  "proFeeBps",
  "referralCreditsCents",
]);
const PARTIAL_RELEASES_FIELDS = new Set([
  "gross",
  "releases",
  "proFeeBps",
  "referralCredits",
]);
const PARTIAL_RELEASES_CENTS_FIELDS = new Set([
  "grossCents",
  "releasesCents",
  "proFeeBps",
  "referralCreditsCents",
]);
const REFUND_FIELDS = new Set(["deposit"]);
const REFUND_CENTS_FIELDS = new Set(["depositCents"]);
const ARBITRATION_SPLIT_SETTLEMENT_CENTS_FIELDS = new Set([
  "grossCents",
  "creatorCents",
  "proFeeBps",
  "referralCreditsCents",
]);
const ARBITRATION_SPLIT_SETTLEMENT_FIELDS = new Set([
  "gross",
  "creator",
  "proFeeBps",
  "referralCredits",
]);

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
  assertSettlementInputs("settlePartialRelease", inputs);
  assertKnownSettlementFields("settlePartialRelease", inputs, PARTIAL_SETTLEMENT_FIELDS);
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
  assertSettlementInputs("settlePartialReleases", inputs);
  assertKnownSettlementFields("settlePartialReleases", inputs, PARTIAL_RELEASES_FIELDS);
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
  assertSettlementInputs("settleRefund", inputs);
  assertKnownSettlementFields("settleRefund", inputs, REFUND_FIELDS);
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

export interface ArbitrationSplitSettlementInputs {
  /** Still-locked balance to divide, in float dollars. */
  gross: number;
  /** Creator's share of the locked balance, in float dollars. */
  creator: number;
  /** Platform fee in basis points, e.g. 500 = 5%; charged on the creator share only. */
  proFeeBps: number;
  referralCredits?: number | undefined;
}

export interface ArbitrationSplitSettlement {
  gross: number;
  /** Creator's gross share, in float dollars. */
  creator: number;
  /** Sponsor's share (refund, no fee), in float dollars: `gross - creator`. */
  sponsor: number;
  /** Platform fee on the creator share only, in float dollars. */
  proFee: number;
  referralCredits: number;
  /** Creator's net payout: `creator - proFee - referralCredits`. */
  creatorNet: number;
  /** Sum of the party amounts; equals `gross` when balanced. */
  totalOutflow: number;
  /** True when `totalOutflow` equals `gross` exactly. */
  balanced: boolean;
}

/**
 * Dollar settlement for an arbitrated split (backlog #1458): divide the
 * still-locked balance between creator and sponsor.
 *
 * The dollar twin of {@link settleArbitrationSplitCents}, in the same
 * shape as the other dollar helpers: the creator leg settles exactly
 * like a single partial release of the same amount — `settlePartialRelease`
 * with `released: creator` — so the platform fee is charged on the
 * creator share only, with the same `round2` fee rounding and the same
 * negative-net guard; the sponsor leg is a full refund of the remainder
 * (`settleRefund` semantics), so the sponsor share is the release's
 * `remaining` and the two shares sum to the gross by construction. A
 * creator share above the gross throws (`creator must not exceed gross`);
 * referral credits above the creator net throw `net payout would be
 * negative`. The fee is computed on binary floats (`round2(creator *
 * proFeeBps / 10000)`), so on cent-exact inputs the dust can flip a
 * half-cent (gross 1.15 at 5000 bps fees 0.57 here, 58 cents exactly
 * in the cents version) — callers that already keep money as integer
 * cents should use {@link settleArbitrationSplitCents}. Pure arithmetic
 * only: state advancement still goes through `dispatch`
 * (`ARBITRATE_SPLIT`).
 */
export function settleArbitrationSplit(
  inputs: ArbitrationSplitSettlementInputs,
): ArbitrationSplitSettlement {
  assertSettlementInputs("settleArbitrationSplit", inputs);
  assertKnownSettlementFields(
    "settleArbitrationSplit",
    inputs,
    ARBITRATION_SPLIT_SETTLEMENT_FIELDS,
  );
  const { gross, creator, proFeeBps, referralCredits = 0 } = inputs;
  if (!Number.isFinite(gross) || gross < 0)
    throw new Error("gross must be a finite non-negative number");
  if (!Number.isFinite(creator) || creator < 0)
    throw new Error("creator must be a finite non-negative number");
  if (creator > gross)
    throw new Error("creator must not exceed gross");
  const leg = settlePartialRelease({
    gross,
    released: creator,
    proFeeBps,
    referralCredits,
  });
  const sponsor = leg.remaining;
  // The legs are already cent-rounded, but their float sum can carry
  // dust (0.1 + 0.2); round2 recovers the exact cent sum, matching the
  // accumulation convention in settlePartialReleases.
  const totalOutflow = round2(
    leg.net + leg.proFee + leg.referralCredits + sponsor,
  );
  return {
    gross,
    creator,
    sponsor,
    proFee: leg.proFee,
    referralCredits: leg.referralCredits,
    creatorNet: leg.net,
    totalOutflow,
    balanced: totalOutflow === gross,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Gross-to-net settlement on release, in float dollars.
 *
 * New callers that already keep money as integer cents should use
 * {@link settleReleaseCents} instead: the fee here is computed as
 * `round2(gross * proFeeBps / 10000)` on binary floats, and on some
 * cent-exact inputs that dust flips the half-cent (gross 1.15 at
 * 5000 bps fees 0.57 here, 58 cents exactly in the cents version).
 * This function stays unchanged for existing dollar-denominated
 * callers; see the cents version for the exact-arithmetic path.
 */
export function settleRelease(inputs: SettlementInputs): Settlement {
  assertSettlementInputs("settleRelease", inputs);
  assertKnownSettlementFields("settleRelease", inputs, SETTLEMENT_FIELDS);
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

// ---------------------------------------------------------------------------
// Integer minor-unit (cents) settlement.
//
// The dollar helpers above compute the fee as `round2(gross * bps / 10000)`
// on binary floats. That is fine for most inputs, but on cent-exact inputs
// the float dust can flip a half-cent: gross 1.15 at 5000 bps fees 0.57 in
// `settleRelease` (1.15 * 5000 / 10000 * 100 is 57.49999999999999, so
// Math.round takes 57), while the exact half-up fee is 58 cents. The cents
// helpers below are the exact-arithmetic counterparts, in the same shape as
// `calculateDepositCents` in feeCalculator.ts: every money field is a whole
// number of cents in and out, the fee is rounded a single time, half-up, to
// the nearest cent, and the two APIs agree to the cent on the same inputs
// except where the float version's dust flips a half-cent — there the cents
// version is right by construction. This is the recommended path for new
// callers; the dollar helpers stay unchanged for existing callers.
// ---------------------------------------------------------------------------

export interface SettlementInputsCents {
  /** Gross amount in integer cents, e.g. 1999 for $19.99. */
  grossCents: number;
  /** Platform fee in basis points, e.g. 500 = 5% */
  proFeeBps: number;
  referralCreditsCents?: number | undefined;
}

export interface SettlementCents {
  grossCents: number;
  proFeeCents: number;
  referralCreditsCents: number;
  netCents: number;
}

export interface PartialSettlementInputsCents {
  grossCents: number;
  /** Amount released now, in integer cents; the rest stays locked. */
  releasedCents: number;
  /** Platform fee in basis points, e.g. 500 = 5%; charged on the released amount only. */
  proFeeBps: number;
  referralCreditsCents?: number | undefined;
}

export interface PartialSettlementCents {
  releasedCents: number;
  proFeeCents: number;
  referralCreditsCents: number;
  netCents: number;
  remainingCents: number;
}

export interface PartialReleasesInputsCents {
  grossCents: number;
  /**
   * Release amounts in order, in integer cents; each tranche settles
   * against the balance still locked after the previous ones.
   */
  releasesCents: number[];
  /** Platform fee in basis points, e.g. 500 = 5%; charged on each released amount, never on the whole gross. */
  proFeeBps: number;
  /**
   * Referral credits for the batch, in integer cents, applied to the
   * first tranche only. Credits with no releases throw instead of
   * being silently dropped.
   */
  referralCreditsCents?: number | undefined;
}

export interface PartialReleasesCents {
  grossCents: number;
  /** Per-tranche ledger, in the order the releases were given. */
  releases: PartialSettlementCents[];
  totalReleasedCents: number;
  totalProFeeCents: number;
  totalReferralCreditsCents: number;
  totalNetCents: number;
  remainingCents: number;
}

export interface RefundSettlementInputsCents {
  /** Locked deposit to return in full, in integer cents. */
  depositCents: number;
}

export interface RefundSettlementCents {
  depositCents: number;
  /** Full deposit returned to the sponsor (depositor). */
  sponsorCents: number;
  /** Always 0 on a refund: no creator payout on this path. */
  creatorCents: number;
  /** Always 0 on a refund: no platform fee is charged on this path. */
  platformCents: number;
  /** Always 0 on a refund: no referral credit is paid out on this path. */
  referrerCents: number;
  /** Sum of the party amounts; equals `depositCents` when balanced. */
  totalOutflowCents: number;
  /** True when `totalOutflowCents` equals `depositCents` exactly. */
  balanced: boolean;
}

function assertMoneyCents(name: string, v: number): void {
  if (!Number.isSafeInteger(v) || v < 0)
    throw new Error(
      `${name} must be a finite non-negative integer number of cents`,
    );
}

function assertProFeeBps(proFeeBps: number): void {
  if (!Number.isInteger(proFeeBps) || proFeeBps < 0 || proFeeBps > 10000)
    throw new Error("proFeeBps must be an integer in [0, 10000]");
}

/**
 * Exact half-up fee in cents: `round(grossCents * proFeeBps / 10000)`.
 * Computed in BigInt so even a `Number.MAX_SAFE_INTEGER` gross stays
 * exact (the float product would lose low bits long before that). The
 * result can never exceed `grossCents` (bps <= 10000), so it is always
 * a safe integer when the gross is.
 */
function feeCents(grossCents: number, proFeeBps: number): number {
  return Number(
    (BigInt(grossCents) * BigInt(proFeeBps) + 5000n) / 10000n,
  );
}

/**
 * Integer-cents version of {@link settleRelease}: the same gross-to-net
 * settlement, but every money field is a whole number of cents in and
 * out. The fee is rounded a single time, half-up, to the nearest cent
 * (exact integer arithmetic, no float dust), the net is an exact
 * subtraction, and a negative net throws the same
 * `net payout would be negative` error as the dollar version.
 * Inputs that are not whole cents, negative, or not safe integers fail
 * fast, as does a `proFeeBps` outside [0, 10000].
 */
export function settleReleaseCents(
  inputs: SettlementInputsCents,
): SettlementCents {
  assertSettlementInputs("settleReleaseCents", inputs);
  assertKnownSettlementFields("settleReleaseCents", inputs, SETTLEMENT_CENTS_FIELDS);
  const { grossCents, proFeeBps, referralCreditsCents = 0 } = inputs;
  assertMoneyCents("grossCents", grossCents);
  assertProFeeBps(proFeeBps);
  assertMoneyCents("referralCreditsCents", referralCreditsCents);
  const proFeeCents = feeCents(grossCents, proFeeBps);
  const netCents = grossCents - proFeeCents - referralCreditsCents;
  if (netCents < 0) throw new Error("net payout would be negative");
  return { grossCents, proFeeCents, referralCreditsCents, netCents };
}

/**
 * Integer-cents version of {@link settlePartialRelease}: split out one
 * release from a larger locked gross without touching escrow state. The
 * fee is charged on the released amount only, via
 * {@link settleReleaseCents} with gross = released, so the two paths
 * cannot drift apart on fee or net semantics; the remaining balance is
 * an exact integer subtraction, never a `round2`.
 */
export function settlePartialReleaseCents(
  inputs: PartialSettlementInputsCents,
): PartialSettlementCents {
  assertSettlementInputs("settlePartialReleaseCents", inputs);
  assertKnownSettlementFields("settlePartialReleaseCents", inputs, PARTIAL_SETTLEMENT_CENTS_FIELDS);
  const { grossCents, releasedCents, proFeeBps, referralCreditsCents = 0 } =
    inputs;
  assertMoneyCents("grossCents", grossCents);
  assertMoneyCents("releasedCents", releasedCents);
  if (releasedCents > grossCents)
    throw new Error("releasedCents must not exceed grossCents");
  const { proFeeCents, netCents } = settleReleaseCents({
    grossCents: releasedCents,
    proFeeBps,
    referralCreditsCents,
  });
  return {
    releasedCents,
    proFeeCents,
    referralCreditsCents,
    netCents,
    remainingCents: grossCents - releasedCents,
  };
}

/**
 * Integer-cents version of {@link settlePartialReleases}: settle a whole
 * list of releases against one locked gross in a single call, with an
 * exact cumulative guard. The guard compares `releasedCents` against
 * `grossCents - cumulative` instead of adding first, so even a batch
 * whose running total approaches `Number.MAX_SAFE_INTEGER` cannot lose
 * a cent to float addition rounding — the comparison operands are exact
 * integer differences of safe integers. Each tranche delegates to
 * {@link settlePartialReleaseCents} against the still-locked balance,
 * so fee, net, and rounding semantics cannot drift from the single
 * path. Pure arithmetic only: state advancement still goes through
 * `dispatch`.
 */
export function settlePartialReleasesCents(
  inputs: PartialReleasesInputsCents,
): PartialReleasesCents {
  assertSettlementInputs("settlePartialReleasesCents", inputs);
  assertKnownSettlementFields("settlePartialReleasesCents", inputs, PARTIAL_RELEASES_CENTS_FIELDS);
  const { grossCents, releasesCents, proFeeBps, referralCreditsCents = 0 } =
    inputs;
  assertMoneyCents("grossCents", grossCents);
  if (!Array.isArray(releasesCents))
    throw new Error("releasesCents must be an array of numbers");
  assertProFeeBps(proFeeBps);
  assertMoneyCents("referralCreditsCents", referralCreditsCents);
  if (releasesCents.length === 0 && referralCreditsCents !== 0)
    throw new Error(
      "referralCreditsCents require at least one release: credits are applied to the first tranche and there is none",
    );
  let cumulative = 0;
  let totalProFeeCents = 0;
  let totalNetCents = 0;
  const settled: PartialSettlementCents[] = [];
  for (let i = 0; i < releasesCents.length; i++) {
    const releasedCents = releasesCents[i];
    assertMoneyCents(`releasesCents[${i}]`, releasedCents);
    // Exact cumulative guard, checked before any per-tranche math so the
    // batch fails as a whole. `grossCents - cumulative` is exact (both
    // safe integers), so this never admits an over-pay by float dust.
    if (releasedCents > grossCents - cumulative) {
      // The would-be total is rendered via BigInt: cumulative and the
      // tranche are each safe integers, but their sum need not be, and a
      // float-rounded figure in an error message would misstate the
      // over-pay by a cent at the top of the range.
      const wouldBe = BigInt(cumulative) + BigInt(releasedCents);
      throw new Error(
        `cumulative released ${wouldBe} exceeds gross ${grossCents} (release ${i + 1} of ${releasesCents.length}: ${releasedCents} would bring the total to ${wouldBe})`,
      );
    }
    const tranche = settlePartialReleaseCents({
      grossCents: grossCents - cumulative,
      releasedCents,
      proFeeBps,
      referralCreditsCents: i === 0 ? referralCreditsCents : 0,
    });
    settled.push(tranche);
    cumulative += releasedCents;
    totalProFeeCents += tranche.proFeeCents;
    totalNetCents += tranche.netCents;
  }
  return {
    grossCents,
    releases: settled,
    totalReleasedCents: cumulative,
    totalProFeeCents,
    totalReferralCreditsCents:
      releasesCents.length === 0 ? 0 : referralCreditsCents,
    totalNetCents,
    remainingCents: grossCents - cumulative,
  };
}

export interface ArbitrationSplitSettlementInputsCents {
  /** Still-locked balance to divide, in integer cents. */
  grossCents: number;
  /** Creator's share of the locked balance, in integer cents. */
  creatorCents: number;
  /** Platform fee in basis points, e.g. 500 = 5%; charged on the creator share only. */
  proFeeBps: number;
  referralCreditsCents?: number | undefined;
}

export interface ArbitrationSplitSettlementCents {
  grossCents: number;
  /** Creator's gross share, in integer cents. */
  creatorCents: number;
  /** Sponsor's share (refund, no fee), in integer cents: `grossCents - creatorCents`. */
  sponsorCents: number;
  /** Platform fee on the creator share only, in integer cents. */
  proFeeCents: number;
  referralCreditsCents: number;
  /** Creator's net payout: `creatorCents - proFeeCents - referralCreditsCents`. */
  creatorNetCents: number;
  /** Sum of the party amounts; equals `grossCents` when balanced. */
  totalOutflowCents: number;
  /** True when `totalOutflowCents` equals `grossCents` exactly. */
  balanced: boolean;
}

/**
 * Integer-cents settlement for an arbitrated split (backlog #1449):
 * divide the still-locked balance between creator and sponsor.
 *
 * The creator leg settles exactly like a single partial release of
 * the same amount — `settlePartialReleaseCents` with
 * `releasedCents: creatorCents` — so the platform fee is charged on
 * the creator share only, with the same half-up BigInt rounding and
 * the same negative-net guard; the sponsor leg is a full refund of
 * the remainder (`settleRefundCents` semantics), so the sponsor
 * share is the release's `remainingCents` and the two shares sum to
 * the gross by construction. A creator share above the gross throws
 * through the release helper (`releasedCents must not exceed
 * grossCents`); referral credits above the creator net throw
 * `net payout would be negative`. Pure arithmetic only: state
 * advancement still goes through `dispatch` (`ARBITRATE_SPLIT`).
 */
export function settleArbitrationSplitCents(
  inputs: ArbitrationSplitSettlementInputsCents,
): ArbitrationSplitSettlementCents {
  assertSettlementInputs("settleArbitrationSplitCents", inputs);
  assertKnownSettlementFields(
    "settleArbitrationSplitCents",
    inputs,
    ARBITRATION_SPLIT_SETTLEMENT_CENTS_FIELDS,
  );
  const { grossCents, creatorCents, proFeeBps, referralCreditsCents = 0 } =
    inputs;
  assertMoneyCents("grossCents", grossCents);
  assertMoneyCents("creatorCents", creatorCents);
  assertProFeeBps(proFeeBps);
  assertMoneyCents("referralCreditsCents", referralCreditsCents);
  const leg = settlePartialReleaseCents({
    grossCents,
    releasedCents: creatorCents,
    proFeeBps,
    referralCreditsCents,
  });
  const sponsorCents = leg.remainingCents;
  const totalOutflowCents =
    leg.netCents +
    leg.proFeeCents +
    leg.referralCreditsCents +
    sponsorCents;
  return {
    grossCents,
    creatorCents,
    sponsorCents,
    proFeeCents: leg.proFeeCents,
    referralCreditsCents: leg.referralCreditsCents,
    creatorNetCents: leg.netCents,
    totalOutflowCents,
    balanced: totalOutflowCents === grossCents,
  };
}

/**
 * Integer-cents version of {@link settleRefund}: return the locked
 * deposit to the sponsor in full. Amounts pass through exactly (no
 * cent rounding), so the result can never drift from the deposit
 * recorded in the audit history. Pure arithmetic only: state
 * advancement still goes through `dispatch`.
 */
export function settleRefundCents(
  inputs: RefundSettlementInputsCents,
): RefundSettlementCents {
  assertSettlementInputs("settleRefundCents", inputs);
  assertKnownSettlementFields("settleRefundCents", inputs, REFUND_CENTS_FIELDS);
  const { depositCents } = inputs;
  assertMoneyCents("depositCents", depositCents);
  const sponsorCents = depositCents;
  const creatorCents = 0;
  const platformCents = 0;
  const referrerCents = 0;
  const totalOutflowCents =
    sponsorCents + creatorCents + platformCents + referrerCents;
  return {
    depositCents,
    sponsorCents,
    creatorCents,
    platformCents,
    referrerCents,
    totalOutflowCents,
    balanced: totalOutflowCents === depositCents,
  };
}
