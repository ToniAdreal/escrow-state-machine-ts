import test from "node:test";
import assert from "node:assert/strict";
import { settleRelease } from "../src/index.js";

test("gross 1e308 with proFeeBps 0 overflows the net to Infinity and throws instead of returning it", () => {
  assert.throws(
    () => settleRelease({ gross: 1e308, proFeeBps: 0 }),
    /settlement computation overflowed: inputs too large/,
  );
});

test("gross 1e308 with proFeeBps 500 throws the overflow error, not the misleading net-negative error", () => {
  assert.throws(
    () => settleRelease({ gross: 1e308, proFeeBps: 500 }),
    /settlement computation overflowed: inputs too large/,
  );
});

test("gross 1e308 with proFeeBps 10000 throws the overflow error, not the misleading net-negative error", () => {
  assert.throws(
    () => settleRelease({ gross: 1e308, proFeeBps: 10000 }),
    /settlement computation overflowed: inputs too large/,
  );
});

test("golden vector is unchanged: gross 10630 at 500bps splits to proFee 531.5 and net 10098.5", () => {
  const r = settleRelease({ gross: 10630, proFeeBps: 500 });
  assert.equal(r.proFee, 531.5);
  assert.equal(r.net, 10098.5);
  assert.equal(r.gross, 10630);
  assert.equal(r.referralCredits, 0);
});

test("a 1e15-scale gross is large but finite and still accepted", () => {
  const r = settleRelease({ gross: 1e15, proFeeBps: 500 });
  assert.ok(Number.isFinite(r.proFee));
  assert.ok(Number.isFinite(r.net));
  assert.ok(r.net > 0);
});

test("a 1e306 gross stays finite through round2 and is still accepted", () => {
  const r = settleRelease({ gross: 1e306, proFeeBps: 0 });
  assert.ok(Number.isFinite(r.net));
  assert.equal(r.net, 1e306);
});

test("the overflow error is exact and no partial settlement escapes", () => {
  let result: unknown;
  let thrown: unknown;
  try {
    result = settleRelease({ gross: 1e308, proFeeBps: 0 });
  } catch (err) {
    thrown = err;
  }
  assert.equal(result, undefined);
  assert.ok(thrown instanceof Error);
  assert.equal(thrown.message, "settlement computation overflowed: inputs too large");
});

test("a finite negative net still takes the negative route, not the overflow route", () => {
  // Keeps the two guards distinct: finite negative net -> "would be
  // negative"; non-finite result -> "overflowed".
  assert.throws(
    () => settleRelease({ gross: 1000, proFeeBps: 500, referralCredits: 1000 }),
    /net payout would be negative/,
  );
});
