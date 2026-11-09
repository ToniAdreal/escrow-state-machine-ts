import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  allowedEvents,
  isTerminal,
  transitionTable,
  type EscrowState,
} from "../src/index.js";

const ALL_STATES: EscrowState[] = [
  "CREATED",
  "FUNDED",
  "MILESTONE_SUBMITTED",
  "VERIFIED",
  "DISPUTED",
  "RELEASED",
  "REFUNDED",
  "EXPIRED",
];

const TERMINAL_STATES: EscrowState[] = ["RELEASED", "REFUNDED", "EXPIRED"];
const NON_TERMINAL_STATES: EscrowState[] = [
  "CREATED",
  "FUNDED",
  "MILESTONE_SUBMITTED",
  "VERIFIED",
  "DISPUTED",
];

/** Drive a fresh escrow to the given state with real dispatches. */
function escrowIn(state: EscrowState): Escrow {
  const e = new Escrow(`is-terminal-${state.toLowerCase()}`);
  switch (state) {
    case "CREATED":
      break;
    case "FUNDED":
      e.dispatch("FUND");
      break;
    case "MILESTONE_SUBMITTED":
      e.dispatch("FUND");
      e.dispatch("SUBMIT_MILESTONE");
      break;
    case "VERIFIED":
      e.dispatch("FUND");
      e.dispatch("SUBMIT_MILESTONE");
      e.dispatch("VERIFY_PASS");
      break;
    case "DISPUTED":
      e.dispatch("FUND");
      e.dispatch("DISPUTE");
      break;
    case "RELEASED":
      e.dispatch("FUND");
      e.dispatch("SUBMIT_MILESTONE");
      e.dispatch("VERIFY_PASS");
      e.dispatch("RELEASE");
      break;
    case "REFUNDED":
      e.dispatch("FUND");
      e.dispatch("DISPUTE");
      e.dispatch("ARBITRATE_REFUND");
      break;
    case "EXPIRED":
      e.dispatch("EXPIRE");
      break;
  }
  assert.equal(e.state, state);
  return e;
}

test("terminal states return true", () => {
  for (const state of TERMINAL_STATES) {
    assert.equal(isTerminal(state), true, state);
  }
});

test("non-terminal states return false", () => {
  for (const state of NON_TERMINAL_STATES) {
    assert.equal(isTerminal(state), false, state);
  }
});

test("matches the instance getter for every state", () => {
  for (const state of ALL_STATES) {
    const escrow = escrowIn(state);
    assert.equal(
      isTerminal(state),
      escrow.isTerminal,
      `${state}: pure function vs getter`,
    );
  }
});

test("terminal set is exactly the states with no outgoing edges", () => {
  const noOutgoing = ALL_STATES.filter(
    (state) => allowedEvents(state).length === 0,
  );
  assert.deepEqual(noOutgoing, TERMINAL_STATES);
  // And the transition table agrees: no edge leaves a terminal state.
  for (const edge of transitionTable()) {
    assert.equal(
      isTerminal(edge.from),
      false,
      `edge leaves terminal state ${edge.from}`,
    );
  }
});

test("unknown state fails closed", () => {
  assert.throws(
    () => isTerminal("RELEASEDD" as EscrowState),
    /invalid isTerminal: unknown state "RELEASEDD"/,
  );
});

test("lowercase state name fails closed (states are case-sensitive)", () => {
  assert.throws(
    () => isTerminal("funded" as EscrowState),
    /invalid isTerminal: unknown state "funded"/,
  );
});

test("empty string fails closed", () => {
  assert.throws(
    () => isTerminal("" as EscrowState),
    /invalid isTerminal: unknown state ""/,
  );
});

test("non-string value fails closed", () => {
  assert.throws(
    () => isTerminal(42 as unknown as EscrowState),
    /invalid isTerminal: unknown state "42"/,
  );
});
