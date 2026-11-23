/**
 * Batch selector batch-shape guards (backlog #1340).
 *
 * The eight batch selectors only ever validated their filter
 * parameters, never the batch itself: a `null` batch surfaced as a
 * bare `TypeError` (`reading 'filter'`), and worse,
 * `escrowsByFilters([null], {})` silently returned `[null]` when no
 * filter axis was set, handing the caller a `null` to use as an
 * escrow. Each selector now validates the batch first, before any
 * filter-parameter validation, with a named error:
 * `invalid <fn>: escrows must be an array` for a non-array batch,
 * and `invalid <fn>: escrows[N] must be an Escrow` naming the first
 * bad entry. Entries are checked with `instanceof Escrow`: the
 * selectors read `state`, `history`, `isTerminal`, and
 * `getDeadline()`, which only a real `Escrow` guarantees, and no
 * caller in this repo passes a plain-object stand-in to a selector,
 * so a hand-built object with the right fields is rejected on
 * purpose. The guard also covers the executors that screen through
 * these selectors (`expireOverdueEscrows` via `expiredEscrows`,
 * `actOnStaleEscrows` via `staleEscrows`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  actOnStaleEscrows,
  Escrow,
  escrowsApproachingDeadline,
  escrowsByActor,
  escrowsByEvent,
  escrowsByFilters,
  escrowsBySettlementRef,
  escrowsByState,
  expiredEscrows,
  expireOverdueEscrows,
  staleEscrows,
} from "../src/index.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const DAY = 24 * 3600_000;
const iso = (d: Date): string => d.toISOString();
const daysAgo = (n: number): string => iso(new Date(NOW.getTime() - n * DAY));

function fundedEscrow(id: string, actor?: string): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch(
    "FUND",
    "initial deposit",
    1000,
    actor === undefined ? undefined : { actor },
  );
  return escrow;
}

function releasedEscrow(id: string, settlementRef?: string): Escrow {
  const escrow = fundedEscrow(id);
  escrow.dispatch("SUBMIT_MILESTONE");
  escrow.dispatch("VERIFY_PASS");
  escrow.dispatch("RELEASE", undefined, undefined, {
    ...(settlementRef !== undefined ? { settlementRef } : {}),
  });
  return escrow;
}

function fundedAt(id: string, at: string): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 1000, { at });
  return escrow;
}

function deadlineEscrow(id: string, deadline: string): Escrow {
  const escrow = fundedEscrow(id);
  escrow.setDeadline(deadline);
  return escrow;
}

type Selector = (escrows: unknown) => unknown;

const SELECTORS: Array<{ name: string; call: Selector }> = [
  {
    name: "expiredEscrows",
    call: (escrows) =>
      expiredEscrows(escrows as readonly Escrow[], NOW),
  },
  {
    name: "escrowsByState",
    call: (escrows) =>
      escrowsByState(escrows as readonly Escrow[], "FUNDED"),
  },
  {
    name: "escrowsByActor",
    call: (escrows) => escrowsByActor(escrows as readonly Escrow[], "alice"),
  },
  {
    name: "escrowsByEvent",
    call: (escrows) => escrowsByEvent(escrows as readonly Escrow[], "FUND"),
  },
  {
    name: "escrowsBySettlementRef",
    call: (escrows) =>
      escrowsBySettlementRef(escrows as readonly Escrow[], "0xabc123"),
  },
  {
    name: "escrowsByFilters",
    call: (escrows) =>
      escrowsByFilters(escrows as readonly Escrow[], {}, NOW),
  },
  {
    name: "escrowsApproachingDeadline",
    call: (escrows) =>
      escrowsApproachingDeadline(escrows as readonly Escrow[], DAY, NOW),
  },
  {
    name: "staleEscrows",
    call: (escrows) =>
      staleEscrows(escrows as readonly Escrow[], { FUNDED: 7 * DAY }, NOW),
  },
];

function throwsNamed(
  fn: () => unknown,
  message: string,
): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.message, message);
    return true;
  });
}

describe("batch selector batch-shape guards", () => {
  for (const { name, call } of SELECTORS) {
    it(`${name}: non-array batch throws a named error`, () => {
      for (const bad of [null, undefined, "x", 42, {}]) {
        throwsNamed(
          () => call(bad),
          `invalid ${name}: escrows must be an array, got ${bad === null ? "null" : typeof bad}`,
        );
      }
    });

    it(`${name}: non-Escrow entry throws naming its index`, () => {
      for (const bad of [null, "x", 42, {}]) {
        throwsNamed(
          () => call([bad]),
          `invalid ${name}: escrows[0] must be an Escrow, got ${bad === null ? "null" : typeof bad}`,
        );
      }
      // A bad entry past a good one is named by its own index, and
      // nothing is returned: the whole call fails, it never yields a
      // partial selection.
      const good = fundedEscrow(`${name}-good`);
      throwsNamed(
        () => call([good, null, good]),
        `invalid ${name}: escrows[1] must be an Escrow, got null`,
      );
    });

    it(`${name}: a plain-object stand-in is rejected, not treated as an escrow`, () => {
      const standIn = { id: "fake", state: "FUNDED", history: [] };
      throwsNamed(
        () => call([standIn]),
        `invalid ${name}: escrows[0] must be an Escrow, got object`,
      );
    });

    it(`${name}: the batch guard runs before filter-parameter validation`, () => {
      // A bad batch AND a bad filter value: the batch error wins, so a
      // malformed batch is never masked by (or mistaken for) a bad
      // filter value.
      const badFilterCalls: Record<string, () => unknown> = {
        escrowsByState: () =>
          escrowsByState(null as unknown as readonly Escrow[], "NOPE" as never),
        escrowsByActor: () =>
          escrowsByActor(null as unknown as readonly Escrow[], ""),
        escrowsByEvent: () =>
          escrowsByEvent(null as unknown as readonly Escrow[], "NOPE" as never),
        escrowsBySettlementRef: () =>
          escrowsBySettlementRef(null as unknown as readonly Escrow[], ""),
        escrowsByFilters: () =>
          escrowsByFilters(null as unknown as readonly Escrow[], {
            state: "NOPE",
          } as never),
        escrowsApproachingDeadline: () =>
          escrowsApproachingDeadline(
            null as unknown as readonly Escrow[],
            -1,
            NOW,
          ),
        staleEscrows: () =>
          staleEscrows(null as unknown as readonly Escrow[], {
            NOPE: 1,
          } as never, NOW),
        expiredEscrows: () =>
          expiredEscrows(null as unknown as readonly Escrow[], NOW),
      };
      throwsNamed(
        badFilterCalls[name],
        `invalid ${name}: escrows must be an array, got null`,
      );
    });

    it(`${name}: an empty batch returns an empty selection`, () => {
      assert.deepEqual(call([]), []);
    });
  }

  it("escrowsByFilters([null], {}) no longer silently returns [null]", () => {
    throwsNamed(
      () => escrowsByFilters([null] as unknown as readonly Escrow[], {}, NOW),
      "invalid escrowsByFilters: escrows[0] must be an Escrow, got null",
    );
  });

  it("escrowsBySettlementRef([null], ref) no longer throws a bare TypeError", () => {
    throwsNamed(
      () =>
        escrowsBySettlementRef(
          [null] as unknown as readonly Escrow[],
          "0xabc123",
        ),
      "invalid escrowsBySettlementRef: escrows[0] must be an Escrow, got null",
    );
  });

  it("legal batches return the same selections as before", () => {
    const funded = fundedEscrow("sel-funded", "alice");
    const created = new Escrow("sel-created");
    const released = releasedEscrow("sel-released", "0xabc123");
    const overdue = deadlineEscrow("sel-overdue", daysAgo(1));
    const approaching = deadlineEscrow(
      "sel-approaching",
      iso(new Date(NOW.getTime() + DAY / 2)),
    );
    const stale = fundedAt("sel-stale", daysAgo(30));
    const batch = [funded, created, released, overdue, approaching, stale];

    assert.deepEqual(
      escrowsByState(batch, "FUNDED").map((e) => e.id),
      ["sel-funded", "sel-overdue", "sel-approaching", "sel-stale"],
    );
    assert.deepEqual(
      escrowsByActor(batch, "alice").map((e) => e.id),
      ["sel-funded"],
    );
    assert.deepEqual(
      escrowsByEvent(batch, "RELEASE").map((e) => e.id),
      ["sel-released"],
    );
    assert.deepEqual(
      escrowsBySettlementRef(batch, "0xabc123").map((e) => e.id),
      ["sel-released"],
    );
    assert.deepEqual(
      escrowsByFilters(batch, { state: "FUNDED", actor: "alice" }).map(
        (e) => e.id,
      ),
      ["sel-funded"],
    );
    // An empty filter object still selects every escrow.
    assert.deepEqual(
      escrowsByFilters(batch, {}).map((e) => e.id),
      batch.map((e) => e.id),
    );
    assert.deepEqual(
      expiredEscrows(batch, NOW).map((e) => e.id),
      ["sel-overdue"],
    );
    assert.deepEqual(
      escrowsApproachingDeadline(batch, DAY, NOW).map((e) => e.id),
      ["sel-approaching"],
    );
    assert.deepEqual(
      staleEscrows(batch, { FUNDED: 7 * DAY }, NOW).map((e) => e.id),
      ["sel-stale"],
    );
  });

  it("expireOverdueEscrows inherits the guard from expiredEscrows", () => {
    throwsNamed(
      () => expireOverdueEscrows(null as unknown as readonly Escrow[], NOW),
      "invalid expiredEscrows: escrows must be an array, got null",
    );
    throwsNamed(
      () =>
        expireOverdueEscrows(
          [null] as unknown as readonly Escrow[],
          NOW,
        ),
      "invalid expiredEscrows: escrows[0] must be an Escrow, got null",
    );
  });

  it("actOnStaleEscrows inherits the guard from staleEscrows", () => {
    throwsNamed(
      () =>
        actOnStaleEscrows(
          null as unknown as readonly Escrow[],
          () => {},
          { FUNDED: 7 * DAY },
          NOW,
        ),
      "invalid staleEscrows: escrows must be an array, got null",
    );
    throwsNamed(
      () =>
        actOnStaleEscrows(
          [null] as unknown as readonly Escrow[],
          () => {},
          { FUNDED: 7 * DAY },
          NOW,
        ),
      "invalid staleEscrows: escrows[0] must be an Escrow, got null",
    );
  });
});
