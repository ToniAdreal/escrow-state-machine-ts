/**
 * Keyed audit chain uses constant-time MAC comparison (#570): in keyed
 * mode `verifyHistoryChain` compares the recomputed HMAC with the stored
 * digest via `timingSafeEqual` (plus a length guard), so an online
 * verifier leaks no per-byte timing signal. Unkeyed chains keep plain
 * `===` (tamper evidence, not a MAC) and legacy hashless histories are
 * unaffected. Forged digest shapes must fail verification, never throw.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Escrow, verifyHistoryChain } from "../src/index.js";
import type { EscrowHistoryEntry } from "../src/index.js";

const KEY = "audit-secret-2026";
const WRONG_KEY = "audit-secret-1999";

/** Build a keyed escrow: CREATED -> FUNDED -> MILESTONE_SUBMITTED. */
function keyedEscrow(): Escrow {
  const e = new Escrow("escrow-timing-1", { auditKey: KEY });
  e.dispatch("FUND", "sponsor deposit", 10630);
  e.dispatch("SUBMIT_MILESTONE", "creator delivers KPI bundle");
  return e;
}

/** Deep-clone a history so tampering tests don't fight Object.freeze. */
function cloneHistory(
  history: readonly EscrowHistoryEntry[]
): EscrowHistoryEntry[] {
  return JSON.parse(JSON.stringify(history)) as EscrowHistoryEntry[];
}

test("keyed chain verifies with the correct key, string and Buffer forms", () => {
  const e = keyedEscrow();
  assert.equal(verifyHistoryChain(e.history, KEY), true);
  assert.equal(verifyHistoryChain(e.history, Buffer.from(KEY, "utf8")), true);
});

test("tampered keyed entry fails verification", () => {
  const tampered = cloneHistory(keyedEscrow().history);
  tampered[1].note = "rewritten after the fact";
  assert.equal(verifyHistoryChain(tampered, KEY), false);
});

test("forged digest of the wrong length fails without throwing", () => {
  const cases: Array<{ name: string; hash: string }> = [
    { name: "short hex", hash: "abcd" },
    { name: "long hex", hash: "ab".repeat(64) },
    { name: "odd-length hex", hash: "abc" },
    { name: "empty string", hash: "" },
  ];
  for (const { name, hash } of cases) {
    const forged = cloneHistory(keyedEscrow().history);
    forged[0].hash = hash;
    // The next entry's prevHash no longer matches either, but the forged
    // entry itself must fail on its own digest shape, not throw.
    assert.equal(
      verifyHistoryChain(forged, KEY),
      false,
      `${name} must fail, not throw`
    );
  }
});

test("forged non-hex digest fails without throwing", () => {
  const forged = cloneHistory(keyedEscrow().history);
  forged[0].hash = "zz".repeat(32);
  assert.equal(verifyHistoryChain(forged, KEY), false);
  const garbage = cloneHistory(keyedEscrow().history);
  garbage[1].hash = "not-a-digest-at-all";
  assert.equal(verifyHistoryChain(garbage, KEY), false);
});

test("deleted digest fails without throwing", () => {
  const stripped = cloneHistory(keyedEscrow().history);
  delete stripped[0].hash;
  assert.equal(verifyHistoryChain(stripped, KEY), false);
});

test("keyed chain fails closed without a key and with the wrong key", () => {
  const e = keyedEscrow();
  assert.equal(verifyHistoryChain(e.history), false);
  assert.equal(verifyHistoryChain(e.history, WRONG_KEY), false);
});

test("unkeyed chain is unchanged: verifies, and tampering still fails", () => {
  const e = new Escrow("escrow-timing-plain");
  e.dispatch("FUND", "sponsor deposit", 10630);
  e.dispatch("SUBMIT_MILESTONE", "creator delivers");
  assert.equal(verifyHistoryChain(e.history), true);
  assert.equal(verifyHistoryChain(e.history, KEY), false);
  const tampered = cloneHistory(e.history);
  tampered[0].amount = 10631;
  assert.equal(verifyHistoryChain(tampered), false);
});

test("legacy hashless history still verifies as vacuous", () => {
  const legacy: EscrowHistoryEntry[] = [
    {
      seq: 0,
      event: "FUND",
      from: "CREATED",
      to: "FUNDED",
      at: "2026-10-09T00:00:00.000Z",
    },
  ];
  assert.equal(verifyHistoryChain(legacy), true);
  assert.equal(verifyHistoryChain(legacy, KEY), true);
});

test("empty history still verifies as vacuous in both modes", () => {
  assert.equal(verifyHistoryChain([]), true);
  assert.equal(verifyHistoryChain([], KEY), true);
});
