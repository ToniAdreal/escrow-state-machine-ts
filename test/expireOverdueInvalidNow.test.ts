/**
 * expireOverdueEscrows invalid-`now` fail-fast (#1259).
 *
 * Before this fix, an invalid `now` screened nothing (`NaN >= deadline`
 * is false for every escrow) and the executor then threw a bare
 * `RangeError: Invalid time value` from `now.toISOString()` — a
 * confusing error for a caller bug, and one that only surfaced after
 * screening. An invalid `now` must now throw
 * `invalid now: expected a valid Date` at entry, before any escrow
 * is read, screened, or dispatched — same wording as the other
 * watchdog helpers (`nextEscrowDeadline`, `staleEscrows`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Escrow, expireOverdueEscrows } from "../src/index.js";

const FUND_AT = new Date("2026-01-01T00:00:00.000Z");
const DEADLINE = new Date("2026-02-01T00:00:00.000Z");
const NOW = new Date("2026-06-01T00:00:00.000Z");
const AT = "2026-06-01T00:00:00.000Z";

function fundedWithDeadline(id: string): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 1000, { at: FUND_AT });
  escrow.setDeadline(DEADLINE);
  return escrow;
}

const INVALID_NOW = /invalid now: expected a valid Date/;

describe("expireOverdueEscrows invalid now", () => {
  it("new Date(NaN) throws invalid now", () => {
    const escrow = fundedWithDeadline("invalid-nan");
    assert.throws(
      () => expireOverdueEscrows([escrow], new Date(NaN)),
      INVALID_NOW
    );
  });

  it('new Date("not-a-date") throws invalid now', () => {
    const escrow = fundedWithDeadline("invalid-string-date");
    assert.throws(
      () => expireOverdueEscrows([escrow], new Date("not-a-date")),
      INVALID_NOW
    );
  });

  it("an empty batch with an invalid now still throws instead of silently returning []", () => {
    assert.throws(
      () => expireOverdueEscrows([], new Date(NaN)),
      INVALID_NOW
    );
  });

  it("a dry run with an invalid now throws the same way", () => {
    const escrow = fundedWithDeadline("invalid-dry-run");
    assert.throws(
      () => expireOverdueEscrows([escrow], new Date(NaN), { dryRun: true }),
      INVALID_NOW
    );
  });

  it("an invalid now wins over an explicit valid at pin", () => {
    const escrow = fundedWithDeadline("invalid-now-beats-at");
    assert.throws(
      () => expireOverdueEscrows([escrow], new Date(NaN), { at: AT }),
      INVALID_NOW
    );
  });

  it("a non-Date now (string) throws invalid now, not a TypeError", () => {
    const escrow = fundedWithDeadline("invalid-non-date");
    assert.throws(
      () =>
        expireOverdueEscrows(
          [escrow],
          "2026-06-01T00:00:00.000Z" as unknown as Date
        ),
      INVALID_NOW
    );
  });

  it("an invalid now touches zero escrows: state and history are unchanged", () => {
    const escrow = fundedWithDeadline("invalid-untouched");
    const stateBefore = escrow.state;
    const historyBefore = escrow.history;
    const jsonBefore = JSON.stringify(escrow.toJSON());
    assert.throws(
      () => expireOverdueEscrows([escrow], new Date(NaN)),
      INVALID_NOW
    );
    assert.equal(escrow.state, stateBefore);
    assert.deepEqual(escrow.history, historyBefore);
    assert.equal(JSON.stringify(escrow.toJSON()), jsonBefore);
  });

  it("an invalid now is checked after opts shape validation", () => {
    const escrow = fundedWithDeadline("invalid-opts-first");
    assert.throws(
      () =>
        expireOverdueEscrows([escrow], new Date(NaN), {
          dryRun: "yes" as unknown as boolean,
        }),
      /invalid expireOverdueEscrows options: dryRun must be a boolean/
    );
  });

  it("a valid now still expires the overdue escrow and stamps the screening now", () => {
    const escrow = fundedWithDeadline("valid-now-still-works");
    const results = expireOverdueEscrows([escrow], NOW);
    assert.equal(results.length, 1);
    assert.equal(results[0].expired, true);
    assert.equal(results[0].error, undefined);
    assert.equal(escrow.state, "EXPIRED");
    assert.equal(results[0].entry?.at, NOW.toISOString());
  });
});
