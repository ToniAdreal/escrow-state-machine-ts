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
    // Self-loop: top-ups are legal while the escrow is still FUNDED —
    // additional deposits add to the locked total (see
    // depositAmountFromHistory, which sums every FUND amount). A FUND
    // dispatched from any other state is still rejected.
    FUND: "FUNDED",
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

/**
 * Options accepted by {@link Escrow.dispatch}.
 */
export interface DispatchOptions {
  /**
   * Optional idempotency key (payments-style retry safety).
   *
   * The key must be a non-empty string. When a key has been seen before,
   * dispatch is a no-op: it returns the *current* state and appends nothing
   * to the audit history, without validating the transition (a duplicate
   * delivery must not fail just because the escrow has since moved on).
   *
   * Keys are global to the escrow instance, not per-event: the same key
   * with a different event is still treated as a duplicate.
   *
   * Keys are recorded only after a dispatch succeeds — a failed dispatch
   * (invalid transition, invalid amount) does not consume the key, so the
   * caller can retry the same key with corrected input.
   *
   * The seen-key set is in-memory only and is NOT part of
   * `toJSON()`/`fromJSON()`: after a restart the same key would execute
   * again, so callers that need cross-restart idempotency must reconcile
   * before replaying (e.g. compare against the persisted history).
   */
  idempotencyKey?: string;
}

/** Stateful escrow with an append-only audit history. */
export class Escrow {
  readonly id: string;
  private _state: EscrowState = "CREATED";
  private _history: EscrowHistoryEntry[] = [];
  private _seenIdempotencyKeys = new Set<string>();

  constructor(id: string) {
    // fromJSON validates the same rule; a live Escrow must never hold an id
    // its own snapshot validation would reject.
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("invalid escrow: id must be a non-empty string");
    }
    this.id = id;
  }

  get state(): EscrowState {
    return this._state;
  }

  /**
   * The append-only audit history. Each call returns a detached, frozen
   * snapshot: the array is `Object.freeze`d and each entry is a frozen
   * copy, so external callers can neither push/splice the array nor
   * rewrite entry fields — even by an accidental caller. dispatch()
   * remains the only way to append.
   */
  get history(): readonly EscrowHistoryEntry[] {
    return Object.freeze(this._history.map((e) => Object.freeze({ ...e })));
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
   * @param event  The event to dispatch. FUND from CREATED is the initial
   *               deposit; FUND from FUNDED is a top-up (self-loop) that adds
   *               to the locked total — see `depositAmountFromHistory`.
   * @param note   Optional human-readable note recorded in the audit history.
   *               A non-string note is rejected with a descriptive error
   *               before anything is appended (mirrors the fromJSON
   *               `note must be a string` rule).
   * @param amount Optional deposit amount, accepted ONLY on FUND. Must be a
   *               finite non-negative number (NaN, ±Infinity, negatives, and
   *               non-numbers are rejected with a descriptive error). The
   *               validated amount is recorded on the FUND history entry.
   * @param opts   Optional {@link DispatchOptions}. When `idempotencyKey`
   *               was seen before, dispatch is a no-op returning the current
   *               state; otherwise the key is recorded only after a
   *               successful dispatch.
   */
  dispatch(
    event: EscrowEvent,
    note?: string,
    amount?: number,
    opts?: DispatchOptions
  ): EscrowState {
    // Input validation fails fast, before idempotency dedup or transition
    // checks: invalid caller input must never reach the audit history, and
    // a broken caller must hear about it even when the transition itself
    // would be illegal (fail-fast beats transition-first here).
    if (note !== undefined && typeof note !== "string") {
      throw new Error(
        `invalid dispatch: note must be a string, got ${typeof note}`
      );
    }
    let idempotencyKey: string | undefined;
    if (opts !== undefined) {
      if (typeof opts !== "object" || opts === null || Array.isArray(opts)) {
        throw new Error("invalid dispatch options: opts must be an object");
      }
      idempotencyKey = opts.idempotencyKey;
      if (idempotencyKey !== undefined) {
        if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
          throw new Error(
            `invalid dispatch options: idempotencyKey must be a non-empty string, got ${String(
              idempotencyKey
            )}`
          );
        }
        if (this._seenIdempotencyKeys.has(idempotencyKey)) {
          return this._state; // duplicate delivery: no-op, no history append
        }
      }
    }
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
    if (idempotencyKey !== undefined) {
      this._seenIdempotencyKeys.add(idempotencyKey);
    }
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
