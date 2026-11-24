/**
 * parseRetryAfter() shape guard (backlog #1386).
 *
 * The function validated `nowMs` but called `value.trim()` with no type
 * check, so `parseRetryAfter(120)` / `(true)` / `({})` died as a bare
 * `TypeError: value.trim is not a function` — the error carries no
 * function name, and if a caller treats the throw as "no hint" it
 * silently falls back to exponential backoff, masking a caller bug
 * (a header value parsed into a number upstream) as a missing hint.
 * A non-string `value` now throws the named
 * `parseRetryAfter: value must be a string, got …` error. The tolerated
 * cases are unchanged: `null`/`undefined` still return `undefined`,
 * and a garbage *string* ("banana") still returns `undefined`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { parseRetryAfter } from "../src/index.js";

const NOW = 1_700_000_000_000;

test("parseRetryAfter: non-string values throw a named error", () => {
  for (const bad of [120, true, {}, [], Symbol("retry-after")] as const) {
    assert.throws(
      () => parseRetryAfter(bad as never, NOW),
      (error: unknown) =>
        error instanceof Error &&
        error.message ===
          `parseRetryAfter: value must be a string, got ${typeof bad}`,
      `expected a named error for ${String(bad)}`,
    );
  }
});

test("parseRetryAfter: the error is a plain Error, not a bare TypeError", () => {
  assert.throws(
    () => parseRetryAfter(120 as never, NOW),
    (error: unknown) =>
      error instanceof Error &&
      !(error instanceof TypeError) &&
      error.message.startsWith("parseRetryAfter: value must be a string, got "),
  );
});

test("parseRetryAfter: null and undefined still return undefined", () => {
  assert.equal(parseRetryAfter(null, NOW), undefined);
  assert.equal(parseRetryAfter(undefined, NOW), undefined);
});

test("parseRetryAfter: delay-seconds parsing is unchanged", () => {
  assert.equal(parseRetryAfter("120", NOW), 120_000);
  assert.equal(parseRetryAfter("0", NOW), 0);
  assert.equal(parseRetryAfter("  30 ", NOW), 30_000);
  assert.equal(parseRetryAfter("1.5", NOW), 1500);
});

test("parseRetryAfter: HTTP-date parsing is unchanged", () => {
  const future = new Date(NOW + 5000).toUTCString();
  const delta = parseRetryAfter(future, NOW);
  assert.ok(
    delta !== undefined && delta > 4000 && delta <= 5000,
    `HTTP-date delta ${delta}ms`,
  );
  assert.equal(parseRetryAfter(new Date(NOW - 1000).toUTCString(), NOW), 0);
});

test("parseRetryAfter: signed numbers are rejected and garbage strings fall back", () => {
  assert.equal(parseRetryAfter("-5", NOW), undefined);
  assert.equal(parseRetryAfter("+5", NOW), undefined);
  assert.equal(parseRetryAfter("banana", NOW), undefined);
  assert.equal(parseRetryAfter("", NOW), undefined);
  assert.equal(parseRetryAfter("   ", NOW), undefined);
});

test("parseRetryAfter: illegal nowMs still throws the existing error", () => {
  for (const badNow of [Number.NaN, Infinity, -Infinity, "x", null] as const) {
    assert.throws(
      () => parseRetryAfter("120", badNow as never),
      (error: unknown) =>
        error instanceof Error &&
        error.message.startsWith(
          "parseRetryAfter: nowMs must be a finite epoch-millisecond number, got ",
        ),
      `expected the nowMs error for ${String(badNow)}`,
    );
  }
});

test("parseRetryAfter: the value guard runs before any parsing", () => {
  // A non-string must fail even when the clock is broken too — the clock
  // check stays first, so a bad clock still reports the clock, not the
  // value; with a good clock the value error is the one reported.
  assert.throws(
    () => parseRetryAfter(120 as never, Number.NaN),
    /nowMs must be a finite epoch-millisecond number/,
  );
  assert.throws(
    () => parseRetryAfter(120 as never, NOW),
    /value must be a string, got number/,
  );
});
