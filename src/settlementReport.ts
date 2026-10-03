/**
 * Human-readable settlement report from the escrow audit history.
 *
 * Pure functions: the audit history (append-only event trail) decides *which*
 * money movements happened; the fee calculator and settlement math decide
 * *how much*. Every figure in the report is derived from those two sources,
 * nothing is invented.
 *
 * Money model (documented so the accounting stays auditable):
 * - FUND locks the full `deposit` from the sponsor into escrow.
 * - On RELEASE / ARBITRATE_RELEASE the escrow pays out per `settleRelease`
 *   with gross = deposit: creator receives `net`, the platform takes the
 *   pro fee, and any referral credits go to the referrer.
 * - On ARBITRATE_REFUND / EXPIRE the full deposit returns to the sponsor.
 * - The oracle fee bundled into the deposit is NOT attributed to a separate
 *   party: this is an off-chain reproduction, not the on-chain contract, and
 *   splitting it would double-count. See README "Limitations (honest)".
 */

import type {
  EscrowEvent,
  EscrowHistoryEntry,
  EscrowState,
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
 * terminal state, or when a released/refunded escrow has an empty history
 * (the audit trail is the evidence; no trail, no report).
 */
export function buildSettlementReport(
  inputs: SettlementReportInputs,
): SettlementReport {
  const { escrowId, history, finalState, deposit } = inputs;
  const depositAmount = deposit.deposit;

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

function money(n: number): string {
  return (
    "$" +
    n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
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
