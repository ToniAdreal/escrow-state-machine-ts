import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  calculateDeposit,
  createQuorum,
  dispatchArbitration,
  historyFromNdjson,
  historyToNdjson,
  settleArbitrationSplitCents,
  settlePartialReleasesCents,
  verifyHistoryChain,
} from "../src/index.js";

const SIGNERS = [
  "dao-1", "dao-2", "dao-3", "dao-4", "dao-5",
  "dao-6", "dao-7", "dao-8", "dao-9",
];

/** Escrow sitting in DISPUTED: CREATED → FUNDED(10630) → DISPUTED. */
function disputedEscrow(id = "esc-1"): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", undefined, 10630);
  escrow.dispatch("DISPUTE");
  assert.equal(escrow.state, "DISPUTED");
  assert.equal(escrow.history.length, 2);
  return escrow;
}

/** Quorum with the first `n` signers approved (5/9 rule). */
function quorumWith(n: number) {
  const quorum = createQuorum({ threshold: 5, signers: SIGNERS });
  for (let i = 0; i < n; i++) quorum.approve(SIGNERS[i]);
  return quorum;
}

/** 70/30 split of the golden 10630.00 locked balance, in cents. */
const SPLIT_70_30 = { creatorCents: 744100, sponsorCents: 318900 };

describe("ARBITRATE_SPLIT dispatch (backlog #1449)", () => {
  it("throws without quorum and leaves state/history untouched", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(4); // 4/9: below threshold

    assert.throws(
      () =>
        dispatchArbitration(escrow, quorum, "split", undefined, {
          split: SPLIT_70_30,
        }),
      /arbitration requires quorum: 4\/5 approvals/,
    );

    assert.equal(escrow.state, "DISPUTED");
    assert.equal(escrow.history.length, 2);
  });

  it("split without amounts throws and leaves the escrow untouched", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(5);

    assert.throws(
      () => dispatchArbitration(escrow, quorum, "split"),
      /split is required on ARBITRATE_SPLIT: the split amounts are the event/,
    );

    assert.equal(escrow.state, "DISPUTED");
    assert.equal(escrow.history.length, 2);
  });

  it("split summing below the locked balance throws and consumes no key", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(5);
    const opts = { idempotencyKey: "split-1" } as const;

    assert.throws(
      () =>
        dispatchArbitration(escrow, quorum, "split", undefined, {
          ...opts,
          split: { creatorCents: 744100, sponsorCents: 318899 },
        }),
      /split amounts must equal the locked balance: creator 744100 \+ sponsor 318899 = 1062999 cents but 1063000 cents are still locked/,
    );

    assert.equal(escrow.state, "DISPUTED");
    assert.equal(escrow.history.length, 2);
    // Same key retries cleanly once the amounts are corrected.
    assert.equal(
      dispatchArbitration(escrow, quorum, "split", undefined, {
        ...opts,
        split: SPLIT_70_30,
      }),
      "RELEASED",
    );
    assert.equal(escrow.history.length, 3);
  });

  it("split summing above the locked balance throws", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(5);

    assert.throws(
      () =>
        dispatchArbitration(escrow, quorum, "split", undefined, {
          split: { creatorCents: 744100, sponsorCents: 318901 },
        }),
      /split amounts must equal the locked balance: creator 744100 \+ sponsor 318901 = 1063001 cents but 1063000 cents are still locked/,
    );

    assert.equal(escrow.state, "DISPUTED");
    assert.equal(escrow.history.length, 2);
  });

  it("negative shares throw a shape error", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(5);

    assert.throws(
      () =>
        dispatchArbitration(escrow, quorum, "split", undefined, {
          split: { creatorCents: -1, sponsorCents: 1063001 },
        }),
      /invalid dispatch options: split creatorCents must be a non-negative safe integer number of cents, got -1/,
    );
    assert.throws(
      () =>
        dispatchArbitration(escrow, quorum, "split", undefined, {
          split: { creatorCents: 1063001, sponsorCents: -1 },
        }),
      /invalid dispatch options: split sponsorCents must be a non-negative safe integer number of cents, got -1/,
    );

    assert.equal(escrow.state, "DISPUTED");
    assert.equal(escrow.history.length, 2);
  });

  it("fractional and non-numeric shares throw a shape error", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(5);

    assert.throws(
      () =>
        dispatchArbitration(escrow, quorum, "split", undefined, {
          split: { creatorCents: 744100.5, sponsorCents: 318899.5 },
        }),
      /invalid dispatch options: split creatorCents must be a non-negative safe integer number of cents, got 744100.5/,
    );
    assert.throws(
      () =>
        dispatchArbitration(escrow, quorum, "split", undefined, {
          split: { creatorCents: "744100", sponsorCents: 318900 } as never,
        }),
      /invalid dispatch options: split creatorCents must be a non-negative safe integer number of cents, got "744100"/,
    );

    assert.equal(escrow.history.length, 2);
  });

  it("an unknown field in the split object fails closed", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(5);

    assert.throws(
      () =>
        dispatchArbitration(escrow, quorum, "split", undefined, {
          split: {
            creatorCents: 744100,
            sponsorCents: 318900,
            platformCents: 1,
          } as never,
        }),
      /invalid dispatch options: split has unknown field "platformCents"/,
    );

    assert.equal(escrow.history.length, 2);
  });

  it("an overflowing sum is rejected as a mismatch, not rounded", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(5);

    // Each share is a safe integer, but their sum is not — the
    // comparison runs in BigInt, so the exact sum names the mismatch
    // instead of a float-rounded figure.
    assert.throws(
      () =>
        dispatchArbitration(escrow, quorum, "split", undefined, {
          split: {
            creatorCents: Number.MAX_SAFE_INTEGER,
            sponsorCents: 1,
          },
        }),
      /split amounts must equal the locked balance: creator 9007199254740991 \+ sponsor 1 = 9007199254740992 cents but 1063000 cents are still locked/,
    );

    assert.equal(escrow.history.length, 2);
  });

  it("split amounts on a release/refund outcome are rejected", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(5);

    assert.throws(
      () =>
        dispatchArbitration(escrow, quorum, "release", undefined, {
          split: SPLIT_70_30,
        }),
      /split is only accepted on ARBITRATE_SPLIT, not on ARBITRATE_RELEASE/,
    );
    assert.throws(
      () =>
        dispatchArbitration(escrow, quorum, "refund", undefined, {
          split: SPLIT_70_30,
        }),
      /split is only accepted on ARBITRATE_SPLIT, not on ARBITRATE_REFUND/,
    );

    assert.equal(escrow.state, "DISPUTED");
    assert.equal(escrow.history.length, 2);
  });

  it("a positional amount on ARBITRATE_SPLIT is rejected", () => {
    const escrow = disputedEscrow();

    assert.throws(
      () =>
        escrow.dispatch("ARBITRATE_SPLIT", undefined, 10630, {
          split: SPLIT_70_30,
        }),
      /amount is only accepted on FUND and PARTIAL_RELEASE, not on ARBITRATE_SPLIT/,
    );

    assert.equal(escrow.history.length, 2);
  });

  it("split from a non-DISPUTED state throws invalid transition", () => {
    const escrow = new Escrow("esc-1");
    escrow.dispatch("FUND", undefined, 10630);
    assert.equal(escrow.state, "FUNDED");

    assert.throws(
      () =>
        escrow.dispatch("ARBITRATE_SPLIT", undefined, undefined, {
          split: SPLIT_70_30,
        }),
      /invalid transition: ARBITRATE_SPLIT from FUNDED/,
    );

    assert.equal(escrow.history.length, 1);
  });

  it("a malformed split reports its shape error before the transition", () => {
    const escrow = new Escrow("esc-1");
    escrow.dispatch("FUND", undefined, 10630);

    // Shape validation runs with the other reference-shape checks,
    // before transition legality — the caller hears about its own
    // malformed input, not the illegal transition.
    assert.throws(
      () =>
        escrow.dispatch("ARBITRATE_SPLIT", undefined, undefined, {
          split: { creatorCents: -1, sponsorCents: 1063001 },
        }),
      /invalid dispatch options: split creatorCents must be a non-negative safe integer/,
    );

    assert.equal(escrow.history.length, 1);
  });

  it("a 70/30 split settles the escrow and records the split", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(5);

    const state = dispatchArbitration(escrow, quorum, "split", undefined, {
      split: SPLIT_70_30,
    });
    assert.equal(state, "RELEASED");
    assert.equal(escrow.state, "RELEASED");

    const last = escrow.history[escrow.history.length - 1];
    assert.equal(last.event, "ARBITRATE_SPLIT");
    assert.equal(last.from, "DISPUTED");
    assert.equal(last.to, "RELEASED");
    assert.deepEqual(last.splitCents, SPLIT_70_30);
    assert.equal(
      last.note,
      "quorum 5/5 [dao-1, dao-2, dao-3, dao-4, dao-5]",
    );
    assert.equal(escrow.history.length, 3);
    assert.equal(verifyHistoryChain(escrow.history), true);
  });

  it("the split divides the balance net of prior partial releases", () => {
    const escrow = new Escrow("esc-1");
    escrow.dispatch("FUND", undefined, 10630);
    escrow.dispatch("PARTIAL_RELEASE", undefined, 6000);
    escrow.dispatch("DISPUTE");
    const quorum = quorumWith(5);

    // Locked after the tranche: 10630 - 6000 = 4630.00 = 463000 cents.
    const state = dispatchArbitration(escrow, quorum, "split", undefined, {
      split: { creatorCents: 300000, sponsorCents: 163000 },
    });
    assert.equal(state, "RELEASED");

    const last = escrow.history[escrow.history.length - 1];
    assert.deepEqual(last.splitCents, {
      creatorCents: 300000,
      sponsorCents: 163000,
    });
    assert.equal(verifyHistoryChain(escrow.history), true);
  });

  it("100/0 and 0/100 boundary splits are legal", () => {
    const fullCreator = disputedEscrow("esc-full-creator");
    dispatchArbitration(fullCreator, quorumWith(5), "split", undefined, {
      split: { creatorCents: 1063000, sponsorCents: 0 },
    });
    assert.equal(fullCreator.state, "RELEASED");
    assert.deepEqual(
      fullCreator.history[fullCreator.history.length - 1].splitCents,
      { creatorCents: 1063000, sponsorCents: 0 },
    );

    const fullSponsor = disputedEscrow("esc-full-sponsor");
    dispatchArbitration(fullSponsor, quorumWith(5), "split", undefined, {
      split: { creatorCents: 0, sponsorCents: 1063000 },
    });
    assert.equal(fullSponsor.state, "RELEASED");
    assert.deepEqual(
      fullSponsor.history[fullSponsor.history.length - 1].splitCents,
      { creatorCents: 0, sponsorCents: 1063000 },
    );
  });

  it("a zero-balance split divides nothing and still settles", () => {
    const escrow = new Escrow("esc-1");
    escrow.dispatch("FUND"); // no amount: nothing locked
    escrow.dispatch("DISPUTE");
    const quorum = quorumWith(5);

    const state = dispatchArbitration(escrow, quorum, "split", undefined, {
      split: { creatorCents: 0, sponsorCents: 0 },
    });
    assert.equal(state, "RELEASED");
    assert.deepEqual(
      escrow.history[escrow.history.length - 1].splitCents,
      { creatorCents: 0, sponsorCents: 0 },
    );
  });

  it("settlementRef is recorded on the split entry", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(5);

    dispatchArbitration(escrow, quorum, "split", undefined, {
      split: SPLIT_70_30,
      settlementRef: "0xsplit-batch-1",
    });

    const last = escrow.history[escrow.history.length - 1];
    assert.equal(last.event, "ARBITRATE_SPLIT");
    assert.equal(last.settlementRef, "0xsplit-batch-1");
    assert.deepEqual(last.splitCents, SPLIT_70_30);
  });

  it("requireSettlementRef also gates the split", () => {
    const escrow = new Escrow("esc-1", { requireSettlementRef: true });
    escrow.dispatch("FUND", undefined, 10630);
    escrow.dispatch("DISPUTE");
    const quorum = quorumWith(5);

    assert.throws(
      () =>
        dispatchArbitration(escrow, quorum, "split", undefined, {
          split: SPLIT_70_30,
        }),
      /settlement reference required: ARBITRATE_SPLIT must carry a non-empty settlementRef when requireSettlementRef is enabled/,
    );
    assert.equal(escrow.history.length, 2);

    dispatchArbitration(escrow, quorum, "split", undefined, {
      split: SPLIT_70_30,
      settlementRef: "0xsplit-batch-1",
    });
    assert.equal(escrow.state, "RELEASED");
  });

  it("refundRef stays rejected on ARBITRATE_SPLIT", () => {
    const escrow = disputedEscrow();

    assert.throws(
      () =>
        escrow.dispatch("ARBITRATE_SPLIT", undefined, undefined, {
          split: SPLIT_70_30,
          refundRef: "refund-1",
        }),
      /refundRef is only accepted on ARBITRATE_REFUND, not on ARBITRATE_SPLIT/,
    );

    assert.equal(escrow.history.length, 2);
  });

  it("a split-scoped quorum allows a split and refuses a release", () => {
    const escrow = disputedEscrow();
    const splitScoped = createQuorum({
      threshold: 5,
      signers: SIGNERS,
      statementScope: { escrowId: "esc-1", outcome: "split" },
    });
    for (let i = 0; i < 5; i++) splitScoped.approve(SIGNERS[i]);

    assert.equal(
      dispatchArbitration(escrow, splitScoped, "split", undefined, {
        split: SPLIT_70_30,
      }),
      "RELEASED",
    );

    const escrow2 = disputedEscrow("esc-2");
    const releaseScoped = createQuorum({
      threshold: 5,
      signers: SIGNERS,
      statementScope: { escrowId: "esc-2", outcome: "release" },
    });
    for (let i = 0; i < 5; i++) releaseScoped.approve(SIGNERS[i]);

    assert.throws(
      () =>
        dispatchArbitration(escrow2, releaseScoped, "split", undefined, {
          split: SPLIT_70_30,
        }),
      /arbitration quorum scope mismatch: quorum is scoped to outcome "release" but dispatch outcome is "split"/,
    );
    assert.equal(escrow2.state, "DISPUTED");
    assert.equal(escrow2.history.length, 2);
  });

  it("an arbitration-scoped quorum allows a split", () => {
    const escrow = disputedEscrow();
    const quorum = createQuorum({
      threshold: 5,
      signers: SIGNERS,
      statementScope: { escrowId: "esc-1", outcome: "arbitration" },
    });
    for (let i = 0; i < 5; i++) quorum.approve(SIGNERS[i]);

    assert.equal(
      dispatchArbitration(escrow, quorum, "split", undefined, {
        split: SPLIT_70_30,
      }),
      "RELEASED",
    );
  });

  it("a repeated split with the same idempotency key is a pure no-op", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(5);
    const opts = { idempotencyKey: "split-1" } as const;

    assert.equal(
      dispatchArbitration(escrow, quorum, "split", undefined, {
        ...opts,
        split: SPLIT_70_30,
      }),
      "RELEASED",
    );
    const historyLength = escrow.history.length;

    // A different split under the same key does not re-execute.
    assert.equal(
      dispatchArbitration(escrow, quorum, "split", undefined, {
        ...opts,
        split: { creatorCents: 1063000, sponsorCents: 0 },
      }),
      "RELEASED",
    );
    assert.equal(escrow.history.length, historyLength);
    assert.deepEqual(
      escrow.history[escrow.history.length - 1].splitCents,
      SPLIT_70_30,
    );
  });

  it("mutating the caller's split object cannot rewrite the entry", () => {
    const escrow = disputedEscrow();
    const quorum = quorumWith(5);
    const split = { ...SPLIT_70_30 };

    dispatchArbitration(escrow, quorum, "split", undefined, { split });
    split.creatorCents = 1;
    split.sponsorCents = 1;

    assert.deepEqual(
      escrow.history[escrow.history.length - 1].splitCents,
      SPLIT_70_30,
    );
    assert.equal(verifyHistoryChain(escrow.history), true);
  });

  it("snapshot and NDJSON round-trips preserve the split", () => {
    const escrow = disputedEscrow();
    dispatchArbitration(escrow, quorumWith(5), "split", undefined, {
      split: SPLIT_70_30,
      settlementRef: "0xsplit-batch-1",
    });

    const snapshot = escrow.toJSON();
    const restored = Escrow.fromJSON(snapshot);
    assert.equal(restored.state, "RELEASED");
    assert.deepEqual(
      restored.history[restored.history.length - 1].splitCents,
      SPLIT_70_30,
    );
    // The parser allows the ref on a split entry, so it survives too.
    assert.equal(
      restored.history[restored.history.length - 1].settlementRef,
      "0xsplit-batch-1",
    );
    assert.equal(
      JSON.stringify(restored.toJSON()),
      JSON.stringify(snapshot),
    );
    assert.equal(verifyHistoryChain(restored.history), true);

    const ndjson = historyToNdjson(escrow.history);
    const parsed = historyFromNdjson(ndjson);
    assert.deepEqual(
      parsed[parsed.length - 1].splitCents,
      SPLIT_70_30,
    );
  });

  it("the parser rejects splitCents on a non-split entry", () => {
    const escrow = new Escrow("esc-1");
    escrow.dispatch("FUND", undefined, 10630);
    escrow.dispatch("SUBMIT_MILESTONE");
    escrow.dispatch("VERIFY_PASS");
    escrow.dispatch("RELEASE");
    const snapshot = escrow.toJSON();
    // Strip the chain so the shape error reports first.
    for (const entry of snapshot.history) {
      delete entry.prevHash;
      delete entry.hash;
    }
    snapshot.history[3].splitCents = { ...SPLIT_70_30 };

    assert.throws(
      () => Escrow.fromJSON(snapshot),
      /invalid snapshot: history\[3\]: splitCents only allowed on ARBITRATE_SPLIT entries/,
    );
  });

  it("the parser rejects a malformed splitCents on a split entry", () => {
    const escrow = disputedEscrow();
    dispatchArbitration(escrow, quorumWith(5), "split", undefined, {
      split: SPLIT_70_30,
    });
    const snapshot = escrow.toJSON();
    for (const entry of snapshot.history) {
      delete entry.prevHash;
      delete entry.hash;
    }
    snapshot.history[2].splitCents = {
      creatorCents: -5,
      sponsorCents: 1063005,
    };

    assert.throws(
      () => Escrow.fromJSON(snapshot),
      /invalid snapshot: history\[2\]: split creatorCents must be a non-negative safe integer number of cents, got -5/,
    );
  });

  it("buildSettlementReport refuses a split history fail-closed", () => {
    // No split branch exists yet: a split escrow must not be
    // restated as a full release. The report refuses instead of
    // misstating the settlement; use settleArbitrationSplitCents
    // directly until the report gains a split branch.
    const escrow = disputedEscrow();
    dispatchArbitration(escrow, quorumWith(5), "split", undefined, {
      split: SPLIT_70_30,
    });

    assert.throws(
      () =>
        buildSettlementReport({
          escrowId: "esc-1",
          history: escrow.history,
          finalState: "RELEASED",
          deposit: calculateDeposit({
            creatorPool: 10000,
            baseFee: 600,
            complexityMultiplier: 1.0,
            loyaltyDiscount: 30,
            oracleFee: 60,
          }),
          settlement: { proFeeBps: 500 },
        }),
      /cannot build settlement report for esc-1: state is RELEASED but the last audit event is ARBITRATE_SPLIT/,
    );
  });
});

describe("settleArbitrationSplitCents (backlog #1449)", () => {
  it("settles the golden 70/30 split at 500 bps", () => {
    const split = settleArbitrationSplitCents({
      grossCents: 1063000,
      creatorCents: 744100,
      proFeeBps: 500,
    });

    assert.deepEqual(split, {
      grossCents: 1063000,
      creatorCents: 744100,
      sponsorCents: 318900,
      proFeeCents: 37205,
      referralCreditsCents: 0,
      creatorNetCents: 706895,
      totalOutflowCents: 1063000,
      balanced: true,
    });
  });

  it("agrees with settlePartialReleasesCents on the creator leg", () => {
    const split = settleArbitrationSplitCents({
      grossCents: 1063000,
      creatorCents: 744100,
      proFeeBps: 500,
      referralCreditsCents: 10000,
    });
    const batch = settlePartialReleasesCents({
      grossCents: 1063000,
      releasesCents: [744100],
      proFeeBps: 500,
      referralCreditsCents: 10000,
    });

    // The creator leg IS the single-tranche partial release: same
    // fee, same net, and the sponsor share is the batch remainder.
    assert.deepEqual(batch.releases[0], {
      releasedCents: 744100,
      proFeeCents: split.proFeeCents,
      referralCreditsCents: 10000,
      netCents: split.creatorNetCents,
      remainingCents: split.sponsorCents,
    });
    assert.equal(batch.totalNetCents, split.creatorNetCents);
    assert.equal(batch.remainingCents, split.sponsorCents);
    assert.equal(split.totalOutflowCents, 1063000);
    assert.equal(split.balanced, true);
  });

  it("rounds the fee half-up in exact cents, not float dust", () => {
    // Gross 115 cents at 5000 bps: the float helper fees 57 (dust
    // flips the half-cent); the exact fee is 58.
    const split = settleArbitrationSplitCents({
      grossCents: 115,
      creatorCents: 115,
      proFeeBps: 5000,
    });
    assert.equal(split.proFeeCents, 58);
    assert.equal(split.creatorNetCents, 57);
    assert.equal(split.sponsorCents, 0);
    assert.equal(split.balanced, true);
  });

  it("referral credits reduce the creator net, never the sponsor share", () => {
    const split = settleArbitrationSplitCents({
      grossCents: 1063000,
      creatorCents: 744100,
      proFeeBps: 500,
      referralCreditsCents: 10000,
    });
    assert.equal(split.creatorNetCents, 696895);
    assert.equal(split.sponsorCents, 318900);
    assert.equal(split.totalOutflowCents, 1063000);
    assert.equal(split.balanced, true);
  });

  it("a creator share above the gross throws", () => {
    assert.throws(
      () =>
        settleArbitrationSplitCents({
          grossCents: 1063000,
          creatorCents: 1063001,
          proFeeBps: 500,
        }),
      /releasedCents must not exceed grossCents/,
    );
  });

  it("invalid inputs fail fast", () => {
    assert.throws(
      () =>
        settleArbitrationSplitCents({
          grossCents: 1063000,
          creatorCents: -1,
          proFeeBps: 500,
        }),
      /creatorCents must be a finite non-negative integer number of cents/,
    );
    assert.throws(
      () =>
        settleArbitrationSplitCents({
          grossCents: 1063000,
          creatorCents: 744100.5,
          proFeeBps: 500,
        }),
      /creatorCents must be a finite non-negative integer number of cents/,
    );
    assert.throws(
      () =>
        settleArbitrationSplitCents({
          grossCents: 1063000,
          creatorCents: 744100,
          proFeeBps: 10001,
        }),
      /proFeeBps must be an integer in \[0, 10000\]/,
    );
    assert.throws(
      () =>
        settleArbitrationSplitCents({
          grossCents: 1063000,
          creatorCents: 744100,
          proFeeBps: 500,
          referralCreditsCents: 744101,
        }),
      /net payout would be negative/,
    );
    assert.throws(
      () =>
        settleArbitrationSplitCents({
          grossCents: 1063000,
          creatorCents: 744100,
          proFeeBps: 500,
          platformCents: 1,
        } as never),
      /settleArbitrationSplitCents: unknown field "platformCents"/,
    );
  });

  it("a zero creator share settles cleanly", () => {
    const split = settleArbitrationSplitCents({
      grossCents: 1063000,
      creatorCents: 0,
      proFeeBps: 500,
    });
    assert.deepEqual(split, {
      grossCents: 1063000,
      creatorCents: 0,
      sponsorCents: 1063000,
      proFeeCents: 0,
      referralCreditsCents: 0,
      creatorNetCents: 0,
      totalOutflowCents: 1063000,
      balanced: true,
    });
  });
});
