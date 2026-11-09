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
  type SettlementReportInputs,
  type SettlementReportResult,
} from "../src/index.js";

const SECRET = "whsec_test_batch_duplicate_escrowid";
const FIXED_NOW = "2026-11-09T12:00:00.000Z";

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

function inputsFor(e: Escrow): SettlementReportInputs {
  return {
    escrowId: e.id,
    history: e.history,
    finalState: e.state,
    deposit: deposit(),
    settlement: { proFeeBps: 500 },
  };
}

function webhooksFor(ids: string[]): SettlementReportResult[] {
  // Build each report singly on purpose: the batch report builder
  // (#993) would itself reject a duplicate list, and this guard is
  // exactly for callers who bypass it and hand-assemble the results.
  return ids.map((id) => {
    const report = buildSettlementReport(inputsFor(released(id)));
    return { escrowId: id, report };
  });
}

/** Deterministic factory: evt-1, evt-2, … in call order. */
function counterFactory() {
  let n = 0;
  return () => `evt-${++n}`;
}

test("duplicate escrowId aborts the whole batch with the id in the error", () => {
  const results = webhooksFor(["dup-same", "dup-same"]);
  assert.throws(
    () =>
      buildSettlementWebhooks(results, {
        secret: SECRET,
        now: FIXED_NOW,
        eventIdFactory: counterFactory(),
      }),
    /buildSettlementWebhooks: duplicate escrowId "dup-same" in batch: escrowIds must be unique within a batch/,
  );
});

test("duplicate id aborts before any webhook is signed (factory never called)", () => {
  const results = webhooksFor(["dup-nobuild-a", "dup-nobuild-b", "dup-nobuild-b"]);
  let calls = 0;
  const factory = () => {
    calls += 1;
    return `evt-${calls}`;
  };
  assert.throws(
    () =>
      buildSettlementWebhooks(results, {
        secret: SECRET,
        now: FIXED_NOW,
        eventIdFactory: factory,
      }),
    /duplicate escrowId "dup-nobuild-b"/,
  );
  assert.equal(calls, 0);
});

test("non-adjacent duplicates are caught", () => {
  const results = webhooksFor(["dup-far-a", "dup-far-b", "dup-far-c", "dup-far-a"]);
  assert.throws(
    () =>
      buildSettlementWebhooks(results, {
        secret: SECRET,
        now: FIXED_NOW,
        eventIdFactory: counterFactory(),
      }),
    /duplicate escrowId "dup-far-a"/,
  );
});

test("every distinct duplicate id is named in the error", () => {
  const results = webhooksFor(["dup-all-a", "dup-all-b", "dup-all-a", "dup-all-b"]);
  assert.throws(
    () =>
      buildSettlementWebhooks(results, {
        secret: SECRET,
        now: FIXED_NOW,
        eventIdFactory: counterFactory(),
      }),
    /duplicate escrowId "dup-all-a", "dup-all-b" in batch/,
  );
});

test("distinct escrowIds still batch normally and each webhook verifies", () => {
  const results = webhooksFor(["dup-ok-1", "dup-ok-2"]);
  const batch = buildSettlementWebhooks(results, {
    secret: SECRET,
    now: FIXED_NOW,
    eventIdFactory: counterFactory(),
  });
  assert.equal(batch.length, 2);
  for (const entry of batch) {
    assert.ok(entry.webhook);
    assert.equal(entry.error, undefined);
    assert.equal(
      verifySettlementWebhook(entry.webhook!.payload, entry.webhook!.signature, SECRET),
      true,
    );
    assert.equal(
      verifySettlementWebhook(JSON.stringify(entry.webhook!.payload), entry.webhook!.signature, SECRET),
      true,
    );
  }
  assert.deepEqual(
    batch.map((b) => b.webhook!.payload.eventId),
    ["evt-1", "evt-2"],
  );
});

test("single-report buildSettlementWebhook is unaffected by the batch rule", () => {
  const report = buildSettlementReport(inputsFor(released("dup-single")));
  const first = buildSettlementWebhook(report, {
    secret: SECRET,
    now: FIXED_NOW,
    eventId: "evt-single-1",
  });
  const second = buildSettlementWebhook(report, {
    secret: SECRET,
    now: FIXED_NOW,
    eventId: "evt-single-2",
  });
  assert.equal(first.payload.escrowId, "dup-single");
  assert.equal(second.payload.escrowId, "dup-single");
  assert.notEqual(first.payload.eventId, second.payload.eventId);
});

test("duplicate check wins over a per-item failure in the same batch", () => {
  const open = new Escrow("dup-wins-open");
  open.dispatch("FUND");
  // Without the duplicate guard this batch would return a per-item
  // error for the non-terminal escrow plus a webhook; the duplicate
  // must abort the whole call instead.
  const dupOpen: SettlementReportResult = {
    escrowId: "dup-wins",
    error: "cannot build settlement report: no settlement has happened yet",
  };
  const results = webhooksFor(["dup-wins"]);
  assert.throws(
    () =>
      buildSettlementWebhooks([results[0], dupOpen], {
        secret: SECRET,
        now: FIXED_NOW,
        eventIdFactory: counterFactory(),
      }),
    /duplicate escrowId "dup-wins"/,
  );
});

test("malformed entries with no string escrowId keep their per-entry failure", () => {
  // Two entries carrying a non-string escrowId are NOT duplicates of
  // each other: only string ids are scanned, so neither trips the
  // guard and both keep their original per-entry handling.
  const good = webhooksFor(["dup-malformed-ok"])[0];
  const malformed = { escrowId: 123 } as unknown as SettlementReportResult;
  const batch = buildSettlementWebhooks([good, malformed], {
    secret: SECRET,
    now: FIXED_NOW,
    eventIdFactory: counterFactory(),
  });
  assert.equal(batch.length, 2);
  assert.ok(batch[0].webhook);
  assert.equal(batch[1].webhook, undefined);
  assert.equal(batch[1].escrowId, "unknown");
  assert.match(batch[1].error ?? "", /missing settlement report/);
});

test("empty secret still reports the configuration error, not the duplicate", () => {
  const results = webhooksFor(["dup-cfg", "dup-cfg"]);
  assert.throws(
    () =>
      buildSettlementWebhooks(results, {
        secret: "",
        now: FIXED_NOW,
        eventIdFactory: counterFactory(),
      }),
    /signing secret must not be empty/,
  );
});

test("empty batch still returns an empty result", () => {
  assert.deepEqual(
    buildSettlementWebhooks([], {
      secret: SECRET,
      now: FIXED_NOW,
      eventIdFactory: counterFactory(),
    }),
    [],
  );
});
