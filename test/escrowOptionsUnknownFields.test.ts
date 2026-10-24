/**
 * Constructor `EscrowOptions` unknown-field fail-closed (#548).
 *
 * `new Escrow("x", { maxDepost: 100 })` (a typo'd `maxDeposit`) used to
 * be silently accepted, quietly disabling the deposit-cap risk control.
 * The snapshot parser got an unknown-field whitelist in #132, but the
 * constructor — the more dangerous side, since its options are live risk
 * controls (deposit cap, verify-evidence gate, audit key, RBAC) — had
 * none. Unknown option keys now throw
 * `invalid escrow options: unknown option "<name>"` before any field is
 * consumed. `Escrow.fromJSON(snapshot, opts)` routes its opts through the
 * same constructor, so the restore path gets the same protection.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Escrow } from "../src/stateMachine.js";

/** Minimal snapshot fixture for the fromJSON path. */
function bareSnapshot() {
  return { v: 1, id: "snap-1", state: "CREATED", history: [] };
}

describe("EscrowOptions unknown-field fail-closed", () => {
  it("accepts all four legal option fields together", () => {
    const escrow = new Escrow("ok-all", {
      requireVerifyEvidence: true,
      maxDeposit: 10000,
      auditKey: "k1",
      rolePolicy: { VERIFY_PASS: ["moderator"] },
    });
    assert.equal(escrow.id, "ok-all");
  });

  it("accepts each legal field in isolation", () => {
    new Escrow("ok-1", { requireVerifyEvidence: false });
    new Escrow("ok-2", { maxDeposit: 0 });
    new Escrow("ok-3", { auditKey: Buffer.from("k2") });
    new Escrow("ok-4", { rolePolicy: {} });
  });

  it("rejects a typo'd maxDeposit and names the field", () => {
    assert.throws(
      () => new Escrow("bad-1", { maxDepost: 100 } as never),
      /invalid escrow options: unknown option "maxDepost"/
    );
  });

  it("rejects case-variant misspellings (maxdeposit, MaxDeposit)", () => {
    assert.throws(
      () => new Escrow("bad-2", { maxdeposit: 100 } as never),
      /unknown option "maxdeposit"/
    );
    assert.throws(
      () => new Escrow("bad-3", { MaxDeposit: 100 } as never),
      /unknown option "MaxDeposit"/
    );
  });

  it("rejects unknown extras alongside legal fields, no instance produced", () => {
    let built: Escrow | undefined;
    assert.throws(() => {
      built = new Escrow("bad-4", {
        maxDeposit: 10000,
        depositCap: 10000,
      } as never);
    }, /unknown option "depositCap"/);
    assert.equal(built, undefined);
  });

  it("rejects trailing junk after all legal fields and with empty opts shape", () => {
    assert.throws(
      () =>
        new Escrow("bad-5", {
          requireVerifyEvidence: true,
          maxDeposit: 5000,
          auditKey: "k3",
          rolePolicy: {},
          debug: true,
        } as never),
      /unknown option "debug"/
    );
  });

  it("accepts an empty options object (all defaults)", () => {
    const escrow = new Escrow("ok-empty", {});
    assert.equal(escrow.id, "ok-empty");
  });

  it("rejects a typo'd option on the fromJSON restore path", () => {
    assert.throws(
      () => Escrow.fromJSON(bareSnapshot(), { maxDepost: 100 } as never),
      /invalid escrow options: unknown option "maxDepost"/
    );
  });

  it("fromJSON still accepts legal options (no behavior change on the restore path)", () => {
    const restored = Escrow.fromJSON(bareSnapshot(), {
      requireVerifyEvidence: true,
      maxDeposit: 9000,
    });
    assert.equal(restored.id, "snap-1");
    assert.equal(restored.state, "CREATED");
    // The re-enabled cap really enforces: FUND over it throws.
    restored.dispatch("FUND", "first", 9000);
    assert.throws(() => restored.dispatch("FUND", "over", 1), /deposit cap exceeded/);
  });

  it("still rejects non-object opts before the field scan", () => {
    assert.throws(
      () => new Escrow("bad-6", "opts" as never),
      /invalid escrow options: opts must be an object/
    );
    assert.throws(
      () => new Escrow("bad-7", ["maxDeposit"] as never),
      /invalid escrow options: opts must be an object/
    );
  });
});
