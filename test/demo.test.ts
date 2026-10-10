import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runDemo, DEMO_ESCROW_ID } from "../src/demo.js";

const repoRoot = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
); // dist/test/*.test.js -> repo root

test("demo runs the full CREATED -> RELEASED chain in-process without throwing", () => {
  const { escrow, report } = runDemo();

  assert.equal(escrow.id, DEMO_ESCROW_ID);
  assert.equal(escrow.state, "RELEASED");
  assert.equal(escrow.isTerminal, true);
  // FUND -> SUBMIT_MILESTONE -> VERIFY_PASS -> RELEASE (4 dispatches)
  assert.equal(escrow.history.length, 4);
  assert.deepEqual(
    escrow.history.map((h) => [h.event, h.from, h.to]),
    [
      ["FUND", "CREATED", "FUNDED"],
      ["SUBMIT_MILESTONE", "FUNDED", "MILESTONE_SUBMITTED"],
      ["VERIFY_PASS", "MILESTONE_SUBMITTED", "VERIFIED"],
      ["RELEASE", "VERIFIED", "RELEASED"],
    ],
  );
  assert.equal(report.outcome, "released");
});

test("demo settlement numbers are self-consistent with the golden deposit", () => {
  const { report } = runDemo();

  // Golden vector: deposit 10,630; 5% pro fee -> platform 531.50,
  // creator 10,098.50, referrer 0, sponsor -10,630.
  assert.equal(report.deposit.deposit, 10630);
  assert.ok(report.balanced);
  assert.equal(report.totalInflow, 10630);
  assert.equal(report.totalOutflow, 10630);
  // Conservation: deposit in = money out, so every party's net sums to 0.
  const netSum = report.parties.reduce((sum, p) => sum + p.net, 0);
  assert.equal(Math.round(netSum * 100) / 100, 0);
  const byParty = Object.fromEntries(report.parties.map((p) => [p.party, p.net]));
  assert.deepEqual(byParty, {
    sponsor: -10630,
    creator: 10098.5,
    platform: 531.5,
    referrer: 0,
  });
});

test("demo is deterministic: two runs produce identical lines", () => {
  assert.deepEqual(runDemo().lines, runDemo().lines);
});

test("compiled demo script exits 0 and prints the chain, history, and report", () => {
  const out = execFileSync("node", [path.join(repoRoot, "dist", "src", "demo.js")], {
    encoding: "utf8",
  });

  assert.match(out, /Escrow DEMO-ESC-001: CREATED/);
  for (const [event, from, to] of [
    ["FUND", "CREATED", "FUNDED"],
    ["SUBMIT_MILESTONE", "FUNDED", "MILESTONE_SUBMITTED"],
    ["VERIFY_PASS", "MILESTONE_SUBMITTED", "VERIFIED"],
    ["RELEASE", "VERIFIED", "RELEASED"],
  ] as const) {
    assert.ok(
      out.includes(event) && out.includes(from) && out.includes(to),
      `missing chain step ${event}: ${from} -> ${to}`,
    );
  }
  assert.match(out, /Final state: RELEASED \(terminal: true\)/);
  // Audit trail has exactly 4 numbered history entries
  const seqRows = out.match(/^\s+\d+  /gm) ?? [];
  assert.equal(seqRows.length, 4);
  // Settlement report tail: balanced totals on the golden deposit
  assert.match(out, /Totals: inflow \$10,630\.00 = outflow \$10,630\.00 — balanced ✓/);
});
