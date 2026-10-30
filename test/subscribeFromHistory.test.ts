/**
 * Escrow.fromHistory rebuild carries zero subscribers (backlog #734).
 *
 * Subscriptions are in-memory only: they live in the listener list of the
 * live instance, never in the audit log. The dataquest side already pins
 * this for `TaskLifecycle.fromHistory` (its `subscribe.test.ts` asserts a
 * rebuilt `listenerCount` of 0); the escrow side only pinned the
 * toJSON/fromJSON round-trip, leaving the event-sourcing rebuild
 * unbacked — while the `fromHistory` JSDoc itself promises "zero
 * listeners". These tests close that asymmetry.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Escrow } from "../src/index.js";

test("fromHistory: rebuild starts with zero listeners; source listener is not carried over", () => {
  const source = new Escrow("sub-from-history-1");
  let sourceCalls = 0;
  source.subscribe(() => {
    sourceCalls++;
  });
  source.dispatch("FUND", undefined, 1000);
  assert.equal(sourceCalls, 1);
  assert.equal(source.listenerCount, 1);

  const rebuilt = Escrow.fromHistory(source.id, source.history);
  assert.equal(rebuilt.listenerCount, 0);
  assert.equal(rebuilt.state, "FUNDED");
  // Field-level history check, not deepEqual: fromHistory re-parses the
  // log, so keys that were explicitly `undefined` on the live entries
  // (here: `note`) are absent on the rebuilt entries. That parse
  // asymmetry is out of scope for the subscription contract pinned here.
  assert.equal(rebuilt.history.length, source.history.length);
  assert.equal(rebuilt.history[0].seq, source.history[0].seq);
  assert.equal(rebuilt.history[0].event, source.history[0].event);
  assert.equal(rebuilt.history[0].from, source.history[0].from);
  assert.equal(rebuilt.history[0].to, source.history[0].to);

  // A dispatch on the rebuilt escrow must not notify the source's listener.
  rebuilt.dispatch("SUBMIT_MILESTONE");
  assert.equal(sourceCalls, 1);
  assert.equal(rebuilt.listenerCount, 0);
});

test("fromHistory: a listener subscribed after rebuild receives only post-rebuild dispatches", () => {
  const source = new Escrow("sub-from-history-2");
  let sourceCalls = 0;
  source.subscribe(() => {
    sourceCalls++;
  });
  source.dispatch("FUND", undefined, 1000);
  assert.equal(sourceCalls, 1);

  const rebuilt = Escrow.fromHistory(source.id, source.history);
  const seen: string[] = [];
  rebuilt.subscribe((event, from, to) => {
    seen.push(`${event}:${from}->${to}`);
  });
  assert.equal(rebuilt.listenerCount, 1);

  rebuilt.dispatch("SUBMIT_MILESTONE");
  rebuilt.dispatch("VERIFY_PASS");
  assert.deepEqual(seen, [
    "SUBMIT_MILESTONE:FUNDED->MILESTONE_SUBMITTED",
    "VERIFY_PASS:MILESTONE_SUBMITTED->VERIFIED",
  ]);
  // The source listener observed only the source's own FUND, never the
  // rebuilt instance's dispatches.
  assert.equal(sourceCalls, 1);
});

test("fromHistory: several source listeners all stay behind on rebuild", () => {
  const source = new Escrow("sub-from-history-3");
  let a = 0;
  let b = 0;
  source.subscribe(() => {
    a++;
  });
  source.subscribe(() => {
    b++;
  });
  source.dispatch("FUND", undefined, 500);
  assert.equal(a, 1);
  assert.equal(b, 1);
  assert.equal(source.listenerCount, 2);

  const rebuilt = Escrow.fromHistory(source.id, source.history);
  assert.equal(rebuilt.listenerCount, 0);
  rebuilt.dispatch("SUBMIT_MILESTONE");
  assert.equal(a, 1);
  assert.equal(b, 1);
});
