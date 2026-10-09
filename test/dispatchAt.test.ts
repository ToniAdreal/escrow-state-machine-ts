/**
 * Injectable audit timestamps for Escrow.dispatch (DispatchOptions.at).
 *
 * The audit entry's `at` was the one timestamp with no injection point:
 * quorum approvals take `QuorumConfig.now`, webhook payloads take
 * `BuildWebhookOptions.now`, but dispatch hard-coded the wall clock, so
 * dispatch-level tests and replay scenarios could not be deterministic.
 * `opts.at` (Date | string) pins it, under the same rules the snapshot
 * parser enforces: strings must already be canonical ISO-8601, values
 * must be non-decreasing, and a rejected value leaves no residue.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Escrow, verifyHistoryChain } from "../src/index.js";
import type { EscrowHistoryEntry, EscrowSnapshot } from "../src/index.js";

const T1 = "2026-03-01T10:00:00.000Z";
const T2 = "2026-03-01T11:00:00.000Z";
const T3 = "2026-03-01T12:00:00.000Z";

/** Deep-clone a history so tampering tests don't fight Object.freeze. */
function cloneHistory(
  history: readonly EscrowHistoryEntry[]
): EscrowHistoryEntry[] {
  return JSON.parse(JSON.stringify(history)) as EscrowHistoryEntry[];
}

describe("dispatch at injection", () => {
  it("records a string at verbatim on the audit entry", () => {
    const escrow = new Escrow("at-1");
    escrow.dispatch("FUND", "initial deposit", 1000, { at: T1 });
    assert.equal(escrow.history.length, 1);
    assert.equal(escrow.history[0].at, T1);
  });

  it("records a Date at as its canonical ISO string", () => {
    const escrow = new Escrow("at-2");
    escrow.dispatch("FUND", "initial deposit", 1000, { at: new Date(T2) });
    assert.equal(escrow.history[0].at, T2);
  });

  it("normalizes a Date at to canonical ISO (millis always present)", () => {
    const escrow = new Escrow("at-3");
    // This Date was parsed from a string without fractional seconds; the
    // stored audit value must still be the canonical toISOString() form.
    const date = new Date("2026-03-01T10:00:00Z");
    escrow.dispatch("FUND", undefined, 1000, { at: date });
    assert.equal(escrow.history[0].at, "2026-03-01T10:00:00.000Z");
  });

  it("omitted at keeps the legacy wall-clock behavior", () => {
    const escrow = new Escrow("at-4");
    const before = Date.now();
    escrow.dispatch("FUND", "initial deposit", 1000);
    const after = Date.now();
    const at = escrow.history[0].at;
    // Canonical ISO (round-trips through Date exactly) and ~now.
    assert.equal(new Date(Date.parse(at)).toISOString(), at);
    const ms = Date.parse(at);
    assert.ok(ms >= before && ms <= after, `at ${at} within dispatch window`);
  });

  it("rejects non-canonical string at values with no history residue", () => {
    for (const bad of ["2026-03-01", "2026-03-01T10:00:00Z", "2026-03-01 10:00:00"]) {
      const escrow = new Escrow("at-5");
      assert.throws(
        () => escrow.dispatch("FUND", undefined, 1000, { at: bad }),
        /at must be a canonical ISO-8601 timestamp/
      );
      assert.equal(escrow.state, "CREATED");
      assert.equal(escrow.history.length, 0);
    }
  });

  it("rejects an unparseable string at with no history residue", () => {
    const escrow = new Escrow("at-6");
    assert.throws(
      () => escrow.dispatch("FUND", undefined, 1000, { at: "not-a-date" }),
      /at must be a canonical ISO-8601 timestamp/
    );
    assert.equal(escrow.state, "CREATED");
    assert.equal(escrow.history.length, 0);
  });

  it("rejects an invalid Date at with no history residue", () => {
    const escrow = new Escrow("at-7");
    assert.throws(
      () => escrow.dispatch("FUND", undefined, 1000, { at: new Date(NaN) }),
      /at must be a canonical ISO-8601 timestamp/
    );
    assert.equal(escrow.state, "CREATED");
    assert.equal(escrow.history.length, 0);
  });

  it("rejects non-Date non-string at values with no history residue", () => {
    for (const bad of [12345, null]) {
      const escrow = new Escrow("at-8");
      assert.throws(
        () =>
          escrow.dispatch("FUND", undefined, 1000, {
            at: bad as unknown as string,
          }),
        /at must be a canonical ISO-8601 timestamp/
      );
      assert.equal(escrow.state, "CREATED");
      assert.equal(escrow.history.length, 0);
    }
  });

  it("rejects an at earlier than the previous entry; equal at is accepted", () => {
    const escrow = new Escrow("at-9");
    escrow.dispatch("FUND", undefined, 1000, { at: T2 });
    assert.throws(
      () => escrow.dispatch("SUBMIT_MILESTONE", undefined, undefined, { at: T1 }),
      /earlier than the previous entry's at/
    );
    // The rejected dispatch left state and history untouched.
    assert.equal(escrow.state, "FUNDED");
    assert.equal(escrow.history.length, 1);
    // Non-decreasing means an identical timestamp is fine.
    escrow.dispatch("SUBMIT_MILESTONE", undefined, undefined, { at: T2 });
    assert.equal(escrow.history.length, 2);
    assert.equal(escrow.history[1].at, T2);
  });

  it("covers the injected at with the hash chain (tampering breaks it)", () => {
    const escrow = new Escrow("at-10");
    escrow.dispatch("FUND", undefined, 1000, { at: T1 });
    escrow.dispatch("SUBMIT_MILESTONE", undefined, undefined, { at: T2 });
    assert.equal(verifyHistoryChain(escrow.history), true);

    const tampered = cloneHistory(escrow.history);
    tampered[0].at = "2026-03-01T10:00:01.000Z"; // rewrite history on disk
    assert.equal(verifyHistoryChain(tampered), false);

    // Same story through the snapshot path: a structurally valid but
    // chain-invalid `at` rewrite is rejected by fromJSON.
    const snapshot = JSON.parse(
      JSON.stringify(escrow.toJSON())
    ) as EscrowSnapshot;
    snapshot.history[1].at = "2026-03-01T11:00:01.000Z";
    assert.throws(() => Escrow.fromJSON(snapshot), /hash chain is broken/);
  });

  it("makes replay deterministic: same injected ats give identical histories", () => {
    const run = (id: string): Escrow => {
      const escrow = new Escrow(id);
      escrow.dispatch("FUND", "deposit", 1000, { at: T1 });
      escrow.dispatch("SUBMIT_MILESTONE", "bundle", undefined, { at: T2 });
      escrow.dispatch("VERIFY_PASS", undefined, undefined, {
        at: T3,
        evidence: "chainlink-req-0xabc",
      });
      return escrow;
    };
    const a = run("at-11a");
    const b = run("at-11b");
    // Byte-identical audit trails, hashes included — the wall clock would
    // have made every run differ.
    assert.deepEqual(cloneHistory(a.history), cloneHistory(b.history));
  });

  it("round-trips an injected-at history through toJSON/fromJSON", () => {
    const escrow = new Escrow("at-12");
    escrow.dispatch("FUND", "deposit", 1000, { at: T1 });
    escrow.dispatch("SUBMIT_MILESTONE", undefined, undefined, { at: T2 });
    const restored = Escrow.fromJSON(
      JSON.parse(JSON.stringify(escrow.toJSON()))
    );
    assert.deepEqual(cloneHistory(restored.history), cloneHistory(escrow.history));
    assert.equal(verifyHistoryChain(restored.history), true);
    // The restored escrow keeps accepting injected timestamps.
    restored.dispatch("VERIFY_PASS", undefined, undefined, {
      at: T3,
      evidence: "chainlink-req-0xabc",
    });
    assert.equal(restored.history[2].at, T3);
    assert.equal(verifyHistoryChain(restored.history), true);
  });

  it("a rejected at does not consume the idempotency key", () => {
    const escrow = new Escrow("at-13");
    assert.throws(
      () =>
        escrow.dispatch("FUND", undefined, 1000, {
          idempotencyKey: "k-at",
          at: "bogus",
        }),
      /at must be a canonical ISO-8601 timestamp/
    );
    assert.equal(escrow.history.length, 0);
    // Corrected retry with the same key executes normally.
    escrow.dispatch("FUND", undefined, 1000, { idempotencyKey: "k-at", at: T1 });
    assert.equal(escrow.history.length, 1);
    assert.equal(escrow.history[0].at, T1);
  });

  it("a duplicate idempotency delivery stays a no-op even with a different at", () => {
    const escrow = new Escrow("at-14");
    escrow.dispatch("FUND", undefined, 1000, { idempotencyKey: "k-dup", at: T1 });
    const state = escrow.dispatch("SUBMIT_MILESTONE", undefined, undefined, {
      idempotencyKey: "k-dup",
      at: T2,
    });
    assert.equal(state, "FUNDED");
    assert.equal(escrow.history.length, 1);
    assert.equal(escrow.history[0].at, T1);
  });
});
