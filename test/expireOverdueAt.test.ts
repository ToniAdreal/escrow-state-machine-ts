/**
 * expireOverdueEscrows pins the screening `now` as each EXPIRE entry's
 * `at` (#552).
 *
 * Before this fix the executor dispatched `EXPIRE` with no `at`, so the
 * appended audit entry carried the dispatch-time wall clock: the same
 * screening `now` produced jittered entries across the batch, and fixed-
 * `now` tests/replays could not pin them. Now `dispatch("EXPIRE",
 * undefined, undefined, { at: now })` nails every entry to the
 * screening instant. The pin inherits dispatch's no-backward-clock
 * rule, so a backdated `now` lands as a per-escrow error and the batch
 * continues.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  expireOverdueEscrows,
  verifyHistoryChain,
} from "../src/index.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const FUND_AT = new Date("2026-01-01T00:00:00.000Z");
const DEADLINE = new Date("2026-01-15T00:00:00.000Z");

function overdue(id: string, fundAt: Date = FUND_AT): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 1000, { at: fundAt });
  escrow.setDeadline(DEADLINE);
  return escrow;
}

describe("expireOverdueEscrows pins screening now as EXPIRE entry at", () => {
  it("the EXPIRE entry's at is byte-identical to the screening now", () => {
    const escrow = overdue("pinned");
    const results = expireOverdueEscrows([escrow], NOW);
    assert.equal(results[0].expired, true);
    const entry = escrow.history[escrow.history.length - 1];
    assert.equal(entry.event, "EXPIRE");
    assert.equal(entry.at, NOW.toISOString());
  });

  it("a whole batch carries the same identical at across escrows", () => {
    const batch = ["e1", "e2", "e3", "e4", "e5"].map((id) => overdue(id));
    const results = expireOverdueEscrows(batch, NOW);
    assert.equal(results.filter((r) => r.expired).length, 5);
    const ats = batch.map((e) => e.history[e.history.length - 1].at);
    assert.ok(ats.every((at) => at === NOW.toISOString()));
  });

  it("sub-second precision is preserved exactly", () => {
    const precise = new Date("2026-06-01T12:34:56.789Z");
    const escrow = overdue("precise");
    expireOverdueEscrows([escrow], precise);
    const entry = escrow.history[escrow.history.length - 1];
    assert.equal(entry.at, "2026-06-01T12:34:56.789Z");
  });

  it("two runs on fresh batches replay byte-identically", () => {
    const run = () => {
      const escrow = overdue("replay");
      expireOverdueEscrows([escrow], NOW);
      return escrow.history[escrow.history.length - 1].at;
    };
    assert.equal(run(), run());
    assert.equal(run(), NOW.toISOString());
  });

  it("a past screening now expires deterministically (no wall-clock leak)", () => {
    // Everything lives in the past relative to the wall clock: the
    // screening `now` pins the entry, and the wall clock stays out.
    const escrow = new Escrow("past-screening");
    escrow.dispatch("FUND", "initial deposit", 1000, {
      at: new Date("2025-01-01T00:00:00.000Z"),
    });
    escrow.setDeadline(new Date("2025-06-01T00:00:00.000Z"));
    const pastNow = new Date("2025-12-31T00:00:00.000Z");
    const results = expireOverdueEscrows([escrow], pastNow);
    assert.equal(results[0].expired, true);
    const entry = escrow.history[escrow.history.length - 1];
    assert.equal(entry.event, "EXPIRE");
    assert.equal(entry.at, pastNow.toISOString());
    assert.ok(verifyHistoryChain(escrow.history));
  });

  it("a now earlier than an escrow's last entry lands as a per-item error", () => {
    // Deadline before the screening now, but history AFTER the
    // screening now: the escrow is overdue (deadline passed) yet the
    // pinned `at` would move the audit clock backwards.
    const escrow = new Escrow("time-warp");
    escrow.dispatch("FUND", "initial deposit", 1000, {
      at: new Date("2026-07-01T00:00:00.000Z"),
    });
    // Deadline before the screening now (so the escrow IS overdue), but
    // the history is after it: pinning `now` would move the audit
    // clock backwards.
    escrow.setDeadline(new Date("2026-05-15T00:00:00.000Z"));
    const companion = overdue("companion");
    const results = expireOverdueEscrows([escrow, companion], NOW);
    assert.equal(results.length, 2);
    const warped = results.find((r) => r.escrow.id === "time-warp")!;
    assert.equal(warped.expired, false);
    assert.match(
      warped.error ?? "",
      /is earlier than the previous entry's at/
    );
    assert.equal(escrow.state, "FUNDED"); // untouched
    // The batch continued past the failure.
    const ok = results.find((r) => r.escrow.id === "companion")!;
    assert.equal(ok.expired, true);
    assert.equal(
      companion.history[companion.history.length - 1].at,
      NOW.toISOString()
    );
  });

  it("VERIFIED overdue escrows still fail with invalid transition", () => {
    const verified = new Escrow("verified");
    verified.dispatch("FUND", "deposit", 1000, { at: FUND_AT });
    verified.dispatch("SUBMIT_MILESTONE", "done", undefined, {
      at: new Date("2026-02-01T00:00:00.000Z"),
    });
    verified.dispatch("VERIFY_PASS", undefined, undefined, {
      at: new Date("2026-03-01T00:00:00.000Z"),
    });
    verified.setDeadline(DEADLINE);
    const results = expireOverdueEscrows([verified], NOW);
    assert.equal(results[0].expired, false);
    assert.match(
      results[0].error ?? "",
      /invalid transition: EXPIRE from VERIFIED/
    );
  });

  it("the pinned entries still pass verifyHistoryChain", () => {
    const batch = ["c1", "c2", "c3"].map((id) => overdue(id));
    expireOverdueEscrows(batch, NOW);
    for (const escrow of batch) {
      assert.equal(verifyHistoryChain(escrow.history), true);
    }
  });

  it("the pinned at is canonical ISO-8601 and never a wall-clock artifact", () => {
    const escrow = overdue("canonical");
    expireOverdueEscrows([escrow], NOW);
    const entry = escrow.history[escrow.history.length - 1];
    assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // Not "sometime around now": the test clock and the wall clock are
    // months apart, so a wall-clock leak would show up here.
    assert.ok(
      Math.abs(Date.parse(entry.at) - Date.now()) > 30 * 24 * 3600_000,
      "pinned at must not come from the wall clock"
    );
  });

  it("terminal escrows are still skipped entirely", () => {
    const escrow = overdue("terminal");
    expireOverdueEscrows([escrow], NOW);
    assert.equal(escrow.state, "EXPIRED");
    const historyLen = escrow.history.length;
    const second = expireOverdueEscrows([escrow], NOW);
    assert.deepEqual(second, []);
    assert.equal(escrow.history.length, historyLen);
  });
});
