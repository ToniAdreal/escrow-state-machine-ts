/**
 * StaleEscrowActionResult.entry (backlog #573).
 *
 * Mirrors dataquest's StaleActionResult.entry (#571) on the escrow
 * side, where there is no default action: `actOnStaleEscrows()`
 * fills `entry` with a frozen, detached copy of the audit entry the
 * successful action appended (history growth across the action is the
 * test), leaves it absent for notify-only actions that appended
 * nothing, and leaves it absent for failed actions — even when the
 * action dispatched and then threw.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Escrow, actOnStaleEscrows } from "../src/index.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const DAY = 24 * 3600_000;
const iso = (d: Date): string => d.toISOString();
const daysAgo = (n: number): string => iso(new Date(NOW.getTime() - n * DAY));

function fundedAt(id: string, at: string): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 1000, { at });
  return escrow;
}

const BUDGET = { FUNDED: 7 * DAY };

describe("actOnStaleEscrows entry", () => {
  it("dispatch action success: entry is the appended audit entry, frozen", () => {
    const escrow = fundedAt("stale", daysAgo(30));
    const [result] = actOnStaleEscrows(
      [escrow],
      (e) => e.dispatch("EXPIRE"),
      BUDGET,
      NOW
    );
    assert.equal(result.acted, true);
    assert.equal(result.error, undefined);
    const last = escrow.history[escrow.history.length - 1];
    assert.deepEqual(result.entry, last);
    assert.equal(result.entry?.event, "EXPIRE");
    assert.equal(result.entry?.from, "FUNDED");
    assert.equal(result.entry?.to, "EXPIRED");
    assert.ok(Object.isFrozen(result.entry));
  });

  it("entry describes the action itself, not the pre-action last entry", () => {
    const escrow = fundedAt("stale", daysAgo(30));
    const before = escrow.history[escrow.history.length - 1];
    assert.equal(before.event, "FUND");
    const [result] = actOnStaleEscrows(
      [escrow],
      (e) => e.dispatch("SUBMIT_MILESTONE"),
      BUDGET,
      NOW
    );
    assert.equal(result.entry?.event, "SUBMIT_MILESTONE");
    assert.equal(result.entry?.seq, before.seq + 1);
  });

  it("custom dispatch action also carries its entry", () => {
    const escrow = fundedAt("stale", daysAgo(30));
    const [result] = actOnStaleEscrows(
      [escrow],
      (e) => e.dispatch("SUBMIT_MILESTONE", "milestone filed"),
      BUDGET,
      NOW
    );
    assert.equal(result.acted, true);
    assert.deepEqual(result.entry, escrow.history[escrow.history.length - 1]);
    assert.equal(result.entry?.note, "milestone filed");
  });

  it("multi-dispatch action: entry is the last appended entry", () => {
    const escrow = fundedAt("stale", daysAgo(30));
    const [result] = actOnStaleEscrows(
      [escrow],
      (e) => {
        e.dispatch("SUBMIT_MILESTONE");
        e.dispatch("VERIFY_PASS");
      },
      BUDGET,
      NOW
    );
    assert.equal(escrow.state, "VERIFIED");
    assert.equal(result.entry?.event, "VERIFY_PASS");
    assert.equal(result.entry?.to, "VERIFIED");
    assert.deepEqual(result.entry, escrow.history[escrow.history.length - 1]);
  });

  it("notify-only action success: no entry field", () => {
    const escrow = fundedAt("stale", daysAgo(30));
    const seen: string[] = [];
    const [result] = actOnStaleEscrows(
      [escrow],
      (e) => seen.push(e.id),
      BUDGET,
      NOW
    );
    assert.equal(result.acted, true);
    assert.equal("entry" in result, false);
    assert.equal(escrow.history.length, 1);
    assert.deepEqual(seen, ["stale"]);
  });

  it("failed action: no entry and history untouched", () => {
    const escrow = fundedAt("stale", daysAgo(30));
    const [result] = actOnStaleEscrows(
      [escrow],
      () => {
        throw new Error("notify backend down");
      },
      BUDGET,
      NOW
    );
    assert.equal(result.acted, false);
    assert.equal(result.error, "notify backend down");
    assert.equal("entry" in result, false);
    assert.equal(escrow.history.length, 1);
  });

  it("dispatch-then-throw failure: still no entry, even though history grew", () => {
    const escrow = fundedAt("stale", daysAgo(30));
    const [result] = actOnStaleEscrows(
      [escrow],
      (e) => {
        e.dispatch("EXPIRE");
        throw new Error("post-dispatch crash");
      },
      BUDGET,
      NOW
    );
    assert.equal(result.acted, false);
    assert.equal("entry" in result, false);
    // The dispatch itself is not rolled back; only the result omits it.
    assert.equal(escrow.history.length, 2);
    assert.equal(escrow.state, "EXPIRED");
  });

  it("entry is detached: mutating it throws and leaves the audit trail intact", () => {
    const escrow = fundedAt("stale", daysAgo(30));
    const [result] = actOnStaleEscrows(
      [escrow],
      (e) => e.dispatch("EXPIRE"),
      BUDGET,
      NOW
    );
    assert.throws(() => {
      (result.entry as { event: string }).event = "FUND";
    }, TypeError);
    const last = escrow.history[escrow.history.length - 1];
    assert.equal(last.event, "EXPIRE");
    assert.notEqual(result.entry, last);
  });

  it("empty batch is unchanged", () => {
    assert.deepEqual(actOnStaleEscrows([], () => {}, BUDGET, NOW), []);
  });

  it("mixed batch: successes carry entries, failures do not, order preserved", () => {
    const good = fundedAt("good", daysAgo(30));
    const bad = fundedAt("bad", daysAgo(25));
    const notifyOnly = fundedAt("notify", daysAgo(20));
    const results = actOnStaleEscrows(
      [good, bad, notifyOnly],
      (e) => {
        if (e.id === "bad") throw new Error("boom");
        if (e.id === "notify") return;
        e.dispatch("EXPIRE");
      },
      BUDGET,
      NOW
    );
    assert.deepEqual(
      results.map((r) => r.escrow.id),
      ["good", "bad", "notify"]
    );
    assert.equal(results[0].entry?.event, "EXPIRE");
    assert.equal("entry" in results[1], false);
    assert.equal("entry" in results[2], false);
  });
});
