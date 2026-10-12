import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createQuorum,
  restoreQuorum,
} from "../src/index.js";
import type { QuorumConfig, QuorumSnapshot } from "../src/index.js";

/**
 * Quorum snapshot export / restore (backlog #226).
 *
 * Rules under test:
 *  - `snapshot()` exports the full approval audit trail (expired and
 *    superseded entries included) plus the config it was collected
 *    under, as detached plain JSON
 *  - `restoreQuorum(config, snapshot)` round-trips counting state:
 *    `hasQuorum()` / `approvalCount()` / `approvals()` / approval
 *    timestamps are identical, and approve/revoke keep working
 *  - expiry ages from the *original* timestamps after a restore —
 *    restoring never refreshes an approval
 *  - corrupt snapshots fail loudly: unknown signer, exact duplicate
 *    entry, bad/non-canonical timestamp, out-of-order entries, and
 *    any mismatch with the supplied config (threshold, signer set,
 *    maxApprovalAgeMs) are all rejected
 */

const NINE = [
  "dao-1", "dao-2", "dao-3", "dao-4", "dao-5",
  "dao-6", "dao-7", "dao-8", "dao-9",
];
const WINDOW = 60_000;
const T0 = 1_700_000_000_000;

function fakeClock(start = T0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function roundTrip(config: QuorumConfig, snapshot: QuorumSnapshot) {
  // Persist + reparse, like a real restart would.
  return restoreQuorum(config, JSON.parse(JSON.stringify(snapshot)));
}

describe("quorum snapshot: round-trip", () => {
  it("restores counting state and timestamps exactly (5/9 example)", () => {
    const clock = fakeClock();
    const config: QuorumConfig = { threshold: 5, signers: NINE, now: clock.now };
    const q = createQuorum(config);
    for (const s of NINE.slice(0, 4)) {
      q.approve(s);
      clock.advance(1_000);
    }
    assert.equal(q.hasQuorum(), false);
    const restored = roundTrip(config, q.snapshot());
    assert.equal(restored.hasQuorum(), false);
    assert.equal(restored.approvalCount(), 4);
    assert.deepEqual(restored.approvals(), q.approvals());
    assert.deepEqual(restored.approvalLog(), q.approvalLog());
    assert.equal(restored.threshold, 5);
    assert.equal(restored.signerCount, 9);
    restored.approve("dao-5");
    assert.equal(restored.hasQuorum(), true);
  });

  it("keeps a reached threshold reached across the restore", () => {
    const clock = fakeClock();
    const config: QuorumConfig = { threshold: 5, signers: NINE, now: clock.now };
    const q = createQuorum(config);
    for (const s of NINE.slice(0, 7)) q.approve(s);
    const restored = roundTrip(config, q.snapshot());
    assert.equal(restored.hasQuorum(), true);
    assert.equal(restored.approvalCount(), 7);
  });

  it("restored quorum keeps approving and revoking normally", () => {
    const clock = fakeClock();
    const config: QuorumConfig = { threshold: 3, signers: NINE.slice(0, 5), now: clock.now };
    const q = createQuorum(config);
    q.approve("dao-1");
    q.approve("dao-2");
    const restored = roundTrip(config, q.snapshot());
    restored.revoke("dao-1");
    assert.deepEqual(restored.approvals(), ["dao-2"]);
    restored.approve("dao-3");
    restored.approve("dao-4");
    assert.equal(restored.hasQuorum(), true);
    assert.throws(() => restored.approve("mallory"), /unknown quorum signer/);
    assert.throws(() => restored.revoke("dao-1"), /has not approved/);
  });

  it("snapshot() is detached: mutating it cannot alter the quorum", () => {
    const clock = fakeClock();
    const config: QuorumConfig = { threshold: 2, signers: NINE.slice(0, 3), now: clock.now };
    const q = createQuorum(config);
    q.approve("dao-1");
    const snap = q.snapshot();
    snap.approvals.push({ signerId: "dao-2", at: new Date(T0).toISOString() });
    snap.signers.push("mallory");
    assert.equal(q.approvalCount(), 1);
    assert.deepEqual(q.approvals(), ["dao-1"]);
    // And mutating the snapshot's input after restore cannot alter
    // the restored quorum either.
    const restored = roundTrip(config, q.snapshot());
    const snap2 = q.snapshot();
    snap2.approvals.length = 0;
    assert.equal(restored.approvalCount(), 1);
  });

  it("empty quorum snapshots round-trip (no maxApprovalAgeMs key when unset)", () => {
    const config: QuorumConfig = { threshold: 1, signers: NINE.slice(0, 2) };
    const q = createQuorum(config);
    const snap = q.snapshot();
    assert.deepEqual(snap, {
      v: 1,
      threshold: 1,
      signers: ["dao-1", "dao-2"],
      approvals: [],
    });
    assert.equal("maxApprovalAgeMs" in snap, false);
    const restored = roundTrip(config, snap);
    assert.equal(restored.approvalCount(), 0);
    assert.equal(restored.hasQuorum(), false);
  });
});

describe("quorum snapshot: expiry semantics survive restore", () => {
  it("expired approvals stay expired after restore (age from original timestamps)", () => {
    const clock = fakeClock();
    const config: QuorumConfig = {
      threshold: 3,
      signers: NINE.slice(0, 5),
      now: clock.now,
      maxApprovalAgeMs: WINDOW,
    };
    const q = createQuorum(config);
    q.approve("dao-1");
    q.approve("dao-2");
    q.approve("dao-3");
    assert.equal(q.hasQuorum(), true);
    clock.advance(WINDOW + 1); // everything expires before the snapshot
    assert.equal(q.hasQuorum(), false);
    const restored = roundTrip(config, q.snapshot());
    assert.equal(restored.hasQuorum(), false);
    assert.equal(restored.approvalCount(), 0);
    // The audit trail itself never expires.
    assert.equal(restored.approvalLog().length, 3);
  });

  it("an approval near the boundary keeps its exact remaining window after restore", () => {
    const clock = fakeClock();
    const config: QuorumConfig = {
      threshold: 1,
      signers: NINE.slice(0, 3),
      now: clock.now,
      maxApprovalAgeMs: WINDOW,
    };
    const q = createQuorum(config);
    q.approve("dao-1");
    clock.advance(WINDOW - 1_000); // 1s of window left at snapshot time
    const restored = roundTrip(config, q.snapshot());
    assert.equal(restored.approvalCount(), 1);
    clock.advance(1_000); // exactly at the boundary: still counts
    assert.equal(restored.approvalCount(), 1);
    clock.advance(1); // past it — the restore did not refresh the age
    assert.equal(restored.approvalCount(), 0);
  });

  it("superseded entries (re-approval after expiry) round-trip with both timestamps", () => {
    const clock = fakeClock();
    const config: QuorumConfig = {
      threshold: 1,
      signers: NINE.slice(0, 3),
      now: clock.now,
      maxApprovalAgeMs: WINDOW,
    };
    const q = createQuorum(config);
    q.approve("dao-1");
    clock.advance(WINDOW + 1);
    q.approve("dao-1"); // fresh entry; the old one stays in the log
    const restored = roundTrip(config, q.snapshot());
    assert.deepEqual(restored.approvalLog(), q.approvalLog());
    assert.equal(restored.approvalLog().length, 2);
    assert.equal(restored.approvalCount(), 1);
    assert.equal(restored.snapshot().maxApprovalAgeMs, WINDOW);
  });
});

describe("quorum snapshot: corrupt snapshots are rejected", () => {
  const clock = fakeClock();
  const config: QuorumConfig = { threshold: 2, signers: NINE.slice(0, 5), now: clock.now };
  const at = (ms: number) => new Date(T0 + ms).toISOString();
  function validSnapshot(): QuorumSnapshot {
    const q = createQuorum(config);
    q.approve("dao-1");
    clock.advance(1_000);
    q.approve("dao-2");
    return q.snapshot();
  }

  it("rejects an approval from an unknown signer", () => {
    const snap = validSnapshot();
    snap.approvals.push({ signerId: "mallory", at: at(2_000) });
    assert.throws(() => restoreQuorum(config, snap), /invalid quorum snapshot: approvals\[2\]: unknown signer/);
  });

  it("rejects an exact duplicate approval entry", () => {
    const snap = validSnapshot();
    snap.approvals.push({ ...snap.approvals[1] });
    // Inserted at the end with an earlier timestamp: duplicate fires
    // before the ordering check only if equal position — duplicate is
    // detected regardless of position.
    assert.throws(() => restoreQuorum(config, snap), /duplicate approval entry/);
  });

  it("rejects bad and non-canonical timestamps", () => {
    for (const bad of ["not-a-date", "2023-11-14 22:13:20", "2023-11-14T22:13:20Z", 12345, null]) {
      const snap = validSnapshot();
      snap.approvals[0] = { signerId: "dao-1", at: bad as never };
      assert.throws(
        () => restoreQuorum(config, snap),
        /canonical ISO-8601/,
        `value: ${String(bad)}`
      );
    }
  });

  it("rejects out-of-order approval entries", () => {
    const snap = validSnapshot();
    snap.approvals.reverse();
    assert.throws(() => restoreQuorum(config, snap), /non-decreasing timestamp order/);
  });

  it("rejects config mismatches: threshold, signer set, expiry window", () => {
    const snap = validSnapshot();
    assert.throws(
      () => restoreQuorum({ ...config, threshold: 3 }, snap),
      /threshold 2 does not match config threshold 3/
    );
    assert.throws(
      () => restoreQuorum({ ...config, signers: [...NINE.slice(0, 4), "dao-x"] }, snap),
      /signers do not match config signers/
    );
    assert.throws(
      () => restoreQuorum({ ...config, maxApprovalAgeMs: WINDOW }, snap),
      /maxApprovalAgeMs undefined does not match config/
    );
    const expiring = createQuorum({ ...config, maxApprovalAgeMs: WINDOW });
    expiring.approve("dao-1");
    assert.throws(
      () => restoreQuorum(config, expiring.snapshot()),
      /maxApprovalAgeMs 60000 does not match config/
    );
  });

  it("rejects structural corruption", () => {
    const snap = validSnapshot();
    for (const bad of [null, 42, "snapshot", []]) {
      assert.throws(() => restoreQuorum(config, bad), /invalid quorum snapshot: expected a JSON object/);
    }
    assert.throws(
      () => restoreQuorum(config, { ...snap, v: 2 }),
      /unsupported snapshot version 2/
    );
    assert.throws(
      () => restoreQuorum(config, { ...snap, extra: true }),
      /unknown field "extra"/
    );
    assert.throws(
      () => restoreQuorum(config, { ...snap, approvals: "nope" }),
      /approvals must be an array/
    );
    assert.throws(
      () => restoreQuorum(config, { ...snap, approvals: [{ signerId: "dao-1" }] }),
      /canonical ISO-8601/
    );
    assert.throws(
      () =>
        restoreQuorum(config, {
          ...snap,
          approvals: [{ signerId: "dao-1", at: at(0), signature: "x" }],
        }),
      /unknown field "signature"/
    );
    assert.throws(
      () => restoreQuorum(config, { ...snap, signers: ["dao-1", "dao-1", "dao-3", "dao-4", "dao-5"] }),
      /signer id duplicated/
    );
  });

  it("accepts signer lists in a different order (signer order is not significant)", () => {
    const snap = validSnapshot();
    const reordered: QuorumConfig = {
      ...config,
      signers: [...config.signers].reverse(),
    };
    const restored = restoreQuorum(reordered, snap);
    assert.equal(restored.approvalCount(), 2);
    assert.equal(restored.hasQuorum(), true);
  });
});
