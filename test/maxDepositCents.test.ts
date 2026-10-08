/**
 * Cent-precision maxDeposit tests for Escrow.
 *
 * The deposit cap check compares at cent precision (round2 on both sides),
 * matching the settlement-report comparison semantics (#69): raw float
 * addition can be off by an ulp — e.g. locked 0.2 + new FUND 0.1 sums to
 * 0.30000000000000004 while the cap is exactly 0.3 — and a raw `>` would
 * reject a legitimate funding sitting exactly on the cap.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Escrow } from "../src/stateMachine.js";

describe("EscrowOptions.maxDeposit cent-precision comparison", () => {
  it("0.2 locked + 0.1 top-up vs 0.3 cap is allowed (float dust absorbed)", () => {
    const escrow = new Escrow("e-cap-cents-1", { maxDeposit: 0.3 });
    escrow.dispatch("FUND", "initial", 0.2);
    // Raw float sum is 0.30000000000000004 > 0.3 — the old comparison
    // would have rejected this legitimate top-up.
    assert.equal(escrow.dispatch("FUND", "top-up", 0.1), "FUNDED");
    assert.equal(escrow.history.length, 2);
    assert.equal(escrow.history[1].seq, 2);
  });

  it("a single FUND of exactly 0.3 against a 0.3 cap is allowed", () => {
    const escrow = new Escrow("e-cap-cents-2", { maxDeposit: 0.3 });
    assert.equal(escrow.dispatch("FUND", "exact", 0.3), "FUNDED");
    assert.equal(escrow.history.length, 1);
  });

  it("a real one-cent overage (0.31 vs 0.3) is still rejected", () => {
    const escrow = new Escrow("e-cap-cents-3", { maxDeposit: 0.3 });
    escrow.dispatch("FUND", "initial", 0.2);
    assert.throws(
      () => escrow.dispatch("FUND", "over", 0.11),
      /deposit cap exceeded/
    );
  });

  it("sub-cent dust below the cap is absorbed, not rejected", () => {
    const escrow = new Escrow("e-cap-cents-4", { maxDeposit: 0.3 });
    // round2(0.301) = 0.3, not above round2(0.3): within the cap.
    assert.equal(escrow.dispatch("FUND", "dust", 0.301), "FUNDED");
    assert.equal(escrow.history.length, 1);
  });

  it("0.2 + 0.1001 (= 0.3001) vs a 0.3 cap is allowed: cent precision rounds it to 0.30", () => {
    // Under the cent-precision money model, 0.3001 rounds to 0.30 — not
    // above the cap. The cap check sees cents, not raw floats.
    const escrow = new Escrow("e-cap-cents-5", { maxDeposit: 0.3 });
    escrow.dispatch("FUND", "initial", 0.2);
    assert.equal(escrow.dispatch("FUND", "barely over in raw floats", 0.1001), "FUNDED");
    assert.equal(escrow.history.length, 2);
  });

  it("a true cent-level overage (total 0.31 vs 0.3 cap) is rejected", () => {
    const escrow = new Escrow("e-cap-cents-5b", { maxDeposit: 0.3 });
    escrow.dispatch("FUND", "initial", 0.2);
    // round2(0.2 + 0.11) = round2(0.31) = 0.31 > 0.30: genuinely over.
    assert.throws(
      () => escrow.dispatch("FUND", "over", 0.11),
      /deposit cap exceeded/
    );
  });

  it("rejected FUND leaves no history residue and keeps the error shape", () => {
    const escrow = new Escrow("e-cap-cents-6", { maxDeposit: 0.3 });
    escrow.dispatch("FUND", "initial", 0.2);
    assert.throws(
      () => escrow.dispatch("FUND", "over", 0.11),
      /deposit cap exceeded: locked 0\.2 \+ new funding 0\.11 would exceed maxDeposit 0\.3/
    );
    assert.equal(escrow.state, "FUNDED");
    assert.equal(escrow.history.length, 1);
    // Recovery: a legal top-up appends cleanly with no seq gap.
    assert.equal(escrow.dispatch("FUND", "legal top-up", 0.1), "FUNDED");
    assert.equal(escrow.history.length, 2);
    assert.equal(escrow.history[1].seq, 2);
  });

  it("float-dusty cap values themselves are compared at cent precision", () => {
    // A caller passing the float-arithmetic result 0.1+0.2 as the cap
    // gets the same cent-rounded cap as 0.3.
    const escrow = new Escrow("e-cap-cents-7", { maxDeposit: 0.1 + 0.2 });
    escrow.dispatch("FUND", "initial", 0.2);
    assert.equal(escrow.dispatch("FUND", "top-up", 0.1), "FUNDED");
  });
});
