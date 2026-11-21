import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  Escrow,
  historyFromNdjson,
  historyToNdjson,
  parseEscrowHistory,
  verifyHistoryChain,
} from "../src/index.js";
import type { EscrowHistoryEntry } from "../src/index.js";

// Backlog #1296: parseEscrowHistory used to reject a broken hash chain
// with one generic sentence ("history hash chain is broken …") that
// named no entry, so a 200-entry audit log gave the caller nowhere to
// look — and historyFromNdjson could not retag it with a line number,
// unlike every structural error. The chain error now names the first
// entry whose link or hash fails, in the same `history[N]` form the
// structural errors already use, with its seq appended:
//   invalid snapshot: history[2]: history hash chain is broken (…) at entry seq 3
// The `history[N]` form is what lets retagLine map it to the NDJSON
// physical line number with zero changes on the NDJSON side. This
// mirrors the dataquest lifecycle's backlog #1285 fix.

const SECRET = "audit-key-for-location-tests";

function chainedEscrow(): Escrow {
  const e = new Escrow("chain-loc-1");
  e.dispatch("FUND", "sponsor deposit", 10630);
  e.dispatch("SUBMIT_MILESTONE", "creator delivers KPI bundle");
  e.dispatch("VERIFY_PASS", "oracle attestation ok", undefined, {
    evidence: "chainlink-req-0xabc",
  });
  e.dispatch("RELEASE", "release to creator", undefined, {
    settlementRef: "0xabc123",
  });
  return e;
}

function keyedEscrow(): Escrow {
  const e = new Escrow("chain-loc-keyed", { auditKey: SECRET });
  e.dispatch("FUND", "sponsor deposit", 10630);
  e.dispatch("SUBMIT_MILESTONE", "creator delivers KPI bundle");
  e.dispatch("VERIFY_PASS", "oracle attestation ok", undefined, {
    evidence: "chainlink-req-0xabc",
  });
  e.dispatch("RELEASE", "release to creator", undefined, {
    settlementRef: "0xabc123",
  });
  return e;
}

function wireClone(entries: readonly EscrowHistoryEntry[]): EscrowHistoryEntry[] {
  return JSON.parse(JSON.stringify(entries)) as EscrowHistoryEntry[];
}

const BROKEN =
  /invalid snapshot: history\[(\d+)\]: history hash chain is broken \(an entry was tampered with, deleted, or reordered\) at entry seq (\d+)/;

function assertNamesSeq(
  fn: () => unknown,
  entryIndex: number,
  seq: number,
): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof Error, "expected an Error");
    const match = BROKEN.exec(err.message);
    assert.ok(match, `message must carry the located form, got: ${err.message}`);
    assert.equal(Number(match[1]), entryIndex, "history[N] index");
    assert.equal(Number(match[2]), seq, "entry seq");
    assert.equal(seq, entryIndex + 1, "seq is the 1-based entry index");
    return true;
  });
}

describe("parseEscrowHistory names the first broken chain entry", () => {
  it("a tampered middle entry names its seq", () => {
    const tampered = wireClone(chainedEscrow().history);
    tampered[2].note = "forged attestation";
    assert.equal(verifyHistoryChain(tampered), false);
    assertNamesSeq(() => parseEscrowHistory(tampered), 2, 3);
  });

  it("a tampered first entry names seq 1", () => {
    const tampered = wireClone(chainedEscrow().history);
    tampered[0].note = "forged deposit";
    assertNamesSeq(() => parseEscrowHistory(tampered), 0, 1);
  });

  it("a forged stored hash names the entry carrying it", () => {
    const forged = wireClone(chainedEscrow().history);
    forged[3].hash = "0".repeat(64);
    assertNamesSeq(() => parseEscrowHistory(forged), 3, 4);
  });

  it("a forged prevHash names the entry carrying it", () => {
    const forged = wireClone(chainedEscrow().history);
    forged[1].prevHash = "f".repeat(64);
    assertNamesSeq(() => parseEscrowHistory(forged), 1, 2);
  });

  it("a deleted middle entry names the break-point seq", () => {
    const original = wireClone(chainedEscrow().history);
    // Drop the seq-2 entry and re-sequence: the seq-3 entry now sits
    // at index 1, so the from/to continuity check — which runs before
    // the chain check — rejects it and names history[1] (seq 2), the
    // first entry after the gap. The chain detector agrees.
    const shortened = [original[0], ...original.slice(2)].map((e, i) => ({
      ...e,
      seq: i + 1,
    }));
    assert.equal(verifyHistoryChain(shortened), false);
    assert.throws(
      () => parseEscrowHistory(shortened),
      /invalid snapshot: history\[1\]: from MILESTONE_SUBMITTED does not continue previous to FUNDED/,
    );
  });

  it("a deletion patched to look structurally valid is caught by the chain at the patched entry", () => {
    const original = wireClone(chainedEscrow().history);
    // The attacker deletes the seq-2 SUBMIT_MILESTONE and rewrites
    // the next entry into a legal SUBMIT_MILESTONE edge
    // (FUNDED -> MILESTONE_SUBMITTED) so the structural checks pass —
    // the hash chain is what catches the rewrite, at the patched
    // entry (seq 2): its prevHash still points at the deleted
    // entry's hash. The rewrite must also respect the parser's
    // event-attribution rules: evidence belongs only on VERIFY_PASS
    // (stripped here) and settlementRef only on RELEASE.
    const patched = [original[0], ...original.slice(2)].map((e, i) => ({
      ...e,
      seq: i + 1,
    }));
    patched[1] = {
      ...patched[1],
      event: "SUBMIT_MILESTONE",
      from: "FUNDED",
      to: "MILESTONE_SUBMITTED",
    };
    delete patched[1].evidence;
    // The tail must be patched too, or the from/to continuity check
    // fires first: the last entry becomes the VERIFY_PASS the new
    // MILESTONE_SUBMITTED state legally leads to.
    patched[2] = {
      ...patched[2],
      event: "VERIFY_PASS",
      from: "MILESTONE_SUBMITTED",
      to: "VERIFIED",
      evidence: "chainlink-req-0xabc",
    };
    delete patched[2].settlementRef;
    assert.equal(verifyHistoryChain(patched), false);
    assertNamesSeq(() => parseEscrowHistory(patched), 1, 2);
  });

  it("reordered entries name the first entry out of place", () => {
    const original = wireClone(chainedEscrow().history);
    // Swapping the first two entries breaks the "must start at
    // CREATED" structural check, which runs before the chain check and
    // names history[0] (seq 1). The chain detector agrees.
    const reordered = [original[1], original[0], ...original.slice(2)].map(
      (e, i) => ({ ...e, seq: i + 1 }),
    );
    assert.equal(verifyHistoryChain(reordered), false);
    assert.throws(
      () => parseEscrowHistory(reordered),
      /invalid snapshot: history\[0\]: chain must start at CREATED, got FUNDED/,
    );
  });

  it("a keyed history tampered with names its seq under the key", () => {
    const tampered = wireClone(keyedEscrow().history);
    tampered[1].note = "forged bundle";
    assert.equal(verifyHistoryChain(tampered, SECRET), false);
    assertNamesSeq(() => parseEscrowHistory(tampered, SECRET), 1, 2);
  });

  it("a keyed history parsed without the key breaks at seq 1", () => {
    // Every stored link is an HMAC; recomputing unkeyed fails on the
    // very first entry, so the locator must say seq 1, not just "broken".
    assertNamesSeq(() => parseEscrowHistory(wireClone(keyedEscrow().history)), 0, 1);
  });
});

describe("parseEscrowHistory names the first entry in a mixed log", () => {
  it("a hashless middle entry names its seq", () => {
    const mixed = wireClone(chainedEscrow().history);
    delete mixed[2].hash;
    delete mixed[2].prevHash;
    assert.equal(verifyHistoryChain(mixed), false);
    assert.throws(
      () => parseEscrowHistory(mixed),
      /invalid snapshot: history\[2\]: hash-chain entries must not be mixed with hashless entries at entry seq 3/,
    );
  });

  it("a hashless-first log names the first chained entry", () => {
    const mixed = wireClone(chainedEscrow().history);
    delete mixed[0].hash;
    delete mixed[0].prevHash;
    assert.throws(
      () => parseEscrowHistory(mixed),
      /invalid snapshot: history\[1\]: hash-chain entries must not be mixed with hashless entries at entry seq 2/,
    );
  });
});

describe("NDJSON import retags the located chain error with its line", () => {
  it("a tampered line reports its physical line number and seq", () => {
    const escrow = chainedEscrow();
    const tampered = historyToNdjson(escrow).replace(
      '"note":"creator delivers KPI bundle"',
      '"note":"forged bundle"',
    );
    // The tampered note first appears on the seq-2 SUBMIT_MILESTONE
    // line, so the chain breaks at entry seq 2 on NDJSON line 2.
    assert.throws(
      () => historyFromNdjson(tampered),
      /invalid ndjson: line 2: history hash chain is broken \(an entry was tampered with, deleted, or reordered\) at entry seq 2/,
    );
  });

  it("blank lines shift the line number but not the seq", () => {
    const escrow = chainedEscrow();
    const lines = historyToNdjson(escrow).split("\n");
    // Tamper the seq-3 VERIFY_PASS line (index 2), then pad the
    // text with blank lines so the physical line is 5, not 3.
    const tamperedLine = lines[2].replace(
      '"note":"oracle attestation ok"',
      '"note":"forged attestation"',
    );
    const text = `\n${lines[0]}\n\n${lines[1]}\n${tamperedLine}\n${lines[3]}\n`;
    assert.throws(
      () => historyFromNdjson(text),
      /invalid ndjson: line 5: history hash chain is broken \(an entry was tampered with, deleted, or reordered\) at entry seq 3/,
    );
  });

  it("a mixed log imported from NDJSON reports its line and seq", () => {
    const escrow = chainedEscrow();
    const lines = historyToNdjson(escrow).split("\n");
    const stripped = JSON.parse(lines[2]) as Record<string, unknown>;
    delete stripped.hash;
    delete stripped.prevHash;
    lines[2] = JSON.stringify(stripped);
    assert.throws(
      () => historyFromNdjson(lines.join("\n")),
      /invalid ndjson: line 3: hash-chain entries must not be mixed with hashless entries at entry seq 3/,
    );
  });
});

describe("legal chains and legacy logs are unchanged", () => {
  it("an intact chained history still parses and verifies", () => {
    const history = wireClone(chainedEscrow().history);
    assert.equal(verifyHistoryChain(history), true);
    assert.deepEqual(parseEscrowHistory(history), history);
  });

  it("a fully hashless legacy history still passes through", () => {
    const legacy = wireClone(chainedEscrow().history).map(
      ({ prevHash, hash, ...rest }) => rest as EscrowHistoryEntry,
    );
    assert.equal(verifyHistoryChain(legacy), true);
    const parsed = parseEscrowHistory(legacy);
    assert.equal(parsed.length, 4);
    assert.equal(parsed[0].hash, undefined);
  });

  it("an empty history still parses and verifies", () => {
    assert.equal(verifyHistoryChain([]), true);
    assert.deepEqual(parseEscrowHistory([]), []);
  });
});
