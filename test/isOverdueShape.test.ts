/**
 * isOverdue() shape guards (backlog #1383).
 *
 * The single-escrow watchdog entry read `escrow.getDeadline()` and
 * `now.getTime()` with no guard, so `isOverdue(null)` died as a bare
 * `TypeError`, a plain object with `getDeadline()` was silently treated
 * as an escrow, and an invalid `now` silently returned false — telling
 * a watchdog an overdue escrow was not overdue. The batch entry
 * (`expiredEscrows`) was already guarded by `assertEscrowBatch`; this
 * file pins the single-escrow entry to the same fail-fast rule.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Escrow, isOverdue } from "../src/index.js";

const PAST = new Date("2026-01-01T00:00:00.000Z");
const FUTURE = new Date("2027-01-01T00:00:00.000Z");
const NOW = new Date("2026-06-01T00:00:00.000Z");

function fundedEscrow(id: string): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 1000);
  return escrow;
}

function overdueEscrow(id: string): Escrow {
  const escrow = fundedEscrow(id);
  escrow.setDeadline(PAST);
  return escrow;
}

describe("isOverdue shape guards", () => {
  it("rejects a null escrow with a named error", () => {
    assert.throws(
      () => isOverdue(null as unknown as Escrow, NOW),
      /invalid isOverdue: escrow must be an Escrow, got null/
    );
  });

  it("rejects an undefined escrow with a named error", () => {
    assert.throws(
      () => isOverdue(undefined as unknown as Escrow, NOW),
      /invalid isOverdue: escrow must be an Escrow, got undefined/
    );
  });

  it("rejects a string escrow with a named error", () => {
    assert.throws(
      () => isOverdue("esc-1" as unknown as Escrow, NOW),
      /invalid isOverdue: escrow must be an Escrow, got string/
    );
  });

  it("rejects a number escrow with a named error", () => {
    assert.throws(
      () => isOverdue(42 as unknown as Escrow, NOW),
      /invalid isOverdue: escrow must be an Escrow, got number/
    );
  });

  it("rejects a boolean escrow with a named error", () => {
    assert.throws(
      () => isOverdue(true as unknown as Escrow, NOW),
      /invalid isOverdue: escrow must be an Escrow, got boolean/
    );
  });

  it("rejects an array escrow with a named error", () => {
    assert.throws(
      () => isOverdue([] as unknown as Escrow, NOW),
      /invalid isOverdue: escrow must be an Escrow, got object/
    );
  });

  it("rejects a plain-object stand-in with getDeadline/isTerminal", () => {
    // A plain object with the two members isOverdue reads is not an
    // Escrow: the guard is instanceof, not a shape check (only a real
    // Escrow guarantees the deadline/terminal machinery).
    const standIn = {
      getDeadline: () => PAST.toISOString(),
      isTerminal: false,
    };
    assert.throws(
      () => isOverdue(standIn as unknown as Escrow, NOW),
      /invalid isOverdue: escrow must be an Escrow, got object/
    );
  });

  it("throws a plain Error, never a bare TypeError, for a bad escrow", () => {
    try {
      isOverdue(null as unknown as Escrow, NOW);
      assert.fail("expected isOverdue(null) to throw");
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.ok(!(err instanceof TypeError));
      assert.match(
        (err as Error).message,
        /invalid isOverdue: escrow must be an Escrow, got null/
      );
    }
  });

  it("rejects an invalid Date now with a named error", () => {
    const escrow = overdueEscrow("n1");
    assert.throws(
      () => isOverdue(escrow, new Date(NaN)),
      /invalid now: expected a valid Date/
    );
    assert.throws(
      () => isOverdue(escrow, new Date("not-a-date")),
      /invalid now: expected a valid Date/
    );
  });

  it("rejects a non-Date now with a named error", () => {
    const escrow = overdueEscrow("n2");
    assert.throws(
      () => isOverdue(escrow, "2021-01-01" as unknown as Date),
      /invalid now: expected a valid Date/
    );
    assert.throws(
      () => isOverdue(escrow, 12345 as unknown as Date),
      /invalid now: expected a valid Date/
    );
  });

  it("checks the escrow guard before the now guard", () => {
    // A null escrow plus an invalid now reports the escrow error, so
    // a malformed escrow is never masked by a bad clock.
    assert.throws(
      () => isOverdue(null as unknown as Escrow, new Date(NaN)),
      /invalid isOverdue: escrow must be an Escrow, got null/
    );
  });

  it("keeps the overdue judgement unchanged for a legal escrow", () => {
    assert.equal(isOverdue(overdueEscrow("k1"), NOW), true);
    const fresh = fundedEscrow("k2");
    fresh.setDeadline(FUTURE);
    assert.equal(isOverdue(fresh, NOW), false);
  });

  it("keeps no-deadline and terminal escrows non-overdue", () => {
    assert.equal(isOverdue(fundedEscrow("k3"), NOW), false);
    const released = fundedEscrow("k4");
    released.dispatch("SUBMIT_MILESTONE");
    released.dispatch("VERIFY_PASS");
    released.dispatch("RELEASE");
    released.setDeadline(PAST);
    assert.equal(isOverdue(released, NOW), false);
  });

  it("keeps the boundary: now exactly at the deadline counts as overdue", () => {
    assert.equal(isOverdue(overdueEscrow("k5"), PAST), true);
  });

  it("still accepts an escrow restored by fromJSON", () => {
    const escrow = overdueEscrow("k6");
    const restored = Escrow.fromJSON(
      JSON.parse(JSON.stringify(escrow.toJSON())) as unknown
    );
    assert.ok(restored instanceof Escrow);
    assert.equal(isOverdue(restored, NOW), true);
    assert.equal(
      isOverdue(restored, new Date("2025-06-01T00:00:00.000Z")),
      false
    );
  });
});
