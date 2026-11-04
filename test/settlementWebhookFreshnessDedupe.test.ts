import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementWebhook,
  calculateDeposit,
  verifySettlementWebhook,
  SettlementEventDedupe,
} from "../src/index.js";

/**
 * Settlement webhook freshness window x `SettlementEventDedupe`
 * verify-then-record order (backlog #884, the escrow-side counterpart
 * of dataquest #819).
 *
 * `test/webhookFreshness.test.ts` pins the freshness window alone and
 * `test/webhookVerifyDedupe.test.ts` pins verify-before-record for
 * forged bodies — but freshness failures and dedupe never met. The
 * gap matters: a legitimately-signed payload that is too old, or
 * stamped too far in the future, verifies false only because of its
 * timestamp. If a receiver recorded its `eventId` before (or
 * regardless of) that freshness verdict, the poisoned entry would
 * turn the sender's later, fresh re-delivery of the same event into
 * a false "duplicate" — a settlement event silently dropped for
 * being on time the second time.
 *
 * Rules pinned here, via the documented receiver order collapsed
 * into a local `receive()` helper (verify with the two-sided
 * freshness window first; `checkAndRecord` only after a `true`
 * verification):
 *  - a stale payload (`now - at > maxAgeMs`) verifies false and
 *    records nothing, so the same eventId re-signed with a fresh
 *    `at` is still a first sighting (not a duplicate poisoned by
 *    the stale attempt)
 *  - an over-future-window payload (`at - now > maxFutureSkewMs`)
 *    behaves the same way: rejected, unrecorded, fresh re-sign
 *    first-seen
 *  - an in-window payload verifies, is recorded as a first
 *    sighting, and its re-delivery reports duplicate, with
 *    hits/misses counting the flow
 *  - freshness failures leave the dedupe counters untouched — both
 *    before any success (stats stay all-zero) and after a success
 *    (a stale replay of an already-seen eventId changes neither
 *    the stats nor the duplicate verdict of the true re-delivery)
 *  - the boundaries are inclusive for recording too: a payload aged
 *    exactly `maxAgeMs`, and one skewed exactly `maxFutureSkewMs`
 *    into the future, both verify and are recorded as first
 *    sightings (one millisecond past either bound still rejects
 *    and records nothing)
 *
 * No source change: the verify-then-record order is already the
 * documented receiver flow; this file is the missing backstop for
 * its freshness interaction.
 */

const SECRET = "whsec_test_settlement_freshness_dedupe_20261104";
const NOW = Date.parse("2026-11-04T14:00:00.000Z");
const ONE_HOUR = 3_600_000;

function goldenDeposit() {
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

function releasedReport(id = "esc-fresh-dedupe") {
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

function signedDelivery(eventId: string, at: Date) {
  const signed = buildSettlementWebhook(releasedReport(), {
    secret: SECRET,
    now: at,
    eventId,
  });
  return { raw: JSON.stringify(signed.payload), signature: signed.signature };
}

type ReceiveOutcome = "processed" | "duplicate" | "rejected";

/**
 * The documented receiver order, with the freshness window applied
 * at verify time: verify the raw wire body first (signature, then
 * freshness); only a verified delivery reaches `checkAndRecord`.
 * A rejected delivery never touches the dedupe store.
 */
function receive(
  dedupe: SettlementEventDedupe,
  raw: string,
  signature: string,
): ReceiveOutcome {
  const verified = verifySettlementWebhook(raw, signature, {
    secrets: [SECRET],
    maxAgeMs: ONE_HOUR,
    maxFutureSkewMs: ONE_HOUR,
    now: NOW,
  });
  if (!verified) return "rejected";
  const { eventId } = JSON.parse(raw) as { eventId: string };
  return dedupe.checkAndRecord(eventId) ? "duplicate" : "processed";
}

function freshDedupe() {
  return new SettlementEventDedupe({ now: () => NOW });
}

function emptyStats() {
  return { size: 0, hits: 0, misses: 0, evictions: 0 };
}

test("stale payload is rejected and unrecorded, so its fresh re-sign is first-seen", () => {
  const stale = signedDelivery(
    "evt-fresh-dedupe-stale",
    new Date(NOW - 2 * ONE_HOUR),
  );
  const dedupe = freshDedupe();
  // The signature alone is valid — only the age gate rejects it.
  assert.equal(verifySettlementWebhook(stale.raw, stale.signature, SECRET), true);
  assert.equal(
    verifySettlementWebhook(stale.raw, stale.signature, {
      secrets: [SECRET],
      maxAgeMs: ONE_HOUR,
      now: NOW,
    }),
    false,
  );
  assert.equal(receive(dedupe, stale.raw, stale.signature), "rejected");
  assert.equal(dedupe.size, 0);
  assert.deepEqual(dedupe.stats(), emptyStats());
  // Same eventId, freshly stamped and re-signed: a first sighting,
  // not a duplicate poisoned by the stale attempt.
  const fresh = signedDelivery("evt-fresh-dedupe-stale", new Date(NOW));
  assert.equal(receive(dedupe, fresh.raw, fresh.signature), "processed");
  assert.equal(receive(dedupe, fresh.raw, fresh.signature), "duplicate");
  assert.deepEqual(dedupe.stats(), {
    size: 1,
    hits: 1,
    misses: 1,
    evictions: 0,
  });
});

test("over-future-window payload is rejected and unrecorded, so its fresh re-sign is first-seen", () => {
  const future = signedDelivery(
    "evt-fresh-dedupe-future",
    new Date(NOW + 2 * ONE_HOUR),
  );
  const dedupe = freshDedupe();
  // The signature alone is valid — only the future-skew gate rejects it.
  assert.equal(
    verifySettlementWebhook(future.raw, future.signature, SECRET),
    true,
  );
  assert.equal(
    verifySettlementWebhook(future.raw, future.signature, {
      secrets: [SECRET],
      maxFutureSkewMs: ONE_HOUR,
      now: NOW,
    }),
    false,
  );
  assert.equal(receive(dedupe, future.raw, future.signature), "rejected");
  assert.equal(dedupe.size, 0);
  assert.deepEqual(dedupe.stats(), emptyStats());
  const fresh = signedDelivery("evt-fresh-dedupe-future", new Date(NOW));
  assert.equal(receive(dedupe, fresh.raw, fresh.signature), "processed");
  assert.equal(receive(dedupe, fresh.raw, fresh.signature), "duplicate");
  assert.deepEqual(dedupe.stats(), {
    size: 1,
    hits: 1,
    misses: 1,
    evictions: 0,
  });
});

test("in-window payload verifies, records a first sighting, and re-delivery is a duplicate", () => {
  const delivery = signedDelivery("evt-fresh-dedupe-window", new Date(NOW));
  const dedupe = freshDedupe();
  assert.equal(receive(dedupe, delivery.raw, delivery.signature), "processed");
  assert.equal(dedupe.size, 1);
  assert.equal(receive(dedupe, delivery.raw, delivery.signature), "duplicate");
  assert.equal(dedupe.size, 1);
  assert.deepEqual(dedupe.stats(), {
    size: 1,
    hits: 1,
    misses: 1,
    evictions: 0,
  });
});

test("freshness failures leave dedupe counters untouched, before and after a success", () => {
  const dedupe = freshDedupe();
  // Two freshness failures, two directions, before any success.
  const stale = signedDelivery(
    "evt-fresh-dedupe-counters",
    new Date(NOW - 2 * ONE_HOUR),
  );
  const future = signedDelivery(
    "evt-fresh-dedupe-counters-future",
    new Date(NOW + 2 * ONE_HOUR),
  );
  assert.equal(receive(dedupe, stale.raw, stale.signature), "rejected");
  assert.equal(receive(dedupe, future.raw, future.signature), "rejected");
  assert.deepEqual(dedupe.stats(), emptyStats());
  // A success in between, then a stale replay of the same eventId:
  // the replay is rejected and must change neither the stats nor
  // the duplicate verdict of the true re-delivery.
  const good = signedDelivery("evt-fresh-dedupe-counters", new Date(NOW));
  assert.equal(receive(dedupe, good.raw, good.signature), "processed");
  const before = dedupe.stats();
  assert.equal(receive(dedupe, stale.raw, stale.signature), "rejected");
  assert.deepEqual(dedupe.stats(), before);
  assert.equal(receive(dedupe, good.raw, good.signature), "duplicate");
  assert.deepEqual(dedupe.stats(), {
    size: 1,
    hits: 1,
    misses: 1,
    evictions: 0,
  });
});

test("boundary payloads verify and are recorded; one millisecond past either bound rejects unrecorded", () => {
  const dedupe = freshDedupe();
  // Exactly maxAgeMs old: inclusive boundary, verifies and records.
  const aged = signedDelivery(
    "evt-fresh-dedupe-boundary-old",
    new Date(NOW - ONE_HOUR),
  );
  assert.equal(receive(dedupe, aged.raw, aged.signature), "processed");
  // Exactly maxFutureSkewMs in the future: inclusive boundary too.
  const skewed = signedDelivery(
    "evt-fresh-dedupe-boundary-future",
    new Date(NOW + ONE_HOUR),
  );
  assert.equal(receive(dedupe, skewed.raw, skewed.signature), "processed");
  assert.equal(dedupe.size, 2);
  // One millisecond past either bound: rejected and unrecorded.
  const tooOld = signedDelivery(
    "evt-fresh-dedupe-boundary-past",
    new Date(NOW - ONE_HOUR - 1),
  );
  assert.equal(receive(dedupe, tooOld.raw, tooOld.signature), "rejected");
  const tooFar = signedDelivery(
    "evt-fresh-dedupe-boundary-far",
    new Date(NOW + ONE_HOUR + 1),
  );
  assert.equal(receive(dedupe, tooFar.raw, tooFar.signature), "rejected");
  assert.equal(dedupe.size, 2);
  assert.deepEqual(dedupe.stats(), {
    size: 2,
    hits: 0,
    misses: 2,
    evictions: 0,
  });
});
