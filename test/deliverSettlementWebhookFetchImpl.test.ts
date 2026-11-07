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
import type {
  SettlementReport,
  SettlementWebhook,
  SettlementWebhookFetchImpl,
} from "../src/index.js";

const SECRET = "whsec_test_settlement_delivery_fetchimpl_20261107";
const OTHER_SECRET = "whsec_test_settlement_delivery_fetchimpl_other";
const FIXED_NOW = "2026-11-07T19:30:00.000Z";
const URL_A = "https://ledger.example.com/hooks/escrow";
const URL_B = "https://notify.example.com/hooks/escrow";

function goldenDeposit() {
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

function goldenReport(): SettlementReport {
  const escrow = new Escrow("esc-delivery-fetchimpl");
  escrow.dispatch("FUND");
  escrow.dispatch("SUBMIT_MILESTONE");
  escrow.dispatch("VERIFY_PASS");
  escrow.dispatch("RELEASE");
  return buildSettlementReport({
    escrowId: escrow.id,
    history: escrow.history,
    finalState: escrow.state,
    deposit: goldenDeposit(),
    settlement: { proFeeBps: 500 },
  });
}

function goldenWebhook(): SettlementWebhook {
  return buildSettlementWebhook(goldenReport(), {
    secret: SECRET,
    now: FIXED_NOW,
  });
}

interface RecordedCall {
  url: string;
  init: RequestInit;
}

/** Fake fetch that replays scripted responses and records every call. */
function scriptedFetch(
  script: Array<Response | Error>,
  calls: RecordedCall[],
): SettlementWebhookFetchImpl {
  let index = 0;
  return async (url, init) => {
    calls.push({ url, init });
    const next = script[Math.min(index, script.length - 1)];
    index += 1;
    if (next instanceof Error) throw next;
    return next;
  };
}

function okResponse(): Response {
  return new Response("ok", { status: 200 });
}

test("injected fetch receives the signed POST and succeeds", async () => {
  const webhook = goldenWebhook();
  const calls: RecordedCall[] = [];
  const result = await deliverSettlementWebhook(URL_A, webhook, {
    backoffMs: 0,
    fetchImpl: scriptedFetch([okResponse()], calls),
  });
  assert.deepEqual(result, { status: 200, attempts: 1 });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(typeof call.url, "string");
  assert.equal(call.url, URL_A);
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.redirect, "manual");
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers["X-Signature"], webhook.signature);
  assert.equal(headers["X-Event-Id"], webhook.payload.eventId);
  assert.equal(headers["Idempotency-Key"], webhook.payload.eventId);
  assert.equal(typeof call.init.body, "string");
  // The posted body is byte-identical to what was signed: the receiver
  // can verify it over the raw bytes.
  assert.equal(
    verifySettlementWebhook(call.init.body as string, webhook.signature, SECRET),
    true,
  );
  assert.equal(
    JSON.parse(call.init.body as string).eventId,
    webhook.payload.eventId,
  );
});

test("injected fetch drives the retry loop (500 then 200)", async () => {
  const webhook = goldenWebhook();
  const calls: RecordedCall[] = [];
  const result = await deliverSettlementWebhook(URL_A, webhook, {
    retries: 2,
    backoffMs: 0,
    fetchImpl: scriptedFetch(
      [
        new Response("boom", { status: 500 }),
        okResponse(),
      ],
      calls,
    ),
  });
  assert.deepEqual(result, { status: 200, attempts: 2 });
  assert.equal(calls.length, 2);
  // Retries re-send the identical webhook: same body, same signature.
  assert.equal(calls[0].init.body, calls[1].init.body);
});

test("injected fetch honors a 429 Retry-After hint", async () => {
  const webhook = goldenWebhook();
  const calls: RecordedCall[] = [];
  const result = await deliverSettlementWebhook(URL_A, webhook, {
    retries: 2,
    backoffMs: 0,
    fetchImpl: scriptedFetch(
      [
        new Response("slow down", {
          status: 429,
          headers: { "Retry-After": "0" },
        }),
        okResponse(),
      ],
      calls,
    ),
  });
  assert.deepEqual(result, { status: 200, attempts: 2 });
  assert.equal(calls.length, 2);
});

test("non-function fetchImpl is a config error before any request", async () => {
  const webhook = goldenWebhook();
  // Each value is rejected with its own value in the message, before any
  // request is made: an https URL to a non-existent host would surface
  // a network error instead of this config error if a fetch were
  // attempted at all.
  const badValues: Array<[unknown, RegExp]> = [
    ["fetch", /fetchImpl must be a function, got fetch/],
    [42, /fetchImpl must be a function, got 42/],
    [{}, /fetchImpl must be a function, got \[object Object\]/],
    [null, /fetchImpl must be a function, got null/],
  ];
  for (const [bad, pattern] of badValues) {
    await assert.rejects(
      deliverSettlementWebhook(URL_A, webhook, {
        backoffMs: 0,
        fetchImpl: bad as SettlementWebhookFetchImpl,
      }),
      pattern,
    );
  }
});

test("network errors from the injected fetch are retried, then reported", async () => {
  const webhook = goldenWebhook();
  const calls: RecordedCall[] = [];
  await assert.rejects(
    deliverSettlementWebhook(URL_A, webhook, {
      retries: 2,
      backoffMs: 0,
      fetchImpl: scriptedFetch(
        [new Error("connection refused"), new Error("connection refused")],
        calls,
      ),
    }),
    /webhook delivery to https:\/\/ledger\.example\.com\/hooks\/escrow failed after 3 attempts: connection refused/,
  );
  assert.equal(calls.length, 3);
});

test("injected fetch that ignores its signal still times out per attempt", async () => {
  const webhook = goldenWebhook();
  const calls: RecordedCall[] = [];
  const hanging: SettlementWebhookFetchImpl = (url, init) => {
    calls.push({ url, init });
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  };
  await assert.rejects(
    deliverSettlementWebhook(URL_A, webhook, {
      retries: 0,
      backoffMs: 0,
      timeoutMs: 50,
      fetchImpl: hanging,
    }),
    /webhook delivery timed out after 50ms/,
  );
  assert.equal(calls.length, 1);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test("no fetchImpl keeps the loopback global-fetch behavior", async () => {
  const webhook = goldenWebhook();
  const received: string[] = [];
  const server: Server = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        received.push(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, { "content-type": "application/json" });
        res.end("ok");
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const result = await deliverSettlementWebhook(
      `http://127.0.0.1:${port}/hooks/escrow`,
      webhook,
      { backoffMs: 0, allowInsecureHttp: true },
    );
    assert.deepEqual(result, { status: 200, attempts: 1 });
    assert.equal(received.length, 1);
    assert.equal(verifySettlementWebhook(received[0], webhook.signature, SECRET), true);
  } finally {
    server.close();
  }
});

test("fan-out shares the call-level fetchImpl across endpoints", async () => {
  const report = goldenReport();
  const calls: RecordedCall[] = [];
  const out = await deliverSettlementWebhookToMany(
    report,
    [
      { url: URL_A, secret: SECRET },
      { url: URL_B, secret: OTHER_SECRET },
    ],
    {
      backoffMs: 0,
      fetchImpl: scriptedFetch([okResponse()], calls),
    },
  );
  assert.equal(out.delivered, 2);
  assert.equal(out.failed, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, URL_A);
  assert.equal(calls[1].url, URL_B);
  // Each endpoint's copy is signed under its own secret.
  const headersA = calls[0].init.headers as Record<string, string>;
  const headersB = calls[1].init.headers as Record<string, string>;
  assert.notEqual(headersA["X-Signature"], headersB["X-Signature"]);
  assert.equal(
    verifySettlementWebhook(
      calls[0].init.body as string,
      headersA["X-Signature"],
      SECRET,
    ),
    true,
  );
  assert.equal(
    verifySettlementWebhook(
      calls[1].init.body as string,
      headersB["X-Signature"],
      OTHER_SECRET,
    ),
    true,
  );
  assert.equal(
    verifySettlementWebhook(
      calls[0].init.body as string,
      headersA["X-Signature"],
      OTHER_SECRET,
    ),
    false,
  );
});

test("fan-out per-endpoint fetchImpl overrides the call-level one", async () => {
  const report = goldenReport();
  const sharedCalls: RecordedCall[] = [];
  const overrideCalls: RecordedCall[] = [];
  const out = await deliverSettlementWebhookToMany(
    report,
    [
      {
        url: URL_A,
        secret: SECRET,
        fetchImpl: scriptedFetch([okResponse()], overrideCalls),
      },
      { url: URL_B, secret: OTHER_SECRET },
    ],
    {
      backoffMs: 0,
      fetchImpl: scriptedFetch([okResponse()], sharedCalls),
    },
  );
  assert.equal(out.delivered, 2);
  assert.equal(out.failed, 0);
  assert.equal(overrideCalls.length, 1);
  assert.equal(overrideCalls[0].url, URL_A);
  assert.equal(sharedCalls.length, 1);
  assert.equal(sharedCalls[0].url, URL_B);
});

test("fan-out call-level non-function fetchImpl throws before any request", async () => {
  const report = goldenReport();
  await assert.rejects(
    deliverSettlementWebhookToMany(
      report,
      [{ url: URL_A, secret: SECRET }],
      {
        backoffMs: 0,
        fetchImpl: 42 as unknown as SettlementWebhookFetchImpl,
      },
    ),
    /cannot deliver settlement webhook: fetchImpl must be a function, got 42/,
  );
});

test("fan-out per-endpoint non-function fetchImpl fails only that endpoint", async () => {
  const report = goldenReport();
  const sharedCalls: RecordedCall[] = [];
  const out = await deliverSettlementWebhookToMany(
    report,
    [
      {
        url: URL_A,
        secret: SECRET,
        fetchImpl: "not-a-function" as unknown as SettlementWebhookFetchImpl,
      },
      { url: URL_B, secret: OTHER_SECRET },
    ],
    {
      backoffMs: 0,
      fetchImpl: scriptedFetch([okResponse()], sharedCalls),
    },
  );
  assert.equal(out.delivered, 1);
  assert.equal(out.failed, 1);
  assert.equal(out.results[0].ok, false);
  assert.equal(out.results[0].attempts, 0);
  assert.match(
    out.results[0].error ?? "",
    /cannot deliver settlement webhook: fetchImpl must be a function/,
  );
  assert.equal(out.results[1].ok, true);
  assert.equal(sharedCalls.length, 1);
  assert.equal(sharedCalls[0].url, URL_B);
});
