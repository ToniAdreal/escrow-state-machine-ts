import test from "node:test";
import assert from "node:assert/strict";
import {
  SettlementWebhookOutbox,
  retrySettlementWebhookOutbox,
} from "../src/index.js";

/**
 * Retry runner clock fail-closed (backlog #1332).
 *
 * `retrySettlementWebhookOutbox` used to validate `opts.now` only as
 * "is a function" and never check what it returned. Both failure
 * paths then called `clock()` inside `recordAttempt({ …, at:
 * clock() })`, and `recordAttempt` threw "at must be a finite
 * number" — escaping the per-pair worker, rejecting the runner's
 * `Promise.all`, and killing the whole multi-pair run with no
 * summary, while the pair stayed pending and unrecorded. Rules
 * under test:
 *  - a non-finite runner clock (`NaN`, `Infinity`, a non-number)
 *    throws a configuration error at the round boundary, before
 *    any pair in that round is delivered (`deliverOne` is never
 *    called); the message names the runner, not the ledger
 *  - a clock that goes bad mid-run fails at the next round's
 *    boundary, and earlier rounds' recorded attempts are kept
 *  - a good clock still records failures normally, stamped with
 *    the round-resolved `at`
 *  - a dry run never reads the runner clock, even a `NaN` one
 *  - with nothing pending the runner returns an empty summary
 *    without reading the clock at all
 */

const A = "https://books.example/hooks/settlement";
const B = "https://ledger.example/hooks/settlement";
const EVT_1 = "evt-0001";
const EVT_2 = "evt-0002";
const EVT_3 = "evt-0003";

function onePendingPair(): SettlementWebhookOutbox {
  const outbox = new SettlementWebhookOutbox({ maxAttempts: 3 });
  outbox.recordAttempt({
    endpoint: A,
    eventId: EVT_1,
    ok: false,
    error: "server responded with status 500",
    at: 1000,
  });
  return outbox;
}

function threePendingPairs(): SettlementWebhookOutbox {
  const outbox = new SettlementWebhookOutbox({ maxAttempts: 3 });
  for (const [endpoint, eventId] of [
    [A, EVT_1],
    [A, EVT_2],
    [B, EVT_3],
  ] as const) {
    outbox.recordAttempt({
      endpoint,
      eventId,
      ok: false,
      error: "server responded with status 500",
      at: 1000,
    });
  }
  return outbox;
}

test("NaN clock fails before delivery on the throwing branch", async () => {
  const outbox = onePendingPair();
  let calls = 0;
  await assert.rejects(
    retrySettlementWebhookOutbox(
      outbox,
      async () => {
        calls += 1;
        throw new Error("gateway down");
      },
      { now: () => NaN },
    ),
    {
      message:
        "retrySettlementWebhookOutbox: now must return a finite number of milliseconds since the epoch, got NaN",
    },
  );
  assert.equal(calls, 0);
  // No attempt was recorded: the pair is exactly as seeded.
  assert.equal(outbox.pending().length, 1);
  assert.equal(outbox.pending()[0].attempts, 1);
  assert.equal(outbox.pending()[0].lastAt, 1000);
});

test("NaN clock fails before delivery on the false branch", async () => {
  const outbox = onePendingPair();
  let calls = 0;
  await assert.rejects(
    retrySettlementWebhookOutbox(
      outbox,
      async () => {
        calls += 1;
        return false;
      },
      { now: () => NaN },
    ),
    {
      message:
        "retrySettlementWebhookOutbox: now must return a finite number of milliseconds since the epoch, got NaN",
    },
  );
  assert.equal(calls, 0);
  assert.equal(outbox.pending()[0].attempts, 1);
  assert.equal(outbox.pending()[0].lastAt, 1000);
});

test("Infinity clock fails before delivery on the false branch", async () => {
  const outbox = onePendingPair();
  let calls = 0;
  await assert.rejects(
    retrySettlementWebhookOutbox(
      outbox,
      async () => {
        calls += 1;
        return false;
      },
      { now: () => Infinity },
    ),
    {
      message:
        "retrySettlementWebhookOutbox: now must return a finite number of milliseconds since the epoch, got Infinity",
    },
  );
  assert.equal(calls, 0);
  assert.equal(outbox.pending()[0].attempts, 1);
});

test("non-number clock reading fails before delivery", async () => {
  const outbox = onePendingPair();
  let calls = 0;
  await assert.rejects(
    retrySettlementWebhookOutbox(
      outbox,
      async () => {
        calls += 1;
        return false;
      },
      // Deliberately wrong type: the runner must fail-closed
      // instead of stamping a string into the ledger.
      { now: () => "x" as unknown as number },
    ),
    {
      message:
        "retrySettlementWebhookOutbox: now must return a finite number of milliseconds since the epoch, got x",
    },
  );
  assert.equal(calls, 0);
  assert.equal(outbox.pending()[0].attempts, 1);
});

test("NaN clock delivers no pair at all in a multi-pair run", async () => {
  const outbox = threePendingPairs();
  let calls = 0;
  await assert.rejects(
    retrySettlementWebhookOutbox(
      outbox,
      async () => {
        calls += 1;
        return false;
      },
      { now: () => NaN },
    ),
    {
      message:
        "retrySettlementWebhookOutbox: now must return a finite number of milliseconds since the epoch, got NaN",
    },
  );
  assert.equal(calls, 0);
  assert.equal(outbox.pending().length, 3);
  assert.deepEqual(
    outbox.pending().map((entry) => entry.attempts),
    [1, 1, 1],
  );
});

test("clock going bad mid-run fails at the next round boundary", async () => {
  const outbox = onePendingPair();
  let clockCalls = 0;
  // First reading good (round 1), every later reading NaN.
  const now = () => {
    clockCalls += 1;
    return clockCalls === 1 ? 2000 : NaN;
  };
  let calls = 0;
  await assert.rejects(
    retrySettlementWebhookOutbox(
      outbox,
      async () => {
        calls += 1;
        return false;
      },
      { now, maxRounds: 2, backoffMs: 0 },
    ),
    {
      message:
        "retrySettlementWebhookOutbox: now must return a finite number of milliseconds since the epoch, got NaN",
    },
  );
  // Round 1 ran exactly once and its failure was recorded; round
  // 2 never delivered anything.
  assert.equal(calls, 1);
  assert.equal(clockCalls, 2);
  assert.equal(outbox.pending().length, 1);
  assert.equal(outbox.pending()[0].attempts, 2);
  assert.equal(outbox.pending()[0].lastAt, 2000);
});

test("good clock records a failed delivery with the round-resolved at", async () => {
  const outbox = onePendingPair();
  const summary = await retrySettlementWebhookOutbox(
    outbox,
    async () => false,
    { now: () => 2000 },
  );
  assert.deepEqual(summary, {
    attempted: 1,
    acknowledged: 0,
    stillPending: 1,
    deadLettered: 0,
    aborted: false,
  });
  assert.equal(outbox.pending()[0].attempts, 2);
  assert.equal(outbox.pending()[0].lastAt, 2000);
});

test("good clock records a throwing delivery with the round-resolved at", async () => {
  const outbox = onePendingPair();
  const summary = await retrySettlementWebhookOutbox(
    outbox,
    async () => {
      throw new Error("gateway down");
    },
    { now: () => 2000 },
  );
  assert.deepEqual(summary, {
    attempted: 1,
    acknowledged: 0,
    stillPending: 1,
    deadLettered: 0,
    aborted: false,
  });
  assert.equal(outbox.pending()[0].attempts, 2);
  assert.equal(outbox.pending()[0].lastAt, 2000);
  assert.equal(outbox.pending()[0].lastError, "gateway down");
});

test("NaN clock dry run reports wouldRetry and never reads the clock", async () => {
  const outbox = onePendingPair();
  let clockCalls = 0;
  const now = () => {
    clockCalls += 1;
    return NaN;
  };
  const summary = await retrySettlementWebhookOutbox(
    outbox,
    async () => false,
    { now, dryRun: true },
  );
  assert.deepEqual(summary, {
    attempted: 0,
    acknowledged: 0,
    stillPending: 1,
    deadLettered: 0,
    aborted: false,
    wouldRetry: [{ endpoint: A, eventId: EVT_1, wouldRetry: true }],
  });
  assert.equal(clockCalls, 0);
  assert.equal(outbox.pending()[0].attempts, 1);
});

test("empty pending list returns an empty summary without reading the clock", async () => {
  const outbox = new SettlementWebhookOutbox({ maxAttempts: 3 });
  let clockCalls = 0;
  const now = () => {
    clockCalls += 1;
    return NaN;
  };
  let calls = 0;
  const summary = await retrySettlementWebhookOutbox(
    outbox,
    async () => {
      calls += 1;
      return false;
    },
    { now },
  );
  assert.deepEqual(summary, {
    attempted: 0,
    acknowledged: 0,
    stillPending: 0,
    deadLettered: 0,
    aborted: false,
  });
  assert.equal(calls, 0);
  assert.equal(clockCalls, 0);
});
