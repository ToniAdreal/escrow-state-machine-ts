/**
 * Settlement webhook notification payload + HMAC-SHA256 signing.
 *
 * An off-chain escrow still needs to push its settlement result out to the
 * real world (accounting / bookkeeping systems listening on webhooks). This
 * module is a small, dependency-free transport helper: it derives a compact
 * notification payload from a {@link SettlementReport} and signs it with
 * HMAC-SHA256, using the same `sha256=<hex>` header convention GitHub
 * webhooks use.
 *
 * Scope honesty (what this is NOT):
 * - Delivery is available via {@link deliverSettlementWebhook}: HTTP POST of
 *   the signed payload with the `X-Signature` header, a per-attempt timeout,
 *   and exponential-backoff retries on 5xx, 429, and network errors (a 429
 *   `Retry-After` hint is honored; other 4xx are not retried). Multi-endpoint
 *   fan-out is available via {@link deliverSettlementWebhookToMany}.
 * - Secret distribution is the caller's responsibility. Whoever holds the
 *   secret can forge signatures; store it like any other API credential.
 * - `verifySettlementWebhook` should run over the raw request body bytes.
 *   Re-stringifying a parsed object round-trips byte-identically *if* key
 *   order is preserved, but raw bytes are the transport-safe path.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { PartyRole, SettlementReport } from "./settlementReport.js";

/** Compact machine-readable settlement notification. */
export interface SettlementWebhookPayload {
  event: "escrow.settled";
  /**
   * Unique delivery ID for this notification. Receivers MUST deduplicate on
   * `eventId`: `deliverSettlementWebhook` retries with exponential backoff,
   * so a successful retry re-POSTs a byte-different `at` but the same
   * logical event, and retries always reuse the original `eventId`. Two
   * independent settlements always get different `eventId`s.
   */
  eventId: string;
  escrowId: string;
  outcome: "released" | "refunded" | "expired";
  /**
   * How a `released` settlement was reached, copied verbatim from
   * `SettlementReport.releasePath` (e.g. `"VERIFY_PASS → RELEASE"` for the
   * normal path, `"DISPUTE → ARBITRATE_RELEASE"` for an arbitration
   * release). Present only when the outcome is `released` and the report
   * carries a path; `refunded`/`expired` payloads omit the key entirely
   * (never `releasePath: undefined` on the wire). Receivers can route on
   * it — e.g. send arbitration settlements to manual review — without
   * re-querying the settlement report. Covered by the signature like
   * every other field, so tampering with it fails verification.
   */
  releasePath?: string;
  /** Locked deposit total (same `deposit.deposit` the report accounts for). */
  deposit: number;
  parties: Array<{ party: PartyRole; inflow: number; outflow: number; net: number }>;
  /** ISO-8601 timestamp of when the payload was built. */
  at: string;
}

export interface SettlementWebhook {
  payload: SettlementWebhookPayload;
  /** `sha256=<hex>` — same shape as the X-Hub-Signature-256 header. */
  signature: string;
}

export interface BuildWebhookOptions {
  /** HMAC secret; must not be empty (empty string / zero-length buffer throws). */
  secret: string | Buffer;
  /**
   * Payload `at` timestamp. Defaults to the real clock; inject a fixed
   * value in tests to make signatures deterministic.
   */
  now?: Date | string;
  /**
   * Payload `eventId`. Defaults to `crypto.randomUUID()`; inject a fixed
   * value in tests to make signatures deterministic. Must be a non-empty
   * string when provided.
   */
  eventId?: string;
}

/**
 * Options for secret-rotation-aware webhook verification.
 *
 * During a secret rotation window the receiver must accept signatures made
 * with either the old or the new secret; pass both as `secrets`. The first
 * candidate whose HMAC matches wins, so the array order is only a
 * performance preference (put the newest secret first), never a security
 * one — any match authenticates, and all-mismatch fails closed.
 */
export interface VerifyWebhookOptions {
  /** Candidate HMAC secrets; must be a non-empty array of non-empty secrets. */
  secrets: (string | Buffer)[];
  /**
   * Maximum age of the payload in milliseconds, measured from `payload.at`
   * to `now`. When set, a payload whose signature verifies but whose `at`
   * timestamp is older than this window returns `false` (fail-closed): this
   * rejects replays of legitimately-signed old notifications (a signed
   * payload from a year ago would otherwise verify forever — a signature
   * has no expiry on its own). Leave unset (the default) for
   * signature-only verification (the pre-freshness-check behavior).
   * Must be a finite non-negative number; illegal values throw a caller
   * configuration error. Note the boundary is inclusive: an age exactly
   * equal to `maxAgeMs` still passes (`now - at > maxAgeMs` fails).
   * Future timestamps are not bounded by this field (a negative age
   * always passes); bound them separately with `maxFutureSkewMs`.
   */
  maxAgeMs?: number;
  /**
   * Maximum clock skew into the future tolerated for the payload, in
   * milliseconds, measured from `now` to `payload.at`. When set, a payload
   * whose signature verifies but whose `at` lies further in the future
   * than this window returns `false` (fail-closed): a legitimately-signed
   * payload issued far into the future would otherwise gain a
   * near-unbounded replay window under a `maxAgeMs`-only check, and a
   * sender clock set wrong (or fast) would leave the receiver with no
   * defense. Leave unset (the default) for the legacy behavior, in which
   * future timestamps pass however far ahead they lie. Must be a finite
   * non-negative number; illegal values throw a caller configuration
   * error, with the same style as `maxAgeMs`. The boundary is inclusive:
   * a future skew exactly equal to `maxFutureSkewMs` still passes
   * (`at - now > maxFutureSkewMs` fails). Together, `maxAgeMs` and
   * `maxFutureSkewMs` form a two-sided freshness window; neither replaces
   * deduplication on `eventId`.
   */
  maxFutureSkewMs?: number;
  /**
   * "Now" for the freshness check, as epoch milliseconds. Defaults to
   * `Date.now()`; inject a fixed value in tests for determinism.
   */
  now?: number;
}

function assertSecret(secret: string | Buffer): void {
  if (secret.length === 0) {
    throw new Error(
      "cannot build settlement webhook: signing secret must not be empty",
    );
  }
}

function canonicalJson(payload: SettlementWebhookPayload): string {
  // The payload object is constructed below with a fixed literal key order,
  // so JSON.stringify is deterministic. Receivers must verify over the raw
  // body bytes (the `string` overload); the object overload exists only as a
  // convenience for tests and in-process checks.
  return JSON.stringify(payload);
}

function sign(body: string, secret: string | Buffer): string {
  return "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

/**
 * Build the (unsigned) payload body for a report. Shared by
 * {@link buildSettlementWebhook} and the fan-out delivery, which builds
 * the body exactly once and signs that same body per endpoint.
 * Validation messages match `buildSettlementWebhook`'s historical ones.
 */
function buildPayload(
  report: SettlementReport,
  options: { now?: Date | string; eventId?: string },
): SettlementWebhookPayload {
  const when = options.now === undefined ? new Date() : new Date(options.now);
  if (Number.isNaN(when.getTime())) {
    throw new Error(
      `cannot build settlement webhook: invalid 'now' timestamp for ${report.escrowId}`,
    );
  }
  const at = when.toISOString();

  if (options.eventId !== undefined && (typeof options.eventId !== "string" || options.eventId.length === 0)) {
    throw new Error(
      `cannot build settlement webhook: 'eventId' must be a non-empty string for ${report.escrowId}`,
    );
  }
  const eventId = options.eventId ?? randomUUID();

  const payload: SettlementWebhookPayload = {
    event: "escrow.settled",
    eventId,
    escrowId: report.escrowId,
    outcome: report.outcome,
    // Fixed canonical key order: `releasePath` sits between `outcome` and
    // `deposit`, and the key is written only for a released report that
    // carries a path — refunded/expired payloads keep their legacy shape.
    ...(report.outcome === "released" && report.releasePath
      ? { releasePath: report.releasePath }
      : {}),
    deposit: report.deposit.deposit,
    parties: report.parties.map((p) => ({
      party: p.party,
      inflow: p.inflow,
      outflow: p.outflow,
      net: p.net,
    })),
    at,
  };
  return payload;
}

/**
 * Build the signed settlement webhook for a settled escrow.
 *
 * Every figure in the payload is derived from the report (which itself is
 * derived from the append-only audit history): nothing is invented here.
 * Throws when the secret is empty, `now` is not a valid timestamp, or an
 * injected `eventId` is not a non-empty string.
 */
export function buildSettlementWebhook(
  report: SettlementReport,
  options: BuildWebhookOptions,
): SettlementWebhook {
  assertSecret(options.secret);
  const payload = buildPayload(report, options);
  const signature = sign(canonicalJson(payload), options.secret);
  return { payload, signature };
}

/**
 * Verify a settlement webhook signature. Returns `true` only when the
 * signature matches the HMAC-SHA256 of the given body under the secret.
 *
 * Prefer passing the raw body `string`; a parsed object is re-stringified
 * (fine in-process, but raw bytes are the safe transport path).
 * Malformed signatures return `false` rather than throwing, so a hostile
 * input can never turn verification into an unhandled exception. Each
 * candidate is compared in constant time (`timingSafeEqual`).
 *
 * Note: `eventId` is not validated separately — it is part of the signed
 * body, so any tampering with it breaks the signature check above.
 *
 * Rotation: pass `{ secrets: [newSecret, oldSecret] }` instead of a single
 * secret during the rotation window — any candidate that matches returns
 * `true`; all-mismatch returns `false` (fail-closed). An empty `secrets`
 * array (or an empty secret inside it) is a caller configuration error and
 * throws, never silently passes.
 *
 * Freshness (opt-in replay bound): pass `{ secrets, maxAgeMs, now? }`.
 * The signature is checked FIRST; only when it matches does the `at`
 * timestamp get checked against `now` — a forged signature still fails on
 * the signature comparison, and never reaches the freshness gate. An
 * unparseable `at` (or an unparseable string body) fails closed as
 * `false`, not an exception. Future timestamps are not bounded by
 * `maxAgeMs` (a negative age always passes); it only rejects old
 * payloads. Pass `maxFutureSkewMs` alongside (or instead) to bound that
 * future direction too: after the signature matches, a payload with
 * `at - now > maxFutureSkewMs` returns `false`, with the same inclusive
 * boundary, so the two fields together form a two-sided window. When
 * `maxFutureSkewMs` is unset, far-future timestamps still pass exactly
 * as before. Freshness is defense-in-depth only: receivers MUST still
 * deduplicate on `eventId`.
 */
export function verifySettlementWebhook(
  body: string | SettlementWebhookPayload,
  signature: string,
  secret: string | Buffer,
): boolean;
export function verifySettlementWebhook(
  body: string | SettlementWebhookPayload,
  signature: string,
  options: VerifyWebhookOptions,
): boolean;
export function verifySettlementWebhook(
  body: string | SettlementWebhookPayload,
  signature: string,
  secretOrOptions: string | Buffer | VerifyWebhookOptions,
): boolean {
  const secrets: (string | Buffer)[] =
    typeof secretOrOptions === "string" || Buffer.isBuffer(secretOrOptions)
      ? [secretOrOptions]
      : secretOrOptions.secrets;
  if (secrets.length === 0) {
    throw new Error(
      "cannot verify settlement webhook: secrets must be a non-empty array",
    );
  }
  secrets.forEach((secret, i) => {
    if (secret.length === 0) {
      throw new Error(
        `cannot verify settlement webhook: secrets[${i}] must not be empty`,
      );
    }
  });

  const isOptionsForm =
    typeof secretOrOptions === "object" && !Buffer.isBuffer(secretOrOptions);
  const maxAgeMs = isOptionsForm
    ? (secretOrOptions as VerifyWebhookOptions).maxAgeMs
    : undefined;
  if (
    maxAgeMs !== undefined &&
    (typeof maxAgeMs !== "number" || !Number.isFinite(maxAgeMs) || maxAgeMs < 0)
  ) {
    throw new Error(
      `cannot verify settlement webhook: maxAgeMs must be a finite non-negative number, got ${String(
        maxAgeMs,
      )}`,
    );
  }
  const maxFutureSkewMs = isOptionsForm
    ? (secretOrOptions as VerifyWebhookOptions).maxFutureSkewMs
    : undefined;
  if (
    maxFutureSkewMs !== undefined &&
    (typeof maxFutureSkewMs !== "number" ||
      !Number.isFinite(maxFutureSkewMs) ||
      maxFutureSkewMs < 0)
  ) {
    throw new Error(
      `cannot verify settlement webhook: maxFutureSkewMs must be a finite non-negative number, got ${String(
        maxFutureSkewMs,
      )}`,
    );
  }
  const now = isOptionsForm
    ? ((secretOrOptions as VerifyWebhookOptions).now ?? Date.now())
    : Date.now();
  if (typeof now !== "number" || !Number.isFinite(now)) {
    throw new Error(
      `cannot verify settlement webhook: now must be a finite epoch-millisecond number, got ${String(
        now,
      )}`,
    );
  }

  const match = /^sha256=([0-9a-f]{64})$/.exec(signature);
  if (!match) return false;
  const bodyString = typeof body === "string" ? body : canonicalJson(body);
  const actual = Buffer.from(match[1], "hex");
  let signatureMatches = false;
  for (const secret of secrets) {
    const expected = Buffer.from(
      createHmac("sha256", secret).update(bodyString, "utf8").digest(),
    );
    // timingSafeEqual throws on length mismatch; a forged 64-hex string that
    // decodes short (never, given the regex) or long is simply a failure.
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) {
      signatureMatches = true;
      break;
    }
  }
  if (!signatureMatches) return false;
  // Freshness is orthogonal to secret rotation and runs only after the
  // signature matched: forgeries fail above, never here.
  if (maxAgeMs === undefined && maxFutureSkewMs === undefined) return true;
  return payloadFreshEnough(body, maxAgeMs, maxFutureSkewMs, now);
}

/**
 * Fail-closed freshness gate over `payload.at`.
 *
 * String bodies are JSON-parsed to read `at`; unparseable bodies, missing
 * `at`, or non-parseable timestamps all return `false` (never throw)
 * whenever either window bound is configured.
 * Each boundary is inclusive: `now - at <= maxAgeMs` passes when
 * `maxAgeMs` is set, and `at - now <= maxFutureSkewMs` passes when
 * `maxFutureSkewMs` is set. An unset bound never rejects: with no
 * `maxFutureSkewMs`, a future `at` (negative age) always passes, and
 * with no `maxAgeMs`, an old `at` always passes.
 */
function payloadFreshEnough(
  body: string | SettlementWebhookPayload,
  maxAgeMs: number | undefined,
  maxFutureSkewMs: number | undefined,
  now: number,
): boolean {
  let at: unknown;
  if (typeof body === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return false;
    }
    // A JSON string's `.at` is String#at (a function); `typeof` below
    // rejects it before Date.parse ever sees it. Same for null/numbers.
    at = (parsed as { at?: unknown } | null)?.at;
  } else {
    at = body.at;
  }
  const atMs = typeof at === "string" ? Date.parse(at) : Number.NaN;
  if (Number.isNaN(atMs)) return false;
  if (maxAgeMs !== undefined && now - atMs > maxAgeMs) return false;
  if (maxFutureSkewMs !== undefined && atMs - now > maxFutureSkewMs) {
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Receiver-side eventId deduplication                                 */
/* ------------------------------------------------------------------ */

/** Options for {@link SettlementEventDedupe}. All fields optional. */
export interface SettlementEventDedupeOptions {
  /**
   * Milliseconds a recorded `eventId` stays deduplicated. An id seen
   * again while `now - firstSeenAt < ttlMs` is a duplicate; at exactly
   * `ttlMs` the record has expired and the id counts as unseen again
   * (the same boundary rule as the sibling rfc9421 `ReplayCache`).
   * Defaults to 3_600_000 (1 hour). Must be a finite number > 0.
   * Pick a TTL at least as long as the longest window in which the
   * sender (or a fan-out retry) can re-deliver the same event — the
   * delivery layer's retry horizon, not the freshness window.
   */
  ttlMs?: number;
  /**
   * Maximum number of `eventId`s tracked. When a new id needs room,
   * expired entries are reclaimed first, then the least recently seen
   * entry is evicted (LRU). Defaults to 10_000 (aligned with the
   * sibling `ReplayCache`). Must be a positive integer.
   */
  maxEntries?: number;
  /**
   * Clock source (milliseconds since the epoch). Defaults to
   * `Date.now`. Inject a fake clock for deterministic tests.
   */
  now?: () => number;
}

/**
 * Observability snapshot of a {@link SettlementEventDedupe}.
 *
 * - `size`: live (unexpired) entries tracked, computed against the
 *   dedupe's injected clock — same reading as the `size` getter.
 * - `hits`: `checkAndRecord` calls where the id was already seen
 *   within the TTL (i.e. duplicates).
 * - `misses`: `checkAndRecord` calls where the id was unseen and got
 *   recorded (including an id whose previous record had expired —
 *   expiry means "unseen").
 * - `evictions`: entries dropped while making room for a new entry —
 *   both expired-entry reclamation and LRU eviction count. The
 *   delete+re-record of an expired id inside `checkAndRecord` is part
 *   of the miss path and is *not* an eviction.
 *
 * Counters reset to zero on `clear()`.
 */
export interface SettlementEventDedupeStats {
  size: number;
  hits: number;
  misses: number;
  evictions: number;
}

/**
 * Receiver-side deduplication store for settlement webhook `eventId`s.
 *
 * `verifySettlementWebhook`'s freshness window is only defense-in-depth:
 * its docs require receivers to deduplicate on `eventId`, because a
 * retried (or fanned-out) delivery re-POSTs the same logical event
 * with the same `eventId`. This class is that deduplication step, so
 * receivers no longer hand-roll a `Map` with ad-hoc TTL/capacity/clock
 * choices. It follows the same paradigm as the sibling
 * rfc9421-signing-demo `ReplayCache` (TTL + LRU, injectable clock,
 * `hits`/`misses`/`evictions` observability).
 *
 * Usage — after the signature (and any freshness window) verifies:
 *
 * ```ts
 * const dedupe = new SettlementEventDedupe();
 * if (dedupe.checkAndRecord(payload.eventId)) {
 *   // duplicate delivery: acknowledge it, do not process the settlement twice
 * }
 * ```
 *
 * Honest scope: this is a single-process, in-memory store. Two
 * receiver processes each keep their own store and cannot see each
 * other's records, and a restart forgets every recorded id — a
 * deployment with multiple receiver processes (or one that must
 * survive restarts inside the TTL) must deduplicate over shared
 * storage (a database unique constraint, Redis, …) instead. Within
 * one process the store is exact: an id is a duplicate if and only if
 * it was recorded within the TTL and has not since been evicted.
 */
export class SettlementEventDedupe {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly clock: () => number;
  /** eventId -> first-seen-at (ms). Insertion order = LRU order. */
  private readonly seenAt = new Map<string, number>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(opts: SettlementEventDedupeOptions = {}) {
    const ttlMs = opts.ttlMs ?? 3_600_000;
    const maxEntries = opts.maxEntries ?? 10_000;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error(
        "SettlementEventDedupe: ttlMs must be a positive finite number",
      );
    }
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error(
        "SettlementEventDedupe: maxEntries must be a positive integer",
      );
    }
    if (opts.now !== undefined && typeof opts.now !== "function") {
      throw new Error("SettlementEventDedupe: now must be a function");
    }
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.clock = opts.now ?? Date.now;
  }

  /**
   * Atomically check-and-record an `eventId`: returns `true` when the
   * id was already recorded within the TTL — i.e. this delivery is a
   * duplicate/replay, the same "true = is a replay" contract as the
   * rfc9421 `NonceStore.check` — otherwise records the id and returns
   * `false` (first sighting; process the event).
   *
   * Expired entries are treated as unseen and re-recorded with a fresh
   * timestamp. On a duplicate hit the entry's LRU recency is refreshed
   * but its original first-seen timestamp is kept, so repeated
   * duplicates cannot extend the deduplication window.
   *
   * An empty or non-string `eventId` is a caller bug and throws —
   * silently accepting it would disable deduplication for exactly the
   * malformed deliveries that need it most.
   */
  checkAndRecord(eventId: string): boolean {
    if (typeof eventId !== "string" || eventId.length === 0) {
      throw new Error(
        "SettlementEventDedupe: eventId must be a non-empty string",
      );
    }
    const t = this.clock();
    const prev = this.seenAt.get(eventId);
    if (prev !== undefined) {
      if (t - prev < this.ttlMs) {
        // Refresh LRU recency (delete + re-insert moves it to the
        // tail) while keeping the original first-seen timestamp.
        this.seenAt.delete(eventId);
        this.seenAt.set(eventId, prev);
        this.hits++;
        return true; // duplicate
      }
      // Expired: drop and fall through to re-record with a fresh
      // timestamp. This is the miss path (an expired record means
      // "unseen"), not an eviction.
      this.seenAt.delete(eventId);
    }
    this.prune(t);
    this.seenAt.set(eventId, t);
    this.misses++;
    return false;
  }

  /**
   * Number of live (unexpired) entries tracked, computed against the
   * dedupe's injected clock.
   */
  get size(): number {
    const t = this.clock();
    let n = 0;
    for (const at of this.seenAt.values()) if (t - at < this.ttlMs) n++;
    return n;
  }

  /** Drop all tracked ids and reset the observability counters. */
  clear(): void {
    this.seenAt.clear();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  /**
   * Point-in-time observability snapshot (see
   * {@link SettlementEventDedupeStats}). The returned object is a fresh
   * copy — mutating it does not affect the store.
   */
  stats(): SettlementEventDedupeStats {
    return {
      size: this.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }

  /**
   * Make room for one new entry: reclaim expired entries first, then
   * evict the least recently seen ones. Map iteration order is
   * insertion order, so the head is always the oldest entry. Every
   * entry dropped here counts as an eviction for observability.
   */
  private prune(t: number): void {
    if (this.seenAt.size < this.maxEntries) return;
    for (const [eventId, at] of this.seenAt) {
      if (t - at >= this.ttlMs) {
        this.seenAt.delete(eventId);
        this.evictions++;
      }
      if (this.seenAt.size < this.maxEntries) return;
    }
    while (this.seenAt.size >= this.maxEntries) {
      const oldest = this.seenAt.keys().next();
      if (oldest.done) break;
      this.seenAt.delete(oldest.value);
      this.evictions++;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Delivery                                                            */
/* ------------------------------------------------------------------ */

/** Options for {@link deliverSettlementWebhook}. All fields optional. */
export interface DeliverWebhookOptions {
  /**
   * Retries after the initial attempt. Default 3 (up to 4 total attempts).
   * Must be a non-negative integer; `0` disables retries.
   */
  retries?: number;
  /**
   * Base backoff between retries in milliseconds. Retry n (1-based) waits
   * `backoffMs * 2^(n-1)`. Default 1000. May be 0 in tests.
   */
  backoffMs?: number;
  /** Per-attempt request timeout in milliseconds. Default 10000. */
  timeoutMs?: number;
  /**
   * Cap, in milliseconds, on the `Retry-After` wait honored on a 429.
   * A faulty or malicious server can answer `Retry-After: 31536000`; without
   * a cap the delivery promise would sleep for a year before the next
   * attempt. The
   * hint is clamped with `Math.min` before sleeping; default 60000.
   * Must be a finite non-negative number (`0` disables any Retry-After
   * wait, retrying immediately). Only the 429 hint is clamped — the
   * exponential backoff used when the hint is absent/unparsable is
   * unaffected.
   */
  maxRetryDelayMs?: number;
  /**
   * Optional external abort signal. Wired into both the in-flight request
   * and the backoff sleep between retries: aborting the signal ends the
   * whole delivery (no further attempts) and the returned promise rejects
   * with `webhook delivery aborted`. The per-attempt `timeoutMs` still
   * applies independently. Any non-`AbortSignal` value is a config error.
   */
  signal?: AbortSignal;
}

/** Result of a successful {@link deliverSettlementWebhook} call. */
export interface WebhookDeliveryResult {
  /** HTTP status of the attempt that succeeded (2xx). */
  status: number;
  /** Total HTTP attempts made, including the initial one. */
  attempts: number;
}

/**
 * Parse a `Retry-After` header value into a wait in milliseconds.
 * Accepts delay-seconds (a non-negative number) or an HTTP-date.
 * Returns `undefined` when the value is absent or unparsable, in which case
 * the caller falls back to exponential backoff. A past HTTP-date yields 0
 * (retry immediately) rather than a negative sleep.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    return undefined;
  }
  // "-5" is neither a legal delay-seconds value nor a date; Date.parse
  // would happily read it as a year, so reject signed numbers explicitly.
  if (/^[+-]/.test(trimmed)) return undefined;
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, when - nowMs);
}

/**
 * Wait before the next retry: a 429 `Retry-After` hint wins over backoff,
 * clamped to `maxRetryDelayMs` so a runaway hint can never stall delivery
 * longer than the caller allows.
 */
function retryDelayMs(
  response: Response,
  attempt: number,
  backoffMs: number,
  maxRetryDelayMs: number,
): number {
  if (response.status === 429) {
    const hinted = parseRetryAfter(response.headers.get("retry-after"));
    if (hinted !== undefined) return Math.min(hinted, maxRetryDelayMs);
  }
  return backoffMs * 2 ** attempt;
}

/**
 * Sleep between retries, interruptible by an external abort signal.
 * Rejects with `webhook delivery aborted` if the signal is already aborted
 * or aborts while the sleep is pending (the pending timer is cleared, so no
 * further attempt fires). Without a signal this is a plain sleep.
 */
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("webhook delivery aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("webhook delivery aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    // The timer deliberately stays ref'd: an awaited delivery must keep
    // the process alive until the backoff settles. With an unref'd timer
    // the event loop can drain mid-backoff (stubbed fetch, no live
    // sockets) and the delivery promise then never settles.
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** An error thrown by delivery, annotated with its real attempt count. */
type DeliveryError = Error & { attempts?: number; status?: number };

/**
 * Annotate a delivery error with the number of HTTP attempts actually
 * made (and the last HTTP status, when a response caused the failure).
 * The public single-endpoint API throws plain errors with unchanged
 * messages; the annotation exists so the fan-out wrapper can report
 * truthful per-endpoint `attempts`/`status` without re-implementing —
 * or parsing — the delivery loop.
 */
function withDeliveryOutcome(
  err: Error,
  attempts: number,
  status?: number,
): DeliveryError {
  const annotated = err as DeliveryError;
  annotated.attempts = attempts;
  if (status !== undefined) annotated.status = status;
  return annotated;
}

function assertDeliverSignalType(signal: unknown): void {
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new Error(
      `cannot deliver settlement webhook: signal must be an AbortSignal, got ${String(
        signal,
      )}`,
    );
  }
}

/**
 * Validate the numeric delivery options (after defaults are applied).
 * Shared by {@link deliverSettlementWebhook} and the fan-out wrapper,
 * which validates the call-level options once, up front.
 */
function assertDeliverOptionValues(
  options: DeliverWebhookOptions,
  resolved: {
    retries: number;
    backoffMs: number;
    timeoutMs: number;
    maxRetryDelayMs: number;
  },
): void {
  if (!Number.isInteger(resolved.retries) || resolved.retries < 0) {
    throw new Error(
      `cannot deliver settlement webhook: retries must be a non-negative integer, got ${String(
        options.retries,
      )}`,
    );
  }
  if (!Number.isFinite(resolved.backoffMs) || resolved.backoffMs < 0) {
    throw new Error(
      `cannot deliver settlement webhook: backoffMs must be a non-negative number, got ${String(
        options.backoffMs,
      )}`,
    );
  }
  if (!Number.isFinite(resolved.timeoutMs) || resolved.timeoutMs <= 0) {
    throw new Error(
      `cannot deliver settlement webhook: timeoutMs must be a positive number, got ${String(
        options.timeoutMs,
      )}`,
    );
  }
  if (!Number.isFinite(resolved.maxRetryDelayMs) || resolved.maxRetryDelayMs < 0) {
    throw new Error(
      `cannot deliver settlement webhook: maxRetryDelayMs must be a non-negative number, got ${String(
        options.maxRetryDelayMs,
      )}`,
    );
  }
}

/**
 * POST the signed webhook to `url` as JSON with the `X-Signature` header.
 *
 * The request body is byte-identical to what `buildSettlementWebhook`
 * signed, so the receiver can verify it over the raw bytes.
 *
 * Retry policy:
 * - 2xx → success, returned as `{ status, attempts }`.
 * - 429 and 5xx / network errors (including timeouts) → retried with
 *   exponential backoff, up to `retries` additional attempts. A 429
 *   `Retry-After` response header (delay seconds or an HTTP-date) takes
 *   precedence over the computed backoff; an absent or unparsable value
 *   falls back to `backoffMs * 2^(n-1)`. The honored hint is clamped to
 *   `maxRetryDelayMs` (default 60s), so a faulty or hostile server cannot
 *   stall delivery beyond the cap.
 * - Other 3xx/4xx (400, 404, …) → the request itself is at fault; throws
 *   immediately, no retry. Redirects are never followed (`redirect:
 *   "manual"`): a 3xx response is returned as-is and lands in this branch,
 *   so the signed payload is never re-posted to a redirect target URL —
 *   the caller must fix the endpoint.
 *
 * When every attempt fails, throws
 * `webhook delivery to <url> failed after <n> attempts: <last cause>`.
 * A per-attempt timeout surfaces as `webhook delivery timed out after
 * <timeoutMs>ms`. An external `signal` aborts the in-flight request and any
 * pending backoff sleep alike — no further attempts are made, and the
 * promise rejects with `webhook delivery aborted` (an abort is a caller
 * request to stop, never retried). Invalid options throw a
 * `cannot deliver settlement webhook: …` config error before any request
 * is made.
 */
export async function deliverSettlementWebhook(
  url: string,
  webhook: SettlementWebhook,
  options: DeliverWebhookOptions = {},
): Promise<WebhookDeliveryResult> {
  const retries = options.retries ?? 3;
  const backoffMs = options.backoffMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? 60_000;
  const signal = options.signal;

  assertDeliverSignalType(signal);
  if (signal?.aborted) {
    // Pre-aborted: the caller asked to stop before we started. Zero HTTP
    // attempts, a clear error, no retry.
    throw new Error("webhook delivery aborted");
  }
  assertDeliverOptionValues(options, {
    retries,
    backoffMs,
    timeoutMs,
    maxRetryDelayMs,
  });

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Error(
      `cannot deliver settlement webhook: invalid url ${JSON.stringify(url)}`,
    );
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error(
      `cannot deliver settlement webhook: unsupported protocol ${JSON.stringify(
        target.protocol,
      )} (http/https only)`,
    );
  }

  const body = canonicalJson(webhook.payload);

  let attempts = 0;
  let lastError: Error | null = null;
  let lastStatus: number | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    attempts = attempt + 1;
    let response: Response;
    try {
      response = await postOnce(target, webhook.signature, body, timeoutMs, signal);
    } catch (err) {
      if (signal?.aborted) {
        // The caller asked to stop: propagate the abort immediately,
        // never treat it as a retryable network failure.
        throw withDeliveryOutcome(new Error("webhook delivery aborted"), attempts);
      }
      lastError = err instanceof Error ? err : new Error(String(err));
      lastStatus = undefined;
      if (attempt < retries) {
        await sleepAbortable(backoffMs * 2 ** attempt, signal);
        continue;
      }
      break;
    }
    if (response.ok) {
      return { status: response.status, attempts };
    }
    if (
      response.status === 429 ||
      (response.status >= 500 && response.status <= 599)
    ) {
      lastError = new Error(`server responded with status ${response.status}`);
      lastStatus = response.status;
      if (attempt < retries) {
        await sleepAbortable(
          retryDelayMs(response, attempt, backoffMs, maxRetryDelayMs),
          signal,
        );
        continue;
      }
      break;
    }
    // Other 3xx/4xx (400, 404, …): the request itself is at fault; retrying
    // the identical request changes nothing.
    throw withDeliveryOutcome(
      new Error(
        `webhook delivery to ${url} failed with status ${response.status} (not retried)`,
      ),
      attempts,
      response.status,
    );
  }
  throw withDeliveryOutcome(
    new Error(
      `webhook delivery to ${url} failed after ${attempts} attempt${
        attempts === 1 ? "" : "s"
      }: ${lastError?.message ?? "unknown error"}`,
    ),
    attempts,
    lastStatus,
  );
}

/* ------------------------------------------------------------------ */
/* Multi-endpoint fan-out delivery                                     */
/* ------------------------------------------------------------------ */

/**
 * One fan-out destination for {@link deliverSettlementWebhookToMany}.
 * Each endpoint has its OWN signing secret: the shared payload body is
 * signed independently per endpoint, so one endpoint's secret can never
 * verify another endpoint's delivery. The delivery-option fields
 * override the call-level options for this endpoint only (retry budgets
 * are therefore counted per endpoint).
 */
export interface SettlementWebhookEndpoint {
  /** Destination URL (http/https), validated per endpoint. */
  url: string;
  /** This endpoint's signing secret (non-empty string or Buffer). */
  secret: string | Buffer;
  /** Per-endpoint override of the call-level `retries`. */
  retries?: number;
  /** Per-endpoint override of the call-level `backoffMs`. */
  backoffMs?: number;
  /** Per-endpoint override of the call-level `timeoutMs`. */
  timeoutMs?: number;
  /** Per-endpoint override of the call-level `maxRetryDelayMs`. */
  maxRetryDelayMs?: number;
  /** Per-endpoint override of the call-level `signal`. */
  signal?: AbortSignal;
}

/** Options for {@link deliverSettlementWebhookToMany}. */
export interface DeliverSettlementWebhookToManyOptions
  extends DeliverWebhookOptions {
  /**
   * Payload `at` timestamp shared by every endpoint's copy of the
   * event. Resolved ONCE per call (defaults to the real clock) so all
   * endpoints receive the same logical event, not one event per
   * endpoint with drifting timestamps.
   */
  now?: Date | string;
  /**
   * Payload `eventId` shared by every endpoint (see the eventId
   * semantics on {@link deliverSettlementWebhookToMany}). Defaults to
   * one freshly generated UUID per call; inject a fixed value in tests
   * for determinism. Must be a non-empty string.
   */
  eventId?: string;
}

/** Per-endpoint outcome of {@link deliverSettlementWebhookToMany}. */
export interface SettlementWebhookEndpointResult {
  /** The endpoint's URL, exactly as supplied (the endpoint identifier). */
  url: string;
  /** True when this endpoint returned a 2xx within its retry budget. */
  ok: boolean;
  /**
   * Total HTTP attempts actually made for this endpoint, including the
   * initial one. `0` when the endpoint failed before any request (an
   * empty secret, an invalid URL, an invalid per-endpoint override).
   */
  attempts: number;
  /** HTTP status of the successful — or last failed — response, when one was received. */
  status?: number;
  /** Failure summary (the single-endpoint delivery error's message), when `ok` is false. */
  error?: string;
}

/**
 * Aggregate outcome of {@link deliverSettlementWebhookToMany}.
 * `results[i]` always corresponds to `endpoints[i]` (input order is
 * preserved even though deliveries run concurrently), and
 * `delivered + failed` always equals `results.length`.
 */
export interface DeliverSettlementWebhookToManyResult {
  /** Per-endpoint results, in the same order as the input endpoints. */
  results: SettlementWebhookEndpointResult[];
  /** How many endpoints reported `ok: true`. */
  delivered: number;
  /** How many endpoints reported `ok: false`. */
  failed: number;
}

/**
 * Fan one settled escrow's settlement webhook out to many endpoints at
 * once — the shape where a single settlement must notify accounting,
 * notifications, and reconciliation systems simultaneously, each
 * holding its own secret.
 *
 * Semantics (aligned with the dataquest payout fan-out):
 * - The payload body is built ONCE from the report (one shared
 *   `eventId`, one shared `at`): this is a single logical settlement
 *   event fanned out, not N distinct events. Each endpoint's copy is
 *   signed independently with that endpoint's own secret, and delivered
 *   via {@link deliverSettlementWebhook} — the same retry / backoff /
 *   `Retry-After` logic, never a second implementation — with the
 *   endpoint's option overrides applied over the call-level options.
 *   Retry budgets are therefore per endpoint: one endpoint burning its
 *   retries never consumes another's.
 * - Deliveries run concurrently. One endpoint's failure — retries
 *   exhausted, network error, even a per-endpoint configuration problem
 *   such as an invalid URL or an empty secret — is reported as that
 *   endpoint's `{ ok: false, attempts, error }` result and never blocks
 *   or fails the other endpoints.
 * - Call-level configuration errors DO throw before any request is
 *   made: a missing/empty/non-array `endpoints`, invalid global
 *   delivery options, or an invalid shared `now`/`eventId` are caller
 *   bugs, not per-endpoint outcomes.
 *
 * Honest limit: there is no durable queue and no cross-process retry.
 * If the process dies mid-fan-out, some endpoints may have received the
 * event and others not; the caller reconciles by re-delivering and
 * letting receivers deduplicate on the shared `eventId`.
 */
export async function deliverSettlementWebhookToMany(
  report: SettlementReport,
  endpoints: SettlementWebhookEndpoint[],
  opts: DeliverSettlementWebhookToManyOptions = {},
): Promise<DeliverSettlementWebhookToManyResult> {
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    throw new Error(
      "cannot deliver settlement webhook to many endpoints: endpoints must be a non-empty array",
    );
  }
  // Call-level delivery options are caller configuration: validate them
  // once, up front, with the same rules as a single delivery.
  // (Per-endpoint overrides are validated per endpoint, inside the
  // fan-out, so a bad override fails only its own endpoint.)
  assertDeliverSignalType(opts.signal);
  assertDeliverOptionValues(opts, {
    retries: opts.retries ?? 3,
    backoffMs: opts.backoffMs ?? 1000,
    timeoutMs: opts.timeoutMs ?? 10_000,
    maxRetryDelayMs: opts.maxRetryDelayMs ?? 60_000,
  });
  // One logical event: build the shared payload body exactly once. A
  // bad shared `now`/`eventId` throws here, before any request.
  const payload = buildPayload(report, { now: opts.now, eventId: opts.eventId });
  const body = canonicalJson(payload);

  const results = await Promise.all(
    endpoints.map(async (endpoint, index): Promise<SettlementWebhookEndpointResult> => {
      const url =
        endpoint !== null &&
        typeof endpoint === "object" &&
        typeof endpoint.url === "string"
          ? endpoint.url
          : "";
      try {
        if (
          endpoint === null ||
          typeof endpoint !== "object" ||
          typeof endpoint.url !== "string"
        ) {
          throw new Error(
            `cannot deliver settlement webhook to many endpoints: endpoints[${index}] must be an object with a string url and a secret`,
          );
        }
        assertSecret(endpoint.secret);
        const webhook: SettlementWebhook = {
          payload,
          signature: sign(body, endpoint.secret),
        };
        const result = await deliverSettlementWebhook(endpoint.url, webhook, {
          retries: endpoint.retries ?? opts.retries,
          backoffMs: endpoint.backoffMs ?? opts.backoffMs,
          timeoutMs: endpoint.timeoutMs ?? opts.timeoutMs,
          maxRetryDelayMs: endpoint.maxRetryDelayMs ?? opts.maxRetryDelayMs,
          signal: endpoint.signal ?? opts.signal,
        });
        return { url, ok: true, attempts: result.attempts, status: result.status };
      } catch (err) {
        // Per-endpoint failures (invalid URL, empty secret, invalid
        // per-endpoint override, exhausted retries, aborts) fail only
        // this endpoint. Attempts/status ride on the delivery errors
        // themselves (see withDeliveryOutcome); pre-flight failures
        // made zero requests.
        const annotated = err as Partial<DeliveryError>;
        return {
          url,
          ok: false,
          attempts:
            typeof annotated.attempts === "number" ? annotated.attempts : 0,
          ...(typeof annotated.status === "number"
            ? { status: annotated.status }
            : {}),
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
  const delivered = results.filter((r) => r.ok).length;
  return { results, delivered, failed: results.length - delivered };
}

/**
 * One POST attempt with a per-attempt timeout. Network errors propagate.
 * An external `signal`, when provided, aborts the same request controller
 * as the timeout: an abort triggered by the caller surfaces as
 * `webhook delivery aborted`, distinct from the timeout error.
 */
async function postOnce(
  target: URL,
  signature: string,
  body: string,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref();
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, {
        once: true,
      });
    }
  }
  try {
    return await fetch(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Signature": signature,
      },
      body,
      signal: controller.signal,
      // Never follow redirects. The WHATWG default ("follow") would silently
      // re-POST the signed payload to the redirect target URL (a third party
      // for a hijacked or misconfigured endpoint), and the retry loop below
      // could then report the *target's* 2xx as a successful delivery. With
      // "manual" the 3xx response itself is returned and falls into the
      // not-retried branch: the caller sees the redirect and fixes the URL.
      redirect: "manual",
    });
  } catch (err) {
    if (timedOut) {
      throw new Error(`webhook delivery timed out after ${timeoutMs}ms`);
    }
    if (externalSignal?.aborted) {
      throw new Error("webhook delivery aborted");
    }
    throw err;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}
