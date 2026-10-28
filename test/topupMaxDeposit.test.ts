/**
 * Top-up x maxDeposit combination tests (backlog #682).
 *
 * Each dimension already has its own suite — `topup.test.ts` pins the
 * FUND self-loop on FUNDED, `maxDeposit.test.ts` pins the cap — but the
 * two were never exercised together at a realistic scale, and one order
 * was never pinned at all: a top-up that is rejected for exceeding the
 * cap, followed by a recovery top-up that lands exactly on the cap.
 * (`maxDeposit.test.ts` reaches the cap first and only then rejects;
 * it never rejects first and then recovers to exactly the cap.)
 *
 * The cap is cumulative: it compares the locked total (the sum of every
 * FUND amount in the audit history) plus the new funding against
 * `maxDeposit`, so a top-up is judged on the running total, not on its
 * own size. A rejected top-up must leave no history residue and must
 * not consume a sequence number.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Escrow, depositAmountFromHistory } from "../src/index.js";

function cappedAt10000Funded9000(): Escrow {
  const escrow = new Escrow("esc-cap-topup", { maxDeposit: 10000 });
  escrow.dispatch("FUND", "initial wire", 9000);
  return escrow;
}

describe("top-up x maxDeposit combination", () => {
  it("over-cap top-up is rejected verbatim with no locked/history residue", () => {
    const escrow = cappedAt10000Funded9000();
    assert.throws(
      () => escrow.dispatch("FUND", "top-up wire", 2000),
      /deposit cap exceeded: locked 9000 \+ new funding 2000 would exceed maxDeposit 10000/,
    );
    // The failed dispatch is invisible: same state, same single entry,
    // same locked total read back from the audit trail.
    assert.equal(escrow.state, "FUNDED");
    assert.equal(escrow.history.length, 1);
    assert.equal(escrow.history[0].seq, 1);
    assert.equal(escrow.history[0].amount, 9000);
    assert.equal(depositAmountFromHistory(escrow.history, escrow.id), 9000);
  });

  it("exact-cap top-up recovers cleanly after an over-cap rejection", () => {
    const escrow = cappedAt10000Funded9000();
    assert.throws(
      () => escrow.dispatch("FUND", "too much", 2000),
      /deposit cap exceeded/,
    );
    // Recovery: a top-up landing exactly on the cap passes, and the
    // rejected attempt did not consume a sequence number.
    assert.equal(escrow.dispatch("FUND", "top-up to the cap", 1000), "FUNDED");
    assert.equal(escrow.history.length, 2);
    assert.deepEqual(
      escrow.history.map((h) => h.seq),
      [1, 2],
    );
    const topUp = escrow.history[1];
    assert.equal(topUp.event, "FUND");
    assert.equal(topUp.from, "FUNDED");
    assert.equal(topUp.to, "FUNDED");
    assert.equal(topUp.amount, 1000);
    assert.equal(depositAmountFromHistory(escrow.history, escrow.id), 10000);
  });

  it("once at the cap, any further positive top-up is rejected", () => {
    const escrow = cappedAt10000Funded9000();
    escrow.dispatch("FUND", "top-up to the cap", 1000);
    assert.equal(depositAmountFromHistory(escrow.history, escrow.id), 10000);
    assert.throws(
      () => escrow.dispatch("FUND", "one more", 1),
      /deposit cap exceeded: locked 10000 \+ new funding 1 would exceed maxDeposit 10000/,
    );
    assert.equal(escrow.history.length, 2);
    assert.equal(depositAmountFromHistory(escrow.history, escrow.id), 10000);
  });

  it("cap is cumulative across several top-ups, not per-dispatch", () => {
    const escrow = new Escrow("esc-cap-multi", { maxDeposit: 10000 });
    escrow.dispatch("FUND", "initial", 5000);
    escrow.dispatch("FUND", "first top-up", 3000);
    // 5000 + 3000 = 8000 locked; a 3000 top-up would breach the cap
    // even though 3000 alone is far below it.
    assert.throws(
      () => escrow.dispatch("FUND", "too much", 3000),
      /deposit cap exceeded: locked 8000 \+ new funding 3000 would exceed maxDeposit 10000/,
    );
    assert.equal(escrow.history.length, 2);
    // The remaining headroom (2000) tops up exactly to the cap.
    escrow.dispatch("FUND", "final top-up", 2000);
    assert.equal(depositAmountFromHistory(escrow.history, escrow.id), 10000);
  });
});
