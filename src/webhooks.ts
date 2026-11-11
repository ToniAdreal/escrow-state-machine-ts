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
 *   the signed payload with the `X-Signature` header plus an `X-Event-Id`
 *   header and an `Idempotency-Key` header, both carrying the payload's
 *   `eventId`, a per-attempt timeout,
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
import type {
  PartyRole,
  SettlementOutcome,
  SettlementReport,
  SettlementReportResult,
} from "./settlementReport.js";

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
  /**
   * Settlement outcome, copied verbatim from the report — including
   * `"partially-released"` for a FUNDED escrow reported on one released
   * slice (the payload then carries the slice's party ledgers and the
   * still-locked remainder on the sponsor's row, exactly as the report
   * does; receivers that settle on the amount that actually left escrow
   * should read the report's `partialSettlement.released`, not the
   * payload's totals).
   */
  outcome: SettlementOutcome;
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
  /**
   * ISO 4217 alpha-3 currency code copied verbatim from
   * `SettlementReport.currency`, when the report carries one. Present
   * only then: currency-less reports keep the legacy payload shape
   * exactly. It sits after `deposit` in the canonical key order and is
   * covered by the signature, so changing it (or stripping it) fails
   * verification. A label only — no conversion is performed anywhere.
   */
  currency?: string;
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

  // Same currency rule as the report builder (mirrored here so a
  // hand-built report carrying a mistyped code can never be signed and
  // shipped): three uppercase letters, or the key absent. Reports built
  // by buildSettlementReport already passed this check, so this only
  // fires for caller-assembled reports.
  if (
    report.currency !== undefined &&
    (typeof report.currency !== "string" || !/^[A-Z]{3}$/.test(report.currency))
  ) {
    const shown =
      typeof report.currency === "string"
        ? JSON.stringify(report.currency)
        : String(report.currency);
    throw new Error(
      `cannot build settlement webhook: invalid settlement currency for ${report.escrowId}: ${shown} must be a 3-letter uppercase ISO 4217 code (e.g. "USD")`,
    );
  }

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
    // Same omission rule as releasePath: a currency-less report keeps
    // the legacy payload shape, so pinned field-set tests for legacy
    // payloads stay exact.
    ...(report.currency !== undefined ? { currency: report.currency } : {}),
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

/** Options for {@link buildSettlementWebhooks}. */
export interface BuildSettlementWebhooksOptions {
  /** HMAC secret shared by every webhook in the batch; must not be empty. */
  secret: string | Buffer;
  /**
   * Payload `at` timestamp shared by every webhook in the batch.
   * Resolved once per call (defaults to the real clock at call time,
   * passed through to each single build) so a batch is a coherent
   * snapshot point, not N builds with drifting timestamps. An invalid
   * value is a call-level configuration error and throws for the whole
   * batch, exactly as an empty secret does.
   */
  now?: Date | string;
  /**
   * Generation strategy for per-report `eventId`s: called once per
   * report, in input order, and its return value becomes that report's
   * `eventId`. Defaults to `crypto.randomUUID()` per report. This is
   * deliberately a factory, not a fixed string like the single build's
   * `eventId`: every settlement in the batch is a DISTINCT event, so a
   * batch must never reuse one `eventId` across reports, or receivers
   * deduplicating on `eventId` would drop all but the first settlement
   * as apparent duplicates. A factory that returns a non-string or
   * empty value fails only that report (the single-build validation
   * runs per report); a non-function value is a call-level
   * configuration error and throws. A factory that returns an `eventId`
   * already issued earlier in the same batch is caught here, not by
   * the receiver: that later report fails as `{ escrowId, error }`
   * with a `duplicate eventId` message, is never signed, and does not
   * block later reports (see the `eventId` semantics paragraph on
   * {@link buildSettlementWebhooks}).
   */
  eventIdFactory?: () => string;
}

/**
 * Per-escrow outcome of {@link buildSettlementWebhooks}: exactly one of
 * `webhook` / `error` is set (the {@link SettlementReportResult} shape).
 */
export type BuildSettlementWebhooksResult =
  | { escrowId: string; webhook: SettlementWebhook; error?: undefined }
  | { escrowId: string; webhook?: undefined; error: string };

/**
 * Batch settlement webhook building: build one signed webhook per
 * report from the {@link SettlementReportResult} list that
 * `buildSettlementReports` returns — pipe its output straight in, no
 * hand-written loop and no pre-filtering of the success entries:
 *
 * ```ts
 * const results = buildSettlementReports(inputsList);
 * const webhooks = buildSettlementWebhooks(results, { secret });
 * ```
 *
 * This exists because a hand-written loop over
 * {@link buildSettlementWebhook} has the same trap the other batch
 * wrappers fixed: the single-report function throws on the first bad
 * report, aborting the whole batch and leaving the caller to
 * re-implement per-item isolation. Here each entry is attempted
 * independently: an entry that already carries an `error` from
 * `buildSettlementReports` (no report was produced) is forwarded as
 * `{ escrowId, error }` with its original message, a structurally
 * broken report fails as `{ escrowId, error }` with the caught error's
 * message, and neither blocks later entries. The result has one entry
 * per input, in input order, each carrying that entry's `escrowId`.
 *
 * Call-level configuration errors DO throw before any report is
 * attempted — those are caller bugs, not per-report outcomes: a
 * non-array input, a missing/empty secret, an invalid shared `now`, or
 * a non-function `eventIdFactory`.
 *
 * `eventId` semantics: one DISTINCT `eventId` per report (see
 * {@link BuildSettlementWebhooksOptions.eventIdFactory}); the shared
 * elements are the generation strategy, the secret, and the `now`
 * timestamp, never the value. Each built webhook verifies under the
 * batch secret exactly as a single build does.
 *
 * Duplicate detection: the batch keeps the set of `eventId`s it has
 * already issued (successfully signed) in this call. When the factory
 * returns an `eventId` already in that set, that report is NOT signed
 * and instead fails as `{ escrowId, error }` with
 * `duplicate eventId "<id>" in batch: eventIds must be unique within
 * a batch`, and later reports are still attempted — the per-item
 * isolation above applies to duplicates too. Only issued ids are
 * recorded: a report whose build fails (a non-string/empty factory
 * value, a structurally broken report) never claims its `eventId`, so
 * a later report may legitimately reuse that value. Forwarded error
 * entries from `buildSettlementReports` never call the factory, so
 * they consume no `eventId` and cannot mask a later duplicate.
 *
 * One exception to per-item isolation: a repeated `escrowId` aborts
 * the whole batch, exactly like {@link buildSettlementReports}
 * (backlog #993). Two entries for the same escrow would produce two
 * signed webhooks with different `eventId`s for one settlement, and a
 * receiver deduplicating on `eventId` could not tell they are the
 * same settlement — so the batch fails closed before building
 * anything, throwing an error naming the duplicate id(s) and
 * producing no webhooks at all. This is a caller bug (a mistyped
 * batch list), not a per-report failure, so it is a throw, not a
 * per-entry error. The single-report {@link buildSettlementWebhook}
 * is unaffected: calling it twice for the same escrow is legitimate.
 *
 * Pure: building never mutates any report, and this wrapper adds no
 * mutation of its own — the input list and its entries are only read.
 *
 * Honest limit: this builds signed payloads only. It is a signing
 * primitive, not delivery — nothing is POSTed, queued, or retried
 * here; use {@link deliverSettlementWebhook} per built webhook for
 * that.
 */
export function buildSettlementWebhooks(
  results: readonly SettlementReportResult[],
  options: BuildSettlementWebhooksOptions,
): BuildSettlementWebhooksResult[] {
  if (!Array.isArray(results)) {
    throw new Error(
      "cannot build settlement webhooks: results must be an array",
    );
  }
  // Call-level configuration, validated once up front: an empty or
  // missing secret would fail every report identically, so it throws
  // for the whole batch instead of being recorded per report.
  if (
    !options ||
    (typeof options.secret !== "string" && !Buffer.isBuffer(options.secret))
  ) {
    throw new Error(
      "cannot build settlement webhooks: signing secret must be a string or Buffer",
    );
  }
  assertSecret(options.secret);
  if (
    options.eventIdFactory !== undefined &&
    typeof options.eventIdFactory !== "function"
  ) {
    throw new Error(
      "cannot build settlement webhooks: 'eventIdFactory' must be a function",
    );
  }
  if (
    options.now !== undefined &&
    Number.isNaN(new Date(options.now).getTime())
  ) {
    throw new Error(
      "cannot build settlement webhooks: invalid 'now' timestamp",
    );
  }
  // Duplicate escrowIds fail the whole batch before anything is built
  // (the buildSettlementReports guard, backlog #993): two entries for
  // one escrow would sign two webhooks with different eventIds for the
  // same settlement, and a receiver deduplicating on eventId could not
  // tell they are the same settlement. Only string ids are scanned — a
  // malformed entry with no string id keeps its per-entry failure
  // below, exactly as before.
  const seenIds = new Set<string>();
  const duplicateIds: string[] = [];
  for (const entry of results) {
    const id =
      entry !== null &&
      typeof entry === "object" &&
      typeof entry.escrowId === "string"
        ? entry.escrowId
        : undefined;
    if (id === undefined) continue;
    if (seenIds.has(id)) {
      if (!duplicateIds.includes(id)) {
        duplicateIds.push(id);
      }
    } else {
      seenIds.add(id);
    }
  }
  if (duplicateIds.length > 0) {
    const quoted = duplicateIds.map((id) => `"${id}"`).join(", ");
    throw new Error(
      `buildSettlementWebhooks: duplicate escrowId ${quoted} in batch: escrowIds must be unique within a batch (a repeated escrow would produce two signed settlement webhooks with different eventIds, and a receiver deduplicating on eventId could not tell they are the same settlement)`,
    );
  }
  const eventIdFactory = options.eventIdFactory ?? randomUUID;
  // eventIds already issued (successfully signed) in this batch only:
  // a failed build never claims its id, so a later report may reuse it.
  const issuedEventIds = new Set<string>();
  return results.map((entry) => {
    const escrowId =
      entry !== null &&
      typeof entry === "object" &&
      typeof entry.escrowId === "string"
        ? entry.escrowId
        : "unknown";
    // An entry buildSettlementReports already failed carries no report:
    // forward its error untouched instead of inventing a new one.
    if (!entry || typeof entry !== "object" || !entry.report) {
      const message =
        entry && typeof entry.error === "string" && entry.error.length > 0
          ? entry.error
          : "cannot build settlement webhook: missing settlement report";
      return { escrowId, error: message };
    }
    try {
      const eventId = eventIdFactory();
      // A factory bug (counter reset, fixed value) must not ship two
      // signed webhooks under one eventId: the receiver's dedupe would
      // drop the second settlement as an apparent duplicate while the
      // sender believes it delivered. The duplicate is never signed,
      // and later entries are still attempted.
      if (issuedEventIds.has(eventId)) {
        return {
          escrowId,
          error: `duplicate eventId "${eventId}" in batch: eventIds must be unique within a batch`,
        };
      }
      const webhook = buildSettlementWebhook(entry.report, {
        secret: options.secret,
        ...(options.now !== undefined ? { now: options.now } : {}),
        eventId,
      });
      issuedEventIds.add(eventId);
      return { escrowId, webhook };
    } catch (err) {
      return {
        escrowId,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
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
 * Serializable snapshot of a {@link SettlementEventDedupe}, produced by
 * `exportSnapshot()` and consumed by `SettlementEventDedupe.restore()`.
 *
 * - `v`: snapshot format version. Only `1` exists; `restore` rejects
 *   any other value (including a missing `v`) instead of guessing.
 * - `entries`: `[eventId, seenAtMs]` pairs in LRU order (least
 *   recently seen first). `seenAtMs` is a millisecond timestamp in the
 *   same unit as `SettlementEventDedupeOptions.now` — the original
 *   first-seen time, *not* the export time, so a restored id keeps
 *   counting down its original TTL instead of getting a fresh window.
 *   Only entries still live at export time are included.
 *
 * The observability counters (`hits`/`misses`/`evictions`) are *not*
 * part of the snapshot: a restored dedupe starts them at zero.
 *
 * The snapshot is plain JSON data (`JSON.stringify` it to persist
 * it), but it is not a shared store: two processes restoring the same
 * snapshot afterwards diverge, and ids recorded by one are invisible
 * to the other. Multi-instance deployments still need shared storage.
 */
export interface SettlementEventDedupeSnapshot {
  v: 1;
  entries: Array<[eventId: string, seenAtMs: number]>;
}

/**
 * Integrity-protected form of a {@link SettlementEventDedupeSnapshot},
 * produced by `SettlementEventDedupe.exportSignedSnapshot(secret)` and
 * consumed by `SettlementEventDedupe.restoreSignedSnapshot(envelope,
 * secret, opts?)` (see those methods for the exact contract). Same
 * envelope shape as the sibling rfc9421 `ReplayCache` signed snapshot
 * (`ReplayCacheSignedSnapshotEnvelope`).
 *
 * - `v`: envelope format version. Only `1` exists; restore rejects
 *   any other value (including a missing `v`) instead of guessing.
 * - `snapshot`: the wrapped {@link SettlementEventDedupeSnapshot},
 *   exactly as `exportSnapshot()` produces it (live ids only, with
 *   their original first-seen timestamps).
 * - `mac`: lowercase hex HMAC-SHA256 over the canonical JSON of
 *   `snapshot` (object keys sorted recursively, array order
 *   preserved) under the caller's secret.
 *
 * The envelope carries no secret: the secret is caller configuration,
 * never persisted in the envelope, and the same secret must be
 * supplied at restore time. An envelope with any other field is
 * rejected, so a caller cannot smuggle extra data (including a
 * secret) past restore. The MAC is integrity protection only — it
 * proves the snapshot was not rewritten by anyone without the
 * secret — not confidentiality: the eventIds inside are not secrets
 * (they are wire-visible values from signed webhooks), and the
 * envelope itself is plain JSON. A caller that needs the snapshot
 * kept private must encrypt it separately; this envelope does not.
 */
export interface SettlementEventDedupeSignedSnapshotEnvelope {
  v: 1;
  snapshot: SettlementEventDedupeSnapshot;
  mac: string;
}

/**
 * Canonical JSON for snapshot MACing: object keys sorted
 * recursively (so a JSON round-trip that reorders keys still
 * verifies), array order preserved (reordering entries would change
 * which id wins a duplicate, so it must change the MAC), and
 * primitives via `JSON.stringify`. A non-JSON value (notably
 * `undefined`, which `JSON.stringify` would silently drop) throws
 * instead of being silently normalized — a MAC computed over a
 * silently altered document would be worse than no MAC.
 * Same semantics as the sibling rfc9421 `ReplayCache` signed
 * snapshot's canonical form. (Named distinctly from the
 * payload-shaped `canonicalJson` above, which only handles
 * `SettlementWebhookPayload`.)
 */
function canonicalJsonForSnapshot(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error(
        "SettlementEventDedupe: cannot canonicalize a non-finite number for snapshot signing",
      );
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalJsonForSnapshot(entry)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJsonForSnapshot(record[key])}`)
      .join(",")}}`;
  }
  throw new Error(
    `SettlementEventDedupe: cannot canonicalize a non-JSON value of type ${typeof value} for snapshot signing`,
  );
}

/**
 * Validate a signed-snapshot secret and return its bytes. A secret
 * is a non-empty string (UTF-8) or a non-empty `Buffer` — the same
 * input shapes as the sibling `ReplayCache` helper, and deliberately
 * without a length floor: this MAC is integrity protection for a
 * list of already wire-visible eventIds, and the backlog contract
 * for this helper rejects only an empty secret, so a shorter caller
 * secret is the caller's risk to take (use a long random secret;
 * the envelope never records how long it was). An empty or
 * wrongly typed secret is a caller-configuration error, thrown
 * before any store state is touched.
 */
function signedSnapshotSecretBytes(secret: unknown): Buffer {
  if (typeof secret === "string") {
    if (secret.length === 0)
      throw new Error(
        "SettlementEventDedupe: signed snapshot secret must not be empty",
      );
    return Buffer.from(secret, "utf8");
  }
  if (Buffer.isBuffer(secret)) {
    if (secret.length === 0)
      throw new Error(
        "SettlementEventDedupe: signed snapshot secret must not be empty",
      );
    return secret;
  }
  throw new Error(
    `SettlementEventDedupe: signed snapshot secret must be a non-empty string or Buffer, got ${typeof secret}`,
  );
}

/** HMAC-SHA256 (hex) over the canonical JSON of a snapshot. */
function computeSnapshotMac(
  snapshot: SettlementEventDedupeSnapshot,
  secretBytes: Buffer,
): string {
  return createHmac("sha256", secretBytes)
    .update(canonicalJsonForSnapshot(snapshot), "utf8")
    .digest("hex");
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
 * other's records. A single process *can* carry its recorded ids
 * across its own restart: `exportSnapshot()` before shutdown and
 * `SettlementEventDedupe.restore()` at startup (see
 * {@link SettlementEventDedupeSnapshot}) — but that covers only the
 * process that saved the snapshot, never a fleet. The unsigned
 * snapshot is trusted configuration: prefer
 * `exportSignedSnapshot(secret)` /
 * `restoreSignedSnapshot(envelope, secret)` (see
 * {@link SettlementEventDedupeSignedSnapshotEnvelope}) whenever the
 * persisted file can be rewritten by anyone without the secret —
 * a rewritten unsigned snapshot silently reopens the
 * double-settlement window or discards legitimate settlements.
 * A deployment with
 * multiple receiver processes must deduplicate over shared storage
 * (a database unique constraint, Redis, …) instead. Within one
 * process the store is exact: an id is a duplicate if and only if
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
   * Export the live recorded ids as a detached, JSON-serializable
   * {@link SettlementEventDedupeSnapshot}: persist it before a restart
   * and pass it to `SettlementEventDedupe.restore()` at startup so the
   * restart does not reopen the deduplication window for ids seen
   * inside their TTL — exactly when a deploy or scale-out would
   * otherwise let a settlement event be recorded twice.
   *
   * Entries already expired against this dedupe's clock are excluded.
   * The returned object (including every entry pair) is a fresh copy —
   * mutating it does not affect this store.
   */
  exportSnapshot(): SettlementEventDedupeSnapshot {
    const t = this.clock();
    const entries: Array<[string, number]> = [];
    for (const [eventId, at] of this.seenAt) {
      if (t - at < this.ttlMs) entries.push([eventId, at]);
    }
    return { v: 1, entries };
  }

  /**
   * Export the current snapshot wrapped in an HMAC-signed envelope
   * (see {@link SettlementEventDedupeSignedSnapshotEnvelope}):
   * `{ v: 1, snapshot, mac }` where `mac` is HMAC-SHA256 over the
   * canonical JSON of the snapshot under `secret`. Persist the
   * envelope (plain JSON) before a restart and restore it with
   * {@link SettlementEventDedupe.restoreSignedSnapshot} — a process
   * that restarts keeps rejecting eventIds seen inside their TTL,
   * and anyone who rewrites the persisted entries without the
   * secret is caught at restore instead of silently reopening the
   * double-settlement window (deleting a consumed id) or silently
   * discarding a legitimate settlement (injecting a forged id).
   *
   * The secret is never written into the envelope, and the envelope
   * is integrity protection only, not encryption: the eventIds
   * inside are wire-visible values, so the envelope itself needs no
   * secrecy, but the secret must be kept where the snapshot writer
   * keeps its other signing-side secrets. An empty secret is a
   * caller-configuration error. The unsigned `exportSnapshot()`
   * path is unchanged: this envelope is opt-in, and a caller that
   * never signs keeps the old trusted-configuration semantics.
   */
  exportSignedSnapshot(
    secret: string | Buffer,
  ): SettlementEventDedupeSignedSnapshotEnvelope {
    const secretBytes = signedSnapshotSecretBytes(secret);
    const snapshot = this.exportSnapshot();
    return { v: 1, snapshot, mac: computeSnapshotMac(snapshot, secretBytes) };
  }

  /**
   * Rebuild a dedupe from a snapshot produced by `exportSnapshot()`
   * (typically after a `JSON.parse` of the persisted form). `opts`
   * configures the *new* dedupe (`ttlMs`/`maxEntries`/`now`) and is
   * validated exactly like the constructor's.
   *
   * The input is untrusted data and is validated strictly: a
   * non-object snapshot, an unknown top-level field, a `v` other than
   * `1`, a non-array `entries`, or a malformed entry (not an
   * `[eventId, seenAtMs]` pair, an empty/non-string `eventId`, a
   * non-finite or negative `seenAtMs`) throws — a corrupt snapshot
   * fails loudly at startup rather than silently disabling
   * deduplication.
   *
   * Entries already expired against the new dedupe's clock are
   * dropped. If the surviving entries exceed `maxEntries`, the oldest
   * by `seenAtMs` are evicted first until the store fits (ties break
   * by snapshot order, least recently seen first). Duplicate ids
   * collapse to their last occurrence. TTLs keep counting from each
   * entry's original `seenAtMs` — restoring never extends an id's
   * deduplication window. Observability counters start at zero: the
   * load-time drops above are not counted as `evictions`.
   *
   * This covers a single process across its own restart only; see
   * {@link SettlementEventDedupeSnapshot} for the multi-instance limit.
   */
  static restore(
    snapshot: unknown,
    opts: SettlementEventDedupeOptions = {},
  ): SettlementEventDedupe {
    const fail = (detail: string): never => {
      throw new Error(`SettlementEventDedupe: invalid snapshot: ${detail}`);
    };
    if (
      typeof snapshot !== "object" ||
      snapshot === null ||
      Array.isArray(snapshot)
    )
      fail("expected an object of the form { v: 1, entries: [...] }");
    const record = snapshot as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== "v" && key !== "entries") fail(`unknown field "${key}"`);
    }
    if (record.v !== 1)
      fail(
        `unsupported snapshot version ${JSON.stringify(record.v) ?? String(record.v)} (expected 1)`,
      );
    const rawEntries: unknown = record.entries;
    if (!Array.isArray(rawEntries)) fail("entries must be an array");
    const entriesList = rawEntries as unknown[];
    const parsed: Array<[string, number]> = [];
    for (let i = 0; i < entriesList.length; i++) {
      const entry: unknown = entriesList[i];
      if (!Array.isArray(entry) || entry.length !== 2)
        fail(`entries[${i}] must be a [eventId, seenAtMs] pair`);
      const pair = entry as unknown[];
      const eventId: unknown = pair[0];
      const seenAtMs: unknown = pair[1];
      if (typeof eventId !== "string" || eventId === "")
        fail(`entries[${i}]: eventId must be a non-empty string`);
      if (
        typeof seenAtMs !== "number" ||
        !Number.isFinite(seenAtMs) ||
        seenAtMs < 0
      )
        fail(
          `entries[${i}]: seenAtMs must be a finite non-negative number (milliseconds)`,
        );
      parsed.push([eventId as string, seenAtMs as number]);
    }

    const dedupe = new SettlementEventDedupe(opts);
    const t = dedupe.clock();
    // Drop entries whose TTL already ran out against the new clock, and
    // collapse duplicate ids to their last occurrence (position and
    // timestamp), mirroring the recency refresh in `checkAndRecord`.
    const live = new Map<string, number>();
    for (const [eventId, at] of parsed) {
      if (t - at >= dedupe.ttlMs) continue;
      live.delete(eventId);
      live.set(eventId, at);
    }
    let kept = [...live.entries()];
    if (kept.length > dedupe.maxEntries) {
      const excess = kept.length - dedupe.maxEntries;
      const drop = new Set(
        kept
          .map((_, i) => i)
          .sort((a, b) => kept[a][1] - kept[b][1] || a - b)
          .slice(0, excess),
      );
      kept = kept.filter((_, i) => !drop.has(i));
    }
    for (const [eventId, at] of kept) dedupe.seenAt.set(eventId, at);
    return dedupe;
  }

  /** Alias of {@link SettlementEventDedupe.restore} (snapshot naming). */
  static fromSnapshot(
    snapshot: unknown,
    opts: SettlementEventDedupeOptions = {},
  ): SettlementEventDedupe {
    return SettlementEventDedupe.restore(snapshot, opts);
  }

  /**
   * Rebuild a dedupe from a signed envelope produced by
   * {@link SettlementEventDedupe.exportSignedSnapshot} (typically
   * after a `JSON.parse` of the persisted form). `opts` configures
   * the *new* dedupe (`ttlMs`/`maxEntries`/`now`) and is validated
   * exactly like the constructor's. The returned dedupe is a fresh
   * object — nothing is installed into any existing dedupe, so a
   * failed restore leaves the caller's dedupes untouched (and their
   * `stats()` counters unmoved: a failed restore counts nothing).
   *
   * Restore is fail-closed in the same order as the unsigned path,
   * with authenticity checked first: an envelope with an unknown
   * field (including a smuggled `secret`), a version other than
   * `1`, a malformed `mac`, or a MAC that does not match the
   * snapshot under `secret` throws a descriptive configuration
   * `Error` and no dedupe is produced — a tampered entry, a tampered
   * `seenAtMs`, or a wrong secret all fail here, before any snapshot
   * parsing, so a tampered envelope can never partially install. A
   * MAC-valid envelope whose snapshot is itself malformed then
   * fails through the same strict snapshot validation as
   * {@link SettlementEventDedupe.restore}, again with no dedupe
   * produced. The MAC comparison is constant-time over equal-length
   * hex digests; a wrong-length `mac` is rejected as malformed
   * before comparison.
   *
   * On success the semantics are exactly
   * {@link SettlementEventDedupe.restore}'s: expired entries are
   * dropped, over-capacity snapshots keep the newest entries, TTLs
   * keep counting from each entry's original `seenAtMs`, and the
   * observability counters start at zero.
   *
   * The unsigned `restore()` and this signed restore do not accept
   * each other's input: an unsigned snapshot has no `mac` (and an
   * `entries` field where the envelope expects `snapshot`), and a
   * signed envelope has fields the unsigned path rejects — so a
   * caller cannot silently downgrade a signed restore to the
   * trusted-configuration path.
   */
  static restoreSignedSnapshot(
    envelope: unknown,
    secret: string | Buffer,
    opts: SettlementEventDedupeOptions = {},
  ): SettlementEventDedupe {
    const secretBytes = signedSnapshotSecretBytes(secret);
    const fail = (detail: string): never => {
      throw new Error(
        `SettlementEventDedupe: invalid signed snapshot envelope: ${detail}`,
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
      if (key !== "v" && key !== "snapshot" && key !== "mac")
        fail(`unknown field "${key}"`);
    }
    if (record.v !== 1)
      fail(
        `unsupported envelope version ${JSON.stringify(record.v) ?? String(record.v)} (expected 1)`,
      );
    const mac = record.mac;
    if (typeof mac !== "string" || !/^[0-9a-f]{64}$/.test(mac))
      throw new Error(
        "SettlementEventDedupe: invalid signed snapshot envelope: mac must be a 64-character lowercase hex HMAC-SHA256 digest",
      );
    const snapshot = record.snapshot;
    if (
      typeof snapshot !== "object" ||
      snapshot === null ||
      Array.isArray(snapshot)
    )
      fail('"snapshot" must be an object');
    const expectedMac = computeSnapshotMac(
      snapshot as SettlementEventDedupeSnapshot,
      secretBytes,
    );
    const macBytes = Buffer.from(mac, "hex");
    const expectedBytes = Buffer.from(expectedMac, "hex");
    if (
      macBytes.length !== expectedBytes.length ||
      !timingSafeEqual(macBytes, expectedBytes)
    )
      throw new Error(
        "SettlementEventDedupe: signed snapshot MAC mismatch: the snapshot was tampered with or the secret is wrong",
      );
    // MAC verified — now the same strict structural validation as restore().
    return SettlementEventDedupe.restore(snapshot, opts);
  }

  /** Alias of {@link SettlementEventDedupe.restoreSignedSnapshot} (snapshot naming). */
  static fromSignedSnapshot(
    envelope: unknown,
    secret: string | Buffer,
    opts: SettlementEventDedupeOptions = {},
  ): SettlementEventDedupe {
    return SettlementEventDedupe.restoreSignedSnapshot(envelope, secret, opts);
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
/* Sender-side delivery-failure ledger (outbox + dead letter)          */
/* ------------------------------------------------------------------ */

/** Options for {@link SettlementWebhookOutbox}. All fields optional. */
export interface SettlementWebhookOutboxOptions {
  /**
   * Consecutive failures after which a `(endpoint, eventId)` pair is
   * considered exhausted and moves from `pending()` to `deadLetter()`.
   * Defaults to 3. Must be a positive integer (>= 1).
   */
  maxAttempts?: number;
  /**
   * Clock source (milliseconds since the epoch). Defaults to
   * `Date.now`. Inject a fake clock for deterministic tests; it is
   * also the default timestamp for attempts recorded without an
   * explicit `at`.
   */
  now?: () => number;
}

/**
 * Maximum length, in characters, of the `lastError` text a
 * {@link SettlementWebhookOutbox} keeps per `(endpoint, eventId)`
 * pair. `recordAttempt()` truncates a longer `error` to exactly this
 * many characters (see {@link truncateOutboxError}) before storing
 * it, so one oversized failure — a full HTML error page, a long
 * stack trace — cannot bloat the failure ledger or the snapshot
 * (signed or unsigned) exported from it.
 *
 * Why 1024: `lastError` is a diagnostic hint for the human who reads
 * the dead letter, not the failure itself — the first kilobyte of an
 * error message carries the cause in practice, and a 1024-character
 * ceiling keeps a 1,000-pair ledger under ~1 MB of error text even
 * if every pair failed with a maximal message. Callers that need the
 * full error body should log it where the delivery happened, before
 * handing the short form to the outbox. This mirrors the audit
 * log's {@link MAX_NOTE_LENGTH} precedent (a hard cap on
 * caller-supplied text at the point it enters the record), at a
 * smaller value because an error hint needs less room than a note.
 */
export const MAX_OUTBOX_ERROR_LENGTH = 1024;

/** Marker appended to a truncated outbox error (12 characters). */
const OUTBOX_ERROR_TRUNCATION_MARKER = "…[truncated]";

/**
 * Truncate an outbox error to {@link MAX_OUTBOX_ERROR_LENGTH}
 * characters. Errors at or under the cap pass through byte-for-byte
 * (the returned string is the input string); longer ones keep their
 * first `MAX_OUTBOX_ERROR_LENGTH - marker.length` characters and end
 * with `…[truncated]`, so a truncated value is always recognizable
 * as truncated and its total length is exactly the cap.
 */
export function truncateOutboxError(error: string): string {
  if (error.length <= MAX_OUTBOX_ERROR_LENGTH) return error;
  return (
    error.slice(
      0,
      MAX_OUTBOX_ERROR_LENGTH - OUTBOX_ERROR_TRUNCATION_MARKER.length,
    ) + OUTBOX_ERROR_TRUNCATION_MARKER
  );
}

/**
 * One delivery attempt recorded in a {@link SettlementWebhookOutbox}.
 * This is the input shape for `recordAttempt()` — it describes a
 * single outcome, not the accumulated record (see
 * {@link SettlementWebhookOutboxEntry}).
 */
export interface SettlementWebhookOutboxAttempt {
  /** Destination URL the attempt was made against. */
  endpoint: string;
  /** `eventId` of the settlement event the attempt carried. */
  eventId: string;
  /** Whether the attempt succeeded (2xx). */
  ok: boolean;
  /**
   * HTTP status of the attempt, when known. A network failure has no
   * status — pass `error` instead. Informational only; the outbox
   * never retries on its own.
   */
  status?: number;
  /**
   * Human-readable failure reason (error message, status text).
   * `recordAttempt()` stores at most
   * {@link MAX_OUTBOX_ERROR_LENGTH} characters of it (see
   * {@link truncateOutboxError}); pass the full text here and let
   * the outbox cap it, or log the full body where the delivery
   * happened and pass the short form.
   */
  error?: string;
  /**
   * Attempt time in milliseconds since the epoch. Defaults to the
   * outbox clock (`now`). Inject it for deterministic tests or to
   * record an attempt that happened earlier.
   */
  at?: number | undefined;
}

/**
 * One accumulated failure record in a {@link SettlementWebhookOutbox},
 * as returned by `pending()` and `deadLetter()`.
 *
 * - `attempts`: consecutive failures recorded for this
 *   `(endpoint, eventId)` pair since the last success. A pair is
 *   pending while `attempts < maxAttempts` and dead-lettered once
 *   `attempts >= maxAttempts`.
 * - `lastError`: the `error` of the most recent failed attempt, when
 *   the caller supplied one, truncated to
 *   {@link MAX_OUTBOX_ERROR_LENGTH} characters at record time (see
 *   {@link truncateOutboxError}) — a truncated value ends with
 *   `…[truncated]` and is exactly the cap long.
 * - `lastAt`: timestamp (ms since the epoch) of the most recent
 *   failed attempt.
 */
export interface SettlementWebhookOutboxEntry {
  endpoint: string;
  eventId: string;
  attempts: number;
  lastError?: string;
  lastAt: number;
}

/**
 * Serializable snapshot of a {@link SettlementWebhookOutbox}, produced
 * by `exportSnapshot()` and consumed by
 * `SettlementWebhookOutbox.restore()`.
 *
 * - `v`: snapshot format version. Only `1` exists; `restore` rejects
 *   any other value (including a missing `v`) instead of guessing.
 * - `entries`: one object per tracked `(endpoint, eventId)` pair, in
 *   first-recorded order. `attempts` is the consecutive-failure count;
 *   whether an entry reads as pending or dead-lettered after restore
 *   is derived from `attempts` against the *restoring* outbox's
 *   `maxAttempts`, so a snapshot restored under a different
 *   `maxAttempts` re-derives the boundary honestly. `lastError` is
 *   omitted when the last recorded failure carried none.
 *
 * The snapshot is plain JSON data (`JSON.stringify` it to persist
 * it). It is an unsigned, trusted-configuration snapshot in the same
 * posture as `SettlementEventDedupe.exportSnapshot()`: a process that
 * restarts from its own snapshot keeps the failure counts it had, but
 * anyone able to rewrite the persisted file can silently clear a
 * dead letter (or invent failures) without detection. Persist it
 * where the webhook configuration itself is trusted, and do not treat
 * the snapshot as evidence about a third party.
 */
export interface SettlementWebhookOutboxSnapshot {
  v: 1;
  entries: SettlementWebhookOutboxEntry[];
}

/**
 * Integrity-protected form of a {@link SettlementWebhookOutboxSnapshot},
 * produced by `SettlementWebhookOutbox.exportSignedSnapshot(secret)` and
 * consumed by `SettlementWebhookOutbox.restoreSignedSnapshot(envelope,
 * secret, opts?)` (see those methods for the exact contract). Same
 * envelope shape as the sibling `SettlementEventDedupe` signed snapshot
 * (`SettlementEventDedupeSignedSnapshotEnvelope`, backlog #1010) and
 * the rfc9421 `ReplayCache` signed snapshot.
 *
 * - `v`: envelope format version. Only `1` exists; restore rejects
 *   any other value (including a missing `v`) instead of guessing.
 * - `snapshot`: the wrapped {@link SettlementWebhookOutboxSnapshot},
 *   exactly as `exportSnapshot()` produces it.
 * - `mac`: lowercase hex HMAC-SHA256 over the canonical JSON of
 *   `snapshot` (object keys sorted recursively, array order
 *   preserved) under the caller's secret.
 *
 * Why this exists: the unsigned snapshot is trusted configuration —
 * anyone able to rewrite the persisted file can silently clear a
 * dead letter (a failed delivery is then retried forever, or a
 * dead-lettered pair is resurrected as pending) or inflate an
 * `attempts` count (a pair that still deserves retries is pushed
 * into the dead letter and never retried). The envelope MAC covers
 * the whole snapshot, so any such rewrite fails closed at restore.
 *
 * The envelope carries no secret: the secret is caller configuration,
 * never persisted in the envelope, and the same secret must be
 * supplied at restore time. An envelope with any other field is
 * rejected, so a caller cannot smuggle extra data (including a
 * secret) past restore. The MAC is integrity protection only — it
 * proves the snapshot was not rewritten by anyone without the
 * secret — not confidentiality: the endpoints and eventIds inside
 * are wire-visible values, and the envelope itself is plain JSON. A
 * caller that needs the snapshot kept private must encrypt it
 * separately; this envelope does not.
 */
export interface SettlementWebhookOutboxSignedSnapshotEnvelope {
  v: 1;
  snapshot: SettlementWebhookOutboxSnapshot;
  mac: string;
}

/**
 * Validate a signed-snapshot secret for the outbox and return its
 * bytes. A secret is a non-empty string (UTF-8) or a non-empty
 * `Buffer` — the same input shapes as the sibling
 * `SettlementEventDedupe` helper, and deliberately without a length
 * floor: this MAC is integrity protection for a persisted failure
 * ledger, and the backlog contract for this helper rejects only an
 * empty secret, so a shorter caller secret is the caller's risk to
 * take (use a long random secret; the envelope never records how
 * long it was). An empty or wrongly typed secret is a
 * caller-configuration error, thrown before any outbox state is
 * touched.
 */
function outboxSignedSnapshotSecretBytes(secret: unknown): Buffer {
  if (typeof secret === "string") {
    if (secret.length === 0)
      throw new Error(
        "SettlementWebhookOutbox: signed snapshot secret must not be empty",
      );
    return Buffer.from(secret, "utf8");
  }
  if (Buffer.isBuffer(secret)) {
    if (secret.length === 0)
      throw new Error(
        "SettlementWebhookOutbox: signed snapshot secret must not be empty",
      );
    return secret;
  }
  throw new Error(
    `SettlementWebhookOutbox: signed snapshot secret must be a non-empty string or Buffer, got ${typeof secret}`,
  );
}

/**
 * HMAC-SHA256 (hex) over the canonical JSON of an outbox snapshot,
 * using the shared {@link canonicalJsonForSnapshot} form (object keys
 * sorted recursively, array order preserved) — the same canonical
 * form as the sibling `SettlementEventDedupe` envelope, so the two
 * envelopes are verified by the same rule.
 */
function computeOutboxSnapshotMac(
  snapshot: SettlementWebhookOutboxSnapshot,
  secretBytes: Buffer,
): string {
  return createHmac("sha256", secretBytes)
    .update(canonicalJsonForSnapshot(snapshot), "utf8")
    .digest("hex");
}

/**
 * In-memory ledger of failed settlement-webhook deliveries, keyed by
 * `(endpoint, eventId)`. `deliverSettlementWebhook` /
 * `deliverSettlementWebhookToMany` only return the outcome of one call
 * — they keep no memory — so a caller whose endpoint fails repeatedly
 * had no ready answer to "which (endpoint, eventId) pairs are still
 * undelivered, and which have exhausted their retries". This class is
 * that answer: record each attempt, ask `pending()` what still needs a
 * retry and `deadLetter()` what needs a human.
 *
 * The outbox records; it never retries on its own. The opt-in
 * {@link retrySettlementWebhookOutbox} runner re-delivers the pending
 * pairs in-process (bounded rounds, exponential backoff, dead letters
 * never retried) for callers that want the loop without hand-writing
 * it; a hand-written loop stays possible too (the caller then owns
 * the backoff policy, the abort signal, and the decision to stop).
 * Either way there is no durable queue and no cross-process retry
 * here, exactly as the README Limitations section says. It is also
 * process-local: a process that dies loses the ledger unless it
 * exported a snapshot first (see
 * {@link SettlementWebhookOutboxSnapshot} for the trusted-configuration
 * caveat), and two processes never see each other's records. The
 * unsigned snapshot is trusted configuration: prefer
 * `exportSignedSnapshot(secret)` /
 * `restoreSignedSnapshot(envelope, secret)` (see
 * {@link SettlementWebhookOutboxSignedSnapshotEnvelope}) whenever the
 * persisted file can be rewritten by anyone without the secret —
 * a rewritten unsigned snapshot silently clears a dead letter or
 * invents failures. A deployment with
 * multiple processes must keep its failure ledger in shared storage
 * (a database outbox table, a queue, …) instead. Within one
 * process the ledger is exact: a pair is pending or dead-lettered
 * exactly as its consecutive-failure count says.
 *
 * Counting rules, mirroring the sibling `SettlementEventDedupe`
 * posture (fail fast on caller bugs, deterministic under an injected
 * clock):
 * - a failed attempt increments the pair's consecutive-failure count
 *   (capped at `maxAttempts` — a dead-lettered pair stays at the cap
 *   while later failures still refresh `lastError`/`lastAt`, so the
 *   record keeps describing the latest failure instead of growing
 *   without bound); the refreshed `lastError` is truncated to
 *   {@link MAX_OUTBOX_ERROR_LENGTH} characters at record time, so
 *   the ledger itself stays bounded too;
 * - a successful attempt (`ok: true`, or `acknowledge()`) removes the
 *   pair entirely, so a later failure starts counting from 1 again;
 * - `pending()` lists pairs with `attempts < maxAttempts`,
 *   `deadLetter()` lists pairs with `attempts >= maxAttempts`; a pair
 *   is in exactly one of the two lists.
 */
export class SettlementWebhookOutbox {
  private readonly maxAttempts: number;
  private readonly clock: () => number;
  /**
   * endpoint -> eventId -> accumulated record. Nested maps (not a
   * joined string key) so no endpoint or eventId text can collide
   * with a separator.
   */
  private readonly records = new Map<
    string,
    Map<string, SettlementWebhookOutboxEntry>
  >();

  constructor(opts: SettlementWebhookOutboxOptions = {}) {
    const maxAttempts = opts.maxAttempts ?? 3;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error(
        "SettlementWebhookOutbox: maxAttempts must be a positive integer",
      );
    }
    if (opts.now !== undefined && typeof opts.now !== "function") {
      throw new Error("SettlementWebhookOutbox: now must be a function");
    }
    this.maxAttempts = maxAttempts;
    this.clock = opts.now ?? Date.now;
  }

  /**
   * Record one delivery attempt. A failed attempt increments the
   * pair's consecutive-failure count (capped at `maxAttempts`) and
   * refreshes `lastError`/`lastAt`; a successful attempt removes the
   * pair, exactly like `acknowledge()`. A supplied `error` longer
   * than {@link MAX_OUTBOX_ERROR_LENGTH} characters is truncated
   * at record time (see {@link truncateOutboxError}), so the stored
   * `lastError` — and any snapshot exported from it — stays bounded.
   *
   * Caller bugs fail fast: an empty/non-string `endpoint` or
   * `eventId`, a non-boolean `ok`, a non-finite `status`/`at`, or a
   * non-string `error` throws before anything is recorded — silently
   * accepting a malformed attempt would corrupt the ledger for
   * exactly the deliveries that need it most.
   */
  recordAttempt(attempt: SettlementWebhookOutboxAttempt): void {
    const { endpoint, eventId, ok } = attempt;
    if (typeof endpoint !== "string" || endpoint.length === 0) {
      throw new Error(
        "SettlementWebhookOutbox: endpoint must be a non-empty string",
      );
    }
    if (typeof eventId !== "string" || eventId.length === 0) {
      throw new Error(
        "SettlementWebhookOutbox: eventId must be a non-empty string",
      );
    }
    if (typeof ok !== "boolean") {
      throw new Error("SettlementWebhookOutbox: ok must be a boolean");
    }
    if (
      attempt.status !== undefined &&
      (!Number.isFinite(attempt.status) ||
        !Number.isInteger(attempt.status))
    ) {
      throw new Error(
        "SettlementWebhookOutbox: status must be a finite integer",
      );
    }
    if (attempt.error !== undefined && typeof attempt.error !== "string") {
      throw new Error("SettlementWebhookOutbox: error must be a string");
    }
    const at = attempt.at ?? this.clock();
    if (!Number.isFinite(at)) {
      throw new Error(
        "SettlementWebhookOutbox: at must be a finite number (milliseconds)",
      );
    }
    if (ok) {
      this.records.get(endpoint)?.delete(eventId);
      if (this.records.get(endpoint)?.size === 0) {
        this.records.delete(endpoint);
      }
      return;
    }
    let byEvent = this.records.get(endpoint);
    if (byEvent === undefined) {
      byEvent = new Map<string, SettlementWebhookOutboxEntry>();
      this.records.set(endpoint, byEvent);
    }
    const prev = byEvent.get(eventId);
    const entry: SettlementWebhookOutboxEntry = {
      endpoint,
      eventId,
      attempts: Math.min((prev?.attempts ?? 0) + 1, this.maxAttempts),
      lastAt: at,
    };
    if (attempt.error !== undefined)
      entry.lastError = truncateOutboxError(attempt.error);
    byEvent.set(eventId, entry);
  }

  /**
   * Mark a `(endpoint, eventId)` pair delivered: drop its failure
   * record, so a later failure starts counting from 1 again.
   * Acknowledging an untracked pair is a no-op (there is nothing to
   * clear), never an error — a success for a pair the outbox never
   * saw fail is not a caller bug.
   */
  acknowledge(endpoint: string, eventId: string): void {
    if (typeof endpoint !== "string" || endpoint.length === 0) {
      throw new Error(
        "SettlementWebhookOutbox: endpoint must be a non-empty string",
      );
    }
    if (typeof eventId !== "string" || eventId.length === 0) {
      throw new Error(
        "SettlementWebhookOutbox: eventId must be a non-empty string",
      );
    }
    const byEvent = this.records.get(endpoint);
    if (byEvent === undefined) return;
    byEvent.delete(eventId);
    if (byEvent.size === 0) this.records.delete(endpoint);
  }

  /**
   * Pairs that have failed but not yet exhausted their retries
   * (`attempts < maxAttempts`), in first-recorded order. Each entry
   * is a fresh copy — mutating it does not affect the ledger.
   */
  pending(): SettlementWebhookOutboxEntry[] {
    const out: SettlementWebhookOutboxEntry[] = [];
    for (const byEvent of this.records.values()) {
      for (const entry of byEvent.values()) {
        if (entry.attempts < this.maxAttempts) out.push({ ...entry });
      }
    }
    return out;
  }

  /**
   * Pairs that have exhausted their retries
   * (`attempts >= maxAttempts`), in first-recorded order — the ones
   * that need a human (fix the endpoint, re-issue the event, or
   * accept the loss). Each entry is a fresh copy — mutating it does
   * not affect the ledger.
   */
  deadLetter(): SettlementWebhookOutboxEntry[] {
    const out: SettlementWebhookOutboxEntry[] = [];
    for (const byEvent of this.records.values()) {
      for (const entry of byEvent.values()) {
        if (entry.attempts >= this.maxAttempts) out.push({ ...entry });
      }
    }
    return out;
  }

  /** Number of tracked `(endpoint, eventId)` pairs (pending + dead-lettered). */
  get size(): number {
    let n = 0;
    for (const byEvent of this.records.values()) n += byEvent.size;
    return n;
  }

  /** Drop every tracked pair. */
  clear(): void {
    this.records.clear();
  }

  /**
   * Export the tracked pairs as a detached, JSON-serializable
   * {@link SettlementWebhookOutboxSnapshot}: persist it before a
   * restart and pass it to `SettlementWebhookOutbox.restore()` at
   * startup so the restart does not forget which deliveries were
   * already failing. The returned object (including every entry) is
   * a fresh copy — mutating it does not affect the ledger.
   */
  exportSnapshot(): SettlementWebhookOutboxSnapshot {
    const entries: SettlementWebhookOutboxEntry[] = [];
    for (const byEvent of this.records.values()) {
      for (const entry of byEvent.values()) entries.push({ ...entry });
    }
    return { v: 1, entries };
  }

  /**
   * Export the current snapshot wrapped in an HMAC-signed envelope
   * (see {@link SettlementWebhookOutboxSignedSnapshotEnvelope}):
   * `{ v: 1, snapshot, mac }` where `mac` is HMAC-SHA256 over the
   * canonical JSON of the snapshot under `secret`. Persist the
   * envelope (plain JSON) before a restart and restore it with
   * {@link SettlementWebhookOutbox.restoreSignedSnapshot} — a process
   * that restarts keeps its pending counts and dead letters, and
   * anyone who rewrites the persisted entries without the secret
   * is caught at restore instead of silently clearing a dead letter
   * (or inventing failures).
   *
   * The secret is never written into the envelope, and the envelope
   * is integrity protection only, not encryption: the endpoints and
   * eventIds inside are wire-visible values, so the envelope itself
   * needs no secrecy, but the secret must be kept where the snapshot
   * writer keeps its other signing-side secrets. An empty secret is a
   * caller-configuration error. The unsigned `exportSnapshot()`
   * path is unchanged: this envelope is opt-in, and a caller that
   * never signs keeps the old trusted-configuration semantics.
   */
  exportSignedSnapshot(
    secret: string | Buffer,
  ): SettlementWebhookOutboxSignedSnapshotEnvelope {
    const secretBytes = outboxSignedSnapshotSecretBytes(secret);
    const snapshot = this.exportSnapshot();
    return {
      v: 1,
      snapshot,
      mac: computeOutboxSnapshotMac(snapshot, secretBytes),
    };
  }

  /**
   * Rebuild an outbox from a snapshot produced by `exportSnapshot()`
   * (typically after a `JSON.parse` of the persisted form). `opts`
   * configures the *new* outbox (`maxAttempts`/`now`) and is
   * validated exactly like the constructor's.
   *
   * The input is untrusted data and is validated strictly: a
   * non-object snapshot, an unknown top-level field, a `v` other than
   * `1`, a non-array `entries`, or a malformed entry (not an object
   * with exactly `endpoint`/`eventId`/`attempts`/`lastAt` plus an
   * optional `lastError`, an empty/non-string `endpoint`/`eventId`, a
   * non-positive-integer `attempts`, a non-string `lastError`, a
   * non-finite `lastAt`) throws — a corrupt snapshot fails loudly at
   * startup rather than silently clearing a dead letter. Duplicate
   * `(endpoint, eventId)` pairs collapse to their last occurrence.
   *
   * Whether a restored entry reads as pending or dead-lettered is
   * derived from its `attempts` against the new outbox's
   * `maxAttempts` (see {@link SettlementWebhookOutboxSnapshot}).
   * This covers a single process across its own restart only; see
   * {@link SettlementWebhookOutboxSnapshot} for the multi-instance
   * and trust limits.
   */
  static restore(
    snapshot: unknown,
    opts: SettlementWebhookOutboxOptions = {},
  ): SettlementWebhookOutbox {
    const fail = (detail: string): never => {
      throw new Error(`SettlementWebhookOutbox: invalid snapshot: ${detail}`);
    };
    if (
      typeof snapshot !== "object" ||
      snapshot === null ||
      Array.isArray(snapshot)
    )
      fail("expected an object of the form { v: 1, entries: [...] }");
    const record = snapshot as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== "v" && key !== "entries") fail(`unknown field "${key}"`);
    }
    if (record.v !== 1)
      fail(
        `unsupported snapshot version ${JSON.stringify(record.v) ?? String(record.v)} (expected 1)`,
      );
    const rawEntries: unknown = record.entries;
    if (!Array.isArray(rawEntries)) fail("entries must be an array");
    const entriesList = rawEntries as unknown[];
    const parsed: SettlementWebhookOutboxEntry[] = [];
    for (let i = 0; i < entriesList.length; i++) {
      const entry: unknown = entriesList[i];
      if (typeof entry !== "object" || entry === null || Array.isArray(entry))
        fail(`entries[${i}] must be an object`);
      const rec = entry as Record<string, unknown>;
      for (const key of Object.keys(rec)) {
        if (
          key !== "endpoint" &&
          key !== "eventId" &&
          key !== "attempts" &&
          key !== "lastError" &&
          key !== "lastAt"
        )
          fail(`entries[${i}]: unknown field "${key}"`);
      }
      const endpoint: unknown = rec.endpoint;
      const eventId: unknown = rec.eventId;
      const attempts: unknown = rec.attempts;
      const lastError: unknown = rec.lastError;
      const lastAt: unknown = rec.lastAt;
      if (typeof endpoint !== "string" || endpoint === "")
        fail(`entries[${i}]: endpoint must be a non-empty string`);
      if (typeof eventId !== "string" || eventId === "")
        fail(`entries[${i}]: eventId must be a non-empty string`);
      if (
        typeof attempts !== "number" ||
        !Number.isInteger(attempts) ||
        attempts < 1
      )
        fail(
          `entries[${i}]: attempts must be a positive integer`,
        );
      if (lastError !== undefined && typeof lastError !== "string")
        fail(`entries[${i}]: lastError must be a string`);
      if (typeof lastAt !== "number" || !Number.isFinite(lastAt))
        fail(`entries[${i}]: lastAt must be a finite number (milliseconds)`);
      const parsedEntry: SettlementWebhookOutboxEntry = {
        endpoint: endpoint as string,
        eventId: eventId as string,
        attempts: attempts as number,
        lastAt: lastAt as number,
      };
      if (typeof lastError === "string") parsedEntry.lastError = lastError;
      parsed.push(parsedEntry);
    }

    const outbox = new SettlementWebhookOutbox(opts);
    for (const entry of parsed) {
      let byEvent = outbox.records.get(entry.endpoint);
      if (byEvent === undefined) {
        byEvent = new Map<string, SettlementWebhookOutboxEntry>();
        outbox.records.set(entry.endpoint, byEvent);
      }
      // Duplicate pairs collapse to their last occurrence (position
      // and record), mirroring the recency rule in
      // `SettlementEventDedupe.restore`.
      byEvent.delete(entry.eventId);
      byEvent.set(entry.eventId, { ...entry });
    }
    return outbox;
  }

  /** Alias of {@link SettlementWebhookOutbox.restore} (snapshot naming). */
  static fromSnapshot(
    snapshot: unknown,
    opts: SettlementWebhookOutboxOptions = {},
  ): SettlementWebhookOutbox {
    return SettlementWebhookOutbox.restore(snapshot, opts);
  }

  /**
   * Rebuild an outbox from a signed envelope produced by
   * {@link SettlementWebhookOutbox.exportSignedSnapshot} (typically
   * after a `JSON.parse` of the persisted form). `opts` configures
   * the *new* outbox (`maxAttempts`/`now`) and is validated exactly
   * like the constructor's. The returned outbox is a fresh object —
   * nothing is installed into any existing outbox, so a failed
   * restore leaves the caller's outboxes untouched.
   *
   * Restore is fail-closed in the same order as the unsigned path,
   * with authenticity checked first: an envelope with an unknown
   * field (including a smuggled `secret`), a version other than
   * `1`, a malformed `mac`, or a MAC that does not match the
   * snapshot under `secret` throws a descriptive configuration
   * `Error` and no outbox is produced — a tampered `attempts`
   * count, a tampered `lastError`/`lastAt`, a tampered
   * `(endpoint, eventId)` key, or a wrong secret all fail here,
   * before any snapshot parsing, so a tampered envelope can never
   * partially install. A MAC-valid envelope whose snapshot is
   * itself malformed then fails through the same strict snapshot
   * validation as {@link SettlementWebhookOutbox.restore}, again
   * with no outbox produced. The MAC comparison is constant-time
   * over equal-length hex digests; a wrong-length `mac` is rejected
   * as malformed before comparison.
   *
   * On success the semantics are exactly
   * {@link SettlementWebhookOutbox.restore}'s: duplicate pairs
   * collapse to their last occurrence, and whether a restored entry
   * reads as pending or dead-lettered is derived from its
   * `attempts` against the new outbox's `maxAttempts`.
   *
   * The unsigned `restore()` and this signed restore do not accept
   * each other's input: an unsigned snapshot has no `mac` (and an
   * `entries` field where the envelope expects `snapshot`), and a
   * signed envelope has fields the unsigned path rejects — so a
   * caller cannot silently downgrade a signed restore to the
   * trusted-configuration path.
   */
  static restoreSignedSnapshot(
    envelope: unknown,
    secret: string | Buffer,
    opts: SettlementWebhookOutboxOptions = {},
  ): SettlementWebhookOutbox {
    const secretBytes = outboxSignedSnapshotSecretBytes(secret);
    const fail = (detail: string): never => {
      throw new Error(
        `SettlementWebhookOutbox: invalid signed snapshot envelope: ${detail}`,
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
      if (key !== "v" && key !== "snapshot" && key !== "mac")
        fail(`unknown field "${key}"`);
    }
    if (record.v !== 1)
      fail(
        `unsupported envelope version ${JSON.stringify(record.v) ?? String(record.v)} (expected 1)`,
      );
    const mac = record.mac;
    if (typeof mac !== "string" || !/^[0-9a-f]{64}$/.test(mac))
      throw new Error(
        "SettlementWebhookOutbox: invalid signed snapshot envelope: mac must be a 64-character lowercase hex HMAC-SHA256 digest",
      );
    const snapshot = record.snapshot;
    if (
      typeof snapshot !== "object" ||
      snapshot === null ||
      Array.isArray(snapshot)
    )
      fail('"snapshot" must be an object');
    const expectedMac = computeOutboxSnapshotMac(
      snapshot as SettlementWebhookOutboxSnapshot,
      secretBytes,
    );
    const macBytes = Buffer.from(mac, "hex");
    const expectedBytes = Buffer.from(expectedMac, "hex");
    if (
      macBytes.length !== expectedBytes.length ||
      !timingSafeEqual(macBytes, expectedBytes)
    )
      throw new Error(
        "SettlementWebhookOutbox: signed snapshot MAC mismatch: the snapshot was tampered with or the secret is wrong",
      );
    // MAC verified — now the same strict structural validation as restore().
    return SettlementWebhookOutbox.restore(snapshot, opts);
  }

  /** Alias of {@link SettlementWebhookOutbox.restoreSignedSnapshot} (snapshot naming). */
  static fromSignedSnapshot(
    envelope: unknown,
    secret: string | Buffer,
    opts: SettlementWebhookOutboxOptions = {},
  ): SettlementWebhookOutbox {
    return SettlementWebhookOutbox.restoreSignedSnapshot(envelope, secret, opts);
  }
}

/* ------------------------------------------------------------------ */
/* Outbox retry runner                                                 */
/* ------------------------------------------------------------------ */

/**
 * One re-delivery attempt by {@link retrySettlementWebhookOutbox}:
 * re-send the settlement event for `(endpoint, eventId)` and report
 * whether the receiver accepted it (`true` = 2xx). The runner does
 * not build or sign the payload — wrap {@link deliverSettlementWebhook}
 * (or any transport that returns a boolean) so the runner stays
 * transport-agnostic and testable with a stub.
 */
export type SettlementWebhookOutboxDeliverOne = (
  endpoint: string,
  eventId: string,
) => Promise<boolean>;

/** Options for {@link retrySettlementWebhookOutbox}. All fields optional. */
export interface SettlementWebhookOutboxRetryOptions {
  /**
   * How many rounds over the pending list to run. Default 1: one pass
   * over whatever is pending when the call starts. Each round
   * re-reads `outbox.pending()`, so pairs acknowledged or
   * dead-lettered in an earlier round are not revisited. Must be a
   * positive integer.
   */
  maxRounds?: number;
  /**
   * Base backoff between rounds in milliseconds. The wait before
   * round `r` (1-based, i.e. the second round waits `backoffMs`, the
   * third `backoffMs * 2`) is `backoffMs * 2^(r-1)` — the same
   * exponential schedule as {@link deliverSettlementWebhook}'s
   * per-attempt backoff. Default 1000. May be 0 in tests.
   */
  backoffMs?: number;
  /**
   * Opt-in jitter, in milliseconds, added on top of each between-rounds
   * backoff (`backoffMs * 2^(r-1) + Math.random() * jitterMs`).
   * Default `0` — the delay schedule is exactly the deterministic
   * backoff sequence. `Math.random` is only de-synchronizing retry
   * schedules, never generating secret material.
   */
  jitterMs?: number;
  /**
   * Maximum number of re-deliveries in flight at once within a round.
   * Default 1 (serial): one pair at a time, in `pending()` order.
   * Set it higher for a bounded pool — a new pair starts only when
   * one settles — the same pool semantics as
   * `DeliverSettlementWebhookToManyOptions.maxConcurrency`, so a
   * 50-pair backlog never opens 50 simultaneous connections. Must be
   * a positive integer when present. Results are reported per pair
   * through the outbox either way; the summary counts do not depend
   * on the concurrency.
   */
  maxConcurrency?: number;
  /**
   * Optional external abort signal. Checked at round boundaries: an
   * abort stops the run before the next round starts (and aborts the
   * between-rounds sleep), and the summary reports `aborted: true`
   * with whatever the earlier rounds already did — acknowledged
   * pairs stay acknowledged, recorded failures stay recorded. A
   * round already in flight runs to its end; the signal does not
   * cancel an in-flight `deliverOne` call itself — a `deliverOne`
   * that wraps `deliverSettlementWebhook` should be passed the same
   * signal so the delivery aborts too.
   */
  signal?: AbortSignal;
  /**
   * Sleep implementation for the between-rounds backoff. Defaults to
   * an abortable `setTimeout` sleep (the same helper
   * {@link deliverSettlementWebhook} uses). Inject a stub in tests
   * to record the delay sequence without waiting, or a custom clock
   * in production. The implementation receives the runner's
   * `signal` and must honor it: a sleep that rejects while the
   * signal is aborted ends the run as `aborted: true`; a sleep that
   * rejects while the signal is NOT aborted is a bug in the sleep
   * implementation and propagates.
   */
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Clock source (milliseconds since the epoch) for the `at` stamped
   * on the attempts the runner records. Defaults to `Date.now`.
   * Inject a fake clock for deterministic tests. This is the
   * runner's clock only — the outbox keeps the clock it was built
   * with for attempts recorded without an explicit `at`.
   */
  now?: () => number;
}

/**
 * Aggregate outcome of {@link retrySettlementWebhookOutbox}. Counts
 * are exact: `attempted` is the number of `deliverOne` calls made,
 * `acknowledged` the number of pairs cleared by a successful
 * re-delivery, and `stillPending`/`deadLettered` are the outbox's
 * own `pending()`/`deadLetter()` lengths when the run ended — so
 * `attempted` always equals the number of re-delivery attempts, and
 * `acknowledged + stillPending + deadLettered` is the number of
 * pairs the run started with, minus any pair that was already
 * dead-lettered (those were never attempted).
 */
export interface SettlementWebhookOutboxRetrySummary {
  /** Number of `deliverOne` calls made. */
  attempted: number;
  /** Number of pairs cleared by a successful re-delivery. */
  acknowledged: number;
  /** Pairs still pending when the run ended (`outbox.pending().length`). */
  stillPending: number;
  /** Pairs dead-lettered when the run ended (`outbox.deadLetter().length`). */
  deadLettered: number;
  /** `true` only when the run stopped early because `signal` aborted. */
  aborted: boolean;
}

/**
 * Re-deliver a {@link SettlementWebhookOutbox}'s pending pairs — the
 * opt-in retry loop for the failure ledger, so callers do not have to
 * hand-write the same loop (and hand-write its two easiest mistakes:
 * retrying a dead letter, and forgetting to clear a pair after a
 * success).
 *
 * Semantics, mirroring the outbox's own counting rules:
 * - Each round works on a fresh `outbox.pending()` snapshot: pairs
 *   already dead-lettered are never re-delivered, and a pair that
 *   dead-letters mid-run (its `recordAttempt` hits `maxAttempts`)
 *   is not revisited by a later round.
 * - A successful re-delivery (`deliverOne` resolves `true`) calls
 *   `outbox.acknowledge(endpoint, eventId)`, clearing the pair so a
 *   later failure counts from 1 again.
 * - A failed re-delivery (`false`, or a `deliverOne` that throws)
 *   calls `outbox.recordAttempt({ endpoint, eventId, ok: false,
 *   error?, at })`, pushing the pair one step toward the dead
 *   letter; a thrown error is recorded with its message and never
 *   crashes the run. A `deliverOne` that resolves to a non-boolean
 *   is a caller bug and throws before anything is recorded for
 *   that pair.
 * - Between rounds the runner sleeps the exponential backoff
 *   (`backoffMs * 2^(r-1)`, plus opt-in `jitterMs`); with the
 *   default `maxRounds: 1` there is no sleep at all.
 * - `signal` aborts at round boundaries (see
 *   {@link SettlementWebhookOutboxRetryOptions.signal}): already-made
 *   attempts keep their results, and the summary reports
 *   `aborted: true`.
 *
 * Honest limits: the runner is in-process only — it retries the
 * pairs this process's outbox holds, and a process that dies loses
 * the ledger unless it exported a snapshot first (see the outbox's
 * snapshot methods). It introduces no durable queue: the runner
 * never persists anything, and `maxRounds` bounds the loop so a
 * run cannot spin forever on a permanently-down endpoint. A
 * deployment that needs retries across restarts or processes must
 * build them over shared storage (a database outbox table, a
 * queue, …) instead.
 */
export async function retrySettlementWebhookOutbox(
  outbox: SettlementWebhookOutbox,
  deliverOne: SettlementWebhookOutboxDeliverOne,
  opts: SettlementWebhookOutboxRetryOptions = {},
): Promise<SettlementWebhookOutboxRetrySummary> {
  if (!(outbox instanceof SettlementWebhookOutbox)) {
    throw new Error(
      "retrySettlementWebhookOutbox: outbox must be a SettlementWebhookOutbox",
    );
  }
  if (typeof deliverOne !== "function") {
    throw new Error(
      "retrySettlementWebhookOutbox: deliverOne must be a function",
    );
  }
  const maxRounds = opts.maxRounds ?? 1;
  if (!Number.isInteger(maxRounds) || maxRounds < 1) {
    throw new Error(
      `retrySettlementWebhookOutbox: maxRounds must be a positive integer, got ${String(
        opts.maxRounds,
      )}`,
    );
  }
  const backoffMs = opts.backoffMs ?? 1000;
  if (!Number.isFinite(backoffMs) || backoffMs < 0) {
    throw new Error(
      `retrySettlementWebhookOutbox: backoffMs must be a non-negative number, got ${String(
        opts.backoffMs,
      )}`,
    );
  }
  const jitterMs = opts.jitterMs ?? 0;
  if (!Number.isFinite(jitterMs) || jitterMs < 0) {
    throw new Error(
      `retrySettlementWebhookOutbox: jitterMs must be a non-negative number, got ${String(
        opts.jitterMs,
      )}`,
    );
  }
  const maxConcurrency = opts.maxConcurrency ?? 1;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error(
      `retrySettlementWebhookOutbox: maxConcurrency must be a positive integer, got ${String(
        opts.maxConcurrency,
      )}`,
    );
  }
  if (opts.signal !== undefined && !(opts.signal instanceof AbortSignal)) {
    throw new Error(
      `retrySettlementWebhookOutbox: signal must be an AbortSignal, got ${String(
        opts.signal,
      )}`,
    );
  }
  if (opts.sleepImpl !== undefined && typeof opts.sleepImpl !== "function") {
    throw new Error(
      "retrySettlementWebhookOutbox: sleepImpl must be a function",
    );
  }
  if (opts.now !== undefined && typeof opts.now !== "function") {
    throw new Error(
      "retrySettlementWebhookOutbox: now must be a function",
    );
  }
  const signal = opts.signal;
  const clock = opts.now ?? Date.now;
  const sleep = opts.sleepImpl ?? sleepAbortable;

  let attempted = 0;
  let acknowledged = 0;
  let aborted = false;

  for (let round = 0; round < maxRounds; round++) {
    // Round boundary: an abort stops the run before the next round
    // starts; whatever earlier rounds did stays recorded.
    if (signal?.aborted) {
      aborted = true;
      break;
    }
    const entries = outbox.pending();
    if (entries.length === 0) break;
    // Bounded pool over this round's snapshot (default serial): a
    // worker takes the next entry only when one settles, and the
    // single-worker loop assigns indices without awaiting between
    // read and increment, so no two workers take one entry. The
    // snapshot is per round — a pair acknowledged or dead-lettered
    // here is not revisited by a later round.
    let next = 0;
    const runWorker = async (): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= entries.length) return;
        const entry = entries[index];
        let ok: boolean;
        try {
          ok = await deliverOne(entry.endpoint, entry.eventId);
        } catch (err) {
          // A throwing deliverOne is a failed attempt, not a runner
          // crash: record it with the error message and keep going.
          attempted += 1;
          outbox.recordAttempt({
            endpoint: entry.endpoint,
            eventId: entry.eventId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            at: clock(),
          });
          continue;
        }
        if (typeof ok !== "boolean") {
          throw new Error(
            `retrySettlementWebhookOutbox: deliverOne must resolve to a boolean, got ${typeof ok}`,
          );
        }
        attempted += 1;
        if (ok) {
          outbox.acknowledge(entry.endpoint, entry.eventId);
          acknowledged += 1;
        } else {
          outbox.recordAttempt({
            endpoint: entry.endpoint,
            eventId: entry.eventId,
            ok: false,
            at: clock(),
          });
        }
      }
    };
    const workerCount = Math.min(maxConcurrency, entries.length);
    await Promise.all(
      Array.from({ length: workerCount }, () => runWorker()),
    );
    if (round + 1 < maxRounds) {
      // Between-rounds backoff. A sleep that rejects while the
      // signal is aborted ends the run at this boundary; any other
      // sleep failure is a bug in the sleep implementation and
      // propagates instead of being masked as an abort.
      try {
        await sleep(jitteredBackoffMs(round, backoffMs, jitterMs), signal);
      } catch (err) {
        if (signal?.aborted) {
          aborted = true;
          break;
        }
        throw err;
      }
    }
  }

  return {
    attempted,
    acknowledged,
    stillPending: outbox.pending().length,
    deadLettered: outbox.deadLetter().length,
    aborted,
  };
}

/* ------------------------------------------------------------------ */
/* Delivery                                                            */
/* ------------------------------------------------------------------ */

/**
 * Minimal `fetch` shape {@link deliverSettlementWebhook} depends on. The
 * global `fetch` satisfies it; inject a stub in tests so delivery can be
 * exercised with no network at all, or a custom transport (proxy, mTLS,
 * record/replay) in production. The dataquest sibling
 * (`PayoutWebhookFetchImpl`) uses the same signature.
 */
export type SettlementWebhookFetchImpl = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

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
   * Opt-in jitter, in milliseconds, added on top of the exponential
   * backoff between retries. Default `0` — the delay schedule is
   * exactly the deterministic backoff sequence and behavior is
   * unchanged. When greater than `0`, each backoff wait becomes
   * `backoffMs * 2^(n-1) + Math.random() * jitterMs` (n is the 1-based
   * retry number), spreading retries that failed together (a
   * thundering herd after the receiver restarts) across the
   * `[backoff, backoff + jitterMs]` window. `Math.random` is used
   * only for de-synchronization — never for secrets or signatures —
   * so a non-cryptographic RNG is fine. A 429 `Retry-After` hint is
   * the receiver's own prescribed time and is always waited exactly,
   * with no jitter added. Must be a finite non-negative number.
   */
  jitterMs?: number;
  /**
   * Optional external abort signal. Wired into both the in-flight request
   * and the backoff sleep between retries: aborting the signal ends the
   * whole delivery (no further attempts) and the returned promise rejects
   * with `webhook delivery aborted`. The per-attempt `timeoutMs` still
   * applies independently. Any non-`AbortSignal` value is a config error.
   */
  signal?: AbortSignal;
  /**
   * Explicit opt-in for plaintext `http://` delivery. Defaults to
   * `false`: an `http:` endpoint URL is refused before any request is
   * made, because the settlement payload (full amount breakdown) and the
   * `X-Signature` header are trivially copyable — and replayable — over
   * plaintext. Pass `true` for local development loopback servers or
   * other endpoints you know are safe. `https:` URLs are never gated by
   * this flag. Honest limit: the refusal only blocks plaintext; it does
   * not validate certificates or pin TLS.
   */
  allowInsecureHttp?: boolean;
  /**
   * Fetch implementation. Defaults to the global `fetch`. Inject a stub
   * in tests to exercise delivery with no network at all, or a custom
   * transport (proxy, mTLS, record/replay) in production. The timeout
   * and external `signal` are still enforced by the caller: the
   * implementation receives the per-attempt `AbortSignal` in `init`
   * and is expected to honor it, exactly like the global `fetch` —
   * an implementation that ignores its signal cannot be force-stopped
   * by a timeout or an abort either. A non-function value is a
   * configuration error thrown before any request is made.
   */
  fetchImpl?: SettlementWebhookFetchImpl;
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
 * Exponential backoff with opt-in jitter for retry `attemptIndex`
 * (0-based): `backoffMs * 2^attemptIndex`, plus a uniform
 * `Math.random() * jitterMs` spread when `jitterMs > 0`. The default
 * `jitterMs` of `0` keeps the deterministic pure-exponential schedule;
 * the jitter is never applied to a 429 `Retry-After` hint, which is
 * computed by {@link retryDelayMs} separately.
 */
function jitteredBackoffMs(
  attemptIndex: number,
  backoffMs: number,
  jitterMs: number,
): number {
  const backoff = backoffMs * 2 ** attemptIndex;
  if (jitterMs <= 0) return backoff;
  // Math.random is only de-synchronizing retry schedules (spreading a
  // thundering herd), never generating secret material — a
  // non-cryptographic RNG is fine here.
  return backoff + Math.random() * jitterMs;
}

/**
 * Wait before the next retry: a 429 `Retry-After` hint wins over backoff,
 * clamped to `maxRetryDelayMs` so a runaway hint can never stall delivery
 * longer than the caller allows. The hint is the receiver's own
 * prescribed time and is waited exactly — no jitter is added on top.
 */
function retryDelayMs(
  response: Response,
  attempt: number,
  backoffMs: number,
  maxRetryDelayMs: number,
  jitterMs: number,
): number {
  if (response.status === 429) {
    const hinted = parseRetryAfter(response.headers.get("retry-after"));
    if (hinted !== undefined) return Math.min(hinted, maxRetryDelayMs);
  }
  return jitteredBackoffMs(attempt, backoffMs, jitterMs);
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

function assertDeliverAllowInsecureHttpType(value: unknown): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(
      `cannot deliver settlement webhook: allowInsecureHttp must be a boolean, got ${String(
        value,
      )}`,
    );
  }
}

function assertDeliverFetchImplType(value: unknown): void {
  if (value !== undefined && typeof value !== "function") {
    throw new Error(
      `cannot deliver settlement webhook: fetchImpl must be a function, got ${String(
        value,
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
    jitterMs: number;
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
  if (!Number.isFinite(resolved.jitterMs) || resolved.jitterMs < 0) {
    throw new Error(
      `cannot deliver settlement webhook: jitterMs must be a non-negative number, got ${String(
        options.jitterMs,
      )}`,
    );
  }
}

/**
 * POST the signed webhook to `url` as JSON with the `X-Signature` header.
 *
 * Every attempt also carries an `X-Event-Id` header whose value is exactly
 * the payload's `eventId` — the same value on every retry, since retries
 * re-send the identical webhook. The header exists so a gateway or
 * receiver that deduplicates on a header can do so without parsing the
 * body first (and still can when body parsing fails). It is a transport
 * hint only: it is NOT covered by the signature, which covers the body
 * alone, so a receiver must still verify the signature and then trust
 * the body's `eventId`, never the header, as the deduplication key.
 *
 * Every attempt also carries an `Idempotency-Key` header with exactly the
 * same value — the payload's `eventId`, identical on every retry and on
 * every fan-out endpoint (fan-out shares one logical event). There is no
 * opt-out: the header is always sent. It exists for receivers that
 * deduplicate on the standard payment-gateway `Idempotency-Key` header
 * rather than on a vendor-specific header; like `X-Event-Id`, it is a
 * transport hint only, NOT covered by the signature, so a receiver must
 * verify the signature and then trust the body's `eventId`, never the
 * header, as the deduplication key.
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
 *   stall delivery beyond the cap. Opt-in `jitterMs` spreads each
 *   backoff wait by up to that many extra milliseconds
 *   (`backoffMs * 2^(n-1) + Math.random() * jitterMs`, default 0 for the
 *   exact deterministic schedule); it is never added to a `Retry-After`
 *   hint, which is waited exactly.
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
 *
 * Transport security: `http:` endpoint URLs are refused by default
 * (`allowInsecureHttp` must be explicitly `true` to opt out) — the
 * signed settlement payload plus the `X-Signature` header are replayable
 * over plaintext, so delivery over the clear is a real replay threat.
 * The refusal only blocks plaintext transport; it does not validate
 * certificates or pin TLS.
 *
 * Transport injection: `fetchImpl` replaces the global `fetch` for every
 * attempt (same `(url: string, init)` shape). Inject a stub in tests or
 * a custom transport in production; the per-attempt timeout and the
 * external `signal` are still wired into `init.signal`, so the
 * implementation must honor it like the global `fetch` does.
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
  const jitterMs = options.jitterMs ?? 0;
  const signal = options.signal;
  const fetchImpl: SettlementWebhookFetchImpl =
    options.fetchImpl ?? ((u, init) => fetch(u, init));

  assertDeliverSignalType(signal);
  assertDeliverAllowInsecureHttpType(options.allowInsecureHttp);
  assertDeliverFetchImplType(options.fetchImpl);
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
    jitterMs,
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
  if (target.protocol === "http:" && options.allowInsecureHttp !== true) {
    // Plaintext transport: the signed settlement payload (full amount
    // breakdown) plus the X-Signature header are copyable — and
    // replayable — in the clear, exactly the gap #84 (redirect leak)
    // left on the transport layer. Refuse before any request is made;
    // the caller opts out explicitly for loopback/dev servers. https:
    // endpoints are never gated by this flag.
    throw new Error(
      "cannot deliver settlement webhook: refusing to POST over plaintext http (pass allowInsecureHttp: true to opt out)",
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
      response = await postOnce(
        target,
        webhook.signature,
        webhook.payload.eventId,
        body,
        timeoutMs,
        fetchImpl,
        signal,
      );
    } catch (err) {
      if (signal?.aborted) {
        // The caller asked to stop: propagate the abort immediately,
        // never treat it as a retryable network failure.
        throw withDeliveryOutcome(new Error("webhook delivery aborted"), attempts);
      }
      lastError = err instanceof Error ? err : new Error(String(err));
      lastStatus = undefined;
      if (attempt < retries) {
        await sleepAbortable(
          jitteredBackoffMs(attempt, backoffMs, jitterMs),
          signal,
        );
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
          retryDelayMs(response, attempt, backoffMs, maxRetryDelayMs, jitterMs),
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
  /** Per-endpoint override of the call-level `jitterMs`. */
  jitterMs?: number;
  /** Per-endpoint override of the call-level `signal`. */
  signal?: AbortSignal;
  /** Per-endpoint override of the call-level `allowInsecureHttp`. */
  allowInsecureHttp?: boolean;
  /**
   * Per-endpoint fetch override; defaults to the call-level `fetchImpl`
   * (which itself defaults to the global `fetch`). Lets one endpoint
   * ride a different transport (its own proxy or mTLS client) while the
   * rest share the call-level one.
   */
  fetchImpl?: SettlementWebhookFetchImpl;
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
  /**
   * Maximum number of endpoints in one call. When set and
   * `endpoints.length` exceeds it, the call throws a caller
   * configuration error before any request is made (zero fetch calls)
   * — an unbounded fan-out is how one settlement event turns into an
   * endpoint explosion. Must be a positive integer when present.
   */
  maxEndpoints?: number;
  /**
   * Maximum number of endpoint deliveries in flight at once. When
   * set, the fan-out runs as a bounded pool: a new endpoint starts
   * only when a running one settles, so a 50-endpoint fan-out never
   * opens 50 simultaneous connections. When unset, every endpoint
   * starts at once (the historical behaviour, unchanged). Must be a
   * positive integer when present. The per-endpoint result shape is
   * identical either way (`results[i]` still corresponds to
   * `endpoints[i]`), and `overallDeadlineMs` keeps its meaning: the
   * deadline still aborts every in-flight delivery, and an endpoint
   * that has not started when the deadline fires is reported as a
   * deadline failure with 0 attempts and no request made.
   */
  maxConcurrency?: number;
  /**
   * Overall wall-clock budget for the whole fan-out, in milliseconds.
   * When set, a timer aborts every in-flight endpoint delivery once
   * the budget expires (composed with each endpoint's own signal, so
   * a per-endpoint signal override cannot bypass the deadline); an
   * endpoint stopped this way reports
   * `{ ok: false, error: "settlement webhook delivery timed out: overall deadline of <ms>ms exceeded" }`
   * instead of the plain abort text, and the aggregate result carries
   * `deadlineExceeded: true`. Endpoints that already completed keep
   * their results, and `delivered`/`failed` count exactly what
   * happened. Must be a positive number when present. Honest limit:
   * the deadline aborts via the fetch signal, exactly like an
   * external abort — a fetch implementation that ignores its signal
   * cannot be force-stopped by the deadline either.
   */
  overallDeadlineMs?: number;
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
  /**
   * `true` only when an `overallDeadlineMs` budget was set and its
   * timer fired before every endpoint had settled. `false` in every
   * other case, including a call with no deadline at all.
   */
  deadlineExceeded: boolean;
}

/**
 * Combine several abort signals into one that fires when ANY input
 * fires, with a `dispose()` that detaches the forwarding listeners.
 * With zero or one live input the input signal is returned as-is
 * (dispose is then a no-op), so the no-deadline path is untouched.
 * An already-aborted input aborts the combined signal immediately.
 */
function combineAbortSignals(
  signals: Array<AbortSignal | undefined>,
): { signal: AbortSignal | undefined; dispose: () => void } {
  const live = signals.filter((s): s is AbortSignal => s !== undefined);
  if (live.length <= 1) {
    return { signal: live[0], dispose: () => {} };
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const s of live) s.addEventListener("abort", onAbort, { once: true });
  if (live.some((s) => s.aborted)) controller.abort();
  return {
    signal: controller.signal,
    dispose: () => {
      for (const s of live) s.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * The endpoint identifier for a fan-out result: the endpoint's URL
 * exactly as supplied, or "" when the entry is not an object with a
 * string url. A malformed entry is reported as its endpoint's failed
 * result (see `deliverOne` below), never thrown, so the identifier
 * must be computable without assuming the entry's shape.
 */
function fanoutEndpointUrl(endpoint: unknown): string {
  return endpoint !== null &&
    typeof endpoint === "object" &&
    typeof (endpoint as { url?: unknown }).url === "string"
    ? (endpoint as { url: string }).url
    : "";
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
 *   or fails the other endpoints. `maxConcurrency` (when set) bounds
 *   that concurrency: at most that many deliveries are in flight at
 *   once, and the next endpoint starts only when one settles.
 *   Unset, every endpoint starts at once.
 * - Call-level configuration errors DO throw before any request is
 *   made: a missing/empty/non-array `endpoints`, invalid global
 *   delivery options, or an invalid shared `now`/`eventId` are caller
 *   bugs, not per-endpoint outcomes.
 * - `maxEndpoints` caps the fan-out size: more endpoints than the cap
 *   throws before any request, and an invalid cap (non-integer, <= 0,
 *   non-finite, non-number) throws the same way.
 * - `maxConcurrency` caps the in-flight concurrency: an invalid cap
 *   (non-integer, <= 0, non-finite, non-number) throws before any
 *   request, the same way as `maxEndpoints`. A deadline that fires
 *   while endpoints are still queued reports those endpoints as
 *   deadline failures with 0 attempts and no request made.
 * - `overallDeadlineMs` caps the whole call's wall-clock time: when
 *   the budget expires, every still-in-flight endpoint is aborted
 *   through a deadline signal composed with that endpoint's own
 *   signal (a per-endpoint signal override does NOT exempt an
 *   endpoint from the deadline). A deadline-stopped endpoint reports
 *   the deadline timeout error, not the plain abort text; endpoints
 *   that already finished keep their results, and the aggregate
 *   result reports `deadlineExceeded: true`.
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
  assertDeliverAllowInsecureHttpType(opts.allowInsecureHttp);
  assertDeliverFetchImplType(opts.fetchImpl);
  assertDeliverOptionValues(opts, {
    retries: opts.retries ?? 3,
    backoffMs: opts.backoffMs ?? 1000,
    timeoutMs: opts.timeoutMs ?? 10_000,
    maxRetryDelayMs: opts.maxRetryDelayMs ?? 60_000,
    jitterMs: opts.jitterMs ?? 0,
  });
  // Fan-out limits are call-level configuration too: validate them
  // before any request, with the same "cannot deliver settlement
  // webhook to many endpoints: …" prefix as the endpoints check above.
  if (
    opts.maxEndpoints !== undefined &&
    (!Number.isInteger(opts.maxEndpoints) || opts.maxEndpoints < 1)
  ) {
    throw new Error(
      `cannot deliver settlement webhook to many endpoints: maxEndpoints must be a positive integer, got ${String(
        opts.maxEndpoints,
      )}`,
    );
  }
  if (
    opts.maxEndpoints !== undefined &&
    endpoints.length > opts.maxEndpoints
  ) {
    throw new Error(
      `cannot deliver settlement webhook to many endpoints: ${endpoints.length} endpoints exceed maxEndpoints ${opts.maxEndpoints}`,
    );
  }
  if (
    opts.maxConcurrency !== undefined &&
    (!Number.isInteger(opts.maxConcurrency) || opts.maxConcurrency < 1)
  ) {
    throw new Error(
      `cannot deliver settlement webhook to many endpoints: maxConcurrency must be a positive integer, got ${String(
        opts.maxConcurrency,
      )}`,
    );
  }
  if (
    opts.overallDeadlineMs !== undefined &&
    (!Number.isFinite(opts.overallDeadlineMs) || opts.overallDeadlineMs <= 0)
  ) {
    throw new Error(
      `cannot deliver settlement webhook to many endpoints: overallDeadlineMs must be a positive number, got ${String(
        opts.overallDeadlineMs,
      )}`,
    );
  }
  // One logical event: build the shared payload body exactly once. A
  // bad shared `now`/`eventId` throws here, before any request.
  const payload = buildPayload(report, {
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.eventId !== undefined ? { eventId: opts.eventId } : {}),
  });
  const body = canonicalJson(payload);

  // Overall deadline: one timer for the whole call. It flips
  // `deadlineExceeded` and aborts the shared deadline controller; the
  // per-endpoint delivery below composes that controller's signal
  // with the endpoint's own signal, so no endpoint can outrun it.
  // The timer stays ref'd (never unref'd): a hanging fetch is the one
  // case where the timer is the only handle that can settle the call,
  // and it is always cleared below once every delivery has settled.
  let deadlineExceeded = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineSignal: AbortSignal | undefined;
  if (opts.overallDeadlineMs !== undefined) {
    const deadlineController = new AbortController();
    deadlineSignal = deadlineController.signal;
    deadlineTimer = setTimeout(() => {
      deadlineExceeded = true;
      deadlineController.abort();
    }, opts.overallDeadlineMs);
  }

  // One endpoint's delivery, in input position `index`. Every failure
  // mode is a per-endpoint result, never a throw: only the call-level
  // validation above throws.
  const deadlineError = `settlement webhook delivery timed out: overall deadline of ${opts.overallDeadlineMs}ms exceeded`;
  const deliverOne = async (
    endpoint: SettlementWebhookEndpoint,
    index: number,
  ): Promise<SettlementWebhookEndpointResult> => {
    const url = fanoutEndpointUrl(endpoint);
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
      // Compose the deadline with the endpoint's own signal (or the
      // call-level one): a per-endpoint signal override does not
      // exempt the endpoint from the overall deadline.
      const { signal, dispose } = combineAbortSignals([
        endpoint.signal ?? opts.signal,
        deadlineSignal,
      ]);
      try {
        // Per-endpoint overrides fall back to the call-level options;
        // either side may be unset, so each field is spread in only
        // when defined — DeliverWebhookOptions no longer accepts an
        // explicit undefined (exactOptionalPropertyTypes).
        const retries = endpoint.retries ?? opts.retries;
        const backoffMs = endpoint.backoffMs ?? opts.backoffMs;
        const timeoutMs = endpoint.timeoutMs ?? opts.timeoutMs;
        const maxRetryDelayMs = endpoint.maxRetryDelayMs ?? opts.maxRetryDelayMs;
        const jitterMs = endpoint.jitterMs ?? opts.jitterMs;
        const allowInsecureHttp =
          endpoint.allowInsecureHttp ?? opts.allowInsecureHttp;
        const fetchImpl = endpoint.fetchImpl ?? opts.fetchImpl;
        const result = await deliverSettlementWebhook(endpoint.url, webhook, {
          ...(retries !== undefined ? { retries } : {}),
          ...(backoffMs !== undefined ? { backoffMs } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(maxRetryDelayMs !== undefined ? { maxRetryDelayMs } : {}),
          ...(jitterMs !== undefined ? { jitterMs } : {}),
          ...(signal !== undefined ? { signal } : {}),
          ...(allowInsecureHttp !== undefined ? { allowInsecureHttp } : {}),
          ...(fetchImpl !== undefined ? { fetchImpl } : {}),
        });
        return { url, ok: true, attempts: result.attempts, status: result.status };
      } finally {
        dispose();
      }
    } catch (err) {
      // Per-endpoint failures (invalid URL, empty secret, invalid
      // per-endpoint override, exhausted retries, aborts) fail only
      // this endpoint. Attempts/status ride on the delivery errors
      // themselves (see withDeliveryOutcome); pre-flight failures
      // made zero requests.
      const annotated = err as Partial<DeliveryError>;
      const rawError = err instanceof Error ? err.message : String(err);
      // Only a deadline-stopped abort is rewritten: an abort that
      // landed while the deadline signal was live. An endpoint
      // aborted on its own signal before the deadline fired keeps
      // the plain abort text, and non-abort failures keep theirs.
      const error =
        deadlineSignal?.aborted && rawError === "webhook delivery aborted"
          ? deadlineError
          : rawError;
      return {
        url,
        ok: false,
        attempts:
          typeof annotated.attempts === "number" ? annotated.attempts : 0,
        ...(typeof annotated.status === "number"
          ? { status: annotated.status }
          : {}),
        error,
      };
    }
  };

  // Unbounded (the historical path): every endpoint starts at once.
  // Bounded (`maxConcurrency` set): a pool of at most that many
  // workers, each taking the next endpoint only when one settles.
  // `results[i]` still corresponds to `endpoints[i]` either way, and
  // the single-worker loop below assigns indices without awaiting
  // between read and increment, so no two workers take one endpoint.
  const results: SettlementWebhookEndpointResult[] = new Array(
    endpoints.length,
  );
  if (opts.maxConcurrency === undefined) {
    const settled = await Promise.all(
      endpoints.map((endpoint, index) => deliverOne(endpoint, index)),
    );
    for (let i = 0; i < settled.length; i++) results[i] = settled[i];
  } else {
    const workerCount = Math.min(opts.maxConcurrency, endpoints.length);
    let next = 0;
    const runWorker = async (): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= endpoints.length) return;
        if (deadlineSignal?.aborted) {
          // The deadline fired before this endpoint started: report
          // the deadline failure without making a request.
          results[index] = {
            url: fanoutEndpointUrl(endpoints[index]),
            ok: false,
            attempts: 0,
            error: deadlineError,
          };
          continue;
        }
        results[index] = await deliverOne(endpoints[index], index);
      }
    };
    await Promise.all(
      Array.from({ length: workerCount }, () => runWorker()),
    );
  }
  if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  const delivered = results.filter((r) => r.ok).length;
  return {
    results,
    delivered,
    failed: results.length - delivered,
    deadlineExceeded,
  };
}

/**
 * One POST attempt with a per-attempt timeout. Network errors propagate.
 * An external `signal`, when provided, aborts the same request controller
 * as the timeout: an abort triggered by the caller surfaces as
 * `webhook delivery aborted`, distinct from the timeout error. The
 * `fetchImpl` receives the attempt's `AbortSignal` in `init.signal` and
 * is expected to honor it, exactly like the global `fetch` — an
 * implementation that ignores its signal cannot be force-stopped by a
 * timeout or an abort either.
 */
async function postOnce(
  target: URL,
  signature: string,
  eventId: string,
  body: string,
  timeoutMs: number,
  fetchImpl: SettlementWebhookFetchImpl,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  // No unref(): the timeout timer can be the only handle that settles
  // an awaited attempt (e.g. a fetch that only settles via this abort),
  // and unref'ing it lets the event loop drain first. The timer is
  // always cleared in the finally below, so it never outlives the
  // attempt.
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
    return await fetchImpl(target.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Signature": signature,
        "X-Event-Id": eventId,
        "Idempotency-Key": eventId,
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
