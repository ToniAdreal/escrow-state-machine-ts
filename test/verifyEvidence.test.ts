/**
 * VERIFY_PASS evidence tests.
 *
 * dispatch("VERIFY_PASS") is a caller trust decision (README FAQ, SECURITY.md):
 * nothing in the state machine verifies the oracle proof. The opt-in
 * `requireVerifyEvidence` constructor flag makes an evidence-free VERIFY_PASS
 * impossible — the evidence reference (e.g. a Chainlink request ID or TEE
 * attestation quote hash) is a required, non-empty string recorded verbatim
 * on the audit entry. The library records the claim; it does NOT verify it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Escrow } from "../src/stateMachine.js";

function fundedSubmitted(escrow: Escrow): void {
  escrow.dispatch("FUND", "initial deposit", 10630);
  escrow.dispatch("SUBMIT_MILESTONE", "milestone 1 delivered");
}

describe("VERIFY_PASS evidence (requireVerifyEvidence)", () => {
  it("required: VERIFY_PASS without evidence throws and leaves no residue", () => {
    const escrow = new Escrow("e1", { requireVerifyEvidence: true });
    fundedSubmitted(escrow);
    const before = escrow.history.length;
    assert.throws(
      () => escrow.dispatch("VERIFY_PASS"),
      /verify evidence required/
    );
    assert.equal(escrow.state, "MILESTONE_SUBMITTED");
    assert.equal(escrow.history.length, before);
  });

  it("required: evidence is recorded verbatim on the audit entry", () => {
    const escrow = new Escrow("e2", { requireVerifyEvidence: true });
    fundedSubmitted(escrow);
    const ref = "chainlink-req-0x9f3a::fulfilled";
    assert.equal(
      escrow.dispatch("VERIFY_PASS", "KPIs validated", undefined, {
        evidence: ref,
      }),
      "VERIFIED"
    );
    const entry = escrow.history[escrow.history.length - 1];
    assert.equal(entry.evidence, ref);
    assert.equal(entry.event, "VERIFY_PASS");
    assert.equal(entry.note, "KPIs validated");
  });

  it("required: empty-string and non-string evidence throw, fail-fast before transition check", () => {
    const escrow = new Escrow("e3", { requireVerifyEvidence: true });
    fundedSubmitted(escrow);
    // Empty string must fail the *required* check, not slip through.
    assert.throws(() => escrow.dispatch("VERIFY_PASS", undefined, undefined, {
      evidence: "",
    } as never), /verify evidence required|must be a non-empty string/);
    // Non-string evidence is a malformed caller input, not a missing one.
    assert.throws(
      () =>
        escrow.dispatch("VERIFY_PASS", undefined, undefined, {
          evidence: 42,
        } as never),
      /must be a non-empty string/
    );
    assert.equal(escrow.state, "MILESTONE_SUBMITTED");
    assert.equal(escrow.history.length, 2);
    // The check runs even when the transition would be illegal: fail-fast
    // input validation must fire before the transition check.
    const created = new Escrow("e3b", { requireVerifyEvidence: true });
    assert.throws(() => created.dispatch("VERIFY_PASS"), /verify evidence required/);
  });

  it("default off: VERIFY_PASS without evidence keeps legacy behavior", () => {
    const escrow = new Escrow("e4");
    fundedSubmitted(escrow);
    assert.equal(escrow.dispatch("VERIFY_PASS", "KPIs validated by oracle"), "VERIFIED");
    const entry = escrow.history[escrow.history.length - 1];
    assert.ok(!("evidence" in entry));
    // VERIFY_FAIL never needs evidence, flag or not.
    const escrow2 = new Escrow("e4b", { requireVerifyEvidence: true });
    fundedSubmitted(escrow2);
    assert.equal(escrow2.dispatch("VERIFY_FAIL", "KPIs missed"), "DISPUTED");
  });

  it("advisory mode: evidence accepted when the flag is off, written to the entry", () => {
    const escrow = new Escrow("e5");
    fundedSubmitted(escrow);
    escrow.dispatch("VERIFY_PASS", undefined, undefined, {
      evidence: "tee-quote-0xabc",
    });
    assert.equal(escrow.history[escrow.history.length - 1].evidence, "tee-quote-0xabc");
  });

  it("evidence on any other event throws, flag or not", () => {
    const plain = new Escrow("e6");
    assert.throws(
      () =>
        plain.dispatch("FUND", "initial", 100, { evidence: "x" } as never),
      /evidence is only accepted on VERIFY_PASS, not on FUND/
    );
    const strict = new Escrow("e6b", { requireVerifyEvidence: true });
    assert.throws(
      () => strict.dispatch("SUBMIT_MILESTONE", undefined, undefined, { evidence: "x" } as never),
      /evidence is only accepted on VERIFY_PASS, not on SUBMIT_MILESTONE/
    );
    assert.equal(plain.history.length, 0);
  });

  it("evidence survives toJSON/fromJSON round-trip", () => {
    const escrow = new Escrow("e7", { requireVerifyEvidence: true });
    fundedSubmitted(escrow);
    escrow.dispatch("VERIFY_PASS", undefined, undefined, {
      evidence: "zk-proof-commitment-0x77",
    });
    const snap = JSON.parse(JSON.stringify(escrow)) as unknown;
    const rebuilt = Escrow.fromJSON(snap);
    const entry = rebuilt.history[rebuilt.history.length - 1];
    assert.equal(entry.event, "VERIFY_PASS");
    assert.equal(entry.evidence, "zk-proof-commitment-0x77");
    // Restored escrow can keep dispatching; the evidence check is
    // per-instance (not in the snapshot), so the rebuilt escrow is in
    // advisory mode until re-constructed with the flag.
    assert.equal(rebuilt.dispatch("RELEASE"), "RELEASED");
  });

  it("fromJSON rejects tampered evidence", () => {
    const escrow = new Escrow("e8");
    fundedSubmitted(escrow);
    escrow.dispatch("VERIFY_PASS");
    const snap = escrow.toJSON() as unknown as Record<string, unknown>;
    const history = snap.history as Array<Record<string, unknown>>;

    const withEvidenceOnFund = JSON.parse(JSON.stringify(snap));
    withEvidenceOnFund.history[0].evidence = "forged";
    assert.throws(
      () => Escrow.fromJSON(withEvidenceOnFund),
      /evidence only allowed on VERIFY_PASS entries/
    );

    const emptyEvidence = JSON.parse(JSON.stringify(snap));
    emptyEvidence.history[2].evidence = "";
    assert.throws(
      () => Escrow.fromJSON(emptyEvidence),
      /evidence must be a non-empty string/
    );

    const nonStringEvidence = JSON.parse(JSON.stringify(snap));
    nonStringEvidence.history[2].evidence = 123;
    assert.throws(
      () => Escrow.fromJSON(nonStringEvidence),
      /evidence must be a non-empty string/
    );
    assert.equal(history.length, 3); // input untouched by the failed parses
  });

  it("constructor options are validated", () => {
    assert.throws(
      () => new Escrow("e9", { requireVerifyEvidence: "yes" } as never),
      /requireVerifyEvidence must be a boolean/
    );
    assert.throws(
      () => new Escrow("e9b", "nope" as never),
      /invalid escrow options/
    );
    // Explicit false behaves like the default.
    const escrow = new Escrow("e9c", { requireVerifyEvidence: false });
    fundedSubmitted(escrow);
    assert.equal(escrow.dispatch("VERIFY_PASS"), "VERIFIED");
  });

  it("evidence combines with idempotency keys", () => {
    const escrow = new Escrow("e10", { requireVerifyEvidence: true });
    fundedSubmitted(escrow);
    const opts = { idempotencyKey: "verify-1", evidence: "chainlink-req-1" };
    assert.equal(escrow.dispatch("VERIFY_PASS", "note", undefined, opts), "VERIFIED");
    assert.equal(escrow.dispatch("VERIFY_PASS", "note", undefined, opts), "VERIFIED");
    assert.equal(
      escrow.history.filter((e) => e.event === "VERIFY_PASS").length,
      1
    );
  });
});
