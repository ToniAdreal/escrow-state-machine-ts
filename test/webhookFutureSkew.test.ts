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

/**
 * Settlement webhook future-skew bound (backlog #150):
 * `VerifyWebhookOptions.maxFutureSkewMs` — the escrow-side pair of
 * dataquest #148, with identical semantics, naming, and boundaries.
 *
 * Rules under test:
 *  - only after the HMAC signature matches, `at - now > maxFutureSkewMs`
 *    returns false (fail-closed, never throws)
 *  - the boundary is inclusive: skew exactly `maxFutureSkewMs` passes,
 *    one millisecond more fails; `maxFutureSkewMs: 0` passes only
 *    `at == now` (or earlier)
 *  - unset keeps legacy behavior: a far-future timestamp still passes,
 *    including under a `maxAgeMs`-only window
 *  - illegal `maxFutureSkewMs` (negative / NaN / Infinity / non-number)
 *    throws a caller configuration error, in the `maxAgeMs` style
 *  - a forged signature fails on the signature check, before any
 *    timestamp is looked at
 *  - secret rotation does not relax the bound, and `maxAgeMs` +
 *    `maxFutureSkewMs` together form a two-sided window
 */

const SECRET = "whsec_test_webhook_future_skew_20261010";
const OLD_SECRET = "whsec_test_webhook_future_skew_old";
const NOW = Date.parse("2026-10-10T00:00:00.000Z");
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

function releasedReport(id = "esc-future-skew") {
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

/** Sign an arbitrary body object with the test secret (test-side signer). */
function signBody(body: unknown, secret: string = SECRET): string {
  const bodyString = JSON.stringify(body);
  return (
    "sha256=" +
    createHmac("sha256", secret).update(bodyString, "utf8").digest("hex")
  );
}

test("future-skew: far-future payload beyond maxFutureSkewMs returns false (object and string bodies)", () => {
  const { payload, signature } = buildSettlementWebhook(releasedReport(), {
    secret: SECRET,
    now: new Date(NOW + 2 * ONE_HOUR),
  });
  const opts = { secrets: [SECRET], maxFutureSkewMs: ONE_HOUR, now: NOW };
  // The signature itself is valid — only the future-skew gate rejects it.
  assert.equal(verifySettlementWebhook(payload, signature, SECRET), true);
  assert.equal(verifySettlementWebhook(payload, signature, opts), false);
  assert.equal(
    verifySettlementWebhook(JSON.stringify(payload), signature, opts),
    false,
  );
});

test("future-skew: future payload inside the window, and exactly at its boundary, passes", () => {
  const inside = buildSettlementWebhook(releasedReport("esc-future-inside"), {
    secret: SECRET,
    now: new Date(NOW + ONE_HOUR - 1),
  });
  assert.equal(
    verifySettlementWebhook(inside.payload, inside.signature, {
      secrets: [SECRET],
      maxFutureSkewMs: ONE_HOUR,
      now: NOW,
    }),
    true,
  );
  const atBoundary = buildSettlementWebhook(
    releasedReport("esc-future-boundary"),
    { secret: SECRET, now: new Date(NOW + ONE_HOUR) },
  );
  const boundaryOpts = {
    secrets: [SECRET],
    maxFutureSkewMs: ONE_HOUR,
    now: NOW,
  };
  assert.equal(
    verifySettlementWebhook(atBoundary.payload, atBoundary.signature, boundaryOpts),
    true,
  );
  assert.equal(
    verifySettlementWebhook(
      JSON.stringify(atBoundary.payload),
      atBoundary.signature,
      boundaryOpts,
    ),
    true,
  );
  // One millisecond past the boundary fails.
  const pastBoundary = buildSettlementWebhook(
    releasedReport("esc-future-past-boundary"),
    { secret: SECRET, now: new Date(NOW + ONE_HOUR + 1) },
  );
  assert.equal(
    verifySettlementWebhook(pastBoundary.payload, pastBoundary.signature, boundaryOpts),
    false,
  );
  // A past payload is never rejected by the future bound alone.
  const past = buildSettlementWebhook(releasedReport("esc-future-past"), {
    secret: SECRET,
    now: new Date(NOW - 365 * 24 * ONE_HOUR),
  });
  assert.equal(
    verifySettlementWebhook(past.payload, past.signature, boundaryOpts),
    true,
  );
});

test("future-skew: maxFutureSkewMs 0 boundary — at == now passes, 1ms in the future fails", () => {
  const exact = buildSettlementWebhook(releasedReport("esc-zero-skew"), {
    secret: SECRET,
    now: new Date(NOW),
  });
  assert.equal(
    verifySettlementWebhook(exact.payload, exact.signature, {
      secrets: [SECRET],
      maxFutureSkewMs: 0,
      now: NOW,
    }),
    true,
  );
  const oneMsFuture = buildSettlementWebhook(
    releasedReport("esc-zero-skew-future"),
    { secret: SECRET, now: new Date(NOW + 1) },
  );
  assert.equal(
    verifySettlementWebhook(oneMsFuture.payload, oneMsFuture.signature, {
      secrets: [SECRET],
      maxFutureSkewMs: 0,
      now: NOW,
    }),
    false,
  );
});

test("future-skew: omitting maxFutureSkewMs keeps legacy behavior (far future still passes)", () => {
  const { payload, signature } = buildSettlementWebhook(releasedReport(), {
    secret: SECRET,
    now: new Date(NOW + 365 * 24 * ONE_HOUR),
  });
  assert.equal(verifySettlementWebhook(payload, signature, SECRET), true);
  assert.equal(
    verifySettlementWebhook(payload, signature, { secrets: [SECRET] }),
    true,
  );
  // A maxAgeMs-only window does not bound the future either.
  assert.equal(
    verifySettlementWebhook(payload, signature, {
      secrets: [SECRET],
      maxAgeMs: ONE_HOUR,
      now: NOW,
    }),
    true,
  );
});

test("future-skew: secret rotation does not relax the bound", () => {
  const { payload, signature } = buildSettlementWebhook(releasedReport(), {
    secret: OLD_SECRET,
    now: new Date(NOW + 2 * ONE_HOUR),
  });
  // Signed with the OLD secret during the rotation window and inside the
  // future window: passes.
  const near = buildSettlementWebhook(releasedReport("esc-rotation-near"), {
    secret: OLD_SECRET,
    now: new Date(NOW),
  });
  assert.equal(
    verifySettlementWebhook(near.payload, near.signature, {
      secrets: [SECRET, OLD_SECRET],
      maxFutureSkewMs: ONE_HOUR,
      now: NOW,
    }),
    true,
  );
  // The same rotation candidate set still rejects the far-future payload.
  assert.equal(
    verifySettlementWebhook(payload, signature, {
      secrets: [SECRET, OLD_SECRET],
      maxFutureSkewMs: ONE_HOUR,
      now: NOW,
    }),
    false,
  );
});

test("future-skew: illegal maxFutureSkewMs values throw a configuration error", () => {
  const { payload, signature } = buildSettlementWebhook(releasedReport(), {
    secret: SECRET,
    now: new Date(NOW),
  });
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "60000" as never]) {
    assert.throws(
      () =>
        verifySettlementWebhook(payload, signature, {
          secrets: [SECRET],
          maxFutureSkewMs: bad,
          now: NOW,
        }),
      /maxFutureSkewMs must be a finite non-negative number/,
    );
  }
});

test("future-skew: forged signature fails on the signature check, before any timestamp check", () => {
  const { payload, signature } = buildSettlementWebhook(releasedReport(), {
    secret: SECRET,
    now: new Date(NOW + 2 * ONE_HOUR),
  });
  const opts = { secrets: [SECRET], maxFutureSkewMs: ONE_HOUR, now: NOW };
  // Wrong secret: a signature failure, regardless of the timestamp.
  assert.equal(
    verifySettlementWebhook(payload, signature, {
      secrets: [OLD_SECRET],
      maxFutureSkewMs: ONE_HOUR,
      now: NOW,
    }),
    false,
  );
  // Tampering `at` back into the window cannot help: the attacker cannot
  // re-sign, so the signature check rejects the forged body.
  const forged: SettlementWebhookPayload = {
    ...payload,
    at: new Date(NOW).toISOString(),
  };
  assert.equal(verifySettlementWebhook(forged, signature, opts), false);
  assert.equal(
    verifySettlementWebhook(JSON.stringify(forged), signature, opts),
    false,
  );
});

test("future-skew: maxAgeMs and maxFutureSkewMs together form a two-sided window", () => {
  const opts = {
    secrets: [SECRET],
    maxAgeMs: ONE_HOUR,
    maxFutureSkewMs: ONE_HOUR,
    now: NOW,
  };
  const inside = buildSettlementWebhook(releasedReport("esc-two-sided-in"), {
    secret: SECRET,
    now: new Date(NOW + 30 * 60_000),
  });
  assert.equal(
    verifySettlementWebhook(inside.payload, inside.signature, opts),
    true,
  );
  const tooOld = buildSettlementWebhook(releasedReport("esc-two-sided-old"), {
    secret: SECRET,
    now: new Date(NOW - 2 * ONE_HOUR),
  });
  assert.equal(
    verifySettlementWebhook(tooOld.payload, tooOld.signature, opts),
    false,
  );
  const tooFuture = buildSettlementWebhook(
    releasedReport("esc-two-sided-future"),
    { secret: SECRET, now: new Date(NOW + 2 * ONE_HOUR) },
  );
  assert.equal(
    verifySettlementWebhook(tooFuture.payload, tooFuture.signature, opts),
    false,
  );
});

test("future-skew: unparseable at with only maxFutureSkewMs set fails closed; without it the signature decides", () => {
  const { payload } = buildSettlementWebhook(releasedReport(), {
    secret: SECRET,
    now: new Date(NOW),
  });
  const bad: SettlementWebhookPayload = { ...payload, at: "banana" };
  const body = JSON.stringify(bad);
  const sig = signBody(bad);
  const opts = { secrets: [SECRET], maxFutureSkewMs: ONE_HOUR, now: NOW };
  assert.equal(verifySettlementWebhook(bad, sig, opts), false);
  assert.equal(verifySettlementWebhook(body, sig, opts), false);
  // Backward compat: with no freshness bound at all, the signature decides.
  assert.equal(verifySettlementWebhook(bad, sig, SECRET), true);
  assert.equal(verifySettlementWebhook(body, sig, SECRET), true);
});
