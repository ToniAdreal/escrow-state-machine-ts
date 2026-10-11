import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  allowedEvents,
  transition,
  transitionTable,
  transitionTableJson,
  type EscrowEvent,
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

const ALL_EVENTS: EscrowEvent[] = [
  "FUND",
  "SUBMIT_MILESTONE",
  "VERIFY_PASS",
  "VERIFY_FAIL",
  "RELEASE",
  "DISPUTE",
  "ARBITRATE_RELEASE",
  "ARBITRATE_REFUND",
  "EXPIRE",
];

const TERMINAL_STATES: EscrowState[] = ["RELEASED", "REFUNDED", "EXPIRED"];

function snapshotPath(): string {
  // Tests run compiled from dist/test/, so the repo root is two up.
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  return join(root, "test", "__snapshots__", "transitionTable.snapshot.json");
}

test("transition table matches the committed JSON snapshot (no accidental edits)", () => {
  const snapshot = readFileSync(snapshotPath(), "utf8");
  assert.equal(transitionTableJson(), snapshot);
  // Belt and suspenders: structured comparison, not just string equality.
  assert.deepEqual(JSON.parse(snapshot), transitionTable());
  // The snapshot is machine-generated; guard its shape by hand-count too.
  assert.equal(transitionTable().length, 14);
});

test("transitionTableJson is deterministic with pinned key order", () => {
  assert.equal(transitionTableJson(), transitionTableJson());
  for (const edge of JSON.parse(transitionTableJson())) {
    assert.deepEqual(Object.keys(edge), ["from", "event", "to"]);
  }
  // Canonical form: 2-space indent and exactly one trailing newline.
  assert.ok(transitionTableJson().endsWith("]\n"));
  assert.ok(!transitionTableJson().endsWith("]\n\n"));
});

test("allowedEvents(state) covers every event of every state, with no extras", () => {
  const edges = transitionTable();
  assert.equal(ALL_STATES.length, 8);
  for (const state of ALL_STATES) {
    const fromTable: EscrowEvent[] = edges
      .filter((e) => e.from === state)
      .map((e) => e.event);
    assert.deepEqual(allowedEvents(state), fromTable, `state ${state}`);
  }
});

test("snapshot edges agree with transition() on every state/event pair", () => {
  const edges = transitionTable();
  const edgeKeys = new Set(edges.map((e) => `${e.from}:${e.event}`));
  assert.equal(edgeKeys.size, edges.length, "no duplicate (from, event) edges");
  for (const edge of edges) {
    assert.equal(
      transition(edge.from, edge.event),
      edge.to,
      `edge ${edge.from} --${edge.event}--> ${edge.to}`,
    );
  }
  // No missing or extra edges: transition() succeeds exactly on table edges.
  for (const state of ALL_STATES) {
    for (const event of ALL_EVENTS) {
      if (edgeKeys.has(`${state}:${event}`)) continue;
      assert.throws(
        () => transition(state, event),
        /invalid transition/,
        `${event} from ${state} must not be a table edge`,
      );
    }
  }
  // Terminal states have no outgoing edges.
  for (const state of TERMINAL_STATES) {
    assert.equal(edges.filter((e) => e.from === state).length, 0, state);
    assert.deepEqual(allowedEvents(state), [], state);
  }
});
