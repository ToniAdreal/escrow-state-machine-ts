import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  createQuorum,
  dispatchArbitration,
} from "../src/index.js";

/**
 * Quorum approval expiry window (backlog #162).
 *
 * Rules under test:
 *  - `maxApprovalAgeMs` is opt-in: the counting views (`hasQuorum`,
 *    `approvalCount`, `approvals`) only count approvals whose age on the
 *    injected clock is at most the window; the boundary is inclusive
 *    (age exactly `maxApprovalAgeMs` still counts), matching this repo's
 *    webhook freshness windows
 *  - expiry never deletes: `approvalLog()` keeps expired entries
 *  - re-approving after expiry appends a fresh entry and restores the
 *    signer's count; approving while still counted stays a no-op
 *  - revoking an expired approval is allowed and removes all of the
 *    signer's log entries (same semantics as revoking a live one)
 *  - invalid `maxApprovalAgeMs` throws at construction
 *  - without the option, approvals never expire (historical behavior)
 */

const SIGNERS = ["dao-1", "dao-2", "dao-3", "dao-4", "dao-5"];
const WINDOW = 60_000;

function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function expiringQuorum(clock: { now: () => number }) {
  return createQuorum({
    threshold: 3,
    signers: SIGNERS,
    now: clock.now,
    maxApprovalAgeMs: WINDOW,
  });
}

describe("quorum approval expiry window", () => {
  it("reaches quorum within the window", () => {
    const clock = fakeClock();
    const q = expiringQuorum(clock);
    q.approve("dao-1");
    clock.advance(30_000);
    q.approve("dao-2");
    q.approve("dao-3");
    assert.equal(q.hasQuorum(), true);
    assert.equal(q.approvalCount(), 3);
    assert.deepEqual(q.approvals(), ["dao-1", "dao-2", "dao-3"]);
  });

  it("falls below quorum as the clock crosses the window, count stays consistent", () => {
    const clock = fakeClock();
    const q = expiringQuorum(clock);
    q.approve("dao-1");
    clock.advance(30_000);
    q.approve("dao-2");
    q.approve("dao-3");
    assert.equal(q.hasQuorum(), true);
    clock.advance(30_001); // dao-1 is now 60_001 old; dao-2/dao-3 are 30_001
    assert.equal(q.hasQuorum(), false);
    assert.equal(q.approvalCount(), 2);
    assert.deepEqual(q.approvals(), ["dao-2", "dao-3"]);
  });

  it("boundary is inclusive: age exactly maxApprovalAgeMs still counts", () => {
    const clock = fakeClock();
    const q = expiringQuorum(clock);
    q.approve("dao-1");
    clock.advance(WINDOW);
    assert.equal(q.approvalCount(), 1);
    clock.advance(1);
    assert.equal(q.approvalCount(), 0);
  });

  it("re-approving after expiry restores the count with a fresh timestamp", () => {
    const clock = fakeClock();
    const q = expiringQuorum(clock);
    q.approve("dao-1");
    q.approve("dao-2");
    q.approve("dao-3");
    clock.advance(WINDOW + 1);
    assert.equal(q.hasQuorum(), false);
    q.approve("dao-1");
    assert.equal(q.approvalCount(), 1);
    assert.deepEqual(q.approvals(), ["dao-1"]);
    const log = q.approvalLog();
    const dao1 = log.filter((e) => e.signerId === "dao-1");
    assert.equal(dao1.length, 2); // superseded entry kept in the audit trail
    assert.equal(dao1[1].at, new Date(clock.now()).toISOString());
    assert.notEqual(dao1[1].at, dao1[0].at);
  });

  it("approvalLog() retains expired entries even though they no longer count", () => {
    const clock = fakeClock();
    const q = expiringQuorum(clock);
    q.approve("dao-1");
    q.approve("dao-2");
    clock.advance(WINDOW * 2);
    assert.equal(q.approvalCount(), 0);
    assert.deepEqual(
      q.approvalLog().map((e) => e.signerId),
      ["dao-1", "dao-2"]
    );
  });

  it("approving while the current approval still counts stays a no-op", () => {
    const clock = fakeClock();
    const q = expiringQuorum(clock);
    q.approve("dao-1");
    const at = q.approvalLog()[0].at;
    clock.advance(1_000);
    q.approve("dao-1");
    assert.equal(q.approvalLog().length, 1);
    assert.equal(q.approvalLog()[0].at, at);
  });

  it("revoking an expired approval succeeds and removes its log entries", () => {
    const clock = fakeClock();
    const q = expiringQuorum(clock);
    q.approve("dao-1");
    clock.advance(WINDOW + 1);
    assert.equal(q.approvalCount(), 0);
    q.revoke("dao-1"); // must not throw even though the approval expired
    assert.deepEqual(q.approvalLog(), []);
    assert.throws(() => q.revoke("dao-1"), /has not approved/);
  });

  it("rejects invalid maxApprovalAgeMs at construction", () => {
    for (const bad of [0, -1, NaN, Infinity, -Infinity, "60000", null]) {
      assert.throws(
        () =>
          createQuorum({
            threshold: 1,
            signers: SIGNERS,
            maxApprovalAgeMs: bad as never,
          }),
        /maxApprovalAgeMs must be a positive finite number/,
        `value: ${String(bad)}`
      );
    }
  });

  it("without maxApprovalAgeMs approvals never expire", () => {
    const clock = fakeClock();
    const q = createQuorum({ threshold: 2, signers: SIGNERS, now: clock.now });
    q.approve("dao-1");
    q.approve("dao-2");
    clock.advance(10 * 365 * 24 * 3600 * 1000);
    assert.equal(q.hasQuorum(), true);
    assert.equal(q.approvalCount(), 2);
  });

  it("dispatchArbitration refuses an expired quorum and accepts a refreshed one", () => {
    const clock = fakeClock();
    const escrow = new Escrow("esc-expiry");
    escrow.dispatch("FUND", undefined, 10630);
    escrow.dispatch("DISPUTE");
    const q = createQuorum({
      threshold: 5,
      signers: [...SIGNERS, "dao-6", "dao-7", "dao-8", "dao-9"],
      now: clock.now,
      maxApprovalAgeMs: WINDOW,
    });
    for (const s of ["dao-1", "dao-2", "dao-3", "dao-4", "dao-5"]) q.approve(s);
    clock.advance(WINDOW + 1);
    assert.throws(
      () => dispatchArbitration(escrow, q, "release"),
      /arbitration requires quorum: 0\/5 approvals/
    );
    assert.equal(escrow.state, "DISPUTED");
    for (const s of ["dao-1", "dao-2", "dao-3", "dao-4", "dao-5"]) q.approve(s);
    dispatchArbitration(escrow, q, "release");
    assert.equal(escrow.state, "RELEASED");
  });
});
