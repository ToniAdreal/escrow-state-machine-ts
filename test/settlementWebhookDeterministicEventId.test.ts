import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementWebhook,
  buildSettlementWebhooks,
  calculateDeposit,
  diffSettlementReports,
  parseSettlementReportJson,
  renderReportJson,
  SettlementEventDedupe,
  verifySettlementWebhook,
} from "../src/index.js";
import type { SettlementReport } from "../src/index.js";

/**
 * Deterministic settlement webhook `eventId` (backlog #1430).
 *
 * Before this item `buildSettlementWebhook` defaulted `eventId` to a fresh
 * `crypto.randomUUID()` on every call, so two independent builds of the
 * same settlement produced two legitimately signed webhooks with
 * different `eventId`s — and a receiver deduplicating on `eventId`
 * (`SettlementEventDedupe`) saw both as first sightings and booked the
 * settlement twice. The default is now derived from the report's
 * settlement-evidence anchor (`terminalSeq` + `terminalHash`, stamped
 * by `buildSettlementReport` from the audit chain tip):
 * `settlement-<escrowId>-<terminalSeq>-<first 12 hex of terminalHash>`.
 * A report without an anchor (hand-built, or built from a legacy
 * hashless history) keeps the UUID fallback, and an explicit `eventId`
 * still overrides.
 */

const SECRET = "whsec_test_deterministic_settlement_event_id";
const KEY = "audit-key-for-deterministic-event-id";
const FIXED_NOW = "2026-11-27T10:55:00.000Z";
const LATER_NOW = "2026-11-27T10:56:00.000Z";
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function goldenDeposit() {
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

function keyedReleasedEscrow(id: string) {
  const e = new Escrow(id, { auditKey: KEY });
  e.dispatch("FUND", undefined, 10630);
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return e;
}

function keyedReleasedReport(id: string): SettlementReport {
  const e = keyedReleasedEscrow(id);
  return buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500 },
    auditKey: KEY,
  });
}

function keyedRefundedReport(id: string): SettlementReport {
  const e = new Escrow(id, { auditKey: KEY });
  e.dispatch("FUND", undefined, 10630);
  e.dispatch("DISPUTE");
  e.dispatch("ARBITRATE_REFUND");
  return buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: goldenDeposit(),
    auditKey: KEY,
  });
}

function unkeyedReleasedReport(id: string): SettlementReport {
  const e = new Escrow(id);
  e.dispatch("FUND", undefined, 10630);
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

test("same anchored report built twice with a fixed now shares eventId and signature", () => {
  const report = keyedReleasedReport("esc-det-a");
  const expected =
    `settlement-esc-det-a-${report.terminalSeq}-${report.terminalHash!.slice(0, 12)}`;
  const a = buildSettlementWebhook(report, { secret: SECRET, now: FIXED_NOW });
  const b = buildSettlementWebhook(report, { secret: SECRET, now: FIXED_NOW });
  assert.equal(a.payload.eventId, expected);
  assert.equal(b.payload.eventId, expected);
  assert.deepEqual(a.payload, b.payload);
  assert.equal(a.signature, b.signature);
  assert.ok(verifySettlementWebhook(a.payload, a.signature, SECRET));
});

test("same anchored report at two different fixed nows shares eventId, differs in at and signature", () => {
  const report = keyedReleasedReport("esc-det-b");
  const a = buildSettlementWebhook(report, { secret: SECRET, now: FIXED_NOW });
  const b = buildSettlementWebhook(report, { secret: SECRET, now: LATER_NOW });
  assert.equal(a.payload.eventId, b.payload.eventId);
  assert.equal(a.payload.at, FIXED_NOW);
  assert.equal(b.payload.at, LATER_NOW);
  assert.notEqual(a.signature, b.signature);
  assert.ok(verifySettlementWebhook(a.payload, a.signature, SECRET));
  assert.ok(verifySettlementWebhook(b.payload, b.signature, SECRET));
});

test("two different escrows produce different eventIds", () => {
  const a = buildSettlementWebhook(keyedReleasedReport("esc-det-c1"), {
    secret: SECRET,
    now: FIXED_NOW,
  });
  const b = buildSettlementWebhook(keyedReleasedReport("esc-det-c2"), {
    secret: SECRET,
    now: FIXED_NOW,
  });
  assert.notEqual(a.payload.eventId, b.payload.eventId);
});

test("same escrowId with a different terminal seq/hash produces a different eventId", () => {
  const released = keyedReleasedReport("esc-det-same");
  const refunded = keyedRefundedReport("esc-det-same");
  assert.notEqual(released.terminalSeq, refunded.terminalSeq);
  assert.notEqual(released.terminalHash, refunded.terminalHash);
  const a = buildSettlementWebhook(released, { secret: SECRET, now: FIXED_NOW });
  const b = buildSettlementWebhook(refunded, { secret: SECRET, now: FIXED_NOW });
  assert.notEqual(a.payload.eventId, b.payload.eventId);
});

test("explicit eventId still overrides the deterministic default", () => {
  const report = keyedReleasedReport("esc-det-d");
  const { payload, signature } = buildSettlementWebhook(report, {
    secret: SECRET,
    now: FIXED_NOW,
    eventId: "evt-explicit-override",
  });
  assert.equal(payload.eventId, "evt-explicit-override");
  assert.ok(verifySettlementWebhook(payload, signature, SECRET));
});

test("SettlementEventDedupe drops the second build of the same settlement", () => {
  const report = keyedReleasedReport("esc-det-e");
  const first = buildSettlementWebhook(report, { secret: SECRET, now: FIXED_NOW });
  const second = buildSettlementWebhook(report, { secret: SECRET, now: LATER_NOW });
  assert.equal(first.payload.eventId, second.payload.eventId);
  const dedupe = new SettlementEventDedupe({ ttlMs: 60_000 });
  assert.equal(dedupe.checkAndRecord(first.payload.eventId), false);
  assert.equal(dedupe.checkAndRecord(second.payload.eventId), true);
});

test("batch still rejects a factory that repeats an eventId", () => {
  const results = [
    { escrowId: "esc-det-f1", report: keyedReleasedReport("esc-det-f1") },
    { escrowId: "esc-det-f2", report: keyedReleasedReport("esc-det-f2") },
  ];
  const batch = buildSettlementWebhooks(results, {
    secret: SECRET,
    now: FIXED_NOW,
    eventIdFactory: () => "evt-batch-dup",
  });
  assert.equal(batch[0].webhook?.payload.eventId, "evt-batch-dup");
  assert.match(batch[1].error ?? "", /duplicate eventId "evt-batch-dup" in batch/);
  assert.equal(batch[1].webhook, undefined);
});

test("report without an anchor keeps the UUID default and two builds differ", () => {
  // A hand-built report carries no anchor: strip both fields from a
  // built report (an unkeyed escrow's history IS hash-chained — plain
  // SHA-256 by default — so a report built from any real escrow gets an
  // anchor; only hand-built reports and legacy hashless histories fall
  // back to a fresh UUID).
  const anchored = keyedReleasedReport("esc-det-g");
  const { terminalSeq: _seq, terminalHash: _hash, ...report } = anchored;
  const a = buildSettlementWebhook(report, { secret: SECRET, now: FIXED_NOW });
  const b = buildSettlementWebhook(report, { secret: SECRET, now: FIXED_NOW });
  assert.match(a.payload.eventId, UUID_V4);
  assert.match(b.payload.eventId, UUID_V4);
  assert.notEqual(a.payload.eventId, b.payload.eventId);
});

test("half-anchor report fails closed before signing", () => {
  const report = keyedReleasedReport("esc-det-h");
  const { terminalHash: _dropped, ...half } = report;
  assert.throws(
    () => buildSettlementWebhook(half, { secret: SECRET, now: FIXED_NOW }),
    /'terminalSeq' and 'terminalHash' must appear together when present/,
  );
  const { terminalSeq: _droppedSeq, ...otherHalf } = report;
  assert.throws(
    () => buildSettlementWebhook(otherHalf, { secret: SECRET, now: FIXED_NOW }),
    /'terminalSeq' and 'terminalHash' must appear together when present/,
  );
});

test("buildSettlementReport stamps the anchor from the keyed chain tip", () => {
  // The report is built from the SAME escrow instance: dispatch stamps
  // wall-clock `at` into each entry, so two separately built escrows
  // with the same id hash differently and must never be compared.
  const e = keyedReleasedEscrow("esc-det-i");
  const report = buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500 },
    auditKey: KEY,
  });
  const tip = e.history[e.history.length - 1];
  assert.equal(report.terminalSeq, tip.seq);
  assert.equal(report.terminalHash, tip.hash);
  // The anchor survives the JSON round-trip, so a rehydrated report
  // rebuilds to the same eventId.
  const parsed = parseSettlementReportJson(renderReportJson(report));
  assert.equal(parsed.terminalSeq, report.terminalSeq);
  assert.equal(parsed.terminalHash, report.terminalHash);
  const rebuilt = buildSettlementWebhook(parsed, { secret: SECRET, now: FIXED_NOW });
  const direct = buildSettlementWebhook(report, { secret: SECRET, now: FIXED_NOW });
  assert.equal(rebuilt.payload.eventId, direct.payload.eventId);
});

test("unkeyed history stamps the anchor from the plain-SHA-256 chain tip", () => {
  // Chaining is the default for every escrow, keyed or not — only the
  // hash function differs (plain SHA-256 vs HMAC) — so an unkeyed
  // report anchors and derives its eventId exactly like a keyed one.
  // FUND=1, SUBMIT_MILESTONE=2, VERIFY_PASS=3, RELEASE=4.
  const report = unkeyedReleasedReport("esc-det-j");
  assert.equal(report.terminalSeq, 4);
  assert.equal(typeof report.terminalHash, "string");
  assert.equal(report.terminalHash!.length, 64);
  const a = buildSettlementWebhook(report, { secret: SECRET, now: FIXED_NOW });
  const b = buildSettlementWebhook(report, { secret: SECRET, now: FIXED_NOW });
  assert.equal(
    a.payload.eventId,
    `settlement-esc-det-j-4-${report.terminalHash!.slice(0, 12)}`,
  );
  assert.equal(a.payload.eventId, b.payload.eventId);
  assert.equal(a.signature, b.signature);
});

test("diffSettlementReports reports anchor moves", () => {
  const released = keyedReleasedReport("esc-det-k");
  const refunded = keyedRefundedReport("esc-det-k");
  const diff = diffSettlementReports(released, refunded);
  assert.deepEqual(diff.terminalSeqChanged, {
    from: released.terminalSeq,
    to: refunded.terminalSeq,
  });
  assert.deepEqual(diff.terminalHashChanged, {
    from: released.terminalHash,
    to: refunded.terminalHash,
  });
  assert.deepEqual(diffSettlementReports(released, released), {});
});
