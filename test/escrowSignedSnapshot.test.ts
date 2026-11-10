/**
 * HMAC-signed snapshot envelopes for `Escrow` (backlog #1017),
 * mirroring the `SettlementEventDedupe` envelope (#1010) and the
 * sibling rfc9421 `ReplayCache` signed-snapshot paradigm.
 *
 * The audit hash chain covers history entries only — the
 * snapshot-level fields (`state`, `deadline`, `rolePolicy`,
 * `idempotencyKeys`, `maxDeposit`, `requireVerifyEvidence`) sit
 * outside it, so a rewritten persisted snapshot could push a
 * deadline back, loosen a policy, clear consumed idempotency keys,
 * or lift a deposit cap without breaking any history link. Rules
 * under test:
 *  - `exportSignedSnapshot(secret)` returns `{ v: 1, snapshot, mac }`
 *    with `mac` = HMAC-SHA256 over the canonical JSON of the
 *    snapshot; the secret is never written into the envelope
 *  - `restoreSignedSnapshot(envelope, secret, opts)` (alias
 *    `fromSignedSnapshot`) rebuilds a working escrow whose
 *    snapshot-level configuration is intact and whose history
 *    chain continues unbroken on further dispatch
 *  - a tampered snapshot field (`state`/`deadline`/`rolePolicy`/
 *    `idempotencyKeys`/`maxDeposit`/`requireVerifyEvidence`),
 *    a tampered history entry, a tampered `mac`, or a wrong secret
 *    is rejected fail-closed and produces no escrow
 *  - envelope shape is validated first (unknown field, version
 *    other than 1, malformed mac), and a MAC-valid envelope whose
 *    snapshot is itself malformed still fails snapshot validation
 *  - an empty (or wrongly typed) secret is rejected on both sides
 *  - the unsigned path is unchanged, and the two forms do not
 *    accept each other — a signed restore cannot silently
 *    downgrade to trusted configuration
 *  - a keyed history chain still needs its own `auditKey` on
 *    restore (independent of the envelope secret), fail-closed
 *    both ways
 *  - honest scope stays single-process: a signed envelope bridges
 *    one process across its own restart, it is not shared storage
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Escrow, verifyHistoryChain } from "../src/index.js";
import type {
  EscrowSignedSnapshotEnvelope,
  EscrowSnapshot,
} from "../src/index.js";

const SECRET = "escrow-snapshot-signing-secret-for-tests";
const AUDIT_KEY = "escrow-audit-key-for-tests";
const WRONG_SECRET = "escrow-snapshot-signing-secret-wrong";

/** Seeded escrow: VERIFIED, with every snapshot-level field set. */
function seededEscrow(): Escrow {
  const e = new Escrow("escrow-signed-1", {
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

/** Deep-clone a value so tampering tests don't fight Object.freeze. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Independent canonical-JSON re-implementation (keys sorted
 * recursively, array order preserved) for the MAC-valid-but-malformed
 * test: the MAC there must be recomputed in the test, not trusted
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

// A signed snapshot restores with every snapshot-level field intact,
// and the restored escrow keeps dispatching with an unbroken chain.
test("signed snapshot round-trip restores config and continues dispatch", () => {
  const escrow = seededEscrow();
  const envelope = escrow.exportSignedSnapshot(SECRET);
  assert.equal(envelope.v, 1);
  assert.match(envelope.mac, /^[0-9a-f]{64}$/);
  assert.equal(envelope.snapshot.id, "escrow-signed-1");
  assert.equal(envelope.snapshot.state, "VERIFIED");

  const restored = Escrow.restoreSignedSnapshot(envelope, SECRET);
  assert.equal(restored.id, "escrow-signed-1");
  assert.equal(restored.state, "VERIFIED");
  assert.equal(restored.toJSON().deadline, "2027-01-01T00:00:00.000Z");
  assert.deepEqual(restored.toJSON().rolePolicy, {
    RELEASE: ["arbiter"],
  });
  assert.deepEqual(restored.toJSON().idempotencyKeys, ["dep-1", "ms-1"]);
  assert.equal(restored.toJSON().maxDeposit, 20000);
  assert.equal(restored.toJSON().requireVerifyEvidence, true);
  assert.deepEqual(restored.toJSON().history, escrow.toJSON().history);
  assert.equal(verifyHistoryChain(restored.history), true);

  // The chain continues unbroken: the next dispatch appends seq 4
  // with a correct prevHash link, and the role policy still gates.
  assert.throws(
    () => restored.dispatch("RELEASE", "wrong actor", undefined, { actor: "mallory" }),
    /"mallory" is not in/,
  );
  restored.dispatch("RELEASE", "arbiter releases", undefined, {
    actor: "arbiter",
  });
  assert.equal(restored.state, "RELEASED");
  assert.equal(restored.history.length, 4);
  assert.equal(restored.history[3].seq, 4);
  assert.equal(restored.history[3].prevHash, restored.history[2].hash);
  assert.equal(verifyHistoryChain(restored.history), true);
  // A replayed consumed key stays a no-op after the restore (the
  // dedupe returns the current state and appends nothing).
  assert.equal(
    restored.dispatch("RELEASE", "replay", undefined, {
      actor: "arbiter",
      idempotencyKey: "ms-1",
    }),
    "RELEASED",
  );
  assert.equal(restored.history.length, 4);
});

// The envelope is plain JSON: a string round-trip must not break it.
test("signed snapshot survives a JSON persistence round-trip", () => {
  const envelope = seededEscrow().exportSignedSnapshot(SECRET);
  const wire = JSON.parse(
    JSON.stringify(envelope),
  ) as EscrowSignedSnapshotEnvelope;
  const restored = Escrow.fromSignedSnapshot(wire, SECRET);
  assert.equal(restored.state, "VERIFIED");
  assert.equal(restored.toJSON().deadline, "2027-01-01T00:00:00.000Z");
  assert.equal(verifyHistoryChain(restored.history), true);
});

// The secret is caller configuration: it is never written into the
// envelope, so a persisted envelope leaks nothing about it.
test("envelope carries no secret", () => {
  const envelope = seededEscrow().exportSignedSnapshot(SECRET);
  assert.deepEqual(Object.keys(envelope).sort(), ["mac", "snapshot", "v"]);
  assert.equal(JSON.stringify(envelope).includes(SECRET), false);
  assert.equal(JSON.stringify(envelope).includes("secret"), false);
});

// Every snapshot-level field is covered by the MAC: rewriting any
// one of them without the secret fails closed, with no escrow
// produced.
test("tampered snapshot-level fields are rejected", () => {
  const cases: Array<{
    name: string;
    mutate: (snapshot: EscrowSnapshot) => void;
  }> = [
    {
      name: "state",
      mutate: (s) => {
        s.state = "FUNDED";
      },
    },
    {
      name: "deadline",
      mutate: (s) => {
        s.deadline = "2099-01-01T00:00:00.000Z";
      },
    },
    {
      name: "rolePolicy",
      mutate: (s) => {
        s.rolePolicy = {};
      },
    },
    {
      name: "idempotencyKeys",
      mutate: (s) => {
        s.idempotencyKeys = [];
      },
    },
    {
      name: "maxDeposit",
      mutate: (s) => {
        s.maxDeposit = 999999999;
      },
    },
    {
      name: "requireVerifyEvidence",
      mutate: (s) => {
        delete s.requireVerifyEvidence;
      },
    },
    {
      name: "history entry amount",
      mutate: (s) => {
        s.history[0].amount = 1;
      },
    },
  ];
  for (const { name, mutate } of cases) {
    const envelope = seededEscrow().exportSignedSnapshot(SECRET);
    mutate(envelope.snapshot);
    assert.throws(
      () => Escrow.restoreSignedSnapshot(envelope, SECRET),
      /signed snapshot MAC mismatch/,
      `tampered ${name} must fail the MAC check`,
    );
  }
});

test("tampered mac and wrong secret are rejected", () => {
  const envelope = seededEscrow().exportSignedSnapshot(SECRET);
  const tampered = clone(envelope);
  tampered.mac = "0".repeat(64);
  assert.throws(
    () => Escrow.restoreSignedSnapshot(tampered, SECRET),
    /signed snapshot MAC mismatch/,
  );
  assert.throws(
    () => Escrow.restoreSignedSnapshot(envelope, WRONG_SECRET),
    /signed snapshot MAC mismatch/,
  );
  // Restoring with the wrong secret leaves no instance behind: the
  // same envelope still restores fine under the right one.
  const restored = Escrow.restoreSignedSnapshot(envelope, SECRET);
  assert.equal(restored.state, "VERIFIED");
});

test("envelope shape is validated before the MAC", () => {
  const envelope = seededEscrow().exportSignedSnapshot(SECRET);
  // Unknown field, including a smuggled secret.
  const smuggled = clone(envelope) as unknown as Record<string, unknown>;
  smuggled.secret = SECRET;
  assert.throws(
    () => Escrow.restoreSignedSnapshot(smuggled, SECRET),
    /invalid signed snapshot envelope: unknown field "secret"/,
  );
  // Version other than 1, and a missing version.
  for (const badVersion of [2, 0, "1", undefined]) {
    const bad = clone(envelope) as unknown as Record<string, unknown>;
    if (badVersion === undefined) delete bad.v;
    else bad.v = badVersion;
    assert.throws(
      () => Escrow.restoreSignedSnapshot(bad, SECRET),
      /invalid signed snapshot envelope: unsupported envelope version/,
    );
  }
  // Malformed mac shapes: uppercase hex, too short, non-hex.
  for (const badMac of [
    envelope.mac.toUpperCase(),
    envelope.mac.slice(0, 63),
    "g".repeat(64),
    "",
  ]) {
    const bad = clone(envelope);
    bad.mac = badMac;
    assert.throws(
      () => Escrow.restoreSignedSnapshot(bad, SECRET),
      /mac must be a 64-character lowercase hex HMAC-SHA256 digest/,
    );
  }
  // Non-object envelopes.
  for (const badEnvelope of [null, [], "not-an-envelope", 42]) {
    assert.throws(
      () => Escrow.restoreSignedSnapshot(badEnvelope, SECRET),
      /invalid signed snapshot envelope: expected an object/,
    );
  }
  // A snapshot that is not an object.
  const badSnapshot = clone(envelope) as unknown as Record<string, unknown>;
  badSnapshot.snapshot = "not-a-snapshot";
  assert.throws(
    () => Escrow.restoreSignedSnapshot(badSnapshot, SECRET),
    /invalid signed snapshot envelope: "snapshot" must be an object/,
  );
});

test("empty or wrongly typed secret is rejected on both sides", () => {
  const escrow = seededEscrow();
  assert.throws(
    () => escrow.exportSignedSnapshot(""),
    /signed snapshot secret must not be empty/,
  );
  assert.throws(
    () => escrow.exportSignedSnapshot(Buffer.alloc(0)),
    /signed snapshot secret must not be empty/,
  );
  assert.throws(
    () =>
      escrow.exportSignedSnapshot(
        123 as unknown as string,
      ),
    /signed snapshot secret must be a non-empty string or Buffer, got number/,
  );
  const envelope = escrow.exportSignedSnapshot(SECRET);
  assert.throws(
    () => Escrow.restoreSignedSnapshot(envelope, ""),
    /signed snapshot secret must not be empty/,
  );
  assert.throws(
    () =>
      Escrow.restoreSignedSnapshot(
        envelope,
        null as unknown as string,
      ),
    /signed snapshot secret must be a non-empty string or Buffer, got object/,
  );
});

// The MAC only proves the snapshot was not rewritten — a snapshot
// that is itself malformed must still fail strict snapshot
// validation even when its MAC is valid (recomputed here with the
// real secret over the independently canonicalized JSON).
test("MAC-valid envelope with a malformed snapshot still fails validation", () => {
  const badSnapshot = {
    v: 1,
    id: "escrow-signed-1",
    state: "FUNDED",
    history: [
      {
        seq: 1,
        event: "FUND",
        from: "CREATED",
        to: "FUNDED",
        at: "2026-11-09T00:00:00.000Z",
        amount: 100,
        prevHash: "GENESIS",
        hash: "0".repeat(64),
      },
    ],
  };
  const mac = createHmac("sha256", SECRET)
    .update(canonicalJson(badSnapshot), "utf8")
    .digest("hex");
  assert.throws(
    () =>
      Escrow.restoreSignedSnapshot(
        { v: 1, snapshot: badSnapshot, mac },
        SECRET,
      ),
    /invalid snapshot: history hash chain is broken/,
  );
});

// The two forms do not accept each other: a signed restore cannot
// silently downgrade to the trusted-configuration path, and the
// unsigned path never mistakes an envelope for a snapshot.
test("signed and unsigned forms are mutually exclusive", () => {
  const escrow = seededEscrow();
  const envelope = escrow.exportSignedSnapshot(SECRET);
  assert.throws(
    () => Escrow.fromJSON(envelope),
    /invalid snapshot: unknown field "snapshot"/,
  );
  const unsigned = escrow.toJSON();
  assert.throws(
    () => Escrow.restoreSignedSnapshot(unsigned, SECRET),
    /invalid signed snapshot envelope: unknown field "id"/,
  );
  // Unsigned path regression: the old form still works untouched.
  const restoredUnsigned = Escrow.fromJSON(unsigned);
  assert.equal(restoredUnsigned.state, "VERIFIED");
  assert.equal(restoredUnsigned.toJSON().deadline, "2027-01-01T00:00:00.000Z");
});

// A Buffer secret and the same bytes as a string produce the same
// MAC, and either form restores the other's envelope.
test("string and Buffer secrets cross-restore with the same MAC", () => {
  const escrow = seededEscrow();
  const fromString = escrow.exportSignedSnapshot(SECRET);
  const fromBuffer = escrow.exportSignedSnapshot(
    Buffer.from(SECRET, "utf8"),
  );
  assert.equal(fromBuffer.mac, fromString.mac);
  const restored = Escrow.restoreSignedSnapshot(
    fromBuffer,
    Buffer.from(SECRET, "utf8"),
  );
  assert.equal(restored.state, "VERIFIED");
  const restoredCross = Escrow.fromSignedSnapshot(
    fromString,
    Buffer.from(SECRET, "utf8"),
  );
  assert.equal(restoredCross.state, "VERIFIED");
  // Mutating the caller's Buffer after signing must not change the
  // envelope: the secret bytes are read at signing time.
  const mutable = Buffer.from(SECRET, "utf8");
  const signed = escrow.exportSignedSnapshot(mutable);
  mutable.fill(0);
  const stillRestores = Escrow.restoreSignedSnapshot(signed, SECRET);
  assert.equal(stillRestores.state, "VERIFIED");
});

// The envelope secret and the audit key are independent: the keyed
// chain still needs its own key on restore, fail-closed both ways.
test("keyed history chain still needs its auditKey on signed restore", () => {
  const keyed = new Escrow("escrow-signed-keyed", { auditKey: AUDIT_KEY });
  keyed.dispatch("FUND", "deposit", 500, {
    at: "2026-11-09T00:00:00.000Z",
  });
  const envelope = keyed.exportSignedSnapshot(SECRET);
  // Same envelope secret, correct audit key: restores and the chain
  // verifies under the key.
  const restored = Escrow.restoreSignedSnapshot(envelope, SECRET, {
    auditKey: AUDIT_KEY,
  });
  assert.equal(restored.state, "FUNDED");
  assert.equal(verifyHistoryChain(restored.history, AUDIT_KEY), true);
  // Without the audit key, or with the wrong one, the keyed chain
  // is rejected — the envelope MAC alone does not bless the log.
  assert.throws(
    () => Escrow.restoreSignedSnapshot(envelope, SECRET),
    /invalid snapshot: history hash chain is broken/,
  );
  assert.throws(
    () =>
      Escrow.restoreSignedSnapshot(envelope, SECRET, {
        auditKey: "wrong-audit-key",
      }),
    /invalid snapshot: history hash chain is broken/,
  );
});
