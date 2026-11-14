import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  MAX_SETTLEMENT_REF_LENGTH,
  historyFromNdjson,
  historyToNdjson,
  parseEscrowHistory,
  verifyHistoryChain,
  type EscrowHistoryEntry,
} from "../src/index.js";

/**
 * Backlog #1123: an ARBITRATE_REFUND entry carries an optional
 * `refundRef` — the mirror of `settlementRef` on RELEASE (#1072):
 * the pointer from the audit trail to the real-world refund (bank
 * refund reference, gateway refund id). Same rule, same shared cap
 * (`MAX_SETTLEMENT_REF_LENGTH` = 256, non-empty string), recorded
 * verbatim on the entry and covered by the hash chain.
 */

function refundEscrow(id: string, refundRef?: string): Escrow {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("DISPUTE");
  e.dispatch(
    "ARBITRATE_REFUND",
    undefined,
    undefined,
    refundRef !== undefined ? { refundRef } : undefined,
  );
  return e;
}

test("ARBITRATE_REFUND records the refundRef verbatim on the entry", () => {
  const e = refundEscrow("esc-refund", "rfnd-2026-0315");
  assert.equal(e.state, "REFUNDED");
  const last = e.history[e.history.length - 1];
  assert.equal(last.event, "ARBITRATE_REFUND");
  assert.equal(last.refundRef, "rfnd-2026-0315");
  // The ref is covered by the hash chain: the trail still verifies.
  assert.equal(verifyHistoryChain(e.history), true);
});

test("ARBITRATE_REFUND without a ref stays legal and carries no key", () => {
  const e = refundEscrow("esc-noref");
  const last = e.history[e.history.length - 1];
  assert.equal("refundRef" in last, false);
  assert.equal(last.refundRef, undefined);
});

test("refundRef on any other event throws and leaves no trace", () => {
  for (const event of ["RELEASE", "FUND", "DISPUTE", "EXPIRE"] as const) {
    const e = new Escrow(`esc-${event.toLowerCase()}`);
    // Drive the escrow to a state where the event is legal, so the
    // rejection is about the ref, not the transition.
    if (event === "RELEASE") {
      e.dispatch("FUND");
      e.dispatch("SUBMIT_MILESTONE");
      e.dispatch("VERIFY_PASS");
    } else if (event === "DISPUTE" || event === "EXPIRE") {
      e.dispatch("FUND");
    }
    const historyBefore = e.history.length;
    const stateBefore = e.state;
    assert.throws(
      () =>
        e.dispatch(event, undefined, undefined, {
          refundRef: "rfnd-001",
        }),
      (err: unknown) =>
        err instanceof Error &&
        err.message ===
          `refundRef is only accepted on ARBITRATE_REFUND, not on ${event}`,
    );
    assert.equal(e.history.length, historyBefore);
    assert.equal(e.state, stateBefore);
  }
});

test("empty, non-string, and overlong refundRef throw at dispatch", () => {
  for (const bad of ["", "r".repeat(MAX_SETTLEMENT_REF_LENGTH + 1)]) {
    // A fresh disputed escrow per bad value: the failed dispatch must
    // leave it DISPUTED with its history untouched.
    const fresh = new Escrow("esc-bad2");
    fresh.dispatch("FUND");
    fresh.dispatch("DISPUTE");
    assert.throws(
      () =>
        fresh.dispatch("ARBITRATE_REFUND", undefined, undefined, {
          refundRef: bad,
        }),
      (err: unknown) =>
        err instanceof Error &&
        /invalid dispatch: refundRef must be/.test(err.message),
    );
    assert.equal(fresh.state, "DISPUTED");
    assert.equal(fresh.history.length, 2);
  }
  const fresh = new Escrow("esc-bad3");
  fresh.dispatch("FUND");
  fresh.dispatch("DISPUTE");
  assert.throws(
    () =>
      fresh.dispatch("ARBITRATE_REFUND", undefined, undefined, {
        refundRef: 123 as unknown as string,
      }),
    /invalid dispatch: refundRef must be a non-empty string/,
  );
});

test("a 256-character refundRef passes dispatch (cap is inclusive)", () => {
  const ref = "r".repeat(MAX_SETTLEMENT_REF_LENGTH);
  const e = refundEscrow("esc-cap", ref);
  assert.equal(e.history[e.history.length - 1].refundRef, ref);
});

test("a rejected refundRef does not consume an idempotency key", () => {
  const e = new Escrow("esc-key");
  e.dispatch("FUND");
  e.dispatch("DISPUTE");
  assert.throws(
    () =>
      e.dispatch("ARBITRATE_REFUND", undefined, undefined, {
        refundRef: "",
        idempotencyKey: "key-1",
      }),
    /invalid dispatch: refundRef must be a non-empty string/,
  );
  // Same key with a legal ref still executes: the failed dispatch
  // consumed nothing.
  e.dispatch("ARBITRATE_REFUND", undefined, undefined, {
    refundRef: "rfnd-001",
    idempotencyKey: "key-1",
  });
  assert.equal(e.state, "REFUNDED");
  assert.equal(e.history[e.history.length - 1].refundRef, "rfnd-001");
});

test("fromJSON / fromHistory / NDJSON round-trips carry the refundRef", () => {
  const e = refundEscrow("esc-roundtrip", "rfnd-2026-0315");
  const snapshot = e.toJSON();
  const restored = Escrow.fromJSON(snapshot);
  assert.equal(
    restored.history[restored.history.length - 1].refundRef,
    "rfnd-2026-0315",
  );
  assert.equal(JSON.stringify(restored.toJSON()), JSON.stringify(snapshot));

  const parsed = parseEscrowHistory(e.history);
  assert.equal(
    parsed[parsed.length - 1].refundRef,
    "rfnd-2026-0315",
  );

  const ndjson = historyToNdjson(e.history);
  assert.match(ndjson, /"refundRef":"rfnd-2026-0315"/);
  const fromNdjson = historyFromNdjson(ndjson);
  assert.equal(
    fromNdjson[fromNdjson.length - 1].refundRef,
    "rfnd-2026-0315",
  );
});

test("parser rejects refundRef on a RELEASE entry", () => {
  // A legal RELEASE edge (VERIFIED → RELEASED) carrying a refundRef:
  // the edge check passes, so the ref restriction is what fires.
  const history: EscrowHistoryEntry[] = [
    {
      seq: 1,
      event: "FUND",
      from: "CREATED",
      to: "FUNDED",
      at: "2026-03-06T08:00:00.000Z",
      amount: 10630,
    },
    {
      seq: 2,
      event: "SUBMIT_MILESTONE",
      from: "FUNDED",
      to: "MILESTONE_SUBMITTED",
      at: "2026-03-06T08:01:00.000Z",
    },
    {
      seq: 3,
      event: "VERIFY_PASS",
      from: "MILESTONE_SUBMITTED",
      to: "VERIFIED",
      at: "2026-03-06T08:02:00.000Z",
    },
    {
      seq: 4,
      event: "RELEASE",
      from: "VERIFIED",
      to: "RELEASED",
      at: "2026-03-06T08:03:00.000Z",
      refundRef: "rfnd-001",
    },
  ];
  assert.throws(
    () => parseEscrowHistory(history),
    (err: unknown) =>
      err instanceof Error &&
      /refundRef only allowed on ARBITRATE_REFUND entries/.test(err.message),
  );
});

test("parser rejects empty and overlong refundRef in a snapshot", () => {
  for (const bad of ["", "r".repeat(MAX_SETTLEMENT_REF_LENGTH + 1)]) {
    const history: EscrowHistoryEntry[] = [
      {
        seq: 1,
        event: "FUND",
        from: "CREATED",
        to: "FUNDED",
        at: "2026-03-06T08:00:00.000Z",
        amount: 10630,
      },
      {
        seq: 2,
        event: "DISPUTE",
        from: "FUNDED",
        to: "DISPUTED",
        at: "2026-03-06T08:01:00.000Z",
      },
      {
        seq: 3,
        event: "ARBITRATE_REFUND",
        from: "DISPUTED",
        to: "REFUNDED",
        at: "2026-03-06T08:02:00.000Z",
        refundRef: bad,
      },
    ];
    assert.throws(
      () => parseEscrowHistory(history),
      (err: unknown) =>
        err instanceof Error && /refundRef must be/.test(err.message),
    );
  }
});

test("rewriting a persisted refundRef breaks the hash chain", () => {
  const e = refundEscrow("esc-chain", "rfnd-2026-0315");
  assert.equal(verifyHistoryChain(e.history), true);
  const tampered = e.history.map((entry, i) =>
    i === e.history.length - 1
      ? { ...entry, refundRef: "rfnd-forged" }
      : entry,
  );
  assert.equal(verifyHistoryChain(tampered), false);
  // And the parser refuses the tampered snapshot outright.
  assert.throws(
    () => Escrow.fromJSON({ ...e.toJSON(), history: tampered }),
    /hash chain is broken/,
  );
});

test("a refundRef typo is an unknown field, not a silent drop", () => {
  const history = refundEscrow("esc-typo", "rfnd-001").history;
  const last = history[history.length - 1];
  const typo = history.map((entry) =>
    entry === last
      ? { ...entry, refundref: "rfnd-001", refundRef: undefined }
      : entry,
  );
  assert.throws(
    () => parseEscrowHistory(typo),
    (err: unknown) =>
      err instanceof Error && /unknown field "refundref"/.test(err.message),
  );
});
