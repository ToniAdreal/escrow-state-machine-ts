import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementWebhook,
  calculateDeposit,
  verifySettlementWebhook,
} from "../src/index.js";
import type { SettlementWebhookPayload } from "../src/index.js";

const SECRET = "whsec_test_settlement_notifications_20261006";
const FIXED_NOW = "2026-10-06T11:30:00.000Z";

function goldenDeposit() {
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

function releaseEscrow(id = "esc-10630") {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return e;
}

function releasedWebhook(id = "esc-10630") {
  const escrow = releaseEscrow(id);
  const report = buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500 },
  });
  return { report, signed: buildSettlementWebhook(report, { secret: SECRET, now: FIXED_NOW }) };
}

test("payload mirrors the report: event, id, outcome, deposit, parties, at", () => {
  const { signed } = releasedWebhook();
  assert.equal(signed.payload.event, "escrow.settled");
  assert.equal(signed.payload.escrowId, "esc-10630");
  assert.equal(signed.payload.outcome, "released");
  assert.equal(signed.payload.deposit, 10630);
  assert.equal(signed.payload.at, FIXED_NOW);
  assert.deepEqual(
    signed.payload.parties.map((p) => p.party),
    ["sponsor", "creator", "platform", "referrer"],
  );
  const byParty = Object.fromEntries(signed.payload.parties.map((p) => [p.party, p]));
  // Independent hand-check: released with 5% pro fee → sponsor out 10630,
  // creator nets 10098.50, platform takes 531.50.
  assert.deepEqual(
    { inflow: byParty.sponsor.inflow, outflow: byParty.sponsor.outflow, net: byParty.sponsor.net },
    { inflow: 0, outflow: 10630, net: -10630 },
  );
  assert.equal(byParty.creator.net, 10098.5);
  assert.equal(byParty.platform.net, 531.5);
  // No bookkeeping fields leak into the payload.
  assert.deepEqual(Object.keys(signed.payload).sort(), [
    "at",
    "deposit",
    "escrowId",
    "event",
    "outcome",
    "parties",
  ]);
});

test("signature is sha256=<64 hex> and verifies with the correct secret (object form)", () => {
  const { signed } = releasedWebhook();
  assert.match(signed.signature, /^sha256=[0-9a-f]{64}$/);
  assert.ok(verifySettlementWebhook(signed.payload, signed.signature, SECRET));
});

test("raw body string verifies (transport-safe path)", () => {
  const { signed } = releasedWebhook();
  const raw = JSON.stringify(signed.payload);
  assert.ok(verifySettlementWebhook(raw, signed.signature, SECRET));
});

test("tampered payload fails verification", () => {
  const { signed } = releasedWebhook();
  const tampered: SettlementWebhookPayload = {
    ...signed.payload,
    parties: signed.payload.parties.map((p) =>
      p.party === "creator" ? { ...p, net: p.net + 1 } : p,
    ),
  };
  assert.equal(verifySettlementWebhook(tampered, signed.signature, SECRET), false);
  // Tampering with the top-level fields fails too, via the raw-body path.
  const raw = JSON.stringify({ ...signed.payload, deposit: 99999 });
  assert.equal(verifySettlementWebhook(raw, signed.signature, SECRET), false);
});

test("wrong secret fails verification", () => {
  const { signed } = releasedWebhook();
  assert.equal(verifySettlementWebhook(signed.payload, signed.signature, "wrong-secret"), false);
});

test("malformed signatures return false instead of throwing", () => {
  const { signed } = releasedWebhook();
  for (const bad of [
    "",
    "nope",
    "sha256=",
    "sha256=xyz",
    "md5=" + "a".repeat(32),
    "sha256=" + "a".repeat(63), // one nibble short
    "sha256=" + "a".repeat(65), // one nibble long
    "SHA256=" + "a".repeat(64), // wrong prefix case
  ]) {
    assert.equal(
      verifySettlementWebhook(signed.payload, bad, SECRET),
      false,
      `should reject: ${JSON.stringify(bad)}`,
    );
  }
});

test("Buffer secret works on both sides", () => {
  const { report } = releasedWebhook("esc-buf-secret");
  const secretBuf = Buffer.from(SECRET, "utf8");
  const signed = buildSettlementWebhook(report, { secret: secretBuf, now: FIXED_NOW });
  assert.ok(verifySettlementWebhook(JSON.stringify(signed.payload), signed.signature, secretBuf));
  // Same HMAC input → the Buffer and string forms must agree byte-for-byte.
  const asString = buildSettlementWebhook(report, { secret: SECRET, now: FIXED_NOW });
  assert.equal(signed.signature, asString.signature);
});

test("empty secret is rejected at build time (fail fast, not a weak signature)", () => {
  const { report } = releasedWebhook("esc-empty-secret");
  assert.throws(
    () => buildSettlementWebhook(report, { secret: "" }),
    /signing secret must not be empty/,
  );
  assert.throws(
    () => buildSettlementWebhook(report, { secret: Buffer.alloc(0) }),
    /signing secret must not be empty/,
  );
});

test("invalid 'now' timestamp throws a clear error", () => {
  const { report } = releasedWebhook("esc-bad-now");
  assert.throws(
    () => buildSettlementWebhook(report, { secret: SECRET, now: "not-a-date" }),
    /invalid 'now' timestamp/,
  );
});

test("same inputs produce byte-identical signatures (deterministic for tests)", () => {
  const { report } = releasedWebhook("esc-deterministic");
  const a = buildSettlementWebhook(report, { secret: SECRET, now: FIXED_NOW });
  const b = buildSettlementWebhook(report, { secret: SECRET, now: FIXED_NOW });
  assert.equal(a.signature, b.signature);
  assert.deepEqual(a.payload, b.payload);
});

test("refunded escrow produces a refunded webhook that verifies", () => {
  const e = new Escrow("esc-refund");
  e.dispatch("FUND");
  e.dispatch("DISPUTE");
  e.dispatch("ARBITRATE_REFUND");
  const report = buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: goldenDeposit(),
  });
  const signed = buildSettlementWebhook(report, { secret: SECRET, now: FIXED_NOW });
  assert.equal(signed.payload.outcome, "refunded");
  const byParty = Object.fromEntries(signed.payload.parties.map((p) => [p.party, p]));
  assert.deepEqual(
    { inflow: byParty.sponsor.inflow, outflow: byParty.sponsor.outflow, net: byParty.sponsor.net },
    { inflow: 10630, outflow: 10630, net: 0 },
  );
  assert.ok(verifySettlementWebhook(signed.payload, signed.signature, SECRET));
});

test("payload is a snapshot: later report mutation cannot change a signed body", () => {
  const { report, signed } = releasedWebhook("esc-snapshot");
  const rawBefore = JSON.stringify(signed.payload);
  // The payload was copied field-by-field at build time; nothing here shares
  // references with the report.
  assert.notEqual(rawBefore, JSON.stringify({ ...signed.payload, escrowId: "other" }));
  assert.ok(verifySettlementWebhook(rawBefore, signed.signature, SECRET));
  assert.equal(report.escrowId, "esc-snapshot");
});
