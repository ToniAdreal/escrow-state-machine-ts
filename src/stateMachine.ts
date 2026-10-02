/**
 * Deterministic escrow fund-release state machine.
 *
 * Reproduces the milestone-escrow mechanics from the ALLWEB3 portfolio case
 * study: funds are locked on campaign creation, released when oracle/KPI
 * verification passes, and routed to DAO arbitration (5/9 multi-sig in the
 * case study) on dispute. Every transition is explicit; invalid transitions
 * throw. An append-only history gives the "immutable operational audit log".
 */

export type EscrowState =
  | "CREATED"
  | "FUNDED"
  | "MILESTONE_SUBMITTED"
  | "VERIFIED"
  | "DISPUTED"
  | "RELEASED"
  | "REFUNDED"
  | "EXPIRED";

export type EscrowEvent =
  | "FUND"
  | "SUBMIT_MILESTONE"
  | "VERIFY_PASS"
  | "VERIFY_FAIL"
  | "RELEASE"
  | "DISPUTE"
  | "ARBITRATE_RELEASE"
  | "ARBITRATE_REFUND"
  | "EXPIRE";

const TRANSITIONS: Record<
  EscrowState,
  Partial<Record<EscrowEvent, EscrowState>>
> = {
  CREATED: { FUND: "FUNDED", EXPIRE: "EXPIRED" },
  FUNDED: {
    SUBMIT_MILESTONE: "MILESTONE_SUBMITTED",
    DISPUTE: "DISPUTED",
    EXPIRE: "EXPIRED",
  },
  MILESTONE_SUBMITTED: {
    VERIFY_PASS: "VERIFIED",
    VERIFY_FAIL: "DISPUTED",
    DISPUTE: "DISPUTED",
    EXPIRE: "EXPIRED",
  },
  VERIFIED: { RELEASE: "RELEASED", DISPUTE: "DISPUTED" },
  DISPUTED: {
    ARBITRATE_RELEASE: "RELEASED",
    ARBITRATE_REFUND: "REFUNDED",
  },
  RELEASED: {},
  REFUNDED: {},
  EXPIRED: {},
};

/** Pure transition function: current state + event -> next state. */
export function transition(state: EscrowState, event: EscrowEvent): EscrowState {
  const next = TRANSITIONS[state][event];
  if (!next) throw new Error(`invalid transition: ${event} from ${state}`);
  return next;
}

/** Events allowed from a state (for UI gating). */
export function allowedEvents(state: EscrowState): EscrowEvent[] {
  return Object.keys(TRANSITIONS[state]) as EscrowEvent[];
}

export interface EscrowHistoryEntry {
  seq: number;
  event: EscrowEvent;
  from: EscrowState;
  to: EscrowState;
  at: string; // ISO timestamp
  note?: string;
}

/** Stateful escrow with an append-only audit history. */
export class Escrow {
  readonly id: string;
  private _state: EscrowState = "CREATED";
  private _history: EscrowHistoryEntry[] = [];

  constructor(id: string) {
    this.id = id;
  }

  get state(): EscrowState {
    return this._state;
  }

  get history(): readonly EscrowHistoryEntry[] {
    return this._history;
  }

  get isTerminal(): boolean {
    return (
      this._state === "RELEASED" ||
      this._state === "REFUNDED" ||
      this._state === "EXPIRED"
    );
  }

  dispatch(event: EscrowEvent, note?: string): EscrowState {
    const from = this._state;
    const to = transition(from, event); // throws on invalid transition
    this._state = to;
    this._history.push({
      seq: this._history.length + 1,
      event,
      from,
      to,
      at: new Date().toISOString(),
      note,
    });
    return to;
  }
}
