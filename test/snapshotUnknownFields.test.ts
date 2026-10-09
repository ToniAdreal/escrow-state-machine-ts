import test from "node:test";
import assert from "node:assert/strict";
import { Escrow } from "../src/index.js";

/**
 * Snapshot unknown-field rejection (#132): parseEscrowSnapshot used to
 * silently drop any field outside the snapshot/entry shapes, so a typo
 * like `deadlline` (for `deadline`) parsed as "no deadline" — a
 * fail-open loss, since a watchdog then sees an escrow that can never
 * be overdue — and `amout` (for `amount`) parsed as a FUND entry
 * carrying no money. The parser now whitelists both levels and throws
 * `invalid snapshot: unknown field "<name>"` (top level) /
 * `invalid snapshot: history[i]: unknown field "<name>"` (entry level).
 */

/** Golden escrow carrying amount, evidence, and hash-chain fields. */
function goldenEscrow(): Escrow {
  const e = new Escrow("escrow-unknown-fields-1");
  e.dispatch("FUND", "sponsor deposit", 10630);
  e.dispatch("SUBMIT_MILESTONE", "creator delivers KPI bundle");
  e.dispatch("VERIFY_PASS", "oracle attestation ok", undefined, {
    evidence: "chainlink-req-123",
  });
  return e;
}

function serializedGolden(): {
  v?: unknown;
  id: string;
  state: string;
  history: Array<Record<string, unknown>>;
  [key: string]: unknown;
} {
  return JSON.parse(JSON.stringify(goldenEscrow().toJSON()));
}

test("typo: `deadlline` is rejected and the error names the field", () => {
  const e = goldenEscrow();
  e.setDeadline("2026-12-31T00:00:00.000Z");
  const s = JSON.parse(JSON.stringify(e.toJSON())) as Record<string, unknown>;
  // Rename the real field the way a hand-editing caller would mistype it.
  s.deadlline = s.deadline;
  delete s.deadline;
  assert.throws(
    () => Escrow.fromJSON(s),
    /invalid snapshot: unknown field "deadlline"/
  );
});

test("top level: an extra field alongside all valid fields is rejected", () => {
  const s = serializedGolden();
  s.owner = "dao-multisig";
  assert.throws(
    () => Escrow.fromJSON(s),
    /invalid snapshot: unknown field "owner"/
  );
});

test("top level: unknown field is rejected even on an empty-history snapshot", () => {
  assert.throws(
    () =>
      Escrow.fromJSON({
        id: "fresh",
        state: "CREATED",
        history: [],
        deadlline: "2026-12-31T00:00:00.000Z",
      }),
    /invalid snapshot: unknown field "deadlline"/
  );
});

test("entry level: typo `amout` on a FUND entry is rejected with its index", () => {
  const s = serializedGolden();
  s.history[0].amout = s.history[0].amount;
  delete s.history[0].amount;
  assert.throws(
    () => Escrow.fromJSON(s),
    /invalid snapshot: history\[0\]: unknown field "amout"/
  );
});

test("entry level: extra field on a later entry reports that entry's index", () => {
  const s = serializedGolden();
  s.history[2].memo = "not a real field";
  assert.throws(
    () => Escrow.fromJSON(s),
    /invalid snapshot: history\[2\]: unknown field "memo"/
  );
});

test("entry level: unknown field is reported, not silently dropped past the hash chain", () => {
  const s = serializedGolden();
  // The canonical hash serialization ignores unknown keys, so before
  // this fix the extra field survived parsing without breaking the
  // chain and was silently dropped. It must now be the reported error.
  s.history[1].note2 = "shadow note";
  assert.throws(
    () => Escrow.fromJSON(s),
    /invalid snapshot: history\[1\]: unknown field "note2"/
  );
});

test("error shape distinguishes top-level from entry-level unknowns", () => {
  const top = serializedGolden();
  top.memo = "x";
  assert.throws(() => Escrow.fromJSON(top), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /^invalid snapshot: unknown field "memo"$/);
    return true;
  });
  const entry = serializedGolden();
  entry.history[0].memo = "x";
  assert.throws(() => Escrow.fromJSON(entry), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(
      err.message,
      /^invalid snapshot: history\[0\]: unknown field "memo"$/
    );
    return true;
  });
});

test("regression: everything toJSON() produces passes the whitelist", () => {
  const e = goldenEscrow();
  e.setDeadline("2026-12-31T00:00:00.000Z");
  const restored = Escrow.fromJSON(JSON.parse(JSON.stringify(e.toJSON())));
  assert.equal(restored.state, e.state);
  assert.deepEqual(restored.history, e.history);
  assert.equal(restored.getDeadline(), "2026-12-31T00:00:00.000Z");
  // The wire shape itself carries only whitelisted keys, both levels.
  const snap = e.toJSON();
  assert.deepEqual(Object.keys(snap).sort(), [
    "deadline",
    "history",
    "id",
    "state",
    "v",
  ]);
  for (const entry of snap.history) {
    for (const key of Object.keys(entry)) {
      assert.ok(
        [
          "seq",
          "event",
          "from",
          "to",
          "at",
          "note",
          "amount",
          "evidence",
          "prevHash",
          "hash",
        ].includes(key),
        `entry key ${key} must be whitelisted`
      );
    }
  }
});

test("reserved/current `v: 1` passes (no false positive on the version field)", () => {
  const s = serializedGolden();
  assert.equal(s.v, 1);
  const restored = Escrow.fromJSON(s);
  assert.equal(restored.state, "VERIFIED");
});

test("legacy hashless snapshot using only whitelisted fields still passes", () => {
  const restored = Escrow.fromJSON({
    id: "legacy-unknown-fields",
    state: "FUNDED",
    history: [
      {
        seq: 1,
        event: "FUND",
        from: "CREATED",
        to: "FUNDED",
        at: "2026-03-01T00:00:00.000Z",
        amount: 500,
      },
    ],
  });
  assert.equal(restored.state, "FUNDED");
  assert.equal(restored.history[0].amount, 500);
});
