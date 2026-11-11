import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementReports,
  buildSettlementWebhook,
  buildSettlementWebhooks,
  calculateDeposit,
  MAX_EVENT_ID_LENGTH,
  SettlementEventDedupe,
  SettlementWebhookOutbox,
  verifySettlementWebhook,
  type SettlementReportInputs,
} from "../src/index.js";
import {
  DEMO_OUTBOX_RECOVERED_EVENT_ID,
  DEMO_WEBHOOK_EVENT_ID,
} from "../src/demo.js";

const SECRET = "whsec_test_max_event_id_length_20261111";
const FIXED_NOW = "2026-11-11T11:30:00.000Z";
const OVERLONG = "e".repeat(MAX_EVENT_ID_LENGTH + 1);
const AT_CAP = "e".repeat(MAX_EVENT_ID_LENGTH);

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

function inputsFor(e: Escrow): SettlementReportInputs {
  return {
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: deposit(),
    settlement: { proFeeBps: 500 },
  };
}

function releasedReport(id = "evt-cap-escrow") {
  return buildSettlementReport(inputsFor(released(id)));
}

test("MAX_EVENT_ID_LENGTH is exported and is 256 (UUIDs are 36 chars)", () => {
  assert.equal(MAX_EVENT_ID_LENGTH, 256);
});

test("build: overlong eventId is rejected, never truncated", () => {
  assert.throws(
    () =>
      buildSettlementWebhook(releasedReport(), {
        secret: SECRET,
        now: FIXED_NOW,
        eventId: OVERLONG,
      }),
    /eventId.*must be at most 256 characters, got 257/,
  );
});

test("build: eventId exactly at the cap is used verbatim and verifies", () => {
  const { payload, signature } = buildSettlementWebhook(releasedReport(), {
    secret: SECRET,
    now: FIXED_NOW,
    eventId: AT_CAP,
  });
  assert.equal(payload.eventId, AT_CAP);
  assert.equal(payload.eventId.length, MAX_EVENT_ID_LENGTH);
  assert.equal(verifySettlementWebhook(payload, signature, SECRET), true);
});

test("dedupe: checkAndRecord rejects an overlong eventId and records nothing", () => {
  const dedupe = new SettlementEventDedupe({ now: () => 1_000 });
  assert.throws(
    () => dedupe.checkAndRecord(OVERLONG),
    /eventId must be at most 256 characters, got 257/,
  );
  assert.equal(dedupe.size, 0);
  assert.equal(dedupe.stats().misses, 0);
  // A later valid id still records normally: the throw left no residue.
  assert.equal(dedupe.checkAndRecord("evt_ok"), false);
  assert.equal(dedupe.size, 1);
});

test("dedupe: eventId exactly at the cap records and dedupes", () => {
  const dedupe = new SettlementEventDedupe({ now: () => 1_000 });
  assert.equal(dedupe.checkAndRecord(AT_CAP), false);
  assert.equal(dedupe.checkAndRecord(AT_CAP), true);
  assert.equal(dedupe.size, 1);
});

test("dedupe: restore rejects a snapshot carrying an overlong eventId", () => {
  assert.throws(
    () =>
      SettlementEventDedupe.restore(
        { v: 1, entries: [[OVERLONG, 1_000]] },
        { now: () => 2_000 },
      ),
    /entries\[0\]: eventId must be at most 256 characters, got 257/,
  );
});

test("dedupe: restore accepts a snapshot carrying an at-cap eventId", () => {
  const dedupe = SettlementEventDedupe.restore(
    { v: 1, entries: [[AT_CAP, 1_000]] },
    { now: () => 2_000 },
  );
  // Still live (TTL 1h) and still deduplicates: the restore kept the id.
  assert.equal(dedupe.checkAndRecord(AT_CAP), true);
});

test("outbox: recordAttempt rejects an overlong eventId and records nothing", () => {
  const outbox = new SettlementWebhookOutbox({ now: () => 1_000 });
  assert.throws(
    () =>
      outbox.recordAttempt({
        endpoint: "https://example.com/hook",
        eventId: OVERLONG,
        ok: false,
        error: "boom",
      }),
    /eventId must be at most 256 characters, got 257/,
  );
  assert.equal(outbox.size, 0);
  assert.deepEqual(outbox.pending(), []);
});

test("outbox: recordAttempt accepts an eventId exactly at the cap", () => {
  const outbox = new SettlementWebhookOutbox({ now: () => 1_000 });
  outbox.recordAttempt({
    endpoint: "https://example.com/hook",
    eventId: AT_CAP,
    ok: false,
    error: "boom",
  });
  assert.equal(outbox.size, 1);
  assert.equal(outbox.pending()[0]?.eventId, AT_CAP);
});

test("outbox: restore rejects a snapshot carrying an overlong eventId", () => {
  assert.throws(
    () =>
      SettlementWebhookOutbox.restore({
        v: 1,
        entries: [
          {
            endpoint: "https://example.com/hook",
            eventId: OVERLONG,
            attempts: 1,
            lastAt: 1_000,
          },
        ],
      }),
    /entries\[0\]: eventId must be at most 256 characters, got 257/,
  );
});

test("batch: an overlong factory eventId fails only that report", () => {
  const results = buildSettlementReports([
    inputsFor(released("evt-cap-batch-1")),
    inputsFor(released("evt-cap-batch-2")),
  ]);
  const ids = [OVERLONG, "evt_batch_ok"];
  let n = 0;
  const batch = buildSettlementWebhooks(results, {
    secret: SECRET,
    now: FIXED_NOW,
    eventIdFactory: () => ids[n++],
  });
  assert.equal(batch.length, 2);
  assert.equal(batch[0]?.webhook, undefined);
  assert.match(batch[0]?.error ?? "", /at most 256 characters, got 257/);
  // The later report was still attempted and signed: per-item isolation.
  assert.equal(batch[1]?.webhook?.payload.eventId, "evt_batch_ok");
  assert.equal(batch[1]?.error, undefined);
});

test("demo eventIds are unaffected by the cap", () => {
  assert.ok(DEMO_WEBHOOK_EVENT_ID.length < MAX_EVENT_ID_LENGTH);
  assert.ok(DEMO_OUTBOX_RECOVERED_EVENT_ID.length < MAX_EVENT_ID_LENGTH);
  const { payload, signature } = buildSettlementWebhook(releasedReport(), {
    secret: SECRET,
    now: FIXED_NOW,
    eventId: DEMO_WEBHOOK_EVENT_ID,
  });
  assert.equal(payload.eventId, DEMO_WEBHOOK_EVENT_ID);
  assert.equal(verifySettlementWebhook(payload, signature, SECRET), true);

  const dedupe = new SettlementEventDedupe({ now: () => 1_000 });
  assert.equal(dedupe.checkAndRecord(DEMO_WEBHOOK_EVENT_ID), false);

  const outbox = new SettlementWebhookOutbox({ now: () => 1_000 });
  outbox.recordAttempt({
    endpoint: "https://example.com/hook",
    eventId: DEMO_OUTBOX_RECOVERED_EVENT_ID,
    ok: false,
    error: "boom",
  });
  assert.equal(outbox.pending()[0]?.eventId, DEMO_OUTBOX_RECOVERED_EVENT_ID);
});
