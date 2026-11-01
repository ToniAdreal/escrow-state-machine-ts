import test from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementReports,
  buildSettlementWebhook,
  buildSettlementWebhooks,
  calculateDeposit,
  deliverSettlementWebhookToMany,
  expireOverdueEscrows,
  verifySettlementWebhook,
  type SettlementReportInputs,
} from "../src/index.js";
import type { SettlementReport } from "../src/index.js";

/**
 * Expired escrow x settlement webhook (backlog #798).
 *
 * `expireOverdueEscrows` and the settlement webhook builder were each
 * covered on their own, but no test pinned the two together: when the
 * watchdog expires an overdue FUNDED escrow, does the settlement
 * report really come out `expired`, and does its webhook carry that
 * outcome with the full deposit refunded to the sponsor — without
 * disturbing a released control in the same batch or manufacturing a
 * settlement for a not-overdue escrow that the watchdog skipped?
 *
 * Rules under test:
 *  - an overdue FUNDED escrow expired by `expireOverdueEscrows` yields
 *    a report with outcome `expired` and a webhook with the same
 *    outcome, the full deposit, a sponsor party refunded in full
 *    (inflow == outflow == deposit, all other parties zero), and no
 *    `releasePath` key at all
 *  - in one `buildSettlementWebhooks` batch, the expired webhook sits
 *    next to a released control's webhook with its outcome and
 *    `releasePath` untouched, and a counting eventId factory issues
 *    exactly one id per success, in input order
 *  - the expired event fanned out via `deliverSettlementWebhookToMany`
 *    to 4 endpoints reaches every endpoint as the same logical event
 *    (one shared eventId) and verifies only under that endpoint's own
 *    secret
 *  - a not-overdue FUNDED escrow in the same watchdog batch stays
 *    FUNDED with its history untouched, and in the report/webhook
 *    batch it is a forwarded per-item error with no webhook, consuming
 *    no eventId
 */

const BATCH_SECRET = "whsec_test_expired_webhook_batch_20261101";
const STRANGER_SECRET = "whsec_test_expired_webhook_stranger_20261101";
const FIXED_NOW = "2026-11-01T20:30:00.000Z";

// Fixture audit timestamps, pinned strictly before the watchdog `now`:
// expireOverdueEscrows pins the screening `now` as each EXPIRE entry's
// `at`, and dispatch rejects a backward-moving audit clock.
const FUND_AT = new Date("2026-01-01T00:00:00.000Z");
const PAST_DEADLINE = new Date("2026-01-01T00:00:00.000Z");
const FUTURE_DEADLINE = new Date("2027-01-01T00:00:00.000Z");
const WATCHDOG_NOW = new Date("2026-06-01T00:00:00.000Z");

function deposit() {
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

function overdueFunded(id: string): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", deposit().deposit, { at: FUND_AT });
  escrow.setDeadline(PAST_DEADLINE);
  return escrow;
}

function notOverdueFunded(id: string): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", deposit().deposit, { at: FUND_AT });
  escrow.setDeadline(FUTURE_DEADLINE);
  return escrow;
}

function released(id: string): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND");
  escrow.dispatch("SUBMIT_MILESTONE");
  escrow.dispatch("VERIFY_PASS");
  escrow.dispatch("RELEASE");
  return escrow;
}

function inputsFor(e: Escrow): SettlementReportInputs {
  return {
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: deposit(),
    // Required for a released escrow; ignored on the expired path.
    settlement: { proFeeBps: 500 },
  };
}

function expiredReport(id: string): SettlementReport {
  const escrow = overdueFunded(id);
  const results = expireOverdueEscrows([escrow], WATCHDOG_NOW);
  assert.equal(results.length, 1);
  assert.equal(results[0].expired, true);
  assert.equal(escrow.state, "EXPIRED");
  const report = buildSettlementReport(inputsFor(escrow));
  assert.equal(report.outcome, "expired");
  return report;
}

test("watchdog expiry flows into an expired webhook with a full sponsor refund", () => {
  const escrow = overdueFunded("exp-single");
  const results = expireOverdueEscrows([escrow], WATCHDOG_NOW);
  assert.equal(results.length, 1);
  assert.equal(results[0].expired, true);
  assert.equal(escrow.state, "EXPIRED");
  const last = escrow.history[escrow.history.length - 1];
  assert.equal(last.event, "EXPIRE");
  assert.equal(last.from, "FUNDED");
  assert.equal(last.to, "EXPIRED");

  const report = buildSettlementReport(inputsFor(escrow));
  assert.equal(report.outcome, "expired");
  assert.equal(report.deposit.deposit, 10630);
  assert.equal(report.balanced, true);

  const webhook = buildSettlementWebhook(report, {
    secret: BATCH_SECRET,
    now: FIXED_NOW,
    eventId: "evt-expired-1",
  });
  assert.equal(webhook.payload.event, "escrow.settled");
  assert.equal(webhook.payload.eventId, "evt-expired-1");
  assert.equal(webhook.payload.escrowId, "exp-single");
  assert.equal(webhook.payload.outcome, "expired");
  assert.equal(webhook.payload.deposit, 10630);
  assert.equal(webhook.payload.at, FIXED_NOW);
  // Expired payloads omit releasePath entirely (never `undefined`).
  assert.equal("releasePath" in webhook.payload, false);
  // Full refund to the sponsor: inflow == outflow == deposit, net 0;
  // every other party is exactly zero.
  const byParty = new Map(webhook.payload.parties.map((p) => [p.party, p]));
  const sponsor = byParty.get("sponsor")!;
  assert.deepEqual(
    { inflow: sponsor.inflow, outflow: sponsor.outflow, net: sponsor.net },
    { inflow: 10630, outflow: 10630, net: 0 },
  );
  for (const party of ["creator", "platform", "referrer"] as const) {
    const row = byParty.get(party)!;
    assert.deepEqual(
      { inflow: row.inflow, outflow: row.outflow, net: row.net },
      { inflow: 0, outflow: 0, net: 0 },
    );
  }
  assert.match(webhook.signature, /^sha256=[0-9a-f]{64}$/);
  assert.equal(
    verifySettlementWebhook(webhook.payload, webhook.signature, BATCH_SECRET),
    true,
  );
  assert.equal(
    verifySettlementWebhook(webhook.payload, webhook.signature, STRANGER_SECRET),
    false,
  );
});

test("batch webhooks: expired item does not disturb a released control", () => {
  const expired = overdueFunded("exp-batch");
  expireOverdueEscrows([expired], WATCHDOG_NOW);
  const rel = released("exp-batch-rel");

  const reports = buildSettlementReports([inputsFor(expired), inputsFor(rel)]);
  assert.equal(reports[0].report?.outcome, "expired");
  assert.equal(reports[1].report?.outcome, "released");

  let counter = 0;
  const webhooks = buildSettlementWebhooks(reports, {
    secret: BATCH_SECRET,
    now: FIXED_NOW,
    eventIdFactory: () => `evt-exp-batch-${++counter}`,
  });
  assert.equal(counter, 2);
  assert.equal(webhooks[0].webhook?.payload.outcome, "expired");
  assert.equal(webhooks[0].webhook?.payload.deposit, 10630);
  assert.equal("releasePath" in (webhooks[0].webhook?.payload ?? {}), false);
  assert.equal(webhooks[0].webhook?.payload.eventId, "evt-exp-batch-1");
  assert.equal(webhooks[1].webhook?.payload.outcome, "released");
  assert.equal(webhooks[1].webhook?.payload.releasePath, "VERIFY_PASS → RELEASE");
  assert.equal(webhooks[1].webhook?.payload.eventId, "evt-exp-batch-2");
  for (const entry of webhooks) {
    assert.equal(entry.error, undefined);
    assert.equal(
      verifySettlementWebhook(
        entry.webhook!.payload,
        entry.webhook!.signature,
        BATCH_SECRET,
      ),
      true,
    );
  }
});

test("not-overdue control is untouched by the watchdog and gets no webhook", () => {
  const overdue = overdueFunded("exp-control-overdue");
  const control = notOverdueFunded("exp-control-fresh");
  const controlHistoryLen = control.history.length;

  const results = expireOverdueEscrows([overdue, control], WATCHDOG_NOW);
  // Only the overdue escrow is attempted; the control is not even listed.
  assert.deepEqual(
    results.map((r) => r.escrow.id),
    ["exp-control-overdue"],
  );
  assert.equal(overdue.state, "EXPIRED");
  assert.equal(control.state, "FUNDED");
  assert.equal(control.history.length, controlHistoryLen);
  assert.equal(
    control.history[control.history.length - 1].event,
    "FUND",
  );

  const reports = buildSettlementReports([inputsFor(overdue), inputsFor(control)]);
  assert.equal(reports[0].report?.outcome, "expired");
  assert.equal(reports[1].report, undefined);
  assert.match(reports[1].error ?? "", /no settlement has happened yet/);

  let counter = 0;
  const webhooks = buildSettlementWebhooks(reports, {
    secret: BATCH_SECRET,
    now: FIXED_NOW,
    eventIdFactory: () => `evt-exp-control-${++counter}`,
  });
  // The error entry consumes no eventId: exactly one issued, for the
  // expired escrow only.
  assert.equal(counter, 1);
  assert.equal(webhooks[0].webhook?.payload.outcome, "expired");
  assert.equal(webhooks[1].webhook, undefined);
  assert.equal(webhooks[1].error, reports[1].error);
});

interface ReceivedRequest {
  body: string;
  signature: string;
}

interface TestServer {
  url: string;
  received: ReceivedRequest[];
  close: () => Promise<void>;
}

async function startServer(): Promise<TestServer> {
  const received: ReceivedRequest[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        body: Buffer.concat(chunks).toString("utf8"),
        signature: String(req.headers["x-signature"] ?? ""),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/webhook`,
    received,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("expired event fanned out to 4 endpoints: same event, per-endpoint secrets only", async () => {
  const secrets = [
    "whsec_expired_fanout_accounting",
    "whsec_expired_fanout_notify",
    "whsec_expired_fanout_ledger",
    "whsec_expired_fanout_audit",
  ];
  const servers = [
    await startServer(),
    await startServer(),
    await startServer(),
    await startServer(),
  ];
  try {
    const out = await deliverSettlementWebhookToMany(
      expiredReport("exp-fanout"),
      servers.map((s, i) => ({ url: s.url, secret: secrets[i] })),
      { allowInsecureHttp: true, backoffMs: 1, now: FIXED_NOW, eventId: "evt-expired-fanout-1" },
    );
    assert.equal(out.delivered, 4);
    assert.equal(out.failed, 0);
    assert.deepEqual(
      out.results.map((r) => r.attempts),
      [1, 1, 1, 1],
    );
    assert.ok(out.results.every((r) => r.ok && r.status === 200));
    assert.deepEqual(
      servers.map((s) => s.received.length),
      [1, 1, 1, 1],
    );
    for (let i = 0; i < 4; i++) {
      const copy = servers[i].received[0];
      const payload = JSON.parse(copy.body) as {
        eventId: string;
        outcome: string;
        deposit: number;
      };
      assert.equal(payload.eventId, "evt-expired-fanout-1");
      assert.equal(payload.outcome, "expired");
      assert.equal(payload.deposit, 10630);
      assert.equal(
        verifySettlementWebhook(copy.body, copy.signature, secrets[i]),
        true,
        `endpoint ${i} copy must verify under its own secret`,
      );
      for (let j = 0; j < 4; j++) {
        if (j === i) continue;
        assert.equal(
          verifySettlementWebhook(copy.body, copy.signature, secrets[j]),
          false,
          `endpoint ${i} copy must not verify under endpoint ${j}'s secret`,
        );
      }
    }
  } finally {
    for (const s of servers) await s.close();
  }
});
