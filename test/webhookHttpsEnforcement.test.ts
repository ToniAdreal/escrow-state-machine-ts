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
} from "../src/index.js";
import type { SettlementReport, SettlementWebhook } from "../src/index.js";

/**
 * HTTPS-by-default transport gate (backlog #551).
 *
 * Rules under test:
 *  - an `http:` endpoint URL is refused BEFORE any request is made, with
 *    the exact `refusing to POST over plaintext http` message
 *  - `allowInsecureHttp: true` opts out explicitly (per call, or per
 *    fan-out endpoint); `https:` URLs are never gated by the flag
 *  - check order: URL parse -> protocol whitelist -> https gate
 *  - non-boolean `allowInsecureHttp` is a config error
 *  - every test uses local 127.0.0.1 servers: no external network
 */

const SECRET = "whsec_https_gate_20261024";
const REFUSAL =
  "cannot deliver settlement webhook: refusing to POST over plaintext http (pass allowInsecureHttp: true to opt out)";

function goldenReport(): SettlementReport {
  const escrow = new Escrow("esc-https-gate");
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

function goldenWebhook(): SettlementWebhook {
  return buildSettlementWebhook(goldenReport(), { secret: SECRET });
}

interface TestServer {
  url: string;
  received: number;
  close: () => Promise<void>;
}

async function startServer(status = 200): Promise<TestServer> {
  let received = 0;
  const server: Server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    received += 1;
    res.writeHead(status, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/webhook`,
    get received() {
      return received;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("http URL is refused by default with the exact message and zero HTTP attempts", async () => {
  const server = await startServer();
  try {
    let caught: unknown = null;
    try {
      await deliverSettlementWebhook(server.url, goldenWebhook(), {
        retries: 0,
        backoffMs: 0,
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof Error, "expected the delivery to reject");
    assert.equal(caught.message, REFUSAL);
    assert.equal(server.received, 0, "the refusal must happen before any request");
  } finally {
    await server.close();
  }
});

test("opt-in http delivers normally", async () => {
  const server = await startServer();
  try {
    const result = await deliverSettlementWebhook(server.url, goldenWebhook(), {
      allowInsecureHttp: true,
      retries: 0,
      backoffMs: 0,
    });
    assert.deepEqual(result, { status: 200, attempts: 1 });
    assert.equal(server.received, 1);
  } finally {
    await server.close();
  }
});

test("https URLs are not gated by the flag", async () => {
  // Nothing listens on port 1: the refusal must NOT fire; the delivery
  // must die on the network error instead, proving https passes the gate.
  let caught: unknown = null;
  try {
    await deliverSettlementWebhook("https://127.0.0.1:1/webhook", goldenWebhook(), {
      retries: 0,
      backoffMs: 0,
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error, "expected the delivery to reject");
  assert.match(caught.message, /failed after 1 attempt/);
  assert.ok(
    !caught.message.includes("refusing to POST over plaintext http"),
    "https must not hit the plaintext refusal",
  );
});

test("invalid URL fails on parse, before the https gate", async () => {
  await assert.rejects(
    () => deliverSettlementWebhook("not a url", goldenWebhook()),
    /cannot deliver settlement webhook: invalid url/,
  );
});

test("unsupported protocol fails on the protocol check, before the https gate", async () => {
  await assert.rejects(
    () =>
      deliverSettlementWebhook("ftp://example.com/hook", goldenWebhook(), {
        allowInsecureHttp: true,
      }),
    /cannot deliver settlement webhook: unsupported protocol/,
  );
});

test("non-boolean allowInsecureHttp is a config error", async () => {
  const server = await startServer();
  try {
    await assert.rejects(
      () =>
        deliverSettlementWebhook(server.url, goldenWebhook(), {
          allowInsecureHttp: "yes" as unknown as boolean,
        }),
      /cannot deliver settlement webhook: allowInsecureHttp must be a boolean, got yes/,
    );
    assert.equal(server.received, 0, "config errors fire before any request");
  } finally {
    await server.close();
  }
});

test("ToMany: per-endpoint opt-in delivers while the sibling without it is refused", async () => {
  const refused = await startServer();
  const allowed = await startServer();
  try {
    const out = await deliverSettlementWebhookToMany(
      goldenReport(),
      [
        { url: refused.url, secret: SECRET },
        { url: allowed.url, secret: SECRET, allowInsecureHttp: true },
      ],
      { backoffMs: 1, now: "2026-10-24T13:00:00.000Z", eventId: "evt-https-gate-1" },
    );
    assert.equal(out.delivered, 1);
    assert.equal(out.failed, 1);
    assert.equal(out.results[0].ok, false);
    assert.equal(out.results[0].attempts, 0);
    assert.equal(out.results[0].error, REFUSAL);
    assert.equal(out.results[1].ok, true);
    assert.equal(out.results[1].attempts, 1);
    assert.equal(refused.received, 0, "refused endpoint made zero requests");
    assert.equal(allowed.received, 1);
  } finally {
    await refused.close();
    await allowed.close();
  }
});

test("ToMany: endpoint-level false overrides call-level true", async () => {
  const server = await startServer();
  try {
    const out = await deliverSettlementWebhookToMany(
      goldenReport(),
      [{ url: server.url, secret: SECRET, allowInsecureHttp: false }],
      {
        backoffMs: 1,
        allowInsecureHttp: true,
        now: "2026-10-24T13:00:00.000Z",
        eventId: "evt-https-gate-2",
      },
    );
    assert.equal(out.delivered, 0);
    assert.equal(out.failed, 1);
    assert.equal(out.results[0].ok, false);
    assert.equal(out.results[0].error, REFUSAL);
    assert.equal(server.received, 0);
  } finally {
    await server.close();
  }
});
