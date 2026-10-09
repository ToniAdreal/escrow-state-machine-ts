/**
 * Keyed (HMAC) audit hash chain (#135): `EscrowOptions.auditKey`
 * upgrades the audit chain from plain SHA-256 to HMAC-SHA256, so a
 * full-log rewrite with recomputed hashes is detected without the key.
 * The mode is opt-in and fail-closed in both directions: a keyed chain
 * never verifies without/with the wrong key, and an unkeyed chain
 * never verifies when a key is supplied. The key itself is per-instance
 * configuration — it is never written into snapshots.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Escrow, verifyHistoryChain } from "../src/index.js";
import type { EscrowHistoryEntry, EscrowSnapshot } from "../src/index.js";

const KEY = "audit-secret-2026";
const WRONG_KEY = "audit-secret-1999";

/** Build a keyed escrow: CREATED -> FUNDED -> MILESTONE_SUBMITTED -> VERIFIED. */
function keyedEscrow(key: string | Buffer = KEY): Escrow {
  const e = new Escrow("escrow-keyed-1", { auditKey: key });
  e.dispatch("FUND", "sponsor deposit", 10630);
  e.dispatch("SUBMIT_MILESTONE", "creator delivers KPI bundle");
  e.dispatch("VERIFY_PASS", "oracle attestation ok", undefined, {
    evidence: "chainlink-req-0xabc",
  });
  return e;
}

/** Deep-clone a value so tampering tests don't fight Object.freeze. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test("keyed chain verifies with the correct key", () => {
  const e = keyedEscrow();
  assert.equal(verifyHistoryChain(e.history, KEY), true);
  // Entries still carry well-formed links and 64-char hex hashes.
  for (const entry of e.history) {
    assert.match(entry.hash ?? "", /^[0-9a-f]{64}$/);
    assert.equal(typeof entry.prevHash, "string");
  }
  for (let i = 1; i < e.history.length; i++) {
    assert.equal(e.history[i].prevHash, e.history[i - 1].hash);
  }
});

test("keyed chain fails closed without a key and with the wrong key", () => {
  const e = keyedEscrow();
  assert.equal(verifyHistoryChain(e.history), false);
  assert.equal(verifyHistoryChain(e.history, WRONG_KEY), false);
});

test("unkeyed default is unchanged and fails closed when a key is supplied", () => {
  const e = new Escrow("escrow-unkeyed-1");
  e.dispatch("FUND", "sponsor deposit", 10630);
  assert.equal(verifyHistoryChain(e.history), true);
  assert.equal(verifyHistoryChain(e.history, KEY), false);
});

test("keyed and unkeyed chains over identical content produce different hashes", () => {
  const plain = new Escrow("escrow-same-1");
  const keyed = new Escrow("escrow-same-1", { auditKey: KEY });
  // Pin identical timestamps so the entries differ ONLY by chain mode.
  const at = "2026-10-09T00:00:00.000Z";
  plain.dispatch("FUND", "deposit", 500, { at });
  keyed.dispatch("FUND", "deposit", 500, { at });
  assert.notEqual(keyed.history[0].hash, plain.history[0].hash);
  assert.equal(keyed.history[0].prevHash, plain.history[0].prevHash);
});

test("string and Buffer forms of the same key produce identical chains", () => {
  // Pin identical timestamps so the entries differ ONLY by key form.
  const build = (key: string | Buffer): Escrow => {
    const e = new Escrow("escrow-keyed-form", { auditKey: key });
    e.dispatch("FUND", "deposit", 500, { at: "2026-10-09T00:00:00.000Z" });
    e.dispatch("SUBMIT_MILESTONE", "delivers", undefined, {
      at: "2026-10-09T01:00:00.000Z",
    });
    return e;
  };
  const fromString = build(KEY);
  const fromBuffer = build(Buffer.from(KEY, "utf8"));
  assert.deepEqual(
    fromBuffer.history.map((e) => e.hash),
    fromString.history.map((e) => e.hash)
  );
  assert.equal(verifyHistoryChain(fromBuffer.history, KEY), true);
});

test("tampering with a keyed entry breaks verification even for the key holder", () => {
  const e = keyedEscrow();
  const tampered = clone(e.history) as EscrowHistoryEntry[];
  tampered[0].amount = 99999; // rewrite the FUND amount on disk
  assert.equal(verifyHistoryChain(tampered, KEY), false);
});

test("keyed snapshot round-trips through fromJSON with the key", () => {
  const e = keyedEscrow();
  const snapshot = clone(e.toJSON());
  const restored = Escrow.fromJSON(snapshot, { auditKey: KEY });
  assert.equal(restored.state, e.state);
  assert.deepEqual(
    restored.history.map((h) => h.hash),
    e.history.map((h) => h.hash)
  );
  assert.equal(verifyHistoryChain(restored.history, KEY), true);
});

test("keyed snapshot is rejected without the key or with the wrong key", () => {
  const snapshot = clone(keyedEscrow().toJSON());
  assert.throws(() => Escrow.fromJSON(snapshot), /hash chain is broken/);
  assert.throws(
    () => Escrow.fromJSON(snapshot, { auditKey: WRONG_KEY }),
    /hash chain is broken/
  );
});

test("unkeyed chained snapshot is rejected when restored with a key", () => {
  const e = new Escrow("escrow-unkeyed-2");
  e.dispatch("FUND", "sponsor deposit", 10630);
  const snapshot = clone(e.toJSON());
  assert.throws(
    () => Escrow.fromJSON(snapshot, { auditKey: KEY }),
    /hash chain is broken/
  );
  // …and still restores fine without one.
  assert.equal(Escrow.fromJSON(snapshot).state, "FUNDED");
});

test("legacy hashless snapshot restored with a key is chained in keyed mode", () => {
  const e = new Escrow("escrow-legacy-1");
  e.dispatch("FUND", "sponsor deposit", 10630);
  const snapshot = clone(e.toJSON());
  for (const entry of snapshot.history) {
    delete entry.hash;
    delete entry.prevHash;
  }
  const restored = Escrow.fromJSON(snapshot, { auditKey: KEY });
  assert.equal(verifyHistoryChain(restored.history, KEY), true);
  assert.equal(verifyHistoryChain(restored.history), false);
  // Further dispatches keep the keyed chain going.
  restored.dispatch("SUBMIT_MILESTONE", "creator delivers");
  assert.equal(verifyHistoryChain(restored.history, KEY), true);
});

test("restored keyed escrow keeps dispatching on the same keyed chain", () => {
  const restored = Escrow.fromJSON(clone(keyedEscrow().toJSON()), {
    auditKey: KEY,
  });
  restored.dispatch("RELEASE");
  assert.equal(restored.state, "RELEASED");
  assert.equal(verifyHistoryChain(restored.history, KEY), true);
  assert.equal(verifyHistoryChain(restored.history), false);
});

test("constructor rejects empty or non-string/Buffer audit keys", () => {
  assert.throws(() => new Escrow("x", { auditKey: "" }), /auditKey/);
  assert.throws(() => new Escrow("x", { auditKey: Buffer.alloc(0) }), /auditKey/);
  assert.throws(
    () => new Escrow("x", { auditKey: 42 as unknown as string }),
    /auditKey/
  );
  // verifyHistoryChain applies the same fail-fast rule to a bad key.
  assert.throws(() => verifyHistoryChain([], ""), /auditKey/);
});

test("the audit key never appears in the serialized snapshot", () => {
  const snapshot = keyedEscrow().toJSON() as EscrowSnapshot;
  assert.equal(JSON.stringify(snapshot).includes(KEY), false);
  assert.deepEqual(Object.keys(snapshot).sort(), [
    "history",
    "id",
    "state",
    "v",
  ]);
});

test("mutating the caller's Buffer after construction does not change the key", () => {
  const callerBuffer = Buffer.from(KEY, "utf8");
  const e = new Escrow("escrow-keyed-buffer", { auditKey: callerBuffer });
  callerBuffer.fill(0); // caller scribbles over their copy
  e.dispatch("FUND", "sponsor deposit", 100);
  assert.equal(verifyHistoryChain(e.history, KEY), true);
});
