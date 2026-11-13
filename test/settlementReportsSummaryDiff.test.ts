import test from "node:test";
import assert from "node:assert/strict";
import {
  diffSettlementReportsSummaries,
  summarizeSettlementReports,
  type PartyLedger,
  type SettlementCurrencySummary,
  type SettlementReport,
  type SettlementReportResult,
  type SettlementReportsSummary,
} from "../src/index.js";

// Backlog #1101: `diffSettlementReportsSummaries` answers "what moved
// since the summary I stored last night?" for a whole batch, mirroring
// dataquest's `diffTaskSettlementsSummaries` (#1094) and following this
// file's own `diffSettlementReports` (#1092) for the nested shapes
// (parties by role, currency buckets by code). Counts compare exactly;
// money compares at integer-cent precision, so sub-cent float noise is
// not a change and a one-cent difference is.

const DIFF_MESSAGE =
  "invalid settlement reports summary diff: both summaries must be objects";

function fakeSummary(
  overrides: Partial<SettlementReportsSummary> = {},
): SettlementReportsSummary {
  const parties: PartyLedger[] = [
    {
      party: "sponsor",
      label: "Sponsor (depositor)",
      inflow: 10630,
      outflow: 10630,
      net: 0,
    },
    {
      party: "creator",
      label: "Creator (payee)",
      inflow: 10098.5,
      outflow: 0,
      net: 10098.5,
    },
    {
      party: "platform",
      label: "Platform (pro fee)",
      inflow: 531.5,
      outflow: 0,
      net: 531.5,
    },
    {
      party: "referrer",
      label: "Referrer (referral credits)",
      inflow: 0,
      outflow: 0,
      net: 0,
    },
  ];
  const byCurrency: Record<string, SettlementCurrencySummary> = {
    USD: {
      reports: 2,
      totalDeposit: 21260,
      totalInflow: 21260,
      totalOutflow: 21260,
      totalRemaining: 0,
    },
  };
  return {
    total: 2,
    reports: 2,
    errors: 0,
    outcomes: {
      released: 1,
      refunded: 1,
      expired: 0,
      "partially-released": 0,
    },
    totalDeposit: 21260,
    totalInflow: 21260,
    totalOutflow: 21260,
    totalRemaining: 0,
    parties,
    byCurrency,
    balanced: true,
    ...overrides,
  };
}

function fakeReport(
  id: string,
  opts: { amount?: number; currency?: string; outcome?: "released" | "refunded" } = {},
): SettlementReportResult {
  const amount = opts.amount ?? 10630;
  const report: SettlementReport = {
    escrowId: id,
    outcome: opts.outcome ?? "released",
    deposit: {
      creatorPool: 10000,
      baseFee: 600,
      complexityMultiplier: 1,
      loyaltyDiscount: 0,
      oracleFee: 0,
      adjustedBaseFee: 600,
      deposit: amount,
    },
    parties: [
      {
        party: "sponsor",
        label: "Sponsor (depositor)",
        inflow: amount,
        outflow: amount,
        net: 0,
      },
      {
        party: "creator",
        label: "Creator (payee)",
        inflow: 10098.5,
        outflow: 0,
        net: 10098.5,
      },
      {
        party: "platform",
        label: "Platform (pro fee)",
        inflow: 531.5,
        outflow: 0,
        net: 531.5,
      },
      {
        party: "referrer",
        label: "Referrer (referral credits)",
        inflow: 0,
        outflow: 0,
        net: 0,
      },
    ],
    totalInflow: amount,
    totalOutflow: amount,
    balanced: true,
    eventCount: 4,
  };
  if (opts.currency !== undefined) report.currency = opts.currency;
  return { escrowId: id, report };
}

test("identical summaries diff to {}", () => {
  assert.deepEqual(
    diffSettlementReportsSummaries(fakeSummary(), fakeSummary()),
    {},
  );
});

test("a single count moving reports only that count", () => {
  assert.deepEqual(
    diffSettlementReportsSummaries(fakeSummary(), fakeSummary({ total: 3 })),
    { totalChanged: { from: 2, to: 3 } },
  );
  assert.deepEqual(
    diffSettlementReportsSummaries(
      fakeSummary(),
      fakeSummary({ reports: 1, errors: 1 }),
    ),
    {
      reportsChanged: { from: 2, to: 1 },
      errorsChanged: { from: 0, to: 1 },
    },
  );
});

test("a single money field moving reports only that field", () => {
  assert.deepEqual(
    diffSettlementReportsSummaries(
      fakeSummary(),
      fakeSummary({ totalDeposit: 31890 }),
    ),
    { totalDepositChanged: { from: 21260, to: 31890 } },
  );
});

test("a sub-cent money difference is not a change (cent rule)", () => {
  // 0.004 of drift is raw-float noise, not a moved amount.
  assert.deepEqual(
    diffSettlementReportsSummaries(
      fakeSummary(),
      fakeSummary({ totalDeposit: 21260.004 }),
    ),
    {},
  );
});

test("a one-cent money difference is a change", () => {
  assert.deepEqual(
    diffSettlementReportsSummaries(
      fakeSummary(),
      fakeSummary({ totalDeposit: 21260.01 }),
    ),
    { totalDepositChanged: { from: 21260, to: 21260.01 } },
  );
});

test("one outcome tier moving reports the whole outcomes record", () => {
  const after = fakeSummary({
    outcomes: {
      released: 2,
      refunded: 0,
      expired: 0,
      "partially-released": 0,
    },
  });
  assert.deepEqual(
    diffSettlementReportsSummaries(fakeSummary(), after),
    {
      outcomesChanged: {
        from: {
          released: 1,
          refunded: 1,
          expired: 0,
          "partially-released": 0,
        },
        to: {
          released: 2,
          refunded: 0,
          expired: 0,
          "partially-released": 0,
        },
      },
    },
  );
});

test("a balanced flip is its own entry", () => {
  assert.deepEqual(
    diffSettlementReportsSummaries(
      fakeSummary(),
      fakeSummary({ balanced: false }),
    ),
    { balancedChanged: { from: true, to: false } },
  );
});

test("one party role moving one figure reports that role only", () => {
  const after = fakeSummary();
  after.parties[1] = { ...after.parties[1], outflow: 50, net: 10048.5 };
  assert.deepEqual(
    diffSettlementReportsSummaries(fakeSummary(), after),
    {
      partiesChanged: {
        added: [],
        removed: [],
        changed: [
          {
            role: "creator",
            from: {
              party: "creator",
              label: "Creator (payee)",
              inflow: 10098.5,
              outflow: 0,
              net: 10098.5,
            },
            to: {
              party: "creator",
              label: "Creator (payee)",
              inflow: 10098.5,
              outflow: 50,
              net: 10048.5,
            },
          },
        ],
      },
    },
  );
});

test("a party role present on one side only is added or removed, not dropped", () => {
  const withoutReferrer = fakeSummary();
  withoutReferrer.parties = withoutReferrer.parties.slice(0, 3);
  assert.deepEqual(
    diffSettlementReportsSummaries(fakeSummary(), withoutReferrer),
    {
      partiesChanged: { added: [], removed: ["referrer"], changed: [] },
    },
  );
  assert.deepEqual(
    diffSettlementReportsSummaries(withoutReferrer, fakeSummary()),
    {
      partiesChanged: { added: ["referrer"], removed: [], changed: [] },
    },
  );
});

test("one currency bucket moving one figure reports that bucket only", () => {
  const after = fakeSummary();
  after.byCurrency = {
    USD: { ...after.byCurrency.USD, totalInflow: 22000 },
  };
  assert.deepEqual(
    diffSettlementReportsSummaries(fakeSummary(), after),
    {
      byCurrencyChanged: {
        added: [],
        removed: [],
        changed: [
          {
            currency: "USD",
            from: {
              reports: 2,
              totalDeposit: 21260,
              totalInflow: 21260,
              totalOutflow: 21260,
              totalRemaining: 0,
            },
            to: {
              reports: 2,
              totalDeposit: 21260,
              totalInflow: 22000,
              totalOutflow: 21260,
              totalRemaining: 0,
            },
          },
        ],
      },
    },
  );
});

test("a currency present on one side only reports the whole bucket", () => {
  const withEur = fakeSummary();
  withEur.byCurrency = {
    ...withEur.byCurrency,
    EUR: {
      reports: 1,
      totalDeposit: 5000,
      totalInflow: 5000,
      totalOutflow: 5000,
      totalRemaining: 0,
    },
  };
  assert.deepEqual(
    diffSettlementReportsSummaries(fakeSummary(), withEur),
    {
      byCurrencyChanged: { added: ["EUR"], removed: [], changed: [] },
    },
  );
  const withoutUsd = fakeSummary();
  withoutUsd.byCurrency = {};
  assert.deepEqual(
    diffSettlementReportsSummaries(fakeSummary(), withoutUsd),
    {
      byCurrencyChanged: { added: [], removed: ["USD"], changed: [] },
    },
  );
});

test("two money fields moving by the same amount are both reported (no netting)", () => {
  assert.deepEqual(
    diffSettlementReportsSummaries(
      fakeSummary(),
      fakeSummary({ totalDeposit: 21360, totalInflow: 21360 }),
    ),
    {
      totalDepositChanged: { from: 21260, to: 21360 },
      totalInflowChanged: { from: 21260, to: 21360 },
    },
  );
});

test("empty batch against empty batch diffs to {}; against a settled batch every field moves", () => {
  const empty = summarizeSettlementReports([]);
  assert.deepEqual(diffSettlementReportsSummaries(empty, empty), {});
  const settled = summarizeSettlementReports([
    fakeReport("s-1", { currency: "USD" }),
  ]);
  const diff = diffSettlementReportsSummaries(empty, settled);
  assert.deepEqual(diff.totalChanged, { from: 0, to: 1 });
  assert.deepEqual(diff.reportsChanged, { from: 0, to: 1 });
  assert.deepEqual(diff.outcomesChanged, {
    from: { released: 0, refunded: 0, expired: 0, "partially-released": 0 },
    to: { released: 1, refunded: 0, expired: 0, "partially-released": 0 },
  });
  assert.deepEqual(diff.totalDepositChanged, { from: 0, to: 10630 });
  assert.deepEqual(diff.totalInflowChanged, { from: 0, to: 10630 });
  assert.deepEqual(diff.totalOutflowChanged, { from: 0, to: 10630 });
  // Both summaries are balanced (vacuously true for the empty batch),
  // so no balanced entry appears even though everything else moved.
  assert.equal(diff.balancedChanged, undefined);
  assert.deepEqual(diff.partiesChanged?.changed.map((c) => c.role), [
    "sponsor",
    "creator",
    "platform",
  ]);
  assert.deepEqual(diff.byCurrencyChanged, {
    added: ["USD"],
    removed: [],
    changed: [],
  });
});

test("non-object inputs throw with the #1092-shaped message", () => {
  const good = fakeSummary();
  for (const bad of [null, undefined, "summary", 42, []]) {
    assert.throws(
      () => diffSettlementReportsSummaries(bad as never, good),
      (err: unknown) =>
        err instanceof Error && err.message === DIFF_MESSAGE,
    );
    assert.throws(
      () => diffSettlementReportsSummaries(good, bad as never),
      (err: unknown) =>
        err instanceof Error && err.message === DIFF_MESSAGE,
    );
  }
});

test("pure: inputs are untouched and every diff is a fresh object", () => {
  const a = fakeSummary();
  const b = fakeSummary({ totalDeposit: 31890 });
  const beforeA = JSON.stringify(a);
  const beforeB = JSON.stringify(b);
  const diff1 = diffSettlementReportsSummaries(a, b);
  const diff2 = diffSettlementReportsSummaries(a, b);
  assert.notEqual(diff1, diff2);
  assert.notEqual(diff1.totalDepositChanged, diff2.totalDepositChanged);
  assert.equal(JSON.stringify(a), beforeA);
  assert.equal(JSON.stringify(b), beforeB);
  // Mutating the diff's detached copies must not reach the inputs.
  const c = fakeSummary();
  const d = fakeSummary({
    outcomes: {
      released: 2,
      refunded: 0,
      expired: 0,
      "partially-released": 0,
    },
  });
  const beforeC = JSON.stringify(c);
  const beforeD = JSON.stringify(d);
  const moved = diffSettlementReportsSummaries(c, d);
  if (moved.outcomesChanged !== undefined) {
    moved.outcomesChanged.from.released = 999;
    moved.outcomesChanged.to.released = 999;
  }
  assert.equal(JSON.stringify(c), beforeC);
  assert.equal(JSON.stringify(d), beforeD);
});

test("end to end: the same batch re-summarized after one payout changes diffs exactly the moved fields", () => {
  const batch = [fakeReport("s-1", { currency: "USD" }), fakeReport("s-2", { currency: "USD" })];
  const before = summarizeSettlementReports(batch);
  const rerun = summarizeSettlementReports(batch);
  assert.deepEqual(diffSettlementReportsSummaries(before, rerun), {});
  const changed = [
    fakeReport("s-1", { currency: "USD" }),
    fakeReport("s-2", { currency: "USD", amount: 20000 }),
  ];
  const after = summarizeSettlementReports(changed);
  const diff = diffSettlementReportsSummaries(before, after);
  assert.deepEqual(diff.totalDepositChanged, { from: 21260, to: 30630 });
  assert.deepEqual(diff.totalInflowChanged, { from: 21260, to: 30630 });
  assert.deepEqual(diff.totalOutflowChanged, { from: 21260, to: 30630 });
  assert.equal(diff.totalChanged, undefined);
  assert.equal(diff.reportsChanged, undefined);
  assert.equal(diff.outcomesChanged, undefined);
  assert.equal(diff.balancedChanged, undefined);
  // Only the sponsor row moves: the fixture's creator/platform rows are
  // fixed slices of the original deposit, so they stay put.
  assert.deepEqual(diff.partiesChanged?.changed.map((c) => c.role), [
    "sponsor",
  ]);
  assert.equal(diff.byCurrencyChanged?.changed.length, 1);
  assert.equal(diff.byCurrencyChanged?.changed[0].currency, "USD");
  assert.deepEqual(diff.byCurrencyChanged?.changed[0].to.totalDeposit, 30630);
});
