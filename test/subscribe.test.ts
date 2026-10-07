import assert from "node:assert/strict";
import test from "node:test";
import { Escrow, ListenerErrorContext } from "../src/stateMachine.js";

test("subscribe: listeners receive (event, from, to, entry) in subscription order", () => {
  const escrow = new Escrow("sub-order");
  const seen: string[] = [];
  escrow.subscribe((event, from, to) => {
    seen.push(`first:${event}:${from}->${to}`);
  });
  escrow.subscribe((event, from, to, entry) => {
    seen.push(`second:${event}:${from}->${to}:${entry.seq}`);
  });
  escrow.dispatch("FUND", undefined, 1000);
  assert.deepEqual(seen, [
    "first:FUND:CREATED->FUNDED",
    "second:FUND:CREATED->FUNDED:1",
  ]);
});

test("subscribe: no notification before dispatch happens", () => {
  const escrow = new Escrow("sub-none");
  let calls = 0;
  escrow.subscribe(() => {
    calls++;
  });
  assert.equal(calls, 0);
});

test("subscribe: unsubscribe stops notifications; unsubscribe is idempotent", () => {
  const escrow = new Escrow("sub-unsub");
  const seen: string[] = [];
  const unsub = escrow.subscribe((event) => {
    seen.push(event);
  });
  assert.equal(escrow.listenerCount, 1);
  unsub();
  unsub(); // idempotent: second call is a no-op, must not throw
  assert.equal(escrow.listenerCount, 0);
  escrow.dispatch("FUND", undefined, 500);
  assert.deepEqual(seen, []);
});

test("subscribe: throwing listener is isolated — dispatch still returns, history intact, peers still run", () => {
  const escrow = new Escrow("sub-isolate");
  const after: string[] = [];
  escrow.subscribe(() => {
    throw new Error("bad fan-out consumer");
  });
  escrow.subscribe((event) => {
    after.push(event);
  });
  const next = escrow.dispatch("FUND", undefined, 250);
  assert.equal(next, "FUNDED");
  assert.equal(escrow.history.length, 1);
  assert.deepEqual(after, ["FUND"]);
});

test("subscribe: onError observes listener failures with dispatch context; throwing onError is swallowed", () => {
  const escrow = new Escrow("sub-onerror");
  const boom = new Error("listener blew up");
  const observed: Array<{ err: unknown; ctx: ListenerErrorContext }> = [];
  escrow.subscribe(
    () => {
      throw boom;
    },
    {
      onError: (err, ctx) => {
        observed.push({ err, ctx });
        throw new Error("broken error hook"); // must be swallowed too
      },
    }
  );
  const next = escrow.dispatch("FUND", undefined, 100);
  assert.equal(next, "FUNDED");
  assert.equal(observed.length, 1);
  assert.equal(observed[0].err, boom);
  assert.deepEqual(observed[0].ctx, {
    event: "FUND",
    from: "CREATED",
    to: "FUNDED",
  });
  // dispatch completes normally even with a broken onError
  assert.equal(escrow.history.length, 1);
});

test("subscribe: failed dispatch produces zero notifications", () => {
  const escrow = new Escrow("sub-failed");
  const seen: string[] = [];
  escrow.subscribe((event) => {
    seen.push(event);
  });
  assert.throws(() => escrow.dispatch("RELEASE"), /invalid transition/);
  escrow.dispatch("FUND", undefined, 100);
  assert.deepEqual(seen, ["FUND"]);
  // failed dispatch never touches the listener list either
  assert.equal(escrow.listenerCount, 1);
});

test("subscribe: duplicate idempotency-key dispatch is silent (no re-notify)", () => {
  const escrow = new Escrow("sub-idem");
  const seen: string[] = [];
  escrow.subscribe((event) => {
    seen.push(event);
  });
  escrow.dispatch("FUND", undefined, 100, { idempotencyKey: "k1" });
  escrow.dispatch("FUND", undefined, 100, { idempotencyKey: "k1" }); // no-op
  assert.deepEqual(seen, ["FUND"]);
  assert.equal(escrow.history.length, 1);
});

test("subscribe: entry handed to listener is frozen and detached from the audit trail", () => {
  const escrow = new Escrow("sub-frozen");
  let leaked: unknown = null;
  escrow.subscribe((event, from, to, entry) => {
    leaked = entry;
    assert.throws(
      () => {
        (entry as { seq: number }).seq = 999;
      },
      /TypeError/
    );
  });
  escrow.dispatch("FUND", "deposit", 100);
  assert.ok(leaked !== null);
  // the real audit entry is untouched and structurally clean
  assert.equal(escrow.history[0].seq, 1);
  assert.equal(escrow.history[0].note, "deposit");
});

test("subscribe: non-function listener and invalid options are rejected", () => {
  const escrow = new Escrow("sub-invalid");
  assert.throws(() => escrow.subscribe("nope" as never), /invalid subscribe/);
  assert.throws(
    () => escrow.subscribe(() => {}, { onError: "x" as never }),
    /invalid subscribe: onError/
  );
  assert.throws(
    () => escrow.subscribe(() => {}, "x" as never),
    /invalid subscribe: options must be an object/
  );
  assert.equal(escrow.listenerCount, 0);
});

test("subscribe: subscriptions are in-memory only — toJSON/fromJSON round-trip restarts empty", () => {
  const escrow = new Escrow("sub-snapshot");
  escrow.dispatch("FUND", undefined, 100);
  const seen: string[] = [];
  escrow.subscribe((event) => {
    seen.push(event);
  });
  const restored = Escrow.fromJSON(escrow.toJSON());
  assert.equal(restored.listenerCount, 0);
  restored.dispatch("SUBMIT_MILESTONE");
  assert.deepEqual(seen, []); // old subscription did not follow the snapshot
});

test("subscribe: multiple dispatches notify with matching audit entries", () => {
  const escrow = new Escrow("sub-multi");
  const entries: Array<{ seq: number; event: string; to: string }> = [];
  escrow.subscribe((event, from, to, entry) => {
    entries.push({ seq: entry.seq, event, to });
    // entry matches the last audit entry exactly
    const last = escrow.history[escrow.history.length - 1];
    assert.deepEqual(entry, last);
  });
  escrow.dispatch("FUND", undefined, 1000);
  escrow.dispatch("SUBMIT_MILESTONE");
  escrow.dispatch("VERIFY_PASS", undefined, undefined, { evidence: "Qm-evidence" });
  assert.deepEqual(entries, [
    { seq: 1, event: "FUND", to: "FUNDED" },
    { seq: 2, event: "SUBMIT_MILESTONE", to: "MILESTONE_SUBMITTED" },
    { seq: 3, event: "VERIFY_PASS", to: "VERIFIED" },
  ]);
});
