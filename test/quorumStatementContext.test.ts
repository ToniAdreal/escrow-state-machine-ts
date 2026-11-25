import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  approvalStatement,
  createQuorum,
  restoreQuorum,
} from "../src/index.js";

const SIGNERS = ["dao-1", "dao-2", "dao-3"];
const CONTEXT_A = "esc-1:release";
const CONTEXT_B = "esc-2:release";

const VERIFY_FAILED = /quorum signature verification failed for signer "dao-1"/;
const CONTEXT_CONFIG_MESSAGE =
  /quorum statementContext must be a non-empty string of at most 256 characters, got /;
const CONTEXT_STATEMENT_MESSAGE =
  /invalid approval statement: statementContext must be a non-empty string of at most 256 characters, got /;

function keyedQuorum(statementContext?: string) {
  const pair = generateKeyPairSync("ed25519");
  const quorum = createQuorum({
    threshold: 1,
    signers: SIGNERS,
    signerPublicKeys: { "dao-1": pair.publicKey },
    ...(statementContext !== undefined ? { statementContext } : {}),
    now: () => 1_000,
  });
  return { pair, quorum };
}

test("context-bound statement bytes are pinned exactly", () => {
  assert.equal(
    approvalStatement("dao-1", CONTEXT_A).toString("utf8"),
    "escrow-quorum:approve:dao-1:esc-1:release"
  );
  // Same signer, different context: different bytes.
  assert.notEqual(
    approvalStatement("dao-1", CONTEXT_A).toString("utf8"),
    approvalStatement("dao-1", CONTEXT_B).toString("utf8")
  );
  // Context never leaks into the legacy form.
  assert.notEqual(
    approvalStatement("dao-1", CONTEXT_A).toString("utf8"),
    approvalStatement("dao-1").toString("utf8")
  );
});

test("no-context statement bytes are unchanged (legacy pin)", () => {
  assert.equal(
    approvalStatement("dao-1").toString("utf8"),
    "escrow-quorum:approve:dao-1"
  );
  assert.equal(
    approvalStatement("dao-1", undefined).toString("utf8"),
    "escrow-quorum:approve:dao-1"
  );
});

test("context-bound quorum accepts a same-context signature end to end", () => {
  const { pair, quorum } = keyedQuorum(CONTEXT_A);
  const signature = sign(
    null,
    approvalStatement("dao-1", CONTEXT_A),
    pair.privateKey
  );
  quorum.approveSigned("dao-1", signature);
  assert.equal(quorum.approvalCount(), 1);
  assert.equal(quorum.hasQuorum(), true);
  assert.deepEqual(quorum.approvalLog(), [
    { signerId: "dao-1", at: "1970-01-01T00:00:01.000Z", verified: true },
  ]);
});

test("cross-arbitration replay is blocked: same signature, different context quorum", () => {
  const { pair, quorum: quorumA } = keyedQuorum(CONTEXT_A);
  // Same signer key, second arbitration: the signature must not carry over.
  const quorumB = createQuorum({
    threshold: 1,
    signers: SIGNERS,
    signerPublicKeys: { "dao-1": pair.publicKey },
    statementContext: CONTEXT_B,
    now: () => 1_000,
  });
  const signature = sign(
    null,
    approvalStatement("dao-1", CONTEXT_A),
    pair.privateKey
  );
  quorumA.approveSigned("dao-1", signature);
  assert.equal(quorumA.approvalCount(), 1);
  assert.throws(() => quorumB.approveSigned("dao-1", signature), VERIFY_FAILED);
  assert.equal(quorumB.approvalCount(), 0);
  assert.deepEqual(quorumB.approvalLog(), []);
});

test("missing context fails closed: context-less signature rejected by a context quorum", () => {
  const { pair, quorum } = keyedQuorum(CONTEXT_A);
  const legacy = sign(null, approvalStatement("dao-1"), pair.privateKey);
  assert.throws(() => quorum.approveSigned("dao-1", legacy), VERIFY_FAILED);
  assert.equal(quorum.approvalCount(), 0);
  assert.deepEqual(quorum.approvalLog(), []);
});

test("context-bound signature is rejected by a legacy no-context quorum", () => {
  const { pair, quorum } = keyedQuorum();
  const bound = sign(
    null,
    approvalStatement("dao-1", CONTEXT_A),
    pair.privateKey
  );
  assert.throws(() => quorum.approveSigned("dao-1", bound), VERIFY_FAILED);
  assert.equal(quorum.approvalCount(), 0);
});

test("createQuorum rejects an empty, non-string, or overlong statementContext", () => {
  const pair = generateKeyPairSync("ed25519");
  const base = {
    threshold: 1,
    signers: SIGNERS,
    signerPublicKeys: { "dao-1": pair.publicKey },
    now: () => 1_000,
  } as const;
  assert.throws(
    () => createQuorum({ ...base, statementContext: "" }),
    CONTEXT_CONFIG_MESSAGE
  );
  assert.throws(
    () => createQuorum({ ...base, statementContext: 42 as never }),
    /got 42$/
  );
  assert.throws(
    () => createQuorum({ ...base, statementContext: "x".repeat(257) }),
    CONTEXT_CONFIG_MESSAGE
  );
  // The cap is inclusive: a 256-character context configures fine.
  const quorum = createQuorum({
    ...base,
    statementContext: "x".repeat(256),
  });
  assert.equal(quorum.threshold, 1);
});

test("approvalStatement rejects a null, non-string, empty, or overlong context instead of minting it", () => {
  assert.throws(
    () => approvalStatement("dao-1", null as never),
    CONTEXT_STATEMENT_MESSAGE
  );
  assert.throws(
    () => approvalStatement("dao-1", 42 as never),
    /got 42$/
  );
  assert.throws(
    () => approvalStatement("dao-1", ""),
    /got ""$/
  );
  assert.throws(
    () => approvalStatement("dao-1", "x".repeat(257)),
    CONTEXT_STATEMENT_MESSAGE
  );
  // The cap is inclusive: a 256-character context mints fine.
  assert.equal(
    approvalStatement("dao-1", "x".repeat(256)).toString("utf8"),
    `escrow-quorum:approve:dao-1:${"x".repeat(256)}`
  );
});

test("context-bound approveSigned upgrades a plain approve() entry in place", () => {
  const { pair, quorum } = keyedQuorum(CONTEXT_A);
  quorum.approve("dao-1");
  assert.deepEqual(quorum.approvalLog(), [
    { signerId: "dao-1", at: "1970-01-01T00:00:01.000Z" },
  ]);
  const signature = sign(
    null,
    approvalStatement("dao-1", CONTEXT_A),
    pair.privateKey
  );
  quorum.approveSigned("dao-1", signature);
  // Same timestamp, same single entry, now verified — no second entry.
  assert.deepEqual(quorum.approvalLog(), [
    { signerId: "dao-1", at: "1970-01-01T00:00:01.000Z", verified: true },
  ]);
  assert.equal(quorum.approvalCount(), 1);
});

test("restored quorum verifies under the restoring config's context", () => {
  const pair = generateKeyPairSync("ed25519");
  const config = {
    threshold: 1,
    signers: SIGNERS,
    signerPublicKeys: { "dao-1": pair.publicKey },
    statementContext: CONTEXT_A,
    now: () => 1_000,
  } as const;
  const quorum = createQuorum(config);
  quorum.approve("dao-1");
  const restored = restoreQuorum(config, quorum.snapshot());
  const signature = sign(
    null,
    approvalStatement("dao-1", CONTEXT_A),
    pair.privateKey
  );
  // The plain approval upgrades to verified under the same context.
  restored.approveSigned("dao-1", signature);
  assert.equal(restored.approvalCount(), 1);
  assert.equal(restored.approvalLog()[0].verified, true);

  // Restoring the same snapshot under a different context rejects
  // the context-A signature: the binding follows the config.
  const restoredOther = restoreQuorum(
    { ...config, statementContext: CONTEXT_B },
    quorum.snapshot()
  );
  assert.throws(
    () => restoredOther.approveSigned("dao-1", signature),
    VERIFY_FAILED
  );
  assert.equal(restoredOther.approvalLog()[0].verified, undefined);
});

test("rejected cross-context vote leaves no residue in the log", () => {
  const { pair, quorum } = keyedQuorum(CONTEXT_B);
  const wrongContext = sign(
    null,
    approvalStatement("dao-1", CONTEXT_A),
    pair.privateKey
  );
  assert.throws(
    () => quorum.approveSigned("dao-1", wrongContext),
    VERIFY_FAILED
  );
  // A later correct-context vote still lands cleanly.
  const rightContext = sign(
    null,
    approvalStatement("dao-1", CONTEXT_B),
    pair.privateKey
  );
  quorum.approveSigned("dao-1", rightContext);
  assert.equal(quorum.approvalCount(), 1);
  assert.equal(quorum.approvalLog().length, 1);
});
