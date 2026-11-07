/**
 * Snapshot diff dimension `idempotencyKeysChanged` (backlog #959).
 *
 * The consumed idempotency-key set is part of the snapshot, but
 * `diffEscrowSnapshots` never compared it — a key consumed (or
 * dropped on restore) between two stored snapshots was invisible
 * in the diff. The set is compared order-insensitively; a snapshot
 * without the field (legacy, or no key consumed yet) is the empty
 * set.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Escrow, diffEscrowSnapshots } from "../src/index.js";
import type { EscrowSnapshot } from "../src/index.js";

const AT = "2026-03-10T09:00:00.000Z";

function fundedEscrowWithKeys(id: string): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 1000, {
    at: AT,
    idempotencyKey: "pay-1",
  });
  escrow.dispatch("SUBMIT_MILESTONE", undefined, undefined, {
    at: "2026-03-11T09:00:00.000Z",
    idempotencyKey: "pay-2",
  });
  return escrow;
}

describe("diffEscrowSnapshots idempotencyKeysChanged", () => {
  it("reports true when a key is consumed between snapshots", () => {
    const escrow = new Escrow("ESC-DIFF-KEY-01");
    const before = escrow.toJSON();
    escrow.dispatch("FUND", "initial deposit", 1000, {
      at: AT,
      idempotencyKey: "pay-1",
    });
    const diff = diffEscrowSnapshots(before, escrow.toJSON());
    assert.equal(diff.idempotencyKeysChanged, true);
  });

  it("reports true when a key is dropped between snapshots", () => {
    const escrow = fundedEscrowWithKeys("ESC-DIFF-KEY-02");
    const before = escrow.toJSON();
    const dropped: EscrowSnapshot = { ...before };
    delete dropped.idempotencyKeys;
    const diff = diffEscrowSnapshots(before, dropped);
    assert.equal(diff.idempotencyKeysChanged, true);
    // Nothing else moved: same state, same history.
    assert.equal(diff.stateChanged, undefined);
    assert.equal(diff.historyAppended, undefined);
  });

  it("does not report when the same set is reordered", () => {
    const escrow = fundedEscrowWithKeys("ESC-DIFF-KEY-03");
    const before = escrow.toJSON();
    const reordered: EscrowSnapshot = {
      ...before,
      idempotencyKeys: ["pay-2", "pay-1"],
    };
    assert.deepEqual(
      diffEscrowSnapshots(before, reordered),
      {},
    );
  });

  it("does not report for identical snapshots", () => {
    const escrow = fundedEscrowWithKeys("ESC-DIFF-KEY-04");
    const snapshot = escrow.toJSON();
    assert.deepEqual(diffEscrowSnapshots(snapshot, escrow.toJSON()), {});
  });

  it("reports true for a legacy snapshot without keys vs one with keys", () => {
    const escrow = fundedEscrowWithKeys("ESC-DIFF-KEY-05");
    const withKeys = escrow.toJSON();
    const legacy: EscrowSnapshot = { ...withKeys };
    delete legacy.idempotencyKeys;
    assert.equal(
      diffEscrowSnapshots(legacy, withKeys).idempotencyKeysChanged,
      true,
    );
  });

  it("does not report when neither snapshot carries keys", () => {
    const escrow = new Escrow("ESC-DIFF-KEY-06");
    escrow.dispatch("FUND", "initial deposit", 1000, { at: AT });
    const snapshot = escrow.toJSON();
    assert.equal(snapshot.idempotencyKeys, undefined);
    assert.deepEqual(diffEscrowSnapshots(snapshot, escrow.toJSON()), {});
  });

  it("is orthogonal to the other six dimensions", () => {
    const escrow = fundedEscrowWithKeys("ESC-DIFF-KEY-07");
    const before = escrow.toJSON();
    const oneKeyLess: EscrowSnapshot = {
      ...before,
      idempotencyKeys: ["pay-1"],
    };
    assert.deepEqual(diffEscrowSnapshots(before, oneKeyLess), {
      idempotencyKeysChanged: true,
    });
  });

  it("reports alongside a state change when both move", () => {
    const escrow = new Escrow("ESC-DIFF-KEY-08");
    escrow.dispatch("FUND", "initial deposit", 1000, {
      at: AT,
      idempotencyKey: "pay-1",
    });
    const before = escrow.toJSON();
    escrow.dispatch("SUBMIT_MILESTONE", undefined, undefined, {
      at: "2026-03-11T09:00:00.000Z",
      idempotencyKey: "pay-2",
    });
    const diff = diffEscrowSnapshots(before, escrow.toJSON());
    assert.equal(diff.idempotencyKeysChanged, true);
    assert.deepEqual(diff.stateChanged, {
      from: "FUNDED",
      to: "MILESTONE_SUBMITTED",
    });
    assert.equal(diff.historyAppended?.fromSeq, 2);
  });

  it("treats duplicate keys in a snapshot as the same set", () => {
    const escrow = fundedEscrowWithKeys("ESC-DIFF-KEY-09");
    const before = escrow.toJSON();
    const duplicated: EscrowSnapshot = {
      ...before,
      idempotencyKeys: ["pay-1", "pay-2", "pay-1", "pay-2"],
    };
    assert.deepEqual(diffEscrowSnapshots(before, duplicated), {});
  });

  it("treats an empty key array as the same state as no field", () => {
    const escrow = new Escrow("ESC-DIFF-KEY-10");
    escrow.dispatch("FUND", "initial deposit", 1000, { at: AT });
    const before = escrow.toJSON();
    const empty: EscrowSnapshot = { ...before, idempotencyKeys: [] };
    assert.deepEqual(diffEscrowSnapshots(before, empty), {});
    assert.deepEqual(diffEscrowSnapshots(empty, before), {});
  });

  it("reports alongside history appends when both move", () => {
    const escrow = fundedEscrowWithKeys("ESC-DIFF-KEY-11");
    const before = escrow.toJSON();
    escrow.dispatch("VERIFY_PASS", undefined, undefined, {
      at: "2026-03-12T09:00:00.000Z",
      idempotencyKey: "pay-3",
    });
    const diff = diffEscrowSnapshots(before, escrow.toJSON());
    assert.equal(diff.idempotencyKeysChanged, true);
    assert.equal(diff.historyAppended?.fromSeq, 3);
    assert.equal(diff.historyAppended?.toSeq, 3);
  });
});
