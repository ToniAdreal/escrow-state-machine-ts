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

import { Escrow, type EscrowEvent, type EscrowState } from "./stateMachine.js";
import type { Quorum } from "./quorum.js";

/** The two arbitration outcomes the DISPUTED state can reach. */
export type ArbitrationOutcome = "release" | "refund";

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
 *
 * The escrow's own transition rules still apply: calling from a state
 * other than DISPUTED fails with the usual `invalid transition` error —
 * a reached quorum does not override the state machine.
 */
export function dispatchArbitration(
  escrow: Escrow,
  quorum: Quorum,
  outcome: ArbitrationOutcome,
  note?: string
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
  return escrow.dispatch(event, fullNote);
}
