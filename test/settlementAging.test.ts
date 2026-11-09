/**
 * Settlement funding aging buckets (backlog #992).
 *
 * Finance ops needs a "how long has this locked money sat
 * unreleased" view to chase stale settlements first: `settlementAging`
 * buckets every funded, non-terminal escrow by whole days since its
 * most recent FUND entry, mirroring the dataquest lifecycle's
 * `payoutAging` (same four buckets, same pinned 7/30-day endpoints).
 * Terminal escrows are settled and never appear; a non-terminal
 * escrow with no FUND entry lands in `unknown` instead of being
 * silently dropped.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Escrow, settlementAging } from "../src/index.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const DAY = 24 * 3600_000;
const iso = (d: Date): string => d.toISOString();
const daysAgo = (n: number): string => iso(new Date(NOW.getTime() - n * DAY));

/** Escrow funded at a fixed time (deterministic age). */
function fundedAt(id: string, at: string): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 1000, { at });
  return escrow;
}

/** Escrow funded `fundDays` ago, then topped up `topupDays` ago. */
function toppedUpAt(id: string, fundDays: number, topupDays: number): Escrow {
  const escrow = fundedAt(id, daysAgo(fundDays));
  escrow.dispatch("FUND", "top-up", 500, { at: daysAgo(topupDays) });
  return escrow;
}

function releasedAt(id: string, fundDays: number): Escrow {
  const escrow = fundedAt(id, daysAgo(fundDays));
  escrow.dispatch("SUBMIT_MILESTONE");
  escrow.dispatch("VERIFY_PASS");
  escrow.dispatch("RELEASE");
  return escrow;
}

function refundedAt(id: string, fundDays: number): Escrow {
  const escrow = fundedAt(id, daysAgo(fundDays));
  escrow.dispatch("DISPUTE", "buyer claims non-delivery");
  escrow.dispatch("ARBITRATE_REFUND");
  return escrow;
}

function expiredAt(id: string, fundDays: number): Escrow {
  const escrow = fundedAt(id, daysAgo(fundDays));
  escrow.dispatch("EXPIRE");
  return escrow;
}

function disputedAt(id: string, fundDays: number): Escrow {
  const escrow = fundedAt(id, daysAgo(fundDays));
  escrow.dispatch("DISPUTE", "buyer claims non-delivery");
  return escrow;
}

function verifiedAt(id: string, fundDays: number): Escrow {
  const escrow = fundedAt(id, daysAgo(fundDays));
  escrow.dispatch("SUBMIT_MILESTONE");
  escrow.dispatch("VERIFY_PASS");
  return escrow;
}

describe("settlementAging", () => {
  it("buckets by whole days: under 7, 7-29, 30+", () => {
    const fresh = fundedAt("fresh", daysAgo(3));
    const week = fundedAt("week", daysAgo(10));
    const stale = fundedAt("stale", daysAgo(45));
    const result = settlementAging([fresh, week, stale], NOW);
    assert.deepEqual(result.under7Days, [{ id: "fresh", ageDays: 3 }]);
    assert.deepEqual(result.days7To30, [{ id: "week", ageDays: 10 }]);
    assert.deepEqual(result.over30Days, [{ id: "stale", ageDays: 45 }]);
    assert.deepEqual(result.unknown, []);
  });

  it("pinned endpoints: exactly 7 days lands in days7To30, exactly 30 in over30Days", () => {
    const seven = fundedAt("seven", daysAgo(7));
    const thirty = fundedAt("thirty", daysAgo(30));
    const result = settlementAging([seven, thirty], NOW);
    assert.deepEqual(result.days7To30, [{ id: "seven", ageDays: 7 }]);
    assert.deepEqual(result.over30Days, [{ id: "thirty", ageDays: 30 }]);
  });

  it("just inside the boundaries: 6 days stays under7Days, 29 days stays days7To30", () => {
    const six = fundedAt("six", daysAgo(6));
    const twentyNine = fundedAt("twenty-nine", daysAgo(29));
    const result = settlementAging([six, twentyNine], NOW);
    assert.deepEqual(result.under7Days, [{ id: "six", ageDays: 6 }]);
    assert.deepEqual(result.days7To30, [{ id: "twenty-nine", ageDays: 29 }]);
  });

  it("a never-funded (CREATED) escrow goes to unknown, not any age bucket", () => {
    const created = new Escrow("created");
    const funded = fundedAt("funded", daysAgo(2));
    const result = settlementAging([created, funded], NOW);
    assert.deepEqual(result.unknown, [{ id: "created" }]);
    assert.deepEqual(result.under7Days, [{ id: "funded", ageDays: 2 }]);
  });

  it("terminal escrows never appear in any bucket, however old their funding", () => {
    const released = releasedAt("released", 90);
    const refunded = refundedAt("refunded", 90);
    const expired = expiredAt("expired", 90);
    const funded = fundedAt("funded", daysAgo(90));
    const result = settlementAging(
      [released, refunded, expired, funded],
      NOW,
    );
    assert.deepEqual(result.over30Days, [{ id: "funded", ageDays: 90 }]);
    assert.deepEqual(result.under7Days, []);
    assert.deepEqual(result.days7To30, []);
    assert.deepEqual(result.unknown, []);
  });

  it("non-FUNDED live states age from their last FUND: DISPUTED and VERIFIED included", () => {
    const disputed = disputedAt("disputed", 12);
    const verified = verifiedAt("verified", 40);
    const result = settlementAging([disputed, verified], NOW);
    assert.deepEqual(result.days7To30, [{ id: "disputed", ageDays: 12 }]);
    assert.deepEqual(result.over30Days, [{ id: "verified", ageDays: 40 }]);
  });

  it("a top-up re-ages the escrow: age counts from the most recent FUND", () => {
    const topped = toppedUpAt("topped", 40, 2);
    const result = settlementAging([topped], NOW);
    assert.deepEqual(result.under7Days, [{ id: "topped", ageDays: 2 }]);
    assert.deepEqual(result.days7To30, []);
    assert.deepEqual(result.over30Days, []);
  });

  it("ageDays is the floored day difference against the FUND entry's at", () => {
    // 10 days and 12 hours ago floors to 10 whole days, not 11.
    const half = fundedAt(
      "half",
      new Date(NOW.getTime() - 10 * DAY - 12 * 3600_000).toISOString(),
    );
    const result = settlementAging([half], NOW);
    assert.deepEqual(result.days7To30, [{ id: "half", ageDays: 10 }]);
  });

  it("a funding timestamp in the future counts as 0 days, never negative", () => {
    const future = fundedAt(
      "future",
      new Date(NOW.getTime() + 2 * DAY).toISOString(),
    );
    const result = settlementAging([future], NOW);
    assert.deepEqual(result.under7Days, [{ id: "future", ageDays: 0 }]);
  });

  it("input order is kept within each bucket", () => {
    const a = fundedAt("a", daysAgo(2));
    const b = fundedAt("b", daysAgo(5));
    const c = fundedAt("c", daysAgo(1));
    const result = settlementAging([c, a, b], NOW);
    assert.deepEqual(
      result.under7Days.map((e) => e.id),
      ["c", "a", "b"],
    );
    assert.deepEqual(
      result.under7Days.map((e) => e.ageDays),
      [1, 2, 5],
    );
  });

  it("an invalid now fails fast instead of returning an empty result", () => {
    const funded = fundedAt("funded", daysAgo(2));
    assert.throws(
      () => settlementAging([funded], new Date("not-a-date")),
      /invalid now: expected a valid Date/,
    );
    assert.throws(
      () => settlementAging([funded], new Date(Number.NaN)),
      /invalid now: expected a valid Date/,
    );
  });

  it("is pure: escrows and the input array are untouched", () => {
    const funded = fundedAt("funded", daysAgo(9));
    const created = new Escrow("created");
    const batch = [funded, created];
    const before = funded.history.length;
    settlementAging(batch, NOW);
    assert.equal(funded.state, "FUNDED");
    assert.equal(funded.history.length, before);
    assert.equal(created.state, "CREATED");
    assert.deepEqual(
      batch.map((e) => e.id),
      ["funded", "created"],
    );
  });

  it("an empty batch returns four empty buckets", () => {
    assert.deepEqual(settlementAging([], NOW), {
      under7Days: [],
      days7To30: [],
      over30Days: [],
      unknown: [],
    });
  });
});
