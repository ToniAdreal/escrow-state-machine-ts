/**
 * Snapshot diff helper diffEscrowSnapshots (backlog #858).
 *
 * Two stored snapshots of one escrow are the only honest way to
 * answer "what changed since I last looked" — but a hand-written
 * field compare has no shared answer for history: is a rewritten
 * entry an append, or tampering? This helper fixes one rule: the
 * later snapshot's history must be an append-only extension of the
 * earlier one's, and anything else fails loudly instead of being
 * reported as progress.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  diffEscrowSnapshots,
} from "../src/index.js";
import type { EscrowSnapshot } from "../src/index.js";

const AT = "2026-03-10T09:00:00.000Z";

function fundedEscrow(id: string): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 1000, { at: AT });
  return escrow;
}

describe("diffEscrowSnapshots", () => {
  it("identical snapshots diff to an empty object", () => {
    const escrow = fundedEscrow("ESC-DIFF-01");
    const snapshot = escrow.toJSON();
    assert.deepEqual(diffEscrowSnapshots(snapshot, escrow.toJSON()), {});
    assert.deepEqual(diffEscrowSnapshots(snapshot, snapshot), {});
  });

  it("reports a state change together with the appended history", () => {
    const escrow = fundedEscrow("ESC-DIFF-02");
    const before = escrow.toJSON();
    escrow.dispatch("SUBMIT_MILESTONE", undefined, undefined, {
      at: "2026-03-11T09:00:00.000Z",
    });
    const diff = diffEscrowSnapshots(before, escrow.toJSON());
    assert.deepEqual(diff.stateChanged, {
      from: "FUNDED",
      to: "MILESTONE_SUBMITTED",
    });
    assert.equal(diff.historyAppended?.fromSeq, 2);
    assert.equal(diff.historyAppended?.toSeq, 2);
    assert.deepEqual(
      diff.historyAppended?.entries.map((entry) => entry.event),
      ["SUBMIT_MILESTONE"],
    );
    assert.equal(diff.deadlineChanged, undefined);
    assert.equal(diff.rolePolicyChanged, undefined);
  });

  it("returns detached copies of the appended entries", () => {
    const escrow = fundedEscrow("ESC-DIFF-03");
    const before = escrow.toJSON();
    escrow.dispatch("SUBMIT_MILESTONE", "milestone note", undefined, {
      at: "2026-03-11T09:00:00.000Z",
    });
    const after = escrow.toJSON();
    const diff = diffEscrowSnapshots(before, after);
    const entry = diff.historyAppended?.entries[0];
    assert.notEqual(entry, after.history[1]);
    entry!.note = "rewritten by the caller";
    assert.equal(after.history[1].note, "milestone note");
    assert.equal(diffEscrowSnapshots(before, after).historyAppended
      ?.entries[0].note, "milestone note");
  });

  it("reports a deadline set with no history append", () => {
    const escrow = fundedEscrow("ESC-DIFF-04");
    const before = escrow.toJSON();
    escrow.setDeadline("2026-04-01T09:00:00.000Z");
    const diff = diffEscrowSnapshots(before, escrow.toJSON());
    assert.deepEqual(diff.deadlineChanged, {
      from: undefined,
      to: "2026-04-01T09:00:00.000Z",
    });
    assert.equal(diff.stateChanged, undefined);
    assert.equal(diff.historyAppended, undefined);
  });

  it("reports a deadline cleared back to no deadline", () => {
    const escrow = new Escrow("ESC-DIFF-05", {
      deadline: "2026-04-01T09:00:00.000Z",
    });
    escrow.dispatch("FUND", "initial deposit", 1000, { at: AT });
    const before = escrow.toJSON();
    escrow.clearDeadline();
    assert.deepEqual(
      diffEscrowSnapshots(before, escrow.toJSON()).deadlineChanged,
      { from: "2026-04-01T09:00:00.000Z", to: undefined },
    );
  });

  it("reports a role-policy change over identical pinned history", () => {
    const a = new Escrow("ESC-DIFF-06", {
      rolePolicy: { RELEASE: ["treasury"] },
    });
    a.dispatch("FUND", "initial deposit", 1000, { at: AT });
    const b = new Escrow("ESC-DIFF-06", {
      rolePolicy: { RELEASE: ["treasury", "auditor"] },
    });
    b.dispatch("FUND", "initial deposit", 1000, { at: AT });
    const diff = diffEscrowSnapshots(a.toJSON(), b.toJSON());
    assert.equal(diff.rolePolicyChanged, true);
    assert.equal(diff.stateChanged, undefined);
    assert.equal(diff.historyAppended, undefined);
  });

  it("role reordering is not a change, and absent vs empty policy is not either", () => {
    const a = new Escrow("ESC-DIFF-07", {
      rolePolicy: { RELEASE: ["treasury", "auditor"] },
    });
    a.dispatch("FUND", "initial deposit", 1000, { at: AT });
    const b = new Escrow("ESC-DIFF-07", {
      rolePolicy: { RELEASE: ["auditor", "treasury"] },
    });
    b.dispatch("FUND", "initial deposit", 1000, { at: AT });
    assert.deepEqual(diffEscrowSnapshots(a.toJSON(), b.toJSON()), {});
    const plain: EscrowSnapshot = {
      id: "ESC-DIFF-07",
      state: "FUNDED",
      history: [],
    };
    const withEmptyPolicy: EscrowSnapshot = {
      id: "ESC-DIFF-07",
      state: "FUNDED",
      history: [],
      rolePolicy: {},
    };
    assert.deepEqual(diffEscrowSnapshots(plain, withEmptyPolicy), {});
  });

  it("a rewritten history entry throws instead of reporting an append", () => {
    const escrow = fundedEscrow("ESC-DIFF-08");
    const before = escrow.toJSON();
    const tampered = escrow.toJSON();
    tampered.history[0] = { ...tampered.history[0], note: "forged" };
    assert.throws(
      () => diffEscrowSnapshots(before, tampered),
      /snapshot diff failed: history of escrow "ESC-DIFF-08" diverged at entry 1/,
    );
  });

  it("a shorter later history throws, it is not a rollback report", () => {
    const escrow = fundedEscrow("ESC-DIFF-09");
    escrow.dispatch("SUBMIT_MILESTONE", undefined, undefined, {
      at: "2026-03-11T09:00:00.000Z",
    });
    const after = escrow.toJSON();
    const before = fundedEscrow("ESC-DIFF-09").toJSON();
    assert.throws(
      () => diffEscrowSnapshots(after, before),
      /snapshot diff failed: history .* diverged at entry 2/,
    );
  });

  it("snapshots of different escrows throw", () => {
    const a = fundedEscrow("ESC-DIFF-10").toJSON();
    const b = fundedEscrow("ESC-DIFF-11").toJSON();
    assert.throws(
      () => diffEscrowSnapshots(a, b),
      /snapshot diff failed: cannot diff snapshots of different escrows/,
    );
  });

  it("an empty earlier history appends from the first entry's seq", () => {
    const empty: EscrowSnapshot = {
      id: "ESC-DIFF-12",
      state: "CREATED",
      history: [],
    };
    const later = fundedEscrow("ESC-DIFF-12").toJSON();
    const diff = diffEscrowSnapshots(empty, later);
    assert.equal(diff.historyAppended?.fromSeq, 1);
    assert.equal(diff.historyAppended?.toSeq, 1);
    assert.equal(diff.historyAppended?.entries.length, 1);
    assert.deepEqual(diff.stateChanged, {
      from: "CREATED",
      to: "FUNDED",
    });
  });

  it("entry key order does not count as a history change", () => {
    const a: EscrowSnapshot = {
      id: "ESC-DIFF-13",
      state: "FUNDED",
      history: [
        {
          seq: 1,
          event: "FUND",
          from: "CREATED",
          to: "FUNDED",
          at: AT,
          amount: 1000,
        },
      ],
    };
    const b: EscrowSnapshot = {
      state: "FUNDED",
      history: [
        {
          amount: 1000,
          at: AT,
          to: "FUNDED",
          from: "CREATED",
          event: "FUND",
          seq: 1,
        },
      ],
      id: "ESC-DIFF-13",
    };
    assert.deepEqual(diffEscrowSnapshots(a, b), {});
  });
});
