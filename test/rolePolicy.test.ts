import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Escrow, verifyHistoryChain } from "../src/stateMachine.js";
import type { RolePolicy } from "../src/stateMachine.js";

/**
 * Event-level RBAC (EscrowOptions.rolePolicy) — backlog #141.
 *
 * A policy maps events to the actor names allowed to dispatch them.
 * Events the policy does not cover are unrestricted; an escrow built
 * without a policy behaves exactly as before (no actor needed
 * anywhere). Violations throw `actor not authorized for …` and leave
 * no trace: no state change, no history append, no idempotency-key
 * consumption. This mirrors the dataquest lifecycle's RBAC semantics.
 *
 * Honest limit (asserted in docs, not code): the policy is a
 * caller-supplied allowlist, NOT identity authentication — the
 * caller asserts the actor string and nothing verifies who they are.
 */

/** Drive a fresh escrow to VERIFIED (RELEASE is legal from there). */
function toVerified(escrow: Escrow): void {
  escrow.dispatch("FUND", "initial deposit", 1000);
  escrow.dispatch("SUBMIT_MILESTONE", "milestone delivered");
  escrow.dispatch("VERIFY_PASS", "KPIs validated");
}

/** Drive a fresh escrow to DISPUTED (arbitration is legal from there). */
function toDisputed(escrow: Escrow): void {
  escrow.dispatch("FUND", "initial deposit", 1000);
  escrow.dispatch("DISPUTE", "creator disputes");
}

describe("RBAC: allowlisted actors can dispatch gated events", () => {
  it("(1) allowlisted actor can dispatch RELEASE successfully", () => {
    const escrow = new Escrow("rbac-release-ok", {
      rolePolicy: { RELEASE: ["treasury", "dao-admin"] },
    });
    toVerified(escrow);
    assert.equal(
      escrow.dispatch("RELEASE", undefined, undefined, { actor: "treasury" }),
      "RELEASED"
    );
    assert.equal(escrow.state, "RELEASED");
  });

  it("(1) allowlisted actor can dispatch ARBITRATE_RELEASE successfully", () => {
    const escrow = new Escrow("rbac-arb-ok", {
      rolePolicy: {
        ARBITRATE_RELEASE: ["dao-arbitrator"],
        ARBITRATE_REFUND: ["dao-arbitrator"],
      },
    });
    toDisputed(escrow);
    assert.equal(
      escrow.dispatch("ARBITRATE_RELEASE", undefined, undefined, {
        actor: "dao-arbitrator",
      }),
      "RELEASED"
    );
  });

  it("matches actor names exactly (case-sensitive)", () => {
    const escrow = new Escrow("rbac-case", {
      rolePolicy: { RELEASE: ["treasury"] },
    });
    toVerified(escrow);
    assert.throws(
      () =>
        escrow.dispatch("RELEASE", undefined, undefined, { actor: "Treasury" }),
      /actor not authorized for RELEASE/
    );
    assert.equal(escrow.state, "VERIFIED");
  });
});

describe("RBAC: unauthorized dispatches are rejected cleanly", () => {
  it("(2) non-allowlisted actor dispatching RELEASE throws and leaves state/history/idempotency unchanged", () => {
    const escrow = new Escrow("rbac-release-no", {
      rolePolicy: { RELEASE: ["treasury"] },
    });
    toVerified(escrow);
    const historyBefore = escrow.history.length;
    assert.throws(
      () =>
        escrow.dispatch("RELEASE", undefined, undefined, {
          actor: "creator",
          idempotencyKey: "release-attempt-1",
        }),
      /actor not authorized for RELEASE: "creator" is not in \[treasury\]/
    );
    assert.equal(escrow.state, "VERIFIED");
    assert.equal(escrow.history.length, historyBefore);
    // The failed dispatch consumed no idempotency key: the snapshot
    // carries no key set for it.
    const snap = escrow.toJSON();
    assert.equal(snap.idempotencyKeys, undefined);
    // And the escrow is still usable by the authorized actor.
    assert.equal(
      escrow.dispatch("RELEASE", undefined, undefined, { actor: "treasury" }),
      "RELEASED"
    );
  });

  it("(3) policy present + missing actor throws", () => {
    const escrow = new Escrow("rbac-anon", {
      rolePolicy: { RELEASE: ["treasury"] },
    });
    toVerified(escrow);
    assert.throws(
      () => escrow.dispatch("RELEASE"),
      /actor not authorized for RELEASE: policy requires an actor in \[treasury\]/
    );
    assert.equal(escrow.state, "VERIFIED");
    assert.equal(escrow.history.length, 3);
  });

  it("(8) RBAC-rejected dispatch does not consume its idempotency key (retry with authorized actor + same key succeeds)", () => {
    const escrow = new Escrow("rbac-idem-retry", {
      rolePolicy: { RELEASE: ["treasury"] },
    });
    toVerified(escrow);
    assert.throws(
      () =>
        escrow.dispatch("RELEASE", undefined, undefined, {
          actor: "creator",
          idempotencyKey: "release-key-1",
        }),
      /actor not authorized for RELEASE/
    );
    // Same key, authorized actor: must execute, not be treated as a
    // duplicate no-op.
    assert.equal(
      escrow.dispatch("RELEASE", undefined, undefined, {
        actor: "treasury",
        idempotencyKey: "release-key-1",
      }),
      "RELEASED"
    );
    assert.equal(escrow.history.length, 4);
    // Now the key IS consumed: replaying it is a duplicate no-op.
    assert.equal(
      escrow.dispatch("RELEASE", undefined, undefined, {
        actor: "treasury",
        idempotencyKey: "release-key-1",
      }),
      "RELEASED"
    );
    assert.equal(escrow.history.length, 4);
  });

  it("ordering: a duplicate idempotency key is a no-op before the RBAC check (mirrors dataquest)", () => {
    const escrow = new Escrow("rbac-idem-order", {
      rolePolicy: { FUND: ["sponsor"] },
    });
    escrow.dispatch("FUND", "initial", 500, {
      actor: "sponsor",
      idempotencyKey: "fund-key-1",
    });
    // Same key, wrong actor: the dedup runs first, so this is the
    // documented duplicate no-op, not an RBAC rejection.
    assert.equal(
      escrow.dispatch("FUND", "initial", 500, {
        actor: "intruder",
        idempotencyKey: "fund-key-1",
      }),
      "FUNDED"
    );
    assert.equal(escrow.history.length, 1);
  });
});

describe("RBAC: partial policies only gate the listed events", () => {
  it("(4) unlisted events work with any actor and with no actor", () => {
    const escrow = new Escrow("rbac-partial", {
      rolePolicy: { ARBITRATE_RELEASE: ["dao-arbitrator"] },
    });
    // FUND / DISPUTE are not in the policy: no actor needed at all.
    assert.equal(escrow.dispatch("FUND", "initial", 1000), "FUNDED");
    assert.equal(
      escrow.dispatch("DISPUTE", undefined, undefined, { actor: "anyone" }),
      "DISPUTED"
    );
    // The listed event is still gated.
    assert.throws(
      () =>
        escrow.dispatch("ARBITRATE_RELEASE", undefined, undefined, {
          actor: "anyone",
        }),
      /actor not authorized for ARBITRATE_RELEASE/
    );
  });

  it("(7) no policy → existing behavior unchanged (explicit case)", () => {
    const escrow = new Escrow("rbac-nopolicy");
    toVerified(escrow);
    // No actor anywhere, exactly the pre-RBAC flow.
    assert.equal(escrow.dispatch("RELEASE"), "RELEASED");
    const disputed = new Escrow("rbac-nopolicy-arb");
    toDisputed(disputed);
    assert.equal(disputed.dispatch("ARBITRATE_REFUND"), "REFUNDED");
  });
});

describe("RBAC: invalid policies are rejected fail-fast at construction", () => {
  const bad: Array<[string, RolePolicy]> = [
    ["unknown event", { FLY: ["pilot"] } as unknown as RolePolicy],
    ["empty actor string in allowlist", { RELEASE: [""] }],
    ["non-array value", { RELEASE: "treasury" } as unknown as RolePolicy],
    ["empty array", { RELEASE: [] }],
    ["non-string role", { RELEASE: [42] } as unknown as RolePolicy],
  ];
  for (const [name, policy] of bad) {
    it(`(5) constructor rejects ${name}`, () => {
      assert.throws(
        () => new Escrow("rbac-bad", { rolePolicy: policy }),
        /invalid option: rolePolicy/
      );
    });
  }

  it("(5) constructor rejects a non-object policy", () => {
    assert.throws(
      () =>
        new Escrow("rbac-bad-obj", {
          rolePolicy: "treasury" as unknown as RolePolicy,
        }),
      /invalid option: rolePolicy must be an object/
    );
  });

  it("duplicate roles are deduped, not rejected", () => {
    const escrow = new Escrow("rbac-dedupe", {
      rolePolicy: { RELEASE: ["treasury", "treasury"] },
    });
    toVerified(escrow);
    assert.equal(
      escrow.dispatch("RELEASE", undefined, undefined, { actor: "treasury" }),
      "RELEASED"
    );
    // The snapshot shows the deduped policy.
    const withPolicy = new Escrow("rbac-dedupe-snap", {
      rolePolicy: { RELEASE: ["treasury", "treasury"] },
    });
    assert.deepEqual(withPolicy.toJSON().rolePolicy, {
      RELEASE: ["treasury"],
    });
  });
});

describe("RBAC: actor validation and audit recording", () => {
  it("empty-string actor throws invalid dispatch options and leaves no residue", () => {
    const escrow = new Escrow("rbac-empty-actor", {
      rolePolicy: { RELEASE: ["treasury"] },
    });
    toVerified(escrow);
    assert.throws(
      () =>
        escrow.dispatch("RELEASE", undefined, undefined, { actor: "" }),
      /invalid dispatch options: actor must be a non-empty string, got ""/
    );
    assert.equal(escrow.state, "VERIFIED");
    assert.equal(escrow.history.length, 3);
  });

  it("non-string actor throws invalid dispatch options", () => {
    const escrow = new Escrow("rbac-nonstr-actor");
    assert.throws(
      () =>
        escrow.dispatch("FUND", undefined, 100, {
          actor: 42 as unknown as string,
        }),
      /invalid dispatch options: actor must be a non-empty string/
    );
    assert.equal(escrow.history.length, 0);
  });

  it("actor is recorded on the history entry and covered by the hash chain", () => {
    const escrow = new Escrow("rbac-audit", {
      rolePolicy: { RELEASE: ["treasury"] },
    });
    toVerified(escrow);
    escrow.dispatch("RELEASE", undefined, undefined, { actor: "treasury" });
    const last = escrow.history[escrow.history.length - 1];
    assert.equal(last.actor, "treasury");
    // Entries dispatched without an actor carry no actor field.
    assert.equal(escrow.history[0].actor, undefined);
    assert.equal(verifyHistoryChain(escrow.history), true);
    // Tampering with a persisted actor breaks the chain.
    const tampered = JSON.parse(JSON.stringify(escrow.history));
    tampered[tampered.length - 1].actor = "intruder";
    assert.equal(verifyHistoryChain(tampered), false);
    // The actor survives a snapshot round-trip.
    const restored = Escrow.fromJSON(
      JSON.parse(JSON.stringify(escrow.toJSON()))
    );
    assert.equal(
      restored.history[restored.history.length - 1].actor,
      "treasury"
    );
    assert.equal(verifyHistoryChain(restored.history), true);
  });

  it("legacy hashless snapshot without actor restores gracefully and is chained on rehydration", () => {
    const restored = Escrow.fromJSON({
      id: "rbac-legacy",
      state: "FUNDED",
      history: [
        {
          seq: 1,
          event: "FUND",
          from: "CREATED",
          to: "FUNDED",
          at: "2026-03-01T00:00:00.000Z",
          amount: 500,
        },
      ],
    });
    assert.equal(restored.state, "FUNDED");
    assert.equal(restored.history[0].actor, undefined);
    assert.equal(verifyHistoryChain(restored.history), true);
  });

  it("snapshot parser rejects an empty-string actor on a history entry", () => {
    const escrow = new Escrow("rbac-snap-actor");
    escrow.dispatch("FUND", "initial", 100, { actor: "sponsor" });
    const snap = JSON.parse(JSON.stringify(escrow.toJSON()));
    snap.history[0].actor = "";
    // Rewriting the actor also breaks the hash, but the actor shape
    // check runs during structural parsing, before chain verification.
    assert.throws(
      () => Escrow.fromJSON(snap),
      /invalid snapshot: history\[0\]: actor must be a non-empty string/
    );
  });
});

describe("RBAC: persistence round-trips", () => {
  const policy: RolePolicy = {
    RELEASE: ["treasury"],
    ARBITRATE_RELEASE: ["dao-arbitrator"],
  };

  it("(6) policy survives toJSON/fromJSON round-trip and is still enforced after restore", () => {
    const escrow = new Escrow("rbac-rt", { rolePolicy: policy });
    toVerified(escrow);
    const json = JSON.parse(JSON.stringify(escrow.toJSON()));
    assert.deepEqual(json.rolePolicy, policy);
    const restored = Escrow.fromJSON(json);
    assert.throws(
      () =>
        restored.dispatch("RELEASE", undefined, undefined, {
          actor: "creator",
        }),
      /actor not authorized for RELEASE/
    );
    assert.throws(
      () => restored.dispatch("RELEASE"),
      /actor not authorized for RELEASE: policy requires an actor/
    );
    assert.equal(
      restored.dispatch("RELEASE", undefined, undefined, {
        actor: "treasury",
      }),
      "RELEASED"
    );
    // The restored escrow's own snapshot still carries the policy.
    assert.deepEqual(restored.toJSON().rolePolicy, policy);
  });

  it("a snapshot without rolePolicy rehydrates unrestricted and writes no rolePolicy field", () => {
    const escrow = new Escrow("rbac-rt-free");
    toDisputed(escrow);
    const snap = escrow.toJSON();
    assert.equal(snap.rolePolicy, undefined);
    assert.ok(!("rolePolicy" in JSON.parse(JSON.stringify(snap))));
    const restored = Escrow.fromJSON(JSON.parse(JSON.stringify(snap)));
    assert.equal(restored.dispatch("ARBITRATE_RELEASE"), "RELEASED");
  });

  it("fromJSON rejects a tampered policy in a stored snapshot", () => {
    const escrow = new Escrow("rbac-rt-tamper", { rolePolicy: policy });
    const json = JSON.parse(JSON.stringify(escrow.toJSON()));
    json.rolePolicy = { RELEASE: [] }; // tampered: empty allowlist
    assert.throws(
      () => Escrow.fromJSON(json),
      /invalid snapshot: rolePolicy\[RELEASE\] must be a non-empty array/
    );
    const json2 = JSON.parse(JSON.stringify(escrow.toJSON()));
    json2.rolePolicy = { PAY_OUT: ["treasury"] }; // tampered: unknown event
    assert.throws(
      () => Escrow.fromJSON(json2),
      /invalid snapshot: rolePolicy has unknown event PAY_OUT/
    );
  });

  it("fromJSON opts.rolePolicy overrides the snapshot policy entirely (no merging)", () => {
    const escrow = new Escrow("rbac-override", { rolePolicy: policy });
    toVerified(escrow);
    const snap = JSON.parse(JSON.stringify(escrow.toJSON()));
    // Override with a different allowlist: the snapshot's actor no
    // longer works, the override's actor does.
    const overridden = Escrow.fromJSON(snap, {
      rolePolicy: { RELEASE: ["new-treasury"] },
    });
    assert.throws(
      () =>
        overridden.dispatch("RELEASE", undefined, undefined, {
          actor: "treasury",
        }),
      /actor not authorized for RELEASE/
    );
    assert.equal(
      overridden.dispatch("RELEASE", undefined, undefined, {
        actor: "new-treasury",
      }),
      "RELEASED"
    );
    // Override with an empty policy clears enforcement entirely.
    const cleared = Escrow.fromJSON(snap, { rolePolicy: {} });
    assert.equal(cleared.dispatch("RELEASE"), "RELEASED");
    assert.equal(cleared.toJSON().rolePolicy, undefined);
  });
});
