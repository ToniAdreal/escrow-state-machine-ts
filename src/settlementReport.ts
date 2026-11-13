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
  MAX_ESCROW_ID_LENGTH,
  type AuditKey,
  type EscrowEvent,
  type EscrowHistoryEntry,
  type EscrowState,
  verifyHistoryChain,
} from "./stateMachine.js";
import { formatMinorUnits, type FeeBreakdown } from "./feeCalculator.js";
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

/**
 * Validate a settlement-report escrow identity: a non-empty string of at
 * most {@link MAX_ESCROW_ID_LENGTH} characters — the same cap the escrow
 * constructor (#1061), the CSV/JSON parsers, and `reconcileSettlements`
 * (#1067) enforce. A report the library builds must always be parseable
 * and reconcilable by the library itself, so the build path checks the
 * identity before any money math runs, and the history-amount helpers
 * check an explicitly passed label the same way. `prefix` is the
 * caller's error family (`cannot build settlement report` for the build
 * path, `cannot read settlement amount` for the helpers).
 */
function assertSettlementEscrowId(
  escrowId: unknown,
  prefix: string,
): asserts escrowId is string {
  if (typeof escrowId !== "string" || escrowId.length === 0) {
    throw new Error(`${prefix}: escrowId must be a non-empty string`);
  }
  if (escrowId.length > MAX_ESCROW_ID_LENGTH) {
    throw new Error(
      `${prefix}: escrowId must be at most ${MAX_ESCROW_ID_LENGTH} characters, got ${escrowId.length}`,
    );
  }
}

export interface SettlementReportInputs {
  /**
   * Identity of the escrow this report is about. Must be a non-empty
   * string of at most `MAX_ESCROW_ID_LENGTH` (256) characters — the
   * same cap the escrow constructor enforces, so a report built here
   * can always be parsed (`parseSettlementReportCsv` /
   * `parseSettlementReportJson`) and reconciled
   * (`reconcileSettlements`) by this library. An empty or overlong id
   * throws `cannot build settlement report: …` before any money math
   * runs, and the batch wrapper records that failure per escrow
   * instead of aborting the batch.
   */
  escrowId: string;
  /** Append-only audit history, in seq order. */
  history: readonly EscrowHistoryEntry[];
  finalState: EscrowState;
  deposit: FeeBreakdown;
  /**
   * Optional ISO 4217 alpha-3 currency code for the figures in this
   * report (e.g. "USD"). When given it is carried verbatim onto the
   * report, the settlement webhook payload, the CSV export, and the
   * batch paths, and is covered by the webhook signature like every
   * other payload field. Omit it and the report keeps its previous
   * shape exactly: no `currency` key is emitted, so existing
   * snapshots, JSON exports, and receivers see zero change — the CSV
   * export still gains a `currency` column, left empty, so a
   * currency-less report's CSV keeps the same column shape as a
   * currency-carrying one. An illegal value (lowercase, wrong
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
  releasePath?: string | undefined;
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
 *
 * `escrowId` is only the label on those error messages. Omit it and the
 * default label `"escrow"` is used — that is a label for a call with no
 * report identity, not a report identity, so it is never validated. Pass
 * one explicitly and it is validated like a report identity (non-empty,
 * at most `MAX_ESCROW_ID_LENGTH` characters); an invalid label throws
 * `cannot read settlement amount: …` before the history is read.
 */
export function depositAmountFromHistory(
  history: readonly EscrowHistoryEntry[],
  escrowId?: string,
): number {
  const label = escrowId ?? "escrow";
  if (escrowId !== undefined) {
    assertSettlementEscrowId(escrowId, "cannot read settlement amount");
  }
  const total = totalFundedAmount(history);
  if (total === undefined) {
    const hasFund = history.some((entry) => entry.event === "FUND");
    throw new Error(
      hasFund
        ? `settlement requires a FUND amount for ${label}: a FUND event was recorded without an amount`
        : `settlement requires a FUND amount for ${label}: no FUND event in the audit history`,
    );
  }
  return total;
}

/**
 * Sum of all PARTIAL_RELEASE amounts in the audit history — the total
 * paid out in tranches so far. Symmetric to
 * {@link depositAmountFromHistory} (same shape, same `escrowId` for
 * error messages), with one deliberate asymmetry: an escrow with no
 * PARTIAL_RELEASE event at all has released 0, not an error — a
 * fresh escrow's released total is 0 by definition, and callers
 * computing the still-locked balance (`deposit - released`) need
 * that zero, not a throw. The strict half is kept: a
 * PARTIAL_RELEASE entry recorded without an amount throws
 * `settlement requires a PARTIAL_RELEASE amount` instead of letting
 * an uncorroborated release silently understate the paid-out total.
 * Dispatch always records an amount on PARTIAL_RELEASE, so a live
 * escrow never hits that throw — it guards hand-built or legacy
 * histories. Use it wherever a report or webhook payload needs the
 * paid-out tranche total alongside the locked deposit.
 *
 * `escrowId` is only the label on those error messages. Omit it and the
 * default label `"escrow"` is used — that is a label for a call with no
 * report identity, not a report identity, so it is never validated. Pass
 * one explicitly and it is validated like a report identity (non-empty,
 * at most `MAX_ESCROW_ID_LENGTH` characters); an invalid label throws
 * `cannot read settlement amount: …` before the history is read.
 */
export function releasedAmountFromHistory(
  history: readonly EscrowHistoryEntry[],
  escrowId?: string,
): number {
  const label = escrowId ?? "escrow";
  if (escrowId !== undefined) {
    assertSettlementEscrowId(escrowId, "cannot read settlement amount");
  }
  let total = 0;
  let hasRelease = false;
  for (const entry of history) {
    if (entry.event !== "PARTIAL_RELEASE") continue;
    hasRelease = true;
    if (entry.amount === undefined) {
      throw new Error(
        `settlement requires a PARTIAL_RELEASE amount for ${label}: a PARTIAL_RELEASE event was recorded without an amount`,
      );
    }
    total += entry.amount;
  }
  return hasRelease ? total : 0;
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
 * The report identity is checked first of all: an empty or overlong
 * `escrowId` (over `MAX_ESCROW_ID_LENGTH`, 256) throws `cannot build
 * settlement report: …` before the currency check, the chain check, or
 * any money math runs — a report the library builds must always pass
 * the library's own parsers and `reconcileSettlements`, so the build
 * path enforces the same identity cap those paths enforce.
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

  // Report identity first: an empty or overlong escrowId is the caller's
  // bug and must fail fast before the currency check, the chain check,
  // or any money math runs, so a report that could never be parsed or
  // reconciled by this library is never minted.
  assertSettlementEscrowId(escrowId, "cannot build settlement report");

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
 * order, each carrying the input's `escrowId`. An empty or overlong
 * `escrowId` is a per-entry failure like any other (the single-escrow
 * builder throws it, the wrapper records it) — it never aborts the
 * batch; only a repeated `escrowId` does, per the exception below. A per-escrow `auditKey`
 * rides along in the same inputs shape (the wrapper delegates to
 * {@link buildSettlementReport} unchanged), so a batch mixing keyed and
 * unkeyed escrows reports each under its own key.
 *
 * One exception to per-item isolation: a repeated `escrowId` aborts the
 * whole batch. Two entries for the same escrow would produce two
 * identical reports and `summarizeSettlementReports` would double-count
 * the same settlement in the day-end totals, so the batch fails closed
 * before building anything — it throws an error naming the duplicate
 * id(s) and produces no reports at all. This is a caller bug (a mistyped
 * batch list), not a per-escrow failure, so it is a throw, not a
 * per-entry error. The single-escrow {@link buildSettlementReport} is
 * unaffected: calling it twice for the same escrow is legitimate.
 */
export function buildSettlementReports(
  inputsList: readonly SettlementReportInputs[],
): SettlementReportResult[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const inputs of inputsList) {
    if (seen.has(inputs.escrowId)) {
      if (!duplicates.includes(inputs.escrowId)) {
        duplicates.push(inputs.escrowId);
      }
    } else {
      seen.add(inputs.escrowId);
    }
  }
  if (duplicates.length > 0) {
    const quoted = duplicates.map((id) => `"${id}"`).join(", ");
    throw new Error(
      `buildSettlementReports: duplicate escrowId ${quoted} in batch: escrowIds must be unique within a batch (a repeated escrow would produce two identical reports and double-count in summaries)`,
    );
  }
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
  /**
   * Sum of per-report `remaining` over this bucket's reports only
   * (reports without a `remaining` field — a full release, refund, or
   * expiry — contribute 0). This is the money still locked in this
   * currency's partially-released escrows; read it, not
   * `totalDeposit - totalOutflow`, for the still-locked remainder.
   */
  totalRemaining: number;
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
  /**
   * Sum of per-report `remaining` over successful reports only
   * (reports without a `remaining` field — a full release, refund, or
   * expiry — contribute 0). This is the money still locked in the
   * batch's partially-released escrows. Read this, not
   * `totalDeposit - totalOutflow`, for the still-locked remainder: a
   * partial report's ledger runs over the full deposit, so its
   * inflow and outflow both equal the deposit and the hand-computed
   * difference is 0 even while money is still locked.
   */
  totalRemaining: number;
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
 * counts, error count, total locked deposit, total inflow/outflow, the
 * still-locked remainder (`totalRemaining`, the sum of each successful
 * report's `remaining`), and per-party net totals.
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
 *
 * If any running total would leave the finite range — a hand-built or
 * upstream report carrying astronomical figures, or a batch whose
 * figures sum past `Number.MAX_VALUE` — the function throws
 * `settlement reports summary computation overflowed: inputs too large`
 * instead of returning `Infinity` totals that would only surface as
 * render errors downstream. Single reports are never re-validated:
 * only the sums are guarded, mirroring dataquest's
 * `summarizeTaskSettlements` contract (backlog #838).
 */
export function summarizeSettlementReports(
  results: readonly SettlementReportResult[],
): SettlementReportsSummary {
  // Fail-closed overflow guard (backlog #1098): every money
  // accumulation below goes through `addChecked`, and every rounded
  // figure on its way out goes through `roundChecked`, so no
  // `Infinity`/`NaN` can reach the returned summary.
  const overflow = (): Error =>
    new Error(
      "settlement reports summary computation overflowed: inputs too large",
    );
  const addChecked = (running: number, amount: number): number => {
    const next = running + amount;
    if (!Number.isFinite(next)) throw overflow();
    return next;
  };
  // `round2` multiplies by 100 before rounding, so a finite running
  // total above ~1.8e306 would still come back `Infinity` from the
  // rounding itself — the accumulation guard above cannot see that.
  const roundChecked = (n: number): number => {
    const rounded = round2(n);
    if (!Number.isFinite(rounded)) throw overflow();
    return rounded;
  };
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
  let totalRemaining = 0;
  let balanced = true;
  const currencySums = new Map<
    string,
    { reports: number; totalDeposit: number; totalInflow: number; totalOutflow: number; totalRemaining: number }
  >();

  for (const result of results) {
    if (!result.report) {
      errors += 1;
      continue;
    }
    const report = result.report;
    reports += 1;
    outcomes[report.outcome] += 1;
    totalDeposit = addChecked(totalDeposit, report.deposit.deposit);
    totalInflow = addChecked(totalInflow, report.totalInflow);
    totalOutflow = addChecked(totalOutflow, report.totalOutflow);
    // Only partially-released reports carry `remaining`; every other
    // outcome contributes 0, so a fully settled batch reads 0 here.
    totalRemaining = addChecked(totalRemaining, report.remaining ?? 0);
    if (!report.balanced) balanced = false;
    const bucketKey = report.currency ?? UNSPECIFIED_SETTLEMENT_CURRENCY;
    let bucket = currencySums.get(bucketKey);
    if (!bucket) {
      bucket = { reports: 0, totalDeposit: 0, totalInflow: 0, totalOutflow: 0, totalRemaining: 0 };
      currencySums.set(bucketKey, bucket);
    }
    bucket.reports += 1;
    bucket.totalDeposit = addChecked(bucket.totalDeposit, report.deposit.deposit);
    bucket.totalInflow = addChecked(bucket.totalInflow, report.totalInflow);
    bucket.totalOutflow = addChecked(bucket.totalOutflow, report.totalOutflow);
    bucket.totalRemaining = addChecked(bucket.totalRemaining, report.remaining ?? 0);
    for (const party of report.parties) {
      const sum = partySums.get(party.party);
      if (sum) {
        sum.inflow = addChecked(sum.inflow, party.inflow);
        sum.outflow = addChecked(sum.outflow, party.outflow);
      }
    }
  }

  const byCurrency: Record<string, SettlementCurrencySummary> = {};
  for (const [currency, bucket] of currencySums) {
    byCurrency[currency] = {
      reports: bucket.reports,
      totalDeposit: roundChecked(bucket.totalDeposit),
      totalInflow: roundChecked(bucket.totalInflow),
      totalOutflow: roundChecked(bucket.totalOutflow),
      totalRemaining: roundChecked(bucket.totalRemaining),
    };
  }

  return {
    total: results.length,
    reports,
    errors,
    outcomes,
    totalDeposit: roundChecked(totalDeposit),
    totalInflow: roundChecked(totalInflow),
    totalOutflow: roundChecked(totalOutflow),
    totalRemaining: roundChecked(totalRemaining),
    parties: (["sponsor", "creator", "platform", "referrer"] as PartyRole[]).map(
      (role) => {
        const sum = partySums.get(role)!;
        // The net is a subtraction, not an accumulation: two finite
        // opposite-signed extremes can still overflow it, so it gets
        // its own check rather than relying on the inflow/outflow
        // guards above.
        if (!Number.isFinite(sum.inflow - sum.outflow)) throw overflow();
        const row = ledger(role, sum.inflow, sum.outflow);
        if (
          !Number.isFinite(row.inflow) ||
          !Number.isFinite(row.outflow) ||
          !Number.isFinite(row.net)
        ) {
          throw overflow();
        }
        return row;
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
 * negative `amount` throws; an `escrowId` longer than
 * {@link MAX_ESCROW_ID_LENGTH} characters on either side throws — the
 * library can never mint an escrow id that long (the constructor caps
 * it at 256), so an overlong id at the reconcile entry is a malformed
 * input, not a pairing to attempt, and the throw happens before either
 * lookup map is consulted, so no partial pairing survives it; an
 * illegal currency code on either side (anything but three uppercase
 * letters) throws `invalid settlement currency: …` via the same shape
 * check the report builder uses; an id appearing twice in the reports
 * throws `duplicate report escrowId` — a duplicated report would
 * otherwise be counted once per copy in `matched` (the same settlement
 * tallied twice); and an id appearing twice in the ledger throws
 * `duplicate ledger escrowId` — a duplicated ledger row would otherwise
 * make "matched" ambiguous (which row did the report pair with?).
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
    if (report.escrowId.length > MAX_ESCROW_ID_LENGTH) {
      throw new Error(
        `invalid reconcileSettlements: report escrowId must be at most ${MAX_ESCROW_ID_LENGTH} characters, got ${report.escrowId.length}`,
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
    if (row.escrowId.length > MAX_ESCROW_ID_LENGTH) {
      throw new Error(
        `invalid reconcileSettlements: ledger escrowId must be at most ${MAX_ESCROW_ID_LENGTH} characters, got ${row.escrowId.length}`,
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

/**
 * One party row whose ledger moved between two reports of the same escrow.
 * `from` / `to` are detached copies: mutating them never touches the
 * compared reports.
 */
export interface SettlementReportPartyDiff {
  role: PartyRole;
  from: PartyLedger;
  to: PartyLedger;
}

/**
 * How the party ledgers moved between two reports: roles that appear in
 * only one report (`added` / `removed`, in that report's party order),
 * and roles present in both whose inflow, outflow, net, or label moved
 * (`changed`, in `a`'s party order). Amounts compare at integer-cent
 * precision, like every other money comparison in this diff. A role
 * listed twice compares by its first row — the build path never emits a
 * duplicate role, and this is a comparison, not a validation (see
 * {@link diffSettlementReports}).
 */
export interface SettlementReportPartiesDiff {
  added: PartyRole[];
  removed: PartyRole[];
  changed: SettlementReportPartyDiff[];
}

/**
 * Field-level difference between two settlement reports of the same
 * escrow. Only fields that moved are present: two identical reports
 * diff to `{}`. Every money comparison is at integer-cent precision
 * precision (see `toCents`) — figures that differ only below a cent, the
 * raw-float noise the rest of the library already rounds away, are the
 * same amount. `balanced` flipping is its own entry, so a report that
 * stopped balancing is visible even when no single amount looks wrong.
 */
export interface SettlementReportDiff {
  currencyChanged?: { from: string | undefined; to: string | undefined };
  outcomeChanged?: { from: SettlementOutcome; to: SettlementOutcome };
  releasePathChanged?: { from: string | undefined; to: string | undefined };
  depositChanged?: { from: FeeBreakdown; to: FeeBreakdown };
  settlementChanged?: {
    from: Settlement | undefined;
    to: Settlement | undefined;
  };
  partialSettlementChanged?: {
    from: PartialSettlement | undefined;
    to: PartialSettlement | undefined;
  };
  remainingChanged?: { from: number | undefined; to: number | undefined };
  partiesChanged?: SettlementReportPartiesDiff;
  totalInflowChanged?: { from: number; to: number };
  totalOutflowChanged?: { from: number; to: number };
  balancedChanged?: { from: boolean; to: boolean };
  eventCountChanged?: { from: number; to: number };
  firstEventAtChanged?: { from: string | undefined; to: string | undefined };
  lastEventAtChanged?: { from: string | undefined; to: string | undefined };
}

/**
 * Money as whole cents: the library's money model rounds every amount to
 * cents, so two figures that differ only below a cent (raw float
 * addition noise — 0.1 + 0.2 sums to 0.30000000000000004 while the
 * calculator produces exactly 0.3) are the same amount. This is the
 * same rule the build path uses when it checks the deposit against the
 * FUND total, and the same rule `reconcileSettlements` uses for
 * `totalOutflow`.
 */
function toCents(n: number): number {
  return Math.round(n * 100);
}

function sameMoney(a: number, b: number): boolean {
  return toCents(a) === toCents(b);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sameFeeBreakdown(a: FeeBreakdown, b: FeeBreakdown): boolean {
  return (
    sameMoney(a.creatorPool, b.creatorPool) &&
    sameMoney(a.baseFee, b.baseFee) &&
    // The multiplier is a plain ratio, not money: exact compare.
    a.complexityMultiplier === b.complexityMultiplier &&
    sameMoney(a.loyaltyDiscount, b.loyaltyDiscount) &&
    sameMoney(a.oracleFee, b.oracleFee) &&
    sameMoney(a.adjustedBaseFee, b.adjustedBaseFee) &&
    sameMoney(a.deposit, b.deposit)
  );
}

function sameSettlement(a: Settlement, b: Settlement): boolean {
  return (
    sameMoney(a.gross, b.gross) &&
    sameMoney(a.proFee, b.proFee) &&
    sameMoney(a.referralCredits, b.referralCredits) &&
    sameMoney(a.net, b.net)
  );
}

function samePartialSettlement(
  a: PartialSettlement,
  b: PartialSettlement,
): boolean {
  return (
    sameMoney(a.released, b.released) &&
    sameMoney(a.proFee, b.proFee) &&
    sameMoney(a.referralCredits, b.referralCredits) &&
    sameMoney(a.net, b.net) &&
    sameMoney(a.remaining, b.remaining)
  );
}

function samePartyLedger(a: PartyLedger, b: PartyLedger): boolean {
  return (
    a.label === b.label &&
    sameMoney(a.inflow, b.inflow) &&
    sameMoney(a.outflow, b.outflow) &&
    sameMoney(a.net, b.net)
  );
}

/**
 * Party rows indexed by role, first row wins on a duplicate role (the
 * build path never emits one). The map is read-only for the diff; the
 * rows it holds are the reports' own rows, so callers that need a
 * detached copy must spread them (see `diffSettlementReports`).
 */
function indexParties(
  parties: readonly PartyLedger[],
): Map<PartyRole, PartyLedger> {
  const byRole = new Map<PartyRole, PartyLedger>();
  for (const row of parties) {
    if (!byRole.has(row.party)) byRole.set(row.party, row);
  }
  return byRole;
}

/**
 * Compare two settlement reports of the same escrow and report what
 * changed between them — the reconciliation question ("what moved since
 * the report I stored last night?") without hand-written field compares
 * that disagree about float tolerance or party alignment.
 *
 * Dimensions compared, and only these: `currency` (an absent code and a
 * present one are different states), `outcome`, `releasePath`, the
 * `deposit` breakdown (every money field at integer-cent precision, the
 * complexity multiplier exactly), the `settlement` / `partialSettlement`
 * figures (same cent rule; present on one side only is a change),
 * `remaining`, the party ledgers (aligned by role — a role present on
 * one side only is reported as added/removed, never silently dropped),
 * `totalInflow` / `totalOutflow` (cent rule), the `balanced` flag (a
 * flip is its own entry), `eventCount`, and the audit window
 * `firstEventAt` / `lastEventAt`. Only `escrowId` itself is not
 * reported: it is the identity the two reports must share, and reports
 * of different escrows throw
 * `settlement report diff failed: cannot diff reports of different escrows …`
 * — the same fail-fast identity rule `diffEscrowSnapshots` uses
 * for snapshots, so diffing across escrows can never report nonsense
 * as if it were one escrow's evolution.
 *
 * Pure: reads both reports, never mutates them, and every object the
 * diff carries is a detached copy. This is a comparison, not a
 * validation — it does not re-check that either report's figures are
 * internally consistent, that its history chain holds, or that its
 * totals sum; run a report through `buildSettlementReport` (or its
 * history through `verifyHistoryChain`) when the input itself is
 * untrusted.
 *
 *   const before = buildSettlementReport({ ... });
 *   const after = buildSettlementReport({ ..., settlement: { proFeeBps: 600 } });
 *   diffSettlementReports(before, after);
 *   // { settlementChanged: { from: { gross: 10630, proFee: 531.5, … },
 *   //                        to: { gross: 10630, proFee: 637.8, … } },
 *   //   partiesChanged: { added: [], removed: [],
 *   //                     changed: [{ role: "creator", … }, { role: "platform", … }] } }
 *   // (The totals do not move here: the deposit is unchanged, so
 *   // `totalInflow` / `totalOutflow` stay 10630 and `balanced` stays true.)
 */
export function diffSettlementReports(
  a: SettlementReport,
  b: SettlementReport,
): SettlementReportDiff {
  if (!isRecord(a) || !isRecord(b)) {
    throw new Error(
      "invalid settlement report diff: both reports must be objects",
    );
  }
  if (a.escrowId !== b.escrowId) {
    throw new Error(
      `settlement report diff failed: cannot diff reports of different escrows (${JSON.stringify(a.escrowId)} vs ${JSON.stringify(b.escrowId)})`,
    );
  }
  const diff: SettlementReportDiff = {};
  if (a.currency !== b.currency) {
    diff.currencyChanged = { from: a.currency, to: b.currency };
  }
  if (a.outcome !== b.outcome) {
    diff.outcomeChanged = { from: a.outcome, to: b.outcome };
  }
  if (a.releasePath !== b.releasePath) {
    diff.releasePathChanged = { from: a.releasePath, to: b.releasePath };
  }
  if (!sameFeeBreakdown(a.deposit, b.deposit)) {
    diff.depositChanged = { from: { ...a.deposit }, to: { ...b.deposit } };
  }
  if (
    (a.settlement === undefined) !== (b.settlement === undefined) ||
    (a.settlement !== undefined &&
      b.settlement !== undefined &&
      !sameSettlement(a.settlement, b.settlement))
  ) {
    diff.settlementChanged = {
      from: a.settlement === undefined ? undefined : { ...a.settlement },
      to: b.settlement === undefined ? undefined : { ...b.settlement },
    };
  }
  if (
    (a.partialSettlement === undefined) !==
      (b.partialSettlement === undefined) ||
    (a.partialSettlement !== undefined &&
      b.partialSettlement !== undefined &&
      !samePartialSettlement(a.partialSettlement, b.partialSettlement))
  ) {
    diff.partialSettlementChanged = {
      from:
        a.partialSettlement === undefined
          ? undefined
          : { ...a.partialSettlement },
      to:
        b.partialSettlement === undefined
          ? undefined
          : { ...b.partialSettlement },
    };
  }
  if (
    (a.remaining === undefined) !== (b.remaining === undefined) ||
    (a.remaining !== undefined &&
      b.remaining !== undefined &&
      !sameMoney(a.remaining, b.remaining))
  ) {
    diff.remainingChanged = { from: a.remaining, to: b.remaining };
  }
  const aParties = indexParties(a.parties);
  const bParties = indexParties(b.parties);
  const added: PartyRole[] = [];
  const removed: PartyRole[] = [];
  const changed: SettlementReportPartyDiff[] = [];
  for (const row of b.parties) {
    if (!aParties.has(row.party) && !added.includes(row.party)) {
      added.push(row.party);
    }
  }
  for (const row of a.parties) {
    if (!bParties.has(row.party) && !removed.includes(row.party)) {
      removed.push(row.party);
    }
  }
  for (const row of a.parties) {
    const other = bParties.get(row.party);
    if (
      other !== undefined &&
      !samePartyLedger(row, other) &&
      !changed.some((entry) => entry.role === row.party)
    ) {
      changed.push({ role: row.party, from: { ...row }, to: { ...other } });
    }
  }
  if (added.length > 0 || removed.length > 0 || changed.length > 0) {
    diff.partiesChanged = { added, removed, changed };
  }
  if (!sameMoney(a.totalInflow, b.totalInflow)) {
    diff.totalInflowChanged = { from: a.totalInflow, to: b.totalInflow };
  }
  if (!sameMoney(a.totalOutflow, b.totalOutflow)) {
    diff.totalOutflowChanged = { from: a.totalOutflow, to: b.totalOutflow };
  }
  if (a.balanced !== b.balanced) {
    diff.balancedChanged = { from: a.balanced, to: b.balanced };
  }
  if (a.eventCount !== b.eventCount) {
    diff.eventCountChanged = { from: a.eventCount, to: b.eventCount };
  }
  if (a.firstEventAt !== b.firstEventAt) {
    diff.firstEventAtChanged = { from: a.firstEventAt, to: b.firstEventAt };
  }
  if (a.lastEventAt !== b.lastEventAt) {
    diff.lastEventAtChanged = { from: a.lastEventAt, to: b.lastEventAt };
  }
  return diff;
}

/**
 * How one party's ledger moved between two summaries: the role, and
 * the ledger rows from each side (detached copies, so mutating the
 * diff never touches either summary). The move itself is decided by
 * `samePartyLedger` (inflow, outflow, net at cent precision, label
 * included) — the same rule `diffSettlementReports` uses for single
 * reports, so the two diffs never disagree about what a party move is.
 */
export interface SettlementReportsSummaryPartyDiff {
  role: PartyRole;
  from: PartyLedger;
  to: PartyLedger;
}

/**
 * How the party ledgers moved between two summaries: roles that appear
 * in only one summary (`added` / `removed`, in that summary's party
 * order), and roles present in both whose ledger moved (`changed`, in
 * `a`'s party order). A role listed twice compares by its first row —
 * the build path never emits a duplicate role, and this is a
 * comparison, not a validation (see {@link diffSettlementReports}).
 */
export interface SettlementReportsSummaryPartiesDiff {
  added: PartyRole[];
  removed: PartyRole[];
  changed: SettlementReportsSummaryPartyDiff[];
}

/**
 * How one currency bucket moved between two summaries: the code, and
 * the bucket figures from each side (detached copies). The move is
 * decided by the bucket's five figures — `reports` exactly, the four
 * money figures at integer-cent precision.
 */
export interface SettlementReportsSummaryCurrencyDiff {
  currency: string;
  from: SettlementCurrencySummary;
  to: SettlementCurrencySummary;
}

/**
 * How the per-currency buckets moved between two summaries: codes
 * that appear in only one summary (`added` / `removed`, in that
 * summary's key order — a bucket present on one side only is reported
 * whole, never field by field), and codes present in both whose
 * figures moved (`changed`, in `a`'s key order).
 */
export interface SettlementReportsSummaryCurrenciesDiff {
  added: string[];
  removed: string[];
  changed: SettlementReportsSummaryCurrencyDiff[];
}

/**
 * Field-level difference between two settlement-reports summaries.
 * Only fields that moved are present: two identical summaries diff
 * to `{}`. Counts compare exactly; every money comparison is at
 * integer-cent precision (see `toCents`) — figures that differ only
 * below a cent, the raw-float noise the rest of the library already
 * rounds away, are the same amount, and a one-cent difference is a
 * change. `outcomes` is one entry carrying the whole four-tier record
 * (detached copies), so a single tier moving is visible without
 * hand-written per-tier compares; `balanced` flipping is its own
 * entry, so a summary that stopped balancing is visible even when no
 * single amount looks wrong.
 */
export interface SettlementReportsSummaryDiff {
  totalChanged?: { from: number; to: number };
  reportsChanged?: { from: number; to: number };
  errorsChanged?: { from: number; to: number };
  outcomesChanged?: {
    from: Record<SettlementOutcome, number>;
    to: Record<SettlementOutcome, number>;
  };
  totalDepositChanged?: { from: number; to: number };
  totalInflowChanged?: { from: number; to: number };
  totalOutflowChanged?: { from: number; to: number };
  totalRemainingChanged?: { from: number; to: number };
  partiesChanged?: SettlementReportsSummaryPartiesDiff;
  byCurrencyChanged?: SettlementReportsSummaryCurrenciesDiff;
  balancedChanged?: { from: boolean; to: boolean };
}

/** The four outcome tiers, in the canonical order the summary uses. */
const SETTLEMENT_OUTCOME_TIERS: readonly SettlementOutcome[] = [
  "released",
  "refunded",
  "expired",
  "partially-released",
];

function sameOutcomes(
  a: Record<SettlementOutcome, number>,
  b: Record<SettlementOutcome, number>,
): boolean {
  return SETTLEMENT_OUTCOME_TIERS.every((tier) => a[tier] === b[tier]);
}

function sameCurrencySummary(
  a: SettlementCurrencySummary,
  b: SettlementCurrencySummary,
): boolean {
  return (
    a.reports === b.reports &&
    sameMoney(a.totalDeposit, b.totalDeposit) &&
    sameMoney(a.totalInflow, b.totalInflow) &&
    sameMoney(a.totalOutflow, b.totalOutflow) &&
    sameMoney(a.totalRemaining, b.totalRemaining)
  );
}

/**
 * Compare two settlement-reports summaries and report what changed
 * between them — the reconciliation question ("what moved since the
 * summary I stored last night?") without hand-written field compares
 * that disagree about float tolerance, party alignment, or currency
 * buckets. This is the escrow-side mirror of dataquest's
 * `diffTaskSettlementsSummaries` (backlog #1094), with the same diff
 * shape — `{ <field>Changed: { from, to } }` per moved field, `{}` when
 * nothing moved — and the same contract: a comparison, not a
 * validation. The nested shapes follow this file's own
 * `diffSettlementReports` (backlog #1092): parties align by role and
 * currency buckets align by code, a role or code present on one side
 * only is reported as added or removed, never silently dropped.
 *
 * One deliberate difference from the dataquest mirror, forced by what
 * the summary carries: there is no identity guard. A
 * `SettlementReport` carries an `escrowId` the single-report diff
 * refuses to cross; a `SettlementReportsSummary` carries no batch id
 * at all, so there is nothing to compare identity on. Diffing
 * summaries of two different batches is the caller's responsibility —
 * the diff answers "what moved", never "are these the same batch".
 *
 * Pure: reads both summaries, never mutates them, and every object the
 * diff carries is a detached copy. This is a comparison, not a
 * validation — it does not re-check that either summary's
 * `totalRemaining` equals the sum of its reports' `remaining`, that its
 * currency buckets sum to the top-level totals, that `balanced` agrees
 * with its totals, or that its figures match any audit history; run an
 * untrusted input through the summary parsers when the input itself is
 * untrusted.
 *
 *   const before = summarizeSettlementReports(results);
 *   const after = summarizeSettlementReports(recomputed);
 *   diffSettlementReportsSummaries(before, after);
 *   // { totalChanged: { from: 1, to: 2 },
 *   //   reportsChanged: { from: 1, to: 2 },
 *   //   totalDepositChanged: { from: 10630, to: 21260 }, ... }
 *   // (A second escrow settling adds a report and doubles the locked
 *   // deposit; the per-currency bucket moves with it, while `balanced`
 *   // stays true and reports no entry.)
 */
export function diffSettlementReportsSummaries(
  a: SettlementReportsSummary,
  b: SettlementReportsSummary,
): SettlementReportsSummaryDiff {
  if (!isRecord(a) || !isRecord(b)) {
    throw new Error(
      "invalid settlement reports summary diff: both summaries must be objects",
    );
  }
  const diff: SettlementReportsSummaryDiff = {};
  if (a.total !== b.total) {
    diff.totalChanged = { from: a.total, to: b.total };
  }
  if (a.reports !== b.reports) {
    diff.reportsChanged = { from: a.reports, to: b.reports };
  }
  if (a.errors !== b.errors) {
    diff.errorsChanged = { from: a.errors, to: b.errors };
  }
  if (!sameOutcomes(a.outcomes, b.outcomes)) {
    diff.outcomesChanged = { from: { ...a.outcomes }, to: { ...b.outcomes } };
  }
  if (!sameMoney(a.totalDeposit, b.totalDeposit)) {
    diff.totalDepositChanged = { from: a.totalDeposit, to: b.totalDeposit };
  }
  if (!sameMoney(a.totalInflow, b.totalInflow)) {
    diff.totalInflowChanged = { from: a.totalInflow, to: b.totalInflow };
  }
  if (!sameMoney(a.totalOutflow, b.totalOutflow)) {
    diff.totalOutflowChanged = { from: a.totalOutflow, to: b.totalOutflow };
  }
  if (!sameMoney(a.totalRemaining, b.totalRemaining)) {
    diff.totalRemainingChanged = {
      from: a.totalRemaining,
      to: b.totalRemaining,
    };
  }
  const aParties = indexParties(a.parties);
  const bParties = indexParties(b.parties);
  const added: PartyRole[] = [];
  const removed: PartyRole[] = [];
  const changed: SettlementReportsSummaryPartyDiff[] = [];
  for (const row of b.parties) {
    if (!aParties.has(row.party) && !added.includes(row.party)) {
      added.push(row.party);
    }
  }
  for (const row of a.parties) {
    if (!bParties.has(row.party) && !removed.includes(row.party)) {
      removed.push(row.party);
    }
  }
  for (const row of a.parties) {
    const other = bParties.get(row.party);
    if (
      other !== undefined &&
      !samePartyLedger(row, other) &&
      !changed.some((entry) => entry.role === row.party)
    ) {
      changed.push({ role: row.party, from: { ...row }, to: { ...other } });
    }
  }
  if (added.length > 0 || removed.length > 0 || changed.length > 0) {
    diff.partiesChanged = { added, removed, changed };
  }
  const hasCurrency = (
    buckets: Record<string, SettlementCurrencySummary>,
    code: string,
  ): boolean => Object.prototype.hasOwnProperty.call(buckets, code);
  const addedCurrencies: string[] = [];
  const removedCurrencies: string[] = [];
  const changedCurrencies: SettlementReportsSummaryCurrencyDiff[] = [];
  for (const code of Object.keys(b.byCurrency)) {
    if (
      !hasCurrency(a.byCurrency, code) &&
      !addedCurrencies.includes(code)
    ) {
      addedCurrencies.push(code);
    }
  }
  for (const code of Object.keys(a.byCurrency)) {
    if (
      !hasCurrency(b.byCurrency, code) &&
      !removedCurrencies.includes(code)
    ) {
      removedCurrencies.push(code);
    }
  }
  for (const code of Object.keys(a.byCurrency)) {
    if (!hasCurrency(b.byCurrency, code)) continue;
    const other = b.byCurrency[code];
    if (
      !sameCurrencySummary(a.byCurrency[code], other) &&
      !changedCurrencies.some((entry) => entry.currency === code)
    ) {
      changedCurrencies.push({
        currency: code,
        from: { ...a.byCurrency[code] },
        to: { ...other },
      });
    }
  }
  if (
    addedCurrencies.length > 0 ||
    removedCurrencies.length > 0 ||
    changedCurrencies.length > 0
  ) {
    diff.byCurrencyChanged = {
      added: addedCurrencies,
      removed: removedCurrencies,
      changed: changedCurrencies,
    };
  }
  if (a.balanced !== b.balanced) {
    diff.balancedChanged = { from: a.balanced, to: b.balanced };
  }
  return diff;
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
 * - Header: `escrowId,outcome,currency,role,inflow,outflow,net`.
 * - One row per party in the report's party order (sponsor, creator,
 *   platform, referrer), including zero-amount parties, so a row is never
 *   silently absent from an import. Amounts are cent-rounded with exactly
 *   two decimals, matching `renderReport`'s cent precision.
 * - A final `TOTAL` row (`escrowId,outcome,currency,TOTAL,...`) whose inflow/outflow/
 *   net columns are the sums over the party rows above it — computed from
 *   the rows themselves, not copied from the report's totals, so the CSV is
 *   self-consistent even if a hand-built report's totals disagree.
 *
 * The `currency` column carries the report's ISO 4217 code on every row
 * (including `TOTAL`), so a multi-currency bookkeeping import can tell
 * USD rows from EUR rows without re-querying the report. A report built
 * without a currency renders the column empty — the column is still
 * present, so a currency-less export keeps the same 7-column shape and
 * an importer never has to guess the column count from the header.
 *
 * String fields are RFC 4180-escaped (today's ids/roles/outcomes contain no
 * special characters; the escaping is pinned anyway so a future id carrying
 * a comma or quote cannot silently shift columns).
 *
 * The parameter is a full {@link SettlementReport} or the CSV-carried
 * subset returned by {@link parseSettlementReportCsv}: rendering reads
 * only `escrowId`, `outcome`, `currency`, and `parties`, so a parsed value re-renders
 * byte-identically without rebuilding the fields the CSV never carried.
 *
 * Before rendering, the CSV-carried fields are shape-checked with the
 * shared core also used by {@link assertReportShape} (see below): a non-object
 * report, an empty `escrowId`, an illegal `outcome`, an illegal `currency`,
 * an empty `parties` array, an unknown party role, or a non-finite party amount
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
  const lines: string[] = ["escrowId,outcome,currency,role,inflow,outflow,net"];
  let totalInflow = 0;
  let totalOutflow = 0;
  let totalNet = 0;
  for (const p of report.parties) {
    lines.push(
      [
        csvField(report.escrowId),
        csvField(report.outcome),
        csvField(report.currency ?? ""),
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
      csvField(report.currency ?? ""),
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
 * A CSV row carries `escrowId`, `outcome`, the `currency` code when
 * the report was built with one (the column is empty when it was not),
 * and the per-party `inflow`/`outflow`/`net` ledgers, plus the `TOTAL`
 * row that sums them.
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
  /**
   * The report's ISO 4217 currency code, when the report was built
   * with one. Absent when the CSV's currency column was empty — the
   * column is still present in the file, so a currency-less report
   * re-renders byte-identically with the empty column.
   */
  currency?: string;
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
function parseCsvRecords(
  text: string,
  prefix = "cannot parse settlement report CSV",
): string[][] {
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
          `${prefix}: unexpected character after a closing quote: ${JSON.stringify(c)}`,
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
    throw new Error(`${prefix}: unterminated quoted field`);
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

function parseCsvMoney(
  value: string,
  where: string,
  prefix = "cannot parse settlement report CSV",
): number {
  if (!CSV_MONEY.test(value)) {
    throw new Error(
      `${prefix}: ${where} must be a two-decimal money figure, got ${JSON.stringify(value)}`,
    );
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(
      `${prefix}: ${where} must be a finite number, got ${JSON.stringify(value)}`,
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
 * `escrowId,outcome,currency,role,inflow,outflow,net`; there must be exactly four
 * party rows (one per role, each once, in any order) plus a final `TOTAL`
 * row; every row must carry the same `escrowId` (non-empty and at most
 * {@link MAX_ESCROW_ID_LENGTH} characters, the same cap the escrow
 * constructor enforces — a longer id could never have been minted by
 * this library), `outcome`, and `currency` (empty when the report was
 * built without one; a non-empty code must be a 3-letter uppercase ISO
 * 4217 code); every amount must be a finite two-decimal figure; every
 * party's `net` must equal its `inflow − outflow` at cent precision; and
 * the `TOTAL` row must equal the sums over the party rows. Any violation
 * throws `cannot parse settlement report CSV: …` instead of returning a
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
    header.length !== 7 ||
    header[0] !== "escrowId" ||
    header[1] !== "outcome" ||
    header[2] !== "currency" ||
    header[3] !== "role" ||
    header[4] !== "inflow" ||
    header[5] !== "outflow" ||
    header[6] !== "net"
  ) {
    fail('header must be exactly "escrowId,outcome,currency,role,inflow,outflow,net"');
  }
  const escrowId = records[1][0];
  const outcome = records[1][1];
  const currency = records[1][2];
  if (escrowId === undefined || escrowId === "") {
    fail("escrowId must be a non-empty string");
  }
  if (escrowId.length > MAX_ESCROW_ID_LENGTH) {
    fail(
      `escrowId must be at most ${MAX_ESCROW_ID_LENGTH} characters, got ${escrowId.length}`,
    );
  }
  if (outcome !== "released" && outcome !== "refunded" && outcome !== "expired" && outcome !== "partially-released") {
    fail('outcome must be "released", "refunded", "expired", or "partially-released"');
  }
  if (currency === undefined) {
    fail("currency must be present (empty when the report carries none)");
  }
  if (currency !== "" && !ISO_4217_ALPHA3.test(currency)) {
    fail(`currency must be a 3-letter uppercase ISO 4217 code, got ${JSON.stringify(currency)}`);
  }
  const parties: PartyLedger[] = [];
  const seen = new Set<string>();
  let sumInflow = 0;
  let sumOutflow = 0;
  let sumNet = 0;
  for (let r = 1; r <= 4; r += 1) {
    const row = records[r];
    const where = `party row ${r}`;
    if (row.length !== 7) fail(`${where} must have 7 columns, got ${row.length}`);
    if (row[0] !== escrowId) fail(`${where} escrowId ${JSON.stringify(row[0])} does not match ${JSON.stringify(escrowId)}`);
    if (row[1] !== outcome) fail(`${where} outcome ${JSON.stringify(row[1])} does not match ${JSON.stringify(outcome)}`);
    if (row[2] !== currency) fail(`${where} currency ${JSON.stringify(row[2])} does not match ${JSON.stringify(currency)}`);
    const role = row[3];
    if (role !== "sponsor" && role !== "creator" && role !== "platform" && role !== "referrer") {
      fail(`${where} role must be a PartyRole, got ${JSON.stringify(role)}`);
    }
    if (seen.has(role)) fail(`${where} role ${JSON.stringify(role)} appears more than once`);
    seen.add(role);
    const inflow = parseCsvMoney(row[4], `${where} inflow`);
    const outflow = parseCsvMoney(row[5], `${where} outflow`);
    const net = parseCsvMoney(row[6], `${where} net`);
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
  if (total.length !== 7) fail(`TOTAL row must have 7 columns, got ${total.length}`);
  if (total[0] !== escrowId) fail(`TOTAL row escrowId does not match ${JSON.stringify(escrowId)}`);
  if (total[1] !== outcome) fail(`TOTAL row outcome does not match ${JSON.stringify(outcome)}`);
  if (total[2] !== currency) fail(`TOTAL row currency does not match ${JSON.stringify(currency)}`);
  if (total[3] !== "TOTAL") fail(`last row role must be "TOTAL", got ${JSON.stringify(total[3])}`);
  const totalInflow = parseCsvMoney(total[4], "TOTAL row inflow");
  const totalOutflow = parseCsvMoney(total[5], "TOTAL row outflow");
  const totalNet = parseCsvMoney(total[6], "TOTAL row net");
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
    // Empty currency column means the report was built without one:
    // omit the key so the parsed value re-renders byte-identically
    // (the renderer writes an empty column for an absent currency).
    ...(currency !== "" ? { currency } : {}),
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
 * `currency`, and the per-party ledgers. This is the shared core of the
 * report shape checks: {@link renderReportCsv} applies exactly this (with a CSV
 * prefix) because rendering reads nothing else, and
 * {@link assertReportShape} applies it first and then adds the
 * full-report fields. `currency`, totals, and `balanced` are carried by
 * both shapes, so when present they must be sane; a bare carried-fields
 * value without them still passes here, and the full-report check below
 * requires the totals and the balanced flag. The `escrowId` is capped at
 * {@link MAX_ESCROW_ID_LENGTH} characters, the same cap the escrow
 * constructor enforces: a report shape carrying a longer id could never
 * have been minted by this library, so it is malformed here, not only
 * at the reconcile entry.
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
  if (
    typeof r.escrowId === "string" &&
    r.escrowId.length > MAX_ESCROW_ID_LENGTH
  )
    fail(
      `escrowId must be at most ${MAX_ESCROW_ID_LENGTH} characters, got ${r.escrowId.length}`,
    );
  if (r.outcome !== "released" && r.outcome !== "refunded" && r.outcome !== "expired" && r.outcome !== "partially-released")
    fail('outcome must be "released", "refunded", "expired", or "partially-released"');
  if (
    r.currency !== undefined &&
    (typeof r.currency !== "string" || !ISO_4217_ALPHA3.test(r.currency))
  )
    fail("currency must be a 3-letter uppercase ISO 4217 code when present");
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
  // Currency is validated by the shared CSV-fields core above, which
  // runs first with this same prefix — no second check here.
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

/**
 * The settlement-reports summary as carried by
 * {@link renderSettlementReportsSummaryCsv} — the whole
 * {@link SettlementReportsSummary}, nothing less. Unlike
 * {@link SettlementReportCsv}, which is a subset of its report (the CSV
 * drops the deposit breakdown, settlement parameters, and audit
 * window), the summary CSV carries every field, so a parsed value is
 * the full summary and re-renders byte-identically; no field is ever
 * invented on import.
 */
export type SettlementReportsSummaryCsv = SettlementReportsSummary;

/**
 * Canonical field order for the summary CSV: the header names every
 * column, and every row carries the columns its section owns, leaving
 * the rest empty — so a hand-built file cannot smuggle a value into a
 * column its row does not own. Column meanings are uniform across
 * rows: `count` is the row's own entry count (an outcome's report
 * count, a currency bucket's report count); `total` / `reports` /
 * `errors` are the batch totals and appear only on the `summary` row;
 * the four money columns are cent sums for the row's scope (the batch
 * on the `summary` row, one currency's reports on a `currency` row,
 * one party's summed ledger on a `party` row); `net` is
 * `inflow − outflow` on a `party` row; `balanced` is `true`/`false`
 * on the `summary` row only.
 */
const SUMMARY_CSV_HEADER =
  "section,key,count,total,reports,errors,totalDeposit,totalInflow,totalOutflow,totalRemaining,net,balanced";

/** Outcome counts appear in this fixed order in the summary CSV. */
const SUMMARY_OUTCOME_ORDER: SettlementOutcome[] = [
  "released",
  "refunded",
  "expired",
  "partially-released",
];

/** Party rows appear in this canonical role order in the summary CSV. */
const SUMMARY_PARTY_ORDER: PartyRole[] = [
  "sponsor",
  "creator",
  "platform",
  "referrer",
];

/**
 * Canonical integer text for the summary CSV's counts: `0`, or a
 * positive integer with no leading zeros. Anything else — `5.0`,
 * `1e3`, `007`, `-0`, `+5`, ` 5`, a negative count — is rejected, so
 * a parsed summary re-renders byte-identically instead of silently
 * normalizing the spelling a caller wrote.
 */
const SUMMARY_CSV_INTEGER = /^(0|[1-9]\d*)$/;

function parseSummaryCsvInteger(value: string, where: string): number {
  if (!SUMMARY_CSV_INTEGER.test(value)) {
    throw new Error(
      `cannot parse settlement reports summary CSV: ${where} must be a canonical non-negative integer, got ${JSON.stringify(value)}`,
    );
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(
      `cannot parse settlement reports summary CSV: ${where} must be a safe integer, got ${JSON.stringify(value)}`,
    );
  }
  return n;
}

/**
 * Validate the structural shape of a settlement-reports summary
 * before it is serialized (or after it is parsed back). This is a
 * shape check, not a re-derivation of the accounting: the figures are
 * trusted as the caller's (normally {@link summarizeSettlementReports}'s
 * output), but a value that is not a summary at all — or a money
 * figure that is not a finite cent-exact number — must fail loudly
 * here rather than silently degrading in transit. `JSON.stringify`
 * turns `Infinity`/`NaN` into `null` without complaint, so a
 * non-finite figure would otherwise leave this function as a
 * plausible-looking `null` and corrupt a downstream import. Counts
 * must be safe integers — `JSON.stringify` and `Number` both lose
 * precision past `Number.MAX_SAFE_INTEGER`, so an unsafe count would
 * round-trip to a different number and break the `parse(render(s)) ===
 * s` identity the renderers promise. Unknown or missing fields fail
 * closed: a summary with a field the renderers never write is not a
 * summary this library can carry, and a missing field would render as
 * an empty column. Every failure throws `<prefix>: …`, where the
 * prefix names the direction, so a failure's origin is unambiguous.
 */
function assertSettlementReportsSummaryShape(
  summary: unknown,
  prefix: string,
): asserts summary is SettlementReportsSummary {
  const fail = (reason: string): never => {
    throw new Error(`${prefix}: ${reason}`);
  };
  if (
    typeof summary !== "object" ||
    summary === null ||
    Array.isArray(summary)
  )
    fail("summary must be a SettlementReportsSummary object");
  const s = summary as Record<string, unknown>;
  const topLevelFields = [
    "total",
    "reports",
    "errors",
    "outcomes",
    "totalDeposit",
    "totalInflow",
    "totalOutflow",
    "totalRemaining",
    "parties",
    "byCurrency",
    "balanced",
  ] as const;
  for (const field of topLevelFields) {
    if (!(field in s)) fail(`missing field ${JSON.stringify(field)}`);
  }
  for (const key of Object.keys(s)) {
    if (!(topLevelFields as readonly string[]).includes(key))
      fail(`unknown field ${JSON.stringify(key)}`);
  }
  const show = (value: unknown): string =>
    typeof value === "number" ? String(value) : JSON.stringify(value);
  for (const field of ["total", "reports", "errors"] as const) {
    const value = s[field];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      fail(
        `${field} must be a non-negative safe integer, got ${show(value)}`,
      );
  }
  if (
    typeof s.outcomes !== "object" ||
    s.outcomes === null ||
    Array.isArray(s.outcomes)
  )
    fail("outcomes must be an object");
  const outcomes = s.outcomes as Record<string, unknown>;
  for (const outcome of SUMMARY_OUTCOME_ORDER) {
    if (!(outcome in outcomes))
      fail(`missing outcomes field ${JSON.stringify(outcome)}`);
  }
  for (const key of Object.keys(outcomes)) {
    if (!(SUMMARY_OUTCOME_ORDER as readonly string[]).includes(key))
      fail(`unknown outcomes field ${JSON.stringify(key)}`);
    const value = outcomes[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      fail(
        `outcomes.${key} must be a non-negative safe integer, got ${show(value)}`,
      );
  }
  const assertMoney = (
    value: unknown,
    where: string,
    allowNegative: boolean,
  ): void => {
    if (typeof value !== "number" || !Number.isFinite(value))
      fail(`${where} must be a finite number, got ${show(value)}`);
    // The check above established the type; the cast only tells
    // TypeScript what the runtime check established (a never-returning
    // helper call does not narrow here).
    const n = value as number;
    if (round2(n) !== n)
      fail(`${where} must be a cent-exact number, got ${show(n)}`);
    if (!allowNegative && n < 0)
      fail(`${where} must not be negative, got ${n}`);
  };
  for (const field of [
    "totalDeposit",
    "totalInflow",
    "totalOutflow",
    "totalRemaining",
  ] as const) {
    assertMoney(s[field], field, false);
  }
  if (!Array.isArray(s.parties) || s.parties.length !== 4)
    fail("parties must be an array of exactly 4 PartyLedger entries");
  const seenRoles = new Set<string>();
  for (const party of s.parties as unknown[]) {
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
    if (seenRoles.has(p.party as string))
      fail(`party role ${JSON.stringify(p.party)} appears more than once`);
    seenRoles.add(p.party as string);
    if (typeof p.label !== "string") fail("each party.label must be a string");
    assertMoney(p.inflow, `parties.${p.party as string}.inflow`, false);
    assertMoney(p.outflow, `parties.${p.party as string}.outflow`, false);
    assertMoney(p.net, `parties.${p.party as string}.net`, true);
  }
  for (const role of SUMMARY_PARTY_ORDER) {
    if (!seenRoles.has(role))
      fail(`missing party entry for role ${JSON.stringify(role)}`);
  }
  if (
    typeof s.byCurrency !== "object" ||
    s.byCurrency === null ||
    Array.isArray(s.byCurrency)
  )
    fail("byCurrency must be an object");
  for (const [code, bucket] of Object.entries(
    s.byCurrency as Record<string, unknown>,
  )) {
    if (
      code !== UNSPECIFIED_SETTLEMENT_CURRENCY &&
      !ISO_4217_ALPHA3.test(code)
    )
      fail(
        `byCurrency key ${JSON.stringify(code)} must be a 3-letter uppercase ISO 4217 code or ${JSON.stringify(UNSPECIFIED_SETTLEMENT_CURRENCY)}`,
      );
    if (typeof bucket !== "object" || bucket === null || Array.isArray(bucket))
      fail(`byCurrency.${code} must be a SettlementCurrencySummary object`);
    const b = bucket as Record<string, unknown>;
    const bucketFields = [
      "reports",
      "totalDeposit",
      "totalInflow",
      "totalOutflow",
      "totalRemaining",
    ] as const;
    for (const field of bucketFields) {
      if (!(field in b))
        fail(`missing field byCurrency.${code}.${field}`);
    }
    for (const key of Object.keys(b)) {
      if (!(bucketFields as readonly string[]).includes(key))
        fail(`unknown field byCurrency.${code}.${key}`);
    }
    if (
      typeof b.reports !== "number" ||
      !Number.isSafeInteger(b.reports) ||
      b.reports < 0
    )
      fail(
        `byCurrency.${code}.reports must be a non-negative safe integer, got ${show(b.reports)}`,
      );
    for (const field of [
      "totalDeposit",
      "totalInflow",
      "totalOutflow",
      "totalRemaining",
    ] as const) {
      assertMoney(b[field], `byCurrency.${code}.${field}`, false);
    }
  }
  if (typeof s.balanced !== "boolean") fail("balanced must be a boolean");
}

/**
 * Validate the self-consistency identities a settlement-reports
 * summary carries — the check that turns a structurally valid object
 * into one the renderers can stand behind. The identities are the
 * ones {@link summarizeSettlementReports} guarantees by construction:
 * `total` is `reports + errors`; the four outcome counts sum to
 * `reports`; the party ledgers sum to the top-level inflow/outflow
 * and each party's `net` is its `inflow − outflow` at cent precision;
 * the currency buckets sum to the top-level totals (report count and
 * all four money figures, `totalRemaining` included). `balanced` is
 * checked only in the direction the summary can prove: a summary
 * claiming `balanced: true` over disagreeing totals is impossible —
 * every successful report being balanced means each report's inflow
 * equals its outflow, so the batch totals must agree — and is
 * rejected; a `balanced: false` over agreeing totals is accepted,
 * because two unbalanced reports could cancel and the summary alone
 * cannot tell. Every failure throws `<prefix>: …`.
 */
function assertSettlementReportsSummaryConsistency(
  summary: SettlementReportsSummary,
  prefix: string,
): void {
  const fail = (reason: string): never => {
    throw new Error(`${prefix}: ${reason}`);
  };
  if (summary.total !== summary.reports + summary.errors) {
    fail(
      `total ${summary.total} does not equal reports ${summary.reports} plus errors ${summary.errors}`,
    );
  }
  const outcomeSum = SUMMARY_OUTCOME_ORDER.reduce(
    (sum, outcome) => sum + summary.outcomes[outcome],
    0,
  );
  if (outcomeSum !== summary.reports) {
    fail(
      `outcome counts sum to ${outcomeSum} but reports is ${summary.reports}`,
    );
  }
  let partyInflow = 0;
  let partyOutflow = 0;
  for (const party of summary.parties) {
    if (party.net !== round2(party.inflow - party.outflow)) {
      fail(
        `party ${party.party} net ${party.net} does not equal inflow ${party.inflow} minus outflow ${party.outflow}`,
      );
    }
    partyInflow = round2(partyInflow + party.inflow);
    partyOutflow = round2(partyOutflow + party.outflow);
  }
  if (partyInflow !== summary.totalInflow) {
    fail(
      `party inflows sum to ${partyInflow} but totalInflow is ${summary.totalInflow}`,
    );
  }
  if (partyOutflow !== summary.totalOutflow) {
    fail(
      `party outflows sum to ${partyOutflow} but totalOutflow is ${summary.totalOutflow}`,
    );
  }
  let bucketReports = 0;
  let bucketDeposit = 0;
  let bucketInflow = 0;
  let bucketOutflow = 0;
  let bucketRemaining = 0;
  for (const bucket of Object.values(summary.byCurrency)) {
    bucketReports += bucket.reports;
    bucketDeposit = round2(bucketDeposit + bucket.totalDeposit);
    bucketInflow = round2(bucketInflow + bucket.totalInflow);
    bucketOutflow = round2(bucketOutflow + bucket.totalOutflow);
    bucketRemaining = round2(bucketRemaining + bucket.totalRemaining);
  }
  if (bucketReports !== summary.reports) {
    fail(
      `currency buckets sum to ${bucketReports} reports but reports is ${summary.reports}`,
    );
  }
  if (bucketDeposit !== summary.totalDeposit) {
    fail(
      `currency buckets sum to totalDeposit ${bucketDeposit} but totalDeposit is ${summary.totalDeposit}`,
    );
  }
  if (bucketInflow !== summary.totalInflow) {
    fail(
      `currency buckets sum to totalInflow ${bucketInflow} but totalInflow is ${summary.totalInflow}`,
    );
  }
  if (bucketOutflow !== summary.totalOutflow) {
    fail(
      `currency buckets sum to totalOutflow ${bucketOutflow} but totalOutflow is ${summary.totalOutflow}`,
    );
  }
  if (bucketRemaining !== summary.totalRemaining) {
    fail(
      `currency buckets sum to totalRemaining ${bucketRemaining} but totalRemaining is ${summary.totalRemaining}`,
    );
  }
  if (summary.balanced && summary.totalInflow !== summary.totalOutflow) {
    fail(
      `balanced is true but totalInflow ${summary.totalInflow} does not equal totalOutflow ${summary.totalOutflow}: at least one successful report is unbalanced`,
    );
  }
}

/**
 * Shape plus self-consistency for a settlement-reports summary, in
 * either direction: the renderers apply it before emitting text, the
 * parsers apply it after reading text back, each under its own
 * direction prefix.
 */
function assertSettlementReportsSummary(
  summary: unknown,
  prefix: string,
): asserts summary is SettlementReportsSummary {
  assertSettlementReportsSummaryShape(summary, prefix);
  assertSettlementReportsSummaryConsistency(summary, prefix);
}

/**
 * Rebuild a summary in canonical key order: top-level fields in
 * declaration order, outcomes in fixed order, currency buckets
 * alphabetically by code. Party ledgers keep the caller's order (an
 * array's order is content, and the renderers never reorder it), and
 * every party is rebuilt as a fresh object so a rendered summary
 * never shares references with its input. A caller-built object may
 * list the keys in any order, but the rendered document is always the
 * same bytes for the same summary.
 */
function canonicalSettlementReportsSummary(
  summary: SettlementReportsSummary,
): SettlementReportsSummary {
  return {
    total: summary.total,
    reports: summary.reports,
    errors: summary.errors,
    outcomes: {
      released: summary.outcomes.released,
      refunded: summary.outcomes.refunded,
      expired: summary.outcomes.expired,
      "partially-released": summary.outcomes["partially-released"],
    },
    totalDeposit: summary.totalDeposit,
    totalInflow: summary.totalInflow,
    totalOutflow: summary.totalOutflow,
    totalRemaining: summary.totalRemaining,
    parties: summary.parties.map((party) => ({
      party: party.party,
      label: party.label,
      inflow: party.inflow,
      outflow: party.outflow,
      net: party.net,
    })),
    byCurrency: Object.fromEntries(
      Object.keys(summary.byCurrency)
        .sort()
        .map((code) => {
          const bucket = summary.byCurrency[code];
          return [
            code,
            {
              reports: bucket.reports,
              totalDeposit: bucket.totalDeposit,
              totalInflow: bucket.totalInflow,
              totalOutflow: bucket.totalOutflow,
              totalRemaining: bucket.totalRemaining,
            },
          ];
        }),
    ),
    balanced: summary.balanced,
  };
}

/**
 * Render a settlement-reports summary as CSV — the text form of the
 * batch position {@link summarizeSettlementReports} returns, for the
 * bookkeeping hop: a caller that exported a summary with this
 * function gets a table that pastes straight into a reconciliation
 * spreadsheet or a settlement statement, and that an auditor can file
 * next to the per-report CSVs without re-deriving a figure.
 *
 * Shape (lines joined by `\n`, no trailing newline):
 * - Header: `section,key,count,total,reports,errors,totalDeposit,totalInflow,totalOutflow,totalRemaining,net,balanced`.
 * - One `summary` row carrying the batch totals (`total`, `reports`,
 *   `errors`, the four money totals, `balanced`).
 * - Four `outcome` rows, one per outcome in fixed order
 *   (`released`, `refunded`, `expired`, `partially-released`), each
 *   carrying that outcome's report count.
 * - Four `party` rows in canonical role order (`sponsor`, `creator`,
 *   `platform`, `referrer`), each carrying that party's summed
 *   inflow/outflow/net over the batch.
 * - One `currency` row per `byCurrency` bucket, keys in alphabetical
 *   order (the `UNSPECIFIED` bucket sorts as the literal string it
 *   is, among the real codes), each carrying the bucket's report
 *   count and four money totals. A batch with no currency buckets
 *   (empty, or all-error) has no `currency` rows.
 *
 * Money is the same cent value the JSON form carries as a number,
 * spelled with exactly two decimals (`csvMoney`, the same spelling
 * `renderReportCsv` uses); counts are canonical integers; `balanced`
 * is `true` or `false`. Cells a row does not own are empty, so a
 * `party` row never carries a `totalDeposit` and an `outcome` row
 * never carries money.
 *
 * Before rendering, the summary is shape-checked and
 * self-consistency-checked with the shared check (see
 * {@link assertSettlementReportsSummary}): a non-object summary, a
 * missing or unknown field, a non-integer or unsafe-integer count, a
 * non-cent-exact money figure, a `total` that does not equal
 * `reports + errors`, outcome counts that do not sum to `reports`,
 * party ledgers whose inflow/outflow do not sum to the totals, a
 * party `net` that does not equal `inflow − outflow`, currency
 * buckets whose sums do not equal the top-level totals, or a
 * `balanced: true` over disagreeing totals all throw
 * `cannot render settlement reports summary as CSV: …` instead of
 * emitting a table that reads consistent but is not.
 *
 * Pure: the summary is only read, never mutated.
 */
export function renderSettlementReportsSummaryCsv(
  summary: SettlementReportsSummary,
): string {
  assertSettlementReportsSummary(
    summary,
    "cannot render settlement reports summary as CSV",
  );
  const lines: string[] = [SUMMARY_CSV_HEADER];
  lines.push(
    [
      csvField("summary"),
      csvField(""),
      "",
      String(summary.total),
      String(summary.reports),
      String(summary.errors),
      csvMoney(summary.totalDeposit),
      csvMoney(summary.totalInflow),
      csvMoney(summary.totalOutflow),
      csvMoney(summary.totalRemaining),
      "",
      summary.balanced ? "true" : "false",
    ].join(","),
  );
  for (const outcome of SUMMARY_OUTCOME_ORDER) {
    lines.push(
      [
        csvField("outcome"),
        csvField(outcome),
        String(summary.outcomes[outcome]),
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
      ].join(","),
    );
  }
  const partyByRole = new Map(summary.parties.map((p) => [p.party, p]));
  for (const role of SUMMARY_PARTY_ORDER) {
    const party = partyByRole.get(role)!;
    lines.push(
      [
        csvField("party"),
        csvField(role),
        "",
        "",
        "",
        "",
        "",
        csvMoney(party.inflow),
        csvMoney(party.outflow),
        "",
        csvMoney(party.net),
        "",
      ].join(","),
    );
  }
  for (const code of Object.keys(summary.byCurrency).sort()) {
    const bucket = summary.byCurrency[code];
    lines.push(
      [
        csvField("currency"),
        csvField(code),
        String(bucket.reports),
        "",
        "",
        "",
        csvMoney(bucket.totalDeposit),
        csvMoney(bucket.totalInflow),
        csvMoney(bucket.totalOutflow),
        csvMoney(bucket.totalRemaining),
        "",
        "",
      ].join(","),
    );
  }
  return lines.join("\n");
}

/**
 * Parse a settlement-reports summary back from CSV — the inverse of
 * {@link renderSettlementReportsSummaryCsv}, for the receiving end of
 * the bookkeeping hop: a caller that exported a summary with
 * `renderSettlementReportsSummaryCsv` gets the summary back without
 * hand-writing a parser for each row.
 *
 * The check is strict: the header must match exactly; there must be
 * exactly one `summary` row, four `outcome` rows in fixed order, four
 * `party` rows in canonical role order, then zero or more `currency`
 * rows in strictly alphabetical key order; every row must have exactly
 * 12 columns; cells a row does not own must be empty; every count
 * must be a canonical non-negative integer and every money figure a
 * two-decimal figure; every party's `net` must equal its
 * `inflow − outflow` at cent precision; and the whole table must
 * satisfy the shared self-consistency identities — `total` is
 * `reports + errors`, outcome counts sum to `reports`, party ledgers
 * sum to the top-level totals, currency buckets sum to the top-level
 * totals (`totalRemaining` included), and a `balanced: true` over
 * disagreeing totals is rejected. Any violation throws
 * `cannot parse settlement reports summary CSV: …` instead of
 * returning a plausible-looking half-summary. A UTF-8 byte-order mark
 * is a transport artifact, not a column, and is stripped; trailing
 * blank lines are line-ending noise, not extra rows; CRLF endings and
 * RFC 4180 quoted fields parse.
 *
 * Honest limit, shared with `renderSettlementReportsSummaryCsv`:
 * this is structural validation only. Importing a summary does not
 * re-verify the audit histories it claims to summarize — a hand-built
 * table with internally consistent rows parses, just as it would
 * render, and chain verification still belongs to
 * `verifyHistoryChain` over the escrows' own histories. The
 * `balanced` check is one-directional for the same reason: the table
 * can prove a `balanced: true` claim false (disagreeing totals), but
 * it cannot prove a `balanced: false` claim wrong (two unbalanced
 * reports could cancel), so only the first direction is enforced.
 *
 * Pure: the input string is only read, never mutated, and the
 * returned value is a fresh object graph (a second parse of the same
 * text yields an independent copy).
 */
export function parseSettlementReportsSummaryCsv(
  text: string,
): SettlementReportsSummary {
  if (typeof text !== "string") {
    throw new Error(
      "cannot parse settlement reports summary CSV: input must be a CSV string",
    );
  }
  const prefix = "cannot parse settlement reports summary CSV";
  // Column indices: 0 section, 1 key, 2 count, 3 total, 4 reports,
  // 5 errors, 6 totalDeposit, 7 totalInflow, 8 totalOutflow,
  // 9 totalRemaining, 10 net, 11 balanced.
  const records = parseCsvRecords(text.replace(/^\uFEFF/, ""), prefix);
  // Trailing blank lines are line-ending noise, not extra rows; a blank
  // record anywhere else changes the record count and fails below.
  while (records.length > 0) {
    const last = records[records.length - 1];
    if (last.length === 1 && last[0] === "") records.pop();
    else break;
  }
  const fail = (reason: string): never => {
    throw new Error(`${prefix}: ${reason}`);
  };
  const mustBeEmpty = (value: string, where: string): void => {
    if (value !== "")
      fail(`${where} must be empty, got ${JSON.stringify(value)}`);
  };
  if (records.length < 10) {
    fail(
      `expected at least 10 records (header + summary + 4 outcome rows + 4 party rows), got ${records.length}`,
    );
  }
  const header = records[0];
  if (header.join(",") !== SUMMARY_CSV_HEADER) {
    fail(`header must be exactly ${JSON.stringify(SUMMARY_CSV_HEADER)}`);
  }
  for (let i = 0; i < records.length; i += 1) {
    if (records[i].length !== 12)
      fail(`record ${i + 1} must have 12 columns, got ${records[i].length}`);
  }
  const summaryRow = records[1];
  if (summaryRow[0] !== "summary")
    fail(`record 2 section must be "summary", got ${JSON.stringify(summaryRow[0])}`);
  if (summaryRow[1] !== "")
    fail(`summary row key must be empty, got ${JSON.stringify(summaryRow[1])}`);
  mustBeEmpty(summaryRow[2], "summary row count");
  const total = parseSummaryCsvInteger(summaryRow[3], "summary row total");
  const reports = parseSummaryCsvInteger(summaryRow[4], "summary row reports");
  const errors = parseSummaryCsvInteger(summaryRow[5], "summary row errors");
  const totalDeposit = parseCsvMoney(summaryRow[6], "summary row totalDeposit", prefix);
  const totalInflow = parseCsvMoney(summaryRow[7], "summary row totalInflow", prefix);
  const totalOutflow = parseCsvMoney(summaryRow[8], "summary row totalOutflow", prefix);
  const totalRemaining = parseCsvMoney(summaryRow[9], "summary row totalRemaining", prefix);
  mustBeEmpty(summaryRow[10], "summary row net");
  if (summaryRow[11] !== "true" && summaryRow[11] !== "false")
    fail(`summary row balanced must be "true" or "false", got ${JSON.stringify(summaryRow[11])}`);
  const balanced = summaryRow[11] === "true";
  for (const [value, where] of [
    [totalDeposit, "summary row totalDeposit"],
    [totalInflow, "summary row totalInflow"],
    [totalOutflow, "summary row totalOutflow"],
    [totalRemaining, "summary row totalRemaining"],
  ] as const) {
    if (value < 0) fail(`${where} must not be negative, got ${value}`);
  }
  const outcomes = {} as Record<SettlementOutcome, number>;
  for (let r = 0; r < 4; r += 1) {
    const row = records[2 + r];
    const where = `outcome row ${r + 1}`;
    if (row[0] !== "outcome")
      fail(`${where} section must be "outcome", got ${JSON.stringify(row[0])}`);
    const outcome = SUMMARY_OUTCOME_ORDER[r];
    if (row[1] !== outcome)
      fail(`${where} key must be ${JSON.stringify(outcome)}, got ${JSON.stringify(row[1])}`);
    outcomes[outcome] = parseSummaryCsvInteger(row[2], `${where} count`);
    for (let c = 3; c < 12; c += 1)
      mustBeEmpty(row[c], `${where} column ${c + 1}`);
  }
  const parties: PartyLedger[] = [];
  for (let r = 0; r < 4; r += 1) {
    const row = records[6 + r];
    const where = `party row ${r + 1}`;
    if (row[0] !== "party")
      fail(`${where} section must be "party", got ${JSON.stringify(row[0])}`);
    const role = SUMMARY_PARTY_ORDER[r];
    if (row[1] !== role)
      fail(`${where} key must be ${JSON.stringify(role)}, got ${JSON.stringify(row[1])}`);
    for (const c of [2, 3, 4, 5, 6]) mustBeEmpty(row[c], `${where} column ${c + 1}`);
    const inflow = parseCsvMoney(row[7], `${where} totalInflow`, prefix);
    const outflow = parseCsvMoney(row[8], `${where} totalOutflow`, prefix);
    if (inflow < 0) fail(`${where} totalInflow must not be negative, got ${inflow}`);
    if (outflow < 0) fail(`${where} totalOutflow must not be negative, got ${outflow}`);
    mustBeEmpty(row[9], `${where} column 10`);
    const net = parseCsvMoney(row[10], `${where} net`, prefix);
    mustBeEmpty(row[11], `${where} column 12`);
    if (net !== round2(inflow - outflow)) {
      fail(
        `${where} net ${net} does not equal inflow ${inflow} minus outflow ${outflow}`,
      );
    }
    parties.push({ party: role, label: PARTY_LABELS[role], inflow, outflow, net });
  }
  const byCurrency: Record<string, SettlementCurrencySummary> = {};
  let prevCode: string | undefined;
  for (let r = 10; r < records.length; r += 1) {
    const row = records[r];
    const where = `currency row ${r - 9}`;
    if (row[0] !== "currency")
      fail(`${where} section must be "currency", got ${JSON.stringify(row[0])}`);
    const code = row[1];
    if (
      code !== UNSPECIFIED_SETTLEMENT_CURRENCY &&
      !ISO_4217_ALPHA3.test(code)
    )
      fail(
        `${where} key must be a 3-letter uppercase ISO 4217 code or ${JSON.stringify(UNSPECIFIED_SETTLEMENT_CURRENCY)}, got ${JSON.stringify(code)}`,
      );
    if (prevCode !== undefined && !(prevCode < code))
      fail(
        `${where} currency ${JSON.stringify(code)} must come after ${JSON.stringify(prevCode)} in alphabetical order`,
      );
    prevCode = code;
    const bucketReports = parseSummaryCsvInteger(row[2], `${where} count`);
    for (const c of [3, 4, 5]) mustBeEmpty(row[c], `${where} column ${c + 1}`);
    const bucketDeposit = parseCsvMoney(row[6], `${where} totalDeposit`, prefix);
    const bucketInflow = parseCsvMoney(row[7], `${where} totalInflow`, prefix);
    const bucketOutflow = parseCsvMoney(row[8], `${where} totalOutflow`, prefix);
    const bucketRemaining = parseCsvMoney(row[9], `${where} totalRemaining`, prefix);
    for (const [value, field] of [
      [bucketDeposit, "totalDeposit"],
      [bucketInflow, "totalInflow"],
      [bucketOutflow, "totalOutflow"],
      [bucketRemaining, "totalRemaining"],
    ] as const) {
      if (value < 0)
        fail(`${where} ${field} must not be negative, got ${value}`);
    }
    for (const c of [10, 11]) mustBeEmpty(row[c], `${where} column ${c + 1}`);
    byCurrency[code] = {
      reports: bucketReports,
      totalDeposit: bucketDeposit,
      totalInflow: bucketInflow,
      totalOutflow: bucketOutflow,
      totalRemaining: bucketRemaining,
    };
  }
  const summary: SettlementReportsSummary = {
    total,
    reports,
    errors,
    outcomes: {
      released: outcomes.released,
      refunded: outcomes.refunded,
      expired: outcomes.expired,
      "partially-released": outcomes["partially-released"],
    },
    totalDeposit,
    totalInflow,
    totalOutflow,
    totalRemaining,
    parties,
    byCurrency,
    balanced,
  };
  assertSettlementReportsSummary(summary, prefix);
  return summary;
}

/**
 * Render a settlement-reports summary as JSON — the text form for the
 * API/storage hop: a caller that stored a summary with this function
 * gets a document whose fields are numbers, not strings, so a
 * consumer parsing it gets `31890`, not `"31890.00"` — the one
 * deliberate difference from CSV, where the same cent value is
 * spelled with exactly two decimals. The fields are written in
 * canonical key order (top-level fields in declaration order,
 * outcomes in fixed order, currency buckets alphabetically), so
 * rendering the same summary twice is byte-identical.
 *
 * Before rendering, the summary is shape-checked and
 * self-consistency-checked with the shared check (see
 * {@link assertSettlementReportsSummary}): a malformed object never
 * becomes a plausible-looking JSON document — `JSON.stringify` turns
 * `Infinity`/`NaN` into `null` without complaint, so a non-finite
 * figure would otherwise leave this function as a plausible-looking
 * `null` and corrupt a downstream import.
 *
 * Pure: the summary is only read, never mutated.
 */
export function renderSettlementReportsSummaryJson(
  summary: SettlementReportsSummary,
): string {
  assertSettlementReportsSummary(
    summary,
    "cannot render settlement reports summary as JSON",
  );
  return JSON.stringify(canonicalSettlementReportsSummary(summary));
}

/**
 * Parse a settlement-reports summary back from JSON — the inverse of
 * {@link renderSettlementReportsSummaryJson}, for the receiving end of
 * the API/storage hop: a caller that stored a summary with
 * `renderSettlementReportsSummaryJson` gets a typed summary back
 * without hand-writing a parser for each field.
 *
 * The check is exactly the shape check
 * `renderSettlementReportsSummaryJson` applies, in the other
 * direction: unparseable text, a JSON value that is not a summary
 * object, a missing or unknown field, a non-integer or unsafe-integer
 * count (including `null`, which is what a non-finite figure becomes
 * after a plain `JSON.stringify`, and `1e999`, which `JSON.parse`
 * reads as `Infinity`), a non-cent-exact money figure, a `total`
 * that does not equal `reports + errors`, outcome counts that do not
 * sum to `reports`, party ledgers whose sums disagree with the
 * totals, currency buckets whose sums disagree with the top-level
 * totals, or a `balanced: true` over disagreeing totals all throw
 * `cannot parse settlement reports summary JSON: …` instead of
 * returning a plausible-looking half-summary. A parsed summary
 * re-renders byte-identically through
 * `renderSettlementReportsSummaryJson`.
 *
 * Honest limit, shared with `renderSettlementReportsSummaryJson`:
 * this is structural validation only. Importing a summary does not
 * re-verify the audit histories it claims to summarize — a hand-built
 * document with internally consistent fields passes, just as it would
 * serialize. Chain verification still belongs to `verifyHistoryChain`
 * over the escrows' own histories, not to this import.
 *
 * Pure: the input string is only read, never mutated, and the
 * returned summary is a fresh object graph (a second parse of the
 * same text yields an independent copy).
 */
export function parseSettlementReportsSummaryJson(
  text: string,
): SettlementReportsSummary {
  if (typeof text !== "string")
    throw new Error(
      "cannot parse settlement reports summary JSON: input must be a JSON string",
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `cannot parse settlement reports summary JSON: invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  assertSettlementReportsSummary(
    parsed,
    "cannot parse settlement reports summary JSON",
  );
  return canonicalSettlementReportsSummary(parsed);
}

/**
 * Spell one summary money figure with exactly two decimals, via
 * {@link formatMinorUnits}: summary figures are cent-exact floats in
 * the reports' currency units, so the ×100 step converts them to
 * integer minor units and `Math.round` absorbs the binary-float
 * residue of that step (`0.29 * 100` is `28.999…`, which rounds back
 * to `29`). The spelling therefore matches `csvMoney` exactly —
 * `1234.56` here is `1234.56` in the CSV — while staying free of
 * locale-dependent separators, so the same summary always renders
 * the same bytes.
 *
 * Fail-closed limit: a figure whose minor units leave the safe
 * integer range (roughly ±9e13 in currency units, where one cent is
 * smaller than a float step) cannot be spelled exactly, so it throws
 * with the render prefix instead of printing a rounded-off figure.
 * Realistic settlement batches are far below that bound; the CSV
 * renderer stays the escape hatch for astronomical hand-built
 * summaries.
 */
function summaryMoney(n: number): string {
  const minor = Math.round(n * 100);
  if (!Number.isSafeInteger(minor)) {
    throw new Error(
      `cannot render settlement reports summary: amount ${n} is outside the safely renderable range`,
    );
  }
  return formatMinorUnits(minor);
}

/**
 * Render a settlement-reports summary as plain human-readable text —
 * the form for a log line or a terminal paste during reconciliation:
 * a caller that wants to eyeball a batch's position no longer has to
 * hand-build the string or paste a JSON document into a chat.
 *
 * The layout follows the dataquest-side `renderTaskSettlements`
 * (backlog #1096) and this file's single-report {@link renderReport}:
 * a title line, a counts line, the four outcome rows in fixed order,
 * the four money lines, one row per party in canonical role order,
 * one row per currency bucket in alphabetical order, a `balanced`
 * line, and a units line, in that fixed order — so the same summary
 * always renders the same bytes, and a reader scanning two batches
 * can compare line by line:
 *
 * ```text
 * Settlement reports summary
 * Reports: 3 (errors: 1)
 * Released: 1
 * Refunded: 1
 * Expired: 0
 * Partially-released: 1
 * Total deposit: 31890.00
 * Total inflow: 31890.00
 * Total outflow: 31890.00
 * Total remaining: 6378.00
 * Sponsor (depositor): inflow 17008.00, outflow 31890.00, net -14882.00
 * Creator (payee): inflow 14137.90, outflow 0.00, net 14137.90
 * Platform (pro fee): inflow 744.10, outflow 0.00, net 744.10
 * Referrer (referral credits): inflow 0.00, outflow 0.00, net 0.00
 * EUR: 1 report, deposit 10630.00, inflow 10630.00, outflow 10630.00, remaining 0.00
 * USD: 2 reports, deposit 21260.00, inflow 21260.00, outflow 21260.00, remaining 6378.00
 * Balanced: true
 * Amounts are in the reports' currency units, shown with two decimals; top-level totals sum figures across currencies — read the per-currency rows for single-currency money.
 * ```
 *
 * The counts, outcome, money, party, and `balanced` rows are always
 * present, even when zero, so a zero batch reads as an explicit
 * all-zero position rather than a missing section. Currency rows
 * appear only for buckets the summary actually carries — an empty or
 * all-error batch has none, mirroring the CSV renderer.
 *
 * Before rendering, the summary is shape-checked and
 * self-consistency-checked with the shared check (see
 * {@link assertSettlementReportsSummary}): a non-object summary, a
 * missing or unknown field, a non-integer or unsafe-integer count, a
 * non-cent-exact money figure, a `total` that does not equal
 * `reports + errors`, outcome counts that do not sum to `reports`,
 * party ledgers whose inflow/outflow do not sum to the totals, a
 * party `net` that does not equal `inflow − outflow`, currency
 * buckets whose sums do not equal the top-level totals, or a
 * `balanced: true` over disagreeing totals all throw
 * `cannot render settlement reports summary: …` instead of emitting
 * a document that reads consistent but is not.
 *
 * Honest limit, shared with the CSV/JSON renderers but stronger
 * here: this is a display form, not an interchange form. There is no
 * parser back — the CSV and JSON renderers are the round-trippable
 * text forms — and reading figures off this text does not re-verify
 * the audit histories the summary claims to summarize. The units
 * line says so in the output itself: the top-level totals sum raw
 * figures across currencies, so a mixed-currency batch must be read
 * bucket by bucket.
 *
 * Pure: the summary is only read, never mutated.
 */
export function renderSettlementReportsSummary(
  summary: SettlementReportsSummary,
): string {
  assertSettlementReportsSummary(
    summary,
    "cannot render settlement reports summary",
  );
  const lines: string[] = [
    "Settlement reports summary",
    `Reports: ${summary.reports} (errors: ${summary.errors})`,
  ];
  for (const outcome of SUMMARY_OUTCOME_ORDER) {
    const label =
      outcome === "partially-released"
        ? "Partially-released"
        : outcome[0].toUpperCase() + outcome.slice(1);
    lines.push(`${label}: ${summary.outcomes[outcome]}`);
  }
  lines.push(
    `Total deposit: ${summaryMoney(summary.totalDeposit)}`,
    `Total inflow: ${summaryMoney(summary.totalInflow)}`,
    `Total outflow: ${summaryMoney(summary.totalOutflow)}`,
    `Total remaining: ${summaryMoney(summary.totalRemaining)}`,
  );
  const partyByRole = new Map(summary.parties.map((p) => [p.party, p]));
  for (const role of SUMMARY_PARTY_ORDER) {
    const party = partyByRole.get(role)!;
    lines.push(
      `${party.label}: inflow ${summaryMoney(party.inflow)}, outflow ${summaryMoney(party.outflow)}, net ${summaryMoney(party.net)}`,
    );
  }
  for (const code of Object.keys(summary.byCurrency).sort()) {
    const bucket = summary.byCurrency[code];
    lines.push(
      `${code}: ${bucket.reports} ${bucket.reports === 1 ? "report" : "reports"}, deposit ${summaryMoney(bucket.totalDeposit)}, inflow ${summaryMoney(bucket.totalInflow)}, outflow ${summaryMoney(bucket.totalOutflow)}, remaining ${summaryMoney(bucket.totalRemaining)}`,
    );
  }
  lines.push(
    `Balanced: ${summary.balanced ? "true" : "false"}`,
    "Amounts are in the reports' currency units, shown with two decimals; top-level totals sum figures across currencies — read the per-currency rows for single-currency money.",
  );
  return lines.join("\n");
}
