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
 * Keyed batch settlement x webhook build x fan-out delivery, end to
 * end (backlog #825).
 *
 * Backlog #812 benched the same chain without keys, and #818 pinned
 * the keyed batch only up to `buildSettlementReports`: a wrong key
 * fails alone in the middle of the batch. What neither pinned is
 * whether that isolation survives the rest of the day-end pipeline:
 * does the wrong-key entry stay an error when the batch is turned
 * into webhooks (forwarded verbatim, consuming no `eventId`), and
 * does it stay undelivered when the good entries fan out — no
 * fetch, no dedupe record — while the good entries verify per
 * endpoint and read as first sightings, then as duplicates on
 * re-delivery?
 *
 * One API honesty note, recorded here so the test is not misread:
 * `deliverSettlementWebhookToMany` takes a *report*, not a built
 * webhook, and rebuilds the payload body from that report. The
 * built webhook's `eventId` and `at` are therefore passed back in
 * as the fan-out options, which makes the delivered body
 * byte-identical to the built webhook's payload (same payload
 * builder, same inputs). That threading is exactly what this test
 * pins: the receiver's dedupe sees the delivered copy as the same
 * event the batch build issued, not as a new settlement.
 *
 * Rules under test:
 *  - a [good key, wrong key, unkeyed] batch yields two reports and
 *    one forwarded error; the wrong-key error text is forwarded
 *    verbatim into the webhook batch and consumes no `eventId`
 *    (factory issues exactly evt-key-1..evt-key-2, the second good
 *    entry drawing evt-key-2)
 *  - fanning each good report out to 3 endpoints delivers both
 *    settlements to every endpoint, each endpoint's copy verifying
 *    only under its own secret, with the shared body byte-identical
 *    to the built webhook payload and the `X-Event-Id` /
 *    `Idempotency-Key` headers carrying the built eventId
 *  - re-delivering the same batch (same eventIds) still reports
 *    delivery success, but every endpoint's `SettlementEventDedupe`
 *    receiver flags the second round as duplicates
 *  - the wrong-key escrow is never delivered in either round: zero
 *    fetch calls carry its id, and no receiver dedupe ever records
 *    an event for it (each dedupe holds exactly the two good ids)
 *
 * All delivery goes through a stubbed `globalThis.fetch` (the
 * demo's pattern: this library has no fetchImpl option), restored
 * in `finally` so no later test can observe the stub. Zero real
 * network: the endpoint URLs are example.test hostnames that the
 * stub answers without any socket.
 */

const KEY_A = "audit-key-chain-alpha";
const WRONG_KEY = "a-different-audit-key";
const BATCH_SECRET = "whsec_chain_delivery_20261102";
const SECRET_A = "whsec_chain_accounting_20261102";
const SECRET_B = "whsec_chain_notify_20261102";
const SECRET_C = "whsec_chain_ledger_20261102";
const ENDPOINT_SECRETS = [SECRET_A, SECRET_B, SECRET_C];
const FIXED_NOW = "2026-11-02T19:30:00.000Z";

function goldenDeposit() {
  // Portfolio golden vector: pool $10,000, base $600 x 1.0,
  // loyalty -$30, oracle +$60 -> deposit $10,630.
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

function keyedReleased(id: string, key: string) {
  const e = new Escrow(id, { auditKey: key });
  e.dispatch("FUND", undefined, 10630);
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return e;
}

function unkeyedReleased(id: string) {
  const e = new Escrow(id);
  e.dispatch("FUND", undefined, 10630);
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return e;
}

function inputsFor(
  e: Escrow,
  auditKey?: string,
): SettlementReportInputs {
  return {
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500 },
    ...(auditKey !== undefined ? { auditKey } : {}),
  };
}

function assertGoldenSplit(
  report: NonNullable<ReturnType<typeof buildSettlementReports>[number]["report"]>,
) {
  assert.equal(report.outcome, "released");
  assert.equal(report.balanced, true);
  assert.equal(report.totalInflow, 10630);
  assert.equal(report.totalOutflow, 10630);
  // 5% of 10630 = 531.50 pro fee, no referral credits.
  const byRole = new Map(report.parties.map((p) => [p.party, p]));
  assert.equal(byRole.get("sponsor")!.outflow, 10630);
  assert.equal(byRole.get("creator")!.inflow, 10098.5);
  assert.equal(byRole.get("platform")!.inflow, 531.5);
  assert.equal(byRole.get("referrer")!.inflow, 0);
}

interface BuiltChain {
  reports: ReturnType<typeof buildSettlementReports>;
  webhooks: ReturnType<typeof buildSettlementWebhooks>;
  eventIds: string[];
}

function buildChain(): BuiltChain {
  const good = keyedReleased("kb-good", KEY_A);
  const wrong = keyedReleased("kb-wrong", KEY_A);
  const plain = unkeyedReleased("kb-plain");

  const reports = buildSettlementReports([
    inputsFor(good, KEY_A),
    inputsFor(wrong, WRONG_KEY),
    inputsFor(plain),
  ]);
  assertGoldenSplit(reports[0].report!);
  assert.equal(reports[0].error, undefined);
  assert.equal(reports[1].report, undefined);
  assert.match(reports[1].error ?? "", /hash chain/);
  assertGoldenSplit(reports[2].report!);
  assert.equal(reports[2].error, undefined);

  const eventIds: string[] = [];
  let counter = 0;
  const webhooks = buildSettlementWebhooks(reports, {
    secret: BATCH_SECRET,
    now: FIXED_NOW,
    eventIdFactory: () => {
      const id = `evt-key-${++counter}`;
      eventIds.push(id);
      return id;
    },
  });
  return { reports, webhooks, eventIds };
}

function endpoints(): SettlementWebhookEndpoint[] {
  return [
    { url: "https://accounting.example.test/webhook", secret: SECRET_A },
    { url: "https://notify.example.test/webhook", secret: SECRET_B },
    { url: "https://ledger.example.test/webhook", secret: SECRET_C },
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
 * Install a stub fetch that always answers 200 and records every
 * call (url, raw body, signature and event headers) so the test can
 * verify bodies and signatures exactly.
 */
function installStubFetch(): StubbedFetch {
  const calls: CapturedCall[] = [];
  const stub: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      body: String(init?.body ?? ""),
      signature: headers.get("x-signature") ?? "",
      eventIdHeader: headers.get("x-event-id") ?? "",
      idempotencyHeader: headers.get("idempotency-key") ?? "",
    });
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stub;
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

test("build stage: wrong-key error forwarded verbatim and consumes no eventId", () => {
  const { webhooks, eventIds } = buildChain();
  // The wrong-key entry produced no webhook and forwarded the
  // report error verbatim; the entry after it still built.
  assert.equal(webhooks[1].webhook, undefined);
  assert.match(webhooks[1].error ?? "", /hash chain/);
  assert.ok(webhooks[0].webhook);
  assert.ok(webhooks[2].webhook);
  // Exactly two eventIds issued, in batch order, with the second
  // good entry drawing evt-key-2 — the failed entry consumed none.
  assert.deepEqual(eventIds, ["evt-key-1", "evt-key-2"]);
  assert.equal(webhooks[0].webhook?.payload.eventId, "evt-key-1");
  assert.equal(webhooks[2].webhook?.payload.eventId, "evt-key-2");
  for (const entry of [webhooks[0], webhooks[2]]) {
    assert.ok(
      verifySettlementWebhook(
        entry.webhook!.payload,
        entry.webhook!.signature,
        BATCH_SECRET,
      ),
    );
  }
});

test("first delivery: good settlements fan out, verify per endpoint, read as first sightings", async () => {
  const { reports, webhooks, eventIds } = buildChain();
  const eps = endpoints();
  const stub = installStubFetch();
  try {
    for (const i of [0, 2]) {
      const out = await deliverSettlementWebhookToMany(reports[i].report!, eps, {
        now: FIXED_NOW,
        eventId: webhooks[i].webhook!.payload.eventId,
        backoffMs: 1,
      });
      assert.equal(out.delivered, 3);
      assert.equal(out.failed, 0);
      assert.deepEqual(
        out.results.map((r) => ({ url: r.url, ok: r.ok, attempts: r.attempts, status: r.status })),
        eps.map((e) => ({ url: e.url, ok: true, attempts: 1, status: 200 })),
      );
    }
  } finally {
    stub.restore();
  }

  // 2 settlements x 3 endpoints = 6 deliveries, no more, no fewer.
  assert.equal(stub.calls.length, 6);
  // The wrong-key escrow was never delivered.
  assert.ok(stub.calls.every((c) => !c.body.includes("kb-wrong")));

  // Per endpoint: the two bodies, in batch order, byte-identical
  // to the built webhook payloads; each signature verifies only
  // under that endpoint's own secret; headers carry the built id;
  // the receiver sees each event for the first time.
  const dedupes = eps.map(() => new SettlementEventDedupe());
  for (let e = 0; e < eps.length; e++) {
    const mine = stub.calls.filter((c) => c.url === eps[e].url);
    assert.equal(mine.length, 2);
    for (const [slot, i] of [[0, 0], [1, 2]] as const) {
      const built = webhooks[i].webhook;
      assert.ok(built, `webhook ${i} must exist`);
      assert.equal(mine[slot].body, JSON.stringify(built.payload));
      assert.equal(mine[slot].eventIdHeader, eventIds[slot]);
      assert.equal(mine[slot].idempotencyHeader, eventIds[slot]);
      assert.equal(
        verifySettlementWebhook(mine[slot].body, mine[slot].signature, ENDPOINT_SECRETS[e]),
        true,
      );
      for (let other = 0; other < ENDPOINT_SECRETS.length; other++) {
        if (other !== e) {
          assert.equal(
            verifySettlementWebhook(mine[slot].body, mine[slot].signature, ENDPOINT_SECRETS[other]),
            false,
          );
        }
      }
      // Receiver flow: verify first, then dedupe — first sighting.
      assert.equal(dedupes[e].checkAndRecord(eventIds[slot]), false);
    }
    // After both, every good eventId is now recorded at this endpoint.
    for (const id of eventIds) {
      assert.equal(dedupes[e].checkAndRecord(id), true);
    }
    // And the dedupe holds exactly the two good ids — nothing for
    // the wrong-key entry, which never had an eventId to record.
    assert.deepEqual(
      dedupes[e].exportSnapshot().entries.map(([id]) => id).sort(),
      [...eventIds].sort(),
    );
  }
});

test("re-delivering the keyed batch: delivery succeeds, receivers flag duplicates, wrong-key item still never fetched", async () => {
  const { reports, webhooks, eventIds } = buildChain();
  const eps = endpoints();
  const dedupes = eps.map(() => new SettlementEventDedupe());
  const stub = installStubFetch();
  try {
    const deliverBatch = async () => {
      for (const i of [0, 2]) {
        const out = await deliverSettlementWebhookToMany(reports[i].report!, eps, {
          now: FIXED_NOW,
          eventId: webhooks[i].webhook!.payload.eventId,
          backoffMs: 1,
        });
        assert.equal(out.delivered, 3);
        assert.equal(out.failed, 0);
      }
    };
    await deliverBatch();
    const firstRound = stub.calls.slice();
    assert.equal(firstRound.length, 6);
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
    const secondRound = stub.calls.slice(6);
    assert.equal(secondRound.length, 6);
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
    assert.ok(stub.calls.every((c) => !c.body.includes("kb-wrong")));
    // Dedupe snapshots still hold exactly the two good ids.
    for (const dedupe of dedupes) {
      assert.deepEqual(
        dedupe.exportSnapshot().entries.map(([id]) => id).sort(),
        [...eventIds].sort(),
      );
    }
  } finally {
    stub.restore();
  }
});
