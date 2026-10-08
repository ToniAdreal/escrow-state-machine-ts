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

const SECRET = "whsec_test_webhook_freshness_20261008";
const OLD_SECRET = "whsec_old_rotated_out_20261008";
const NOW = Date.parse("2026-10-08T12:00:00.000Z");
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

function releasedReport(id = "esc-freshness") {
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

test("freshness: fresh payload passes the maxAgeMs window", () => {
  const { payload, signature } = buildSettlementWebhook(releasedReport(), {
    secret: SECRET,
    now: new Date(NOW),
  });
  assert.equal(
    verifySettlementWebhook(payload, signature, {
      secrets: [SECRET],
      maxAgeMs: ONE_HOUR,
      now: NOW,
    }),
    true,
  );
});

test("freshness: expired payload fails fail-closed", () => {
  const { payload, signature } = buildSettlementWebhook(releasedReport(), {
    secret: SECRET,
    now: new Date(NOW - 2 * ONE_HOUR),
  });
  assert.equal(
    verifySettlementWebhook(payload, signature, {
      secrets: [SECRET],
      maxAgeMs: ONE_HOUR,
      now: NOW,
    }),
    false,
  );
});

test("freshness: unset maxAgeMs keeps signature-only behavior (old payload verifies)", () => {
  const { payload, signature } = buildSettlementWebhook(releasedReport(), {
    secret: SECRET,
    now: new Date(NOW - 365 * 24 * ONE_HOUR),
  });
  // A year-old signature is still cryptographically valid without the opt-in.
  assert.equal(verifySettlementWebhook(payload, signature, SECRET), true);
});

test("freshness: boundary — age exactly maxAgeMs passes", () => {
  const { payload, signature } = buildSettlementWebhook(releasedReport(), {
    secret: SECRET,
    now: new Date(NOW - ONE_HOUR),
  });
  assert.equal(
    verifySettlementWebhook(payload, signature, {
      secrets: [SECRET],
      maxAgeMs: ONE_HOUR,
      now: NOW,
    }),
    true,
  );
});

test("freshness: one millisecond past the window fails", () => {
  const { payload, signature } = buildSettlementWebhook(releasedReport(), {
    secret: SECRET,
    now: new Date(NOW - ONE_HOUR - 1),
  });
  assert.equal(
    verifySettlementWebhook(payload, signature, {
      secrets: [SECRET],
      maxAgeMs: ONE_HOUR,
      now: NOW,
    }),
    false,
  );
});

test("freshness: string-body overload parity (fresh passes, expired fails)", () => {
  const fresh = buildSettlementWebhook(releasedReport(), {
    secret: SECRET,
    now: new Date(NOW),
  });
  const expired = buildSettlementWebhook(releasedReport("esc-freshness-2"), {
    secret: SECRET,
    now: new Date(NOW - 2 * ONE_HOUR),
  });
  const opts = { secrets: [SECRET], maxAgeMs: ONE_HOUR, now: NOW };
  assert.equal(
    verifySettlementWebhook(JSON.stringify(fresh.payload), fresh.signature, opts),
    true,
  );
  assert.equal(
    verifySettlementWebhook(
      JSON.stringify(expired.payload),
      expired.signature,
      opts,
    ),
    false,
  );
});

test("freshness: invalid at + maxAgeMs fails closed", () => {
  const { payload } = buildSettlementWebhook(releasedReport(), {
    secret: SECRET,
    now: new Date(NOW),
  });
  const bad: SettlementWebhookPayload = { ...payload, at: "banana" };
  const body = JSON.stringify(bad);
  const sig = signBody(bad);
  assert.equal(
    verifySettlementWebhook(bad, sig, {
      secrets: [SECRET],
      maxAgeMs: ONE_HOUR,
      now: NOW,
    }),
    false,
  );
  assert.equal(
    verifySettlementWebhook(body, sig, {
      secrets: [SECRET],
      maxAgeMs: ONE_HOUR,
      now: NOW,
    }),
    false,
  );
});

test("freshness: invalid at without maxAgeMs is judged by the signature alone", () => {
  const { payload } = buildSettlementWebhook(releasedReport(), {
    secret: SECRET,
    now: new Date(NOW),
  });
  const bad: SettlementWebhookPayload = { ...payload, at: "banana" };
  const body = JSON.stringify(bad);
  const sig = signBody(bad);
  // Backward compat: freshness is opt-in; a valid signature decides.
  assert.equal(verifySettlementWebhook(bad, sig, SECRET), true);
  assert.equal(verifySettlementWebhook(body, sig, SECRET), true);
});

test("freshness: unparseable string body + maxAgeMs fails closed, not throws", () => {
  const opts = { secrets: [SECRET], maxAgeMs: ONE_HOUR, now: NOW };
  assert.equal(verifySettlementWebhook("not json at all", WELL_FORMED_SIG, opts), false);
  // Valid JSON but not an object with a string `at`.
  assert.equal(verifySettlementWebhook('"just a string"', WELL_FORMED_SIG, opts), false);
  assert.equal(verifySettlementWebhook("42", WELL_FORMED_SIG, opts), false);
  assert.equal(verifySettlementWebhook("null", WELL_FORMED_SIG, opts), false);
});

test("freshness: forgery fails on the signature check, before any freshness gate", () => {
  const { payload, signature } = buildSettlementWebhook(releasedReport(), {
    secret: SECRET,
    now: new Date(NOW),
  });
  // Fresh (inside the window) but tampered: signature must reject it.
  const tampered: SettlementWebhookPayload = { ...payload, deposit: 1 };
  assert.equal(
    verifySettlementWebhook(tampered, signature, {
      secrets: [SECRET],
      maxAgeMs: ONE_HOUR,
      now: NOW,
    }),
    false,
  );
  // Wrong secret: also a signature failure, not a freshness verdict.
  assert.equal(
    verifySettlementWebhook(payload, signature, {
      secrets: [OLD_SECRET],
      maxAgeMs: ONE_HOUR,
      now: NOW,
    }),
    false,
  );
});

test("freshness: works together with secret rotation", () => {
  const { payload, signature } = buildSettlementWebhook(releasedReport(), {
    secret: OLD_SECRET,
    now: new Date(NOW),
  });
  // Signed with the OLD secret during the rotation window: fresh passes…
  assert.equal(
    verifySettlementWebhook(payload, signature, {
      secrets: [SECRET, OLD_SECRET],
      maxAgeMs: ONE_HOUR,
      now: NOW,
    }),
    true,
  );
  // …and the same legitimately-signed payload fails when it is stale.
  const stale = buildSettlementWebhook(releasedReport("esc-freshness-3"), {
    secret: OLD_SECRET,
    now: new Date(NOW - 2 * ONE_HOUR),
  });
  assert.equal(
    verifySettlementWebhook(stale.payload, stale.signature, {
      secrets: [SECRET, OLD_SECRET],
      maxAgeMs: ONE_HOUR,
      now: NOW,
    }),
    false,
  );
});

test("freshness: default now uses the real clock", () => {
  // Built "just now" on the wall clock; a 60s window with an uninjected now
  // must pass on any machine.
  const { payload, signature } = buildSettlementWebhook(releasedReport(), {
    secret: SECRET,
  });
  assert.equal(
    verifySettlementWebhook(payload, signature, {
      secrets: [SECRET],
      maxAgeMs: 60_000,
    }),
    true,
  );
});

test("freshness: illegal maxAgeMs values throw a configuration error", () => {
  const { payload, signature } = buildSettlementWebhook(releasedReport(), {
    secret: SECRET,
    now: new Date(NOW),
  });
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "60000" as never]) {
    assert.throws(
      () =>
        verifySettlementWebhook(payload, signature, {
          secrets: [SECRET],
          maxAgeMs: bad,
          now: NOW,
        }),
      /maxAgeMs must be a finite non-negative number/,
    );
  }
  // maxAgeMs: 0 is legal (only age <= 0 passes).
  assert.equal(
    verifySettlementWebhook(payload, signature, {
      secrets: [SECRET],
      maxAgeMs: 0,
      now: NOW,
    }),
    true,
  );
});

test("freshness: illegal now values throw a configuration error", () => {
  const { payload, signature } = buildSettlementWebhook(releasedReport(), {
    secret: SECRET,
    now: new Date(NOW),
  });
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "x" as never]) {
    assert.throws(
      () =>
        verifySettlementWebhook(payload, signature, {
          secrets: [SECRET],
          maxAgeMs: ONE_HOUR,
          now: bad,
        }),
      /now must be a finite epoch-millisecond number/,
    );
  }
});
