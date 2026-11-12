import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  escrowsByFilters,
  escrowsBySettlementRef,
  historyFromNdjson,
  historyToNdjson,
  MAX_SETTLEMENT_REF_LENGTH,
  verifyHistoryChain,
} from "../src/index.js";

/**
 * RELEASE settlement references (backlog #1072): the dataquest
 * lifecycle's `payoutRef` counterpart for this escrow — a chain tx
 * hash / bank transfer ref recorded verbatim on the RELEASE audit
 * entry, plus the `escrowsBySettlementRef` single-axis selector and
 * the `settlementRef` axis of `escrowsByFilters`.
 *
 * Rules under test:
 *  - `DispatchOptions.settlementRef` is accepted ONLY on RELEASE;
 *    any other event with a ref throws before anything is appended
 *    and consumes no idempotency key
 *  - a ref must be a non-empty string no longer than
 *    `MAX_SETTLEMENT_REF_LENGTH` (256) characters — longer refs are
 *    rejected, never truncated; an exactly-at-cap ref is accepted
 *  - a RELEASE without a ref stays legal and carries no
 *    `settlementRef` key
 *  - the ref is recorded verbatim, survives `toJSON()`/`fromJSON()`,
 *    `fromHistory()`, and NDJSON round-trips, and is covered by the
 *    hash chain (rewriting it breaks `verifyHistoryChain`)
 *  - the snapshot/history parsers enforce the same bar: a ref on a
 *    non-RELEASE entry, an empty ref, or an oversized ref in an
 *    untrusted log throws
 *  - `escrowsBySettlementRef` matches only RELEASE entries carrying
 *    that exact ref (case-sensitive); one ref may settle several
 *    escrows; an empty/non-string ref fails fast
 *  - the `escrowsByFilters` `settlementRef` axis composes with the
 *    state/actor axes under the same fail-closed key rule
 */

const AT = [
  "2026-03-01T00:00:00.000Z",
  "2026-03-01T01:00:00.000Z",
  "2026-03-01T02:00:00.000Z",
  "2026-03-01T03:00:00.000Z",
];

/** Full lifecycle CREATED -> FUNDED -> ... -> RELEASED, pinned timestamps. */
function releasedEscrow(id: string, settlementRef?: string): Escrow {
  const e = new Escrow(id);
  e.dispatch("FUND", undefined, 1000, { at: AT[0] });
  e.dispatch("SUBMIT_MILESTONE", undefined, undefined, { at: AT[1] });
  e.dispatch("VERIFY_PASS", undefined, undefined, { at: AT[2] });
  e.dispatch("RELEASE", undefined, undefined, {
    at: AT[3],
    ...(settlementRef !== undefined ? { settlementRef } : {}),
  });
  return e;
}

/** An escrow driven to VERIFIED (one RELEASE away). */
function verifiedEscrow(id: string): Escrow {
  const e = new Escrow(id);
  e.dispatch("FUND", undefined, 1000, { at: AT[0] });
  e.dispatch("SUBMIT_MILESTONE", undefined, undefined, { at: AT[1] });
  e.dispatch("VERIFY_PASS", undefined, undefined, { at: AT[2] });
  return e;
}

test("RELEASE records the settlementRef verbatim on the audit entry", () => {
  const e = releasedEscrow("ref-1", "0xabc123");
  assert.equal(e.state, "RELEASED");
  assert.equal(e.history.length, 4);
  const release = e.history[3];
  assert.equal(release.event, "RELEASE");
  assert.equal(release.settlementRef, "0xabc123");
  // No earlier entry carries a ref.
  for (const entry of e.history.slice(0, 3)) {
    assert.equal("settlementRef" in entry, false);
  }
  assert.equal(verifyHistoryChain(e.history), true);
});

test("RELEASE without a ref stays legal and carries no settlementRef key", () => {
  const e = releasedEscrow("ref-2");
  assert.equal(e.state, "RELEASED");
  assert.equal("settlementRef" in e.history[3], false);
});

test("a ref on any non-RELEASE event throws and leaves no trace", () => {
  for (const event of ["FUND", "SUBMIT_MILESTONE", "VERIFY_PASS"] as const) {
    const e = new Escrow(`ref-reject-${event}`);
    if (event !== "FUND") e.dispatch("FUND", undefined, 1000);
    if (event === "VERIFY_PASS") e.dispatch("SUBMIT_MILESTONE");
    const before = e.history.length;
    assert.throws(
      () =>
        e.dispatch(event, undefined, event === "FUND" ? 100 : undefined, {
          settlementRef: "0xabc123",
        }),
      new RegExp(
        `settlementRef is only accepted on RELEASE, not on ${event}`,
      ),
    );
    assert.equal(e.history.length, before);
  }
});

test("a rejected ref dispatch consumes no idempotency key", () => {
  const e = new Escrow("ref-key-1");
  assert.throws(
    () =>
      e.dispatch("FUND", undefined, 100, {
        idempotencyKey: "key-1",
        settlementRef: "0xabc123",
      }),
    /settlementRef is only accepted on RELEASE, not on FUND/,
  );
  // Same key retries cleanly once the ref is dropped.
  assert.equal(
    e.dispatch("FUND", undefined, 100, { idempotencyKey: "key-1" }),
    "FUNDED",
  );
  assert.equal(e.history.length, 1);
});

test("empty and non-string refs throw a shape error", () => {
  const e = verifiedEscrow("ref-shape-1");
  assert.throws(
    () => e.dispatch("RELEASE", undefined, undefined, { settlementRef: "" }),
    /invalid dispatch: settlementRef must be a non-empty string, got /,
  );
  assert.throws(
    () =>
      e.dispatch("RELEASE", undefined, undefined, {
        settlementRef: 42 as unknown as string,
      }),
    /invalid dispatch: settlementRef must be a non-empty string, got 42/,
  );
  assert.equal(e.state, "VERIFIED");
  assert.equal(e.history.length, 3);
});

test("an oversized ref is rejected, an at-cap ref is accepted", () => {
  const over = "x".repeat(MAX_SETTLEMENT_REF_LENGTH + 1);
  const atCap = "x".repeat(MAX_SETTLEMENT_REF_LENGTH);
  const e = verifiedEscrow("ref-cap-1");
  assert.throws(
    () =>
      e.dispatch("RELEASE", undefined, undefined, { settlementRef: over }),
    new RegExp(
      `invalid dispatch: settlementRef must be at most ${MAX_SETTLEMENT_REF_LENGTH} characters, got ${MAX_SETTLEMENT_REF_LENGTH + 1}`,
    ),
  );
  assert.equal(e.state, "VERIFIED");
  assert.equal(
    e.dispatch("RELEASE", undefined, undefined, { settlementRef: atCap }),
    "RELEASED",
  );
  assert.equal(e.history[3].settlementRef, atCap);
});

test("snapshot round-trip preserves the ref verbatim", () => {
  const e = releasedEscrow("ref-snap-1", "tx-0xdeadbeef");
  const restored = Escrow.fromJSON(e.toJSON());
  assert.equal(restored.state, "RELEASED");
  assert.equal(restored.history[3].settlementRef, "tx-0xdeadbeef");
  assert.equal(verifyHistoryChain(restored.history), true);
  // A ref-free release round-trips ref-free.
  const plain = Escrow.fromJSON(releasedEscrow("ref-snap-2").toJSON());
  assert.equal("settlementRef" in plain.history[3], false);
});

test("fromHistory round-trip preserves the ref", () => {
  const e = releasedEscrow("ref-hist-1", "bank-2026-031");
  const restored = Escrow.fromHistory("ref-hist-1", e.toJSON().history);
  assert.equal(restored.history[3].settlementRef, "bank-2026-031");
  assert.equal(verifyHistoryChain(restored.history), true);
});

test("NDJSON round-trip preserves the ref", () => {
  const e = releasedEscrow("ref-ndjson-1", "batch-77");
  const text = historyToNdjson(e.history);
  const entries = historyFromNdjson(text);
  assert.equal(entries[3].settlementRef, "batch-77");
  const restored = Escrow.fromHistory("ref-ndjson-1", entries);
  assert.equal(restored.history[3].settlementRef, "batch-77");
  assert.equal(verifyHistoryChain(restored.history), true);
});

test("rewriting a persisted ref breaks the hash chain", () => {
  const e = releasedEscrow("ref-tamper-1", "0xoriginal");
  const snapshot = e.toJSON();
  assert.equal(verifyHistoryChain(snapshot.history), true);
  const tampered = {
    ...snapshot,
    history: snapshot.history.map((entry) =>
      entry.event === "RELEASE"
        ? { ...entry, settlementRef: "0xforged" }
        : entry,
    ),
  };
  assert.equal(verifyHistoryChain(tampered.history), false);
  assert.throws(
    () => Escrow.fromJSON(tampered),
    /invalid snapshot: history hash chain is broken/,
  );
});

test("parser rejects a ref on a non-RELEASE entry in a snapshot", () => {
  const e = releasedEscrow("ref-parse-1", "0xabc123");
  const snapshot = e.toJSON();
  const tampered = {
    ...snapshot,
    history: snapshot.history.map((entry, i) =>
      i === 0 ? { ...entry, settlementRef: "0xabc123" } : entry,
    ),
  };
  assert.throws(
    () => Escrow.fromJSON(tampered),
    /invalid snapshot: history\[0\]: settlementRef only allowed on RELEASE entries/,
  );
});

test("parser rejects empty and oversized refs in a snapshot", () => {
  const e = releasedEscrow("ref-parse-2", "0xabc123");
  const snapshot = e.toJSON();
  const empty = {
    ...snapshot,
    history: snapshot.history.map((entry) =>
      entry.event === "RELEASE" ? { ...entry, settlementRef: "" } : entry,
    ),
  };
  assert.throws(
    () => Escrow.fromJSON(empty),
    /invalid snapshot: history\[3\]: settlementRef must be a non-empty string, got ""/,
  );
  const over = {
    ...snapshot,
    history: snapshot.history.map((entry) =>
      entry.event === "RELEASE"
        ? { ...entry, settlementRef: "x".repeat(MAX_SETTLEMENT_REF_LENGTH + 1) }
        : entry,
    ),
  };
  assert.throws(
    () => Escrow.fromJSON(over),
    new RegExp(
      `invalid snapshot: history\\[3\\]: settlementRef must be at most ${MAX_SETTLEMENT_REF_LENGTH} characters, got ${MAX_SETTLEMENT_REF_LENGTH + 1}`,
    ),
  );
});

test("parser rejects an unknown settlementRef typo field", () => {
  const e = releasedEscrow("ref-parse-3", "0xabc123");
  const snapshot = e.toJSON();
  const tampered = {
    ...snapshot,
    history: snapshot.history.map((entry) =>
      entry.event === "RELEASE"
        ? { ...entry, settlementref: "0xabc123" }
        : entry,
    ),
  };
  assert.throws(
    () => Escrow.fromJSON(tampered),
    /invalid snapshot: history\[3\]: unknown field "settlementref"/,
  );
});

test("escrowsBySettlementRef matches only RELEASE entries with that ref", () => {
  const a = releasedEscrow("ref-sel-a", "0xshared");
  const b = releasedEscrow("ref-sel-b", "0xshared");
  const c = releasedEscrow("ref-sel-c", "0xother");
  const d = releasedEscrow("ref-sel-d");
  const batch = [a, b, c, d];
  assert.deepEqual(
    escrowsBySettlementRef(batch, "0xshared").map((e) => e.id),
    ["ref-sel-a", "ref-sel-b"],
  );
  assert.deepEqual(
    escrowsBySettlementRef(batch, "0xother").map((e) => e.id),
    ["ref-sel-c"],
  );
  // Released without a ref never matches; unknown refs match nothing.
  assert.deepEqual(escrowsBySettlementRef(batch, "0xmissing"), []);
  // Matching is exact and case-sensitive.
  assert.deepEqual(escrowsBySettlementRef(batch, "0XSHARED"), []);
});

test("escrowsBySettlementRef fails fast on an empty or non-string ref", () => {
  const batch = [releasedEscrow("ref-sel-e", "0xabc123")];
  assert.throws(
    () => escrowsBySettlementRef(batch, ""),
    /invalid escrowsBySettlementRef: settlementRef must be a non-empty string, got ""/,
  );
  assert.throws(
    () =>
      escrowsBySettlementRef(
        batch,
        42 as unknown as string,
      ),
    /invalid escrowsBySettlementRef: settlementRef must be a non-empty string, got 42/,
  );
});

test("escrowsByFilters settlementRef axis composes with state and actor", () => {
  const a = releasedEscrow("ref-filt-a", "0xbatch-1");
  const b = releasedEscrow("ref-filt-b", "0xbatch-1");
  const c = releasedEscrow("ref-filt-c", "0xbatch-2");
  // Give b an actor on its RELEASE entry for the actor-axis combination.
  const d = new Escrow("ref-filt-d");
  d.dispatch("FUND", undefined, 1000, { actor: "ops", at: AT[0] });
  d.dispatch("SUBMIT_MILESTONE", undefined, undefined, {
    actor: "ops",
    at: AT[1],
  });
  d.dispatch("VERIFY_PASS", undefined, undefined, { actor: "ops", at: AT[2] });
  d.dispatch("RELEASE", undefined, undefined, {
    actor: "ops",
    at: AT[3],
    settlementRef: "0xbatch-1",
  });
  const batch = [a, b, c, d];
  assert.deepEqual(
    escrowsByFilters(batch, { settlementRef: "0xbatch-1" }).map((e) => e.id),
    ["ref-filt-a", "ref-filt-b", "ref-filt-d"],
  );
  assert.deepEqual(
    escrowsByFilters(batch, {
      state: "RELEASED",
      settlementRef: "0xbatch-1",
    }).map((e) => e.id),
    ["ref-filt-a", "ref-filt-b", "ref-filt-d"],
  );
  assert.deepEqual(
    escrowsByFilters(batch, {
      actor: "ops",
      settlementRef: "0xbatch-1",
    }).map((e) => e.id),
    ["ref-filt-d"],
  );
  assert.deepEqual(
    escrowsByFilters(batch, { settlementRef: "0xmissing" }),
    [],
  );
});

test("escrowsByFilters settlementRef axis validates like the other axes", () => {
  const batch = [releasedEscrow("ref-filt-e", "0xabc123")];
  assert.throws(
    () => escrowsByFilters(batch, { settlementRef: "" }),
    /invalid escrowsByFilters: settlementRef must be a non-empty string, got ""/,
  );
  assert.throws(
    () => escrowsByFilters(batch, { settlementRef: 7 as unknown as string }),
    /invalid escrowsByFilters: settlementRef must be a non-empty string, got 7/,
  );
  // The unknown-key rule still covers typos of the new axis name.
  assert.throws(
    () =>
      escrowsByFilters(batch, {
        settlementRefs: "0xabc123",
      } as unknown as { settlementRef: string }),
    /invalid escrowsByFilters: unknown filter "settlementRefs"/,
  );
});
