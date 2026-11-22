import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementWebhook,
  calculateDeposit,
  verifySettlementWebhook,
} from "../src/index.js";
import type { SettlementWebhookPayload } from "../src/index.js";

// Backlog #1317: an object body that cannot be serialized (BigInt values,
// circular references, a throwing `toJSON`) must fail closed as `false`,
// never turn verification into an unhandled exception. The JSDoc promise
// is "a hostile input can never turn verification into an unhandled
// exception"; before this fix `canonicalJson` (bare `JSON.stringify`)
// threw a bare `TypeError` (or rethrew the `toJSON` error) out of
// `verifySettlementWebhook`.

const SECRET = "whsec_test_non_serializable_body_20261121";
const NOW = Date.parse("2026-11-21T10:00:00.000Z");

/** Any well-formed `sha256=<64 hex>` signature: passes the shape regex. */
const WELL_FORMED_SIGNATURE = "sha256=" + "ab".repeat(32);

/** Cast a hostile shape past the payload type: the runtime accepts any object. */
function hostileBody(value: unknown): SettlementWebhookPayload {
  return value as SettlementWebhookPayload;
}

function goldenDeposit() {
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

function releasedReport(id = "esc-non-serializable-body") {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500 },
  });
}

test("BigInt value in object body returns false, never throws", () => {
  const body = hostileBody({
    escrowId: "esc-bigint",
    at: "2026-11-21T10:00:00.000Z",
    amount: 10n,
  });
  assert.equal(
    verifySettlementWebhook(body, WELL_FORMED_SIGNATURE, SECRET),
    false,
  );
});

test("nested BigInt value in object body returns false, never throws", () => {
  const body = hostileBody({
    escrowId: "esc-bigint-nested",
    at: "2026-11-21T10:00:00.000Z",
    settlement: { amount: 10n },
  });
  assert.equal(
    verifySettlementWebhook(body, WELL_FORMED_SIGNATURE, SECRET),
    false,
  );
});

test("circular reference in object body returns false, never throws", () => {
  const body = { escrowId: "esc-circular" } as Record<string, unknown>;
  body.self = body;
  assert.equal(
    verifySettlementWebhook(
      body as unknown as SettlementWebhookPayload,
      WELL_FORMED_SIGNATURE,
      SECRET,
    ),
    false,
  );
});

test("nested circular reference in object body returns false, never throws", () => {
  const inner = { escrowId: "esc-circular-nested" } as Record<string, unknown>;
  inner.parent = { child: inner };
  const body = hostileBody({
    escrowId: "esc-circular-nested",
    at: "2026-11-21T10:00:00.000Z",
    nested: inner,
  });
  assert.equal(
    verifySettlementWebhook(body, WELL_FORMED_SIGNATURE, SECRET),
    false,
  );
});

test("throwing toJSON in object body returns false, never throws", () => {
  const body = hostileBody({
    escrowId: "esc-tojson-throws",
    at: "2026-11-21T10:00:00.000Z",
    toJSON() {
      throw new Error("hostile toJSON");
    },
  });
  assert.equal(
    verifySettlementWebhook(body, WELL_FORMED_SIGNATURE, SECRET),
    false,
  );
});

test("malformed signature plus BigInt body still returns false, never throws", () => {
  const body = hostileBody({
    escrowId: "esc-bigint-bad-sig",
    at: "2026-11-21T10:00:00.000Z",
    amount: 10n,
  });
  // The shape regex rejects this before serialization is ever attempted.
  assert.equal(verifySettlementWebhook(body, "not-a-signature", SECRET), false);
  assert.equal(verifySettlementWebhook(body, "sha256=zz", SECRET), false);
});

test("non-serializable body with options form returns false, never throws", () => {
  const body = hostileBody({
    escrowId: "esc-bigint-options",
    at: "2026-11-21T10:00:00.000Z",
    amount: 10n,
  });
  assert.equal(
    verifySettlementWebhook(body, WELL_FORMED_SIGNATURE, {
      secrets: [SECRET],
      requireEventId: true,
      maxAgeMs: 3_600_000,
      now: NOW,
    }),
    false,
  );
});

test("valid object body still verifies true (regression)", () => {
  const { payload, signature } = buildSettlementWebhook(releasedReport(), {
    secret: SECRET,
    now: new Date(NOW),
    eventId: "evt-non-serializable-body-valid",
  });
  assert.equal(verifySettlementWebhook(payload, signature, SECRET), true);
});

test("string body behavior is unchanged (regression)", () => {
  const { payload, signature } = buildSettlementWebhook(releasedReport(), {
    secret: SECRET,
    now: new Date(NOW),
    eventId: "evt-non-serializable-body-string",
  });
  const bodyString = JSON.stringify(payload);
  assert.equal(verifySettlementWebhook(bodyString, signature, SECRET), true);
  // A tampered string body still fails on the signature, never throws.
  assert.equal(
    verifySettlementWebhook(bodyString + " ", signature, SECRET),
    false,
  );
});

test("configuration errors still throw (guard is verification-only)", () => {
  const body = hostileBody({
    escrowId: "esc-bigint-config",
    at: "2026-11-21T10:00:00.000Z",
    amount: 10n,
  });
  assert.throws(
    () =>
      verifySettlementWebhook(body, WELL_FORMED_SIGNATURE, { secrets: [] }),
    /secrets must be a non-empty array/,
  );
});
