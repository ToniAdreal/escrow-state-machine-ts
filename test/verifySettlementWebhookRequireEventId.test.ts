import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementWebhook,
  calculateDeposit,
  verifySettlementWebhook,
} from "../src/index.js";
import type { SettlementWebhookPayload } from "../src/index.js";

const SECRET = "whsec_test_require_event_id_20261115";
const OLD_SECRET = "whsec_old_rotated_out_require_event_id";
const NOW = Date.parse("2026-11-15T10:00:00.000Z");
const ONE_HOUR = 3_600_000;

function goldenDeposit() {
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

function releasedReport(id = "esc-require-event-id") {
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

/** Sign an arbitrary body with the test secret (test-side signer). */
function signBody(body: unknown, secret: string = SECRET): string {
  const bodyString = typeof body === "string" ? body : JSON.stringify(body);
  return (
    "sha256=" +
    createHmac("sha256", secret).update(bodyString, "utf8").digest("hex")
  );
}

/** The built payload with `eventId` removed (signed over the keyless bytes). */
function keylessBody(): { bodyString: string; signature: string } {
  const { payload } = buildSettlementWebhook(releasedReport(), {
    secret: SECRET,
    now: new Date(NOW),
    eventId: "evt-require-event-id",
  });
  const { eventId: _dropped, ...noId } = payload;
  const bodyString = JSON.stringify(noId);
  return { bodyString, signature: signBody(bodyString) };
}

test("requireEventId: string body without eventId fails closed", () => {
  const { bodyString, signature } = keylessBody();
  assert.equal(
    verifySettlementWebhook(bodyString, signature, {
      secrets: [SECRET],
      requireEventId: true,
    }),
    false,
  );
});

test("requireEventId: object body without eventId fails closed", () => {
  const { bodyString, signature } = keylessBody();
  const parsed = JSON.parse(bodyString) as SettlementWebhookPayload;
  assert.equal(
    verifySettlementWebhook(parsed, signature, {
      secrets: [SECRET],
      requireEventId: true,
    }),
    false,
  );
});

test("requireEventId: empty-string eventId fails closed (both body forms)", () => {
  const { payload } = buildSettlementWebhook(releasedReport(), {
    secret: SECRET,
    now: new Date(NOW),
    eventId: "evt-require-event-id",
  });
  const emptyId = { ...payload, eventId: "" };
  const bodyString = JSON.stringify(emptyId);
  const signature = signBody(bodyString);
  assert.equal(
    verifySettlementWebhook(bodyString, signature, {
      secrets: [SECRET],
      requireEventId: true,
    }),
    false,
  );
  assert.equal(
    verifySettlementWebhook(emptyId, signature, {
      secrets: [SECRET],
      requireEventId: true,
    }),
    false,
  );
});

test("requireEventId: non-string eventId fails closed", () => {
  const { payload } = buildSettlementWebhook(releasedReport(), {
    secret: SECRET,
    now: new Date(NOW),
    eventId: "evt-require-event-id",
  });
  const numericId = { ...payload, eventId: 12345 } as unknown as SettlementWebhookPayload;
  const bodyString = JSON.stringify(numericId);
  assert.equal(
    verifySettlementWebhook(bodyString, signBody(bodyString), {
      secrets: [SECRET],
      requireEventId: true,
    }),
    false,
  );
});

test("requireEventId: payload with eventId passes (both body forms)", () => {
  const { payload, signature } = buildSettlementWebhook(releasedReport(), {
    secret: SECRET,
    now: new Date(NOW),
    eventId: "evt-require-event-id",
  });
  assert.equal(
    verifySettlementWebhook(JSON.stringify(payload), signature, {
      secrets: [SECRET],
      requireEventId: true,
    }),
    true,
  );
  assert.equal(
    verifySettlementWebhook(payload, signature, {
      secrets: [SECRET],
      requireEventId: true,
    }),
    true,
  );
});

test("requireEventId: option off keeps the legacy behavior (keyless payload verifies)", () => {
  const { bodyString, signature } = keylessBody();
  // Plain secret form (no options object at all).
  assert.equal(verifySettlementWebhook(bodyString, signature, SECRET), true);
  // Options form without requireEventId.
  assert.equal(
    verifySettlementWebhook(bodyString, signature, { secrets: [SECRET] }),
    true,
  );
  assert.equal(
    verifySettlementWebhook(bodyString, signature, {
      secrets: [SECRET],
      requireEventId: false,
    }),
    true,
  );
});

test("requireEventId: forged signature fails first (missing eventId does not change the error path)", () => {
  const { bodyString } = keylessBody();
  const forged = signBody(bodyString, "whsec_attacker_forged");
  assert.equal(
    verifySettlementWebhook(bodyString, forged, {
      secrets: [SECRET],
      requireEventId: true,
    }),
    false,
  );
  // A malformed signature shape also fails without ever reaching the gate.
  assert.equal(
    verifySettlementWebhook(bodyString, "not-a-signature", {
      secrets: [SECRET],
      requireEventId: true,
    }),
    false,
  );
});

test("requireEventId: wrong secret still fails with a missing eventId", () => {
  const { bodyString, signature } = keylessBody();
  assert.equal(
    verifySettlementWebhook(bodyString, signature, {
      secrets: ["whsec_wrong_secret"],
      requireEventId: true,
    }),
    false,
  );
});

test("requireEventId: unparseable string body fails closed, never throws", () => {
  const raw = "{not json";
  const signature = signBody(raw);
  assert.equal(
    verifySettlementWebhook(raw, signature, {
      secrets: [SECRET],
      requireEventId: true,
    }),
    false,
  );
});

test("requireEventId: secret rotation — old-secret signature with eventId passes, keyless fails", () => {
  const { payload, signature } = buildSettlementWebhook(releasedReport(), {
    secret: OLD_SECRET,
    now: new Date(NOW),
    eventId: "evt-require-event-id",
  });
  assert.equal(
    verifySettlementWebhook(JSON.stringify(payload), signature, {
      secrets: [SECRET, OLD_SECRET],
      requireEventId: true,
    }),
    true,
  );
  const { bodyString } = keylessBody();
  assert.equal(
    verifySettlementWebhook(bodyString, signBody(bodyString, OLD_SECRET), {
      secrets: [SECRET, OLD_SECRET],
      requireEventId: true,
    }),
    false,
  );
});

test("requireEventId: non-boolean option value is a caller configuration error", () => {
  const { payload, signature } = buildSettlementWebhook(releasedReport(), {
    secret: SECRET,
    now: new Date(NOW),
    eventId: "evt-require-event-id",
  });
  assert.throws(
    () =>
      verifySettlementWebhook(JSON.stringify(payload), signature, {
        secrets: [SECRET],
        requireEventId: "yes" as unknown as boolean,
      }),
    /requireEventId must be a boolean/,
  );
});

test("requireEventId: composes with the freshness window (both gates must pass)", () => {
  const { payload, signature } = buildSettlementWebhook(releasedReport(), {
    secret: SECRET,
    now: new Date(NOW),
    eventId: "evt-require-event-id",
  });
  // Fresh + keyed passes.
  assert.equal(
    verifySettlementWebhook(JSON.stringify(payload), signature, {
      secrets: [SECRET],
      maxAgeMs: ONE_HOUR,
      requireEventId: true,
      now: NOW,
    }),
    true,
  );
  // Fresh but keyless fails on the eventId gate, not the freshness gate.
  const { bodyString, signature: keylessSig } = keylessBody();
  assert.equal(
    verifySettlementWebhook(bodyString, keylessSig, {
      secrets: [SECRET],
      maxAgeMs: ONE_HOUR,
      requireEventId: true,
      now: NOW,
    }),
    false,
  );
  // Keyed but expired fails on the freshness gate.
  assert.equal(
    verifySettlementWebhook(JSON.stringify(payload), signature, {
      secrets: [SECRET],
      maxAgeMs: ONE_HOUR,
      requireEventId: true,
      now: NOW + 2 * ONE_HOUR,
    }),
    false,
  );
});
