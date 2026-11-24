import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { approvalStatement, createQuorum } from "../src/index.js";

const SIGNERS = ["dao-1", "dao-2", "dao-3"];

const SHAPE_MESSAGE =
  /invalid approval statement: signerId must be a non-empty string of at most 256 characters, got /;

test("approvalStatement rejects null and undefined instead of minting a statement", () => {
  assert.throws(() => approvalStatement(null as never), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, SHAPE_MESSAGE);
    assert.match(err.message, /got null$/);
    return true;
  });
  assert.throws(
    () => approvalStatement(undefined as never),
    /got undefined$/
  );
});

test("approvalStatement rejects a number instead of stringifying it", () => {
  assert.throws(() => approvalStatement(123 as never), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, SHAPE_MESSAGE);
    assert.match(err.message, /got 123$/);
    return true;
  });
  assert.throws(() => approvalStatement(true as never), /got true$/);
});

test("approvalStatement rejects an empty string: no real signer is empty", () => {
  assert.throws(
    () => approvalStatement(""),
    /invalid approval statement: signerId must be a non-empty string of at most 256 characters, got ""$/
  );
});

test("approvalStatement rejects an object instead of stringifying it", () => {
  assert.throws(() => approvalStatement({} as never), /got \{\}$/);
  assert.throws(() => approvalStatement(["dao-1"] as never), /got \["dao-1"\]$/);
});

test("approvalStatement rejects a 257-character id and accepts the 256-character cap", () => {
  const overlong = "x".repeat(257);
  assert.throws(() => approvalStatement(overlong), SHAPE_MESSAGE);
  // The cap is inclusive: a 256-character id is a legal signer id.
  assert.equal(
    approvalStatement("x".repeat(256)).toString("utf8"),
    `escrow-quorum:approve:${"x".repeat(256)}`
  );
});

test("legal signer statements are byte-identical, including spaces and Unicode", () => {
  assert.equal(
    approvalStatement("dao-1").toString("utf8"),
    "escrow-quorum:approve:dao-1"
  );
  assert.equal(
    approvalStatement("dao 1 ✓").toString("utf8"),
    "escrow-quorum:approve:dao 1 ✓"
  );
  assert.equal(
    approvalStatement("dao-1").length,
    Buffer.byteLength("escrow-quorum:approve:dao-1", "utf8")
  );
});

test("approveSigned still verifies a legal statement end to end", () => {
  const pair = generateKeyPairSync("ed25519");
  const quorum = createQuorum({
    threshold: 1,
    signers: SIGNERS,
    signerPublicKeys: { "dao-1": pair.publicKey },
    now: () => 1_000,
  });
  const signature = sign(null, approvalStatement("dao-1"), pair.privateKey);
  quorum.approveSigned("dao-1", signature);
  assert.equal(quorum.approvalCount(), 1);
  assert.equal(quorum.hasQuorum(), true);
});

test("approveSigned still rejects a wrong signer and a wrong key", () => {
  const pair = generateKeyPairSync("ed25519");
  const stranger = generateKeyPairSync("ed25519");
  const quorum = createQuorum({
    threshold: 1,
    signers: SIGNERS,
    signerPublicKeys: { "dao-1": pair.publicKey },
    now: () => 1_000,
  });
  // dao-2's statement presented as dao-1's vote.
  const cross = sign(null, approvalStatement("dao-2"), pair.privateKey);
  assert.throws(
    () => quorum.approveSigned("dao-1", cross),
    /quorum signature verification failed for signer "dao-1"/
  );
  // dao-1's statement signed with a stranger's key.
  const wrongKey = sign(null, approvalStatement("dao-1"), stranger.privateKey);
  assert.throws(
    () => quorum.approveSigned("dao-1", wrongKey),
    /quorum signature verification failed for signer "dao-1"/
  );
  assert.equal(quorum.approvalCount(), 0);
  assert.deepStrictEqual(quorum.approvalLog(), []);
});
