import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementWebhook,
  calculateDeposit,
  verifySettlementWebhook,
} from "../src/index.js";

const OLD_SECRET = "whsec_test_settlement_notifications_20261006";
const NEW_SECRET = "whsec_test_settlement_notifications_rotated_20261007";
const FIXED_NOW = "2026-10-07T18:00:00.000Z";

function settledReport() {
  const e = new Escrow("esc-rotation-1");
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: calculateDeposit({
      creatorPool: 10000,
      baseFee: 600,
      complexityMultiplier: 1.0,
      loyaltyDiscount: 30,
      oracleFee: 60,
    }),
    settlement: { proFeeBps: 500 },
  });
}

function signedWith(secret: string) {
  return buildSettlementWebhook(settledReport(), { secret, now: FIXED_NOW });
}

test("signature made with the new secret verifies with { secrets: [new, old] }", () => {
  const { payload, signature } = signedWith(NEW_SECRET);
  assert.ok(
    verifySettlementWebhook(payload, signature, { secrets: [NEW_SECRET, OLD_SECRET] }),
    "rotation window must accept the new secret",
  );
});

test("signature made with the old secret still verifies during the rotation window (either order)", () => {
  const { payload, signature } = signedWith(OLD_SECRET);
  assert.ok(
    verifySettlementWebhook(payload, signature, { secrets: [NEW_SECRET, OLD_SECRET] }),
    "rotation window must keep accepting the old secret",
  );
  assert.ok(
    verifySettlementWebhook(payload, signature, { secrets: [OLD_SECRET, NEW_SECRET] }),
    "candidate order must not matter",
  );
});

test("all-wrong candidates fail closed (false, no throw)", () => {
  const { payload, signature } = signedWith(NEW_SECRET);
  assert.equal(
    verifySettlementWebhook(payload, signature, {
      secrets: ["whsec_wrong_1", "whsec_wrong_2"],
    }),
    false,
  );
});

test("single-secret call shape is unchanged (plain string still works)", () => {
  const { payload, signature } = signedWith(OLD_SECRET);
  assert.ok(verifySettlementWebhook(payload, signature, OLD_SECRET));
  assert.equal(verifySettlementWebhook(payload, signature, NEW_SECRET), false);
  // The options form with a single candidate behaves identically.
  assert.ok(
    verifySettlementWebhook(payload, signature, { secrets: [OLD_SECRET] }),
  );
  assert.equal(
    verifySettlementWebhook(payload, signature, { secrets: [NEW_SECRET] }),
    false,
  );
});

test("rotation works over the raw body string (transport-safe path)", () => {
  // Fixed eventId so the "wire" body matches the signed build byte-for-byte.
  const { payload, signature } = buildSettlementWebhook(settledReport(), {
    secret: NEW_SECRET,
    now: FIXED_NOW,
    eventId: "evt_rotation_raw",
  });
  const rawBody = JSON.stringify(payload);
  assert.ok(
    verifySettlementWebhook(rawBody, signature, {
      secrets: [NEW_SECRET, OLD_SECRET],
    }),
  );
  assert.equal(
    verifySettlementWebhook(rawBody, signature, {
      secrets: [OLD_SECRET, "whsec_wrong"],
    }),
    false,
  );
});

test("empty secrets array throws a config error (never silently passes)", () => {
  const { payload, signature } = signedWith(NEW_SECRET);
  assert.throws(
    () => verifySettlementWebhook(payload, signature, { secrets: [] }),
    /secrets must be a non-empty array/,
  );
});

test("an empty secret inside the array throws a config error", () => {
  const { payload, signature } = signedWith(NEW_SECRET);
  assert.throws(
    () =>
      verifySettlementWebhook(payload, signature, {
        secrets: [NEW_SECRET, ""],
      }),
    /secrets\[1\] must not be empty/,
  );
});

test("malformed signatures fail closed with the options form too (no throw)", () => {
  const { payload } = signedWith(NEW_SECRET);
  const opts = { secrets: [NEW_SECRET, OLD_SECRET] };
  for (const bad of ["", "sha256=xyz", "sha256=" + "ab".repeat(31), "md5=" + "ab".repeat(32)]) {
    assert.equal(verifySettlementWebhook(payload, bad, opts), false);
  }
});

test("buffer secrets participate in rotation", () => {
  const { payload, signature } = signedWith(NEW_SECRET);
  assert.ok(
    verifySettlementWebhook(payload, signature, {
      secrets: [Buffer.from(NEW_SECRET, "utf8"), Buffer.from(OLD_SECRET, "utf8")],
    }),
  );
});
