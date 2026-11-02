import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReports,
  buildSettlementWebhooks,
  calculateDeposit,
  deliverSettlementWebhookToMany,
  verifySettlementWebhook,
  SettlementEventDedupe,
  type SettlementReportInputs,
  type SettlementWebhookEndpoint,
} from "../src/index.js";

/**
 * `buildSettlementReports` batch x `deliverSettlementWebhookToMany`
 * fan-out delivery (backlog #809).
 *
 * The day-end pipeline is: batch reports -> one signed webhook per
 * successful item -> fan that item's settlement out to many
 * endpoints. Backlog #797 pinned the pipeline only up to building
 * the webhooks: no test delivered a batch through the fan-out, so
 * per-endpoint secrets, per-endpoint failure isolation, and the
 * eventId threading from batch build to delivery were unpinned.
 *
 * One API honesty note, recorded here so the test is not misread:
 * `deliverSettlementWebhookToMany` takes a *report*, not a built
 * webhook, and rebuilds the payload body from that report. The
 * built webhook's `eventId` and `at` are therefore passed back in
 * as the fan-out options, which makes the delivered body
 * byte-identical to the built webhook's payload (same
 * `buildPayload`, same inputs). That threading is exactly what
 * this test pins: a receiver that already recorded the built
 * webhook's eventId must see the delivered copy as the same event,
 * not as a second settlement.
 *
 * Rules under test:
 *  - a released / refunded / expired / non-terminal batch yields
 *    three built webhooks and one forwarded per-item error; the
 *    non-terminal entry consumes no `eventId` (factory issues
 *    exactly evt-1..evt-3)
 *  - fanning each successful report out to 4 endpoints delivers
 *    all 3 settlements to every endpoint, each endpoint's copy
 *    verifying only under its own secret, with the shared body
 *    byte-identical to the built webhook payload and the
 *    `X-Event-Id` / `Idempotency-Key` headers carrying the built
 *    eventId
 *  - one endpoint answering 500 on its first attempt retries to
 *    success (attempts 2 for that endpoint on that settlement
 *    only) while the other endpoints stay at attempts 1 and the
 *    aggregate stays delivered 4 / failed 0
 *  - re-delivering the same batch (same eventIds) still reports
 *    delivery success, but every endpoint's `SettlementEventDedupe`
 *    receiver flags the second round as duplicates, and the
 *    non-terminal escrow is never delivered in either round
 *
 * All delivery goes through a stubbed `globalThis.fetch` (the
 * demo's pattern: this library has no fetchImpl option), restored
 * in `finally` so no later test can observe the stub. Zero real
 * network: the endpoint URLs are example.test hostnames that the
 * stub answers without any socket.
 */

const BATCH_SECRET = "whsec_batch_delivery_20261102";
const SECRET_A = "whsec_delivery_accounting_20261102";
const SECRET_B = "whsec_delivery_notify_20261102";
const SECRET_C = "whsec_delivery_ledger_20261102";
const SECRET_D = "whsec_delivery_audit_20261102";
const ENDPOINT_SECRETS = [SECRET_A, SECRET_B, SECRET_C, SECRET_D];
const FIXED_NOW = "2026-11-02T10:00:00.000Z";

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

interface BuiltBatch {
  reports: ReturnType<typeof buildSettlementReports>;
  webhooks: ReturnType<typeof buildSettlementWebhooks>;
  eventIds: string[];
}

function buildBatch(): BuiltBatch {
  const rel = released("bd-rel");
  const ref = refunded("bd-ref");
  const exp = expired("bd-exp");
  const open = new Escrow("bd-open");
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

  const eventIds: string[] = [];
  let counter = 0;
  const webhooks = buildSettlementWebhooks(reports, {
    secret: BATCH_SECRET,
    now: FIXED_NOW,
    eventIdFactory: () => {
      const id = `evt-batch-${++counter}`;
      eventIds.push(id);
      return id;
    },
  });
  // The non-terminal entry consumed no eventId: exactly three issued.
  assert.equal(counter, 3);
  assert.deepEqual(eventIds, ["evt-batch-1", "evt-batch-2", "evt-batch-3"]);
  assert.equal(webhooks[3].webhook, undefined);
  assert.match(webhooks[3].error ?? "", /no settlement has happened yet/);
  return { reports, webhooks, eventIds };
}

function endpoints(): SettlementWebhookEndpoint[] {
  return [
    { url: "https://accounting.example.test/webhook", secret: SECRET_A },
    { url: "https://notify.example.test/webhook", secret: SECRET_B },
    { url: "https://ledger.example.test/webhook", secret: SECRET_C },
    { url: "https://audit.example.test/webhook", secret: SECRET_D },
  ];
}

interface CapturedCall {
  url: string;
  body: string;
  signature: string;
  eventIdHeader: string;
  idempotencyHeader: string;
}

interface StubbedFetch {
  calls: CapturedCall[];
  restore: () => void;
}

/**
 * Install a stub fetch that answers per URL from `statusFor`. The
 * stub records every call (url, raw body, signature and event
 * headers) so the test can verify bodies and signatures exactly.
 */
function installStubFetch(
  statusFor: (url: string, callIndex: number) => number,
): StubbedFetch {
  const calls: CapturedCall[] = [];
  const perUrlCount = new Map<string, number>();
  const stub: typeof fetch = async (input, init) => {
    const url = String(input);
    const callIndex = perUrlCount.get(url) ?? 0;
    perUrlCount.set(url, callIndex + 1);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      body: String(init?.body ?? ""),
      signature: headers.get("x-signature") ?? "",
      eventIdHeader: headers.get("x-event-id") ?? "",
      idempotencyHeader: headers.get("idempotency-key") ?? "",
    });
    return new Response("{}", {
      status: statusFor(url, callIndex),
      headers: { "content-type": "application/json" },
    });
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stub;
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

test("batch webhooks fan out to four endpoints: shared bodies, per-endpoint secrets, receiver first sightings", async () => {
  const { reports, webhooks, eventIds } = buildBatch();
  const eps = endpoints();
  const stub = installStubFetch(() => 200);
  try {
    for (let i = 0; i < 3; i++) {
      const report = reports[i].report;
      assert.ok(report, `report ${i} must exist`);
      const out = await deliverSettlementWebhookToMany(report, eps, {
        now: FIXED_NOW,
        eventId: eventIds[i],
        backoffMs: 1,
      });
      assert.equal(out.delivered, 4);
      assert.equal(out.failed, 0);
      assert.deepEqual(
        out.results.map((r) => ({ url: r.url, ok: r.ok, attempts: r.attempts, status: r.status })),
        eps.map((e) => ({ url: e.url, ok: true, attempts: 1, status: 200 })),
      );
    }
  } finally {
    stub.restore();
  }

  // 3 settlements x 4 endpoints = 12 deliveries, no more, no fewer.
  assert.equal(stub.calls.length, 12);
  // The non-terminal escrow was never delivered.
  assert.ok(stub.calls.every((c) => !c.body.includes("bd-open")));

  // Per endpoint: the three bodies, in batch order, byte-identical
  // to the built webhook payloads; each signature verifies only
  // under that endpoint's own secret; headers carry the built id.
  const dedupes = eps.map(() => new SettlementEventDedupe());
  for (let e = 0; e < eps.length; e++) {
    const mine = stub.calls.filter((c) => c.url === eps[e].url);
    assert.equal(mine.length, 3);
    for (let i = 0; i < 3; i++) {
      const built = webhooks[i].webhook;
      assert.ok(built, `webhook ${i} must exist`);
      assert.equal(mine[i].body, JSON.stringify(built.payload));
      assert.equal(mine[i].eventIdHeader, eventIds[i]);
      assert.equal(mine[i].idempotencyHeader, eventIds[i]);
      assert.equal(
        verifySettlementWebhook(mine[i].body, mine[i].signature, ENDPOINT_SECRETS[e]),
        true,
      );
      for (let other = 0; other < ENDPOINT_SECRETS.length; other++) {
        if (other !== e) {
          assert.equal(
            verifySettlementWebhook(mine[i].body, mine[i].signature, ENDPOINT_SECRETS[other]),
            false,
          );
        }
      }
      // Receiver flow: verify first, then dedupe — first sighting.
      assert.equal(dedupes[e].checkAndRecord(eventIds[i]), false);
    }
    // After all three, every eventId is now recorded at this endpoint.
    for (const id of eventIds) {
      assert.equal(dedupes[e].checkAndRecord(id), true);
    }
  }
});

test("one endpoint 500-then-200: retry isolated to that endpoint and settlement", async () => {
  const { reports, eventIds } = buildBatch();
  const eps = endpoints();
  const flakyUrl = eps[1].url;
  // Only the flaky endpoint's very first fetch call fails; every
  // other call (including its later settlements) answers 200.
  const stub = installStubFetch((url, callIndex) =>
    url === flakyUrl && callIndex === 0 ? 500 : 200,
  );
  try {
    const first = await deliverSettlementWebhookToMany(reports[0].report!, eps, {
      now: FIXED_NOW,
      eventId: eventIds[0],
      backoffMs: 1,
    });
    assert.equal(first.delivered, 4);
    assert.equal(first.failed, 0);
    assert.deepEqual(
      first.results.map((r) => r.attempts),
      [1, 2, 1, 1],
    );
    assert.deepEqual(
      first.results.map((r) => r.status),
      [200, 200, 200, 200],
    );

    // Later settlements: the flaky endpoint is healthy again, so
    // every endpoint is back to a single attempt.
    for (let i = 1; i < 3; i++) {
      const out = await deliverSettlementWebhookToMany(reports[i].report!, eps, {
        now: FIXED_NOW,
        eventId: eventIds[i],
        backoffMs: 1,
      });
      assert.equal(out.delivered, 4);
      assert.equal(out.failed, 0);
      assert.deepEqual(out.results.map((r) => r.attempts), [1, 1, 1, 1]);
    }
  } finally {
    stub.restore();
  }
  // Flaky endpoint: 2 attempts for settlement 1, 1 each for 2 and 3.
  assert.equal(stub.calls.filter((c) => c.url === flakyUrl).length, 4);
  assert.equal(stub.calls.length, 13);
});

test("re-delivering the same batch: delivery still succeeds, receivers flag duplicates", async () => {
  const { reports, eventIds } = buildBatch();
  const eps = endpoints();
  const dedupes = eps.map(() => new SettlementEventDedupe());
  const stub = installStubFetch(() => 200);
  try {
    const deliverBatch = async () => {
      for (let i = 0; i < 3; i++) {
        const out = await deliverSettlementWebhookToMany(reports[i].report!, eps, {
          now: FIXED_NOW,
          eventId: eventIds[i],
          backoffMs: 1,
        });
        assert.equal(out.delivered, 4);
        assert.equal(out.failed, 0);
      }
    };
    await deliverBatch();
    const firstRound = stub.calls.slice();
    assert.equal(firstRound.length, 12);
    // Receiver flow on round one: verify, then first sighting.
    for (let e = 0; e < eps.length; e++) {
      for (const call of firstRound.filter((c) => c.url === eps[e].url)) {
        assert.equal(
          verifySettlementWebhook(call.body, call.signature, ENDPOINT_SECRETS[e]),
          true,
        );
        assert.equal(dedupes[e].checkAndRecord(JSON.parse(call.body).eventId), false);
      }
    }

    await deliverBatch();
    const secondRound = stub.calls.slice(12);
    assert.equal(secondRound.length, 12);
    // Delivery still reports success (the wire succeeded), but the
    // receivers must now treat every copy as a duplicate replay.
    for (let e = 0; e < eps.length; e++) {
      for (const call of secondRound.filter((c) => c.url === eps[e].url)) {
        assert.equal(
          verifySettlementWebhook(call.body, call.signature, ENDPOINT_SECRETS[e]),
          true,
        );
        assert.equal(dedupes[e].checkAndRecord(JSON.parse(call.body).eventId), true);
      }
    }
    // Second-round bodies are byte-identical to the first round's:
    // the same logical events, not new settlements.
    assert.deepEqual(
      secondRound.map((c) => c.body),
      firstRound.map((c) => c.body),
    );
    assert.ok(secondRound.every((c) => !c.body.includes("bd-open")));
  } finally {
    stub.restore();
  }
});
