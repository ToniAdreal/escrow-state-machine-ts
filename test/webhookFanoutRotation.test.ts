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
 * Settlement webhook fan-out x secret rotation (backlog #681).
 *
 * Combination under test: fan-out (#156) signs each endpoint's copy
 * with that endpoint's own secret, and rotation (#rotation) lets a
 * receiver accept signatures made with either the old or the new
 * secret. Neither file tests the two together: `webhookFanout.test.ts`
 * checks per-endpoint secrets but never a rotation candidate list,
 * and `webhookSecretRotation.test.ts` checks candidate lists only on
 * a single endpoint. The gap this file closes: during a rotation
 * window, a fan-out to a still-legacy endpoint (old secret) and an
 * already-migrated endpoint (new secret) must both verify under the
 * receiver's `[new, old]` candidate list, while a new-only list must
 * still reject the legacy copy — one endpoint's verdict must never
 * mask the other's.
 *
 * Honest reading of "the same webhook object": `ToMany` builds ONE
 * logical event (shared eventId + at, byte-identical bodies) and
 * signs each copy independently with that endpoint's secret. The
 * shared object is the event, not a single signature — the two
 * `x-signature` headers differ, and the tests pin both facts.
 * Every test uses local 127.0.0.1 servers: no external network.
 */

const OLD_SECRET = "whsec_fanout_rotation_old_20261028";
const NEW_SECRET = "whsec_fanout_rotation_new_20261028";
const FIXED_NOW = "2026-10-28T18:00:00.000Z";
const EVENT_ID = "evt-fanout-rotation-1";

function goldenReport(): SettlementReport {
  const escrow = new Escrow("esc-fanout-rotation");
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
  method: string | undefined;
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
        method: req.method,
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

async function deliverToLegacyAndMigrated() {
  const legacy = await startServer(ok200);
  const migrated = await startServer(ok200);
  const out = await deliverSettlementWebhookToMany(
    goldenReport(),
    [
      { url: legacy.url, secret: OLD_SECRET },
      { url: migrated.url, secret: NEW_SECRET },
    ],
    { allowInsecureHttp: true, backoffMs: 1, now: FIXED_NOW, eventId: EVENT_ID },
  );
  return { legacy, migrated, out };
}

test("rotation window across fan-out: old-signed and new-signed copies both verify with [new, old]", async () => {
  const { legacy, migrated, out } = await deliverToLegacyAndMigrated();
  try {
    assert.equal(out.delivered, 2);
    assert.equal(out.failed, 0);
    assert.equal(legacy.received.length, 1);
    assert.equal(migrated.received.length, 1);
    const [reqOld] = legacy.received;
    const [reqNew] = migrated.received;
    // One logical event: byte-identical bodies, shared eventId + at…
    assert.equal(reqOld.body, reqNew.body);
    assert.equal(JSON.parse(reqOld.body).eventId, EVENT_ID);
    assert.equal(JSON.parse(reqOld.body).at, FIXED_NOW);
    // …but independently signed per endpoint.
    assert.notEqual(reqOld.headers["x-signature"], reqNew.headers["x-signature"]);
    // …and during the rotation window both signatures are accepted.
    assert.ok(
      verifySettlementWebhook(reqOld.body, String(reqOld.headers["x-signature"]), {
        secrets: [NEW_SECRET, OLD_SECRET],
      }),
      "legacy (old-signed) copy must verify under [new, old]",
    );
    assert.ok(
      verifySettlementWebhook(reqNew.body, String(reqNew.headers["x-signature"]), {
        secrets: [NEW_SECRET, OLD_SECRET],
      }),
      "migrated (new-signed) copy must verify under [new, old]",
    );
  } finally {
    await legacy.close();
    await migrated.close();
  }
});

test("candidate order does not matter for either fan-out copy", async () => {
  const { legacy, migrated } = await deliverToLegacyAndMigrated();
  try {
    const [reqOld] = legacy.received;
    const [reqNew] = migrated.received;
    for (const candidates of [
      [NEW_SECRET, OLD_SECRET],
      [OLD_SECRET, NEW_SECRET],
    ]) {
      assert.ok(
        verifySettlementWebhook(reqOld.body, String(reqOld.headers["x-signature"]), {
          secrets: candidates,
        }),
      );
      assert.ok(
        verifySettlementWebhook(reqNew.body, String(reqNew.headers["x-signature"]), {
          secrets: candidates,
        }),
      );
    }
  } finally {
    await legacy.close();
    await migrated.close();
  }
});

test("new-only candidates reject the legacy copy but accept the migrated copy (no masking)", async () => {
  const { legacy, migrated } = await deliverToLegacyAndMigrated();
  try {
    const [reqOld] = legacy.received;
    const [reqNew] = migrated.received;
    // The rotation window closing must be visible per endpoint: the
    // legacy copy fails under [new] while the migrated copy passes
    // under the very same candidate list.
    assert.equal(
      verifySettlementWebhook(reqOld.body, String(reqOld.headers["x-signature"]), {
        secrets: [NEW_SECRET],
      }),
      false,
    );
    assert.ok(
      verifySettlementWebhook(reqNew.body, String(reqNew.headers["x-signature"]), {
        secrets: [NEW_SECRET],
      }),
    );
    // Symmetric leg: old-only accepts the legacy copy, rejects the migrated one.
    assert.ok(
      verifySettlementWebhook(reqOld.body, String(reqOld.headers["x-signature"]), {
        secrets: [OLD_SECRET],
      }),
    );
    assert.equal(
      verifySettlementWebhook(reqNew.body, String(reqNew.headers["x-signature"]), {
        secrets: [OLD_SECRET],
      }),
      false,
    );
  } finally {
    await legacy.close();
    await migrated.close();
  }
});

test("all-wrong candidates fail closed for both fan-out copies", async () => {
  const { legacy, migrated } = await deliverToLegacyAndMigrated();
  try {
    const [reqOld] = legacy.received;
    const [reqNew] = migrated.received;
    const wrong = { secrets: ["whsec_wrong_1", "whsec_wrong_2"] };
    assert.equal(
      verifySettlementWebhook(reqOld.body, String(reqOld.headers["x-signature"]), wrong),
      false,
    );
    assert.equal(
      verifySettlementWebhook(reqNew.body, String(reqNew.headers["x-signature"]), wrong),
      false,
    );
  } finally {
    await legacy.close();
    await migrated.close();
  }
});

test("malformed signatures fail closed for both fan-out copies", async () => {
  const { legacy, migrated } = await deliverToLegacyAndMigrated();
  try {
    const [reqOld] = legacy.received;
    const [reqNew] = migrated.received;
    const opts = { secrets: [NEW_SECRET, OLD_SECRET] };
    for (const bad of ["", "sha256=xyz", "sha256=" + "ab".repeat(31), "md5=" + "ab".repeat(32)]) {
      assert.equal(verifySettlementWebhook(reqOld.body, bad, opts), false);
      assert.equal(verifySettlementWebhook(reqNew.body, bad, opts), false);
    }
  } finally {
    await legacy.close();
    await migrated.close();
  }
});

test("tampered body fails verification for either endpoint's copy", async () => {
  const { legacy, migrated } = await deliverToLegacyAndMigrated();
  try {
    const [reqOld] = legacy.received;
    const [reqNew] = migrated.received;
    const opts = { secrets: [NEW_SECRET, OLD_SECRET] };
    // Raw wire tamper: the eventId inside the signed body changes.
    const tamperedRawOld = reqOld.body.replace(EVENT_ID, "evt-fanout-rotation-2");
    assert.notEqual(tamperedRawOld, reqOld.body);
    assert.equal(
      verifySettlementWebhook(tamperedRawOld, String(reqOld.headers["x-signature"]), opts),
      false,
    );
    const tamperedRawNew = reqNew.body.replace(EVENT_ID, "evt-fanout-rotation-2");
    assert.equal(
      verifySettlementWebhook(tamperedRawNew, String(reqNew.headers["x-signature"]), opts),
      false,
    );
    // Object-form tamper: a parsed payload with an altered field.
    const parsedOld = JSON.parse(reqOld.body) as Record<string, unknown>;
    parsedOld["eventId"] = "evt-fanout-rotation-2";
    assert.equal(
      verifySettlementWebhook(
        parsedOld as unknown as Parameters<typeof verifySettlementWebhook>[0],
        String(reqOld.headers["x-signature"]),
        opts,
      ),
      false,
    );
    const parsedNew = JSON.parse(reqNew.body) as Record<string, unknown>;
    parsedNew["eventId"] = "evt-fanout-rotation-2";
    assert.equal(
      verifySettlementWebhook(
        parsedNew as unknown as Parameters<typeof verifySettlementWebhook>[0],
        String(reqNew.headers["x-signature"]),
        opts,
      ),
      false,
    );
  } finally {
    await legacy.close();
    await migrated.close();
  }
});

test("rotation verifies over the raw wire body for both fan-out copies", async () => {
  const { legacy, migrated } = await deliverToLegacyAndMigrated();
  try {
    const [reqOld] = legacy.received;
    const [reqNew] = migrated.received;
    // The wire body is already a string here; this pins the
    // transport-safe path per endpoint, not just the object path.
    assert.ok(
      verifySettlementWebhook(reqOld.body, String(reqOld.headers["x-signature"]), {
        secrets: [NEW_SECRET, OLD_SECRET],
      }),
    );
    assert.ok(
      verifySettlementWebhook(reqNew.body, String(reqNew.headers["x-signature"]), {
        secrets: [NEW_SECRET, OLD_SECRET],
      }),
    );
    assert.equal(
      verifySettlementWebhook(reqOld.body, String(reqOld.headers["x-signature"]), {
        secrets: [NEW_SECRET],
      }),
      false,
      "raw path must apply the same candidate rules as the object path",
    );
  } finally {
    await legacy.close();
    await migrated.close();
  }
});

test("a failing legacy endpoint does not mask the migrated endpoint's rotation verification", async () => {
  const legacy = await startServer((_req, res) => {
    res.writeHead(500);
    res.end("boom");
  });
  const migrated = await startServer(ok200);
  try {
    const out = await deliverSettlementWebhookToMany(
      goldenReport(),
      [
        { url: legacy.url, secret: OLD_SECRET },
        { url: migrated.url, secret: NEW_SECRET },
      ],
      { allowInsecureHttp: true, retries: 1, backoffMs: 1, now: FIXED_NOW, eventId: EVENT_ID },
    );
    assert.equal(out.delivered, 1);
    assert.equal(out.failed, 1);
    assert.equal(out.results[0].ok, false);
    assert.equal(out.results[0].attempts, 2, "initial attempt + 1 retry");
    assert.deepEqual(out.results[1], { url: migrated.url, ok: true, attempts: 1, status: 200 });
    assert.equal(legacy.received.length, 2);
    assert.equal(migrated.received.length, 1);
    // Retries resend the same signed copy; every attempt stays verifiable.
    assert.equal(legacy.received[0].body, legacy.received[1].body);
    assert.equal(
      legacy.received[0].headers["x-signature"],
      legacy.received[1].headers["x-signature"],
    );
    assert.ok(
      verifySettlementWebhook(
        legacy.received[0].body,
        String(legacy.received[0].headers["x-signature"]),
        { secrets: [NEW_SECRET, OLD_SECRET] },
      ),
    );
    // And the healthy endpoint's copy still verifies under rotation.
    const [reqNew] = migrated.received;
    assert.ok(
      verifySettlementWebhook(reqNew.body, String(reqNew.headers["x-signature"]), {
        secrets: [NEW_SECRET, OLD_SECRET],
      }),
    );
  } finally {
    await legacy.close();
    await migrated.close();
  }
});

test("single-secret call shape still distinguishes the two fan-out copies", async () => {
  const { legacy, migrated } = await deliverToLegacyAndMigrated();
  try {
    const [reqOld] = legacy.received;
    const [reqNew] = migrated.received;
    assert.ok(
      verifySettlementWebhook(reqOld.body, String(reqOld.headers["x-signature"]), OLD_SECRET),
    );
    assert.equal(
      verifySettlementWebhook(reqOld.body, String(reqOld.headers["x-signature"]), NEW_SECRET),
      false,
    );
    assert.ok(
      verifySettlementWebhook(reqNew.body, String(reqNew.headers["x-signature"]), NEW_SECRET),
    );
    assert.equal(
      verifySettlementWebhook(reqNew.body, String(reqNew.headers["x-signature"]), OLD_SECRET),
      false,
    );
  } finally {
    await legacy.close();
    await migrated.close();
  }
});
