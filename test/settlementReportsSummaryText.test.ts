import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReports,
  calculateDeposit,
  renderSettlementReportsSummary,
  summarizeSettlementReports,
  type SettlementReportInputs,
  type SettlementReportResult,
  type SettlementReportsSummary,
} from "../src/index.js";

/**
 * The summary CSV/JSON pair carries a batch for machines; an operator
 * pasting a batch into a log or a chat still had to hand-build the
 * string or paste raw JSON. This plain-text renderer closes that gap,
 * mirroring dataquest's `renderTaskSettlements` (#1096) and this
 * repo's single-report `renderReport`: fixed line order, always
 * present rows, money spelled with exactly two decimals.
 */

function goldenDeposit() {
  // Portfolio golden vector: pool $10,000, base $600 × 1.0, loyalty −$30,
  // oracle +$60 → deposit $10,630.
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

function released(id: string) {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return e;
}

function refunded(id: string) {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_FAIL");
  e.dispatch("ARBITRATE_REFUND");
  return e;
}

function funded(id: string) {
  const e = new Escrow(id);
  e.dispatch("FUND", undefined, 10630);
  return e;
}

function inputsFor(e: Escrow, currency?: string): SettlementReportInputs {
  return {
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500 },
    ...(currency !== undefined ? { currency } : {}),
  };
}

function partialInputs(
  e: Escrow,
  releasedAmount: number,
  currency?: string,
): SettlementReportInputs {
  return {
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: goldenDeposit(),
    partialRelease: { released: releasedAmount, proFeeBps: 500 },
    ...(currency !== undefined ? { currency } : {}),
  };
}

/**
 * The golden batch (same batch as the CSV/JSON tests): one released
 * USD, one refunded EUR, one partial USD slice of 4252 (proFee
 * 212.60, net 4039.40, 6378 still locked), and one still-open escrow
 * that fails to report (the error entry). Figures hand-computed from
 * the report ledgers, not captured from output — see the CSV/JSON
 * test's comment for the arithmetic.
 */
function goldenResults(): SettlementReportResult[] {
  const open = new Escrow("g-open");
  open.dispatch("FUND");
  return buildSettlementReports([
    inputsFor(released("g-rel"), "USD"),
    inputsFor(refunded("g-ref"), "EUR"),
    partialInputs(funded("g-par"), 4252, "USD"),
    inputsFor(open),
  ]);
}

function goldenSummary(): SettlementReportsSummary {
  return summarizeSettlementReports(goldenResults());
}

const UNITS_LINE =
  "Amounts are in the reports' currency units, shown with two decimals; top-level totals sum figures across currencies — read the per-currency rows for single-currency money.";

test("mixed-currency batch renders byte-exact golden text", () => {
  assert.equal(
    renderSettlementReportsSummary(goldenSummary()),
    [
      "Settlement reports summary",
      "Reports: 3 (errors: 1)",
      "Released: 1",
      "Refunded: 1",
      "Expired: 0",
      "Partially-released: 1",
      "Total deposit: 31890.00",
      "Total inflow: 31890.00",
      "Total outflow: 31890.00",
      "Total remaining: 6378.00",
      "Sponsor (depositor): inflow 17008.00, outflow 31890.00, net -14882.00",
      "Creator (payee): inflow 14137.90, outflow 0.00, net 14137.90",
      "Platform (pro fee): inflow 744.10, outflow 0.00, net 744.10",
      "Referrer (referral credits): inflow 0.00, outflow 0.00, net 0.00",
      "EUR: 1 report, deposit 10630.00, inflow 10630.00, outflow 10630.00, remaining 0.00",
      "USD: 2 reports, deposit 21260.00, inflow 21260.00, outflow 21260.00, remaining 6378.00",
      "Balanced: true",
      UNITS_LINE,
    ].join("\n"),
  );
});

test("empty batch renders an explicit all-zero position", () => {
  assert.equal(
    renderSettlementReportsSummary(summarizeSettlementReports([])),
    [
      "Settlement reports summary",
      "Reports: 0 (errors: 0)",
      "Released: 0",
      "Refunded: 0",
      "Expired: 0",
      "Partially-released: 0",
      "Total deposit: 0.00",
      "Total inflow: 0.00",
      "Total outflow: 0.00",
      "Total remaining: 0.00",
      "Sponsor (depositor): inflow 0.00, outflow 0.00, net 0.00",
      "Creator (payee): inflow 0.00, outflow 0.00, net 0.00",
      "Platform (pro fee): inflow 0.00, outflow 0.00, net 0.00",
      "Referrer (referral credits): inflow 0.00, outflow 0.00, net 0.00",
      "Balanced: true",
      UNITS_LINE,
    ].join("\n"),
  );
});

test("all-error batch renders with no currency rows", () => {
  const open = new Escrow("e-open");
  open.dispatch("FUND");
  const summary = summarizeSettlementReports(
    buildSettlementReports([inputsFor(open)]),
  );
  assert.equal(summary.errors, 1);
  assert.equal(
    renderSettlementReportsSummary(summary),
    [
      "Settlement reports summary",
      "Reports: 0 (errors: 1)",
      "Released: 0",
      "Refunded: 0",
      "Expired: 0",
      "Partially-released: 0",
      "Total deposit: 0.00",
      "Total inflow: 0.00",
      "Total outflow: 0.00",
      "Total remaining: 0.00",
      "Sponsor (depositor): inflow 0.00, outflow 0.00, net 0.00",
      "Creator (payee): inflow 0.00, outflow 0.00, net 0.00",
      "Platform (pro fee): inflow 0.00, outflow 0.00, net 0.00",
      "Referrer (referral credits): inflow 0.00, outflow 0.00, net 0.00",
      "Balanced: true",
      UNITS_LINE,
    ].join("\n"),
  );
});

test("currency-less reports render under the UNSPECIFIED bucket", () => {
  const summary = summarizeSettlementReports(
    buildSettlementReports([inputsFor(released("u-rel"))]),
  );
  const rendered = renderSettlementReportsSummary(summary);
  assert.ok(
    rendered.includes(
      "UNSPECIFIED: 1 report, deposit 10630.00, inflow 10630.00, outflow 10630.00, remaining 0.00",
    ),
  );
  assert.ok(!rendered.includes("USD:"));
  assert.ok(!rendered.includes("EUR:"));
});

test("line order is fixed: title, counts, outcomes, money, parties, currency, balanced, units", () => {
  const lines = renderSettlementReportsSummary(goldenSummary()).split("\n");
  const starts = lines.map((line) => line.split(":")[0]);
  assert.deepEqual(starts, [
    "Settlement reports summary",
    "Reports",
    "Released",
    "Refunded",
    "Expired",
    "Partially-released",
    "Total deposit",
    "Total inflow",
    "Total outflow",
    "Total remaining",
    "Sponsor (depositor)",
    "Creator (payee)",
    "Platform (pro fee)",
    "Referrer (referral credits)",
    "EUR",
    "USD",
    "Balanced",
    "Amounts are in the reports' currency units, shown with two decimals; top-level totals sum figures across currencies — read the per-currency rows for single-currency money.",
  ]);
});

test("rendering twice yields byte-identical text", () => {
  const summary = goldenSummary();
  assert.equal(
    renderSettlementReportsSummary(summary),
    renderSettlementReportsSummary(summary),
  );
});

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

test("rendering never mutates the summary, even when frozen", () => {
  const summary = deepFreeze(goldenSummary());
  const before = JSON.stringify(summary);
  renderSettlementReportsSummary(summary);
  assert.equal(JSON.stringify(summary), before);
});

test("real summarize output renders end to end", () => {
  const rendered = renderSettlementReportsSummary(goldenSummary());
  assert.ok(rendered.startsWith("Settlement reports summary\n"));
  assert.ok(rendered.includes("Reports: 3 (errors: 1)"));
  assert.ok(rendered.includes("Total remaining: 6378.00"));
  assert.ok(rendered.endsWith(UNITS_LINE));
});

const INVALID: Array<[string, (s: SettlementReportsSummary) => unknown]> = [
  ["non-object summary", () => null],
  [
    "unknown field",
    (s) => ({ ...s, surprise: 1 }),
  ],
  [
    "non-integer count",
    (s) => ({ ...s, reports: 1.5 }),
  ],
  [
    "non-cent-exact money figure",
    (s) => ({ ...s, totalDeposit: 100.001 }),
  ],
  [
    "total that does not equal reports + errors",
    (s) => ({ ...s, total: 99 }),
  ],
  [
    "outcome counts that do not sum to reports",
    (s) => ({ ...s, outcomes: { ...s.outcomes, released: 99 } }),
  ],
  [
    "party net that does not equal inflow - outflow",
    (s) => ({
      ...s,
      parties: s.parties.map((p) =>
        p.party === "sponsor" ? { ...p, net: 0 } : p,
      ),
    }),
  ],
];

for (const [name, mutate] of INVALID) {
  test(`invalid summary (${name}) throws with the render prefix`, () => {
    assert.throws(
      () => renderSettlementReportsSummary(mutate(goldenSummary()) as never),
      (err: unknown) =>
        err instanceof Error &&
        err.message.startsWith("cannot render settlement reports summary: "),
    );
  });
}
