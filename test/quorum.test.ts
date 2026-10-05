import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createQuorum } from "../src/quorum.js";

const NINE = ["dao-1", "dao-2", "dao-3", "dao-4", "dao-5", "dao-6", "dao-7", "dao-8", "dao-9"];

describe("quorum: 5/9 threshold example", () => {
  it("reaches quorum exactly at the 5th distinct approval", () => {
    const q = createQuorum({ threshold: 5, signers: NINE });
    for (let i = 0; i < 4; i++) {
      q.approve(NINE[i]);
      assert.equal(q.hasQuorum(), false, `should not have quorum at ${i + 1}/9`);
    }
    q.approve(NINE[4]);
    assert.equal(q.hasQuorum(), true);
  });

  it("stays quorate after further approvals", () => {
    const q = createQuorum({ threshold: 5, signers: NINE });
    for (let i = 0; i < 9; i++) q.approve(NINE[i]);
    assert.equal(q.hasQuorum(), true);
    assert.equal(q.approvalCount(), 9);
  });

  it("approvals() preserves approval order", () => {
    const q = createQuorum({ threshold: 2, signers: NINE });
    q.approve("dao-9");
    q.approve("dao-1");
    assert.deepEqual(q.approvals(), ["dao-9", "dao-1"]);
  });
});

describe("quorum: idempotency", () => {
  it("re-approving the same signer does not double count", () => {
    const q = createQuorum({ threshold: 2, signers: NINE });
    q.approve("dao-1");
    q.approve("dao-1");
    q.approve("dao-1");
    assert.equal(q.approvalCount(), 1);
    assert.equal(q.hasQuorum(), false);
    assert.deepEqual(q.approvals(), ["dao-1"]);
  });
});

describe("quorum: unknown signers", () => {
  it("throws on an unknown signer id", () => {
    const q = createQuorum({ threshold: 5, signers: NINE });
    assert.throws(() => q.approve("not-a-signer"), /unknown quorum signer/);
    assert.equal(q.approvalCount(), 0);
  });

  it("does not accept approvals after a rejected one", () => {
    const q = createQuorum({ threshold: 5, signers: NINE });
    assert.throws(() => q.approve(""), /unknown quorum signer/);
    q.approve("dao-1");
    assert.equal(q.approvalCount(), 1);
  });
});

describe("quorum: config validation", () => {
  it("rejects empty signer lists", () => {
    assert.throws(() => createQuorum({ threshold: 1, signers: [] }), /non-empty array/);
  });

  it("rejects duplicated signer ids", () => {
    assert.throws(
      () => createQuorum({ threshold: 2, signers: ["a", "a", "b"] }),
      /duplicated/
    );
  });

  it("rejects empty-string signer ids", () => {
    assert.throws(
      () => createQuorum({ threshold: 1, signers: ["ok", ""] }),
      /non-empty strings/
    );
  });

  it("rejects threshold < 1", () => {
    assert.throws(() => createQuorum({ threshold: 0, signers: NINE }), /≥ 1/);
    assert.throws(() => createQuorum({ threshold: -3, signers: NINE }), /≥ 1/);
  });

  it("rejects non-integer thresholds", () => {
    assert.throws(() => createQuorum({ threshold: 2.5, signers: NINE }), /integer/);
  });

  it("rejects threshold above the signer count", () => {
    assert.throws(
      () => createQuorum({ threshold: 10, signers: NINE }),
      /exceeds signer count/
    );
  });

  it("exposes threshold and signerCount", () => {
    const q = createQuorum({ threshold: 5, signers: NINE });
    assert.equal(q.threshold, 5);
    assert.equal(q.signerCount, 9);
  });
});
