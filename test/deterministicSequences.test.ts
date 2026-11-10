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
  totalReleased: number;
}

/**
 * Still-locked balance of a walk escrow: FUND total minus released
 * total, at cent precision. Read straight off the history entries
 * (an amountless FUND counts as 0) rather than via
 * depositAmountFromHistory, which throws on an amountless FUND — and
 * walks FUND without an amount half the time.
 */
function lockedBalance(escrow: Escrow): number {
  let locked = 0;
  for (const entry of escrow.history) {
    if (entry.event === "FUND" && typeof entry.amount === "number") {
      locked += entry.amount;
    }
    if (entry.event === "PARTIAL_RELEASE" && typeof entry.amount === "number") {
      locked -= entry.amount;
    }
  }
  return Math.round(locked * 100) / 100;
}

/**
 * Dispatch one random legal event. PARTIAL_RELEASE (backlog #1028)
 * needs a mandatory amount, so it is given a random tranche of the
 * still-locked balance — at least one cent, at most the whole locked
 * balance. When nothing is locked the release is not dispatchable
 * this step, so the pick falls through to the next legal event
 * (every non-terminal state offers at least one amountless event:
 * FUND, SUBMIT_MILESTONE, DISPUTE, EXPIRE, …). Returns the
 * dispatched event and its amount, or null when no event was
 * dispatchable — impossible for a non-terminal state, and callers
 * treat it as a skipped step rather than a deadlock.
 */
function dispatchRandomLegalEvent(
  escrow: Escrow,
  rand: () => number,
): { event: EscrowEvent; amount?: number } | null {
  const allowed = allowedEvents(escrow.state);
  const start = Math.floor(rand() * allowed.length);
  for (let i = 0; i < allowed.length; i++) {
    const event = allowed[(start + i) % allowed.length];
    if (event === "PARTIAL_RELEASE") {
      const locked = lockedBalance(escrow);
      if (locked <= 0) continue;
      // Random tranche: 0.01 + rand() * (locked - 0.01), cent-rounded.
      const amount = Math.round((0.01 + rand() * (locked - 0.01)) * 100) / 100;
      escrow.dispatch(event, undefined, amount);
      return { event, amount };
    }
    let amount: number | undefined;
    if (event === "FUND" && rand() < 0.5) {
      // 2-decimal money amounts in a realistic range.
      amount = Math.round(rand() * 50000 * 100) / 100;
    }
    escrow.dispatch(event, undefined, amount);
    return { event, amount };
  }
  return null;
}

/** One random walk over *legal* events only (from allowedEvents). */
function runWalk(id: string, rand: () => number): WalkResult {
  const escrow = new Escrow(id);
  const events: EscrowEvent[] = [];
  let totalFunded = 0;
  let totalReleased = 0;
  let steps = 0;
  while (!escrow.isTerminal && steps < 25) {
    const step = dispatchRandomLegalEvent(escrow, rand);
    if (step === null) break;
    if (step.event === "FUND" && step.amount !== undefined) {
      totalFunded += step.amount;
    }
    if (step.event === "PARTIAL_RELEASE" && step.amount !== undefined) {
      totalReleased += step.amount;
    }
    events.push(step.event);
    steps++;
  }
  return { id, events, finalState: escrow.state, totalFunded, totalReleased };
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
      const step = dispatchRandomLegalEvent(escrow, rand);
      assert.ok(step !== null, `a dispatchable event exists (${escrow.state})`);
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
    // Tranches paid out mid-walk are gone before the final
    // settlement: only the remainder is settled at the end, so the
    // conservation check is released + final payout == funded.
    const released = result.totalReleased;
    const remaining = Math.round((gross - released) * 100) / 100;
    if (result.finalState === "RELEASED" || result.finalState === "REFUNDED") {
      const s = settleRelease({
        gross: remaining,
        proFeeBps: 500,
        referralCredits: Math.round(remaining) / 100,
      });
      const paid = released + s.net + s.proFee + s.referralCredits;
      assert.ok(paid <= gross + 0.01, `payout ≤ funded [${result.id}: ${result.events.join("→")}]`);
      assert.ok(
        Math.abs(paid - gross) <= 0.01,
        `money conserved: released tranches + final payout == funded [${result.id}: ${result.events.join("→")}]`,
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
    assert.equal(rb.totalReleased, ra.totalReleased, `identical released total with seed ${SEED}`);
  }
});
