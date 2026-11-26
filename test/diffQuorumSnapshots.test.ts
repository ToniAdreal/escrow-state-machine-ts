/**
 * Quorum snapshot diff helper diffQuorumSnapshots (backlog #1175).
 *
 * Two stored quorum snapshots are the only honest way to answer
 * "who voted since I last looked, did the threshold move, was
 * anyone revoked" — but a hand-written field compare has no shared
 * answer for approvals: is an expired signer's re-approval one
 * change or two, and is a verified flag arriving late a change at
 * all? This helper fixes one rule: an approval's identity is its
 * signer id plus its timestamp, so a re-approval is exactly one
 * added entry and a late `verified` flag is exactly one modified
 * entry, never an add-plus-remove pair.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  approvalStatement,
  createQuorum,
  diffQuorumSnapshots,
  restoreQuorum,
} from "../src/index.js";
import type { QuorumConfig, QuorumSnapshot } from "../src/index.js";

const NINE = [
  "dao-1", "dao-2", "dao-3", "dao-4", "dao-5",
  "dao-6", "dao-7", "dao-8", "dao-9",
];
const WINDOW = 60_000;
const T0 = 1_700_000_000_000;

function fakeClock(start = T0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function quorumWith(
  approvals: readonly string[],
  configOverrides: Partial<QuorumConfig> = {},
) {
  const clock = fakeClock();
  const config: QuorumConfig = {
    threshold: 2,
    signers: NINE.slice(0, 5),
    now: clock.now,
    ...configOverrides,
  };
  const q = createQuorum(config);
  for (const s of approvals) {
    q.approve(s);
    clock.advance(1_000);
  }
  return { q, config, clock };
}

describe("diffQuorumSnapshots", () => {
  it("identical snapshots diff to only { approvalsChanged: false }", () => {
    const { q } = quorumWith(["dao-1"]);
    const snapshot = q.snapshot();
    assert.deepEqual(diffQuorumSnapshots(snapshot, q.snapshot()), {
      approvalsChanged: false,
    });
    assert.deepEqual(diffQuorumSnapshots(snapshot, snapshot), {
      approvalsChanged: false,
    });
  });

  it("reports a threshold change with from/to", () => {
    const { q: qa } = quorumWith(["dao-1"], { threshold: 2 });
    const { q: qb } = quorumWith(["dao-1"], { threshold: 3 });
    const diff = diffQuorumSnapshots(qa.snapshot(), qb.snapshot());
    assert.deepEqual(diff.thresholdChanged, { from: 2, to: 3 });
    assert.equal(diff.approvalsChanged, false);
    assert.equal(diff.signersChanged, undefined);
  });

  it("reports signer additions and removals, but not a pure reorder", () => {
    const { q: qa } = quorumWith(["dao-1"]);
    const { q: qb } = quorumWith(["dao-1"], {
      signers: [...NINE.slice(0, 4), "dao-9"],
    });
    const diff = diffQuorumSnapshots(qa.snapshot(), qb.snapshot());
    assert.deepEqual(diff.signersChanged, {
      from: NINE.slice(0, 5),
      to: [...NINE.slice(0, 4), "dao-9"],
    });
    assert.equal(diff.approvalsChanged, false);

    // Same signer set in a different config order is not a change:
    // signers is config order, not meaning.
    const { q: qc } = quorumWith(["dao-1"], {
      signers: [...NINE.slice(0, 5)].reverse(),
    });
    assert.equal(
      diffQuorumSnapshots(qa.snapshot(), qc.snapshot()).signersChanged,
      undefined,
    );
  });

  it("reports maxApprovalAgeMs set, cleared, and changed", () => {
    const { q: plain } = quorumWith(["dao-1"]);
    const { q: windowed } = quorumWith(["dao-1"], {
      maxApprovalAgeMs: WINDOW,
    });
    assert.deepEqual(
      diffQuorumSnapshots(plain.snapshot(), windowed.snapshot())
        .maxApprovalAgeMsChanged,
      { from: undefined, to: WINDOW },
    );
    assert.deepEqual(
      diffQuorumSnapshots(windowed.snapshot(), plain.snapshot())
        .maxApprovalAgeMsChanged,
      { from: WINDOW, to: undefined },
    );
    const { q: wider } = quorumWith(["dao-1"], {
      maxApprovalAgeMs: WINDOW * 2,
    });
    assert.deepEqual(
      diffQuorumSnapshots(windowed.snapshot(), wider.snapshot())
        .maxApprovalAgeMsChanged,
      { from: WINDOW, to: WINDOW * 2 },
    );
  });

  it("reports a new approval as one added entry", () => {
    const { q } = quorumWith(["dao-1"]);
    const before = q.snapshot();
    q.approve("dao-2");
    const diff = diffQuorumSnapshots(before, q.snapshot());
    assert.equal(diff.approvalsChanged, true);
    assert.deepEqual(
      diff.approvalsAdded?.map((e) => e.signerId),
      ["dao-2"],
    );
    assert.equal(diff.approvalsRemoved, undefined);
    assert.equal(diff.approvalsModified, undefined);
  });

  it("reports a revoke as one removed entry", () => {
    const { q } = quorumWith(["dao-1", "dao-2"]);
    const before = q.snapshot();
    q.revoke("dao-2");
    const diff = diffQuorumSnapshots(before, q.snapshot());
    assert.equal(diff.approvalsChanged, true);
    assert.deepEqual(
      diff.approvalsRemoved?.map((e) => e.signerId),
      ["dao-2"],
    );
    assert.equal(diff.approvalsAdded, undefined);
  });

  it("counts an expired re-approval as one change, not two", () => {
    const { q, clock } = quorumWith(["dao-1"], {
      maxApprovalAgeMs: WINDOW,
    });
    const before = q.snapshot();
    clock.advance(WINDOW + 1);
    q.approve("dao-1"); // fresh entry; the old one stays in the log
    const after = q.snapshot();
    assert.equal(after.approvals.length, 2);
    const diff = diffQuorumSnapshots(before, after);
    assert.equal(diff.approvalsChanged, true);
    assert.equal(diff.approvalsAdded?.length, 1);
    assert.equal(diff.approvalsAdded?.[0].signerId, "dao-1");
    assert.equal(diff.approvalsRemoved, undefined);
    assert.equal(diff.approvalsModified, undefined);
  });

  it("reports a late verified flag as one modified entry", () => {
    const pair = generateKeyPairSync("ed25519");
    const { q, config } = quorumWith(["dao-1"], {
      signerPublicKeys: { "dao-1": pair.publicKey },
    });
    const before = q.snapshot();
    assert.equal(before.approvals[0].verified, undefined);
    q.approveSigned(
      "dao-1",
      sign(null, approvalStatement("dao-1"), pair.privateKey),
    );
    const after = q.snapshot();
    assert.equal(after.approvals.length, 1);
    assert.equal(after.approvals[0].verified, true);
    const diff = diffQuorumSnapshots(before, after);
    assert.equal(diff.approvalsChanged, true);
    assert.deepEqual(diff.approvalsModified, [
      { signerId: "dao-1", at: before.approvals[0].at, verified: true },
    ]);
    assert.equal(diff.approvalsAdded, undefined);
    assert.equal(diff.approvalsRemoved, undefined);
    // The unsigned restore drops the flag again (backlog #1419):
    // before-vs-restored shows no change — the late flag did not
    // survive the restore — while after-vs-restored reports the
    // downgrade as one modified entry, so the loss is visible.
    const restored = restoreQuorum(config, JSON.parse(JSON.stringify(after)));
    assert.deepEqual(diffQuorumSnapshots(before, restored.snapshot()), {
      approvalsChanged: false,
    });
    assert.deepEqual(diffQuorumSnapshots(after, restored.snapshot()), {
      approvalsChanged: true,
      approvalsModified: [
        { signerId: "dao-1", at: after.approvals[0].at },
      ],
    });
  });

  it("rejects malformed snapshots instead of silently comparing them", () => {
    const { q } = quorumWith(["dao-1"]);
    const good = q.snapshot();
    const badInputs: Array<[string, unknown]> = [
      ["non-object", 42],
      ["null", null],
      ["unknown top-level field", { ...good, extra: true }],
      ["unsupported version", { ...good, v: 2 }],
      ["non-integer threshold", { ...good, threshold: 1.5 }],
      ["threshold above signer count", { ...good, threshold: 99 }],
      ["empty signer list", { ...good, signers: [] }],
      ["bad expiry window", { ...good, maxApprovalAgeMs: 0 }],
      ["unknown signer in approvals", {
        ...good,
        approvals: [{ signerId: "mallory", at: good.approvals[0].at }],
      }],
      ["non-canonical timestamp", {
        ...good,
        approvals: [{ signerId: "dao-1", at: "2026-03-10 09:00:00" }],
      }],
      ["duplicate approval entry", {
        ...good,
        approvals: [good.approvals[0], good.approvals[0]],
      }],
    ];
    for (const [label, bad] of badInputs) {
      assert.throws(
        () => diffQuorumSnapshots(bad as QuorumSnapshot, good),
        /invalid quorum snapshot: /,
        `a-side: ${label}`,
      );
      assert.throws(
        () => diffQuorumSnapshots(good, bad as QuorumSnapshot),
        /invalid quorum snapshot: /,
        `b-side: ${label}`,
      );
    }
  });

  it("empty approvals on both sides diff to no change", () => {
    const { q: qa } = quorumWith([]);
    const { q: qb } = quorumWith([]);
    assert.deepEqual(diffQuorumSnapshots(qa.snapshot(), qb.snapshot()), {
      approvalsChanged: false,
    });
  });

  it("round-trips through restore: snapshot -> diff -> restore agrees", () => {
    const { q, config, clock } = quorumWith(["dao-1", "dao-2"]);
    const before = q.snapshot();
    const restored = restoreQuorum(config, JSON.parse(JSON.stringify(before)));
    assert.deepEqual(diffQuorumSnapshots(before, restored.snapshot()), {
      approvalsChanged: false,
    });
    // And a diff taken after the restore reports the same new vote.
    clock.advance(1_000);
    restored.approve("dao-3");
    const diff = diffQuorumSnapshots(before, restored.snapshot());
    assert.deepEqual(
      diff.approvalsAdded?.map((e) => e.signerId),
      ["dao-3"],
    );
    assert.equal(diff.approvalsChanged, true);
  });

  it("returns detached copies and never mutates its inputs", () => {
    const { q } = quorumWith(["dao-1"]);
    const before = q.snapshot();
    q.approve("dao-2");
    const after = q.snapshot();
    const beforeJson = JSON.stringify(before);
    const afterJson = JSON.stringify(after);
    const diff = diffQuorumSnapshots(before, after);
    // The entries are detached copies, not aliases into the snapshot:
    // rewriting one must not change what a fresh diff reports.
    (diff.approvalsAdded![0] as { signerId: string }).signerId =
      "rewritten by the caller";
    assert.deepEqual(diffQuorumSnapshots(before, after).approvalsAdded, [
      { signerId: "dao-2", at: after.approvals[1].at },
    ]);
    assert.equal(JSON.stringify(before), beforeJson);
    assert.equal(JSON.stringify(after), afterJson);
  });
});
