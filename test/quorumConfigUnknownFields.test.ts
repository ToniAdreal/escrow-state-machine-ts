/**
 * `QuorumConfig` unknown-field fail-closed (backlog #1281).
 *
 * `createQuorum({ threshold: 1, signers: ["a"], threshhold: 99,
 * maxApprovalAge: 1000 })` used to be silently accepted: the two
 * typo'd keys were dropped by destructuring, so the caller believed
 * the threshold was 99 while a single vote reached quorum, and
 * believed approvals expired after 1000 ms while they never expired.
 * The snapshot side (`validateQuorumSnapshotShape`) already rejected
 * unknown fields; the config side — the more dangerous side, since
 * `threshold` and `maxApprovalAgeMs` are live arbitration risk
 * controls — had no such check. Unknown config keys now throw
 * `quorum: unknown option "<name>"` before any field is consumed.
 * `createQuorum` and `restoreQuorum` share the check through
 * `assertValidConfig`, and `restoreSignedQuorumSnapshot`'s own
 * `opts` (only `now` is legal) fails closed the same way: a typo'd
 * clock used to fall back to `Date.now()` silently, so the envelope
 * expiry check ran on wall-clock instead of the injected clock.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  createQuorum,
  exportSignedQuorumSnapshot,
  restoreQuorum,
  restoreSignedQuorumSnapshot,
} from "../src/index.js";
import type { Quorum, QuorumConfig } from "../src/index.js";

const SECRET = "quorum-config-unknown-fields-test-secret";
const T0 = Date.parse("2026-11-14T00:00:00.000Z");

/** Mutable clock so the expiry-window test can move time. */
function clock() {
  let nowMs = T0;
  return {
    now: () => nowMs,
    set: (ms: number) => {
      nowMs = ms;
    },
  };
}

function legalConfig(): QuorumConfig {
  return { threshold: 2, signers: ["a", "b", "c"] };
}

describe("QuorumConfig unknown-field fail-closed", () => {
  it("accepts all five legal fields together", () => {
    const c = clock();
    const { publicKey } = generateKeyPairSync("ed25519");
    const quorum = createQuorum({
      threshold: 2,
      signers: ["a", "b", "c"],
      now: c.now,
      maxApprovalAgeMs: 1000,
      signerPublicKeys: { a: publicKey },
    });
    assert.equal(quorum.threshold, 2);
    assert.equal(quorum.signerCount, 3);
    quorum.approve("a");
    quorum.approve("b");
    assert.equal(quorum.hasQuorum(), true);
    // The window is really wired: past 1000 ms the votes stop counting.
    c.set(T0 + 1001);
    assert.equal(quorum.hasQuorum(), false);
  });

  it("accepts each legal field in isolation", () => {
    createQuorum({ threshold: 1, signers: ["a"] });
    createQuorum({ threshold: 1, signers: ["a"], now: () => T0 });
    createQuorum({
      threshold: 1,
      signers: ["a"],
      maxApprovalAgeMs: 60_000,
    });
    const { publicKey } = generateKeyPairSync("ed25519");
    createQuorum({
      threshold: 1,
      signers: ["a"],
      signerPublicKeys: { a: publicKey },
    });
  });

  it("rejects a typo'd threshhold and names the field", () => {
    assert.throws(
      () =>
        createQuorum({
          threshold: 1,
          signers: ["a"],
          threshhold: 99,
        } as never),
      /quorum: unknown option "threshhold"/,
    );
  });

  it("rejects a typo'd maxApprovalAge and names the field", () => {
    assert.throws(
      () =>
        createQuorum({
          threshold: 1,
          signers: ["a"],
          maxApprovalAge: 1000,
        } as never),
      /quorum: unknown option "maxApprovalAge"/,
    );
  });

  it("rejects a singular signer typo and case-variant misspellings", () => {
    assert.throws(
      () =>
        createQuorum({
          threshold: 1,
          signers: ["a"],
          signer: ["x"],
        } as never),
      /quorum: unknown option "signer"/,
    );
    assert.throws(
      () =>
        createQuorum({
          Threshold: 1,
          signers: ["a"],
        } as never),
      /quorum: unknown option "Threshold"/,
    );
    assert.throws(
      () =>
        createQuorum({
          threshold: 1,
          signers: ["a"],
          MaxApprovalAgeMs: 1000,
        } as never),
      /quorum: unknown option "MaxApprovalAgeMs"/,
    );
  });

  it("rejects unknown extras alongside legal fields, no instance produced", () => {
    let built: Quorum | undefined;
    assert.throws(() => {
      built = createQuorum({
        threshold: 1,
        signers: ["a"],
        maxApprovalAgeMs: 1000,
        debug: true,
      } as never);
    }, /quorum: unknown option "debug"/);
    assert.equal(built, undefined);
  });

  it("scans unknown keys before any other config validation", () => {
    // Both the typo and an illegal threshold are present: the typo is
    // reported as itself, not masked by the threshold error.
    assert.throws(
      () =>
        createQuorum({
          threshold: 0,
          signers: ["a"],
          threshhold: 99,
        } as never),
      /quorum: unknown option "threshhold"/,
    );
  });

  it("rejects a typo'd config on the restoreQuorum path", () => {
    const quorum = createQuorum(legalConfig());
    quorum.approve("a");
    const snapshot = quorum.snapshot();
    assert.throws(
      () =>
        restoreQuorum(
          { threshold: 2, signers: ["a", "b", "c"], threshhold: 99 } as never,
          snapshot,
        ),
      /quorum: unknown option "threshhold"/,
    );
  });

  it("restoreQuorum still accepts a legal config (no behavior change)", () => {
    const quorum = createQuorum(legalConfig());
    quorum.approve("a");
    quorum.approve("b");
    const restored = restoreQuorum(legalConfig(), quorum.snapshot());
    assert.equal(restored.hasQuorum(), true);
    assert.deepEqual(restored.approvals(), ["a", "b"]);
  });

  it("existing illegal configs still report their original errors", () => {
    assert.throws(
      () => createQuorum({ threshold: 0, signers: ["a"] }),
      /quorum threshold must be an integer ≥ 1/,
    );
    assert.throws(
      () => createQuorum({ threshold: 1, signers: [] }),
      /quorum signers must be a non-empty array/,
    );
    assert.throws(
      () => createQuorum({ threshold: 2, signers: ["a"] }),
      /quorum threshold 2 exceeds signer count 1/,
    );
    assert.throws(
      () =>
        createQuorum({
          threshold: 1,
          signers: ["a"],
          maxApprovalAgeMs: -5,
        }),
      /quorum maxApprovalAgeMs must be a positive finite number/,
    );
  });

  it("restoreSignedQuorumSnapshot rejects a typo'd restore clock", () => {
    const quorum = createQuorum(legalConfig());
    quorum.approve("a");
    const envelope = exportSignedQuorumSnapshot(quorum, SECRET, {
      expiresAt: "2026-11-15T00:00:00.000Z",
    });
    assert.throws(
      () =>
        restoreSignedQuorumSnapshot(legalConfig(), envelope, SECRET, {
          noww: T0,
        } as never),
      /Quorum: invalid signed snapshot envelope: unknown option "noww"/,
    );
    assert.throws(
      () =>
        restoreSignedQuorumSnapshot(
          legalConfig(),
          envelope,
          SECRET,
          "now" as never,
        ),
      /Quorum: invalid signed snapshot envelope: restore options must be an object/,
    );
  });

  it("restoreSignedQuorumSnapshot still accepts a legal now (no behavior change)", () => {
    const quorum = createQuorum(legalConfig());
    quorum.approve("a");
    const expiresAt = "2026-11-15T00:00:00.000Z";
    const envelope = exportSignedQuorumSnapshot(quorum, SECRET, {
      expiresAt,
    });
    const restored = restoreSignedQuorumSnapshot(legalConfig(), envelope, SECRET, {
      now: Date.parse(expiresAt),
    });
    assert.deepEqual(restored.approvalLog(), quorum.approvalLog());
  });
});
