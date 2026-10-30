/**
 * dispatchArbitration x rolePolicy combination (backlog #719).
 *
 * The arbitration wiring and event-level RBAC each have their own
 * suites, but their combination was never pinned: `dispatchArbitration`
 * forwards its opts to `escrow.dispatch` (src/arbitration.ts), so the
 * escrow's own rolePolicy should constrain arbitration events — while
 * the quorum gate still runs first, before dispatch is ever reached.
 * This file pins that interaction and its gate order:
 *
 * - With a reached quorum, an unauthorized actor's arbitration dispatch
 *   is rejected by the policy with the usual wording, leaves state,
 *   history and the quorum count untouched, and consumes no
 *   idempotency key (an authorized retry with the same key succeeds).
 * - A missing actor fails with the missing-actor wording.
 * - An authorized (moderator) actor's dispatch succeeds to the
 *   terminal state with the audit entry intact (quorum note, actor,
 *   hash chain verifies).
 * - Below quorum, even an authorized — and even an unauthorized —
 *   actor gets the quorum error, never a policy error: the quorum
 *   gate runs before dispatch, so policy is never consulted.
 * - The retry-safety forwarding is unaffected by policy: `expectedSeq`
 *   still guards (a stale seq conflicts before policy is consulted,
 *   since the seq guard runs first inside dispatch), and a
 *   policy-rejected attempt leaves the seq untouched for the retry.
 *
 * RBAC itself is a caller-supplied allowlist, NOT identity
 * authentication (see rolePolicy.test.ts): nothing here verifies who
 * the actor string really is.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  createQuorum,
  dispatchArbitration,
  verifyHistoryChain,
} from "../src/index.js";
import type { RolePolicy } from "../src/stateMachine.js";

const SIGNERS = [
  "dao-1", "dao-2", "dao-3", "dao-4", "dao-5",
  "dao-6", "dao-7", "dao-8", "dao-9",
];

/** Both arbitration outcomes gated to the moderator allowlist. */
const MODERATOR_POLICY: RolePolicy = {
  ARBITRATE_RELEASE: ["moderator"],
  ARBITRATE_REFUND: ["moderator"],
};

/** Escrow sitting in DISPUTED: CREATED -> FUNDED -> DISPUTED. */
function disputedEscrow(id: string, rolePolicy?: RolePolicy): Escrow {
  const escrow =
    rolePolicy === undefined ? new Escrow(id) : new Escrow(id, { rolePolicy });
  escrow.dispatch("FUND", undefined, 10630);
  escrow.dispatch("DISPUTE");
  assert.equal(escrow.state, "DISPUTED");
  assert.equal(escrow.history.length, 2);
  return escrow;
}

/** Quorum with the first `n` signers approved (5/9 rule). */
function quorumWith(n: number) {
  const quorum = createQuorum({ threshold: 5, signers: SIGNERS });
  for (let i = 0; i < n; i++) quorum.approve(SIGNERS[i]);
  return quorum;
}

describe("dispatchArbitration x rolePolicy", () => {
  it("unauthorized actor with reached quorum is rejected and leaves state/history/quorum untouched", () => {
    const escrow = disputedEscrow("arb-policy-no", MODERATOR_POLICY);
    const quorum = quorumWith(5);

    assert.throws(
      () =>
        dispatchArbitration(escrow, quorum, "release", undefined, {
          actor: "creator",
        }),
      /actor not authorized for ARBITRATE_RELEASE: "creator" is not in \[moderator\]/
    );
    assert.equal(escrow.state, "DISPUTED");
    assert.equal(escrow.history.length, 2);
    assert.equal(escrow.history[escrow.history.length - 1].event, "DISPUTE");
    // The quorum object is never mutated by a rejected dispatch.
    assert.equal(quorum.approvalCount(), 5);
    assert.equal(quorum.hasQuorum(), true);
    // The escrow is still usable by the authorized actor.
    assert.equal(
      dispatchArbitration(escrow, quorum, "release", undefined, {
        actor: "moderator",
      }),
      "RELEASED"
    );
  });

  it("missing actor with reached quorum fails with the missing-actor wording", () => {
    const escrow = disputedEscrow("arb-policy-anon", MODERATOR_POLICY);
    const quorum = quorumWith(5);

    assert.throws(
      () => dispatchArbitration(escrow, quorum, "release"),
      /actor not authorized for ARBITRATE_RELEASE: policy requires an actor in \[moderator\]/
    );
    assert.equal(escrow.state, "DISPUTED");
    assert.equal(escrow.history.length, 2);
  });

  it("authorized actor release succeeds to terminal with the audit entry intact", () => {
    const escrow = disputedEscrow("arb-policy-ok", MODERATOR_POLICY);
    const quorum = quorumWith(5);

    const state = dispatchArbitration(escrow, quorum, "release", "DAO vote passed", {
      actor: "moderator",
    });
    assert.equal(state, "RELEASED");
    assert.equal(escrow.state, "RELEASED");
    const last = escrow.history[escrow.history.length - 1];
    assert.equal(last.event, "ARBITRATE_RELEASE");
    assert.equal(last.from, "DISPUTED");
    assert.equal(last.to, "RELEASED");
    assert.equal(last.actor, "moderator");
    assert.equal(last.note, "DAO vote passed [quorum 5/5]");
    assert.equal(verifyHistoryChain(escrow.history), true);
  });

  it("authorized actor refund succeeds to REFUNDED under the same policy", () => {
    const escrow = disputedEscrow("arb-policy-refund", MODERATOR_POLICY);
    const quorum = quorumWith(6);

    assert.equal(
      dispatchArbitration(escrow, quorum, "refund", undefined, {
        actor: "moderator",
      }),
      "REFUNDED"
    );
    const last = escrow.history[escrow.history.length - 1];
    assert.equal(last.event, "ARBITRATE_REFUND");
    assert.equal(last.actor, "moderator");
    assert.equal(last.note, "quorum 6/5");
    assert.equal(verifyHistoryChain(escrow.history), true);
  });

  it("below quorum, an authorized actor gets the quorum error, not a success", () => {
    const escrow = disputedEscrow("arb-policy-short", MODERATOR_POLICY);
    const quorum = quorumWith(4); // 4/5: below threshold

    assert.throws(
      () =>
        dispatchArbitration(escrow, quorum, "release", undefined, {
          actor: "moderator",
        }),
      /arbitration requires quorum: 4\/5 approvals/
    );
    assert.equal(escrow.state, "DISPUTED");
    assert.equal(escrow.history.length, 2);
  });

  it("below quorum, an unauthorized actor also gets the quorum error, never the policy error", () => {
    // Gate order pinned: the quorum gate runs before dispatch, so the
    // policy is never consulted when the quorum is short — the caller
    // hears about the missing approvals, not about authorization.
    const escrow = disputedEscrow("arb-policy-short-no", MODERATOR_POLICY);
    const quorum = quorumWith(4);

    assert.throws(
      () =>
        dispatchArbitration(escrow, quorum, "release", undefined, {
          actor: "creator",
        }),
      /arbitration requires quorum: 4\/5 approvals/
    );
    assert.equal(escrow.state, "DISPUTED");
    assert.equal(escrow.history.length, 2);
    // Gathering approvals and retrying with the same (unauthorized)
    // actor then surfaces the policy error, proving the gates are
    // ordered quorum-first, policy-second.
    quorum.approve(SIGNERS[4]);
    assert.equal(quorum.hasQuorum(), true);
    assert.throws(
      () =>
        dispatchArbitration(escrow, quorum, "release", undefined, {
          actor: "creator",
        }),
      /actor not authorized for ARBITRATE_RELEASE: "creator" is not in \[moderator\]/
    );
    assert.equal(escrow.state, "DISPUTED");
    assert.equal(escrow.history.length, 2);
  });

  it("policy-rejected arbitration does not consume its idempotencyKey", () => {
    const escrow = disputedEscrow("arb-policy-idem", MODERATOR_POLICY);
    const quorum = quorumWith(5);

    assert.throws(
      () =>
        dispatchArbitration(escrow, quorum, "release", undefined, {
          actor: "creator",
          idempotencyKey: "arb-policy-1",
        }),
      /actor not authorized for ARBITRATE_RELEASE/
    );
    assert.equal(escrow.toJSON().idempotencyKeys, undefined);
    // Authorized retry with the same key executes (not a no-op).
    assert.equal(
      dispatchArbitration(escrow, quorum, "release", undefined, {
        actor: "moderator",
        idempotencyKey: "arb-policy-1",
      }),
      "RELEASED"
    );
    assert.equal(escrow.history.length, 3);
    // And a repeat of the now-consumed key is a pure no-op.
    assert.equal(
      dispatchArbitration(escrow, quorum, "release", undefined, {
        actor: "moderator",
        idempotencyKey: "arb-policy-1",
      }),
      "RELEASED"
    );
    assert.equal(escrow.history.length, 3);
  });

  it("expectedSeq forwarding is unaffected by policy: policy rejection leaves the seq for the retry", () => {
    const escrow = disputedEscrow("arb-policy-seq", MODERATOR_POLICY);
    const quorum = quorumWith(5);

    // Unauthorized attempt pins the read seq (2) but is policy-rejected.
    assert.throws(
      () =>
        dispatchArbitration(escrow, quorum, "release", undefined, {
          actor: "creator",
          expectedSeq: 2,
        }),
      /actor not authorized for ARBITRATE_RELEASE/
    );
    assert.equal(escrow.history.length, 2);
    // The seq is untouched, so the authorized retry with the same
    // pinned seq succeeds.
    assert.equal(
      dispatchArbitration(escrow, quorum, "release", undefined, {
        actor: "moderator",
        expectedSeq: 2,
      }),
      "RELEASED"
    );
    assert.equal(escrow.history.length, 3);
  });

  it("stale expectedSeq conflicts before policy is consulted", () => {
    // The seq guard runs first inside dispatch, so even an authorized
    // actor with a stale seq gets the conflict, and an unauthorized
    // actor with a stale seq gets the conflict too — not the policy
    // error. Neither rejection mutates anything.
    const escrow = disputedEscrow("arb-policy-stale", MODERATOR_POLICY);
    const quorum = quorumWith(5);

    assert.throws(
      () =>
        dispatchArbitration(escrow, quorum, "release", undefined, {
          actor: "moderator",
          expectedSeq: 99,
        }),
      /dispatch conflict: expected seq 99 but escrow is at seq 2/
    );
    assert.throws(
      () =>
        dispatchArbitration(escrow, quorum, "release", undefined, {
          actor: "creator",
          expectedSeq: 99,
        }),
      /dispatch conflict: expected seq 99 but escrow is at seq 2/
    );
    assert.equal(escrow.state, "DISPUTED");
    assert.equal(escrow.history.length, 2);
  });
});
