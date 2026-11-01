import test from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  Escrow,
  buildSettlementReport,
  calculateDeposit,
  deliverSettlementWebhookToMany,
  verifySettlementWebhook,
  SettlementEventDedupe,
} from "../src/index.js";
import type { SettlementReport } from "../src/index.js";

/**
 * Settlement webhook top-up event x ToMany fan-out (backlog #788).
 *
 * The single-endpoint top-up suite (`webhookTopup.test.ts`) pins that a
 * top-up's summed deposit (10000 + 630) reaches the payload, and the
 * fan-out suites pin multi-endpoint delivery — but neither covers the
 * combination: a top-up settlement event fanned out to several
 * endpoints at once. Rules under test, with one independent
 * `SettlementEventDedupe` per endpoint and the documented receiver
 * order (verify the raw wire body first, `checkAndRecord` only after
 * a `true` verification):
 *  - one top-up event fanned out to 4 endpoints: every endpoint
 *    receives the same logical event (one shared eventId) carrying
 *    the summed deposit 10630, and each copy verifies with that
 *    endpoint's own secret only
 *  - one endpoint 500s its first attempt, then succeeds on retry:
 *    it reports attempts 2 while the other three report attempts 1,
 *    so a transient failure on one receiver never disturbs the rest
 *  - re-presenting each recorded wire body to its own endpoint's
 *    receiver reports duplicate on all four receivers, with the
 *    per-endpoint dedupe at size 1
 */

const SECRET_A = "whsec_topup_fanout_accounting";
const SECRET_B = "whsec_topup_fanout_notify";
const SECRET_C = "whsec_topup_fanout_ledger";
const SECRET_D = "whsec_topup_fanout_audit";
const SECRETS = [SECRET_A, SECRET_B, SECRET_C, SECRET_D];
const FIXED_NOW = "2026-10-28T13:30:00.000Z";

/** CREATED → FUNDED(10000) → FUNDED(+630 top-up) → RELEASED. */
function topupReport(): SettlementReport {
  const escrow = new Escrow("esc-topup-fanout");
  escrow.dispatch("FUND", undefined, 10000);
  escrow.dispatch("FUND", undefined, 630); // top-up self-loop (#43)
  escrow.dispatch("SUBMIT_MILESTONE");
  escrow.dispatch("VERIFY_PASS");
  escrow.dispatch("RELEASE");
  assert.equal(escrow.state, "RELEASED");
  return buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: calculateDeposit({
      creatorPool: 10000,
      baseFee: 600,
      complexityMultiplier: 1.0,
      loyaltyDiscount: 30,
      oracleFee: 60,
    }),
    settlement: { proFeeBps: 500 },
  });
}

interface ReceivedRequest {
  body: string;
  signature: string;
}

interface TestServer {
  url: string;
  received: ReceivedRequest[];
  close: () => Promise<void>;
}

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse, received: ReceivedRequest[]) => void,
): Promise<TestServer> {
  const received: ReceivedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        body: Buffer.concat(chunks).toString("utf8"),
        signature: String(req.headers["x-signature"] ?? ""),
      });
      handler(req, res, received);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/webhook`,
    received,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const ok200 = (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
};

/** 500 on the first attempt, 200 afterwards (transient failure). */
const failOnceThenOk = (_req: IncomingMessage, res: ServerResponse, received: ReceivedRequest[]) => {
  if (received.length < 2) {
    res.writeHead(500);
    res.end("boom");
  } else {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  }
};

type ReceiveOutcome = "processed" | "duplicate" | "rejected";

/**
 * The documented receiver order: verify the raw wire body first; only
 * a verified delivery reaches `checkAndRecord`. A rejected delivery
 * never touches the dedupe store.
 */
function receive(
  raw: string,
  signature: string,
  dedupe: SettlementEventDedupe,
  secret: string,
): ReceiveOutcome {
  if (!verifySettlementWebhook(raw, signature, secret)) return "rejected";
  const { eventId } = JSON.parse(raw) as { eventId: string };
  return dedupe.checkAndRecord(eventId) ? "duplicate" : "processed";
}

async function fanOutTopup(eventId: string): Promise<TestServer[]> {
  const servers = [
    await startServer(ok200),
    await startServer(ok200),
    await startServer(failOnceThenOk),
    await startServer(ok200),
  ];
  try {
    const out = await deliverSettlementWebhookToMany(
      topupReport(),
      servers.map((s, i) => ({ url: s.url, secret: SECRETS[i] })),
      { allowInsecureHttp: true, backoffMs: 1, now: FIXED_NOW, eventId },
    );
    assert.equal(out.delivered, 4);
    assert.equal(out.failed, 0);
    // The retrying endpoint needed a second attempt; the rest, one.
    assert.deepEqual(
      out.results.map((r) => r.attempts),
      [1, 1, 2, 1],
    );
    assert.ok(out.results.every((r) => r.ok && r.status === 200));
    return servers;
  } catch (err) {
    for (const s of servers) await s.close();
    throw err;
  }
}

async function closeAll(servers: TestServer[]): Promise<void> {
  for (const s of servers) await s.close();
}

/** The last (accepted) wire copy per endpoint: retries re-POST a new body. */
function lastCopies(servers: TestServer[]): ReceivedRequest[] {
  return servers.map((s) => s.received[s.received.length - 1]);
}

test("top-up event fanned out to 4 endpoints: same event, summed deposit, per-endpoint signatures", async () => {
  const servers = await fanOutTopup("evt-topup-fanout-1");
  try {
    const copies = lastCopies(servers);
    for (let i = 0; i < 4; i++) {
      const payload = JSON.parse(copies[i].body) as {
        eventId: string;
        deposit: number;
      };
      assert.equal(payload.eventId, "evt-topup-fanout-1");
      // The top-up sum, not the first FUND (10000) nor the last (630).
      assert.equal(payload.deposit, 10630);
      assert.equal(
        verifySettlementWebhook(copies[i].body, copies[i].signature, SECRETS[i]),
        true,
      );
      // Each copy is signed with its own endpoint's secret only.
      for (let j = 0; j < 4; j++) {
        if (j !== i) {
          assert.equal(
            verifySettlementWebhook(copies[i].body, copies[i].signature, SECRETS[j]),
            false,
          );
        }
      }
    }
    // Only the transiently failing endpoint saw a second request.
    assert.deepEqual(
      servers.map((s) => s.received.length),
      [1, 1, 2, 1],
    );
  } finally {
    await closeAll(servers);
  }
});

test("re-delivery of the same top-up eventId is a duplicate on all four receivers", async () => {
  const servers = await fanOutTopup("evt-topup-fanout-2");
  try {
    const copies = lastCopies(servers);
    const dedupes = SECRETS.map(() => new SettlementEventDedupe());
    for (let i = 0; i < 4; i++) {
      assert.equal(
        receive(copies[i].body, copies[i].signature, dedupes[i], SECRETS[i]),
        "processed",
      );
      assert.equal(
        receive(copies[i].body, copies[i].signature, dedupes[i], SECRETS[i]),
        "duplicate",
      );
      assert.deepEqual(dedupes[i].stats(), {
        size: 1,
        hits: 1,
        misses: 1,
        evictions: 0,
      });
    }
  } finally {
    await closeAll(servers);
  }
});
