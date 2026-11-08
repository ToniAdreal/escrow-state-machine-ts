import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  Escrow,
  approvalStatement,
  createQuorum,
  dispatchArbitration,
  restoreQuorum,
} from "../src/index.js";

const SIGNERS = [
  "dao-1", "dao-2", "dao-3", "dao-4", "dao-5",
  "dao-6", "dao-7", "dao-8", "dao-9",
];

/** Deterministic clock: each call returns the next value from `ticks`. */
function scriptedClock(ticks: number[]): () => number {
  let i = 0;
  return () => ticks[Math.min(i++, ticks.length - 1)];
}

/** Mutable clock: the test sets `t.current` to move time explicitly. */
function mutableClock(startMs: number): { now: () => number; current: number } {
  const clock = { now: () => clock.current, current: startMs };
  return clock;
}

interface KeyPair {
  publicKey: import("node:crypto").KeyObject;
  privateKey: import("node:crypto").KeyObject;
}

function ed25519Keys(): KeyPair {
  return generateKeyPairSync("ed25519");
}

/** Quorum with Ed25519 keys registered for the first `n` signers. */
function keyedQuorum(
  threshold: number,
  keyedSigners: string[],
  extra: Record<string, unknown> = {}
) {
  const keys = new Map<string, KeyPair>();
  const signerPublicKeys: Record<string, import("node:crypto").KeyObject> = {};
  for (const id of keyedSigners) {
    const pair = ed25519Keys();
    keys.set(id, pair);
    signerPublicKeys[id] = pair.publicKey;
  }
  const quorum = createQuorum({
    threshold,
    signers: SIGNERS,
    signerPublicKeys,
    ...extra,
  });
  return { quorum, keys };
}

/** Sign the canonical approval statement for `signerId` with `pair`. */
function signApproval(pair: KeyPair, signerId: string): Buffer {
  return sign(null, approvalStatement(signerId), pair.privateKey);
}

test("approvalStatement pins the exact canonical bytes", () => {
  assert.equal(
    approvalStatement("dao-1").toString("utf8"),
    "escrow-quorum:approve:dao-1"
  );
  assert.notEqual(
    approvalStatement("dao-1").toString("utf8"),
    approvalStatement("dao-2").toString("utf8")
  );
});

test("valid signature counts and the log marks the entry verified", () => {
  const { quorum, keys } = keyedQuorum(2, ["dao-1", "dao-2"], {
    now: scriptedClock([1_000, 2_000]),
  });
  quorum.approveSigned("dao-1", signApproval(keys.get("dao-1")!, "dao-1"));
  quorum.approveSigned("dao-2", signApproval(keys.get("dao-2")!, "dao-2"));
  assert.equal(quorum.approvalCount(), 2);
  assert.equal(quorum.hasQuorum(), true);
  assert.deepStrictEqual(quorum.approvals(), ["dao-1", "dao-2"]);
  assert.deepStrictEqual(quorum.approvalLog(), [
    { signerId: "dao-1", at: new Date(1_000).toISOString(), verified: true },
    { signerId: "dao-2", at: new Date(2_000).toISOString(), verified: true },
  ]);
});

test("signature from an unregistered key is rejected and records nothing", () => {
  const { quorum } = keyedQuorum(1, ["dao-1"], { now: scriptedClock([1_000]) });
  const stranger = ed25519Keys();
  assert.throws(
    () => quorum.approveSigned("dao-1", signApproval(stranger, "dao-1")),
    /quorum signature verification failed for signer "dao-1"/
  );
  assert.equal(quorum.approvalCount(), 0);
  assert.deepStrictEqual(quorum.approvalLog(), []);
});

test("signature over a tampered statement is rejected and records nothing", () => {
  const { quorum, keys } = keyedQuorum(1, ["dao-1"], { now: scriptedClock([1_000]) });
  const pair = keys.get("dao-1")!;
  const tampered = sign(
    null,
    Buffer.from("escrow-quorum:approve:dao-1:tampered", "utf8"),
    pair.privateKey
  );
  assert.throws(
    () => quorum.approveSigned("dao-1", tampered),
    /quorum signature verification failed for signer "dao-1"/
  );
  assert.equal(quorum.approvalCount(), 0);
  assert.deepStrictEqual(quorum.approvalLog(), []);
});

test("signature for another signer is rejected", () => {
  const { quorum, keys } = keyedQuorum(1, ["dao-1", "dao-2"], {
    now: scriptedClock([1_000]),
  });
  // dao-2's key over dao-2's statement, presented as dao-1's vote.
  const cross = signApproval(keys.get("dao-2")!, "dao-2");
  assert.throws(
    () => quorum.approveSigned("dao-1", cross),
    /quorum signature verification failed for signer "dao-1"/
  );
  assert.equal(quorum.approvalCount(), 0);
});

test("dao-1's statement signed with dao-2's key is rejected", () => {
  const { quorum, keys } = keyedQuorum(1, ["dao-1", "dao-2"], {
    now: scriptedClock([1_000]),
  });
  const wrongKey = signApproval(keys.get("dao-2")!, "dao-1");
  assert.throws(
    () => quorum.approveSigned("dao-1", wrongKey),
    /quorum signature verification failed for signer "dao-1"/
  );
  assert.equal(quorum.approvalCount(), 0);
});

test("approveSigned without a registered public key throws", () => {
  const { quorum, keys } = keyedQuorum(1, ["dao-1"], { now: scriptedClock([1_000]) });
  assert.throws(
    () =>
      quorum.approveSigned("dao-2", signApproval(keys.get("dao-1")!, "dao-2")),
    /quorum approveSigned: no public key registered for signer "dao-2"/
  );
  assert.equal(quorum.approvalCount(), 0);
});

test("approveSigned for an unknown signer throws the unknown-signer error", () => {
  const { quorum, keys } = keyedQuorum(1, ["dao-1"], { now: scriptedClock([1_000]) });
  assert.throws(
    () => quorum.approveSigned("dao-99", signApproval(keys.get("dao-1")!, "dao-99")),
    /unknown quorum signer: "dao-99"/
  );
});

test("non-Ed25519 keys are rejected at construction", () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(
    () =>
      createQuorum({
        threshold: 1,
        signers: SIGNERS,
        signerPublicKeys: { "dao-1": rsa.publicKey },
      }),
    /quorum signerPublicKeys\["dao-1"\] must be an Ed25519 public key/
  );
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  assert.throws(
    () =>
      createQuorum({
        threshold: 1,
        signers: SIGNERS,
        signerPublicKeys: { "dao-1": ec.publicKey },
      }),
    /quorum signerPublicKeys\["dao-1"\] must be an Ed25519 public key/
  );
});

test("a private key in signerPublicKeys is rejected at construction", () => {
  const pair = ed25519Keys();
  assert.throws(
    () =>
      createQuorum({
        threshold: 1,
        signers: SIGNERS,
        signerPublicKeys: { "dao-1": pair.privateKey },
      }),
    /quorum signerPublicKeys\["dao-1"\] must be an Ed25519 public key/
  );
});

test("signerPublicKeys for an unknown signer is rejected at construction", () => {
  const pair = ed25519Keys();
  assert.throws(
    () =>
      createQuorum({
        threshold: 1,
        signers: SIGNERS,
        signerPublicKeys: { "dao-99": pair.publicKey },
      }),
    /quorum signerPublicKeys has a key for unknown signer: "dao-99"/
  );
});

test("a non-KeyObject value in signerPublicKeys is rejected at construction", () => {
  assert.throws(
    () =>
      createQuorum({
        threshold: 1,
        signers: SIGNERS,
        signerPublicKeys: { "dao-1": "not-a-key" as never },
      }),
    /quorum signerPublicKeys\["dao-1"\] must be a KeyObject/
  );
  assert.throws(
    () =>
      createQuorum({
        threshold: 1,
        signers: SIGNERS,
        signerPublicKeys: [] as never,
      }),
    /quorum signerPublicKeys must be an object keyed by signer id/
  );
});

test("mixed verified and unverified approvals count identically", () => {
  const { quorum, keys } = keyedQuorum(2, ["dao-1"], {
    now: scriptedClock([1_000, 2_000]),
  });
  quorum.approve("dao-2", "gov-prop-42");
  quorum.approveSigned("dao-1", signApproval(keys.get("dao-1")!, "dao-1"));
  assert.equal(quorum.approvalCount(), 2);
  assert.equal(quorum.hasQuorum(), true);
  assert.deepStrictEqual(quorum.approvals(), ["dao-2", "dao-1"]);
  assert.deepStrictEqual(quorum.approvalLog(), [
    { signerId: "dao-2", at: new Date(1_000).toISOString(), evidence: "gov-prop-42" },
    { signerId: "dao-1", at: new Date(2_000).toISOString(), verified: true },
  ]);
});

test("plain approve() behavior is unchanged: no verified key, idempotent, evidence kept", () => {
  const q = createQuorum({ threshold: 2, signers: SIGNERS, now: scriptedClock([1_000, 2_000]) });
  q.approve("dao-1", "vote-record-7");
  q.approve("dao-1", "different-evidence"); // no-op: evidence unchanged
  assert.deepStrictEqual(q.approvalLog(), [
    { signerId: "dao-1", at: new Date(1_000).toISOString(), evidence: "vote-record-7" },
  ]);
  assert.equal("verified" in q.approvalLog()[0], false);
});

test("approveSigned upgrades a counted unverified approval in place", () => {
  const { quorum, keys } = keyedQuorum(1, ["dao-1"], {
    now: scriptedClock([1_000, 2_000]),
  });
  quorum.approve("dao-1", "gov-prop-9");
  quorum.approveSigned("dao-1", signApproval(keys.get("dao-1")!, "dao-1"));
  // Same single entry, same timestamp and evidence, now verified.
  assert.deepStrictEqual(quorum.approvalLog(), [
    {
      signerId: "dao-1",
      at: new Date(1_000).toISOString(),
      evidence: "gov-prop-9",
      verified: true,
    },
  ]);
  assert.equal(quorum.approvalCount(), 1);
});

test("a failed approveSigned leaves a counted unverified approval untouched", () => {
  const { quorum } = keyedQuorum(1, ["dao-1"], { now: scriptedClock([1_000]) });
  quorum.approve("dao-1");
  const stranger = ed25519Keys();
  assert.throws(
    () => quorum.approveSigned("dao-1", signApproval(stranger, "dao-1")),
    /quorum signature verification failed for signer "dao-1"/
  );
  assert.deepStrictEqual(quorum.approvalLog(), [
    { signerId: "dao-1", at: new Date(1_000).toISOString() },
  ]);
  assert.equal(quorum.approvalCount(), 1);
});

test("approveSigned records evidence alongside the verified flag", () => {
  const { quorum, keys } = keyedQuorum(1, ["dao-1"], { now: scriptedClock([1_000]) });
  quorum.approveSigned("dao-1", signApproval(keys.get("dao-1")!, "dao-1"), "gov-prop-42");
  assert.deepStrictEqual(quorum.approvalLog(), [
    {
      signerId: "dao-1",
      at: new Date(1_000).toISOString(),
      evidence: "gov-prop-42",
      verified: true,
    },
  ]);
  const { quorum: q2, keys: keys2 } = keyedQuorum(1, ["dao-1"], {
    now: scriptedClock([1_000]),
  });
  assert.throws(
    () => q2.approveSigned("dao-1", signApproval(keys2.get("dao-1")!, "dao-1"), ""),
    /quorum approval evidence must be a non-empty string/
  );
  assert.equal(q2.approvalCount(), 0);
});

test("a non-Buffer signature is a caller error and records nothing", () => {
  const { quorum } = keyedQuorum(1, ["dao-1"], { now: scriptedClock([1_000]) });
  for (const bad of ["deadbeef", 42, null, undefined, {}]) {
    assert.throws(
      () => quorum.approveSigned("dao-1", bad as never),
      /quorum approveSigned: signature must be a Buffer or Uint8Array/
    );
  }
  assert.equal(quorum.approvalCount(), 0);
  assert.deepStrictEqual(quorum.approvalLog(), []);
});

test("a wrong-length signature fails closed and records nothing", () => {
  const { quorum } = keyedQuorum(1, ["dao-1"], { now: scriptedClock([1_000]) });
  assert.throws(
    () => quorum.approveSigned("dao-1", Buffer.alloc(32)),
    /quorum signature verification failed for signer "dao-1"/
  );
  assert.throws(
    () => quorum.approveSigned("dao-1", new Uint8Array(64)),
    /quorum signature verification failed for signer "dao-1"/
  );
  assert.equal(quorum.approvalCount(), 0);
  assert.deepStrictEqual(quorum.approvalLog(), []);
});

test("revoke removes a verified entry; re-approveSigned records it fresh", () => {
  const { quorum, keys } = keyedQuorum(1, ["dao-1"], {
    now: scriptedClock([1_000, 2_000]),
  });
  quorum.approveSigned("dao-1", signApproval(keys.get("dao-1")!, "dao-1"));
  quorum.revoke("dao-1");
  assert.equal(quorum.approvalCount(), 0);
  assert.deepStrictEqual(quorum.approvalLog(), []);
  quorum.approveSigned("dao-1", signApproval(keys.get("dao-1")!, "dao-1"));
  assert.deepStrictEqual(quorum.approvalLog(), [
    { signerId: "dao-1", at: new Date(2_000).toISOString(), verified: true },
  ]);
});

test("expired verified approval re-approveSigned appends a fresh verified entry", () => {
  const clock = mutableClock(1_000);
  const { quorum, keys } = keyedQuorum(1, ["dao-1"], {
    now: clock.now,
    maxApprovalAgeMs: 60_000,
  });
  quorum.approveSigned("dao-1", signApproval(keys.get("dao-1")!, "dao-1"));
  clock.current = 70_000; // first approval expired (age 69s > 60s window)
  assert.equal(quorum.approvalCount(), 0);
  quorum.approveSigned("dao-1", signApproval(keys.get("dao-1")!, "dao-1"));
  assert.equal(quorum.approvalCount(), 1);
  assert.deepStrictEqual(quorum.approvalLog(), [
    { signerId: "dao-1", at: new Date(1_000).toISOString(), verified: true },
    { signerId: "dao-1", at: new Date(70_000).toISOString(), verified: true },
  ]);
});

test("snapshot round-trip preserves the verified flag; keys are never in the snapshot", () => {
  const { quorum, keys } = keyedQuorum(2, ["dao-1"], {
    now: scriptedClock([1_000, 2_000]),
  });
  quorum.approveSigned("dao-1", signApproval(keys.get("dao-1")!, "dao-1"));
  quorum.approve("dao-2");
  const snapshot = quorum.snapshot();
  assert.equal("signerPublicKeys" in snapshot, false);
  assert.ok(!JSON.stringify(snapshot).includes("-----BEGIN"));
  const pair = keys.get("dao-1")!;
  const restored = restoreQuorum(
    {
      threshold: 2,
      signers: SIGNERS,
      signerPublicKeys: { "dao-1": pair.publicKey },
      now: scriptedClock([3_000]),
    },
    snapshot
  );
  assert.deepStrictEqual(restored.approvalLog(), quorum.approvalLog());
  assert.equal(restored.approvalCount(), 2);
  // The restored quorum can still collect a fresh verified vote.
  restored.approveSigned("dao-1", signApproval(pair, "dao-1"));
  assert.equal(restored.approvalLog().length, 2); // upgrade in place, no new entry
  assert.equal(restored.approvalLog()[0].verified, true);
});

test("restore rejects a snapshot entry with verified: false", () => {
  const { quorum, keys } = keyedQuorum(1, ["dao-1"], { now: scriptedClock([1_000]) });
  quorum.approveSigned("dao-1", signApproval(keys.get("dao-1")!, "dao-1"));
  const snapshot = quorum.snapshot();
  const tampered = {
    ...snapshot,
    approvals: [{ ...snapshot.approvals[0], verified: false }],
  };
  assert.throws(
    () =>
      restoreQuorum(
        { threshold: 1, signers: SIGNERS, now: scriptedClock([2_000]) },
        tampered
      ),
    /invalid quorum snapshot: approvals\[0\]: verified must be true when present/
  );
});

test("dispatchArbitration counts verified approvals and refuses below threshold", () => {
  const { quorum, keys } = keyedQuorum(2, ["dao-1", "dao-2"]);
  const escrow = new Escrow("esc-1");
  escrow.dispatch("FUND", undefined, 10630);
  escrow.dispatch("DISPUTE");
  quorum.approveSigned("dao-1", signApproval(keys.get("dao-1")!, "dao-1"));
  assert.throws(
    () => dispatchArbitration(escrow, quorum, "release"),
    /arbitration requires quorum: 1\/2 approvals/
  );
  assert.equal(escrow.state, "DISPUTED");
  quorum.approveSigned("dao-2", signApproval(keys.get("dao-2")!, "dao-2"));
  assert.equal(dispatchArbitration(escrow, quorum, "release"), "RELEASED");
  assert.equal(escrow.state, "RELEASED");
});
