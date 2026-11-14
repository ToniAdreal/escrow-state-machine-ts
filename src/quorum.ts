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

import { createHmac, KeyObject, timingSafeEqual, verify } from "node:crypto";
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
 * strings it carries. When the snapshot crosses an untrusted boundary
 * (a persisted file, a queue, another service), wrap it in the
 * HMAC-signed envelope instead — see
 * {@link exportSignedQuorumSnapshot} /
 * {@link restoreSignedQuorumSnapshot} — so a rewritten snapshot
 * (including a forged `verified: true` flag) fails closed at restore.
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
   * restart with {@link restoreQuorum}. When the snapshot crosses
   * an untrusted boundary, wrap it with
   * {@link exportSignedQuorumSnapshot} instead — the plain form
   * carries no authentication, so a rewritten file restores
   * silently.
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

/**
 * Integrity-protected form of a {@link QuorumSnapshot}, produced by
 * {@link exportSignedQuorumSnapshot} and consumed by
 * {@link restoreSignedQuorumSnapshot} (see those functions for the
 * exact contract). Same envelope shape as the sibling
 * `EscrowSignedSnapshotEnvelope` (backlog #1017), the
 * `SettlementEventDedupe` / `SettlementWebhookOutbox` signed
 * snapshots, and the rfc9421 `ReplayCache` signed snapshot.
 *
 * - `v`: envelope format version. Only `1` exists; restore rejects
 *   any other value (including a missing `v`) instead of guessing.
 * - `snapshot`: the wrapped {@link QuorumSnapshot}, exactly as
 *   `Quorum.snapshot()` produces it.
 * - `mac`: lowercase hex HMAC-SHA256 over the canonical JSON of
 *   `snapshot` (object keys sorted recursively, array order
 *   preserved) under the caller's secret — or, when `expiresAt`
 *   is present, over the canonical JSON of
 *   `{ expiresAt, snapshot }`, so the expiry timestamp is inside
 *   the MAC coverage and cannot be extended without the secret.
 * - `expiresAt`: optional canonical ISO-8601 UTC timestamp. When
 *   present the envelope restores only while `now <= expiresAt`
 *   (`now > expiresAt` is expired, checked after the MAC so a
 *   tampered `expiresAt` fails as a MAC mismatch first); absent
 *   means the envelope never expires, exactly as before this
 *   field existed — envelopes exported without it verify
 *   unchanged.
 *
 * Why this exists: the plain snapshot carries the full approval
 * audit trail, including the `verified: true` flags recorded by
 * `approveSigned()`, and nothing in it is authenticated — a
 * rewritten persisted snapshot could flip an unverified claim to
 * "verified", invent approvals, or drop a revocation, and
 * `restoreQuorum` would accept it as long as the shape is valid.
 * The envelope MAC covers the whole snapshot, so any such rewrite
 * fails closed at restore.
 *
 * The envelope carries no secret: the secret is caller configuration,
 * never persisted in the envelope, and the same secret must be
 * supplied at restore time. An envelope with any other field is
 * rejected, so a caller cannot smuggle extra data (including a
 * secret) past restore. The MAC is integrity protection only — it
 * proves the snapshot was not rewritten by anyone without the
 * secret — not confidentiality: the snapshot contents are plain
 * JSON, and the envelope itself is plain JSON. A caller that needs
 * the snapshot kept private must encrypt it separately; this
 * envelope does not. The envelope secret need not equal any
 * `auditKey` or webhook secret (they protect different things and
 * are managed independently).
 */
export interface QuorumSignedSnapshotEnvelope {
  v: 1;
  snapshot: QuorumSnapshot;
  expiresAt?: string;
  mac: string;
}

/**
 * Options for {@link exportSignedQuorumSnapshot} (backlog #1137):
 * an optional expiry for the envelope. Exactly one of `expiresAt` /
 * `maxAgeMs` may be set; `now` is only used with `maxAgeMs`. The
 * resolved timestamp is written into the envelope and covered by
 * its MAC, so it cannot be extended without the secret. An envelope
 * exported with neither option never expires.
 */
export interface QuorumExportSignedSnapshotOptions {
  /**
   * Absolute expiry for the envelope, a canonical ISO-8601 UTC
   * timestamp string (`new Date(ms).toISOString()` form — exactly
   * what `Date.parse` round-trips). Mutually exclusive with
   * `maxAgeMs`.
   */
  expiresAt?: string;
  /**
   * Relative expiry in milliseconds from `now` (below): the
   * envelope's `expiresAt` is set to
   * `new Date(now + maxAgeMs).toISOString()`. Mutually exclusive
   * with `expiresAt`. Must be a positive finite number.
   */
  maxAgeMs?: number;
  /**
   * Clock override (milliseconds since the epoch) used only with
   * `maxAgeMs` to compute `expiresAt`; defaults to `Date.now()`.
   * Inject a fixed time for deterministic tests. Supplying it
   * without `maxAgeMs` is a configuration error — there is nothing
   * for it to compute.
   */
  now?: number;
}

/**
 * Options for {@link restoreSignedQuorumSnapshot}: the clock used
 * for the envelope-expiry check.
 */
export interface QuorumRestoreSignedSnapshotOptions {
  /**
   * Clock override (milliseconds since the epoch) for the
   * `expiresAt` check; defaults to `Date.now()`. An envelope is
   * expired only when `now > Date.parse(expiresAt)` — restoring at
   * exactly `expiresAt` still succeeds, the same inclusive
   * boundary the settlement webhook freshness window uses
   * (`now - at > maxAgeMs` fails).
   */
  now?: number;
}

/**
 * Canonical JSON for snapshot signing (backlog #1137): object keys
 * sorted recursively, array order preserved, primitives via
 * `JSON.stringify`. A non-JSON value (notably `undefined`, which
 * `JSON.stringify` would silently drop) throws instead of being
 * silently normalized — a MAC computed over a silently altered
 * document would be worse than no MAC. Same semantics as the
 * sibling `Escrow` helper and the rfc9421 `ReplayCache` signed
 * snapshot's canonical form.
 */
function canonicalJsonForQuorumSignedSnapshot(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error(
        "Quorum: cannot canonicalize a non-finite number for snapshot signing",
      );
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalJsonForQuorumSignedSnapshot(entry)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJsonForQuorumSignedSnapshot(record[key])}`,
      )
      .join(",")}}`;
  }
  throw new Error(
    `Quorum: cannot canonicalize a non-JSON value of type ${typeof value} for snapshot signing`,
  );
}

/**
 * Validate a signed-snapshot secret and return its bytes. A secret
 * is a non-empty string (UTF-8) or a non-empty `Buffer` — the same
 * input shapes as the sibling `Escrow` helper, and deliberately
 * without a length floor: this MAC is integrity protection for a
 * persisted snapshot, and the contract rejects only an empty secret,
 * so a shorter caller secret is the caller's risk to take (use a
 * long random secret; the envelope never records how long it was).
 * An empty or wrongly typed secret is a caller-configuration error,
 * thrown before any quorum state is touched.
 */
function quorumSignedSnapshotSecretBytes(secret: unknown): Buffer {
  if (typeof secret === "string") {
    if (secret.length === 0)
      throw new Error(
        "Quorum: signed snapshot secret must not be empty",
      );
    return Buffer.from(secret, "utf8");
  }
  if (Buffer.isBuffer(secret)) {
    if (secret.length === 0)
      throw new Error(
        "Quorum: signed snapshot secret must not be empty",
      );
    return secret;
  }
  throw new Error(
    `Quorum: signed snapshot secret must be a non-empty string or Buffer, got ${typeof secret}`,
  );
}

/**
 * Resolve the `expiresAt` for a signed quorum snapshot export from
 * `QuorumExportSignedSnapshotOptions` (backlog #1137):
 * `expiresAt` must already be a canonical ISO-8601 UTC string,
 * `maxAgeMs` must be a positive finite number and is resolved
 * against `now` (default `Date.now()`), the two are mutually
 * exclusive, and `now` without `maxAgeMs` is a configuration error.
 * Returns `undefined` when the caller set neither (no expiry).
 * Mirrors the sibling `Escrow` resolver, same wording, same bar.
 */
function resolveQuorumSignedSnapshotExpiresAt(
  opts: QuorumExportSignedSnapshotOptions | undefined,
): string | undefined {
  if (opts === undefined) return undefined;
  if (typeof opts !== "object" || opts === null || Array.isArray(opts))
    throw new Error(
      "Quorum: exportSignedQuorumSnapshot options must be an object",
    );
  const { expiresAt, maxAgeMs, now } = opts;
  if (expiresAt !== undefined && maxAgeMs !== undefined)
    throw new Error(
      "Quorum: exportSignedQuorumSnapshot options must not combine expiresAt and maxAgeMs",
    );
  if (now !== undefined && maxAgeMs === undefined)
    throw new Error(
      "Quorum: exportSignedQuorumSnapshot option now is only used with maxAgeMs",
    );
  if (
    now !== undefined &&
    (typeof now !== "number" || !Number.isFinite(now))
  )
    throw new Error(
      "Quorum: exportSignedQuorumSnapshot option now must be a finite number of milliseconds since the epoch",
    );
  if (expiresAt !== undefined) {
    if (!isCanonicalIso(expiresAt))
      throw new Error(
        "Quorum: exportSignedQuorumSnapshot option expiresAt must be a canonical ISO-8601 UTC timestamp string",
      );
    return expiresAt;
  }
  if (maxAgeMs !== undefined) {
    if (
      typeof maxAgeMs !== "number" ||
      !Number.isFinite(maxAgeMs) ||
      maxAgeMs <= 0
    )
      throw new Error(
        "Quorum: exportSignedQuorumSnapshot option maxAgeMs must be a positive finite number",
      );
    return new Date((now ?? Date.now()) + maxAgeMs).toISOString();
  }
  return undefined;
}

/**
 * HMAC-SHA256 (hex) over the canonical JSON of a quorum snapshot —
 * or, when `expiresAt` is present, over the canonical JSON of
 * `{ expiresAt, snapshot }`, so the expiry timestamp is inside the
 * MAC coverage and cannot be extended without the secret. Envelopes
 * without `expiresAt` MAC exactly as before, so envelopes exported
 * before this field existed still verify.
 */
function computeQuorumSignedSnapshotMac(
  snapshot: QuorumSnapshot,
  secretBytes: Buffer,
  expiresAt?: string,
): string {
  const macInput =
    expiresAt === undefined ? snapshot : { expiresAt, snapshot };
  return createHmac("sha256", secretBytes)
    .update(canonicalJsonForQuorumSignedSnapshot(macInput), "utf8")
    .digest("hex");
}

/**
 * Compare two hex digests in constant time. `timingSafeEqual` throws
 * on length mismatch, and `Buffer.from(x, "hex")` silently drops
 * non-hex characters, so both guards are applied explicitly: non-hex
 * input, an odd-length digest, or a length mismatch is simply
 * `false`, never a throw — a forged digest shape must fail
 * verification, not crash the caller. Same helper as the sibling
 * `Escrow` one, quorum-scoped.
 */
function constantTimeHexEqual(
  expected: string,
  actual: string | undefined,
): boolean {
  if (actual === undefined) return false;
  if (
    expected.length !== actual.length ||
    expected.length % 2 !== 0 ||
    !/^[0-9a-fA-F]+$/.test(expected) ||
    !/^[0-9a-fA-F]+$/.test(actual)
  ) {
    return false;
  }
  const expectedBytes = Buffer.from(expected, "hex");
  const actualBytes = Buffer.from(actual, "hex");
  return (
    expectedBytes.length === actualBytes.length &&
    timingSafeEqual(expectedBytes, actualBytes)
  );
}

/**
 * Export a quorum's snapshot wrapped in an HMAC-signed envelope
 * (see {@link QuorumSignedSnapshotEnvelope}):
 * `{ v: 1, snapshot, mac }` where `mac` is HMAC-SHA256 over the
 * canonical JSON of the snapshot under `secret`. Persist the
 * envelope (plain JSON) before a restart and restore it with
 * {@link restoreSignedQuorumSnapshot} — a process that restarts
 * keeps its collected approvals, including which were
 * signature-verified, and anyone who rewrites the persisted file
 * without the secret is caught at restore instead of silently
 * forging a `verified: true` approval or inventing votes.
 *
 * The secret is never written into the envelope, and the envelope
 * is integrity protection only, not encryption: the snapshot
 * contents are plain JSON, so the secret must be kept where the
 * snapshot writer keeps its other signing-side secrets. An empty
 * secret is a caller-configuration error. The unsigned `snapshot()`
 * path is unchanged: this envelope is opt-in, and a caller that
 * never signs keeps the old trusted-configuration semantics.
 *
 * `opts` optionally bounds the envelope's life
 * (see {@link QuorumExportSignedSnapshotOptions}): `expiresAt` (an
 * absolute canonical ISO-8601 UTC timestamp) or `maxAgeMs`
 * (relative to `opts.now`, default `Date.now()`). The timestamp
 * is written into the envelope and covered by the MAC, so it
 * cannot be extended without the secret; an envelope exported
 * with neither option never expires, exactly as before.
 */
export function exportSignedQuorumSnapshot(
  quorum: Quorum,
  secret: string | Buffer,
  opts?: QuorumExportSignedSnapshotOptions,
): QuorumSignedSnapshotEnvelope {
  const secretBytes = quorumSignedSnapshotSecretBytes(secret);
  const snapshot = quorum.snapshot();
  const expiresAt = resolveQuorumSignedSnapshotExpiresAt(opts);
  const mac = computeQuorumSignedSnapshotMac(snapshot, secretBytes, expiresAt);
  return expiresAt === undefined
    ? { v: 1, snapshot, mac }
    : { v: 1, snapshot, expiresAt, mac };
}

/**
 * Rebuild a quorum from a signed envelope produced by
 * {@link exportSignedQuorumSnapshot} (typically after a
 * `JSON.parse` of the persisted form), under `config` — pass the
 * same configuration the snapshot was taken from; the strict
 * config-match validation of {@link restoreQuorum} still applies
 * after the MAC check.
 *
 * Restore is fail-closed, with authenticity checked first: an
 * envelope with an unknown field (including a smuggled `secret`),
 * a version other than `1`, a malformed `mac`, or a MAC that does
 * not match the snapshot under `secret` throws a descriptive
 * configuration `Error` and no quorum is produced — a tampered
 * approval entry (including a flipped `verified` flag), a tampered
 * threshold/signer list, or a wrong secret all fail here, before
 * any snapshot parsing, so a tampered envelope can never partially
 * install. A MAC-valid envelope whose snapshot is itself malformed
 * then fails through the same strict snapshot validation as
 * {@link restoreQuorum}, again with no quorum produced. The MAC
 * comparison is constant-time over equal-length hex digests; a
 * wrong-length `mac` is rejected as malformed before comparison.
 *
 * When the envelope carries `expiresAt`, restore additionally
 * checks it after the MAC — so a tampered timestamp fails as a
 * MAC mismatch first, never as an expiry — and before any
 * snapshot parsing: the envelope is expired only when
 * `now > Date.parse(expiresAt)`, so restoring at exactly
 * `expiresAt` still succeeds, and an expired envelope throws a
 * descriptive `Error` with no quorum produced. `opts.now`
 * (milliseconds since the epoch, default `Date.now()`) injects
 * the clock for deterministic tests. An envelope without
 * `expiresAt` never expires.
 *
 * The unsigned `restoreQuorum()` and this signed restore do not
 * accept each other's input: an unsigned snapshot has no `mac`
 * (and fields where the envelope expects `snapshot`), and a signed
 * envelope has fields the unsigned path rejects — so a caller
 * cannot silently downgrade a signed restore to the
 * trusted-configuration path.
 */
export function restoreSignedQuorumSnapshot(
  config: QuorumConfig,
  envelope: unknown,
  secret: string | Buffer,
  opts?: QuorumRestoreSignedSnapshotOptions,
): Quorum {
  const secretBytes = quorumSignedSnapshotSecretBytes(secret);
  const fail = (detail: string): never => {
    throw new Error(
      `Quorum: invalid signed snapshot envelope: ${detail}`,
    );
  };
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    Array.isArray(envelope)
  )
    fail("expected an object of the form { v: 1, snapshot, mac }");
  const record = envelope as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (
      key !== "v" &&
      key !== "snapshot" &&
      key !== "mac" &&
      key !== "expiresAt"
    )
      fail(`unknown field "${key}"`);
  }
  if (record.v !== 1)
    fail(
      `unsupported envelope version ${JSON.stringify(record.v) ?? String(record.v)} (expected 1)`,
    );
  const expiresAtRaw = record.expiresAt;
  let expiresAt: string | undefined;
  if (expiresAtRaw !== undefined) {
    if (typeof expiresAtRaw === "string" && isCanonicalIso(expiresAtRaw)) {
      expiresAt = expiresAtRaw;
    } else {
      fail("expiresAt must be a canonical ISO-8601 UTC timestamp string");
    }
  }
  const mac = record.mac;
  if (typeof mac !== "string" || !/^[0-9a-f]{64}$/.test(mac))
    throw new Error(
      "Quorum: invalid signed snapshot envelope: mac must be a 64-character lowercase hex HMAC-SHA256 digest",
    );
  const snapshot = record.snapshot;
  if (
    typeof snapshot !== "object" ||
    snapshot === null ||
    Array.isArray(snapshot)
  )
    fail('"snapshot" must be an object');
  const expectedMac = computeQuorumSignedSnapshotMac(
    snapshot as QuorumSnapshot,
    secretBytes,
    expiresAt,
  );
  if (!constantTimeHexEqual(expectedMac, mac))
    throw new Error(
      "Quorum: signed snapshot MAC mismatch: the snapshot was tampered with or the secret is wrong",
    );
  // MAC verified — now the expiry check, then the same strict
  // structural validation as restoreQuorum().
  if (expiresAt !== undefined) {
    const now = opts?.now ?? Date.now();
    if (typeof now !== "number" || !Number.isFinite(now))
      throw new Error(
        "Quorum: invalid signed snapshot envelope: restore option now must be a finite number of milliseconds since the epoch",
      );
    if (now > Date.parse(expiresAt))
      throw new Error(
        `Quorum: signed snapshot envelope expired at ${expiresAt}`,
      );
  }
  return restoreQuorum(config, snapshot);
}
