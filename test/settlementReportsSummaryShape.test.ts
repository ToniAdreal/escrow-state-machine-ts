import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementReports,
  calculateDeposit,
  parseSettlementReportJson,
  renderReportJson,
  summarizeSettlementReports,
  type SettlementReport,
  type SettlementReportInputs,
  type SettlementReportResult,
} from "../src/index.js";

// Backlog #1278: `summarizeSettlementReports` is the only public consumer
// of reports that never validated their shape. A hand-built report with an
// unknown outcome used to be summed anyway — its outcome count became
// `NaN` (serialized as `null`) while its `totalInflow` was still added,
// so the party nets no longer summed to zero. Every successful report is
// now shape-checked with the same `assertReportShape` the JSON/CSV
// renderers apply, before any figure is summed. A malformed batch fails
// whole (the #1268 duplicate guard's whole-batch contract): the call throws and returns
// no summary, never a partial one.

function goldenDeposit() {
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
  e.dispatch("FUND", undefined, 10630);
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return e;
}

function refunded(id: string) {
  const e = new Escrow(id);
  e.dispatch("FUND", undefined, 10630);
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_FAIL");
  e.dispatch("ARBITRATE_REFUND");
  return e;
}

function expired(id: string) {
  const e = new Escrow(id);
  e.dispatch("FUND", undefined, 10630);
  e.dispatch("EXPIRE");
  return e;
}

function inputsFor(e: Escrow): SettlementReportInputs {
  return {
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500 },
  };
}

/** A hand-built report in the shape `buildSettlementReport` produces. */
function fakeReport(id: string, amount = 100): SettlementReport {
  return {
    escrowId: id,
    outcome: "refunded",
    deposit: {
      creatorPool: amount,
      baseFee: 0,
      complexityMultiplier: 1,
      loyaltyDiscount: 0,
      oracleFee: 0,
      adjustedBaseFee: 0,
      deposit: amount,
    },
    parties: [
      { party: "sponsor", label: "Sponsor (depositor)", inflow: amount, outflow: amount, net: 0 },
      { party: "creator", label: "Creator (payee)", inflow: 0, outflow: 0, net: 0 },
      { party: "platform", label: "Platform (pro fee)", inflow: 0, outflow: 0, net: 0 },
      { party: "referrer", label: "Referrer (referral credits)", inflow: 0, outflow: 0, net: 0 },
    ],
    totalInflow: amount,
    totalOutflow: amount,
    balanced: true,
    eventCount: 2,
  };
}

function malformed(
  mutate: (report: Record<string, unknown>) => void,
): SettlementReportResult {
  const report = JSON.parse(JSON.stringify(fakeReport("s-bad"))) as Record<
    string,
    unknown
  >;
  mutate(report);
  return { escrowId: "s-bad", report: report as unknown as SettlementReport };
}

function assertShapeError(fn: () => unknown, fragment: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof Error, "must throw an Error");
    assert.ok(!(err instanceof TypeError), "must not be a bare TypeError");
    assert.match(
      err.message,
      /^invalid settlement reports summary: /,
      "error carries the summary prefix",
    );
    assert.ok(
      err.message.includes(fragment),
      `error names the defect ("${fragment}"): ${err.message}`,
    );
    return true;
  });
}

test("unknown outcome throws and yields no summary", () => {
  const bad = malformed((r) => {
    r.outcome = "bogus-outcome";
  });
  assertShapeError(
    () => summarizeSettlementReports([bad]),
    'outcome must be "released", "refunded", "expired", or "partially-released"',
  );
});

test("unknown party role throws (the backlog's escrow-agent case)", () => {
  const bad = malformed((r) => {
    const parties = r.parties as Record<string, unknown>[];
    parties[0].party = "escrow-agent";
    parties[0].inflow = 100;
  });
  assertShapeError(
    () => summarizeSettlementReports([bad]),
    "each party.party must be a PartyRole",
  );
});

test("parties as a string is rejected, not iterated character by character", () => {
  const bad = malformed((r) => {
    r.parties = "not-an-array";
  });
  assertShapeError(
    () => summarizeSettlementReports([bad]),
    "parties must be a non-empty array",
  );
});

test("missing deposit throws a named error, not a TypeError", () => {
  const bad = malformed((r) => {
    delete r.deposit;
  });
  assertShapeError(
    () => summarizeSettlementReports([bad]),
    "deposit must be a FeeBreakdown object",
  );
});

test("non-finite deposit.deposit throws", () => {
  const bad = malformed((r) => {
    (r.deposit as Record<string, unknown>).deposit = Infinity;
  });
  assertShapeError(
    () => summarizeSettlementReports([bad]),
    "deposit.deposit must be a finite number",
  );
});

test("missing totalOutflow throws", () => {
  const bad = malformed((r) => {
    delete r.totalOutflow;
  });
  assertShapeError(
    () => summarizeSettlementReports([bad]),
    "totalOutflow must be a finite number",
  );
});

test("missing totalInflow throws", () => {
  const bad = malformed((r) => {
    delete r.totalInflow;
  });
  assertShapeError(
    () => summarizeSettlementReports([bad]),
    "totalInflow must be a finite number",
  );
});

test("missing balanced flag throws", () => {
  const bad = malformed((r) => {
    delete r.balanced;
  });
  assertShapeError(
    () => summarizeSettlementReports([bad]),
    "balanced must be a boolean",
  );
});

test("missing eventCount throws", () => {
  const bad = malformed((r) => {
    delete r.eventCount;
  });
  assertShapeError(
    () => summarizeSettlementReports([bad]),
    "eventCount must be a non-negative integer",
  );
});

test("non-finite remaining throws", () => {
  const bad = malformed((r) => {
    r.outcome = "partially-released";
    r.remaining = NaN;
  });
  assertShapeError(
    () => summarizeSettlementReports([bad]),
    "remaining must be a finite number when present",
  );
});

test("a bad item in the middle fails the whole batch, never partially", () => {
  // Whole-batch contract (chosen at implementation time, mirroring the #1268
  // duplicate guard): the shape check runs in the pre-pass before any
  // figure is summed, so the call throws and returns no summary — the
  // valid reports around the bad one are not summed either.
  const good1: SettlementReportResult = {
    escrowId: "s-good-1",
    report: fakeReport("s-good-1", 100),
  };
  const good2: SettlementReportResult = {
    escrowId: "s-good-2",
    report: fakeReport("s-good-2", 200),
  };
  const bad = malformed((r) => {
    r.outcome = "bogus-outcome";
  });
  assertShapeError(
    () => summarizeSettlementReports([good1, bad, good2]),
    "outcome must be",
  );
  // The same valid reports on their own still summarize exactly.
  const s = summarizeSettlementReports([good1, good2]);
  assert.equal(s.totalDeposit, 300);
  assert.equal(s.reports, 2);
});

test("legal mixed batch (released/refunded/expired/partially-released) is unchanged", () => {
  const partial = new Escrow("s-partial");
  partial.dispatch("FUND", undefined, 10630);
  const results = buildSettlementReports([
    inputsFor(released("s-rel")),
    inputsFor(refunded("s-ref")),
    inputsFor(expired("s-exp")),
    {
      escrowId: partial.id,
      history: partial.history,
      finalState: partial.state,
      deposit: goldenDeposit(),
      partialRelease: { released: 4252, proFeeBps: 500 },
    },
  ]);
  assert.equal(results.filter((r) => r.report).length, 4);
  const s = summarizeSettlementReports(results);
  assert.equal(s.total, 4);
  assert.equal(s.reports, 4);
  assert.equal(s.errors, 0);
  assert.deepEqual(s.outcomes, {
    released: 1,
    refunded: 1,
    expired: 1,
    "partially-released": 1,
  });
  // Four escrows, each locking the golden deposit 10630.
  assert.equal(s.totalDeposit, 42520);
  assert.equal(s.totalInflow, 42520);
  assert.equal(s.totalOutflow, 42520);
  // Only the partial report still holds money: 10630 - 4252 = 6378.
  assert.equal(s.totalRemaining, 6378);
  assert.equal(s.balanced, true);
  const netSum = s.parties.reduce((acc, p) => acc + p.net, 0);
  // `+ 0` normalizes a possible -0 sum (strict assert.equal treats -0
  // and 0 as different values).
  assert.equal(Math.round(netSum * 100) / 100 + 0, 0);
});

test("error entries are still only counted, never shape-checked", () => {
  const open = new Escrow("s-open");
  open.dispatch("FUND", undefined, 10630);
  const results = buildSettlementReports([
    inputsFor(released("s-rel")),
    inputsFor(open),
  ]);
  const s = summarizeSettlementReports(results);
  assert.equal(s.total, 2);
  assert.equal(s.reports, 1);
  assert.equal(s.errors, 1);
  assert.equal(s.totalDeposit, 10630);
});

test("a report round-tripped through parseSettlementReportJson still summarizes", () => {
  const report = buildSettlementReport(inputsFor(released("s-rt")));
  const parsed = parseSettlementReportJson(renderReportJson(report));
  const s = summarizeSettlementReports([{ escrowId: parsed.escrowId, report: parsed }]);
  assert.equal(s.reports, 1);
  assert.equal(s.totalDeposit, 10630);
  assert.equal(s.outcomes.released, 1);
  assert.equal(s.balanced, true);
});

test("duplicate escrowId still throws the duplicate error, not a shape error", () => {
  const results = buildSettlementReports([
    inputsFor(released("s-dup")),
    inputsFor(refunded("s-other")),
  ]);
  const dup: SettlementReportResult = {
    escrowId: "s-dup",
    report: fakeReport("s-dup", 100),
  };
  assert.throws(
    () => summarizeSettlementReports([...results, dup]),
    /invalid summarizeSettlementReports: duplicate report escrowId: "s-dup"/,
  );
});
