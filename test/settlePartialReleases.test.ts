import test from "node:test";
import assert from "node:assert/strict";
import {
  settleRelease,
  settlePartialRelease,
  settlePartialReleases,
} from "../src/index.js";

test("two tranches summing exactly to gross leave remaining 0 and reconcile with a single full release", () => {
  const batch = settlePartialReleases({
    gross: 10630,
    releases: [4252, 6378],
    proFeeBps: 500,
  });
  assert.equal(batch.gross, 10630);
  assert.equal(batch.releases.length, 2);
  // Tranche 1: fee 212.60, net 4,039.40, remaining 6,378.
  assert.deepEqual(batch.releases[0], {
    released: 4252,
    proFee: 212.6,
    referralCredits: 0,
    net: 4039.4,
    remaining: 6378,
  });
  // Tranche 2: fee 318.90, net 6,059.10, remaining 0.
  assert.deepEqual(batch.releases[1], {
    released: 6378,
    proFee: 318.9,
    referralCredits: 0,
    net: 6059.1,
    remaining: 0,
  });
  assert.equal(batch.totalReleased, 10630);
  assert.equal(batch.totalProFee, 531.5);
  assert.equal(batch.totalReferralCredits, 0);
  assert.equal(batch.totalNet, 10098.5);
  assert.equal(batch.remaining, 0);
  // Splitting a release never double-charges the fee: totals match the
  // single full-release split exactly.
  const full = settleRelease({ gross: 10630, proFeeBps: 500 });
  assert.equal(batch.totalProFee, full.proFee);
  assert.equal(batch.totalNet, full.net);
});

test("cumulative over gross throws with the cumulative total in the message", () => {
  assert.throws(
    () =>
      settlePartialReleases({ gross: 1000, releases: [600, 600], proFeeBps: 500 }),
    /cumulative released 1200 exceeds gross 1000/,
  );
  // The over-pay is caught on the second tranche even though the first
  // tranche alone is legal: 600 + 600 individually pass, jointly over-pay.
  assert.throws(
    () =>
      settlePartialReleases({
        gross: 1000,
        releases: [400, 400, 400],
        proFeeBps: 500,
      }),
    /cumulative released 1200 exceeds gross 1000 \(release 3 of 3: 400 would bring the total to 1200\)/,
  );
});

test("a single tranche above gross still throws, via the cumulative guard", () => {
  // The cumulative check runs before delegation, so a one-tranche batch
  // that over-pays fails with the cumulative figures (the per-tranche
  // "released must not exceed gross" guard inside settlePartialRelease
  // remains as defense-in-depth behind it).
  assert.throws(
    () =>
      settlePartialReleases({ gross: 5000, releases: [5000.01], proFeeBps: 500 }),
    /cumulative released 5000.01 exceeds gross 5000/,
  );
});

test("three tranches: fee and net totals equal the per-tranche sums", () => {
  const batch = settlePartialReleases({
    gross: 1000,
    releases: [333, 333, 334],
    proFeeBps: 500,
  });
  assert.deepEqual(
    batch.releases.map((r) => r.proFee),
    [16.65, 16.65, 16.7],
  );
  assert.deepEqual(
    batch.releases.map((r) => r.net),
    [316.35, 316.35, 317.3],
  );
  assert.deepEqual(
    batch.releases.map((r) => r.remaining),
    [667, 334, 0],
  );
  assert.equal(batch.totalReleased, 1000);
  assert.equal(batch.totalProFee, 50);
  assert.equal(batch.totalNet, 950);
  assert.equal(batch.remaining, 0);
});

test("empty releases return a zero ledger with the whole gross remaining", () => {
  assert.deepEqual(
    settlePartialReleases({ gross: 1000, releases: [], proFeeBps: 500 }),
    {
      gross: 1000,
      releases: [],
      totalReleased: 0,
      totalProFee: 0,
      totalReferralCredits: 0,
      totalNet: 0,
      remaining: 1000,
    },
  );
});

test("referralCredits apply to the first tranche only and match the single helper", () => {
  const batch = settlePartialReleases({
    gross: 10630,
    releases: [5000, 5630],
    proFeeBps: 500,
    referralCredits: 100,
  });
  // Tranche 1 carries the credits, exactly as the single helper would.
  assert.deepEqual(
    batch.releases[0],
    settlePartialRelease({
      gross: 10630,
      released: 5000,
      proFeeBps: 500,
      referralCredits: 100,
    }),
  );
  // Tranche 2 settles against the still-locked balance with no credits.
  assert.deepEqual(
    batch.releases[1],
    settlePartialRelease({
      gross: 5630,
      released: 5630,
      proFeeBps: 500,
    }),
  );
  assert.equal(batch.totalReferralCredits, 100);
  assert.equal(batch.totalProFee, 531.5);
  assert.equal(batch.totalNet, 9998.5);
  assert.equal(batch.remaining, 0);
});

test("referralCredits with no releases throw instead of silently dropping the credit", () => {
  assert.throws(
    () =>
      settlePartialReleases({
        gross: 1000,
        releases: [],
        proFeeBps: 500,
        referralCredits: 100,
      }),
    /referralCredits require at least one release/,
  );
});

test("a second tranche exactly filling the remainder passes the boundary", () => {
  const batch = settlePartialReleases({
    gross: 1000,
    releases: [999.99, 0.01],
    proFeeBps: 500,
  });
  assert.equal(batch.totalReleased, 1000);
  assert.equal(batch.remaining, 0);
  assert.equal(batch.releases[1].released, 0.01);
  assert.equal(batch.releases[1].net, 0.01);
});

test("a zero-amount tranche is a no-op in the ledger", () => {
  const batch = settlePartialReleases({
    gross: 1000,
    releases: [0, 1000],
    proFeeBps: 500,
  });
  assert.deepEqual(batch.releases[0], {
    released: 0,
    proFee: 0,
    referralCredits: 0,
    net: 0,
    remaining: 1000,
  });
  assert.equal(batch.totalReleased, 1000);
  assert.equal(batch.totalNet, 950);
  assert.equal(batch.remaining, 0);
});

test("negative and non-finite tranche amounts fail fast", () => {
  assert.throws(
    () =>
      settlePartialReleases({ gross: 1000, releases: [500, -1], proFeeBps: 500 }),
    /releases\[1\] must be a finite non-negative number/,
  );
  assert.throws(
    () =>
      settlePartialReleases({
        gross: 1000,
        releases: [Number.NaN],
        proFeeBps: 500,
      }),
    /releases\[0\] must be a finite non-negative number/,
  );
});

test("invalid inputs fail fast: non-array releases, bad gross, bad proFeeBps, bad credits", () => {
  assert.throws(
    () =>
      settlePartialReleases({
        gross: 1000,
        releases: "600" as unknown as number[],
        proFeeBps: 500,
      }),
    /releases must be an array of numbers/,
  );
  assert.throws(
    () =>
      settlePartialReleases({ gross: -1, releases: [100], proFeeBps: 500 }),
    /gross must be a finite non-negative number/,
  );
  assert.throws(
    () =>
      settlePartialReleases({ gross: 1000, releases: [], proFeeBps: 10001 }),
    /proFeeBps must be an integer in \[0, 10000\]/,
  );
  assert.throws(
    () =>
      settlePartialReleases({
        gross: 1000,
        releases: [100],
        proFeeBps: 500,
        referralCredits: -5,
      }),
    /referralCredits must be a finite non-negative number/,
  );
});

test("cent rounding keeps 0.1 + 0.2 exact in the cumulative total", () => {
  const batch = settlePartialReleases({
    gross: 0.3,
    releases: [0.1, 0.2],
    proFeeBps: 0,
  });
  assert.equal(batch.totalReleased, 0.3);
  assert.equal(batch.totalNet, 0.3);
  assert.equal(batch.remaining, 0);
});
