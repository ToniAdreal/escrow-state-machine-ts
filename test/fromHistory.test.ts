/**
 * Escrow.fromHistory tests (#235).
 *
 * `fromJSON` restores from a snapshot envelope (id + state + history +
 * configuration); a holder of a BARE audit history — e.g. the receiving
 * end of the NDJSON transport in src/ndjson.ts — had no restore path at
 * all and had to hand-wrap entries in a synthetic envelope with a state
 * field it derived itself. `Escrow.fromHistory(id, history, opts?)`
 * closes that gap: the history is the only source of truth, validation
 * is the exact parseEscrowHistory code path, the state is derived from
 * the last entry, and per-instance options re-attach with the same
 * semantics as fromJSON's options.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  historyFromNdjson,
  historyToNdjson,
  verifyHistoryChain,
  type EscrowHistoryEntry,
} from "../src/index.js";

const T1 = "2026-03-01T10:00:00.000Z";
const T2 = "2026-03-01T11:00:00.000Z";
const T3 = "2026-03-01T12:00:00.000Z";
const T4 = "2026-03-01T13:00:00.000Z";

/** Escrow driven CREATED -> FUNDED -> MILESTONE_SUBMITTED -> VERIFIED. */
function goldenEscrow(id = "escrow-from-history-1"): Escrow {
  const e = new Escrow(id);
  e.dispatch("FUND", "sponsor deposit", 10630, { at: T1 });
  e.dispatch("SUBMIT_MILESTONE", "creator delivers KPI bundle", undefined, {
    at: T2,
  });
  e.dispatch("VERIFY_PASS", "oracle attestation ok", undefined, { at: T3 });
  return e;
}

/** The golden escrow's history as a detached plain-JSON value. */
function goldenHistory(id?: string): EscrowHistoryEntry[] {
  return JSON.parse(JSON.stringify(goldenEscrow(id).history));
}

/** Same history with every hash-chain field stripped (legacy form). */
function hashlessHistory(id?: string): EscrowHistoryEntry[] {
  return goldenHistory(id).map((e) => {
    const { prevHash: _p, hash: _h, ...rest } = e;
    return rest as EscrowHistoryEntry;
  });
}

describe("Escrow.fromHistory(id, history, opts?)", () => {
  it("golden history replays to the correct final state with history intact", () => {
    const live = goldenEscrow();
    const restored = Escrow.fromHistory(live.id, goldenHistory());
    assert.equal(restored.id, live.id);
    assert.equal(restored.state, "VERIFIED");
    assert.equal(restored.isTerminal, false);
    assert.deepEqual(restored.history, live.history);
    assert.equal(restored.history[0].amount, 10630);
  });

  it("empty history rebuilds a fresh CREATED escrow that can dispatch", () => {
    const restored = Escrow.fromHistory("fresh-from-log", []);
    assert.equal(restored.state, "CREATED");
    assert.equal(restored.history.length, 0);
    assert.equal(restored.dispatch("FUND", "first", 500, { at: T1 }), "FUNDED");
    assert.equal(restored.history[0].seq, 1);
  });

  it("restored escrow keeps dispatching with no seq gap and an intact chain", () => {
    const restored = Escrow.fromHistory("escrow-from-history-1", goldenHistory());
    assert.equal(restored.dispatch("RELEASE", "pay out", undefined, { at: T4 }), "RELEASED");
    assert.deepEqual(
      restored.history.map((h) => h.seq),
      [1, 2, 3, 4]
    );
    const last = restored.history[restored.history.length - 1];
    assert.equal(last.prevHash, restored.history[2].hash);
    assert.equal(verifyHistoryChain(restored.history), true);
  });

  it("agrees deeply with fromJSON on the equivalent snapshot", () => {
    const live = goldenEscrow();
    const snapshot = JSON.parse(JSON.stringify(live.toJSON()));
    const viaSnapshot = Escrow.fromJSON(snapshot);
    const viaHistory = Escrow.fromHistory(live.id, goldenHistory());
    assert.equal(viaHistory.state, viaSnapshot.state);
    assert.deepEqual(viaHistory.history, viaSnapshot.history);
    assert.deepEqual(viaHistory.toJSON(), viaSnapshot.toJSON());
  });

  it("legacy hashless history replays and is chained on rehydration", () => {
    const bare = hashlessHistory();
    const restored = Escrow.fromHistory("escrow-from-history-1", bare);
    assert.equal(restored.state, "VERIFIED");
    for (const entry of restored.history) {
      assert.equal(typeof entry.hash, "string");
      assert.equal(typeof entry.prevHash, "string");
    }
    assert.equal(verifyHistoryChain(restored.history), true);
    // Audit content itself is unchanged: stripping the rehydration-added
    // chain fields reproduces the input exactly.
    assert.deepEqual(
      restored.history.map((e) => {
        const { prevHash: _p, hash: _h, ...rest } = e;
        return rest;
      }),
      bare
    );
  });

  it("terminal history replays to a terminal escrow that rejects dispatch", () => {
    const live = goldenEscrow("escrow-terminal");
    live.dispatch("RELEASE", "pay out", undefined, { at: T4 });
    const restored = Escrow.fromHistory(
      live.id,
      JSON.parse(JSON.stringify(live.history))
    );
    assert.equal(restored.state, "RELEASED");
    assert.equal(restored.isTerminal, true);
    assert.throws(() => restored.dispatch("EXPIRE"), /invalid transition/);
  });

  it("rejects a chain break, a seq gap, and an illegal edge with clear errors", () => {
    const broken = goldenHistory();
    broken[1].from = "VERIFIED";
    assert.throws(
      () => Escrow.fromHistory("x", broken),
      /does not continue previous to/
    );

    const gapped = goldenHistory();
    gapped[1].seq = 5;
    assert.throws(() => Escrow.fromHistory("x", gapped), /seq must be 2/);

    const illegal: unknown = [
      {
        seq: 1,
        event: "FUND",
        from: "CREATED",
        to: "FUNDED",
        at: T1,
        amount: 100,
      },
      {
        seq: 2,
        event: "RELEASE",
        from: "FUNDED",
        to: "RELEASED",
        at: T2,
      },
    ];
    assert.throws(() => Escrow.fromHistory("x", illegal), /cannot lead to/);
  });

  it("rejects a tampered chained history (hash chain re-verified)", () => {
    const tampered = goldenHistory();
    tampered[0].amount = 1; // rewrite the deposit, keep the old hashes
    assert.throws(
      () => Escrow.fromHistory("x", tampered),
      /hash chain is broken/
    );
  });

  it("rejects a missing field and an unknown entry field", () => {
    const missing = hashlessHistory();
    delete (missing[1] as unknown as Record<string, unknown>).at;
    assert.throws(() => Escrow.fromHistory("x", missing), /at must be canonical/);

    const unknownField = hashlessHistory();
    (unknownField[0] as unknown as Record<string, unknown>).amout = 10630;
    assert.throws(
      () => Escrow.fromHistory("x", unknownField),
      /unknown field "amout"/
    );
  });

  it("rejects an invalid id and a non-array history", () => {
    for (const bad of ["", 42, null, undefined]) {
      assert.throws(
        () => Escrow.fromHistory(bad as string, []),
        /invalid history: id must be a non-empty string/
      );
    }
    for (const bad of [null, "x", 42, {}]) {
      assert.throws(
        () => Escrow.fromHistory("x", bad),
        /invalid history: history must be an array/
      );
    }
  });

  it("re-attaches requireVerifyEvidence and maxDeposit via opts", () => {
    const submitted = new Escrow("opts-1");
    submitted.dispatch("FUND", "initial", 900, { at: T1 });
    submitted.dispatch("SUBMIT_MILESTONE", "done", undefined, { at: T2 });
    const restored = Escrow.fromHistory(
      "opts-1",
      JSON.parse(JSON.stringify(submitted.history)),
      { requireVerifyEvidence: true, maxDeposit: 1000 }
    );
    assert.throws(() => restored.dispatch("VERIFY_PASS"), /verify evidence required/);
    assert.equal(restored.history.length, 2);
    assert.equal(
      restored.dispatch("VERIFY_PASS", "ok", undefined, {
        evidence: "chainlink-req-1",
        at: T3,
      }),
      "VERIFIED"
    );

    const funded = new Escrow("opts-2");
    funded.dispatch("FUND", "initial", 900, { at: T1 });
    const capped = Escrow.fromHistory(
      "opts-2",
      JSON.parse(JSON.stringify(funded.history)),
      { maxDeposit: 1000 }
    );
    assert.throws(() => capped.dispatch("FUND", "over", 200), /deposit cap exceeded/);
    assert.equal(capped.dispatch("FUND", "top-up", 100, { at: T2 }), "FUNDED");
  });

  it("re-attaches a rolePolicy via opts; without opts the rebuild is unrestricted", () => {
    const funded = new Escrow("opts-3");
    funded.dispatch("FUND", "initial", 900, { at: T1 });
    const history = JSON.parse(JSON.stringify(funded.history));

    const guarded = Escrow.fromHistory("opts-3", history, {
      rolePolicy: { SUBMIT_MILESTONE: ["creator"] },
    });
    assert.throws(
      () => guarded.dispatch("SUBMIT_MILESTONE", "done"),
      /actor not authorized for SUBMIT_MILESTONE/
    );
    assert.equal(
      guarded.dispatch("SUBMIT_MILESTONE", "done", undefined, {
        actor: "creator",
        at: T2,
      }),
      "MILESTONE_SUBMITTED"
    );

    const open = Escrow.fromHistory("opts-3", history);
    assert.equal(
      open.dispatch("SUBMIT_MILESTONE", "done", undefined, { at: T2 }),
      "MILESTONE_SUBMITTED"
    );
  });

  it("keyed history rebuilds only with the same auditKey", () => {
    const keyed = new Escrow("keyed-1", { auditKey: "history-key" });
    keyed.dispatch("FUND", "initial", 900, { at: T1 });
    const history = JSON.parse(JSON.stringify(keyed.history));

    assert.throws(() => Escrow.fromHistory("keyed-1", history), /hash chain is broken/);
    assert.throws(
      () => Escrow.fromHistory("keyed-1", history, { auditKey: "wrong-key" }),
      /hash chain is broken/
    );
    const restored = Escrow.fromHistory("keyed-1", history, {
      auditKey: "history-key",
    });
    assert.equal(restored.state, "FUNDED");
    restored.dispatch("FUND", "top-up", 100, { at: T2 });
    assert.equal(verifyHistoryChain(restored.history, "history-key"), true);
    assert.equal(verifyHistoryChain(restored.history), false);
  });

  it("honest limits: deadline and consumed idempotency keys are NOT in a bare history", () => {
    const live = new Escrow("limits-1");
    live.setDeadline("2026-04-01T00:00:00.000Z");
    live.dispatch("FUND", "initial", 900, { at: T1, idempotencyKey: "k1" });
    const history = JSON.parse(JSON.stringify(live.history));

    // The snapshot envelope carries both; the bare history carries neither.
    const viaSnapshot = Escrow.fromJSON(JSON.parse(JSON.stringify(live.toJSON())));
    assert.equal(viaSnapshot.getDeadline(), "2026-04-01T00:00:00.000Z");
    assert.equal(viaSnapshot.dispatch("FUND", "dup", 100, { idempotencyKey: "k1" }), "FUNDED");
    assert.equal(viaSnapshot.history.length, 1); // duplicate key: no-op

    const viaHistory = Escrow.fromHistory("limits-1", history);
    assert.equal(viaHistory.getDeadline(), undefined);
    assert.equal(viaHistory.dispatch("FUND", "dup", 100, { at: T2, idempotencyKey: "k1" }), "FUNDED");
    assert.equal(viaHistory.history.length, 2); // key set starts empty: re-executes
  });

  it("rebuilds directly from NDJSON-imported entries (history-only transport)", () => {
    const live = goldenEscrow("ndjson-1");
    const entries = historyFromNdjson(historyToNdjson(live));
    const restored = Escrow.fromHistory("ndjson-1", entries);
    assert.equal(restored.state, "VERIFIED");
    assert.deepEqual(restored.history, live.history);
  });

  it("the rebuilt escrow is detached from later mutation of the input value", () => {
    const input = goldenHistory();
    const restored = Escrow.fromHistory("detach-1", input);
    input[0].amount = 1;
    input.push({
      seq: 99,
      event: "EXPIRE",
      from: "VERIFIED",
      to: "EXPIRED",
      at: T4,
    });
    assert.equal(restored.history.length, 3);
    assert.equal(restored.history[0].amount, 10630);
    assert.equal(restored.state, "VERIFIED");
  });
});
