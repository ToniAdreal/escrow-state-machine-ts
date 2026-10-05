import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  allowedEvents,
  settleRelease,
  type EscrowEvent,
} from "../src/index.js";

/**
 * Deterministic property-style tests: fixed-seed random walks through the
 * state machine must never break accounting or structural invariants.
 *
 * Seed 20261005 is written down in the source so any run is byte-identical;
 * a second run of the same generator is asserted equal to the first.
 */

/** Fixed seed — change this and every expectation below is reproducible. */
const SEED = 20261005;
/** Number of random walks per run. */
const WALKS = 200;

/** mulberry32: tiny, deterministic, good-enough PRNG for test walks. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface WalkResult {
  id: string;
  events: EscrowEvent[];
  finalState: string;
  totalFunded: number;
}

/** One random walk over *legal* events only (from allowedEvents). */
function runWalk(id: string, rand: () => number): WalkResult {
  const escrow = new Escrow(id);
  const events: EscrowEvent[] = [];
  let totalFunded = 0;
  let steps = 0;
  while (!escrow.isTerminal && steps < 25) {
    const allowed = allowedEvents(escrow.state);
    const event = allowed[Math.floor(rand() * allowed.length)];
    let amount: number | undefined;
    if (event === "FUND" && rand() < 0.5) {
      // 2-decimal money amounts in a realistic range.
      amount = Math.round(rand() * 50000 * 100) / 100;
      totalFunded += amount;
    }
    escrow.dispatch(event, undefined, amount);
    events.push(event);
    steps++;
  }
  return { id, events, finalState: escrow.state, totalFunded };
}

/** Structural invariants of the append-only audit history. */
function assertHistoryIntegrity(escrow: Escrow): void {
  let prevTo: string | null = null;
  for (const [i, e] of escrow.history.entries()) {
    assert.equal(e.seq, i + 1, `seq strictly increments (${escrow.id})`);
    if (prevTo === null) {
      assert.equal(e.from, "CREATED", `walk starts at CREATED (${escrow.id})`);
    } else {
      assert.equal(e.from, prevTo, `from/to chain is continuous (${escrow.id})`);
    }
    assert.ok(
      !Number.isNaN(Date.parse(e.at)),
      `timestamp is valid ISO (${escrow.id})`,
    );
    prevTo = e.to;
  }
  assert.equal(prevTo, escrow.state, `history ends at current state (${escrow.id})`);
}

test("deterministic walks: no walk ever deadlocks, history stays intact", () => {
  const rand = mulberry32(SEED);
  for (let i = 0; i < WALKS; i++) {
    const escrow = new Escrow(`walk-${i}`);
    const allowed = () => allowedEvents(escrow.state);
    let steps = 0;
    while (!escrow.isTerminal && steps < 25) {
      const evts = allowed();
      assert.ok(evts.length > 0, `non-terminal state must offer events (${escrow.state})`);
      escrow.dispatch(evts[Math.floor(rand() * evts.length)]);
      steps++;
    }
    assert.ok(escrow.isTerminal, `walk-${i} reached a terminal state, not stuck`);
    assertHistoryIntegrity(escrow);
  }
});

test("deterministic walks: accounting invariants hold on every walk", () => {
  const rand = mulberry32(SEED);
  for (let i = 0; i < WALKS; i++) {
    const result = runWalk(`acct-${i}`, rand);
    const gross = result.totalFunded;
    if (result.finalState === "RELEASED" || result.finalState === "REFUNDED") {
      const s = settleRelease({
        gross,
        proFeeBps: 500,
        referralCredits: Math.round(gross) / 100,
      });
      const paid = s.net + s.proFee + s.referralCredits;
      assert.ok(paid <= gross + 0.01, `payout ≤ funded [${result.id}: ${result.events.join("→")}]`);
      assert.ok(
        Math.abs(paid - gross) <= 0.01,
        `money conserved: payout == funded [${result.id}: ${result.events.join("→")}]`,
      );
      assert.ok(s.proFee >= 0 && s.net >= 0 && s.referralCredits >= 0, `no negative payout [${result.id}]`);
    } else {
      // EXPIRED: everything stays locked, nothing paid out.
      assert.equal(
        result.finalState,
        "EXPIRED",
        `only terminal states are RELEASED/REFUNDED/EXPIRED [${result.id}]`,
      );
    }
  }
});

test("deterministic walks: same seed reproduces identical walks", () => {
  const a = mulberry32(SEED);
  const b = mulberry32(SEED);
  for (let i = 0; i < WALKS; i++) {
    const ra = runWalk(`repro-a-${i}`, a);
    const rb = runWalk(`repro-b-${i}`, b);
    assert.deepEqual(rb.events, ra.events, `identical event path with seed ${SEED}`);
    assert.equal(rb.finalState, ra.finalState, `identical final state with seed ${SEED}`);
    assert.equal(rb.totalFunded, ra.totalFunded, `identical funding with seed ${SEED}`);
  }
});
