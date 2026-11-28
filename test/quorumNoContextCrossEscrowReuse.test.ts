import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import {
  approvalStatement,
  createQuorum,
  dispatchArbitration,
  Escrow,
} from "../src/index.js";

const SIGNERS = ["dao-1", "dao-2", "dao-3"];
const CONTEXT_A = "esc-1:release";
const CONTEXT_B = "esc-2:release";

const VERIFY_FAILED = /quorum signature verification failed for signer "dao-1"/;

/**
 * Backlog #1455: pin the reuse surface of the default (no-context,
 * no-scope) quorum configuration. Without a `statementContext` or a
 * `statementScope` the signed statement is
 * `escrow-quorum:approve:<signerId>` — it binds the signer id only,
 * not an escrow or an outcome. These tests record that behavior
 * as-is; they do not change the semantics. Callers who reuse the
 * same signer keys across escrows must configure a unique
 * `statementContext` (e.g. the escrow id) or a `statementScope`
 * per escrow, so the statement itself carries the binding.
 */
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

function signStatement(
  privateKey: KeyObject,
  statementContext?: string,
): Buffer {
  return sign(null, approvalStatement("dao-1", statementContext), privateKey);
}

/** Escrow sitting in DISPUTED: CREATED → FUNDED → DISPUTED. */
function disputedEscrow(id: string): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", undefined, 10630);
  escrow.dispatch("DISPUTE");
  assert.equal(escrow.state, "DISPUTED");
  return escrow;
}

test("no-context statement bytes carry no escrow binding (premise pin)", () => {
  // The same signer, minted with no context, produces identical bytes
  // no matter which escrow the vote is meant for — there is nothing
  // in the statement that names an escrow or an outcome.
  assert.equal(
    approvalStatement("dao-1").toString("utf8"),
    "escrow-quorum:approve:dao-1",
  );
  assert.equal(
    approvalStatement("dao-1", undefined).toString("utf8"),
    approvalStatement("dao-1").toString("utf8"),
  );
});

test("same no-context signature counts in two quorums (behavior pinned, not changed)", () => {
  const { pair, quorum: quorumA } = keyedQuorum();
  const quorumB = createQuorum({
    threshold: 1,
    signers: SIGNERS,
    signerPublicKeys: { "dao-1": pair.publicKey },
    now: () => 1_000,
  });
  const signature = signStatement(pair.privateKey);

  quorumA.approveSigned("dao-1", signature);
  assert.equal(quorumA.approvalCount(), 1);
  assert.equal(quorumA.hasQuorum(), true);
  assert.equal(quorumA.approvalLog()[0].verified, true);

  // The identical bytes verify in the second quorum too: with no
  // context and no scope configured, the statement binds the signer
  // id only. This is the default configuration's reuse surface —
  // recorded here so any future tightening (or loosening) shows up
  // as a deliberate test change, not a silent drift.
  quorumB.approveSigned("dao-1", signature);
  assert.equal(quorumB.approvalCount(), 1);
  assert.equal(quorumB.hasQuorum(), true);
  assert.equal(quorumB.approvalLog()[0].verified, true);
});

test("same no-context signature dispatches two escrows (end-to-end consequence)", () => {
  const { pair, quorum: quorumA } = keyedQuorum();
  const quorumB = createQuorum({
    threshold: 1,
    signers: SIGNERS,
    signerPublicKeys: { "dao-1": pair.publicKey },
    now: () => 1_000,
  });
  const signature = signStatement(pair.privateKey);

  const escrowA = disputedEscrow("esc-1");
  const escrowB = disputedEscrow("esc-2");

  quorumA.approveSigned("dao-1", signature);
  quorumB.approveSigned("dao-1", signature);
  assert.equal(dispatchArbitration(escrowA, quorumA, "release"), "RELEASED");
  assert.equal(dispatchArbitration(escrowB, quorumB, "release"), "RELEASED");
});

test("control: different statementContexts bind the signature to one quorum", () => {
  const { pair, quorum: quorumA } = keyedQuorum(CONTEXT_A);
  const quorumB = createQuorum({
    threshold: 1,
    signers: SIGNERS,
    signerPublicKeys: { "dao-1": pair.publicKey },
    statementContext: CONTEXT_B,
    now: () => 1_000,
  });
  const signature = signStatement(pair.privateKey, CONTEXT_A);

  quorumA.approveSigned("dao-1", signature);
  assert.equal(quorumA.approvalCount(), 1);
  assert.equal(quorumA.hasQuorum(), true);

  assert.throws(() => quorumB.approveSigned("dao-1", signature), VERIFY_FAILED);
  assert.equal(quorumB.approvalCount(), 0);
  assert.deepEqual(quorumB.approvalLog(), []);

  // And the mirror direction: a signature minted for escrow B's
  // context does not verify in escrow A's quorum.
  const signatureB = signStatement(pair.privateKey, CONTEXT_B);
  assert.throws(() => quorumA.approveSigned("dao-1", signatureB), VERIFY_FAILED);
  assert.equal(quorumA.approvalCount(), 1);
});

test("control: a context-less signature does not verify in a context-bound quorum", () => {
  const { pair, quorum } = keyedQuorum(CONTEXT_A);
  const legacy = signStatement(pair.privateKey);
  assert.throws(() => quorum.approveSigned("dao-1", legacy), VERIFY_FAILED);
  assert.equal(quorum.approvalCount(), 0);
  assert.deepEqual(quorum.approvalLog(), []);

  // And a context-bound signature does not verify in a no-context quorum.
  const { pair: pair2, quorum: bareQuorum } = keyedQuorum();
  const contextual = signStatement(pair2.privateKey, CONTEXT_A);
  assert.throws(
    () => bareQuorum.approveSigned("dao-1", contextual),
    VERIFY_FAILED,
  );
  assert.equal(bareQuorum.approvalCount(), 0);
});
