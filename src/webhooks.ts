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
 * - It builds and verifies the payload; it does NOT deliver it. Delivery
 *   (HTTP POST, retries, fan-out) is the caller's job.
 * - Secret distribution is the caller's responsibility. Whoever holds the
 *   secret can forge signatures; store it like any other API credential.
 * - `verifySettlementWebhook` should run over the raw request body bytes.
 *   Re-stringifying a parsed object round-trips byte-identically *if* key
 *   order is preserved, but raw bytes are the transport-safe path.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { PartyRole, SettlementReport } from "./settlementReport.js";

/** Compact machine-readable settlement notification. */
export interface SettlementWebhookPayload {
  event: "escrow.settled";
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
 * Throws when the secret is empty or `now` is not a valid timestamp.
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

  const payload: SettlementWebhookPayload = {
    event: "escrow.settled",
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
 * input can never turn verification into an unhandled exception. The
 * comparison itself is constant-time (`timingSafeEqual`).
 */
export function verifySettlementWebhook(
  body: string | SettlementWebhookPayload,
  signature: string,
  secret: string | Buffer,
): boolean {
  const match = /^sha256=([0-9a-f]{64})$/.exec(signature);
  if (!match) return false;
  const expected = Buffer.from(
    createHmac("sha256", secret)
      .update(typeof body === "string" ? body : canonicalJson(body), "utf8")
      .digest(),
  );
  const actual = Buffer.from(match[1], "hex");
  // timingSafeEqual throws on length mismatch; a forged 64-hex string that
  // decodes short (never, given the regex) or long is simply a failure.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
