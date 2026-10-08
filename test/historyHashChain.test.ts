import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  GENESIS_PREV_HASH,
  verifyHistoryChain,
} from "../src/index.js";
import type { EscrowHistoryEntry, EscrowSnapshot } from "../src/index.js";

/** Build a chained escrow: CREATED -> FUNDED -> MILESTONE_SUBMITTED -> VERIFIED. */
function chainedEscrow(): Escrow {
  const e = new Escrow("escrow-hashchain-1");
  e.dispatch("FUND", "sponsor deposit", 10630);
  e.dispatch("SUBMIT_MILESTONE", "creator delivers KPI bundle");
  e.dispatch("VERIFY_PASS", "oracle attestation ok", undefined, {
    evidence: "chainlink-req-0xabc",
  });
  return e;
}

/** Deep-clone a history so tampering tests don't fight Object.freeze. */
function cloneHistory(
  history: readonly EscrowHistoryEntry[]
): EscrowHistoryEntry[] {
  return JSON.parse(JSON.stringify(history)) as EscrowHistoryEntry[];
}

test("genesis entry links to the GENESIS_PREV_HASH constant", () => {
  assert.equal(GENESIS_PREV_HASH, "GENESIS");
  const e = chainedEscrow();
  assert.equal(e.history[0].prevHash, GENESIS_PREV_HASH);
  assert.equal(e.history[0].seq, 1);
});

test("every dispatched entry carries a 64-char hex sha256 hash", () => {
  const e = chainedEscrow();
  for (const entry of e.history) {
    assert.match(entry.hash ?? "", /^[0-9a-f]{64}$/);
    assert.equal(typeof entry.prevHash, "string");
  }
  // Each entry's prevHash links to the previous entry's hash.
  for (let i = 1; i < e.history.length; i++) {
    assert.equal(e.history[i].prevHash, e.history[i - 1].hash);
  }
});

test("verifyHistoryChain passes on a normally dispatched history", () => {
  const e = chainedEscrow();
  assert.equal(verifyHistoryChain(e.history), true);
});

test("verifyHistoryChain fails when a middle entry's amount is tampered with", () => {
  const e = chainedEscrow();
  const tampered = cloneHistory(e.history);
  tampered[0].amount = 99999; // rewrite the FUND amount on disk
  assert.equal(verifyHistoryChain(tampered), false);
});

test("verifyHistoryChain fails when a middle entry's note is tampered with", () => {
  const e = chainedEscrow();
  const tampered = cloneHistory(e.history);
  tampered[1].note = "rewritten by an attacker";
  assert.equal(verifyHistoryChain(tampered), false);
});

test("verifyHistoryChain fails when a middle entry's evidence is tampered with", () => {
  const e = chainedEscrow();
  const tampered = cloneHistory(e.history);
  tampered[2].evidence = "fake-evidence";
  assert.equal(verifyHistoryChain(tampered), false);
});

test("verifyHistoryChain fails when a middle entry is deleted and seqs renumbered", () => {
  const e = chainedEscrow();
  const tampered = cloneHistory(e.history);
  tampered.splice(1, 1); // drop SUBMIT_MILESTONE
  tampered.forEach((entry, i) => {
    entry.seq = i + 1;
  });
  assert.equal(verifyHistoryChain(tampered), false);
});

test("verifyHistoryChain fails when a stored hash is forged", () => {
  const e = chainedEscrow();
  const tampered = cloneHistory(e.history);
  tampered[1].hash =
    "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  assert.equal(verifyHistoryChain(tampered), false);
});

test("verifyHistoryChain: empty history is vacuously true", () => {
  assert.equal(verifyHistoryChain([]), true);
});

test("verifyHistoryChain: fully hashless legacy history passes through as true", () => {
  const e = chainedEscrow();
  const legacy = cloneHistory(e.history);
  for (const entry of legacy) {
    delete entry.hash;
    delete entry.prevHash;
  }
  assert.equal(verifyHistoryChain(legacy), true);
});

test("verifyHistoryChain: mixed chained/hashless history fails closed", () => {
  const e = chainedEscrow();
  const mixed = cloneHistory(e.history);
  delete mixed[1].hash;
  delete mixed[1].prevHash;
  assert.equal(verifyHistoryChain(mixed), false);
});

test("fromJSON accepts a legacy hashless snapshot and chains it on rehydration", () => {
  const e = chainedEscrow();
  const snapshot = JSON.parse(JSON.stringify(e.toJSON())) as EscrowSnapshot;
  for (const entry of snapshot.history) {
    delete entry.hash;
    delete entry.prevHash;
  }
  const restored = Escrow.fromJSON(snapshot);
  assert.equal(restored.state, e.state);
  // The restored escrow's history is now chained — audit content unchanged.
  assert.equal(verifyHistoryChain(restored.history), true);
  assert.equal(restored.history[0].prevHash, GENESIS_PREV_HASH);
  assert.equal(restored.history[0].amount, 10630);
  assert.equal(restored.history[2].evidence, "chainlink-req-0xabc");
  // And it round-trips cleanly from here on.
  const again = Escrow.fromJSON(
    JSON.parse(JSON.stringify(restored.toJSON()))
  );
  assert.deepEqual(again.history, restored.history);
});

test("fromJSON rejects a snapshot that mixes chained and hashless entries", () => {
  const e = chainedEscrow();
  const snapshot = JSON.parse(JSON.stringify(e.toJSON())) as EscrowSnapshot;
  delete snapshot.history[1].hash;
  delete snapshot.history[1].prevHash;
  assert.throws(() => Escrow.fromJSON(snapshot), /must not be mixed/);
});

test("fromJSON rejects a chained snapshot whose amount was tampered with", () => {
  const e = chainedEscrow();
  const snapshot = JSON.parse(JSON.stringify(e.toJSON())) as EscrowSnapshot;
  snapshot.history[0].amount = 1; // structurally valid, chain-invalid
  assert.throws(() => Escrow.fromJSON(snapshot), /hash chain is broken/);
});

test("fromJSON rejects a chained snapshot with a middle entry deleted", () => {
  const e = chainedEscrow();
  const snapshot = JSON.parse(JSON.stringify(e.toJSON())) as EscrowSnapshot;
  snapshot.history.splice(1, 1);
  snapshot.history.forEach((entry, i) => {
    entry.seq = i + 1;
  });
  // The from/to chain still breaks first (structure is checked before the
  // hash chain), so this surfaces as a structural error — still rejected.
  assert.throws(() => Escrow.fromJSON(snapshot), /invalid snapshot/);
});

test("fromJSON rejects an entry carrying hash without prevHash", () => {
  const e = chainedEscrow();
  const snapshot = JSON.parse(JSON.stringify(e.toJSON())) as EscrowSnapshot;
  delete snapshot.history[0].prevHash;
  assert.throws(() => Escrow.fromJSON(snapshot), /prevHash must be a non-empty string/);
});

test("fromJSON rejects non-string hash fields", () => {
  const e = chainedEscrow();
  const snapshot = JSON.parse(JSON.stringify(e.toJSON())) as EscrowSnapshot;
  (snapshot.history[0] as unknown as Record<string, unknown>).hash = 42;
  assert.throws(() => Escrow.fromJSON(snapshot), /hash must be a non-empty string/);
});

test("toJSON -> fromJSON preserves the chain byte-for-byte", () => {
  const e = chainedEscrow();
  const restored = Escrow.fromJSON(JSON.parse(JSON.stringify(e.toJSON())));
  assert.deepEqual(restored.history, e.history);
  assert.equal(verifyHistoryChain(restored.history), true);
});

test("EscrowSnapshot type export carries the chained history shape", () => {
  // Compile-time: the exported EscrowSnapshot type includes the optional
  // hash-chain fields on its entries.
  const e = chainedEscrow();
  const snapshot: EscrowSnapshot = e.toJSON();
  const first: EscrowHistoryEntry = snapshot.history[0];
  assert.equal(first.prevHash, GENESIS_PREV_HASH);
  assert.match(first.hash ?? "", /^[0-9a-f]{64}$/);
});

test("dispatch on a chained snapshot continues the chain", () => {
  const e = chainedEscrow();
  const restored = Escrow.fromJSON(JSON.parse(JSON.stringify(e.toJSON())));
  restored.dispatch("RELEASE", "pay out");
  const history = restored.history;
  assert.equal(history.length, 4);
  assert.equal(history[3].prevHash, history[2].hash);
  assert.equal(verifyHistoryChain(history), true);
});

test("dispatch on a legacy-restored escrow continues from the rehydrated chain", () => {
  const e = chainedEscrow();
  const snapshot = JSON.parse(JSON.stringify(e.toJSON())) as EscrowSnapshot;
  for (const entry of snapshot.history) {
    delete entry.hash;
    delete entry.prevHash;
  }
  const restored = Escrow.fromJSON(snapshot);
  restored.dispatch("RELEASE", "pay out");
  const history = restored.history;
  assert.equal(history.length, 4);
  assert.equal(history[3].prevHash, history[2].hash);
  assert.equal(verifyHistoryChain(history), true);
  // The rehydrated escrow round-trips cleanly (no mixed history escapes).
  const again = Escrow.fromJSON(
    JSON.parse(JSON.stringify(restored.toJSON()))
  );
  assert.deepEqual(again.history, restored.history);
});

test("hash commits to the full entry: same content re-chains identically", () => {
  const e = chainedEscrow();
  const restored = Escrow.fromJSON(JSON.parse(JSON.stringify(e.toJSON())));
  // Rehydration recomputes nothing for chained input — hashes are stable.
  assert.equal(restored.history[1].hash, e.history[1].hash);
  assert.equal(restored.history[2].prevHash, e.history[2].prevHash);
});
