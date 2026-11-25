import test from "node:test";
import assert from "node:assert/strict";
import {
  settleRelease,
  settleReleaseCents,
  settlePartialReleaseCents,
  settlePartialReleasesCents,
  settleRefundCents,
} from "../src/index.js";

// Integer minor-unit (cents) settlement (backlog #1401): the same
// gross-to-net arithmetic as the dollar helpers, but every money field is
// a whole number of cents in and out and the fee is rounded a single time,
// half-up, in exact integer arithmetic (BigInt). Every expected value
// below was computed BY HAND from that rule — never by running the
// implementation — so a regression in the rounding cannot hide behind a
// copied output.

test("cents: 19.99 gross at 500 bps fees exactly 100 cents", () => {
  // Hand calc: 1999 * 500 / 10000 = 99.95 -> round half-up 100;
  // net = 1999 - 100 = 1899. The dollar version agrees here.
  const r = settleReleaseCents({ grossCents: 1999, proFeeBps: 500 });
  assert.deepEqual(r, {
    grossCents: 1999,
    proFeeCents: 100,
    referralCreditsCents: 0,
    netCents: 1899,
  });
  const dollars = settleRelease({ gross: 19.99, proFeeBps: 500 });
  // Math.round on both sides: 18.99 * 100 is 1898.9999999999998 in float.
  assert.equal(Math.round(dollars.proFee * 100), 100);
  assert.equal(Math.round(dollars.net * 100), 1899);
});

test("cents: portfolio golden vector in cents", () => {
  // Hand calc: 1,063,000 * 500 / 10000 = 53,150 exactly;
  // net = 1,063,000 - 53,150 = 1,009,850. The dollar version agrees:
  // gross 10630 at 500 bps fees 531.50, net 10098.50.
  const r = settleReleaseCents({ grossCents: 1063000, proFeeBps: 500 });
  assert.equal(r.proFeeCents, 53150);
  assert.equal(r.netCents, 1009850);
  const dollars = settleRelease({ gross: 10630, proFeeBps: 500 });
  assert.equal(dollars.proFee, 531.5);
  assert.equal(dollars.net, 10098.5);
});

test("cents: half-cent boundary rounds up where the float version rounds down", () => {
  // Hand calc: 115 * 5000 / 10000 = 57.5 -> round half-up 58, net 57.
  // The dollar version computes 1.15 * 5000 / 10000 * 100 as
  // 57.49999999999999, so Math.round takes 57 and fees 0.57 — the exact
  // float dust this cents path exists to eliminate. Both results are
  // pinned: the cents one as correct, the dollar one as the known
  // float behavior it replaces for new callers.
  const r = settleReleaseCents({ grossCents: 115, proFeeBps: 5000 });
  assert.equal(r.proFeeCents, 58);
  assert.equal(r.netCents, 57);
  assert.equal(settleRelease({ gross: 1.15, proFeeBps: 5000 }).proFee, 0.57);
});

test("cents: half-up rounding pins at the exact .5 boundary", () => {
  // 1 * 5000 / 10000 = 0.5 -> 1 (half-up, not banker's rounding).
  assert.equal(
    settleReleaseCents({ grossCents: 1, proFeeBps: 5000 }).proFeeCents,
    1,
  );
  // 3 * 5000 / 10000 = 1.5 -> 2.
  assert.equal(
    settleReleaseCents({ grossCents: 3, proFeeBps: 5000 }).proFeeCents,
    2,
  );
  // 1 * 4999 / 10000 = 0.4999 -> 0 (just below the boundary rounds down).
  assert.equal(
    settleReleaseCents({ grossCents: 1, proFeeBps: 4999 }).proFeeCents,
    0,
  );
});

test("cents: referral credits reduce the net, fee unchanged", () => {
  // Hand calc: fee 100 as in the 19.99 case; net = 1999 - 100 - 50 = 1849.
  const r = settleReleaseCents({
    grossCents: 1999,
    proFeeBps: 500,
    referralCreditsCents: 50,
  });
  assert.equal(r.proFeeCents, 100);
  assert.equal(r.referralCreditsCents, 50);
  assert.equal(r.netCents, 1849);
});

test("cents: negative net throws the same error as the dollar version", () => {
  assert.throws(
    () =>
      settleReleaseCents({
        grossCents: 100,
        proFeeBps: 0,
        referralCreditsCents: 101,
      }),
    /net payout would be negative/,
  );
  assert.throws(
    () => settleRelease({ gross: 1, proFeeBps: 0, referralCredits: 1.01 }),
    /net payout would be negative/,
  );
});

test("cents: fractional, negative, and non-safe-integer cents fail fast", () => {
  for (const bad of [1999.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => settleReleaseCents({ grossCents: bad, proFeeBps: 500 }),
      /grossCents must be a finite non-negative integer number of cents/,
    );
  }
  assert.throws(
    () =>
      settleReleaseCents({
        grossCents: Number.MAX_SAFE_INTEGER + 1,
        proFeeBps: 500,
      }),
    /grossCents must be a finite non-negative integer number of cents/,
  );
  assert.throws(
    () =>
      settleReleaseCents({
        grossCents: 1999,
        proFeeBps: 500,
        referralCreditsCents: 0.5,
      }),
    /referralCreditsCents must be a finite non-negative integer number of cents/,
  );
});

test("cents: proFeeBps outside [0, 10000] or non-integer fails fast", () => {
  for (const bad of [-1, 10001, 12.5, Number.NaN]) {
    assert.throws(
      () => settleReleaseCents({ grossCents: 1999, proFeeBps: bad }),
      /proFeeBps must be an integer in \[0, 10000\]/,
    );
  }
  // Boundaries pass: 0 bps fees nothing, 10000 bps fees everything.
  assert.equal(
    settleReleaseCents({ grossCents: 1999, proFeeBps: 0 }).proFeeCents,
    0,
  );
  assert.equal(
    settleReleaseCents({ grossCents: 1999, proFeeBps: 10000 }).netCents,
    0,
  );
});

test("cents: MAX_SAFE_INTEGER gross stays exact (BigInt fee path)", () => {
  // Hand calc: 9007199254740991 * 500 / 10000 = 450359962737049.55 ->
  // round half-up 450359962737050; net = 9007199254740991 - 450359962737050
  // = 8556839292003941. A float product would lose low bits here.
  const r = settleReleaseCents({
    grossCents: Number.MAX_SAFE_INTEGER,
    proFeeBps: 500,
  });
  assert.equal(r.proFeeCents, 450359962737050);
  assert.equal(r.netCents, 8556839292003941);
});

test("cents: dollar and cents versions agree to the cent on shared inputs", () => {
  const cases: Array<[number, number]> = [
    [1999, 500],
    [1063000, 500],
    [100, 0],
    [1, 10000],
    [25075, 600],
  ];
  for (const [grossCents, proFeeBps] of cases) {
    const cents = settleReleaseCents({ grossCents, proFeeBps });
    const dollars = settleRelease({ gross: grossCents / 100, proFeeBps });
    assert.equal(
      cents.proFeeCents,
      Math.round(dollars.proFee * 100),
      `fee mismatch at grossCents ${grossCents} bps ${proFeeBps}`,
    );
    assert.equal(
      cents.netCents,
      Math.round(dollars.net * 100),
      `net mismatch at grossCents ${grossCents} bps ${proFeeBps}`,
    );
  }
});

test("cents: partial release fees only the released amount, remainder exact", () => {
  // Hand calc: released 6000 at 500 bps -> fee 300, net 5700,
  // remaining = 10000 - 6000 = 4000 exactly.
  const r = settlePartialReleaseCents({
    grossCents: 10000,
    releasedCents: 6000,
    proFeeBps: 500,
  });
  assert.deepEqual(r, {
    releasedCents: 6000,
    proFeeCents: 300,
    referralCreditsCents: 0,
    netCents: 5700,
    remainingCents: 4000,
  });
  // No round2 anywhere: 10000 - 3333 = 6667, not a float-rounded 6667.0x.
  assert.equal(
    settlePartialReleaseCents({
      grossCents: 10000,
      releasedCents: 3333,
      proFeeBps: 500,
    }).remainingCents,
    6667,
  );
  assert.throws(
    () =>
      settlePartialReleaseCents({
        grossCents: 10000,
        releasedCents: 10001,
        proFeeBps: 500,
      }),
    /releasedCents must not exceed grossCents/,
  );
});

test("cents: batch partial releases with credits on the first tranche only", () => {
  // Hand calc: tranche 1: 6000 at 500 bps -> fee 300, net 6000-300-100
  // = 5600; tranche 2: 4000 -> fee 200, net 3800. Totals: released
  // 10000, fee 500, credits 100, net 9400, remaining 0.
  const r = settlePartialReleasesCents({
    grossCents: 10000,
    releasesCents: [6000, 4000],
    proFeeBps: 500,
    referralCreditsCents: 100,
  });
  assert.equal(r.releases[0].netCents, 5600);
  assert.equal(r.releases[1].netCents, 3800);
  assert.equal(r.totalReleasedCents, 10000);
  assert.equal(r.totalProFeeCents, 500);
  assert.equal(r.totalReferralCreditsCents, 100);
  assert.equal(r.totalNetCents, 9400);
  assert.equal(r.remainingCents, 0);
});

test("cents: batch cumulative guard fails as a whole on over-pay", () => {
  // 6000 + 6000 against a 10000 gross: the second tranche trips the
  // guard before any per-tranche math, so nothing settles halfway.
  assert.throws(
    () =>
      settlePartialReleasesCents({
        grossCents: 10000,
        releasesCents: [6000, 6000],
        proFeeBps: 500,
      }),
    /cumulative released 12000 exceeds gross 10000/,
  );
  assert.throws(
    () =>
      settlePartialReleasesCents({
        grossCents: 10000,
        releasesCents: [],
        proFeeBps: 500,
        referralCreditsCents: 100,
      }),
    /referralCreditsCents require at least one release/,
  );
});

test("cents: refund returns the whole deposit, balanced exactly", () => {
  const r = settleRefundCents({ depositCents: 1063000 });
  assert.deepEqual(r, {
    depositCents: 1063000,
    sponsorCents: 1063000,
    creatorCents: 0,
    platformCents: 0,
    referrerCents: 0,
    totalOutflowCents: 1063000,
    balanced: true,
  });
  assert.throws(
    () => settleRefundCents({ depositCents: 10.5 }),
    /depositCents must be a finite non-negative integer number of cents/,
  );
});

test("cents: non-object inputs fail with a named error, not a TypeError", () => {
  for (const bad of [null, "x", 42, []]) {
    assert.throws(
      () => settleReleaseCents(bad as never),
      /settleReleaseCents: invalid settlement inputs: inputs must be an object/,
    );
    assert.throws(
      () => settlePartialReleaseCents(bad as never),
      /settlePartialReleaseCents: invalid settlement inputs: inputs must be an object/,
    );
    assert.throws(
      () => settlePartialReleasesCents(bad as never),
      /settlePartialReleasesCents: invalid settlement inputs: inputs must be an object/,
    );
    assert.throws(
      () => settleRefundCents(bad as never),
      /settleRefundCents: invalid settlement inputs: inputs must be an object/,
    );
  }
});
