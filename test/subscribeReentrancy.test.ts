import assert from "node:assert/strict";
import test from "node:test";
import {
  Escrow,
  EscrowEvent,
  EscrowState,
} from "../src/stateMachine.js";

/**
 * Reentrancy semantics of dispatch subscriptions (#527).
 *
 * `Escrow.dispatch` calls `_notifyListeners` AFTER the audit entry is
 * appended, and `_notifyListeners` iterates over a snapshot of the
 * listener list. A listener may therefore dispatch again (reentrancy):
 * the inner dispatch appends seq+1 and notifies the full listener list
 * before the outer notification loop resumes. The interleaved order is
 * a deliberate, pinned part of the fan-out contract — webhook delivery
 * hooks routinely trigger follow-up transitions, and a future refactor
 * must not silently reshuffle this order.
 *
 * All four cases below turn red if `_notifyListeners` is changed from
 * snapshot iteration (`[...this._listeners]`) to live-array iteration:
 * with a live array, subscribe/unsubscribe mutations during a reentrant
 * notification leak across dispatch levels and change who gets notified.
 */

// One reentrant dispatch only: fires on the first FUND, then disarms,
// so a pathological listener cannot recurse forever.
function reentrantOnce(
  escrow: Escrow,
  seen: string[],
  name: string,
  reenter: () => void
): void {
  let armed = true;
  escrow.subscribe((event: EscrowEvent) => {
    seen.push(`${name}:${event}`);
    if (event === "FUND" && armed) {
      armed = false;
      reenter();
    }
  });
}

test("subscribe: reentrant dispatch interleaves notifications in a pinned order", () => {
  const escrow = new Escrow("sub-reentry-order");
  const seen: string[] = [];
  reentrantOnce(escrow, seen, "A", () => escrow.dispatch("SUBMIT_MILESTONE"));
  escrow.subscribe((event: EscrowEvent) => {
    seen.push(`B:${event}`);
  });

  const outer = escrow.dispatch("FUND", undefined, 1000);
  assert.equal(outer, "FUNDED");

  // Outer notification pauses while the inner dispatch fully notifies.
  assert.deepEqual(seen, [
    "A:FUND",
    "A:SUBMIT_MILESTONE",
    "B:SUBMIT_MILESTONE",
    "B:FUND",
  ]);

  // Audit trail: two appends, no gaps, chain continuous.
  const history = escrow.history;
  assert.deepEqual(
    history.map((e) => [e.seq, e.event, e.from, e.to]),
    [
      [1, "FUND", "CREATED", "FUNDED"],
      [2, "SUBMIT_MILESTONE", "FUNDED", "MILESTONE_SUBMITTED"],
    ]
  );
  assert.equal(escrow.state, "MILESTONE_SUBMITTED");

  // The reentry fired exactly once: A and B each got exactly two calls.
  const counts = (n: string) => seen.filter((s) => s.startsWith(n + ":")).length;
  assert.equal(counts("A"), 2);
  assert.equal(counts("B"), 2);
});

test("subscribe: a throwing reentrant dispatch is isolated — outer dispatch returns normally, audit intact", () => {
  const escrow = new Escrow("sub-reentry-throw");
  const seen: string[] = [];
  let reentryError: string | undefined;
  escrow.subscribe((event: EscrowEvent) => {
    seen.push(`A:${event}`);
    if (event === "FUND") {
      // VERIFY_PASS is illegal from FUNDED: the inner dispatch throws.
      try {
        escrow.dispatch("VERIFY_PASS");
      } catch (err) {
        reentryError = (err as Error).message;
        throw err; // propagate into the isolation boundary
      }
    }
  });
  escrow.subscribe((event: EscrowEvent) => {
    seen.push(`B:${event}`);
  });

  // Proves the reentrant dispatch really did throw…
  const outer = escrow.dispatch("FUND", undefined, 1000);
  assert.match(reentryError ?? "", /invalid transition: VERIFY_PASS from FUNDED/);

  // …and that the throw was swallowed by listener isolation: the outer
  // dispatch returns normally, the audit entry is intact, and the peer
  // listener was still notified. Error isolation and reentrancy are
  // orthogonal.
  assert.equal(outer, "FUNDED");
  const history = escrow.history;
  assert.equal(history.length, 1);
  assert.deepEqual(
    history.map((e) => [e.seq, e.event, e.from, e.to]),
    [[1, "FUND", "CREATED", "FUNDED"]]
  );
  assert.deepEqual(seen, ["A:FUND", "B:FUND"]);
});

test("subscribe: a listener subscribed during reentrancy gets the inner event, not the outer one", () => {
  const escrow = new Escrow("sub-reentry-subscribe");
  const seen: string[] = [];
  let armed = true;
  escrow.subscribe((event: EscrowEvent) => {
    seen.push(`A:${event}`);
    if (event === "FUND" && armed) {
      armed = false;
      // C joins after the outer snapshot was taken but before the inner
      // dispatch: it must be notified for SUBMIT_MILESTONE, never for
      // the already-in-flight FUND.
      escrow.subscribe((e: EscrowEvent) => {
        seen.push(`C:${e}`);
      });
      escrow.dispatch("SUBMIT_MILESTONE");
    }
  });
  escrow.subscribe((event: EscrowEvent) => {
    seen.push(`B:${event}`);
  });

  escrow.dispatch("FUND", undefined, 1000);
  assert.deepEqual(seen, [
    "A:FUND",
    "A:SUBMIT_MILESTONE",
    "B:SUBMIT_MILESTONE",
    "C:SUBMIT_MILESTONE",
    "B:FUND",
  ]);

  const cCalls = seen.filter((s) => s === "C:SUBMIT_MILESTONE");
  assert.equal(cCalls.length, 1);
  assert.ok(!seen.some((s) => s === "C:FUND"), "C must not get the outer FUND");
});

test("subscribe: unsubscribing during reentrancy affects only later dispatches", () => {
  const escrow = new Escrow("sub-reentry-unsubscribe");
  const seen: string[] = [];
  let armed = true;
  let unsubB: (() => void) | undefined;
  escrow.subscribe((event: EscrowEvent, _from: EscrowState, _to: EscrowState) => {
    seen.push(`A:${event}`);
    if (event === "FUND" && armed) {
      armed = false;
      // B leaves after the outer snapshot was taken but before the inner
      // dispatch: the inner notification (snapshot taken post-removal)
      // skips B, while the outer notification (snapshot pre-removal)
      // still delivers FUND to B.
      unsubB!();
      escrow.dispatch("SUBMIT_MILESTONE");
    }
  });
  unsubB = escrow.subscribe((event: EscrowEvent) => {
    seen.push(`B:${event}`);
  });

  escrow.dispatch("FUND", undefined, 1000);
  assert.deepEqual(seen, ["A:FUND", "A:SUBMIT_MILESTONE", "B:FUND"]);
  assert.equal(escrow.listenerCount, 1);

  // B stays gone for later dispatches.
  seen.length = 0;
  const next = escrow.dispatch("DISPUTE");
  assert.equal(next, "DISPUTED");
  assert.deepEqual(seen, ["A:DISPUTE"]);
});
