import test from "node:test";
import assert from "node:assert/strict";
import {
  Escrow,
  buildSettlementReport,
  buildSettlementReports,
  buildSettlementWebhook,
  buildSettlementWebhooks,
  calculateDeposit,
  verifySettlementWebhook,
  type SettlementReport,
  type SettlementReportInputs,
} from "../src/index.js";

const SECRET = "whsec_test_batch_settlement_notifications";
const FIXED_NOW = "2026-10-13T11:30:00.000Z";

function deposit() {
  return calculateDeposit({
    creatorPool: 10000,
    baseFee: 600,
    complexityMultiplier: 1.0,
    loyaltyDiscount: 30,
    oracleFee: 60,
  });
}

function released(id: string) {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_PASS");
  e.dispatch("RELEASE");
  return e;
}

function refunded(id: string) {
  const e = new Escrow(id);
  e.dispatch("FUND");
  e.dispatch("SUBMIT_MILESTONE");
  e.dispatch("VERIFY_FAIL");
  e.dispatch("ARBITRATE_REFUND");
  return e;
}

function inputsFor(e: Escrow): SettlementReportInputs {
  return {
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: deposit(),
    settlement: { proFeeBps: 500 },
  };
}

/** Deterministic factory: evt-1, evt-2, … in call order. */
function counterFactory() {
  let n = 0;
  return () => `evt-${++n}`;
}

test("mixed batch matches single builds field-for-field under the same now/factory sequence", () => {
  const results = buildSettlementReports([
    inputsFor(released("bw-rel")),
    inputsFor(refunded("bw-ref")),
  ]);
  const batch = buildSettlementWebhooks(results, {
    secret: SECRET,
    now: FIXED_NOW,
    eventIdFactory: counterFactory(),
  });

  assert.equal(batch.length, 2);
  const singleFactory = counterFactory();
  for (const [i, entry] of results.entries()) {
    const single = buildSettlementWebhook(entry.report!, {
      secret: SECRET,
      now: FIXED_NOW,
      eventId: singleFactory(),
    });
    assert.equal(batch[i].escrowId, entry.escrowId);
    assert.equal(batch[i].error, undefined);
    assert.deepEqual(batch[i].webhook, single);
  }
});

test("an error entry from buildSettlementReports is forwarded and does not block later entries", () => {
  const open = new Escrow("bw-open");
  open.dispatch("FUND");
  const results = buildSettlementReports([
    inputsFor(released("bw-first")),
    inputsFor(open),
    inputsFor(refunded("bw-last")),
  ]);
  assert.match(results[1].error ?? "", /no settlement has happened yet/);

  const batch = buildSettlementWebhooks(results, {
    secret: SECRET,
    now: FIXED_NOW,
    eventIdFactory: counterFactory(),
  });

  assert.deepEqual(
    batch.map((b) => b.escrowId),
    ["bw-first", "bw-open", "bw-last"],
  );
  assert.ok(batch[0].webhook);
  assert.equal(batch[1].webhook, undefined);
  assert.equal(batch[1].error, results[1].error);
  // The entry after the failure still built — and the failed entry did
  // not consume an eventId (factory runs per attempted report only).
  assert.ok(batch[2].webhook);
  assert.equal(batch[2].webhook?.payload.eventId, "evt-2");
});

test("a structurally broken report fails per-item and does not pollute its neighbours", () => {
  const good = buildSettlementReport(inputsFor(released("bw-good")));
  const broken = { escrowId: "bw-broken" } as unknown as SettlementReport;
  const batch = buildSettlementWebhooks(
    [
      { escrowId: "bw-good", report: good },
      { escrowId: "bw-broken", report: broken },
      { escrowId: "bw-good-2", report: buildSettlementReport(inputsFor(refunded("bw-good-2"))) },
    ],
    { secret: SECRET, now: FIXED_NOW, eventIdFactory: counterFactory() },
  );

  assert.ok(batch[0].webhook);
  assert.equal(batch[1].webhook, undefined);
  assert.ok(typeof batch[1].error === "string" && batch[1].error.length > 0);
  assert.ok(batch[2].webhook);
  assert.ok(
    verifySettlementWebhook(batch[0].webhook!.payload, batch[0].webhook!.signature, SECRET),
  );
  assert.ok(
    verifySettlementWebhook(batch[2].webhook!.payload, batch[2].webhook!.signature, SECRET),
  );
});

test("empty input returns an empty array", () => {
  assert.deepEqual(buildSettlementWebhooks([], { secret: SECRET }), []);
});

test("call-level configuration errors throw for the whole batch", () => {
  const results = buildSettlementReports([inputsFor(released("bw-cfg"))]);
  assert.throws(
    () => buildSettlementWebhooks(results, { secret: "" }),
    /signing secret must not be empty/,
  );
  assert.throws(
    () => buildSettlementWebhooks(results, { secret: SECRET, now: "not-a-date" }),
    /invalid 'now' timestamp/,
  );
  assert.throws(
    () =>
      buildSettlementWebhooks(results, {
        secret: SECRET,
        eventIdFactory: "evt-fixed" as unknown as () => string,
      }),
    /'eventIdFactory' must be a function/,
  );
  assert.throws(
    () =>
      buildSettlementWebhooks(
        "nope" as unknown as typeof results,
        { secret: SECRET },
      ),
    /results must be an array/,
  );
});

test("per-item eventIds are distinct and every built webhook verifies", () => {
  const results = buildSettlementReports([
    inputsFor(released("bw-a")),
    inputsFor(refunded("bw-b")),
    inputsFor(released("bw-c")),
  ]);
  const batch = buildSettlementWebhooks(results, { secret: SECRET, now: FIXED_NOW });
  const ids = batch.map((b) => b.webhook?.payload.eventId);
  assert.equal(new Set(ids).size, 3);
  for (const entry of batch) {
    assert.ok(entry.webhook);
    assert.match(
      entry.webhook!.payload.eventId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    assert.ok(
      verifySettlementWebhook(entry.webhook!.payload, entry.webhook!.signature, SECRET),
    );
    assert.equal(
      verifySettlementWebhook(entry.webhook!.payload, entry.webhook!.signature, "wrong-secret"),
      false,
    );
  }
});

test("a factory returning an empty eventId fails only that item", () => {
  const results = buildSettlementReports([
    inputsFor(released("bw-f1")),
    inputsFor(released("bw-f2")),
    inputsFor(released("bw-f3")),
  ]);
  let n = 0;
  const batch = buildSettlementWebhooks(results, {
    secret: SECRET,
    now: FIXED_NOW,
    eventIdFactory: () => (++n === 2 ? "" : `evt-${n}`),
  });
  assert.ok(batch[0].webhook);
  assert.equal(batch[1].webhook, undefined);
  assert.match(batch[1].error ?? "", /'eventId' must be a non-empty string/);
  assert.ok(batch[2].webhook);
});

test("a factory returning a duplicate eventId fails only the later item, unsigned", () => {
  const results = buildSettlementReports([
    inputsFor(released("bw-dup-1")),
    inputsFor(refunded("bw-dup-2")),
  ]);
  const batch = buildSettlementWebhooks(results, {
    secret: SECRET,
    now: FIXED_NOW,
    eventIdFactory: () => "evt-dup",
  });

  assert.ok(batch[0].webhook);
  assert.equal(batch[0].webhook?.payload.eventId, "evt-dup");
  assert.ok(
    verifySettlementWebhook(batch[0].webhook!.payload, batch[0].webhook!.signature, SECRET),
  );
  assert.equal(batch[1].webhook, undefined);
  assert.match(batch[1].error ?? "", /duplicate eventId "evt-dup" in batch/);
});

test("a duplicate in the middle does not block the report after it", () => {
  const results = buildSettlementReports([
    inputsFor(released("bw-mid-1")),
    inputsFor(refunded("bw-mid-2")),
    inputsFor(released("bw-mid-3")),
  ]);
  const ids = ["evt-a", "evt-a", "evt-b"];
  let n = 0;
  const batch = buildSettlementWebhooks(results, {
    secret: SECRET,
    now: FIXED_NOW,
    eventIdFactory: () => ids[n++],
  });

  assert.ok(batch[0].webhook);
  assert.equal(batch[0].webhook?.payload.eventId, "evt-a");
  assert.equal(batch[1].webhook, undefined);
  assert.match(batch[1].error ?? "", /duplicate eventId "evt-a" in batch/);
  assert.ok(batch[2].webhook);
  assert.equal(batch[2].webhook?.payload.eventId, "evt-b");
  assert.ok(
    verifySettlementWebhook(batch[2].webhook!.payload, batch[2].webhook!.signature, SECRET),
  );
});

test("a duplicate is still caught across a forwarded error entry (which consumes no eventId)", () => {
  const open = new Escrow("bw-x-open");
  open.dispatch("FUND");
  const results = buildSettlementReports([
    inputsFor(released("bw-x-1")),
    inputsFor(open),
    inputsFor(refunded("bw-x-2")),
  ]);
  assert.ok(results[1].error);
  // The forwarded error entry never calls the factory, so the second
  // attempted report draws the same "evt-x" as the first — a duplicate.
  const batch = buildSettlementWebhooks(results, {
    secret: SECRET,
    now: FIXED_NOW,
    eventIdFactory: () => "evt-x",
  });

  assert.ok(batch[0].webhook);
  assert.equal(batch[1].webhook, undefined);
  assert.equal(batch[1].error, results[1].error);
  assert.equal(batch[2].webhook, undefined);
  assert.match(batch[2].error ?? "", /duplicate eventId "evt-x" in batch/);
});

test("a failed build does not claim its eventId: a later report may reuse it", () => {
  const good = buildSettlementReport(inputsFor(released("bw-reuse-good")));
  const broken = { escrowId: "bw-reuse-broken" } as unknown as SettlementReport;
  const batch = buildSettlementWebhooks(
    [
      { escrowId: "bw-reuse-broken", report: broken },
      { escrowId: "bw-reuse-good", report: good },
    ],
    { secret: SECRET, now: FIXED_NOW, eventIdFactory: () => "evt-reuse" },
  );

  assert.equal(batch[0].webhook, undefined);
  assert.ok(typeof batch[0].error === "string" && batch[0].error.length > 0);
  assert.ok(!/duplicate eventId/.test(batch[0].error ?? ""));
  assert.ok(batch[1].webhook);
  assert.equal(batch[1].webhook?.payload.eventId, "evt-reuse");
  assert.ok(
    verifySettlementWebhook(batch[1].webhook!.payload, batch[1].webhook!.signature, SECRET),
  );
});

test("an empty factory value does not claim its id, and a later valid duplicate is still caught", () => {
  const results = buildSettlementReports([
    inputsFor(released("bw-e-1")),
    inputsFor(refunded("bw-e-2")),
    inputsFor(released("bw-e-3")),
  ]);
  const ids = ["", "evt-valid", "evt-valid"];
  let n = 0;
  const batch = buildSettlementWebhooks(results, {
    secret: SECRET,
    now: FIXED_NOW,
    eventIdFactory: () => ids[n++],
  });

  assert.equal(batch[0].webhook, undefined);
  assert.match(batch[0].error ?? "", /'eventId' must be a non-empty string/);
  assert.ok(batch[1].webhook);
  assert.equal(batch[1].webhook?.payload.eventId, "evt-valid");
  assert.equal(batch[2].webhook, undefined);
  assert.match(batch[2].error ?? "", /duplicate eventId "evt-valid" in batch/);
});

test("all-distinct factory ids keep the previous batch behaviour exactly", () => {
  const results = buildSettlementReports([
    inputsFor(released("bw-ok-1")),
    inputsFor(refunded("bw-ok-2")),
    inputsFor(released("bw-ok-3")),
  ]);
  const batch = buildSettlementWebhooks(results, {
    secret: SECRET,
    now: FIXED_NOW,
    eventIdFactory: counterFactory(),
  });

  assert.deepEqual(
    batch.map((b) => b.webhook?.payload.eventId),
    ["evt-1", "evt-2", "evt-3"],
  );
  for (const entry of batch) {
    assert.ok(entry.webhook);
    assert.equal(entry.error, undefined);
    assert.ok(
      verifySettlementWebhook(entry.webhook!.payload, entry.webhook!.signature, SECRET),
    );
  }
});

test("the duplicate error message is exact, including the offending id", () => {
  const results = buildSettlementReports([
    inputsFor(released("bw-exact-1")),
    inputsFor(released("bw-exact-2")),
  ]);
  const batch = buildSettlementWebhooks(results, {
    secret: SECRET,
    now: FIXED_NOW,
    eventIdFactory: () => "evt-exact",
  });

  assert.equal(
    batch[1].error,
    'duplicate eventId "evt-exact" in batch: eventIds must be unique within a batch',
  );
});

test("a non-function eventIdFactory still throws call-level even for a duplicate-prone batch", () => {
  const results = buildSettlementReports([
    inputsFor(released("bw-nf-1")),
    inputsFor(released("bw-nf-2")),
  ]);
  assert.throws(
    () =>
      buildSettlementWebhooks(results, {
        secret: SECRET,
        eventIdFactory: "evt-fixed" as unknown as () => string,
      }),
    /'eventIdFactory' must be a function/,
  );
});

test("single build behaviour is unchanged (no batch wrapper involved)", () => {
  const report = buildSettlementReport(inputsFor(released("bw-single")));
  const single = buildSettlementWebhook(report, {
    secret: SECRET,
    now: FIXED_NOW,
    eventId: "evt-single",
  });
  assert.equal(single.payload.eventId, "evt-single");
  assert.equal(single.payload.at, FIXED_NOW);
  assert.ok(verifySettlementWebhook(single.payload, single.signature, SECRET));
  assert.throws(
    () => buildSettlementWebhook(report, { secret: "" }),
    /signing secret must not be empty/,
  );
});
