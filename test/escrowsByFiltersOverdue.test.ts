/**
 * escrowsByFilters overdue axis (backlog #1048).
 *
 * `escrowsByFilters()` had state/actor/event axes only, so a patrol
 * that wanted "overdue escrows alice touched" had to screen with
 * `expiredEscrows()` and intersect by hand — and the hand-written
 * intersection had no shared answer for the deadline boundary, for
 * terminal escrows, or for an escrow with no deadline at all. The
 * `overdue` axis reuses `isOverdue()`'s rule exactly (past deadline,
 * non-terminal, boundary `now >= deadline` inclusive), with `now`
 * injectable as a third argument so tests pin the screening instant.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Escrow, escrowsByFilters } from "../src/index.js";

const PAST = new Date("2026-01-01T00:00:00.000Z");
const FUTURE = new Date("2027-01-01T00:00:00.000Z");
const NOW = new Date("2026-06-01T00:00:00.000Z");
// Fixture audit timestamps: pinned strictly before NOW.
const FUND_AT = new Date("2026-01-01T00:00:00.000Z");
const SUBMIT_AT = new Date("2026-02-01T00:00:00.000Z");
const VERIFY_AT = new Date("2026-03-01T00:00:00.000Z");
const RELEASE_AT = new Date("2026-04-01T00:00:00.000Z");

function fundedWithDeadline(
  id: string,
  deadline: Date,
  actor?: string,
): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch(
    "FUND",
    "initial deposit",
    1000,
    actor === undefined ? { at: FUND_AT } : { actor, at: FUND_AT },
  );
  escrow.setDeadline(deadline);
  return escrow;
}

function disputedWithDeadline(id: string, deadline: Date): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 1000, { at: FUND_AT });
  escrow.dispatch("DISPUTE", "buyer unhappy", undefined, { at: SUBMIT_AT });
  escrow.setDeadline(deadline);
  return escrow;
}

function releasedWithDeadline(id: string, deadline: Date): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 1000, { at: FUND_AT });
  escrow.dispatch("SUBMIT_MILESTONE", "milestone done", undefined, {
    at: SUBMIT_AT,
  });
  escrow.dispatch("VERIFY_PASS", undefined, undefined, { at: VERIFY_AT });
  escrow.dispatch("RELEASE", undefined, undefined, { at: RELEASE_AT });
  escrow.setDeadline(deadline);
  return escrow;
}

function byId(escrows: Escrow[]): string[] {
  return escrows.map((e) => e.id);
}

describe("escrowsByFilters overdue axis", () => {
  it("overdue:true selects only past-deadline non-terminal escrows", () => {
    const overdue = fundedWithDeadline("overdue", PAST);
    const disputed = disputedWithDeadline("disputed", PAST);
    const notOverdue = fundedWithDeadline("not-overdue", FUTURE);
    const noDeadline = new Escrow("no-deadline");
    noDeadline.dispatch("FUND", "initial deposit", 1000, { at: FUND_AT });
    const released = releasedWithDeadline("released", PAST);

    assert.deepEqual(
      byId(
        escrowsByFilters(
          [overdue, disputed, notOverdue, noDeadline, released],
          { overdue: true },
          NOW,
        ),
      ),
      ["overdue", "disputed"],
    );
  });

  it("a deadline exactly at now counts as overdue (boundary inclusive)", () => {
    const atBoundary = fundedWithDeadline("at-boundary", NOW);
    const justAfter = fundedWithDeadline(
      "just-after",
      new Date(NOW.getTime() + 1),
    );
    assert.deepEqual(
      byId(escrowsByFilters([atBoundary, justAfter], { overdue: true }, NOW)),
      ["at-boundary"],
    );
    assert.deepEqual(
      byId(
        escrowsByFilters([atBoundary, justAfter], { overdue: false }, NOW),
      ),
      ["just-after"],
    );
  });

  it("an escrow with no deadline never matches overdue:true", () => {
    const noDeadline = new Escrow("no-deadline");
    noDeadline.dispatch("FUND", "initial deposit", 1000, { at: FUND_AT });
    assert.deepEqual(
      byId(escrowsByFilters([noDeadline], { overdue: true }, NOW)),
      [],
    );
    assert.deepEqual(
      byId(escrowsByFilters([noDeadline], { overdue: false }, NOW)),
      ["no-deadline"],
    );
  });

  it("a terminal escrow never matches overdue:true even past its deadline", () => {
    const released = releasedWithDeadline("released", PAST);
    assert.deepEqual(
      byId(escrowsByFilters([released], { overdue: true }, NOW)),
      [],
    );
    assert.deepEqual(
      byId(escrowsByFilters([released], { overdue: false }, NOW)),
      ["released"],
    );
  });

  it("overdue:false selects the complement: not overdue, no deadline, terminal", () => {
    const overdue = fundedWithDeadline("overdue", PAST);
    const notOverdue = fundedWithDeadline("not-overdue", FUTURE);
    const noDeadline = new Escrow("no-deadline");
    noDeadline.dispatch("FUND", "initial deposit", 1000, { at: FUND_AT });
    const released = releasedWithDeadline("released", PAST);

    assert.deepEqual(
      byId(
        escrowsByFilters(
          [overdue, notOverdue, noDeadline, released],
          { overdue: false },
          NOW,
        ),
      ),
      ["not-overdue", "no-deadline", "released"],
    );
  });

  it("overdue intersects with the state, actor, and event axes", () => {
    const aliceOverdue = fundedWithDeadline("alice-overdue", PAST, "alice");
    const aliceCurrent = fundedWithDeadline("alice-current", FUTURE, "alice");
    const bobOverdue = fundedWithDeadline("bob-overdue", PAST, "bob");
    const disputed = disputedWithDeadline("disputed", PAST);

    assert.deepEqual(
      byId(
        escrowsByFilters(
          [aliceOverdue, aliceCurrent, bobOverdue, disputed],
          { state: "FUNDED", overdue: true },
          NOW,
        ),
      ),
      ["alice-overdue", "bob-overdue"],
    );
    assert.deepEqual(
      byId(
        escrowsByFilters(
          [aliceOverdue, aliceCurrent, bobOverdue, disputed],
          { actor: "alice", overdue: true },
          NOW,
        ),
      ),
      ["alice-overdue"],
    );
    assert.deepEqual(
      byId(
        escrowsByFilters(
          [aliceOverdue, aliceCurrent, bobOverdue, disputed],
          { event: "DISPUTE", overdue: true },
          NOW,
        ),
      ),
      ["disputed"],
    );
    // A combination no escrow satisfies stays empty instead of
    // degrading to a single-axis answer.
    assert.deepEqual(
      byId(
        escrowsByFilters(
          [aliceOverdue, aliceCurrent, bobOverdue, disputed],
          { state: "DISPUTED", overdue: false },
          NOW,
        ),
      ),
      [],
    );
  });

  it("an empty condition object still selects every escrow", () => {
    const overdue = fundedWithDeadline("overdue", PAST);
    const notOverdue = fundedWithDeadline("not-overdue", FUTURE);
    const created = new Escrow("created");
    assert.deepEqual(
      byId(escrowsByFilters([overdue, notOverdue, created], {}, NOW)),
      ["overdue", "not-overdue", "created"],
    );
  });

  it("omitting overdue leaves the deadline out of the match entirely", () => {
    const overdue = fundedWithDeadline("overdue", PAST);
    const notOverdue = fundedWithDeadline("not-overdue", FUTURE);
    assert.deepEqual(
      byId(
        escrowsByFilters([overdue, notOverdue], { state: "FUNDED" }, NOW),
      ),
      ["overdue", "not-overdue"],
    );
  });

  it("an unknown filter key still throws fail-closed", () => {
    const escrow = fundedWithDeadline("x", PAST);
    assert.throws(
      () =>
        escrowsByFilters(
          [escrow],
          { overdues: true } as never,
          NOW,
        ),
      /invalid escrowsByFilters: unknown filter "overdues"/,
    );
  });

  it("a non-boolean overdue value throws fail-closed", () => {
    const escrow = fundedWithDeadline("x", PAST);
    assert.throws(
      () =>
        escrowsByFilters([escrow], { overdue: "yes" } as never, NOW),
      /invalid escrowsByFilters: overdue must be a boolean, got "yes"/,
    );
  });

  it("an invalid now throws fail-fast when the overdue axis is present", () => {
    const escrow = fundedWithDeadline("x", PAST);
    assert.throws(
      () =>
        escrowsByFilters([escrow], { overdue: true }, new Date("not-a-date")),
      /invalid now: expected a valid Date/,
    );
    // Without the overdue axis the screening instant is never read,
    // so the same invalid Date is inert instead of failing the call.
    assert.deepEqual(
      byId(
        escrowsByFilters([escrow], {}, new Date("not-a-date")),
      ),
      ["x"],
    );
  });

  it("without an explicit now the real clock decides (far past vs far future deadlines)", () => {
    const longOverdue = fundedWithDeadline(
      "long-overdue",
      new Date("2000-01-01T00:00:00.000Z"),
    );
    const farFuture = fundedWithDeadline(
      "far-future",
      new Date("2999-01-01T00:00:00.000Z"),
    );
    assert.deepEqual(
      byId(escrowsByFilters([longOverdue, farFuture], { overdue: true })),
      ["long-overdue"],
    );
    assert.deepEqual(
      byId(escrowsByFilters([longOverdue, farFuture], { overdue: false })),
      ["far-future"],
    );
  });
});
