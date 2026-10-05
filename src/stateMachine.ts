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

export interface TransitionEdge {
  from: EscrowState;
  event: EscrowEvent;
  to: EscrowState;
}

/**
 * Every (from, event, to) edge of the transition table, in declaration order.
 * Single source of truth for docs/diagrams that must stay in sync with code
 * (see README's mermaid state diagram, verified by test/stateDiagram.test.ts).
 */
export function transitionTable(): TransitionEdge[] {
  const edges: TransitionEdge[] = [];
  for (const from of Object.keys(TRANSITIONS) as EscrowState[]) {
    const row = TRANSITIONS[from];
    for (const event of Object.keys(row) as EscrowEvent[]) {
      edges.push({ from, event, to: row[event]! });
    }
  }
  return edges;
}

export interface EscrowHistoryEntry {
  seq: number;
  event: EscrowEvent;
  from: EscrowState;
  to: EscrowState;
  at: string; // ISO timestamp
  note?: string;
  /**
   * Deposit amount in base currency units. Only present on FUND entries
   * (dispatch validates it as a finite non-negative number).
   */
  amount?: number;
}

/**
 * Serializable snapshot of an escrow: id + live state + append-only audit
 * history. Plain JSON (no class instances), safe to store in any document
 * store and feed back into Escrow.fromJSON().
 */
export interface EscrowSnapshot {
  id: string;
  state: EscrowState;
  history: EscrowHistoryEntry[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const ESCROW_STATES = new Set<EscrowState>(
  Object.keys(TRANSITIONS) as EscrowState[]
);
const ESCROW_EVENTS = new Set<EscrowEvent>(
  Object.values(TRANSITIONS).flatMap((row) => Object.keys(row)) as EscrowEvent[]
);

function isCanonicalIso(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const ms = Date.parse(s);
  return !Number.isNaN(ms) && new Date(ms).toISOString() === s;
}

/**
 * Parse and strictly validate an untrusted value into an EscrowSnapshot.
 *
 * Throws with a specific message on the first problem found:
 *  - not an object / missing or empty id / unknown state
 *  - history entry shape violations (seq, event, from, to, at)
 *  - seq must restart at 1 and increment by 1 with no gaps
 *  - the from/to chain must be continuous, start at CREATED, and land on
 *    the snapshot's state
 *  - every (from, event) -> to edge must be a legal transition edge
 *  - timestamps must be canonical ISO-8601 and non-decreasing
 *  - `amount`, when present, must be a finite non-negative number and may
 *    only appear on FUND entries
 *  - `note`, when present, must be a string
 *
 * Anything produced by toJSON() passes; anything else must earn its way.
 */
function parseEscrowSnapshot(snapshot: unknown): EscrowSnapshot {
  if (!isRecord(snapshot)) {
    throw new Error("invalid snapshot: expected a JSON object");
  }
  if (typeof snapshot.id !== "string" || snapshot.id.length === 0) {
    throw new Error("invalid snapshot: id must be a non-empty string");
  }
  if (!ESCROW_STATES.has(snapshot.state as EscrowState)) {
    throw new Error(`invalid snapshot: unknown state ${String(snapshot.state)}`);
  }
  const state = snapshot.state as EscrowState;
  const id = snapshot.id;

  if (!Array.isArray(snapshot.history)) {
    throw new Error("invalid snapshot: history must be an array");
  }
  const history: EscrowHistoryEntry[] = [];
  for (let i = 0; i < snapshot.history.length; i++) {
    const raw = snapshot.history[i];
    const tag = `invalid snapshot: history[${i}]`;
    if (!isRecord(raw)) throw new Error(`${tag}: entry must be an object`);
    if (raw.seq !== i + 1) {
      throw new Error(`${tag}: seq must be ${i + 1}, got ${String(raw.seq)}`);
    }
    if (!ESCROW_EVENTS.has(raw.event as EscrowEvent)) {
      throw new Error(`${tag}: unknown event ${String(raw.event)}`);
    }
    if (!ESCROW_STATES.has(raw.from as EscrowState)) {
      throw new Error(`${tag}: unknown from-state ${String(raw.from)}`);
    }
    if (!ESCROW_STATES.has(raw.to as EscrowState)) {
      throw new Error(`${tag}: unknown to-state ${String(raw.to)}`);
    }
    if (!isCanonicalIso(raw.at)) {
      throw new Error(
        `${tag}: at must be canonical ISO-8601, got ${String(raw.at)}`
      );
    }
    const event = raw.event as EscrowEvent;
    const from = raw.from as EscrowState;
    const to = raw.to as EscrowState;
    if (i === 0 && from !== "CREATED") {
      throw new Error(`${tag}: chain must start at CREATED, got ${from}`);
    }
    if (i > 0) {
      const prev = history[i - 1];
      if (from !== prev.to) {
        throw new Error(
          `${tag}: from ${from} does not continue previous to ${prev.to}`
        );
      }
      if (Date.parse(raw.at) < Date.parse(prev.at)) {
        throw new Error(`${tag}: timestamps must be non-decreasing`);
      }
    }
    const legal = (TRANSITIONS[from] as Partial<Record<EscrowEvent, EscrowState>>)[
      event
    ];
    if (legal !== to) {
      throw new Error(`${tag}: ${event} from ${from} cannot lead to ${to}`);
    }
    const entry: EscrowHistoryEntry = {
      seq: i + 1,
      event,
      from,
      to,
      at: raw.at,
    };
    if (raw.note !== undefined) {
      if (typeof raw.note !== "string") {
        throw new Error(`${tag}: note must be a string`);
      }
      entry.note = raw.note;
    }
    if (raw.amount !== undefined) {
      if (event !== "FUND") {
        throw new Error(`${tag}: amount only allowed on FUND entries`);
      }
      if (
        typeof raw.amount !== "number" ||
        !Number.isFinite(raw.amount) ||
        raw.amount < 0
      ) {
        throw new Error(
          `${tag}: amount must be a finite non-negative number`
        );
      }
      entry.amount = raw.amount;
    }
    history.push(entry);
  }

  if (history.length > 0) {
    const last = history[history.length - 1];
    if (last.to !== state) {
      throw new Error(
        `invalid snapshot: history ends at ${last.to} but state is ${state}`
      );
    }
  } else if (state !== "CREATED") {
    throw new Error(
      `invalid snapshot: empty history but state is ${state} (expected CREATED)`
    );
  }

  return { id, state, history };
}

/**
 * Boundary check for monetary inputs: must be a finite, non-negative number.
 * Throws a descriptive Error on anything else (negative, NaN, ±Infinity,
 * non-number), so invalid caller input fails fast instead of silently
 * poisoning downstream accounting.
 */
export function assertNonNegativeMoney(name: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number`);
  }
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

  /**
   * Move the escrow through a state transition.
   *
   * @param event  The event to dispatch.
   * @param note   Optional human-readable note recorded in the audit history.
   * @param amount Optional deposit amount, accepted ONLY on FUND. Must be a
   *               finite non-negative number (NaN, ±Infinity, negatives, and
   *               non-numbers are rejected with a descriptive error). The
   *               validated amount is recorded on the FUND history entry.
   */
  dispatch(event: EscrowEvent, note?: string, amount?: number): EscrowState {
    if (amount !== undefined && event !== "FUND") {
      throw new Error(
        `amount is only accepted on FUND, not on ${event}`
      );
    }
    const from = this._state;
    const to = transition(from, event); // throws on invalid transition
    if (event === "FUND" && amount !== undefined) {
      assertNonNegativeMoney("amount", amount);
    }
    this._state = to;
    this._history.push({
      seq: this._history.length + 1,
      event,
      from,
      to,
      at: new Date().toISOString(),
      note,
      ...(event === "FUND" && amount !== undefined ? { amount } : {}),
    });
    return to;
  }

  /**
   * Export a serializable snapshot (id + live state + history) for
   * persistence. The returned object is a deep copy: mutating it does not
   * affect the escrow, and JSON.stringify(escrow) goes through this method.
   */
  toJSON(): EscrowSnapshot {
    return {
      id: this.id,
      state: this._state,
      history: this._history.map((e) => ({ ...e })),
    };
  }

  /**
   * Rebuild an Escrow from an untrusted snapshot. The input is strictly
   * validated (see parseEscrowSnapshot); malformed snapshots throw with a
   * descriptive `invalid snapshot: ...` error instead of producing a
   * corrupt escrow.
   */
  static fromJSON(snapshot: unknown): Escrow {
    const parsed = parseEscrowSnapshot(snapshot);
    const escrow = new Escrow(parsed.id);
    escrow._state = parsed.state;
    escrow._history = parsed.history;
    return escrow;
  }
}
