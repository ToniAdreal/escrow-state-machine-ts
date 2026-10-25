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
  buildSettlementWebhook,
  calculateDeposit,
  deliverSettlementWebhook,
  deliverSettlementWebhookToMany,
  verifySettlementWebhook,
} from "../src/index.js";
import type { SettlementWebhook } from "../src/index.js";

const SECRET = "whsec_test_idempotency_key_header_20261025";
const FIXED_NOW = "2026-10-25T10:00:00.000Z";

function goldenReport() {
  const escrow = new Escrow("esc-idempotency-key");
  escrow.dispatch("FUND");
  escrow.dispatch("SUBMIT_MILESTONE");
  escrow.dispatch("VERIFY_PASS");
  escrow.dispatch("RELEASE");
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

function goldenWebhook(eventId: string): SettlementWebhook {
  return buildSettlementWebhook(goldenReport(), {
    secret: SECRET,
    now: FIXED_NOW,
    eventId,
  });
}

interface ReceivedRequest {
  path: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

async function withServer(
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    received: ReceivedRequest[],
  ) => void,
  run: (baseUrl: string, received: ReceivedRequest[]) => Promise<void>,
): Promise<void> {
  const received: ReceivedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        path: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      handler(req, res, received);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`, received);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function ok(res: ServerResponse): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
}

test("single delivery: Idempotency-Key header equals the body eventId", async () => {
  const signed = goldenWebhook("evt-576-single");
  await withServer(
    (_req, res) => ok(res),
    async (baseUrl, received) => {
      const result = await deliverSettlementWebhook(
        `${baseUrl}/webhook`,
        signed,
        { allowInsecureHttp: true },
      );
      assert.deepEqual(result, { status: 200, attempts: 1 });
      assert.equal(received.length, 1);
      const [req] = received;
      assert.equal(req.headers["idempotency-key"], "evt-576-single");
      assert.equal(req.headers["x-event-id"], "evt-576-single");
      const body = JSON.parse(req.body) as { eventId: string };
      assert.equal(body.eventId, "evt-576-single");
      assert.equal(req.headers["idempotency-key"], body.eventId);
    },
  );
});

test("retries: every attempt carries the same Idempotency-Key", async () => {
  const signed = goldenWebhook("evt-576-retry");
  await withServer(
    (_req, res, received) => {
      if (received.length < 3) {
        res.writeHead(500);
        res.end("boom");
      } else {
        ok(res);
      }
    },
    async (baseUrl, received) => {
      const result = await deliverSettlementWebhook(
        `${baseUrl}/webhook`,
        signed,
        { allowInsecureHttp: true, retries: 3, backoffMs: 5, timeoutMs: 5000 },
      );
      assert.deepEqual(result, { status: 200, attempts: 3 });
      assert.equal(received.length, 3);
      for (const req of received) {
        assert.equal(req.headers["idempotency-key"], "evt-576-retry");
        assert.equal(req.headers["idempotency-key"], req.headers["x-event-id"]);
      }
    },
  );
});

test("re-delivery of the same webhook reuses the same Idempotency-Key", async () => {
  const signed = goldenWebhook("evt-576-redeliver");
  await withServer(
    (_req, res) => ok(res),
    async (baseUrl, received) => {
      await deliverSettlementWebhook(`${baseUrl}/a`, signed, {
        allowInsecureHttp: true,
      });
      await deliverSettlementWebhook(`${baseUrl}/b`, signed, {
        allowInsecureHttp: true,
      });
      assert.equal(received.length, 2);
      for (const req of received) {
        assert.equal(req.headers["idempotency-key"], "evt-576-redeliver");
      }
    },
  );
});

test("fan-out: every endpoint gets the shared logical event's Idempotency-Key", async () => {
  const report = goldenReport();
  await withServer(
    (_req, res) => ok(res),
    async (baseUrl, received) => {
      const out = await deliverSettlementWebhookToMany(
        report,
        [
          { url: `${baseUrl}/ledger`, secret: SECRET },
          { url: `${baseUrl}/notify`, secret: "whsec_test_idempotency_notify_20261025" },
        ],
        { allowInsecureHttp: true, eventId: "evt-576-shared", now: FIXED_NOW },
      );
      assert.equal(out.delivered, 2);
      assert.equal(out.failed, 0);
      assert.equal(received.length, 2);
      // One logical settlement event fanned out: the header is the SAME
      // shared eventId on both endpoints, not a per-endpoint value.
      const byPath = new Map(received.map((r) => [r.path, r]));
      for (const path of ["/ledger", "/notify"]) {
        const req = byPath.get(path);
        assert.ok(req, `missing request to ${path}`);
        assert.equal(req.headers["idempotency-key"], "evt-576-shared");
        const body = JSON.parse(req.body) as { eventId: string };
        assert.equal(body.eventId, "evt-576-shared");
      }
    },
  );
});

test("distinct deliveries carry distinct Idempotency-Key values", async () => {
  const first = goldenWebhook("evt-576-first");
  const second = goldenWebhook("evt-576-second");
  await withServer(
    (_req, res) => ok(res),
    async (baseUrl, received) => {
      await deliverSettlementWebhook(`${baseUrl}/a`, first, {
        allowInsecureHttp: true,
      });
      await deliverSettlementWebhook(`${baseUrl}/b`, second, {
        allowInsecureHttp: true,
      });
      assert.equal(received.length, 2);
      assert.equal(received[0].headers["idempotency-key"], "evt-576-first");
      assert.equal(received[1].headers["idempotency-key"], "evt-576-second");
    },
  );
});

test("header is a transport hint only: body verification ignores the header", async () => {
  const signed = goldenWebhook("evt-576-hint");
  await withServer(
    (_req, res) => ok(res),
    async (baseUrl, received) => {
      await deliverSettlementWebhook(`${baseUrl}/webhook`, signed, {
        allowInsecureHttp: true,
      });
      assert.equal(received.length, 1);
      const [req] = received;
      // The signature covers the body alone: verification over the raw
      // body + signature succeeds regardless of the header value, so a
      // receiver must never trust the header over the verified body.
      assert.ok(
        verifySettlementWebhook(
          req.body,
          String(req.headers["x-signature"]),
          SECRET,
        ),
      );
      const body = JSON.parse(req.body) as { eventId: string };
      assert.equal(body.eventId, "evt-576-hint");
      assert.equal(req.headers["idempotency-key"], body.eventId);
    },
  );
});

test("fan-out: a failing endpoint does not block the other's Idempotency-Key", async () => {
  const report = goldenReport();
  await withServer(
    (req, res) => {
      if (req.url === "/broken") {
        res.writeHead(500);
        res.end("boom");
      } else {
        ok(res);
      }
    },
    async (baseUrl, received) => {
      const out = await deliverSettlementWebhookToMany(
        report,
        [
          { url: `${baseUrl}/broken`, secret: SECRET },
          { url: `${baseUrl}/ledger`, secret: SECRET },
        ],
        {
          allowInsecureHttp: true,
          eventId: "evt-576-partial",
          now: FIXED_NOW,
          retries: 0,
          backoffMs: 1,
        },
      );
      assert.equal(out.delivered, 1);
      assert.equal(out.failed, 1);
      const ledger = received.filter((r) => r.path === "/ledger");
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0].headers["idempotency-key"], "evt-576-partial");
      const broken = received.filter((r) => r.path === "/broken");
      assert.equal(broken.length, 1);
      assert.equal(broken[0].headers["idempotency-key"], "evt-576-partial");
    },
  );
});

test("fan-out with a custom eventId: header tracks the custom eventId", async () => {
  const report = goldenReport();
  await withServer(
    (_req, res) => ok(res),
    async (baseUrl, received) => {
      const out = await deliverSettlementWebhookToMany(
        report,
        [{ url: `${baseUrl}/ledger`, secret: SECRET }],
        { allowInsecureHttp: true, eventId: "evt-576-custom", now: FIXED_NOW },
      );
      assert.equal(out.delivered, 1);
      assert.equal(received.length, 1);
      assert.equal(received[0].headers["idempotency-key"], "evt-576-custom");
      assert.equal(received[0].headers["x-event-id"], "evt-576-custom");
    },
  );
});
