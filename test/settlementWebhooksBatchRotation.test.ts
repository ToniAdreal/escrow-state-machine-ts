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
  type SettlementReportInputs,
} from "../src/index.js";

/**
 * `buildSettlementWebhooks` batch x secret rotation (backlog #772).
 *
 * `settlementWebhooksBatchDedupe` (#763) pins batch x dedupe, and
 * `verifySettlementWebhook` accepts a `secrets: [new, old]` candidate
 * list, but no test pinned the two together: a batch signed during
 * the rotation window (with the OLD key) delivered to a receiver
 * that verifies with the [new, old] candidate list, and what the
 * receiver's dedupe records across a whole-batch re-delivery, a
 * re-sign under the NEW key for the same eventIds, and a batch
 * item signed with a stranger key.
 *
 * Rules under test, with the documented receiver order (verify the
 * raw wire body first with the rotation candidate list,
 * `checkAndRecord` only after a `true` verification, collapsed into
 * a local `receive()` helper):
 *  - a 3-report batch signed with the old key verifies under
 *    [new, old] and all 3 eventIds are first sightings
 *  - re-delivering the whole batch: all 3 report duplicate, and the
 *    store grows by nothing
 *  - re-signing the same eventIds with the new key (post-rotation
 *    issuance) still verifies under [new, old] but is correctly a
 *    duplicate on the receiver: rotation changes which key is
 *    trusted, it does not reset dedupe
 *  - a batch signed with a stranger key fails verification under
 *    [new, old] and records nothing, so a later true batch under the
 *    same eventIds is still a first sighting
 */

const OLD_KEY = "whsec_test_batch_rotation_old_20261031";
const NEW_KEY = "whsec_test_batch_rotation_new_20261031";
const STRANGER_KEY = "whsec_test_batch_rotation_stranger_20261031";
const FIXED_NOW = "2026-10-31T22:20:00.000Z";

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

/** Deterministic factory: evt-rot-1, evt-rot-2, … in call order. */
function counterFactory(prefix: string) {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

type ReceiveOutcome = "processed" | "duplicate" | "rejected";

/**
 * The documented receiver order: verify the raw wire body first
 * (rotation candidate list, newest first); only a verified delivery
 * reaches `checkAndRecord`. A rejected delivery never touches the
 * dedupe store.
 */
function receive(
  raw: string,
  signature: string,
  dedupe: SettlementEventDedupe,
): ReceiveOutcome {
  if (
    !verifySettlementWebhook(raw, signature, {
      secrets: [NEW_KEY, OLD_KEY],
    })
  ) {
    return "rejected";
  }
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

function batchResults() {
  return buildSettlementReports([
    inputsFor(released("bw-rot-a")),
    inputsFor(refunded("bw-rot-b")),
    inputsFor(released("bw-rot-c")),
  ]);
}

test("a 3-report batch signed with the old key verifies under [new, old] and all 3 are first sightings", () => {
  const batch = buildSettlementWebhooks(batchResults(), {
    secret: OLD_KEY,
    now: FIXED_NOW,
    eventIdFactory: counterFactory("evt-rot"),
  });

  assert.deepEqual(
    batch.map((b) => b.webhook?.payload.eventId),
    ["evt-rot-1", "evt-rot-2", "evt-rot-3"],
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

test("re-delivering the whole old-key batch reports duplicate for all 3, store unchanged", () => {
  const batch = buildSettlementWebhooks(batchResults(), {
    secret: OLD_KEY,
    now: FIXED_NOW,
    eventIdFactory: counterFactory("evt-rot"),
  });

  const dedupe = new SettlementEventDedupe();
  assert.deepEqual(deliverBatch(batch, dedupe), [
    "processed",
    "processed",
    "processed",
  ]);
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

test("re-signing the same eventIds with the new key still verifies but is a duplicate, not a first sighting", () => {
  const results = batchResults();
  const batch = buildSettlementWebhooks(results, {
    secret: OLD_KEY,
    now: FIXED_NOW,
    eventIdFactory: counterFactory("evt-rot"),
  });

  const dedupe = new SettlementEventDedupe();
  assert.deepEqual(deliverBatch(batch, dedupe), [
    "processed",
    "processed",
    "processed",
  ]);

  // Post-rotation issuance: the same settlements re-signed with the
  // new key under the same eventIds. The signatures are genuine
  // under the candidate list, but dedupe keys on the verified body
  // eventId, so the receiver must still drop all three as duplicates.
  const rebuilt = results.map((entry, i) => {
    assert.ok(entry.report, `expected a report for ${entry.escrowId}`);
    return buildSettlementWebhook(entry.report!, {
      secret: NEW_KEY,
      now: FIXED_NOW,
      eventId: `evt-rot-${i + 1}`,
    });
  });
  assert.deepEqual(
    rebuilt.map((w) =>
      receive(JSON.stringify(w.payload), w.signature, dedupe),
    ),
    ["duplicate", "duplicate", "duplicate"],
  );
  assert.equal(dedupe.size, 3);
  assert.deepEqual(dedupe.stats(), {
    size: 3,
    hits: 3,
    misses: 3,
    evictions: 0,
  });
});

test("a batch signed with a stranger key verifies false and records nothing; the true batch under the same eventIds is still first-seen", () => {
  const strangerBatch = buildSettlementWebhooks(batchResults(), {
    secret: STRANGER_KEY,
    now: FIXED_NOW,
    eventIdFactory: counterFactory("evt-stranger"),
  });

  const dedupe = new SettlementEventDedupe();
  assert.deepEqual(deliverBatch(strangerBatch, dedupe), [
    "rejected",
    "rejected",
    "rejected",
  ]);
  assert.equal(dedupe.size, 0);
  assert.deepEqual(dedupe.stats(), {
    size: 0,
    hits: 0,
    misses: 0,
    evictions: 0,
  });

  // The same eventIds, now genuinely signed with the old key:
  // nothing was recorded by the rejected batch, so all are first
  // sightings, not duplicates poisoned by the stranger's attempt.
  const trueBatch = buildSettlementWebhooks(batchResults(), {
    secret: OLD_KEY,
    now: FIXED_NOW,
    eventIdFactory: counterFactory("evt-stranger"),
  });
  assert.deepEqual(deliverBatch(trueBatch, dedupe), [
    "processed",
    "processed",
    "processed",
  ]);
  assert.equal(dedupe.size, 3);
});
