import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  settleRelease,
  type BuildWebhookOptions,
  type DeliverWebhookOptions,
  type DispatchOptions,
  type EscrowHistoryEntry,
  type EscrowOptions,
  type EscrowSnapshot,
  type EscrowsByFiltersOptions,
  type SettlementInputs,
  type SettlementReport,
  type SettlementWebhookOutboxAttempt,
  type SettlementWebhookOutboxOptions,
} from "../src/index.js";

// Backlog #1036: `exactOptionalPropertyTypes` is on (rfc #1021 pilot,
// mirrored here). Two rules hold:
//  - data/message shapes genuinely carry undefined at runtime, so their
//    optional fields accept an explicit undefined (absent == undefined
//    there): EscrowHistoryEntry (note/amount), EscrowSnapshot
//    (deadline), SettlementInputs/PartialSettlementInputs
//    (referralCredits), SettlementWebhookOutboxAttempt (at),
//    SettlementReport (releasePath);
//  - config options do NOT accept one: omitting the field is the only
//    way to take the default, so a caller that forwards a
//    possibly-undefined value must omit it (conditional spread)
//    instead of passing it through. This covers EscrowOptions,
//    DispatchOptions, EscrowsByFiltersOptions, BuildWebhookOptions,
//    DeliverWebhookOptions, and SettlementWebhookOutboxOptions.
// Each negative case below must fail to compile without its
// expect-error comment: if a type ever re-admits explicit undefined, tsc
// reports the directive as unused and the suite goes red.

test("exactOptionalPropertyTypes: data shapes still accept explicit undefined, and omitted config optionals keep working", () => {
  const entry: EscrowHistoryEntry = {
    seq: 1,
    event: "FUND",
    from: "CREATED",
    to: "FUNDED",
    at: "2026-01-01T00:00:00.000Z",
    note: undefined,
    amount: undefined,
  };
  const snapshot: EscrowSnapshot = {
    id: "e-eopt-1",
    state: "FUNDED",
    history: [entry],
    deadline: undefined,
  };
  const attempt: SettlementWebhookOutboxAttempt = {
    endpoint: "https://example.com/hook",
    eventId: "evt-1",
    ok: false,
    error: "server responded with status 500",
    at: undefined,
  };
  const report: SettlementReport = {
    escrowId: "e-eopt-1",
    outcome: "released",
    releasePath: undefined,
    deposit: {
      creatorPool: 100,
      baseFee: 0,
      complexityMultiplier: 1,
      loyaltyDiscount: 0,
      oracleFee: 0,
      adjustedBaseFee: 0,
      deposit: 100,
    },
    parties: [],
    totalInflow: 0,
    totalOutflow: 0,
    balanced: true,
    eventCount: 1,
  };
  void snapshot;
  void attempt;
  void report;
  const settled = settleRelease({
    gross: 100,
    proFeeBps: 500,
    referralCredits: undefined,
  } satisfies SettlementInputs);
  assert.equal(settled.referralCredits, 0);

  // Omitted config optionals still take their defaults at runtime.
  const escrow = new Escrow("e-eopt-1");
  escrow.dispatch("FUND", "seed", 100);
  assert.equal(escrow.state, "FUNDED");
  assert.equal(escrow.toJSON().deadline, undefined);
});

// Positive controls: omitting an optional config field still compiles.
const omittedEscrow: EscrowOptions = {};
const omittedDispatch: DispatchOptions = {};
const omittedFilters: EscrowsByFiltersOptions = {};
const omittedBuild: BuildWebhookOptions = { secret: "s3cr3t" };
const omittedDeliver: DeliverWebhookOptions = {};
const omittedOutbox: SettlementWebhookOutboxOptions = {};
void omittedEscrow;
void omittedDispatch;
void omittedFilters;
void omittedBuild;
void omittedDeliver;
void omittedOutbox;

// Negative pins: an explicit undefined on a config option must not compile.
// @ts-expect-error EscrowOptions.maxDeposit does not accept an explicit undefined
const rejectedMaxDeposit: EscrowOptions = { maxDeposit: undefined };
// @ts-expect-error EscrowOptions.requireVerifyEvidence does not accept an explicit undefined
const rejectedRequireEvidence: EscrowOptions = { requireVerifyEvidence: undefined };
// @ts-expect-error EscrowOptions.auditKey does not accept an explicit undefined
const rejectedAuditKey: EscrowOptions = { auditKey: undefined };
// @ts-expect-error EscrowOptions.rolePolicy does not accept an explicit undefined
const rejectedRolePolicy: EscrowOptions = { rolePolicy: undefined };
// @ts-expect-error EscrowOptions.requireActor does not accept an explicit undefined
const rejectedRequireActor: EscrowOptions = { requireActor: undefined };
// @ts-expect-error EscrowOptions.deadline does not accept an explicit undefined
const rejectedDeadline: EscrowOptions = { deadline: undefined };
// @ts-expect-error DispatchOptions.evidence does not accept an explicit undefined
const rejectedDispatchEvidence: DispatchOptions = { evidence: undefined };
// @ts-expect-error DispatchOptions.actor does not accept an explicit undefined
const rejectedDispatchActor: DispatchOptions = { actor: undefined };
// @ts-expect-error DispatchOptions.at does not accept an explicit undefined
const rejectedDispatchAt: DispatchOptions = { at: undefined };
// @ts-expect-error DispatchOptions.amount does not accept an explicit undefined
const rejectedDispatchAmount: DispatchOptions = { amount: undefined };
// @ts-expect-error EscrowsByFiltersOptions.actor does not accept an explicit undefined
const rejectedFilterActor: EscrowsByFiltersOptions = { actor: undefined };
// @ts-expect-error EscrowsByFiltersOptions.state does not accept an explicit undefined
const rejectedFilterState: EscrowsByFiltersOptions = { state: undefined };
// @ts-expect-error BuildWebhookOptions.now does not accept an explicit undefined
const rejectedBuildNow: BuildWebhookOptions = { secret: "s3cr3t", now: undefined };
// @ts-expect-error BuildWebhookOptions.eventId does not accept an explicit undefined
const rejectedBuildEventId: BuildWebhookOptions = { secret: "s3cr3t", eventId: undefined };
// @ts-expect-error DeliverWebhookOptions.retries does not accept an explicit undefined
const rejectedDeliverRetries: DeliverWebhookOptions = { retries: undefined };
// @ts-expect-error DeliverWebhookOptions.backoffMs does not accept an explicit undefined
const rejectedDeliverBackoff: DeliverWebhookOptions = { backoffMs: undefined };
// @ts-expect-error DeliverWebhookOptions.jitterMs does not accept an explicit undefined
const rejectedDeliverJitter: DeliverWebhookOptions = { jitterMs: undefined };
// @ts-expect-error DeliverWebhookOptions.fetchImpl does not accept an explicit undefined
const rejectedDeliverFetchImpl: DeliverWebhookOptions = { fetchImpl: undefined };
// @ts-expect-error DeliverWebhookOptions.allowInsecureHttp does not accept an explicit undefined
const rejectedDeliverInsecure: DeliverWebhookOptions = { allowInsecureHttp: undefined };
// @ts-expect-error DeliverWebhookOptions.signal does not accept an explicit undefined
const rejectedDeliverSignal: DeliverWebhookOptions = { signal: undefined };
// @ts-expect-error SettlementWebhookOutboxOptions.maxAttempts does not accept an explicit undefined
const rejectedOutboxMaxAttempts: SettlementWebhookOutboxOptions = { maxAttempts: undefined };
// @ts-expect-error SettlementWebhookOutboxOptions.now does not accept an explicit undefined
const rejectedOutboxNow: SettlementWebhookOutboxOptions = { now: undefined };
void rejectedMaxDeposit;
void rejectedRequireEvidence;
void rejectedAuditKey;
void rejectedRolePolicy;
void rejectedRequireActor;
void rejectedDeadline;
void rejectedDispatchEvidence;
void rejectedDispatchActor;
void rejectedDispatchAt;
void rejectedDispatchAmount;
void rejectedFilterActor;
void rejectedFilterState;
void rejectedBuildNow;
void rejectedBuildEventId;
void rejectedDeliverRetries;
void rejectedDeliverBackoff;
void rejectedDeliverJitter;
void rejectedDeliverFetchImpl;
void rejectedDeliverInsecure;
void rejectedDeliverSignal;
void rejectedOutboxMaxAttempts;
void rejectedOutboxNow;
