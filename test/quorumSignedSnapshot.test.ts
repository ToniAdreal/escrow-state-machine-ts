/**
 * HMAC-signed snapshot envelopes for `Quorum` (backlog #1137),
 * mirroring the `Escrow` envelope (#1017) and the sibling
 * `SettlementEventDedupe` / `SettlementWebhookOutbox` envelopes.
 *
 * The plain snapshot carries the full approval audit trail,
 * including the `verified: true` flags recorded by `approveSigned()`,
 * and nothing in it is authenticated — a rewritten persisted
 * snapshot could flip an unverified claim to "verified", invent
 * approvals, or drop a revocation, and `restoreQuorum` would accept
 * it as long as the shape is valid. Rules under test:
 *  - `exportSignedQuorumSnapshot(quorum, secret)` returns
 *    `{ v: 1, snapshot, mac }` with `mac` = HMAC-SHA256 over the
 *    canonical JSON of the snapshot; the secret is never written
 *    into the envelope
 *  - `restoreSignedQuorumSnapshot(config, envelope, secret, opts)`
 *    rebuilds a working quorum whose approval log (verified flags,
 *    evidence, order) is item-for-item identical and whose counting
 *    continues from the restored state
 *  - a tampered snapshot field (a flipped `verified` flag, a changed
 *    threshold, a tampered approval), a tampered `expiresAt`, a
 *    tampered `mac`, or a wrong secret is rejected fail-closed and
 *    produces no quorum
 *  - envelope shape is validated first (unknown field, version
 *    other than 1, malformed mac), the MAC is checked before the
 *    expiry (a tampered `expiresAt` reports a MAC mismatch, never
 *    an expiry), and a MAC-valid envelope whose snapshot is itself
 *    malformed still fails snapshot validation
 *  - expiry: an expired envelope is rejected; restoring at exactly
 *    `expiresAt` still succeeds; `expiresAt` / `maxAgeMs` are
 *    mutually exclusive and invalid values fail fast on export
 *  - an empty (or wrongly typed) secret is rejected on both sides
 *  - the unsigned path is unchanged, and the two forms do not
 *    accept each other — a signed restore cannot silently
 *    downgrade to trusted configuration
 *  - approval expiry keeps aging from the original timestamps
 *    across a signed restore, never refreshed by it
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import {
  approvalStatement,
  createQuorum,
  exportSignedQuorumSnapshot,
  restoreQuorum,
  restoreSignedQuorumSnapshot,
} from "../src/index.js";
import type {
  Quorum,
  QuorumConfig,
  QuorumSignedSnapshotEnvelope,
  QuorumSnapshot,
} from "../src/index.js";

const SECRET = "quorum-snapshot-signing-secret-for-tests";
const WRONG_SECRET = "quorum-snapshot-signing-secret-that-is-wrong";
const T0 = Date.parse("2026-11-14T00:00:00.000Z");
const SIGNERS = ["dao-1", "dao-2", "dao-3", "dao-4", "dao-5"];

/** Mutable clock so expiry tests can move time without rebuilding. */
function clock() {
  let nowMs = T0;
  return {
    now: () => nowMs,
    set: (ms: number) => {
      nowMs = ms;
    },
  };
}

function keyPairs() {
  const keys = new Map<string, ReturnType<typeof generateKeyPairSync>>();
  for (const signerId of SIGNERS)
    keys.set(signerId, generateKeyPairSync("ed25519"));
  return keys;
}

function signApproval(
  pair: ReturnType<typeof generateKeyPairSync>,
  signerId: string,
): Buffer {
  return sign(null, approvalStatement(signerId), pair.privateKey);
}

function publicKeys(
  keys: Map<string, ReturnType<typeof generateKeyPairSync>>,
): Record<string, ReturnType<typeof generateKeyPairSync>["publicKey"]> {
  return Object.fromEntries(
    [...keys.entries()].map(([id, pair]) => [id, pair.publicKey]),
  );
}

/**
 * Seeded quorum: threshold 3 of 5 — dao-1 verified via `approveSigned`
 * (with evidence), dao-2 plain `approve()` (with evidence), dao-3
 * plain `approve()` without evidence. dao-1/dao-2/dao-3 reach quorum.
 */
function seededQuorum(): { quorum: Quorum; config: QuorumConfig } {
  const c = clock();
  const keys = keyPairs();
  const config: QuorumConfig = {
    threshold: 3,
    signers: SIGNERS,
    now: c.now,
    signerPublicKeys: publicKeys(keys),
  };
  const quorum = createQuorum(config);
  quorum.approveSigned(
    "dao-1",
    signApproval(keys.get("dao-1")!, "dao-1"),
    "gov-proposal-42",
  );
  quorum.approve("dao-2", "vote-record-7");
  quorum.approve("dao-3");
  return { quorum, config };
}

/** Deep-clone a value so tampering tests don't fight Object.freeze. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Independent canonical-JSON re-implementation (keys sorted
 * recursively, array order preserved) for the MAC-valid-but-malformed
 * test: it re-signs a hand-built snapshot so the envelope passes the
 * MAC check and must then fail the snapshot validation underneath.
 */
function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error(`cannot canonicalize ${typeof value}`);
}

function macFor(snapshot: QuorumSnapshot, secret: string, expiresAt?: string): string {
  const input = expiresAt === undefined ? snapshot : { expiresAt, snapshot };
  return createHmac("sha256", secret)
    .update(canonicalJson(input), "utf8")
    .digest("hex");
}

test("exportSignedQuorumSnapshot returns a v1 envelope with a 64-hex mac and no secret", () => {
  const { quorum } = seededQuorum();
  const envelope = exportSignedQuorumSnapshot(quorum, SECRET);
  assert.equal(envelope.v, 1);
  assert.match(envelope.mac, /^[0-9a-f]{64}$/);
  assert.equal(envelope.expiresAt, undefined);
  assert.equal(envelope.snapshot.threshold, 3);
  assert.deepEqual(envelope.snapshot.signers, SIGNERS);
  assert.equal(JSON.stringify(envelope).includes(SECRET), false);
});

test("signed round-trip restores the approval log item-for-item and keeps counting", () => {
  const { quorum, config } = seededQuorum();
  const envelope = exportSignedQuorumSnapshot(quorum, SECRET);
  const restored = restoreSignedQuorumSnapshot(config, envelope, SECRET);
  assert.deepEqual(restored.approvalLog(), quorum.approvalLog());
  assert.deepEqual(restored.snapshot(), quorum.snapshot());
  assert.equal(restored.hasQuorum(), true);
  assert.equal(restored.approvalCount(), 3);
  assert.deepEqual(restored.approvals(), ["dao-1", "dao-2", "dao-3"]);
  // The restored quorum keeps working: a fourth approval counts.
  restored.approve("dao-4");
  assert.equal(restored.approvalCount(), 4);
  assert.deepEqual(restored.approvals(), ["dao-1", "dao-2", "dao-3", "dao-4"]);
});

test("signed round-trip preserves verified flags and evidence exactly", () => {
  const { quorum, config } = seededQuorum();
  const envelope = exportSignedQuorumSnapshot(quorum, SECRET);
  const restored = restoreSignedQuorumSnapshot(config, envelope, SECRET);
  const log = restored.approvalLog();
  assert.equal(log[0].signerId, "dao-1");
  assert.equal(log[0].verified, true);
  assert.equal(log[0].evidence, "gov-proposal-42");
  assert.equal(log[1].signerId, "dao-2");
  assert.equal(log[1].verified, undefined);
  assert.equal(log[1].evidence, "vote-record-7");
  assert.equal(log[2].signerId, "dao-3");
  assert.equal(log[2].verified, undefined);
  assert.equal(log[2].evidence, undefined);
});

test("Buffer secret round-trips like a string secret", () => {
  const { quorum, config } = seededQuorum();
  const envelope = exportSignedQuorumSnapshot(quorum, Buffer.from(SECRET, "utf8"));
  const restored = restoreSignedQuorumSnapshot(
    config,
    envelope,
    Buffer.from(SECRET, "utf8"),
  );
  assert.deepEqual(restored.approvalLog(), quorum.approvalLog());
});

test("tampering a verified flag fails with a MAC mismatch", () => {
  const { quorum, config } = seededQuorum();
  const envelope = clone(exportSignedQuorumSnapshot(quorum, SECRET)) as unknown as {
    snapshot: { approvals: { verified?: boolean }[] };
  };
  // Forge the unverified dao-2 vote into a "verified" one.
  envelope.snapshot.approvals[1].verified = true;
  assert.throws(
    () =>
      restoreSignedQuorumSnapshot(
        config,
        envelope as unknown as QuorumSignedSnapshotEnvelope,
        SECRET,
      ),
    /Quorum: signed snapshot MAC mismatch/,
  );
});

test("tampering the threshold or a signer id fails with a MAC mismatch", () => {
  const { quorum, config } = seededQuorum();
  const thresholdTampered = clone(exportSignedQuorumSnapshot(quorum, SECRET)) as unknown as {
    snapshot: { threshold: number };
  };
  thresholdTampered.snapshot.threshold = 2;
  assert.throws(
    () =>
      restoreSignedQuorumSnapshot(
        config,
        thresholdTampered as unknown as QuorumSignedSnapshotEnvelope,
        SECRET,
      ),
    /Quorum: signed snapshot MAC mismatch/,
  );
  const signerTampered = clone(exportSignedQuorumSnapshot(quorum, SECRET)) as unknown as {
    snapshot: { approvals: { signerId: string }[] };
  };
  signerTampered.snapshot.approvals[0].signerId = "dao-5";
  assert.throws(
    () =>
      restoreSignedQuorumSnapshot(
        config,
        signerTampered as unknown as QuorumSignedSnapshotEnvelope,
        SECRET,
      ),
    /Quorum: signed snapshot MAC mismatch/,
  );
});

test("tampering the mac itself fails with a MAC mismatch", () => {
  const { quorum, config } = seededQuorum();
  const envelope = clone(exportSignedQuorumSnapshot(quorum, SECRET));
  envelope.mac = "0".repeat(64);
  assert.throws(
    () => restoreSignedQuorumSnapshot(config, envelope, SECRET),
    /Quorum: signed snapshot MAC mismatch/,
  );
});

test("a wrong secret fails with a MAC mismatch", () => {
  const { quorum, config } = seededQuorum();
  const envelope = exportSignedQuorumSnapshot(quorum, SECRET);
  assert.throws(
    () => restoreSignedQuorumSnapshot(config, envelope, WRONG_SECRET),
    /Quorum: signed snapshot MAC mismatch/,
  );
});

test("envelope shape is validated first: unknown field, wrong version, malformed mac", () => {
  const { quorum, config } = seededQuorum();
  const withSecret = clone(exportSignedQuorumSnapshot(quorum, SECRET)) as unknown as Record<
    string,
    unknown
  >;
  withSecret.secret = SECRET;
  assert.throws(
    () =>
      restoreSignedQuorumSnapshot(
        config,
        withSecret as unknown as QuorumSignedSnapshotEnvelope,
        SECRET,
      ),
    /Quorum: invalid signed snapshot envelope: unknown field "secret"/,
  );
  const versioned = clone(exportSignedQuorumSnapshot(quorum, SECRET)) as unknown as Record<
    string,
    unknown
  >;
  versioned.v = 2;
  assert.throws(
    () =>
      restoreSignedQuorumSnapshot(
        config,
        versioned as unknown as QuorumSignedSnapshotEnvelope,
        SECRET,
      ),
    /unsupported envelope version 2/,
  );
  const shortMac = clone(exportSignedQuorumSnapshot(quorum, SECRET));
  shortMac.mac = "abcd";
  assert.throws(
    () => restoreSignedQuorumSnapshot(config, shortMac, SECRET),
    /mac must be a 64-character lowercase hex HMAC-SHA256 digest/,
  );
  const upperMac = clone(exportSignedQuorumSnapshot(quorum, SECRET));
  upperMac.mac = upperMac.mac.toUpperCase();
  assert.throws(
    () => restoreSignedQuorumSnapshot(config, upperMac, SECRET),
    /mac must be a 64-character lowercase hex HMAC-SHA256 digest/,
  );
  assert.throws(
    () => restoreSignedQuorumSnapshot(config, null, SECRET),
    /expected an object of the form \{ v: 1, snapshot, mac \}/,
  );
});

test("a tampered expiresAt reports a MAC mismatch, never an expiry", () => {
  const { quorum, config } = seededQuorum();
  const envelope = clone(
    exportSignedQuorumSnapshot(quorum, SECRET, {
      expiresAt: "2026-11-15T00:00:00.000Z",
    }),
  );
  // Extend the expiry without the secret: the MAC must catch it first.
  envelope.expiresAt = "2027-11-15T00:00:00.000Z";
  assert.throws(
    () =>
      restoreSignedQuorumSnapshot(config, envelope, SECRET, {
        now: Date.parse("2026-11-16T00:00:00.000Z"),
      }),
    /Quorum: signed snapshot MAC mismatch/,
  );
});

test("an expired envelope is rejected, and restoring exactly at expiresAt still succeeds", () => {
  const { quorum, config } = seededQuorum();
  const expiresAt = "2026-11-15T00:00:00.000Z";
  const envelope = exportSignedQuorumSnapshot(quorum, SECRET, { expiresAt });
  assert.equal(envelope.expiresAt, expiresAt);
  assert.throws(
    () =>
      restoreSignedQuorumSnapshot(config, envelope, SECRET, {
        now: Date.parse(expiresAt) + 1,
      }),
    new RegExp(`Quorum: signed snapshot envelope expired at ${expiresAt}`),
  );
  const restored = restoreSignedQuorumSnapshot(config, envelope, SECRET, {
    now: Date.parse(expiresAt),
  });
  assert.deepEqual(restored.approvalLog(), quorum.approvalLog());
});

test("maxAgeMs resolves expiresAt against now and the envelope verifies inside the window", () => {
  const { quorum, config } = seededQuorum();
  const envelope = exportSignedQuorumSnapshot(quorum, SECRET, {
    maxAgeMs: 60_000,
    now: T0,
  });
  assert.equal(
    envelope.expiresAt,
    new Date(T0 + 60_000).toISOString(),
  );
  const restored = restoreSignedQuorumSnapshot(config, envelope, SECRET, {
    now: T0 + 59_999,
  });
  assert.equal(restored.hasQuorum(), true);
  assert.throws(
    () =>
      restoreSignedQuorumSnapshot(config, envelope, SECRET, {
        now: T0 + 60_001,
      }),
    /Quorum: signed snapshot envelope expired at/,
  );
});

test("invalid expiry options fail fast on export", () => {
  const { quorum } = seededQuorum();
  assert.throws(
    () =>
      exportSignedQuorumSnapshot(quorum, SECRET, {
        expiresAt: "2026-11-15T00:00:00.000Z",
        maxAgeMs: 60_000,
      }),
    /must not combine expiresAt and maxAgeMs/,
  );
  assert.throws(
    () => exportSignedQuorumSnapshot(quorum, SECRET, { maxAgeMs: 0 }),
    /maxAgeMs must be a positive finite number/,
  );
  assert.throws(
    () => exportSignedQuorumSnapshot(quorum, SECRET, { maxAgeMs: -1000 }),
    /maxAgeMs must be a positive finite number/,
  );
  assert.throws(
    () => exportSignedQuorumSnapshot(quorum, SECRET, { maxAgeMs: Number.NaN }),
    /maxAgeMs must be a positive finite number/,
  );
  assert.throws(
    () =>
      exportSignedQuorumSnapshot(quorum, SECRET, {
        expiresAt: "2026-11-15 00:00:00",
      }),
    /expiresAt must be a canonical ISO-8601 UTC timestamp string/,
  );
  assert.throws(
    () => exportSignedQuorumSnapshot(quorum, SECRET, { now: T0 }),
    /option now is only used with maxAgeMs/,
  );
  assert.throws(
    () =>
      exportSignedQuorumSnapshot(
        quorum,
        SECRET,
        "not-an-object" as unknown as never,
      ),
    /options must be an object/,
  );
});

test("an empty or wrongly typed secret is rejected on both sides", () => {
  const { quorum, config } = seededQuorum();
  assert.throws(
    () => exportSignedQuorumSnapshot(quorum, ""),
    /signed snapshot secret must not be empty/,
  );
  assert.throws(
    () => exportSignedQuorumSnapshot(quorum, Buffer.alloc(0)),
    /signed snapshot secret must not be empty/,
  );
  assert.throws(
    () => exportSignedQuorumSnapshot(quorum, 42 as unknown as string),
    /signed snapshot secret must be a non-empty string or Buffer, got number/,
  );
  const envelope = exportSignedQuorumSnapshot(quorum, SECRET);
  assert.throws(
    () => restoreSignedQuorumSnapshot(config, envelope, ""),
    /signed snapshot secret must not be empty/,
  );
  assert.throws(
    () => restoreSignedQuorumSnapshot(config, envelope, null as unknown as string),
    /signed snapshot secret must be a non-empty string or Buffer, got object/,
  );
});

test("the unsigned path is unchanged and does not accept a signed envelope", () => {
  const { quorum, config } = seededQuorum();
  const plain = quorum.snapshot();
  const restored = restoreQuorum(config, clone(plain));
  assert.deepEqual(restored.approvalLog(), quorum.approvalLog());
  const envelope = exportSignedQuorumSnapshot(quorum, SECRET);
  assert.throws(
    () => restoreQuorum(config, clone(envelope) as unknown as QuorumSnapshot),
    /invalid quorum snapshot: unknown field "snapshot"/,
  );
  assert.throws(
    () =>
      restoreSignedQuorumSnapshot(
        config,
        clone(plain) as unknown as QuorumSignedSnapshotEnvelope,
        SECRET,
      ),
    // Shape validation runs before the mac check: a plain snapshot
    // is not an envelope, and its first non-envelope field is caught.
    /Quorum: invalid signed snapshot envelope: unknown field "threshold"/,
  );
});

test("a MAC-valid but malformed snapshot still fails snapshot validation", () => {
  const { quorum, config } = seededQuorum();
  const snapshot = clone(quorum.snapshot());
  // Unknown signer: shape-valid JSON, but restoreQuorum must refuse it.
  snapshot.approvals.push({
    signerId: "dao-99",
    at: new Date(T0).toISOString(),
  });
  const envelope: QuorumSignedSnapshotEnvelope = {
    v: 1,
    snapshot,
    mac: macFor(snapshot, SECRET),
  };
  assert.throws(
    () => restoreSignedQuorumSnapshot(config, envelope, SECRET),
    /invalid quorum snapshot: approvals\[3\]: unknown signer "dao-99"/,
  );
});

test("approval expiry keeps aging from the original timestamps across a signed restore", () => {
  const c = clock();
  const config: QuorumConfig = {
    threshold: 2,
    signers: SIGNERS,
    now: c.now,
    maxApprovalAgeMs: 60_000,
  };
  const quorum = createQuorum(config);
  quorum.approve("dao-1");
  quorum.approve("dao-2");
  assert.equal(quorum.hasQuorum(), true);
  const envelope = exportSignedQuorumSnapshot(quorum, SECRET);
  // 61s later the approvals have expired; the restore must not refresh them.
  // The counting clock lives in the config, so move it before restoring.
  c.set(T0 + 61_000);
  const restored = restoreSignedQuorumSnapshot(config, envelope, SECRET);
  assert.equal(restored.hasQuorum(), false);
  assert.equal(restored.approvalCount(), 0);
  assert.equal(restored.approvalLog().length, 2);
  // Re-approving after expiry records a fresh entry and counts again.
  restored.approve("dao-1");
  restored.approve("dao-2");
  assert.equal(restored.hasQuorum(), true);
});
