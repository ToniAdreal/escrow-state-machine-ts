import test from "node:test";
import assert from "node:assert/strict";
import { Escrow } from "../src/index.js";
import type { EscrowSnapshot } from "../src/index.js";

/** Build a golden escrow: CREATED -> FUNDED -> MILESTONE_SUBMITTED -> VERIFIED. */
function goldenEscrow(): Escrow {
  const e = new Escrow("escrow-serialization-1");
  e.dispatch("FUND", "sponsor deposit", 10630);
  e.dispatch("SUBMIT_MILESTONE", "creator delivers KPI bundle");
  e.dispatch("VERIFY_PASS", "oracle attestation ok");
  return e;
}

test("toJSON: snapshot shape is plain JSON and survives a stringify round-trip", () => {
  const escrow = goldenEscrow();
  const snapshot = escrow.toJSON();
  assert.equal(snapshot.id, "escrow-serialization-1");
  assert.equal(snapshot.state, "VERIFIED");
  assert.equal(snapshot.history.length, 3);
  const revived = JSON.parse(JSON.stringify(snapshot)) as EscrowSnapshot;
  assert.deepEqual(revived, snapshot);
});

test("fromJSON: full round-trip restores state, history, and FUND amount", () => {
  const escrow = goldenEscrow();
  const restored = Escrow.fromJSON(JSON.parse(JSON.stringify(escrow.toJSON())));
  assert.equal(restored.id, escrow.id);
  assert.equal(restored.state, escrow.state);
  assert.deepEqual(restored.history, escrow.history);
  assert.equal(restored.history[0].amount, 10630);
  assert.equal(restored.isTerminal, false);
});

test("fromJSON: restored escrow keeps dispatching with no seq gaps", () => {
  const restored = Escrow.fromJSON(
    JSON.parse(JSON.stringify(goldenEscrow().toJSON()))
  );
  restored.dispatch("RELEASE", "pay out");
  assert.equal(restored.state, "RELEASED");
  const last = restored.history[restored.history.length - 1];
  assert.equal(last.seq, 4);
  assert.deepEqual([1, 2, 3, 4], restored.history.map((h) => h.seq));
});

test("fromJSON: empty-history snapshot restores a fresh CREATED escrow", () => {
  const restored = Escrow.fromJSON({
    id: "fresh",
    state: "CREATED",
    history: [],
  });
  assert.equal(restored.state, "CREATED");
  assert.equal(restored.history.length, 0);
  restored.dispatch("FUND", undefined, 500);
  assert.equal(restored.state, "FUNDED");
});

test("toJSON: returns a detached copy, later mutation cannot leak in", () => {
  const escrow = goldenEscrow();
  const snapshot = escrow.toJSON();
  snapshot.id = "tampered";
  snapshot.history[0].to = "RELEASED";
  snapshot.history.push({
    seq: 99,
    event: "EXPIRE",
    from: "VERIFIED",
    to: "EXPIRED",
    at: new Date().toISOString(),
  });
  assert.equal(escrow.id, "escrow-serialization-1");
  assert.equal(escrow.history.length, 3);
  assert.equal(escrow.history[0].to, "FUNDED");
});

test("JSON.stringify(escrow) goes through toJSON and restores cleanly", () => {
  const escrow = goldenEscrow();
  const restored = Escrow.fromJSON(JSON.parse(JSON.stringify(escrow)));
  assert.deepEqual(restored.history, escrow.history);
});

test("fromJSON: rejects a catalog of corrupted snapshots with clear errors", () => {
  const valid = JSON.parse(JSON.stringify(goldenEscrow().toJSON()));
  const cases: Array<[string, () => void, RegExp]> = [
    ["non-object", () => Escrow.fromJSON("nope"), /expected a JSON object/],
    [
      "missing id",
      () => Escrow.fromJSON({ ...valid, id: undefined }),
      /id must be a non-empty string/,
    ],
    [
      "unknown state",
      () => Escrow.fromJSON({ ...valid, state: "PAID" }),
      /unknown state/,
    ],
    [
      "history not an array",
      () => Escrow.fromJSON({ ...valid, history: null }),
      /history must be an array/,
    ],
    [
      "seq gap",
      () => {
        const s = structuredClone(valid);
        s.history[1].seq = 5;
        Escrow.fromJSON(s);
      },
      /seq must be 2/,
    ],
    [
      "chain break (from != previous to)",
      () => {
        const s = structuredClone(valid);
        s.history[1].from = "VERIFIED";
        Escrow.fromJSON(s);
      },
      /does not continue previous to/,
    ],
    [
      "chain not starting at CREATED",
      () => {
        const s = structuredClone(valid);
        s.history[0].from = "FUNDED";
        Escrow.fromJSON(s);
      },
      /chain must start at CREATED/,
    ],
    [
      "illegal edge (wrong event for edge)",
      () => {
        const s = structuredClone(valid);
        s.history[2].event = "FUND";
        Escrow.fromJSON(s);
      },
      /cannot lead to/,
    ],
    [
      "non-canonical timestamp",
      () => {
        const s = structuredClone(valid);
        s.history[1].at = "2026-10-05 18:00:00";
        Escrow.fromJSON(s);
      },
      /canonical ISO-8601/,
    ],
    [
      "timestamps decreasing",
      () => {
        const s = structuredClone(valid);
        s.history[0].at = "2026-10-06T00:00:00.000Z";
        s.history[1].at = "2026-10-05T00:00:00.000Z";
        Escrow.fromJSON(s);
      },
      /non-decreasing/,
    ],
    [
      "state != history end",
      () => Escrow.fromJSON({ ...valid, state: "RELEASED" }),
      /history ends at VERIFIED but state is RELEASED/,
    ],
    [
      "empty history with non-CREATED state",
      () => Escrow.fromJSON({ id: "x", state: "FUNDED", history: [] }),
      /empty history but state is FUNDED/,
    ],
    [
      "amount on non-FUND entry",
      () => {
        const s = structuredClone(valid);
        s.history[1].amount = 5;
        Escrow.fromJSON(s);
      },
      /amount only allowed on FUND entries/,
    ],
    [
      "negative amount on FUND",
      () => {
        const s = structuredClone(valid);
        s.history[0].amount = -1;
        Escrow.fromJSON(s);
      },
      /amount must be a finite non-negative number/,
    ],
    [
      "NaN amount on FUND",
      () => {
        const s = structuredClone(valid);
        s.history[0].amount = NaN;
        Escrow.fromJSON(s);
      },
      /amount must be a finite non-negative number/,
    ],
    [
      "non-string note",
      () => {
        const s = structuredClone(valid);
        s.history[0].note = 42;
        Escrow.fromJSON(s);
      },
      /note must be a string/,
    ],
    [
      "unknown event",
      () => {
        const s = structuredClone(valid);
        s.history[1].event = "PAY_OUT";
        Escrow.fromJSON(s);
      },
      /unknown event/,
    ],
  ];
  for (const [name, fn, pattern] of cases) {
    assert.throws(fn, pattern, `corrupted case should throw: ${name}`);
  }
  assert.equal(cases.length, 17);
});

test("fromJSON: valid snapshot survives the strict parser byte-for-byte", () => {
  const escrow = goldenEscrow();
  const parsed = Escrow.fromJSON(JSON.parse(JSON.stringify(escrow.toJSON())));
  assert.deepEqual(parsed.toJSON(), escrow.toJSON());
});
