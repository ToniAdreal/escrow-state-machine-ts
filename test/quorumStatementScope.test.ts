import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import {
  approvalStatement,
  createQuorum,
  dispatchArbitration,
  Escrow,
  restoreQuorum,
  type QuorumStatementScope,
} from "../src/index.js";

const SIGNERS = ["dao-1", "dao-2", "dao-3"];
const SCOPE_A: QuorumStatementScope = { escrowId: "esc-1", outcome: "release" };
const SCOPE_B: QuorumStatementScope = { escrowId: "esc-2", outcome: "refund" };
const SCOPE_A_ESCROW_ONLY: QuorumStatementScope = { escrowId: "esc-1" };

const VERIFY_FAILED = /quorum signature verification failed for signer "dao-1"/;
const SCOPE_ESCROW_CONFIG_MESSAGE =
  /quorum statementScope escrowId must be a non-empty string of at most 256 characters, got /;
const SCOPE_OUTCOME_CONFIG_MESSAGE =
  /quorum statementScope outcome must be "release", "refund", "split", or "arbitration", got /;
const SCOPE_STATEMENT_MESSAGE =
  /invalid approval statement: statementScope escrowId must be a non-empty string of at most 256 characters, got /;
const REPLAYED_MESSAGE =
  /quorum approveSigned: signature for signer "dao-1" was revoked and cannot be replayed/;
const NONCE_REUSED_MESSAGE =
  /quorum approveSigned: nonce "n-1" has already been used/;
const SCOPE_MISMATCH_ESCROW =
  /arbitration quorum scope mismatch: quorum is scoped to escrow "esc-2" but dispatch targets escrow "esc-1"/;
const SCOPE_MISMATCH_OUTCOME =
  /arbitration quorum scope mismatch: quorum is scoped to outcome "refund" but dispatch outcome is "release"/;

function keyedQuorum(scope?: QuorumStatementScope) {
  const pair = generateKeyPairSync("ed25519");
  const quorum = createQuorum({
    threshold: 1,
    signers: SIGNERS,
    signerPublicKeys: { "dao-1": pair.publicKey },
    ...(scope !== undefined ? { statementScope: scope } : {}),
    now: () => 1_000,
  });
  return { pair, quorum };
}

function signStatement(
  privateKey: KeyObject,
  scope?: QuorumStatementScope,
  nonce?: string,
  statementContext?: string,
) {
  return sign(
    null,
    approvalStatement("dao-1", statementContext, scope, nonce),
    privateKey,
  );
}

/** Escrow sitting in DISPUTED: CREATED → FUNDED → DISPUTED. */
function disputedEscrow(id: string): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", undefined, 10630);
  escrow.dispatch("DISPUTE");
  assert.equal(escrow.state, "DISPUTED");
  return escrow;
}

test("scope-bound statement bytes are pinned exactly", () => {
  assert.equal(
    approvalStatement("dao-1", undefined, SCOPE_A).toString("utf8"),
    "escrow-quorum:approve:dao-1:scope:esc-1:release",
  );
  // Context sits before the scope marker; outcome is omitted when unpinned.
  assert.equal(
    approvalStatement("dao-1", "round-7", SCOPE_A).toString("utf8"),
    "escrow-quorum:approve:dao-1:round-7:scope:esc-1:release",
  );
  assert.equal(
    approvalStatement("dao-1", undefined, SCOPE_A_ESCROW_ONLY).toString("utf8"),
    "escrow-quorum:approve:dao-1:scope:esc-1",
  );
  // A nonce appends as the final segment, after the scope.
  assert.equal(
    approvalStatement("dao-1", undefined, SCOPE_A, "n-1").toString("utf8"),
    "escrow-quorum:approve:dao-1:scope:esc-1:release:nonce:n-1",
  );
  assert.equal(
    approvalStatement("dao-1", undefined, undefined, "n-1").toString("utf8"),
    "escrow-quorum:approve:dao-1:nonce:n-1",
  );
  // Same signer, different scope: different bytes.
  assert.notEqual(
    approvalStatement("dao-1", undefined, SCOPE_A).toString("utf8"),
    approvalStatement("dao-1", undefined, SCOPE_B).toString("utf8"),
  );
  // Scope never leaks into the legacy form.
  assert.notEqual(
    approvalStatement("dao-1", undefined, SCOPE_A).toString("utf8"),
    approvalStatement("dao-1").toString("utf8"),
  );
});

test("scope-consistent signature verifies end to end", () => {
  const { pair, quorum } = keyedQuorum(SCOPE_A);
  const signature = signStatement(pair.privateKey, SCOPE_A);
  quorum.approveSigned("dao-1", signature);
  assert.equal(quorum.approvalCount(), 1);
  assert.equal(quorum.hasQuorum(), true);
  assert.deepEqual(quorum.approvalLog(), [
    { signerId: "dao-1", at: "1970-01-01T00:00:01.000Z", verified: true },
  ]);
  // statementScope() reports the configured scope, as a copy.
  const readBack = quorum.statementScope();
  assert.deepEqual(readBack, SCOPE_A);
  if (readBack !== undefined) readBack.escrowId = "esc-9";
  assert.equal(quorum.statementScope()?.escrowId, "esc-1");
});

test("same signature does not carry across escrows (backlog probe)", () => {
  const { pair, quorum: quorumA } = keyedQuorum(SCOPE_A);
  // Same signer key, second escrow: the signature must not carry over.
  const quorumB = createQuorum({
    threshold: 1,
    signers: SIGNERS,
    signerPublicKeys: { "dao-1": pair.publicKey },
    statementScope: SCOPE_B,
    now: () => 1_000,
  });
  const signature = signStatement(pair.privateKey, SCOPE_A);
  quorumA.approveSigned("dao-1", signature);
  assert.equal(quorumA.approvalCount(), 1);
  assert.throws(() => quorumB.approveSigned("dao-1", signature), VERIFY_FAILED);
  assert.equal(quorumB.approvalCount(), 0);
  assert.deepEqual(quorumB.approvalLog(), []);
});

test("outcome mismatch is rejected: release signature in a refund-scoped quorum", () => {
  const { pair, quorum } = keyedQuorum(SCOPE_B);
  const releaseSignature = signStatement(pair.privateKey, SCOPE_A);
  assert.throws(() => quorum.approveSigned("dao-1", releaseSignature), VERIFY_FAILED);
  assert.equal(quorum.approvalCount(), 0);
  // And the reverse direction: a refund signature in a release quorum.
  const { pair: pair2, quorum: releaseQuorum } = keyedQuorum(SCOPE_A);
  const refundSignature = signStatement(pair2.privateKey, SCOPE_B);
  assert.throws(
    () => releaseQuorum.approveSigned("dao-1", refundSignature),
    VERIFY_FAILED,
  );
  assert.equal(releaseQuorum.approvalCount(), 0);
});

test("unpinned outcome binds the escrow only, not a direction", () => {
  const { pair, quorum } = keyedQuorum(SCOPE_A_ESCROW_ONLY);
  // A signature minted without an outcome verifies.
  const bare = signStatement(pair.privateKey, SCOPE_A_ESCROW_ONLY);
  quorum.approveSigned("dao-1", bare);
  assert.equal(quorum.approvalCount(), 1);

  // A signature minted with an outcome pinned does not: the bytes differ.
  const { pair: pair2, quorum: quorum2 } = keyedQuorum(SCOPE_A_ESCROW_ONLY);
  const pinned = signStatement(pair2.privateKey, SCOPE_A);
  assert.throws(() => quorum2.approveSigned("dao-1", pinned), VERIFY_FAILED);
  assert.equal(quorum2.approvalCount(), 0);
});

test("scoped quorum rejects a scope-less signature", () => {
  const { pair, quorum } = keyedQuorum(SCOPE_A);
  const legacy = signStatement(pair.privateKey);
  assert.throws(() => quorum.approveSigned("dao-1", legacy), VERIFY_FAILED);
  assert.equal(quorum.approvalCount(), 0);
  assert.deepEqual(quorum.approvalLog(), []);
});

test("legacy no-scope signature still verifies in a no-scope quorum", () => {
  const { pair, quorum } = keyedQuorum();
  assert.equal(quorum.statementScope(), undefined);
  const legacy = signStatement(pair.privateKey);
  quorum.approveSigned("dao-1", legacy);
  assert.equal(quorum.approvalCount(), 1);
  assert.equal(quorum.hasQuorum(), true);
});

test("dispatchArbitration refuses a quorum scoped to another escrow", () => {
  const escrow = disputedEscrow("esc-1");
  const historyBefore = escrow.history.length;
  const quorum = createQuorum({
    threshold: 1,
    signers: SIGNERS,
    statementScope: SCOPE_B,
  });
  quorum.approve("dao-1");
  assert.equal(quorum.hasQuorum(), true);

  assert.throws(
    () => dispatchArbitration(escrow, quorum, "release"),
    SCOPE_MISMATCH_ESCROW,
  );
  assert.equal(escrow.state, "DISPUTED");
  assert.equal(escrow.history.length, historyBefore);
  assert.equal(escrow.history[escrow.history.length - 1].event, "DISPUTE");
});

test("dispatchArbitration refuses a quorum scoped to the other outcome", () => {
  const escrow = disputedEscrow("esc-1");
  const historyBefore = escrow.history.length;
  const quorum = createQuorum({
    threshold: 1,
    signers: SIGNERS,
    statementScope: { escrowId: "esc-1", outcome: "refund" },
  });
  quorum.approve("dao-1");

  assert.throws(
    () => dispatchArbitration(escrow, quorum, "release"),
    SCOPE_MISMATCH_OUTCOME,
  );
  assert.equal(escrow.state, "DISPUTED");
  assert.equal(escrow.history.length, historyBefore);

  // The same quorum dispatches fine for the outcome it is scoped to.
  const refundEscrow = disputedEscrow("esc-1");
  const state = dispatchArbitration(refundEscrow, quorum, "refund");
  assert.equal(state, "REFUNDED");
});

test("dispatchArbitration with a matching scope dispatches", () => {
  const escrow = disputedEscrow("esc-1");
  const quorum = createQuorum({
    threshold: 1,
    signers: SIGNERS,
    statementScope: SCOPE_A,
  });
  quorum.approve("dao-1");

  const state = dispatchArbitration(escrow, quorum, "release");
  assert.equal(state, "RELEASED");
  const last = escrow.history[escrow.history.length - 1];
  assert.equal(last.event, "ARBITRATE_RELEASE");
  assert.equal(last.note, "quorum 1/1 [dao-1]");
});

test("dispatchArbitration with an unpinned-outcome scope dispatches either direction", () => {
  const releaseQuorum = createQuorum({
    threshold: 1,
    signers: SIGNERS,
    statementScope: SCOPE_A_ESCROW_ONLY,
  });
  releaseQuorum.approve("dao-1");
  const releaseEscrow = disputedEscrow("esc-1");
  assert.equal(
    dispatchArbitration(releaseEscrow, releaseQuorum, "release"),
    "RELEASED",
  );

  const refundQuorum = createQuorum({
    threshold: 1,
    signers: SIGNERS,
    statementScope: SCOPE_A_ESCROW_ONLY,
  });
  refundQuorum.approve("dao-1");
  const refundEscrow = disputedEscrow("esc-1");
  assert.equal(
    dispatchArbitration(refundEscrow, refundQuorum, "refund"),
    "REFUNDED",
  );
});

test("revoke then replay of the same signature is rejected", () => {
  const { pair, quorum } = keyedQuorum(SCOPE_A);
  const signature = signStatement(pair.privateKey, SCOPE_A);
  quorum.approveSigned("dao-1", signature);
  assert.equal(quorum.approvalCount(), 1);

  quorum.revoke("dao-1");
  assert.equal(quorum.approvalCount(), 0);
  assert.deepEqual(quorum.approvalLog(), []);

  assert.throws(() => quorum.approveSigned("dao-1", signature), REPLAYED_MESSAGE);
  assert.equal(quorum.approvalCount(), 0);
  assert.deepEqual(quorum.approvalLog(), []);
});

test("revoke then the same signer re-approves with a fresh nonce", () => {
  const { pair, quorum } = keyedQuorum(SCOPE_A);
  const first = signStatement(pair.privateKey, SCOPE_A, "n-1");
  quorum.approveSigned("dao-1", first, undefined, "n-1");
  assert.equal(quorum.approvalCount(), 1);

  quorum.revoke("dao-1");
  assert.equal(quorum.approvalCount(), 0);

  // The old (nonce, signature) pair is refused twice over: the nonce
  // was consumed, and the signature itself was tombstoned — the
  // nonce check fires first.
  assert.throws(
    () => quorum.approveSigned("dao-1", first, undefined, "n-1"),
    NONCE_REUSED_MESSAGE,
  );
  assert.equal(quorum.approvalCount(), 0);

  // A fresh nonce mints a fresh statement and a fresh signature.
  const second = signStatement(pair.privateKey, SCOPE_A, "n-2");
  assert.notEqual(first.toString("hex"), second.toString("hex"));
  quorum.approveSigned("dao-1", second, undefined, "n-2");
  assert.equal(quorum.approvalCount(), 1);
  assert.equal(quorum.hasQuorum(), true);
  assert.equal(quorum.approvalLog()[0].verified, true);
});

test("nonce reuse is rejected while the approval still counts", () => {
  const { pair, quorum } = keyedQuorum(SCOPE_A);
  const signature = signStatement(pair.privateKey, SCOPE_A, "n-1");
  quorum.approveSigned("dao-1", signature, undefined, "n-1");
  assert.equal(quorum.approvalCount(), 1);

  assert.throws(
    () => quorum.approveSigned("dao-1", signature, undefined, "n-1"),
    NONCE_REUSED_MESSAGE,
  );
  assert.equal(quorum.approvalCount(), 1);
  assert.equal(quorum.approvalLog().length, 1);
});

test("createQuorum rejects an invalid scope", () => {
  const pair = generateKeyPairSync("ed25519");
  const base = {
    threshold: 1,
    signers: SIGNERS,
    signerPublicKeys: { "dao-1": pair.publicKey },
    now: () => 1_000,
  } as const;
  assert.throws(
    () => createQuorum({ ...base, statementScope: { escrowId: "" } }),
    SCOPE_ESCROW_CONFIG_MESSAGE,
  );
  assert.throws(
    () => createQuorum({ ...base, statementScope: { escrowId: 42 as never } }),
    /got 42$/,
  );
  assert.throws(
    () =>
      createQuorum({
        ...base,
        statementScope: { escrowId: "x".repeat(257) },
      }),
    SCOPE_ESCROW_CONFIG_MESSAGE,
  );
  assert.throws(
    () =>
      createQuorum({
        ...base,
        statementScope: { escrowId: "esc-1", outcome: "burn" as never },
      }),
    SCOPE_OUTCOME_CONFIG_MESSAGE,
  );
  assert.throws(
    () =>
      createQuorum({
        ...base,
        statementScope: { escrowId: "esc-1", escrowID: "esc-1" } as never,
      }),
    /quorum statementScope has unknown field "escrowID"/,
  );
  assert.throws(
    () => createQuorum({ ...base, statementScope: "esc-1" as never }),
    /quorum statementScope must be an object with an escrowId, got "esc-1"/,
  );
  // The caps are inclusive: a 256-character escrowId and an
  // "arbitration" outcome configure fine.
  const quorum = createQuorum({
    ...base,
    statementScope: { escrowId: "x".repeat(256), outcome: "arbitration" },
  });
  assert.deepEqual(quorum.statementScope(), {
    escrowId: "x".repeat(256),
    outcome: "arbitration",
  });
});

test("approvalStatement rejects an invalid scope instead of minting it", () => {
  assert.throws(
    () => approvalStatement("dao-1", undefined, { escrowId: "" }),
    SCOPE_STATEMENT_MESSAGE,
  );
  assert.throws(
    () => approvalStatement("dao-1", undefined, null as never),
    /invalid approval statement: statementScope must be an object with an escrowId, got null/,
  );
  assert.throws(
    () =>
      approvalStatement("dao-1", undefined, {
        escrowId: "esc-1",
        outcome: "burn" as never,
      }),
    /invalid approval statement: statementScope outcome must be "release", "refund", "split", or "arbitration", got "burn"/,
  );
  assert.throws(
    () => approvalStatement("dao-1", undefined, undefined, ""),
    /invalid approval statement: nonce must be a non-empty string of at most 256 characters, got ""/,
  );
});

test("restored quorum verifies under the restoring config's scope", () => {
  const pair = generateKeyPairSync("ed25519");
  const config = {
    threshold: 1,
    signers: SIGNERS,
    signerPublicKeys: { "dao-1": pair.publicKey },
    statementScope: SCOPE_A,
    now: () => 1_000,
  } as const;
  const quorum = createQuorum(config);
  quorum.approve("dao-1");
  const restored = restoreQuorum(
    config,
    quorum.snapshot(),
  );
  const signature = signStatement(pair.privateKey, SCOPE_A);
  // The plain approval upgrades to verified under the same scope.
  restored.approveSigned("dao-1", signature);
  assert.equal(restored.approvalCount(), 1);
  assert.equal(restored.approvalLog()[0].verified, true);

  // Restoring the same snapshot under a different scope rejects the
  // scope-A signature: the binding follows the config.
  const restoredOther = restoreQuorum(
    { ...config, statementScope: SCOPE_B },
    quorum.snapshot(),
  );
  assert.throws(
    () => restoredOther.approveSigned("dao-1", signature),
    VERIFY_FAILED,
  );
  assert.equal(restoredOther.approvalLog()[0].verified, undefined);
});
