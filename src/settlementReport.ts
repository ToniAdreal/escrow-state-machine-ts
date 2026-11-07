/**
 * Human-readable settlement report from the escrow audit history.
 *
 * Pure functions: the audit history (append-only event trail) decides *which*
 * money movements happened; the fee calculator and settlement math decide
 * *how much*. Every figure in the report is derived from those two sources,
 * nothing is invented.
 *
 * Money model (documented so the accounting stays auditable):
 * - FUND locks money from the sponsor into escrow. The initial FUND comes
 *   from CREATED; further FUND dispatches are allowed while the escrow is
 *   FUNDED (top-ups). The locked total is always the SUM of every FUND
 *   entry's amount — see `depositAmountFromHistory`.
 * - On RELEASE / ARBITRATE_RELEASE the escrow pays out per `settleRelease`
 *   with gross = deposit: creator receives `net`, the platform takes the
 *   pro fee, and any referral credits go to the referrer.
 * - On a partial release the escrow stays FUNDED and `buildSettlementReport`
 *   reports the released slice per `settlePartialRelease` (fee charged on
 *   the slice only): creator receives the slice `net`, the platform takes
 *   the slice pro fee, referral credits go to the referrer, and the sponsor
 *   keeps the `remaining` balance locked — the sponsor's ledger row shows
 *   that remaining amount as still held, so the report still balances over
 *   the full deposit.
 * - On ARBITRATE_REFUND / EXPIRE the full deposit returns to the sponsor.
 * - The oracle fee bundled into the deposit is NOT attributed to a separate
 *   party: this is an off-chain reproduction, not the on-chain contract, and
 *   splitting it would double-count. See README "Limitations (honest)".
 */

import {
  type AuditKey,
  type EscrowEvent,
  type EscrowHistoryEntry,
  type EscrowState,
  verifyHistoryChain,
} from "./stateMachine.js";
import type { FeeBreakdown } from "./feeCalculator.js";
import {
  settlePartialRelease,
  settleRelease,
  type PartialSettlement,
  type Settlement,
} from "./settlement.js";

export type SettlementOutcome =
  | "released"
  | "refunded"
  | "expired"
  | "partially-released";

export type PartyRole = "sponsor" | "creator" | "platform" | "referrer";

const PARTY_LABELS: Record<PartyRole, string> = {
  sponsor: "Sponsor (depositor)",
  creator: "Creator (payee)",
  platform: "Platform (pro fee)",
  referrer: "Referrer (referral credits)",
};

export interface PartyLedger {
  party: PartyRole;
  label: string;
  inflow: number;
  outflow: number;
  /** inflow − outflow */
  net: number;
}

/** ISO 4217 alpha-3 code shape: exactly three uppercase ASCII letters. */
const ISO_4217_ALPHA3 = /^[A-Z]{3}$/;

/**
 * Validate an optional settlement currency. This checks the code shape
 * only (three uppercase letters, e.g. "USD", "EUR"); it does not verify
 * membership in the published ISO 4217 registry, and it performs no
 * conversion — the code is a label on the figures, which stay in the
 * caller's units. An illegal value throws before any money math runs,
 * so a mistyped code can never ship inside a signed report or webhook.
 */
function assertSettlementCurrency(
  currency: unknown,
  escrowId: string,
): asserts currency is string | undefined {
  if (currency === undefined) return;
  if (typeof currency !== "string" || !ISO_4217_ALPHA3.test(currency)) {
    const shown =
      typeof currency === "string" ? JSON.stringify(currency) : String(currency);
    throw new Error(
      `invalid settlement currency for ${escrowId}: ${shown} must be a 3-letter uppercase ISO 4217 code (e.g. "USD")`,
    );
  }
}

export interface SettlementReportInputs {
  escrowId: string;
  /** Append-only audit history, in seq order. */
  history: readonly EscrowHistoryEntry[];
  finalState: EscrowState;
  deposit: FeeBreakdown;
  /**
   * Optional ISO 4217 alpha-3 currency code for the figures in this
   * report (e.g. "USD"). When given it is carried verbatim onto the
   * report, the settlement webhook payload, and the batch paths, and is
   * covered by the webhook signature like every other payload field.
   * Omit it and the report keeps its previous shape exactly: no
   * `currency` key is emitted, so existing snapshots, CSV exports, and
   * receivers see zero change. An illegal value (lowercase, wrong
   * length, non-letters, non-string) throws `invalid settlement
   * currency: …` before any money math runs. The code is a label only:
   * amounts are never converted, and no exchange rate is applied.
   */
  currency?: string;
  /**
   * Settlement parameters; used only when the outcome is `released`.
   * `gross` is ignored and always taken from `deposit.deposit`, so the
   * report can never disagree with the locked deposit.
   */
  settlement?: { proFeeBps: number; referralCredits?: number };
  /**
   * Partial-release parameters; used only when the escrow is still
   * `FUNDED` and the caller wants a report for one released slice of the
   * locked deposit. The arithmetic is delegated to
   * `settlePartialRelease` with gross = `deposit.deposit`, so the slice
   * figures can never drift from the pure function's own math: the fee
   * is charged on the released amount only, `released` must not exceed
   * the deposit, and a negative net or overflow fails fast there. The
   * escrow itself stays FUNDED — a partial release does not advance
   * state, and the report is evidence of the slice, not a state change.
   * Supplying this with a terminal `finalState` (RELEASED / REFUNDED /
   * EXPIRED) throws: a settled escrow's money is already fully
   * accounted for by its terminal outcome. Omit it and a FUNDED escrow
   * keeps its previous behavior (no settlement has happened yet).
   */
  partialRelease?: { released: number; proFeeBps: number; referralCredits?: number };
  /**
   * Key for a keyed (HMAC) audit hash chain, as produced by an escrow
   * constructed with `EscrowOptions.auditKey`. A keyed history must be
   * reported with the same key, otherwise the chain check fails closed
   * and no report is produced. Omit for unkeyed chains (the previous
   * behavior is unchanged). An empty key, or a key that is neither a
   * string nor a Buffer, throws `invalid audit key: …` before any
   * money math runs — the same fail-fast wording `verifyHistoryChain`
   * uses, since the check is delegated to it.
   */
  auditKey?: AuditKey;
}

export interface SettlementReport {
  escrowId: string;
  /**
   * ISO 4217 alpha-3 currency code carried from
   * {@link SettlementReportInputs.currency}, when the caller supplied
   * one. Absent when the report was built without a currency — the key
   * is omitted entirely, never present-but-undefined on the wire.
   */
  currency?: string;
  outcome: SettlementOutcome;
  /** e.g. "VERIFY_PASS → RELEASE" for released, undefined otherwise */
  releasePath?: string;
  deposit: FeeBreakdown;
  /** Present only for the `released` outcome. */
  settlement?: Settlement;
  /**
   * Present only for the `partially-released` outcome: the
   * `settlePartialRelease` result for the reported slice (`released`,
   * `proFee`, `referralCredits`, `net`, `remaining`).
   */
  partialSettlement?: PartialSettlement;
  /**
   * Amount still locked in escrow after the reported partial release
   * (`deposit.deposit` minus the released slice). Present only for the
   * `partially-released` outcome; the sponsor's ledger row carries the
   * same figure as its inflow (money still held on the sponsor's
   * behalf), so the report still balances over the full deposit.
   */
  remaining?: number;
  parties: PartyLedger[];
  totalInflow: number;
  totalOutflow: number;
  /** Conservation check: every cent that flowed out flowed in somewhere. */
  balanced: boolean;
  eventCount: number;
  firstEventAt?: string;
  lastEventAt?: string;
}

/**
 * Total amount locked into escrow by the audit history: the sum of the
 * `amount` on every FUND entry (initial deposit plus any top-ups).
 *
 * Returns `undefined` when the total cannot be established: no FUND event at
 * all, or at least one FUND event recorded without an amount (FUND's amount
 * is optional, and an unknown slice of the total must never be silently
 * treated as zero). Callers that require a number should use
 * `depositAmountFromHistory`, which throws on these inputs.
 */
function totalFundedAmount(
  history: readonly EscrowHistoryEntry[],
): number | undefined {
  const funds = history.filter((entry) => entry.event === "FUND");
  if (funds.length === 0) return undefined;
  let total = 0;
  for (const fund of funds) {
    if (fund.amount === undefined) return undefined;
    total += fund.amount;
  }
  return total;
}

/**
 * Read the locked deposit amount from the audit history.
 *
 * Top-ups add to the locked total, so this returns the SUM of the `amount`
 * recorded on every FUND entry (the initial deposit plus any top-ups), not
 * just the first one. Settlement math must never run on an amount the trail
 * does not corroborate: when there is no FUND event, or any FUND event was
 * recorded without an amount (FUND accepts an optional amount), this throws
 * `settlement requires a FUND amount` instead of letting undefined/NaN
 * silently poison the accounting.
 */
export function depositAmountFromHistory(
  history: readonly EscrowHistoryEntry[],
  escrowId = "escrow",
): number {
  const total = totalFundedAmount(history);
  if (total === undefined) {
    const hasFund = history.some((entry) => entry.event === "FUND");
    throw new Error(
      hasFund
        ? `settlement requires a FUND amount for ${escrowId}: a FUND event was recorded without an amount`
        : `settlement requires a FUND amount for ${escrowId}: no FUND event in the audit history`,
    );
  }
  return total;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function ledger(
  party: PartyRole,
  inflow: number,
  outflow: number,
): PartyLedger {
  inflow = round2(inflow);
  outflow = round2(outflow);
  return { party, label: PARTY_LABELS[party], inflow, outflow, net: round2(inflow - outflow) };
}

/**
 * Build the settlement report. Throws when the escrow has not reached a
 * terminal state, when the audit history's hash chain is broken or mixes
 * chained and hashless entries (tampered, deleted, or reordered entries —
 * the same standard the snapshot parser enforces), when a released/refunded
 * escrow has an empty history (the audit trail is the evidence; no trail,
 * no report), or when the caller-supplied deposit disagrees with the FUND
 * amount recorded in the audit history (fail fast instead of accounting for
 * money the trail never saw). A keyed history must be reported with the
 * same `auditKey` the escrow was built with: without it, or with the
 * wrong key, the chain check fails closed and no report is produced —
 * a keyed escrow previously could not be reported at all, because the
 * report path had no way to pass the key through.
 *
 * The one non-terminal report is the partial release: a FUNDED escrow
 * plus `partialRelease` inputs yields outcome `"partially-released"`,
 * with the released slice settled per `settlePartialRelease` and the
 * remainder still locked (see the `remaining` field). A FUNDED escrow
 * without `partialRelease` still throws as before, and `partialRelease`
 * with a terminal state throws — a settled escrow's money is already
 * fully accounted for.
 */
export function buildSettlementReport(
  inputs: SettlementReportInputs,
): SettlementReport {
  const { escrowId, history, finalState, deposit, auditKey, currency } = inputs;
  const depositAmount = deposit.deposit;

  // Caller configuration first: an illegal currency is the caller's bug
  // and must fail fast even before the history chain is inspected, so
  // it can never be masked by (or mask) a chain failure.
  assertSettlementCurrency(currency, escrowId);

  // The audit history is the sole evidence for every figure below, so it
  // must be integrity-checked before any money math runs: an attacker who
  // rewrote an amount, edited a note, deleted an entry, or reordered the
  // trail could otherwise make a clean-looking report out of a tampered
  // history. A fully hashless history is legacy and passes through (nothing
  // to verify), while a mix of chained and hashless entries is rejected —
  // exactly the semantics of verifyHistoryChain, aligned with the snapshot
  // parser's rules.
  if (!verifyHistoryChain(history, auditKey)) {
    throw new Error(
      `cannot build settlement report for ${escrowId}: audit history hash chain is broken or mixes chained and hashless entries (an entry was tampered with, deleted, or reordered)`,
    );
  }

  // Fail fast on an uncorroborated deposit: when the audit history records
  // FUND amounts, their total (initial deposit + any top-ups) must match the
  // caller-supplied deposit — otherwise the report would silently produce
  // garbage accounting from an amount the trail cannot confirm. A FUND event
  // recorded without an amount keeps the previous behavior (the deposit is
  // the caller's responsibility); use depositAmountFromHistory() to require it.
  //
  // The comparison is done at cent precision (round2 on both sides), not on
  // the raw floats: this library's money model is "all amounts are rounded
  // to cents", and raw float addition can be off by an ulp — e.g. 0.1 + 0.2
  // sums to 0.30000000000000004 while calculateDeposit() produces exactly
  // 0.3. An exact !== comparison would reject a legitimately funded escrow.
  const fundedTotal = totalFundedAmount(history);
  if (fundedTotal !== undefined && round2(fundedTotal) !== round2(depositAmount)) {
    throw new Error(
      `cannot build settlement report for ${escrowId}: deposit ${depositAmount} does not match the FUND total ${fundedTotal} recorded in the audit history`,
    );
  }

  // A partial release only makes sense for an escrow that is still
  // FUNDED: the money of a terminal escrow is already fully accounted
  // for by its terminal outcome, so a slice on top of it would double
  // count. Checked here — after the chain check, so a tampered history
  // still reports the broken chain first — and before any branch runs.
  // The slice numbers themselves are validated by settlePartialRelease
  // inside the FUNDED branch (released ≤ deposit, fee bounds, no
  // negative net, no overflow).
  if (inputs.partialRelease !== undefined) {
    if (
      typeof inputs.partialRelease !== "object" ||
      inputs.partialRelease === null ||
      Array.isArray(inputs.partialRelease)
    ) {
      throw new Error(
        `cannot build settlement report for ${escrowId}: partialRelease must be an object { released, proFeeBps, referralCredits? }, got ${JSON.stringify(inputs.partialRelease)}`,
      );
    }
    if (finalState !== "FUNDED") {
      throw new Error(
        `cannot build settlement report for ${escrowId}: partialRelease is only valid for a FUNDED escrow (state is ${finalState})`,
      );
    }
  }

  const base = {
    escrowId,
    // Omitted entirely when no currency was supplied, so a
    // currency-less report serializes exactly as before.
    ...(currency !== undefined ? { currency } : {}),
    deposit,
    eventCount: history.length,
    firstEventAt: history[0]?.at,
    lastEventAt: history[history.length - 1]?.at,
  };

  if (finalState === "RELEASED") {
    if (history.length === 0)
      throw new Error(
        `cannot build settlement report for ${escrowId}: released escrow has an empty audit history`,
      );
    const lastEvent: EscrowEvent = history[history.length - 1].event;
    if (lastEvent !== "RELEASE" && lastEvent !== "ARBITRATE_RELEASE")
      throw new Error(
        `cannot build settlement report for ${escrowId}: state is RELEASED but the last audit event is ${lastEvent}`,
      );
    if (!inputs.settlement)
      throw new Error(
        `cannot build settlement report for ${escrowId}: settlement parameters (proFeeBps) are required for a released escrow`,
      );
    const settlement = settleRelease({
      gross: depositAmount,
      proFeeBps: inputs.settlement.proFeeBps,
      referralCredits: inputs.settlement.referralCredits,
    });
    const prev = history.length >= 2 ? history[history.length - 2].event : null;
    const parties = [
      ledger("sponsor", 0, depositAmount),
      ledger("creator", settlement.net, 0),
      ledger("platform", settlement.proFee, 0),
      ledger("referrer", settlement.referralCredits, 0),
    ];
    const totalInflow = round2(parties.reduce((s, p) => s + p.inflow, 0));
    const totalOutflow = round2(parties.reduce((s, p) => s + p.outflow, 0));
    return {
      ...base,
      outcome: "released",
      releasePath: prev ? `${prev} → ${lastEvent}` : lastEvent,
      settlement,
      parties,
      totalInflow,
      totalOutflow,
      // By settleRelease's own arithmetic: net + proFee + referralCredits === gross.
      balanced: totalInflow === depositAmount && totalOutflow === depositAmount,
    };
  }

  if (finalState === "REFUNDED" || finalState === "EXPIRED") {
    if (history.length === 0)
      throw new Error(
        `cannot build settlement report for ${escrowId}: ${finalState === "REFUNDED" ? "refunded" : "expired"} escrow has an empty audit history`,
      );
    // Symmetric to the RELEASED branch: a terminal state's report must be
    // backed by a matching terminal event. Without this, a REFUNDED escrow
    // whose last audit entry is EXPIRE (corrupted history) would silently
    // produce a full-refund report with no visible evidence of the mismatch.
    const lastEvent: EscrowEvent = history[history.length - 1].event;
    const expectedLastEvent: EscrowEvent =
      finalState === "REFUNDED" ? "ARBITRATE_REFUND" : "EXPIRE";
    if (lastEvent !== expectedLastEvent)
      throw new Error(
        `cannot build settlement report for ${escrowId}: state is ${finalState} but the last audit event is ${lastEvent}`,
      );
    const parties = [
      ledger("sponsor", depositAmount, depositAmount),
      ledger("creator", 0, 0),
      ledger("platform", 0, 0),
      ledger("referrer", 0, 0),
    ];
    return {
      ...base,
      outcome: finalState === "REFUNDED" ? "refunded" : "expired",
      parties,
      totalInflow: depositAmount,
      totalOutflow: depositAmount,
      balanced: true,
    };
  }

  if (finalState === "FUNDED" && inputs.partialRelease !== undefined) {
    if (history.length === 0)
      throw new Error(
        `cannot build settlement report for ${escrowId}: funded escrow has an empty audit history`,
      );
    // A release event in the trail means the escrow already settled —
    // the caller-supplied finalState and the audit history disagree, and
    // a slice on top of a released escrow would double-count money.
    if (
      history.some(
        (entry) => entry.event === "RELEASE" || entry.event === "ARBITRATE_RELEASE",
      )
    )
      throw new Error(
        `cannot build settlement report for ${escrowId}: state is FUNDED but the audit history contains a release event`,
      );
    // Gross is always the locked deposit, never the caller's word for
    // it; settlePartialRelease re-validates the slice (released ≤ gross,
    // fee bounds, no negative net, no overflow).
    const partialSettlement = settlePartialRelease({
      gross: depositAmount,
      released: inputs.partialRelease.released,
      proFeeBps: inputs.partialRelease.proFeeBps,
      referralCredits: inputs.partialRelease.referralCredits,
    });
    // Ledger over the full deposit, so the report still balances:
    // the sponsor's outflow is the whole locked deposit (what left the
    // sponsor), the sponsor's inflow is the amount still held on their
    // behalf, and the released slice flows out to creator / platform /
    // referrer exactly as a full release would split it. With released
    // === deposit the remaining is 0 and this is byte-for-byte the
    // released outcome's ledger (minus releasePath/settlement).
    const parties = [
      ledger("sponsor", partialSettlement.remaining, depositAmount),
      ledger("creator", partialSettlement.net, 0),
      ledger("platform", partialSettlement.proFee, 0),
      ledger("referrer", partialSettlement.referralCredits, 0),
    ];
    const totalInflow = round2(parties.reduce((s, p) => s + p.inflow, 0));
    const totalOutflow = round2(parties.reduce((s, p) => s + p.outflow, 0));
    return {
      ...base,
      outcome: "partially-released",
      partialSettlement,
      remaining: partialSettlement.remaining,
      parties,
      totalInflow,
      totalOutflow,
      // remaining + released === depositAmount by settlePartialRelease's
      // own arithmetic, so both totals equal the deposit.
      balanced: totalInflow === depositAmount && totalOutflow === depositAmount,
    };
  }

  throw new Error(
    `cannot build settlement report for ${escrowId}: escrow is in ${finalState}, no settlement has happened yet`,
  );
}

/**
 * Per-escrow outcome of {@link buildSettlementReports}: exactly one of
 * `report` / `error` is set.
 */
export type SettlementReportResult =
  | { escrowId: string; report: SettlementReport; error?: undefined }
  | { escrowId: string; report?: undefined; error: string };

/**
 * Batch settlement reporting: build one report per escrow from a list of
 * {@link SettlementReportInputs} — the exact same input shape (and
 * semantics) as the single-escrow {@link buildSettlementReport}, one entry
 * per escrow, in batch order.
 *
 * This exists because a hand-written loop over `buildSettlementReport`
 * has the same trap `expireOverdueEscrows` fixed for the watchdog path:
 * the single-escrow function throws on the first non-terminal escrow or
 * corrupted history, aborting the whole batch and leaving the caller to
 * re-implement per-item isolation. Here each entry is attempted
 * independently: a failure is recorded as `{ escrowId, error }` (the
 * caught error's message) and never blocks later entries.
 *
 * Pure: building a report never mutates any escrow state or history, and
 * this batch wrapper adds no mutation of its own — the input list and its
 * entries are only read. The result has one entry per input, in input
 * order, each carrying the input's `escrowId`. A per-escrow `auditKey`
 * rides along in the same inputs shape (the wrapper delegates to
 * {@link buildSettlementReport} unchanged), so a batch mixing keyed and
 * unkeyed escrows reports each under its own key.
 */
export function buildSettlementReports(
  inputsList: readonly SettlementReportInputs[],
): SettlementReportResult[] {
  return inputsList.map((inputs) => {
    try {
      return { escrowId: inputs.escrowId, report: buildSettlementReport(inputs) };
    } catch (err) {
      return {
        escrowId: inputs.escrowId,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

/**
 * Per-currency slice of a {@link SettlementReportsSummary}: how many
 * reports carried this currency code, and the money figures summed over
 * just those reports (already cent-rounded inside each report, and
 * `round2`-rounded again at the aggregate, the same rule the top-level
 * totals use). A slice is single-currency money by construction, unlike
 * the top-level totals, which sum raw figures across currencies.
 */
export interface SettlementCurrencySummary {
  /** Reports in this currency bucket. */
  reports: number;
  /** Sum of `deposit.deposit` over this bucket's reports only. */
  totalDeposit: number;
  /** Sum of per-report totalInflow over this bucket's reports only. */
  totalInflow: number;
  /** Sum of per-report totalOutflow over this bucket's reports only. */
  totalOutflow: number;
}

/**
 * Bucket key for reports built without a currency code. The code is a
 * label only, and a missing label is not a currency: currency-less
 * reports are grouped under this key instead of being folded into any
 * real currency's bucket.
 */
export const UNSPECIFIED_SETTLEMENT_CURRENCY = "UNSPECIFIED";

export interface SettlementReportsSummary {
  /** Total batch entries inspected (reports + errors). */
  total: number;
  /** Entries that produced a report. */
  reports: number;
  /** Entries that failed with an error; counted, never summed. */
  errors: number;
  /** Successful reports per outcome. */
  outcomes: Record<SettlementOutcome, number>;
  /** Sum of `deposit.deposit` over successful reports only. */
  totalDeposit: number;
  /** Sum of per-report totalInflow over successful reports only. */
  totalInflow: number;
  /** Sum of per-report totalOutflow over successful reports only. */
  totalOutflow: number;
  /** Per-party inflow/outflow/net summed over successful reports, in canonical role order. */
  parties: PartyLedger[];
  /**
   * Per-currency breakdown of the money figures, keyed by the report's
   * ISO 4217 code; reports built without a currency land in the
   * `UNSPECIFIED_SETTLEMENT_CURRENCY` bucket. Each bucket sums only
   * its own currency's reports, so a mixed-currency batch never leaks
   * one currency's figures into another's. The top-level totals above
   * are kept as-is for backward compatibility and still sum raw
   * figures across currencies — read `byCurrency`, not the top-level
   * totals, when the batch may mix currencies. An empty (or
   * all-error) batch yields an empty object.
   */
  byCurrency: Record<string, SettlementCurrencySummary>;
  /** True when every successful report is balanced (vacuously true for an empty/all-error batch). */
  balanced: boolean;
}

/**
 * Aggregate a batch of {@link SettlementReportResult} (the return value of
 * {@link buildSettlementReports}) into one reconciliation summary: outcome
 * counts, error count, total locked deposit, total inflow/outflow, and
 * per-party net totals.
 *
 * Error entries are counted in `errors` and contribute nothing to any
 * money figure — a failed escrow must never silently enter the totals as
 * zero-value business. Money is summed from the figures already rounded
 * to cents inside each report, and every aggregate is rounded with the
 * same `round2` rule, so the summary cannot drift from the reports it
 * summarizes by re-deriving amounts from raw inputs. An empty input
 * returns an all-zero summary (with `balanced: true`, vacuously).
 *
 * The money figures are also broken down per currency in
 * `byCurrency`, keyed by each report's ISO 4217 code (currency-less
 * reports under {@link UNSPECIFIED_SETTLEMENT_CURRENCY}). The
 * top-level totals are kept for backward compatibility and still sum
 * raw figures across currencies — they must not be read as
 * single-currency money when the batch mixes currencies; read the
 * per-currency bucket instead.
 *
 * Pure: the results array and the reports inside it are only read.
 */
export function summarizeSettlementReports(
  results: readonly SettlementReportResult[],
): SettlementReportsSummary {
  const outcomes: Record<SettlementOutcome, number> = {
    released: 0,
    refunded: 0,
    expired: 0,
    "partially-released": 0,
  };
  const partySums = new Map<PartyRole, { inflow: number; outflow: number }>(
    (["sponsor", "creator", "platform", "referrer"] as PartyRole[]).map(
      (role) => [role, { inflow: 0, outflow: 0 }],
    ),
  );
  let reports = 0;
  let errors = 0;
  let totalDeposit = 0;
  let totalInflow = 0;
  let totalOutflow = 0;
  let balanced = true;
  const currencySums = new Map<
    string,
    { reports: number; totalDeposit: number; totalInflow: number; totalOutflow: number }
  >();

  for (const result of results) {
    if (!result.report) {
      errors += 1;
      continue;
    }
    const report = result.report;
    reports += 1;
    outcomes[report.outcome] += 1;
    totalDeposit += report.deposit.deposit;
    totalInflow += report.totalInflow;
    totalOutflow += report.totalOutflow;
    if (!report.balanced) balanced = false;
    const bucketKey = report.currency ?? UNSPECIFIED_SETTLEMENT_CURRENCY;
    let bucket = currencySums.get(bucketKey);
    if (!bucket) {
      bucket = { reports: 0, totalDeposit: 0, totalInflow: 0, totalOutflow: 0 };
      currencySums.set(bucketKey, bucket);
    }
    bucket.reports += 1;
    bucket.totalDeposit += report.deposit.deposit;
    bucket.totalInflow += report.totalInflow;
    bucket.totalOutflow += report.totalOutflow;
    for (const party of report.parties) {
      const sum = partySums.get(party.party);
      if (sum) {
        sum.inflow += party.inflow;
        sum.outflow += party.outflow;
      }
    }
  }

  const byCurrency: Record<string, SettlementCurrencySummary> = {};
  for (const [currency, bucket] of currencySums) {
    byCurrency[currency] = {
      reports: bucket.reports,
      totalDeposit: round2(bucket.totalDeposit),
      totalInflow: round2(bucket.totalInflow),
      totalOutflow: round2(bucket.totalOutflow),
    };
  }

  return {
    total: results.length,
    reports,
    errors,
    outcomes,
    totalDeposit: round2(totalDeposit),
    totalInflow: round2(totalInflow),
    totalOutflow: round2(totalOutflow),
    parties: (["sponsor", "creator", "platform", "referrer"] as PartyRole[]).map(
      (role) => {
        const sum = partySums.get(role)!;
        return ledger(role, sum.inflow, sum.outflow);
      },
    ),
    byCurrency,
    balanced,
  };
}

/**
 * One row of an external payment ledger, paired against a settlement
 * report by `escrowId`. The shape is deliberately minimal: the id that
 * pairs the row with a report, and the amount the ledger says was paid
 * out, in the same units and cent-rounded convention as the report's
 * `totalOutflow`. Extra fields on a caller-supplied row are ignored,
 * never compared.
 */
export interface LedgerSettlement {
  /** Escrow id, pairing with a report's `escrowId`. */
  escrowId: string;
  /** Amount the ledger records for this escrow, if recorded. */
  amount?: number;
  /**
   * Optional ISO 4217 alpha-3 currency code for the ledger row's
   * figures (e.g. "USD"). Shape-checked like the report's currency
   * (three uppercase letters, registry membership not verified, no
   * conversion). Omit it and the row pairs under the previous rules:
   * currency is only compared when both sides carry a code.
   */
  currency?: string;
}

/**
 * One amount disagreement found by {@link reconcileSettlements}: the
 * report and the ledger row agree on the escrow id but not on the
 * amount. Either side's amount is never `undefined` here: a ledger row
 * with no recorded amount is a reference-only match, not a
 * disagreement (see {@link reconcileSettlements}).
 */
export interface SettlementAmountMismatch {
  /** The report whose settled amount disagrees with the ledger. */
  report: SettlementReport;
  /** The ledger row carrying the same escrow id. */
  ledger: LedgerSettlement;
  /**
   * Settled amount from the report: `totalOutflow` for the terminal
   * outcomes, `partialSettlement.released` for a `partially-released`
   * report — the amount that actually left escrow, which is what the
   * ledger records.
   */
  reportAmount: number;
  /** Amount recorded on the ledger row. */
  ledgerAmount: number;
  /**
   * Why the report side carries this figure, present only when it is
   * not the plain `totalOutflow`: for a `partially-released` report,
   * `"partial release: compared against partialSettlement.released,
   * not totalOutflow"`. Absent for terminal outcomes, where the figure
   * is `totalOutflow` and needs no explanation.
   */
  reason?: string;
}

/**
 * One currency disagreement found by {@link reconcileSettlements}: the
 * report and the ledger row agree on the escrow id but carry different
 * ISO 4217 codes. Either side's code is never `undefined` here: a pair
 * is only currency-compared when both sides carry a code (see
 * {@link reconcileSettlements}).
 */
export interface SettlementCurrencyMismatch {
  /** The report whose currency disagrees with the ledger row. */
  report: SettlementReport;
  /** The ledger row carrying the same escrow id. */
  ledger: LedgerSettlement;
  /** Currency code from the report. */
  reportCurrency: string;
  /** Currency code from the ledger row. */
  ledgerCurrency: string;
}

/**
 * The five-way result of {@link reconcileSettlements}. Every group
 * keeps input order; report groups hold the same report objects, and
 * `ledgerOnly` holds the same ledger objects, so callers can act on
 * them directly.
 */
export interface ReconcileSettlementsResult {
  /** Reports whose id and (where recorded) amount agree with a ledger row. */
  matched: SettlementReport[];
  /** Reports with an id no ledger row carries. */
  reportOnly: SettlementReport[];
  /** Ledger rows whose id no report carries. */
  ledgerOnly: LedgerSettlement[];
  /** Reports paired by id but disagreeing on amount. */
  amountMismatch: SettlementAmountMismatch[];
  /**
   * Reports paired by id but carrying a different currency code than
   * the ledger row. Single verdict: a pair in this group is in no
   * other group, even when its amounts also disagree — the currency
   * mismatch is the more fundamental break, and reporting both would
   * double-count one bad pairing.
   */
  currencyMismatch: SettlementCurrencyMismatch[];
}

/**
 * Reconciliation helper: pair a batch of settlement reports against an
 * external payment ledger, by `escrowId`.
 *
 * This is the half of reconciliation the report-side summaries cannot
 * do: {@link summarizeSettlementReports} aggregates what the reports
 * claim, but it cannot see whether the money actually left the
 * external account. Pairing against the ledger closes that gap in both
 * directions — a settlement the ledger never paid, and a ledger
 * payment no report accounts for:
 *
 *   const { matched, reportOnly, ledgerOnly, amountMismatch, currencyMismatch } =
 *     reconcileSettlements(reports, ledgerRows);
 *
 * Pairing rules:
 * - A report pairs with the ledger row carrying the same `escrowId`;
 *   the report's amount is its `totalOutflow`, the figure that left
 *   escrow on the terminal outcomes (released, refunded, and expired
 *   alike). For a `partially-released` report `totalOutflow` is the full
 *   locked deposit (the sponsor's outflow, with the still-locked remainder
 *   carried as the sponsor's inflow) — the amount that actually left
 *   escrow is `partialSettlement.released`, so a partial report is
 *   compared against the released slice, not the deposit: a ledger row
 *   carrying 4,252 for a 10,630-deposit partial release matches, and a
 *   mismatch reports `reportAmount` as the released slice with a
 *   `reason` naming the partial-release basis. A `partially-released`
 *   report built without `partialSettlement` (hand-built — never
 *   produced by `buildSettlementReport`) falls back to `totalOutflow`.
 * - Amounts are compared at cent precision (`round2` on both sides),
 *   the library's money model: a ledger figure that differs only by
 *   float noise is not a disagreement, a one-cent difference is.
 * - An amount disagreement is reported only when the ledger row
 *   recorded an amount. A row with no amount pairs on the reference
 *   alone and lands in `matched` — the missing amount is still
 *   visible to the caller, because `matched` holds the report itself,
 *   not a claim that amounts were verified.
 * - Currency is compared only when both sides carry a code: a report
 *   and a ledger row that both carry a currency, and disagree on it,
 *   land in `currencyMismatch` — and in no other group, even when
 *   their amounts also disagree (single verdict per pairing; a
 *   currency-mismatched pair must never be read as matched money).
 *   When either side omits the code, the previous four-group rules
 *   apply unchanged. No conversion is ever performed and no
 *   exchange rate is applied: a code is a label, and a label
 *   disagreement is itself the finding.
 * - A ledger row is `ledgerOnly` only when no report carries its id;
 *   pairing a row never consumes it for other reports.
 *
 * Fail-fast, before any pairing: a report that is not an object, or
 * carries an empty or non-string `escrowId` or a non-finite
 * `totalOutflow`, throws; a ledger row that is not an object, carries
 * an empty or non-string `escrowId`, or carries a non-finite or
 * negative `amount` throws; an illegal currency code on either side
 * (anything but three uppercase letters) throws
 * `invalid settlement currency: …` via the same shape check the
 * report builder uses; an id appearing twice in the reports throws
 * `duplicate report escrowId` — a duplicated report would otherwise be
 * counted once per copy in `matched` (the same settlement tallied
 * twice); and an id appearing twice in the ledger
 * throws `duplicate ledger escrowId` — a duplicated ledger row would
 * otherwise make "matched" ambiguous (which row did the report pair
 * with?).
 *
 * Pure: reads the reports and the ledger rows, never mutates or
 * dispatches anything. An empty report batch and an empty ledger
 * return five empty groups.
 */
export function reconcileSettlements(
  reports: readonly SettlementReport[],
  ledger: readonly LedgerSettlement[],
): ReconcileSettlementsResult {
  const reportById = new Map<string, SettlementReport>();
  for (const report of reports) {
    if (report === null || typeof report !== "object" || Array.isArray(report)) {
      throw new Error(
        `invalid reconcileSettlements: report must be an object, got ${JSON.stringify(report)}`,
      );
    }
    if (typeof report.escrowId !== "string" || report.escrowId.length === 0) {
      throw new Error(
        `invalid reconcileSettlements: report escrowId must be a non-empty string, got ${JSON.stringify(report.escrowId)}`,
      );
    }
    if (typeof report.totalOutflow !== "number" || !Number.isFinite(report.totalOutflow)) {
      throw new Error(
        `invalid reconcileSettlements: report totalOutflow must be a finite number, got ${String(report.totalOutflow)}`,
      );
    }
    assertSettlementCurrency(report.currency, report.escrowId);
    if (reportById.has(report.escrowId)) {
      throw new Error(
        `invalid reconcileSettlements: duplicate report escrowId: ${JSON.stringify(report.escrowId)}`,
      );
    }
    reportById.set(report.escrowId, report);
  }
  const ledgerById = new Map<string, LedgerSettlement>();
  for (const row of ledger) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(
        `invalid reconcileSettlements: ledger entry must be an object, got ${JSON.stringify(row)}`,
      );
    }
    if (typeof row.escrowId !== "string" || row.escrowId.length === 0) {
      throw new Error(
        `invalid reconcileSettlements: ledger escrowId must be a non-empty string, got ${JSON.stringify(row.escrowId)}`,
      );
    }
    if (
      row.amount !== undefined &&
      (typeof row.amount !== "number" || !Number.isFinite(row.amount) || row.amount < 0)
    ) {
      throw new Error(
        `invalid reconcileSettlements: ledger amount must be a non-negative finite number, got ${String(row.amount)}`,
      );
    }
    assertSettlementCurrency(row.currency, row.escrowId);
    if (ledgerById.has(row.escrowId)) {
      throw new Error(
        `invalid reconcileSettlements: duplicate ledger escrowId: ${JSON.stringify(row.escrowId)}`,
      );
    }
    ledgerById.set(row.escrowId, row);
  }

  const result: ReconcileSettlementsResult = {
    matched: [],
    reportOnly: [],
    ledgerOnly: [],
    amountMismatch: [],
    currencyMismatch: [],
  };
  const seenIds = new Set<string>();
  for (const report of reports) {
    seenIds.add(report.escrowId);
    const row = ledgerById.get(report.escrowId);
    if (row === undefined) {
      result.reportOnly.push(report);
      continue;
    }
    // Currency first, single verdict: a code disagreement is reported
    // here and nowhere else, even when the amounts also disagree.
    if (
      report.currency !== undefined &&
      row.currency !== undefined &&
      report.currency !== row.currency
    ) {
      result.currencyMismatch.push({
        report,
        ledger: row,
        reportCurrency: report.currency,
        ledgerCurrency: row.currency,
      });
      continue;
    }
    // The amount that left escrow: `totalOutflow` for the terminal
    // outcomes, the released slice for a partial report — a ledger that
    // records the slice actually paid must not be flagged for
    // disagreeing with the full locked deposit.
    const releasedSlice =
      report.outcome === "partially-released"
        ? report.partialSettlement?.released
        : undefined;
    const reportAmount = releasedSlice ?? report.totalOutflow;
    if (row.amount !== undefined && round2(row.amount) !== round2(reportAmount)) {
      result.amountMismatch.push({
        report,
        ledger: row,
        reportAmount,
        ledgerAmount: row.amount,
        ...(releasedSlice !== undefined
          ? {
              reason:
                "partial release: compared against partialSettlement.released, not totalOutflow",
            }
          : {}),
      });
      continue;
    }
    result.matched.push(report);
  }
  for (const row of ledger) {
    if (!seenIds.has(row.escrowId)) result.ledgerOnly.push(row);
  }
  return result;
}

function money(n: number): string {
  return (
    "$" +
    n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

/**
 * Format a money figure for CSV output: cent-rounded, exactly two decimals,
 * and never thousands-separated (a `,` inside a number would be a column
 * separator). A negative zero rounds to plain `0.00`, never `-0.00`.
 */
function csvMoney(n: number): string {
  const v = round2(n);
  return (v === 0 ? 0 : v).toFixed(2);
}

/**
 * Escape one CSV field per RFC 4180: a field containing a comma, a double
 * quote, or a line break is wrapped in double quotes, and each double quote
 * inside it is doubled. Fields without those characters pass through bare.
 */
function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Render the report as CSV for bookkeeping/reconciliation imports — the
 * machine-readable counterpart to {@link renderReport}'s human-readable
 * text, so callers never have to parse prose lines whose format may change.
 *
 * Shape (lines joined by `\n`, no trailing newline):
 * - Header: `escrowId,outcome,role,inflow,outflow,net`.
 * - One row per party in the report's party order (sponsor, creator,
 *   platform, referrer), including zero-amount parties, so a row is never
 *   silently absent from an import. Amounts are cent-rounded with exactly
 *   two decimals, matching `renderReport`'s cent precision.
 * - A final `TOTAL` row (`escrowId,outcome,TOTAL,...`) whose inflow/outflow/
 *   net columns are the sums over the party rows above it — computed from
 *   the rows themselves, not copied from the report's totals, so the CSV is
 *   self-consistent even if a hand-built report's totals disagree.
 *
 * String fields are RFC 4180-escaped (today's ids/roles/outcomes contain no
 * special characters; the escaping is pinned anyway so a future id carrying
 * a comma or quote cannot silently shift columns).
 *
 * The parameter is a full {@link SettlementReport} or the CSV-carried
 * subset returned by {@link parseSettlementReportCsv}: rendering reads
 * only `escrowId`, `outcome`, and `parties`, so a parsed value re-renders
 * byte-identically without rebuilding the fields the CSV never carried.
 *
 * Before rendering, the CSV-carried fields are shape-checked with the
 * shared core also used by {@link assertReportShape} (see below): a non-object
 * report, an empty `escrowId`, an illegal `outcome`, an empty
 * `parties` array, an unknown party role, or a non-finite party amount
 * throws `cannot render settlement report as CSV: …` instead of
 * emitting a row that reads `Infinity` or `NaN` — the literals
 * `csvMoney` used to produce for such figures. Only the carried fields
 * are required: the deposit breakdown, settlement parameters,
 * `releasePath`, `eventCount`, and audit window are not read by this
 * renderer and are not checked here, so a parsed
 * {@link SettlementReportCsv} still re-renders; a full report's carried
 * fields are checked the same way, and its `totalInflow`/
 * `totalOutflow`/`balanced`, when present, must be finite/boolean or
 * the render throws too.
 */
export function renderReportCsv(
  report: SettlementReport | SettlementReportCsv,
): string {
  assertReportCsvFields(report, "cannot render settlement report as CSV");
  const lines: string[] = ["escrowId,outcome,role,inflow,outflow,net"];
  let totalInflow = 0;
  let totalOutflow = 0;
  let totalNet = 0;
  for (const p of report.parties) {
    lines.push(
      [
        csvField(report.escrowId),
        csvField(report.outcome),
        csvField(p.party),
        csvMoney(p.inflow),
        csvMoney(p.outflow),
        csvMoney(p.net),
      ].join(","),
    );
    totalInflow = round2(totalInflow + p.inflow);
    totalOutflow = round2(totalOutflow + p.outflow);
    totalNet = round2(totalNet + p.net);
  }
  lines.push(
    [
      csvField(report.escrowId),
      csvField(report.outcome),
      "TOTAL",
      csvMoney(totalInflow),
      csvMoney(totalOutflow),
      csvMoney(totalNet),
    ].join(","),
  );
  return lines.join("\n");
}

/**
 * The settlement report as carried by {@link renderReportCsv} — the
 * CSV-carried subset of a {@link SettlementReport}, nothing more.
 *
 * A CSV row carries only `escrowId`, `outcome`, and the per-party
 * `inflow`/`outflow`/`net` ledgers, plus the `TOTAL` row that sums them.
 * It does NOT carry the deposit breakdown (`creatorPool`, `baseFee`,
 * `complexityMultiplier`, `loyaltyDiscount`, `oracleFee`), the
 * `settlement` parameters, the `releasePath`, the `eventCount`, or the
 * audit window (`firstEventAt`/`lastEventAt`) — so a CSV import cannot
 * reconstruct a full `SettlementReport` without inventing those figures,
 * and this type does not pretend otherwise. `totalInflow`/`totalOutflow`
 * are the `TOTAL` row's figures (cross-checked against the party rows);
 * `balanced` is whether those two totals agree at cent precision.
 * For a report produced by `buildSettlementReport`, `totalOutflow` equals
 * `deposit.deposit` (the sponsor's outflow is the locked deposit in all
 * four outcomes — for `partially-released` the still-locked remainder is
 * the sponsor's inflow, so the totals still equal the deposit); for a
 * hand-built CSV it is simply the `TOTAL` outflow figure, not an
 * independently verified deposit.
 */
export interface SettlementReportCsv {
  escrowId: string;
  outcome: SettlementOutcome;
  parties: PartyLedger[];
  totalInflow: number;
  totalOutflow: number;
  /** totalInflow === totalOutflow at cent precision. */
  balanced: boolean;
}

/**
 * Split CSV text into records, following RFC 4180: a field containing a
 * comma, a double quote, or a line break is wrapped in double quotes, and
 * each double quote inside it is doubled. A quote anywhere else — a bare
 * quote in the middle of an unquoted field, a character other than a
 * comma, a line break, or end-of-input after a closing quote, or an
 * unterminated quoted field — is malformed and throws, because silently
 * re-interpreting a shifted column would corrupt a money import.
 * CRLF and LF line breaks are both accepted; a quoted field may itself
 * contain a line break, so records are parsed from the whole text, not
 * by splitting on newlines first.
 */
function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let afterClosingQuote = false;
  let i = 0;
  const pushField = () => {
    record.push(field);
    field = "";
  };
  const pushRecord = () => {
    pushField();
    records.push(record);
    record = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          afterClosingQuote = true;
          i += 1;
        }
      } else {
        field += c;
        i += 1;
      }
      continue;
    }
    if (afterClosingQuote) {
      if (c === ",") {
        pushField();
        afterClosingQuote = false;
        i += 1;
      } else if (c === "\r") {
        if (text[i + 1] === "\n") i += 1;
        pushRecord();
        afterClosingQuote = false;
        i += 1;
      } else if (c === "\n") {
        pushRecord();
        afterClosingQuote = false;
        i += 1;
      } else {
        throw new Error(
          `cannot parse settlement report CSV: unexpected character after a closing quote: ${JSON.stringify(c)}`,
        );
      }
      continue;
    }
    if (c === '"' && field === "") {
      inQuotes = true;
      i += 1;
    } else if (c === ",") {
      pushField();
      i += 1;
    } else if (c === "\r") {
      if (text[i + 1] === "\n") i += 1;
      pushRecord();
      i += 1;
    } else if (c === "\n") {
      pushRecord();
      i += 1;
    } else {
      field += c;
      i += 1;
    }
  }
  if (inQuotes) {
    throw new Error("cannot parse settlement report CSV: unterminated quoted field");
  }
  // A trailing newline already closed the last record; only push a final
  // record when the text ends mid-field or mid-record.
  if (afterClosingQuote || field !== "" || record.length > 0) {
    pushRecord();
  }
  return records;
}

/** Two-decimal money figure, exactly as `renderReportCsv` emits it. */
const CSV_MONEY = /^-?\d+\.\d{2}$/;

function parseCsvMoney(value: string, where: string): number {
  if (!CSV_MONEY.test(value)) {
    throw new Error(
      `cannot parse settlement report CSV: ${where} must be a two-decimal money figure, got ${JSON.stringify(value)}`,
    );
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(
      `cannot parse settlement report CSV: ${where} must be a finite number, got ${JSON.stringify(value)}`,
    );
  }
  return n;
}

/**
 * Parse a settlement report back from CSV — the inverse of
 * {@link renderReportCsv}, for the receiving end of the bookkeeping hop:
 * a caller that exported a report with `renderReportCsv` gets the
 * report's ledgers back without hand-writing a CSV parser for each row.
 *
 * The check is structural plus self-consistency, in the other direction
 * from rendering: the header must be exactly
 * `escrowId,outcome,role,inflow,outflow,net`; there must be exactly four
 * party rows (one per role, each once, in any order) plus a final `TOTAL`
 * row; every row must carry the same `escrowId` and `outcome`; every
 * amount must be a finite two-decimal figure; every party's `net` must
 * equal its `inflow − outflow` at cent precision; and the `TOTAL` row
 * must equal the sums over the party rows. Any violation throws
 * `cannot parse settlement report CSV: …` instead of returning a
 * plausible-looking half-report.
 *
 * Honest limit, stated plainly because it is the whole point of the
 * {@link SettlementReportCsv} type: this import recovers only what the
 * CSV carries. The deposit breakdown, settlement parameters,
 * `releasePath`, `eventCount`, and audit window are not in the file and
 * are not reconstructed — a parsed value re-renders byte-identically
 * through `renderReportCsv`, but it is not the original
 * `SettlementReport`, and no field in it should be read as the original
 * breakdown. Import is structural validation only, not a re-verification
 * of the audit chain: a hand-built CSV with internally consistent rows
 * parses, just as it would render, and chain verification still belongs
 * to `verifyHistoryChain` over the escrow's own history.
 *
 * Pure: the input string is only read, never mutated, and the returned
 * value is a fresh object graph (a second parse of the same text yields
 * an independent copy).
 */
export function parseSettlementReportCsv(text: string): SettlementReportCsv {
  if (typeof text !== "string") {
    throw new Error("cannot parse settlement report CSV: input must be a CSV string");
  }
  // A UTF-8 byte-order mark is a transport artifact, not a column.
  const records = parseCsvRecords(text.replace(/^\uFEFF/, ""));
  // Trailing blank lines are line-ending noise, not extra rows; a blank
  // record anywhere else changes the record count and fails below.
  while (records.length > 0) {
    const last = records[records.length - 1];
    if (last.length === 1 && last[0] === "") records.pop();
    else break;
  }
  const fail = (reason: string): never => {
    throw new Error(`cannot parse settlement report CSV: ${reason}`);
  };
  if (records.length !== 6) {
    fail(
      `expected 6 records (header + 4 party rows + TOTAL row), got ${records.length}`,
    );
  }
  const header = records[0];
  if (
    header.length !== 6 ||
    header[0] !== "escrowId" ||
    header[1] !== "outcome" ||
    header[2] !== "role" ||
    header[3] !== "inflow" ||
    header[4] !== "outflow" ||
    header[5] !== "net"
  ) {
    fail('header must be exactly "escrowId,outcome,role,inflow,outflow,net"');
  }
  const escrowId = records[1][0];
  const outcome = records[1][1];
  if (escrowId === undefined || escrowId === "") {
    fail("escrowId must be a non-empty string");
  }
  if (outcome !== "released" && outcome !== "refunded" && outcome !== "expired" && outcome !== "partially-released") {
    fail('outcome must be "released", "refunded", "expired", or "partially-released"');
  }
  const parties: PartyLedger[] = [];
  const seen = new Set<string>();
  let sumInflow = 0;
  let sumOutflow = 0;
  let sumNet = 0;
  for (let r = 1; r <= 4; r += 1) {
    const row = records[r];
    const where = `party row ${r}`;
    if (row.length !== 6) fail(`${where} must have 6 columns, got ${row.length}`);
    if (row[0] !== escrowId) fail(`${where} escrowId ${JSON.stringify(row[0])} does not match ${JSON.stringify(escrowId)}`);
    if (row[1] !== outcome) fail(`${where} outcome ${JSON.stringify(row[1])} does not match ${JSON.stringify(outcome)}`);
    const role = row[2];
    if (role !== "sponsor" && role !== "creator" && role !== "platform" && role !== "referrer") {
      fail(`${where} role must be a PartyRole, got ${JSON.stringify(role)}`);
    }
    if (seen.has(role)) fail(`${where} role ${JSON.stringify(role)} appears more than once`);
    seen.add(role);
    const inflow = parseCsvMoney(row[3], `${where} inflow`);
    const outflow = parseCsvMoney(row[4], `${where} outflow`);
    const net = parseCsvMoney(row[5], `${where} net`);
    if (inflow < 0) fail(`${where} inflow must not be negative`);
    if (outflow < 0) fail(`${where} outflow must not be negative`);
    if (round2(inflow - outflow) !== net) {
      fail(`${where} net ${net} does not equal inflow ${inflow} minus outflow ${outflow}`);
    }
    // The role check above already rejected anything outside PartyRole;
    // the cast only tells TypeScript what the runtime check established
    // (a never-returning helper call does not narrow here).
    parties.push({ party: role as PartyRole, label: PARTY_LABELS[role as PartyRole], inflow, outflow, net });
    sumInflow = round2(sumInflow + inflow);
    sumOutflow = round2(sumOutflow + outflow);
    sumNet = round2(sumNet + net);
  }
  for (const role of ["sponsor", "creator", "platform", "referrer"] as const) {
    if (!seen.has(role)) fail(`missing party row for role ${JSON.stringify(role)}`);
  }
  const total = records[5];
  if (total.length !== 6) fail(`TOTAL row must have 6 columns, got ${total.length}`);
  if (total[0] !== escrowId) fail(`TOTAL row escrowId does not match ${JSON.stringify(escrowId)}`);
  if (total[1] !== outcome) fail(`TOTAL row outcome does not match ${JSON.stringify(outcome)}`);
  if (total[2] !== "TOTAL") fail(`last row role must be "TOTAL", got ${JSON.stringify(total[2])}`);
  const totalInflow = parseCsvMoney(total[3], "TOTAL row inflow");
  const totalOutflow = parseCsvMoney(total[4], "TOTAL row outflow");
  const totalNet = parseCsvMoney(total[5], "TOTAL row net");
  if (totalInflow !== sumInflow) {
    fail(`TOTAL row inflow ${totalInflow} does not equal the sum over party rows ${sumInflow}`);
  }
  if (totalOutflow !== sumOutflow) {
    fail(`TOTAL row outflow ${totalOutflow} does not equal the sum over party rows ${sumOutflow}`);
  }
  if (totalNet !== sumNet) {
    fail(`TOTAL row net ${totalNet} does not equal the sum over party rows ${sumNet}`);
  }
  return {
    escrowId,
    // Same note as the role cast above: the outcome check already
    // rejected anything outside SettlementOutcome.
    outcome: outcome as SettlementOutcome,
    parties,
    totalInflow,
    totalOutflow,
    balanced: totalInflow === totalOutflow,
  };
}

/**
 * Validate the structural shape of a {@link SettlementReport} before it is
 * serialized (or after it is parsed back). This is a shape check, not a
 * re-derivation of the accounting: the figures are trusted as the caller's
 * (normally `buildSettlementReport`'s output), but a value that is not a
 * report at all — or a money figure that is not a finite number — must fail
 * loudly here rather than silently degrading in transit. `JSON.stringify`
 * turns `Infinity`/`NaN` into `null` without complaint, so a non-finite
 * amount would otherwise leave this function as a plausible-looking `null`
 * and corrupt a downstream import. Every failure throws
 * `<prefix>: …`, where the prefix names the direction (`cannot render
 * settlement report as JSON` when writing, `cannot parse settlement
 * report JSON` when reading) so a failure's origin is unambiguous.
 * The CSV-carried fields are checked first via
 * {@link assertReportCsvFields}, shared with {@link renderReportCsv},
 * so both renderers reject the same malformed ledgers, each under its
 * own direction prefix.
 */
/**
 * Validate the fields a CSV row actually carries: `escrowId`, `outcome`,
 * and the per-party ledgers. This is the shared core of the report shape
 * checks: {@link renderReportCsv} applies exactly this (with a CSV
 * prefix) because rendering reads nothing else, and
 * {@link assertReportShape} applies it first and then adds the
 * full-report fields. Totals/`balanced` are carried by both shapes, so
 * when present they must be sane; a bare carried-fields value without
 * them still passes here, and the full-report check below requires them.
 * Every failure throws `<prefix>: …`. No assertion signature: callers
 * keep their own (narrower) parameter types.
 */
function assertReportCsvFields(report: unknown, prefix: string): void {
  const fail = (reason: string): never => {
    throw new Error(`${prefix}: ${reason}`);
  };
  if (typeof report !== "object" || report === null || Array.isArray(report))
    fail("report must be a SettlementReport object");
  const r = report as Record<string, unknown>;
  if (typeof r.escrowId !== "string" || r.escrowId.length === 0)
    fail("escrowId must be a non-empty string");
  if (r.outcome !== "released" && r.outcome !== "refunded" && r.outcome !== "expired" && r.outcome !== "partially-released")
    fail('outcome must be "released", "refunded", "expired", or "partially-released"');
  if (!Array.isArray(r.parties) || r.parties.length === 0)
    fail("parties must be a non-empty array");
  for (const party of r.parties as unknown[]) {
    if (typeof party !== "object" || party === null || Array.isArray(party))
      fail("each party must be a PartyLedger object");
    const p = party as Record<string, unknown>;
    if (
      p.party !== "sponsor" &&
      p.party !== "creator" &&
      p.party !== "platform" &&
      p.party !== "referrer"
    )
      fail("each party.party must be a PartyRole");
    if (typeof p.label !== "string") fail("each party.label must be a string");
    for (const key of ["inflow", "outflow", "net"] as const) {
      if (typeof p[key] !== "number" || !Number.isFinite(p[key]))
        fail(`each party.${key} must be a finite number`);
    }
  }
  for (const key of ["totalInflow", "totalOutflow"] as const) {
    if (
      r[key] !== undefined &&
      (typeof r[key] !== "number" || !Number.isFinite(r[key]))
    )
      fail(`${key} must be a finite number`);
  }
  if (r.balanced !== undefined && typeof r.balanced !== "boolean")
    fail("balanced must be a boolean");
}

function assertReportShape(
  report: unknown,
  prefix = "cannot render settlement report as JSON",
): asserts report is SettlementReport {
  assertReportCsvFields(report, prefix);
  const fail = (reason: string): never => {
    throw new Error(`${prefix}: ${reason}`);
  };
  const r = report as Record<string, unknown>;
  if (
    r.currency !== undefined &&
    (typeof r.currency !== "string" || !ISO_4217_ALPHA3.test(r.currency))
  )
    fail("currency must be a 3-letter uppercase ISO 4217 code when present");
  if (typeof r.deposit !== "object" || r.deposit === null || Array.isArray(r.deposit))
    fail("deposit must be a FeeBreakdown object");
  const deposit = r.deposit as Record<string, unknown>;
  if (typeof deposit.deposit !== "number" || !Number.isFinite(deposit.deposit))
    fail("deposit.deposit must be a finite number");
  for (const [key, value] of Object.entries(deposit)) {
    // Every FeeBreakdown field is a money figure: a null here is what a
    // non-finite figure becomes after a plain JSON.stringify, so it must
    // fail like Infinity does, not slip through as "not a number".
    if (typeof value !== "number" || !Number.isFinite(value))
      fail(`deposit.${key} must be a finite number`);
  }
  // The carried-fields check above already validated escrowId, outcome,
  // and the party ledgers; the full-report check adds the requirement
  // that totals and the balanced flag are actually present (not merely
  // sane when present).
  for (const key of ["totalInflow", "totalOutflow"] as const) {
    if (typeof r[key] !== "number" || !Number.isFinite(r[key]))
      fail(`${key} must be a finite number`);
  }
  if (typeof r.balanced !== "boolean") fail("balanced must be a boolean");
  if (
    typeof r.eventCount !== "number" ||
    !Number.isInteger(r.eventCount) ||
    r.eventCount < 0
  )
    fail("eventCount must be a non-negative integer");
  if (r.releasePath !== undefined && typeof r.releasePath !== "string")
    fail("releasePath must be a string when present");
  if (r.settlement !== undefined) {
    if (typeof r.settlement !== "object" || r.settlement === null || Array.isArray(r.settlement))
      fail("settlement must be a Settlement object when present");
    for (const [key, value] of Object.entries(r.settlement as Record<string, unknown>)) {
      // Every Settlement field is a money figure: same null rule as deposit.
      if (typeof value !== "number" || !Number.isFinite(value))
        fail(`settlement.${key} must be a finite number`);
    }
  }
  if (r.partialSettlement !== undefined) {
    if (typeof r.partialSettlement !== "object" || r.partialSettlement === null || Array.isArray(r.partialSettlement))
      fail("partialSettlement must be a PartialSettlement object when present");
    for (const [key, value] of Object.entries(r.partialSettlement as Record<string, unknown>)) {
      // Every PartialSettlement field is a money figure: same null rule.
      if (typeof value !== "number" || !Number.isFinite(value))
        fail(`partialSettlement.${key} must be a finite number`);
    }
  }
  if (r.remaining !== undefined && (typeof r.remaining !== "number" || !Number.isFinite(r.remaining)))
    fail("remaining must be a finite number when present");
  for (const key of ["firstEventAt", "lastEventAt"] as const) {
    if (r[key] !== undefined && typeof r[key] !== "string")
      fail(`${key} must be a string when present`);
  }
}

/**
 * Render the report as JSON for programmatic consumers — the
 * machine-readable counterpart to {@link renderReportCsv} for callers that
 * feed the report to a bookkeeping API or a database instead of a CSV
 * import. The output is `JSON.stringify` of the report itself, so it
 * carries exactly the {@link SettlementReport} fields (escrowId, outcome,
 * releasePath when present, deposit breakdown, settlement when present,
 * partialSettlement and remaining when present, the four party ledgers,
 * totals, balanced flag, and audit window) with no field added, renamed,
 * or dropped.
 *
 * The one deliberate difference from CSV: amounts stay JSON numbers, not
 * two-decimal strings. A consumer parsing this output gets `10098.5`, not
 * `"10098.50"` — re-stringifying a CSV row would lose that distinction
 * and break the moment a field is added. Optional fields that are
 * `undefined` are omitted by `JSON.stringify` itself, as usual; a report
 * that fails the shape check throws instead of serializing (see
 * `assertReportShape`), so a malformed object never becomes a
 * plausible-looking JSON document.
 *
 * Pure: the report is only read, never mutated.
 */
export function renderReportJson(report: SettlementReport): string {
  assertReportShape(report);
  return JSON.stringify(report);
}

/**
 * Parse a {@link SettlementReport} back from JSON — the inverse of
 * {@link renderReportJson}, for the receiving end of the API/storage hop:
 * a caller that stored a report with `renderReportJson` gets a typed
 * report back without hand-writing a parser for each field.
 *
 * The check is exactly the shape check `renderReportJson` applies, in the
 * other direction: unparseable text, a JSON value that is not a report
 * object, an empty `escrowId`, an illegal `outcome`, an empty `parties`
 * array, an unknown party role, or a non-finite money figure (including
 * `null`, which is what a non-finite figure becomes after a plain
 * `JSON.stringify`, and `1e999`, which `JSON.parse` reads as `Infinity`)
 * all throw `cannot parse settlement report JSON: …` instead of returning
 * a plausible-looking half-report. A parsed report re-renders
 * byte-identically through `renderReportJson`.
 *
 * Honest limit, shared with `renderReportJson`: this is structural
 * validation only. Importing a report does not re-verify the audit chain
 * it claims to summarize — a hand-built document with internally
 * consistent fields passes, just as it would serialize. Chain
 * verification still belongs to `verifyHistoryChain` over the escrow's own
 * history, not to this import.
 *
 * Pure: the input string is only read, never mutated, and the returned
 * report is a fresh object graph (a second parse of the same text yields
 * an independent copy).
 */
export function parseSettlementReportJson(text: string): SettlementReport {
  if (typeof text !== "string")
    throw new Error("cannot parse settlement report JSON: input must be a JSON string");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `cannot parse settlement report JSON: invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  assertReportShape(parsed, "cannot parse settlement report JSON");
  return parsed;
}

/** Render the report as plain human-readable text. */
export function renderReport(report: SettlementReport): string {
  const d = report.deposit;
  const lines: string[] = [
    `Escrow settlement report — ${report.escrowId}`,
    `Outcome: ${report.outcome}${report.releasePath ? ` (via ${report.releasePath})` : ""}`,
    ...(report.currency !== undefined ? [`Currency: ${report.currency}`] : []),
    `Deposit: ${money(d.deposit)} (pool ${money(d.creatorPool)} + base ${money(d.baseFee)}×${d.complexityMultiplier} − loyalty ${money(d.loyaltyDiscount)} + oracle ${money(d.oracleFee)})`,
    "",
    "Party".padEnd(30) + "Inflow".padStart(14) + "Outflow".padStart(14) + "Net".padStart(14),
    "-".repeat(72),
  ];
  for (const p of report.parties) {
    lines.push(
      p.label.padEnd(30) +
        money(p.inflow).padStart(14) +
        money(p.outflow).padStart(14) +
        money(p.net).padStart(14),
    );
  }
  lines.push(
    "",
    `Totals: inflow ${money(report.totalInflow)} = outflow ${money(report.totalOutflow)} — ${report.balanced ? "balanced ✓" : "UNBALANCED ✗"}`,
    `Audit: ${report.eventCount} events${report.firstEventAt ? `, ${report.firstEventAt} → ${report.lastEventAt}` : ""}`,
  );
  if (report.outcome === "released") {
    lines.push(
      "Note: oracle fee is bundled into the deposit (off-chain reproduction, no on-chain payout attributed).",
    );
  }
  if (report.outcome === "partially-released" && report.partialSettlement !== undefined) {
    const p = report.partialSettlement;
    lines.push(
      `Partial release: ${money(p.released)} of ${money(report.deposit.deposit)} released (fee ${money(p.proFee)}, net ${money(p.net)}), ${money(p.remaining)} remains locked.`,
    );
  }
  return lines.join("\n");
}
