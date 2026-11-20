import test from "node:test";
import assert from "node:assert/strict";
import {
  diffSettlementReportsSummaries,
  type PartyLedger,
  type SettlementCurrencySummary,
  type SettlementReportsSummary,
} from "../src/index.js";

// Backlog #1292: `diffSettlementReportsSummaries` shape-checks both
// inputs first (the escrow-side mirror of dataquest #1276). The diff
// is a comparison, not a validation — it never re-checks the
// total/outcomes sums or the `balanced` self-consistency — but both
// inputs must be summaries at all first. Before this change the diff
// only checked "is it an object" and then read eleven fields straight
// off it, so a record-shaped but field-missing input (e.g.
// `{total: 1}`) threw a bare `TypeError` from `sameOutcomes` /
// `indexParties` / `Object.keys(b.byCurrency)`, a missing field
// diffed as no move (`undefined === undefined`), a wrong-type field
// (e.g. `total: "3"`) silently produced a misleading difference,
// and an unknown outcome tier or party role silently diffed as a
// phantom move.
//
// Rules under test:
//  - `{total: 1}` and `{}` throw the shape error, never a bare
//    TypeError; the error is a plain Error naming the first missing
//    field
//  - a missing field, a wrong-type field, an unknown field, an
//    unknown outcome tier, a missing outcome tier, an unknown party
//    role, a duplicate party role, a short parties array, a
//    non-cent-exact or negative or non-finite money figure, a bad
//    currency code, a malformed currency bucket, and a non-boolean
//    `balanced` all throw, each with the exact shape message
//  - the `a` side is checked first: both sides broken, the error
//    names `a`'s fault
//  - the comparison-not-validation contract does not regress: a
//    shape-valid but self-inconsistent summary (totals that disagree,
//    `balanced: true` over disagreeing inflow/outflow) still diffs
//  - a legal diff is byte-for-byte the old behaviour

const PREFIX = "invalid settlement reports summary diff";

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

/** Assert the diff throws exactly `PREFIX: <reason>`. */
function throwsShape(
  a: unknown,
  b: unknown,
  reason: string,
): void {
  assert.throws(
    () =>
      diffSettlementReportsSummaries(
        a as SettlementReportsSummary,
        b as SettlementReportsSummary,
      ),
    (err: unknown) =>
      err instanceof Error &&
      !(err instanceof TypeError) &&
      err.message === `${PREFIX}: ${reason}`,
  );
}

test("a record-shaped but field-missing input throws the shape error, never a bare TypeError", () => {
  // The backlog's motivating case: `{total: 1}` used to die in
  // `sameOutcomes` with `Cannot read properties of undefined`.
  throwsShape({ total: 1 }, fakeSummary(), 'missing field "reports"');
  throwsShape(fakeSummary(), { total: 1 }, 'missing field "reports"');
});

test("empty objects no longer report a false 'no change'", () => {
  throwsShape({}, {}, 'missing field "total"');
});

test("a missing field on either side throws, naming the field", () => {
  const { reports, ...missingReports } = fakeSummary();
  void reports;
  throwsShape(missingReports, fakeSummary(), 'missing field "reports"');
  const { balanced, ...missingBalanced } = fakeSummary();
  void balanced;
  throwsShape(fakeSummary(), missingBalanced, 'missing field "balanced"');
  const { released, ...missingReleased } = fakeSummary().outcomes;
  void released;
  throwsShape(
    fakeSummary({ outcomes: missingReleased as never }),
    fakeSummary(),
    'missing outcomes field "released"',
  );
});

test("a wrong-type count throws the exact shape error", () => {
  throwsShape(
    fakeSummary({ total: "3" as never }),
    fakeSummary(),
    'total must be a non-negative safe integer, got "3"',
  );
  throwsShape(
    fakeSummary(),
    fakeSummary({ errors: -1 }),
    "errors must be a non-negative safe integer, got -1",
  );
  throwsShape(
    fakeSummary({
      outcomes: { released: 1.5, refunded: 1, expired: 0, "partially-released": 0 },
    }),
    fakeSummary(),
    "outcomes.released must be a non-negative safe integer, got 1.5",
  );
});

test("an unknown top-level field throws, naming the key", () => {
  throwsShape(
    { ...fakeSummary(), batchId: "B-1" },
    fakeSummary(),
    'unknown field "batchId"',
  );
  throwsShape(
    fakeSummary(),
    { ...fakeSummary(), batchId: "B-1" },
    'unknown field "batchId"',
  );
});

test("an unknown outcome tier throws, naming the key", () => {
  throwsShape(
    fakeSummary({
      outcomes: {
        released: 1,
        refunded: 1,
        expired: 0,
        "partially-released": 0,
        voided: 0,
      } as never,
    }),
    fakeSummary(),
    'unknown outcomes field "voided"',
  );
});

test("an unknown party role throws", () => {
  const parties = fakeSummary().parties.map((row) => ({ ...row }));
  parties[3] = { ...parties[3], party: "auditor" as never };
  throwsShape(
    fakeSummary({ parties }),
    fakeSummary(),
    "each party.party must be a PartyRole",
  );
  throwsShape(
    fakeSummary(),
    fakeSummary({ parties }),
    "each party.party must be a PartyRole",
  );
});

test("a duplicate party role throws, naming the role", () => {
  const parties = fakeSummary().parties.map((row) => ({ ...row }));
  parties[3] = { ...parties[1], party: "creator" };
  throwsShape(
    fakeSummary({ parties }),
    fakeSummary(),
    'party role "creator" appears more than once',
  );
});

test("a short parties array throws", () => {
  throwsShape(
    fakeSummary({ parties: fakeSummary().parties.slice(0, 3) }),
    fakeSummary(),
    "parties must be an array of exactly 4 PartyLedger entries",
  );
});

test("a non-cent-exact, negative, or non-finite money figure throws", () => {
  throwsShape(
    fakeSummary({ totalDeposit: 21260.004 }),
    fakeSummary(),
    "totalDeposit must be a cent-exact number, got 21260.004",
  );
  throwsShape(
    fakeSummary(),
    fakeSummary({ totalInflow: -5 }),
    "totalInflow must not be negative, got -5",
  );
  throwsShape(
    fakeSummary({ totalRemaining: Number.NaN }),
    fakeSummary(),
    "totalRemaining must be a finite number, got NaN",
  );
  const parties = fakeSummary().parties.map((row) => ({ ...row }));
  parties[1] = { ...parties[1], inflow: 10098.501 };
  throwsShape(
    fakeSummary({ parties }),
    fakeSummary(),
    "parties.creator.inflow must be a cent-exact number, got 10098.501",
  );
});

test("a bad currency code or a malformed currency bucket throws", () => {
  throwsShape(
    fakeSummary({
      byCurrency: {
        usd: {
          reports: 1,
          totalDeposit: 5000,
          totalInflow: 5000,
          totalOutflow: 5000,
          totalRemaining: 0,
        },
      },
    }),
    fakeSummary(),
    'byCurrency key "usd" must be a 3-letter uppercase ISO 4217 code or "UNSPECIFIED"',
  );
  const bucket = {
    reports: 1,
    totalDeposit: 5000,
    totalInflow: 5000,
    totalOutflow: 5000,
  } as never;
  throwsShape(
    fakeSummary({ byCurrency: { EUR: bucket } }),
    fakeSummary(),
    "missing field byCurrency.EUR.totalRemaining",
  );
});

test("a non-boolean balanced throws", () => {
  throwsShape(
    fakeSummary({ balanced: "yes" as never }),
    fakeSummary(),
    "balanced must be a boolean",
  );
});

test("the a side is checked first: both sides broken, the error names a's fault", () => {
  throwsShape({ total: 1 }, {}, 'missing field "reports"');
  throwsShape(
    fakeSummary({ total: "3" as never }),
    { total: 1 },
    'total must be a non-negative safe integer, got "3"',
  );
});

test("shape-valid but self-inconsistent summaries still diff: comparison, not validation", () => {
  // `total` disagrees with reports + errors, and `balanced` is
  // true over disagreeing inflow/outflow — the diff reports what
  // moved and never re-checks the identities.
  assert.deepEqual(
    diffSettlementReportsSummaries(fakeSummary(), fakeSummary({ total: 5 })),
    { totalChanged: { from: 2, to: 5 } },
  );
  assert.deepEqual(
    diffSettlementReportsSummaries(
      fakeSummary(),
      fakeSummary({ totalInflow: 99999 }),
    ),
    { totalInflowChanged: { from: 21260, to: 99999 } },
  );
});

test("a legal diff is unchanged: identical diffs to {}, one moved field reports only itself", () => {
  assert.deepEqual(
    diffSettlementReportsSummaries(fakeSummary(), fakeSummary()),
    {},
  );
  assert.deepEqual(
    diffSettlementReportsSummaries(
      fakeSummary(),
      fakeSummary({ totalDeposit: 31890 }),
    ),
    { totalDepositChanged: { from: 21260, to: 31890 } },
  );
});
