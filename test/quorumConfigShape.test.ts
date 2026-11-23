/**
 * `QuorumConfig` body shape guard (backlog #1357).
 *
 * `createQuorum` and `restoreQuorum` both started by reading `config`
 * fields with no body check, so a null config surfaced a bare
 * `TypeError: Cannot convert undefined or null to object` from
 * `Object.keys` inside `assertValidConfig`, and an array config died
 * as the misleading field error `quorum signers must be a non-empty
 * array` (an array has no `signers` field). The quorum is the last
 * gate before escrow funds release, so a caller passing the wrong
 * shape deserves a named error, not a bare TypeError or a field error
 * about a field it never had. Both entry points share the guard
 * through `assertValidConfig`, which runs before the unknown-field
 * scan, the clock check (#1336) and every field validation; the
 * signed-restore path inherits it via `restoreQuorum`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createQuorum,
  exportSignedQuorumSnapshot,
  restoreQuorum,
  restoreSignedQuorumSnapshot,
} from "../src/index.js";
import type { QuorumConfig } from "../src/index.js";

const SECRET = "quorum-config-shape-test-secret";

function legalConfig(): QuorumConfig {
  return { threshold: 2, signers: ["a", "b", "c"] };
}

describe("QuorumConfig body shape guard", () => {
  it("createQuorum rejects a null config with a named error", () => {
    assert.throws(
      () => createQuorum(null as never),
      /quorum: config must be an object, got null/,
    );
  });

  it("createQuorum rejects a string config with a named error", () => {
    assert.throws(
      () => createQuorum("x" as never),
      /quorum: config must be an object, got "x"/,
    );
  });

  it("createQuorum rejects a number config with a named error", () => {
    assert.throws(
      () => createQuorum(42 as never),
      /quorum: config must be an object, got 42/,
    );
  });

  it("createQuorum rejects an array config with a named error", () => {
    // Before the guard an array died as the misleading field error
    // "quorum signers must be a non-empty array": an array has no
    // `signers` field, so the report blamed a field the caller
    // never had.
    assert.throws(
      () => createQuorum([] as never),
      /quorum: config must be an object, got \[\]/,
    );
  });

  it("restoreQuorum rejects a null config with a named error", () => {
    const quorum = createQuorum(legalConfig());
    assert.throws(
      () => restoreQuorum(null as never, quorum.snapshot()),
      /quorum: config must be an object, got null/,
    );
  });

  it("restoreQuorum rejects a string config with a named error", () => {
    const quorum = createQuorum(legalConfig());
    assert.throws(
      () => restoreQuorum("x" as never, quorum.snapshot()),
      /quorum: config must be an object, got "x"/,
    );
  });

  it("restoreQuorum rejects a number config with a named error", () => {
    const quorum = createQuorum(legalConfig());
    assert.throws(
      () => restoreQuorum(42 as never, quorum.snapshot()),
      /quorum: config must be an object, got 42/,
    );
  });

  it("restoreQuorum rejects an array config with a named error", () => {
    const quorum = createQuorum(legalConfig());
    assert.throws(
      () => restoreQuorum([] as never, quorum.snapshot()),
      /quorum: config must be an object, got \[\]/,
    );
  });

  it("the config guard runs before snapshot validation on restore", () => {
    // Both the config and the snapshot are broken: the config error
    // is reported as itself, not masked by the snapshot error.
    assert.throws(
      () => restoreQuorum(null as never, { bogus: true } as never),
      /quorum: config must be an object, got null/,
    );
  });

  it("legal createQuorum still reaches quorum after two approvals", () => {
    const quorum = createQuorum(legalConfig());
    quorum.approve("a");
    assert.equal(quorum.hasQuorum(), false);
    quorum.approve("b");
    assert.equal(quorum.hasQuorum(), true);
    assert.deepEqual(quorum.approvals(), ["a", "b"]);
  });

  it("legal restoreQuorum round-trips a snapshot unchanged", () => {
    const quorum = createQuorum(legalConfig());
    quorum.approve("a");
    quorum.approve("b");
    const restored = restoreQuorum(legalConfig(), quorum.snapshot());
    assert.equal(restored.hasQuorum(), true);
    assert.deepEqual(restored.approvals(), ["a", "b"]);
    assert.deepEqual(restored.approvalLog(), quorum.approvalLog());
  });

  it("the #1336 bad-clock error is unchanged", () => {
    // The clock is read lazily: construction succeeds and the pinned
    // error fires when the clock is first consumed by an approval.
    const quorum = createQuorum({
      threshold: 1,
      signers: ["a"],
      now: () => Number.NaN,
    });
    assert.throws(
      () => quorum.approve("a"),
      /quorum: now must return a finite number of milliseconds since the epoch, got NaN/,
    );
    assert.deepEqual(quorum.approvalLog(), []);
  });

  it("restoreSignedQuorumSnapshot inherits the config guard", () => {
    // Envelope validation runs first, so the envelope must be live
    // for the config guard to be the error that surfaces.
    const quorum = createQuorum(legalConfig());
    quorum.approve("a");
    const envelope = exportSignedQuorumSnapshot(quorum, SECRET, {
      expiresAt: "2027-11-15T00:00:00.000Z",
    });
    assert.throws(
      () =>
        restoreSignedQuorumSnapshot(null as never, envelope, SECRET),
      /quorum: config must be an object, got null/,
    );
  });
});
