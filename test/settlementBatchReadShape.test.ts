/**
 * Settlement/patrol read-path batch-shape guards (backlog #1360).
 *
 * `nextEscrowDeadline`, `settlementAging`, and
 * `unreconciledSettlements` are the remaining batch entry points on
 * the settlement/patrol read path: #1340 already covered the eight
 * batch selectors, #1343 the reports/ledger reconciliation inputs,
 * but these three iterated the batch with no guard at all. A `null`
 * batch surfaced as a bare `TypeError` (`escrows is not iterable`,
 * `reading 'filter'`), a string batch as `escrow.getDeadline is not
 * a function`, and `[null]` as `reading 'isTerminal'` / `reading
 * 'state'` — none of which names the caller mistake. All three now
 * validate the batch first, before any other parameter check, with
 * the #1340 `assertEscrowBatch` guard (`instanceof Escrow`): a
 * non-array batch throws
 * `invalid <fn>: escrows must be an array, got <kind>`, and a bad
 * entry throws `invalid <fn>: escrows[N] must be an Escrow, got
 * <kind>`, naming the first bad index.
 *
 * The guard is the escrow-batch guard, not the reports/ledger guard
 * of `reconcileSettlements` (#1343): `unreconciledSettlements` reads
 * escrow state and audit history, never settlement reports or a
 * ledger, so a plain object with the right fields is rejected here
 * on purpose — it is not an escrow, and silently treating it as one
 * would let a hand-built object bypass the state machine's
 * invariants.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  nextEscrowDeadline,
  settlementAging,
  unreconciledSettlements,
  type Escrow as EscrowType,
} from "../src/index.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const DAY = 24 * 3600_000;
const iso = (d: Date): string => d.toISOString();
const daysAgo = (n: number): string => iso(new Date(NOW.getTime() - n * DAY));
const INVALID_NOW = new Date(NaN);

/** Funded escrow carrying a deadline. */
function fundedEscrow(id: string, deadline?: string): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 1000);
  if (deadline !== undefined) escrow.setDeadline(deadline);
  return escrow;
}

/** Escrow funded at a fixed time (deterministic age). */
function fundedAt(id: string, at: string): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 1000, { at });
  return escrow;
}

/** Released escrow, optionally carrying a settlement reference. */
function releasedEscrow(id: string, settlementRef?: string): Escrow {
  const escrow = fundedEscrow(id);
  escrow.dispatch("SUBMIT_MILESTONE");
  escrow.dispatch("VERIFY_PASS");
  escrow.dispatch("RELEASE", undefined, undefined, {
    ...(settlementRef !== undefined ? { settlementRef } : {}),
  });
  return escrow;
}

/** A named, plain-`Error` (never `TypeError`) rejection. */
function assertNamedError(
  fn: () => unknown,
  message: string,
): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(!(error instanceof TypeError));
    assert.equal(error.message, message);
    return true;
  });
}

const BAD_BATCHES: Array<{ value: unknown; got: string }> = [
  { value: null, got: "null" },
  { value: "x", got: "string" },
  { value: 42, got: "number" },
  { value: undefined, got: "undefined" },
];

describe("nextEscrowDeadline batch shape", () => {
  it("rejects a non-array batch with a named error", () => {
    for (const { value, got } of BAD_BATCHES) {
      assertNamedError(
        () => nextEscrowDeadline(value as readonly EscrowType[]),
        `invalid nextEscrowDeadline: escrows must be an array, got ${got}`,
      );
    }
  });

  it("names the first bad entry in a [null] batch", () => {
    assertNamedError(
      () => nextEscrowDeadline([null] as unknown as readonly EscrowType[]),
      "invalid nextEscrowDeadline: escrows[0] must be an Escrow, got null",
    );
  });

  it("names the bad entry at its index in a mixed batch", () => {
    const good = fundedEscrow("shape-n1", daysAgo(-30));
    assertNamedError(
      () =>
        nextEscrowDeadline(
          [good, "x"] as unknown as readonly EscrowType[],
        ),
      "invalid nextEscrowDeadline: escrows[1] must be an Escrow, got string",
    );
  });

  it("rejects a plain-object stand-in, even with the right fields", () => {
    const standIn = {
      id: "shape-n2",
      state: "FUNDED",
      history: [],
      isTerminal: false,
      getDeadline: () => daysAgo(-30),
    };
    assertNamedError(
      () =>
        nextEscrowDeadline([standIn] as unknown as readonly EscrowType[]),
      "invalid nextEscrowDeadline: escrows[0] must be an Escrow, got object",
    );
  });

  it("guard runs before the now check", () => {
    assertNamedError(
      () =>
        nextEscrowDeadline(
          null as unknown as readonly EscrowType[],
          INVALID_NOW,
        ),
      "invalid nextEscrowDeadline: escrows must be an array, got null",
    );
  });

  it("legal batch still returns the earliest future deadline", () => {
    const later = fundedEscrow("shape-n3", "2026-11-01T00:00:00.000Z");
    const soon = fundedEscrow("shape-n4", "2026-10-15T00:00:00.000Z");
    const result = nextEscrowDeadline([later, soon], NOW);
    assert.ok(result !== undefined);
    assert.equal(result.escrow, soon);
    assert.equal(result.deadline, "2026-10-15T00:00:00.000Z");
  });

  it("empty batch returns undefined", () => {
    assert.equal(nextEscrowDeadline([], NOW), undefined);
  });
});

describe("settlementAging batch shape", () => {
  it("rejects a non-array batch with a named error", () => {
    for (const { value, got } of BAD_BATCHES) {
      assertNamedError(
        () => settlementAging(value as readonly EscrowType[]),
        `invalid settlementAging: escrows must be an array, got ${got}`,
      );
    }
  });

  it("names the first bad entry in a [null] batch", () => {
    assertNamedError(
      () => settlementAging([null] as unknown as readonly EscrowType[]),
      "invalid settlementAging: escrows[0] must be an Escrow, got null",
    );
  });

  it("names the bad entry at its index in a mixed batch", () => {
    const good = fundedAt("shape-a1", daysAgo(3));
    assertNamedError(
      () =>
        settlementAging([good, 42] as unknown as readonly EscrowType[]),
      "invalid settlementAging: escrows[1] must be an Escrow, got number",
    );
  });

  it("rejects a plain-object stand-in, even with the right fields", () => {
    const standIn = {
      id: "shape-a2",
      state: "FUNDED",
      history: [{ seq: 1, event: "FUND", from: "CREATED", to: "FUNDED", at: daysAgo(3) }],
      isTerminal: false,
    };
    assertNamedError(
      () => settlementAging([standIn] as unknown as readonly EscrowType[]),
      "invalid settlementAging: escrows[0] must be an Escrow, got object",
    );
  });

  it("guard runs before the now check", () => {
    assertNamedError(
      () =>
        settlementAging(
          null as unknown as readonly EscrowType[],
          INVALID_NOW,
        ),
      "invalid settlementAging: escrows must be an array, got null",
    );
  });

  it("legal batch still buckets by whole days since the last FUND", () => {
    const young = fundedAt("shape-a3", daysAgo(3));
    const old = fundedAt("shape-a4", daysAgo(40));
    const result = settlementAging([young, old], NOW);
    assert.deepEqual(result.under7Days, [{ id: "shape-a3", ageDays: 3 }]);
    assert.deepEqual(result.days7To30, []);
    assert.deepEqual(result.over30Days, [{ id: "shape-a4", ageDays: 40 }]);
    assert.deepEqual(result.unknown, []);
  });

  it("empty batch returns four empty buckets", () => {
    assert.deepEqual(settlementAging([], NOW), {
      under7Days: [],
      days7To30: [],
      over30Days: [],
      unknown: [],
    });
  });
});

describe("unreconciledSettlements batch shape", () => {
  it("rejects a non-array batch with a named error", () => {
    for (const { value, got } of BAD_BATCHES) {
      assertNamedError(
        () => unreconciledSettlements(value as readonly EscrowType[]),
        `invalid unreconciledSettlements: escrows must be an array, got ${got}`,
      );
    }
  });

  it("names the first bad entry in a [null] batch", () => {
    assertNamedError(
      () =>
        unreconciledSettlements([null] as unknown as readonly EscrowType[]),
      "invalid unreconciledSettlements: escrows[0] must be an Escrow, got null",
    );
  });

  it("names the bad entry at its index in a mixed batch", () => {
    const good = releasedEscrow("shape-u1");
    assertNamedError(
      () =>
        unreconciledSettlements(
          [good, "x"] as unknown as readonly EscrowType[],
        ),
      "invalid unreconciledSettlements: escrows[1] must be an Escrow, got string",
    );
  });

  it("rejects a plain-object stand-in, even with the right fields", () => {
    const standIn = {
      id: "shape-u2",
      state: "RELEASED",
      history: [
        { seq: 1, event: "FUND", from: "CREATED", to: "FUNDED", at: daysAgo(1) },
        { seq: 2, event: "RELEASE", from: "VERIFIED", to: "RELEASED", at: daysAgo(0) },
      ],
    };
    assertNamedError(
      () =>
        unreconciledSettlements([standIn] as unknown as readonly EscrowType[]),
      "invalid unreconciledSettlements: escrows[0] must be an Escrow, got object",
    );
  });

  it("legal batch still returns only ref-less releases", () => {
    const unreconciled = releasedEscrow("shape-u3");
    const reconciled = releasedEscrow("shape-u4", "pay_123");
    const funded = fundedEscrow("shape-u5");
    assert.deepEqual(
      unreconciledSettlements([reconciled, unreconciled, funded]),
      [unreconciled],
    );
  });

  it("empty batch returns an empty array", () => {
    assert.deepEqual(unreconciledSettlements([]), []);
  });
});
