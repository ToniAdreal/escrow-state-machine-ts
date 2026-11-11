/**
 * `MAX_EVIDENCE_LENGTH` (32,768) enforcement on both gates (backlog #1052).
 *
 * The dispatch `evidence` reference (a Chainlink request ID, zk proof
 * commitment, or TEE attestation quote hash) was only checked for
 * non-emptiness, so a caller could write a multi-megabyte string
 * straight into the append-only audit history and inflate every
 * snapshot, signed envelope, and NDJSON export that serializes it
 * verbatim. Both gates now enforce the same value as the note cap
 * (32,768 characters — an evidence reference is a short identifier,
 * so the ceiling leaves orders of magnitude of headroom) with the
 * same wording (`evidence must be at most 32768 characters, got N`),
 * rejecting oversized references outright instead of truncating them
 * (truncation would change what the reference points at). The parse
 * gate covers `fromJSON`, `fromHistory`, `parseEscrowHistory`, and
 * `historyFromNdjson` (all four funnel through `parseEscrowSnapshot`).
 * The length check sits next to the existing non-empty check, before
 * the `requireVerifyEvidence` gate, so a gated escrow reports the
 * length error first for evidence that was supplied but too long.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  Escrow,
  MAX_EVIDENCE_LENGTH,
  MAX_NOTE_LENGTH,
  historyFromNdjson,
  parseEscrowHistory,
} from "../src/index.js";

function submitted(): Escrow {
  const e = new Escrow("evidence-limit-test");
  e.dispatch("FUND", "initial deposit", 10630);
  e.dispatch("SUBMIT_MILESTONE", "milestone 1 delivered");
  return e;
}

function gatedSubmitted(): Escrow {
  const e = new Escrow("evidence-limit-gated", {
    requireVerifyEvidence: true,
  });
  e.dispatch("FUND", "initial deposit", 10630);
  e.dispatch("SUBMIT_MILESTONE", "milestone 1 delivered");
  return e;
}

const AT = "2026-11-06T00:00:00.000Z";

function overlongEvidence(): string {
  return "x".repeat(MAX_EVIDENCE_LENGTH + 1);
}

function verifiedHistoryWithEvidence(evidence: string) {
  return [
    {
      seq: 1,
      event: "FUND",
      from: "CREATED",
      to: "FUNDED",
      at: AT,
      amount: 100,
    },
    {
      seq: 2,
      event: "SUBMIT_MILESTONE",
      from: "FUNDED",
      to: "MILESTONE_SUBMITTED",
      at: AT,
    },
    {
      seq: 3,
      event: "VERIFY_PASS",
      from: "MILESTONE_SUBMITTED",
      to: "VERIFIED",
      at: AT,
      evidence,
    },
  ];
}

// --- dispatch gate ---

test("dispatch rejects evidence longer than MAX_EVIDENCE_LENGTH with no history residue", () => {
  const e = submitted();
  assert.equal(MAX_EVIDENCE_LENGTH, 32_768);
  assert.throws(
    () =>
      e.dispatch("VERIFY_PASS", undefined, undefined, {
        evidence: "x".repeat(40_000),
      }),
    /invalid dispatch: evidence must be at most 32768 characters, got 40000/
  );
  assert.equal(e.state, "MILESTONE_SUBMITTED");
  assert.equal(e.history.length, 2);
});

test("dispatch accepts evidence of exactly MAX_EVIDENCE_LENGTH characters", () => {
  const e = submitted();
  assert.equal(
    e.dispatch("VERIFY_PASS", undefined, undefined, {
      evidence: "x".repeat(MAX_EVIDENCE_LENGTH),
    }),
    "VERIFIED"
  );
  assert.equal(
    e.history[e.history.length - 1].evidence?.length,
    MAX_EVIDENCE_LENGTH
  );
});

test("dispatch rejects evidence one character over the limit", () => {
  const e = submitted();
  assert.throws(
    () =>
      e.dispatch("VERIFY_PASS", undefined, undefined, {
        evidence: overlongEvidence(),
      }),
    /got 32769/
  );
  assert.equal(e.history.length, 2);
});

test("non-string evidence still fails with the old type error, not the length error", () => {
  const e = submitted();
  assert.throws(
    () =>
      e.dispatch("VERIFY_PASS", undefined, undefined, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        evidence: 42 as any,
      }),
    /invalid dispatch: evidence must be a non-empty string, got 42/
  );
  assert.equal(e.history.length, 2);
});

test("empty evidence still fails with the old non-empty error", () => {
  const e = submitted();
  assert.throws(
    () =>
      e.dispatch("VERIFY_PASS", undefined, undefined, { evidence: "" }),
    /invalid dispatch: evidence must be a non-empty string, got /
  );
  assert.equal(e.history.length, 2);
});

test("a rejected overlong evidence does not consume its idempotency key", () => {
  const e = submitted();
  const key = "k-evidence-limit";
  assert.throws(
    () =>
      e.dispatch("VERIFY_PASS", undefined, undefined, {
        idempotencyKey: key,
        evidence: overlongEvidence(),
      }),
    /evidence must be at most 32768 characters/
  );
  // Same key with a fitting reference succeeds — the failed dispatch
  // never recorded it.
  assert.equal(
    e.dispatch("VERIFY_PASS", undefined, undefined, {
      idempotencyKey: key,
      evidence: "chainlink-req-1",
    }),
    "VERIFIED"
  );
  assert.equal(
    e.history.filter((entry) => entry.event === "VERIFY_PASS").length,
    1
  );
});

test("gated escrow reports the length error first, not 'verify evidence required'", () => {
  const e = gatedSubmitted();
  assert.throws(
    () =>
      e.dispatch("VERIFY_PASS", undefined, undefined, {
        evidence: overlongEvidence(),
      }),
    /invalid dispatch: evidence must be at most 32768 characters, got 32769/
  );
  assert.equal(e.state, "MILESTONE_SUBMITTED");
  assert.equal(e.history.length, 2);
});

test("overlong evidence on a non-VERIFY_PASS event reports the event error first", () => {
  const e = new Escrow("evidence-limit-event");
  assert.throws(
    () =>
      e.dispatch("FUND", "initial", 100, {
        evidence: overlongEvidence(),
      } as never),
    /evidence is only accepted on VERIFY_PASS, not on FUND/
  );
  assert.deepEqual(e.history, []);
});

// --- independence from the note cap ---

test("a max-length note and max-length evidence pass together on VERIFY_PASS", () => {
  const e = submitted();
  assert.equal(
    e.dispatch(
      "VERIFY_PASS",
      "x".repeat(MAX_NOTE_LENGTH),
      undefined,
      { evidence: "x".repeat(MAX_EVIDENCE_LENGTH) }
    ),
    "VERIFIED"
  );
  const entry = e.history[e.history.length - 1];
  assert.equal(entry.note?.length, MAX_NOTE_LENGTH);
  assert.equal(entry.evidence?.length, MAX_EVIDENCE_LENGTH);
});

test("an overlong note still reports the note error when the evidence fits", () => {
  const e = submitted();
  assert.throws(
    () =>
      e.dispatch("VERIFY_PASS", "x".repeat(MAX_NOTE_LENGTH + 1), undefined, {
        evidence: "chainlink-req-1",
      }),
    /invalid dispatch: note must be at most 32768 characters, got 32769/
  );
  assert.equal(e.history.length, 2);
});

// --- snapshot / history parse gate ---

test("fromJSON rejects a snapshot whose VERIFY_PASS evidence is overlong", () => {
  const e = submitted();
  e.dispatch("VERIFY_PASS", undefined, undefined, {
    evidence: "chainlink-req-1",
  });
  const snapshot = e.toJSON() as unknown as Record<string, unknown>;
  const history = snapshot.history as Record<string, unknown>[];
  history[2].evidence = overlongEvidence();
  assert.throws(
    () => Escrow.fromJSON(snapshot),
    /invalid snapshot: history\[2\]: evidence must be at most 32768 characters, got 32769/
  );
});

test("parseEscrowHistory rejects an overlong evidence entry", () => {
  assert.throws(
    () => parseEscrowHistory(verifiedHistoryWithEvidence(overlongEvidence())),
    /invalid snapshot: history\[2\]: evidence must be at most 32768 characters, got 32769/
  );
});

test("fromHistory rejects a history log with overlong evidence", () => {
  assert.throws(
    () =>
      Escrow.fromHistory(
        "evidence-limit-test",
        verifiedHistoryWithEvidence(overlongEvidence())
      ),
    /evidence must be at most 32768 characters, got 32769/
  );
});

test("historyFromNdjson rejects an NDJSON line with overlong evidence", () => {
  const lines = verifiedHistoryWithEvidence(overlongEvidence())
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  assert.throws(
    () => historyFromNdjson(`${lines}\n`),
    /evidence must be at most 32768 characters, got 32769/
  );
});

test("a history at exactly the limit parses on every restore path", () => {
  const atLimit = verifiedHistoryWithEvidence(
    "x".repeat(MAX_EVIDENCE_LENGTH)
  );
  assert.equal(parseEscrowHistory(atLimit).length, 3);
  const rebuilt = Escrow.fromHistory("evidence-limit-test", atLimit);
  assert.equal(rebuilt.state, "VERIFIED");
  assert.equal(
    rebuilt.history[rebuilt.history.length - 1].evidence?.length,
    MAX_EVIDENCE_LENGTH
  );
});
