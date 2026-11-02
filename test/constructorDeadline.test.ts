/**
 * Constructor-time deadline (backlog #828).
 *
 * `EscrowOptions` previously had no `deadline` field: a deadline could
 * only be attached after construction via `setDeadline()`, so a bare
 * history rebuilt with `Escrow.fromHistory()` could never carry one
 * in a single step (its doc comment honestly said the rebuild starts
 * with no deadline), while the snapshot path (`toJSON`/`fromJSON`)
 * could. The constructor now accepts `deadline?: Date | string` with
 * the exact `setDeadline` validation (canonical ISO storage,
 * unparseable input fails fast), `fromHistory` installs it through
 * the constructor, and `fromJSON` treats an explicit `opts.deadline`
 * as an override of the snapshot's deadline (mirroring `rolePolicy`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Escrow, isOverdue } from "../src/index.js";

const PAST = new Date("2026-01-01T00:00:00.000Z");
const FUTURE = new Date("2027-01-01T00:00:00.000Z");
const OTHER = new Date("2028-06-15T12:00:00.000Z");
const NOW = new Date("2026-06-01T00:00:00.000Z");
const AT = "2026-03-01T10:00:00.000Z";

function fundedEscrow(id: string): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 1000, { at: AT });
  return escrow;
}

describe("constructor deadline (backlog #828)", () => {
  it("string deadline reads back as canonical ISO", () => {
    const escrow = new Escrow("c1", {
      deadline: "2027-01-01T00:00:00.000Z",
    });
    assert.equal(escrow.getDeadline(), "2027-01-01T00:00:00.000Z");
  });

  it("Date deadline and non-canonical string are normalized like setDeadline", () => {
    const byDate = new Escrow("c2", { deadline: FUTURE });
    assert.equal(byDate.getDeadline(), FUTURE.toISOString());
    const byString = new Escrow("c3", { deadline: "2027-1-1" });
    assert.equal(byString.getDeadline(), "2027-01-01T00:00:00.000Z");
  });

  it("omitted deadline stays undefined and out of the snapshot", () => {
    const escrow = new Escrow("c4");
    assert.equal(escrow.getDeadline(), undefined);
    assert.ok(!("deadline" in escrow.toJSON()));
  });

  it("constructor deadline lands in toJSON and survives fromJSON", () => {
    const escrow = new Escrow("c5", { deadline: FUTURE });
    const snapshot = escrow.toJSON();
    assert.equal(snapshot.deadline, FUTURE.toISOString());
    const restored = Escrow.fromJSON(
      JSON.parse(JSON.stringify(snapshot)) as unknown
    );
    assert.equal(restored.getDeadline(), FUTURE.toISOString());
  });

  it("unparseable string deadline throws and produces no instance", () => {
    let built: Escrow | undefined;
    assert.throws(() => {
      built = new Escrow("c6", { deadline: "not-a-date" });
    }, /invalid deadline: not-a-date/);
    assert.equal(built, undefined);
  });

  it("Invalid Date deadline throws and produces no instance", () => {
    let built: Escrow | undefined;
    assert.throws(() => {
      built = new Escrow("c7", { deadline: new Date(NaN) });
    }, /invalid deadline: Invalid Date/);
    assert.equal(built, undefined);
  });

  it("isOverdue judgement agrees with the constructor deadline", () => {
    const overdue = new Escrow("c8", { deadline: PAST });
    overdue.dispatch("FUND", "initial deposit", 1000, { at: AT });
    assert.equal(isOverdue(overdue, NOW), true);
    const fresh = new Escrow("c9", { deadline: FUTURE });
    fresh.dispatch("FUND", "initial deposit", 1000, { at: AT });
    assert.equal(isOverdue(fresh, NOW), false);
  });

  it("setDeadline after construction still overwrites the constructor deadline", () => {
    const escrow = new Escrow("c10", { deadline: FUTURE });
    escrow.setDeadline(OTHER);
    assert.equal(escrow.getDeadline(), OTHER.toISOString());
    escrow.clearDeadline();
    assert.equal(escrow.getDeadline(), undefined);
  });

  it("fromHistory with opts.deadline rebuilds deadline, state, and chain", () => {
    const live = fundedEscrow("c11");
    const history = JSON.parse(JSON.stringify(live.history));
    const restored = Escrow.fromHistory(live.id, history, {
      deadline: FUTURE,
    });
    assert.equal(restored.getDeadline(), FUTURE.toISOString());
    assert.equal(restored.state, "FUNDED");
    assert.deepEqual(restored.history, live.history);
    assert.equal(isOverdue(restored, NOW), false);
    // Continued dispatch appends with a continuous seq chain.
    restored.dispatch("SUBMIT_MILESTONE", "creator delivers", undefined, {
      at: "2026-03-01T11:00:00.000Z",
    });
    assert.equal(restored.state, "MILESTONE_SUBMITTED");
    assert.equal(restored.history.length, 2);
    assert.equal(restored.history[1].from, "FUNDED");
    assert.equal(restored.history[1].to, "MILESTONE_SUBMITTED");
    assert.equal(restored.history[1].seq, restored.history[0].seq + 1);
    assert.equal(restored.getDeadline(), FUTURE.toISOString());
  });

  it("fromHistory without opts still starts with no deadline", () => {
    const live = fundedEscrow("c12");
    const restored = Escrow.fromHistory(
      live.id,
      JSON.parse(JSON.stringify(live.history))
    );
    assert.equal(restored.getDeadline(), undefined);
    assert.equal(restored.state, "FUNDED");
  });

  it("fromJSON opts.deadline overrides the snapshot deadline", () => {
    const escrow = fundedEscrow("c13");
    escrow.setDeadline(FUTURE);
    const snapshot = JSON.parse(JSON.stringify(escrow.toJSON()));
    const overridden = Escrow.fromJSON(snapshot, { deadline: OTHER });
    assert.equal(overridden.getDeadline(), OTHER.toISOString());
    assert.equal(overridden.state, "FUNDED");
    assert.equal(overridden.history.length, 1);
    // Without opts, the snapshot deadline is restored as before.
    const plain = Escrow.fromJSON(
      JSON.parse(JSON.stringify(escrow.toJSON())) as unknown
    );
    assert.equal(plain.getDeadline(), FUTURE.toISOString());
  });

  it("deadline is a legal constructor option, not an unknown field", () => {
    const escrow = new Escrow("c14", {
      requireVerifyEvidence: false,
      maxDeposit: 10000,
      auditKey: "k1",
      rolePolicy: {},
      deadline: FUTURE,
    });
    assert.equal(escrow.getDeadline(), FUTURE.toISOString());
  });
});
