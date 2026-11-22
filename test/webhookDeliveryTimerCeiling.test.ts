import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  SettlementWebhookOutbox,
  buildSettlementReport,
  buildSettlementWebhook,
  calculateDeposit,
  deliverSettlementWebhook,
  deliverSettlementWebhookToMany,
  retrySettlementWebhookOutbox,
} from "../src/index.js";
import type {
  SettlementReport,
  SettlementWebhook,
  SettlementWebhookFetchImpl,
} from "../src/index.js";

/**
 * Delivery timers obey the Node `setTimeout` ceiling (backlog #1326).
 *
 * Node stores timer delays in a 32-bit signed integer: anything above
 * `2^31 - 1` ms (~24.8 days) triggers a `TimeoutOverflowWarning` and
 * fires after 1ms instead of the requested wait (verified on this
 * machine: `setTimeout(3e9)` warns and fires after ~1ms). Three
 * caller-controlled durations reach `setTimeout` in this module —
 * the exponential backoff sleep, the per-attempt timeout, and the
 * fan-out overall deadline — and an ordinary-looking configuration
 * grows past the ceiling (`backoffMs: 60_000` with `retries: 17`
 * reaches 3,932,160,000ms). Rules under test:
 *  - every backoff sleep the delivery loop arms is at most the
 *    ceiling, with the over-ceiling tail clamped to exactly the
 *    ceiling (never 1ms, never dropped)
 *  - a 429 `Retry-After` hint larger than the ceiling is likewise
 *    capped, even when `maxRetryDelayMs` is set above the ceiling
 *  - an over-ceiling `timeoutMs` arms the ceiling, not a 1ms
 *    misfire: the request still completes normally
 *  - small backoffs and timeouts keep their exact schedule
 *    (unchanged values, unchanged error text)
 *  - an over-ceiling `overallDeadlineMs` arms the ceiling and still
 *    stops a hanging endpoint with the deadline error text
 *  - the outbox runner's default between-rounds sleep shares the
 *    same clamp (it flows through the same helper)
 *
 * The timers are observed by wrapping the global `setTimeout`: the
 * wrapper records the delay each delivery timer is armed with (the
 * call site is identified from the stack, the same technique the CLI
 * demo uses), then fires delivery timers immediately so the test
 * never waits out a multi-day ceiling. Timers from any other caller
 * (the test runner's own) pass through untouched.
 */

const SECRET = "whsec_test_timer_ceiling_20261006";
const FIXED_NOW = "2026-10-06T16:00:00.000Z";
const MAX_TIMER_MS = 2 ** 31 - 1;

function goldenWebhook(): SettlementWebhook {
  const escrow = new Escrow("esc-timer-ceiling");
  escrow.dispatch("FUND");
  escrow.dispatch("SUBMIT_MILESTONE");
  escrow.dispatch("VERIFY_PASS");
  escrow.dispatch("RELEASE");
  const report = buildSettlementReport({
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
  return buildSettlementWebhook(report, { secret: SECRET, now: FIXED_NOW });
}

function goldenReport(): SettlementReport {
  const escrow = new Escrow("esc-timer-ceiling-fanout");
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

type TimerSite = "sleep" | "postOnce" | "deadline" | "other";

interface RecordedTimer {
  ms: number;
  site: TimerSite;
}

type TimerFn = (
  callback: (...args: never[]) => void,
  ms?: number,
  ...args: never[]
) => unknown;

/**
 * Record every delay the delivery code arms, and fire delivery timers
 * immediately (the recorded value is what the code asked the platform
 * for; waiting out a 24-day ceiling is not an option). Restores the
 * global timer when the returned `restore` runs.
 */
function installRecordingTimers(): {
  recorded: RecordedTimer[];
  restore: () => void;
} {
  const globalTimers = globalThis as unknown as { setTimeout: TimerFn };
  const originalSetTimeout = globalTimers.setTimeout;
  const recorded: RecordedTimer[] = [];
  const recording: TimerFn = (callback, ms, ...args) => {
    const stack = new Error().stack ?? "";
    let site: TimerSite = "other";
    if (stack.includes("sleepAbortable")) site = "sleep";
    else if (stack.includes("postOnce")) site = "postOnce";
    else if (stack.includes("deliverSettlementWebhookToMany"))
      site = "deadline";
    const wait = typeof ms === "number" ? ms : 0;
    if (site !== "other") {
      recorded.push({ ms: wait, site });
      return originalSetTimeout(callback, 0, ...args);
    }
    return originalSetTimeout(callback, ms, ...args);
  };
  globalTimers.setTimeout = recording;
  return {
    recorded,
    restore: () => {
      globalTimers.setTimeout = originalSetTimeout;
    },
  };
}

/** Fetch stub that always answers with the given status. */
function statusFetch(
  status: number,
  headers: Record<string, string> = {},
): SettlementWebhookFetchImpl {
  return async () =>
    new Response("{}", { status, headers });
}

/** Fetch stub that never settles on its own, but honors its signal. */
function hangingFetch(): SettlementWebhookFetchImpl {
  return async (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      signal?.addEventListener(
        "abort",
        () => reject(new Error("aborted")),
        { once: true },
      );
    });
}

function sleeps(recorded: RecordedTimer[]): number[] {
  return recorded.filter((t) => t.site === "sleep").map((t) => t.ms);
}

function postOnceTimers(recorded: RecordedTimer[]): number[] {
  return recorded.filter((t) => t.site === "postOnce").map((t) => t.ms);
}

function deadlineTimers(recorded: RecordedTimer[]): number[] {
  return recorded.filter((t) => t.site === "deadline").map((t) => t.ms);
}

test("backoffMs 1_200_000_000 with retries 2: the over-ceiling sleep clamps, the under-ceiling one passes through", async () => {
  const signed = goldenWebhook();
  const { recorded, restore } = installRecordingTimers();
  try {
    await assert.rejects(
      deliverSettlementWebhook("https://hooks.example.com/settlement", signed, {
        backoffMs: 1_200_000_000,
        retries: 2,
        fetchImpl: statusFetch(500),
      }),
      /failed after 3 attempts: server responded with status 500/,
    );
  } finally {
    restore();
  }
  // Requested: 1_200_000_000 (under the ceiling, passes through) then
  // 2_400_000_000 (over it, clamped to the ceiling).
  assert.deepEqual(sleeps(recorded), [1_200_000_000, MAX_TIMER_MS]);
  assert.ok(
    sleeps(recorded).every((ms) => ms <= MAX_TIMER_MS),
    "no armed sleep exceeds the Node setTimeout ceiling",
  );
});

test("backoffMs 60_000 with retries 17: exact schedule until the ceiling, then clamped", async () => {
  const signed = goldenWebhook();
  const { recorded, restore } = installRecordingTimers();
  try {
    await assert.rejects(
      deliverSettlementWebhook("https://hooks.example.com/settlement", signed, {
        backoffMs: 60_000,
        retries: 17,
        fetchImpl: statusFetch(500),
      }),
      /failed after 18 attempts: server responded with status 500/,
    );
  } finally {
    restore();
  }
  const expected = Array.from({ length: 17 }, (_v, i) =>
    i < 16 ? 60_000 * 2 ** i : MAX_TIMER_MS,
  );
  assert.deepEqual(sleeps(recorded), expected);
});

test("small backoffs keep their exact schedule (no clamping below the ceiling)", async () => {
  const signed = goldenWebhook();
  const { recorded, restore } = installRecordingTimers();
  try {
    await assert.rejects(
      deliverSettlementWebhook("https://hooks.example.com/settlement", signed, {
        backoffMs: 1000,
        retries: 2,
        fetchImpl: statusFetch(500),
      }),
      /failed after 3 attempts: server responded with status 500/,
    );
  } finally {
    restore();
  }
  assert.deepEqual(sleeps(recorded), [1000, 2000]);
});

test("429 Retry-After above the ceiling is capped even with a huge maxRetryDelayMs", async () => {
  const signed = goldenWebhook();
  const { recorded, restore } = installRecordingTimers();
  try {
    let calls = 0;
    const result = await deliverSettlementWebhook(
      "https://hooks.example.com/settlement",
      signed,
      {
        backoffMs: 1000,
        retries: 1,
        maxRetryDelayMs: 3e9,
        fetchImpl: async () => {
          calls += 1;
          return calls === 1
            ? new Response("{}", {
                status: 429,
                headers: { "retry-after": "31536000" },
              })
            : new Response("{}", { status: 200 });
        },
      },
    );
    assert.deepEqual(result, { status: 200, attempts: 2 });
  } finally {
    restore();
  }
  // Hinted 31,536,000,000ms, capped by maxRetryDelayMs to 3e9, then by
  // the timer ceiling to 2^31 - 1.
  assert.deepEqual(sleeps(recorded), [MAX_TIMER_MS]);
});

test("timeoutMs 3e9 arms the ceiling and does not misfire as a 1ms timeout", async () => {
  const signed = goldenWebhook();
  const { recorded, restore } = installRecordingTimers();
  try {
    const result = await deliverSettlementWebhook(
      "https://hooks.example.com/settlement",
      signed,
      { timeoutMs: 3e9, retries: 0, fetchImpl: statusFetch(200) },
    );
    assert.deepEqual(result, { status: 200, attempts: 1 });
  } finally {
    restore();
  }
  assert.deepEqual(postOnceTimers(recorded), [MAX_TIMER_MS]);
});

test("small timeoutMs keeps its exact value and still times out a hanging request", async () => {
  const signed = goldenWebhook();
  const { recorded, restore } = installRecordingTimers();
  try {
    await assert.rejects(
      deliverSettlementWebhook("https://hooks.example.com/settlement", signed, {
        timeoutMs: 50,
        retries: 0,
        fetchImpl: hangingFetch(),
      }),
      /failed after 1 attempt: webhook delivery timed out after 50ms/,
    );
  } finally {
    restore();
  }
  assert.deepEqual(postOnceTimers(recorded), [50]);
});

test("overallDeadlineMs 3e9 arms the ceiling on a successful fan-out", async () => {
  const report = goldenReport();
  const { recorded, restore } = installRecordingTimers();
  try {
    const result = await deliverSettlementWebhookToMany(
      report,
      [
        {
          url: "https://hooks.example.com/settlement",
          secret: SECRET,
          fetchImpl: statusFetch(200),
        },
      ],
      { overallDeadlineMs: 3e9 },
    );
    assert.equal(result.delivered, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.deadlineExceeded, false);
  } finally {
    restore();
  }
  assert.deepEqual(deadlineTimers(recorded), [MAX_TIMER_MS]);
});

test("overallDeadlineMs 3e9 still stops a hanging endpoint with the deadline error", async () => {
  const report = goldenReport();
  const { recorded, restore } = installRecordingTimers();
  try {
    const result = await deliverSettlementWebhookToMany(
      report,
      [
        {
          url: "https://hooks.example.com/settlement",
          secret: SECRET,
          fetchImpl: hangingFetch(),
        },
      ],
      { overallDeadlineMs: 3e9 },
    );
    assert.equal(result.delivered, 0);
    assert.equal(result.failed, 1);
    assert.equal(result.deadlineExceeded, true);
    assert.equal(
      result.results[0].error,
      "settlement webhook delivery timed out: overall deadline of 3000000000ms exceeded",
    );
  } finally {
    restore();
  }
  assert.deepEqual(deadlineTimers(recorded), [MAX_TIMER_MS]);
});

test("outbox runner default sleep clamps its between-rounds backoff to the ceiling", async () => {
  const outbox = new SettlementWebhookOutbox({ maxAttempts: 10 });
  outbox.recordAttempt({
    endpoint: "https://books.example/hooks/settlement",
    eventId: "evt-timer-ceiling",
    ok: false,
    error: "server responded with status 500",
  });
  const { recorded, restore } = installRecordingTimers();
  try {
    const summary = await retrySettlementWebhookOutbox(
      outbox,
      async () => false,
      { backoffMs: 1_200_000_000, maxRounds: 3 },
    );
    assert.deepEqual(summary, {
      attempted: 3,
      acknowledged: 0,
      stillPending: 1,
      deadLettered: 0,
      aborted: false,
    });
  } finally {
    restore();
  }
  // Between-rounds sleeps: 1_200_000_000 (under the ceiling) then
  // 2_400_000_000 (clamped to the ceiling).
  assert.deepEqual(sleeps(recorded), [1_200_000_000, MAX_TIMER_MS]);
});
