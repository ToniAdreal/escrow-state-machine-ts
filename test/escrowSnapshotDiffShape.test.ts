import test from "node:test";
import assert from "node:assert/strict";
import { Escrow, diffEscrowSnapshots } from "../src/index.js";
import type { EscrowSnapshot } from "../src/index.js";

// Backlog #1295: `diffEscrowSnapshots` shape-checks both inputs
// first (the escrow mirror of dataquest #1294's `diffTaskSnapshots`).
// The diff is a comparison, not a validation — it never re-checks
// that either snapshot's transitions are legal, its seq chain is
// continuous, or its hash chain holds — but both inputs must be
// snapshots at all first. Before this change the diff only checked
// "is it an object" plus matching `id` and "is `history` an array"
// and then read the fields straight off it, so `state: "BOGUS"`
// diffed as a phantom state move, a string `rolePolicy` was
// silently expanded into a character set by `rolePolicyKey`
// (`Object.keys("x")` is `["0"]`), a numeric `rolePolicy` slipped
// through the same key function, and a `null` policy threw a bare
// `TypeError` from `Object.keys(null)` instead of a shape error.
//
// Rules under test:
//  - an unknown `state` on either side throws the exact shape error
//  - a string / numeric / null `rolePolicy` throws the exact shape
//    error, never a bare TypeError (and never a silent char-set
//    comparison); an unknown role-policy event key is rejected too
//  - a string / numeric `idempotencyKeys` throws the exact shape
//    error, never a bare TypeError or a silent char-set comparison
//  - a missing `id`, `state`, or `history` throws the exact shape
//    error; an unknown top-level field (`deadlline`) and a future
//    `v` are rejected the same way
//  - malformed history entries (unknown event, non-canonical `at`,
//    non-integer seq, negative amount, amount on a non-FUND entry)
//    throw the exact per-entry shape error
//  - malformed config (`maxDeposit: -1`, a non-boolean gate, an
//    unknown `maxVisitsByState` state) throws the exact shape error
//  - the `a` side is checked first: both sides broken, the error
//    names `a`'s fault
//  - non-object inputs still throw the pre-existing "both snapshots
//    must be objects" error (the gate runs after that check)
//  - the comparison-not-validation contract does not regress: a
//    shape-valid but hash-broken pair still diffs (identical pair
//    reports `{}`), and a legal diff is byte-for-byte the old
//    behaviour

const PREFIX = "invalid snapshot diff";
const AT = "2026-03-10T09:00:00.000Z";

function fundedEscrow(id: string): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", "initial deposit", 1000, { at: AT });
  return escrow;
}

function clone(snapshot: EscrowSnapshot): Record<string, unknown> {
  return JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
}

function fundedSnapshot(id = "ESC-DIFFSHAPE-01"): EscrowSnapshot {
  return fundedEscrow(id).toJSON();
}

test("unknown state on either side throws the shape error", () => {
  const good = fundedSnapshot();
  const badA = clone(good);
  badA.state = "BOGUS";
  assert.throws(
    () =>
      diffEscrowSnapshots(
        badA as unknown as EscrowSnapshot,
        good,
      ),
    (err: unknown) =>
      err instanceof Error &&
      err.message === `${PREFIX}: unknown state BOGUS`,
  );
  const badB = clone(good);
  badB.state = "BOGUS";
  assert.throws(
    () =>
      diffEscrowSnapshots(
        good,
        badB as unknown as EscrowSnapshot,
      ),
    (err: unknown) =>
      err instanceof Error &&
      err.message === `${PREFIX}: unknown state BOGUS`,
  );
});

test("string, numeric, and null rolePolicy throw the shape error, never a bare TypeError", () => {
  const good = fundedSnapshot();
  for (const badPolicy of ["x", 123, null]) {
    const bad = clone(good);
    bad.rolePolicy = badPolicy;
    assert.throws(
      () =>
        diffEscrowSnapshots(
          bad as unknown as EscrowSnapshot,
          good,
        ),
      (err: unknown) =>
        err instanceof Error &&
        err.message.startsWith(`${PREFIX}: rolePolicy must be an object`) &&
        !/TypeError/.test(err.message),
    );
  }
  // The old silent path: a string policy used to be expanded into a
  // character set by rolePolicyKey, so "abc" compared equal to
  // ["a", "b", "c"] and diffed as no change. It must throw now.
  const stringPolicy = clone(good);
  stringPolicy.rolePolicy = "abc";
  const arrayPolicy = clone(good);
  arrayPolicy.rolePolicy = ["a", "b", "c"];
  assert.throws(
    () =>
      diffEscrowSnapshots(
        stringPolicy as unknown as EscrowSnapshot,
        arrayPolicy as unknown as EscrowSnapshot,
      ),
    (err: unknown) =>
      err instanceof Error &&
      err.message.startsWith(`${PREFIX}: rolePolicy must be an object`),
  );
});

test("rolePolicy with an unknown event key throws the shape error", () => {
  const good = fundedSnapshot();
  const bad = clone(good);
  bad.rolePolicy = { BOGUS: ["treasury"] };
  assert.throws(
    () =>
      diffEscrowSnapshots(
        bad as unknown as EscrowSnapshot,
        good,
      ),
    (err: unknown) =>
      err instanceof Error &&
      err.message === `${PREFIX}: rolePolicy has unknown event BOGUS`,
  );
});

test("string and numeric idempotencyKeys throw the shape error, never a bare TypeError or a silent char-set compare", () => {
  const good = fundedSnapshot();
  for (const badKeys of ["abc", 123]) {
    const bad = clone(good);
    bad.idempotencyKeys = badKeys;
    assert.throws(
      () =>
        diffEscrowSnapshots(
          bad as unknown as EscrowSnapshot,
          good,
        ),
      (err: unknown) =>
        err instanceof Error &&
        err.message.startsWith(
          `${PREFIX}: idempotencyKeys must be an array`,
        ) &&
        !(err instanceof TypeError),
    );
  }
  // The old silent path: "abc" used to spread into ["a", "b", "c"]
  // by idempotencyKeysKey and compare equal to that array.
  const stringKeys = clone(good);
  stringKeys.idempotencyKeys = "abc";
  const arrayKeys = clone(good);
  arrayKeys.idempotencyKeys = ["a", "b", "c"];
  assert.throws(
    () =>
      diffEscrowSnapshots(
        stringKeys as unknown as EscrowSnapshot,
        arrayKeys as unknown as EscrowSnapshot,
      ),
    (err: unknown) =>
      err instanceof Error &&
      err.message.startsWith(`${PREFIX}: idempotencyKeys must be an array`),
  );
});

test("missing id, state, or history each throws the exact shape error", () => {
  const good = fundedSnapshot();
  const noId = clone(good);
  delete noId.id;
  assert.throws(
    () => diffEscrowSnapshots(noId as unknown as EscrowSnapshot, good),
    (err: unknown) =>
      err instanceof Error &&
      err.message === `${PREFIX}: id must be a non-empty string`,
  );
  const noState = clone(good);
  delete noState.state;
  assert.throws(
    () => diffEscrowSnapshots(noState as unknown as EscrowSnapshot, good),
    (err: unknown) =>
      err instanceof Error &&
      err.message === `${PREFIX}: unknown state undefined`,
  );
  const noHistory = clone(good);
  delete noHistory.history;
  assert.throws(
    () => diffEscrowSnapshots(noHistory as unknown as EscrowSnapshot, good),
    (err: unknown) =>
      err instanceof Error &&
      err.message === `${PREFIX}: history must be an array`,
  );
});

test("unknown top-level field and future schema version are rejected", () => {
  const good = fundedSnapshot();
  const typo = clone(good);
  typo.deadlline = "2026-04-01T09:00:00.000Z";
  assert.throws(
    () => diffEscrowSnapshots(typo as unknown as EscrowSnapshot, good),
    (err: unknown) =>
      err instanceof Error &&
      err.message === `${PREFIX}: unknown field "deadlline"`,
  );
  const future = clone(good);
  future.v = 2;
  assert.throws(
    () => diffEscrowSnapshots(future as unknown as EscrowSnapshot, good),
    (err: unknown) =>
      err instanceof Error &&
      err.message === `${PREFIX}: unsupported snapshot version 2`,
  );
});

test("malformed history entries throw per-entry shape errors", () => {
  const good = fundedSnapshot();
  const cases: Array<{
    mutate: (entry: Record<string, unknown>) => void;
    message: string;
  }> = [
    {
      mutate: (entry) => {
        entry.event = "BOGUS";
      },
      message: `${PREFIX}: entry[0]: unknown event BOGUS`,
    },
    {
      mutate: (entry) => {
        entry.at = "2026-03-10 09:00:00";
      },
      message: `${PREFIX}: entry[0]: at must be canonical ISO-8601, got 2026-03-10 09:00:00`,
    },
    {
      mutate: (entry) => {
        entry.seq = "1";
      },
      message: `${PREFIX}: entry[0]: seq must be a positive integer, got 1`,
    },
    {
      mutate: (entry) => {
        entry.amount = -5;
      },
      message: `${PREFIX}: entry[0]: amount must be a finite non-negative number`,
    },
  ];
  for (const { mutate, message } of cases) {
    const bad = clone(good);
    const history = bad.history as Array<Record<string, unknown>>;
    mutate(history[0]);
    assert.throws(
      () => diffEscrowSnapshots(bad as unknown as EscrowSnapshot, good),
      (err: unknown) => err instanceof Error && err.message === message,
    );
  }
});

test("amount on a non-FUND entry throws the placement shape error", () => {
  const escrow = fundedEscrow("ESC-DIFFSHAPE-02");
  escrow.dispatch("SUBMIT_MILESTONE", undefined, undefined, {
    at: "2026-03-11T09:00:00.000Z",
  });
  const good = escrow.toJSON();
  const bad = clone(good);
  const history = bad.history as Array<Record<string, unknown>>;
  history[1].amount = 50;
  assert.throws(
    () => diffEscrowSnapshots(bad as unknown as EscrowSnapshot, good),
    (err: unknown) =>
      err instanceof Error &&
      err.message ===
        `${PREFIX}: entry[1]: amount only allowed on FUND and PARTIAL_RELEASE entries`,
  );
});

test("malformed config fields throw the exact shape error", () => {
  const good = fundedSnapshot();
  const badCap = clone(good);
  badCap.maxDeposit = -1;
  assert.throws(
    () => diffEscrowSnapshots(badCap as unknown as EscrowSnapshot, good),
    (err: unknown) =>
      err instanceof Error &&
      err.message ===
        `${PREFIX}: maxDeposit must be a finite non-negative number, got -1`,
  );
  const badGate = clone(good);
  badGate.requireVerifyEvidence = "yes";
  assert.throws(
    () => diffEscrowSnapshots(badGate as unknown as EscrowSnapshot, good),
    (err: unknown) =>
      err instanceof Error &&
      err.message ===
        `${PREFIX}: requireVerifyEvidence must be a boolean, got "yes"`,
  );
  const badBudget = clone(good);
  badBudget.maxVisitsByState = { BOGUS: 2 };
  assert.throws(
    () => diffEscrowSnapshots(badBudget as unknown as EscrowSnapshot, good),
    (err: unknown) =>
      err instanceof Error &&
      err.message === `${PREFIX}: maxVisitsByState has unknown state BOGUS`,
  );
});

test("the a side is checked first: both sides broken, the error names a's fault", () => {
  const good = fundedSnapshot();
  const badA = clone(good);
  badA.state = "BOGUS";
  const badB = clone(good);
  badB.state = "ALSO_BOGUS";
  assert.throws(
    () =>
      diffEscrowSnapshots(
        badA as unknown as EscrowSnapshot,
        badB as unknown as EscrowSnapshot,
      ),
    (err: unknown) =>
      err instanceof Error &&
      err.message === `${PREFIX}: unknown state BOGUS`,
  );
});

test("non-object inputs still throw the pre-existing objects error", () => {
  const good = fundedSnapshot();
  assert.throws(
    () => diffEscrowSnapshots(null as unknown as EscrowSnapshot, good),
    (err: unknown) =>
      err instanceof Error &&
      err.message === "invalid snapshot diff: both snapshots must be objects",
  );
  assert.throws(
    () => diffEscrowSnapshots(good, "x" as unknown as EscrowSnapshot),
    (err: unknown) =>
      err instanceof Error &&
      err.message === "invalid snapshot diff: both snapshots must be objects",
  );
});

test("legal diffs are unchanged: identical pair reports {}, a state move reports the move", () => {
  const escrow = fundedEscrow("ESC-DIFFSHAPE-03");
  const before = escrow.toJSON();
  assert.deepEqual(diffEscrowSnapshots(before, escrow.toJSON()), {});
  escrow.dispatch("SUBMIT_MILESTONE", undefined, undefined, {
    at: "2026-03-11T09:00:00.000Z",
  });
  const diff = diffEscrowSnapshots(before, escrow.toJSON());
  assert.deepEqual(diff.stateChanged, {
    from: "FUNDED",
    to: "MILESTONE_SUBMITTED",
  });
  assert.equal(diff.historyAppended?.fromSeq, 2);
  assert.equal(diff.historyAppended?.toSeq, 2);
});

test("comparison, not validation: a shape-valid but hash-broken pair still diffs", () => {
  const escrow = fundedEscrow("ESC-DIFFSHAPE-04");
  const tampered = clone(escrow.toJSON());
  const history = tampered.history as Array<Record<string, unknown>>;
  // Rewriting a note breaks the hash chain but leaves every field
  // shape-valid; the diff must report "no change" for the identical
  // pair, not cry tampering — chain verification is the parser's job.
  history[0].note = "rewritten by an attacker";
  assert.deepEqual(
    diffEscrowSnapshots(
      tampered as unknown as EscrowSnapshot,
      tampered as unknown as EscrowSnapshot,
    ),
    {},
  );
});
