/**
 * Webhook-infra constructor shape guards (backlog #1361).
 *
 * `SettlementEventDedupe` and `SettlementWebhookOutbox` both started
 * their constructor with the unknown-option scan's `Object.keys(opts)`
 * and no shape check, so a null options value surfaced a bare
 * `TypeError` (`Cannot convert undefined or null to object`) — and
 * the gap was wider than null: a string options value surfaced the
 * misleading `unknown option "0"` (string indices are keys), while a
 * number or an array carried no option keys at all and silently
 * constructed with every default in place. Both constructors now
 * share the `assertWebhookOptionsObject` guard at the top, verbatim
 * the dataquest `PayoutEventDedupe` / `PayoutWebhookOutbox` wording
 * (`<Class>: opts must be an object`, #1330), running before the
 * unknown-option scan and before any field is read. `restore()` /
 * `restoreSignedSnapshot()` inherit it through the constructor.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  SettlementEventDedupe,
  SettlementWebhookOutbox,
} from "../src/index.js";

/**
 * Assert the call throws a configuration Error (a plain Error, never a
 * bare TypeError) with exactly this message.
 */
function assertThrowsConfigError(fn: () => unknown, message: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error, "expected an Error to be thrown");
  assert.ok(
    !(caught instanceof TypeError),
    `expected a configuration Error, got TypeError: ${caught.message}`,
  );
  assert.equal(caught.message, message);
}

// --- SettlementEventDedupe: null / non-object opts -------------------------

test("dedupe: null opts throws a named error, not a bare TypeError", () => {
  assertThrowsConfigError(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => new SettlementEventDedupe(null as any),
    "SettlementEventDedupe: opts must be an object",
  );
});

test("dedupe: string opts throws the named error, not unknown option \"0\"", () => {
  assertThrowsConfigError(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => new SettlementEventDedupe("x" as any),
    "SettlementEventDedupe: opts must be an object",
  );
});

test("dedupe: number opts throws a named error instead of silently defaulting", () => {
  assertThrowsConfigError(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => new SettlementEventDedupe(42 as any),
    "SettlementEventDedupe: opts must be an object",
  );
});

test("dedupe: array opts throws a named error instead of silently defaulting", () => {
  assertThrowsConfigError(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => new SettlementEventDedupe([] as any),
    "SettlementEventDedupe: opts must be an object",
  );
});

// --- SettlementWebhookOutbox: null / non-object opts -----------------------

test("outbox: null opts throws a named error, not a bare TypeError", () => {
  assertThrowsConfigError(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => new SettlementWebhookOutbox(null as any),
    "SettlementWebhookOutbox: opts must be an object",
  );
});

test("outbox: string opts throws the named error, not unknown option \"0\"", () => {
  assertThrowsConfigError(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => new SettlementWebhookOutbox("x" as any),
    "SettlementWebhookOutbox: opts must be an object",
  );
});

test("outbox: number opts throws a named error instead of silently defaulting", () => {
  assertThrowsConfigError(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => new SettlementWebhookOutbox(42 as any),
    "SettlementWebhookOutbox: opts must be an object",
  );
});

test("outbox: array opts throws a named error instead of silently defaulting", () => {
  assertThrowsConfigError(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => new SettlementWebhookOutbox([] as any),
    "SettlementWebhookOutbox: opts must be an object",
  );
});

// --- guard ordering: before the unknown-option scan ------------------------

test("guard runs before the unknown-option scan: null opts names opts, not a key", () => {
  // A null value has no keys to scan; the opts guard must fire first.
  assertThrowsConfigError(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => new SettlementEventDedupe(null as any),
    "SettlementEventDedupe: opts must be an object",
  );
  assertThrowsConfigError(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => new SettlementWebhookOutbox(null as any),
    "SettlementWebhookOutbox: opts must be an object",
  );
});

test("unknown option keys still fail closed after the guard", () => {
  assertThrowsConfigError(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => new SettlementEventDedupe({ ttl: 1000 } as any),
    'SettlementEventDedupe: unknown option "ttl"',
  );
  assertThrowsConfigError(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => new SettlementWebhookOutbox({ maxAttempt: 5 } as any),
    'SettlementWebhookOutbox: unknown option "maxAttempt"',
  );
});

// --- legal construction unchanged ------------------------------------------

test("legal construction: default dedupe and outbox behave as before", () => {
  const dedupe = new SettlementEventDedupe();
  assert.equal(dedupe.checkAndRecord("evt-1"), false);
  assert.equal(dedupe.checkAndRecord("evt-1"), true);
  assert.equal(dedupe.stats().size, 1);

  const outbox = new SettlementWebhookOutbox();
  outbox.recordAttempt({
    endpoint: "https://example.invalid/hook",
    eventId: "evt-1",
    ok: false,
    error: "boom",
  });
  assert.equal(outbox.pending().length, 1);
  assert.equal(outbox.deadLetter().length, 0);
});

test("legal construction: custom capacity/TTL/injected clock honored", () => {
  const now = () => 1_000;
  const dedupe = new SettlementEventDedupe({
    ttlMs: 60_000,
    maxEntries: 2,
    now,
  });
  assert.equal(dedupe.checkAndRecord("evt-a"), false);
  assert.equal(dedupe.has("evt-a"), true);

  const outbox = new SettlementWebhookOutbox({
    maxAttempts: 2,
    maxEntries: 5,
    now,
  });
  outbox.recordAttempt({
    endpoint: "https://example.invalid/hook",
    eventId: "evt-b",
    ok: false,
    error: "boom",
  });
  outbox.recordAttempt({
    endpoint: "https://example.invalid/hook",
    eventId: "evt-b",
    ok: false,
    error: "boom again",
  });
  assert.equal(outbox.pending().length, 0);
  assert.equal(outbox.deadLetter().length, 1);
});

test("explicit undefined opts takes the default path", () => {
  const dedupe = new SettlementEventDedupe(undefined);
  assert.equal(dedupe.checkAndRecord("evt-u"), false);
  const outbox = new SettlementWebhookOutbox(undefined);
  assert.equal(outbox.pending().length, 0);
});

// --- restore() inherits the guard through the constructor ------------------

test("restore: null opts inherits the named error", () => {
  assertThrowsConfigError(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => SettlementEventDedupe.restore({ v: 1, entries: [] }, null as any),
    "SettlementEventDedupe: opts must be an object",
  );
  assertThrowsConfigError(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () =>
      SettlementWebhookOutbox.restore({ v: 1, entries: [] }, null as any),
    "SettlementWebhookOutbox: opts must be an object",
  );
});
