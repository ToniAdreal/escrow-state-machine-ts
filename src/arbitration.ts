/**
 * Wiring between the M-of-N approval quorum and the escrow state machine.
 *
 * `createQuorum` (src/quorum.ts) models only the counting rule — who has
 * approved — with no knowledge of the escrow. This module is the caller-side
 * orchestration that gates the arbitration transitions on that count:
 * arbitration dispatch requires the quorum to be reached, otherwise the
 * escrow is left completely untouched.
 *
 * Honesty note: by default the quorum records caller-trust approvals
 * (plain `approve()` performs no signature verification — see README
 * FAQ); `approveSigned()` verifies Ed25519 signatures only when the
 * caller registers public keys in `QuorumConfig.signerPublicKeys`.
 * Either way there is no key management and no DAO governance. This
 * module wires the *count* to the *dispatch*; it counts verified and
 * unverified approvals identically, and it does not make plain
 * approvals cryptographic.
 */

import {
  Escrow,
  MAX_NOTE_LENGTH,
  type DispatchOptions,
  type EscrowEvent,
  type EscrowState,
} from "./stateMachine.js";
import type { Quorum, QuorumStatementScope } from "./quorum.js";

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
 * Read a quorum's statement scope, if it reports one (backlog #1418).
 * `createQuorum` / `restoreQuorum` always provide `statementScope()`;
 * a duck-typed quorum without it is treated as unscoped (the legacy
 * behavior). A scope that is present but malformed fails closed
 * instead of being trusted — a hand-built quorum object must not be
 * able to smuggle a bogus scope past the gate.
 */
function readQuorumScope(quorum: Quorum): QuorumStatementScope | undefined {
  const statementScope = quorum.statementScope;
  if (statementScope === undefined) return undefined;
  if (typeof statementScope !== "function")
    throw new Error(
      `invalid dispatchArbitration: quorum statementScope must be a function, got ${typeof statementScope}`
    );
  const scope = statementScope.call(quorum);
  if (scope === undefined) return undefined;
  if (
    typeof scope !== "object" ||
    scope === null ||
    Array.isArray(scope) ||
    typeof (scope as QuorumStatementScope).escrowId !== "string" ||
    (scope as QuorumStatementScope).escrowId.length === 0 ||
    ((scope as QuorumStatementScope).outcome !== undefined &&
      (scope as QuorumStatementScope).outcome !== "release" &&
      (scope as QuorumStatementScope).outcome !== "refund" &&
      (scope as QuorumStatementScope).outcome !== "arbitration")
  )
    throw new Error(
      `invalid dispatchArbitration: quorum statementScope is malformed, got ${JSON.stringify(scope)}`
    );
  return scope as QuorumStatementScope;
}

/**
 * Dispatch an arbitration event only if the quorum has been reached.
 *
 * - Outcome must be `"release"` or `"refund"`; anything else throws a
 *   caller error (nothing is dispatched).
 * - `escrow` must be an `Escrow` and `quorum` a `Quorum` (an object
 *   with `hasQuorum()` / `approvalCount()` / `approvals()`); anything
 *   else throws `invalid dispatchArbitration: …` — a null or foreign
 *   object at the arbitration entry used to die as a bare `TypeError`
 *   (`reading 'dispatch'` / `reading 'hasQuorum'`), never as a caller
 *   error. The shape guard runs after the outcome/note validation
 *   above and before the quorum gate below, so an invalid outcome
 *   still reports its own error first and a below-threshold quorum
 *   still reports its own error for a well-formed escrow/quorum pair.
 *   The guard reads only the three `Quorum` methods this function
 *   itself calls, so a duck-typed quorum with exactly that surface
 *   still passes; anything missing a method fails here instead of
 *   crashing mid-message.
 * - Scope binding (backlog #1418): when the quorum reports a
 *   `statementScope()` (every quorum built by `createQuorum` /
 *   `restoreQuorum` does), the scope must name this escrow's id and,
 *   when an outcome is pinned, this outcome — an `"arbitration"`
 *   outcome or an absent one leaves the direction open. A mismatch
 *   throws `arbitration quorum scope mismatch: …` and the escrow is
 *   left untouched. The check runs after the shape guard above and
 *   before the quorum gate below. A duck-typed quorum without
 *   `statementScope()` is treated as unscoped (legacy behavior).
 * - If `quorum.hasQuorum()` is false, throws
 *   `arbitration requires quorum: <approvals>/<threshold> approvals` and
 *   the escrow's state and history are left unchanged — the failed gating
 *   never touches the audit log.
 * - On success, dispatches `ARBITRATE_RELEASE` / `ARBITRATE_REFUND` and
 *   automatically records `quorum <approvals>/<threshold> [signer, …]`
 *   in the audit note (appended after the caller's own note when one is
 *   given). The signer list names the approvals that actually counted
 *   toward the threshold — `quorum.approvals()`, in approval-time
 *   order, deduplicated, with expired approvals (see
 *   `maxApprovalAgeMs`) excluded — so the append-only history alone
 *   proves *who* approved, not just how many. A caller that drops
 *   the `Quorum` object after dispatching loses nothing: the audit
 *   trail still carries the voter list.
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
 * - The quorum suffix is appended *before* the dispatch, so a caller
 *   note that is legal on its own can still overflow the escrow's
 *   {@link MAX_NOTE_LENGTH} ceiling once the ` [quorum n/m […]]`
 *   suffix is added. The merged length is checked here — after the
 *   quorum gate — and an overflow throws
 *   `arbitration note too long: caller note <n> chars plus quorum
 *   suffix <m> chars exceeds MAX_NOTE_LENGTH <limit>`, naming the
 *   suffix as the cause instead of letting the dispatch blame the
 *   caller's note with its generic message. The escrow is left
 *   untouched, so the caller can shorten the note and retry.
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
  if (!(escrow instanceof Escrow)) {
    throw new Error(
      `invalid dispatchArbitration: escrow must be an Escrow, got ${escrow === null ? "null" : typeof escrow}`
    );
  }
  if (
    quorum === null ||
    typeof quorum !== "object" ||
    typeof quorum.hasQuorum !== "function" ||
    typeof quorum.approvalCount !== "function" ||
    typeof quorum.approvals !== "function"
  ) {
    throw new Error(
      `invalid dispatchArbitration: quorum must be a Quorum, got ${quorum === null ? "null" : typeof quorum}`
    );
  }
  // Scope binding (backlog #1418): a quorum configured with a
  // statementScope only votes for that escrow — and, when the outcome
  // is pinned, only for that outcome ("arbitration" or an absent
  // outcome leaves the direction open). Checked before the quorum
  // gate, so a quorum scoped to another escrow can never release
  // this one even if its count was reached; the escrow is left
  // untouched on a mismatch.
  const scope = readQuorumScope(quorum);
  if (scope !== undefined) {
    if (scope.escrowId !== escrow.id)
      throw new Error(
        `arbitration quorum scope mismatch: quorum is scoped to escrow ${JSON.stringify(scope.escrowId)} but dispatch targets escrow ${JSON.stringify(escrow.id)}`
      );
    if (
      scope.outcome !== undefined &&
      scope.outcome !== "arbitration" &&
      scope.outcome !== outcome
    )
      throw new Error(
        `arbitration quorum scope mismatch: quorum is scoped to outcome ${JSON.stringify(scope.outcome)} but dispatch outcome is ${JSON.stringify(outcome)}`
      );
  }
  if (!quorum.hasQuorum()) {
    throw new Error(
      `arbitration requires quorum: ${quorum.approvalCount()}/${quorum.threshold} approvals`
    );
  }
  const signers = quorum.approvals();
  const quorumNote = `quorum ${quorum.approvalCount()}/${quorum.threshold} [${signers.join(", ")}]`;
  const fullNote = note === undefined ? quorumNote : `${note} [${quorumNote}]`;
  // The suffix is library-appended, so a caller note that fits on its
  // own can overflow once the suffix is added. Check the merged length
  // here — after the quorum gate, before any dispatch — and blame the
  // suffix explicitly instead of the dispatch's generic note error.
  const callerNoteLength = note === undefined ? 0 : note.length;
  const suffixLength = fullNote.length - callerNoteLength;
  if (fullNote.length > MAX_NOTE_LENGTH) {
    throw new Error(
      `arbitration note too long: caller note ${callerNoteLength} chars plus quorum suffix ${suffixLength} chars exceeds MAX_NOTE_LENGTH ${MAX_NOTE_LENGTH}`
    );
  }
  return escrow.dispatch(event, fullNote, undefined, opts);
}
