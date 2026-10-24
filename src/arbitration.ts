/**
 * Wiring between the M-of-N approval quorum and the escrow state machine.
 *
 * `createQuorum` (src/quorum.ts) models only the counting rule — who has
 * approved — with no knowledge of the escrow. This module is the caller-side
 * orchestration that gates the arbitration transitions on that count:
 * arbitration dispatch requires the quorum to be reached, otherwise the
 * escrow is left completely untouched.
 *
 * Honesty note: the quorum still records caller-trust approvals (no
 * signature verification, no key management, no DAO governance — see
 * README FAQ). This module wires the *count* to the *dispatch*; it does not
 * make the approvals cryptographic.
 */

import {
  Escrow,
  type DispatchOptions,
  type EscrowEvent,
  type EscrowState,
} from "./stateMachine.js";
import type { Quorum } from "./quorum.js";

/** The two arbitration outcomes the DISPUTED state can reach. */
export type ArbitrationOutcome = "release" | "refund";

/**
 * Audit metadata forwarded to the arbitration dispatch.
 *
 * The same injectable timestamp (`at`) and caller-asserted actor
 * (`actor`) the plain `Escrow.dispatch` accepts (see
 * {@link DispatchOptions}) — the arbitration entry was previously the
 * one audit entry with no injection point, so deterministic logs/replays
 * (and the CLI demo) could not pin it — plus the retry-safety fields:
 *
 * - `idempotencyKey`: a duplicate key makes a repeated arbitration
 *   dispatch a pure no-op (returns the current state, appends nothing).
 *   The key is consumed only when the arbitration dispatch itself
 *   succeeds: a quorum-gated rejection throws before the escrow is ever
 *   touched, so the caller can gather approvals and retry with the same
 *   key without it being "used up".
 * - `expectedSeq`: optimistic-concurrency guard. It is checked *first*
 *   inside the escrow's dispatch — before the idempotency dedupe — so a
 *   stale seq raises `dispatch conflict: expected seq <n> but escrow is
 *   at seq <m>` instead of silently no-op'ing through the dedupe. A
 *   guarded retry must therefore pin the seq the caller actually read;
 *   a conflict is a pure rejection (no mutation, no key consumed).
 *
 * Validation is the dispatch's own: an invalid `at`/`actor`/
 * `idempotencyKey`/`expectedSeq` throws before anything is appended.
 * Note the guard ordering documented above — the quorum check itself
 * always runs before option validation.
 */
export type ArbitrationDispatchOptions = Pick<
  DispatchOptions,
  "at" | "actor" | "idempotencyKey" | "expectedSeq"
>;

const OUTCOME_EVENTS: Record<ArbitrationOutcome, EscrowEvent> = {
  release: "ARBITRATE_RELEASE",
  refund: "ARBITRATE_REFUND",
};

/**
 * Dispatch an arbitration event only if the quorum has been reached.
 *
 * - Outcome must be `"release"` or `"refund"`; anything else throws a
 *   caller error (nothing is dispatched).
 * - If `quorum.hasQuorum()` is false, throws
 *   `arbitration requires quorum: <approvals>/<threshold> approvals` and
 *   the escrow's state and history are left unchanged — the failed gating
 *   never touches the audit log.
 * - On success, dispatches `ARBITRATE_RELEASE` / `ARBITRATE_REFUND` and
 *   automatically records `quorum <approvals>/<threshold>` in the audit
 *   note (appended after the caller's own note when one is given).
 * - `opts` optionally forwards retry-safety metadata to that dispatch
 *   (see {@link ArbitrationDispatchOptions}): an injectable audit
 *   timestamp and/or actor, an `idempotencyKey` that turns a repeated
 *   (e.g. timed-out) arbitration call into a pure no-op instead of an
 *   `invalid transition` failure, and/or an `expectedSeq` optimistic-
 *   concurrency guard. The key is consumed only on a successful
 *   dispatch — the quorum gate below runs first, so a below-threshold
 *   rejection never "uses up" the key and the caller can gather
 *   approvals and retry with the same key. Omitting `opts` keeps the
 *   exact historical behavior.
 *
 * The escrow's own transition rules still apply: calling from a state
 * other than DISPUTED fails with the usual `invalid transition` error —
 * a reached quorum does not override the state machine.
 */
export function dispatchArbitration(
  escrow: Escrow,
  quorum: Quorum,
  outcome: ArbitrationOutcome,
  note?: string,
  opts?: ArbitrationDispatchOptions
): EscrowState {
  const event = OUTCOME_EVENTS[outcome];
  if (event === undefined) {
    throw new Error(
      `invalid arbitration outcome: ${JSON.stringify(outcome)} (expected "release" or "refund")`
    );
  }
  if (note !== undefined && typeof note !== "string") {
    throw new Error(
      `invalid arbitration note: must be a string, got ${typeof note}`
    );
  }
  if (!quorum.hasQuorum()) {
    throw new Error(
      `arbitration requires quorum: ${quorum.approvalCount()}/${quorum.threshold} approvals`
    );
  }
  const quorumNote = `quorum ${quorum.approvalCount()}/${quorum.threshold}`;
  const fullNote = note === undefined ? quorumNote : `${note} [${quorumNote}]`;
  return escrow.dispatch(event, fullNote, undefined, opts);
}
