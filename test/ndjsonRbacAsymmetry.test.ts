import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  historyFromNdjson,
  historyToNdjson,
} from "../src/index.js";
import type { RolePolicy } from "../src/index.js";

/**
 * NDJSON vs snapshot RBAC recovery asymmetry (backlog #770).
 *
 * The audit log is not a snapshot: `src/ndjson.ts` documents that it
 * carries no escrow id and no configuration — deadline, idempotency
 * keys, and RBAC policy live in the snapshot envelope
 * (toJSON()/fromJSON()), not in the history. So:
 *
 * - an escrow restored from its JSON snapshot keeps its rolePolicy,
 *   and a non-listed actor is still refused the gated arbitration
 *   event;
 * - an escrow restored from NDJSON history alone via fromHistory()
 *   WITHOUT re-attaching a policy is unrestricted, even though the
 *   original escrow was gated — the log cannot restore what it never
 *   carried. Anyone treating NDJSON as a policy-restore channel would
 *   silently drop the gate, so this asymmetry is pinned explicitly;
 * - re-attaching the same policy via fromHistory(id, history,
 *   { rolePolicy }) gates again, proving the asymmetry is about the
 *   channel, not about fromHistory() being unable to carry a policy.
 *
 * This is the escrow mirror of the dataquest lifecycle's #764 test:
 * same four cases, same assertions, adapted to escrow's FUND/DISPUTE
 * path to DISPUTED and its ARBITRATE_RELEASE/ARBITRATE_REFUND events.
 */

const ARBITRATION_POLICY: RolePolicy = {
  ARBITRATE_RELEASE: ["dao-arbitrator"],
  ARBITRATE_REFUND: ["dao-arbitrator"],
};

/** Drive a fresh policy-gated escrow to DISPUTED without naming actors. */
function disputedEscrow(id: string): Escrow {
  const escrow = new Escrow(id, { rolePolicy: ARBITRATION_POLICY });
  escrow.dispatch("FUND", "initial deposit", 1000);
  escrow.dispatch("DISPUTE", "creator disputes");
  assert.equal(escrow.state, "DISPUTED");
  return escrow;
}

describe("NDJSON x snapshot RBAC recovery asymmetry", () => {
  it("JSON snapshot round-trip preserves the policy", () => {
    const escrow = disputedEscrow("ndjson-rbac-snap");
    const snapshot = escrow.toJSON();
    assert.deepEqual(snapshot.rolePolicy, ARBITRATION_POLICY);

    const restored = Escrow.fromJSON(
      JSON.parse(JSON.stringify(snapshot)),
    );
    assert.equal(restored.state, "DISPUTED");
    assert.deepEqual(restored.toJSON(), snapshot);

    assert.throws(
      () =>
        restored.dispatch("ARBITRATE_RELEASE", undefined, undefined, {
          actor: "creator",
        }),
      /actor not authorized for ARBITRATE_RELEASE: "creator" is not in \[dao-arbitrator\]/,
    );
    assert.equal(restored.state, "DISPUTED");
    assert.equal(restored.history.length, escrow.history.length);
    assert.equal(
      restored.dispatch("ARBITRATE_RELEASE", undefined, undefined, {
        actor: "dao-arbitrator",
      }),
      "RELEASED",
    );
  });

  it("NDJSON history alone restores state and history but NOT the policy", () => {
    const escrow = disputedEscrow("ndjson-rbac-log");
    const text = historyToNdjson(escrow);
    // The gate itself never enters the log: no policy field, no
    // arbitrator name anywhere in the NDJSON text.
    assert.ok(!text.includes("rolePolicy"));
    assert.ok(!text.includes("dao-arbitrator"));

    const restored = Escrow.fromHistory(
      "ndjson-rbac-log-restored",
      historyFromNdjson(text),
    );
    assert.equal(restored.state, "DISPUTED");
    assert.deepEqual(restored.history, escrow.history);

    // Unrestricted by design: the creator the original escrow would
    // have refused now arbitrates successfully, with no actor needed
    // at all. This is the asymmetry, pinned, not a bug to fix by
    // smuggling policy into the audit log.
    assert.equal(restored.dispatch("ARBITRATE_RELEASE"), "RELEASED");
    assert.equal(restored.history.length, escrow.history.length + 1);
    assert.equal(
      restored.history[restored.history.length - 1].seq,
      escrow.history.length + 1,
    );
  });

  it("NDJSON history with an explicitly re-attached policy gates again", () => {
    const escrow = disputedEscrow("ndjson-rbac-reattach");
    const text = historyToNdjson(escrow);

    const restored = Escrow.fromHistory(
      "ndjson-rbac-reattach-restored",
      historyFromNdjson(text),
      { rolePolicy: ARBITRATION_POLICY },
    );
    assert.equal(restored.state, "DISPUTED");

    assert.throws(
      () =>
        restored.dispatch("ARBITRATE_REFUND", undefined, undefined, {
          actor: "creator",
        }),
      /actor not authorized for ARBITRATE_REFUND/,
    );
    assert.equal(restored.state, "DISPUTED");
    assert.equal(
      restored.dispatch("ARBITRATE_REFUND", undefined, undefined, {
        actor: "dao-arbitrator",
      }),
      "REFUNDED",
    );
  });

  it("the original escrow is still gated before any export", () => {
    const escrow = disputedEscrow("ndjson-rbac-original");
    assert.throws(
      () =>
        escrow.dispatch("ARBITRATE_RELEASE", undefined, undefined, {
          actor: "creator",
        }),
      /actor not authorized for ARBITRATE_RELEASE/,
    );
    assert.equal(escrow.state, "DISPUTED");
  });
});
