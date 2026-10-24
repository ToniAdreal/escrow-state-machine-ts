import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  depositAmountFromHistory,
  verifyHistoryChain,
} from "../src/index.js";

/**
 * #542: dispatch("FUND", …, amount) used to record the raw caller value
 * verbatim — a 10.005 FUND landed sub-cent in the audit trail and poisoned
 * totalFundedAmount's sum, while the README FAQ claimed "all amounts are
 * rounded to cents". dispatch now normalizes FUND amounts with round2
 * (after assertNonNegativeMoney, before the deposit-cap check), so the
 * cap comparison, the recorded entry, and the settlement math all see the
 * same cent value. Parsers (fromJSON/fromHistory/NDJSON) still accept
 * legacy sub-cent snapshots without re-normalizing them.
 */

test("FUND 10.005 is recorded as 10.01 (half-up)", () => {
  const escrow = new Escrow("e-norm-1");
  escrow.dispatch("FUND", "half-up", 10.005);
  assert.equal(escrow.history[0].amount, 10.01);
});

test("FUND 10.004 is recorded as 10.00 (half-down)", () => {
  const escrow = new Escrow("e-norm-2");
  escrow.dispatch("FUND", "half-down", 10.004);
  assert.equal(escrow.history[0].amount, 10);
});

test("top-up sums stay cent-clean: no sub-cent residue leaks from entries", () => {
  const escrow = new Escrow("e-norm-3");
  escrow.dispatch("FUND", "first", 0.1);
  escrow.dispatch("FUND", "top-up", 0.2);
  const total = depositAmountFromHistory(escrow.history, "e-norm-3");
  // Binary float dust (0.1 + 0.2 = 0.30000000000000004) is inherent to
  // floats and outside the normalization scope — the money model absorbs
  // it at round2 comparison (#69). Normalization guarantees the recorded
  // entries are cent values, so the sum is cent-exact after one rounding.
  assert.equal(Math.round(total * 100) / 100, 0.3);
  assert.equal(escrow.history[0].amount, 0.1);
  assert.equal(escrow.history[1].amount, 0.2);
});

test("normalized amount feeds the deposit-cap check at cent precision", () => {
  const escrow = new Escrow("e-norm-4", { maxDeposit: 10000 });
  // 9999.996 normalizes to exactly 10000.00 — allowed, sitting on the cap.
  escrow.dispatch("FUND", "to the cap", 9999.996);
  assert.equal(escrow.history[0].amount, 10000);
  // One more half-cent normalizes to 0.01 and pushes the total over the cap.
  assert.throws(
    () => escrow.dispatch("FUND", "dust over the cap", 0.005),
    /deposit cap exceeded/,
  );
  assert.equal(escrow.history.length, 1); // rejection left no residue
});

test("hash chain stays valid across normalized FUND entries", () => {
  const escrow = new Escrow("e-norm-5");
  escrow.dispatch("FUND", "first", 0.1);
  escrow.dispatch("FUND", "top-up", 0.2);
  assert.equal(verifyHistoryChain(escrow.history), true);
});

test("invalid amounts are still rejected before any normalization", () => {
  const escrow = new Escrow("e-norm-6");
  assert.throws(
    () => escrow.dispatch("FUND", "negative", -1),
    /amount must be a finite non-negative number/,
  );
  assert.throws(
    () => escrow.dispatch("FUND", "nan", NaN),
    /amount must be a finite non-negative number/,
  );
  assert.equal(escrow.history.length, 0);
});

test("FUND without an amount is untouched by normalization", () => {
  const escrow = new Escrow("e-norm-7");
  escrow.dispatch("FUND", "amountless");
  assert.equal(escrow.history[0].amount, undefined);
});

test("legacy sub-cent snapshot is still accepted without re-normalization", () => {
  const legacy = Escrow.fromJSON({
    id: "e-norm-8",
    state: "FUNDED",
    history: [
      {
        seq: 1,
        event: "FUND",
        from: "CREATED",
        to: "FUNDED",
        at: "2026-10-24T00:00:00.000Z",
        note: "legacy sub-cent",
        amount: 10.005,
      },
    ],
  });
  assert.equal(legacy.history[0].amount, 10.005);
  // And a follow-up FUND on the restored escrow is normalized.
  legacy.dispatch("FUND", "new", 10.004);
  assert.equal(legacy.history[1].amount, 10);
});

test("idempotency dedupe on the same key is unchanged by normalization", () => {
  const escrow = new Escrow("e-norm-9");
  escrow.dispatch("FUND", "first", 10.005, { idempotencyKey: "k1" });
  assert.equal(
    escrow.dispatch("FUND", "duplicate", 10.009, { idempotencyKey: "k1" }),
    "FUNDED",
  );
  assert.equal(escrow.history.length, 1);
  assert.equal(escrow.history[0].amount, 10.01);
});

test("toJSON/fromJSON round-trips the normalized amount", () => {
  const escrow = new Escrow("e-norm-10");
  escrow.dispatch("FUND", "half-up", 10.005);
  const restored = Escrow.fromJSON(escrow.toJSON());
  assert.equal(restored.history[0].amount, 10.01);
});
