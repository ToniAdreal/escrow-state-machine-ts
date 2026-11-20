/**
 * Unknown option keys on the three HMAC-signed snapshot export
 * entry points fail closed (backlog #1284): `Escrow`,
 * `SettlementEventDedupe`, `SettlementWebhookOutbox`, and
 * `exportSignedQuorumSnapshot` all resolve an optional expiry from
 * `SignedSnapshotExportOptions` (`expiresAt` / `maxAgeMs` /
 * `now`), and all three resolver helpers used to destructure only
 * the keys they knew — a typo'd `expiry: '2099-…'` was silently
 * dropped, so the caller believed the envelope expired in 2099
 * while it actually never expired.
 *
 * Rules under test:
 *  - the three legal keys still work per exporter: `expiresAt`
 *    lands verbatim in the envelope, `{ maxAgeMs, now }` resolves
 *    deterministically, and no options means no expiry
 *  - `expiry` / `maxAge` / `expireAt` each throw an error naming
 *    the bad key, and no envelope is produced
 *  - the pre-existing `now`-without-`maxAgeMs` mutual-exclusion
 *    check still fires (regression)
 *  - legal expiry behavior is unchanged: a far-future envelope
 *    still restores, a past-expiry envelope is still rejected
 *  - restore side, decided in this round: the quorum restore was
 *    already fail-closed (#1281), the dedupe and escrow restores
 *    already reject a typo'd clock through their constructors'
 *    unknown-option scans — but the outbox restore silently
 *    ignored one, because `SettlementWebhookOutbox`'s constructor
 *    never scanned its options. The constructor now scans
 *    (`maxAttempts` / `maxEntries` / `now`), closing the restore
 *    path and direct construction alike.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  SettlementEventDedupe,
  SettlementWebhookOutbox,
  createQuorum,
  exportSignedQuorumSnapshot,
  restoreSignedQuorumSnapshot,
} from "../src/index.js";

const SECRET = "signed-snapshot-export-unknown-options-secret";
const T0 = Date.parse("2026-11-14T00:00:00.000Z");
const FAR_FUTURE = "2999-01-01T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";
const RESOLVED = new Date(T0 + 60_000).toISOString();

function seededEscrow(): Escrow {
  const escrow = new Escrow("export-unknown-opts-1");
  escrow.dispatch("FUND", "sponsor deposit", 100);
  return escrow;
}

function seededDedupe(): SettlementEventDedupe {
  const dedupe = new SettlementEventDedupe();
  dedupe.checkAndRecord("evt-1");
  return dedupe;
}

function seededOutbox(): SettlementWebhookOutbox {
  const outbox = new SettlementWebhookOutbox();
  outbox.recordAttempt({
    endpoint: "https://hooks.example/settlement",
    eventId: "evt-1",
    ok: false,
    status: 500,
    error: "boom",
  });
  return outbox;
}

function seededQuorum() {
  return createQuorum({ threshold: 2, signers: ["a", "b", "c"] });
}

const QUORUM_CONFIG = { threshold: 2, signers: ["a", "b", "c"] };

/** One row per signed-snapshot exporter, with its export/restore. */
const EXPORTERS: Array<{
  label: string;
  exportWith: (opts?: Record<string, unknown>) => { expiresAt?: string };
  restore: (envelope: unknown) => unknown;
}> = [
  {
    label: "Escrow",
    exportWith: (opts) =>
      seededEscrow().exportSignedSnapshot(
        SECRET,
        opts as never,
      ) as { expiresAt?: string },
    restore: (envelope) =>
      Escrow.restoreSignedSnapshot(envelope, SECRET),
  },
  {
    label: "SettlementEventDedupe",
    exportWith: (opts) =>
      seededDedupe().exportSignedSnapshot(
        SECRET,
        opts as never,
      ) as { expiresAt?: string },
    restore: (envelope) =>
      SettlementEventDedupe.restoreSignedSnapshot(envelope, SECRET),
  },
  {
    label: "SettlementWebhookOutbox",
    exportWith: (opts) =>
      seededOutbox().exportSignedSnapshot(
        SECRET,
        opts as never,
      ) as { expiresAt?: string },
    restore: (envelope) =>
      SettlementWebhookOutbox.restoreSignedSnapshot(envelope, SECRET),
  },
  {
    label: "Quorum",
    exportWith: (opts) =>
      exportSignedQuorumSnapshot(
        seededQuorum(),
        SECRET,
        opts as never,
      ) as { expiresAt?: string },
    restore: (envelope) =>
      restoreSignedQuorumSnapshot(QUORUM_CONFIG, envelope, SECRET),
  },
];

for (const exporter of EXPORTERS) {
  test(`${exporter.label}: legal expiresAt lands verbatim in the envelope`, () => {
    const envelope = exporter.exportWith({ expiresAt: FAR_FUTURE });
    assert.equal(envelope.expiresAt, FAR_FUTURE);
  });

  test(`${exporter.label}: legal maxAgeMs + now resolves deterministically`, () => {
    const envelope = exporter.exportWith({ maxAgeMs: 60_000, now: T0 });
    assert.equal(envelope.expiresAt, RESOLVED);
  });

  test(`${exporter.label}: no options means no expiry`, () => {
    const envelope = exporter.exportWith();
    assert.equal(envelope.expiresAt, undefined);
  });

  test(`${exporter.label}: typo'd expiry throws and produces no envelope`, () => {
    assert.throws(
      () => exporter.exportWith({ expiry: FAR_FUTURE }),
      /unknown option "expiry"/,
    );
  });

  test(`${exporter.label}: typo'd maxAge throws and produces no envelope`, () => {
    assert.throws(
      () => exporter.exportWith({ maxAge: 60_000 }),
      /unknown option "maxAge"/,
    );
  });

  test(`${exporter.label}: typo'd expireAt throws and produces no envelope`, () => {
    assert.throws(
      () => exporter.exportWith({ expireAt: FAR_FUTURE }),
      /unknown option "expireAt"/,
    );
  });

  test(`${exporter.label}: now without maxAgeMs still throws (regression)`, () => {
    assert.throws(() => exporter.exportWith({ now: T0 }), /only used with maxAgeMs/);
  });

  test(`${exporter.label}: far-future envelope still restores`, () => {
    const envelope = exporter.exportWith({ expiresAt: FAR_FUTURE });
    assert.doesNotThrow(() => exporter.restore(envelope));
  });

  test(`${exporter.label}: past-expiry envelope is still rejected`, () => {
    const envelope = exporter.exportWith({ expiresAt: PAST });
    assert.throws(() => exporter.restore(envelope), /expired/);
  });
}

test("SettlementWebhookOutbox: constructor rejects a typo'd maxAttempts", () => {
  assert.throws(
    () => new SettlementWebhookOutbox({ maxAttempt: 3 } as never),
    /SettlementWebhookOutbox: unknown option "maxAttempt"/,
  );
});

test("SettlementWebhookOutbox: restore rejects a typo'd now clock", () => {
  const envelope = seededOutbox().exportSignedSnapshot(SECRET, {
    expiresAt: FAR_FUTURE,
  });
  assert.throws(
    () =>
      SettlementWebhookOutbox.restoreSignedSnapshot(envelope, SECRET, {
        noww: () => 1_000,
      } as never),
    /SettlementWebhookOutbox: unknown option "noww"/,
  );
});

test("SettlementWebhookOutbox: restore with a legal now clock still works", () => {
  const envelope = seededOutbox().exportSignedSnapshot(SECRET, {
    expiresAt: FAR_FUTURE,
  });
  assert.doesNotThrow(() =>
    SettlementWebhookOutbox.restoreSignedSnapshot(envelope, SECRET, {
      now: () => T0,
    }),
  );
});

test("SettlementEventDedupe: restore rejects a typo'd now clock (already closed)", () => {
  const envelope = seededDedupe().exportSignedSnapshot(SECRET, {
    expiresAt: FAR_FUTURE,
  });
  assert.throws(
    () =>
      SettlementEventDedupe.restoreSignedSnapshot(envelope, SECRET, {
        noww: () => 1_000,
      } as never),
    /unknown option "noww"/,
  );
});

test("Escrow: restore rejects a typo'd now clock (already closed)", () => {
  const envelope = seededEscrow().exportSignedSnapshot(SECRET, {
    expiresAt: FAR_FUTURE,
  });
  assert.throws(
    () =>
      Escrow.restoreSignedSnapshot(envelope, SECRET, {
        noww: T0,
      } as never),
    /unknown option "noww"/,
  );
});

test("Quorum: restore rejects a typo'd now clock (already closed, #1281)", () => {
  const envelope = exportSignedQuorumSnapshot(seededQuorum(), SECRET, {
    expiresAt: FAR_FUTURE,
  });
  assert.throws(
    () =>
      restoreSignedQuorumSnapshot(QUORUM_CONFIG, envelope, SECRET, {
        noww: T0,
      } as never),
    /unknown option "noww"/,
  );
});
