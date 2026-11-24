import test from "node:test";
import assert from "node:assert/strict";
import { Escrow, verifyHistoryChain } from "../src/index.js";
import type { EscrowHistoryEntry } from "../src/index.js";

/**
 * `verifyHistoryChain` history shape (backlog #1368, mirrors
 * dataquest #1339).
 *
 * The verifier read `history.length` / `history.map(...)` with no
 * shape check, so an untrusted persisted log reached it as a bare
 * `TypeError` — and worse, a hashless non-object entry (`"x"`, `42`,
 * `{}`) silently returned `true`, treated as a legacy hashless
 * history. Rules under test:
 *  - a non-array history throws the same `invalid history: history
 *    must be an array` error `parseEscrowHistory` throws, never a
 *    bare `TypeError`
 *  - a non-object entry (including an array entry, which `isRecord`
 *    rejects) throws `invalid history: entry[N]: entry must be an
 *    object` naming the first offending index
 *  - a well-shaped history keeps its previous verdict: intact -> true,
 *    tampered -> false, mixed chained/hashless -> false, fully
 *    hashless legacy -> true, empty -> true
 *  - the keyed path is untouched: the correct key verifies, a wrong
 *    key fails closed
 */

/** Build a chained escrow: CREATED -> FUNDED -> MILESTONE_SUBMITTED. */
function chainedEscrow(): Escrow {
  const e = new Escrow("escrow-chain-shape-1");
  e.dispatch("FUND", "sponsor deposit", 10630);
  e.dispatch("SUBMIT_MILESTONE", "creator delivers KPI bundle");
  return e;
}

/** Deep-clone a history so tampering tests don't fight Object.freeze. */
function cloneHistory(
  history: readonly EscrowHistoryEntry[],
): EscrowHistoryEntry[] {
  return JSON.parse(JSON.stringify(history)) as EscrowHistoryEntry[];
}

test("null history throws a named array error, not a bare TypeError", () => {
  assert.throws(
    () => verifyHistoryChain(null as never),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof TypeError));
      assert.equal(
        (error as Error).message,
        "invalid history: history must be an array",
      );
      return true;
    },
  );
});

test("undefined, numeric, string and object histories throw the array error", () => {
  for (const bad of [undefined, 42, "x", {}] as never[]) {
    assert.throws(
      () => verifyHistoryChain(bad),
      /invalid history: history must be an array/,
    );
  }
});

test("null, string and numeric entries throw the named entry error", () => {
  for (const bad of [null, "x", 42] as never[]) {
    assert.throws(
      () => verifyHistoryChain([bad]),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!(error instanceof TypeError));
        assert.equal(
          (error as Error).message,
          "invalid history: entry[0]: entry must be an object",
        );
        return true;
      },
    );
  }
});

test("an array entry is not an object entry", () => {
  assert.throws(
    () => verifyHistoryChain([[]] as never),
    /invalid history: entry\[0\]: entry must be an object/,
  );
});

test("the first offending index is named, not just index 0", () => {
  const history = cloneHistory(chainedEscrow().history);
  history[1] = null as never;
  assert.throws(
    () => verifyHistoryChain(history),
    /invalid history: entry\[1\]: entry must be an object/,
  );
});

test("intact chained history still verifies true", () => {
  const e = chainedEscrow();
  assert.equal(verifyHistoryChain(e.history), true);
});

test("tampered chained history still verifies false, not throws", () => {
  const tampered = cloneHistory(chainedEscrow().history);
  tampered[0].amount = 99999; // rewrite the FUND amount on disk
  assert.equal(verifyHistoryChain(tampered), false);
});

test("mixed chained/hashless history still verifies false", () => {
  const mixed = cloneHistory(chainedEscrow().history);
  delete (mixed[1] as Partial<EscrowHistoryEntry>).hash;
  delete (mixed[1] as Partial<EscrowHistoryEntry>).prevHash;
  assert.equal(verifyHistoryChain(mixed), false);
});

test("fully hashless legacy history still verifies true", () => {
  const legacy = cloneHistory(chainedEscrow().history);
  for (const entry of legacy) {
    delete (entry as Partial<EscrowHistoryEntry>).hash;
    delete (entry as Partial<EscrowHistoryEntry>).prevHash;
  }
  assert.equal(verifyHistoryChain(legacy), true);
});

test("empty history still verifies true", () => {
  assert.equal(verifyHistoryChain([]), true);
});

test("keyed path is untouched: correct key verifies, wrong key fails closed", () => {
  const keyed = new Escrow("escrow-chain-shape-keyed", {
    auditKey: "shape-guard-demo-key",
  });
  keyed.dispatch("FUND", "sponsor deposit", 5000);
  assert.equal(
    verifyHistoryChain(keyed.history, "shape-guard-demo-key"),
    true,
  );
  assert.equal(
    verifyHistoryChain(keyed.history, "wrong-key"),
    false,
  );
  assert.equal(verifyHistoryChain(keyed.history), false);
});
