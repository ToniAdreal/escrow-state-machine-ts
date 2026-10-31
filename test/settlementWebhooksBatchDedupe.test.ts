import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReports,
  buildSettlementWebhooks,
  buildSettlementWebhook,
  calculateDeposit,
  verifySettlementWebhook,
  SettlementEventDedupe,
  type SettlementReport,
  type SettlementReportInputs,
} from "../src/index.js";

/**
 * `buildSettlementWebhooks` batch x `SettlementEventDedupe` (backlog #763).
 *
 * `settlementWebhooksBatch` pins that a batch issues one DISTINCT eventId
 * per report (a factory returning a duplicate id fails that report
 * unsigned, without blocking later reports), and `settlementEventDedupe`
 * pins the receiver-side store, but no test pinned the two together:
 * what a receiver's dedupe actually records when it is fed a whole
 * batch, a whole-batch re-delivery, and a batch containing a
 * duplicate-id failure.
 *
 * Rules under test, with the documented receiver order (verify the raw
 * wire body first, `checkAndRecord` only after a `true` verification,
 * collapsed into a local `receive()` helper):
 *  - a 3-report batch with distinct eventIds: every webhook verifies,
 *    and the receiver records all 3 as first sightings
 *  - re-delivering the whole batch: all 3 report duplicate, and the
 *    store grows by nothing
 *  - a factory returning a duplicate id: the later report is unsigned
 *    (no webhook to deliver), so it adds no dedupe entry of its own;
 *    the failed settlement can still be delivered later under a fresh
 *    id as a first sighting
 *  - a failed build does not claim its factory id: a structurally
 *    broken report drawing "evt-reuse-763" is never signed, so a later
 *    true report reusing that same id builds, verifies, and is a first
 *    sighting on the receiver. This is the "later true report with that
 *    id is still first-seen" mechanism: it holds exactly when the
 *    earlier occurrence was never signed/delivered. The complementary
 *    guard is pinned alongside it: once the successfully signed twin
 *    HAS been delivered, a rebuild under that same id is correctly a
 *    duplicate — otherwise dedupe would be broken, not fixed.
 */

const SECRET = "whsec_test_batch_settlement_webhooks_dedupe_20261031";
const FIXED_NOW = "2026-10-31T17:30:00.000Z";

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

function inputsFor(e: Escrow): SettlementReportInputs {
  return {
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: deposit(),
    settlement: { proFeeBps: 500 },
  };
}

/** Deterministic factory: evt-1, evt-2, … in call order. */
function counterFactory() {
  let n = 0;
  return () => `evt-${++n}`;
}

type ReceiveOutcome = "processed" | "duplicate" | "rejected";

/**
 * The documented receiver order: verify the raw wire body first; only
 * a verified delivery reaches `checkAndRecord`. A rejected delivery
 * never touches the dedupe store.
 */
function receive(
  raw: string,
  signature: string,
  dedupe: SettlementEventDedupe,
): ReceiveOutcome {
  if (!verifySettlementWebhook(raw, signature, SECRET)) return "rejected";
  const { eventId } = JSON.parse(raw) as { eventId: string };
  return dedupe.checkAndRecord(eventId) ? "duplicate" : "processed";
}

function deliverBatch(
  batch: ReturnType<typeof buildSettlementWebhooks>,
  dedupe: SettlementEventDedupe,
): ReceiveOutcome[] {
  return batch.map((entry) => {
    assert.ok(entry.webhook, `expected a webhook for ${entry.escrowId}`);
    const raw = JSON.stringify(entry.webhook!.payload);
    return receive(raw, entry.webhook!.signature, dedupe);
  });
}

test("a 3-report batch verifies and all 3 eventIds are first sightings", () => {
  const results = buildSettlementReports([
    inputsFor(released("bw-dedupe-a")),
    inputsFor(refunded("bw-dedupe-b")),
    inputsFor(released("bw-dedupe-c")),
  ]);
  const batch = buildSettlementWebhooks(results, {
    secret: SECRET,
    now: FIXED_NOW,
    eventIdFactory: counterFactory(),
  });

  assert.deepEqual(
    batch.map((b) => b.webhook?.payload.eventId),
    ["evt-1", "evt-2", "evt-3"],
  );
  assert.deepEqual(
    batch.map((b) => b.webhook?.payload.escrowId),
    ["bw-dedupe-a", "bw-dedupe-b", "bw-dedupe-c"],
  );

  const dedupe = new SettlementEventDedupe();
  assert.deepEqual(deliverBatch(batch, dedupe), [
    "processed",
    "processed",
    "processed",
  ]);
  assert.equal(dedupe.size, 3);
  assert.deepEqual(dedupe.stats(), {
    size: 3,
    hits: 0,
    misses: 3,
    evictions: 0,
  });
});

test("re-delivering the whole batch reports duplicate for all 3, store unchanged", () => {
  const results = buildSettlementReports([
    inputsFor(released("bw-redel-a")),
    inputsFor(refunded("bw-redel-b")),
    inputsFor(released("bw-redel-c")),
  ]);
  const batch = buildSettlementWebhooks(results, {
    secret: SECRET,
    now: FIXED_NOW,
    eventIdFactory: counterFactory(),
  });

  const dedupe = new SettlementEventDedupe();
  assert.deepEqual(deliverBatch(batch, dedupe), [
    "processed",
    "processed",
    "processed",
  ]);
  // Whole-batch re-delivery: same eventIds, same signatures, so the
  // receiver must drop all three as duplicates, not re-process any.
  assert.deepEqual(deliverBatch(batch, dedupe), [
    "duplicate",
    "duplicate",
    "duplicate",
  ]);
  assert.equal(dedupe.size, 3);
  assert.deepEqual(dedupe.stats(), {
    size: 3,
    hits: 3,
    misses: 3,
    evictions: 0,
  });
});

test("duplicate factory id: later report unsigned, adds no dedupe entry", () => {
  const results = buildSettlementReports([
    inputsFor(released("bw-dup-a")),
    inputsFor(refunded("bw-dup-b")),
    inputsFor(released("bw-dup-c")),
  ]);
  const batch = buildSettlementWebhooks(results, {
    secret: SECRET,
    now: FIXED_NOW,
    eventIdFactory: () => "evt-dup-763",
  });

  assert.ok(batch[0].webhook);
  assert.equal(batch[0].webhook?.payload.eventId, "evt-dup-763");
  assert.equal(batch[1].webhook, undefined);
  assert.match(batch[1].error ?? "", /duplicate eventId "evt-dup-763" in batch/);
  assert.equal(batch[2].webhook, undefined);
  assert.match(batch[2].error ?? "", /duplicate eventId "evt-dup-763" in batch/);

  const dedupe = new SettlementEventDedupe();
  // Only the signed entry can be delivered at all: the unsigned
  // failures have no signature and no wire body, so they cannot add
  // a dedupe entry. Delivering the one success records exactly one id.
  const first = batch[0].webhook!;
  assert.equal(
    receive(JSON.stringify(first.payload), first.signature, dedupe),
    "processed",
  );
  assert.equal(dedupe.size, 1);
  assert.deepEqual(dedupe.stats(), {
    size: 1,
    hits: 0,
    misses: 1,
    evictions: 0,
  });

  // The failed settlement is not poisoned by its batch failure: rebuilt
  // under a fresh id it verifies and is a first sighting.
  const failedReport = results[1].report!;
  const rebuilt = buildSettlementWebhook(failedReport, {
    secret: SECRET,
    now: FIXED_NOW,
    eventId: "evt-dup-763-rebuilt",
  });
  assert.equal(
    receive(
      JSON.stringify(rebuilt.payload),
      rebuilt.signature,
      dedupe,
    ),
    "processed",
  );
  assert.equal(dedupe.size, 2);

  // Complementary guard: the one id that WAS successfully delivered
  // stays deduplicated. A rebuild under the delivered twin's id
  // verifies (the signature is genuine) but is correctly a duplicate.
  const twinRebuild = buildSettlementWebhook(failedReport, {
    secret: SECRET,
    now: FIXED_NOW,
    eventId: "evt-dup-763",
  });
  assert.ok(
    verifySettlementWebhook(twinRebuild.payload, twinRebuild.signature, SECRET),
  );
  assert.equal(
    receive(
      JSON.stringify(twinRebuild.payload),
      twinRebuild.signature,
      dedupe,
    ),
    "duplicate",
  );
});

test("a failed build does not claim its factory id: later true report with that id is first-seen", () => {
  const good = buildSettlementReports([inputsFor(released("bw-reuse-good"))])[0]
    .report!;
  const broken = { escrowId: "bw-reuse-broken" } as unknown as SettlementReport;
  const batch = buildSettlementWebhooks(
    [
      { escrowId: "bw-reuse-broken", report: broken },
      { escrowId: "bw-reuse-good", report: good },
    ],
    {
      secret: SECRET,
      now: FIXED_NOW,
      eventIdFactory: () => "evt-reuse-763",
    },
  );

  // The broken entry failed before signing, so it never claimed
  // "evt-reuse-763" in the batch: the good entry reusing that same
  // factory value builds (it is not a duplicate) and verifies.
  assert.equal(batch[0].webhook, undefined);
  assert.ok(typeof batch[0].error === "string" && batch[0].error.length > 0);
  assert.ok(!/duplicate eventId/.test(batch[0].error ?? ""));
  assert.ok(batch[1].webhook);
  assert.equal(batch[1].webhook?.payload.eventId, "evt-reuse-763");
  assert.ok(
    verifySettlementWebhook(
      batch[1].webhook!.payload,
      batch[1].webhook!.signature,
      SECRET,
    ),
  );

  // And on the receiver side the id was never recorded by the failed
  // build either: the true report's first delivery is a first sighting,
  // and only its re-delivery is a duplicate.
  const dedupe = new SettlementEventDedupe();
  const webhook = batch[1].webhook!;
  const raw = JSON.stringify(webhook.payload);
  assert.equal(receive(raw, webhook.signature, dedupe), "processed");
  assert.equal(receive(raw, webhook.signature, dedupe), "duplicate");
  assert.deepEqual(dedupe.stats(), {
    size: 1,
    hits: 1,
    misses: 1,
    evictions: 0,
  });
});
