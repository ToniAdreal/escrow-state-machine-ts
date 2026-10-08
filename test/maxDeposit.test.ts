/**
 * maxDeposit tests for Escrow.
 *
 * Real escrow products cap the total locked deposit (risk control, contract
 * limits). EscrowOptions.maxDeposit adds that cap: a FUND dispatch whose
 * amount would push the locked total (sum of all FUND amounts) above the
 * cap throws and appends nothing — failed dispatches leave no audit
 * residue. The cap is per-instance constructor configuration, never part
 * of the JSON snapshot.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Escrow, EscrowOptions } from "../src/stateMachine.js";

describe("EscrowOptions.maxDeposit", () => {
  it("initial FUND above the cap throws with no history residue", () => {
    const escrow = new Escrow("e-cap-1", { maxDeposit: 1000 });
    assert.throws(
      () => escrow.dispatch("FUND", "too much", 1001),
      /deposit cap exceeded: locked 0 \+ new funding 1001 would exceed maxDeposit 1000/
    );
    assert.equal(escrow.state, "CREATED");
    assert.equal(escrow.history.length, 0);
    // Recovery: a FUND within the cap appends cleanly with seq 1.
    assert.equal(escrow.dispatch("FUND", "within cap", 1000), "FUNDED");
    assert.equal(escrow.history.length, 1);
    assert.equal(escrow.history[0].seq, 1);
    assert.equal(escrow.history[0].amount, 1000);
  });

  it("top-up that exactly reaches the cap is allowed; one cent more throws", () => {
    const escrow = new Escrow("e-cap-2", { maxDeposit: 1000 });
    escrow.dispatch("FUND", "initial", 700);
    escrow.dispatch("FUND", "top-up", 300); // 700 + 300 = 1000 exactly
    assert.equal(escrow.state, "FUNDED");
    assert.throws(
      () => escrow.dispatch("FUND", "over by a cent", 0.01),
      /deposit cap exceeded/
    );
    assert.equal(escrow.history.length, 2);
    // Error message shows the running locked total, not just the attempt.
    assert.throws(
      () => escrow.dispatch("FUND", "way over", 500),
      /locked 1000 \+ new funding 500/
    );
  });

  it("FUND without an amount carries no money and is never capped", () => {
    const escrow = new Escrow("e-cap-3", { maxDeposit: 1000 });
    escrow.dispatch("FUND", "initial", 1000); // locked total now exactly at cap
    // No amount: recorded entry, no cap trip.
    escrow.dispatch("FUND", "paperwork only");
    assert.equal(escrow.history.length, 2);
    assert.equal(escrow.history[1].amount, undefined);
    // And it contributes nothing to the locked total: a zero-value top-up
    // stays allowed even at the cap (0 + 1000 = 1000, not above).
    escrow.dispatch("FUND", "zero top-up", 0);
    assert.equal(escrow.history.length, 3);
  });

  it("amount validation still runs before the cap check", () => {
    const escrow = new Escrow("e-cap-4", { maxDeposit: 1000 });
    // Negative amount: amount validation fails first, not the cap.
    assert.throws(
      () => escrow.dispatch("FUND", "bad amount", -5),
      /amount must be a finite non-negative number/
    );
    assert.equal(escrow.history.length, 0);
  });

  it("transition validation runs before the cap check", () => {
    const escrow = new Escrow("e-cap-5", { maxDeposit: 1000 });
    escrow.dispatch("FUND", "initial", 1000);
    // RELEASE is invalid from FUNDED: invalid transition, not a cap error.
    assert.throws(
      () => escrow.dispatch("RELEASE"),
      /invalid transition: RELEASE from FUNDED/
    );
    assert.equal(escrow.history.length, 1);
    // A valid-transition FUND above the cap still trips the cap afterwards.
    assert.throws(
      () => escrow.dispatch("FUND", "over cap", 1),
      /deposit cap exceeded/
    );
  });

  it("constructor rejects illegal maxDeposit values", () => {
    const bad: unknown[] = [-1, NaN, Infinity, -Infinity, "1000", null, {}, []];
    for (const value of bad) {
      assert.throws(
        () => new Escrow("e-cap-bad", { maxDeposit: value as number }),
        /maxDeposit must be a finite non-negative number/,
        `maxDeposit=${String(value)} should throw`
      );
    }
    // maxDeposit: 0 is legal (allows only zero-amount FUNDs).
    const zero = new Escrow("e-cap-zero", { maxDeposit: 0 });
    assert.throws(() => zero.dispatch("FUND", "any money", 1), /deposit cap exceeded/);
    zero.dispatch("FUND", "zero", 0);
    assert.equal(zero.history.length, 1);
  });

  it("default (unset) maxDeposit leaves behavior unchanged", () => {
    const escrow = new Escrow("e-cap-6");
    escrow.dispatch("FUND", "initial", 100_000_000);
    escrow.dispatch("FUND", "big top-up", 999_999_999);
    assert.equal(escrow.history.length, 2);
    // Explicit undefined behaves like unset.
    const escrow2 = new Escrow("e-cap-6b", { maxDeposit: undefined });
    escrow2.dispatch("FUND", "initial", 5_000_000);
    assert.equal(escrow2.history.length, 1);
  });

  it("maxDeposit is not part of the JSON snapshot", () => {
    const opts: EscrowOptions = { maxDeposit: 1000, requireVerifyEvidence: true };
    const escrow = new Escrow("e-cap-7", opts);
    escrow.dispatch("FUND", "initial", 500);
    const snapshot = escrow.toJSON();
    assert.ok(!("maxDeposit" in snapshot));
    assert.ok(!JSON.stringify(snapshot).includes("maxDeposit"));
    // A restored escrow must re-enable the cap via the constructor option:
    // the snapshot round-trip loses it.
    const restored = Escrow.fromJSON(snapshot);
    restored.dispatch("FUND", "unlimited after restore", 999_999);
    assert.equal(restored.history.length, 2);
  });

  it("cap is enforced per escrow instance, not globally", () => {
    const a = new Escrow("e-cap-a", { maxDeposit: 100 });
    const b = new Escrow("e-cap-b", { maxDeposit: 100 });
    a.dispatch("FUND", "fills a", 100);
    b.dispatch("FUND", "small b", 1);
    assert.throws(() => a.dispatch("FUND", "over", 1), /deposit cap exceeded/);
    b.dispatch("FUND", "fills b", 99);
    assert.equal(b.history.length, 2);
  });

  it("failed FUND leaves no seq gap and does not consume an idempotency key", () => {
    const escrow = new Escrow("e-cap-8", { maxDeposit: 100 });
    escrow.dispatch("FUND", "initial", 100);
    const key = "retry-fund";
    // Capped-out dispatch with a key: the key is NOT recorded on failure.
    assert.throws(
      () => escrow.dispatch("FUND", "over", 50, { idempotencyKey: key }),
      /deposit cap exceeded/
    );
    assert.equal(escrow.history.length, 1);
    // The failed dispatch neither consumed the key nor left a seq gap:
    // retrying the same key with a legal amount appends at seq 2.
    assert.equal(
      escrow.dispatch("FUND", "zero top-up", 0, { idempotencyKey: key }),
      "FUNDED"
    );
    assert.equal(escrow.history.length, 2);
    assert.equal(escrow.history[1].seq, 2);
    // And a capped-out duplicate of the same key now returns the current
    // state as a no-op (the key IS recorded after the success above).
    assert.equal(escrow.dispatch("FUND", "over", 50, { idempotencyKey: key }), "FUNDED");
    assert.equal(escrow.history.length, 2);
  });
});
