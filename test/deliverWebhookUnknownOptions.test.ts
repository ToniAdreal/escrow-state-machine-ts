/**
 * `deliverSettlementWebhook` / `deliverSettlementWebhookToMany` unknown-option
 * fail-closed (#1275).
 *
 * The delivery side was the second gap in the fail-closed family: the
 * build side scans its options (#1272) and the verify side scans
 * `VerifyWebhookOptions` (#1262), but the two delivery entry points
 * only read the keys they knew. A typo'd `timeouMs` fell through to the
 * default 10s timeout and a typo'd `retry` fell through to the default
 * 3 retries — a delivery the caller believed was "0 retries, 5ms
 * timeout" silently ran as 3 retries with a 10s timeout. The fan-out
 * side was worse: a typo'd `maxEndpoint` silently dropped the
 * endpoint-explosion cap and a typo'd `overallDeadline` silently
 * dropped the wall-clock budget, and a typo'd per-endpoint override
 * was dropped field by field in `deliverOne` before it ever reached
 * the single-delivery scan.
 *
 * Unknown keys now throw `cannot deliver settlement webhook: unknown
 * option "<key>"` (single) / `cannot deliver settlement webhook to
 * many endpoints: unknown option "<key>"` (fan-out call level) before
 * any request is made, checked before the numeric/type validation of
 * the known keys. A typo'd per-endpoint key is a per-endpoint
 * configuration failure: it is reported as that endpoint's
 * `{ ok: false, attempts: 0, error }` result, the endpoint makes no
 * request, and the other endpoints still deliver.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementWebhook,
  calculateDeposit,
  deliverSettlementWebhook,
  deliverSettlementWebhookToMany,
} from "../src/index.js";
import type {
  DeliverSettlementWebhookToManyOptions,
  SettlementWebhook,
  SettlementWebhookEndpoint,
  SettlementWebhookFetchImpl,
} from "../src/index.js";

const SECRET = "whsec_test_deliver_webhook_unknown_opts_20261120";
const FIXED_NOW = "2026-11-20T02:00:00.000Z";

function goldenDeposit() {
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

function goldenWebhook(): SettlementWebhook {
  const escrow = new Escrow("esc-deliver-unknown-opts");
  escrow.dispatch("FUND");
  escrow.dispatch("SUBMIT_MILESTONE");
  escrow.dispatch("VERIFY_PASS");
  escrow.dispatch("RELEASE");
  const report = buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500 },
  });
  return buildSettlementWebhook(report, { secret: SECRET, now: FIXED_NOW });
}

function goldenReport() {
  const escrow = new Escrow("esc-deliver-unknown-opts");
  escrow.dispatch("FUND");
  escrow.dispatch("SUBMIT_MILESTONE");
  escrow.dispatch("VERIFY_PASS");
  escrow.dispatch("RELEASE");
  return buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500 },
  });
}

/** A stub fetch that counts calls and always answers 200. */
function countingStub() {
  let calls = 0;
  const fetchImpl: SettlementWebhookFetchImpl = async () => {
    calls += 1;
    return new Response("ok", { status: 200 });
  };
  return { fetchImpl, calls: () => calls };
}

const URL = "https://example.com/hooks/escrow";

test("single: all 8 legal keys deliver with one attempt", async () => {
  const stub = countingStub();
  const controller = new AbortController();
  const result = await deliverSettlementWebhook(URL, goldenWebhook(), {
    retries: 0,
    backoffMs: 0,
    timeoutMs: 1000,
    maxRetryDelayMs: 1000,
    jitterMs: 0,
    signal: controller.signal,
    allowInsecureHttp: true,
    fetchImpl: stub.fetchImpl,
  });
  assert.deepEqual(result, { status: 200, attempts: 1 });
  assert.equal(stub.calls(), 1);
});

test("single: typo'd retry throws and makes zero attempts", async () => {
  const stub = countingStub();
  await assert.rejects(
    deliverSettlementWebhook(URL, goldenWebhook(), {
      retry: 0,
      fetchImpl: stub.fetchImpl,
    } as never),
    { message: 'cannot deliver settlement webhook: unknown option "retry"' },
  );
  assert.equal(stub.calls(), 0);
});

test("single: backlog repro { retry: 0, timeouMs: 5 } throws, no default run", async () => {
  const stub = countingStub();
  await assert.rejects(
    deliverSettlementWebhook(URL, goldenWebhook(), {
      retry: 0,
      timeouMs: 5,
      fetchImpl: stub.fetchImpl,
    } as never),
    { message: 'cannot deliver settlement webhook: unknown option "retry"' },
  );
  assert.equal(stub.calls(), 0);
});

test("single: typo'd timeouMs alone throws and makes zero attempts", async () => {
  const stub = countingStub();
  await assert.rejects(
    deliverSettlementWebhook(URL, goldenWebhook(), {
      timeouMs: 5,
      fetchImpl: stub.fetchImpl,
    } as never),
    { message: 'cannot deliver settlement webhook: unknown option "timeouMs"' },
  );
  assert.equal(stub.calls(), 0);
});

test("single: typo'd backoff throws with the key named", async () => {
  const stub = countingStub();
  await assert.rejects(
    deliverSettlementWebhook(URL, goldenWebhook(), {
      backoff: 100,
      fetchImpl: stub.fetchImpl,
    } as never),
    { message: 'cannot deliver settlement webhook: unknown option "backoff"' },
  );
  assert.equal(stub.calls(), 0);
});

test("single: typo'd fetch throws with the key named", async () => {
  const stub = countingStub();
  await assert.rejects(
    deliverSettlementWebhook(URL, goldenWebhook(), {
      fetch: stub.fetchImpl,
    } as never),
    { message: 'cannot deliver settlement webhook: unknown option "fetch"' },
  );
  assert.equal(stub.calls(), 0);
});

test("single: unknown key beats an invalid numeric value", async () => {
  const stub = countingStub();
  await assert.rejects(
    deliverSettlementWebhook(URL, goldenWebhook(), {
      retries: -1,
      timeouMs: 5,
      fetchImpl: stub.fetchImpl,
    } as never),
    { message: 'cannot deliver settlement webhook: unknown option "timeouMs"' },
  );
  assert.equal(stub.calls(), 0);
});

test("single: unknown key beats an invalid URL", async () => {
  const stub = countingStub();
  await assert.rejects(
    deliverSettlementWebhook(URL.replace("https://example.com", "not a url"), goldenWebhook(), {
      badKey: 1,
      fetchImpl: stub.fetchImpl,
    } as never),
    { message: 'cannot deliver settlement webhook: unknown option "badKey"' },
  );
  assert.equal(stub.calls(), 0);
});

test("single: option keys are case-sensitive (Retries is unknown)", async () => {
  const stub = countingStub();
  await assert.rejects(
    deliverSettlementWebhook(URL, goldenWebhook(), {
      Retries: 0,
      fetchImpl: stub.fetchImpl,
    } as never),
    { message: 'cannot deliver settlement webhook: unknown option "Retries"' },
  );
  assert.equal(stub.calls(), 0);
});

function twoEndpoints(): SettlementWebhookEndpoint[] {
  return [
    { url: "https://example.com/a", secret: SECRET },
    { url: "https://example.com/b", secret: SECRET },
  ];
}

test("fan-out: all 5 extension keys deliver both endpoints", async () => {
  const stub = countingStub();
  const opts: DeliverSettlementWebhookToManyOptions = {
    now: FIXED_NOW,
    eventId: "evt-1275-fanout",
    maxEndpoints: 5,
    maxConcurrency: 1,
    overallDeadlineMs: 60000,
    fetchImpl: stub.fetchImpl,
  };
  const result = await deliverSettlementWebhookToMany(
    goldenReport(),
    twoEndpoints(),
    opts,
  );
  assert.equal(result.delivered, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.deadlineExceeded, false);
  assert.equal(stub.calls(), 2);
});

test("fan-out: typo'd maxEndpoint throws at call level, zero requests", async () => {
  const stub = countingStub();
  await assert.rejects(
    deliverSettlementWebhookToMany(goldenReport(), twoEndpoints(), {
      maxEndpoint: 5,
      fetchImpl: stub.fetchImpl,
    } as never),
    {
      message:
        'cannot deliver settlement webhook to many endpoints: unknown option "maxEndpoint"',
    },
  );
  assert.equal(stub.calls(), 0);
});

test("fan-out: typo'd overallDeadline throws at call level, zero requests", async () => {
  const stub = countingStub();
  await assert.rejects(
    deliverSettlementWebhookToMany(goldenReport(), twoEndpoints(), {
      overallDeadline: 60000,
      fetchImpl: stub.fetchImpl,
    } as never),
    {
      message:
        'cannot deliver settlement webhook to many endpoints: unknown option "overallDeadline"',
    },
  );
  assert.equal(stub.calls(), 0);
});

test("fan-out: typo'd call-level retry throws, zero requests", async () => {
  const stub = countingStub();
  await assert.rejects(
    deliverSettlementWebhookToMany(goldenReport(), twoEndpoints(), {
      retry: 0,
      fetchImpl: stub.fetchImpl,
    } as never),
    {
      message:
        'cannot deliver settlement webhook to many endpoints: unknown option "retry"',
    },
  );
  assert.equal(stub.calls(), 0);
});

test("fan-out: typo'd per-endpoint retry fails only that endpoint", async () => {
  const stub = countingStub();
  const endpoints = twoEndpoints();
  (endpoints[0] as never as Record<string, unknown>)["retry"] = 0;
  const result = await deliverSettlementWebhookToMany(goldenReport(), endpoints, {
    now: FIXED_NOW,
    eventId: "evt-1275-endpoint-retry",
    fetchImpl: stub.fetchImpl,
  });
  assert.equal(result.delivered, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.results[0].ok, false);
  assert.equal(result.results[0].attempts, 0);
  assert.equal(
    result.results[0].error,
    'cannot deliver settlement webhook to many endpoints: endpoints[0]: unknown option "retry"',
  );
  assert.equal(result.results[1].ok, true);
  assert.equal(result.results[1].attempts, 1);
  assert.equal(stub.calls(), 1);
});

test("fan-out: typo'd per-endpoint timeouMs fails only that endpoint", async () => {
  const stub = countingStub();
  const endpoints = twoEndpoints();
  (endpoints[1] as never as Record<string, unknown>)["timeouMs"] = 5;
  const result = await deliverSettlementWebhookToMany(goldenReport(), endpoints, {
    now: FIXED_NOW,
    eventId: "evt-1275-endpoint-timeout",
    fetchImpl: stub.fetchImpl,
  });
  assert.equal(result.delivered, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[1].ok, false);
  assert.equal(result.results[1].attempts, 0);
  assert.equal(
    result.results[1].error,
    'cannot deliver settlement webhook to many endpoints: endpoints[1]: unknown option "timeouMs"',
  );
  assert.equal(stub.calls(), 1);
});

test("fan-out: per-endpoint unknown key beats an empty secret", async () => {
  const stub = countingStub();
  const endpoints = twoEndpoints();
  (endpoints[0] as never as Record<string, unknown>)["retry"] = 0;
  endpoints[0].secret = "";
  const result = await deliverSettlementWebhookToMany(goldenReport(), endpoints, {
    now: FIXED_NOW,
    eventId: "evt-1275-endpoint-order",
    fetchImpl: stub.fetchImpl,
  });
  assert.equal(result.results[0].ok, false);
  assert.equal(result.results[0].attempts, 0);
  assert.equal(
    result.results[0].error,
    'cannot deliver settlement webhook to many endpoints: endpoints[0]: unknown option "retry"',
  );
  assert.equal(result.results[1].ok, true);
  assert.equal(stub.calls(), 1);
});
