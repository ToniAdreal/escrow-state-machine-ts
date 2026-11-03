import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementReports,
  buildSettlementWebhook,
  buildSettlementWebhooks,
  calculateDeposit,
  parseSettlementReportJson,
  renderReport,
  renderReportJson,
  verifySettlementWebhook,
} from "../src/index.js";
import type { SettlementReport } from "../src/index.js";

const SECRET = "whsec_test_settlement_currency_20261103";
const FIXED_NOW = "2026-11-03T14:00:00.000Z";
const FIXED_EVENT_ID = "evt-currency-1";

function goldenDeposit() {
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

function releasedEscrow(id = "esc-cur-released") {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return e;
}

function refundedEscrow(id = "esc-cur-refunded") {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("DISPUTE");
  e.dispatch("ARBITRATE_REFUND");
  return e;
}

function reportFor(
  escrow: Escrow,
  extra: { currency?: string; settlement?: { proFeeBps: number } } = {},
) {
  return buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: goldenDeposit(),
    ...(extra.currency !== undefined ? { currency: extra.currency } : {}),
    ...(extra.settlement ? { settlement: extra.settlement } : {}),
  });
}

test("legal currency rides the released report end to end", () => {
  const report = reportFor(releasedEscrow(), {
    currency: "USD",
    settlement: { proFeeBps: 500 },
  });
  assert.equal(report.currency, "USD");
  assert.equal(report.outcome, "released");
  assert.equal(report.deposit.deposit, 10630);
  // The human-readable render carries the label too.
  assert.match(renderReport(report), /Currency: USD/);
});

test("legal currency rides a refunded report and its webhook payload", () => {
  const report = reportFor(refundedEscrow(), { currency: "EUR" });
  assert.equal(report.currency, "EUR");
  assert.equal(report.outcome, "refunded");
  const { payload, signature } = buildSettlementWebhook(report, {
    secret: SECRET,
    now: FIXED_NOW,
    eventId: FIXED_EVENT_ID,
  });
  assert.equal(payload.currency, "EUR");
  assert.ok(verifySettlementWebhook(JSON.stringify(payload), signature, SECRET));
  assert.ok(verifySettlementWebhook(payload, signature, SECRET));
});

test("currency payload has the canonical key order, after deposit", () => {
  const report = reportFor(releasedEscrow(), {
    currency: "USD",
    settlement: { proFeeBps: 500 },
  });
  const { payload, signature } = buildSettlementWebhook(report, {
    secret: SECRET,
    now: FIXED_NOW,
    eventId: FIXED_EVENT_ID,
  });
  assert.deepEqual(Object.keys(payload), [
    "event",
    "eventId",
    "escrowId",
    "outcome",
    "releasePath",
    "deposit",
    "currency",
    "parties",
    "at",
  ]);
  assert.equal(
    JSON.stringify(payload),
    '{"event":"escrow.settled","eventId":"evt-currency-1","escrowId":"esc-cur-released","outcome":"released","releasePath":"VERIFY_PASS → RELEASE","deposit":10630,"currency":"USD","parties":[{"party":"sponsor","inflow":0,"outflow":10630,"net":-10630},{"party":"creator","inflow":10098.5,"outflow":0,"net":10098.5},{"party":"platform","inflow":531.5,"outflow":0,"net":531.5},{"party":"referrer","inflow":0,"outflow":0,"net":0}],"at":"2026-11-03T14:00:00.000Z"}',
  );
  assert.ok(verifySettlementWebhook(JSON.stringify(payload), signature, SECRET));
});

test("tampering with or stripping the currency breaks webhook verification", () => {
  const report = reportFor(releasedEscrow(), {
    currency: "USD",
    settlement: { proFeeBps: 500 },
  });
  const { payload, signature } = buildSettlementWebhook(report, {
    secret: SECRET,
    now: FIXED_NOW,
    eventId: FIXED_EVENT_ID,
  });
  // Re-signed bytes are what the receiver checks; any currency change
  // must fail on both the raw-string and the object path.
  const retagged = { ...payload, currency: "EUR" };
  assert.equal(
    verifySettlementWebhook(JSON.stringify(retagged), signature, SECRET),
    false,
  );
  assert.equal(verifySettlementWebhook(retagged, signature, SECRET), false);
  const { currency: _dropped, ...stripped } = payload;
  assert.equal(
    verifySettlementWebhook(JSON.stringify(stripped), signature, SECRET),
    false,
  );
  assert.equal(verifySettlementWebhook(stripped, signature, SECRET), false);
});

test("illegal currencies throw at report construction, before any money math", () => {
  const escrow = releasedEscrow("esc-cur-bad");
  for (const bad of ["usd", "US", "USDD", "US1", "U$D", "", "usd "]) {
    assert.throws(
      () =>
        buildSettlementReport({
          escrowId: escrow.id,
          history: escrow.history,
          finalState: escrow.state,
          deposit: goldenDeposit(),
          settlement: { proFeeBps: 500 },
          currency: bad,
        }),
      /invalid settlement currency.*must be a 3-letter uppercase ISO 4217 code/,
      `currency ${JSON.stringify(bad)} must be rejected`,
    );
  }
  assert.throws(
    () =>
      buildSettlementReport({
        escrowId: escrow.id,
        history: escrow.history,
        finalState: escrow.state,
        deposit: goldenDeposit(),
        settlement: { proFeeBps: 500 },
        // Deliberately off-type: the runtime guard, not the type, must catch it.
        currency: 840 as unknown as string,
      }),
    /invalid settlement currency/,
  );
});

test("a hand-built report with an illegal currency cannot be signed", () => {
  const report = reportFor(releasedEscrow(), {
    currency: "USD",
    settlement: { proFeeBps: 500 },
  });
  const forged: SettlementReport = { ...report, currency: "usd" };
  assert.throws(
    () =>
      buildSettlementWebhook(forged, {
        secret: SECRET,
        now: FIXED_NOW,
        eventId: FIXED_EVENT_ID,
      }),
    /cannot build settlement webhook: invalid settlement currency/,
  );
});

test("omitting currency keeps the legacy report and payload shapes exactly", () => {
  const report = reportFor(releasedEscrow("esc-cur-legacy"), {
    settlement: { proFeeBps: 500 },
  });
  assert.equal("currency" in report, false);
  assert.doesNotMatch(renderReport(report), /Currency:/);
  const { payload, signature } = buildSettlementWebhook(report, {
    secret: SECRET,
    now: FIXED_NOW,
    eventId: FIXED_EVENT_ID,
  });
  assert.equal("currency" in payload, false);
  assert.deepEqual(Object.keys(payload), [
    "event",
    "eventId",
    "escrowId",
    "outcome",
    "releasePath",
    "deposit",
    "parties",
    "at",
  ]);
  assert.ok(verifySettlementWebhook(JSON.stringify(payload), signature, SECRET));
});

test("JSON render/parse round-trips a currency and still omits it when absent", () => {
  const withCurrency = reportFor(releasedEscrow("esc-cur-json"), {
    currency: "USD",
    settlement: { proFeeBps: 500 },
  });
  const parsed = parseSettlementReportJson(renderReportJson(withCurrency));
  assert.equal(parsed.currency, "USD");
  assert.equal(renderReportJson(parsed), renderReportJson(withCurrency));

  const legacy = reportFor(releasedEscrow("esc-cur-json-legacy"), {
    settlement: { proFeeBps: 500 },
  });
  const parsedLegacy = parseSettlementReportJson(renderReportJson(legacy));
  assert.equal("currency" in parsedLegacy, false);

  const forged = { ...withCurrency, currency: "usd" };
  assert.throws(
    () => parseSettlementReportJson(JSON.stringify(forged)),
    /currency must be a 3-letter uppercase ISO 4217 code/,
  );
});

test("batch reports pass currency through per escrow and isolate a bad code", () => {
  const good = releasedEscrow("esc-cur-batch-good");
  const bad = releasedEscrow("esc-cur-batch-bad");
  const results = buildSettlementReports([
    {
      escrowId: good.id,
      history: good.history,
      finalState: good.state,
      deposit: goldenDeposit(),
      settlement: { proFeeBps: 500 },
      currency: "USD",
    },
    {
      escrowId: bad.id,
      history: bad.history,
      finalState: bad.state,
      deposit: goldenDeposit(),
      settlement: { proFeeBps: 500 },
      currency: "usd",
    },
  ]);
  assert.equal(results.length, 2);
  assert.equal(results[0].report?.currency, "USD");
  assert.match(results[1].error ?? "", /invalid settlement currency/);
  assert.equal(results[1].report, undefined);
});

test("batch webhooks carry each report's currency and keep legacy shape without one", () => {
  const usd = releasedEscrow("esc-cur-bw-usd");
  const legacy = releasedEscrow("esc-cur-bw-legacy");
  const reports = buildSettlementReports([
    {
      escrowId: usd.id,
      history: usd.history,
      finalState: usd.state,
      deposit: goldenDeposit(),
      settlement: { proFeeBps: 500 },
      currency: "USD",
    },
    {
      escrowId: legacy.id,
      history: legacy.history,
      finalState: legacy.state,
      deposit: goldenDeposit(),
      settlement: { proFeeBps: 500 },
    },
  ]);
  let n = 0;
  const webhooks = buildSettlementWebhooks(reports, {
    secret: SECRET,
    now: FIXED_NOW,
    eventIdFactory: () => `evt-currency-batch-${(n += 1)}`,
  });
  assert.equal(webhooks[0].webhook?.payload.currency, "USD");
  assert.equal("currency" in (webhooks[1].webhook?.payload ?? {}), false);
  assert.ok(
    webhooks.every(
      (w) =>
        w.webhook !== undefined &&
        verifySettlementWebhook(
          JSON.stringify(w.webhook.payload),
          w.webhook.signature,
          SECRET,
        ),
    ),
  );
});
