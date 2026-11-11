/**
 * M-of-N approval quorum — the counting rule behind multi-sig arbitration
 * (e.g. the ALLWEB3 case study's 5/9 DAO multi-sig).
 *
 * This is deliberately off-chain: it models *who has approved*, not
 * on-chain governance. By default an approval is a caller-trust claim:
 * `approve()` records that a signer id approved, with no cryptography
 * behind it. Opt in to signature verification by registering Ed25519
 * public keys in `QuorumConfig.signerPublicKeys` and collecting votes
 * with `approveSigned()`: each vote is verified against the canonical
 * approval statement `escrow-quorum:approve:<signerId>` and the log
 * entry is marked `verified: true`. Plain `approve()` entries stay
 * unverified claims — the two kinds count identically toward the
 * threshold, and the log always shows which is which. To act on the
 * count, gate the arbitration dispatch through `dispatchArbitration`
 * (src/arbitration.ts) — it refuses to dispatch until `hasQuorum()` is
 * true and leaves the escrow untouched otherwise, so a caller can never
 * skip the gate by forgetting the check:
 *
 * ```ts
 * import { createQuorum } from "./quorum.js";
 * import { dispatchArbitration } from "./arbitration.js";
 * import { Escrow } from "./index.js";
 *
 * const quorum = createQuorum({
 *   threshold: 5,
 *   signers: ["dao-1", "dao-2", "dao-3", "dao-4", "dao-5",
 *             "dao-6", "dao-7", "dao-8", "dao-9"],
 * });
 * const escrow = new Escrow("esc-1");
 * escrow.dispatch("FUND", undefined, 10630);
 * escrow.dispatch("DISPUTE");
 *
 * // collect off-chain approvals …
 * quorum.approve("dao-3");
 *
 * // Below the threshold this throws
 * // `arbitration requires quorum: 1/5 approvals` and the escrow stays
 * // DISPUTED; once reached it dispatches ARBITRATE_RELEASE (or
 * // ARBITRATE_REFUND for outcome "refund") and returns the new state.
 * dispatchArbitration(escrow, quorum, "release");
 * ```
 *
 * `hasQuorum()` / `approvalCount()` stay available for read-only
 * pre-checks (UI gating, logging) where no dispatch is intended — but
 * they are not a substitute for the gate when dispatching.
 */

import { KeyObject, verify } from "node:crypto";
import { MAX_ACTOR_LENGTH, MAX_EVIDENCE_LENGTH } from "./stateMachine.js";

export interface QuorumConfig {
  /** Approvals required, 1 ≤ threshold ≤ signers.length */
  threshold: number;
  /**
   * Unique signer identifiers; order is not significant. Each id is
   * capped at {@link MAX_ACTOR_LENGTH} characters (256): unlike a
   * `RolePolicy` name — configuration that is never written into any
   * history — a signer id is stamped verbatim onto every approval
   * log entry and snapshot that carries it, so it is audit data and
   * the actor-cap logic applies (see `MAX_ACTOR_LENGTH` in
   * `src/stateMachine.ts` for the full reasoning). The same cap is
   * enforced when a snapshot is restored, because a snapshot's
   * signers must match this configuration.
   */
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
  /**
   * Optional Ed25519 public keys for signature-verified approvals,
   * keyed by signer id. Only signers listed here can use
   * `approveSigned()`; a signer without a registered key can only
   * approve via the unverified `approve()` claim. Every value must be
   * a `KeyObject` holding an Ed25519 *public* key — anything else
   * (a private key, an RSA/EC key, a non-KeyObject value, or a key
   * for an unknown signer id) is rejected at construction time, so a
   * misconfigured quorum fails fast instead of failing open at vote
   * time. Public keys are configuration, not data: they are never
   * written into a snapshot — a snapshot carries only the `verified`
   * flags recorded on its entries, and restoring one does not
   * re-verify any signature.
   */
  signerPublicKeys?: Record<string, KeyObject>;
}

/** One entry of a quorum's approval audit trail. */
export interface ApprovalLogEntry {
  /** Signer that approved. */
  readonly signerId: string;
  /** Canonical ISO-8601 timestamp of when the approval was recorded. */
  readonly at: string;
  /**
   * Optional caller-supplied reference to the off-chain evidence
   * behind this approval — e.g. a vote-record link, a governance
   * proposal id, or an attestation reference. Present only when
   * `approve()` was called with one. The quorum records the claim;
   * it does NOT verify that the referenced evidence is real and
   * performs no signature verification on it — the same honest scope
   * as the VERIFY_PASS evidence reference on escrow history entries.
   * Capped at {@link MAX_EVIDENCE_LENGTH} characters (32,768): the
   * same ceiling as the escrow history evidence, enforced at the
   * write points (`approve()` / `approveSigned()`) and at snapshot
   * restore, so an oversized reference can neither be recorded live
   * nor smuggled in through a rehydrated snapshot. Oversized
   * evidence is rejected outright, never truncated — truncation
   * would change what the audit trail says the evidence was.
   */
  readonly evidence?: string;
  /**
   * Present (and always `true`) only when this approval was recorded
   * via `approveSigned()` after its Ed25519 signature verified
   * against the canonical approval statement. Absent for plain
   * `approve()` claims, which carry no cryptographic backing — the
   * flag is the only thing distinguishing a verified vote from an
   * unverified claim in the log, the snapshot, and the counting
   * views (both kinds count identically toward the threshold).
   */
  readonly verified?: boolean;
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
 * and approvals in it are still caller-persisted data — restoring one
 * carries the recorded `verified` flags as-is and does not re-verify
 * any signature (the public keys live in `QuorumConfig`, never in the
 * snapshot). A `verified: true` flag in a restored snapshot is only as
 * trustworthy as the snapshot itself, exactly like the `evidence`
 * strings it carries.
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
   * still counts: re-approving is a no-op and does not replace the
   * evidence recorded on the original entry (revoke, then approve
   * again, to change it). If the signer's approval has expired (see
   * `maxApprovalAgeMs`), approving again appends a fresh log entry
   * with a new timestamp and the signer counts again, and the fresh
   * entry carries the new evidence (if any) — the counting views
   * always follow the signer's latest entry.
   *
   * The optional `evidence` is a caller-asserted reference to
   * off-chain evidence behind the vote (a vote-record link, a
   * governance proposal id, an attestation reference). It must be a
   * non-empty string when given, and at most
   * {@link MAX_EVIDENCE_LENGTH} characters (32,768) — longer
   * evidence is rejected outright, never truncated. The quorum
   * records it verbatim and never verifies it. Counting
   * (`hasQuorum` / `approvalCount` / `approvals`) is unaffected by
   * whether evidence is present.
   */
  approve(signerId: string, evidence?: string): void;
  /**
   * Record a signature-verified approval. Requires an Ed25519 public
   * key registered for the signer in `QuorumConfig.signerPublicKeys` —
   * calling it for a signer with no registered key throws, as does
   * calling it for an unknown signer.
   *
   * The signature must be an Ed25519 signature over the canonical
   * approval statement `escrow-quorum:approve:<signerId>` (exact
   * bytes, UTF-8, no trailing newline), verified with
   * `crypto.verify(null, statement, publicKey, signature)`. A failed
   * verification throws
   * `quorum signature verification failed for signer "<id>"` and
   * records nothing — a bad signature never counts, never lands in
   * the log, and never consumes anything. A non-`Buffer` /
   * non-`Uint8Array` signature is a caller error and throws before
   * any verification is attempted.
   *
   * The statement binds the signer id only: it does not name an
   * escrow or an outcome, so a signature is meaningful only inside
   * the quorum it was collected for — use one quorum per arbitration
   * (the `dispatchArbitration` pattern) so a vote cannot be replayed
   * across arbitrations. `evidence` is accepted with the same
   * caller-asserted meaning as on `approve()`.
   *
   * On success the entry is marked `verified: true` in the log (and
   * in snapshots). If the signer's current approval still counts, a
   * valid signature upgrades that entry in place — same timestamp,
   * same evidence, now verified — instead of appending a second
   * entry; the approval happened when it happened, the signature
   * only proves it later. If the previous approval has expired, a
   * fresh verified entry is appended, exactly like `approve()`.
   * Counting is identical for verified and unverified approvals.
   */
  approveSigned(
    signerId: string,
    signature: Buffer | Uint8Array,
    evidence?: string
  ): void;
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
  signerPublicKeys,
}: QuorumConfig): void {
  if (!Array.isArray(signers) || signers.length === 0)
    throw new Error("quorum signers must be a non-empty array");
  const seen = new Set<string>();
  for (const s of signers) {
    if (typeof s !== "string" || s.length === 0)
      throw new Error("quorum signer ids must be non-empty strings");
    if (s.length > MAX_ACTOR_LENGTH)
      throw new Error(
        `quorum signer id must be at most ${MAX_ACTOR_LENGTH} characters, got ${s.length}`
      );
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
  if (signerPublicKeys !== undefined) {
    if (
      typeof signerPublicKeys !== "object" ||
      signerPublicKeys === null ||
      Array.isArray(signerPublicKeys)
    )
      throw new Error("quorum signerPublicKeys must be an object keyed by signer id");
    for (const [signerId, key] of Object.entries(signerPublicKeys)) {
      if (!seen.has(signerId))
        throw new Error(
          `quorum signerPublicKeys has a key for unknown signer: ${JSON.stringify(signerId)}`
        );
      if (!(key instanceof KeyObject))
        throw new Error(
          `quorum signerPublicKeys[${JSON.stringify(signerId)}] must be a KeyObject`
        );
      if (key.type !== "public" || key.asymmetricKeyType !== "ed25519")
        throw new Error(
          `quorum signerPublicKeys[${JSON.stringify(signerId)}] must be an Ed25519 public key`
        );
    }
  }
}

interface TimedApproval {
  readonly signerId: string;
  readonly atMs: number;
  readonly evidence?: string;
  /** True only for entries recorded via `approveSigned()`. */
  readonly verified?: boolean;
}

/**
 * Shared evidence guard for `approve()` and `approveSigned()`:
 * evidence must be a non-empty string and at most
 * {@link MAX_EVIDENCE_LENGTH} characters. Oversized evidence is
 * rejected outright, never truncated — truncation would change what
 * the audit trail says the evidence was — and the rejection happens
 * before anything is recorded, so a failed call leaves no residue
 * in the log.
 */
function assertValidEvidence(evidence: string | undefined): void {
  if (evidence === undefined) return;
  if (typeof evidence !== "string" || evidence.length === 0)
    throw new Error("quorum approval evidence must be a non-empty string");
  if (evidence.length > MAX_EVIDENCE_LENGTH)
    throw new Error(
      `quorum approval evidence must be at most ${MAX_EVIDENCE_LENGTH} characters, got ${evidence.length}`
    );
}

/**
 * Canonical approval statement a signer signs for `approveSigned()`:
 * the exact bytes `escrow-quorum:approve:<signerId>` (UTF-8, no
 * trailing newline). It binds the signer id only — not an escrow or
 * an outcome — so a signature is meaningful only inside the quorum
 * it was collected for (see `Quorum.approveSigned`).
 */
export function approvalStatement(signerId: string): Buffer {
  return Buffer.from(`escrow-quorum:approve:${signerId}`, "utf8");
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
  // Defensive copy: a caller mutating its record after construction
  // must not silently re-key the quorum.
  const publicKeys = new Map<string, KeyObject>(
    Object.entries(config.signerPublicKeys ?? {})
  );
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
    approve(signerId: string, evidence?: string): void {
      if (!signers.has(signerId))
        throw new Error(`unknown quorum signer: ${JSON.stringify(signerId)}`);
      assertValidEvidence(evidence);
      const current = latestBySigner().get(signerId);
      if (current !== undefined && isCounted(current)) return; // still counts — no-op, evidence unchanged
      log.push({
        signerId,
        atMs: now(),
        ...(evidence !== undefined ? { evidence } : {}),
      });
    },
    approveSigned(
      signerId: string,
      signature: Buffer | Uint8Array,
      evidence?: string
    ): void {
      if (!signers.has(signerId))
        throw new Error(`unknown quorum signer: ${JSON.stringify(signerId)}`);
      const publicKey = publicKeys.get(signerId);
      if (publicKey === undefined)
        throw new Error(
          `quorum approveSigned: no public key registered for signer ${JSON.stringify(signerId)}`
        );
      assertValidEvidence(evidence);
      // Buffer extends Uint8Array, so one check covers both shapes.
      if (!(signature instanceof Uint8Array))
        throw new Error(
          "quorum approveSigned: signature must be a Buffer or Uint8Array"
        );
      let ok = false;
      try {
        ok = verify(
          null,
          approvalStatement(signerId),
          publicKey,
          signature
        );
      } catch {
        ok = false;
      }
      if (!ok)
        throw new Error(
          `quorum signature verification failed for signer ${JSON.stringify(signerId)}`
        );
      const current = latestBySigner().get(signerId);
      if (current !== undefined && isCounted(current)) {
        // Still counts: upgrade the entry in place — same timestamp,
        // same evidence, now verified. The approval happened when it
        // happened; the signature only proves it later.
        const idx = log.lastIndexOf(current);
        log[idx] = { ...current, verified: true };
        return;
      }
      log.push({
        signerId,
        atMs: now(),
        ...(evidence !== undefined ? { evidence } : {}),
        verified: true,
      });
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
        ...(e.evidence !== undefined ? { evidence: e.evidence } : {}),
        ...(e.verified === true ? { verified: true as const } : {}),
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
          ...(e.evidence !== undefined ? { evidence: e.evidence } : {}),
          ...(e.verified === true ? { verified: true as const } : {}),
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
 *  - an approval entry that is not exactly `{ signerId, at }` plus
 *    an optional `evidence` and an optional `verified: true`, names an
 *    unknown signer, carries a non-canonical-ISO timestamp, carries an
 *    `evidence` that is present but not a non-empty string or is
 *    longer than {@link MAX_EVIDENCE_LENGTH} characters, carries a
 *    `verified` that is present but not `true` (a snapshot never
 *    records `verified: false` — unverified entries omit the key),
 *    is an exact duplicate of an earlier entry (same signer, same
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
      if (
        key !== "signerId" &&
        key !== "at" &&
        key !== "evidence" &&
        key !== "verified"
      )
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
    let evidence: string | undefined;
    if (entry.evidence !== undefined) {
      if (typeof entry.evidence !== "string" || entry.evidence.length === 0)
        fail(`${tag}: evidence must be a non-empty string`);
      const evidenceString = entry.evidence as string;
      if (evidenceString.length > MAX_EVIDENCE_LENGTH)
        fail(
          `${tag}: evidence must be at most ${MAX_EVIDENCE_LENGTH} characters, got ${evidenceString.length}`
        );
      evidence = evidenceString;
    }
    let verified: boolean | undefined;
    if (entry.verified !== undefined) {
      if (entry.verified !== true)
        fail(`${tag}: verified must be true when present`);
      verified = true;
    }
    const pairKey = `${signerId}\u0000${at}`;
    if (seenPairs.has(pairKey))
      fail(`${tag}: duplicate approval entry for signer ${JSON.stringify(signerId)} at ${at}`);
    seenPairs.add(pairKey);
    if (atMs < prevMs)
      fail(`${tag}: approvals must be in non-decreasing timestamp order`);
    prevMs = atMs;
    entries.push({
      signerId,
      atMs,
      ...(evidence !== undefined ? { evidence } : {}),
      ...(verified === true ? { verified: true as const } : {}),
    });
  }
  return buildQuorum(config, entries);
}
