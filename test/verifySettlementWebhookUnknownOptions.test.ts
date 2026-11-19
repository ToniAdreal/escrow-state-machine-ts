/**
 * `VerifyWebhookOptions` unknown-field fail-closed (#1262).
 *
 * `verifySettlementWebhook` validated each of its five known option
 * keys (`secrets`, `maxAgeMs`, `maxFutureSkewMs`, `requireEventId`,
 * `now`) but never scanned the keys: a typo'd `maxAge` was silently
 * dropped, so a caller that believed a freshness window was on got
 * signature-only verification instead — a year-old legitimately-signed
 * notification verified while the replay bound the caller thought it
 * had never existed. Same silent-config-loss class as #1254
 * (`DispatchOptions`) and rfc9421 #1251, on the receiver side.
 * Unknown keys now throw
 * `cannot verify settlement webhook: unknown option "<key>"` after
 * the `secrets` non-empty check and before any other field is read
 * or the signature is compared. The string/Buffer single-secret
 * overload has no keys to scan and is unaffected.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementWebhook,
  calculateDeposit,
  verifySettlementWebhook,
} from "../src/index.js";

const SECRET = "whsec_test_webhook_unknown_opts_20261119";
const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const ONE_HOUR = 3_600_000;
const WELL_FORMED_SIG = "sha256=" + "ab".repeat(32);

function goldenDeposit() {
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

function releasedReport(id = "esc-verify-unknown-opts") {
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

/** A signed payload issued exactly at the pinned NOW. */
function signedAtNow() {
  return buildSettlementWebhook(releasedReport(), {
    secret: SECRET,
    now: new Date(NOW),
  });
}

test("unknown options: all five known keys together still verify", () => {
  const { payload, signature } = signedAtNow();
  assert.equal(
    verifySettlementWebhook(payload, signature, {
      secrets: [SECRET],
      maxAgeMs: ONE_HOUR,
      maxFutureSkewMs: 60_000,
      requireEventId: true,
      now: NOW,
    }),
    true,
  );
});

test("unknown options: secrets-only options form still verifies", () => {
  const { payload, signature } = signedAtNow();
  assert.equal(
    verifySettlementWebhook(payload, signature, { secrets: [SECRET] }),
    true,
  );
});

test("unknown options: maxAgeMs path still verifies a fresh payload", () => {
  const { payload, signature } = signedAtNow();
  assert.equal(
    verifySettlementWebhook(payload, signature, {
      secrets: [SECRET],
      maxAgeMs: ONE_HOUR,
      now: NOW,
    }),
    true,
  );
});

test("unknown options: maxFutureSkewMs path still verifies within the skew", () => {
  const { payload, signature } = signedAtNow();
  assert.equal(
    verifySettlementWebhook(payload, signature, {
      secrets: [SECRET],
      maxFutureSkewMs: 60_000,
      now: NOW - 30_000,
    }),
    true,
  );
});

test("unknown options: requireEventId path still verifies a keyed payload", () => {
  const { payload, signature } = signedAtNow();
  assert.equal(
    verifySettlementWebhook(payload, signature, {
      secrets: [SECRET],
      requireEventId: true,
    }),
    true,
  );
});

test("unknown options: now-only path still verifies", () => {
  const { payload, signature } = signedAtNow();
  assert.equal(
    verifySettlementWebhook(payload, signature, {
      secrets: [SECRET],
      now: NOW,
    }),
    true,
  );
});

test("unknown options: typo'd maxAge is rejected with the exact message", () => {
  const { payload, signature } = signedAtNow();
  assert.throws(
    () =>
      verifySettlementWebhook(payload, signature, {
        secrets: [SECRET],
        maxAge: ONE_HOUR,
      } as never),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(
        err.message,
        'cannot verify settlement webhook: unknown option "maxAge"',
      );
      return true;
    },
  );
});

test("unknown options: typo'd maxageMs is rejected", () => {
  const { payload, signature } = signedAtNow();
  assert.throws(
    () =>
      verifySettlementWebhook(payload, signature, {
        secrets: [SECRET],
        maxageMs: ONE_HOUR,
      } as never),
    /cannot verify settlement webhook: unknown option "maxageMs"/,
  );
});

test("unknown options: typo'd requireEventID is rejected", () => {
  const { payload, signature } = signedAtNow();
  assert.throws(
    () =>
      verifySettlementWebhook(payload, signature, {
        secrets: [SECRET],
        requireEventID: true,
      } as never),
    /cannot verify settlement webhook: unknown option "requireEventID"/,
  );
});

test("unknown options: secrets2 is rejected", () => {
  const { payload, signature } = signedAtNow();
  // `secrets` is present (so the secrets check passes) and the extra
  // `secrets2` key is the typo under test; without `secrets` at all the
  // call already throws the non-empty-secrets error, never silently
  // proceeds, so the typo class this closes is the extra-key form.
  assert.throws(
    () =>
      verifySettlementWebhook(payload, signature, {
        secrets: [SECRET],
        secrets2: [SECRET],
      } as never),
    /cannot verify settlement webhook: unknown option "secrets2"/,
  );
});

test("unknown options: nowMs is rejected", () => {
  const { payload, signature } = signedAtNow();
  assert.throws(
    () =>
      verifySettlementWebhook(payload, signature, {
        secrets: [SECRET],
        nowMs: NOW,
      } as never),
    /cannot verify settlement webhook: unknown option "nowMs"/,
  );
});

test("unknown options: a rejected call never returns true, even for a forged signature", () => {
  // The unknown-key check runs before the signature comparison, so a
  // bad signature does not turn the throw into a quiet `false`.
  const { payload } = signedAtNow();
  assert.throws(
    () =>
      verifySettlementWebhook(payload, WELL_FORMED_SIG, {
        secrets: [SECRET],
        maxAge: ONE_HOUR,
      } as never),
    /cannot verify settlement webhook: unknown option "maxAge"/,
  );
});

test("unknown options: string single-secret overload is unaffected", () => {
  const { payload, signature } = signedAtNow();
  assert.equal(verifySettlementWebhook(payload, signature, SECRET), true);
});

test("unknown options: Buffer single-secret overload is unaffected", () => {
  const { payload, signature } = signedAtNow();
  assert.equal(
    verifySettlementWebhook(payload, signature, Buffer.from(SECRET)),
    true,
  );
});

test("unknown options: empty secrets error still wins over the unknown-key error", () => {
  const { payload, signature } = signedAtNow();
  assert.throws(
    () =>
      verifySettlementWebhook(payload, signature, {
        secrets: [],
        maxAge: ONE_HOUR,
      } as never),
    /cannot verify settlement webhook: secrets must be a non-empty array/,
  );
});
