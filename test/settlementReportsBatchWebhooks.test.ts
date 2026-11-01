import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReports,
  buildSettlementWebhooks,
  buildSettlementWebhook,
  calculateDeposit,
  verifySettlementWebhook,
  type SettlementReportInputs,
} from "../src/index.js";

/**
 * `buildSettlementReports` batch x `buildSettlementWebhooks` end to end
 * (backlog #797).
 *
 * The day-end batch pipeline is: batch reports -> one webhook per
 * successful item. No test pinned the two together: whether a per-item
 * error from the report batch really produces no webhook, whether each
 * webhook's outcome matches its report's outcome (including `expired`),
 * and whether each webhook verifies under its own secret but not under
 * another item's secret.
 *
 * Rules under test:
 *  - a released / refunded / expired / non-terminal batch yields exactly
 *    three webhooks, in input order, each carrying its report's outcome
 *    (including `expired`) and deposit, plus one forwarded per-item
 *    error for the non-terminal escrow and no webhook for it
 *  - the forwarded error message is the report batch's message, unchanged
 *  - the non-terminal entry consumes no `eventId`: a counting factory
 *    issues evt-1..evt-3 to the three webhooks, in order
 *  - every batch webhook verifies under the batch secret and fails
 *    under a stranger secret
 *  - per-item secrets (the single-build path receivers would use when
 *    each escrow has its own secret): a webhook signed for one escrow
 *    verifies under that escrow's secret and fails under the other
 *    escrows' secrets
 */

const BATCH_SECRET = "whsec_test_batch_reports_webhooks_20261101";
const STRANGER_SECRET = "whsec_test_batch_reports_webhooks_stranger_20261101";
const FIXED_NOW = "2026-11-01T19:00:00.000Z";

function deposit() {
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

function released(id: string) {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return e;
}

function refunded(id: string) {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_FAIL");
  e.dispatch("ARBITRATE_REFUND");
  return e;
}

function expired(id: string) {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("EXPIRE");
  return e;
}

function inputsFor(e: Escrow): SettlementReportInputs {
  return {
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: deposit(),
    settlement: { proFeeBps: 500 },
  };
}

test("batch reports pipe into batch webhooks: outcomes match, non-terminal errors with no webhook", () => {
  const rel = released("bw-rel");
  const ref = refunded("bw-ref");
  const exp = expired("bw-exp");
  const open = new Escrow("bw-open");
  open.dispatch("FUND");

  const reports = buildSettlementReports([
    inputsFor(rel),
    inputsFor(ref),
    inputsFor(exp),
    inputsFor(open),
  ]);
  assert.equal(reports[0].report?.outcome, "released");
  assert.equal(reports[1].report?.outcome, "refunded");
  assert.equal(reports[2].report?.outcome, "expired");
  assert.equal(reports[3].report, undefined);
  assert.match(reports[3].error ?? "", /no settlement has happened yet/);

  let counter = 0;
  const webhooks = buildSettlementWebhooks(reports, {
    secret: BATCH_SECRET,
    now: FIXED_NOW,
    eventIdFactory: () => `evt-${++counter}`,
  });

  assert.deepEqual(
    webhooks.map((w) => w.escrowId),
    ["bw-rel", "bw-ref", "bw-exp", "bw-open"],
  );
  // The non-terminal entry consumed no eventId: exactly three issued.
  assert.equal(counter, 3);

  for (let i = 0; i < 3; i++) {
    const webhook = webhooks[i].webhook;
    assert.ok(webhook, `expected a webhook for ${reports[i].escrowId}`);
    assert.equal(webhooks[i].error, undefined);
    assert.equal(webhook.payload.event, "escrow.settled");
    assert.equal(webhook.payload.escrowId, reports[i].escrowId);
    assert.equal(webhook.payload.outcome, reports[i].report?.outcome);
    assert.equal(webhook.payload.deposit, reports[i].report?.deposit.deposit);
    assert.equal(webhook.payload.eventId, `evt-${i + 1}`);
    assert.equal(webhook.payload.at, FIXED_NOW);
    assert.match(webhook.signature, /^sha256=[0-9a-f]{64}$/);
    assert.equal(
      verifySettlementWebhook(webhook.payload, webhook.signature, BATCH_SECRET),
      true,
    );
    assert.equal(
      verifySettlementWebhook(webhook.payload, webhook.signature, STRANGER_SECRET),
      false,
    );
  }

  // Released carries its path; refunded/expired omit the key entirely.
  assert.equal(
    webhooks[0].webhook?.payload.releasePath,
    "VERIFY_PASS → RELEASE",
  );
  assert.equal("releasePath" in (webhooks[1].webhook?.payload ?? {}), false);
  assert.equal("releasePath" in (webhooks[2].webhook?.payload ?? {}), false);

  // The non-terminal item's error is forwarded unchanged, with no webhook.
  assert.equal(webhooks[3].webhook, undefined);
  assert.equal(webhooks[3].error, reports[3].error);
});

test("per-item secrets: a webhook verifies under its own escrow's secret, not another's", () => {
  const escrows = [released("bw-sec-rel"), refunded("bw-sec-ref"), expired("bw-sec-exp")];
  const secrets = [
    "whsec_test_batch_webhooks_rel_20261101",
    "whsec_test_batch_webhooks_ref_20261101",
    "whsec_test_batch_webhooks_exp_20261101",
  ];
  const reports = buildSettlementReports(escrows.map((e) => inputsFor(e)));

  const webhooks = reports.map((r, i) =>
    buildSettlementWebhook(r.report!, {
      secret: secrets[i],
      now: FIXED_NOW,
      eventId: `sec-evt-${i + 1}`,
    }),
  );

  for (let i = 0; i < 3; i++) {
    assert.equal(
      verifySettlementWebhook(webhooks[i].payload, webhooks[i].signature, secrets[i]),
      true,
      `webhook ${i} must verify under its own secret`,
    );
    for (let j = 0; j < 3; j++) {
      if (j === i) continue;
      assert.equal(
        verifySettlementWebhook(webhooks[i].payload, webhooks[i].signature, secrets[j]),
        false,
        `webhook ${i} must not verify under escrow ${j}'s secret`,
      );
    }
  }
});
