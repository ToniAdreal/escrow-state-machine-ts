/**
 * Backlog #1419: `restoreQuorum` must not trust a hand-written
 * `verified: true` in a snapshot. A snapshot carries no signature,
 * so the unsigned restore drops every `verified` flag and treats
 * each restored approval as an unverified claim — the count is
 * unchanged (verified and unverified approvals count identically),
 * only the flag is dropped. The flag is re-earned by a fresh
 * `approveSigned()`, which upgrades a still-counted entry in
 * place. The HMAC-signed envelope restore is the one exception:
 * its MAC authenticates the snapshot, so the flags it carries
 * survive — that path is pinned here so a later change to the
 * unsigned path cannot silently strip it too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import {
  approvalStatement,
  createQuorum,
  diffQuorumSnapshots,
  exportSignedQuorumSnapshot,
  restoreQuorum,
  restoreSignedQuorumSnapshot,
  type QuorumConfig,
  type QuorumSnapshot,
} from "../src/index.js";

const SIGNERS = ["arb-1", "arb-2", "arb-3"];
const AT = "2026-03-01T00:00:00.000Z";
const AT2 = "2026-03-02T00:00:00.000Z";

function config(
  threshold: number,
  extra: Partial<QuorumConfig> = {},
): QuorumConfig {
  return { threshold, signers: [...SIGNERS], ...extra };
}

/** Hand-written snapshot that was never backed by any signature. */
function forgedSnapshot(
  threshold = 1,
  approvals: QuorumSnapshot["approvals"] = [
    { signerId: "arb-1", at: AT, verified: true },
  ],
): QuorumSnapshot {
  return { v: 1, threshold, signers: [...SIGNERS], approvals };
}

function keyedConfig(threshold: number): {
  cfg: QuorumConfig;
  privateKey: KeyObject;
} {
  const pair = generateKeyPairSync("ed25519");
  return {
    cfg: config(threshold, { signerPublicKeys: { "arb-1": pair.publicKey } }),
    privateKey: pair.privateKey,
  };
}

test("hand-written verified:true snapshot restores as an unverified claim, count unchanged", () => {
  const restored = restoreQuorum(config(1), forgedSnapshot());
  assert.equal(restored.hasQuorum(), true);
  assert.equal(restored.approvalCount(), 1);
  assert.deepEqual(restored.approvals(), ["arb-1"]);
  const log = restored.approvalLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].signerId, "arb-1");
  assert.equal(log[0].at, AT);
  assert.equal("verified" in log[0], false);
  assert.equal(log[0].verified, undefined);
});

test("hand-written verified:true needs no registered key to restore as a claim", () => {
  // No signerPublicKeys configured at all: the forged flag is still
  // dropped, and the approval still counts — a claim needs no key.
  const restored = restoreQuorum(config(1), forgedSnapshot());
  assert.equal(restored.hasQuorum(), true);
  assert.equal(restored.approvalLog()[0].verified, undefined);
});

test("real snapshot -> restoreQuorum round-trip drops the verified flag but keeps the vote", () => {
  const { cfg, privateKey } = keyedConfig(1);
  const quorum = createQuorum(cfg);
  quorum.approveSigned(
    "arb-1",
    sign(null, approvalStatement("arb-1"), privateKey),
  );
  assert.equal(quorum.approvalLog()[0].verified, true);
  const before = quorum.snapshot();
  assert.equal(before.approvals[0].verified, true);

  const restored = restoreQuorum(
    cfg,
    JSON.parse(JSON.stringify(before)),
  );
  assert.equal(restored.approvalCount(), 1);
  assert.equal(restored.hasQuorum(), true);
  assert.equal(restored.approvalLog()[0].verified, undefined);
  // The restored quorum's own snapshot no longer carries the flag.
  assert.equal(restored.snapshot().approvals[0].verified, undefined);
});

test("approveSigned after an unsigned restore re-earns verified in place", () => {
  const { cfg, privateKey } = keyedConfig(1);
  const quorum = createQuorum(cfg);
  quorum.approveSigned(
    "arb-1",
    sign(null, approvalStatement("arb-1"), privateKey),
  );
  const restored = restoreQuorum(
    cfg,
    JSON.parse(JSON.stringify(quorum.snapshot())),
  );
  assert.equal(restored.approvalLog()[0].verified, undefined);
  const restoredAt = restored.approvalLog()[0].at;

  restored.approveSigned(
    "arb-1",
    sign(null, approvalStatement("arb-1"), privateKey),
  );
  const log = restored.approvalLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].verified, true);
  // In-place upgrade: the original timestamp survives, no new entry.
  assert.equal(log[0].at, restoredAt);
  assert.equal(restored.approvalCount(), 1);
});

test("verified:false in a snapshot is still rejected, as before", () => {
  assert.throws(
    () =>
      restoreQuorum(config(1), {
        v: 1,
        threshold: 1,
        signers: [...SIGNERS],
        approvals: [{ signerId: "arb-1", at: AT, verified: false }],
      }),
    /invalid quorum snapshot: .*verified must be true when present/,
  );
});

test("existing restore guards still apply: unknown signer and threshold mismatch", () => {
  assert.throws(
    () =>
      restoreQuorum(config(1), {
        v: 1,
        threshold: 1,
        signers: [...SIGNERS],
        approvals: [
          { signerId: "arb-9", at: AT, verified: true },
        ],
      }),
    /invalid quorum snapshot: /,
  );
  assert.throws(
    () => restoreQuorum(config(2), forgedSnapshot(1)),
    /invalid quorum snapshot: threshold 1 does not match config threshold 2/,
  );
});

test("mixed snapshot: verified and plain entries both downgrade, both still count", () => {
  const restored = restoreQuorum(config(2), {
    v: 1,
    threshold: 2,
    signers: [...SIGNERS],
    approvals: [
      { signerId: "arb-1", at: AT, verified: true },
      { signerId: "arb-2", at: AT2 },
    ],
  });
  assert.equal(restored.approvalCount(), 2);
  assert.equal(restored.hasQuorum(), true);
  assert.deepEqual(
    restored.approvalLog().map((e) => e.verified),
    [undefined, undefined],
  );
});

test("diffQuorumSnapshots reports the restore downgrade as one modified entry", () => {
  const { cfg, privateKey } = keyedConfig(1);
  const quorum = createQuorum(cfg);
  quorum.approveSigned(
    "arb-1",
    sign(null, approvalStatement("arb-1"), privateKey),
  );
  const before = quorum.snapshot();
  const restored = restoreQuorum(
    cfg,
    JSON.parse(JSON.stringify(before)),
  );
  const diff = diffQuorumSnapshots(before, restored.snapshot());
  assert.equal(diff.approvalsChanged, true);
  assert.equal(diff.approvalsModified?.length, 1);
  assert.deepEqual(diff.approvalsModified?.[0], {
    signerId: "arb-1",
    at: before.approvals[0].at,
  });
  assert.equal(diff.approvalsAdded, undefined);
  assert.equal(diff.approvalsRemoved, undefined);
});

test("signed-envelope restore still preserves verified flags (MAC-authenticated)", () => {
  const { cfg, privateKey } = keyedConfig(1);
  const quorum = createQuorum(cfg);
  quorum.approveSigned(
    "arb-1",
    sign(null, approvalStatement("arb-1"), privateKey),
  );
  const envelope = exportSignedQuorumSnapshot(quorum, "demo-secret");
  const restored = restoreSignedQuorumSnapshot(
    cfg,
    JSON.parse(JSON.stringify(envelope)),
    "demo-secret",
  );
  assert.equal(restored.hasQuorum(), true);
  assert.equal(restored.approvalLog()[0].verified, true);
});
