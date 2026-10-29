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
} from "../src/index.js";
import type { SettlementReport } from "../src/index.js";

/**
 * Settlement webhook fan-out x jittered backoff combination (backlog #693).
 *
 * Fan-out (webhookFanout.test.ts) and jittered backoff
 * (webhookDeliveryJitter.test.ts) each have dedicated coverage, but the
 * combination was untested: when several endpoints are fanned out at
 * once, is each endpoint's jittered wait independent, does jitter
 * change anything but the wait, and does a retrying endpoint block a
 * healthy one?
 *
 * Rules under test:
 *  - a jittered endpoint that answers 500, 500, 200 waits twice, each
 *    wait inside its own [backoff, backoff + jitterMs] window
 *    (backoff doubles per retry: 100ms, then 200ms, with jitterMs 200
 *    and Math.random pinned to 0.5 the waits are ~200ms and ~300ms)
 *  - retry budgets are counted per endpoint: the jittered endpoint
 *    reports 3 attempts while the healthy endpoint reports 1
 *  - the healthy endpoint is not blocked by the retrying one: its
 *    single request arrives before the jittered endpoint's final
 *    attempt, and the aggregate result stays in input order
 *  - jitter changes only the wait: every attempt's body is
 *    byte-identical across endpoints, carries the same fixed eventId
 *    and at, and verifies under its own endpoint's secret only
 *  - a zero-jitter control fan-out of the same logical event produces
 *    byte-identical bodies, proving jitter adds no payload bytes
 *  - every test uses local 127.0.0.1 servers: no external network
 */

const SECRET_A = "whsec_fanout_jitter_accounting_20261029";
const SECRET_B = "whsec_fanout_jitter_notify_20261029";
const FIXED_NOW = "2026-10-29T09:00:00.000Z";
const EVENT_ID = "evt-fanout-jitter-1";

function goldenReport(): SettlementReport {
  const escrow = new Escrow("esc-fanout-jitter");
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

interface ReceivedRequest {
  atMs: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface TestServer {
  url: string;
  received: ReceivedRequest[];
  close: () => Promise<void>;
}

async function startServer(
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    received: ReceivedRequest[],
  ) => void,
): Promise<TestServer> {
  const received: ReceivedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        atMs: Date.now(),
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
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

/** Run `run` with `Math.random` pinned to a fixed value, then restore it. */
async function withRandom<T>(value: number, run: () => Promise<T>): Promise<T> {
  const original = Math.random;
  Math.random = () => value;
  try {
    return await run();
  } finally {
    Math.random = original;
  }
}

test("fan-out with jitter: per-endpoint waits, independent attempts, healthy endpoint not blocked", async () => {
  const jittered = await startServer((_req, res, received) => {
    if (received.length < 3) {
      res.writeHead(500);
      res.end("boom");
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    }
  });
  const healthy = await startServer(ok200);
  try {
    const out = await withRandom(0.5, () =>
      deliverSettlementWebhookToMany(
        goldenReport(),
        [
          { url: jittered.url, secret: SECRET_A },
          { url: healthy.url, secret: SECRET_B },
        ],
        {
          allowInsecureHttp: true,
          retries: 2,
          backoffMs: 100,
          jitterMs: 200,
          now: FIXED_NOW,
          eventId: EVENT_ID,
        },
      ),
    );
    assert.equal(out.delivered, 2);
    assert.equal(out.failed, 0);
    assert.deepEqual(out.results, [
      { url: jittered.url, ok: true, attempts: 3, status: 200 },
      { url: healthy.url, ok: true, attempts: 1, status: 200 },
    ]);
    assert.equal(jittered.received.length, 3, "500, 500, then 200");
    assert.equal(healthy.received.length, 1, "healthy endpoint was not retried");

    // Per-endpoint waits, measured from the jittered endpoint's own
    // arrival timestamps (not wall-clock total, so the healthy
    // endpoint's timing cannot leak into them). With Math.random
    // pinned to 0.5 the waits are ~200ms (100 + 0.5*200) and ~300ms
    // (200 + 0.5*200). Lower bounds prove jitter was actually added
    // (plain backoff alone would be 100ms / 200ms); upper bounds carry
    // the repo's usual +3000ms host-scheduling slack.
    const [first, second, third] = jittered.received;
    const wait1 = second.atMs - first.atMs;
    const wait2 = third.atMs - second.atMs;
    assert.ok(
      wait1 >= 150 && wait1 <= 300 + 3000,
      `first jittered wait ${wait1}ms should be in [100, 300] + slack`,
    );
    assert.ok(
      wait2 >= 250 && wait2 <= 400 + 3000,
      `second jittered wait ${wait2}ms should be in [200, 400] + slack`,
    );

    // The healthy endpoint was not blocked behind the retries: its
    // only request arrived before the jittered endpoint's final
    // attempt even finished being scheduled.
    assert.ok(
      healthy.received[0].atMs < third.atMs,
      "healthy request must arrive before the jittered endpoint's third attempt",
    );

    // Jitter changes only the wait: every attempt's body is
    // byte-identical, carries the shared eventId/at, and verifies
    // under its own endpoint's secret only.
    const [bodyA] = jittered.received.map((r) => r.body);
    for (const req of jittered.received) {
      assert.equal(req.body, bodyA, "retries resend the same body");
    }
    assert.equal(healthy.received[0].body, bodyA, "fan-out shares one body");
    assert.equal(JSON.parse(bodyA).eventId, EVENT_ID);
    assert.equal(JSON.parse(bodyA).at, FIXED_NOW);
    for (const req of jittered.received) {
      assert.ok(
        verifySettlementWebhook(req.body, String(req.headers["x-signature"]), SECRET_A),
      );
      assert.equal(
        verifySettlementWebhook(req.body, String(req.headers["x-signature"]), SECRET_B),
        false,
        "A's signature must not verify under B's secret",
      );
    }
    assert.ok(
      verifySettlementWebhook(
        healthy.received[0].body,
        String(healthy.received[0].headers["x-signature"]),
        SECRET_B,
      ),
    );
    assert.equal(
      verifySettlementWebhook(
        healthy.received[0].body,
        String(healthy.received[0].headers["x-signature"]),
        SECRET_A,
      ),
      false,
      "B's signature must not verify under A's secret",
    );
  } finally {
    await jittered.close();
    await healthy.close();
  }
});

test("jitter adds no payload bytes: jittered and zero-jitter fan-outs share identical bodies", async () => {
  const a = await startServer(ok200);
  const b = await startServer(ok200);
  try {
    const jittered = await withRandom(0.5, () =>
      deliverSettlementWebhookToMany(
        goldenReport(),
        [
          { url: a.url, secret: SECRET_A },
          { url: b.url, secret: SECRET_B },
        ],
        {
          allowInsecureHttp: true,
          retries: 0,
          backoffMs: 100,
          jitterMs: 200,
          now: FIXED_NOW,
          eventId: EVENT_ID,
        },
      ),
    );
    const plain = await deliverSettlementWebhookToMany(
      goldenReport(),
      [
        { url: a.url, secret: SECRET_A },
        { url: b.url, secret: SECRET_B },
      ],
      {
        allowInsecureHttp: true,
        retries: 0,
        backoffMs: 100,
        jitterMs: 0,
        now: FIXED_NOW,
        eventId: EVENT_ID,
      },
    );
    assert.equal(jittered.delivered, 2);
    assert.equal(plain.delivered, 2);
    // Two requests per endpoint (one per run), in run order.
    assert.equal(a.received.length, 2);
    assert.equal(b.received.length, 2);
    assert.equal(
      a.received[0].body,
      a.received[1].body,
      "jittered vs plain body to the same endpoint must be identical",
    );
    assert.equal(
      b.received[0].body,
      b.received[1].body,
      "jittered vs plain body to the same endpoint must be identical",
    );
    assert.equal(a.received[0].body, b.received[0].body, "fan-out shares one body");
    // Same body + same secret => same signature in both runs.
    assert.equal(
      a.received[0].headers["x-signature"],
      a.received[1].headers["x-signature"],
    );
    assert.equal(
      b.received[0].headers["x-signature"],
      b.received[1].headers["x-signature"],
    );
  } finally {
    await a.close();
    await b.close();
  }
});
