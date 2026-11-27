import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  STRICT_SETTLEMENT_WEBHOOK_MAX_AGE_MS,
  STRICT_SETTLEMENT_WEBHOOK_MAX_FUTURE_SKEW_MS,
  Escrow,
  buildSettlementReport,
  buildSettlementWebhook,
  calculateDeposit,
  verifySettlementWebhook,
  verifySettlementWebhookStrict,
} from "../src/index.js";
import type {
  SettlementWebhookPayload,
  VerifyWebhookOptions,
} from "../src/index.js";

/**
 * Strict settlement webhook verification (backlog #1432): the recommended
 * receiver path — `verifySettlementWebhook` with all three opt-in gates
 * switched on by default in one call. Mirrors the dataquest
 * `verifyPayoutWebhookStrict` (#1427) with this module's overload shape:
 * a single secret or an options object, and `now` as epoch milliseconds.
 *
 * Rules under test:
 *  - defaults: `maxAgeMs` 300_000 (5 minutes), `maxFutureSkewMs`
 *    60_000, `requireEventId: true`; each is overridable per field
 *  - strict accepts a fresh, keyed, correctly-signed payload
 *    (string and object bodies, single-secret and options forms)
 *  - strict rejects a legitimately-signed payload older than 5 minutes
 *    and one more than 60 seconds in the future
 *  - strict rejects a signed payload with a missing, empty, or
 *    non-string `eventId`
 *  - an explicit `maxAgeMs` override is honored (1 hour accepts a
 *    10-minute-old payload); likewise `maxFutureSkewMs`
 *  - the legacy `verifySettlementWebhook()` defaults are untouched: the
 *    same old/keyless payloads still verify on their signature alone
 *  - downgrade guard: explicitly passing `maxAgeMs: undefined` together
 *    with `requireEventId: false` throws a configuration error, so
 *    strict cannot be quietly downgraded to signature-only
 *  - an explicit `maxAgeMs: undefined` on its own falls back to the
 *    5-minute default (it does not disable the window)
 *  - boundaries are inclusive: exactly 5 minutes old passes, 1ms more
 *    fails; exactly 60 seconds in the future passes, 1ms more fails
 *  - strict composes with secret rotation (`secrets: [new, old]`)
 */

const SECRET = "whsec_test_strict_verify_20261126";
const OLD_SECRET = "whsec_test_strict_verify_old_20261126";
const NOW = Date.parse("2026-11-26T10:00:00.000Z");
const FIVE_MINUTES = 300_000;
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

function releasedReport(id: string) {
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

/** A built payload carrying a fixed `eventId`, signed over its bytes. */
function keyedBody(
  builtAtMs: number,
  secret: string = SECRET,
  eventId = "evt-strict-verify",
) {
  return buildSettlementWebhook(
    releasedReport(`esc-strict-verify-${builtAtMs}-${eventId}`),
    { secret, now: new Date(builtAtMs), eventId },
  );
}

/** The built payload with `eventId` removed (signed over the keyless bytes). */
function keylessBody(builtAtMs: number): {
  bodyString: string;
  signature: string;
} {
  const { payload } = keyedBody(builtAtMs, SECRET, "evt-strict-verify-keyless");
  const { eventId: _dropped, ...noId } = payload;
  const bodyString = JSON.stringify(noId);
  return { bodyString, signature: signBody(bodyString) };
}

test("strict defaults are the documented safe values", () => {
  assert.equal(STRICT_SETTLEMENT_WEBHOOK_MAX_AGE_MS, 300_000);
  assert.equal(STRICT_SETTLEMENT_WEBHOOK_MAX_FUTURE_SKEW_MS, 60_000);
});

test("strict: fresh keyed correctly-signed payload verifies (string and object, both forms)", () => {
  const { payload, signature } = keyedBody(NOW);
  assert.equal(
    verifySettlementWebhookStrict(JSON.stringify(payload), signature, {
      secrets: [SECRET],
      now: NOW,
    }),
    true,
  );
  assert.equal(
    verifySettlementWebhookStrict(payload, signature, {
      secrets: [SECRET],
      now: NOW,
    }),
    true,
  );
  // Single-secret form with the real clock: build at "now" so the age
  // is a few milliseconds and the strict defaults pass.
  const live = keyedBody(Date.now(), SECRET, "evt-strict-verify-live");
  assert.equal(
    verifySettlementWebhookStrict(
      JSON.stringify(live.payload),
      live.signature,
      SECRET,
    ),
    true,
  );
  // No `now` either: the real clock is long past the fixed build time,
  // so this only pins that the call does not throw without options.
  assert.equal(
    typeof verifySettlementWebhookStrict(
      JSON.stringify(payload),
      signature,
      SECRET,
    ),
    "boolean",
  );
});

test("strict: payload older than 5 minutes is rejected", () => {
  const { payload, signature } = keyedBody(NOW - 10 * 60_000);
  // The signature itself is valid — only the strict age gate rejects it.
  assert.equal(verifySettlementWebhook(payload, signature, SECRET), true);
  assert.equal(
    verifySettlementWebhookStrict(JSON.stringify(payload), signature, {
      secrets: [SECRET],
      now: NOW,
    }),
    false,
  );
  assert.equal(
    verifySettlementWebhookStrict(payload, signature, {
      secrets: [SECRET],
      now: NOW,
    }),
    false,
  );
});

test("strict: payload more than 60 seconds in the future is rejected", () => {
  const { payload, signature } = keyedBody(NOW + 2 * 60_000);
  // Under `maxAgeMs` alone a future timestamp passes; strict bounds it.
  assert.equal(
    verifySettlementWebhook(payload, signature, {
      secrets: [SECRET],
      maxAgeMs: ONE_HOUR,
      now: NOW,
    }),
    true,
  );
  assert.equal(
    verifySettlementWebhookStrict(JSON.stringify(payload), signature, {
      secrets: [SECRET],
      now: NOW,
    }),
    false,
  );
});

test("strict: signed payload without eventId fails closed (string and object)", () => {
  const { bodyString, signature } = keylessBody(NOW);
  assert.equal(
    verifySettlementWebhookStrict(bodyString, signature, {
      secrets: [SECRET],
      now: NOW,
    }),
    false,
  );
  const parsed = JSON.parse(bodyString) as SettlementWebhookPayload;
  assert.equal(
    verifySettlementWebhookStrict(parsed, signature, {
      secrets: [SECRET],
      now: NOW,
    }),
    false,
  );
});

test("strict: empty-string eventId fails closed", () => {
  const { payload } = keyedBody(NOW);
  const body = { ...payload, eventId: "" };
  const bodyString = JSON.stringify(body);
  assert.equal(
    verifySettlementWebhookStrict(bodyString, signBody(bodyString), {
      secrets: [SECRET],
      now: NOW,
    }),
    false,
  );
});

test("strict: non-string eventId fails closed", () => {
  const { payload } = keyedBody(NOW);
  const body = { ...payload, eventId: 42 } as unknown as SettlementWebhookPayload;
  const bodyString = JSON.stringify(body);
  assert.equal(
    verifySettlementWebhookStrict(bodyString, signBody(bodyString), {
      secrets: [SECRET],
      now: NOW,
    }),
    false,
  );
});

test("strict: explicit maxAgeMs override is honored", () => {
  const { payload, signature } = keyedBody(NOW - 10 * 60_000);
  // 10 minutes old: past the 5-minute default, inside an explicit hour.
  assert.equal(
    verifySettlementWebhookStrict(JSON.stringify(payload), signature, {
      secrets: [SECRET],
      maxAgeMs: ONE_HOUR,
      now: NOW,
    }),
    true,
  );
  // And a tighter explicit window still rejects it.
  assert.equal(
    verifySettlementWebhookStrict(JSON.stringify(payload), signature, {
      secrets: [SECRET],
      maxAgeMs: 60_000,
      now: NOW,
    }),
    false,
  );
});

test("strict: explicit maxFutureSkewMs override is honored", () => {
  const { payload, signature } = keyedBody(NOW + 2 * 60_000);
  assert.equal(
    verifySettlementWebhookStrict(JSON.stringify(payload), signature, {
      secrets: [SECRET],
      maxFutureSkewMs: 5 * 60_000,
      now: NOW,
    }),
    true,
  );
});

test("strict: explicit requireEventId: false keeps the freshness gates", () => {
  const { bodyString, signature } = keylessBody(NOW);
  // Keyless but fresh: the age/future gates still pass without the key.
  assert.equal(
    verifySettlementWebhookStrict(bodyString, signature, {
      secrets: [SECRET],
      requireEventId: false,
      now: NOW,
    }),
    true,
  );
  // Keyless and stale: the age gate still rejects.
  const stale = keylessBody(NOW - 10 * 60_000);
  assert.equal(
    verifySettlementWebhookStrict(stale.bodyString, stale.signature, {
      secrets: [SECRET],
      requireEventId: false,
      now: NOW,
    }),
    false,
  );
});

test("legacy verifySettlementWebhook() still accepts the same old/keyless payloads", () => {
  const { payload, signature } = keyedBody(NOW - 10 * 60_000);
  assert.equal(verifySettlementWebhook(payload, signature, SECRET), true);
  const { bodyString, signature: keylessSignature } = keylessBody(NOW);
  assert.equal(
    verifySettlementWebhook(bodyString, keylessSignature, SECRET),
    true,
  );
});

test("strict: explicit maxAgeMs: undefined with requireEventId: false throws", () => {
  const { payload, signature } = keyedBody(NOW);
  // The repo compiles with `exactOptionalPropertyTypes`, so a typed
  // caller cannot even write `maxAgeMs: undefined` — the cast below
  // stands in for a JavaScript caller, which is who the runtime guard
  // protects.
  const downgradeOpts = {
    secrets: [SECRET],
    maxAgeMs: undefined,
    requireEventId: false,
    now: NOW,
  } as unknown as VerifyWebhookOptions;
  assert.throws(
    () =>
      verifySettlementWebhookStrict(
        JSON.stringify(payload),
        signature,
        downgradeOpts,
      ),
    /cannot verify settlement webhook \(strict\): maxAgeMs must not be explicitly disabled while requireEventId is false/,
  );
  // Both windows explicitly disabled the same way throws too.
  const bothDisabledOpts = {
    secrets: [SECRET],
    maxAgeMs: undefined,
    maxFutureSkewMs: undefined,
    requireEventId: false,
    now: NOW,
  } as unknown as VerifyWebhookOptions;
  assert.throws(
    () =>
      verifySettlementWebhookStrict(
        JSON.stringify(payload),
        signature,
        bothDisabledOpts,
      ),
    /cannot verify settlement webhook \(strict\): maxAgeMs must not be explicitly disabled while requireEventId is false/,
  );
});

test("strict: explicit maxAgeMs: undefined alone falls back to the 5-minute default", () => {
  // Same `exactOptionalPropertyTypes` cast as the guard test above:
  // this stands in for a JavaScript caller passing an explicit
  // `undefined` for the window while leaving the eventId gate on.
  const unsetAgeOpts = {
    secrets: [SECRET],
    maxAgeMs: undefined,
    now: NOW,
  } as unknown as VerifyWebhookOptions;
  const fresh = keyedBody(NOW);
  assert.equal(
    verifySettlementWebhookStrict(
      JSON.stringify(fresh.payload),
      fresh.signature,
      unsetAgeOpts,
    ),
    true,
  );
  const stale = keyedBody(NOW - 10 * 60_000);
  assert.equal(
    verifySettlementWebhookStrict(
      JSON.stringify(stale.payload),
      stale.signature,
      unsetAgeOpts,
    ),
    false,
  );
});

test("strict: inclusive boundaries — exactly 5 minutes old and exactly 60 seconds future pass", () => {
  const ageEdge = keyedBody(NOW - FIVE_MINUTES);
  assert.equal(
    verifySettlementWebhookStrict(JSON.stringify(ageEdge.payload), ageEdge.signature, {
      secrets: [SECRET],
      now: NOW,
    }),
    true,
  );
  const ageOver = keyedBody(NOW - FIVE_MINUTES - 1);
  assert.equal(
    verifySettlementWebhookStrict(JSON.stringify(ageOver.payload), ageOver.signature, {
      secrets: [SECRET],
      now: NOW,
    }),
    false,
  );
  const futureEdge = keyedBody(NOW + 60_000);
  assert.equal(
    verifySettlementWebhookStrict(JSON.stringify(futureEdge.payload), futureEdge.signature, {
      secrets: [SECRET],
      now: NOW,
    }),
    true,
  );
  const futureOver = keyedBody(NOW + 60_001);
  assert.equal(
    verifySettlementWebhookStrict(JSON.stringify(futureOver.payload), futureOver.signature, {
      secrets: [SECRET],
      now: NOW,
    }),
    false,
  );
});

test("strict: composes with secret rotation", () => {
  const keyed = keyedBody(NOW, OLD_SECRET, "evt-strict-verify-rotation");
  assert.equal(
    verifySettlementWebhookStrict(JSON.stringify(keyed.payload), keyed.signature, {
      secrets: [SECRET, OLD_SECRET],
      now: NOW,
    }),
    true,
  );
  // A keyless body signed with the old secret still fails the eventId gate.
  const { eventId: _dropped, ...noId } = keyed.payload;
  const keylessString = JSON.stringify(noId);
  assert.equal(
    verifySettlementWebhookStrict(
      keylessString,
      signBody(keylessString, OLD_SECRET),
      { secrets: [SECRET, OLD_SECRET], now: NOW },
    ),
    false,
  );
});

test("strict: unknown option keys and illegal values still throw", () => {
  const { payload, signature } = keyedBody(NOW);
  assert.throws(
    () =>
      verifySettlementWebhookStrict(JSON.stringify(payload), signature, {
        secrets: [SECRET],
        maxAge: ONE_HOUR,
        now: NOW,
      } as unknown as VerifyWebhookOptions),
    /cannot verify settlement webhook: unknown option "maxAge"/,
  );
  assert.throws(
    () =>
      verifySettlementWebhookStrict(JSON.stringify(payload), signature, {
        secrets: [SECRET],
        maxAgeMs: -1,
        now: NOW,
      }),
    /cannot verify settlement webhook: maxAgeMs must be a finite non-negative number/,
  );
  assert.throws(
    () =>
      verifySettlementWebhookStrict(JSON.stringify(payload), signature, {
        secrets: [SECRET],
        requireEventId: "yes" as unknown as boolean,
        now: NOW,
      }),
    /cannot verify settlement webhook: requireEventId must be a boolean/,
  );
});

test("strict: malformed third argument still throws the legacy configuration error", () => {
  const { payload, signature } = keyedBody(NOW);
  assert.throws(
    () =>
      verifySettlementWebhookStrict(
        JSON.stringify(payload),
        signature,
        null as unknown as VerifyWebhookOptions,
      ),
    /cannot verify settlement webhook: secrets must be a non-empty array/,
  );
});
