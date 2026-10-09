import {
  Escrow,
  parseEscrowHistory,
  type AuditKey,
  type EscrowHistoryEntry,
} from "./stateMachine.js";

/**
 * NDJSON audit-log export / import.
 *
 * A snapshot (`toJSON()`/`fromJSON()`) carries state + history + the
 * escrow's configuration in one JSON envelope. Sometimes only the log
 * itself should travel: streaming it to disk, appending it line by
 * line, or feeding it to a log pipeline for reconciliation. NDJSON —
 * one canonical JSON object per line, line order = `seq` order — is
 * that transport. The division of labour:
 *
 *   snapshot = escrow state + audit log + configuration (restore)
 *   NDJSON   = audit log only (stream / ship / archive)
 *
 * Export (`historyToNdjson`) runs the entries through the same strict
 * `parseEscrowHistory` validation the snapshot parser enforces, so a
 * malformed history fails loudly instead of producing a file that
 * could never be re-imported. Every line ends with `\n`, including
 * the last one (a fixed rule, so exports are byte-stable: export →
 * import → export yields the identical string). An empty history
 * exports to the empty string.
 *
 * Import (`historyFromNdjson`) is strict in the other direction:
 *  - empty or whitespace-only input throws — unlike an empty history
 *    *value*, an empty NDJSON *document* is a truncated or missing
 *    log, not a log of zero events (same choice as the dataquest
 *    lifecycle's NDJSON module);
 *  - a line that is not valid JSON throws naming its 1-based line
 *    number (`invalid ndjson: line 7: not valid JSON`);
 *  - the parsed entries then go through `parseEscrowHistory`, i.e.
 *    exactly the snapshot parser's bar: seq from 1 with no gaps,
 *    from/to chain continuous, every edge legal, hash chain
 *    re-verified via `verifyHistoryChain` semantics — a tampered,
 *    deleted, or reordered line throws instead of being repaired;
 *  - CRLF input is accepted: a trailing `\r` is stripped from each
 *    line before parsing (log shippers on Windows produce CRLF; the
 *    entries themselves are identical either way). Blank lines are
 *    skipped, and line numbers always count physical lines.
 *
 * Keyed histories (produced by an escrow constructed with
 * `EscrowOptions.auditKey`) travel as-is — every line carries its
 * `prevHash`/`hash` HMAC links — but validation is keyed too: pass
 * the same key as the second argument, or the chain check fails
 * closed as a broken chain. The key itself is never written into
 * the NDJSON text.
 *
 * The log carries no escrow id and no configuration (deadline,
 * idempotency keys, RBAC policy) — those live in the snapshot
 * envelope. To rebuild a working escrow from imported entries, wrap
 * them: `Escrow.fromJSON({ id, state: lastEntry.to, history })`;
 * the entries can also feed pure history consumers such as
 * `buildSettlementReport` directly.
 */

/**
 * Export an audit history as NDJSON: one canonical JSON entry per
 * line, terminated by a trailing newline. Accepts either a live
 * {@link Escrow} (exports its current history) or a raw entries
 * array (validated exactly like `parseEscrowHistory` first).
 *
 * An empty history exports to the empty string.
 */
export function historyToNdjson(
  source: Escrow | readonly EscrowHistoryEntry[],
  auditKey?: AuditKey
): string {
  const raw: unknown =
    source instanceof Escrow ? [...source.history] : source;
  const entries = parseEscrowHistory(raw, auditKey);
  if (entries.length === 0) return "";
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

/**
 * Parse NDJSON text into a validated audit history. Throws
 * `invalid ndjson: …` on empty input, on a non-JSON line (naming
 * its 1-based line number), and on any entry that fails the
 * `parseEscrowHistory` integrity checks (entry errors are retagged
 * with the physical line that carried the entry).
 *
 * The returned entries are fresh, sanitized copies — safe to hand
 * to `Escrow.fromJSON` (wrapped in an envelope) or to pure history
 * consumers such as `buildSettlementReport`.
 */
export function historyFromNdjson(
  text: string,
  auditKey?: AuditKey
): EscrowHistoryEntry[] {
  if (typeof text !== "string") {
    throw new Error("invalid ndjson: input must be a string");
  }
  const values: unknown[] = [];
  const lineOf: number[] = []; // lineOf[entryIndex] = 1-based line number
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "").trim();
    if (line === "") continue;
    try {
      values.push(JSON.parse(line));
    } catch {
      throw new Error(`invalid ndjson: line ${i + 1}: not valid JSON`);
    }
    lineOf.push(i + 1);
  }
  if (values.length === 0) {
    throw new Error(
      "invalid ndjson: input is empty (no history entries)"
    );
  }
  try {
    return parseEscrowHistory(values, auditKey);
  } catch (err) {
    throw retagLine(err, lineOf);
  }
}

/**
 * Rewrite a snapshot-parser error for the NDJSON boundary:
 * `invalid snapshot: history[N]: …` becomes
 * `invalid ndjson: line <physical line>: …` (blank lines make the
 * entry index and the line number diverge), and any other
 * `invalid snapshot: …` failure (e.g. a broken hash chain, which is
 * a property of the whole log, not one entry) becomes
 * `invalid ndjson: …` with the rest of the message unchanged.
 */
function retagLine(err: unknown, lineOf: number[]): Error {
  const message = err instanceof Error ? err.message : String(err);
  const entryMatch =
    /^invalid snapshot: history\[(\d+)\]: ([\s\S]*)$/.exec(message);
  if (entryMatch !== null) {
    const line = lineOf[Number(entryMatch[1])];
    if (line !== undefined) {
      return new Error(`invalid ndjson: line ${line}: ${entryMatch[2]}`);
    }
  }
  if (message.startsWith("invalid snapshot: ")) {
    return new Error(
      `invalid ndjson: ${message.slice("invalid snapshot: ".length)}`
    );
  }
  return err instanceof Error ? err : new Error(message);
}
