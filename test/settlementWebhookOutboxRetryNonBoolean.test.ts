import test from "node:test";
import assert from "node:assert/strict";
import {
  SettlementWebhookOutbox,
  retrySettlementWebhookOutbox,
} from "../src/index.js";

/**
 * `retrySettlementWebhookOutbox` and non-boolean `deliverOne`
 * resolutions (backlog #1420, mirroring dataquest #1407).
 *
 * A `deliverOne` that resolves to a non-boolean is a caller bug in
 * the transport, but it must not abort the whole round: the old
 * behaviour threw out of the per-pair worker, which rejected the
 * runner's `Promise.all` — the run died with no summary, the
 * healthy pairs were never attempted, and the misshapen pair was
 * never recorded, so it stayed pending forever and blew up the
 * next run at the same spot. Rules under test:
 *  - a non-boolean resolution is recorded as one failed attempt
 *    for that pair only, with the named error
 *    `retrySettlementWebhookOutbox: deliverOne must resolve to a
 *    boolean, got <typeof>` as `lastError`; `attempted` counts it
 *    (the transport was called) and the run continues with the
 *    remaining pairs, returning a normal summary
 *  - each non-boolean shape records its own `typeof` in the error
 *  - a non-boolean failure counts toward the dead letter like any
 *    other failure, and a pair that failed this way stays pending
 *    and can succeed on a later round
 *  - under concurrency the misshapen return does not reject the
 *    worker pool, and mixed rounds (non-boolean / throw / false /
 *    true) are all recorded with the run completing
 *  - boolean `true`/`false` and throwing `deliverOne` behaviour
 *    is unchanged (controls)
 */

const A = "https://books.example/hooks/settlement";
const B = "https://ledger.example/hooks/settlement";
const EVT_1 = "evt-0001";
const EVT_2 = "evt-0002";

function fail(
  outbox: SettlementWebhookOutbox,
  endpoint: string,
  eventId: string,
  error = "server responded with status 500",
): void {
  outbox.recordAttempt({ endpoint, eventId, ok: false, error });
}

test("a non-boolean deliverOne result is recorded as a failed attempt and the run continues", async () => {
  const outbox = new SettlementWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1);
  fail(outbox, B, EVT_2);

  const summary = await retrySettlementWebhookOutbox(
    outbox,
    async (_endpoint, eventId) =>
      (eventId === EVT_1 ? undefined : true) as unknown as boolean,
    {},
  );
  // The misshapen return cost the first pair one attempt and a
  // named error; the second pair was still delivered and cleared.
  assert.deepEqual(summary, {
    attempted: 2,
    acknowledged: 1,
    stillPending: 1,
    deadLettered: 0,
    aborted: false,
  });
  const pending = outbox.pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].eventId, EVT_1);
  assert.equal(pending[0].attempts, 2);
  assert.equal(
    pending[0].lastError,
    "retrySettlementWebhookOutbox: deliverOne must resolve to a boolean, got undefined",
  );
});

test("each non-boolean shape records its own typeof in the named error", async () => {
  const outbox = new SettlementWebhookOutbox({ maxAttempts: 10 });
  fail(outbox, A, EVT_1);
  fail(outbox, A, EVT_2);
  fail(outbox, B, EVT_1);
  fail(outbox, B, EVT_2);
  const returns: Record<string, unknown> = {
    [EVT_1 + A]: undefined,
    [EVT_2 + A]: null,
    [EVT_1 + B]: 0,
    [EVT_2 + B]: {},
  };

  const summary = await retrySettlementWebhookOutbox(
    outbox,
    async (endpoint, eventId) =>
      returns[eventId + endpoint] as unknown as boolean,
    {},
  );
  assert.deepEqual(summary, {
    attempted: 4,
    acknowledged: 0,
    stillPending: 4,
    deadLettered: 0,
    aborted: false,
  });
  const byPair = new Map(
    outbox.pending().map((e) => [`${e.eventId}${e.endpoint}`, e]),
  );
  assert.equal(
    byPair.get(EVT_1 + A)?.lastError,
    "retrySettlementWebhookOutbox: deliverOne must resolve to a boolean, got undefined",
  );
  assert.equal(
    byPair.get(EVT_2 + A)?.lastError,
    "retrySettlementWebhookOutbox: deliverOne must resolve to a boolean, got object",
  );
  assert.equal(
    byPair.get(EVT_1 + B)?.lastError,
    "retrySettlementWebhookOutbox: deliverOne must resolve to a boolean, got number",
  );
  assert.equal(
    byPair.get(EVT_2 + B)?.lastError,
    "retrySettlementWebhookOutbox: deliverOne must resolve to a boolean, got object",
  );
  assert.ok(outbox.pending().every((e) => e.attempts === 2));
});

test("a non-boolean failure counts toward the dead letter like any other failure", async () => {
  const outbox = new SettlementWebhookOutbox({ maxAttempts: 2 });
  fail(outbox, A, EVT_1);

  const summary = await retrySettlementWebhookOutbox(
    outbox,
    async () => undefined as unknown as boolean,
    {},
  );
  assert.deepEqual(summary, {
    attempted: 1,
    acknowledged: 0,
    stillPending: 0,
    deadLettered: 1,
    aborted: false,
  });
  assert.equal(outbox.deadLetter().length, 1);
  assert.equal(outbox.deadLetter()[0].eventId, EVT_1);
  assert.equal(
    outbox.deadLetter()[0].lastError,
    "retrySettlementWebhookOutbox: deliverOne must resolve to a boolean, got undefined",
  );
});

test("a pair that failed on a non-boolean return stays pending and can succeed on a later round", async () => {
  const outbox = new SettlementWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1);
  let calls = 0;

  const summary = await retrySettlementWebhookOutbox(
    outbox,
    async () => {
      calls += 1;
      return (calls === 1 ? undefined : true) as unknown as boolean;
    },
    { maxRounds: 2, backoffMs: 0, sleepImpl: async () => {} },
  );
  assert.equal(calls, 2);
  assert.deepEqual(summary, {
    attempted: 2,
    acknowledged: 1,
    stillPending: 0,
    deadLettered: 0,
    aborted: false,
  });
});

test("a non-boolean result under concurrency does not reject the worker pool", async () => {
  const outbox = new SettlementWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1);
  fail(outbox, B, EVT_2);

  const summary = await retrySettlementWebhookOutbox(
    outbox,
    async () => undefined as unknown as boolean,
    { maxConcurrency: 2 },
  );
  assert.deepEqual(summary, {
    attempted: 2,
    acknowledged: 0,
    stillPending: 2,
    deadLettered: 0,
    aborted: false,
  });
  assert.ok(
    outbox.pending().every(
      (e) =>
        e.lastError ===
        "retrySettlementWebhookOutbox: deliverOne must resolve to a boolean, got undefined",
    ),
  );
});

test("mixed outcomes in one round: non-boolean, throw, false and true are all recorded and the run completes", async () => {
  const outbox = new SettlementWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1);
  fail(outbox, A, EVT_2);
  fail(outbox, B, EVT_1);
  fail(outbox, B, EVT_2);
  const behaviours: Record<string, () => unknown> = {
    [EVT_1 + A]: () => undefined,
    [EVT_2 + A]: () => {
      throw new Error("boom: connection reset");
    },
    [EVT_1 + B]: () => false,
    [EVT_2 + B]: () => true,
  };

  const summary = await retrySettlementWebhookOutbox(
    outbox,
    async (endpoint, eventId) =>
      behaviours[eventId + endpoint]() as unknown as boolean,
    {},
  );
  assert.deepEqual(summary, {
    attempted: 4,
    acknowledged: 1,
    stillPending: 3,
    deadLettered: 0,
    aborted: false,
  });
  const byPair = new Map(
    outbox.pending().map((e) => [`${e.eventId}${e.endpoint}`, e]),
  );
  assert.equal(
    byPair.get(EVT_1 + A)?.lastError,
    "retrySettlementWebhookOutbox: deliverOne must resolve to a boolean, got undefined",
  );
  assert.equal(byPair.get(EVT_2 + A)?.lastError, "boom: connection reset");
  // A plain `false` return records the attempt with no new error
  // text, so the pair's `lastError` is cleared rather than carried
  // over from the earlier failure.
  assert.equal(byPair.get(EVT_1 + B)?.lastError, undefined);
  assert.ok(outbox.pending().every((e) => e.attempts === 2));
});

test("boolean true/false behaviour is unchanged (control)", async () => {
  const outbox = new SettlementWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1);
  fail(outbox, B, EVT_2);

  const summary = await retrySettlementWebhookOutbox(
    outbox,
    async (_endpoint, eventId) => eventId === EVT_2,
    {},
  );
  assert.deepEqual(summary, {
    attempted: 2,
    acknowledged: 1,
    stillPending: 1,
    deadLettered: 0,
    aborted: false,
  });
  const pending = outbox.pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].eventId, EVT_1);
  assert.equal(pending[0].attempts, 2);
  assert.equal(pending[0].lastError, undefined);
});

test("a throwing deliverOne is still recorded as a failed attempt and the run continues (control)", async () => {
  const outbox = new SettlementWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1);
  fail(outbox, B, EVT_2);

  const summary = await retrySettlementWebhookOutbox(
    outbox,
    async (_endpoint, eventId) => {
      if (eventId === EVT_1) throw new Error("boom: connection reset");
      return true;
    },
    {},
  );
  assert.deepEqual(summary, {
    attempted: 2,
    acknowledged: 1,
    stillPending: 1,
    deadLettered: 0,
    aborted: false,
  });
  const pending = outbox.pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].eventId, EVT_1);
  assert.equal(pending[0].attempts, 2);
  assert.equal(pending[0].lastError, "boom: connection reset");
});
