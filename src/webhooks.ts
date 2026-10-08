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
 *   `Retry-After` hint is honored; other 4xx are not retried). Fan-out to
 *   multiple endpoints stays the caller's job.
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
    deposit: report.deposit.deposit,
    parties: report.parties.map((p) => ({
      party: p.party,
      inflow: p.inflow,
      outflow: p.outflow,
      net: p.net,
    })),
    at,
  };
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

  const match = /^sha256=([0-9a-f]{64})$/.exec(signature);
  if (!match) return false;
  const bodyString = typeof body === "string" ? body : canonicalJson(body);
  const actual = Buffer.from(match[1], "hex");
  for (const secret of secrets) {
    const expected = Buffer.from(
      createHmac("sha256", secret).update(bodyString, "utf8").digest(),
    );
    // timingSafeEqual throws on length mismatch; a forged 64-hex string that
    // decodes short (never, given the regex) or long is simply a failure.
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) {
      return true;
    }
  }
  return false;
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

/** Wait before the next retry: a 429 `Retry-After` hint wins over backoff. */
function retryDelayMs(
  response: Response,
  attempt: number,
  backoffMs: number,
): number {
  if (response.status === 429) {
    const hinted = parseRetryAfter(response.headers.get("retry-after"));
    if (hinted !== undefined) return hinted;
  }
  return backoffMs * 2 ** attempt;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // A pending backoff must not hold the process open on its own.
    timer.unref();
  });
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
 *   falls back to `backoffMs * 2^(n-1)`.
 * - Other 3xx/4xx (400, 404, …) → the request itself is at fault; throws
 *   immediately, no retry. Redirects are never followed (`redirect:
 *   "manual"`): a 3xx response is returned as-is and lands in this branch,
 *   so the signed payload is never re-posted to a redirect target URL —
 *   the caller must fix the endpoint.
 *
 * When every attempt fails, throws
 * `webhook delivery to <url> failed after <n> attempts: <last cause>`.
 * A per-attempt timeout surfaces as `webhook delivery timed out after
 * <timeoutMs>ms`. Invalid options throw a `cannot deliver settlement
 * webhook: …` config error before any request is made.
 */
export async function deliverSettlementWebhook(
  url: string,
  webhook: SettlementWebhook,
  options: DeliverWebhookOptions = {},
): Promise<WebhookDeliveryResult> {
  const retries = options.retries ?? 3;
  const backoffMs = options.backoffMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 10_000;

  if (!Number.isInteger(retries) || retries < 0) {
    throw new Error(
      `cannot deliver settlement webhook: retries must be a non-negative integer, got ${String(
        options.retries,
      )}`,
    );
  }
  if (!Number.isFinite(backoffMs) || backoffMs < 0) {
    throw new Error(
      `cannot deliver settlement webhook: backoffMs must be a non-negative number, got ${String(
        options.backoffMs,
      )}`,
    );
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `cannot deliver settlement webhook: timeoutMs must be a positive number, got ${String(
        options.timeoutMs,
      )}`,
    );
  }

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
  for (let attempt = 0; attempt <= retries; attempt++) {
    attempts = attempt + 1;
    let response: Response;
    try {
      response = await postOnce(target, webhook.signature, body, timeoutMs);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries) {
        await sleep(backoffMs * 2 ** attempt);
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
      if (attempt < retries) {
        await sleep(retryDelayMs(response, attempt, backoffMs));
        continue;
      }
      break;
    }
    // Other 3xx/4xx (400, 404, …): the request itself is at fault; retrying
    // the identical request changes nothing.
    throw new Error(
      `webhook delivery to ${url} failed with status ${response.status} (not retried)`,
    );
  }
  throw new Error(
    `webhook delivery to ${url} failed after ${attempts} attempt${
      attempts === 1 ? "" : "s"
    }: ${lastError?.message ?? "unknown error"}`,
  );
}

/** One POST attempt with a per-attempt timeout. Network errors propagate. */
async function postOnce(
  target: URL,
  signature: string,
  body: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref();
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
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
