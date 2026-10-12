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

/**
 * Serializable snapshot of a quorum, produced by {@link Quorum.snapshot}
 * and consumed by {@link restoreQuorum}. Plain JSON data: persist it
 * with `JSON.stringify` before a restart and `JSON.parse` it back at
 * startup so collected approvals survive the process.
 *
 * The snapshot carries the full approval audit trail (every log entry,
 * including expired and superseded ones — exactly what
 * `approvalLog()` returns), plus the configuration the entries were
 * collected under (`threshold`, `signers`, and `maxApprovalAgeMs` when
 * set), so a restore can refuse a snapshot that does not match the
 * configuration it is being restored into instead of silently changing
 * the counting rule mid-arbitration.
 *
 * Honest scope: a snapshot is an export format, not a built-in store,
 * and approvals in it are still unsigned caller assertions — restoring
 * one adds no signature verification (see the module header).
 */
export interface QuorumSnapshot {
  /** Snapshot schema version; only `1` exists. */
  v: 1;
  /** Threshold the approvals were collected under. */
  threshold: number;
  /** Signer ids the approvals were collected under, in config order. */
  signers: string[];
  /**
   * Expiry window the approvals were collected under. Present only
   * when the source quorum was configured with `maxApprovalAgeMs`
   * (mirroring this repo's optional snapshot fields: a quorum without
   * a window keeps the exact legacy-free shape without the key).
   */
  maxApprovalAgeMs?: number;
  /** Full approval audit trail, in record order. */
  approvals: ApprovalLogEntry[];
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
  /**
   * Export the quorum's full state as a detached, JSON-serializable
   * {@link QuorumSnapshot}: the configuration the approvals were
   * collected under plus the complete approval audit trail (expired
   * and superseded entries included, with their original timestamps —
   * exporting never refreshes an approval's age). Mutating the
   * returned object cannot alter the quorum. Restore it after a
   * restart with {@link restoreQuorum}.
   */
  snapshot(): QuorumSnapshot;
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

function buildQuorum(
  config: QuorumConfig,
  initialLog: readonly TimedApproval[]
): Quorum {
  assertValidConfig(config);
  const { threshold } = config;
  const signerList = [...config.signers];
  const signers = new Set<string>(signerList);
  const now = config.now ?? Date.now;
  const maxAge = config.maxApprovalAgeMs;
  // Full audit trail, in record order. Entries are never removed by
  // expiry — only by revoke(). A signer can appear more than once when
  // it re-approves after its previous approval expired; counting always
  // uses the signer's *latest* entry.
  const log: TimedApproval[] = [...initialLog];

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
    snapshot(): QuorumSnapshot {
      return {
        v: 1,
        threshold,
        signers: [...signerList],
        ...(maxAge !== undefined ? { maxApprovalAgeMs: maxAge } : {}),
        approvals: log.map((e) => ({
          signerId: e.signerId,
          at: new Date(e.atMs).toISOString(),
        })),
      };
    },
  };
}

export function createQuorum(config: QuorumConfig): Quorum {
  return buildQuorum(config, []);
}

function isCanonicalIso(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const ms = Date.parse(s);
  return !Number.isNaN(ms) && new Date(ms).toISOString() === s;
}

const QUORUM_SNAPSHOT_FIELDS = new Set([
  "v",
  "threshold",
  "signers",
  "maxApprovalAgeMs",
  "approvals",
]);

/**
 * Rebuild a quorum from a {@link QuorumSnapshot} produced by
 * `snapshot()` (typically after a `JSON.parse` of the persisted form),
 * restoring it under `config` — pass the same configuration the
 * snapshot was taken from; the restored quorum keeps counting on
 * `config.now` / `config.maxApprovalAgeMs`.
 *
 * The snapshot is untrusted data and is validated strictly; every
 * problem throws `invalid quorum snapshot: …`:
 *  - not a plain object, an unknown top-level field, or `v` other
 *    than `1`
 *  - `threshold`, the `signers` set, or `maxApprovalAgeMs` differing
 *    from `config` (restoring under a different counting rule would
 *    silently re-interpret approvals collected under another one)
 *  - an approval entry that is not exactly `{ signerId, at }`, names
 *    an unknown signer, carries a non-canonical-ISO timestamp, is an
 *    exact duplicate of an earlier entry (same signer, same
 *    timestamp), or is out of record order (timestamps must be
 *    non-decreasing, the same bar this repo's snapshot parsers set)
 *
 * A signer may legitimately appear several times with *different*
 * timestamps (re-approval after expiry appends a fresh entry), so
 * only exact duplicates are rejected. Expiry keeps counting from each
 * entry's original timestamp: restoring never refreshes an approval's
 * age, so an approval that had expired when the snapshot was taken is
 * still expired after the restore.
 */
export function restoreQuorum(
  config: QuorumConfig,
  snapshot: unknown
): Quorum {
  assertValidConfig(config);
  const fail = (detail: string): never => {
    throw new Error(`invalid quorum snapshot: ${detail}`);
  };
  if (
    typeof snapshot !== "object" ||
    snapshot === null ||
    Array.isArray(snapshot)
  )
    fail("expected a JSON object");
  const record = snapshot as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!QUORUM_SNAPSHOT_FIELDS.has(key))
      fail(`unknown field ${JSON.stringify(key)}`);
  }
  if (record.v !== 1)
    fail(
      `unsupported snapshot version ${String(record.v)} (expected 1)`
    );
  if (record.threshold !== config.threshold)
    fail(
      `threshold ${String(record.threshold)} does not match config threshold ${config.threshold}`
    );
  if (!Array.isArray(record.signers))
    fail("signers must be an array of signer ids");
  const snapshotSigners = record.signers as unknown[];
  const snapshotSignerSet = new Set<string>();
  for (const s of snapshotSigners) {
    if (typeof s !== "string" || s.length === 0)
      fail("signers entries must be non-empty strings");
    const signer = s as string;
    if (snapshotSignerSet.has(signer))
      fail(`signer id duplicated: ${JSON.stringify(signer)}`);
    snapshotSignerSet.add(signer);
  }
  const configSignerSet = new Set<string>(config.signers);
  if (
    snapshotSignerSet.size !== configSignerSet.size ||
    [...snapshotSignerSet].some((s) => !configSignerSet.has(s))
  )
    fail("signers do not match config signers");
  if (record.maxApprovalAgeMs !== config.maxApprovalAgeMs)
    fail(
      `maxApprovalAgeMs ${String(record.maxApprovalAgeMs)} does not match config maxApprovalAgeMs ${String(config.maxApprovalAgeMs)}`
    );
  if (!Array.isArray(record.approvals)) fail("approvals must be an array");
  const rawApprovals = record.approvals as unknown[];
  const entries: TimedApproval[] = [];
  const seenPairs = new Set<string>();
  let prevMs = -Infinity;
  for (let i = 0; i < rawApprovals.length; i++) {
    const raw = rawApprovals[i];
    const tag = `approvals[${i}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      fail(`${tag} must be an object { signerId, at }`);
    const entry = raw as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (key !== "signerId" && key !== "at")
        fail(`${tag}: unknown field ${JSON.stringify(key)}`);
    }
    if (typeof entry.signerId !== "string" || entry.signerId.length === 0)
      fail(`${tag}: signerId must be a non-empty string`);
    const signerId = entry.signerId as string;
    if (!configSignerSet.has(signerId))
      fail(`${tag}: unknown signer ${JSON.stringify(signerId)}`);
    if (!isCanonicalIso(entry.at))
      fail(
        `${tag}: at must be canonical ISO-8601, got ${String(entry.at)}`
      );
    const at = entry.at as string;
    const atMs = Date.parse(at);
    const pairKey = `${signerId}\u0000${at}`;
    if (seenPairs.has(pairKey))
      fail(`${tag}: duplicate approval entry for signer ${JSON.stringify(signerId)} at ${at}`);
    seenPairs.add(pairKey);
    if (atMs < prevMs)
      fail(`${tag}: approvals must be in non-decreasing timestamp order`);
    prevMs = atMs;
    entries.push({ signerId, atMs });
  }
  return buildQuorum(config, entries);
}
