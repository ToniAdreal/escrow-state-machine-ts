import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  calculateDeposit,
  deliverSettlementWebhookToMany,
} from "../src/index.js";
import type { SettlementReport } from "../src/index.js";

/**
 * Settlement webhook fan-out x maxRetryDelayMs combination (backlog #716).
 *
 * Fan-out (webhookFanout.test.ts) and the single-endpoint Retry-After cap
 * (maxRetryDelay.test.ts) each have dedicated coverage, but the combination
 * was untested: `deliverSettlementWebhookToMany` claims to pass the
 * call-level and per-endpoint `maxRetryDelayMs` through to the
 * single-endpoint delivery (src/webhooks.ts, ToMany path), yet no fan-out
 * test ever set the option, so a plumbing regression there would be
 * invisible. The single-endpoint cap row does not cover fan-out pass-through.
 *
 * Rules under test:
 *  - a call-level `maxRetryDelayMs` clamps a runaway `Retry-After` hint on
 *    the one hinted endpoint, while the other endpoints answer 200 on
 *    their first attempt and are never retried or delayed
 *  - a per-endpoint `maxRetryDelayMs` overrides the call-level value for
 *    that endpoint only (the clamped wait tracks the override, not the
 *    call-level cap)
 *  - two hinted endpoints clamp independently: each endpoint's wait
 *    tracks its own cap, results stay in input order, and attempts are
 *    counted per endpoint (no cross-talk between endpoints)
 *  - the cap clamps hints only: a hint-less 500 follows the exponential
 *    backoff schedule (100ms, then 200ms) even when `maxRetryDelayMs`
 *    is a tiny 10ms — the cap must never be misapplied to backoff
 *  - every test stubs the global fetch: no external network, and the
 *    per-endpoint attempt timestamps are the recorded "sleep" evidence
 *    (there is no injectable sleep in the delivery code; the wait is
 *    proved with real wall-clock gaps, as in maxRetryDelay.test.ts)
 */

const SECRET_A = "whsec_fanout_maxretry_accounting_20261029";
const SECRET_B = "whsec_fanout_maxretry_notify_20261029";
const SECRET_C = "whsec_fanout_maxretry_archive_20261029";
const SECRET_D = "whsec_fanout_maxretry_audit_20261029";
const FIXED_NOW = "2026-10-29T22:58:00.000Z";
const EVENT_ID = "evt-fanout-maxretry-1";

const URL_A = "https://fanout-maxretry-a.example.com/hooks";
const URL_B = "https://fanout-maxretry-b.example.com/hooks";
const URL_C = "https://fanout-maxretry-c.example.com/hooks";
const URL_D = "https://fanout-maxretry-d.example.com/hooks";

function goldenReport(): SettlementReport {
  const escrow = new Escrow("esc-fanout-maxretry");
  escrow.dispatch("FUND");
  escrow.dispatch("SUBMIT_MILESTONE");
  escrow.dispatch("VERIFY_PASS");
  escrow.dispatch("RELEASE");
  return buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: calculateDeposit({
      creatorPool: 10000,
      baseFee: 600,
      complexityMultiplier: 1.0,
      loyaltyDiscount: 30,
      oracleFee: 60,
    }),
    settlement: { proFeeBps: 500 },
  });
}

interface ScriptStep {
  status: number;
  headers?: Record<string, string>;
}

const ok200: ScriptStep = { status: 200 };
const hintThen200: ScriptStep[] = [
  { status: 429, headers: { "retry-after": "31536000" } },
  { status: 200 },
];

/**
 * Replace the global fetch with a per-URL canned response sequence (stays
 * on the last step once exhausted). Records each attempt's wall-clock
 * time and request body per URL, so a wait can be measured per endpoint
 * and payloads can be checked for cross-talk.
 */
function stubFetch(scripts: Record<string, ScriptStep[]>): {
  times: Record<string, number[]>;
  bodies: Record<string, string[]>;
  restore: () => void;
} {
  const original = globalThis.fetch;
  const times: Record<string, number[]> = {};
  const bodies: Record<string, string[]> = {};
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    const script = scripts[url];
    if (script === undefined) {
      throw new Error(`unexpected fetch url ${url}`);
    }
    times[url] ??= [];
    bodies[url] ??= [];
    times[url].push(Date.now());
    bodies[url].push(String(init?.body ?? ""));
    const step = script[Math.min(times[url].length - 1, script.length - 1)];
    return new Response("{}", { status: step.status, headers: step.headers });
  }) as typeof fetch;
  return {
    times,
    bodies,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function gapMs(times: number[]): number {
  assert.equal(times.length, 2, "expected exactly one retry gap to measure");
  return times[1] - times[0];
}

test("call-level maxRetryDelayMs clamps the hinted endpoint only", async () => {
  const stub = stubFetch({
    [URL_A]: hintThen200,
    [URL_B]: [ok200],
    [URL_C]: [ok200],
    [URL_D]: [ok200],
  });
  try {
    const out = await deliverSettlementWebhookToMany(
      goldenReport(),
      [
        { url: URL_A, secret: SECRET_A },
        { url: URL_B, secret: SECRET_B },
        { url: URL_C, secret: SECRET_C },
        { url: URL_D, secret: SECRET_D },
      ],
      {
        retries: 1,
        backoffMs: 100,
        maxRetryDelayMs: 400,
        now: FIXED_NOW,
        eventId: EVENT_ID,
      },
    );
    assert.equal(out.delivered, 4);
    assert.equal(out.failed, 0);
    assert.deepEqual(out.results, [
      { url: URL_A, ok: true, attempts: 2, status: 200 },
      { url: URL_B, ok: true, attempts: 1, status: 200 },
      { url: URL_C, ok: true, attempts: 1, status: 200 },
      { url: URL_D, ok: true, attempts: 1, status: 200 },
    ]);
    // The hinted endpoint waited ~the 400ms cap, not the one-year hint.
    const gap = gapMs(stub.times[URL_A]);
    assert.ok(gap >= 300, `expected the 400ms cap to be waited, gap was ${gap}ms`);
    assert.ok(gap < 1400, `expected delivery inside the 400ms cap, gap was ${gap}ms`);
    // The healthy endpoints were attempted exactly once: no retry, no delay.
    assert.equal(stub.times[URL_B].length, 1);
    assert.equal(stub.times[URL_C].length, 1);
    assert.equal(stub.times[URL_D].length, 1);
    // No cross-talk: every endpoint got the same logical event body.
    const bodyA = stub.bodies[URL_A][0];
    assert.equal(JSON.parse(bodyA).eventId, EVENT_ID);
    assert.equal(stub.bodies[URL_A][1], bodyA, "retry re-posts the same body");
    assert.equal(stub.bodies[URL_B][0], bodyA);
    assert.equal(stub.bodies[URL_C][0], bodyA);
    assert.equal(stub.bodies[URL_D][0], bodyA);
  } finally {
    stub.restore();
  }
});

test("per-endpoint maxRetryDelayMs overrides the call-level cap", async () => {
  const stub = stubFetch({
    [URL_A]: hintThen200,
    [URL_B]: [ok200],
    [URL_C]: [ok200],
    [URL_D]: [ok200],
  });
  try {
    const out = await deliverSettlementWebhookToMany(
      goldenReport(),
      [
        { url: URL_A, secret: SECRET_A, maxRetryDelayMs: 250 },
        { url: URL_B, secret: SECRET_B },
        { url: URL_C, secret: SECRET_C },
        { url: URL_D, secret: SECRET_D },
      ],
      {
        retries: 1,
        backoffMs: 100,
        maxRetryDelayMs: 1500,
        now: FIXED_NOW,
        eventId: EVENT_ID,
      },
    );
    assert.deepEqual(out.results, [
      { url: URL_A, ok: true, attempts: 2, status: 200 },
      { url: URL_B, ok: true, attempts: 1, status: 200 },
      { url: URL_C, ok: true, attempts: 1, status: 200 },
      { url: URL_D, ok: true, attempts: 1, status: 200 },
    ]);
    // ~250ms (the override), provably not the 1500ms call-level cap.
    const gap = gapMs(stub.times[URL_A]);
    assert.ok(gap >= 200, `expected the 250ms override to be waited, gap was ${gap}ms`);
    assert.ok(gap < 1000, `expected the override, not the 1500ms call cap, gap was ${gap}ms`);
  } finally {
    stub.restore();
  }
});

test("two hinted endpoints clamp independently, results stay in order", async () => {
  const stub = stubFetch({
    [URL_A]: hintThen200,
    [URL_B]: hintThen200,
    [URL_C]: [ok200],
    [URL_D]: [ok200],
  });
  try {
    const out = await deliverSettlementWebhookToMany(
      goldenReport(),
      [
        { url: URL_A, secret: SECRET_A, maxRetryDelayMs: 200 },
        { url: URL_B, secret: SECRET_B, maxRetryDelayMs: 600 },
        { url: URL_C, secret: SECRET_C },
        { url: URL_D, secret: SECRET_D },
      ],
      {
        retries: 1,
        backoffMs: 100,
        now: FIXED_NOW,
        eventId: EVENT_ID,
      },
    );
    assert.deepEqual(out.results, [
      { url: URL_A, ok: true, attempts: 2, status: 200 },
      { url: URL_B, ok: true, attempts: 2, status: 200 },
      { url: URL_C, ok: true, attempts: 1, status: 200 },
      { url: URL_D, ok: true, attempts: 1, status: 200 },
    ]);
    const gapA = gapMs(stub.times[URL_A]);
    const gapB = gapMs(stub.times[URL_B]);
    assert.ok(gapA >= 150, `endpoint A should wait ~200ms, gap was ${gapA}ms`);
    assert.ok(gapA < 1200, `endpoint A gap was ${gapA}ms, not ~200ms`);
    assert.ok(gapB >= 500, `endpoint B should wait ~600ms, gap was ${gapB}ms`);
    assert.ok(gapB < 1600, `endpoint B gap was ${gapB}ms, not ~600ms`);
    assert.ok(
      gapB > gapA,
      `independent caps: B (${gapB}ms) must wait longer than A (${gapA}ms)`,
    );
    assert.equal(stub.times[URL_C].length, 1);
    assert.equal(stub.times[URL_D].length, 1);
  } finally {
    stub.restore();
  }
});

test("hint-less 500 uses exponential backoff, not the tiny hint cap", async () => {
  const stub = stubFetch({
    [URL_A]: [{ status: 500 }, { status: 500 }, { status: 200 }],
    [URL_B]: [ok200],
    [URL_C]: [ok200],
    [URL_D]: [ok200],
  });
  try {
    const out = await deliverSettlementWebhookToMany(
      goldenReport(),
      [
        { url: URL_A, secret: SECRET_A },
        { url: URL_B, secret: SECRET_B },
        { url: URL_C, secret: SECRET_C },
        { url: URL_D, secret: SECRET_D },
      ],
      {
        retries: 2,
        backoffMs: 100,
        jitterMs: 0,
        maxRetryDelayMs: 10,
        now: FIXED_NOW,
        eventId: EVENT_ID,
      },
    );
    assert.deepEqual(out.results, [
      { url: URL_A, ok: true, attempts: 3, status: 200 },
      { url: URL_B, ok: true, attempts: 1, status: 200 },
      { url: URL_C, ok: true, attempts: 1, status: 200 },
      { url: URL_D, ok: true, attempts: 1, status: 200 },
    ]);
    const timesA = stub.times[URL_A];
    assert.equal(timesA.length, 3);
    const gap1 = timesA[1] - timesA[0];
    const gap2 = timesA[2] - timesA[1];
    // Backoff schedule 100ms then 200ms. If the 10ms hint cap were
    // misapplied to backoff, both gaps would be ~10ms and fail below.
    assert.ok(gap1 >= 80, `first backoff should be ~100ms, gap was ${gap1}ms`);
    assert.ok(gap1 < 600, `first backoff gap was ${gap1}ms, not ~100ms`);
    assert.ok(gap2 >= 170, `second backoff should be ~200ms, gap was ${gap2}ms`);
    assert.ok(gap2 < 900, `second backoff gap was ${gap2}ms, not ~200ms`);
    assert.ok(gap2 > gap1, `backoff must double: ${gap1}ms then ${gap2}ms`);
  } finally {
    stub.restore();
  }
});
