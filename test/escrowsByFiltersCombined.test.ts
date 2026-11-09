/**
 * Combined batch filter escrowsByFilters (backlog #991).
 *
 * The single-axis selectors (escrowsByState / escrowsByActor /
 * escrowsByEvent, backlog #843/#927) each filter on one axis, so a
 * patrol that wanted "escrows alice touched, currently DISPUTED
 * after a dispute" had to chain them and intersect the results —
 * and each chained filter re-scanned every escrow's history. This
 * helper does the same intersection in one pass, with each axis
 * keeping its single-axis selector's validation and matching rule.
 * It mirrors the dataquest lifecycle's tasksByFilters (#990), which
 * has one extra axis (payoutRef) that this escrow has no
 * counterpart for.
 *
 * One honest limit, pinned by a test below: a DISPUTE always moves
 * an escrow out of FUNDED, so "FUNDED and ever disputed" is empty
 * by construction — the transition table has no edge back. The
 * combined filter reports that empty slice; it does not invent one.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  escrowsByActor,
  escrowsByEvent,
  escrowsByFilters,
  escrowsByState,
} from "../src/index.js";

function fundedEscrow(id: string, actor?: string): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch(
    "FUND",
    "initial deposit",
    1000,
    actor === undefined ? undefined : { actor },
  );
  return escrow;
}

function releasedEscrow(id: string, actor?: string): Escrow {
  const escrow = fundedEscrow(id, actor);
  escrow.dispatch("SUBMIT_MILESTONE");
  escrow.dispatch("VERIFY_PASS");
  escrow.dispatch("RELEASE");
  return escrow;
}

function disputedEscrow(id: string, actor?: string): Escrow {
  const escrow = fundedEscrow(id, actor);
  escrow.dispatch(
    "DISPUTE",
    "buyer claims non-delivery",
    undefined,
    actor === undefined ? undefined : { actor },
  );
  return escrow;
}

describe("escrowsByFilters", () => {
  it("a single state condition matches escrowsByState on the same batch", () => {
    const fundedA = fundedEscrow("a1");
    const released = releasedEscrow("a2");
    const fundedB = fundedEscrow("a3");
    const created = new Escrow("a4");
    const batch = [fundedA, released, fundedB, created];
    assert.deepEqual(
      escrowsByFilters(batch, { state: "FUNDED" }),
      escrowsByState(batch, "FUNDED"),
    );
    assert.deepEqual(
      escrowsByFilters(batch, { state: "CREATED" }).map((e) => e.id),
      ["a4"],
    );
    assert.deepEqual(
      escrowsByFilters(batch, { state: "RELEASED" }).map((e) => e.id),
      ["a2"],
    );
  });

  it("a single actor condition matches escrowsByActor on the same batch", () => {
    const aliceOnce = fundedEscrow("b1", "alice");
    const bob = fundedEscrow("b2", "bob");
    const aliceTwice = fundedEscrow("b3", "alice");
    aliceTwice.dispatch("SUBMIT_MILESTONE", undefined, undefined, {
      actor: "alice",
    });
    const batch = [aliceOnce, bob, aliceTwice];
    assert.deepEqual(
      escrowsByFilters(batch, { actor: "alice" }),
      escrowsByActor(batch, "alice"),
    );
    assert.deepEqual(
      escrowsByFilters(batch, { actor: "alice" }).map((e) => e.id),
      ["b1", "b3"],
    );
  });

  it("a single event condition matches escrowsByEvent on the same batch", () => {
    const disputedA = disputedEscrow("c1");
    const funded = fundedEscrow("c2");
    const disputedB = disputedEscrow("c3");
    const batch = [disputedA, funded, disputedB];
    assert.deepEqual(
      escrowsByFilters(batch, { event: "DISPUTE" }),
      escrowsByEvent(batch, "DISPUTE"),
    );
    assert.deepEqual(
      escrowsByFilters(batch, { event: "FUND" }).map((e) => e.id),
      ["c1", "c2", "c3"],
    );
    assert.deepEqual(escrowsByFilters(batch, { event: "EXPIRE" }), []);
  });

  it("two conditions intersect: state and event", () => {
    const disputed = disputedEscrow("d1");
    const funded = fundedEscrow("d2");
    const released = releasedEscrow("d3");
    const batch = [disputed, funded, released];
    // Every escrow was funded, but only the funded one is still FUNDED.
    assert.deepEqual(
      escrowsByFilters(batch, { state: "FUNDED", event: "FUND" }).map(
        (e) => e.id,
      ),
      ["d2"],
    );
    assert.deepEqual(
      escrowsByFilters(batch, { state: "DISPUTED", event: "DISPUTE" }).map(
        (e) => e.id,
      ),
      ["d1"],
    );
    // A released escrow carries FUND in its history too.
    assert.deepEqual(
      escrowsByFilters(batch, { state: "RELEASED", event: "FUND" }).map(
        (e) => e.id,
      ),
      ["d3"],
    );
  });

  it("three conditions intersect: the patrol query from the backlog", () => {
    const aliceDisputed = disputedEscrow("e1", "alice");
    const bobDisputed = disputedEscrow("e2", "bob");
    const aliceFunded = fundedEscrow("e3", "alice");
    const batch = [aliceDisputed, bobDisputed, aliceFunded];
    assert.deepEqual(
      escrowsByFilters(batch, {
        state: "DISPUTED",
        actor: "alice",
        event: "DISPUTE",
      }).map((e) => e.id),
      ["e1"],
    );
    // Same actor and event, still FUNDED: the funded slice is separate.
    assert.deepEqual(
      escrowsByFilters(batch, {
        state: "FUNDED",
        actor: "alice",
        event: "FUND",
      }).map((e) => e.id),
      ["e3"],
    );
  });

  it("is genuinely AND: one failing axis excludes the escrow", () => {
    const disputed = disputedEscrow("f1", "alice");
    const funded = fundedEscrow("f2", "alice");
    const batch = [disputed, funded];
    // "FUNDED and ever disputed" is empty by construction: a DISPUTE
    // always moves an escrow out of FUNDED and no edge returns.
    assert.deepEqual(
      escrowsByFilters(batch, { state: "FUNDED", event: "DISPUTE" }),
      [],
    );
    // State matches, actor does not: bob touched nothing here.
    assert.deepEqual(
      escrowsByFilters(batch, { state: "DISPUTED", actor: "bob" }),
      [],
    );
    // Actor matches, event does not: neither escrow ever expired.
    assert.deepEqual(
      escrowsByFilters(batch, { actor: "alice", event: "EXPIRE" }),
      [],
    );
  });

  it("an empty condition object returns every escrow, in input order", () => {
    const funded = fundedEscrow("g1");
    const released = releasedEscrow("g2");
    const created = new Escrow("g3");
    const batch = [funded, released, created];
    const result = escrowsByFilters(batch, {});
    assert.deepEqual(
      result.map((e) => e.id),
      ["g1", "g2", "g3"],
    );
    assert.equal(result[0], funded);
    assert.equal(result[1], released);
    assert.equal(result[2], created);
    assert.notEqual(result, batch);
  });

  it("rejects an unknown state fail-fast, naming the state value", () => {
    const funded = fundedEscrow("h1");
    assert.throws(
      () => escrowsByFilters([funded], { state: "FUNDEDD" as never }),
      /invalid escrowsByFilters: unknown state "FUNDEDD"/,
    );
    assert.throws(
      () => escrowsByFilters([funded], { state: "funded" as never }),
      /invalid escrowsByFilters: unknown state "funded"/,
    );
    // Validation runs before any filtering, even on an empty batch.
    assert.throws(
      () => escrowsByFilters([], { state: "FUNDEDD" as never }),
      /invalid escrowsByFilters: unknown state "FUNDEDD"/,
    );
  });

  it("rejects an unknown event fail-fast, naming the event value", () => {
    const funded = fundedEscrow("i1");
    assert.throws(
      () => escrowsByFilters([funded], { event: "DISPUT" as never }),
      /invalid escrowsByFilters: unknown event "DISPUT"/,
    );
    // A state name is not an event: DISPUTED is a state, DISPUTE is
    // the event.
    assert.throws(
      () => escrowsByFilters([funded], { event: "DISPUTED" as never }),
      /invalid escrowsByFilters: unknown event "DISPUTED"/,
    );
  });

  it("rejects an empty or non-string actor fail-fast", () => {
    const funded = fundedEscrow("j1", "alice");
    assert.throws(
      () => escrowsByFilters([funded], { actor: "" }),
      /invalid escrowsByFilters: actor must be a non-empty string, got ""/,
    );
    assert.throws(
      () => escrowsByFilters([funded], { actor: 42 as unknown as string }),
      /invalid escrowsByFilters: actor must be a non-empty string, got 42/,
    );
    // Explicitly: undefined is not a condition, so it must not throw.
    assert.deepEqual(
      escrowsByFilters([funded], { actor: undefined }).map((e) => e.id),
      ["j1"],
    );
  });

  it("rejects an unknown filter key fail-fast, naming the key (backlog #1012)", () => {
    const funded = fundedEscrow("m1", "alice");
    // The classic typo: `state` misspelled as `states` used to be
    // silently ignored and return the unfiltered batch.
    assert.throws(
      () =>
        escrowsByFilters([funded], { states: "FUNDED" } as never),
      /invalid escrowsByFilters: unknown filter "states"/,
    );
    // Case variants of a legal axis are not legal axes.
    assert.throws(
      () =>
        escrowsByFilters([funded], { State: "FUNDED" } as never),
      /invalid escrowsByFilters: unknown filter "State"/,
    );
    // A plausible-but-nonexistent axis is rejected the same way.
    assert.throws(
      () =>
        escrowsByFilters([funded], { status: "FUNDED" } as never),
      /invalid escrowsByFilters: unknown filter "status"/,
    );
    // The whitelist scan runs before any filtering, even on an
    // empty batch.
    assert.throws(
      () =>
        escrowsByFilters([], { states: "FUNDED" } as never),
      /invalid escrowsByFilters: unknown filter "states"/,
    );
  });

  it("a legal condition plus an unknown key throws instead of returning a partial slice", () => {
    const funded = fundedEscrow("n1", "alice");
    const released = releasedEscrow("n2", "alice");
    const batch = [funded, released];
    // The legal half alone would select [n1]; the unknown half must
    // not be dropped and the call must not return [n1] as if the
    // extra condition never existed.
    assert.throws(
      () =>
        escrowsByFilters(batch, {
          state: "FUNDED",
          states: "FUNDED",
        } as never),
      /invalid escrowsByFilters: unknown filter "states"/,
    );
    assert.throws(
      () =>
        escrowsByFilters(batch, {
          actor: "alice",
          status: "FUNDED",
        } as never),
      /invalid escrowsByFilters: unknown filter "status"/,
    );
  });

  it("rejects a non-object filters argument with a configuration error, not a TypeError", () => {
    const funded = fundedEscrow("o1");
    assert.throws(
      () =>
        escrowsByFilters([funded], null as never),
      /invalid escrowsByFilters: filters must be an object, got null/,
    );
    assert.throws(
      () =>
        escrowsByFilters([funded], undefined as never),
      /invalid escrowsByFilters: filters must be an object, got undefined/,
    );
    assert.throws(
      () =>
        escrowsByFilters([funded], 42 as never),
      /invalid escrowsByFilters: filters must be an object, got number/,
    );
    assert.throws(
      () =>
        escrowsByFilters([funded], "FUNDED" as never),
      /invalid escrowsByFilters: filters must be an object, got string/,
    );
    assert.throws(
      () =>
        escrowsByFilters([funded], [] as never),
      /invalid escrowsByFilters: filters must be an object, got array/,
    );
  });

  it("checks the key whitelist before the value validation", () => {
    const funded = fundedEscrow("p1");
    // Both the key and the value are wrong here: the unknown-key
    // error wins, because the whitelist scan runs at the entry.
    assert.throws(
      () =>
        escrowsByFilters([funded], {
          state: "FUNDEDD",
          states: "FUNDED",
        } as never),
      /invalid escrowsByFilters: unknown filter "states"/,
    );
  });

  it("keeps input order and returns the same escrow objects", () => {
    const released = releasedEscrow("k1", "alice");
    const disputed = disputedEscrow("k2", "alice");
    const funded = fundedEscrow("k3", "alice");
    const batch = [released, disputed, funded];
    const result = escrowsByFilters(batch, { actor: "alice" });
    assert.deepEqual(
      result.map((e) => e.id),
      ["k1", "k2", "k3"],
    );
    assert.equal(result[0], released);
    assert.equal(result[1], disputed);
    assert.equal(result[2], funded);
  });

  it("is pure: no dispatch, no history change, original batch untouched", () => {
    const disputed = disputedEscrow("l1", "alice");
    const funded = fundedEscrow("l2", "alice");
    const batch = [disputed, funded];
    const beforeDisputed = disputed.history.length;
    const beforeFunded = funded.history.length;
    const result = escrowsByFilters(batch, {
      state: "DISPUTED",
      actor: "alice",
      event: "DISPUTE",
    });
    assert.deepEqual(
      result.map((e) => e.id),
      ["l1"],
    );
    assert.equal(result[0], disputed);
    assert.equal(disputed.history.length, beforeDisputed);
    assert.equal(funded.history.length, beforeFunded);
    assert.equal(disputed.state, "DISPUTED");
    assert.equal(funded.state, "FUNDED");
    assert.deepEqual(
      batch.map((e) => e.id),
      ["l1", "l2"],
    );
  });

  it("returns an empty array for an empty batch, not an error", () => {
    assert.deepEqual(escrowsByFilters([], { state: "FUNDED" }), []);
    assert.deepEqual(escrowsByFilters([], {}), []);
  });
});
