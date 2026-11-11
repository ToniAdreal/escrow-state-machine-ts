/**
 * Quorum approval `evidence` length cap (backlog #1063).
 *
 * The quorum's approval evidence was only checked for non-emptiness,
 * so a caller could pass a multi-megabyte string straight into
 * `approve()` / `approveSigned()` and have it recorded verbatim in
 * the approval audit log and in every snapshot that serializes it —
 * the same hole `MAX_EVIDENCE_LENGTH` (32,768) already closes on the
 * escrow history path. All three quorum entry points now enforce the
 * same ceiling, reusing the same constant (no second cap to drift):
 * `approve()`, `approveSigned()`, and the snapshot parser behind
 * `restoreQuorum()`. Oversized evidence is rejected outright, never
 * truncated (truncation would change what the audit trail says the
 * evidence was), and a rejected call leaves no residue in the log.
 *
 * Signer ids are capped alongside, at `MAX_ACTOR_LENGTH` (256):
 * unlike a `RolePolicy` name — configuration that is never written
 * into any history — a signer id is stamped verbatim onto every
 * approval log entry and snapshot that carries it, so it is audit
 * data and the actor-cap logic applies. The cap is enforced in
 * `createQuorum`'s config validation, which also covers restore
 * (a snapshot's signers must match the config).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";

import {
  MAX_ACTOR_LENGTH,
  MAX_EVIDENCE_LENGTH,
  approvalStatement,
  createQuorum,
  restoreQuorum,
} from "../src/index.js";

const SIGNERS = ["dao-1", "dao-2", "dao-3"];

function overlongEvidence(): string {
  return "e".repeat(MAX_EVIDENCE_LENGTH + 1);
}

function atLimitEvidence(): string {
  return "e".repeat(MAX_EVIDENCE_LENGTH);
}

/** Mutable clock: the test sets `clock.current` to move time explicitly. */
function mutableClock(startMs: number): { now: () => number; current: number } {
  const clock = { now: () => clock.current, current: startMs };
  return clock;
}

test("approve() rejects over-long evidence and records nothing", () => {
  const quorum = createQuorum({ threshold: 2, signers: SIGNERS });
  assert.throws(
    () => quorum.approve("dao-1", overlongEvidence()),
    /quorum approval evidence must be at most 32768 characters, got 32769/
  );
  assert.equal(quorum.approvalCount(), 0);
  assert.deepEqual(quorum.approvalLog(), []);
});

test("approveSigned() rejects over-long evidence before verifying, records nothing", () => {
  const pair = generateKeyPairSync("ed25519");
  const quorum = createQuorum({
    threshold: 1,
    signers: SIGNERS,
    signerPublicKeys: { "dao-1": pair.publicKey },
  });
  const signature = sign(null, approvalStatement("dao-1"), pair.privateKey);
  assert.throws(
    () => quorum.approveSigned("dao-1", signature, overlongEvidence()),
    /quorum approval evidence must be at most 32768 characters, got 32769/
  );
  assert.deepEqual(quorum.approvalLog(), []);
});

test("approveSigned() accepts at-limit evidence and marks the entry verified", () => {
  const pair = generateKeyPairSync("ed25519");
  const quorum = createQuorum({
    threshold: 1,
    signers: SIGNERS,
    signerPublicKeys: { "dao-1": pair.publicKey },
  });
  const signature = sign(null, approvalStatement("dao-1"), pair.privateKey);
  quorum.approveSigned("dao-1", signature, atLimitEvidence());
  const [entry] = quorum.approvalLog();
  assert.equal(entry.evidence, atLimitEvidence());
  assert.equal(entry.verified, true);
});

test("restoreQuorum() rejects a snapshot carrying over-long evidence", () => {
  const quorum = createQuorum({ threshold: 2, signers: SIGNERS });
  quorum.approve("dao-1", "vote-record-1");
  const snapshot = quorum.snapshot();
  const tampered = {
    ...snapshot,
    approvals: [
      { ...snapshot.approvals[0], evidence: overlongEvidence() },
    ],
  };
  assert.throws(
    () =>
      restoreQuorum({ threshold: 2, signers: SIGNERS }, tampered),
    /invalid quorum snapshot: approvals\[0\]: evidence must be at most 32768 characters, got 32769/
  );
});

test("at-limit evidence passes approve() and survives a snapshot round-trip verbatim", () => {
  const quorum = createQuorum({ threshold: 1, signers: SIGNERS });
  quorum.approve("dao-1", atLimitEvidence());
  const restored = restoreQuorum(
    { threshold: 1, signers: SIGNERS },
    JSON.parse(JSON.stringify(quorum.snapshot()))
  );
  const [entry] = restored.approvalLog();
  assert.equal(entry.evidence, atLimitEvidence());
  assert.equal(restored.approvalCount(), 1);
  assert.equal(restored.hasQuorum(), true);
});

test("short evidence is recorded verbatim and unchanged", () => {
  const quorum = createQuorum({ threshold: 1, signers: SIGNERS });
  quorum.approve("dao-1", "proposal-42");
  const [entry] = quorum.approvalLog();
  assert.equal(entry.evidence, "proposal-42");
  assert.equal(entry.signerId, "dao-1");
});

test("empty evidence is still rejected with the original message", () => {
  const quorum = createQuorum({ threshold: 1, signers: SIGNERS });
  assert.throws(
    () => quorum.approve("dao-1", ""),
    /quorum approval evidence must be a non-empty string/
  );
  assert.deepEqual(quorum.approvalLog(), []);
});

test("re-approving with over-long evidence leaves the original entry untouched", () => {
  const quorum = createQuorum({ threshold: 1, signers: SIGNERS });
  quorum.approve("dao-1", "v1");
  assert.throws(
    () => quorum.approve("dao-1", overlongEvidence()),
    /quorum approval evidence must be at most 32768 characters/
  );
  const [entry] = quorum.approvalLog();
  assert.equal(entry.evidence, "v1");
  assert.equal(quorum.approvalCount(), 1);
});

test("createQuorum() rejects a signer id longer than MAX_ACTOR_LENGTH", () => {
  const longSigner = "s".repeat(MAX_ACTOR_LENGTH + 1);
  assert.throws(
    () => createQuorum({ threshold: 1, signers: [longSigner] }),
    /quorum signer id must be at most 256 characters, got 257/
  );
});

test("a signer id exactly at MAX_ACTOR_LENGTH is accepted", () => {
  const atLimitSigner = "s".repeat(MAX_ACTOR_LENGTH);
  const quorum = createQuorum({
    threshold: 1,
    signers: [atLimitSigner, "dao-2"],
  });
  quorum.approve(atLimitSigner);
  assert.equal(quorum.approvalCount(), 1);
  assert.deepEqual(quorum.approvals(), [atLimitSigner]);
});

test("re-approval after expiry still enforces the evidence cap", () => {
  const clock = mutableClock(1_000);
  const quorum = createQuorum({
    threshold: 1,
    signers: SIGNERS,
    maxApprovalAgeMs: 1_000,
    now: clock.now,
  });
  quorum.approve("dao-1", "first-vote");
  clock.current = 3_000; // the first approval has expired
  assert.equal(quorum.approvalCount(), 0);
  assert.throws(
    () => quorum.approve("dao-1", overlongEvidence()),
    /quorum approval evidence must be at most 32768 characters/
  );
  // Zero residue: the log still holds only the original entry.
  assert.equal(quorum.approvalLog().length, 1);
  assert.equal(quorum.approvalLog()[0].evidence, "first-vote");
  // A short re-approval still works and appends a fresh entry.
  quorum.approve("dao-1", "second-vote");
  assert.equal(quorum.approvalLog().length, 2);
  assert.equal(quorum.approvalLog()[1].evidence, "second-vote");
  assert.equal(quorum.approvalCount(), 1);
});
