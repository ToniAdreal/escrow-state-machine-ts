import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  calculateDeposit,
  historyFromNdjson,
  historyToNdjson,
} from "../src/index.js";
import type { EscrowHistoryEntry } from "../src/index.js";

const AT = [
  "2026-01-01T00:00:00.000Z",
  "2026-01-01T01:00:00.000Z",
  "2026-01-01T02:00:00.000Z",
  "2026-01-01T03:00:00.000Z",
];

/** Full lifecycle CREATED -> FUNDED -> ... -> RELEASED, pinned timestamps. */
function releasedEscrow(id = "escrow-ndjson-1"): Escrow {
  const e = new Escrow(id);
  e.dispatch("FUND", "sponsor deposit", 10630, { at: AT[0] });
  e.dispatch("SUBMIT_MILESTONE", "creator delivers KPI bundle", undefined, {
    at: AT[1],
  });
  e.dispatch("VERIFY_PASS", "oracle attestation ok", undefined, { at: AT[2] });
  e.dispatch("RELEASE", "pay out", undefined, { at: AT[3] });
  return e;
}

test("ndjson: full lifecycle round-trip is deep-equal and byte-stable", () => {
  const escrow = releasedEscrow();
  const text = historyToNdjson(escrow.history);
  assert.ok(text.endsWith("\n"));
  assert.equal(text.trimEnd().split("\n").length, 4);
  const imported = historyFromNdjson(text);
  assert.deepEqual(imported, [...escrow.history]);
  assert.equal(historyToNdjson(imported), text);
});

test("ndjson: export accepts a live Escrow directly", () => {
  const escrow = releasedEscrow();
  assert.equal(
    historyToNdjson(escrow),
    historyToNdjson(escrow.history)
  );
});

test("ndjson: tampering with a middle line's field breaks the hash chain", () => {
  const lines = historyToNdjson(releasedEscrow()).trimEnd().split("\n");
  const entry = JSON.parse(lines[1]) as EscrowHistoryEntry;
  entry.note = "forged note";
  lines[1] = JSON.stringify(entry);
  assert.throws(
    () => historyFromNdjson(lines.join("\n") + "\n"),
    /invalid ndjson: .*hash chain is broken/
  );
});

test("ndjson: swapping two lines is rejected (chain/seq break)", () => {
  const lines = historyToNdjson(releasedEscrow()).trimEnd().split("\n");
  [lines[1], lines[2]] = [lines[2], lines[1]];
  assert.throws(
    () => historyFromNdjson(lines.join("\n") + "\n"),
    /invalid ndjson:/
  );
});

test("ndjson: a non-JSON line reports its 1-based line number", () => {
  const lines = historyToNdjson(releasedEscrow()).trimEnd().split("\n");
  lines[2] = "{not json";
  assert.throws(
    () => historyFromNdjson(lines.join("\n") + "\n"),
    /invalid ndjson: line 3: not valid JSON/
  );
});

test("ndjson: blank lines are skipped but line numbers stay physical", () => {
  const lines = historyToNdjson(releasedEscrow()).trimEnd().split("\n");
  const text = `\n${lines[0]}\n\n${lines[1]}\n{bad\n`;
  assert.throws(() => historyFromNdjson(text), /invalid ndjson: line 5:/);
});

test("ndjson: empty history exports to '' and empty input is rejected", () => {
  assert.equal(historyToNdjson([]), "");
  assert.throws(() => historyFromNdjson(""), /invalid ndjson: input is empty/);
  assert.throws(
    () => historyFromNdjson("  \n \r\n\t\n"),
    /invalid ndjson: input is empty/
  );
  assert.throws(
    () => historyFromNdjson(42 as unknown as string),
    /invalid ndjson: input must be a string/
  );
});

test("ndjson: CRLF input is accepted and yields identical entries", () => {
  const escrow = releasedEscrow();
  const text = historyToNdjson(escrow.history);
  const crlf = text.replace(/\n/g, "\r\n");
  assert.deepEqual(historyFromNdjson(crlf), [...escrow.history]);
});

test("ndjson: imported entries rebuild an escrow and feed buildSettlementReport", () => {
  const escrow = releasedEscrow();
  const imported = historyFromNdjson(historyToNdjson(escrow.history));
  const restored = Escrow.fromJSON({
    id: escrow.id,
    state: imported[imported.length - 1].to,
    history: imported,
  });
  assert.equal(restored.state, "RELEASED");
  assert.deepEqual(restored.history, escrow.history);

  const deposit = calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
  const report = buildSettlementReport({
    escrowId: escrow.id,
    history: imported,
    finalState: "RELEASED",
    deposit,
    settlement: { proFeeBps: 500 },
  });
  assert.equal(report.outcome, "released");
  assert.equal(report.balanced, true);
  assert.equal(report.eventCount, 4);
});

test("ndjson: exporting a tampered raw history throws instead of writing it", () => {
  const escrow = releasedEscrow();
  const tampered = escrow.history.map((e) => ({ ...e }));
  tampered[0].amount = 1;
  assert.throws(() => historyToNdjson(tampered), /hash chain is broken/);
});

test("ndjson: keyed (HMAC) chains need the audit key on both sides", () => {
  const escrow = new Escrow("escrow-ndjson-keyed", { auditKey: "k1" });
  escrow.dispatch("FUND", "sponsor deposit", 500, { at: AT[0] });
  const text = historyToNdjson(escrow.history, "k1");
  assert.deepEqual(historyFromNdjson(text, "k1"), [...escrow.history]);
  assert.throws(() => historyFromNdjson(text), /hash chain is broken/);
  assert.throws(() => historyFromNdjson(text, "wrong"), /hash chain is broken/);
});
