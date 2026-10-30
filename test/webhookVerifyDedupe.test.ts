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
import type { VerifyWebhookOptions } from "../src/index.js";

/**
 * Settlement webhook receiver flow (backlog #725): verify-then-dedupe.
 *
 * `SettlementEventDedupe`'s docs require receivers to deduplicate on
 * `eventId`, and the README's receiver snippet runs
 * `verifySettlementWebhook` first — but no test ever combined the two, so
 * the verify-before-record ordering had no backing: a receiver that
 * recorded before verifying would let a forged payload poison the dedupe
 * store and turn the genuine re-delivery of the same `eventId` into a
 * false duplicate. Rules under test, mirroring the README snippet:
 *  - first delivery: signature verifies, `eventId` is unseen → processed
 *  - re-delivery of the same signed body: signature still verifies, but
 *    `checkAndRecord` reports a duplicate → dropped, not re-processed
 *  - a tampered body fails verification and must NEVER reach the dedupe
 *    store: the genuine delivery of that same `eventId` afterwards is
 *    still a first sighting
 *  - a rejected (bad-secret / all-mismatch rotation candidates) delivery
 *    likewise leaves the store untouched
 *  - once the TTL expires, the same `eventId` counts as unseen again
 *  - different `eventId`s are independent in the receiver flow too
 *
 * One honest deviation from the backlog wording, pinned here: an empty
 * `secrets` array does NOT return `false` — `verifySettlementWebhook`
 * throws a caller configuration error (`secrets must be a non-empty
 * array`), exactly like an empty secret inside the array. It never
 * authenticates, so the fail-closed outcome is the same, but the shape
 * is a throw, not `false`; the test asserts the real behavior.
 */

const SECRET = "whsec_test_settlement_notifications_20261006";
const WRONG_SECRET = "whsec_wrong_secret_for_receiver_flow_tests";
const FIXED_NOW = "2026-10-06T11:30:00.000Z";
const TTL = 60_000;

function goldenDeposit() {
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

function signedDelivery(eventId: string) {
  const escrow = new Escrow("esc-10630");
  escrow.dispatch("FUND");
  escrow.dispatch("SUBMIT_MILESTONE");
  escrow.dispatch("VERIFY_PASS");
  escrow.dispatch("RELEASE");
  const report = buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500 },
  });
  const signed = buildSettlementWebhook(report, {
    secret: SECRET,
    now: FIXED_NOW,
    eventId,
  });
  return { raw: JSON.stringify(signed.payload), signature: signed.signature };
}

/**
 * The README receiver snippet, as a testable function: verify the raw
 * body FIRST; only a verified delivery may touch the dedupe store.
 * Returns "processed" for a first-seen verified delivery, "duplicate"
 * for a verified re-delivery, and "rejected" for anything unverified.
 */
function receive(
  dedupe: SettlementEventDedupe,
  raw: string,
  signature: string,
  secretOrOptions: string | VerifyWebhookOptions,
): "processed" | "duplicate" | "rejected" {
  // Narrowed per overload: a union argument matches neither overload.
  const verified =
    typeof secretOrOptions === "string"
      ? verifySettlementWebhook(raw, signature, secretOrOptions)
      : verifySettlementWebhook(raw, signature, secretOrOptions);
  if (!verified) {
    return "rejected";
  }
  const { eventId } = JSON.parse(raw) as { eventId: string };
  return dedupe.checkAndRecord(eventId) ? "duplicate" : "processed";
}

function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

test("first delivery processes, re-delivery verifies but is a duplicate", () => {
  const dedupe = new SettlementEventDedupe({ ttlMs: TTL });
  const { raw, signature } = signedDelivery("evt-receiver-1");
  assert.equal(receive(dedupe, raw, signature, SECRET), "processed");
  assert.equal(dedupe.size, 1);
  // Same signed bytes again: the signature still verifies, but the
  // receiver must drop it as a duplicate, not process it twice.
  assert.equal(receive(dedupe, raw, signature, SECRET), "duplicate");
  assert.equal(dedupe.size, 1);
  assert.deepEqual(dedupe.stats(), {
    size: 1,
    hits: 1,
    misses: 1,
    evictions: 0,
  });
});

test("a tampered delivery is rejected and never poisons the dedupe store", () => {
  const dedupe = new SettlementEventDedupe({ ttlMs: TTL });
  const { raw, signature } = signedDelivery("evt-receiver-2");
  const tampered = JSON.parse(raw) as Record<string, unknown>;
  tampered.deposit = 99999; // signature no longer covers the body
  const tamperedRaw = JSON.stringify(tampered);
  assert.equal(verifySettlementWebhook(tamperedRaw, signature, SECRET), false);
  assert.equal(receive(dedupe, tamperedRaw, signature, SECRET), "rejected");
  assert.equal(dedupe.size, 0);
  // The genuine delivery of the same eventId afterwards is still a
  // first sighting — the forgery did not consume the id.
  assert.equal(receive(dedupe, raw, signature, SECRET), "processed");
  assert.equal(dedupe.size, 1);
});

test("a forged re-delivery of an already-seen eventId leaves stats untouched", () => {
  const dedupe = new SettlementEventDedupe({ ttlMs: TTL });
  const { raw, signature } = signedDelivery("evt-receiver-3");
  assert.equal(receive(dedupe, raw, signature, SECRET), "processed");
  const before = dedupe.stats();
  const forged = JSON.parse(raw) as Record<string, unknown>;
  forged.deposit = 1;
  assert.equal(
    receive(dedupe, JSON.stringify(forged), signature, SECRET),
    "rejected",
  );
  assert.deepEqual(dedupe.stats(), before);
  // And the genuine bytes are still recognised as the duplicate they are.
  assert.equal(receive(dedupe, raw, signature, SECRET), "duplicate");
});

test("TTL expiry makes the same eventId a first sighting again", () => {
  const clock = fakeClock();
  const dedupe = new SettlementEventDedupe({ ttlMs: TTL, now: clock.now });
  const { raw, signature } = signedDelivery("evt-receiver-4");
  assert.equal(receive(dedupe, raw, signature, SECRET), "processed");
  clock.advance(TTL - 1);
  assert.equal(receive(dedupe, raw, signature, SECRET), "duplicate");
  clock.advance(1); // age is now exactly ttlMs: expired (boundary)
  assert.equal(receive(dedupe, raw, signature, SECRET), "processed");
});

test("wrong secret and all-mismatch rotation candidates reject without recording", () => {
  const dedupe = new SettlementEventDedupe({ ttlMs: TTL });
  const { raw, signature } = signedDelivery("evt-receiver-5");
  assert.equal(receive(dedupe, raw, signature, WRONG_SECRET), "rejected");
  assert.equal(
    receive(dedupe, raw, signature, {
      secrets: [WRONG_SECRET, "whsec_also_wrong"],
    }),
    "rejected",
  );
  assert.equal(dedupe.size, 0);
  // Rotation to the right secret afterwards still sees a first delivery.
  assert.equal(
    receive(dedupe, raw, signature, { secrets: [WRONG_SECRET, SECRET] }),
    "processed",
  );
});

test("empty secrets throw a configuration error and leave the store empty", () => {
  const dedupe = new SettlementEventDedupe({ ttlMs: TTL });
  const { raw, signature } = signedDelivery("evt-receiver-6");
  assert.throws(
    () => verifySettlementWebhook(raw, signature, { secrets: [] }),
    /secrets must be a non-empty array/,
  );
  assert.throws(
    () => verifySettlementWebhook(raw, signature, { secrets: [""] }),
    /must not be empty/,
  );
  assert.equal(dedupe.size, 0);
  assert.equal(receive(dedupe, raw, signature, SECRET), "processed");
});

test("independent eventIds are independent in the receiver flow", () => {
  const dedupe = new SettlementEventDedupe({ ttlMs: TTL });
  const first = signedDelivery("evt-receiver-7a");
  const second = signedDelivery("evt-receiver-7b");
  assert.equal(receive(dedupe, first.raw, first.signature, SECRET), "processed");
  assert.equal(
    receive(dedupe, second.raw, second.signature, SECRET),
    "processed",
  );
  assert.equal(dedupe.size, 2);
  assert.equal(
    receive(dedupe, first.raw, first.signature, SECRET),
    "duplicate",
  );
  assert.equal(
    receive(dedupe, second.raw, second.signature, SECRET),
    "duplicate",
  );
});
