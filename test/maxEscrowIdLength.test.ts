/**
 * `MAX_ESCROW_ID_LENGTH` (256) enforcement on all three id gates
 * (backlog #1061).
 *
 * The escrow id was only checked for non-emptiness, so a caller could
 * pass a multi-megabyte string straight into the constructor and have
 * it stamped verbatim onto every history entry, snapshot, NDJSON
 * export, settlement report, and webhook payload that carries it.
 * All three gates now enforce a 256-character ceiling — an id is a
 * short identifier (the demo uses `demo-cap`, a UUID is 36
 * characters), so 256 leaves orders of magnitude of headroom — with
 * the same wording (`id must be at most 256 characters, got N`),
 * rejecting oversized ids outright instead of truncating them
 * (truncation would change which escrow a log belongs to). The
 * constructor gate covers live construction, the snapshot parser
 * covers `fromJSON` (and, through it, every restore path), and
 * `Escrow.fromHistory` covers bare-history/NDJSON rebuilds, where the
 * id is supplied explicitly because history entries carry no id.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  Escrow,
  MAX_ESCROW_ID_LENGTH,
  historyFromNdjson,
  historyToNdjson,
} from "../src/index.js";

function overlongId(): string {
  return "x".repeat(MAX_ESCROW_ID_LENGTH + 1);
}

function atLimitId(): string {
  return "x".repeat(MAX_ESCROW_ID_LENGTH);
}

function fundedEscrow(id: string): Escrow {
  const e = new Escrow(id);
  e.dispatch("FUND", "initial deposit", 100);
  return e;
}

// --- constructor gate ---

test("constructor rejects an id longer than MAX_ESCROW_ID_LENGTH", () => {
  assert.equal(MAX_ESCROW_ID_LENGTH, 256);
  assert.throws(
    () => new Escrow(overlongId()),
    /invalid escrow: id must be at most 256 characters, got 257/
  );
});

test("constructor accepts an id of exactly MAX_ESCROW_ID_LENGTH characters, recorded verbatim", () => {
  const e = new Escrow(atLimitId());
  assert.equal(e.id, atLimitId());
  assert.equal(e.id.length, MAX_ESCROW_ID_LENGTH);
  assert.equal(e.state, "CREATED");
});

test("empty and non-string ids still fail with the old non-empty error, not the length error", () => {
  assert.throws(
    () => new Escrow(""),
    /invalid escrow: id must be a non-empty string/
  );
  assert.throws(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => new Escrow(42 as any),
    /invalid escrow: id must be a non-empty string/
  );
});

// --- snapshot parse gate ---

test("fromJSON rejects a snapshot whose id is overlong", () => {
  const e = fundedEscrow("id-limit-test");
  const snapshot = e.toJSON() as unknown as Record<string, unknown>;
  snapshot.id = overlongId();
  assert.throws(
    () => Escrow.fromJSON(snapshot),
    /invalid snapshot: id must be at most 256 characters, got 257/
  );
});

test("fromJSON rejects an overlong id after a JSON string round-trip", () => {
  const e = fundedEscrow("id-limit-test");
  const snapshot = JSON.parse(
    JSON.stringify(e.toJSON())
  ) as Record<string, unknown>;
  snapshot.id = overlongId();
  assert.throws(
    () => Escrow.fromJSON(snapshot),
    /invalid snapshot: id must be at most 256 characters, got 257/
  );
});

test("fromJSON round-trips an escrow whose id is exactly at the limit", () => {
  const e = fundedEscrow(atLimitId());
  const rebuilt = Escrow.fromJSON(e.toJSON());
  assert.equal(rebuilt.id, atLimitId());
  assert.equal(rebuilt.state, "FUNDED");
  assert.deepEqual(rebuilt.history, e.history);
});

// --- fromHistory / NDJSON gate ---

test("fromHistory rejects an overlong id", () => {
  const e = fundedEscrow("id-limit-test");
  assert.throws(
    () => Escrow.fromHistory(overlongId(), e.history),
    /invalid history: id must be at most 256 characters, got 257/
  );
});

test("fromHistory rebuilds an escrow whose id is exactly at the limit", () => {
  const e = fundedEscrow("id-limit-test");
  const rebuilt = Escrow.fromHistory(atLimitId(), e.history);
  assert.equal(rebuilt.id, atLimitId());
  assert.equal(rebuilt.state, "FUNDED");
  // Rebuilt with the at-limit id, it keeps dispatching.
  assert.equal(rebuilt.dispatch("SUBMIT_MILESTONE", "milestone 1"), "MILESTONE_SUBMITTED");
});

test("NDJSON replay rejects an overlong id and accepts one at the limit", () => {
  const e = fundedEscrow("id-limit-test");
  const ndjson = historyToNdjson(e);
  const entries = historyFromNdjson(ndjson);
  assert.throws(
    () => Escrow.fromHistory(overlongId(), entries),
    /invalid history: id must be at most 256 characters, got 257/
  );
  const rebuilt = Escrow.fromHistory(atLimitId(), entries);
  assert.equal(rebuilt.id, atLimitId());
  assert.equal(rebuilt.state, "FUNDED");
});

// --- demo and existing ids unaffected ---

test("the demo's ids are far below the cap and construct unchanged", () => {
  // Representative of every id the CLI demo uses (all `DEMO-ESC-0xx`
  // or `demo-cap` in src/demo.ts); the full demo run is covered by
  // test/demo.test.ts — this pins that the cap does not touch them.
  for (const id of ["demo-cap", "DEMO-ESC-001", "DEMO-ESC-028"]) {
    assert.ok(id.length < MAX_ESCROW_ID_LENGTH);
    const e = new Escrow(id);
    assert.equal(e.id, id);
  }
});
