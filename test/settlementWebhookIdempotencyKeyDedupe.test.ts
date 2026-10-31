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
  verifySettlementWebhook,
  SettlementEventDedupe,
} from "../src/index.js";
import type { SettlementWebhook } from "../src/index.js";

/**
 * Settlement webhook `Idempotency-Key` x `SettlementEventDedupe`
 * (backlog #771, the escrow mirror of dataquest #768).
 *
 * The two single-feature suites never exercised the combination:
 * `webhookIdempotencyKeyHeader.test.ts` pins that every delivery
 * attempt carries `Idempotency-Key: <payload eventId>` on the wire,
 * and `webhookVerifyDedupe.test.ts` pins the receiver-side
 * verify-then-dedupe flow — but nothing pinned that a webhook built
 * twice with the same eventId carries the same header on both
 * deliveries AND that the receiver deduplicates those two deliveries
 * as one event.
 *
 * Rules under test, with the documented receiver order (verify the
 * raw wire body first, `checkAndRecord` only after a `true`
 * verification, dedupe keyed on the verified body's `eventId`):
 *  - the same eventId built twice carries a byte-identical
 *    `Idempotency-Key` header on both deliveries, equal to the body
 *    `eventId`; the receiver accepts the first and reports the
 *    second as a duplicate
 *  - different eventIds carry different headers and are both first
 *    sightings
 *  - a tampered body fails verification, records nothing, and the
 *    true delivery afterwards is still a first sighting
 *  - the header is an unsigned transport hint only: it never drives
 *    the dedupe decision — a redelivery whose presented header was
 *    spoofed is still a duplicate on the verified body eventId, and
 *    a first delivery with a spoofed header is still accepted
 *  - retry attempts carry the same header, so a retried delivery is
 *    a redelivery for dedupe purposes, not a new event
 *  - the dedupe key is the eventId alone: reusing one eventId across
 *    two different escrows still dedupes the second delivery
 *    (reusing an eventId is a caller bug — the batch docs warn
 *    against it — but the receiver must not silently double-book it)
 */

const SECRET = "whsec_test_settlement_idem_dedupe_20261031";
const FIXED_NOW = "2026-10-31T12:00:00.000Z";
const TTL = 60_000;

function goldenReport(escrowId: string) {
  const escrow = new Escrow(escrowId);
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

function goldenWebhook(
  eventId: string,
  escrowId = "esc-idem-dedupe",
): SettlementWebhook {
  return buildSettlementWebhook(goldenReport(escrowId), {
    secret: SECRET,
    now: FIXED_NOW,
    eventId,
  });
}

type ReceiveOutcome = "processed" | "duplicate" | "rejected";

/**
 * The documented receiver order: verify the raw wire body first; only
 * a verified delivery reaches `checkAndRecord`. A rejected delivery
 * never touches the dedupe store.
 */
function receive(
  dedupe: SettlementEventDedupe,
  raw: string,
  signature: string,
): ReceiveOutcome {
  if (!verifySettlementWebhook(raw, signature, SECRET)) return "rejected";
  const { eventId } = JSON.parse(raw) as { eventId: string };
  return dedupe.checkAndRecord(eventId) ? "duplicate" : "processed";
}

/**
 * Same as `receive`, but the presented `Idempotency-Key` header value
 * is passed in explicitly so the test can show it is read and then
 * deliberately NOT used as the dedupe key: the header is unsigned,
 * so a value that disagrees with the verified body is untrusted and
 * must neither create a new entry nor block the body's own dedupe
 * outcome.
 */
function receiveWithPresentedHeader(
  dedupe: SettlementEventDedupe,
  raw: string,
  signature: string,
  presentedIdempotencyKey: string,
): ReceiveOutcome {
  if (!verifySettlementWebhook(raw, signature, SECRET)) return "rejected";
  const { eventId } = JSON.parse(raw) as { eventId: string };
  // The presented header is intentionally not the dedupe key.
  void presentedIdempotencyKey;
  return dedupe.checkAndRecord(eventId) ? "duplicate" : "processed";
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

test("same eventId built twice: byte-identical Idempotency-Key, first processed then duplicate", async () => {
  const first = goldenWebhook("evt-771-idem-1");
  const second = goldenWebhook("evt-771-idem-1");
  // Two builds of the same event are the same signed payload.
  assert.deepEqual(second.payload, first.payload);
  assert.equal(second.signature, first.signature);

  const dedupe = new SettlementEventDedupe({ ttlMs: TTL });
  await withServer(
    (_req, res) => ok(res),
    async (baseUrl, received) => {
      const firstResult = await deliverSettlementWebhook(
        `${baseUrl}/webhook`,
        first,
        { allowInsecureHttp: true },
      );
      const secondResult = await deliverSettlementWebhook(
        `${baseUrl}/webhook`,
        second,
        { allowInsecureHttp: true },
      );
      assert.deepEqual(firstResult, { status: 200, attempts: 1 });
      assert.deepEqual(secondResult, { status: 200, attempts: 1 });
      assert.equal(received.length, 2);
      const [callA, callB] = received;
      // The header is byte-identical across both deliveries and
      // equals the body eventId on each wire copy (X-Event-Id rides
      // alongside with the same value).
      assert.equal(callA.headers["idempotency-key"], "evt-771-idem-1");
      assert.equal(callB.headers["idempotency-key"], "evt-771-idem-1");
      assert.equal(
        callA.headers["idempotency-key"],
        callB.headers["idempotency-key"],
      );
      assert.equal(
        callA.headers["idempotency-key"],
        (JSON.parse(callA.body) as { eventId: string }).eventId,
      );
      assert.equal(
        callB.headers["idempotency-key"],
        (JSON.parse(callB.body) as { eventId: string }).eventId,
      );
      assert.equal(callA.headers["x-event-id"], "evt-771-idem-1");
      assert.equal(callB.headers["x-event-id"], "evt-771-idem-1");

      assert.equal(
        receive(dedupe, callA.body, first.signature),
        "processed",
      );
      assert.equal(
        receive(dedupe, callB.body, second.signature),
        "duplicate",
      );
    },
  );
  assert.deepEqual(dedupe.stats(), {
    size: 1,
    hits: 1,
    misses: 1,
    evictions: 0,
  });
});

test("different eventIds carry different Idempotency-Keys and are both first sightings", async () => {
  const first = goldenWebhook("evt-771-idem-a");
  const second = goldenWebhook("evt-771-idem-b");
  const dedupe = new SettlementEventDedupe({ ttlMs: TTL });
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
      assert.equal(received[0].headers["idempotency-key"], "evt-771-idem-a");
      assert.equal(received[1].headers["idempotency-key"], "evt-771-idem-b");
      assert.notEqual(
        received[0].headers["idempotency-key"],
        received[1].headers["idempotency-key"],
      );
      assert.equal(
        receive(dedupe, received[0].body, first.signature),
        "processed",
      );
      assert.equal(
        receive(dedupe, received[1].body, second.signature),
        "processed",
      );
    },
  );
  assert.deepEqual(dedupe.stats(), {
    size: 2,
    hits: 0,
    misses: 2,
    evictions: 0,
  });
});

test("a tampered body is rejected and never poisons the dedupe store", () => {
  const dedupe = new SettlementEventDedupe({ ttlMs: TTL });
  const signed = goldenWebhook("evt-771-idem-tamper");
  const raw = JSON.stringify(signed.payload);
  const tampered = JSON.parse(raw) as Record<string, unknown>;
  tampered.deposit = 99999; // signature no longer covers the body
  const tamperedRaw = JSON.stringify(tampered);
  assert.equal(verifySettlementWebhook(tamperedRaw, signed.signature, SECRET), false);
  assert.equal(receive(dedupe, tamperedRaw, signed.signature), "rejected");
  assert.equal(dedupe.size, 0);
  // The genuine delivery of the same eventId afterwards is still a
  // first sighting — the forgery did not consume the id.
  assert.equal(receive(dedupe, raw, signed.signature), "processed");
  assert.equal(dedupe.size, 1);
});

test("the presented Idempotency-Key header never drives the dedupe decision", () => {
  const dedupe = new SettlementEventDedupe({ ttlMs: TTL });
  const first = goldenWebhook("evt-771-idem-header-a");
  const second = goldenWebhook("evt-771-idem-header-b");
  const firstRaw = JSON.stringify(first.payload);
  const secondRaw = JSON.stringify(second.payload);
  // A first delivery whose presented header is spoofed is still
  // accepted on its verified body eventId.
  assert.equal(
    receiveWithPresentedHeader(dedupe, firstRaw, first.signature, "evt-spoofed"),
    "processed",
  );
  // The same body presented again, with a different spoofed header,
  // is still a duplicate — the header cannot reset the dedupe key.
  assert.equal(
    receiveWithPresentedHeader(dedupe, firstRaw, first.signature, "evt-other-spoof"),
    "duplicate",
  );
  // A different event whose presented header copies the first
  // event's id is still a first sighting — the header cannot make
  // an unseen body look like a duplicate.
  assert.equal(
    receiveWithPresentedHeader(
      dedupe,
      secondRaw,
      second.signature,
      "evt-771-idem-header-a",
    ),
    "processed",
  );
  assert.deepEqual(dedupe.stats(), {
    size: 2,
    hits: 1,
    misses: 2,
    evictions: 0,
  });
});

test("retries carry the same Idempotency-Key, so a retried delivery is a redelivery", async () => {
  const signed = goldenWebhook("evt-771-idem-retry");
  const dedupe = new SettlementEventDedupe({ ttlMs: TTL });
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
        assert.equal(req.headers["idempotency-key"], "evt-771-idem-retry");
        assert.equal(req.headers["idempotency-key"], req.headers["x-event-id"]);
      }
      // Every retry is the same signed bytes: the receiver processes
      // the first attempt and reports the rest as duplicates.
      assert.equal(receive(dedupe, received[0].body, signed.signature), "processed");
      assert.equal(receive(dedupe, received[1].body, signed.signature), "duplicate");
      assert.equal(receive(dedupe, received[2].body, signed.signature), "duplicate");
    },
  );
  assert.deepEqual(dedupe.stats(), {
    size: 1,
    hits: 2,
    misses: 1,
    evictions: 0,
  });
});

test("the same eventId reused across two escrows still dedupes the second delivery", () => {
  const dedupe = new SettlementEventDedupe({ ttlMs: TTL });
  const first = goldenWebhook("evt-771-idem-shared", "esc-idem-dedupe-1");
  const second = goldenWebhook("evt-771-idem-shared", "esc-idem-dedupe-2");
  // The two settlements are different payloads (different escrowId)
  // that both verify under the same secret — but the dedupe key is
  // the eventId alone.
  assert.notDeepEqual(second.payload, first.payload);
  assert.equal(
    receive(dedupe, JSON.stringify(first.payload), first.signature),
    "processed",
  );
  assert.equal(
    receive(dedupe, JSON.stringify(second.payload), second.signature),
    "duplicate",
  );
  assert.equal(dedupe.size, 1);
});
