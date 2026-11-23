import test from "node:test";
import assert from "node:assert/strict";
import {
  settlePartialRelease,
  settlePartialReleases,
  settleRefund,
  settleRelease,
} from "../src/index.js";

// Backlog #1348: the four pure settlement helpers destructured `inputs` on
// their first line, so a null / non-object `inputs` died as a bare
// TypeError ("Cannot destructure property ... of 'inputs' as it is null")
// instead of a named error. Each function now guards the shape first.

const badInputs: unknown[] = [null, "x", 42, [], undefined];

for (const bad of badInputs) {
  test(`settleRelease rejects ${JSON.stringify(bad)} inputs with a named error, not a bare TypeError`, () => {
    assert.throws(
      () => settleRelease(bad as never),
      /settleRelease: invalid settlement inputs: inputs must be an object/,
    );
  });

  test(`settleRefund rejects ${JSON.stringify(bad)} inputs with a named error, not a bare TypeError`, () => {
    assert.throws(
      () => settleRefund(bad as never),
      /settleRefund: invalid settlement inputs: inputs must be an object/,
    );
  });

  test(`settlePartialRelease rejects ${JSON.stringify(bad)} inputs with a named error, not a bare TypeError`, () => {
    assert.throws(
      () => settlePartialRelease(bad as never),
      /settlePartialRelease: invalid settlement inputs: inputs must be an object/,
    );
  });

  test(`settlePartialReleases rejects ${JSON.stringify(bad)} inputs with a named error, not a bare TypeError`, () => {
    assert.throws(
      () => settlePartialReleases(bad as never),
      /settlePartialReleases: invalid settlement inputs: inputs must be an object/,
    );
  });
}

test("settleRelease golden vector is unchanged by the guard", () => {
  const r = settleRelease({ gross: 10630, proFeeBps: 500 });
  assert.equal(r.proFee, 531.5);
  assert.equal(r.net, 10098.5);
  assert.equal(r.gross, 10630);
  assert.equal(r.referralCredits, 0);
});

test("settleRelease with referral credits is unchanged by the guard", () => {
  const r = settleRelease({ gross: 1000, proFeeBps: 500, referralCredits: 50 });
  assert.equal(r.proFee, 50);
  assert.equal(r.net, 900);
});

test("settleRefund returns the full deposit unchanged by the guard", () => {
  const r = settleRefund({ deposit: 250 });
  assert.equal(r.sponsor, 250);
  assert.equal(r.creator, 0);
  assert.equal(r.platform, 0);
  assert.equal(r.totalOutflow, 250);
  assert.equal(r.balanced, true);
});

test("settlePartialRelease single tranche is unchanged by the guard", () => {
  const r = settlePartialRelease({
    gross: 1000,
    released: 400,
    proFeeBps: 500,
  });
  assert.equal(r.released, 400);
  assert.equal(r.proFee, 20);
  assert.equal(r.net, 380);
  assert.equal(r.remaining, 600);
});

test("settlePartialReleases multi-tranche totals are unchanged by the guard", () => {
  const r = settlePartialReleases({
    gross: 1000,
    releases: [400, 600],
    proFeeBps: 500,
    referralCredits: 50,
  });
  assert.equal(r.totalReleased, 1000);
  assert.equal(r.totalProFee, 50);
  assert.equal(r.totalReferralCredits, 50);
  assert.equal(r.totalNet, 900);
  assert.equal(r.remaining, 0);
  assert.equal(r.releases.length, 2);
});

test("an empty object still fails on the field checks, not on the shape guard", () => {
  assert.throws(
    () => settleRelease({} as never),
    /gross must be a finite non-negative number/,
  );
  assert.throws(
    () => settleRefund({} as never),
    /deposit must be a finite non-negative number/,
  );
});
