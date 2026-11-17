import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  approvalStatement,
  createQuorum,
  restoreQuorum,
} from "../src/index.js";
import type { QuorumConfig } from "../src/index.js";

/**
 * Quorum remaining-approvals read-only API (backlog #1213).
 *
 * Rules under test:
 *  - `remainingApprovals()` is `Math.max(0, threshold -
 *    approvalCount())` from the same counted set, so it starts at
 *    the threshold, steps down one per counted approval, and reads 0
 *    exactly when `hasQuorum()` flips true — never negative, even
 *    with approvals past the threshold
 *  - revoke raises it again; re-approving after a revoke lowers it
 *  - with `maxApprovalAgeMs`, an expired approval stops counting so
 *    the remaining rises, the expired entry stays in
 *    `approvalLog()`, and re-approving records a fresh timestamp and
 *    lowers it again (the expiry boundary is inclusive)
 *  - `snapshot()` / `restoreQuorum()` preserve it, and a restore at
 *    a later clock ages approvals from their original timestamps —
 *    there is no `fromHistory` on Quorum; `restoreQuorum` is its
 *    rebuild path
 *  - it is a pure read: calling it never changes the log, and a
 *    duplicate (no-op) approval leaves it unchanged
 *  - signature-verified votes (`approveSigned()`) count identically
 */

const SIGNERS = ["dao-1", "dao-2", "dao-3", "dao-4", "dao-5"];
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

describe("quorum remainingApprovals", () => {
  it("starts at the threshold before any approval", () => {
    const q = createQuorum({ threshold: 3, signers: SIGNERS });
    assert.equal(q.remainingApprovals(), 3);
    assert.equal(q.hasQuorum(), false);
  });

  it("steps down one per approval and hits 0 exactly when hasQuorum flips", () => {
    const q = createQuorum({ threshold: 3, signers: SIGNERS });
    q.approve("dao-1");
    assert.equal(q.remainingApprovals(), 2);
    assert.equal(q.hasQuorum(), false);
    q.approve("dao-2");
    assert.equal(q.remainingApprovals(), 1);
    assert.equal(q.hasQuorum(), false);
    q.approve("dao-3");
    assert.equal(q.remainingApprovals(), 0);
    assert.equal(q.hasQuorum(), true);
  });

  it("stays 0 for approvals past the threshold, never negative", () => {
    const q = createQuorum({ threshold: 2, signers: SIGNERS });
    q.approve("dao-1");
    q.approve("dao-2");
    q.approve("dao-3");
    q.approve("dao-4");
    q.approve("dao-5");
    assert.equal(q.remainingApprovals(), 0);
    assert.equal(q.approvalCount(), 5);
    assert.equal(q.hasQuorum(), true);
  });

  it("a duplicate approve is a no-op and leaves the remaining unchanged", () => {
    const q = createQuorum({ threshold: 3, signers: SIGNERS });
    q.approve("dao-1");
    assert.equal(q.remainingApprovals(), 2);
    q.approve("dao-1");
    assert.equal(q.remainingApprovals(), 2);
    assert.equal(q.approvalCount(), 1);
  });

  it("revoke raises the remaining and re-approving lowers it again", () => {
    const q = createQuorum({ threshold: 2, signers: SIGNERS });
    q.approve("dao-1");
    q.approve("dao-2");
    assert.equal(q.remainingApprovals(), 0);
    q.revoke("dao-2");
    assert.equal(q.remainingApprovals(), 1);
    assert.equal(q.hasQuorum(), false);
    q.approve("dao-2");
    assert.equal(q.remainingApprovals(), 0);
    assert.equal(q.hasQuorum(), true);
  });

  it("an expired approval raises the remaining but stays in the log", () => {
    const clock = fakeClock();
    const q = createQuorum({
      threshold: 2,
      signers: SIGNERS,
      now: clock.now,
      maxApprovalAgeMs: WINDOW,
    });
    q.approve("dao-1");
    assert.equal(q.remainingApprovals(), 1);
    clock.advance(WINDOW + 1);
    assert.equal(q.remainingApprovals(), 2);
    assert.equal(q.hasQuorum(), false);
    // Expiry never deletes: the trail still shows the vote.
    assert.equal(q.approvalLog().length, 1);
    assert.equal(q.approvalLog()[0].signerId, "dao-1");
  });

  it("re-approving after expiry lowers the remaining again", () => {
    const clock = fakeClock();
    const q = createQuorum({
      threshold: 2,
      signers: SIGNERS,
      now: clock.now,
      maxApprovalAgeMs: WINDOW,
    });
    q.approve("dao-1");
    clock.advance(WINDOW + 1);
    assert.equal(q.remainingApprovals(), 2);
    q.approve("dao-1");
    assert.equal(q.remainingApprovals(), 1);
    assert.equal(q.approvalCount(), 1);
    // The re-approval appended a fresh entry; the expired one stays.
    assert.equal(q.approvalLog().length, 2);
  });

  it("the expiry boundary is inclusive: exactly maxApprovalAgeMs still counts", () => {
    const clock = fakeClock();
    const q = createQuorum({
      threshold: 2,
      signers: SIGNERS,
      now: clock.now,
      maxApprovalAgeMs: WINDOW,
    });
    q.approve("dao-1");
    clock.advance(WINDOW);
    assert.equal(q.remainingApprovals(), 1);
    clock.advance(1);
    assert.equal(q.remainingApprovals(), 2);
  });

  it("threshold 1 reads 1 then 0", () => {
    const q = createQuorum({ threshold: 1, signers: SIGNERS });
    assert.equal(q.remainingApprovals(), 1);
    q.approve("dao-4");
    assert.equal(q.remainingApprovals(), 0);
    assert.equal(q.hasQuorum(), true);
  });

  it("snapshot round-trip preserves the remaining", () => {
    const clock = fakeClock();
    const config: QuorumConfig = {
      threshold: 3,
      signers: SIGNERS,
      now: clock.now,
    };
    const q = createQuorum(config);
    q.approve("dao-1");
    q.approve("dao-2");
    const restored = restoreQuorum(
      config,
      JSON.parse(JSON.stringify(q.snapshot())),
    );
    assert.equal(restored.remainingApprovals(), 1);
    assert.equal(restored.approvalCount(), 2);
    restored.approve("dao-3");
    assert.equal(restored.remainingApprovals(), 0);
  });

  it("a restore at a later clock ages approvals from their original timestamps", () => {
    const clock = fakeClock();
    const config: QuorumConfig = {
      threshold: 2,
      signers: SIGNERS,
      now: clock.now,
      maxApprovalAgeMs: WINDOW,
    };
    const q = createQuorum(config);
    q.approve("dao-1");
    const snapshot = JSON.parse(JSON.stringify(q.snapshot()));
    clock.advance(WINDOW + 1);
    const restored = restoreQuorum(config, snapshot);
    // Restoring never refreshes the approval: it is already expired.
    assert.equal(restored.remainingApprovals(), 2);
    restored.approve("dao-1");
    assert.equal(restored.remainingApprovals(), 1);
  });

  it("is a pure read: repeated calls change nothing", () => {
    const q = createQuorum({ threshold: 3, signers: SIGNERS });
    q.approve("dao-1");
    const before = q.approvalLog();
    assert.equal(q.remainingApprovals(), 2);
    assert.equal(q.remainingApprovals(), 2);
    assert.equal(q.remainingApprovals(), 2);
    assert.deepEqual(q.approvalLog(), before);
    assert.equal(q.approvalCount(), 1);
  });

  it("always agrees with threshold - approvalCount() at every step", () => {
    const clock = fakeClock();
    const q = createQuorum({
      threshold: 3,
      signers: SIGNERS,
      now: clock.now,
      maxApprovalAgeMs: WINDOW,
    });
    const expectAgreement = () =>
      assert.equal(
        q.remainingApprovals(),
        Math.max(0, q.threshold - q.approvalCount()),
      );
    expectAgreement();
    q.approve("dao-1");
    expectAgreement();
    q.approve("dao-2");
    expectAgreement();
    clock.advance(WINDOW + 1);
    expectAgreement();
    q.approve("dao-3");
    expectAgreement();
    q.revoke("dao-3");
    expectAgreement();
  });

  it("a signature-verified vote counts identically", () => {
    const pair = generateKeyPairSync("ed25519");
    const q = createQuorum({
      threshold: 2,
      signers: SIGNERS,
      signerPublicKeys: { "dao-1": pair.publicKey },
    });
    assert.equal(q.remainingApprovals(), 2);
    q.approveSigned(
      "dao-1",
      sign(null, approvalStatement("dao-1"), pair.privateKey),
    );
    assert.equal(q.remainingApprovals(), 1);
    assert.equal(q.approvalLog()[0].verified, true);
  });
});
