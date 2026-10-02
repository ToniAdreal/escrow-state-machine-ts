import test from "node:test";
import assert from "node:assert/strict";
import { Escrow, allowedEvents, transition } from "../src/index.js";

test("happy path: fund -> submit -> verify -> release", () => {
  const e = new Escrow("cmp-2026-042");
  assert.equal(e.state, "CREATED");
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE", "deliverable URLs + IPFS hash");
  e.dispatch("VERIFY_PASS", "KPI thresholds met");
  e.dispatch("RELEASE");
  assert.equal(e.state, "RELEASED");
  assert.equal(e.isTerminal, true);
  assert.equal(e.history.length, 4);
  assert.deepEqual(
    e.history.map((h) => h.to),
    ["FUNDED", "MILESTONE_SUBMITTED", "VERIFIED", "RELEASED"],
  );
  // history is append-only with sequence numbers
  assert.deepEqual(
    e.history.map((h) => h.seq),
    [1, 2, 3, 4],
  );
});

test("dispute path: failed verification -> arbitration -> refund", () => {
  const e = new Escrow("cmp-2026-043");
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_FAIL", "metrics below KPI threshold");
  assert.equal(e.state, "DISPUTED");
  e.dispatch("ARBITRATE_REFUND", "5/9 Safe multi-sig decision");
  assert.equal(e.state, "REFUNDED");
  assert.equal(e.isTerminal, true);
});

test("dispute path: arbitration can also release to creator", () => {
  const e = new Escrow("cmp-2026-044");
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("DISPUTE", "creator contests rejection");
  e.dispatch("ARBITRATE_RELEASE", "evidence accepted");
  assert.equal(e.state, "RELEASED");
});

test("expiry: no milestone before deadline -> expired", () => {
  const e = new Escrow("cmp-2026-045");
  e.dispatch("FUND");
  e.dispatch("EXPIRE", "milestone deadline passed");
  assert.equal(e.state, "EXPIRED");
  assert.equal(e.isTerminal, true);
});

test("invalid transitions throw", () => {
  const e = new Escrow("cmp-2026-046");
  assert.throws(() => e.dispatch("RELEASE"), /invalid transition/);
  e.dispatch("FUND");
  assert.throws(() => e.dispatch("FUND"), /invalid transition/);
  assert.throws(() => e.dispatch("ARBITRATE_REFUND"), /invalid transition/);
});

test("terminal states accept no further events", () => {
  const e = new Escrow("cmp-2026-047");
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  for (const evt of [
    "FUND",
    "DISPUTE",
    "EXPIRE",
  ] as const) {
    assert.throws(() => e.dispatch(evt), /invalid transition/);
  }
});

test("pure transition function + allowed events", () => {
  assert.equal(transition("FUNDED", "SUBMIT_MILESTONE"), "MILESTONE_SUBMITTED");
  assert.deepEqual(allowedEvents("VERIFIED"), ["RELEASE", "DISPUTE"]);
  assert.deepEqual(allowedEvents("RELEASED"), []);
});
