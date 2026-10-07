/**
 * Deadline + expiredEscrows watchdog (#71).
 *
 * Advisory deadlines mirror the dataquest SLA pattern: set/get/clear,
 * canonical ISO storage, strict snapshot validation, and pure
 * isOverdue()/expiredEscrows() helpers that a watchdog uses to decide
 * which escrows to EXPIRE.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  EscrowSnapshot,
  expiredEscrows,
  isOverdue,
} from "../src/index.js";

const PAST = new Date("2026-01-01T00:00:00.000Z");
const FUTURE = new Date("2027-01-01T00:00:00.000Z");
const NOW = new Date("2026-06-01T00:00:00.000Z");

function fundedEscrow(id: string): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 1000);
  return escrow;
}

describe("deadline management", () => {
  it("set/get round-trip stores canonical ISO", () => {
    const escrow = new Escrow("e1");
    escrow.setDeadline("2027-01-01T00:00:00.000Z");
    assert.equal(escrow.getDeadline(), "2027-01-01T00:00:00.000Z");
    // non-canonical input is normalized on the way in
    escrow.setDeadline("2027-1-1");
    assert.equal(escrow.getDeadline(), "2027-01-01T00:00:00.000Z");
  });

  it("accepts Date objects", () => {
    const escrow = new Escrow("e2");
    escrow.setDeadline(new Date("2027-03-15T12:30:00.000Z"));
    assert.equal(escrow.getDeadline(), "2027-03-15T12:30:00.000Z");
  });

  it("overwrites the previous deadline", () => {
    const escrow = new Escrow("e3");
    escrow.setDeadline(PAST);
    escrow.setDeadline(FUTURE);
    assert.equal(escrow.getDeadline(), FUTURE.toISOString());
  });

  it("clearDeadline removes the deadline (no-op when none)", () => {
    const escrow = new Escrow("e4");
    escrow.clearDeadline(); // must not throw
    assert.equal(escrow.getDeadline(), undefined);
    escrow.setDeadline(FUTURE);
    escrow.clearDeadline();
    assert.equal(escrow.getDeadline(), undefined);
  });

  it("rejects unparseable deadlines", () => {
    const escrow = new Escrow("e5");
    assert.throws(() => escrow.setDeadline("not-a-date"), /invalid deadline: not-a-date/);
    assert.throws(() => escrow.setDeadline(new Date(NaN)), /invalid deadline: Invalid Date/);
    assert.equal(escrow.getDeadline(), undefined); // failed set leaves nothing
  });
});

describe("isOverdue", () => {
  it("true when past deadline and non-terminal", () => {
    const escrow = fundedEscrow("o1");
    escrow.setDeadline(PAST);
    assert.equal(isOverdue(escrow, NOW), true);
  });

  it("false when deadline is in the future", () => {
    const escrow = fundedEscrow("o2");
    escrow.setDeadline(FUTURE);
    assert.equal(isOverdue(escrow, NOW), false);
  });

  it("false when no deadline is set", () => {
    const escrow = fundedEscrow("o3");
    assert.equal(isOverdue(escrow, NOW), false);
  });

  it("terminal states are never overdue, even with a past deadline", () => {
    const released = fundedEscrow("t1");
    released.dispatch("SUBMIT_MILESTONE");
    released.dispatch("VERIFY_PASS");
    released.dispatch("RELEASE");
    released.setDeadline(PAST);
    assert.equal(isOverdue(released, NOW), false);

    const refunded = fundedEscrow("t2");
    refunded.dispatch("DISPUTE");
    refunded.dispatch("ARBITRATE_REFUND");
    refunded.setDeadline(PAST);
    assert.equal(isOverdue(refunded, NOW), false);

    const expired = fundedEscrow("t3");
    expired.setDeadline(PAST);
    expired.dispatch("EXPIRE");
    assert.equal(isOverdue(expired, NOW), false);
  });

  it("boundary: now exactly at the deadline counts as overdue", () => {
    const escrow = fundedEscrow("o4");
    escrow.setDeadline(PAST);
    assert.equal(isOverdue(escrow, PAST), true);
  });
});

describe("expiredEscrows", () => {
  it("returns only non-terminal, past-deadline escrows", () => {
    const overdue = fundedEscrow("w1");
    overdue.setDeadline(PAST);
    const future = fundedEscrow("w2");
    future.setDeadline(FUTURE);
    const noDeadline = fundedEscrow("w3");
    const terminal = fundedEscrow("w4");
    terminal.setDeadline(PAST);
    terminal.dispatch("EXPIRE");
    const overdueMilestone = fundedEscrow("w5");
    overdueMilestone.dispatch("SUBMIT_MILESTONE");
    overdueMilestone.setDeadline(PAST);

    const result = expiredEscrows(
      [overdue, future, noDeadline, terminal, overdueMilestone],
      NOW
    );
    assert.deepEqual(
      result.map((e) => e.id).sort(),
      ["w1", "w5"]
    );
  });

  it("empty input returns empty output", () => {
    assert.deepEqual(expiredEscrows([], NOW), []);
  });

  it("is pure: inputs are not mutated and nothing is dispatched", () => {
    const a = fundedEscrow("p1");
    a.setDeadline(PAST);
    const b = fundedEscrow("p2");
    b.setDeadline(FUTURE);
    const beforeA = JSON.stringify(a.toJSON());
    const beforeB = JSON.stringify(b.toJSON());

    expiredEscrows([a, b], NOW);

    assert.equal(JSON.stringify(a.toJSON()), beforeA);
    assert.equal(JSON.stringify(b.toJSON()), beforeB);
    assert.equal(a.state, "FUNDED");
    assert.equal(a.getDeadline(), PAST.toISOString());
  });

  it("watchdog pattern: dispatch EXPIRE on the expired ones", () => {
    const a = fundedEscrow("wd1");
    a.setDeadline(PAST);
    const b = fundedEscrow("wd2");
    b.setDeadline(FUTURE);
    for (const escrow of expiredEscrows([a, b], NOW)) {
      escrow.dispatch("EXPIRE");
    }
    assert.equal(a.state, "EXPIRED");
    assert.equal(b.state, "FUNDED");
    // once terminal, no longer overdue
    assert.equal(isOverdue(a, NOW), false);
  });
});

describe("deadline in snapshots", () => {
  it("toJSON/fromJSON round-trip preserves the deadline", () => {
    const escrow = fundedEscrow("s1");
    escrow.setDeadline(FUTURE);
    const restored = Escrow.fromJSON(
      JSON.parse(JSON.stringify(escrow.toJSON())) as unknown
    );
    assert.equal(restored.getDeadline(), FUTURE.toISOString());
    assert.equal(isOverdue(restored, NOW), false);
    assert.equal(
      isOverdue(restored, new Date("2028-01-01T00:00:00.000Z")),
      true
    );
  });

  it("no deadline: snapshot carries no deadline field", () => {
    const escrow = fundedEscrow("s2");
    const snapshot = escrow.toJSON();
    assert.ok(!("deadline" in snapshot));
    const restored = Escrow.fromJSON(snapshot as EscrowSnapshot);
    assert.equal(restored.getDeadline(), undefined);
  });

  it("tampered deadline is rejected", () => {
    const escrow = fundedEscrow("s3");
    escrow.setDeadline(FUTURE);
    const snapshot = JSON.parse(JSON.stringify(escrow.toJSON())) as EscrowSnapshot;

    // non-canonical ISO (parses, but not the canonical form)
    assert.throws(
      () => Escrow.fromJSON({ ...snapshot, deadline: "2027-01-01T00:00:00Z" }),
      /invalid snapshot: deadline must be canonical ISO-8601/
    );

    // unparseable
    assert.throws(
      () => Escrow.fromJSON({ ...snapshot, deadline: "soon" }),
      /invalid snapshot: deadline must be canonical ISO-8601/
    );

    // wrong type
    assert.throws(
      () => Escrow.fromJSON({ ...snapshot, deadline: 1893456000000 }),
      /invalid snapshot: deadline must be canonical ISO-8601/
    );
  });

  it("restored escrow keeps working (dispatch + history intact)", () => {
    const escrow = fundedEscrow("s4");
    escrow.setDeadline(FUTURE);
    const restored = Escrow.fromJSON(escrow.toJSON());
    restored.dispatch("SUBMIT_MILESTONE");
    assert.equal(restored.state, "MILESTONE_SUBMITTED");
    assert.equal(restored.getDeadline(), FUTURE.toISOString());
    assert.equal(restored.history.length, 2);
  });
});
