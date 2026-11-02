import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createQuorum, restoreQuorum } from "../src/index.js";
import type { QuorumConfig, QuorumSnapshot } from "../src/index.js";

/**
 * Quorum approval evidence references (backlog #831).
 *
 * Rules under test:
 *  - `approve(signerId, evidence?)` records an optional non-empty
 *    string reference on the approval log entry and on the snapshot,
 *    and only there — approvals without evidence keep the exact
 *    legacy `{ signerId, at }` shape
 *  - evidence is a caller assertion: the quorum records it verbatim
 *    and never verifies it, so counting is identical with or
 *    without evidence
 *  - illegal evidence (empty string, non-string) is rejected with
 *    no side effect, and a snapshot whose evidence was corrupted to
 *    an illegal value is rejected by `restoreQuorum`
 *  - revoke removes the signer's entries together with their
 *    evidence; a counted re-approval is a no-op and does not replace
 *    the recorded evidence, while a re-approval after expiry appends
 *    a fresh entry whose evidence becomes the signer's latest
 */

const NINE = [
  "dao-1", "dao-2", "dao-3", "dao-4", "dao-5",
  "dao-6", "dao-7", "dao-8", "dao-9",
];
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

describe("quorum evidence: recording", () => {
  it("records evidence on the log entry and on the snapshot", () => {
    const q = createQuorum({ threshold: 2, signers: NINE });
    q.approve("dao-1", "gov-proposal-42");
    const log = q.approvalLog();
    assert.equal(log.length, 1);
    assert.equal(log[0].signerId, "dao-1");
    assert.equal(log[0].evidence, "gov-proposal-42");
    const snap = q.snapshot();
    assert.equal(snap.approvals.length, 1);
    assert.equal(snap.approvals[0].evidence, "gov-proposal-42");
  });

  it("keeps the exact legacy shape for approvals without evidence", () => {
    const q = createQuorum({ threshold: 2, signers: NINE });
    q.approve("dao-1");
    const log = q.approvalLog();
    assert.equal(log.length, 1);
    assert.deepEqual(Object.keys(log[0]).sort(), ["at", "signerId"]);
    assert.equal("evidence" in log[0], false);
    const snap = q.snapshot();
    assert.deepEqual(Object.keys(snap.approvals[0]).sort(), [
      "at",
      "signerId",
    ]);
    assert.equal("evidence" in snap.approvals[0], false);
  });

  it("round-trips evidence through snapshot restore", () => {
    const clock = fakeClock();
    const config: QuorumConfig = {
      threshold: 2,
      signers: NINE,
      now: clock.now,
    };
    const q = createQuorum(config);
    q.approve("dao-1", "vote-record-001");
    clock.advance(1_000);
    q.approve("dao-2");
    const restored = roundTrip(config, q.snapshot());
    const log = restored.approvalLog();
    assert.equal(log.length, 2);
    assert.equal(log[0].evidence, "vote-record-001");
    assert.equal("evidence" in log[1], false);
    assert.deepEqual(restored.snapshot(), q.snapshot());
  });

  it("does not change counting: evidence approvals count the same", () => {
    const q = createQuorum({ threshold: 2, signers: NINE });
    q.approve("dao-1", "gov-proposal-42");
    assert.equal(q.approvalCount(), 1);
    assert.equal(q.hasQuorum(), false);
    q.approve("dao-2");
    assert.equal(q.approvalCount(), 2);
    assert.equal(q.hasQuorum(), true);
    assert.deepEqual(q.approvals(), ["dao-1", "dao-2"]);
  });
});

describe("quorum evidence: rejection", () => {
  it("rejects an empty-string evidence with no side effect", () => {
    const q = createQuorum({ threshold: 2, signers: NINE });
    assert.throws(
      () => q.approve("dao-1", ""),
      /evidence must be a non-empty string/
    );
    assert.equal(q.approvalCount(), 0);
    assert.deepEqual(q.approvalLog(), []);
  });

  it("rejects non-string evidence with no side effect", () => {
    const q = createQuorum({ threshold: 2, signers: NINE });
    for (const bad of [123, null, {}, true]) {
      assert.throws(
        () => q.approve("dao-1", bad as unknown as string),
        /evidence must be a non-empty string/
      );
    }
    assert.equal(q.approvalCount(), 0);
    assert.deepEqual(q.approvalLog(), []);
  });

  it("rejects a counted re-approval carrying illegal evidence", () => {
    const q = createQuorum({ threshold: 2, signers: NINE });
    q.approve("dao-1", "gov-proposal-42");
    assert.throws(
      () => q.approve("dao-1", ""),
      /evidence must be a non-empty string/
    );
    // The original entry survives untouched.
    assert.equal(q.approvalLog().length, 1);
    assert.equal(q.approvalLog()[0].evidence, "gov-proposal-42");
  });

  it("rejects a snapshot whose evidence was tampered to an empty string", () => {
    const config: QuorumConfig = { threshold: 2, signers: NINE };
    const q = createQuorum(config);
    q.approve("dao-1", "gov-proposal-42");
    const tampered = q.snapshot() as unknown as {
      approvals: { evidence?: unknown }[];
    };
    tampered.approvals[0].evidence = "";
    assert.throws(
      () => restoreQuorum(config, tampered),
      /invalid quorum snapshot: .*evidence must be a non-empty string/
    );
  });

  it("rejects a snapshot whose evidence was tampered to a non-string", () => {
    const config: QuorumConfig = { threshold: 2, signers: NINE };
    const q = createQuorum(config);
    q.approve("dao-1", "gov-proposal-42");
    const tampered = q.snapshot() as unknown as {
      approvals: { evidence?: unknown }[];
    };
    tampered.approvals[0].evidence = 123;
    assert.throws(
      () => restoreQuorum(config, tampered),
      /invalid quorum snapshot: .*evidence must be a non-empty string/
    );
  });
});

describe("quorum evidence: revoke and re-approval", () => {
  it("revoke removes the signer's evidence together with its entries", () => {
    const q = createQuorum({ threshold: 2, signers: NINE });
    q.approve("dao-1", "gov-proposal-42");
    q.revoke("dao-1");
    assert.deepEqual(q.approvalLog(), []);
    assert.deepEqual(q.snapshot().approvals, []);
    // Re-approving without evidence leaves no stale evidence behind.
    q.approve("dao-1");
    assert.equal(q.approvalLog().length, 1);
    assert.equal("evidence" in q.approvalLog()[0], false);
  });

  it("a counted re-approval is a no-op and keeps the original evidence", () => {
    const q = createQuorum({ threshold: 2, signers: NINE });
    q.approve("dao-1", "gov-proposal-42");
    q.approve("dao-1", "gov-proposal-99");
    assert.equal(q.approvalLog().length, 1);
    assert.equal(q.approvalLog()[0].evidence, "gov-proposal-42");
  });

  it("an expired re-approval appends a fresh entry with the new evidence", () => {
    const clock = fakeClock();
    const config: QuorumConfig = {
      threshold: 1,
      signers: NINE,
      now: clock.now,
      maxApprovalAgeMs: 60_000,
    };
    const q = createQuorum(config);
    q.approve("dao-1", "vote-record-old");
    clock.advance(61_000);
    assert.equal(q.approvalCount(), 0, "old approval must have expired");
    q.approve("dao-1", "vote-record-new");
    assert.equal(q.approvalCount(), 1);
    const log = q.approvalLog();
    assert.equal(log.length, 2);
    assert.equal(log[0].evidence, "vote-record-old");
    assert.equal(log[1].evidence, "vote-record-new");
    // The latest entry is what counts, and it survives a restore.
    const restored = roundTrip(config, q.snapshot());
    const restoredLog = restored.approvalLog();
    assert.equal(restoredLog.length, 2);
    assert.equal(restoredLog[1].evidence, "vote-record-new");
    assert.equal(restored.approvalCount(), 1);
  });
});
