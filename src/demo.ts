/**
 * Demo: drive one escrow through the full happy path
 * CREATED -> FUNDED -> MILESTONE_SUBMITTED -> VERIFIED -> RELEASED,
 * print the append-only audit history plus the final settlement report,
 * then build the signed settlement webhook for the released escrow and
 * verify it the way a receiver would.
 *
 * Usage: `npm run demo` (builds with tsc, then runs node on the compiled
 * output). Zero runtime dependencies: this file only imports the library
 * itself.
 *
 * Everything is deterministic: the escrow id, fee inputs, actors, notes,
 * evidence reference, and every dispatch timestamp are fixed constants
 * below — no wall clock, no randomness, no network. Two runs print
 * byte-identical output.
 */

import { fileURLToPath } from "node:url";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementWebhook,
  calculateDeposit,
  renderReport,
  verifySettlementWebhook,
  type EscrowEvent,
  type SettlementReport,
  type SettlementWebhook,
} from "./index.js";

/** Fixed demo fixture: the portfolio golden fee vector (deposit 10,630). */
export const DEMO_ESCROW_ID = "DEMO-ESC-001";
export const DEMO_PRO_FEE_BPS = 500;

/**
 * Signing secret for the demo webhook only — a placeholder printed in
 * the source, NOT a real credential. A real deployment loads its
 * secret from its own credential store and never commits it.
 */
export const DEMO_WEBHOOK_SECRET =
  "whsec_demo_settlement_notifications_not_a_real_secret";
/** Fixed webhook eventId / `at` so the demo signature is deterministic. */
export const DEMO_WEBHOOK_EVENT_ID = "evt_demo_settlement_001";
export const DEMO_WEBHOOK_AT = "2026-03-06T08:17:00.000Z";

const steps: Array<{
  event: EscrowEvent;
  actor: string;
  note: string;
  at: string;
  amount?: number;
  evidence?: string;
}> = [
  {
    event: "FUND",
    actor: "sponsor",
    note: "Deposit locked (wire received)",
    at: "2026-03-01T09:00:00.000Z",
    amount: 10630,
  },
  {
    event: "SUBMIT_MILESTONE",
    actor: "creator",
    note: "Deliverable URLs + IPFS metadata hash",
    at: "2026-03-05T12:30:00.000Z",
  },
  {
    event: "VERIFY_PASS",
    actor: "oracle",
    note: "KPIs validated by oracle",
    at: "2026-03-06T08:15:00.000Z",
    evidence: "demo-oracle-attestation-001",
  },
  {
    event: "RELEASE",
    actor: "system",
    note: "Verification passed — release funds",
    at: "2026-03-06T08:16:00.000Z",
  },
];

export interface DemoResult {
  escrow: Escrow;
  report: SettlementReport;
  webhook: SettlementWebhook;
  webhookVerified: boolean;
  lines: string[];
}

/**
 * Run the demo lifecycle without printing anything, and return the
 * escrow, its settlement report, and the exact lines `main()` prints —
 * so tests can assert on the demo itself, not just on the library.
 */
export function runDemo(): DemoResult {
  const fees = calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });

  const escrow = new Escrow(DEMO_ESCROW_ID);
  const lines: string[] = [
    `Escrow ${escrow.id}: ${escrow.state}`,
    `Deposit preview: ${fees.deposit} (pool ${fees.creatorPool} + base ${fees.baseFee}×${fees.complexityMultiplier} − loyalty ${fees.loyaltyDiscount} + oracle ${fees.oracleFee})`,
    "",
  ];

  for (const { event, actor, note, at, amount, evidence } of steps) {
    const from = escrow.state;
    const to = escrow.dispatch(event, note, amount, { actor, at, evidence });
    lines.push(`  ${event.padEnd(18)} ${from.padEnd(19)} -> ${to}  (${actor})`);
  }

  const report = buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: fees,
    settlement: { proFeeBps: DEMO_PRO_FEE_BPS },
  });

  lines.push("", `Final state: ${escrow.state} (terminal: ${escrow.isTerminal})`);
  lines.push("History (append-only audit trail):");
  lines.push("  seq  event              from                 -> to                   actor        at");
  for (const h of escrow.history) {
    const amount = h.amount !== undefined ? `  amount ${h.amount}` : "";
    lines.push(
      `  ${String(h.seq).padStart(3)}  ${h.event.padEnd(18)} ${h.from.padEnd(20)} -> ${h.to.padEnd(20)} ${String(h.actor ?? "-").padEnd(12)} ${h.at}${amount}`,
    );
  }
  lines.push("", "Settlement report:");
  lines.push(renderReport(report));

  // RELEASE is where settlement webhooks fire: build the signed
  // `escrow.settled` notification from the settlement report (fixed
  // now/eventId, demo-only secret above — see its comment), print what
  // a receiver would get, then verify it with the same secret over the
  // raw body bytes, the transport-safe receiver path.
  const webhook = buildSettlementWebhook(report, {
    secret: DEMO_WEBHOOK_SECRET,
    now: DEMO_WEBHOOK_AT,
    eventId: DEMO_WEBHOOK_EVENT_ID,
  });
  const webhookVerified = verifySettlementWebhook(
    JSON.stringify(webhook.payload),
    webhook.signature,
    DEMO_WEBHOOK_SECRET,
  );
  lines.push("", "Settlement webhook (signed escrow.settled notification):");
  lines.push(`  event:        ${webhook.payload.event}`);
  lines.push(`  eventId:      ${webhook.payload.eventId}`);
  lines.push(`  escrowId:     ${webhook.payload.escrowId}`);
  lines.push(`  outcome:      ${webhook.payload.outcome}`);
  lines.push(`  releasePath:  ${webhook.payload.releasePath ?? "-"}`);
  lines.push(`  deposit:      ${webhook.payload.deposit}`);
  lines.push(
    `  parties:      ${webhook.payload.parties.map((p) => `${p.party} net ${p.net}`).join(", ")}`,
  );
  lines.push(`  at:           ${webhook.payload.at}`);
  lines.push(`  signature:    ${webhook.signature}`);
  lines.push(
    `  verifySettlementWebhook: ${webhookVerified ? "ok" : "FAILED"}`,
  );

  return { escrow, report, webhook, webhookVerified, lines };
}

function main(): void {
  console.log(runDemo().lines.join("\n"));
}

// Run only when executed directly (`node dist/src/demo.js`), not when
// imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
