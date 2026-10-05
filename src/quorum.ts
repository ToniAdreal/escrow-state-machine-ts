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
}

export interface Quorum {
  readonly threshold: number;
  readonly signerCount: number;
  /** Record an approval. Idempotent: re-approving the same signer is a no-op. */
  approve(signerId: string): void;
  /** True once threshold distinct approvals have been recorded. */
  hasQuorum(): boolean;
  /** Number of distinct approvals recorded so far. */
  approvalCount(): number;
  /** Signer ids that have approved, in approval order. */
  approvals(): readonly string[];
}

function assertValidConfig({ threshold, signers }: QuorumConfig): void {
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
}

export function createQuorum(config: QuorumConfig): Quorum {
  assertValidConfig(config);
  const { threshold } = config;
  const signers = new Set<string>(config.signers);
  const approvals: string[] = [];
  const approved = new Set<string>();

  return {
    threshold,
    signerCount: signers.size,
    approve(signerId: string): void {
      if (!signers.has(signerId))
        throw new Error(`unknown quorum signer: ${JSON.stringify(signerId)}`);
      if (approved.has(signerId)) return; // idempotent — no double counting
      approved.add(signerId);
      approvals.push(signerId);
    },
    hasQuorum(): boolean {
      return approved.size >= threshold;
    },
    approvalCount(): number {
      return approved.size;
    },
    approvals(): readonly string[] {
      return [...approvals];
    },
  };
}
