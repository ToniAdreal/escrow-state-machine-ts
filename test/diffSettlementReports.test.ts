import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  calculateDeposit,
  diffSettlementReports,
  type SettlementReport,
} from "../src/index.js";

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

function releaseEscrow(id = "esc-10630") {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return e;
}

function refundEscrow(id = "esc-10630") {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("DISPUTE");
  e.dispatch("ARBITRATE_REFUND");
  return e;
}

function releasedReport(
  id = "esc-10630",
  extra: { currency?: string; proFeeBps?: number } = {},
): SettlementReport {
  const escrow = releaseEscrow(id);
  return buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: extra.proFeeBps ?? 500 },
    ...(extra.currency !== undefined
      ? { currency: extra.currency }
      : {}),
  });
}

function partialReport(released: number): SettlementReport {
  const e = new Escrow("esc-10630");
  e.dispatch("FUND");
  return buildSettlementReport({
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: goldenDeposit(),
    partialRelease: { released, proFeeBps: 500 },
  });
}

/** Detached deep copy: reports are plain JSON data. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test("identical reports diff to an empty diff", () => {
  const report = releasedReport();
  assert.deepEqual(diffSettlementReports(report, clone(report)), {});
});

test("single deposit field difference is reported with both sides", () => {
  const a = releasedReport();
  const b = clone(a);
  b.deposit.deposit += 1;
  const diff = diffSettlementReports(a, b);
  assert.deepEqual(Object.keys(diff), ["depositChanged"]);
  assert.equal(diff.depositChanged!.from.deposit, 10630);
  assert.equal(diff.depositChanged!.to.deposit, 10631);
});

test("sub-cent float noise is not a deposit change", () => {
  const a = releasedReport();
  const b = clone(a);
  // Raw float addition noise (0.1 + 0.2 style): below one cent.
  b.deposit.deposit = 10630.000000000001;
  assert.deepEqual(diffSettlementReports(a, b), {});
});

test("outcome flip reports outcome and the settlement going away", () => {
  const released = releasedReport();
  const escrow = refundEscrow();
  const refunded = buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: goldenDeposit(),
  });
  const diff = diffSettlementReports(released, refunded);
  assert.deepEqual(diff.outcomeChanged, {
    from: "released",
    to: "refunded",
  });
  assert.equal(diff.settlementChanged!.to, undefined);
  assert.equal(diff.settlementChanged!.from!.proFee, 531.5);
  assert.ok(diff.partiesChanged);
});

test("one party amount moves: only that role is listed as changed", () => {
  const a = releasedReport();
  const b = clone(a);
  const creator = b.parties.find((p) => p.party === "creator")!;
  creator.inflow += 1;
  creator.net += 1;
  const diff = diffSettlementReports(a, b);
  assert.deepEqual(diff.partiesChanged!.added, []);
  assert.deepEqual(diff.partiesChanged!.removed, []);
  assert.equal(diff.partiesChanged!.changed.length, 1);
  assert.equal(diff.partiesChanged!.changed[0]!.role, "creator");
  assert.equal(diff.partiesChanged!.changed[0]!.from.inflow, 10098.5);
  assert.equal(diff.partiesChanged!.changed[0]!.to.inflow, 10099.5);
  assert.deepEqual(Object.keys(diff), ["partiesChanged"]);
});

test("a missing party role is reported as removed", () => {
  const a = releasedReport();
  const b = clone(a);
  b.parties = b.parties.filter((p) => p.party !== "referrer");
  const diff = diffSettlementReports(a, b);
  assert.deepEqual(diff.partiesChanged!.removed, ["referrer"]);
  assert.deepEqual(diff.partiesChanged!.added, []);
  assert.deepEqual(diff.partiesChanged!.changed, []);
});

test("a role present only in b is reported as added", () => {
  const a = releasedReport();
  a.parties = a.parties.filter((p) => p.party !== "referrer");
  const b = releasedReport();
  const diff = diffSettlementReports(a, b);
  assert.deepEqual(diff.partiesChanged!.added, ["referrer"]);
  assert.deepEqual(diff.partiesChanged!.removed, []);
});

test("currency difference and currency appearing are both changes", () => {
  const usd = releasedReport("esc-10630", { currency: "USD" });
  const eur = clone(usd);
  eur.currency = "EUR";
  assert.deepEqual(diffSettlementReports(usd, eur).currencyChanged, {
    from: "USD",
    to: "EUR",
  });

  const noCurrency = releasedReport();
  const withCurrency = clone(noCurrency);
  withCurrency.currency = "USD";
  assert.deepEqual(
    diffSettlementReports(noCurrency, withCurrency).currencyChanged,
    { from: undefined, to: "USD" },
  );
});

test("balanced flip is its own entry", () => {
  const a = releasedReport();
  const b = clone(a);
  b.balanced = false;
  const diff = diffSettlementReports(a, b);
  assert.deepEqual(diff.balancedChanged, { from: true, to: false });
  assert.deepEqual(Object.keys(diff), ["balancedChanged"]);
});

test("event count and audit window differences are reported", () => {
  const a = releasedReport();
  const b = clone(a);
  b.eventCount += 1;
  b.firstEventAt = "2026-01-02T00:00:00.000Z";
  const diff = diffSettlementReports(a, b);
  assert.deepEqual(diff.eventCountChanged, { from: 4, to: 5 });
  assert.equal(diff.firstEventAtChanged!.from, a.firstEventAt);
  assert.equal(diff.firstEventAtChanged!.to, "2026-01-02T00:00:00.000Z");
  b.lastEventAt = "2026-01-03T00:00:00.000Z";
  assert.equal(
    diffSettlementReports(a, b).lastEventAtChanged!.to,
    "2026-01-03T00:00:00.000Z",
  );
});

test("release path difference is reported", () => {
  const a = releasedReport();
  const b = clone(a);
  b.releasePath = "VERIFY_FAIL → ARBITRATE_RELEASE";
  const diff = diffSettlementReports(a, b);
  assert.deepEqual(diff.releasePathChanged, {
    from: "VERIFY_PASS → RELEASE",
    to: "VERIFY_FAIL → ARBITRATE_RELEASE",
  });
});

test("reports of different escrows throw, like diffEscrowSnapshots", () => {
  const a = releasedReport("esc-10630");
  const b = releasedReport("esc-other");
  assert.throws(
    () => diffSettlementReports(a, b),
    /settlement report diff failed: cannot diff reports of different escrows \("esc-10630" vs "esc-other"\)/,
  );
});

test("non-object inputs throw", () => {
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

test("different partial-release slices move partialSettlement and remaining", () => {
  const a = partialReport(4252);
  const b = partialReport(5000);
  const diff = diffSettlementReports(a, b);
  assert.equal(diff.partialSettlementChanged!.from!.released, 4252);
  assert.equal(diff.partialSettlementChanged!.to!.released, 5000);
  assert.deepEqual(diff.remainingChanged, { from: 6378, to: 5630 });
  assert.deepEqual(diff.outcomeChanged, undefined);
});

test("remaining difference on the same slice is reported", () => {
  const a = partialReport(4252);
  const b = clone(a);
  b.remaining = 6379;
  assert.deepEqual(diffSettlementReports(a, b).remainingChanged, {
    from: 6378,
    to: 6379,
  });
});

test("totals move independently at cent precision", () => {
  const a = releasedReport();
  const inDiff = clone(a);
  inDiff.totalInflow += 1;
  assert.deepEqual(diffSettlementReports(a, inDiff).totalInflowChanged, {
    from: 10630,
    to: 10631,
  });
  const outDiff = clone(a);
  outDiff.totalOutflow = 10630.000000000001;
  assert.equal(
    diffSettlementReports(a, outDiff).totalOutflowChanged,
    undefined,
  );
});

test("fee change moves settlement figures and the two affected parties", () => {
  const a = releasedReport("esc-10630", { proFeeBps: 500 });
  const b = releasedReport("esc-10630", { proFeeBps: 600 });
  const diff = diffSettlementReports(a, b);
  assert.equal(diff.settlementChanged!.from!.proFee, 531.5);
  assert.equal(diff.settlementChanged!.to!.proFee, 637.8);
  assert.deepEqual(
    diff.partiesChanged!.changed.map((entry) => entry.role),
    ["creator", "platform"],
  );
  // The deposit is unchanged, so the totals do not move.
  assert.equal(diff.totalInflowChanged, undefined);
  assert.equal(diff.totalOutflowChanged, undefined);
  assert.equal(diff.balancedChanged, undefined);
});

test("diff carries detached copies: mutating it never touches the reports", () => {
  const a = releasedReport();
  const b = clone(a);
  b.deposit.deposit += 1;
  const diff = diffSettlementReports(a, b);
  diff.depositChanged!.from.deposit = 0;
  diff.depositChanged!.to.deposit = 0;
  assert.equal(a.deposit.deposit, 10630);
  assert.equal(b.deposit.deposit, 10631);
});
