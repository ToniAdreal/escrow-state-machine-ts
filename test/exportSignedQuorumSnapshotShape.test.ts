/**
 * Shape guard for `exportSignedQuorumSnapshot` (backlog #1395):
 * the signed-snapshot export is the exit of the quorum trust chain
 * — the MAC authenticates `quorum.snapshot()` — and a mistyped
 * `quorum` used to die as a bare `TypeError` from the method call
 * (`Cannot read properties of null (reading 'snapshot')` /
 * `quorum.snapshot is not a function`), with no function name and
 * no hint that the argument itself was wrong. Rules under test:
 *  - `null` / `undefined` / a string / a number / `{}` / an object
 *    whose `snapshot` is not a function each throw the named error
 *    `Quorum: exportSignedQuorumSnapshot: quorum must be a Quorum,
 *    got <null|typeof>` — a plain `Error`, never a `TypeError`
 *  - the guard runs before the secret check: a null quorum with an
 *    empty secret reports the quorum error, not the secret error
 *  - a legal export still round-trips through
 *    `restoreSignedQuorumSnapshot`, with and without `expiresAt`
 *  - the guard only requires the `snapshot()` method this function
 *    actually calls, so a duck-typed quorum still exports
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createQuorum,
  exportSignedQuorumSnapshot,
  restoreSignedQuorumSnapshot,
} from "../src/index.js";
import type { QuorumConfig } from "../src/index.js";

const SECRET = "export-signed-quorum-snapshot-shape-secret";

const CONFIG: QuorumConfig = { threshold: 1, signers: ["dao-1", "dao-2"] };

function assertNamedQuorumError(fn: () => unknown, got: string): void {
  assert.throws(
    fn,
    (error: unknown) => {
      assert.ok(error instanceof Error, "expected an Error");
      assert.ok(
        !(error instanceof TypeError),
        `expected a plain Error, got TypeError: ${error.message}`,
      );
      assert.equal(
        error.message,
        `Quorum: exportSignedQuorumSnapshot: quorum must be a Quorum, got ${got}`,
      );
      return true;
    },
  );
}

test("null quorum throws a named error, not a bare TypeError", () => {
  assertNamedQuorumError(
    () => exportSignedQuorumSnapshot(null as never, SECRET),
    "null",
  );
});

test("undefined quorum throws a named error", () => {
  assertNamedQuorumError(
    () => exportSignedQuorumSnapshot(undefined as never, SECRET),
    "undefined",
  );
});

test("string and number quorums throw a named error", () => {
  assertNamedQuorumError(
    () => exportSignedQuorumSnapshot("dao-1" as never, SECRET),
    "string",
  );
  assertNamedQuorumError(
    () => exportSignedQuorumSnapshot(42 as never, SECRET),
    "number",
  );
});

test("plain object and object without a snapshot method throw", () => {
  assertNamedQuorumError(
    () => exportSignedQuorumSnapshot({} as never, SECRET),
    "object",
  );
  assertNamedQuorumError(
    () => exportSignedQuorumSnapshot({ snapshot: 1 } as never, SECRET),
    "object",
  );
  assertNamedQuorumError(
    () =>
      exportSignedQuorumSnapshot(
        { snapshot: "snapshot" } as never,
        SECRET,
      ),
    "object",
  );
});

test("quorum guard runs before the secret check", () => {
  assertNamedQuorumError(
    () => exportSignedQuorumSnapshot(null as never, ""),
    "null",
  );
  assertNamedQuorumError(
    () => exportSignedQuorumSnapshot({} as never, ""),
    "object",
  );
  // A legal quorum with an empty secret still reports the secret
  // error, proving the guard did not swallow the secret check.
  assert.throws(
    () => exportSignedQuorumSnapshot(createQuorum(CONFIG), ""),
    (error: unknown) =>
      error instanceof Error &&
      error.message ===
        "Quorum: signed snapshot secret must not be empty",
  );
});

test("legal export still round-trips through restore", () => {
  const quorum = createQuorum(CONFIG);
  quorum.approve("dao-1");
  const envelope = exportSignedQuorumSnapshot(quorum, SECRET);
  assert.equal(envelope.v, 1);
  assert.match(envelope.mac, /^[0-9a-f]{64}$/);
  const restored = restoreSignedQuorumSnapshot(CONFIG, envelope, SECRET);
  assert.equal(restored.hasQuorum(), true);
  assert.deepEqual(restored.approvals(), ["dao-1"]);
});

test("legal export with expiresAt still round-trips", () => {
  const quorum = createQuorum(CONFIG);
  quorum.approve("dao-2");
  const envelope = exportSignedQuorumSnapshot(quorum, SECRET, {
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  assert.equal(envelope.expiresAt, "2099-01-01T00:00:00.000Z");
  const restored = restoreSignedQuorumSnapshot(CONFIG, envelope, SECRET, {
    now: Date.parse("2098-01-01T00:00:00.000Z"),
  });
  assert.equal(restored.hasQuorum(), true);
  assert.deepEqual(restored.approvals(), ["dao-2"]);
});

test("duck-typed quorum with only a snapshot method still exports", () => {
  const quorum = createQuorum(CONFIG);
  quorum.approve("dao-1");
  const duckTyped = { snapshot: () => quorum.snapshot() };
  const envelope = exportSignedQuorumSnapshot(duckTyped as never, SECRET);
  assert.equal(envelope.v, 1);
  const restored = restoreSignedQuorumSnapshot(CONFIG, envelope, SECRET);
  assert.equal(restored.hasQuorum(), true);
  assert.deepEqual(restored.approvals(), ["dao-1"]);
});
