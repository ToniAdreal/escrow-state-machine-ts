/**
 * Optional expiry (`expiresAt`) on the three HMAC-signed snapshot
 * envelopes (backlog #1103): `Escrow`,
 * `SettlementEventDedupe`, and `SettlementWebhookOutbox`,
 * mirroring dataquest's `TaskLifecycle` / `PayoutEventDedupe` /
 * `PayoutWebhookOutbox` envelopes (backlog #1076).
 *
 * A MAC-valid envelope stolen or restored months later could
 * otherwise resurrect expired state (a revoked rolePolicy, cleared
 * idempotency keys, a dead letter cleared) — the webhook side
 * already has the opt-in `maxAgeMs` freshness window, but the
 * snapshot envelopes had no equivalent. Rules under test:
 *  - `exportSignedSnapshot(secret, { expiresAt })` /
 *    `{ maxAgeMs, now? }` writes the timestamp into the envelope
 *    and covers it with the MAC; without either option the
 *    envelope never expires, exactly as before
 *  - `restoreSignedSnapshot` (alias `fromSignedSnapshot`) rejects
 *    an expired envelope fail-closed before any snapshot parsing,
 *    and only when `now > Date.parse(expiresAt)` — restoring at
 *    exactly `expiresAt` still succeeds (the same inclusive
 *    boundary the settlement webhook freshness window uses)
 *  - a tampered `expiresAt` fails as a MAC mismatch (the timestamp
 *    is inside the MAC coverage), never as an expiry
 *  - an invalid `expiresAt` (non-ISO, non-canonical, non-string)
 *    is rejected at export and at restore; `maxAgeMs` must be a
 *    positive finite number, `expiresAt` and `maxAgeMs` are
 *    mutually exclusive, and `now` without `maxAgeMs` is a
 *    configuration error
 *  - the restore clock is injectable (`opts.now`): a plain
 *    millisecond timestamp for `Escrow`, the options'
 *    `now` clock function for the dedupe and the outbox
 *  - envelopes exported without `expiresAt` verify unchanged, so
 *    envelopes written before this field existed still restore
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  Escrow,
  SettlementEventDedupe,
  SettlementWebhookOutbox,
} from "../src/index.js";

const ESCROW_SECRET = "escrow-snapshot-signing-secret-for-tests";
const DEDUPE_SECRET = "settlement-dedupe-snapshot-signing-secret-for-tests";
const OUTBOX_SECRET = "outbox-snapshot-signing-secret-for-tests";
const A = "https://books.example/hooks/settlement";
const B = "https://ledger.example/hooks/settlement";

/** Fixed "now" for the Escrow expiry tests (ms). */
const T0 = 1_700_000_000_000;
const EXPIRES_AT_T0 = new Date(T0 + 60_000).toISOString();
/** Far-future expiry, restorable against the real clock. */
const FAR_FUTURE = "2999-01-01T00:00:00.000Z";
/** Seed-clock epoch for the dedupe/outbox expiry tests (ms). */
const EPOCH = 1_000_000;
const EXPIRES_AT_EPOCH = new Date(EPOCH + 60_000).toISOString();

/** Seeded escrow: VERIFIED, with every snapshot-level field set. */
function seededEscrow(): Escrow {
  const e = new Escrow("escrow-expiry-1", {
    deadline: "2027-01-01T00:00:00.000Z",
    rolePolicy: { RELEASE: ["arbiter"] },
    maxDeposit: 20000,
    requireVerifyEvidence: true,
  });
  e.dispatch("FUND", "sponsor deposit", 10630, {
    at: "2026-11-09T00:00:00.000Z",
    idempotencyKey: "dep-1",
  });
  e.dispatch("SUBMIT_MILESTONE", "creator delivers", undefined, {
    at: "2026-11-09T01:00:00.000Z",
    idempotencyKey: "ms-1",
  });
  e.dispatch("VERIFY_PASS", "oracle attestation ok", undefined, {
    at: "2026-11-09T02:00:00.000Z",
    evidence: "chainlink-req-0xabc",
  });
  return e;
}

function fakeClock(start = EPOCH) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function seededDedupe(ttlMs = 60_000): {
  dedupe: SettlementEventDedupe;
  clock: ReturnType<typeof fakeClock>;
} {
  const clock = fakeClock();
  const dedupe = new SettlementEventDedupe({ ttlMs, now: clock.now });
  assert.equal(dedupe.checkAndRecord("evt-1"), false);
  assert.equal(dedupe.checkAndRecord("evt-2"), false);
  return { dedupe, clock };
}

function seededOutbox(): {
  outbox: SettlementWebhookOutbox;
  clock: ReturnType<typeof fakeClock>;
} {
  const clock = fakeClock();
  const outbox = new SettlementWebhookOutbox({ now: clock.now });
  outbox.recordAttempt({
    endpoint: A,
    eventId: "evt-0001",
    ok: false,
    error: "first",
  });
  clock.advance(1000);
  outbox.recordAttempt({
    endpoint: A,
    eventId: "evt-0001",
    ok: false,
    error: "second",
  });
  outbox.recordAttempt({
    endpoint: B,
    eventId: "evt-0002",
    ok: false,
    error: "once",
  });
  outbox.recordAttempt({
    endpoint: B,
    eventId: "evt-0002",
    ok: false,
    error: "twice",
  });
  outbox.recordAttempt({
    endpoint: B,
    eventId: "evt-0002",
    ok: false,
    error: "thrice",
  });
  return { outbox, clock };
}

/** Deep-clone a value so tampering tests don't fight Object.freeze. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Independent canonical-JSON re-implementation (keys sorted
 * recursively, array order preserved) for the expiry-before-parsing
 * tests: the MAC there must be recomputed in the test, not trusted
 * from the implementation under test.
 */
function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "boolean"
  )
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error(`test canonicalizer: non-JSON value ${typeof value}`);
}

/** Build a MAC-valid envelope around an arbitrary snapshot value. */
function signedEnvelope(
  snapshot: unknown,
  secret: string,
  expiresAt?: string,
): Record<string, unknown> {
  const macInput =
    expiresAt === undefined ? snapshot : { expiresAt, snapshot };
  const mac = createHmac("sha256", secret)
    .update(canonicalJson(macInput), "utf8")
    .digest("hex");
  return expiresAt === undefined
    ? { v: 1, snapshot, mac }
    : { v: 1, snapshot, expiresAt, mac };
}

// ---- Escrow ----

test("escrow: envelope without expiresAt carries no expiry field and restores as before", () => {
  const escrow = seededEscrow();
  const envelope = escrow.exportSignedSnapshot(ESCROW_SECRET);
  assert.equal("expiresAt" in envelope, false);
  const restored = Escrow.restoreSignedSnapshot(envelope, ESCROW_SECRET);
  assert.equal(restored.state, escrow.state);
  assert.deepEqual(restored.toJSON(), escrow.toJSON());
});

test("escrow: far-future expiresAt round-trips against the real clock", () => {
  const escrow = seededEscrow();
  const envelope = escrow.exportSignedSnapshot(ESCROW_SECRET, {
    expiresAt: FAR_FUTURE,
  });
  assert.equal(envelope.expiresAt, FAR_FUTURE);
  const restored = Escrow.restoreSignedSnapshot(envelope, ESCROW_SECRET);
  assert.equal(restored.state, escrow.state);
  assert.deepEqual(restored.toJSON(), escrow.toJSON());
});

test("escrow: expired envelope throws and produces no escrow (both restore spellings)", () => {
  const escrow = seededEscrow();
  const envelope = escrow.exportSignedSnapshot(ESCROW_SECRET, {
    expiresAt: EXPIRES_AT_T0,
  });
  assert.throws(
    () =>
      Escrow.restoreSignedSnapshot(envelope, ESCROW_SECRET, {
        now: T0 + 60_001,
      }),
    /signed snapshot envelope expired at 2023-11-14T22:14:20\.000Z/,
  );
  assert.throws(
    () =>
      Escrow.fromSignedSnapshot(envelope, ESCROW_SECRET, {
        now: T0 + 60_001,
      }),
    /signed snapshot envelope expired at/,
  );
  // Still restorable inside the window: the throw left nothing behind.
  const restored = Escrow.restoreSignedSnapshot(envelope, ESCROW_SECRET, {
    now: T0 + 30_000,
  });
  assert.equal(restored.state, escrow.state);
});

test("escrow: restoring at exactly expiresAt still succeeds (inclusive boundary)", () => {
  const escrow = seededEscrow();
  const envelope = escrow.exportSignedSnapshot(ESCROW_SECRET, {
    expiresAt: EXPIRES_AT_T0,
  });
  const restored = Escrow.restoreSignedSnapshot(envelope, ESCROW_SECRET, {
    now: T0 + 60_000,
  });
  assert.equal(restored.state, escrow.state);
});

test("escrow: one millisecond past expiresAt throws", () => {
  const escrow = seededEscrow();
  const envelope = escrow.exportSignedSnapshot(ESCROW_SECRET, {
    expiresAt: EXPIRES_AT_T0,
  });
  assert.throws(
    () =>
      Escrow.restoreSignedSnapshot(envelope, ESCROW_SECRET, {
        now: T0 + 60_001,
      }),
    /signed snapshot envelope expired at/,
  );
});

test("escrow: tampered expiresAt fails as a MAC mismatch, never as an expiry", () => {
  const escrow = seededEscrow();
  const envelope = escrow.exportSignedSnapshot(ESCROW_SECRET, {
    expiresAt: EXPIRES_AT_T0,
  });
  const tampered = clone(envelope);
  tampered.expiresAt = FAR_FUTURE;
  assert.throws(
    () => Escrow.restoreSignedSnapshot(tampered, ESCROW_SECRET),
    /signed snapshot MAC mismatch/,
  );
  // The same tamper on an envelope without expiresAt also fails the MAC.
  const plain = escrow.exportSignedSnapshot(ESCROW_SECRET);
  const smuggled = clone(plain) as unknown as Record<string, unknown>;
  smuggled.expiresAt = FAR_FUTURE;
  assert.throws(
    () => Escrow.restoreSignedSnapshot(smuggled, ESCROW_SECRET),
    /signed snapshot MAC mismatch/,
  );
});

test("escrow: export rejects invalid expiresAt values", () => {
  const escrow = seededEscrow();
  assert.throws(
    () =>
      escrow.exportSignedSnapshot(ESCROW_SECRET, { expiresAt: "tomorrow" }),
    /expiresAt must be a canonical ISO-8601 UTC timestamp string/,
  );
  // Non-canonical ISO (no milliseconds) is rejected, not normalized.
  assert.throws(
    () =>
      escrow.exportSignedSnapshot(ESCROW_SECRET, {
        expiresAt: "2026-11-12T00:00:00Z",
      }),
    /expiresAt must be a canonical ISO-8601 UTC timestamp string/,
  );
  assert.throws(
    () =>
      escrow.exportSignedSnapshot(ESCROW_SECRET, {
        expiresAt: 123 as unknown as string,
      }),
    /expiresAt must be a canonical ISO-8601 UTC timestamp string/,
  );
});

test("escrow: restore rejects an invalid expiresAt inside the envelope", () => {
  const escrow = seededEscrow();
  const envelope = escrow.exportSignedSnapshot(ESCROW_SECRET, {
    expiresAt: EXPIRES_AT_T0,
  });
  const badType = clone(envelope) as unknown as Record<string, unknown>;
  badType.expiresAt = 123;
  assert.throws(
    () => Escrow.restoreSignedSnapshot(badType, ESCROW_SECRET),
    /invalid signed snapshot envelope: expiresAt must be a canonical ISO-8601 UTC timestamp string/,
  );
  const badValue = clone(envelope) as unknown as Record<string, unknown>;
  badValue.expiresAt = "not-a-date";
  assert.throws(
    () => Escrow.restoreSignedSnapshot(badValue, ESCROW_SECRET),
    /invalid signed snapshot envelope: expiresAt must be a canonical ISO-8601 UTC timestamp string/,
  );
});

test("escrow: maxAgeMs sets expiresAt from now and bounds the restore window", () => {
  const escrow = seededEscrow();
  const envelope = escrow.exportSignedSnapshot(ESCROW_SECRET, {
    maxAgeMs: 60_000,
    now: T0,
  });
  assert.equal(envelope.expiresAt, EXPIRES_AT_T0);
  const inside = Escrow.restoreSignedSnapshot(envelope, ESCROW_SECRET, {
    now: T0 + 30_000,
  });
  assert.equal(inside.state, escrow.state);
  assert.throws(
    () =>
      Escrow.restoreSignedSnapshot(envelope, ESCROW_SECRET, {
        now: T0 + 60_001,
      }),
    /signed snapshot envelope expired at/,
  );
});

test("escrow: expiresAt and maxAgeMs are mutually exclusive", () => {
  const escrow = seededEscrow();
  assert.throws(
    () =>
      escrow.exportSignedSnapshot(ESCROW_SECRET, {
        expiresAt: EXPIRES_AT_T0,
        maxAgeMs: 60_000,
      }),
    /must not combine expiresAt and maxAgeMs/,
  );
});

test("escrow: invalid maxAgeMs, stray now, and non-finite restore now all throw", () => {
  const escrow = seededEscrow();
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => escrow.exportSignedSnapshot(ESCROW_SECRET, { maxAgeMs: bad }),
      /maxAgeMs must be a positive finite number/,
    );
  }
  assert.throws(
    () =>
      escrow.exportSignedSnapshot(ESCROW_SECRET, {
        maxAgeMs: "60000" as unknown as number,
      }),
    /maxAgeMs must be a positive finite number/,
  );
  assert.throws(
    () => escrow.exportSignedSnapshot(ESCROW_SECRET, { now: T0 }),
    /option now is only used with maxAgeMs/,
  );
  assert.throws(
    () =>
      escrow.exportSignedSnapshot(ESCROW_SECRET, {
        maxAgeMs: 60_000,
        now: Number.NaN,
      }),
    /option now must be a finite number/,
  );
  const envelope = escrow.exportSignedSnapshot(ESCROW_SECRET, {
    expiresAt: EXPIRES_AT_T0,
  });
  assert.throws(
    () =>
      Escrow.restoreSignedSnapshot(envelope, ESCROW_SECRET, {
        now: Number.NaN,
      }),
    /restore option now must be a finite number/,
  );
});

test("escrow: expiry check runs before snapshot parsing", () => {
  // MAC-valid envelope, but the wrapped snapshot is malformed
  // (unknown state): past the expiry the error must be the expiry,
  // not the snapshot parse error; inside the window the same
  // envelope must fail snapshot validation instead.
  const badSnapshot = {
    v: 1,
    id: "escrow-expiry-1",
    state: "NOPE",
    history: [],
  };
  const expired = signedEnvelope(badSnapshot, ESCROW_SECRET, EXPIRES_AT_T0);
  assert.throws(
    () =>
      Escrow.restoreSignedSnapshot(expired, ESCROW_SECRET, {
        now: T0 + 60_001,
      }),
    /signed snapshot envelope expired at/,
  );
  assert.throws(
    () =>
      Escrow.restoreSignedSnapshot(expired, ESCROW_SECRET, {
        now: T0 + 30_000,
      }),
    /invalid snapshot:/,
  );
});

// ---- SettlementEventDedupe ----

test("dedupe: envelope without expiresAt restores as before, ids still dedupe", () => {
  const { dedupe, clock } = seededDedupe();
  const envelope = dedupe.exportSignedSnapshot(DEDUPE_SECRET);
  assert.equal("expiresAt" in envelope, false);
  const restored = SettlementEventDedupe.restoreSignedSnapshot(
    envelope,
    DEDUPE_SECRET,
    {
      now: clock.now,
    },
  );
  assert.equal(restored.checkAndRecord("evt-1"), true);
  assert.equal(restored.checkAndRecord("evt-2"), true);
  assert.equal(restored.checkAndRecord("evt-3"), false);
});

test("dedupe: future expiresAt round-trips, ids still dedupe", () => {
  const { dedupe } = seededDedupe();
  const envelope = dedupe.exportSignedSnapshot(DEDUPE_SECRET, {
    expiresAt: EXPIRES_AT_EPOCH,
  });
  assert.equal(envelope.expiresAt, EXPIRES_AT_EPOCH);
  const restored = SettlementEventDedupe.restoreSignedSnapshot(
    envelope,
    DEDUPE_SECRET,
    {
      now: () => EPOCH + 30_000,
    },
  );
  assert.equal(restored.checkAndRecord("evt-1"), true);
  assert.equal(restored.checkAndRecord("evt-2"), true);
});

test("dedupe: expired envelope throws and produces no dedupe", () => {
  const { dedupe } = seededDedupe();
  const envelope = dedupe.exportSignedSnapshot(DEDUPE_SECRET, {
    expiresAt: EXPIRES_AT_EPOCH,
  });
  assert.throws(
    () =>
      SettlementEventDedupe.restoreSignedSnapshot(envelope, DEDUPE_SECRET, {
        now: () => EPOCH + 60_001,
      }),
    /signed snapshot envelope expired at 1970-01-01T00:17:40\.000Z/,
  );
  assert.throws(
    () =>
      SettlementEventDedupe.fromSignedSnapshot(envelope, DEDUPE_SECRET, {
        now: () => EPOCH + 60_001,
      }),
    /signed snapshot envelope expired at/,
  );
});

test("dedupe: restoring at exactly expiresAt still succeeds (inclusive boundary)", () => {
  // A longer entry TTL than the envelope window, so the boundary
  // being tested is the envelope's — at exactly expiresAt the
  // entries are still live (entry TTL is exclusive at its own
  // boundary, so a 60_000 ms entry TTL would drop them here).
  const { dedupe } = seededDedupe(120_000);
  const envelope = dedupe.exportSignedSnapshot(DEDUPE_SECRET, {
    expiresAt: EXPIRES_AT_EPOCH,
  });
  const restored = SettlementEventDedupe.restoreSignedSnapshot(
    envelope,
    DEDUPE_SECRET,
    {
      now: () => EPOCH + 60_000,
    },
  );
  assert.equal(restored.checkAndRecord("evt-1"), true);
});

test("dedupe: tampered expiresAt fails as a MAC mismatch", () => {
  const { dedupe } = seededDedupe();
  const envelope = dedupe.exportSignedSnapshot(DEDUPE_SECRET, {
    expiresAt: EXPIRES_AT_EPOCH,
  });
  const tampered = clone(envelope);
  tampered.expiresAt = FAR_FUTURE;
  assert.throws(
    () =>
      SettlementEventDedupe.restoreSignedSnapshot(tampered, DEDUPE_SECRET, {
        now: () => EPOCH + 30_000,
      }),
    /signed snapshot MAC mismatch/,
  );
});

test("dedupe: maxAgeMs sets expiresAt; invalid expiresAt at export throws", () => {
  const { dedupe } = seededDedupe();
  const envelope = dedupe.exportSignedSnapshot(DEDUPE_SECRET, {
    maxAgeMs: 60_000,
    now: EPOCH,
  });
  assert.equal(envelope.expiresAt, EXPIRES_AT_EPOCH);
  const restored = SettlementEventDedupe.restoreSignedSnapshot(
    envelope,
    DEDUPE_SECRET,
    {
      now: () => EPOCH + 30_000,
    },
  );
  assert.equal(restored.checkAndRecord("evt-1"), true);
  assert.throws(
    () =>
      SettlementEventDedupe.restoreSignedSnapshot(envelope, DEDUPE_SECRET, {
        now: () => EPOCH + 60_001,
      }),
    /signed snapshot envelope expired at/,
  );
  assert.throws(
    () =>
      dedupe.exportSignedSnapshot(DEDUPE_SECRET, { expiresAt: "tomorrow" }),
    /expiresAt must be a canonical ISO-8601 UTC timestamp string/,
  );
  assert.throws(
    () =>
      dedupe.exportSignedSnapshot(DEDUPE_SECRET, {
        expiresAt: EXPIRES_AT_EPOCH,
        maxAgeMs: 60_000,
      }),
    /must not combine expiresAt and maxAgeMs/,
  );
});

test("dedupe: expiry check runs before snapshot parsing", () => {
  // MAC-valid envelope, but the wrapped snapshot is malformed
  // (seenAtMs is a string, not a number): past the expiry the
  // error must be the expiry, not the snapshot parse error;
  // inside the window the same envelope must fail snapshot
  // validation instead.
  const badSnapshot = {
    v: 1,
    entries: [["evt-1", "not-a-number"]],
  };
  const expired = signedEnvelope(badSnapshot, DEDUPE_SECRET, EXPIRES_AT_EPOCH);
  assert.throws(
    () =>
      SettlementEventDedupe.restoreSignedSnapshot(expired, DEDUPE_SECRET, {
        now: () => EPOCH + 60_001,
      }),
    /signed snapshot envelope expired at/,
  );
  assert.throws(
    () =>
      SettlementEventDedupe.restoreSignedSnapshot(expired, DEDUPE_SECRET, {
        now: () => EPOCH + 30_000,
      }),
    /invalid snapshot:/,
  );
});

// ---- SettlementWebhookOutbox ----

test("outbox: envelope without expiresAt restores as before, ledger intact", () => {
  const { outbox } = seededOutbox();
  const envelope = outbox.exportSignedSnapshot(OUTBOX_SECRET);
  assert.equal("expiresAt" in envelope, false);
  const restored = SettlementWebhookOutbox.restoreSignedSnapshot(
    envelope,
    OUTBOX_SECRET,
  );
  assert.equal(restored.pending().length, 1);
  assert.equal(restored.pending()[0]?.eventId, "evt-0001");
  assert.equal(restored.deadLetter().length, 1);
  assert.equal(restored.deadLetter()[0]?.eventId, "evt-0002");
});

test("outbox: future expiresAt round-trips, ledger intact", () => {
  const { outbox } = seededOutbox();
  const envelope = outbox.exportSignedSnapshot(OUTBOX_SECRET, {
    expiresAt: EXPIRES_AT_EPOCH,
  });
  assert.equal(envelope.expiresAt, EXPIRES_AT_EPOCH);
  const restored = SettlementWebhookOutbox.restoreSignedSnapshot(
    envelope,
    OUTBOX_SECRET,
    { now: () => EPOCH + 30_000 },
  );
  assert.equal(restored.pending().length, 1);
  assert.equal(restored.deadLetter().length, 1);
});

test("outbox: expired envelope throws and produces no outbox", () => {
  const { outbox } = seededOutbox();
  const envelope = outbox.exportSignedSnapshot(OUTBOX_SECRET, {
    expiresAt: EXPIRES_AT_EPOCH,
  });
  assert.throws(
    () =>
      SettlementWebhookOutbox.restoreSignedSnapshot(envelope, OUTBOX_SECRET, {
        now: () => EPOCH + 60_001,
      }),
    /signed snapshot envelope expired at 1970-01-01T00:17:40\.000Z/,
  );
  assert.throws(
    () =>
      SettlementWebhookOutbox.fromSignedSnapshot(envelope, OUTBOX_SECRET, {
        now: () => EPOCH + 60_001,
      }),
    /signed snapshot envelope expired at/,
  );
});

test("outbox: restoring at exactly expiresAt still succeeds (inclusive boundary)", () => {
  const { outbox } = seededOutbox();
  const envelope = outbox.exportSignedSnapshot(OUTBOX_SECRET, {
    expiresAt: EXPIRES_AT_EPOCH,
  });
  const restored = SettlementWebhookOutbox.restoreSignedSnapshot(
    envelope,
    OUTBOX_SECRET,
    { now: () => EPOCH + 60_000 },
  );
  assert.equal(restored.pending().length, 1);
  assert.equal(restored.deadLetter().length, 1);
});

test("outbox: tampered expiresAt fails as a MAC mismatch; invalid expiresAt at restore throws", () => {
  const { outbox } = seededOutbox();
  const envelope = outbox.exportSignedSnapshot(OUTBOX_SECRET, {
    expiresAt: EXPIRES_AT_EPOCH,
  });
  const tampered = clone(envelope);
  tampered.expiresAt = FAR_FUTURE;
  assert.throws(
    () =>
      SettlementWebhookOutbox.restoreSignedSnapshot(tampered, OUTBOX_SECRET, {
        now: () => EPOCH + 30_000,
      }),
    /signed snapshot MAC mismatch/,
  );
  const badValue = clone(envelope) as unknown as Record<string, unknown>;
  badValue.expiresAt = "not-a-date";
  assert.throws(
    () => SettlementWebhookOutbox.restoreSignedSnapshot(badValue, OUTBOX_SECRET),
    /invalid signed snapshot envelope: expiresAt must be a canonical ISO-8601 UTC timestamp string/,
  );
});

test("outbox: maxAgeMs sets expiresAt; invalid expiresAt at export throws", () => {
  const { outbox } = seededOutbox();
  const envelope = outbox.exportSignedSnapshot(OUTBOX_SECRET, {
    maxAgeMs: 60_000,
    now: EPOCH,
  });
  assert.equal(envelope.expiresAt, EXPIRES_AT_EPOCH);
  const restored = SettlementWebhookOutbox.restoreSignedSnapshot(
    envelope,
    OUTBOX_SECRET,
    { now: () => EPOCH + 30_000 },
  );
  assert.equal(restored.pending().length, 1);
  assert.throws(
    () =>
      SettlementWebhookOutbox.restoreSignedSnapshot(envelope, OUTBOX_SECRET, {
        now: () => EPOCH + 60_001,
      }),
    /signed snapshot envelope expired at/,
  );
  assert.throws(
    () =>
      outbox.exportSignedSnapshot(OUTBOX_SECRET, { expiresAt: "tomorrow" }),
    /expiresAt must be a canonical ISO-8601 UTC timestamp string/,
  );
  assert.throws(
    () =>
      outbox.exportSignedSnapshot(OUTBOX_SECRET, {
        expiresAt: EXPIRES_AT_EPOCH,
        maxAgeMs: 60_000,
      }),
    /must not combine expiresAt and maxAgeMs/,
  );
});

test("outbox: expiry check runs before snapshot parsing", () => {
  // MAC-valid envelope, but the wrapped snapshot is malformed
  // (empty endpoint): past the expiry the error must be the
  // expiry, not the snapshot parse error; inside the window the
  // same envelope must fail snapshot validation instead.
  const badSnapshot = {
    v: 1,
    entries: [{ endpoint: "", eventId: "evt-0001", attempts: 1, lastAt: 1 }],
  };
  const expired = signedEnvelope(badSnapshot, OUTBOX_SECRET, EXPIRES_AT_EPOCH);
  assert.throws(
    () =>
      SettlementWebhookOutbox.restoreSignedSnapshot(expired, OUTBOX_SECRET, {
        now: () => EPOCH + 60_001,
      }),
    /signed snapshot envelope expired at/,
  );
  assert.throws(
    () =>
      SettlementWebhookOutbox.restoreSignedSnapshot(expired, OUTBOX_SECRET, {
        now: () => EPOCH + 30_000,
      }),
    /invalid snapshot:/,
  );
});
