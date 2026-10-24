/**
 * expireOverdueEscrows carries the EXPIRE audit entry on success (#564).
 *
 * Before this change `ExpireOverdueResult` was only
 * `{ escrow, expired, error }` — the escrow-side mirror of the dataquest
 * gap fixed by #544, which added `entry` to dataquest's
 * `ExpireOverdueResult`. An expiry operations report still had to
 * re-read `escrow.history` to find the appended EXPIRE entry. Now a
 * successful outcome carries `entry`: a frozen, detached copy of the
 * escrow's last history entry, taken after the dispatch. Failures
 * leave the field absent, so the result shape stays backward
 * compatible.
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

function overdue(id: string): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 1000, { at: FUND_AT });
  escrow.setDeadline(DEADLINE);
  return escrow;
}

function verifiedOverdue(id: string): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "deposit", 1000, { at: FUND_AT });
  escrow.dispatch("SUBMIT_MILESTONE", "done", undefined, {
    at: new Date("2026-02-01T00:00:00.000Z"),
  });
  escrow.dispatch("VERIFY_PASS", undefined, undefined, {
    at: new Date("2026-03-01T00:00:00.000Z"),
  });
  escrow.setDeadline(DEADLINE);
  return escrow;
}

describe("expireOverdueEscrows result carries the EXPIRE audit entry", () => {
  it("a successful outcome's entry matches the history's last entry field by field", () => {
    const escrow = overdue("entry-match");
    const results = expireOverdueEscrows([escrow], NOW);
    const result = results[0];
    assert.equal(result.expired, true);
    const last = escrow.history[escrow.history.length - 1];
    assert.deepEqual(result.entry, last);
    assert.equal(result.entry?.seq, 2);
    assert.equal(result.entry?.event, "EXPIRE");
    assert.equal(result.entry?.from, "FUNDED");
    assert.equal(result.entry?.to, "EXPIRED");
    assert.equal(result.entry?.at, NOW.toISOString());
    assert.ok(verifyHistoryChain(escrow.history));
  });

  it("a failed outcome carries no entry field at all", () => {
    const verified = verifiedOverdue("entry-absent");
    const results = expireOverdueEscrows([verified], NOW);
    const result = results[0];
    assert.equal(result.expired, false);
    assert.match(result.error ?? "", /invalid transition: EXPIRE from VERIFIED/);
    assert.equal("entry" in result, false);
    assert.equal(verified.state, "VERIFIED");
  });

  it("entry.at equals the screening now (#552 pinning, via the result itself)", () => {
    const escrow = overdue("entry-pinned");
    const results = expireOverdueEscrows([escrow], NOW);
    assert.equal(results[0].entry?.at, NOW.toISOString());
    assert.equal(
      results[0].entry?.at,
      escrow.history[escrow.history.length - 1].at,
    );
  });

  it("the entry is frozen and detached from the live history", () => {
    const escrow = overdue("entry-detached");
    const results = expireOverdueEscrows([escrow], NOW);
    const entry = results[0].entry!;
    assert.ok(Object.isFrozen(entry), "entry must be frozen");
    // Each history read builds fresh copies, so the result's entry is
    // a different object from a later read of the same audit record —
    // mutating (or replacing) one cannot touch the other.
    const fresh = escrow.history[escrow.history.length - 1];
    assert.notEqual(entry, fresh);
    assert.deepEqual(entry, fresh);
    assert.equal(escrow.history.length, 2);
    assert.equal(escrow.state, "EXPIRED");
  });

  it("a mixed batch gives entries only to its successes, in batch order", () => {
    const ok = overdue("batch-ok");
    const bad = verifiedOverdue("batch-bad");
    const results = expireOverdueEscrows([ok, bad], NOW);
    assert.equal(results.length, 2);
    assert.equal(results[0].expired, true);
    assert.equal(results[0].entry?.event, "EXPIRE");
    assert.equal(results[0].entry?.to, "EXPIRED");
    assert.equal(results[1].expired, false);
    assert.equal("entry" in results[1], false);
  });

  it("an empty batch still returns an empty list, unchanged", () => {
    assert.deepEqual(expireOverdueEscrows([], NOW), []);
  });
});
