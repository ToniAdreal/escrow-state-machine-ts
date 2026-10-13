import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  runDemo,
  DEMO_ARBITRATION_AT,
  DEMO_DISPUTE_ESCROW_ID,
  DEMO_ESCROW_ID,
  DEMO_QUORUM_APPROVAL_ATS,
  DEMO_QUORUM_SIGNERS,
  DEMO_QUORUM_THRESHOLD,
  DEMO_WEBHOOK_AT,
  DEMO_WEBHOOK_EVENT_ID,
  DEMO_WEBHOOK_SECRET,
} from "../src/demo.js";
import { verifySettlementWebhook } from "../src/index.js";

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

test("demo builds a settlement webhook from the report and self-verifies it", () => {
  const { webhook, webhookVerified } = runDemo();

  // Payload field set / values mirror the webhooks test fixture shape:
  // fixed eventId + fixed `at`, released outcome with its release path.
  assert.deepEqual(Object.keys(webhook.payload), [
    "event",
    "eventId",
    "escrowId",
    "outcome",
    "releasePath",
    "deposit",
    "parties",
    "at",
  ]);
  assert.equal(webhook.payload.event, "escrow.settled");
  assert.equal(webhook.payload.eventId, DEMO_WEBHOOK_EVENT_ID);
  assert.equal(webhook.payload.escrowId, DEMO_ESCROW_ID);
  assert.equal(webhook.payload.outcome, "released");
  assert.equal(webhook.payload.releasePath, "VERIFY_PASS → RELEASE");
  assert.equal(webhook.payload.deposit, 10630);
  assert.equal(webhook.payload.at, DEMO_WEBHOOK_AT);
  assert.deepEqual(
    webhook.payload.parties.map((p) => [p.party, p.net]),
    [
      ["sponsor", -10630],
      ["creator", 10098.5],
      ["platform", 531.5],
      ["referrer", 0],
    ],
  );
  assert.match(webhook.signature, /^sha256=[0-9a-f]{64}$/);
  // The demo's own receiver-side check passes, and an independent
  // re-verification over the raw body bytes agrees.
  assert.equal(webhookVerified, true);
  assert.ok(
    verifySettlementWebhook(
      JSON.stringify(webhook.payload),
      webhook.signature,
      DEMO_WEBHOOK_SECRET,
    ),
  );
  // Tampering with a signed field (deposit) breaks verification.
  const tampered = { ...webhook.payload, deposit: 1 };
  assert.equal(
    verifySettlementWebhook(
      JSON.stringify(tampered),
      webhook.signature,
      DEMO_WEBHOOK_SECRET,
    ),
    false,
  );
});

test("demo lines print the webhook build + verify section", () => {
  const { lines } = runDemo();
  const text = lines.join("\n");

  assert.match(
    text,
    /Settlement webhook \(signed escrow\.settled notification\):/,
  );
  assert.ok(text.includes(`  eventId:      ${DEMO_WEBHOOK_EVENT_ID}`));
  assert.ok(text.includes("  outcome:      released"));
  assert.ok(text.includes("  releasePath:  VERIFY_PASS → RELEASE"));
  assert.ok(text.includes("  deposit:      10630"));
  assert.ok(text.includes(`  at:           ${DEMO_WEBHOOK_AT}`));
  assert.match(text, / {2}signature: {4}sha256=[0-9a-f]{64}/);
  assert.ok(text.includes("  verifySettlementWebhook: ok"));
});

test("demo dispute branch reaches DISPUTED, is refused below quorum, then refunds at quorum", () => {
  const { disputeEscrow, disputeQuorum, arbitrationRejection } = runDemo();

  assert.equal(disputeEscrow.id, DEMO_DISPUTE_ESCROW_ID);
  assert.equal(disputeEscrow.state, "REFUNDED");
  assert.equal(disputeEscrow.isTerminal, true);
  // FUND -> SUBMIT_MILESTONE -> VERIFY_FAIL -> ARBITRATE_REFUND: exactly
  // 4 entries — the refused below-threshold attempt left no trace.
  assert.equal(disputeEscrow.history.length, 4);
  assert.deepEqual(
    disputeEscrow.history.map((h) => [h.event, h.from, h.to]),
    [
      ["FUND", "CREATED", "FUNDED"],
      ["SUBMIT_MILESTONE", "FUNDED", "MILESTONE_SUBMITTED"],
      ["VERIFY_FAIL", "MILESTONE_SUBMITTED", "DISPUTED"],
      ["ARBITRATE_REFUND", "DISPUTED", "REFUNDED"],
    ],
  );
  assert.equal(
    arbitrationRejection,
    `arbitration requires quorum: 1/${DEMO_QUORUM_THRESHOLD} approvals`,
  );
  // The arbitration entry carries the forwarded fixed actor + timestamp
  // and the auto-recorded quorum tally.
  const last = disputeEscrow.history[disputeEscrow.history.length - 1];
  assert.equal(last.actor, DEMO_QUORUM_SIGNERS[1]);
  assert.equal(last.at, DEMO_ARBITRATION_AT);
  assert.equal(
    last.note,
    `Dispute upheld — refund the sponsor [quorum ${DEMO_QUORUM_THRESHOLD}/${DEMO_QUORUM_THRESHOLD}]`,
  );
  // Quorum: 2-of-3 reached, approval log on the fixed injected clock.
  assert.equal(disputeQuorum.threshold, DEMO_QUORUM_THRESHOLD);
  assert.equal(disputeQuorum.signerCount, DEMO_QUORUM_SIGNERS.length);
  assert.equal(disputeQuorum.approvalCount(), 2);
  assert.equal(disputeQuorum.hasQuorum(), true);
  assert.deepEqual(disputeQuorum.approvalLog(), [
    { signerId: DEMO_QUORUM_SIGNERS[0], at: DEMO_QUORUM_APPROVAL_ATS[0] },
    { signerId: DEMO_QUORUM_SIGNERS[1], at: DEMO_QUORUM_APPROVAL_ATS[1] },
  ]);
});

test("demo dispute refund report returns the full deposit to the sponsor", () => {
  const { disputeReport } = runDemo();

  assert.equal(disputeReport.escrowId, DEMO_DISPUTE_ESCROW_ID);
  assert.equal(disputeReport.outcome, "refunded");
  assert.ok(disputeReport.balanced);
  assert.equal(disputeReport.totalInflow, 10630);
  assert.equal(disputeReport.totalOutflow, 10630);
  const byParty = Object.fromEntries(
    disputeReport.parties.map((p) => [p.party, p.net]),
  );
  assert.deepEqual(byParty, { sponsor: 0, creator: 0, platform: 0, referrer: 0 });
});

test("demo lines print the dispute / quorum / refund branch", () => {
  const { lines } = runDemo();
  const text = lines.join("\n");

  assert.match(text, /Dispute branch \(DISPUTE -> quorum arbitration -> refund\):/);
  assert.ok(text.includes(`Escrow ${DEMO_DISPUTE_ESCROW_ID}: CREATED`));
  assert.ok(text.includes("same M-of-N rule"));
  assert.match(text, /VERIFY_FAIL +MILESTONE_SUBMITTED +-> DISPUTED/);
  assert.ok(
    text.includes(
      `  approve ${DEMO_QUORUM_SIGNERS[0]}        quorum 1/${DEMO_QUORUM_THRESHOLD} — hasQuorum: false`,
    ),
  );
  assert.ok(
    text.includes(
      '  dispatchArbitration("refund") rejected: arbitration requires quorum: 1/2 approvals — escrow unchanged at DISPUTED (history 3 -> 3 entries)',
    ),
  );
  assert.ok(
    text.includes(
      `  approve ${DEMO_QUORUM_SIGNERS[1]}        quorum 2/${DEMO_QUORUM_THRESHOLD} — hasQuorum: true`,
    ),
  );
  assert.match(text, /ARBITRATE_REFUND +DISPUTED +-> REFUNDED/);
  assert.match(text, /Final state: REFUNDED \(terminal: true\)/);
  assert.match(text, /Settlement report \(dispute refund\):/);
  assert.ok(text.includes(`Outcome: refunded`));
});

test("demo is deterministic: two runs produce identical lines", () => {
  assert.deepEqual(runDemo().lines, runDemo().lines);
});

test("compiled demo script exits 0 and prints the chain, history, report, and webhook", () => {
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
  // Audit trails: 4 numbered history entries for the main escrow plus
  // 4 for the dispute escrow (FUND/SUBMIT/VERIFY_FAIL/ARBITRATE_REFUND)
  const seqRows = out.match(/^\s+\d+  /gm) ?? [];
  assert.equal(seqRows.length, 8);
  // Dispute branch tail: below-quorum refusal, then REFUNDED refund
  assert.match(out, /Dispute branch \(DISPUTE -> quorum arbitration -> refund\):/);
  assert.match(out, /Escrow DEMO-ESC-002: CREATED/);
  assert.match(
    out,
    /dispatchArbitration\("refund"\) rejected: arbitration requires quorum: 1\/2 approvals/,
  );
  assert.match(out, /Final state: REFUNDED \(terminal: true\)/);
  assert.match(out, /Settlement report \(dispute refund\):/);
  // Settlement report tail: balanced totals on the golden deposit
  assert.match(out, /Totals: inflow \$10,630\.00 = outflow \$10,630\.00 — balanced ✓/);
  // Settlement webhook tail: signed notification built + verified
  assert.match(
    out,
    /Settlement webhook \(signed escrow\.settled notification\):/,
  );
  assert.ok(out.includes(`  eventId:      ${DEMO_WEBHOOK_EVENT_ID}`));
  assert.match(out, / {2}signature: {4}sha256=[0-9a-f]{64}/);
  assert.match(out, /verifySettlementWebhook: ok/);
});
