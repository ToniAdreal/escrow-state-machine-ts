import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReports,
  calculateDeposit,
  parseSettlementReportsSummaryCsv,
  parseSettlementReportsSummaryJson,
  renderSettlementReportsSummaryCsv,
  renderSettlementReportsSummaryJson,
  summarizeSettlementReports,
  UNSPECIFIED_SETTLEMENT_CURRENCY,
  type SettlementReportInputs,
  type SettlementReportResult,
  type SettlementReportsSummary,
} from "../src/index.js";

/**
 * `summarizeSettlementReports` had no wire form: a batch summary could
 * only travel as an in-memory object, so a caller doing reconciliation
 * had to hand-write the export. These renderers/parsers close that gap
 * in the same strict style as the single-report CSV/JSON pair — the
 * dataquest `#1079` summary pair is the mirror on the other side.
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

function expired(id: string) {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("EXPIRE");
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
 * The golden batch: one released USD, one refunded EUR, one partial
 * USD slice of 4252 (proFee 212.60, net 4039.40, 6378 still locked),
 * and one still-open escrow that fails to report (the error entry).
 * Hand-computed from the report ledgers, not captured from output:
 * - released USD: sponsor (0, 10630), creator (10098.50, 0), platform
 *   (531.50, 0); refunded EUR: sponsor (10630, 10630), others 0;
 *   partial USD: sponsor (6378, 10630), creator (4039.40, 0), platform
 *   (212.60, 0).
 * - Batch parties: sponsor inflow 0 + 10630 + 6378 = 17008, outflow
 *   3 × 10630 = 31890, net −14882; creator 10098.50 + 4039.40 =
 *   14137.90; platform 531.50 + 212.60 = 744.10; referrer 0.
 * - Buckets: EUR 1 report at 10630; USD 2 reports at 21260 with
 *   6378 still locked.
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

const GOLDEN_CSV = [
  "section,key,count,total,reports,errors,totalDeposit,totalInflow,totalOutflow,totalRemaining,net,balanced",
  "summary,,,4,3,1,31890.00,31890.00,31890.00,6378.00,,true",
  "outcome,released,1,,,,,,,,,",
  "outcome,refunded,1,,,,,,,,,",
  "outcome,expired,0,,,,,,,,,",
  "outcome,partially-released,1,,,,,,,,,",
  "party,sponsor,,,,,,17008.00,31890.00,,-14882.00,",
  "party,creator,,,,,,14137.90,0.00,,14137.90,",
  "party,platform,,,,,,744.10,0.00,,744.10,",
  "party,referrer,,,,,,0.00,0.00,,0.00,",
  "currency,EUR,1,,,,10630.00,10630.00,10630.00,0.00,,",
  "currency,USD,2,,,,21260.00,21260.00,21260.00,6378.00,,",
].join("\n");

const GOLDEN_JSON =
  '{"total":4,"reports":3,"errors":1,"outcomes":{"released":1,"refunded":1,"expired":0,"partially-released":1},"totalDeposit":31890,"totalInflow":31890,"totalOutflow":31890,"totalRemaining":6378,"parties":[{"party":"sponsor","label":"Sponsor (depositor)","inflow":17008,"outflow":31890,"net":-14882},{"party":"creator","label":"Creator (payee)","inflow":14137.9,"outflow":0,"net":14137.9},{"party":"platform","label":"Platform (pro fee)","inflow":744.1,"outflow":0,"net":744.1},{"party":"referrer","label":"Referrer (referral credits)","inflow":0,"outflow":0,"net":0}],"byCurrency":{"EUR":{"reports":1,"totalDeposit":10630,"totalInflow":10630,"totalOutflow":10630,"totalRemaining":0},"USD":{"reports":2,"totalDeposit":21260,"totalInflow":21260,"totalOutflow":21260,"totalRemaining":6378}},"balanced":true}';

test("golden batch: summary fields match hand-computed expectations", () => {
  const s = goldenSummary();
  assert.equal(s.total, 4);
  assert.equal(s.reports, 3);
  assert.equal(s.errors, 1);
  assert.deepEqual(s.outcomes, {
    released: 1,
    refunded: 1,
    expired: 0,
    "partially-released": 1,
  });
  assert.equal(s.totalDeposit, 31890);
  assert.equal(s.totalInflow, 31890);
  assert.equal(s.totalOutflow, 31890);
  assert.equal(s.totalRemaining, 6378);
  assert.deepEqual(s.parties, [
    {
      party: "sponsor",
      label: "Sponsor (depositor)",
      inflow: 17008,
      outflow: 31890,
      net: -14882,
    },
    {
      party: "creator",
      label: "Creator (payee)",
      inflow: 14137.9,
      outflow: 0,
      net: 14137.9,
    },
    {
      party: "platform",
      label: "Platform (pro fee)",
      inflow: 744.1,
      outflow: 0,
      net: 744.1,
    },
    {
      party: "referrer",
      label: "Referrer (referral credits)",
      inflow: 0,
      outflow: 0,
      net: 0,
    },
  ]);
  assert.deepEqual(s.byCurrency, {
    EUR: {
      reports: 1,
      totalDeposit: 10630,
      totalInflow: 10630,
      totalOutflow: 10630,
      totalRemaining: 0,
    },
    USD: {
      reports: 2,
      totalDeposit: 21260,
      totalInflow: 21260,
      totalOutflow: 21260,
      totalRemaining: 6378,
    },
  });
  assert.equal(s.balanced, true);
});

test("golden batch: CSV renders byte-exactly", () => {
  assert.equal(renderSettlementReportsSummaryCsv(goldenSummary()), GOLDEN_CSV);
});

test("golden batch: JSON renders byte-exactly in canonical key order", () => {
  assert.equal(renderSettlementReportsSummaryJson(goldenSummary()), GOLDEN_JSON);
});

test("CSV round-trip: parse(render(s)) === s and re-render is byte-identical", () => {
  const s = goldenSummary();
  const csv = renderSettlementReportsSummaryCsv(s);
  assert.deepEqual(parseSettlementReportsSummaryCsv(csv), s);
  assert.equal(renderSettlementReportsSummaryCsv(parseSettlementReportsSummaryCsv(csv)), csv);
  assert.equal(renderSettlementReportsSummaryCsv(s), csv);
});

test("JSON round-trip: parse(render(s)) === s and re-render is byte-identical", () => {
  const s = goldenSummary();
  const json = renderSettlementReportsSummaryJson(s);
  assert.deepEqual(parseSettlementReportsSummaryJson(json), s);
  assert.equal(renderSettlementReportsSummaryJson(parseSettlementReportsSummaryJson(json)), json);
  assert.equal(renderSettlementReportsSummaryJson(s), json);
});

test("rendering never mutates the summary; parsing returns independent copies", () => {
  const s = goldenSummary();
  const before = JSON.stringify(s);
  renderSettlementReportsSummaryCsv(s);
  renderSettlementReportsSummaryJson(s);
  assert.equal(JSON.stringify(s), before);
  const csv = renderSettlementReportsSummaryCsv(s);
  const first = parseSettlementReportsSummaryCsv(csv);
  const second = parseSettlementReportsSummaryCsv(csv);
  first.parties[0].inflow = -1;
  first.byCurrency.USD.totalDeposit = -1;
  assert.equal(second.parties[0].inflow, 17008);
  assert.equal(second.byCurrency.USD.totalDeposit, 21260);
  const json = renderSettlementReportsSummaryJson(s);
  const firstJson = parseSettlementReportsSummaryJson(json);
  const secondJson = parseSettlementReportsSummaryJson(json);
  firstJson.totalDeposit = -1;
  assert.equal(secondJson.totalDeposit, 31890);
});

test("empty batch: golden CSV/JSON and round-trip", () => {
  const s = summarizeSettlementReports([]);
  const expectedCsv = [
    "section,key,count,total,reports,errors,totalDeposit,totalInflow,totalOutflow,totalRemaining,net,balanced",
    "summary,,,0,0,0,0.00,0.00,0.00,0.00,,true",
    "outcome,released,0,,,,,,,,,",
    "outcome,refunded,0,,,,,,,,,",
    "outcome,expired,0,,,,,,,,,",
    "outcome,partially-released,0,,,,,,,,,",
    "party,sponsor,,,,,,0.00,0.00,,0.00,",
    "party,creator,,,,,,0.00,0.00,,0.00,",
    "party,platform,,,,,,0.00,0.00,,0.00,",
    "party,referrer,,,,,,0.00,0.00,,0.00,",
  ].join("\n");
  const expectedJson =
    '{"total":0,"reports":0,"errors":0,"outcomes":{"released":0,"refunded":0,"expired":0,"partially-released":0},"totalDeposit":0,"totalInflow":0,"totalOutflow":0,"totalRemaining":0,"parties":[{"party":"sponsor","label":"Sponsor (depositor)","inflow":0,"outflow":0,"net":0},{"party":"creator","label":"Creator (payee)","inflow":0,"outflow":0,"net":0},{"party":"platform","label":"Platform (pro fee)","inflow":0,"outflow":0,"net":0},{"party":"referrer","label":"Referrer (referral credits)","inflow":0,"outflow":0,"net":0}],"byCurrency":{},"balanced":true}';
  assert.equal(renderSettlementReportsSummaryCsv(s), expectedCsv);
  assert.equal(renderSettlementReportsSummaryJson(s), expectedJson);
  assert.deepEqual(parseSettlementReportsSummaryCsv(expectedCsv), s);
  assert.deepEqual(parseSettlementReportsSummaryJson(expectedJson), s);
});

test("all-error batch: no currency rows, balanced vacuously true", () => {
  const open1 = new Escrow("e-one");
  open1.dispatch("FUND");
  const open2 = new Escrow("e-two");
  open2.dispatch("FUND");
  const s = summarizeSettlementReports(
    buildSettlementReports([inputsFor(open1), inputsFor(open2)]),
  );
  assert.equal(s.total, 2);
  assert.equal(s.reports, 0);
  assert.equal(s.errors, 2);
  assert.deepEqual(s.byCurrency, {});
  assert.equal(s.balanced, true);
  const csv = renderSettlementReportsSummaryCsv(s);
  assert.equal(csv.split("\n").length, 10);
  assert.ok(!csv.includes("currency,"));
  assert.deepEqual(parseSettlementReportsSummaryCsv(csv), s);
  assert.deepEqual(
    parseSettlementReportsSummaryJson(renderSettlementReportsSummaryJson(s)),
    s,
  );
});

test("UNSPECIFIED bucket: currency-less reports sort among real codes", () => {
  const s = summarizeSettlementReports(
    buildSettlementReports([
      inputsFor(released("u-usd"), "USD"),
      inputsFor(released("u-none")),
      inputsFor(refunded("u-eur"), "EUR"),
    ]),
  );
  // The raw summary keeps first-seen bucket order (USD, then the
  // currency-less report, then EUR); the renderers sort alphabetically.
  assert.deepEqual(Object.keys(s.byCurrency), ["USD", "UNSPECIFIED", "EUR"]);
  assert.equal(s.byCurrency[UNSPECIFIED_SETTLEMENT_CURRENCY].reports, 1);
  const csv = renderSettlementReportsSummaryCsv(s);
  const currencyRows = csv.split("\n").filter((line) => line.startsWith("currency,"));
  assert.deepEqual(
    currencyRows.map((line) => line.split(",")[1]),
    ["EUR", "UNSPECIFIED", "USD"],
  );
  assert.ok(currencyRows[1].startsWith(`currency,${UNSPECIFIED_SETTLEMENT_CURRENCY},1,`));
  assert.deepEqual(parseSettlementReportsSummaryCsv(csv), s);
  const parsedJson = parseSettlementReportsSummaryJson(
    renderSettlementReportsSummaryJson(s),
  );
  assert.deepEqual(Object.keys(parsedJson.byCurrency), ["EUR", "UNSPECIFIED", "USD"]);
  assert.deepEqual(parsedJson, s);
});

test("CSV transport tolerance: BOM, CRLF, trailing newline, blank lines, quoted fields", () => {
  const s = goldenSummary();
  const csv = renderSettlementReportsSummaryCsv(s);
  const transported =
    "\uFEFF" +
    csv.replace(/\n/g, "\r\n") +
    "\r\n\r\n\n";
  assert.deepEqual(parseSettlementReportsSummaryCsv(transported), s);
  assert.equal(
    renderSettlementReportsSummaryCsv(parseSettlementReportsSummaryCsv(transported)),
    csv,
  );
  // Quoted section/key fields are transport, not content.
  const quoted = csv.replace("currency,EUR,", '"currency","EUR",');
  assert.deepEqual(parseSettlementReportsSummaryCsv(quoted), s);
});

test("JSON accepts arbitrary key order and re-renders canonical", () => {
  const s = goldenSummary();
  const shuffled = {
    balanced: s.balanced,
    byCurrency: s.byCurrency,
    parties: s.parties,
    totalRemaining: s.totalRemaining,
    totalOutflow: s.totalOutflow,
    totalInflow: s.totalInflow,
    totalDeposit: s.totalDeposit,
    outcomes: {
      "partially-released": 1,
      expired: 0,
      refunded: 1,
      released: 1,
    },
    errors: s.errors,
    reports: s.reports,
    total: s.total,
  };
  const text = JSON.stringify(shuffled);
  assert.notEqual(text, renderSettlementReportsSummaryJson(s));
  assert.deepEqual(parseSettlementReportsSummaryJson(text), s);
  assert.equal(
    renderSettlementReportsSummaryJson(parseSettlementReportsSummaryJson(text)),
    renderSettlementReportsSummaryJson(s),
  );
});

test("JSON preserves the caller's party order (arrays are content)", () => {
  const s = goldenSummary();
  const reordered = { ...s, parties: [...s.parties].reverse() };
  const text = renderSettlementReportsSummaryJson(reordered);
  const parsed = parseSettlementReportsSummaryJson(text);
  assert.deepEqual(
    parsed.parties.map((p) => p.party),
    ["referrer", "platform", "creator", "sponsor"],
  );
  assert.equal(renderSettlementReportsSummaryJson(parsed), text);
});

/** Replace one line of a CSV table (0-based) with a new line. */
function withCsvLine(csv: string, index: number, line: string): string {
  const lines = csv.split("\n");
  lines[index] = line;
  return lines.join("\n");
}

test("CSV rejects malformed tables", () => {
  const csv = GOLDEN_CSV;
  const cases: [string, string][] = [
    ["bad header", csv.replace("section,key,", "section,keey,")],
    [
      "wrong column count",
      withCsvLine(csv, 2, "outcome,released,1,,,,,,,,"),
    ],
    ["too few records", csv.split("\n").slice(0, 9).join("\n")],
    [
      "summary total disagrees with reports + errors",
      withCsvLine(csv, 1, "summary,,,5,3,1,31890.00,31890.00,31890.00,6378.00,,true"),
    ],
    [
      "outcome counts do not sum to reports",
      withCsvLine(csv, 2, "outcome,released,2,,,,,,,,,"),
    ],
    [
      "party net disagrees with inflow minus outflow",
      withCsvLine(csv, 6, "party,sponsor,,,,,,17008.00,31890.00,,-14881.00,"),
    ],
    [
      "party inflows do not sum to totalInflow",
      withCsvLine(csv, 7, "party,creator,,,,,,14137.80,0.00,,14137.80,"),
    ],
    [
      "currency buckets do not sum to totalRemaining",
      withCsvLine(csv, 11, "currency,USD,2,,,,21260.00,21260.00,21260.00,6377.00,,"),
    ],
    [
      "currency buckets do not sum to reports",
      withCsvLine(csv, 10, "currency,EUR,2,,,,10630.00,10630.00,10630.00,0.00,,"),
    ],
    [
      "currency rows out of alphabetical order",
      [csv.split("\n")[0], ...csv.split("\n").slice(1, 10), csv.split("\n")[11], csv.split("\n")[10]].join("\n"),
    ],
    [
      "duplicate currency row",
      csv + "\ncurrency,USD,2,,,,21260.00,21260.00,21260.00,6378.00,,",
    ],
    [
      "money not two-decimal",
      withCsvLine(csv, 1, "summary,,,4,3,1,31890.0,31890.00,31890.00,6378.00,,true"),
    ],
    [
      "count not a canonical integer",
      withCsvLine(csv, 2, "outcome,released,01,,,,,,,,,"),
    ],
    [
      "negative count",
      withCsvLine(csv, 2, "outcome,released,-1,,,,,,,,,"),
    ],
    [
      "non-empty cell where empty is required",
      withCsvLine(csv, 1, "summary,,,4,3,1,31890.00,31890.00,31890.00,6378.00,0.00,true"),
    ],
    [
      "unknown section",
      withCsvLine(csv, 1, "totals,,,4,3,1,31890.00,31890.00,31890.00,6378.00,,true"),
    ],
    [
      "outcome rows in the wrong order",
      [csv.split("\n")[0], csv.split("\n")[1], csv.split("\n")[3], csv.split("\n")[2], ...csv.split("\n").slice(4)].join("\n"),
    ],
    [
      "party rows in the wrong order",
      [csv.split("\n")[0], ...csv.split("\n").slice(1, 7), csv.split("\n")[8], csv.split("\n")[7], ...csv.split("\n").slice(9)].join("\n"),
    ],
    [
      "currency key is not a code",
      withCsvLine(csv, 10, "currency,usd,1,,,,10630.00,10630.00,10630.00,0.00,,"),
    ],
    [
      "balanced is not true/false",
      withCsvLine(csv, 1, "summary,,,4,3,1,31890.00,31890.00,31890.00,6378.00,,yes"),
    ],
    [
      "negative money",
      withCsvLine(csv, 10, "currency,EUR,1,,,,-10630.00,10630.00,10630.00,0.00,,"),
    ],
  ];
  for (const [name, bad] of cases) {
    assert.throws(
      () => parseSettlementReportsSummaryCsv(bad),
      /cannot parse settlement reports summary CSV/,
      name,
    );
  }
  assert.throws(
    () => parseSettlementReportsSummaryCsv(42 as unknown as string),
    /cannot parse settlement reports summary CSV: input must be a CSV string/,
  );
});

test("CSV rejects a balanced:true claim over disagreeing totals", () => {
  // Every other identity holds here: party inflows sum to 10630,
  // party outflows sum to 10631, the USD bucket agrees with both —
  // only the balanced claim is impossible, and only it must fail.
  const lines = [
    "section,key,count,total,reports,errors,totalDeposit,totalInflow,totalOutflow,totalRemaining,net,balanced",
    "summary,,,1,1,0,10630.00,10630.00,10631.00,0.00,,true",
    "outcome,released,1,,,,,,,,,",
    "outcome,refunded,0,,,,,,,,,",
    "outcome,expired,0,,,,,,,,,",
    "outcome,partially-released,0,,,,,,,,,",
    "party,sponsor,,,,,,0.00,10631.00,,-10631.00,",
    "party,creator,,,,,,10098.50,0.00,,10098.50,",
    "party,platform,,,,,,531.50,0.00,,531.50,",
    "party,referrer,,,,,,0.00,0.00,,0.00,",
    "currency,USD,1,,,,10630.00,10630.00,10631.00,0.00,,",
  ].join("\n");
  assert.throws(
    () => parseSettlementReportsSummaryCsv(lines),
    /balanced is true but totalInflow 10630 does not equal totalOutflow 10631/,
  );
  // The same table with balanced:false parses: two unbalanced reports
  // could cancel, so the table alone cannot disprove the claim.
  const unbalanced = lines.replace(",10631.00,0.00,,true", ",10631.00,0.00,,false");
  assert.equal(parseSettlementReportsSummaryCsv(unbalanced).balanced, false);
});

test("JSON rejects malformed documents", () => {
  const s = goldenSummary();
  const mutate = (fn: (obj: Record<string, unknown>) => void): string => {
    const obj = JSON.parse(renderSettlementReportsSummaryJson(s)) as Record<
      string,
      unknown
    >;
    fn(obj);
    return JSON.stringify(obj);
  };
  const cases: [string, string][] = [
    ["invalid JSON", "{"],
    ["array, not an object", "[]"],
    ["number, not an object", "42"],
    ["missing field", mutate((o) => delete o.balanced)],
    ["unknown field", mutate((o) => (o.extra = 1))],
    ["non-integer count", mutate((o) => (o.reports = 1.5))],
    ["unsafe integer count", mutate((o) => (o.reports = 2 ** 53))],
    ["negative total", mutate((o) => (o.total = -1))],
    [
      "money with three decimals",
      mutate((o) => (o.totalDeposit = 31890.001)),
    ],
    ["string money", mutate((o) => (o.totalDeposit = "31890"))],
    ["null money", mutate((o) => (o.totalDeposit = null))],
    [
      "outcomes missing a key",
      mutate((o) => {
        const outcomes = o.outcomes as Record<string, unknown>;
        delete outcomes.expired;
      }),
    ],
    [
      "outcomes with an unknown key",
      mutate((o) => {
        (o.outcomes as Record<string, unknown>).settled = 0;
      }),
    ],
    [
      "parties with a duplicate role",
      mutate((o) => {
        const parties = o.parties as Record<string, unknown>[];
        parties[1].party = "sponsor";
      }),
    ],
    [
      "parties with only three entries",
      mutate((o) => {
        (o.parties as unknown[]).pop();
      }),
    ],
    [
      "byCurrency with a bad code",
      mutate((o) => {
        const byCurrency = o.byCurrency as Record<string, unknown>;
        byCurrency.usd = byCurrency.USD;
        delete byCurrency.USD;
      }),
    ],
    [
      "bucket money sum disagrees with the top level",
      mutate((o) => {
        const byCurrency = o.byCurrency as Record<string, { totalRemaining: number }>;
        byCurrency.USD.totalRemaining = 6377;
      }),
    ],
    [
      "total disagrees with reports + errors",
      mutate((o) => (o.total = 5)),
    ],
    [
      "outcome counts do not sum to reports",
      mutate((o) => {
        (o.outcomes as Record<string, number>).released = 2;
      }),
    ],
    [
      "party net disagrees with inflow minus outflow",
      mutate((o) => {
        const parties = o.parties as Record<string, unknown>[];
        parties[0].net = -14881;
      }),
    ],
    ["Infinity money", '{"total":1,"reports":1,"errors":0,"outcomes":{"released":1,"refunded":0,"expired":0,"partially-released":0},"totalDeposit":1e999,"totalInflow":0,"totalOutflow":0,"totalRemaining":0,"parties":[{"party":"sponsor","label":"Sponsor (depositor)","inflow":0,"outflow":0,"net":0},{"party":"creator","label":"Creator (payee)","inflow":0,"outflow":0,"net":0},{"party":"platform","label":"Platform (pro fee)","inflow":0,"outflow":0,"net":0},{"party":"referrer","label":"Referrer (referral credits)","inflow":0,"outflow":0,"net":0}],"byCurrency":{},"balanced":true}'],
  ];
  for (const [name, bad] of cases) {
    assert.throws(
      () => parseSettlementReportsSummaryJson(bad),
      /cannot parse settlement reports summary JSON/,
      name,
    );
  }
  assert.throws(
    () => parseSettlementReportsSummaryJson(42 as unknown as string),
    /cannot parse settlement reports summary JSON: input must be a JSON string/,
  );
});

test("JSON rejects a balanced:true claim over disagreeing totals", () => {
  const doc = JSON.parse(GOLDEN_JSON) as Record<string, unknown>;
  doc.totalOutflow = 31891;
  const parties = doc.parties as Record<string, unknown>[];
  parties[0].outflow = 31891;
  parties[0].net = -14883;
  const byCurrency = doc.byCurrency as Record<string, Record<string, unknown>>;
  byCurrency.USD.totalOutflow = 21261;
  byCurrency.EUR.totalOutflow = 10630;
  assert.throws(
    () => parseSettlementReportsSummaryJson(JSON.stringify(doc)),
    /balanced is true but totalInflow 31890 does not equal totalOutflow 31891/,
  );
});

test("renderers reject malformed summaries with the render prefix", () => {
  const s = goldenSummary();
  const badTotal = { ...s, total: 5 };
  assert.throws(
    () => renderSettlementReportsSummaryCsv(badTotal),
    /cannot render settlement reports summary as CSV: total 5 does not equal reports 3 plus errors 1/,
  );
  assert.throws(
    () => renderSettlementReportsSummaryJson(badTotal),
    /cannot render settlement reports summary as JSON: total 5 does not equal reports 3 plus errors 1/,
  );
  const badField = { ...s, extra: 1 };
  assert.throws(
    () => renderSettlementReportsSummaryCsv(badField),
    /cannot render settlement reports summary as CSV: unknown field "extra"/,
  );
  assert.throws(
    () => renderSettlementReportsSummaryJson(badField),
    /cannot render settlement reports summary as JSON: unknown field "extra"/,
  );
  const badMoney = { ...s, totalDeposit: 31890.001 };
  assert.throws(
    () => renderSettlementReportsSummaryCsv(badMoney),
    /cannot render settlement reports summary as CSV: totalDeposit must be a cent-exact number/,
  );
  assert.throws(
    () => renderSettlementReportsSummaryJson(badMoney),
    /cannot render settlement reports summary as JSON: totalDeposit must be a cent-exact number/,
  );
});
