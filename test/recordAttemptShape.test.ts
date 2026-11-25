import test from "node:test";
import assert from "node:assert/strict";
import {
  SettlementWebhookOutbox,
  retrySettlementWebhookOutbox,
} from "../src/index.js";

/**
 * `SettlementWebhookOutbox.recordAttempt` shape guard (backlog #1392).
 *
 * `recordAttempt()` destructured its `attempt` argument as its first
 * statement, so a `null`/`undefined` attempt died as a bare
 * `TypeError` (`Cannot destructure property 'endpoint' of 'attempt'
 * as it is null`) — the same gap the dataquest twin
 * `PayoutWebhookOutbox.recordAttempt` closed in commit `56f7fc3`.
 * A wrong-shape attempt is a caller bug and must be reported as
 * itself — a configuration error naming the value — before any
 * field is read, with zero records written. Rules under test:
 *  - `null` / `undefined` / number / boolean / array each throw the
 *    verbatim `SettlementWebhookOutbox: attempt must be an object,
 *    got <null|undefined|number|boolean|array>` error, never a
 *    TypeError, and the ledger stays empty (`size` 0, `pending()`
 *    empty)
 *  - a string attempt keeps its pre-existing behaviour: it falls
 *    through to the field checks, which reject it as a non-empty
 *    `endpoint`, with zero records written
 *  - a legal failed attempt still lands in `pending()`; the third
 *    consecutive failure still dead-letters; a success still clears
 *    the pair — the guard changes no legal path
 *  - the `retrySettlementWebhookOutbox` failure path is unaffected:
 *    a failed re-delivery still records one more attempt, and a
 *    `deliverOne` that throws is still recorded with its message
 *    instead of crashing the run
 */

const A = "https://books.example/hooks/settlement";
const EVT_1 = "evt-1392-1";

/** Exact-message throw, and never a bare TypeError. */
function assertConfigError(fn: () => unknown, message: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof Error, "expected an Error to be thrown");
    assert.ok(
      !(err instanceof TypeError),
      `expected a config Error, got TypeError: ${(err as Error).message}`,
    );
    assert.equal((err as Error).message, message);
    return true;
  });
}

function assertEmpty(outbox: SettlementWebhookOutbox): void {
  assert.equal(outbox.size, 0);
  assert.deepEqual(outbox.pending(), []);
  assert.deepEqual(outbox.deadLetter(), []);
}

test("null attempt throws a named error and records nothing", () => {
  const outbox = new SettlementWebhookOutbox();
  assertConfigError(
    () => outbox.recordAttempt(null as never),
    "SettlementWebhookOutbox: attempt must be an object, got null",
  );
  assertEmpty(outbox);
});

test("undefined attempt throws a named error and records nothing", () => {
  const outbox = new SettlementWebhookOutbox();
  assertConfigError(
    () => outbox.recordAttempt(undefined as never),
    "SettlementWebhookOutbox: attempt must be an object, got undefined",
  );
  assertEmpty(outbox);
});

test("number and boolean attempts throw a named error and record nothing", () => {
  const outbox = new SettlementWebhookOutbox();
  for (const bad of [42, true] as never[]) {
    assertConfigError(
      () => outbox.recordAttempt(bad),
      `SettlementWebhookOutbox: attempt must be an object, got ${typeof bad}`,
    );
  }
  assertEmpty(outbox);
});

test("array attempt throws a named error and records nothing", () => {
  const outbox = new SettlementWebhookOutbox();
  assertConfigError(
    () => outbox.recordAttempt([] as never),
    "SettlementWebhookOutbox: attempt must be an object, got array",
  );
  assertEmpty(outbox);
});

test("string attempt keeps the pre-existing field error and records nothing", () => {
  const outbox = new SettlementWebhookOutbox();
  assertConfigError(
    () => outbox.recordAttempt("x" as never),
    "SettlementWebhookOutbox: endpoint must be a non-empty string",
  );
  assertEmpty(outbox);
});

test("a legal failed attempt still lands in pending", () => {
  const outbox = new SettlementWebhookOutbox();
  outbox.recordAttempt({
    endpoint: A,
    eventId: EVT_1,
    ok: false,
    error: "server responded with status 500",
    at: 1_700_000_000_000,
  });
  assert.equal(outbox.size, 1);
  assert.deepEqual(outbox.pending(), [
    {
      endpoint: A,
      eventId: EVT_1,
      attempts: 1,
      lastAt: 1_700_000_000_000,
      lastError: "server responded with status 500",
    },
  ]);
});

test("the third consecutive failure still dead-letters", () => {
  const outbox = new SettlementWebhookOutbox();
  for (let i = 0; i < 3; i += 1) {
    outbox.recordAttempt({
      endpoint: A,
      eventId: EVT_1,
      ok: false,
      error: "server responded with status 500",
      at: 1_700_000_000_000 + i,
    });
  }
  assert.equal(outbox.size, 1);
  assert.deepEqual(outbox.pending(), []);
  assert.equal(outbox.deadLetter().length, 1);
  assert.equal(outbox.deadLetter()[0].attempts, 3);
});

test("a success still clears the pair", () => {
  const outbox = new SettlementWebhookOutbox();
  outbox.recordAttempt({
    endpoint: A,
    eventId: EVT_1,
    ok: false,
    error: "server responded with status 500",
    at: 1_700_000_000_000,
  });
  assert.equal(outbox.size, 1);
  outbox.recordAttempt({
    endpoint: A,
    eventId: EVT_1,
    ok: true,
    status: 200,
    at: 1_700_000_000_001,
  });
  assertEmpty(outbox);
});

test("retry runner failure path still records the re-delivery", async () => {
  const outbox = new SettlementWebhookOutbox({ now: () => 1_700_000_000_000 });
  outbox.recordAttempt({
    endpoint: A,
    eventId: EVT_1,
    ok: false,
    error: "server responded with status 500",
    at: 1_700_000_000_000,
  });
  const summary = await retrySettlementWebhookOutbox(
    outbox,
    async () => false,
  );
  assert.equal(summary.attempted, 1);
  assert.equal(summary.stillPending, 1);
  assert.equal(outbox.pending()[0].attempts, 2);
});

test("retry runner still records a throwing deliverOne instead of crashing", async () => {
  const outbox = new SettlementWebhookOutbox({ now: () => 1_700_000_000_000 });
  outbox.recordAttempt({
    endpoint: A,
    eventId: EVT_1,
    ok: false,
    error: "server responded with status 500",
    at: 1_700_000_000_000,
  });
  const summary = await retrySettlementWebhookOutbox(outbox, async () => {
    throw new Error("connection reset");
  });
  assert.equal(summary.attempted, 1);
  assert.equal(summary.stillPending, 1);
  assert.equal(outbox.pending()[0].attempts, 2);
  assert.equal(outbox.pending()[0].lastError, "connection reset");
});
