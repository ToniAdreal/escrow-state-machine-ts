import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createQuorum } from "../src/quorum.js";

const NINE = ["dao-1", "dao-2", "dao-3", "dao-4", "dao-5", "dao-6", "dao-7", "dao-8", "dao-9"];

describe("quorum: revoke", () => {
  it("5/9 reaching quorum, then revoking one vote drops below threshold", () => {
    const q = createQuorum({ threshold: 5, signers: NINE });
    for (let i = 0; i < 5; i++) q.approve(NINE[i]);
    assert.equal(q.hasQuorum(), true);
    q.revoke("dao-3");
    assert.equal(q.hasQuorum(), false);
    assert.equal(q.approvalCount(), 4);
    assert.deepEqual(q.approvals(), ["dao-1", "dao-2", "dao-4", "dao-5"]);
  });

  it("re-approving after revoke brings quorum back", () => {
    const q = createQuorum({ threshold: 2, signers: ["a", "b"] });
    q.approve("a");
    q.approve("b");
    assert.equal(q.hasQuorum(), true);
    q.revoke("a");
    assert.equal(q.hasQuorum(), false);
    q.approve("a");
    assert.equal(q.hasQuorum(), true);
    assert.deepEqual(q.approvals(), ["b", "a"]); // order follows approval time
  });

  it("throws for unknown signer", () => {
    const q = createQuorum({ threshold: 2, signers: ["a", "b"] });
    assert.throws(() => q.revoke("mallory"), /unknown quorum signer/);
  });

  it("throws for a signer that never approved", () => {
    const q = createQuorum({ threshold: 2, signers: ["a", "b"] });
    q.approve("a");
    assert.throws(() => q.revoke("b"), /has not approved/);
  });

  it("revoking every vote empties the quorum cleanly", () => {
    const q = createQuorum({ threshold: 2, signers: ["a", "b"] });
    q.approve("a");
    q.approve("b");
    q.revoke("a");
    q.revoke("b");
    assert.equal(q.approvalCount(), 0);
    assert.deepEqual(q.approvals(), []);
    assert.equal(q.hasQuorum(), false);
  });

  it("approve stays idempotent across a revoke boundary", () => {
    const q = createQuorum({ threshold: 2, signers: ["a", "b"] });
    q.approve("a");
    q.approve("a"); // no double count
    q.revoke("a");
    assert.equal(q.approvalCount(), 0);
    q.approve("a");
    assert.equal(q.approvalCount(), 1);
  });
});
