import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  calculateDeposit,
  diffSettlementReports,
  type SettlementReport,
} from "../src/index.js";

// Backlog #1293: `diffSettlementReports` shape-checks both inputs
// first (the single-report mirror of #1292's summary diff). The diff
// is a comparison, not a validation — it never re-checks that either
// report's figures are internally consistent, that its history chain
// holds, or that its totals sum — but both inputs must be reports at
// all first. Before this change the diff only checked "is it an
// object" plus matching `escrowId` and then read the fields straight
// off it, so a report missing `deposit` threw a bare `TypeError` from
// `sameFeeBreakdown` (reading `undefined.creatorPool`), a report
// missing `parties` threw a bare `TypeError` from `indexParties`
// (`for...of` over `undefined`), a missing field diffed as no move
// (`undefined === undefined`), a wrong-type money figure silently
// produced a misleading difference, and an unknown `outcome` value
// silently diffed as a phantom move.
//
// Rules under test:
//  - a missing `deposit`, `parties`, `totalInflow`, `eventCount`, or
//    `balanced` throws the exact shape error, never a bare TypeError
//  - a wrong-type money figure (deposit or party ledger) throws the
//    exact shape error
//  - an unknown `outcome` value throws the exact shape error
//  - the `a` side is checked first: both sides broken, the error
//    names `a`'s fault
//  - non-object inputs still throw the pre-existing "both reports
//    must be objects" error (the gate runs after that check)
//  - the comparison-not-validation contract does not regress: a
//    shape-valid but self-inconsistent report (totals that disagree,
//    `balanced: true` over disagreeing inflow/outflow) still diffs
//  - a legal diff is byte-for-byte the old behaviour

const PREFIX = "invalid settlement report diff";

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

// Backlog #1316: pinned clock. The fixture used to dispatch on the
// live wall clock, so two `releasedReport()` calls straddling a
// millisecond boundary produced reports whose audit windows
// (`firstEventAt`/`lastEventAt`, taken from `history[0].at` /
// `history[last].at`) differed by 1ms — and the "self-inconsistent
// reports still diff" test intermittently saw `firstEventAtChanged` /
// `lastEventAtChanged` alongside the moved field (full-suite
// 2487/2488, single-file 10/10). Pinning `at` through the
// `DispatchOptions.at` injection point (the same fixed-timestamp
// idiom the demo uses) makes every call byte-identical; the diff's
// own window-move detection is untouched — a 1ms shift in either
// window is still reported, see the determinism test below.
const FIXED_AT = [
  "2026-03-01T09:00:00.000Z",
  "2026-03-01T09:00:01.000Z",
  "2026-03-01T09:00:02.000Z",
  "2026-03-01T09:00:03.000Z",
] as const;

function releasedReport(id = "esc-10630"): SettlementReport {
  const e = new Escrow(id);
  e.dispatch("FUND", undefined, undefined, { at: FIXED_AT[0] });
  e.dispatch("SUBMIT_MILESTONE", undefined, undefined, { at: FIXED_AT[1] });
  e.dispatch("VERIFY_PASS", undefined, undefined, { at: FIXED_AT[2] });
  e.dispatch("RELEASE", undefined, undefined, { at: FIXED_AT[3] });
  return buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500 },
  });
}

/** Detached deep copy: reports are plain JSON data. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Assert the diff throws exactly `PREFIX: <reason>`. */
function throwsShape(a: unknown, b: unknown, reason: string): void {
  assert.throws(
    () =>
      diffSettlementReports(
        a as SettlementReport,
        b as SettlementReport,
      ),
    (err: unknown) =>
      err instanceof Error &&
      !(err instanceof TypeError) &&
      err.message === `${PREFIX}: ${reason}`,
  );
}

test("a report missing deposit throws the shape error, never a bare TypeError", () => {
  // The backlog's motivating case: a missing `deposit` used to die
  // in `sameFeeBreakdown` with `Cannot read properties of undefined
  // (reading 'creatorPool')`.
  const { deposit, ...missingDeposit } = releasedReport();
  void deposit;
  throwsShape(
    missingDeposit,
    releasedReport(),
    "deposit must be a FeeBreakdown object",
  );
  throwsShape(
    releasedReport(),
    missingDeposit,
    "deposit must be a FeeBreakdown object",
  );
});

test("a report missing parties throws the shape error, never a bare TypeError", () => {
  // The backlog's second motivating case: a missing `parties` used
  // to die in `indexParties` (`for...of` over `undefined`).
  const { parties, ...missingParties } = releasedReport();
  void parties;
  throwsShape(
    missingParties,
    releasedReport(),
    "parties must be a non-empty array",
  );
  throwsShape(
    releasedReport(),
    missingParties,
    "parties must be a non-empty array",
  );
});

test("a missing total, event count, or balanced flag throws, naming the field", () => {
  const { totalInflow, ...missingTotalInflow } = releasedReport();
  void totalInflow;
  throwsShape(
    missingTotalInflow,
    releasedReport(),
    "totalInflow must be a finite number",
  );
  const { totalOutflow, ...missingTotalOutflow } = releasedReport();
  void totalOutflow;
  throwsShape(
    releasedReport(),
    missingTotalOutflow,
    "totalOutflow must be a finite number",
  );
  const { eventCount, ...missingEventCount } = releasedReport();
  void eventCount;
  throwsShape(
    missingEventCount,
    releasedReport(),
    "eventCount must be a non-negative integer",
  );
  const { balanced, ...missingBalanced } = releasedReport();
  void balanced;
  throwsShape(
    missingBalanced,
    releasedReport(),
    "balanced must be a boolean",
  );
});

test("a wrong-type money figure throws the exact shape error", () => {
  const badDeposit = clone(releasedReport());
  (badDeposit.deposit as never as Record<string, unknown>).deposit = "10630";
  throwsShape(
    badDeposit,
    releasedReport(),
    "deposit.deposit must be a finite number",
  );
  const badTotal = clone(releasedReport());
  (badTotal as never as Record<string, unknown>).totalInflow = "10630";
  throwsShape(
    releasedReport(),
    badTotal,
    "totalInflow must be a finite number",
  );
  const badParty = clone(releasedReport());
  const creator = badParty.parties.find((p) => p.party === "creator")!;
  (creator as never as Record<string, unknown>).inflow = "10098.5";
  throwsShape(
    badParty,
    releasedReport(),
    "each party.inflow must be a finite number",
  );
});

test("an unknown outcome value throws the exact shape error", () => {
  const badOutcome = clone(releasedReport());
  (badOutcome as never as Record<string, unknown>).outcome = "voided";
  throwsShape(
    badOutcome,
    releasedReport(),
    'outcome must be "released", "refunded", "expired", or "partially-released"',
  );
  throwsShape(
    releasedReport(),
    badOutcome,
    'outcome must be "released", "refunded", "expired", or "partially-released"',
  );
});

test("a record-shaped but field-missing input throws, never a bare TypeError", () => {
  throwsShape(
    { escrowId: "esc-10630" },
    releasedReport(),
    'outcome must be "released", "refunded", "expired", or "partially-released"',
  );
  throwsShape({}, releasedReport(), "escrowId must be a non-empty string");
});

test("the a side is checked first: both sides broken, the error names a's fault", () => {
  const { deposit, ...missingDeposit } = releasedReport();
  void deposit;
  throwsShape(
    missingDeposit,
    { escrowId: "esc-10630" },
    "deposit must be a FeeBreakdown object",
  );
  const badDeposit = clone(releasedReport());
  (badDeposit.deposit as never as Record<string, unknown>).deposit = "10630";
  throwsShape(
    badDeposit,
    missingDeposit,
    "deposit.deposit must be a finite number",
  );
});

test("non-object inputs still throw the pre-existing objects error", () => {
  const report = releasedReport();
  assert.throws(
    () => diffSettlementReports(null as unknown as SettlementReport, report),
    /invalid settlement report diff: both reports must be objects/,
  );
  assert.throws(
    () => diffSettlementReports(report, "x" as unknown as SettlementReport),
    /invalid settlement report diff: both reports must be objects/,
  );
});

test("shape-valid but self-inconsistent reports still diff: comparison, not validation", () => {
  // `totalInflow` disagrees with the deposit/parties, and `balanced`
  // is true over disagreeing inflow/outflow — the diff reports what
  // moved and never re-checks the identities.
  const moved = clone(releasedReport());
  moved.totalInflow = 99999;
  assert.deepEqual(
    diffSettlementReports(releasedReport(), moved),
    { totalInflowChanged: { from: 10630, to: 99999 } },
  );
  const unbalanced = clone(releasedReport());
  unbalanced.totalOutflow = 1;
  assert.deepEqual(
    diffSettlementReports(releasedReport(), unbalanced),
    { totalOutflowChanged: { from: 10630, to: 1 } },
  );
});

test("the fixture is deterministic: two released reports are byte-identical, and a 1ms window shift still diffs", () => {
  // Backlog #1316: the two `releasedReport()` calls inside the
  // self-inconsistent test above used to straddle a millisecond
  // boundary and leak `firstEventAtChanged`/`lastEventAtChanged`
  // into the diff. The pinned clock makes them identical — and the
  // second half proves the fix did not neuter the diff: shifting
  // one window edge by 1ms is still reported as a move.
  assert.deepEqual(releasedReport(), releasedReport());
  const shifted = clone(releasedReport());
  shifted.lastEventAt = "2026-03-01T09:00:03.001Z";
  assert.deepEqual(diffSettlementReports(releasedReport(), shifted), {
    lastEventAtChanged: {
      from: "2026-03-01T09:00:03.000Z",
      to: "2026-03-01T09:00:03.001Z",
    },
  });
});

test("a legal diff is unchanged: identical diffs to {}, one moved field reports only itself", () => {
  const report = releasedReport();
  assert.deepEqual(diffSettlementReports(report, clone(report)), {});
  const moved = clone(report);
  moved.deposit.deposit += 1;
  assert.deepEqual(
    diffSettlementReports(report, moved),
    {
      depositChanged: {
        from: { ...report.deposit },
        to: { ...moved.deposit },
      },
    },
  );
});
