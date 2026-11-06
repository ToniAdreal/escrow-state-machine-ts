/**
 * Batch filter helpers escrowsByState / escrowsByActor / escrowsByEvent
 * (backlog #843, #927).
 *
 * The dataquest lifecycle already has tasksByState / tasksByActor; the
 * escrow side only had the watchdog screens (deadline, staleness),
 * so a caller that simply wanted every FUNDED escrow — or every
 * escrow one operator ever touched, or every escrow that was ever
 * disputed — had to hand-write the filter, and a hand-written filter
 * has no shared answer for an unknown state string, an empty actor,
 * or an unknown event. These helpers give all three listings one
 * shared, pure, fail-fast entry point.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  escrowsByActor,
  escrowsByEvent,
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

describe("escrowsByState", () => {
  it("returns every escrow in the state, in input order", () => {
    const fundedA = fundedEscrow("a1");
    const released = releasedEscrow("a2");
    const fundedB = fundedEscrow("a3");
    const created = new Escrow("a4");
    assert.deepEqual(
      escrowsByState([fundedA, released, fundedB, created], "FUNDED").map(
        (e) => e.id,
      ),
      ["a1", "a3"],
    );
    assert.deepEqual(
      escrowsByState([fundedA, released, fundedB, created], "CREATED").map(
        (e) => e.id,
      ),
      ["a4"],
    );
  });

  it("filters terminal states exactly like any other state", () => {
    const released = releasedEscrow("b1");
    const funded = fundedEscrow("b2");
    assert.deepEqual(
      escrowsByState([released, funded], "RELEASED").map((e) => e.id),
      ["b1"],
    );
  });

  it("fails fast on an unknown state, naming the state value", () => {
    const funded = fundedEscrow("c1");
    assert.throws(
      () => escrowsByState([funded], "FUNDEDD" as never),
      /invalid escrowsByState: unknown state "FUNDEDD"/,
    );
    // Case matters: the lowercase spelling is not a state either.
    assert.throws(
      () => escrowsByState([funded], "funded" as never),
      /invalid escrowsByState: unknown state "funded"/,
    );
  });

  it("returns an empty array for an empty batch, not an error", () => {
    assert.deepEqual(escrowsByState([], "FUNDED"), []);
  });
});

describe("escrowsByActor", () => {
  it("returns every escrow the actor touched, in input order, once each", () => {
    const aliceOnce = fundedEscrow("d1", "alice");
    const bob = fundedEscrow("d2", "bob");
    // Two alice entries on one escrow still match it only once.
    const aliceTwice = fundedEscrow("d3", "alice");
    aliceTwice.dispatch("SUBMIT_MILESTONE", undefined, undefined, {
      actor: "alice",
    });
    const aliceLater = releasedEscrow("d4", "alice");
    assert.deepEqual(
      escrowsByActor([aliceOnce, bob, aliceTwice, aliceLater], "alice").map(
        (e) => e.id,
      ),
      ["d1", "d3", "d4"],
    );
  });

  it("matches any history entry, not just the latest one", () => {
    const escrow = fundedEscrow("e1", "alice");
    escrow.dispatch("SUBMIT_MILESTONE", undefined, undefined, {
      actor: "bob",
    });
    assert.deepEqual(escrowsByActor([escrow], "alice").map((e) => e.id), [
      "e1",
    ]);
  });

  it("does not attribute note-only (actor-less) entries to anyone", () => {
    const noted = fundedEscrow("f1");
    noted.dispatch("SUBMIT_MILESTONE", "reviewed, no actor named");
    assert.deepEqual(escrowsByActor([noted], "alice"), []);
    // An escrow with no history at all matches nobody either.
    assert.deepEqual(escrowsByActor([new Escrow("f2")], "alice"), []);
  });

  it("matches actors exactly, not by substring", () => {
    const escrow = fundedEscrow("g1", "alice");
    assert.deepEqual(escrowsByActor([escrow], "ali"), []);
    assert.deepEqual(escrowsByActor([escrow], "alice "), []);
  });

  it("rejects an empty or non-string actor fail-fast", () => {
    const escrow = fundedEscrow("h1", "alice");
    assert.throws(
      () => escrowsByActor([escrow], ""),
      /invalid escrowsByActor: actor must be a non-empty string, got ""/,
    );
    assert.throws(
      () => escrowsByActor([escrow], 42 as unknown as string),
      /invalid escrowsByActor: actor must be a non-empty string, got 42/,
    );
    assert.throws(
      () => escrowsByActor([escrow], undefined as unknown as string),
      /invalid escrowsByActor: actor must be a non-empty string/,
    );
  });

  it("returns an empty array for an empty batch, not an error", () => {
    assert.deepEqual(escrowsByActor([], "alice"), []);
  });

  it("is pure: same object references, no dispatch, no history change", () => {
    const funded = fundedEscrow("i1", "alice");
    const released = releasedEscrow("i2", "alice");
    const beforeFunded = funded.history.length;
    const beforeReleased = released.history.length;
    const result = escrowsByActor([funded, released], "alice");
    assert.equal(result[0], funded);
    assert.equal(result[1], released);
    assert.equal(funded.history.length, beforeFunded);
    assert.equal(released.history.length, beforeReleased);
    assert.equal(funded.state, "FUNDED");
    assert.equal(released.state, "RELEASED");
    const byState = escrowsByState([funded, released], "FUNDED");
    assert.equal(byState[0], funded);
    assert.equal(funded.history.length, beforeFunded);
  });
});

describe("escrowsByEvent", () => {
  function disputedEscrow(id: string): Escrow {
    const escrow = fundedEscrow(id);
    escrow.dispatch("DISPUTE", "buyer claims non-delivery");
    return escrow;
  }

  function verifyFailedThenReleased(id: string): Escrow {
    const escrow = fundedEscrow(id);
    escrow.dispatch("SUBMIT_MILESTONE");
    escrow.dispatch("VERIFY_FAIL", "evidence did not match the brief");
    escrow.dispatch("ARBITRATE_RELEASE", "arbitrator sided with the creator");
    return escrow;
  }

  it("returns every escrow whose history carries the event, in input order", () => {
    const disputedA = disputedEscrow("j1");
    const funded = fundedEscrow("j2");
    const disputedB = disputedEscrow("j3");
    const released = releasedEscrow("j4");
    assert.deepEqual(
      escrowsByEvent(
        [disputedA, funded, disputedB, released],
        "DISPUTE",
      ).map((e) => e.id),
      ["j1", "j3"],
    );
    assert.deepEqual(
      escrowsByEvent([disputedA, funded, disputedB, released], "FUND").map(
        (e) => e.id,
      ),
      ["j1", "j2", "j3", "j4"],
    );
    assert.deepEqual(
      escrowsByEvent([disputedA, funded, disputedB, released], "EXPIRE"),
      [],
    );
  });

  it("matches a terminal escrow when its history carries the event", () => {
    const settled = verifyFailedThenReleased("k1");
    assert.equal(settled.state, "RELEASED");
    // The VERIFY_FAIL entry is two steps back, not the latest one.
    assert.deepEqual(escrowsByEvent([settled], "VERIFY_FAIL").map((e) => e.id), [
      "k1",
    ]);
    // The terminal step was arbitration, not a plain release: the
    // ARBITRATE_RELEASE entry matches, while RELEASE (a different
    // event) matches nothing on this escrow.
    assert.deepEqual(
      escrowsByEvent([settled], "ARBITRATE_RELEASE").map((e) => e.id),
      ["k1"],
    );
    assert.deepEqual(escrowsByEvent([settled], "RELEASE"), []);
    // And a released escrow that was never disputed stays out of the
    // dispute slice.
    const clean = releasedEscrow("k2");
    assert.deepEqual(escrowsByEvent([clean], "DISPUTE"), []);
  });

  it("matches an escrow only once no matter how many entries carry the event", () => {
    // A top-up is a second FUND on the same escrow (FUNDED self-loop).
    const toppedUp = fundedEscrow("l1");
    toppedUp.dispatch("FUND", "top-up deposit", 500);
    assert.equal(
      toppedUp.history.filter((entry) => entry.event === "FUND").length,
      2,
    );
    assert.deepEqual(escrowsByEvent([toppedUp], "FUND").map((e) => e.id), [
      "l1",
    ]);
    assert.equal(escrowsByEvent([toppedUp], "FUND")[0], toppedUp);
  });

  it("matches any history entry, not just the latest one", () => {
    const escrow = disputedEscrow("m1");
    escrow.dispatch("ARBITRATE_REFUND", "arbitrator sided with the buyer");
    assert.equal(escrow.state, "REFUNDED");
    assert.deepEqual(escrowsByEvent([escrow], "DISPUTE").map((e) => e.id), [
      "m1",
    ]);
  });

  it("fails fast on an unknown event, naming the event value", () => {
    const funded = fundedEscrow("n1");
    assert.throws(
      () => escrowsByEvent([funded], "DISPUT" as never),
      /invalid escrowsByEvent: unknown event "DISPUT"/,
    );
    // Case matters: the lowercase spelling is not an event either.
    assert.throws(
      () => escrowsByEvent([funded], "dispute" as never),
      /invalid escrowsByEvent: unknown event "dispute"/,
    );
    // A state name is not an event: DISPUTED is a state, DISPUTE is
    // the event.
    assert.throws(
      () => escrowsByEvent([funded], "DISPUTED" as never),
      /invalid escrowsByEvent: unknown event "DISPUTED"/,
    );
  });

  it("matches nothing on an escrow with no history at all", () => {
    assert.deepEqual(escrowsByEvent([new Escrow("o1")], "FUND"), []);
  });

  it("returns an empty array for an empty batch, not an error", () => {
    assert.deepEqual(escrowsByEvent([], "DISPUTE"), []);
  });

  it("is pure: same object references, no dispatch, no history change", () => {
    const disputed = disputedEscrow("p1");
    const funded = fundedEscrow("p2");
    const beforeDisputed = disputed.history.length;
    const beforeFunded = funded.history.length;
    const result = escrowsByEvent([disputed, funded], "DISPUTE");
    assert.deepEqual(
      result.map((e) => e.id),
      ["p1"],
    );
    assert.equal(result[0], disputed);
    assert.equal(disputed.history.length, beforeDisputed);
    assert.equal(funded.history.length, beforeFunded);
    assert.equal(disputed.state, "DISPUTED");
    assert.equal(funded.state, "FUNDED");
  });

  it("is consistent with the other two lenses on the same batch", () => {
    // The three lenses are orthogonal views of one batch: state reads
    // the present, actor and event read the history.
    const disputed = disputedEscrow("q1");
    const funded = fundedEscrow("q2", "alice");
    const batch = [disputed, funded];
    assert.deepEqual(
      escrowsByState(batch, "DISPUTED").map((e) => e.id),
      ["q1"],
    );
    assert.deepEqual(
      escrowsByActor(batch, "alice").map((e) => e.id),
      ["q2"],
    );
    assert.deepEqual(
      escrowsByEvent(batch, "DISPUTE").map((e) => e.id),
      ["q1"],
    );
    assert.deepEqual(
      escrowsByEvent(batch, "FUND").map((e) => e.id),
      ["q1", "q2"],
    );
  });
});
