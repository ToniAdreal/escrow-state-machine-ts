/**
 * Watchdog executors' optional `at` audit-timestamp pin (backlog #1097).
 *
 * dataquest's two watchdog executors already take an independent audit
 * timestamp (`expireOverdueTasks(tasks, now, at?)` /
 * `actOnStaleTasks(tasks, action, maxAgeByState, now, at?)`), but the
 * escrow executors only knew the screening `now`: `expireOverdueEscrows`
 * pinned `now` as every EXPIRE entry's `at` (#552) and
 * `actOnStaleEscrows` left the timestamp entirely to the caller's
 * action. A caller wanting "screen at `now`, stamp the audit trail at
 * another known instant" (deterministic replay, backfilling history)
 * had to bypass both executors and hand-write dispatches. Both
 * executors now take `opts.at?: Date | string`, validated with the
 * same `invalid at: …` bar as dataquest's `resolveWatchdogAt`
 * (Date → toISOString, string must be canonical ISO-8601, anything
 * else fail-fast before any escrow is touched); omitted, the pin
 * stays the screening `now` (the #552 semantic). `actOnStaleEscrows`
 * hands the pin to the action as `context.at`, so a dispatch-style
 * action stamps its entries with it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  actOnStaleEscrows,
  expireOverdueEscrows,
} from "../src/index.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const PIN = new Date("2026-06-15T12:00:00.000Z");
const PIN_ISO = "2026-06-15T12:00:00.000Z";
const DAY = 24 * 3600_000;
const FUND_AT = new Date("2026-01-01T00:00:00.000Z");
const DEADLINE = new Date("2026-01-15T00:00:00.000Z");

function overdue(id: string, fundAt: Date = FUND_AT): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 1000, { at: fundAt });
  escrow.setDeadline(DEADLINE);
  return escrow;
}

function staleFunded(id: string, daysBeforeNow: number): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 1000, {
    at: new Date(NOW.getTime() - daysBeforeNow * DAY),
  });
  return escrow;
}

const BUDGET = { FUNDED: 7 * DAY };

describe("expireOverdueEscrows opts.at pin", () => {
  it("a Date pin stamps every EXPIRE entry with its ISO form", () => {
    const batch = [overdue("e1"), overdue("e2")];
    const results = expireOverdueEscrows(batch, NOW, { at: PIN });
    assert.ok(results.every((r) => r.expired));
    for (const escrow of batch) {
      const entry = escrow.history[escrow.history.length - 1];
      assert.equal(entry.event, "EXPIRE");
      assert.equal(entry.at, PIN_ISO);
    }
    assert.ok(
      results.every((r) => r.entry !== undefined && r.entry.at === PIN_ISO),
    );
  });

  it("a canonical ISO string pin stamps the entry byte-identically", () => {
    const escrow = overdue("e1");
    const results = expireOverdueEscrows([escrow], NOW, { at: PIN_ISO });
    assert.equal(results[0].expired, true);
    assert.equal(escrow.history[escrow.history.length - 1].at, PIN_ISO);
  });

  it("omitted at still pins the screening now (#552 semantic)", () => {
    const escrow = overdue("e1");
    expireOverdueEscrows([escrow], NOW);
    assert.equal(
      escrow.history[escrow.history.length - 1].at,
      NOW.toISOString(),
    );
  });

  it("three illegal at values fail fast and touch zero escrows", () => {
    const badValues: unknown[] = [
      "2026-06-15 12:00:00",
      new Date(NaN),
      123,
    ];
    for (const bad of badValues) {
      const batch = [overdue("e1"), overdue("e2")];
      assert.throws(
        () => expireOverdueEscrows(batch, NOW, { at: bad as never }),
        /invalid at: /,
      );
      for (const escrow of batch) {
        assert.equal(escrow.state, "FUNDED");
        assert.equal(escrow.history.length, 1);
      }
    }
  });

  it("a backdated at fails per escrow and the rest of the batch still expires", () => {
    const backdated = new Date("2025-06-01T00:00:00.000Z");
    const old = overdue("old", new Date("2025-01-01T00:00:00.000Z"));
    // The first escrow's last entry (2026-01-01) postdates the pin;
    // the second escrow's last entry (2025-01-01) predates it.
    const batch = [overdue("new"), old];
    const results = expireOverdueEscrows(batch, NOW, { at: backdated });
    assert.equal(results[0].expired, false);
    assert.match(results[0].error ?? "", /is earlier than the previous entry/);
    assert.equal(batch[0].state, "FUNDED");
    assert.equal(batch[0].history.length, 1);
    assert.equal(results[1].expired, true);
    assert.equal(
      batch[1].history[batch[1].history.length - 1].at,
      backdated.toISOString(),
    );
  });

  it("dry run with an illegal at still fails fast", () => {
    const escrow = overdue("e1");
    assert.throws(
      () => expireOverdueEscrows([escrow], NOW, { at: "not-a-date", dryRun: true }),
      /invalid at: /,
    );
    assert.equal(escrow.state, "FUNDED");
    assert.equal(escrow.history.length, 1);
  });

  it("dry run predicts against the pin: backdated at reports wouldExpire false", () => {
    const backdated = "2025-06-01T00:00:00.000Z";
    const escrow = overdue("e1");
    const results = expireOverdueEscrows([escrow], NOW, {
      at: backdated,
      dryRun: true,
    });
    assert.equal(results[0].expired, false);
    assert.equal(results[0].wouldExpire, false);
    assert.match(results[0].error ?? "", /is earlier than the previous entry/);
    assert.equal(escrow.state, "FUNDED");
    assert.equal(escrow.history.length, 1);
  });
});

describe("actOnStaleEscrows opts.at pin", () => {
  it("the action receives the pinned at and its dispatch stamps it", () => {
    const escrow = staleFunded("s1", 30);
    const seen: string[] = [];
    const results = actOnStaleEscrows(
      [escrow],
      (e, ctx) => {
        seen.push(ctx.at);
        e.dispatch("EXPIRE", undefined, undefined, {
          actor: "system",
          at: ctx.at,
        });
      },
      BUDGET,
      NOW,
      { at: PIN_ISO },
    );
    assert.deepEqual(seen, [PIN_ISO]);
    assert.equal(results[0].acted, true);
    const entry = escrow.history[escrow.history.length - 1];
    assert.equal(entry.event, "EXPIRE");
    assert.equal(entry.at, PIN_ISO);
    assert.equal(results[0].entry?.at, PIN_ISO);
  });

  it("a Date pin is normalized to ISO before reaching the action", () => {
    const escrow = staleFunded("s1", 30);
    const seen: string[] = [];
    actOnStaleEscrows(
      [escrow],
      (e, ctx) => {
        seen.push(ctx.at);
        e.dispatch("EXPIRE", undefined, undefined, {
          actor: "system",
          at: ctx.at,
        });
      },
      BUDGET,
      NOW,
      { at: PIN },
    );
    assert.deepEqual(seen, [PIN_ISO]);
    assert.equal(escrow.history[escrow.history.length - 1].at, PIN_ISO);
  });

  it("omitted at hands the screening now to the action (#552 semantic)", () => {
    const escrow = staleFunded("s1", 30);
    const seen: string[] = [];
    actOnStaleEscrows(
      [escrow],
      (e, ctx) => {
        seen.push(ctx.at);
        e.dispatch("EXPIRE", undefined, undefined, {
          actor: "system",
          at: ctx.at,
        });
      },
      BUDGET,
      NOW,
    );
    assert.deepEqual(seen, [NOW.toISOString()]);
    assert.equal(
      escrow.history[escrow.history.length - 1].at,
      NOW.toISOString(),
    );
  });

  it("an illegal at fails fast before any action runs", () => {
    const escrow = staleFunded("s1", 30);
    let calls = 0;
    assert.throws(
      () =>
        actOnStaleEscrows([escrow], () => calls++, BUDGET, NOW, {
          at: 123 as never,
        }),
      /invalid at: /,
    );
    assert.equal(calls, 0);
    assert.equal(escrow.state, "FUNDED");
    assert.equal(escrow.history.length, 1);
  });

  it("dry run with an illegal at still fails fast", () => {
    const escrow = staleFunded("s1", 30);
    assert.throws(
      () =>
        actOnStaleEscrows([escrow], () => {}, BUDGET, NOW, {
          at: "2026-06-15",
          dryRun: true,
        }),
      /invalid at: /,
    );
    assert.equal(escrow.state, "FUNDED");
    assert.equal(escrow.history.length, 1);
  });
});
