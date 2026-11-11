/**
 * `MAX_ACTOR_LENGTH` (256) enforcement on both gates (backlog #1056).
 *
 * The dispatch `actor` (a person/service short identifier) was only
 * checked for non-emptiness, so a caller could write a multi-megabyte
 * string straight into the append-only audit history and inflate every
 * snapshot, signed envelope, and NDJSON export that serializes it
 * verbatim. Both gates now enforce a 256-character ceiling — an actor
 * is a short identifier, normally tens of characters, so 256 leaves
 * orders of magnitude of headroom — with the same wording (`actor
 * must be at most 256 characters, got N`), rejecting oversized actors
 * outright instead of truncating them (truncation would change who
 * the entry says acted). The parse gate covers `fromJSON`,
 * `fromHistory`, `parseEscrowHistory`, and `historyFromNdjson` (all
 * four funnel through `parseEscrowSnapshot`). The length check sits
 * next to the existing non-empty check, before the idempotency dedup
 * and the RBAC check, so an oversized actor reports the length error
 * first and consumes no idempotency key.
 *
 * Deliberately NOT capped: `rolePolicy` names. A policy is
 * configuration, not audit data — it is never written into the
 * history, so a long name cannot inflate any persisted log — and a
 * name longer than the cap can never match a legal dispatch anyway
 * (dispatch rejects oversized actors before RBAC), so it is dead
 * configuration rather than a hole. That decision is pinned below.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  Escrow,
  MAX_ACTOR_LENGTH,
  MAX_EVIDENCE_LENGTH,
  MAX_NOTE_LENGTH,
  historyFromNdjson,
  parseEscrowHistory,
} from "../src/index.js";

function fresh(): Escrow {
  return new Escrow("actor-limit-test");
}

const AT = "2026-11-06T00:00:00.000Z";

function overlongActor(): string {
  return "x".repeat(MAX_ACTOR_LENGTH + 1);
}

function fundedHistoryWithActor(actor: string) {
  return [
    {
      seq: 1,
      event: "FUND",
      from: "CREATED",
      to: "FUNDED",
      at: AT,
      amount: 100,
      actor,
    },
  ];
}

// --- dispatch gate ---

test("dispatch rejects an actor longer than MAX_ACTOR_LENGTH with no history residue", () => {
  const e = fresh();
  assert.equal(MAX_ACTOR_LENGTH, 256);
  assert.throws(
    () => e.dispatch("FUND", undefined, 100, { actor: overlongActor() }),
    /invalid dispatch options: actor must be at most 256 characters, got 257/
  );
  assert.deepEqual(e.history, []);
  assert.equal(e.state, "CREATED");
});

test("dispatch accepts an actor of exactly MAX_ACTOR_LENGTH characters, recorded verbatim", () => {
  const e = fresh();
  assert.equal(
    e.dispatch("FUND", undefined, 100, {
      actor: "x".repeat(MAX_ACTOR_LENGTH),
    }),
    "FUNDED"
  );
  assert.equal(e.history[0].actor?.length, MAX_ACTOR_LENGTH);
  assert.equal(e.history[0].actor, "x".repeat(MAX_ACTOR_LENGTH));
});

test("dispatch rejects an actor one character over the limit", () => {
  const e = fresh();
  assert.throws(
    () => e.dispatch("FUND", undefined, 100, { actor: overlongActor() }),
    /got 257/
  );
  assert.deepEqual(e.history, []);
});

test("non-string actor still fails with the old type error, not the length error", () => {
  const e = fresh();
  assert.throws(
    () =>
      e.dispatch("FUND", undefined, 100, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        actor: 42 as any,
      }),
    /invalid dispatch options: actor must be a non-empty string, got 42/
  );
  assert.deepEqual(e.history, []);
});

test("empty actor still fails with the old non-empty error", () => {
  const e = fresh();
  assert.throws(
    () => e.dispatch("FUND", undefined, 100, { actor: "" }),
    /invalid dispatch options: actor must be a non-empty string, got ""/
  );
  assert.deepEqual(e.history, []);
});

test("a rejected overlong actor does not consume its idempotency key", () => {
  const e = fresh();
  const key = "k-actor-limit";
  assert.throws(
    () =>
      e.dispatch("FUND", undefined, 100, {
        idempotencyKey: key,
        actor: overlongActor(),
      }),
    /actor must be at most 256 characters/
  );
  // Same key with a fitting actor succeeds — the failed dispatch
  // never recorded it.
  assert.equal(
    e.dispatch("FUND", undefined, 100, {
      idempotencyKey: key,
      actor: "alice",
    }),
    "FUNDED"
  );
  assert.equal(
    e.history.filter((entry) => entry.event === "FUND").length,
    1
  );
});

test("RBAC-gated escrow reports the length error first, not 'actor not authorized'", () => {
  const e = new Escrow("actor-limit-rbac", {
    rolePolicy: { FUND: ["alice"] },
  });
  assert.throws(
    () => e.dispatch("FUND", undefined, 100, { actor: overlongActor() }),
    /invalid dispatch options: actor must be at most 256 characters, got 257/
  );
  assert.equal(e.state, "CREATED");
  assert.deepEqual(e.history, []);
});

test("a rolePolicy name longer than the cap is accepted at construction and simply never matches", () => {
  // Documented decision (see MAX_ACTOR_LENGTH JSDoc): policy names
  // are configuration, not audit data, so they carry no cap. The
  // overlong name is dead configuration — it can never authorize a
  // dispatch, because dispatch rejects oversized actors before RBAC.
  const overlongName = "x".repeat(MAX_ACTOR_LENGTH + 1);
  const e = new Escrow("actor-limit-policy", {
    rolePolicy: { FUND: [overlongName] },
  });
  // A fitting actor that is not listed is still refused by RBAC …
  assert.throws(
    () =>
      e.dispatch("FUND", undefined, 100, {
        actor: "a".repeat(MAX_ACTOR_LENGTH),
      }),
    /actor not authorized for FUND/
  );
  // … and dispatching AS the overlong name reports the length error,
  // not the RBAC error.
  assert.throws(
    () => e.dispatch("FUND", undefined, 100, { actor: overlongName }),
    /invalid dispatch options: actor must be at most 256 characters, got 257/
  );
  assert.equal(e.state, "CREATED");
  assert.deepEqual(e.history, []);
});

// --- independence from the note / evidence caps ---

test("a max-length note and a max-length actor pass together on FUND", () => {
  const e = fresh();
  assert.equal(
    e.dispatch("FUND", "x".repeat(MAX_NOTE_LENGTH), 100, {
      actor: "x".repeat(MAX_ACTOR_LENGTH),
    }),
    "FUNDED"
  );
  const entry = e.history[0];
  assert.equal(entry.note?.length, MAX_NOTE_LENGTH);
  assert.equal(entry.actor?.length, MAX_ACTOR_LENGTH);
});

test("an overlong note still reports the note error when the actor fits", () => {
  const e = fresh();
  assert.throws(
    () =>
      e.dispatch("FUND", "x".repeat(MAX_NOTE_LENGTH + 1), 100, {
        actor: "alice",
      }),
    /invalid dispatch: note must be at most 32768 characters, got 32769/
  );
  assert.deepEqual(e.history, []);
});

test("an overlong actor reports the actor error first when the evidence is also overlong", () => {
  const e = fresh();
  e.dispatch("FUND", "initial deposit", 100);
  e.dispatch("SUBMIT_MILESTONE", "milestone 1 delivered");
  assert.throws(
    () =>
      e.dispatch("VERIFY_PASS", undefined, undefined, {
        actor: overlongActor(),
        evidence: "x".repeat(MAX_EVIDENCE_LENGTH + 1),
      }),
    /invalid dispatch options: actor must be at most 256 characters, got 257/
  );
  assert.equal(e.state, "MILESTONE_SUBMITTED");
  assert.equal(e.history.length, 2);
});

// --- snapshot / history parse gate ---

test("fromJSON rejects a snapshot whose history actor is overlong", () => {
  const e = fresh();
  e.dispatch("FUND", undefined, 100, { actor: "alice" });
  const snapshot = e.toJSON() as unknown as Record<string, unknown>;
  const history = snapshot.history as Record<string, unknown>[];
  history[0].actor = overlongActor();
  assert.throws(
    () => Escrow.fromJSON(snapshot),
    /invalid snapshot: history\[0\]: actor must be at most 256 characters, got 257/
  );
});

test("parseEscrowHistory rejects an overlong actor entry", () => {
  assert.throws(
    () => parseEscrowHistory(fundedHistoryWithActor(overlongActor())),
    /invalid snapshot: history\[0\]: actor must be at most 256 characters, got 257/
  );
});

test("fromHistory rejects a history log with an overlong actor", () => {
  assert.throws(
    () =>
      Escrow.fromHistory(
        "actor-limit-test",
        fundedHistoryWithActor(overlongActor())
      ),
    /actor must be at most 256 characters, got 257/
  );
});

test("historyFromNdjson rejects an NDJSON line with an overlong actor", () => {
  const lines = fundedHistoryWithActor(overlongActor())
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  assert.throws(
    () => historyFromNdjson(`${lines}\n`),
    /actor must be at most 256 characters, got 257/
  );
});

test("a history at exactly the limit parses on every restore path", () => {
  const atLimit = fundedHistoryWithActor("x".repeat(MAX_ACTOR_LENGTH));
  assert.equal(parseEscrowHistory(atLimit).length, 1);
  const rebuilt = Escrow.fromHistory("actor-limit-test", atLimit);
  assert.equal(rebuilt.state, "FUNDED");
  assert.equal(rebuilt.history[0].actor?.length, MAX_ACTOR_LENGTH);
});
