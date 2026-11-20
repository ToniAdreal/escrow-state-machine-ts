/**
 * `buildSettlementWebhook` / `buildSettlementWebhooks` unknown-option
 * fail-closed (#1272).
 *
 * The sign side was the last gap in the fail-closed family:
 * `verifySettlementWebhook` scans `VerifyWebhookOptions` (#1262),
 * `SettlementEventDedupe` scans its constructor options (#1265), and
 * the escrow constructor/dispatch scan theirs (#548/#1254) — but the
 * two build entry points only read the keys they knew. A typo'd
 * `secrett` fell through to `assertSecret`, which read
 * `undefined.length` and threw a bare `TypeError`, and a typo'd
 * `eventId` / `eventIdFactory` silently fell back to the default
 * `randomUUID` factory, turning deterministic signatures random.
 * Unknown keys now throw
 * `cannot build settlement webhook(s): unknown option "<key>"` before
 * any signing, and a missing or non-string/Buffer secret throws a
 * configuration error instead of a bare `TypeError`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementWebhook,
  buildSettlementWebhooks,
  calculateDeposit,
  verifySettlementWebhook,
} from "../src/index.js";

const SECRET = "whsec_test_build_webhook_unknown_opts_20261120";
const FIXED_NOW = "2026-11-20T01:00:00.000Z";

function goldenDeposit() {
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

function releasedReport(id = "esc-build-unknown-opts") {
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

/** Assert the call throws a plain Error with exactly this message. */
function assertThrowsMessage(fn: () => unknown, message: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error, "expected an Error to be thrown");
  assert.equal(caught.message, message);
}

/**
 * Assert the call throws a configuration Error (a plain Error, never a
 * bare TypeError) with exactly this message.
 */
function assertThrowsConfigError(fn: () => unknown, message: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error, "expected an Error to be thrown");
  assert.ok(
    !(caught instanceof TypeError),
    `expected a configuration Error, got TypeError: ${caught.message}`,
  );
  assert.equal(caught.message, message);
}

// --- single build: legal keys still work ---------------------------------

test("build: three legal keys build and verify", () => {
  const report = releasedReport();
  const signed = buildSettlementWebhook(report, {
    secret: SECRET,
    now: FIXED_NOW,
    eventId: "evt-legal-keys",
  });
  assert.equal(signed.payload.eventId, "evt-legal-keys");
  assert.equal(signed.payload.at, FIXED_NOW);
  assert.equal(
    verifySettlementWebhook(JSON.stringify(signed.payload), signed.signature, SECRET),
    true,
  );
});

test("build: Buffer secret builds and verifies", () => {
  const report = releasedReport();
  const secret = Buffer.from(SECRET, "utf8");
  const signed = buildSettlementWebhook(report, {
    secret,
    now: FIXED_NOW,
    eventId: "evt-buffer-secret",
  });
  assert.equal(
    verifySettlementWebhook(JSON.stringify(signed.payload), signed.signature, secret),
    true,
  );
});

// --- single build: unknown keys fail closed --------------------------------

test("build: typo'd secrett is rejected with the exact message", () => {
  const report = releasedReport();
  assertThrowsMessage(
    () =>
      buildSettlementWebhook(report, {
        secrett: SECRET,
        eventId: "evt-1",
      } as never),
    'cannot build settlement webhook: unknown option "secrett"',
  );
});

test("build: typo'd eventid is rejected and names the key", () => {
  const report = releasedReport();
  assertThrowsMessage(
    () =>
      buildSettlementWebhook(report, {
        secret: SECRET,
        eventid: "evt-1",
      } as never),
    'cannot build settlement webhook: unknown option "eventid"',
  );
});

test("build: eventIdFactory is not a single-build key", () => {
  const report = releasedReport();
  assertThrowsMessage(
    () =>
      buildSettlementWebhook(report, {
        secret: SECRET,
        eventIdFactory: () => "evt-1",
      } as never),
    'cannot build settlement webhook: unknown option "eventIdFactory"',
  );
});

test("build: an unrelated extra key is rejected", () => {
  const report = releasedReport();
  assertThrowsMessage(
    () =>
      buildSettlementWebhook(report, {
        secret: SECRET,
        foo: "bar",
      } as never),
    'cannot build settlement webhook: unknown option "foo"',
  );
});

test("build: unknown key wins over a missing secret (scan runs first)", () => {
  const report = releasedReport();
  // No `secret` at all plus a typo: the unknown-option error is the
  // one reported, not the missing-secret error — the scan runs before
  // assertSecret, so the typo is reported as itself.
  assertThrowsMessage(
    () => buildSettlementWebhook(report, { secrett: SECRET } as never),
    'cannot build settlement webhook: unknown option "secrett"',
  );
});

test("build: a typo'd call signs nothing (the throw is the whole result)", () => {
  const report = releasedReport();
  assert.throws(
    () =>
      buildSettlementWebhook(report, {
        secret: SECRET,
        eventId: "evt-1",
        extra: true,
      } as never),
    /unknown option "extra"/,
  );
  // The same report still builds fine with legal keys afterwards: the
  // failed call left no partial webhook behind (building is pure).
  const signed = buildSettlementWebhook(report, {
    secret: SECRET,
    now: FIXED_NOW,
    eventId: "evt-after-typo",
  });
  assert.equal(signed.payload.eventId, "evt-after-typo");
});

// --- single build: missing / wrong-type secret is a config error -----------

test("build: missing secret throws a config error, not a bare TypeError", () => {
  const report = releasedReport();
  assertThrowsConfigError(
    () => buildSettlementWebhook(report, {} as never),
    "cannot build settlement webhook: signing secret must be a string or Buffer",
  );
});

test("build: numeric secret throws a config error, not a bare TypeError", () => {
  const report = releasedReport();
  assertThrowsConfigError(
    () => buildSettlementWebhook(report, { secret: 123 } as never),
    "cannot build settlement webhook: signing secret must be a string or Buffer",
  );
});

test("build: null options throw a config error, not a bare TypeError", () => {
  const report = releasedReport();
  assertThrowsConfigError(
    () => buildSettlementWebhook(report, null as never),
    "cannot build settlement webhook: signing secret must be a string or Buffer",
  );
});

test("build: empty string secret still reports empty, not wrong-type", () => {
  const report = releasedReport();
  assertThrowsMessage(
    () => buildSettlementWebhook(report, { secret: "" }),
    "cannot build settlement webhook: signing secret must not be empty",
  );
});

test("build: empty Buffer secret still reports empty, not wrong-type", () => {
  const report = releasedReport();
  assertThrowsMessage(
    () => buildSettlementWebhook(report, { secret: Buffer.alloc(0) }),
    "cannot build settlement webhook: signing secret must not be empty",
  );
});

// --- batch build: legal keys still work ------------------------------------

test("batch: three legal keys build with deterministic factory eventIds", () => {
  const first = releasedReport("esc-batch-unknown-opts-1");
  const second = releasedReport("esc-batch-unknown-opts-2");
  const results = buildSettlementWebhooks(
    [
      { escrowId: first.escrowId, report: first },
      { escrowId: second.escrowId, report: second },
    ],
    {
      secret: SECRET,
      now: FIXED_NOW,
      eventIdFactory: (() => {
        let n = 0;
        return () => `evt-batch-${++n}`;
      })(),
    },
  );
  assert.equal(results.length, 2);
  assert.equal(results[0].webhook?.payload.eventId, "evt-batch-1");
  assert.equal(results[1].webhook?.payload.eventId, "evt-batch-2");
  for (const entry of results) {
    assert.equal(entry.error, undefined);
    assert.equal(
      verifySettlementWebhook(
        JSON.stringify(entry.webhook!.payload),
        entry.webhook!.signature,
        SECRET,
      ),
      true,
    );
  }
});

// --- batch build: unknown keys fail closed ----------------------------------

test("batch: typo'd eventIdFactor is rejected with the exact message", () => {
  const report = releasedReport("esc-batch-typo-factory");
  assertThrowsMessage(
    () =>
      buildSettlementWebhooks([{ escrowId: report.escrowId, report }], {
        secret: SECRET,
        eventIdFactor: () => "evt-1",
      } as never),
    'cannot build settlement webhooks: unknown option "eventIdFactor"',
  );
});

test("batch: typo'd secert is rejected, not the secret-type error", () => {
  const report = releasedReport("esc-batch-typo-secret");
  // The scan runs before the call-level secret check, so the typo is
  // reported as itself instead of "signing secret must be a string or
  // Buffer".
  assertThrowsMessage(
    () =>
      buildSettlementWebhooks([{ escrowId: report.escrowId, report }], {
        secert: SECRET,
      } as never),
    'cannot build settlement webhooks: unknown option "secert"',
  );
});

test("batch: typo'd noww is rejected", () => {
  const report = releasedReport("esc-batch-typo-now");
  assertThrowsMessage(
    () =>
      buildSettlementWebhooks([{ escrowId: report.escrowId, report }], {
        secret: SECRET,
        noww: FIXED_NOW,
      } as never),
    'cannot build settlement webhooks: unknown option "noww"',
  );
});

test("batch: unknown key wins over an invalid now (scan runs first)", () => {
  const report = releasedReport("esc-batch-typo-now-invalid");
  assertThrowsMessage(
    () =>
      buildSettlementWebhooks([{ escrowId: report.escrowId, report }], {
        secret: SECRET,
        now: "not-a-date",
        extra: 1,
      } as never),
    'cannot build settlement webhooks: unknown option "extra"',
  );
});

test("batch: missing secret with no unknown keys keeps the existing error", () => {
  const report = releasedReport("esc-batch-missing-secret");
  assertThrowsMessage(
    () =>
      buildSettlementWebhooks(
        [{ escrowId: report.escrowId, report }],
        {} as never,
      ),
    "cannot build settlement webhooks: signing secret must be a string or Buffer",
  );
});

test("batch: a typo'd call signs zero webhooks", () => {
  const first = releasedReport("esc-batch-zero-1");
  const second = releasedReport("esc-batch-zero-2");
  // The throw happens before any report is attempted, so no webhook
  // is produced for either entry — there is no partial batch to leak.
  assert.throws(
    () =>
      buildSettlementWebhooks(
        [
          { escrowId: first.escrowId, report: first },
          { escrowId: second.escrowId, report: second },
        ],
        { secret: SECRET, eventIdFactor: () => "evt-1" } as never,
      ),
    /unknown option "eventIdFactor"/,
  );
});
