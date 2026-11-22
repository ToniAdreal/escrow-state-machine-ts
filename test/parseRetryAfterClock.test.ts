import test from "node:test";
import assert from "node:assert/strict";
import { parseRetryAfter } from "../src/index.js";

/**
 * A non-finite `nowMs` must fail closed: without the guard the HTTP-date
 * branch returns `Math.max(0, when - NaN)` = NaN, `retryDelayMs` passes it
 * through, and `setTimeout(NaN)` treats it as 0 — a server-prescribed 429
 * backoff silently collapses into an immediate retry. The guard is a plain
 * configuration `Error` (never a `TypeError`), and it names both the
 * function and the offending argument so a caller can find the broken
 * clock.
 */
function assertNowMsConfigError(value: string | null, nowMs: unknown): void {
  assert.throws(
    () => parseRetryAfter(value, nowMs as number),
    (error: unknown) => {
      assert.ok(error instanceof Error, "must throw an Error");
      assert.ok(
        !(error instanceof TypeError),
        "a configuration error, not a TypeError",
      );
      assert.match(error.message, /parseRetryAfter/);
      assert.match(error.message, /nowMs/);
      return true;
    },
  );
}

const FIXED_NOW = Date.parse("2026-11-21T12:00:00.000Z");
const FUTURE_HTTP_DATE = new Date(FIXED_NOW + 5000).toUTCString();

test("parseRetryAfter: NaN nowMs throws on the HTTP-date path", () => {
  assertNowMsConfigError(FUTURE_HTTP_DATE, Number.NaN);
});

test("parseRetryAfter: Infinity nowMs throws on the HTTP-date path", () => {
  assertNowMsConfigError(FUTURE_HTTP_DATE, Number.POSITIVE_INFINITY);
});

test("parseRetryAfter: -Infinity nowMs throws on the HTTP-date path", () => {
  assertNowMsConfigError(FUTURE_HTTP_DATE, Number.NEGATIVE_INFINITY);
});

test("parseRetryAfter: non-number nowMs throws on the HTTP-date path", () => {
  assertNowMsConfigError(FUTURE_HTTP_DATE, "2026-11-21T12:00:00.000Z");
});

test("parseRetryAfter: NaN nowMs throws on the delay-seconds path too", () => {
  // The guard runs before any parsing, so the branch that never reads
  // `nowMs` fails closed on a broken clock as well.
  assertNowMsConfigError("120", Number.NaN);
});

test("parseRetryAfter: NaN nowMs throws even when the value is absent", () => {
  // An absent value would otherwise return `undefined` without touching
  // the clock; a caller that explicitly passed a broken clock is told so.
  assertNowMsConfigError(null, Number.NaN);
});

test("parseRetryAfter: finite nowMs keeps HTTP-date and delay-seconds behavior", () => {
  const delta = parseRetryAfter(FUTURE_HTTP_DATE, FIXED_NOW);
  assert.ok(
    delta !== undefined && delta > 4000 && delta <= 5000,
    `HTTP-date delta ${delta}ms`,
  );
  assert.equal(parseRetryAfter("120", FIXED_NOW), 120_000);
  assert.equal(parseRetryAfter("0", FIXED_NOW), 0);
  assert.equal(
    parseRetryAfter(new Date(FIXED_NOW - 1000).toUTCString(), FIXED_NOW),
    0,
  );
});

test("parseRetryAfter: default nowMs still works for a future HTTP-date", () => {
  const future = new Date(Date.now() + 5000).toUTCString();
  const delta = parseRetryAfter(future);
  assert.ok(
    delta !== undefined && delta > 4000 && delta <= 5000,
    `default-clock HTTP-date delta ${delta}ms`,
  );
});
