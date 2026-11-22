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
import type { SettlementReport } from "../src/index.js";

/**
 * Settlement webhook report-shape validation (backlog #1329).
 *
 * Until now `buildPayload` dereferenced a hand-built report's fields with
 * no shape checks, so a malformed report either crashed the signer with
 * a bare `TypeError` (`null`, `{}`, a non-array `parties`) or — worse —
 * was signed anyway with a missing deposit, a `null` deposit, or a
 * meaningless outcome, producing a webhook whose signature verifies but
 * whose figures are nonsense. Every case below must throw a
 * `cannot build settlement webhook: …` configuration error before
 * anything is signed, and a standard report built by
 * `buildSettlementReport` must keep building and verifying byte-for-byte.
 * The outcome set is the full `SettlementOutcome` union: a
 * `"partially-released"` report is a real report the library can mint,
 * so it is accepted (the backlog item's three-value list omits it; see
 * `SettlementWebhookPayload.outcome`).
 */

const SECRET = "whsec_test_webhook_report_shape_20261122";
const FIXED_NOW = "2026-11-22T13:30:00.000Z";
const FIXED_EVENT_ID = "evt-report-shape-1";

function goldenDeposit() {
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

function reportFor(
  escrow: Escrow,
  settlement?: { proFeeBps: number },
): SettlementReport {
  return buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: goldenDeposit(),
    ...(settlement ? { settlement } : {}),
  });
}

function releasedReport(id = "esc-shape-released"): SettlementReport {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return reportFor(e, { proFeeBps: 500 });
}

function refundedReport(id = "esc-shape-refunded"): SettlementReport {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("DISPUTE");
  e.dispatch("ARBITRATE_REFUND");
  return reportFor(e);
}

function expiredReport(id = "esc-shape-expired"): SettlementReport {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("EXPIRE");
  return reportFor(e);
}

/** Deep-copy a report so mutations never touch the golden fixture. */
function cloneReport(report: SettlementReport): Record<string, any> {
  return JSON.parse(JSON.stringify(report));
}

function build(report: unknown) {
  return buildSettlementWebhook(report as SettlementReport, {
    secret: SECRET,
    now: FIXED_NOW,
    eventId: FIXED_EVENT_ID,
  });
}

test("null report throws a configuration error, never a bare TypeError", () => {
  assert.throws(() => build(null), {
    message:
      "cannot build settlement webhook: report must be an object",
  });
});

test("array report throws a configuration error", () => {
  assert.throws(() => build([]), {
    message:
      "cannot build settlement webhook: report must be an object",
  });
});

test("empty object report throws the escrowId error", () => {
  assert.throws(() => build({}), {
    message:
      "cannot build settlement webhook: escrowId must be a non-empty string",
  });
});

test("empty-string escrowId throws the escrowId error", () => {
  const report = cloneReport(releasedReport());
  report.escrowId = "";
  assert.throws(() => build(report), {
    message:
      "cannot build settlement webhook: escrowId must be a non-empty string",
  });
});

test("non-string escrowId throws the escrowId error", () => {
  const report = cloneReport(releasedReport());
  report.escrowId = 123;
  assert.throws(() => build(report), {
    message:
      "cannot build settlement webhook: escrowId must be a non-empty string",
  });
});

test("bogus outcome throws the outcome error naming the valid set", () => {
  const report = cloneReport(releasedReport());
  report.outcome = "bogus-outcome";
  assert.throws(() => build(report), {
    message:
      'cannot build settlement webhook: invalid settlement outcome for esc-shape-released: "bogus-outcome" must be one of "released", "refunded", "expired", "partially-released"',
  });
});

test("missing outcome throws the outcome error with got undefined", () => {
  const report = cloneReport(releasedReport());
  delete report.outcome;
  assert.throws(() => build(report), {
    message:
      'cannot build settlement webhook: invalid settlement outcome for esc-shape-released: undefined must be one of "released", "refunded", "expired", "partially-released"',
  });
});

test("string deposit throws the deposit-object error", () => {
  const report = cloneReport(releasedReport());
  report.deposit = "nope";
  assert.throws(() => build(report), {
    message:
      "cannot build settlement webhook: 'deposit' must be an object for esc-shape-released",
  });
});

test("null deposit throws the deposit-object error", () => {
  const report = cloneReport(releasedReport());
  report.deposit = null;
  assert.throws(() => build(report), {
    message:
      "cannot build settlement webhook: 'deposit' must be an object for esc-shape-released",
  });
});

test("NaN deposit amount throws the finite-deposit error", () => {
  const report = cloneReport(releasedReport());
  report.deposit = { deposit: NaN };
  assert.throws(() => build(report), {
    message:
      "cannot build settlement webhook: 'deposit.deposit' must be a finite non-negative number for esc-shape-released, got NaN",
  });
});

test("negative deposit amount throws the finite-deposit error", () => {
  const report = cloneReport(releasedReport());
  report.deposit.deposit = -1;
  assert.throws(() => build(report), {
    message:
      "cannot build settlement webhook: 'deposit.deposit' must be a finite non-negative number for esc-shape-released, got -1",
  });
});

test("infinite deposit amount throws the finite-deposit error", () => {
  const report = cloneReport(releasedReport());
  report.deposit.deposit = Infinity;
  assert.throws(() => build(report), {
    message:
      "cannot build settlement webhook: 'deposit.deposit' must be a finite non-negative number for esc-shape-released, got Infinity",
  });
});

test("non-array parties throws the parties-array error", () => {
  const report = cloneReport(releasedReport());
  report.parties = "nope";
  assert.throws(() => build(report), {
    message:
      "cannot build settlement webhook: 'parties' must be an array for esc-shape-released",
  });
});

test("null party entry throws the indexed party-object error", () => {
  const report = cloneReport(releasedReport());
  report.parties = [null];
  assert.throws(() => build(report), {
    message:
      "cannot build settlement webhook: parties[0] must be an object for esc-shape-released",
  });
});

test("string party inflow throws the indexed finite-number error", () => {
  const report = cloneReport(releasedReport());
  report.parties[0].inflow = "lots";
  assert.throws(() => build(report), {
    message:
      "cannot build settlement webhook: parties[0].inflow must be a finite number for esc-shape-released, got lots",
  });
});

test("NaN party net throws the indexed finite-number error", () => {
  const report = cloneReport(releasedReport());
  report.parties[0].net = NaN;
  assert.throws(() => build(report), {
    message:
      "cannot build settlement webhook: parties[0].net must be a finite number for esc-shape-released, got NaN",
  });
});

test("missing party outflow throws the indexed finite-number error", () => {
  const report = cloneReport(releasedReport());
  delete report.parties[0].outflow;
  assert.throws(() => build(report), {
    message:
      "cannot build settlement webhook: parties[0].outflow must be a finite number for esc-shape-released, got undefined",
  });
});

test("second bad party entry is named by its index", () => {
  const report = cloneReport(releasedReport());
  report.parties[1].inflow = "lots";
  assert.throws(() => build(report), {
    message:
      "cannot build settlement webhook: parties[1].inflow must be a finite number for esc-shape-released, got lots",
  });
});

test("standard released/refunded/expired reports still build and verify byte-for-byte", () => {
  for (const report of [
    releasedReport(),
    refundedReport(),
    expiredReport(),
  ]) {
    const { payload, signature } = buildSettlementWebhook(report, {
      secret: SECRET,
      now: FIXED_NOW,
      eventId: FIXED_EVENT_ID,
    });
    assert.equal(payload.escrowId, report.escrowId);
    assert.equal(payload.outcome, report.outcome);
    assert.equal(payload.deposit, report.deposit.deposit);
    assert.ok(
      verifySettlementWebhook(JSON.stringify(payload), signature, SECRET),
    );
    assert.ok(verifySettlementWebhook(payload, signature, SECRET));
  }
});

test('"partially-released" is a valid outcome: a report carrying it builds and verifies', () => {
  const report = cloneReport(releasedReport());
  report.outcome = "partially-released";
  const { payload, signature } = build(report);
  assert.equal(payload.outcome, "partially-released");
  assert.ok(
    verifySettlementWebhook(JSON.stringify(payload), signature, SECRET),
  );
});

test("batch: a malformed report is a per-entry error and later reports still build", () => {
  const bad = cloneReport(releasedReport("esc-shape-bad"));
  bad.deposit = "nope";
  const good = releasedReport("esc-shape-good");
  const results = buildSettlementWebhooks(
    [
      { escrowId: "esc-shape-bad", report: bad as unknown as SettlementReport },
      { escrowId: "esc-shape-good", report: good },
    ],
    { secret: SECRET, now: FIXED_NOW, eventIdFactory: () => "evt-batch-1" },
  );
  assert.equal(results.length, 2);
  assert.equal(
    results[0].error,
    "cannot build settlement webhook: 'deposit' must be an object for esc-shape-bad",
  );
  assert.equal(results[0].webhook, undefined);
  assert.equal(results[1].error, undefined);
  assert.ok(results[1].webhook);
  assert.ok(
    verifySettlementWebhook(
      JSON.stringify(results[1].webhook!.payload),
      results[1].webhook!.signature,
      SECRET,
    ),
  );
});
