import test from "node:test";
import assert from "node:assert/strict";
import { transition } from "../src/index.js";

/**
 * `transition` state shape (backlog #1365, mirrors dataquest #1365).
 *
 * The pure transition function is the state machine's core (diagram,
 * CLI and demo all route through it), and until this change it read
 * `TRANSITIONS[state][event]` with no state guard, so a `null` or
 * mistyped state escaped as a bare `TypeError` (`Cannot read
 * properties of undefined (reading 'FUND')`) instead of a named
 * error. Rules under test:
 *  - `null` / `undefined` / a number / an unknown string each throw
 *    the named `invalid transition: unknown state …` error (never a
 *    `TypeError`), with the offending value spelled out
 *  - prototype-chain names such as "toString" are rejected as
 *    unknown states rather than read off `Object.prototype`
 *  - state matching is case-sensitive ("funded" is not "FUNDED")
 *  - a valid state with an illegal event keeps the existing
 *    `invalid transition: <event> from <state>` error, including
 *    terminal states (which have no outgoing edges) and a null event
 *  - every legal edge still returns the same next state
 */

test("null state throws a named error, not a bare TypeError", () => {
  assert.throws(
    () => transition(null as never, "FUND"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof TypeError));
      assert.equal(
        (error as Error).message,
        "invalid transition: unknown state null",
      );
      return true;
    },
  );
});

test("undefined and numeric states throw a named error", () => {
  assert.throws(
    () => transition(undefined as never, "FUND"),
    /invalid transition: unknown state undefined/,
  );
  assert.throws(
    () => transition(42 as never, "FUND"),
    /invalid transition: unknown state 42/,
  );
});

test("unknown string states throw a named error with the value quoted", () => {
  assert.throws(
    () => transition("x" as never, "FUND"),
    /invalid transition: unknown state "x"/,
  );
  assert.throws(
    () => transition("RELEASEDD" as never, "FUND"),
    /invalid transition: unknown state "RELEASEDD"/,
  );
});

test("prototype-chain names are rejected as unknown states", () => {
  assert.throws(
    () => transition("toString" as never, "FUND"),
    /invalid transition: unknown state "toString"/,
  );
  assert.throws(
    () => transition("constructor" as never, "FUND"),
    /invalid transition: unknown state "constructor"/,
  );
});

test("state matching is case-sensitive", () => {
  assert.throws(
    () => transition("funded" as never, "FUND"),
    /invalid transition: unknown state "funded"/,
  );
});

test("terminal states keep the existing invalid-transition error", () => {
  for (const terminal of ["RELEASED", "REFUNDED", "EXPIRED"] as const) {
    assert.throws(
      () => transition(terminal, "FUND"),
      /invalid transition: FUND from (RELEASED|REFUNDED|EXPIRED)/,
    );
  }
});

test("illegal events on valid states keep the existing error", () => {
  assert.throws(
    () => transition("CREATED", "RELEASE"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof TypeError));
      assert.equal(
        (error as Error).message,
        "invalid transition: RELEASE from CREATED",
      );
      return true;
    },
  );
});

test("null event on a valid state keeps the existing error", () => {
  assert.throws(
    () => transition("FUNDED", null as never),
    /invalid transition: null from FUNDED/,
  );
});

test("legal edges still return the same next state", () => {
  assert.equal(transition("CREATED", "FUND"), "FUNDED");
  assert.equal(transition("FUNDED", "FUND"), "FUNDED");
  assert.equal(transition("FUNDED", "SUBMIT_MILESTONE"), "MILESTONE_SUBMITTED");
  assert.equal(transition("MILESTONE_SUBMITTED", "VERIFY_PASS"), "VERIFIED");
  assert.equal(transition("VERIFIED", "RELEASE"), "RELEASED");
  assert.equal(transition("DISPUTED", "ARBITRATE_REFUND"), "REFUNDED");
  assert.equal(transition("CREATED", "EXPIRE"), "EXPIRED");
});
