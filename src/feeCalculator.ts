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
  // Safe-integer, not merely integer: a double past
  // Number.MAX_SAFE_INTEGER (e.g. the literal 9007199254740993, which
  // arrives as 9007199254740992) is an integer but no longer names a
  // single cent value, so accepting it would let the arithmetic below
  // silently return a rounded-off amount. Same gate as settlement.ts's
  // assertMoneyCents.
  if (!Number.isSafeInteger(v) || v < 0)
    throw new Error(`${name} must be a finite non-negative integer number of cents`);
}

/**
 * Shape guard shared by the two fee calculators: a non-object `inputs`
 * is the caller's bug and must fail as a named error, not as a bare
 * TypeError from `Object.entries` on the first line of each function
 * (and not as a misleading field error — `Object.entries("x")` yields
 * `[["0", "x"]]`, so a string input used to die as `0 must be a finite
 * non-negative number`). Same fn-prefixed shape as #1348's
 * `assertSettlementInputs`, with the `got` value rendered via
 * `JSON.stringify` like `buildSettlementReport` (#1347). Arrays are
 * rejected too: their entries would only yield misleading field errors.
 */
function assertFeeInputs(
  fn: string,
  inputs: unknown,
): asserts inputs is Record<string, unknown> {
  if (typeof inputs !== "object" || inputs === null || Array.isArray(inputs)) {
    throw new Error(
      `${fn}: inputs must be an object, got ${JSON.stringify(inputs)}`,
    );
  }
}

/**
 * Unknown-field fail-closed for the fee calculators: a typo'd field
 * (`creatorPoll` for `creatorPool`, `tax` for a fee that does not exist)
 * used to be silently ignored — and worse, `calculateDeposit` spreads
 * `inputs` into its result, so the typo'd key leaked into the returned
 * breakdown and from there into settlement reports and webhook payloads.
 * Unknown keys now throw `${fn}: unknown field "<name>"` before any
 * value is consumed, so a misspelled field can never silently disable
 * part of the fee formula. Missing required fields still fail on their
 * own value check below; only unknown keys are rejected here.
 */
function assertKnownFeeFields(
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

const FEE_INPUT_FIELDS = new Set([
  "creatorPool",
  "baseFee",
  "complexityMultiplier",
  "loyaltyDiscount",
  "oracleFee",
]);

const FEE_INPUT_CENTS_FIELDS = new Set([
  "creatorPoolCents",
  "baseFeeCents",
  "complexityMultiplier",
  "loyaltyDiscountCents",
  "oracleFeeCents",
]);

/**
 * Dollar version of the fee formula (see the module doc): float
 * arithmetic with a single final `round2`, unchanged for existing
 * dollar-denominated callers. Callers holding large amounts or
 * needing cent-exact results should use {@link calculateDepositCents}
 * instead — it computes the same formula in `BigInt` and fails
 * loudly past `Number.MAX_SAFE_INTEGER` instead of silently rounding.
 */
export function calculateDeposit(inputs: FeeInputs): FeeBreakdown {
  // Shape first, before the `Object.entries` scan: see `assertFeeInputs`.
  assertFeeInputs("calculateDeposit", inputs);
  // Unknown fields fail closed before any value is consumed, so a
  // typo'd key can never be silently ignored (or leaked into the
  // returned breakdown via the spread below).
  assertKnownFeeFields("calculateDeposit", inputs, FEE_INPUT_FIELDS);
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
 * The multiplier as an exact rational, read off its shortest
 * round-trip decimal string: `String(1.005)` is `"1.005"`, so the
 * multiplier the caller wrote is 1005/1000 — not the binary double
 * 1.004999999999999893..., which no decimal literal can name. Every
 * finite positive double has such a string (`"1.5"`, `"1e+308"`,
 * `"5e-324"`), so the conversion never guesses: the numerator and
 * denominator below are exactly the decimal the caller sees. A
 * non-finite multiplier never reaches here (the caller-facing guard
 * rejects it first with the finite-positive error), so an unmatched
 * string is a bug, not a caller value, and fails the same way.
 */
function multiplierToRational(multiplier: number): {
  numerator: bigint;
  denominator: bigint;
} {
  const text = String(multiplier);
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  if (match === null)
    throw new Error(
      `complexityMultiplier must be a finite positive number, got ${text}`,
    );
  const digits = match[1] + (match[2] ?? "");
  const exponent = (match[3] === undefined ? 0 : Number(match[3])) - (match[2]?.length ?? 0);
  const numerator = BigInt(digits);
  if (exponent >= 0)
    return { numerator: numerator * 10n ** BigInt(exponent), denominator: 1n };
  return { numerator, denominator: 10n ** BigInt(-exponent) };
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
 * Exactness contract (backlog #1417): the product and the sum are
 * computed in `BigInt`, mirroring `settlement.ts`'s `feeCents` — the
 * multiplier is first converted to the exact rational named by its
 * shortest decimal string (see {@link multiplierToRational}), so
 * `100¢ × 1.005` is exactly 100.5¢ and rounds half-up to 101¢, where
 * the old float product (`100 * 1.005 === 100.49999999999999`)
 * rounded down to 100¢. Money inputs must be safe integers
 * (`Number.isSafeInteger`): a value past the safe-integer ceiling
 * fails at the input gate with the integer-cents error instead of
 * silently rounding. Any exact result past
 * `Number.MAX_SAFE_INTEGER` — an adjusted fee or a deposit total —
 * throws `deposit computation overflowed: inputs too large` (the safe
 * ceiling is part of the overflow contract, not just `Infinity`):
 * `Number.MAX_SAFE_INTEGER × 1.5` is exactly 13,510,798,882,111,487¢,
 * which no double can hold, so it throws instead of returning the
 * float's off-by-one 13,510,798,882,111,486¢. A deposit that would go
 * negative still reports `deposit would be negative` first.
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
  // Shape first, before the `Object.entries` scan: see `assertFeeInputs`.
  assertFeeInputs("calculateDepositCents", inputs);
  // Unknown fields fail closed before any value is consumed: see
  // `assertKnownFeeFields` — a typo'd key used to be silently ignored
  // and leaked into the returned breakdown via the spread below.
  assertKnownFeeFields(
    "calculateDepositCents",
    inputs,
    FEE_INPUT_CENTS_FIELDS,
  );
  for (const [k, v] of Object.entries(inputs)) {
    if (k === "complexityMultiplier") continue;
    assertMoneyCents(k, v as number);
  }
  if (!Number.isFinite(inputs.complexityMultiplier) || inputs.complexityMultiplier <= 0)
    throw new Error("complexityMultiplier must be a finite positive number");

  // Exact half-up product in BigInt: roundHalfUp(base × num/den) is
  // floor((2 × base × num + den) / (2 × den)) for non-negative inputs
  // — the same single-final-rounding shape as the dollar version's
  // `round2`, with no float product in between. Mirrors
  // settlement.ts's `feeCents` (which adds half the divisor before
  // dividing); the doubled form here keeps the tie (exact .5) rounding
  // up, as `Math.round` does on non-negative inputs.
  const { numerator, denominator } = multiplierToRational(
    inputs.complexityMultiplier,
  );
  const adjustedBaseFeeCents = Number(
    (2n * BigInt(inputs.baseFeeCents) * numerator + denominator) /
      (2n * denominator),
  );
  // The adjusted fee is itself a returned money value, so it must fit
  // the safe-integer range on its own — checked before the sum, so a
  // huge base fee fails here even when a huge discount would have made
  // the deposit negative (same overflow message as the dollar version).
  if (!Number.isSafeInteger(adjustedBaseFeeCents))
    throw new Error("deposit computation overflowed: inputs too large");
  const depositCents = Number(
    BigInt(inputs.creatorPoolCents) +
      BigInt(adjustedBaseFeeCents) -
      BigInt(inputs.loyaltyDiscountCents) +
      BigInt(inputs.oracleFeeCents),
  );
  if (depositCents < 0) throw new Error("deposit would be negative");
  // Same overflow guard as the dollar version, now on the exact sum:
  // safe inputs can still add past Number.MAX_SAFE_INTEGER (pool at
  // the ceiling plus any oracle fee), and the exact total is
  // unrepresentable, so fail fast instead of returning a rounded-off
  // deposit that would poison every downstream money sum.
  if (!Number.isSafeInteger(depositCents))
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
