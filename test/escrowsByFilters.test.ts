/**
 * Batch filter helpers escrowsByState / escrowsByActor (backlog #843).
 *
 * The dataquest lifecycle already has tasksByState / tasksByActor; the
 * escrow side only had the watchdog screens (deadline, staleness),
 * so a caller that simply wanted every FUNDED escrow — or every
 * escrow one operator ever touched — had to hand-write the filter,
 * and a hand-written filter has no shared answer for an unknown
 * state string or an empty actor. These helpers give both listings
 * one shared, pure, fail-fast entry point.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  escrowsByActor,
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
