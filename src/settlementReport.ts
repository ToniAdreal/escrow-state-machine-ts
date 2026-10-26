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
 * - On ARBITRATE_REFUND / EXPIRE the full deposit returns to the sponsor.
 * - The oracle fee bundled into the deposit is NOT attributed to a separate
 *   party: this is an off-chain reproduction, not the on-chain contract, and
 *   splitting it would double-count. See README "Limitations (honest)".
 */

import {
  type EscrowEvent,
  type EscrowHistoryEntry,
  type EscrowState,
  verifyHistoryChain,
} from "./stateMachine.js";
import type { FeeBreakdown } from "./feeCalculator.js";
import { settleRelease, type Settlement } from "./settlement.js";

export type SettlementOutcome = "released" | "refunded" | "expired";

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

export interface SettlementReportInputs {
  escrowId: string;
  /** Append-only audit history, in seq order. */
  history: readonly EscrowHistoryEntry[];
  finalState: EscrowState;
  deposit: FeeBreakdown;
  /**
   * Settlement parameters; used only when the outcome is `released`.
   * `gross` is ignored and always taken from `deposit.deposit`, so the
   * report can never disagree with the locked deposit.
   */
  settlement?: { proFeeBps: number; referralCredits?: number };
}

export interface SettlementReport {
  escrowId: string;
  outcome: SettlementOutcome;
  /** e.g. "VERIFY_PASS → RELEASE" for released, undefined otherwise */
  releasePath?: string;
  deposit: FeeBreakdown;
  /** Present only for the `released` outcome. */
  settlement?: Settlement;
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
 * money the trail never saw).
 */
export function buildSettlementReport(
  inputs: SettlementReportInputs,
): SettlementReport {
  const { escrowId, history, finalState, deposit } = inputs;
  const depositAmount = deposit.deposit;

  // The audit history is the sole evidence for every figure below, so it
  // must be integrity-checked before any money math runs: an attacker who
  // rewrote an amount, edited a note, deleted an entry, or reordered the
  // trail could otherwise make a clean-looking report out of a tampered
  // history. A fully hashless history is legacy and passes through (nothing
  // to verify), while a mix of chained and hashless entries is rejected —
  // exactly the semantics of verifyHistoryChain, aligned with the snapshot
  // parser's rules.
  if (!verifyHistoryChain(history)) {
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

  const base = {
    escrowId,
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
 * order, each carrying the input's `escrowId`.
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
 * Pure: the results array and the reports inside it are only read.
 */
export function summarizeSettlementReports(
  results: readonly SettlementReportResult[],
): SettlementReportsSummary {
  const outcomes: Record<SettlementOutcome, number> = {
    released: 0,
    refunded: 0,
    expired: 0,
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
    for (const party of report.parties) {
      const sum = partySums.get(party.party);
      if (sum) {
        sum.inflow += party.inflow;
        sum.outflow += party.outflow;
      }
    }
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
    balanced,
  };
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
 * three outcomes); for a hand-built CSV it is simply the `TOTAL` outflow
 * figure, not an independently verified deposit.
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
  if (outcome !== "released" && outcome !== "refunded" && outcome !== "expired") {
    fail('outcome must be "released", "refunded", or "expired"');
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
  if (r.outcome !== "released" && r.outcome !== "refunded" && r.outcome !== "expired")
    fail('outcome must be "released", "refunded", or "expired"');
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
 * the four party ledgers, totals, balanced flag, and audit window) with
 * no field added, renamed, or dropped.
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
  return lines.join("\n");
}
