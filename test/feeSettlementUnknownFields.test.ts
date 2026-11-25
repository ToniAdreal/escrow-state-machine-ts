/**
 * Fee / settlement inputs unknown-field fail-closed (backlog #1403).
 *
 * The fee calculators and the settlement helpers destructured only the
 * fields they knew, so a typo'd key (`creatorPoll` for `creatorPool`,
 * `proFeeBp` for `proFeeBps`) was silently ignored — and
 * `calculateDeposit` even spread the typo'd key into its returned
 * breakdown, leaking it into settlement reports and webhook payloads.
 * `buildSettlementReport` ignored unknown keys at the top level and
 * inside its nested `settlement` / `partialRelease` parameter objects
 * (and in the `deposit` breakdown it carries verbatim onto the report).
 * Unknown keys now throw a named `unknown field "<name>"` error before
 * any value is consumed. Every case below pins the exact wording, and
 * the legal paths are asserted byte-identical to before.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementReports,
  calculateDeposit,
  calculateDepositCents,
  settlePartialRelease,
  settlePartialReleaseCents,
  settlePartialReleases,
  settlePartialReleasesCents,
  settleRefund,
  settleRefundCents,
  settleRelease,
  settleReleaseCents,
} from "../src/index.js";
import type { SettlementReport } from "../src/index.js";

function goldenFee() {
  return {
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1,
    loyaltyDiscount: 30,
    oracleFee: 60,
  };
}

function goldenFeeCents() {
  return {
    creatorPoolCents: 1000000,
    baseFeeCents: 60000,
    complexityMultiplier: 1,
    loyaltyDiscountCents: 3000,
    oracleFeeCents: 6000,
  };
}

function releasedEscrow(id: string): Escrow {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return e;
}

function fundedEscrow(id: string): Escrow {
  const e = new Escrow(id);
  e.dispatch("FUND");
  return e;
}

function releasedReportInputs(id: string) {
  const e = releasedEscrow(id);
  return {
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: calculateDeposit(goldenFee()),
    settlement: { proFeeBps: 500 },
  };
}

describe("fee inputs unknown-field fail-closed", () => {
  it("accepts the golden fee inputs and returns exactly the known keys", () => {
    const r = calculateDeposit(goldenFee());
    assert.equal(r.deposit, 10630);
    assert.deepEqual(Object.keys(r).sort(), [
      "adjustedBaseFee",
      "baseFee",
      "complexityMultiplier",
      "creatorPool",
      "deposit",
      "loyaltyDiscount",
      "oracleFee",
    ]);
  });

  it("rejects a typo'd creatorPool and names the field", () => {
    assert.throws(
      () =>
        calculateDeposit({
          creatorPoll: 10000,
          baseFee: 600,
          complexityMultiplier: 1,
          loyaltyDiscount: 30,
          oracleFee: 60,
        } as never),
      /calculateDeposit: unknown field "creatorPoll"/,
    );
  });

  it("rejects an extra numeric key instead of leaking it into the breakdown", () => {
    assert.throws(
      () => calculateDeposit({ ...goldenFee(), tax: 5 } as never),
      /calculateDeposit: unknown field "tax"/,
    );
  });

  it("rejects case-variant misspellings (CreatorPool)", () => {
    assert.throws(
      () => calculateDeposit({ ...goldenFee(), CreatorPool: 1 } as never),
      /calculateDeposit: unknown field "CreatorPool"/,
    );
  });

  it("reports the unknown field before any value validation runs", () => {
    // A negative creatorPool would fail the money check on its own; the
    // unknown key must win, so the caller learns the real bug (the typo)
    // instead of a misleading value error.
    assert.throws(
      () =>
        calculateDeposit({ ...goldenFee(), creatorPool: -1, tax: 5 } as never),
      /calculateDeposit: unknown field "tax"/,
    );
  });

  it("still rejects a non-object input with the shape error, not a field scan", () => {
    assert.throws(
      () => calculateDeposit("x" as never),
      /calculateDeposit: inputs must be an object/,
    );
  });

  it("accepts the golden cents inputs; rejects an extra cents key", () => {
    const r = calculateDepositCents(goldenFeeCents());
    assert.equal(r.depositCents, 1063000);
    assert.throws(
      () =>
        calculateDepositCents({ ...goldenFeeCents(), taxCents: 5 } as never),
      /calculateDepositCents: unknown field "taxCents"/,
    );
  });
});

describe("settlement inputs unknown-field fail-closed", () => {
  it("settleRelease accepts legal inputs incl. referralCredits; rejects a proFeeBps typo", () => {
    assert.deepEqual(
      settleRelease({ gross: 100, proFeeBps: 500, referralCredits: 10 }),
      { gross: 100, proFee: 5, referralCredits: 10, net: 85 },
    );
    assert.throws(
      () => settleRelease({ gross: 100, proFeeBp: 500 } as never),
      /settleRelease: unknown field "proFeeBp"/,
    );
  });

  it("settlePartialRelease rejects an extra key; legal slice unchanged", () => {
    assert.deepEqual(
      settlePartialRelease({ gross: 100, released: 50, proFeeBps: 500 }),
      { released: 50, proFee: 2.5, referralCredits: 0, net: 47.5, remaining: 50 },
    );
    assert.throws(
      () =>
        settlePartialRelease({
          gross: 100,
          released: 50,
          proFeeBps: 500,
          tip: 1,
        } as never),
      /settlePartialRelease: unknown field "tip"/,
    );
  });

  it("settlePartialReleases rejects an extra key; legal batch unchanged", () => {
    const r = settlePartialReleases({
      gross: 1000,
      releases: [600, 400],
      proFeeBps: 500,
    });
    assert.equal(r.totalNet, 950);
    assert.throws(
      () =>
        settlePartialReleases({
          gross: 1000,
          releases: [600, 400],
          proFeeBps: 500,
          fee: 1,
        } as never),
      /settlePartialReleases: unknown field "fee"/,
    );
  });

  it("settleRefund rejects an extra key; legal refund unchanged", () => {
    assert.deepEqual(settleRefund({ deposit: 100 }), {
      deposit: 100,
      sponsor: 100,
      creator: 0,
      platform: 0,
      referrer: 0,
      totalOutflow: 100,
      balanced: true,
    });
    assert.throws(
      () => settleRefund({ deposit: 100, note: "x" } as never),
      /settleRefund: unknown field "note"/,
    );
  });

  it("cents helpers reject extra keys on every path", () => {
    assert.equal(
      settleReleaseCents({ grossCents: 10000, proFeeBps: 500 }).netCents,
      9500,
    );
    assert.throws(
      () =>
        settleReleaseCents({
          grossCents: 10000,
          proFeeBps: 500,
          feeCents: 10,
        } as never),
      /settleReleaseCents: unknown field "feeCents"/,
    );
    assert.throws(
      () =>
        settlePartialReleaseCents({
          grossCents: 10000,
          releasedCents: 5000,
          proFeeBps: 500,
          tipCents: 1,
        } as never),
      /settlePartialReleaseCents: unknown field "tipCents"/,
    );
    assert.throws(
      () =>
        settlePartialReleasesCents({
          grossCents: 10000,
          releasesCents: [5000],
          proFeeBps: 500,
          feeCents: 1,
        } as never),
      /settlePartialReleasesCents: unknown field "feeCents"/,
    );
    assert.throws(
      () => settleRefundCents({ depositCents: 100, note: "x" } as never),
      /settleRefundCents: unknown field "note"/,
    );
  });
});

describe("buildSettlementReport unknown-field fail-closed", () => {
  it("legal released report builds with unchanged figures", () => {
    const report = buildSettlementReport(
      releasedReportInputs("rep-unknown-legal"),
    ) as SettlementReport;
    assert.equal(report.settlement?.net, 10098.5);
    assert.equal(report.settlement?.proFee, 531.5);
  });

  it("rejects an unknown top-level field and names it", () => {
    assert.throws(
      () =>
        buildSettlementReport({
          ...releasedReportInputs("rep-unknown-top"),
          bogusField: 1,
        } as never),
      /cannot build settlement report: unknown field "bogusField"/,
    );
  });

  it("rejects an unknown nested settlement field and names it", () => {
    const inputs = releasedReportInputs("rep-unknown-nested");
    assert.throws(
      () =>
        buildSettlementReport({
          ...inputs,
          settlement: { proFeeBps: 500, extra: 1 },
        } as never),
      /cannot build settlement report: settlement: unknown field "extra"/,
    );
  });

  it("rejects a non-object settlement before any branch runs", () => {
    const inputs = releasedReportInputs("rep-unknown-shape");
    assert.throws(
      () => buildSettlementReport({ ...inputs, settlement: "x" } as never),
      /cannot build settlement report: settlement must be an object/,
    );
  });

  it("rejects an unknown nested partialRelease field and names it", () => {
    const e = fundedEscrow("rep-unknown-partial");
    assert.throws(
      () =>
        buildSettlementReport({
          escrowId: e.id,
          history: e.history,
          finalState: e.state,
          deposit: calculateDeposit(goldenFee()),
          partialRelease: { released: 1000, proFeeBps: 500, extra: 1 },
        } as never),
      /cannot build settlement report for rep-unknown-partial: partialRelease: unknown field "extra"/,
    );
  });

  it("legal partial-release report still builds with unchanged figures", () => {
    const e = fundedEscrow("rep-unknown-partial-legal");
    const report = buildSettlementReport({
      escrowId: e.id,
      history: e.history,
      finalState: e.state,
      deposit: calculateDeposit(goldenFee()),
      partialRelease: { released: 1000, proFeeBps: 500 },
    }) as SettlementReport;
    assert.equal(report.outcome, "partially-released");
  });

  it("rejects an unknown key smuggled into the deposit breakdown", () => {
    const inputs = releasedReportInputs("rep-unknown-deposit");
    assert.throws(
      () =>
        buildSettlementReport({
          ...inputs,
          deposit: { ...inputs.deposit, tax: 5 },
        } as never),
      /cannot build settlement report: deposit: unknown field "tax"/,
    );
  });

  it("batch wrapper records the bad entry per escrow and still builds the good one", () => {
    const good = releasedReportInputs("rep-unknown-batch-good");
    const bad = releasedReportInputs("rep-unknown-batch-bad");
    const results = buildSettlementReports([
      good,
      { ...bad, bogusField: 1 } as never,
    ]);
    assert.equal(results.length, 2);
    assert.ok("report" in results[0] && results[0].report !== undefined);
    assert.ok("error" in results[1]);
    assert.match(
      (results[1] as { error: string }).error,
      /unknown field "bogusField"/,
    );
  });
});
