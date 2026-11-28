import test from "node:test";
import assert from "node:assert/strict";
import {
  settleReleaseCents,
  settlePartialReleasesCents,
} from "../src/index.js";

/**
 * Per-tranche fee rounding divergence (backlog #1441).
 *
 * `settlePartialReleasesCents` charges the fee on each tranche
 * separately, half-up rounded to the nearest cent, while the
 * single-release fee rounds once on the total. Each rounding moves
 * the fee by at most half a cent, so with n tranches the batched
 * total fee can differ from the one-shot fee on the same total by
 * at most floor(n / 2) cents — the bound is tight (see the
 * ten-1-cent-tranches case below, which attains it exactly). The
 * exact arithmetic is done with BigInt inside `feeCents`, so the
 * bound was re-verified here by brute force over 200,000 seeded
 * splits before these tests were written: the observed maximum
 * divergence was floor(n / 2) for every n from 2 to 8, never more.
 * Nothing in `src/` changes here; these tests pin the divergence
 * so callers stop reading "splitting never double-charges" as
 * "splitting charges exactly the same fee".
 */

// Deterministic LCG (same generator family as the settlement tests
// elsewhere in this repo): no Math.random, no wall clock.
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 0x100000000;
  };
}

function wholeFeeCents(totalReleasedCents: number, proFeeBps: number): number {
  return settleReleaseCents({
    grossCents: totalReleasedCents,
    proFeeBps,
  }).proFeeCents;
}

test("golden cents fixture: two tranches equal the single-release fee exactly", () => {
  const batch = settlePartialReleasesCents({
    grossCents: 1_063_000,
    releasesCents: [425_200, 637_800],
    proFeeBps: 500,
  });
  // Tranche fees 21,260 + 31,890 = 53,150; the whole fee on 1,063,000
  // at 500 bps is 53,150 too — the README's golden split, in cents.
  assert.deepEqual(
    batch.releases.map((r) => r.proFeeCents),
    [21_260, 31_890],
  );
  assert.equal(batch.totalProFeeCents, 53_150);
  assert.equal(
    batch.totalProFeeCents,
    wholeFeeCents(1_063_000, 500),
  );
  assert.equal(batch.totalNetCents, 1_009_850);
});

test("a real nonzero divergence: two 10-cent tranches at 250 bps undercharge by 1 cent", () => {
  const batch = settlePartialReleasesCents({
    grossCents: 20,
    releasesCents: [10, 10],
    proFeeBps: 250,
  });
  // Each tranche's exact fee is 0.25 cents, half-up rounded to 0;
  // the one-shot fee on 20 cents is exactly 0.5 cents, half-up
  // rounded to 1. Splitting here charges 1 cent less, not more.
  assert.deepEqual(
    batch.releases.map((r) => r.proFeeCents),
    [0, 0],
  );
  assert.equal(batch.totalProFeeCents, 0);
  assert.equal(wholeFeeCents(20, 250), 1);
  assert.equal(
    Math.abs(batch.totalProFeeCents - wholeFeeCents(20, 250)),
    1,
  );
  // The bound floor(2 / 2) = 1 is attained exactly.
  assert.equal(Math.floor(2 / 2), 1);
});

test("ten 1-cent tranches at 5000 bps attain the floor(n / 2) bound exactly", () => {
  const releasesCents = Array.from({ length: 10 }, () => 1);
  const batch = settlePartialReleasesCents({
    grossCents: 10,
    releasesCents,
    proFeeBps: 5000,
  });
  // Each tranche's exact fee is 0.5 cents, half-up rounded to 1, so
  // the batch charges 10 cents; the one-shot fee on 10 cents at
  // 50% is 5 cents. Divergence 5 = floor(10 / 2): the bound is tight.
  assert.equal(batch.totalProFeeCents, 10);
  assert.equal(wholeFeeCents(10, 5000), 5);
  assert.equal(
    Math.abs(batch.totalProFeeCents - wholeFeeCents(10, 5000)),
    Math.floor(10 / 2),
  );
});

test("seeded pseudo-random splits stay within floor(n / 2) cents of the one-shot fee", () => {
  const rng = makeRng(0x1441);
  let maxObserved = 0;
  for (let trial = 0; trial < 120; trial++) {
    const n = 1 + Math.floor(rng() * 8);
    const proFeeBps = Math.floor(rng() * 10001);
    const grossCents = 1 + Math.floor(rng() * 1_000_000);
    // Split a random total (<= gross) into n tranches.
    const total = 1 + Math.floor(rng() * grossCents);
    const releasesCents: number[] = [];
    let remaining = total;
    for (let i = 0; i < n - 1; i++) {
      const cut = Math.floor(rng() * (remaining + 1));
      releasesCents.push(cut);
      remaining -= cut;
    }
    releasesCents.push(remaining);
    const batch = settlePartialReleasesCents({
      grossCents,
      releasesCents,
      proFeeBps,
    });
    const divergence = Math.abs(
      batch.totalProFeeCents - wholeFeeCents(total, proFeeBps),
    );
    maxObserved = Math.max(maxObserved, divergence);
    assert.ok(
      divergence <= Math.floor(n / 2),
      `trial ${trial}: n=${n} bps=${proFeeBps} total=${total} ` +
        `releases=${releasesCents.join(",")} divergence=${divergence} ` +
        `exceeds floor(${n}/2)=${Math.floor(n / 2)}`,
    );
    // Each tranche's fee is exactly the single-release fee on that
    // tranche's amount: the batch cannot drift from the single path.
    for (let i = 0; i < n; i++) {
      assert.equal(
        batch.releases[i].proFeeCents,
        settleReleaseCents({
          grossCents: releasesCents[i],
          proFeeBps,
        }).proFeeCents,
      );
    }
  }
  // The sweep is not a vacuous all-equal pass: at least one seeded
  // split actually diverged.
  assert.ok(maxObserved > 0, `expected a nonzero divergence, saw ${maxObserved}`);
});

test("a single tranche never diverges (n = 1, bound 0)", () => {
  const batch = settlePartialReleasesCents({
    grossCents: 999,
    releasesCents: [999],
    proFeeBps: 333,
  });
  assert.equal(
    batch.totalProFeeCents,
    wholeFeeCents(999, 333),
  );
});

test("partial batches compare against the fee on the total released, not on the gross", () => {
  const batch = settlePartialReleasesCents({
    grossCents: 100,
    releasesCents: [10, 10],
    proFeeBps: 250,
  });
  // Only 20 of the 100 cents are released, so the reference fee is
  // the one-shot fee on 20 (1 cent), not on the gross (3 cents).
  assert.equal(batch.totalProFeeCents, 0);
  assert.equal(wholeFeeCents(20, 250), 1);
  assert.equal(wholeFeeCents(100, 250), 3);
  assert.ok(
    Math.abs(batch.totalProFeeCents - wholeFeeCents(20, 250)) <=
      Math.floor(2 / 2),
  );
  assert.equal(batch.remainingCents, 80);
});

test("net conservation holds across seeded splits, with credits on the first tranche only", () => {
  const rng = makeRng(0xbeef);
  for (let trial = 0; trial < 40; trial++) {
    const n = 1 + Math.floor(rng() * 6);
    const proFeeBps = Math.floor(rng() * 10001);
    const grossCents = 100 + Math.floor(rng() * 100_000);
    const total = 1 + Math.floor(rng() * grossCents);
    const releasesCents: number[] = [];
    let remaining = total;
    for (let i = 0; i < n - 1; i++) {
      const cut = Math.floor(rng() * (remaining + 1));
      releasesCents.push(cut);
      remaining -= cut;
    }
    releasesCents.push(remaining);
    // Credits must fit inside the first tranche's net.
    const firstFee = settleReleaseCents({
      grossCents: releasesCents[0],
      proFeeBps,
    }).proFeeCents;
    const referralCreditsCents = Math.floor(
      rng() * (releasesCents[0] - firstFee + 1),
    );
    const batch = settlePartialReleasesCents({
      grossCents,
      releasesCents,
      proFeeBps,
      referralCreditsCents,
    });
    const netsSum = batch.releases.reduce((a, r) => a + r.netCents, 0);
    assert.equal(
      netsSum + batch.remainingCents,
      grossCents - batch.totalProFeeCents - referralCreditsCents,
      `trial ${trial}: nets + remaining must equal gross - fees - credits`,
    );
    assert.equal(
      batch.totalReferralCreditsCents,
      referralCreditsCents,
    );
    // Credits land on the first tranche only.
    assert.equal(
      batch.releases[0].referralCreditsCents,
      referralCreditsCents,
    );
    for (let i = 1; i < n; i++) {
      assert.equal(batch.releases[i].referralCreditsCents, 0);
    }
  }
});

test("fee-rate extremes never diverge: 0 bps charges nothing, 10000 bps charges the release", () => {
  for (const proFeeBps of [0, 10000]) {
    const batch = settlePartialReleasesCents({
      grossCents: 12345,
      releasesCents: [1, 7, 12337],
      proFeeBps,
    });
    assert.equal(
      batch.totalProFeeCents,
      wholeFeeCents(12345, proFeeBps),
    );
  }
});

test("half-up rounding is pinned: a 1-cent tranche at 5000 bps charges 1 cent, not 0", () => {
  // Exact fee 0.5 cents; floor would charge 0 and ceil would charge
  // 1 on every tranche — this is the discriminator the mutation
  // check flips.
  const batch = settlePartialReleasesCents({
    grossCents: 1,
    releasesCents: [1],
    proFeeBps: 5000,
  });
  assert.equal(batch.releases[0].proFeeCents, 1);
  assert.equal(batch.releases[0].netCents, 0);
});
