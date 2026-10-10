/**
 * M-of-N approval quorum — the counting rule behind multi-sig arbitration
 * (e.g. the ALLWEB3 case study's 5/9 DAO multi-sig).
 *
 * This is deliberately off-chain: it models *who has approved*, not
 * signature verification or on-chain governance. Use it as a caller-side
 * pre-check before dispatching the arbitration events on the state machine:
 *
 * ```ts
 * import { createQuorum } from "./quorum.js";
 * import { Escrow } from "./index.js";
 *
 * const quorum = createQuorum({
 *   threshold: 5,
 *   signers: ["dao-1", "dao-2", "dao-3", "dao-4", "dao-5",
 *             "dao-6", "dao-7", "dao-8", "dao-9"],
 * });
 *
 * // collect off-chain approvals …
 * quorum.approve("dao-3");
 *
 * if (quorum.hasQuorum()) {
 *   escrow.dispatch("ARBITRATE_RELEASE", "5/9 DAO quorum reached");
 * }
 * ```
 */

export interface QuorumConfig {
  /** Approvals required, 1 ≤ threshold ≤ signers.length */
  threshold: number;
  /** Unique signer identifiers; order is not significant */
  signers: readonly string[];
  /**
   * Clock for approval timestamps, in milliseconds since the Unix epoch.
   * Defaults to `Date.now`. Inject a fixed sequence in tests for
   * deterministic audit logs.
   */
  now?: () => number;
  /**
   * Optional approval expiry window, in milliseconds. When set, the
   * counting views (`hasQuorum` / `approvalCount` / `approvals`) only
   * count an approval while its age — measured on the `now` clock — is
   * at most this window (the boundary is inclusive, matching this repo's
   * other freshness windows: an approval exactly `maxApprovalAgeMs` old
   * still counts). Expiry never deletes anything: `approvalLog()` keeps
   * the full audit trail including expired entries. An expired signer
   * can `approve()` again, which records a fresh timestamp (appended to
   * the log) and restores their count. A clock reading earlier than an
   * approval's timestamp yields a negative age, which counts as fresh.
   * When unset, approvals never expire (the historical behavior).
   */
  maxApprovalAgeMs?: number;
}

/** One entry of a quorum's approval audit trail. */
export interface ApprovalLogEntry {
  /** Signer that approved. */
  readonly signerId: string;
  /** Canonical ISO-8601 timestamp of when the approval was recorded. */
  readonly at: string;
}

export interface Quorum {
  readonly threshold: number;
  readonly signerCount: number;
  /**
   * Record an approval. Idempotent while the signer's current approval
   * still counts: re-approving is a no-op. If the signer's approval has
   * expired (see `maxApprovalAgeMs`), approving again appends a fresh
   * log entry with a new timestamp and the signer counts again.
   */
  approve(signerId: string): void;
  /**
   * Withdraw a previously recorded approval (real multi-sigs let signers
   * change their vote before the threshold is reached). Throws for unknown
   * signers, and for signers that have not approved — revoking a vote that
   * was never cast is a caller error, not a no-op. Revoking an *expired*
   * approval is allowed and behaves the same: all of the signer's log
   * entries are removed, exactly as for a live approval.
   */
  revoke(signerId: string): void;
  /**
   * True once threshold distinct *counted* approvals exist. With
   * `maxApprovalAgeMs` set, expired approvals do not count.
   */
  hasQuorum(): boolean;
  /** Number of distinct counted approvals (expired ones excluded). */
  approvalCount(): number;
  /**
   * Signer ids whose approvals currently count, ordered by each signer's
   * latest approval. Expired approvals are excluded.
   */
  approvals(): readonly string[];
  /**
   * Approval audit trail: who approved and when, in record order.
   * Returns a detached copy — mutating it cannot alter the quorum.
   * Unlike the counting views, the log never expires: expired approvals
   * stay in the trail. Revoking a signer removes all of its entries; a
   * later re-approval records a fresh timestamp.
   */
  approvalLog(): ReadonlyArray<ApprovalLogEntry>;
}

function assertValidConfig({
  threshold,
  signers,
  now,
  maxApprovalAgeMs,
}: QuorumConfig): void {
  if (!Array.isArray(signers) || signers.length === 0)
    throw new Error("quorum signers must be a non-empty array");
  const seen = new Set<string>();
  for (const s of signers) {
    if (typeof s !== "string" || s.length === 0)
      throw new Error("quorum signer ids must be non-empty strings");
    if (seen.has(s))
      throw new Error(`quorum signer id duplicated: ${JSON.stringify(s)}`);
    seen.add(s);
  }
  if (!Number.isInteger(threshold) || threshold < 1)
    throw new Error("quorum threshold must be an integer ≥ 1");
  if (threshold > signers.length)
    throw new Error(
      `quorum threshold ${threshold} exceeds signer count ${signers.length}`
    );
  if (now !== undefined && typeof now !== "function")
    throw new Error("quorum now must be a function returning milliseconds");
  if (
    maxApprovalAgeMs !== undefined &&
    (typeof maxApprovalAgeMs !== "number" ||
      !Number.isFinite(maxApprovalAgeMs) ||
      maxApprovalAgeMs <= 0)
  )
    throw new Error("quorum maxApprovalAgeMs must be a positive finite number");
}

interface TimedApproval {
  readonly signerId: string;
  readonly atMs: number;
}

export function createQuorum(config: QuorumConfig): Quorum {
  assertValidConfig(config);
  const { threshold } = config;
  const signers = new Set<string>(config.signers);
  const now = config.now ?? Date.now;
  const maxAge = config.maxApprovalAgeMs;
  // Full audit trail, in record order. Entries are never removed by
  // expiry — only by revoke(). A signer can appear more than once when
  // it re-approves after its previous approval expired; counting always
  // uses the signer's *latest* entry.
  const log: TimedApproval[] = [];

  const latestBySigner = (): Map<string, TimedApproval> => {
    const latest = new Map<string, TimedApproval>();
    for (const e of log) latest.set(e.signerId, e);
    return latest;
  };
  const isCounted = (e: TimedApproval): boolean =>
    maxAge === undefined || now() - e.atMs <= maxAge;
  const countedApprovals = (): TimedApproval[] => {
    const latest = latestBySigner();
    // Log order of each signer's latest entry (a re-approval after
    // expiry moves the signer to the position of its fresh entry).
    return log.filter((e) => latest.get(e.signerId) === e && isCounted(e));
  };

  return {
    threshold,
    signerCount: signers.size,
    approve(signerId: string): void {
      if (!signers.has(signerId))
        throw new Error(`unknown quorum signer: ${JSON.stringify(signerId)}`);
      const current = latestBySigner().get(signerId);
      if (current !== undefined && isCounted(current)) return; // still counts — no-op
      log.push({ signerId, atMs: now() });
    },
    revoke(signerId: string): void {
      if (!signers.has(signerId))
        throw new Error(`unknown quorum signer: ${JSON.stringify(signerId)}`);
      // Expired approvals can be revoked too: any recorded entry counts
      // as "has approved" here, even one that no longer counts toward
      // the threshold. Revoking removes all of the signer's entries.
      if (!log.some((e) => e.signerId === signerId))
        throw new Error(
          `cannot revoke: signer ${JSON.stringify(
            signerId
          )} has not approved`
        );
      for (let i = log.length - 1; i >= 0; i--)
        if (log[i].signerId === signerId) log.splice(i, 1);
    },
    hasQuorum(): boolean {
      return countedApprovals().length >= threshold;
    },
    approvalCount(): number {
      return countedApprovals().length;
    },
    approvals(): readonly string[] {
      return countedApprovals().map((e) => e.signerId);
    },
    approvalLog(): ReadonlyArray<ApprovalLogEntry> {
      return log.map((e) => ({
        signerId: e.signerId,
        at: new Date(e.atMs).toISOString(),
      }));
    },
  };
}
