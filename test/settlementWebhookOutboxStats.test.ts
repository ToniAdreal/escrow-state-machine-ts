import test from "node:test";
import assert from "node:assert/strict";
import { SettlementWebhookOutbox } from "../src/index.js";

/**
 * Settlement webhook outbox observability (backlog #1120).
 *
 * `pending()` / `deadLetter()` answer \"which pairs\" only by
 * materializing full entry lists; a caller that only needs the
 * counts — a dashboard, a health check, a log line — had to copy
 * both lists and count them. `stats()` fills that gap, mirroring
 * the sibling `SettlementEventDedupe.stats()` shape. Rules under
 * test:
 *  - `stats()` returns `{ size, pending, deadLettered, totalAttempts }`;
 *    `size` equals the `size` getter and `pending + deadLettered`
 *  - `pending` counts pairs with `attempts < maxAttempts`,
 *    `deadLettered` counts `attempts >= maxAttempts`
 *  - `totalAttempts` sums `attempts` over every tracked pair,
 *    dead-lettered pairs included, at their capped value (a pair
 *    failed 4 times under `maxAttempts: 3` contributes 3, not 4)
 *  - counts follow `recordAttempt` / `acknowledge()` / `clear()`:
 *    a success clears the pair, an acknowledge clears it, `clear()`
 *    zeroes everything
 *  - `stats()` is a pure read: the pending/dead-letter lists are
 *    byte-identical before and after the call, two calls agree, and
 *    mutating the returned object does not touch the ledger
 *  - `restore()` preserves the counts (including through a JSON
 *    stringify/parse hop), and the pending/dead-letter boundary is
 *    re-derived from the restoring outbox's `maxAttempts`
 *  - pairs are keyed by `(endpoint, eventId)`: the same eventId on
 *    two endpoints, and two eventIds on one endpoint, count
 *    independently
 */

const A = "https://books.example/hooks/settlement";
const B = "https://ledger.example/hooks/settlement";
const EVT_1 = "evt-0001";
const EVT_2 = "evt-0002";
const EVT_3 = "evt-0003";

function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function fail(
  outbox: SettlementWebhookOutbox,
  endpoint: string,
  eventId: string,
  times = 1,
  error = "server responded with status 500",
): void {
  for (let i = 0; i < times; i++) {
    outbox.recordAttempt({ endpoint, eventId, ok: false, error });
  }
}

test("an empty outbox reports all zeros", () => {
  const outbox = new SettlementWebhookOutbox();
  assert.deepEqual(outbox.stats(), {
    size: 0,
    pending: 0,
    deadLettered: 0,
    totalAttempts: 0,
  });
  assert.equal(outbox.stats().size, outbox.size);
});

test("a mixed ledger counts pending, dead-lettered, and attempts per field", () => {
  const clock = fakeClock();
  const outbox = new SettlementWebhookOutbox({ now: clock.now });
  fail(outbox, A, EVT_1, 1); // pending, 1 attempt
  fail(outbox, A, EVT_2, 2); // pending, 2 attempts
  fail(outbox, B, EVT_3, 3); // dead-lettered, 3 attempts

  assert.deepEqual(outbox.stats(), {
    size: 3,
    pending: 2,
    deadLettered: 1,
    totalAttempts: 6,
  });
  assert.equal(outbox.stats().size, outbox.size);
  assert.equal(outbox.pending().length, 2);
  assert.equal(outbox.deadLetter().length, 1);
});

test("attempts past the cap still contribute only the capped value", () => {
  const outbox = new SettlementWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1, 4);
  fail(outbox, A, EVT_2, 1);

  assert.deepEqual(outbox.stats(), {
    size: 2,
    pending: 1,
    deadLettered: 1,
    totalAttempts: 4, // 3 (capped) + 1, not 4 + 1
  });
});

test("a successful attempt clears the pair and the counts follow", () => {
  const outbox = new SettlementWebhookOutbox();
  fail(outbox, A, EVT_1, 2);
  fail(outbox, A, EVT_2, 1);
  assert.equal(outbox.stats().totalAttempts, 3);

  outbox.recordAttempt({ endpoint: A, eventId: EVT_1, ok: true });
  assert.deepEqual(outbox.stats(), {
    size: 1,
    pending: 1,
    deadLettered: 0,
    totalAttempts: 1,
  });

  // A later failure for the cleared pair counts from 1 again.
  fail(outbox, A, EVT_1, 1);
  assert.deepEqual(outbox.stats(), {
    size: 2,
    pending: 2,
    deadLettered: 0,
    totalAttempts: 2,
  });
});

test("acknowledge drops the pair and the counts follow; unknown pairs are a no-op", () => {
  const outbox = new SettlementWebhookOutbox();
  fail(outbox, A, EVT_1, 3); // dead-lettered
  fail(outbox, A, EVT_2, 1); // pending
  assert.deepEqual(outbox.stats(), {
    size: 2,
    pending: 1,
    deadLettered: 1,
    totalAttempts: 4,
  });

  outbox.acknowledge(A, EVT_1);
  assert.deepEqual(outbox.stats(), {
    size: 1,
    pending: 1,
    deadLettered: 0,
    totalAttempts: 1,
  });

  outbox.acknowledge(A, "evt-never-seen");
  assert.deepEqual(outbox.stats(), {
    size: 1,
    pending: 1,
    deadLettered: 0,
    totalAttempts: 1,
  });
});

test("clear() zeroes every counter", () => {
  const outbox = new SettlementWebhookOutbox();
  fail(outbox, A, EVT_1, 3);
  fail(outbox, B, EVT_2, 2);
  assert.equal(outbox.stats().size, 2);

  outbox.clear();
  assert.deepEqual(outbox.stats(), {
    size: 0,
    pending: 0,
    deadLettered: 0,
    totalAttempts: 0,
  });
  assert.equal(outbox.size, 0);
});

test("stats() is a pure read and the returned object is detached", () => {
  const outbox = new SettlementWebhookOutbox();
  fail(outbox, A, EVT_1, 2);
  fail(outbox, B, EVT_2, 3);

  const pendingBefore = outbox.pending();
  const deadBefore = outbox.deadLetter();
  const first = outbox.stats();
  assert.deepEqual(outbox.pending(), pendingBefore);
  assert.deepEqual(outbox.deadLetter(), deadBefore);
  assert.deepEqual(outbox.stats(), first);

  // Mutating the returned snapshot must not touch the ledger.
  first.pending = 99;
  first.totalAttempts = 99;
  assert.deepEqual(outbox.stats(), {
    size: 2,
    pending: 1,
    deadLettered: 1,
    totalAttempts: 5,
  });
});

test("restore preserves the counts, including through a JSON hop", () => {
  const outbox = new SettlementWebhookOutbox();
  fail(outbox, A, EVT_1, 1);
  fail(outbox, A, EVT_2, 2);
  fail(outbox, B, EVT_3, 3);
  const expected = {
    size: 3,
    pending: 2,
    deadLettered: 1,
    totalAttempts: 6,
  };
  assert.deepEqual(outbox.stats(), expected);

  const restored = SettlementWebhookOutbox.restore(
    JSON.parse(JSON.stringify(outbox.exportSnapshot())),
  );
  assert.deepEqual(restored.stats(), expected);
  assert.deepEqual(restored.pending(), outbox.pending());
  assert.deepEqual(restored.deadLetter(), outbox.deadLetter());
});

test("restore re-derives the boundary from the new outbox's maxAttempts", () => {
  const outbox = new SettlementWebhookOutbox({ maxAttempts: 3 });
  fail(outbox, A, EVT_1, 2); // pending under maxAttempts 3
  const snapshot = outbox.exportSnapshot();

  const stricter = SettlementWebhookOutbox.restore(snapshot, {
    maxAttempts: 2,
  });
  assert.deepEqual(stricter.stats(), {
    size: 1,
    pending: 0,
    deadLettered: 1,
    totalAttempts: 2,
  });

  const looser = SettlementWebhookOutbox.restore(snapshot, {
    maxAttempts: 5,
  });
  assert.deepEqual(looser.stats(), {
    size: 1,
    pending: 1,
    deadLettered: 0,
    totalAttempts: 2,
  });
});

test("the same eventId on two endpoints counts independently", () => {
  const outbox = new SettlementWebhookOutbox();
  fail(outbox, A, EVT_1, 3); // dead-lettered on A
  fail(outbox, B, EVT_1, 1); // pending on B
  fail(outbox, A, EVT_2, 1); // pending on A

  assert.deepEqual(outbox.stats(), {
    size: 3,
    pending: 2,
    deadLettered: 1,
    totalAttempts: 5,
  });

  // Acknowledging on one endpoint leaves the other endpoint's pair.
  outbox.acknowledge(B, EVT_1);
  assert.deepEqual(outbox.stats(), {
    size: 2,
    pending: 1,
    deadLettered: 1,
    totalAttempts: 4,
  });
});

test("maxAttempts 1 dead-letters on the first failure", () => {
  const outbox = new SettlementWebhookOutbox({ maxAttempts: 1 });
  fail(outbox, A, EVT_1, 1);
  assert.deepEqual(outbox.stats(), {
    size: 1,
    pending: 0,
    deadLettered: 1,
    totalAttempts: 1,
  });
});
