import test from "node:test";
import assert from "node:assert/strict";
import { settleRelease, settlePartialRelease } from "../src/index.js";

test("golden vector: gross 10630, released 5000 at 500bps fees only the released part", () => {
  const r = settlePartialRelease({ gross: 10630, released: 5000, proFeeBps: 500 });
  assert.equal(r.released, 5000);
  assert.equal(r.proFee, 250);
  assert.equal(r.referralCredits, 0);
  assert.equal(r.net, 4750);
  assert.equal(r.remaining, 5630);
});

test("golden vector with referral credits: credits come off the released net only", () => {
  const r = settlePartialRelease({ gross: 10630, released: 5000, proFeeBps: 500, referralCredits: 100 });
  assert.equal(r.proFee, 250);
  assert.equal(r.net, 4650);
  assert.equal(r.remaining, 5630);
});

test("released = gross matches settleRelease exactly, with remaining 0", () => {
  const partial = settlePartialRelease({ gross: 10630, released: 10630, proFeeBps: 500, referralCredits: 50 });
  const full = settleRelease({ gross: 10630, proFeeBps: 500, referralCredits: 50 });
  assert.equal(partial.proFee, full.proFee);
  assert.equal(partial.net, full.net);
  assert.equal(partial.referralCredits, full.referralCredits);
  assert.equal(partial.remaining, 0);
});

test("fee rounds to cents on the released amount, not on the gross", () => {
  const r = settlePartialRelease({ gross: 1000, released: 333, proFeeBps: 500 });
  assert.equal(r.proFee, 16.65);
  assert.equal(r.net, 316.35);
  assert.equal(r.remaining, 667);
});

test("released 0 releases nothing and leaves the whole gross remaining", () => {
  const r = settlePartialRelease({ gross: 10630, released: 0, proFeeBps: 500 });
  assert.deepEqual(r, { released: 0, proFee: 0, referralCredits: 0, net: 0, remaining: 10630 });
});

test("released above gross fails fast", () => {
  assert.throws(
    () => settlePartialRelease({ gross: 5000, released: 5000.01, proFeeBps: 500 }),
    /released must not exceed gross/,
  );
});

test("negative released fails fast", () => {
  assert.throws(
    () => settlePartialRelease({ gross: 5000, released: -1, proFeeBps: 500 }),
    /released must be a finite non-negative number/,
  );
});

test("non-finite released fails fast", () => {
  assert.throws(
    () => settlePartialRelease({ gross: 5000, released: Number.NaN, proFeeBps: 500 }),
    /released must be a finite non-negative number/,
  );
  assert.throws(
    () => settlePartialRelease({ gross: 5000, released: Infinity, proFeeBps: 500 }),
    /released must be a finite non-negative number/,
  );
});

test("non-finite or negative gross fails fast", () => {
  assert.throws(
    () => settlePartialRelease({ gross: Number.NaN, released: 0, proFeeBps: 500 }),
    /gross must be a finite non-negative number/,
  );
  assert.throws(
    () => settlePartialRelease({ gross: -100, released: 0, proFeeBps: 500 }),
    /gross must be a finite non-negative number/,
  );
});

test("invalid fee or credits reuse the settleRelease guards", () => {
  assert.throws(
    () => settlePartialRelease({ gross: 5000, released: 1000, proFeeBps: 10001 }),
    /proFeeBps must be an integer in \[0, 10000\]/,
  );
  assert.throws(
    () => settlePartialRelease({ gross: 5000, released: 1000, proFeeBps: 500, referralCredits: -1 }),
    /referralCredits must be a finite non-negative number/,
  );
});

test("referral credits above the released net fail with the negative-net error, not a partial result", () => {
  let result: unknown;
  let thrown: unknown;
  try {
    result = settlePartialRelease({ gross: 10630, released: 5000, proFeeBps: 500, referralCredits: 5000 });
  } catch (err) {
    thrown = err;
  }
  assert.equal(result, undefined);
  assert.ok(thrown instanceof Error);
  assert.equal(thrown.message, "net payout would be negative");
});

test("a second partial release on the remainder fees only its own amount", () => {
  const first = settlePartialRelease({ gross: 10630, released: 5000, proFeeBps: 500 });
  const second = settlePartialRelease({ gross: first.remaining, released: 5630, proFeeBps: 500 });
  assert.equal(second.proFee, 281.5);
  assert.equal(second.net, 5348.5);
  assert.equal(second.remaining, 0);
  // Total fees across both releases equal the full-release fee.
  assert.equal(first.proFee + second.proFee, 531.5);
});
