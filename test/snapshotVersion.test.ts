import test from "node:test";
import assert from "node:assert/strict";
import { Escrow, SNAPSHOT_VERSION } from "../src/index.js";

/** Build a chained escrow: CREATED -> FUNDED -> MILESTONE_SUBMITTED -> VERIFIED. */
function goldenEscrow(): Escrow {
  const e = new Escrow("escrow-version-1");
  e.dispatch("FUND", "sponsor deposit", 10630);
  e.dispatch("SUBMIT_MILESTONE", "creator delivers KPI bundle");
  e.dispatch("VERIFY_PASS", "oracle attestation ok");
  return e;
}

function serializedGolden(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(goldenEscrow().toJSON())) as Record<
    string,
    unknown
  >;
}

test("toJSON: snapshot carries v: 1 as the first key (byte shape)", () => {
  const snapshot = goldenEscrow().toJSON();
  assert.equal(snapshot.v, 1);
  assert.equal(SNAPSHOT_VERSION, 1);
  assert.deepEqual(Object.keys(snapshot), ["v", "id", "state", "history"]);
  const bytes = JSON.stringify(snapshot);
  assert.ok(
    bytes.startsWith('{"v":1,"id":"escrow-version-1","state":"VERIFIED"'),
    `unexpected snapshot byte shape: ${bytes.slice(0, 80)}`
  );
});

test("toJSON: deadline snapshots keep v first and deadline last", () => {
  const e = goldenEscrow();
  e.setDeadline("2026-12-31T00:00:00.000Z");
  const snapshot = e.toJSON();
  assert.equal(snapshot.v, 1);
  assert.deepEqual(Object.keys(snapshot), [
    "v",
    "id",
    "state",
    "history",
    "deadline",
  ]);
});

test("round-trip: v: 1 snapshot restores and re-exports v: 1", () => {
  const escrow = goldenEscrow();
  const restored = Escrow.fromJSON(
    JSON.parse(JSON.stringify(escrow.toJSON()))
  );
  assert.equal(restored.state, escrow.state);
  assert.deepEqual(restored.history, escrow.history);
  assert.equal(restored.toJSON().v, 1);
  assert.deepEqual(restored.toJSON(), escrow.toJSON());
});

test("legacy: snapshot without v still restores (backward compatible)", () => {
  const legacy = serializedGolden();
  delete legacy.v;
  assert.ok(!("v" in legacy));
  const restored = Escrow.fromJSON(legacy);
  assert.equal(restored.state, "VERIFIED");
  assert.equal(restored.history.length, 3);
  // Re-export upgrades the legacy snapshot to the current version.
  assert.equal(restored.toJSON().v, 1);
});

test("legacy: empty-history snapshot without v restores a fresh escrow", () => {
  const restored = Escrow.fromJSON({ id: "fresh", state: "CREATED", history: [] });
  assert.equal(restored.state, "CREATED");
  assert.equal(restored.toJSON().v, 1);
});

test("rejects v: 2 (a future version this parser does not understand)", () => {
  const s = serializedGolden();
  s.v = 2;
  assert.throws(() => Escrow.fromJSON(s), /unsupported snapshot version/);
});

test('rejects v: "1" (string is not the number 1)', () => {
  const s = serializedGolden();
  s.v = "1";
  assert.throws(() => Escrow.fromJSON(s), /unsupported snapshot version/);
});

test("rejects v: 0", () => {
  const s = serializedGolden();
  s.v = 0;
  assert.throws(() => Escrow.fromJSON(s), /unsupported snapshot version/);
});

test("rejects v: null", () => {
  const s = serializedGolden();
  s.v = null;
  assert.throws(() => Escrow.fromJSON(s), /unsupported snapshot version/);
});

test("ordering: bad version is reported before a broken hash chain", () => {
  const s = serializedGolden() as {
    v: unknown;
    history: Array<Record<string, unknown>>;
  };
  // Tamper with an entry so the hash chain no longer verifies...
  s.history[0].note = "rewritten after the fact";
  // ...and stamp an unsupported version on top. The version gate runs
  // first, so the error must name the version, not the chain.
  s.v = 2;
  assert.throws(() => Escrow.fromJSON(s), /unsupported snapshot version/);
});

test("ordering: with v: 1 intact, the same tampering still reports the hash chain", () => {
  const s = serializedGolden() as {
    history: Array<Record<string, unknown>>;
  };
  s.history[0].note = "rewritten after the fact";
  assert.throws(() => Escrow.fromJSON(s), /hash chain is broken/);
});

test("JSON.stringify(escrow) carries the version field", () => {
  const parsed = JSON.parse(JSON.stringify(goldenEscrow())) as Record<
    string,
    unknown
  >;
  assert.equal(parsed.v, 1);
});
