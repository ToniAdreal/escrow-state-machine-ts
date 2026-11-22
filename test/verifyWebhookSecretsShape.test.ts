import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementWebhook,
  calculateDeposit,
  verifySettlementWebhook,
} from "../src/index.js";

const SECRET = "whsec_shape_guard";
const OTHER_SECRET = "whsec_shape_guard_old";
const FIXED_NOW = "2026-10-07T18:00:00.000Z";

function settledReport() {
  const e = new Escrow("esc-secrets-shape");
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

/** A config error is a plain Error carrying the `cannot verify …` prefix — never a bare TypeError. */
function assertConfigError(fn: () => unknown, pattern: RegExp) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof Error, "must throw an Error");
    assert.ok(
      !(err instanceof TypeError),
      `must not be a bare TypeError, got: ${String(err)}`,
    );
    assert.match(err.message, pattern);
    return true;
  });
}

test("a numeric entry in secrets throws a config error, not a TypeError from createHmac", () => {
  const { payload, signature } = signedWith(SECRET);
  assertConfigError(
    () =>
      verifySettlementWebhook(payload, signature, {
        secrets: [123 as never],
      }),
    /cannot verify settlement webhook: secrets\[0\] must not be empty/,
  );
});

test("a null entry in secrets throws a config error", () => {
  const { payload, signature } = signedWith(SECRET);
  assertConfigError(
    () =>
      verifySettlementWebhook(payload, signature, {
        secrets: [null as never],
      }),
    /cannot verify settlement webhook: secrets\[0\] must not be empty/,
  );
});

test("an object entry in secrets throws a config error", () => {
  const { payload, signature } = signedWith(SECRET);
  assertConfigError(
    () =>
      verifySettlementWebhook(payload, signature, {
        secrets: [{ toString: () => SECRET } as never],
      }),
    /cannot verify settlement webhook: secrets\[0\] must not be empty/,
  );
});

test("a non-string entry at a later index reports its own position", () => {
  const { payload, signature } = signedWith(SECRET);
  assertConfigError(
    () =>
      verifySettlementWebhook(payload, signature, {
        secrets: [SECRET, true as never],
      }),
    /cannot verify settlement webhook: secrets\[1\] must not be empty/,
  );
});

test("a non-array secrets value throws a config error, not a TypeError from forEach", () => {
  const { payload, signature } = signedWith(SECRET);
  assertConfigError(
    () =>
      verifySettlementWebhook(payload, signature, {
        secrets: "abc" as never,
      }),
    /cannot verify settlement webhook: secrets must be a non-empty array/,
  );
});

test("an options object without secrets throws a config error", () => {
  const { payload, signature } = signedWith(SECRET);
  assertConfigError(
    () => verifySettlementWebhook(payload, signature, {} as never),
    /cannot verify settlement webhook: secrets must be a non-empty array/,
  );
});

test("a numeric third argument throws a config error, not a TypeError from .secrets", () => {
  const { payload, signature } = signedWith(SECRET);
  assertConfigError(
    () => verifySettlementWebhook(payload, signature, 123 as never),
    /cannot verify settlement webhook: secrets must be a non-empty array/,
  );
});

test("a null third argument throws a config error", () => {
  const { payload, signature } = signedWith(SECRET);
  assertConfigError(
    () => verifySettlementWebhook(payload, signature, null as never),
    /cannot verify settlement webhook: secrets must be a non-empty array/,
  );
});

test("an empty string entry is still rejected", () => {
  const { payload, signature } = signedWith(SECRET);
  assertConfigError(
    () =>
      verifySettlementWebhook(payload, signature, {
        secrets: [SECRET, ""],
      }),
    /cannot verify settlement webhook: secrets\[1\] must not be empty/,
  );
});

test("an empty Buffer entry is still rejected", () => {
  const { payload, signature } = signedWith(SECRET);
  assertConfigError(
    () =>
      verifySettlementWebhook(payload, signature, {
        secrets: [Buffer.alloc(0)],
      }),
    /cannot verify settlement webhook: secrets\[0\] must not be empty/,
  );
});

test("valid multi-secret rotation still verifies", () => {
  const { payload, signature } = signedWith(OTHER_SECRET);
  assert.equal(
    verifySettlementWebhook(payload, signature, {
      secrets: [SECRET, OTHER_SECRET],
    }),
    true,
  );
});

test("a valid positional Buffer secret still verifies", () => {
  const { payload, signature } = signedWith(SECRET);
  assert.equal(
    verifySettlementWebhook(payload, signature, Buffer.from(SECRET, "utf8")),
    true,
  );
});
