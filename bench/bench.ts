/**
 * Local micro-benchmark for the escrow-state-machine-ts state machine.
 *
 * Measures real, locally-observed throughput for the hot paths a
 * batch escrow reconciliation / watchdog deployment actually hammers:
 *
 *   1. dispatch — one full CREATED -> RELEASED lifecycle (4 dispatches,
 *      each appending a hash-chained audit entry) on a fresh escrow;
 *   2. `verifyHistoryChain(history)` — full SHA-256 hash-chain
 *      re-verification of that fixed history. The timed path's
 *      per-iteration self-check pins the linkage that verdict
 *      rests on (see the verifyHistoryChain linkage fixture
 *      below): the first entry's `prevHash` is
 *      `GENESIS_PREV_HASH`, every later entry's `prevHash` is
 *      its predecessor's `hash`, and a detached tampered copy
 *      (a middle entry's note rewritten) returns `false` once,
 *      outside the timed loop.
 *   3. `buildSettlementReport(...)` — settlement accounting derived
 *      from the audit history (which itself re-verifies the chain);
 *   4. settlement webhook build / verify — `buildSettlementWebhook`
 *      (HMAC-SHA256 signing) and `verifySettlementWebhook` over the
 *      signed body;
 *   5. `buildSettlementReports(...)` — the batch settlement-reporting
 *      path a reconciliation job actually runs: one call over a fixed
 *      batch of 4 inputs (released / refunded / released, each a
 *      4-entry history comparable to the single-report fixture, plus
 *      one deliberately mismatched input whose report must land as a
 *      per-item `{ escrowId, error }` without aborting the batch).
 *      This measures the per-item try/catch and order-preserving
 *      mapping overhead the single-report path never exercises;
 *   6. NDJSON export / import — `historyToNdjson` (validated export)
 *      and `historyFromNdjson` (per-line JSON parsing interleaved with
 *      a full `parseEscrowHistory` hash-chain re-verification) over a
 *      fixed 8-entry chained history: the same lifecycle funded in
 *      five staged FUND dispatches (initial deposit + four top-ups
 *      summing to the golden 10,630), then milestone, verification,
 *      and release. This is the line-oriented audit-log transport a
 *      batch reconciliation / forwarding pipeline streams, shaped
 *      comparably to the dataquest lifecycle's 8-entry NDJSON bench;
 *   7. quorum approval — `createQuorum` with a fixed 9-signer set and
 *      threshold 5 (the 5/9 multi-sig arbitration shape), approving
 *      one signer at a time until the threshold is reached and calling
 *      `hasQuorum()` after each vote. This is the pre-check
 *      `dispatchArbitration` runs before any arbitration dispatch, so
 *      its per-vote accumulation cost is on the arbitration hot path.
 *   8. settlement webhook fan-out delivery —
 *      `deliverSettlementWebhookToMany()` to 4 fixed endpoints, each
 *      with its own signing secret, through a fake `fetch` installed
 *      on `globalThis` (this library's delivery layer calls the
 *      global `fetch`; the fake records each call and answers 200
 *      immediately). Zero network: the numbers measure the library's
 *      fan-out overhead only — not network throughput;
 *   9. settlement event dedupe — `SettlementEventDedupe.checkAndRecord()`
 *      duplicate hits cycling over 1,000 `eventId`s pre-recorded under
 *      an injected fixed clock, so no entry can expire or be evicted
 *      during the timed loop: the measured path is the pure
 *      steady-state duplicate hit, LRU recency refresh included;
 *  10. event-sourced replay — `Escrow.fromHistory(id, history)`
 *      rebuilding a live escrow from the same detached 4-entry chained
 *      history fixture the dispatch path produces (full
 *      `parseEscrowHistory` validation + hash-chain re-verification +
 *      state derivation on every call). This is the rebuild a
 *      reconciliation holder of a bare audit log pays per escrow.
 *      The fixture ends RELEASED (terminal, no legal next event), so
 *      the continuation self-check outside the timed loop rebuilds
 *      from the fixture's 3-entry VERIFIED prefix and dispatches the
 *      fixture's own RELEASE step: the rebuilt history must then
 *      equal the full fixture entry for entry, seq 1-4 with no gap.
 *      The timed path's per-iteration self-check pins the rebuild
 *      fidelity itself (see the fromHistory fidelity fixture below):
 *      the rebuilt escrow's id and state and every history entry
 *      field for field — `hash` / `prevHash` chain included,
 *      compared field-wise and through the canonical NDJSON
 *      serializer — and a detached tampered copy (the FUND entry's
 *      amount altered) is rejected with the hash-chain error once,
 *      outside the timed loop.
 *  11. settlement batch summary — `summarizeSettlementReports(results)`
 *      aggregating the batch path's fixed 4-item result list (built
 *      once, outside the timed loop) into outcome counts, deposit /
 *      inflow / outflow totals, and per-party nets: the day-end
 *      reconciliation roll-up a settlement holder runs over a whole
 *      batch after the per-item reports are built. The summarizer is
 *      pure (it only reads the results), so the same pre-built result
 *      list is re-summarized on every iteration.
 *  12. settlement batch webhook building — `buildSettlementWebhooks(
 *      results, ...)` over that same fixed 4-item result list (built
 *      once, outside the timed loop): the second half of the day-end
 *      pipeline, batch reports -> batch webhooks. The 3 successful
 *      reports are signed under the shared bench secret at the shared
 *      fixed `WEBHOOK_NOW`, each with a DISTINCT `eventId` from a
 *      deterministic counter factory (fresh per iteration, so the
 *      expected ids are hand-known: bench-batch-event-1..3, in input
 *      order); the batch's one per-item error entry is forwarded as
 *      `{ escrowId, error }` untouched and consumes no `eventId`.
 *      Every built webhook is re-verified with
 *      `verifySettlementWebhook` on every iteration.
 *  13. watchdog screening — `expiredEscrows(escrows, fixedNow)` and
 *      `staleEscrows(escrows, maxAgeByState, fixedNow)` over one fixed
 *      mixed batch of 100 escrows (composition hand-counted in the
 *      fixture comment below: 40 past-deadline non-terminal, 70 stale
 *      under the bench budgets). This is the periodic poll the README
 *      documents as the production watchdog wiring; both filters are
 *      pure, so the same batch is re-screened on every iteration and
 *      each result is checked against the hand-counted expected id
 *      list (in batch order) on every iteration.
 *  14. quorum snapshot restore — `restoreQuorum(config, snapshot)`
 *      rebuilding a live quorum from a persisted snapshot (the JSON
 *      round-tripped form of `snapshot()`), over the bench's fixed
 *      9-signer / threshold-5 quorum shape carrying 7 recorded
 *      approvals (dao-1..dao-7, one second apart on the fixed
 *      clock). This is the restart path an arbitration service runs
 *      for every undecided quorum at startup: strict snapshot
 *      validation (signer set, threshold, per-entry audit-trail
 *      re-checks) plus the rebuild, on every call. The restored
 *      quorum is checked against hand-written expectations (quorum
 *      reached, 7 counted approvals in record order, 7 audit-log
 *      entries) on every iteration.
 *  15. release settlement netting — `settleRelease(inputs)` over one
 *      fixed set of 4 representative inputs (composition and
 *      hand-computed expectations in the fixture comment below: the
 *      golden-deposit case at the case study's 5% fee, a mid-size
 *      case with referral credits, one large-gross case, and one
 *      half-cent bps rounding edge). This is the amount origin of
 *      the whole settlement chain — gross minus pro fee (bps, via
 *      round2) minus referral credits, with the negative-net guard —
 *      that every report / webhook path downstream starts from, and
 *      the one step that previously had no measured baseline. Every
 *      timed iteration checks each result's proFee / net against
 *      the hand-written expectations (never re-derived through the
 *      implementation under test).
 *  16. watchdog execution — `expireOverdueEscrows(escrows, fixedNow)`
 *      and `actOnStaleEscrows(escrows, action, budgets, fixedNow)`
 *      with the production action `(e) => e.dispatch("EXPIRE")`, over
 *      the SAME mixed batch of 100 escrows as the screening paths —
 *      but rebuilt fresh on every iteration, because the executors
 *      mutate the escrows they act on (each successful EXPIRE
 *      dispatch appends a hash-chained audit entry). The rebuild
 *      cost is therefore inside the timed region, unlike screening.
 *      Hand-counted from the fixture composition and the transition
 *      table (never derived by calling the executors):
 *      expireOverdueEscrows attempts the 40 expired ids and ALL 40
 *      succeed (FUNDED and MILESTONE_SUBMITTED both carry an EXPIRE
 *      edge), ending EXPIRED with one extra audit entry each;
 *      actOnStaleEscrows attempts the 70 stale ids and ALL 70
 *      EXPIRE actions succeed for the same reason. Every timed
 *      iteration checks result ids in batch order, the success
 *      flags, the absence of errors, the post-states, and the
 *      appended EXPIRE audit entries against those expectations.
 *      (The executors dispatch EXPIRE without an injectable audit
 *      timestamp, so the bench checks states / flags / history
 *      shape — never the appended entry's timestamp, and the
 *      selections themselves use only the injected fixed `now`.)
 *  17. settlement event dedupe snapshot restore —
 *      `SettlementEventDedupe.restore(snapshot)` rebuilding a
 *      receiver-side dedupe from a persisted snapshot (the JSON
 *      round-tripped form of `exportSnapshot()`), over a fixed
 *      1,000-entry snapshot (see the restore fixture below for its
 *      composition and the hand-written expectations). This is the
 *      restart path a settlement receiver runs at startup before
 *      the first duplicate check: strict snapshot validation plus
 *      the rebuild, on every call. The restored dedupe is checked
 *      against hand-written expectations (1,000 live entries,
 *      observability counters restarting at zero, spot-checked
 *      first / middle / last ids all duplicates) on every
 *      iteration, and exhaustively (all 1,000 ids) once outside
 *      the timed loop.
 *  18. retry-after parsing — `parseRetryAfter(value, nowMs)` over
 *      a fixed 11-value corpus (delay-seconds, a fractional
 *      delay-seconds, a whitespace-padded value, zero, a future
 *      HTTP-date, a past HTTP-date, signed numbers, a garbage
 *      string, and null / undefined), always against the same
 *      injected fixed `nowMs`. This is the parse every 429
 *      settlement-webhook response pays before the retry delay is
 *      chosen, previously visible only inside the end-to-end
 *      delivery numbers. Every timed iteration re-checks each
 *      parsed result against the hand-pinned expectations in the
 *      corpus comment below.
 *  19. funded-total summation — `depositAmountFromHistory(history,
 *      escrowId)` over a fixed 4-shape corpus (a single FUND, a
 *      two-FUND top-up sequence, a FUND recorded without an amount,
 *      and a history with no FUND at all; composition and
 *      hand-pinned totals / error messages in the fixture comment
 *      below). This is the audit-trail scan every settlement
 *      reconciliation pays per escrow to establish the locked
 *      total (top-ups included) before any report math runs,
 *      previously visible only inside the `buildSettlementReport`
 *      numbers. Every timed iteration re-checks each returned
 *      total against its hand-written expectation and each
 *      fail-fast shape against its exact hand-written error
 *      message.
 *  20. settlement report rendering — `renderReport(report)` over
 *      the fixed golden released report built once outside the
 *      timed loop (deposit 10,630, released via
 *      VERIFY_PASS -> RELEASE, 4 party rows). This is the final
 *      day-end reconciliation step that turns a report into the
 *      fixed-width text ledger a human reads — per-party
 *      inflow / outflow / net rows plus the deposit formula line —
 *      previously visible only inside the `buildSettlementReport`
 *      numbers. Every timed iteration re-checks the rendered text
 *      against hand-written expected lines (header / outcome,
 *      deposit formula, and one party's net row).
 *  21. allowed-events lookup — `allowedEvents(state)` over all
 *      8 states of the transition table (one pass = every state
 *      queried once, in declaration order). This is the per-row
 *      primitive a UI or watchdog pays to decide what an escrow
 *      can do next — the demo's no-dead-end narrative and the
 *      state diagram both rest on it — previously visible only
 *      inside the dispatch numbers. Expected event lists are
 *      hand-pinned in the fixture comment below (declaration
 *      order; the three terminal states expect the empty list),
 *      and every timed iteration re-checks each state's result
 *      against them. (The backlog item that commissioned this
 *      path said "all 6 states"; the table in fact declares 8 —
 *      this path covers all 8.)
 *  22. fee calculation — `calculateDeposit(inputs)` over a fixed
 *      3-shape corpus (the golden vector, a complexity-multiplier
 *      case, and a large-pool case; composition and hand-computed
 *      `adjustedBaseFee` / `deposit` expectations in the fixture
 *      comment below). This is the deposit preview every escrow
 *      funding pays first — deposit = creatorPool + baseFee x
 *      complexityMultiplier - loyaltyDiscount + oracleFee, with
 *      per-field money validation and `round2` on both derived
 *      figures — previously visible only as one fixture-construction
 *      call at module scope. Every timed iteration re-checks each
 *      returned breakdown against its hand-written expectation.
 *  23. arbitration dispatch — `dispatchArbitration(escrow, quorum,
 *      "refund")` over a fixed DISPUTED escrow and a threshold-reached
 *      5/9 quorum: the combined cost of the `hasQuorum()` gate, the
 *      `Escrow.dispatch` transition, the hash-chained audit entry
 *      append, and the quorum-count note assembly that every disputed
 *      escrow pays once the vote reaches threshold. Because the
 *      dispatch mutates the escrow, every iteration rebuilds both
 *      sides from fixed prefixes first — the escrow via
 *      `Escrow.fromHistory` from its detached 2-entry prefix
 *      (FUND 10,630 at BASE, then DISPUTE at BASE + 1s) and the
 *      quorum via `createQuorum` approving dao-1..dao-5 on the
 *      fixed clock — so the reported number INCLUDES that rebuild
 *      cost and is a conservative lower bound on the dispatch-only
 *      throughput, the same accounting the watchdog-execution paths
 *      use. The dispatch itself is pinned to a fixed audit
 *      timestamp (BASE + 2s), so no wall clock enters the checks.
 *      Every timed iteration checks the returned and stored state
 *      is REFUNDED, the history grew by exactly one entry, and that
 *      entry is the ARBITRATE_REFUND from DISPUTED carrying the
 *      hand-pinned note `quorum 5/5`.
 *  24. deadline judgement — `isOverdue(escrow, now)` over a fixed
 *      4-case corpus (a past-deadline FUNDED escrow, a
 *      future-deadline FUNDED escrow, a deadline-less FUNDED
 *      escrow, and a past-deadline terminal RELEASED escrow),
 *      always against one injected fixed `now`. This is the
 *      per-escrow primitive the watchdog screening paths pay for
 *      every escrow in a batch — `expiredEscrows` is this check
 *      over a list — previously visible only inside the batch-100
 *      screening numbers. The function is pure (it reads the
 *      deadline and the terminal flag, never mutates or
 *      dispatches), so the same four escrows are re-judged on
 *      every iteration. Expected booleans are hand-pinned in the
 *      fixture comment below (true / false / false / false,
 *      written from the documented semantics — no deadline means
 *      never overdue, and a terminal escrow is never overdue even
 *      past its deadline), and every timed iteration re-checks
 *      each result against them.
 *  25. money guard — `assertNonNegativeMoney(name, value)` over a
 *      fixed legal corpus (zero, a cent, the golden 10,630, and a
 *      large amount), measuring only the legal branch's steady-state
 *      throughput: this is the boundary check every dispatch pays
 *      for its monetary inputs (the #15 input validation), previously
 *      visible only inside the dispatch numbers. The illegal branch
 *      (negative, NaN, ±Infinity, a numeric string, undefined, and
 *      null — each throwing the exact hand-pinned message
 *      `amount must be a finite non-negative number`) is asserted
 *      for correctness ONCE, outside the timed loop, never timed.
 *      Every timed iteration re-checks that the whole legal corpus
 *      passes without throwing.
 *  26. transition-table JSON export — `transitionTableJson()` with
 *      no arguments: the canonical JSON form (declaration order,
 *      2-space indent, trailing newline) that front-end and docs
 *      tooling consumes instead of re-deriving the state machine.
 *      This is the full-edge enumeration plus JSON assembly a docs
 *      or UI build pays per export, previously unmeasured. Every
 *      timed iteration parses the output back and checks it against
 *      hand-pinned expectations (14 edges, pinned first / release /
 *      last edges, pinned per-edge key order — expectations written
 *      from the committed snapshot, never derived by calling
 *      `transitionTable()` or the function under test).
 *
 *  27. state diagram generation — `stateDiagram()` with no
 *      arguments: the Mermaid stateDiagram-v2 block (fenced) that
 *      the README embeds verbatim and docs tooling regenerates via
 *      `npm run diagram`. This is the full-edge enumeration plus
 *      text assembly a docs build pays per render, previously
 *      unmeasured. Every timed iteration checks the output against
 *      hand-pinned expectations (21 lines, 14 edge lines written
 *      out in full, the start line, the 3 terminal lines, and all
 *      8 states present — expectations written from the committed
 *      snapshot and test/diagram.test.ts, never derived by calling
 *      `transitionTable()` or the function under test).
 *
 *  28. README diagram sync check — `readmeDiagramInSync()` with
 *      no arguments: reads this repo's README.md, regenerates the
 *      diagram from the transition table, and checks the exact
 *      generated block is embedded in the README. This is the
 *      documentation-sync check a docs CI pays per run (one README
 *      read plus a full diagram regeneration and byte inclusion
 *      check), previously unmeasured. File reading is limited to
 *      this repo's own README.md; no network, no randomness, and
 *      no wall-clock assertion enters the check. Every timed
 *      iteration checks the result against the hand-pinned
 *      expectation `true` — the same expectation the test suite
 *      pins (test/diagram.test.ts: README embeds the exact
 *      generated diagram block, and the diagram CLI `--check`
 *      passes), never derived by reading the README in the bench
 *      itself.
 *
 *  29. dispatch subscription notification — `subscribe()` with
 *      one fixed collecting listener on a fresh escrow, driven
 *      through the same fixed full CREATED -> RELEASED lifecycle
 *      as group 1 (see the subscribe fixture below). This is the
 *      in-process fan-out every successful dispatch pays after
 *      its audit entry is appended: listeners run in
 *      subscription order, and a throwing listener is isolated
 *      (the dispatch still succeeds and its peers still run).
 *      One timed pass is one full subscribed lifecycle of 4
 *      dispatches + 4 notifications; its per-iteration
 *      self-check pins the notification sequence to the
 *      hand-written (event, from, to) expectations and to the
 *      escrow's own history, entry for entry. Outside the timed
 *      loop, an unsubscribe check pins that a further dispatch
 *      notifies nobody, and an isolation check pins that a
 *      throwing listener neither breaks a dispatch nor starves
 *      its peer. No network, no randomness, and no wall
 *      clock: every dispatch timestamp is fixed.
 *  30. snapshot round-trip — `Escrow.fromJSON(snapshot)` over
 *      the fixed `toJSON()` snapshot of the same full lifecycle
 *      escrow, carrying a fixed deadline (see the snapshot
 *      fixture below). This is the persistence rehydration a
 *      service pays per escrow at restart: strict envelope
 *      validation plus hash-chain re-verification on the way
 *      in, previously visible only inside the demo. Every
 *      timed iteration checks the restored escrow's id, state,
 *      deadline, and history entry for entry (hash / prevHash
 *      chain included) against the source snapshot, and that
 *      re-exporting the restored escrow reproduces the source
 *      snapshot exactly. Outside the timed loop, the snapshot's
 *      serialized text is additionally restored after a
 *      JSON.parse/stringify round-trip and checked to come
 *      back unchanged.
 *  31. standalone history parsing — `parseEscrowHistory()` over
 *      the JSON-serialized text of the same fixed RELEASED
 *      history fixture (see the parseEscrowHistory fixture
 *      below). This is the validation a recovery or
 *      reconciliation tool holding only a bare history value —
 *      JSON text from a log shipper or another store, with no
 *      Escrow instance at all — pays before anything rebuilds
 *      from it: structural validation (seq chain, legal edges,
 *      canonical timestamps) plus full hash-chain
 *      re-verification, returning sanitized detached copies.
 *      The demo gained this as an independent segment in #359
 *      and the NDJSON / fromHistory paths exercise the same
 *      parser internally, but the standalone parse itself had
 *      no measured baseline. The serialized text is fixed
 *      once, outside the timed loop; every timed iteration
 *      parses the text back and runs the standalone parser,
 *      then checks the parsed entries against the original
 *      history entry for entry (hash / prevHash chain
 *      included, compared field-wise and through the canonical
 *      NDJSON serializer). Outside the timed loop, a detached
 *      tampered text (the middle entry's note rewritten, then
 *      re-serialized) is rejected with the exact hash-chain
 *      error, and the original text still parses afterwards.
 *  32. single-step transition dispatch — `benchTransition`:
 *      one legal step (`SUBMIT_MILESTONE`) dispatched on an
 *      escrow restored from the same fixed FUNDED snapshot
 *      (one FUND entry, the golden 10,630, at the fixed base
 *      instant) on every iteration. This is the steady-state
 *      cost of a single dispatch — restore plus one hash-chained
 *      audit append — that the full-lifecycle row (group 1)
 *      only reports as a 4-step aggregate, so a per-step
 *      regression could previously hide inside the lifecycle
 *      average. The restore cost is inside the timed region
 *      (dispatch mutates the escrow, so no instance can be
 *      reused), the same accounting the watchdog-execution
 *      rows use. Every timed iteration checks the state
 *      advanced exactly one step (FUNDED ->
 *      MILESTONE_SUBMITTED), the history grew by exactly one
 *      entry, and the appended entry's seq continues the
 *      snapshot's seq with no gap. Outside the timed loop, an
 *      exhaustive pure-`transition()` check pins every
 *      state/event pair: the 14 legal edges return their
 *      hand-pinned target and every other pair throws the
 *      exact message `invalid transition: <event> from
 *      <state>` — including the one-step illegal dispatch
 *      RELEASE from FUNDED, whose rejection through
 *      `Escrow.dispatch` is pinned with that same exact
 *      message and leaves the restored escrow untouched.
 *      No network, no randomness, and no wall clock: the
 *      step's audit timestamp is fixed at BASE + 1s.
 *  33. transition-table pure object construction —
 *      `transitionTable()` with no arguments: the plain-object
 *      edge list (declaration order, no serialization) that
 *      `transitionTableJson()` and `stateDiagram()` both derive
 *      from. The JSON row (group 26) measures construction plus
 *      serialization together, so the pure construction cost —
 *      and the serialization share — were previously invisible.
 *      Every timed iteration checks the result against
 *      hand-pinned expectations (14 edges in declaration order,
 *      written out in full from the committed snapshot, never
 *      derived by calling the function under test; per-edge key
 *      order from,event,to), spot-checked against the
 *      `transitionTableJson` edge set through the shared pinned
 *      first / release (index 10) / last edges. Outside the
 *      timed loop, an exhaustive check pins the full edge set
 *      equal to the parsed JSON edge set edge for edge and
 *      confirms a hand-pinned non-existent edge
 *      (CREATED / RELEASE / RELEASED) is absent from both.
 *  34. single-target settlement webhook delivery —
 *      `deliverSettlementWebhook(url, webhook)` to one fixed
 *      endpoint through a fake `fetch` installed on
 *      `globalThis` (this library's delivery layer calls the
 *      global `fetch`; the fake answers 200 immediately).
 *      This is the steady-state cost of building the signed
 *      body once, one fetch, and the result encapsulation —
 *      the single-target path under the fan-out wrapper
 *      (group 8), previously visible only inside the
 *      4-endpoint fan-out numbers. Every timed iteration
 *      checks the result is `{ status: 200, attempts: 1 }`,
 *      exactly one captured call went to the pinned URL,
 *      and its `X-Signature` equals the
 *      `buildSettlementWebhook` product's signature and
 *      verifies over the captured body. Outside the timed
 *      loop, a persistent-500 script (backoffMs 0, retries 2)
 *      is pinned to throw the exact exhaustion message
 *      `webhook delivery to <url> failed after 3 attempts:
 *      server responded with status 500` after exactly 3
 *      captured calls. Zero network, zero randomness, and
 *      no real waiting (backoffMs 0 on the timed path too).
 *
 *  35. deadline write cycle — `setDeadline` / `clearDeadline`
 *      on one shared FUNDED escrow: every timed iteration sets
 *      the deadline via a `Date` (BASE + 30 days), reads it back
 *      pinned to the canonical literal, overwrites it via a
 *      string (BASE + 120 days), reads that back pinned, then
 *      clears it and reads back `undefined`, so the escrow
 *      returns to its initial deadline-less state and the same
 *      instance is reused on the next iteration. State and
 *      history are checked unchanged on every iteration —
 *      writing a deadline is configuration, not a dispatch.
 *      This is the write side of the deadline pair: group 24
 *      measures only the `isOverdue` judgement over escrows
 *      whose deadlines were set once in fixture construction.
 *      Outside the timed loop, on separate probe escrows, the
 *      illegal inputs (`not-a-date` and an invalid `Date`) are
 *      pinned to their exact `invalid deadline: ...` messages
 *      and to leaving any stored value untouched, a
 *      non-canonical input is pinned to its normalized
 *      canonical form, and a terminal (RELEASED) probe is
 *      pinned to store a past deadline yet never judge
 *      overdue — the semantics `test/deadline.test.ts` pins.
 *  36. quorum revoke cycle — `revoke()` on a fresh 5/9 quorum
 *      (fixed injected clock) on every iteration: approve
 *      dao-1..dao-5 to the threshold, revoke dao-3 to drop to
 *      4/5 below the threshold, then re-approve dao-3 to return
 *      to 5/5. `approvalCount()` / `hasQuorum()` / `approvals()`
 *      are checked against hand-pinned expectations at every
 *      stage — the re-approved signer returns last in
 *      `approvals()` order, because ordering follows each
 *      signer's latest approval. This is the change-of-vote
 *      cost a multi-sig pays before the threshold is finally
 *      reached, previously visible only inside the
 *      approve-to-threshold numbers. Outside the timed loop,
 *      revoking an unknown signer and revoking a known signer
 *      that has not approved are pinned to their exact
 *      rejection messages and to leaving the quorum unchanged.
 *  37. subscribe `onError` error routing — `subscribe()` with
 *      one pinned throwing listener and a collecting `onError`
 *      on a fresh escrow, driven through a fixed short chain
 *      (FUND -> SUBMIT_MILESTONE -> VERIFY_PASS, ending
 *      VERIFIED; see the subscribe onError fixture below).
 *      This is the error-routing cost every dispatch pays when
 *      a fan-out consumer fails: the listener's throw is
 *      caught, the caught error is handed to `onError` with
 *      its dispatch context, and the dispatch still succeeds.
 *      Group 29 measures only the collecting-listener path, so
 *      this routing overhead was previously invisible. One
 *      timed pass is 3 dispatches + 3 error reports; its
 *      per-iteration self-check pins that every dispatch
 *      succeeded, the history holds exactly 3 entries, and the
 *      reports match the hand-pinned expectations report for
 *      report (pinned message plus event / from / to context,
 *      the first report's context included). Outside the
 *      timed loop, a probe pins that an `onError` that itself
 *      throws is swallowed (the dispatch still succeeds), and
 *      a non-function `onError` is pinned to its exact
 *      rejection message at subscribe time. No network, no
 *      randomness, and no wall clock: every dispatch
 *      timestamp is fixed.
 *  38. settlement event dedupe snapshot export —
 *      `SettlementEventDedupe.exportSnapshot()` over a fixed
 *      1,001-entry dedupe (1,000 live ids plus one entry aged
 *      exactly to the TTL boundary, so it is excluded) under a
 *      stepped fixed injected clock (see the export fixture
 *      below for its composition and the hand-written
 *      expectations). This is the shutdown path a settlement
 *      receiver runs to persist its dedupe window before a
 *      restart: live-entry filtering plus the detached
 *      `{ v: 1, entries }` copy, on every call. The exported
 *      snapshot is checked against hand-written expectations
 *      (envelope version, exactly the 1,000 live entries in
 *      record order with their pinned first-seen timestamps,
 *      the expired entry absent) on every iteration, and a
 *      detached-copy mutation plus the empty-store export are
 *      pinned once, outside the timed loop. Group 17 measures
 *      only the restore direction, so this export cost was
 *      previously visible only inside the restore fixture's
 *      one-time construction.
 *  39. settlement event dedupe clear —
 *      `SettlementEventDedupe.clear()` on a fresh dedupe rebuilt
 *      on every iteration (see the dedupe clear fixture
 *      below): 1,000 fixed ids recorded under an injected
 *      fixed clock, plus one duplicate hit on the first id,
 *      so the counters about to be zeroed are non-trivial
 *      (`{ size: 1,000, hits: 1, misses: 1,000, evictions: 0 }`).
 *      This is the window-reset path a receiver pays on key
 *      rotation, for test isolation, or for a deliberate
 *      dedupe-window reset: drop every tracked id and zero
 *      all three observability counters in one call. `clear()`
 *      mutates the store, so no instance can be reused — every
 *      timed iteration rebuilds the whole fixture first, and
 *      the reported numbers therefore include the fixture-
 *      rebuild cost (prefill plus clear), a conservative floor
 *      for the pure clear cost, not the pure cost itself (the
 *      same accounting the watchdog-execution rows use). One
 *      timed pass is one rebuild + one clear + the post-clear
 *      self-checks; its per-iteration self-check pins the size
 *      and every counter at zero right after the clear, and
 *      pins that the first id records as a new event again
 *      (counters re-accumulating from zero). Outside the timed
 *      loop, clearing an empty dedupe is pinned as a harmless
 *      no-op. No network, no randomness, and no wall clock:
 *      the clear clock is fixed.
 *  40. settlement event dedupe stats —
 *      `SettlementEventDedupe.stats()` on a fixed dedupe
 *      (see the dedupe stats fixture below): 7 ids recorded
 *      under an injectable clock that advances only during
 *      fixture construction, with a 60-second TTL and a
 *      capacity of 6 — one id is LRU-evicted during
 *      construction, one id sits expired in the map at the
 *      stats instant, and 5 ids are live, with the counters
 *      pinned at 1 hit / 7 misses / 1 eviction from the
 *      construction script. This is the observability
 *      snapshot a receiver's monitoring polls on every tick:
 *      traverse the map counting only the live entries
 *      against the store's own clock, then copy the three
 *      counters into a detached object. Its cost was
 *      previously invisible inside the checkAndRecord /
 *      restore rows (those paths read `stats()` only as a
 *      fixture self-check, never as the timed object). One
 *      timed pass is one full `stats()` call; its
 *      per-iteration self-check pins the snapshot to the
 *      hand-written expectation (`{ size: 5, hits: 1,
 *      misses: 7, evictions: 1 }` — size counts only the
 *      live ids, so the expired id still sitting in the map
 *      is excluded). Outside the timed loop, a mutated
 *      detached snapshot is pinned to leave a re-read
 *      unchanged, and an empty dedupe is pinned to report
 *      all-zero stats. No network, no randomness, and no
 *      wall clock after fixture construction: the stats
 *      clock is fixed.
 *  41. quorum snapshot export — `snapshot()` on the fixed
 *      9-signer / threshold-5 quorum carrying 7 recorded
 *      approvals (dao-1..dao-7, one second apart on a stepped
 *      fixed clock starting at BASE_MS — the same shape the
 *      restore fixture in group 14 persists), checked against
 *      hand-pinned expectations on every iteration (the
 *      `{ v: 1, ... }` envelope in its pinned key order,
 *      threshold 5, the 9 signers in config order, no
 *      `maxApprovalAgeMs` key, and the 7 approval entries in
 *      record order with their pinned canonical timestamps).
 *      This is the checkpoint export an arbitration service
 *      pays on every persist: group 14 measures only the
 *      restore direction, so this export cost was previously
 *      visible only as one fixture-construction call.
 *      `snapshot()` is pure, so the same source quorum is
 *      re-exported on every iteration. Outside the timed
 *      loop, a detached-copy mutation is pinned to leave a
 *      re-export unchanged, and the export pushed through a
 *      JSON round-trip is pinned to restore via
 *      `restoreQuorum` into a quorum equivalent to the
 *      group-14 fixture (cross-checked against its persisted
 *      snapshot byte-for-byte).
 *  42. quorum approval expiry — the counting views
 *      (`approvalCount()` / `hasQuorum()` / `approvals()`)
 *      of a fresh 5/9 quorum configured with
 *      `maxApprovalAgeMs` (a 60-second window) on an
 *      advancing injected clock, on every iteration:
 *      approvals are recorded staggered (dao-1 at BASE,
 *      dao-2 at BASE + 30s, dao-3..dao-5 at BASE + 60s) and
 *      the views are checked against hand-pinned
 *      expectations at every pinned instant — all five
 *      count with dao-1 exactly at the inclusive boundary
 *      (age == window), then dao-1 expires one millisecond
 *      later (4 counted), dao-2 sits exactly at the
 *      boundary at BASE + 90s (still 4), then expires too
 *      (3 counted) — while `approvalLog()` keeps all 5
 *      entries at every instant (expiry never deletes).
 *      The two expired signers then re-approve and restore
 *      the quorum (5 counted, re-approved signers last in
 *      `approvals()` order, log grown to 7). This is the
 *      freshness cost a long-running arbitration pays on
 *      every quorum poll; the other quorum rows never set
 *      an expiry window, so the age filtering was
 *      previously unmeasured. Outside the timed loop, a
 *      probe pins that a fully expired quorum still holds
 *      its complete audit log and that re-approving one
 *      expired signer restores exactly its count with the
 *      fresh timestamp appended. No network, no
 *      randomness, and no wall clock: the clock is
 *      injected and only ever set to pinned instants.
 *  43. settlement webhook secret-rotation verification —
 *      `verifySettlementWebhook` with the rotation candidate
 *      set `{ secrets: [newSecret, oldSecret] }` over the
 *      fixed webhook fixture (signed with the OLD secret at
 *      the fixed `WEBHOOK_NOW` / `WEBHOOK_EVENT_ID`, so the
 *      matching candidate is the SECOND one tried) on every
 *      iteration, checked to return exactly `true` on every
 *      iteration. This is the steady-state receiver cost
 *      inside a rotation window: every delivery pays one
 *      failed HMAC trial before the match, a cost the
 *      single-secret verify row (group 4) never exercises.
 *      Outside the timed loop, a candidate pair in which
 *      neither secret matches is pinned to return `false`
 *      (all-mismatch fails closed, no throw), and an empty
 *      `secrets` array is pinned to throw the exact
 *      configuration error. No network, no randomness, and
 *      no wall clock: the signed fixture is built once from
 *      pinned secret / timestamp / eventId.
 *  44. keyed audit-chain verification — `verifyHistoryChain`
 *      with the pinned `auditKey` over a fixed 4-entry history
 *      produced by an escrow constructed with that key (the
 *      same lifecycle, id, and fixed dispatch timestamps as
 *      the unkeyed `historyFixture`, so the two chains differ
 *      only in their hash function: HMAC-SHA256 instead of
 *      plain SHA-256), checked to return exactly `true` on
 *      every iteration, with the genesis link and every
 *      successor link pinned on every iteration as well.
 *      This is the tamper-evidence check a holder of a keyed
 *      audit log pays per escrow; the unkeyed verify row
 *      (group 2) never exercises the HMAC form. Outside the
 *      timed loop, a wrong key is pinned to return `false`,
 *      verification with no key is pinned to return `false`
 *      (the two modes fail closed against each other), and a
 *      detached tampered copy (the middle entry gaining a
 *      note it never carried) is pinned to return `false`
 *      under the correct key. No network, no randomness, and
 *      no wall clock: the keyed fixture is built once from
 *      the pinned key and pinned dispatch timestamps.
 *  45. settlement webhook maxAgeMs freshness verification —
 *      `verifySettlementWebhook` with
 *      `{ secrets: [secret], maxAgeMs, now }` over the fixed
 *      webhook fixture (signed at the fixed `WEBHOOK_NOW`,
 *      so its payload `at` is pinned; the injected `now` is
 *      pinned at `at + 120s` and the window at 300,000 ms,
 *      so the payload is inside the window) on every
 *      iteration, checked to return exactly `true` on every
 *      iteration. This is the steady-state receiver cost of
 *      the opt-in replay bound: the signature is checked
 *      first and the freshness gate runs only after a match,
 *      a cost the plain and rotation verify rows never
 *      exercise (neither sets a window). Outside the timed
 *      loop, an over-age payload (injected `now` at
 *      `at + maxAgeMs + 1`) is pinned to return `false`, a
 *      payload aged exactly to the boundary
 *      (`now - at == maxAgeMs`, inclusive) is pinned to
 *      still return `true`, and an illegal `maxAgeMs`
 *      (-1) is pinned to throw the exact configuration
 *      error. No network, no randomness, and no wall
 *      clock: the signed fixture is built once from pinned
 *      secret / timestamp / eventId and every freshness
 *      instant is injected.
 *  46. settlement webhook maxFutureSkewMs future-skew
 *      verification — `verifySettlementWebhook` with
 *      `{ secrets: [secret], maxFutureSkewMs, now }` over
 *      the fixed webhook fixture (signed at the fixed
 *      `WEBHOOK_NOW`, so its payload `at` is pinned; the
 *      injected `now` is pinned at `at - 120s` and the
 *      skew window at 300,000 ms, so the payload sits
 *      120 s in the future, inside the window) on every
 *      iteration, checked to return exactly `true` on
 *      every iteration. This is the future side of the
 *      two-sided freshness window: `maxAgeMs` alone never
 *      rejects a future timestamp (a negative age always
 *      passes), so the plain, rotation, and maxAgeMs
 *      verify rows never exercise this bound. Outside the
 *      timed loop, an over-skew payload (injected `now`
 *      at `at - maxFutureSkewMs - 1`) is pinned to return
 *      `false`, a payload skewed exactly to the boundary
 *      (`at - now == maxFutureSkewMs`, inclusive) is
 *      pinned to still return `true`, both bounds set
 *      together are pinned to reject on each side (a
 *      future-side rejection while the age side passes,
 *      and an age-side rejection while the skew side
 *      passes, with a payload inside both windows still
 *      verifying), and an illegal `maxFutureSkewMs` (-1)
 *      is pinned to throw the exact configuration error.
 *      No network, no randomness, and no wall clock: the
 *      signed fixture is built once from pinned secret /
 *      timestamp / eventId and every freshness instant
 *      is injected.
 *  47. settlement webhook pre-aborted delivery —
 *      `deliverSettlementWebhook` with a pre-aborted
 *      `AbortSignal` (`signal` already aborted before the
 *      call) over the fixed webhook fixture, through a
 *      counting fake `fetch` installed on `globalThis`,
 *      checked on every iteration to reject with the exact
 *      error `webhook delivery aborted` and to leave the
 *      fetch call count at exactly zero. This is the
 *      deterministic fail-fast guard a caller relies on
 *      when it cancels before dispatch: the aborted check
 *      runs before any request is made, so the pre-aborted
 *      form pays no network cost at all — a cost the
 *      single-target delivery row (group 34) never
 *      exercises, because its signal is never set. Outside
 *      the timed loop, a non-`AbortSignal` `signal` value
 *      is pinned to throw its exact configuration error
 *      before any request, and a signal that never aborts
 *      is pinned to leave the normal delivery path
 *      untouched (`{ status: 200, attempts: 1 }` after
 *      exactly one fetch). No network, no randomness, no
 *      real waiting, and no wall clock: the fake fetch
 *      answers 200 immediately and is never reached on the
 *      timed path.
 *  48. settlement webhook `maxRetryDelayMs` retry-delay
 *      clamp delivery — `deliverSettlementWebhook` with
 *      `maxRetryDelayMs: 0` over the fixed webhook fixture,
 *      through a fake `fetch` installed on `globalThis`
 *      that answers 429 with `Retry-After: 31536000`
 *      (a one-year hint, in seconds) on the first call of
 *      each iteration and 200 on the second, checked on
 *      every iteration to resolve to exactly
 *      `{ status: 200, attempts: 2 }` after exactly two
 *      fetch calls. The hint is clamped with
 *      `Math.min(hinted, maxRetryDelayMs)` before the
 *      retry sleep, so the cap of 0 turns the year-long
 *      hint into an immediate retry: this is the guard
 *      that keeps a faulty or hostile server from
 *      stalling a settlement delivery for a year — a
 *      cost the plain single-target delivery row never
 *      exercises, because its endpoint never answers
 *      429. Outside the timed loop, an illegal
 *      `maxRetryDelayMs` (-1) is pinned to throw its
 *      exact configuration error before any request, and
 *      a hint-less 500-then-200 script is pinned to keep
 *      the exponential-backoff fallback shape
 *      (`{ status: 200, attempts: 2 }`, backoffMs 0 so no
 *      real waiting). No network, no randomness, no real
 *      sleep, and no wall clock: the clamped wait is
 *      exactly 0 ms and every other wait is pinned to 0.
 *  49. verify-evidence gate dispatch — `dispatch("VERIFY_PASS")`
 *      on a fresh escrow constructed with
 *      `requireVerifyEvidence: true` and driven to
 *      MILESTONE_SUBMITTED on fixed timestamps (FUND of the
 *      golden 10,630 at BASE, SUBMIT_MILESTONE at BASE + 1s),
 *      then verified with the pinned evidence reference at
 *      BASE + 2s. This is the security gate that makes an
 *      evidence-free VERIFY_PASS impossible when the flag is
 *      on: the library records the caller's evidence claim
 *      verbatim on the audit entry but does NOT verify the
 *      oracle attestation behind it (honest limit, pinned in
 *      the demo and SECURITY.md). The strict escrow is
 *      rebuilt on every iteration because dispatch mutates
 *      it, so the rebuild cost is inside the timed region.
 *      Every iteration checks the state advances to VERIFIED
 *      and the history grows by exactly one entry (2 -> 3),
 *      whose VERIFY_PASS entry carries the pinned evidence
 *      verbatim. Outside the timed loop: an evidence-free
 *      VERIFY_PASS on the strict escrow is pinned to throw
 *      the exact gate error and to leave state and history
 *      unchanged entry for entry, after which the same
 *      escrow passes with evidence; a default escrow (flag
 *      off) is pinned to keep the pre-gate behavior (an
 *      evidence-free VERIFY_PASS succeeds and its entry
 *      carries no evidence field); and a non-boolean
 *      `requireVerifyEvidence` value is pinned to throw its
 *      exact constructor configuration error. Fixed
 *      timestamps, no network, no randomness, no wall clock.
 *  50. deposit-cap funding — two `dispatch("FUND")` calls
 *      on a fresh escrow constructed with
 *      `maxDeposit: 10630` (the golden deposit as the cap)
 *      on fixed timestamps: an initial FUND of 7,000 at
 *      BASE and a 3,630 top-up at BASE + 1s, landing the
 *      locked total exactly on the cap. This is the
 *      payments risk control that keeps a runaway or
 *      mistaken funding from locking more than the agreed
 *      ceiling: the cap is checked against the running
 *      funded total (every FUND amount, top-ups included)
 *      before anything is appended, so a capped-out FUND
 *      leaves no audit residue — a cost the plain dispatch
 *      row (group 1) never exercises, because its escrow
 *      carries no cap. The capped escrow is rebuilt on
 *      every iteration because dispatch mutates it, so the
 *      rebuild cost is inside the timed region. Every
 *      iteration checks the state is FUNDED, the history
 *      holds exactly two entries, and the two entries
 *      carry the pinned amounts summing to the cap.
 *      Outside the timed loop: a FUND one cent over the
 *      cap is pinned to throw the exact cap error and to
 *      leave state and history unchanged entry for entry;
 *      a FUND without an amount is pinned to stay
 *      uncapped even at the cap (it carries no money and
 *      contributes nothing to the locked total, so a
 *      later one-cent FUND still reports the same locked
 *      total); and an escrow without the option is
 *      pinned to keep the pre-cap behavior (two very
 *      large FUNDs accepted). Fixed timestamps, no
 *      network, no randomness, no wall clock.
 *  51. optimistic-concurrency dispatch — `dispatch("VERIFY_PASS")`
 *      with `expectedSeq: 2` on a fresh escrow driven to
 *      MILESTONE_SUBMITTED on fixed timestamps (FUND of the
 *      golden 10,630 at BASE, SUBMIT_MILESTONE at BASE + 1s,
 *      so the history holds exactly 2 entries). This is the
 *      guard that makes a write based on a stale snapshot
 *      fail loudly with `dispatch conflict: …` instead of
 *      silently advancing a state the writer never saw: the
 *      guard runs before every other dispatch validation, so
 *      a conflict changes nothing. The guarded escrow is
 *      rebuilt on every iteration because dispatch mutates
 *      it, so the rebuild cost is inside the timed region.
 *      Every iteration checks the state advances to VERIFIED
 *      and the history grows by exactly one entry (2 -> 3),
 *      whose VERIFY_PASS entry is pinned field for field.
 *      Outside the timed loop: a stale `expectedSeq` is
 *      pinned to throw the exact conflict error and to leave
 *      state and history unchanged entry for entry; an
 *      empty-history escrow is pinned to advance with
 *      `expectedSeq: 0`; illegal values (-1 and 1.5) are
 *      pinned to their exact configuration errors; and a
 *      dispatch without `expectedSeq` is pinned to keep the
 *      pre-guard behavior. Fixed timestamps, no network, no
 *      randomness, no wall clock.
 *  52. settlement webhook `timeoutMs` timeout delivery —
 *      `deliverSettlementWebhook` with `timeoutMs: 10` and
 *      `retries: 0` over the fixed webhook fixture, through
 *      a hanging fake `fetch` installed on `globalThis`
 *      that only ever rejects when its request signal
 *      aborts, checked on every iteration to reject with
 *      the exact error `webhook delivery to
 *      https://settlement.example.com/hooks/settlement
 *      failed after 1 attempt: webhook delivery timed out
 *      after 10ms` after exactly one fetch call. This is
 *      the per-attempt bound that ends a delivery to an
 *      endpoint that never answers — a cost the plain
 *      single-target delivery row never exercises, because
 *      its endpoint answers 200 immediately. Outside the
 *      timed loop, an illegal `timeoutMs` (0) is pinned to
 *      throw its exact configuration error before any
 *      request (zero fetch calls), and a generous
 *      `timeoutMs` (5000) over an immediately-200 fake is
 *      pinned to keep the normal success shape
 *      (`{ status: 200, attempts: 1 }` after exactly one
 *      fetch). Honest limit: the timeout wait itself is
 *      the object under test and is the pinned short
 *      10 ms — no elapsed-time (wall-clock) assertion is
 *      made anywhere. No network and no randomness: the
 *      hanging fake is installed on `globalThis` for this
 *      path and every other fake answers immediately.
 *
 * Fixtures are fully deterministic: fixed escrow id, the portfolio
 * golden deposit (10,000 / 600 / 1.0x / -30 / +60 -> 10,630), fixed
 * dispatch timestamps (a fixed base instant plus per-step offsets),
 * webhook secret, payload timestamp and `eventId`. Nothing here reads
 * the network, a random source, or the wall clock for fixture data —
 * only the timing loop itself uses `process.hrtime`. Numbers vary with
 * hardware — do not treat them as guaranteed throughput.
 *
 * Run: `npm run bench`
 */
import { cpus } from "node:os";
import {
  actOnStaleEscrows,
  allowedEvents,
  assertNonNegativeMoney,
  buildSettlementReport,
  buildSettlementReports,
  buildSettlementWebhook,
  buildSettlementWebhooks,
  calculateDeposit,
  createQuorum,
  deliverSettlementWebhook,
  deliverSettlementWebhookToMany,
  depositAmountFromHistory,
  dispatchArbitration,
  Escrow,
  GENESIS_PREV_HASH,
  SNAPSHOT_VERSION,
  expiredEscrows,
  expireOverdueEscrows,
  historyFromNdjson,
  historyToNdjson,
  isOverdue,
  parseEscrowHistory,
  parseRetryAfter,
  renderReport,
  restoreQuorum,
  settleRelease,
  SettlementEventDedupe,
  staleEscrows,
  stateDiagram,
  transitionTable,
  transitionTableJson,
  summarizeSettlementReports,
  transition,
  verifyHistoryChain,
  verifySettlementWebhook,
  type EscrowEvent,
  type EscrowHistoryEntry,
  type EscrowSnapshot,
  type EscrowState,
  type Quorum,
  type QuorumSnapshot,
  type SettlementInputs,
  type SettlementReportInputs,
  type SettlementWebhookEndpoint,
  type TransitionEdge,
} from "../src/index.js";
import { readmeDiagramInSync } from "../src/diagram.js";

const ITERATIONS = 3000;
const WARMUP = 200;

/** Fixed base instant for every dispatch timestamp (deterministic). */
const BASE_MS = Date.parse("2026-01-01T00:00:00.000Z");
const WEBHOOK_SECRET = "bench-settlement-secret-2026";
const WEBHOOK_NOW = new Date(BASE_MS + 60_000);
const WEBHOOK_EVENT_ID = "bench-event-001";
const WEBHOOK_ROTATION_NEW_SECRET = "bench-webhook-secret-rotated-in";
const WEBHOOK_ROTATION_UNRELATED_SECRET = "bench-webhook-secret-unrelated";
const WEBHOOK_ROTATION_EMPTY_SECRETS_ERROR =
  "cannot verify settlement webhook: secrets must be a non-empty array";
const WEBHOOK_MAX_AGE_MS = 300_000;
const WEBHOOK_MAX_AGE_NOW_MS = BASE_MS + 60_000 + 120_000;
const WEBHOOK_MAX_AGE_ILLEGAL_ERROR =
  "cannot verify settlement webhook: maxAgeMs must be a finite non-negative number, got -1";
const WEBHOOK_MAX_FUTURE_SKEW_MS = 300_000;
const WEBHOOK_MAX_FUTURE_SKEW_NOW_MS = BASE_MS + 60_000 - 120_000;
const WEBHOOK_MAX_FUTURE_SKEW_ILLEGAL_ERROR =
  "cannot verify settlement webhook: maxFutureSkewMs must be a finite non-negative number, got -1";
const DELIVERY_ABORTED_ERROR = "webhook delivery aborted";
const DELIVERY_BAD_SIGNAL_ERROR =
  "cannot deliver settlement webhook: signal must be an AbortSignal, got bench-not-a-signal";
const DELIVERY_MAX_RETRY_DELAY_HINT = "31536000";
const DELIVERY_MAX_RETRY_DELAY_ILLEGAL_ERROR =
  "cannot deliver settlement webhook: maxRetryDelayMs must be a non-negative number, got -1";
const VERIFY_EVIDENCE_REF = "bench-oracle-attestation-494";
const VERIFY_EVIDENCE_ERROR =
  'verify evidence required: dispatch("VERIFY_PASS") requires a non-empty evidence reference when requireVerifyEvidence is enabled';
const VERIFY_EVIDENCE_ILLEGAL_ERROR =
  "invalid escrow options: requireVerifyEvidence must be a boolean, got string";
const MAX_DEPOSIT_CAP = 10630;
const MAX_DEPOSIT_FIRST_FUND = 7000;
const MAX_DEPOSIT_TOP_UP = 3630;
const MAX_DEPOSIT_OVER_ERROR =
  "deposit cap exceeded: locked 10630 + new funding 0.01 would exceed maxDeposit 10630";
const EXPECTED_SEQ_CONFLICT_ERROR =
  "dispatch conflict: expected seq 1 but escrow is at seq 2";
const EXPECTED_SEQ_ILLEGAL_NEG_ERROR =
  "invalid dispatch options: expectedSeq must be a non-negative integer, got -1";
const EXPECTED_SEQ_ILLEGAL_FRAC_ERROR =
  "invalid dispatch options: expectedSeq must be a non-negative integer, got 1.5";
const AUDIT_KEY = "bench-audit-key";
const AUDIT_WRONG_KEY = "bench-audit-key-wrong";
const DEPOSIT_AMOUNT = 10630;

const LIFECYCLE: Array<{ event: EscrowEvent; amount?: number }> = [
  { event: "FUND", amount: DEPOSIT_AMOUNT },
  { event: "SUBMIT_MILESTONE" },
  { event: "VERIFY_PASS" },
  { event: "RELEASE" },
];

/** One full deterministic CREATED -> RELEASED lifecycle on a fresh escrow. */
function runLifecycle(): Escrow {
  const escrow = new Escrow("BENCH-001");
  LIFECYCLE.forEach(({ event, amount }, i) => {
    escrow.dispatch(event, undefined, amount, {
      at: new Date(BASE_MS + i * 1000).toISOString(),
    });
  });
  return escrow;
}

const REFUNDED_LIFECYCLE: Array<{ event: EscrowEvent; amount?: number }> = [
  { event: "FUND", amount: DEPOSIT_AMOUNT },
  { event: "SUBMIT_MILESTONE" },
  { event: "VERIFY_FAIL" },
  { event: "ARBITRATE_REFUND" },
];

/** One full deterministic CREATED -> REFUNDED lifecycle (4 entries). */
function runRefundedLifecycle(id: string): Escrow {
  const escrow = new Escrow(id);
  REFUNDED_LIFECYCLE.forEach(({ event, amount }, i) => {
    escrow.dispatch(event, undefined, amount, {
      at: new Date(BASE_MS + i * 1000).toISOString(),
    });
  });
  return escrow;
}

/** One full deterministic CREATED -> RELEASED lifecycle under a given id. */
function runReleasedLifecycle(id: string): Escrow {
  const escrow = new Escrow(id);
  LIFECYCLE.forEach(({ event, amount }, i) => {
    escrow.dispatch(event, undefined, amount, {
      at: new Date(BASE_MS + i * 1000).toISOString(),
    });
  });
  return escrow;
}

function settlementInputsFor(
  escrow: Escrow,
): SettlementReportInputs {
  return {
    escrowId: escrow.id,
    history: escrow.history.map((e) => ({ ...e })),
    finalState: escrow.state,
    deposit,
    settlement: { proFeeBps: 500 },
  };
}

/**
 * The NDJSON fixture lifecycle: the golden deposit funded in five
 * staged FUND dispatches (10,000 + 300 + 150 + 100 + 80 = 10,630),
 * then milestone submission, verification, and release — 8 chained
 * audit entries ending RELEASED, comparable in size to the dataquest
 * lifecycle's 8-entry NDJSON bench fixture.
 */
const NDJSON_LIFECYCLE: Array<{ event: EscrowEvent; amount?: number }> = [
  { event: "FUND", amount: 10000 },
  { event: "FUND", amount: 300 },
  { event: "FUND", amount: 150 },
  { event: "FUND", amount: 100 },
  { event: "FUND", amount: 80 },
  { event: "SUBMIT_MILESTONE" },
  { event: "VERIFY_PASS" },
  { event: "RELEASE" },
];

/** One full deterministic 8-entry staged-funding lifecycle. */
function runNdjsonLifecycle(): Escrow {
  const escrow = new Escrow("BENCH-NDJSON-001");
  NDJSON_LIFECYCLE.forEach(({ event, amount }, i) => {
    escrow.dispatch(event, undefined, amount, {
      at: new Date(BASE_MS + i * 1000).toISOString(),
    });
  });
  return escrow;
}

const QUORUM_SIGNERS: readonly string[] = [
  "dao-1",
  "dao-2",
  "dao-3",
  "dao-4",
  "dao-5",
  "dao-6",
  "dao-7",
  "dao-8",
  "dao-9",
];
const QUORUM_THRESHOLD = 5;

/**
 * One deterministic 5/9 quorum accumulation: a fresh quorum on a fixed
 * injected clock, approving signers in order until the threshold is
 * reached, checking `hasQuorum()` after each vote.
 */
function runQuorumToThreshold(): Quorum {
  const quorum = createQuorum({
    threshold: QUORUM_THRESHOLD,
    signers: QUORUM_SIGNERS,
    now: () => BASE_MS,
  });
  for (let i = 0; i < QUORUM_THRESHOLD; i++) {
    quorum.approve(QUORUM_SIGNERS[i]);
    quorum.hasQuorum();
  }
  return quorum;
}

function measure(fn: () => void, iterations: number): number {
  for (let i = 0; i < WARMUP; i++) fn(); // warmup: JIT, module caches
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
  const elapsedSec = Number(process.hrtime.bigint() - start) / 1e9;
  return iterations / elapsedSec;
}

async function measureAsync(
  fn: () => Promise<void>,
  iterations: number,
): Promise<number> {
  for (let i = 0; i < WARMUP; i++) await fn(); // warmup: JIT, module caches
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) await fn();
  const elapsedSec = Number(process.hrtime.bigint() - start) / 1e9;
  return iterations / elapsedSec;
}

function fmt(ops: number): string {
  const s =
    ops >= 1000
      ? ops.toLocaleString("en-US", { maximumFractionDigits: 0 })
      : ops.toFixed(1);
  const perOpUs = (1e6 / ops).toFixed(2);
  return `${s} ops/sec (${perOpUs} µs/op)`;
}

// ---------------------------------------------------------------------
// Deterministic fixtures, built once outside the timed loops.
// ---------------------------------------------------------------------
const deposit = calculateDeposit({
  creatorPool: 10000,
  baseFee: 600,
  complexityMultiplier: 1.0,
  loyaltyDiscount: 30,
  oracleFee: 60,
});
if (deposit.deposit !== DEPOSIT_AMOUNT) {
  throw new Error("benchmark fixture failed: golden deposit mismatch");
}
const releasedEscrow = runLifecycle();
if (releasedEscrow.state !== "RELEASED" || releasedEscrow.history.length !== 4) {
  throw new Error("benchmark fixture failed: lifecycle did not reach RELEASED");
}
// Detached plain copies, exactly what a persisted audit log looks like.
const historyFixture: EscrowHistoryEntry[] = releasedEscrow.history.map((e) => ({
  ...e,
}));
if (!verifyHistoryChain(historyFixture)) {
  throw new Error("benchmark fixture failed: history chain does not verify");
}
// Keyed-chain fixture: the same lifecycle, id, and fixed dispatch
// timestamps as the unkeyed fixture above, but produced by an escrow
// constructed with the pinned audit key — so its entries differ from
// historyFixture only in their hashes (HMAC-SHA256 instead of plain
// SHA-256). Outside-the-timed-loop pins: the correct key verifies,
// a wrong key returns false, and no key returns false (the keyed and
// unkeyed modes fail closed against each other).
const keyedEscrow = new Escrow("BENCH-001", { auditKey: AUDIT_KEY });
LIFECYCLE.forEach(({ event, amount }, i) => {
  keyedEscrow.dispatch(event, undefined, amount, {
    at: new Date(BASE_MS + i * 1000).toISOString(),
  });
});
if (keyedEscrow.state !== "RELEASED" || keyedEscrow.history.length !== 4) {
  throw new Error("benchmark fixture failed: keyed lifecycle shape");
}
const keyedHistoryFixture: EscrowHistoryEntry[] = keyedEscrow.history.map(
  (e) => ({ ...e }),
);
if (!verifyHistoryChain(keyedHistoryFixture, AUDIT_KEY)) {
  throw new Error("benchmark fixture failed: keyed history chain does not verify");
}
if (verifyHistoryChain(keyedHistoryFixture, AUDIT_WRONG_KEY)) {
  throw new Error("benchmark fixture failed: keyed chain verified with a wrong key");
}
if (verifyHistoryChain(keyedHistoryFixture)) {
  throw new Error("benchmark fixture failed: keyed chain verified without a key");
}
for (let i = 0; i < keyedHistoryFixture.length; i++) {
  if (keyedHistoryFixture[i].hash === historyFixture[i].hash) {
    throw new Error("benchmark fixture failed: keyed hash matches unkeyed hash");
  }
}
const report = buildSettlementReport({
  escrowId: releasedEscrow.id,
  history: historyFixture,
  finalState: "RELEASED",
  deposit,
  settlement: { proFeeBps: 500 },
});
if (!report.balanced || report.outcome !== "released") {
  throw new Error("benchmark fixture failed: settlement report not balanced");
}
// Batch fixture: 4 inputs, each a 4-entry history comparable to the
// single-report fixture — released / refunded / released, plus one
// deliberately mismatched input (a RELEASED history claimed as
// REFUNDED) that must land as a per-item error without aborting the
// batch. Expected outcomes are hand-derived from those lifecycles.
const batchEscrows = [
  runReleasedLifecycle("BENCH-BATCH-001"),
  runRefundedLifecycle("BENCH-BATCH-002"),
  runReleasedLifecycle("BENCH-BATCH-003"),
  runReleasedLifecycle("BENCH-BATCH-004"),
];
const batchInputs: SettlementReportInputs[] = [
  settlementInputsFor(batchEscrows[0]),
  settlementInputsFor(batchEscrows[1]),
  settlementInputsFor(batchEscrows[2]),
  { ...settlementInputsFor(batchEscrows[3]), finalState: "REFUNDED" },
];
const BATCH_EXPECTED_OUTCOMES: Array<string | undefined> = [
  "released",
  "refunded",
  "released",
  undefined,
];
function checkBatchResults(
  results: ReturnType<typeof buildSettlementReports>,
): void {
  if (results.length !== batchInputs.length) {
    throw new Error("benchmark batch check failed: result count mismatch");
  }
  for (let i = 0; i < results.length; i++) {
    if (results[i].escrowId !== batchInputs[i].escrowId) {
      throw new Error("benchmark batch check failed: order not preserved");
    }
    const expected = BATCH_EXPECTED_OUTCOMES[i];
    if (expected === undefined) {
      const err = results[i].error;
      if (
        results[i].report !== undefined ||
        typeof err !== "string" ||
        !err.includes(
          "state is REFUNDED but the last audit event is RELEASE",
        )
      ) {
        throw new Error("benchmark batch check failed: bad item shape");
      }
    } else if (
      results[i].error !== undefined ||
      results[i].report?.outcome !== expected ||
      !results[i].report?.balanced
    ) {
      throw new Error("benchmark batch check failed: outcome mismatch");
    }
  }
}
checkBatchResults(buildSettlementReports(batchInputs));
// Summary fixture: the batch results above, built ONCE outside the
// timed loop (the summarizer only reads them, so every timed iteration
// re-summarizes this same list). Expected summary, hand-derived from
// the batch composition — NOT produced by the implementation:
//   items: released / refunded / released / error (mismatched input)
//   each successful report locks the golden deposit 10,630 and is
//   internally balanced at 10,630 in = 10,630 out; a released report
//   at proFeeBps 500 pays proFee = 10,630 * 5% = 531.50 to the
//   platform and creator net = 10,630 - 531.50 = 10,098.50; a
//   refunded report returns the full 10,630 to the sponsor.
//   total = 4, reports = 3, errors = 1 (the error counts, but
//   contributes nothing to any money figure)
//   outcomes = { released: 2, refunded: 1, expired: 0 }
//   totalDeposit = totalInflow = totalOutflow = 3 * 10,630 = 31,890
//   sponsor:  inflow 10,630 (refund only), outflow 3 * 10,630 =
//             31,890, net = 10,630 - 31,890 = -21,260
//   creator:  inflow 2 * 10,098.50 = 20,197, outflow 0, net 20,197
//   platform: inflow 2 * 531.50 = 1,063, outflow 0, net 1,063
//   referrer: inflow 0, outflow 0, net 0
//   balanced = true (every successful report is balanced)
const batchResults = buildSettlementReports(batchInputs);
function checkBatchSummary(
  summary: ReturnType<typeof summarizeSettlementReports>,
): void {
  const parties: Array<[string, number, number, number]> = [
    ["sponsor", 10630, 31890, -21260],
    ["creator", 20197, 0, 20197],
    ["platform", 1063, 0, 1063],
    ["referrer", 0, 0, 0],
  ];
  if (
    summary.total !== 4 ||
    summary.reports !== 3 ||
    summary.errors !== 1 ||
    summary.outcomes.released !== 2 ||
    summary.outcomes.refunded !== 1 ||
    summary.outcomes.expired !== 0 ||
    summary.totalDeposit !== 31890 ||
    summary.totalInflow !== 31890 ||
    summary.totalOutflow !== 31890 ||
    summary.balanced !== true ||
    summary.parties.length !== parties.length ||
    summary.parties.some(
      (p, i) =>
        p.party !== parties[i][0] ||
        p.inflow !== parties[i][1] ||
        p.outflow !== parties[i][2] ||
        p.net !== parties[i][3],
    )
  ) {
    throw new Error("benchmark summary check failed: summarize mismatch");
  }
}
checkBatchSummary(summarizeSettlementReports(batchResults));
// Batch-webhook fixture: the pre-built batch results above are piped
// straight into `buildSettlementWebhooks` — the reports -> webhooks
// hand-off the batch API is designed for. Expectations are hand-derived
// from the batch composition (NOT produced by the implementation):
// entries 1..3 (released / refunded / released) each build a webhook
// whose payload carries that entry's escrowId and the hand-known
// outcome, signed under the shared bench secret at the shared fixed
// WEBHOOK_NOW, with eventIds bench-batch-event-1..3 in input order
// (the deterministic counter factory below is created fresh for every
// call, so the sequence restarts per call); entry 4 is the batch's
// per-item error: it must come back as { escrowId, error } with the
// error forwarded byte-identical from batchResults and NO webhook,
// and it must not consume an eventId. Every built webhook must
// re-verify under the bench secret.
const BATCH_WEBHOOK_EVENT_IDS = [
  "bench-batch-event-1",
  "bench-batch-event-2",
  "bench-batch-event-3",
];
function batchWebhookEventIdFactory(): () => string {
  let n = 0;
  return () => `bench-batch-event-${++n}`;
}
function checkBatchWebhooks(
  built: ReturnType<typeof buildSettlementWebhooks>,
): void {
  if (built.length !== batchResults.length) {
    throw new Error("benchmark batch webhook check failed: count mismatch");
  }
  const seenEventIds = new Set<string>();
  for (let i = 0; i < built.length; i++) {
    if (built[i].escrowId !== batchResults[i].escrowId) {
      throw new Error("benchmark batch webhook check failed: order not preserved");
    }
    const expectedOutcome = BATCH_EXPECTED_OUTCOMES[i];
    if (expectedOutcome === undefined) {
      const entryError = built[i].error;
      if (
        built[i].webhook !== undefined ||
        entryError !== batchResults[i].error ||
        typeof entryError !== "string" ||
        entryError.length === 0
      ) {
        throw new Error("benchmark batch webhook check failed: error not forwarded");
      }
    } else {
      const webhook = built[i].webhook;
      if (
        built[i].error !== undefined ||
        webhook === undefined ||
        webhook.payload.escrowId !== batchResults[i].escrowId ||
        webhook.payload.outcome !== expectedOutcome ||
        webhook.payload.eventId !==
          BATCH_WEBHOOK_EVENT_IDS[seenEventIds.size] ||
        seenEventIds.has(webhook.payload.eventId) ||
        !verifySettlementWebhook(
          JSON.stringify(webhook.payload),
          webhook.signature,
          WEBHOOK_SECRET,
        )
      ) {
        throw new Error("benchmark batch webhook check failed: webhook mismatch");
      }
      seenEventIds.add(webhook.payload.eventId);
    }
  }
  if (seenEventIds.size !== BATCH_WEBHOOK_EVENT_IDS.length) {
    throw new Error("benchmark batch webhook check failed: eventId set mismatch");
  }
}
checkBatchWebhooks(
  buildSettlementWebhooks(batchResults, {
    secret: WEBHOOK_SECRET,
    now: WEBHOOK_NOW,
    eventIdFactory: batchWebhookEventIdFactory(),
  }),
);
const webhook = buildSettlementWebhook(report, {
  secret: WEBHOOK_SECRET,
  now: WEBHOOK_NOW,
  eventId: WEBHOOK_EVENT_ID,
});
const webhookBody = JSON.stringify(webhook.payload);
if (!verifySettlementWebhook(webhookBody, webhook.signature, WEBHOOK_SECRET)) {
  throw new Error("benchmark fixture failed: webhook does not verify");
}
// Secret-rotation fixture checks, outside the timed loop: the main
// webhook above is signed with WEBHOOK_SECRET, which plays the OLD
// secret; under { secrets: [new, old] } it must verify (the match is
// the second candidate tried), a candidate pair with no match must
// return false without throwing, and an empty candidate set must
// throw the pinned configuration error.
const WEBHOOK_ROTATION_OPTS = {
  secrets: [WEBHOOK_ROTATION_NEW_SECRET, WEBHOOK_SECRET],
};
if (
  !verifySettlementWebhook(webhookBody, webhook.signature, WEBHOOK_ROTATION_OPTS)
) {
  throw new Error("benchmark fixture failed: webhook rotation verify");
}
if (
  verifySettlementWebhook(webhookBody, webhook.signature, {
    secrets: [WEBHOOK_ROTATION_NEW_SECRET, WEBHOOK_ROTATION_UNRELATED_SECRET],
  })
) {
  throw new Error(
    "benchmark fixture failed: webhook rotation all-mismatch must be false",
  );
}
let webhookRotationEmptyError = "";
try {
  verifySettlementWebhook(webhookBody, webhook.signature, { secrets: [] });
} catch (err) {
  webhookRotationEmptyError = err instanceof Error ? err.message : String(err);
}
if (webhookRotationEmptyError !== WEBHOOK_ROTATION_EMPTY_SECRETS_ERROR) {
  throw new Error(
    "benchmark fixture failed: webhook rotation empty secrets error mismatch",
  );
}
// MaxAgeMs freshness fixture checks, outside the timed loop: the main
// webhook above was built at WEBHOOK_NOW, so its payload `at` is
// BASE + 60s; the timed options inject now = at + 120s under a
// 300,000 ms window (inside the window, must verify), an injected
// now one millisecond past the boundary must return false, an
// injected now exactly at the boundary must still verify
// (inclusive), and an illegal maxAgeMs must throw the pinned
// configuration error.
const WEBHOOK_MAX_AGE_OPTS = {
  secrets: [WEBHOOK_SECRET],
  maxAgeMs: WEBHOOK_MAX_AGE_MS,
  now: WEBHOOK_MAX_AGE_NOW_MS,
};
if (
  !verifySettlementWebhook(webhookBody, webhook.signature, WEBHOOK_MAX_AGE_OPTS)
) {
  throw new Error("benchmark fixture failed: webhook maxAgeMs verify");
}
if (
  verifySettlementWebhook(webhookBody, webhook.signature, {
    secrets: [WEBHOOK_SECRET],
    maxAgeMs: WEBHOOK_MAX_AGE_MS,
    now: BASE_MS + 60_000 + WEBHOOK_MAX_AGE_MS + 1,
  })
) {
  throw new Error(
    "benchmark fixture failed: webhook maxAgeMs over-age must be false",
  );
}
if (
  !verifySettlementWebhook(webhookBody, webhook.signature, {
    secrets: [WEBHOOK_SECRET],
    maxAgeMs: WEBHOOK_MAX_AGE_MS,
    now: BASE_MS + 60_000 + WEBHOOK_MAX_AGE_MS,
  })
) {
  throw new Error(
    "benchmark fixture failed: webhook maxAgeMs boundary must verify",
  );
}
let webhookMaxAgeIllegalError = "";
try {
  verifySettlementWebhook(webhookBody, webhook.signature, {
    secrets: [WEBHOOK_SECRET],
    maxAgeMs: -1,
    now: WEBHOOK_MAX_AGE_NOW_MS,
  });
} catch (err) {
  webhookMaxAgeIllegalError = err instanceof Error ? err.message : String(err);
}
if (webhookMaxAgeIllegalError !== WEBHOOK_MAX_AGE_ILLEGAL_ERROR) {
  throw new Error(
    "benchmark fixture failed: webhook maxAgeMs illegal error mismatch",
  );
}
// MaxFutureSkewMs future-skew fixture checks, outside the timed loop:
// the main webhook above was built at WEBHOOK_NOW, so its payload `at`
// is BASE + 60s; the timed options inject now = at - 120s under a
// 300,000 ms skew window (the payload sits 120 s in the future, inside
// the window, must verify), an injected now one millisecond before
// the boundary must return false, an injected now exactly at the
// boundary must still verify (inclusive), both bounds set together
// must reject on each side while a payload inside both windows still
// verifies, and an illegal maxFutureSkewMs must throw the pinned
// configuration error.
const WEBHOOK_MAX_FUTURE_SKEW_OPTS = {
  secrets: [WEBHOOK_SECRET],
  maxFutureSkewMs: WEBHOOK_MAX_FUTURE_SKEW_MS,
  now: WEBHOOK_MAX_FUTURE_SKEW_NOW_MS,
};
if (
  !verifySettlementWebhook(
    webhookBody,
    webhook.signature,
    WEBHOOK_MAX_FUTURE_SKEW_OPTS,
  )
) {
  throw new Error("benchmark fixture failed: webhook maxFutureSkewMs verify");
}
if (
  verifySettlementWebhook(webhookBody, webhook.signature, {
    secrets: [WEBHOOK_SECRET],
    maxFutureSkewMs: WEBHOOK_MAX_FUTURE_SKEW_MS,
    now: BASE_MS + 60_000 - WEBHOOK_MAX_FUTURE_SKEW_MS - 1,
  })
) {
  throw new Error(
    "benchmark fixture failed: webhook maxFutureSkewMs over-skew must be false",
  );
}
if (
  !verifySettlementWebhook(webhookBody, webhook.signature, {
    secrets: [WEBHOOK_SECRET],
    maxFutureSkewMs: WEBHOOK_MAX_FUTURE_SKEW_MS,
    now: BASE_MS + 60_000 - WEBHOOK_MAX_FUTURE_SKEW_MS,
  })
) {
  throw new Error(
    "benchmark fixture failed: webhook maxFutureSkewMs boundary must verify",
  );
}
if (
  !verifySettlementWebhook(webhookBody, webhook.signature, {
    secrets: [WEBHOOK_SECRET],
    maxAgeMs: WEBHOOK_MAX_AGE_MS,
    maxFutureSkewMs: WEBHOOK_MAX_FUTURE_SKEW_MS,
    now: WEBHOOK_MAX_FUTURE_SKEW_NOW_MS,
  })
) {
  throw new Error(
    "benchmark fixture failed: webhook two-sided window inside must verify",
  );
}
if (
  verifySettlementWebhook(webhookBody, webhook.signature, {
    secrets: [WEBHOOK_SECRET],
    maxAgeMs: 600_000,
    maxFutureSkewMs: WEBHOOK_MAX_FUTURE_SKEW_MS,
    now: BASE_MS + 60_000 - WEBHOOK_MAX_FUTURE_SKEW_MS - 1,
  })
) {
  throw new Error(
    "benchmark fixture failed: webhook two-sided window future side must reject",
  );
}
if (
  verifySettlementWebhook(webhookBody, webhook.signature, {
    secrets: [WEBHOOK_SECRET],
    maxAgeMs: WEBHOOK_MAX_AGE_MS,
    maxFutureSkewMs: 600_000,
    now: BASE_MS + 60_000 + WEBHOOK_MAX_AGE_MS + 1,
  })
) {
  throw new Error(
    "benchmark fixture failed: webhook two-sided window age side must reject",
  );
}
let webhookMaxFutureSkewIllegalError = "";
try {
  verifySettlementWebhook(webhookBody, webhook.signature, {
    secrets: [WEBHOOK_SECRET],
    maxFutureSkewMs: -1,
    now: WEBHOOK_MAX_FUTURE_SKEW_NOW_MS,
  });
} catch (err) {
  webhookMaxFutureSkewIllegalError =
    err instanceof Error ? err.message : String(err);
}
if (webhookMaxFutureSkewIllegalError !== WEBHOOK_MAX_FUTURE_SKEW_ILLEGAL_ERROR) {
  throw new Error(
    "benchmark fixture failed: webhook maxFutureSkewMs illegal error mismatch",
  );
}
const ndjsonEscrow = runNdjsonLifecycle();
if (ndjsonEscrow.state !== "RELEASED" || ndjsonEscrow.history.length !== 8) {
  throw new Error("benchmark fixture failed: NDJSON lifecycle shape");
}
// Detached plain copies, exactly what a persisted audit log looks like.
const ndjsonHistoryFixture: EscrowHistoryEntry[] = ndjsonEscrow.history.map(
  (e) => ({ ...e }),
);
if (!verifyHistoryChain(ndjsonHistoryFixture)) {
  throw new Error("benchmark fixture failed: NDJSON history chain");
}
// Quorum fixture self-check, outside the timed loop: the threshold
// boundary must be exact (4/9 does not reach quorum, 5/9 does), the
// counted approvals must match the votes cast, and a duplicate
// approval must be idempotent (no double count).
{
  const quorum = createQuorum({
    threshold: QUORUM_THRESHOLD,
    signers: QUORUM_SIGNERS,
    now: () => BASE_MS,
  });
  for (let i = 0; i < QUORUM_THRESHOLD - 1; i++) {
    quorum.approve(QUORUM_SIGNERS[i]);
  }
  if (quorum.hasQuorum() || quorum.approvalCount() !== QUORUM_THRESHOLD - 1) {
    throw new Error("benchmark fixture failed: quorum below threshold");
  }
  quorum.approve(QUORUM_SIGNERS[QUORUM_THRESHOLD - 1]);
  if (!quorum.hasQuorum() || quorum.approvalCount() !== QUORUM_THRESHOLD) {
    throw new Error("benchmark fixture failed: quorum at threshold");
  }
  quorum.approve(QUORUM_SIGNERS[0]);
  if (
    quorum.approvalCount() !== QUORUM_THRESHOLD ||
    quorum.approvals().length !== QUORUM_THRESHOLD
  ) {
    throw new Error("benchmark fixture failed: duplicate approve double-counted");
  }
  const measured = runQuorumToThreshold();
  if (!measured.hasQuorum() || measured.approvalCount() !== QUORUM_THRESHOLD) {
    throw new Error("benchmark fixture failed: quorum accumulation shape");
  }
}

// ---------------------------------------------------------------------
// Quorum revoke-cycle fixture: hand-pinned expectations for one
// change-of-vote cycle on a fresh 5/9 quorum (fixed injected clock),
// cross-checked against test/revoke.test.ts — never derived by
// calling the implementation under test:
//   approve dao-1..dao-5 -> count 5, hasQuorum true,
//     approvals [dao-1, dao-2, dao-3, dao-4, dao-5]
//   revoke dao-3         -> count 4, hasQuorum false,
//     approvals [dao-1, dao-2, dao-4, dao-5]
//   re-approve dao-3     -> count 5, hasQuorum true,
//     approvals [dao-1, dao-2, dao-4, dao-5, dao-3]
//     (the re-approved signer returns LAST: approvals() is ordered
//     by each signer's latest approval, and the re-approval is the
//     latest entry in the log)
// ---------------------------------------------------------------------
const REVOKE_SIGNER = "dao-3";
const REVOKE_AT_THRESHOLD_APPROVALS: readonly string[] = [
  "dao-1",
  "dao-2",
  "dao-3",
  "dao-4",
  "dao-5",
];
const REVOKE_BELOW_APPROVALS: readonly string[] = [
  "dao-1",
  "dao-2",
  "dao-4",
  "dao-5",
];
const REVOKE_RESTORED_APPROVALS: readonly string[] = [
  "dao-1",
  "dao-2",
  "dao-4",
  "dao-5",
  "dao-3",
];

function checkQuorumRevokeState(
  quorum: Quorum,
  expectedCount: number,
  expectedHasQuorum: boolean,
  expectedApprovals: readonly string[],
  stage: string,
): void {
  const approvals = quorum.approvals();
  if (
    quorum.approvalCount() !== expectedCount ||
    quorum.hasQuorum() !== expectedHasQuorum ||
    approvals.length !== expectedApprovals.length ||
    approvals.some((s, i) => s !== expectedApprovals[i])
  ) {
    throw new Error(
      `benchmark self-check failed: quorum revoke cycle (${stage})`,
    );
  }
}

function runQuorumRevokeCycle(): Quorum {
  const quorum = createQuorum({
    threshold: QUORUM_THRESHOLD,
    signers: QUORUM_SIGNERS,
    now: () => BASE_MS,
  });
  for (let i = 0; i < QUORUM_THRESHOLD; i++) {
    quorum.approve(QUORUM_SIGNERS[i]);
  }
  checkQuorumRevokeState(
    quorum,
    QUORUM_THRESHOLD,
    true,
    REVOKE_AT_THRESHOLD_APPROVALS,
    "at threshold",
  );
  quorum.revoke(REVOKE_SIGNER);
  checkQuorumRevokeState(
    quorum,
    QUORUM_THRESHOLD - 1,
    false,
    REVOKE_BELOW_APPROVALS,
    "after revoke",
  );
  quorum.approve(REVOKE_SIGNER);
  checkQuorumRevokeState(
    quorum,
    QUORUM_THRESHOLD,
    true,
    REVOKE_RESTORED_APPROVALS,
    "after re-approve",
  );
  return quorum;
}
// Pre-check outside the timed loop: one full revoke cycle runs
// clean before any number is reported.
runQuorumRevokeCycle();

// Revoke rejection probes (outside the timed loop, never timed):
// revoking an unknown signer and revoking a known signer that has
// not approved both throw their exact hand-pinned messages (from
// src/quorum.ts, cross-checked against test/revoke.test.ts) and
// leave the quorum's counted approvals unchanged.
{
  const probe = createQuorum({
    threshold: QUORUM_THRESHOLD,
    signers: QUORUM_SIGNERS,
    now: () => BASE_MS,
  });
  probe.approve(QUORUM_SIGNERS[0]);
  let unknownError: unknown;
  try {
    probe.revoke("mallory");
  } catch (err) {
    unknownError = err;
  }
  if (
    !(unknownError instanceof Error) ||
    unknownError.message !== 'unknown quorum signer: "mallory"' ||
    probe.approvalCount() !== 1 ||
    probe.hasQuorum() !== false
  ) {
    throw new Error(
      "benchmark fixture failed: quorum revoke probe (unknown signer)",
    );
  }
  let notApprovedError: unknown;
  try {
    probe.revoke("dao-6");
  } catch (err) {
    notApprovedError = err;
  }
  if (
    !(notApprovedError instanceof Error) ||
    notApprovedError.message !==
      'cannot revoke: signer "dao-6" has not approved' ||
    probe.approvalCount() !== 1 ||
    probe.approvals().length !== 1 ||
    probe.approvals()[0] !== QUORUM_SIGNERS[0]
  ) {
    throw new Error(
      "benchmark fixture failed: quorum revoke probe (not approved)",
    );
  }
}

// ---------------------------------------------------------------------
// Quorum approval-expiry fixture: hand-pinned expectations for one
// expiry cycle on a fresh 5/9 quorum configured with
// `maxApprovalAgeMs` = 60s (the window test/quorumExpiry.test.ts
// uses) on an advancing injected clock, cross-checked against
// test/quorumExpiry.test.ts — never derived by calling the
// implementation under test. Approvals are recorded staggered:
//   dao-1 at BASE, dao-2 at BASE + 30s, dao-3..dao-5 at BASE + 60s
// Counting-view expectations at each pinned instant:
//   BASE + 60s     -> count 5, hasQuorum true,
//     approvals [dao-1, dao-2, dao-3, dao-4, dao-5], log 5
//     (dao-1's age is exactly the window: the boundary is
//     inclusive, so the boundary ticket still counts)
//   BASE + 60s + 1 -> count 4, hasQuorum false,
//     approvals [dao-2, dao-3, dao-4, dao-5], log 5
//     (dao-1 expired; expiry never deletes the audit log)
//   BASE + 90s     -> count 4, hasQuorum false,
//     approvals [dao-2, dao-3, dao-4, dao-5], log 5
//     (dao-2's age is now exactly the window: still counted)
//   BASE + 90s + 1 -> count 3, hasQuorum false,
//     approvals [dao-3, dao-4, dao-5], log 5 (dao-2 expired too)
//   re-approve dao-1 at BASE + 90s + 1
//                  -> count 4, hasQuorum false,
//     approvals [dao-3, dao-4, dao-5, dao-1], log 6
//     (the re-approved signer returns LAST: approvals() is
//     ordered by each signer's latest approval)
//   re-approve dao-2 at BASE + 90s + 1
//                  -> count 5, hasQuorum true,
//     approvals [dao-3, dao-4, dao-5, dao-1, dao-2], log 7
// ---------------------------------------------------------------------
const EXPIRY_WINDOW_MS = 60_000;
const EXPIRY_ALL_COUNTED: readonly string[] = [
  "dao-1",
  "dao-2",
  "dao-3",
  "dao-4",
  "dao-5",
];
const EXPIRY_AFTER_DAO1: readonly string[] = [
  "dao-2",
  "dao-3",
  "dao-4",
  "dao-5",
];
const EXPIRY_AFTER_DAO2: readonly string[] = ["dao-3", "dao-4", "dao-5"];
const EXPIRY_DAO1_RESTORED: readonly string[] = [
  "dao-3",
  "dao-4",
  "dao-5",
  "dao-1",
];
const EXPIRY_RESTORED: readonly string[] = [
  "dao-3",
  "dao-4",
  "dao-5",
  "dao-1",
  "dao-2",
];

function checkQuorumExpiryState(
  quorum: Quorum,
  expectedCount: number,
  expectedHasQuorum: boolean,
  expectedApprovals: readonly string[],
  expectedLogLength: number,
  stage: string,
): void {
  const approvals = quorum.approvals();
  if (
    quorum.approvalCount() !== expectedCount ||
    quorum.hasQuorum() !== expectedHasQuorum ||
    approvals.length !== expectedApprovals.length ||
    approvals.some((s, i) => s !== expectedApprovals[i]) ||
    quorum.approvalLog().length !== expectedLogLength
  ) {
    throw new Error(
      `benchmark self-check failed: quorum maxApprovalAgeMs expiry (${stage})`,
    );
  }
}

function runQuorumApprovalExpiry(): Quorum {
  let clockMs = BASE_MS;
  const quorum = createQuorum({
    threshold: QUORUM_THRESHOLD,
    signers: QUORUM_SIGNERS,
    now: () => clockMs,
    maxApprovalAgeMs: EXPIRY_WINDOW_MS,
  });
  quorum.approve(QUORUM_SIGNERS[0]); // dao-1 at BASE
  clockMs = BASE_MS + 30_000;
  quorum.approve(QUORUM_SIGNERS[1]); // dao-2 at BASE + 30s
  clockMs = BASE_MS + EXPIRY_WINDOW_MS;
  quorum.approve(QUORUM_SIGNERS[2]); // dao-3..dao-5 at BASE + 60s
  quorum.approve(QUORUM_SIGNERS[3]);
  quorum.approve(QUORUM_SIGNERS[4]);
  checkQuorumExpiryState(
    quorum,
    QUORUM_THRESHOLD,
    true,
    EXPIRY_ALL_COUNTED,
    5,
    "all counted, dao-1 at boundary",
  );
  clockMs = BASE_MS + EXPIRY_WINDOW_MS + 1;
  checkQuorumExpiryState(
    quorum,
    QUORUM_THRESHOLD - 1,
    false,
    EXPIRY_AFTER_DAO1,
    5,
    "dao-1 expired",
  );
  clockMs = BASE_MS + 90_000;
  checkQuorumExpiryState(
    quorum,
    QUORUM_THRESHOLD - 1,
    false,
    EXPIRY_AFTER_DAO1,
    5,
    "dao-2 at boundary",
  );
  clockMs = BASE_MS + 90_001;
  checkQuorumExpiryState(
    quorum,
    QUORUM_THRESHOLD - 2,
    false,
    EXPIRY_AFTER_DAO2,
    5,
    "dao-2 expired",
  );
  quorum.approve(QUORUM_SIGNERS[0]); // dao-1 re-approves at BASE + 90s + 1
  checkQuorumExpiryState(
    quorum,
    QUORUM_THRESHOLD - 1,
    false,
    EXPIRY_DAO1_RESTORED,
    6,
    "dao-1 re-approved",
  );
  quorum.approve(QUORUM_SIGNERS[1]); // dao-2 re-approves at BASE + 90s + 1
  checkQuorumExpiryState(
    quorum,
    QUORUM_THRESHOLD,
    true,
    EXPIRY_RESTORED,
    7,
    "quorum restored",
  );
  return quorum;
}
// Pre-check outside the timed loop: one full expiry cycle runs
// clean before any number is reported.
runQuorumApprovalExpiry();

// Expiry retention probe (outside the timed loop, never timed):
// a quorum whose approvals have ALL expired still holds its
// complete audit log (expiry never deletes), and re-approving
// one expired signer restores exactly that signer's count with
// a fresh entry — pinned to its literal canonical timestamp —
// appended to the log.
{
  let probeClockMs = BASE_MS;
  const probe = createQuorum({
    threshold: QUORUM_THRESHOLD,
    signers: QUORUM_SIGNERS,
    now: () => probeClockMs,
    maxApprovalAgeMs: EXPIRY_WINDOW_MS,
  });
  for (let i = 0; i < QUORUM_THRESHOLD; i++) {
    probe.approve(QUORUM_SIGNERS[i]);
  }
  probeClockMs = BASE_MS + EXPIRY_WINDOW_MS + 1;
  const logAfterExpiry = probe.approvalLog();
  if (
    probe.approvalCount() !== 0 ||
    probe.hasQuorum() !== false ||
    probe.approvals().length !== 0 ||
    logAfterExpiry.length !== QUORUM_THRESHOLD ||
    logAfterExpiry.some(
      (e, i) =>
        e.signerId !== QUORUM_SIGNERS[i] ||
        e.at !== "2026-01-01T00:00:00.000Z",
    )
  ) {
    throw new Error(
      "benchmark fixture failed: quorum expiry probe (log retention)",
    );
  }
  probe.approve(QUORUM_SIGNERS[0]);
  const logAfterReapprove = probe.approvalLog();
  if (
    probe.approvalCount() !== 1 ||
    probe.approvals().length !== 1 ||
    probe.approvals()[0] !== QUORUM_SIGNERS[0] ||
    logAfterReapprove.length !== QUORUM_THRESHOLD + 1 ||
    logAfterReapprove[QUORUM_THRESHOLD].signerId !== QUORUM_SIGNERS[0] ||
    logAfterReapprove[QUORUM_THRESHOLD].at !== "2026-01-01T00:01:00.001Z"
  ) {
    throw new Error(
      "benchmark fixture failed: quorum expiry probe (re-approval)",
    );
  }
}

// Restore fixture: a snapshot of that same 9-signer / threshold-5
// quorum shape, carrying 7 recorded approvals — dao-1..dao-7 approving
// in order, one second apart on a stepped fixed clock starting at
// BASE_MS (approval i at BASE_MS + i * 1000). Built once, outside the
// timed loop, then pushed through a JSON stringify/parse round-trip
// so the timed path restores exactly the plain-data form a persisted
// snapshot has after a restart. Hand-written expectations (NOT
// produced by the implementation): 7 approvals recorded, all 7 count
// (no expiry window is configured), the threshold of 5 is reached,
// the counted approvals are dao-1..dao-7 in record order, and the
// audit log holds exactly those 7 entries.
const RESTORE_APPROVAL_COUNT = 7;
const RESTORE_EXPECTED_APPROVALS: readonly string[] = QUORUM_SIGNERS.slice(
  0,
  RESTORE_APPROVAL_COUNT,
);
const RESTORE_CONFIG = {
  threshold: QUORUM_THRESHOLD,
  signers: QUORUM_SIGNERS,
  now: () => BASE_MS,
};
const restoreSnapshot: QuorumSnapshot = ((): QuorumSnapshot => {
  let clockMs = BASE_MS;
  const source = createQuorum({
    threshold: QUORUM_THRESHOLD,
    signers: QUORUM_SIGNERS,
    now: () => clockMs,
  });
  for (let i = 0; i < RESTORE_APPROVAL_COUNT; i++) {
    clockMs = BASE_MS + i * 1000;
    source.approve(QUORUM_SIGNERS[i]);
  }
  return source.snapshot();
})();
const restorePersisted: unknown = JSON.parse(JSON.stringify(restoreSnapshot));
function checkRestoredQuorum(restored: Quorum): void {
  const approvals = restored.approvals();
  if (
    !restored.hasQuorum() ||
    restored.approvalCount() !== RESTORE_APPROVAL_COUNT ||
    approvals.length !== RESTORE_APPROVAL_COUNT ||
    approvals.some((s, i) => s !== RESTORE_EXPECTED_APPROVALS[i]) ||
    restored.approvalLog().length !== RESTORE_APPROVAL_COUNT
  ) {
    throw new Error("benchmark restore check failed: restored quorum shape");
  }
}
// Restore pre-checks (outside the timed loop): the restored quorum
// matches the hand-written expectations, and re-snapshotting it
// reproduces the persisted snapshot byte-for-byte (canonical JSON),
// so the timed path restores a snapshot that itself round-trips.
{
  const restored = restoreQuorum(RESTORE_CONFIG, restorePersisted);
  checkRestoredQuorum(restored);
  if (JSON.stringify(restored.snapshot()) !== JSON.stringify(restoreSnapshot)) {
    throw new Error("benchmark fixture failed: restored snapshot mismatch");
  }
}
// Quorum snapshot-export fixture: the export direction of the
// group-14 shape — a 9-signer / threshold-5 quorum carrying the
// same 7 recorded approvals (dao-1..dao-7, one second apart on a
// stepped fixed clock, approval i at BASE_MS + i * 1000), built
// once, outside the timed loop. `snapshot()` is pure, so the
// timed path re-exports this one source quorum on every
// iteration. Hand-written expectations — written out in full
// below, never derived by calling `snapshot()` itself:
//   - the envelope is exactly `{ v, threshold, signers,
//     approvals }` in that key order, with NO `maxApprovalAgeMs`
//     key (no expiry window is configured on this quorum);
//   - `signers` is the 9 bench signers in config order;
//   - `approvals` holds exactly the 7 entries below, in record
//     order, each `at` the canonical ISO form of its pinned
//     instant (BASE_MS + i * 1000, written out literally).
// The detached-copy and JSON-round-trip restore checks run
// ONCE, outside the timed loop, below; the timed path re-checks
// the full exported shape on every iteration (see
// `benchQuorumSnapshotExport`).
const QUORUM_EXPORT_APPROVAL_COUNT = 7;
const QUORUM_EXPORT_EXPECTED_APPROVALS: ReadonlyArray<{
  signerId: string;
  at: string;
}> = [
  { signerId: "dao-1", at: "2026-01-01T00:00:00.000Z" },
  { signerId: "dao-2", at: "2026-01-01T00:00:01.000Z" },
  { signerId: "dao-3", at: "2026-01-01T00:00:02.000Z" },
  { signerId: "dao-4", at: "2026-01-01T00:00:03.000Z" },
  { signerId: "dao-5", at: "2026-01-01T00:00:04.000Z" },
  { signerId: "dao-6", at: "2026-01-01T00:00:05.000Z" },
  { signerId: "dao-7", at: "2026-01-01T00:00:06.000Z" },
];
const quorumExportSource: Quorum = ((): Quorum => {
  let clockMs = BASE_MS;
  const source = createQuorum({
    threshold: QUORUM_THRESHOLD,
    signers: QUORUM_SIGNERS,
    now: () => clockMs,
  });
  for (let i = 0; i < QUORUM_EXPORT_APPROVAL_COUNT; i++) {
    clockMs = BASE_MS + i * 1000;
    source.approve(QUORUM_SIGNERS[i]);
  }
  return source;
})();
function checkQuorumSnapshotExport(
  snapshot: QuorumSnapshot,
  where: string,
): void {
  if (
    snapshot.v !== 1 ||
    snapshot.threshold !== QUORUM_THRESHOLD ||
    Object.keys(snapshot).join(",") !== "v,threshold,signers,approvals" ||
    "maxApprovalAgeMs" in snapshot ||
    snapshot.signers.length !== QUORUM_SIGNERS.length ||
    snapshot.signers.some((s, i) => s !== QUORUM_SIGNERS[i]) ||
    snapshot.approvals.length !== QUORUM_EXPORT_APPROVAL_COUNT ||
    snapshot.approvals.some(
      (entry, i) =>
        entry.signerId !== QUORUM_EXPORT_EXPECTED_APPROVALS[i].signerId ||
        entry.at !== QUORUM_EXPORT_EXPECTED_APPROVALS[i].at,
    )
  ) {
    throw new Error(`benchmark ${where} failed: quorum snapshot export shape`);
  }
}
// Fixture validation (outside the timed loop): the fixture
// export matches the hand-written expectations above.
checkQuorumSnapshotExport(quorumExportSource.snapshot(), "fixture");
// Detached-copy check (outside the timed loop): mutating a
// returned snapshot — rewriting its first approval entry and
// appending an extra one — leaves a re-export from the same
// quorum unchanged.
{
  const detached = quorumExportSource.snapshot();
  detached.approvals[0] = { signerId: "dao-9", at: "2026-01-01T00:00:09.000Z" };
  detached.approvals.push({ signerId: "dao-8", at: "2026-01-01T00:00:07.000Z" });
  checkQuorumSnapshotExport(quorumExportSource.snapshot(), "fixture");
}
// JSON round-trip restore check (outside the timed loop): the
// export, pushed through the persisted JSON form, restores via
// `restoreQuorum` into a quorum that matches the group-14
// hand-written expectations and re-exports byte-for-byte the
// group-14 persisted snapshot (the two fixtures share one
// shape, so their exports must agree exactly).
{
  const persisted: unknown = JSON.parse(
    JSON.stringify(quorumExportSource.snapshot()),
  );
  const restored = restoreQuorum(RESTORE_CONFIG, persisted);
  checkRestoredQuorum(restored);
  if (JSON.stringify(restored.snapshot()) !== JSON.stringify(restoreSnapshot)) {
    throw new Error(
      "benchmark fixture failed: quorum export round-trip snapshot mismatch",
    );
  }
}
// Fan-out delivery fixture: the same settled report fanned out to 4
// fixed endpoints, each with its own signing secret, under the shared
// fixed `WEBHOOK_NOW` / `WEBHOOK_EVENT_ID` above. This library's
// delivery layer calls the global `fetch` (there is no fetchImpl
// option), so the fake is installed on `globalThis`: it records the
// calls of the current fan-out, then answers 200 immediately — no
// network, no randomness, and no retry sleep is ever reached on a 200.
const FANOUT_ENDPOINTS: SettlementWebhookEndpoint[] = [
  { url: "https://billing.example.com/hooks/settlement", secret: "bench-fanout-secret-billing" },
  { url: "https://risk.example.com/hooks/settlement", secret: "bench-fanout-secret-risk" },
  { url: "https://notifications.example.com/hooks/settlement", secret: "bench-fanout-secret-notifications" },
  { url: "https://ledger.example.com/hooks/settlement", secret: "bench-fanout-secret-ledger" },
];
let fanoutCalls: Array<{ url: string; body: string; signature: string }> = [];
const fanoutFetch: typeof fetch = async (input, init) => {
  fanoutCalls.push({
    url: String(input),
    body: String(init?.body ?? ""),
    signature: String(new Headers(init?.headers).get("x-signature") ?? ""),
  });
  return new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

async function runFanout() {
  fanoutCalls = [];
  globalThis.fetch = fanoutFetch;
  const out = await deliverSettlementWebhookToMany(report, FANOUT_ENDPOINTS, {
    now: WEBHOOK_NOW,
    eventId: WEBHOOK_EVENT_ID,
  });
  if (
    out.results.length !== FANOUT_ENDPOINTS.length ||
    out.delivered !== FANOUT_ENDPOINTS.length ||
    out.failed !== 0 ||
    out.results.some((r, i) => !r.ok || r.attempts !== 1 || r.status !== 200 || r.url !== FANOUT_ENDPOINTS[i].url) ||
    fanoutCalls.length !== FANOUT_ENDPOINTS.length ||
    fanoutCalls.some((c) => c.body !== fanoutCalls[0].body) ||
    JSON.parse(fanoutCalls[0].body).eventId !== WEBHOOK_EVENT_ID
  ) {
    throw new Error("benchmark self-check failed: deliverSettlementWebhookToMany");
  }
  return out;
}

// One-time fixture validation (outside the timed loop): every endpoint
// received a copy signed with its OWN secret.
await runFanout();
for (const [i, endpoint] of FANOUT_ENDPOINTS.entries()) {
  const call = fanoutCalls.find((c) => c.url === endpoint.url);
  if (!call || !verifySettlementWebhook(call.body, call.signature, endpoint.secret)) {
    throw new Error(
      `benchmark fixture failed: fan-out endpoint ${i} signature does not verify`,
    );
  }
}

// Single-target delivery fixture: the same settled report's signed
// webhook (`webhook`, built once above via `buildSettlementWebhook`)
// delivered alone to one fixed endpoint through a fake `fetch`
// installed on `globalThis` (the delivery layer calls the global
// `fetch`; there is no fetchImpl option): the fake records the call
// and answers 200 immediately — no network, no randomness, and no
// retry sleep is ever reached on a 200 (backoffMs 0 regardless).
const SINGLE_DELIVERY_URL = "https://settlement.example.com/hooks/settlement";
let singleCalls: Array<{ url: string; body: string; signature: string }> = [];
const singleFetch: typeof fetch = async (input, init) => {
  singleCalls.push({
    url: String(input),
    body: String(init?.body ?? ""),
    signature: String(new Headers(init?.headers).get("x-signature") ?? ""),
  });
  return new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

async function runSingleDelivery() {
  singleCalls = [];
  globalThis.fetch = singleFetch;
  const result = await deliverSettlementWebhook(SINGLE_DELIVERY_URL, webhook, {
    backoffMs: 0,
  });
  if (
    result.attempts !== 1 ||
    result.status !== 200 ||
    singleCalls.length !== 1 ||
    singleCalls[0].url !== SINGLE_DELIVERY_URL ||
    singleCalls[0].body !== webhookBody ||
    singleCalls[0].signature !== webhook.signature
  ) {
    throw new Error("benchmark self-check failed: deliverSettlementWebhook");
  }
  return result;
}

// One-time fixture validation (outside the timed loop): the captured
// signature verifies over the captured body under the bench secret.
await runSingleDelivery();
if (
  !verifySettlementWebhook(singleCalls[0].body, singleCalls[0].signature, WEBHOOK_SECRET)
) {
  throw new Error(
    "benchmark fixture failed: single-target signature does not verify",
  );
}

// Retry-exhaustion check (outside the timed loop, never timed): a
// persistent-500 script with retries 2 and backoffMs 0 must throw the
// exact hand-pinned exhaustion message after exactly 3 attempts.
{
  let exhaustedCalls = 0;
  const exhaustedFetch: typeof fetch = async () => {
    exhaustedCalls++;
    return new Response("boom", {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  };
  globalThis.fetch = exhaustedFetch;
  let exhaustedError: unknown;
  try {
    await deliverSettlementWebhook(SINGLE_DELIVERY_URL, webhook, {
      retries: 2,
      backoffMs: 0,
    });
  } catch (err) {
    exhaustedError = err;
  }
  const expectedExhausted =
    `webhook delivery to ${SINGLE_DELIVERY_URL} failed after 3 attempts: ` +
    "server responded with status 500";
  if (
    !(exhaustedError instanceof Error) ||
    exhaustedError.message !== expectedExhausted ||
    exhaustedCalls !== 3
  ) {
    throw new Error(
      "benchmark fixture failed: deliverSettlementWebhook exhaustion shape",
    );
  }
}

// Pre-aborted delivery fixture: the same signed webhook (`webhook`,
// built once above) delivered with a signal that is already aborted
// before the call, through a counting fake `fetch` installed on
// `globalThis` (the delivery layer calls the global `fetch`; there
// is no fetchImpl option): the fake would answer 200 immediately,
// but the pre-aborted check runs before any request, so it must
// never be reached — the call count stays at exactly zero on every
// iteration. No network, no randomness, and no wall clock.
let abortedCalls = 0;
const abortedFetch: typeof fetch = async () => {
  abortedCalls++;
  return new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
const abortedController = new AbortController();
abortedController.abort();

async function runPreAbortedDelivery() {
  globalThis.fetch = abortedFetch;
  let abortedError: unknown;
  try {
    await deliverSettlementWebhook(SINGLE_DELIVERY_URL, webhook, {
      signal: abortedController.signal,
    });
  } catch (err) {
    abortedError = err;
  }
  if (
    !(abortedError instanceof Error) ||
    abortedError.message !== DELIVERY_ABORTED_ERROR ||
    abortedCalls !== 0
  ) {
    throw new Error(
      "benchmark self-check failed: deliverSettlementWebhook pre-aborted",
    );
  }
}

// One-time fixture validation (outside the timed loop): the
// pre-aborted call itself rejects with the pinned error and zero
// fetch calls (the timed runner re-checks both on every iteration).
await runPreAbortedDelivery();

// Bad-signal check (outside the timed loop, never timed): a
// non-AbortSignal `signal` value must throw the exact pinned
// configuration error before any request — the counting fake
// fetch above must still be at zero calls afterwards.
{
  globalThis.fetch = abortedFetch;
  let badSignalError: unknown;
  try {
    await deliverSettlementWebhook(SINGLE_DELIVERY_URL, webhook, {
      signal: "bench-not-a-signal" as unknown as AbortSignal,
    });
  } catch (err) {
    badSignalError = err;
  }
  if (
    !(badSignalError instanceof Error) ||
    badSignalError.message !== DELIVERY_BAD_SIGNAL_ERROR ||
    abortedCalls !== 0
  ) {
    throw new Error(
      "benchmark fixture failed: deliverSettlementWebhook bad signal shape",
    );
  }
}

// Un-aborted signal check (outside the timed loop, never timed): a
// signal that never aborts must leave the normal delivery path
// untouched — one fetch, answered 200, result { status: 200,
// attempts: 1 }.
{
  let liveSignalCalls = 0;
  const liveSignalFetch: typeof fetch = async () => {
    liveSignalCalls++;
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  globalThis.fetch = liveSignalFetch;
  const liveController = new AbortController();
  const liveResult = await deliverSettlementWebhook(
    SINGLE_DELIVERY_URL,
    webhook,
    { signal: liveController.signal },
  );
  if (
    liveResult.status !== 200 ||
    liveResult.attempts !== 1 ||
    liveSignalCalls !== 1
  ) {
    throw new Error(
      "benchmark fixture failed: deliverSettlementWebhook un-aborted signal shape",
    );
  }
}

// maxRetryDelayMs clamp fixture: the same signed webhook (`webhook`,
// built once above) delivered with `maxRetryDelayMs: 0` through a
// fake `fetch` installed on `globalThis` (the delivery layer calls
// the global `fetch`; there is no fetchImpl option): the fake answers
// 429 with `Retry-After: 31536000` (31,536,000 seconds — a one-year
// hint) on the first call of each run and 200 on the second. The
// delivery layer parses the hint to 31,536,000,000 ms and clamps it
// with `Math.min(hinted, maxRetryDelayMs)` to exactly 0, so the retry
// is immediate — no real sleep ever happens. The call count is reset
// at the start of every run, so each run must see exactly two calls.
// No network, no randomness, and no wall clock.
let clampCalls = 0;
const clampFetch: typeof fetch = async () => {
  clampCalls++;
  if (clampCalls === 1) {
    return new Response("rate limited", {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": DELIVERY_MAX_RETRY_DELAY_HINT,
      },
    });
  }
  return new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

async function runMaxRetryDelayClampDelivery() {
  clampCalls = 0;
  globalThis.fetch = clampFetch;
  const result = await deliverSettlementWebhook(SINGLE_DELIVERY_URL, webhook, {
    maxRetryDelayMs: 0,
  });
  if (
    result.status !== 200 ||
    result.attempts !== 2 ||
    clampCalls !== 2
  ) {
    throw new Error(
      "benchmark self-check failed: deliverSettlementWebhook maxRetryDelayMs clamp",
    );
  }
  return result;
}

// One-time fixture validation (outside the timed loop): the clamped
// delivery itself resolves with the pinned shape after exactly two
// fetch calls (the timed runner re-checks all of it on every
// iteration).
await runMaxRetryDelayClampDelivery();

// Illegal maxRetryDelayMs check (outside the timed loop, never
// timed): a negative cap must throw the exact pinned configuration
// error before any request — the counting fake fetch above must
// still be at zero calls for this run afterwards.
{
  let illegalCalls = 0;
  const illegalFetch: typeof fetch = async () => {
    illegalCalls++;
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  globalThis.fetch = illegalFetch;
  let illegalError: unknown;
  try {
    await deliverSettlementWebhook(SINGLE_DELIVERY_URL, webhook, {
      maxRetryDelayMs: -1,
    });
  } catch (err) {
    illegalError = err;
  }
  if (
    !(illegalError instanceof Error) ||
    illegalError.message !== DELIVERY_MAX_RETRY_DELAY_ILLEGAL_ERROR ||
    illegalCalls !== 0
  ) {
    throw new Error(
      "benchmark fixture failed: deliverSettlementWebhook maxRetryDelayMs illegal shape",
    );
  }
}

// Hint-less 5xx fallback check (outside the timed loop, never
// timed): a 500 without any `Retry-After` hint, then a 200, must
// keep the exponential-backoff fallback shape — with backoffMs 0
// the computed backoff is 0, so no real waiting happens and the
// result is `{ status: 200, attempts: 2 }` after exactly two calls.
{
  let fallbackCalls = 0;
  const fallbackFetch: typeof fetch = async () => {
    fallbackCalls++;
    if (fallbackCalls === 1) {
      return new Response("boom", {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  globalThis.fetch = fallbackFetch;
  const fallbackResult = await deliverSettlementWebhook(
    SINGLE_DELIVERY_URL,
    webhook,
    { backoffMs: 0, maxRetryDelayMs: 0 },
  );
  if (
    fallbackResult.status !== 200 ||
    fallbackResult.attempts !== 2 ||
    fallbackCalls !== 2
  ) {
    throw new Error(
      "benchmark fixture failed: deliverSettlementWebhook 5xx backoff fallback shape",
    );
  }
}

// timeoutMs timeout fixture: the same signed webhook (`webhook`,
// built once above) delivered with `timeoutMs: 10` and
// `retries: 0` through a hanging fake `fetch` installed on
// `globalThis` (the delivery layer calls the global `fetch`;
// there is no fetchImpl option): the fake only ever rejects
// when its request signal aborts, so the pinned short timeout
// is the only thing that can end the attempt — the delivery
// fails after exactly 1 attempt with the pinned timeout text
// as its last cause, and the fake is called exactly once per
// run. The call count is reset at the start of every run.
// Honest limit: the timeout wait is the object under test and
// is the pinned short 10 ms — no elapsed-time assertion is
// made anywhere. No network, no randomness.
const DELIVERY_TIMEOUT_MS = 10;
const DELIVERY_TIMEOUT_GENEROUS_MS = 5000;
const DELIVERY_TIMEOUT_ERROR =
  `webhook delivery to ${SINGLE_DELIVERY_URL} failed after 1 attempt: ` +
  "webhook delivery timed out after 10ms";
const DELIVERY_TIMEOUT_ILLEGAL_ERROR =
  "cannot deliver settlement webhook: timeoutMs must be a positive number, got 0";
let timeoutCalls = 0;
const timeoutHangingFetch: typeof fetch = async (_input, init) => {
  timeoutCalls++;
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal === null || signal === undefined) {
      reject(new Error("benchmark hanging fetch received no request signal"));
      return;
    }
    if (signal.aborted) {
      reject(new Error("benchmark hanging fetch aborted"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(new Error("benchmark hanging fetch aborted")),
      { once: true },
    );
  });
};

async function runTimeoutDelivery() {
  timeoutCalls = 0;
  globalThis.fetch = timeoutHangingFetch;
  let timeoutError: unknown;
  try {
    await deliverSettlementWebhook(SINGLE_DELIVERY_URL, webhook, {
      timeoutMs: DELIVERY_TIMEOUT_MS,
      retries: 0,
    });
  } catch (err) {
    timeoutError = err;
  }
  if (
    !(timeoutError instanceof Error) ||
    timeoutError.message !== DELIVERY_TIMEOUT_ERROR ||
    (timeoutError as { attempts?: unknown }).attempts !== 1 ||
    timeoutCalls !== 1
  ) {
    throw new Error(
      "benchmark self-check failed: deliverSettlementWebhook timeoutMs timeout",
    );
  }
}

// One-time fixture validation (outside the timed loop): the
// timed-out delivery itself rejects with the pinned error
// after exactly one fetch call (the timed runner re-checks
// all of it on every iteration).
await runTimeoutDelivery();

// Illegal timeoutMs check (outside the timed loop, never
// timed): `timeoutMs: 0` must throw the exact pinned
// configuration error before any request — the counting fake
// fetch must still be at zero calls afterwards.
{
  let illegalTimeoutCalls = 0;
  const illegalTimeoutFetch: typeof fetch = async () => {
    illegalTimeoutCalls++;
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  globalThis.fetch = illegalTimeoutFetch;
  let illegalTimeoutError: unknown;
  try {
    await deliverSettlementWebhook(SINGLE_DELIVERY_URL, webhook, {
      timeoutMs: 0,
      retries: 0,
    });
  } catch (err) {
    illegalTimeoutError = err;
  }
  if (
    !(illegalTimeoutError instanceof Error) ||
    illegalTimeoutError.message !== DELIVERY_TIMEOUT_ILLEGAL_ERROR ||
    illegalTimeoutCalls !== 0
  ) {
    throw new Error(
      "benchmark fixture failed: deliverSettlementWebhook timeoutMs illegal shape",
    );
  }
}

// Generous timeoutMs check (outside the timed loop, never
// timed): under the generous pinned timeout an immediately-200
// fake delivers successfully with the unchanged
// `{ status: 200, attempts: 1 }` shape after exactly one call.
{
  let generousTimeoutCalls = 0;
  const generousTimeoutFetch: typeof fetch = async () => {
    generousTimeoutCalls++;
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  globalThis.fetch = generousTimeoutFetch;
  const generousResult = await deliverSettlementWebhook(
    SINGLE_DELIVERY_URL,
    webhook,
    { timeoutMs: DELIVERY_TIMEOUT_GENEROUS_MS, retries: 0 },
  );
  if (
    generousResult.status !== 200 ||
    generousResult.attempts !== 1 ||
    generousTimeoutCalls !== 1
  ) {
    throw new Error(
      "benchmark fixture failed: deliverSettlementWebhook timeoutMs generous shape",
    );
  }
}

// Dedupe fixture: 1,000 fixed `eventId`s pre-recorded in a
// `SettlementEventDedupe` under an injected FIXED clock — the clock
// never advances, so in the timed loop no entry can expire (default
// TTL is 1 hour) and none is evicted (1,001 live entries, far under
// the default 10,000 cap): the measured path is the pure steady-state
// duplicate hit, LRU recency refresh included. No network, no
// randomness, no wall clock.
const DEDUPE_PREFILL = 1000;
const DEDUPE_NOW_MS = BASE_MS + 120_000;
const dedupeIds: string[] = Array.from(
  { length: DEDUPE_PREFILL },
  (_, i) => `bench-dedupe-${String(i).padStart(4, "0")}`,
);
const dedupe = new SettlementEventDedupe({ now: () => DEDUPE_NOW_MS });
for (const id of dedupeIds) {
  if (dedupe.checkAndRecord(id)) {
    throw new Error("benchmark fixture failed: dedupe prefill saw a duplicate");
  }
}
// Semantics self-checks (outside the timed loop): an already-recorded
// id is a duplicate; an unseen id is admitted on first sight and
// judged a duplicate on the second; and the stats counters agree
// exactly with the calls made so far (1,000 prefill misses, then
// hit + miss + hit, no evictions).
if (!dedupe.checkAndRecord(dedupeIds[0])) {
  throw new Error("benchmark fixture failed: dedupe missed a recorded id");
}
if (dedupe.checkAndRecord("bench-dedupe-unseen")) {
  throw new Error("benchmark fixture failed: dedupe flagged a first sighting");
}
if (!dedupe.checkAndRecord("bench-dedupe-unseen")) {
  throw new Error("benchmark fixture failed: dedupe missed a second sighting");
}
const dedupeStatsFixture = dedupe.stats();
if (
  dedupeStatsFixture.size !== DEDUPE_PREFILL + 1 ||
  dedupeStatsFixture.hits !== 2 ||
  dedupeStatsFixture.misses !== DEDUPE_PREFILL + 1 ||
  dedupeStatsFixture.evictions !== 0
) {
  throw new Error("benchmark fixture failed: dedupe stats do not match calls");
}
let dedupeCursor = 0;

// Dedupe-restore fixture: a 1,000-entry snapshot of a dedupe that
// recorded the fixed ids `bench-restore-0000` ..
// `bench-restore-0999`, in that order, under an injected FIXED clock
// (`DEDUPE_RESTORE_NOW_MS`, a fixed instant after BASE_MS — the
// clock never advances). The snapshot goes through a JSON
// stringify/parse round-trip, exactly the persisted form a receiver
// reloads at startup. Restore runs under the default TTL (1 hour)
// and the default capacity (10,000): every entry was first seen at
// the restore instant itself (age 0), so no entry is expired at
// load and none is evicted for capacity. Hand-written expectations
// — written out here from the composition above, never derived by
// calling `restore` itself:
//   - the snapshot is `{ v: 1, entries }` with exactly 1,000 pairs,
//     in prefill order, each `seenAtMs` exactly
//     DEDUPE_RESTORE_NOW_MS;
//   - a restored dedupe reports size 1,000 with all observability
//     counters at zero (counters are not part of a snapshot);
//   - `checkAndRecord` on every snapshot id is a duplicate (true):
//     1,000 hits in total, the size stays 1,000, and an unseen id is
//     still a first sighting (false) followed by a duplicate (true).
// The exhaustive 1,000-id check runs ONCE, outside the timed loop,
// below; the timed path re-checks the counters and spot-checks the
// first / middle / last ids on every iteration (see
// `benchSettlementEventDedupeRestore`).
const DEDUPE_RESTORE_PREFILL = 1000;
const DEDUPE_RESTORE_NOW_MS = BASE_MS + 180_000;
const dedupeRestoreIds: string[] = Array.from(
  { length: DEDUPE_RESTORE_PREFILL },
  (_, i) => `bench-restore-${String(i).padStart(4, "0")}`,
);
const dedupeRestoreSource = new SettlementEventDedupe({
  now: () => DEDUPE_RESTORE_NOW_MS,
});
for (const id of dedupeRestoreIds) {
  if (dedupeRestoreSource.checkAndRecord(id)) {
    throw new Error(
      "benchmark fixture failed: dedupe restore prefill saw a duplicate",
    );
  }
}
const dedupeRestoreSnapshot = JSON.parse(
  JSON.stringify(dedupeRestoreSource.exportSnapshot()),
) as { v: unknown; entries: Array<[string, number]> };
if (
  dedupeRestoreSnapshot.v !== 1 ||
  !Array.isArray(dedupeRestoreSnapshot.entries) ||
  dedupeRestoreSnapshot.entries.length !== DEDUPE_RESTORE_PREFILL ||
  dedupeRestoreSnapshot.entries.some(
    (pair, i) =>
      pair[0] !== dedupeRestoreIds[i] || pair[1] !== DEDUPE_RESTORE_NOW_MS,
  )
) {
  throw new Error("benchmark fixture failed: dedupe restore snapshot shape");
}
// Exhaustive validation (outside the timed loop): every snapshot id
// restores as a duplicate, the counts agree exactly with the calls
// made, and an unseen id keeps first-sighting semantics.
const dedupeRestoreProbe = SettlementEventDedupe.restore(dedupeRestoreSnapshot, {
  now: () => DEDUPE_RESTORE_NOW_MS,
});
const dedupeRestoreProbeFresh = dedupeRestoreProbe.stats();
if (
  dedupeRestoreProbeFresh.size !== DEDUPE_RESTORE_PREFILL ||
  dedupeRestoreProbeFresh.hits !== 0 ||
  dedupeRestoreProbeFresh.misses !== 0 ||
  dedupeRestoreProbeFresh.evictions !== 0
) {
  throw new Error(
    "benchmark fixture failed: restored dedupe counters do not start at zero",
  );
}
for (const id of dedupeRestoreIds) {
  if (!dedupeRestoreProbe.checkAndRecord(id)) {
    throw new Error(
      "benchmark fixture failed: restored dedupe missed a snapshot id",
    );
  }
}
const dedupeRestoreProbeHits = dedupeRestoreProbe.stats();
if (
  dedupeRestoreProbeHits.size !== DEDUPE_RESTORE_PREFILL ||
  dedupeRestoreProbeHits.hits !== DEDUPE_RESTORE_PREFILL ||
  dedupeRestoreProbeHits.misses !== 0 ||
  dedupeRestoreProbeHits.evictions !== 0
) {
  throw new Error(
    "benchmark fixture failed: restored dedupe hit count differs from the hand-written expectation",
  );
}
if (dedupeRestoreProbe.checkAndRecord("bench-restore-unseen")) {
  throw new Error(
    "benchmark fixture failed: restored dedupe flagged a first sighting",
  );
}
if (!dedupeRestoreProbe.checkAndRecord("bench-restore-unseen")) {
  throw new Error(
    "benchmark fixture failed: restored dedupe missed a second sighting",
  );
}

// Dedupe-export fixture: a 1,001-entry dedupe whose export is the
// timed path. Composition, built under a STEPPED injected clock
// (the clock variable is advanced exactly once, during fixture
// construction, and never inside the timed loop):
//   - one expired entry, `bench-export-expired`, recorded first at
//     DEDUPE_EXPORT_EXPIRED_AT_MS;
//   - 1,000 live ids `bench-export-0000` .. `bench-export-0999`,
//     in that order, recorded at DEDUPE_EXPORT_NOW_MS, which is
//     exactly DEDUPE_EXPORT_TTL_MS after the expired entry's
//     first-seen instant — so at export time the expired entry's
//     age equals the TTL exactly and the live test
//     (`age < ttlMs`) excludes it, while every live id has age 0.
// Hand-written expectations — written out here from the
// composition above, never derived by calling `exportSnapshot`
// itself:
//   - the export is `{ v: 1, entries }` with exactly 1,000 pairs,
//     in record order, each `seenAtMs` exactly
//     DEDUPE_EXPORT_NOW_MS (so the first pair is
//     `bench-export-0000` and the last is `bench-export-0999`,
//     both pinned field for field);
//   - the expired id appears nowhere in the export;
//   - mutating a detached export (rewriting its first pair and
//     appending an extra pair) leaves a re-export from the same
//     store byte-identical to the pinned expectation (the export
//     is a detached copy, not a view of the store);
//   - an empty dedupe exports exactly `{ v: 1, entries: [] }`.
// The detached-copy and empty-store checks run ONCE, outside the
// timed loop, below; the timed path re-checks the full exported
// shape on every iteration (see
// `benchSettlementEventDedupeExportSnapshot`).
const DEDUPE_EXPORT_PREFILL = 1000;
const DEDUPE_EXPORT_TTL_MS = 3_600_000;
const DEDUPE_EXPORT_EXPIRED_ID = "bench-export-expired";
const DEDUPE_EXPORT_EXPIRED_AT_MS = BASE_MS + 240_000;
const DEDUPE_EXPORT_NOW_MS =
  DEDUPE_EXPORT_EXPIRED_AT_MS + DEDUPE_EXPORT_TTL_MS;
const dedupeExportIds: string[] = Array.from(
  { length: DEDUPE_EXPORT_PREFILL },
  (_, i) => `bench-export-${String(i).padStart(4, "0")}`,
);
let dedupeExportClockMs = DEDUPE_EXPORT_EXPIRED_AT_MS;
const dedupeExportSource = new SettlementEventDedupe({
  ttlMs: DEDUPE_EXPORT_TTL_MS,
  now: () => dedupeExportClockMs,
});
if (dedupeExportSource.checkAndRecord(DEDUPE_EXPORT_EXPIRED_ID)) {
  throw new Error(
    "benchmark fixture failed: dedupe export prefill saw a duplicate",
  );
}
dedupeExportClockMs = DEDUPE_EXPORT_NOW_MS;
for (const id of dedupeExportIds) {
  if (dedupeExportSource.checkAndRecord(id)) {
    throw new Error(
      "benchmark fixture failed: dedupe export prefill saw a duplicate",
    );
  }
}
function checkDedupeExportSnapshot(
  snapshot: { v: unknown; entries: Array<[string, number]> },
  where: string,
): void {
  if (
    snapshot.v !== 1 ||
    !Array.isArray(snapshot.entries) ||
    snapshot.entries.length !== DEDUPE_EXPORT_PREFILL ||
    snapshot.entries.some(
      (pair, i) =>
        pair[0] !== dedupeExportIds[i] || pair[1] !== DEDUPE_EXPORT_NOW_MS,
    ) ||
    snapshot.entries.some((pair) => pair[0] === DEDUPE_EXPORT_EXPIRED_ID)
  ) {
    throw new Error(`benchmark self-check failed: dedupe export ${where}`);
  }
}
// One-time validation (outside the timed loop): the fixture export
// matches the hand-written expectations, a detached export can be
// mutated without reaching the store, and an empty dedupe exports
// the pinned empty envelope.
checkDedupeExportSnapshot(
  dedupeExportSource.exportSnapshot(),
  "fixture export",
);
{
  const detached = dedupeExportSource.exportSnapshot();
  detached.entries[0] = ["bench-export-tampered", 0];
  detached.entries.push(["bench-export-extra", DEDUPE_EXPORT_NOW_MS]);
  checkDedupeExportSnapshot(
    dedupeExportSource.exportSnapshot(),
    "detached-copy re-export",
  );
  const empty = new SettlementEventDedupe({
    now: () => DEDUPE_EXPORT_NOW_MS,
  }).exportSnapshot();
  if (JSON.stringify(empty) !== '{"v":1,"entries":[]}') {
    throw new Error(
      "benchmark fixture failed: empty dedupe export shape differs from the hand-written expectation",
    );
  }
}

// Dedupe-clear fixture: 1,000 fixed `eventId`s recorded in a fresh
// `SettlementEventDedupe` under an injected FIXED clock (the clock
// never advances, so no entry expires and none is evicted), plus
// one duplicate hit on the first id. Hand-written expectations —
// written out here from the composition above and cross-checked
// against the dedupe clear test / demo segment, never derived by
// calling `clear()` itself:
//   - before the clear the stats are exactly
//     `{ size: 1,000, hits: 1, misses: 1,000, evictions: 0 }`;
//   - right after `clear()` the size is 0 and the stats are
//     exactly `{ size: 0, hits: 0, misses: 0, evictions: 0 }`;
//   - recording the first id again after the clear is a first
//     sighting (false), and the stats then read exactly
//     `{ size: 1, hits: 0, misses: 1, evictions: 0 }`.
// `clear()` mutates the store, so the fixture is a builder: every
// timed iteration constructs a fresh dedupe, and the reported
// numbers include that rebuild cost (see group 39 above).
const DEDUPE_CLEAR_PREFILL = 1000;
const DEDUPE_CLEAR_NOW_MS = BASE_MS + 300_000;
const dedupeClearIds: string[] = Array.from(
  { length: DEDUPE_CLEAR_PREFILL },
  (_, i) => `bench-clear-${String(i).padStart(4, "0")}`,
);
function buildDedupeClearFixture(): SettlementEventDedupe {
  const fresh = new SettlementEventDedupe({
    now: () => DEDUPE_CLEAR_NOW_MS,
  });
  for (const id of dedupeClearIds) {
    if (fresh.checkAndRecord(id)) {
      throw new Error(
        "benchmark fixture failed: dedupe clear prefill saw a duplicate",
      );
    }
  }
  if (!fresh.checkAndRecord(dedupeClearIds[0])) {
    throw new Error(
      "benchmark fixture failed: dedupe clear prefill missed a recorded id",
    );
  }
  const before = fresh.stats();
  if (
    before.size !== DEDUPE_CLEAR_PREFILL ||
    before.hits !== 1 ||
    before.misses !== DEDUPE_CLEAR_PREFILL ||
    before.evictions !== 0
  ) {
    throw new Error(
      "benchmark fixture failed: dedupe clear stats before the clear",
    );
  }
  return fresh;
}
function checkDedupeClear(where: string): void {
  const fresh = buildDedupeClearFixture();
  fresh.clear();
  const afterClear = fresh.stats();
  if (
    fresh.size !== 0 ||
    afterClear.size !== 0 ||
    afterClear.hits !== 0 ||
    afterClear.misses !== 0 ||
    afterClear.evictions !== 0 ||
    fresh.checkAndRecord(dedupeClearIds[0])
  ) {
    throw new Error(`benchmark ${where} failed: SettlementEventDedupe clear`);
  }
  const afterReRecord = fresh.stats();
  if (
    afterReRecord.size !== 1 ||
    afterReRecord.hits !== 0 ||
    afterReRecord.misses !== 1 ||
    afterReRecord.evictions !== 0
  ) {
    throw new Error(`benchmark ${where} failed: SettlementEventDedupe clear`);
  }
}
// Fixture validation (outside the timed loop): a full rebuild +
// clear + re-record pass matches the hand-written expectations
// above.
checkDedupeClear("fixture");
// Empty-store check (outside the timed loop): clearing a dedupe
// that has recorded nothing — twice — is a harmless no-op, and the
// store still records a first sighting afterwards.
{
  const empty = new SettlementEventDedupe({
    now: () => DEDUPE_CLEAR_NOW_MS,
  });
  empty.clear();
  empty.clear();
  const emptyStats = empty.stats();
  if (
    empty.size !== 0 ||
    emptyStats.size !== 0 ||
    emptyStats.hits !== 0 ||
    emptyStats.misses !== 0 ||
    emptyStats.evictions !== 0 ||
    empty.checkAndRecord(dedupeClearIds[0])
  ) {
    throw new Error(
      "benchmark fixture failed: empty dedupe clear is not a no-op",
    );
  }
}

// Dedupe-stats fixture: 7 fixed `eventId`s recorded in a
// `SettlementEventDedupe` under an injectable clock that advances only
// while the fixture is built (a 60-second TTL and a capacity of 6
// throughout):
//   - at the fixture base instant, `bench-stats-evicted` and
//     `bench-stats-expired` are recorded (2 misses);
//   - the clock then advances 50 seconds and 4 live ids
//     `bench-stats-live-00` .. `bench-stats-live-03` are recorded
//     at that instant (4 more misses; the map is now full at 6);
//   - the first live id is recorded again (1 hit, refreshing its
//     LRU recency, so the earlier `bench-stats-evicted` stays at
//     the head of the map);
//   - one further id, `bench-stats-new`, is recorded (1 more
//     miss): making room LRU-evicts `bench-stats-evicted` —
//     nothing is expired yet at that instant — (1 eviction);
//   - the clock then advances 10 more seconds to the stats
//     instant and stays fixed there: `bench-stats-expired` is
//     now exactly one TTL old (age >= TTL — the boundary rule
//     the dedupe tests pin), so it is expired but still sits in
//     the map (no miss has run since, so nothing pruned it),
//     and the 5 later ids are 10 seconds old and live.
// Hand-written expectation — written out here from the script
// above and cross-checked against the dedupe stats test, never
// derived by calling `stats()` itself: the snapshot is exactly
// `{ size: 5, hits: 1, misses: 7, evictions: 1 }`, where `size`
// counts only the 5 live ids (the expired id in the map is
// excluded) and the `size` getter agrees. `stats()` is a pure
// read, so the timed loop reuses this one fixture — no rebuild.
const DEDUPE_STATS_TTL_MS = 60_000;
const DEDUPE_STATS_MAX_ENTRIES = 6;
const DEDUPE_STATS_BASE_MS = BASE_MS + 360_000;
const DEDUPE_STATS_NOW_MS = DEDUPE_STATS_BASE_MS + DEDUPE_STATS_TTL_MS;
const DEDUPE_STATS_EXPECTED = { size: 5, hits: 1, misses: 7, evictions: 1 };
let dedupeStatsClockMs = DEDUPE_STATS_BASE_MS;
const dedupeStats = new SettlementEventDedupe({
  ttlMs: DEDUPE_STATS_TTL_MS,
  maxEntries: DEDUPE_STATS_MAX_ENTRIES,
  now: () => dedupeStatsClockMs,
});
if (dedupeStats.checkAndRecord("bench-stats-evicted")) {
  throw new Error(
    "benchmark fixture failed: dedupe stats prefill saw a duplicate",
  );
}
if (dedupeStats.checkAndRecord("bench-stats-expired")) {
  throw new Error(
    "benchmark fixture failed: dedupe stats prefill saw a duplicate",
  );
}
dedupeStatsClockMs = DEDUPE_STATS_BASE_MS + 50_000;
const DEDUPE_STATS_LIVE_IDS: string[] = Array.from(
  { length: 4 },
  (_, i) => `bench-stats-live-${String(i).padStart(2, "0")}`,
);
for (const id of DEDUPE_STATS_LIVE_IDS) {
  if (dedupeStats.checkAndRecord(id)) {
    throw new Error(
      "benchmark fixture failed: dedupe stats prefill saw a duplicate",
    );
  }
}
if (!dedupeStats.checkAndRecord(DEDUPE_STATS_LIVE_IDS[0])) {
  throw new Error(
    "benchmark fixture failed: dedupe stats prefill missed a recorded id",
  );
}
if (dedupeStats.checkAndRecord("bench-stats-new")) {
  throw new Error(
    "benchmark fixture failed: dedupe stats prefill saw a duplicate",
  );
}
dedupeStatsClockMs = DEDUPE_STATS_NOW_MS;
function checkDedupeStats(where: string): void {
  const snapshot = dedupeStats.stats();
  if (
    snapshot.size !== DEDUPE_STATS_EXPECTED.size ||
    snapshot.hits !== DEDUPE_STATS_EXPECTED.hits ||
    snapshot.misses !== DEDUPE_STATS_EXPECTED.misses ||
    snapshot.evictions !== DEDUPE_STATS_EXPECTED.evictions ||
    dedupeStats.size !== DEDUPE_STATS_EXPECTED.size
  ) {
    throw new Error(`benchmark ${where} failed: SettlementEventDedupe stats`);
  }
}
// Fixture validation (outside the timed loop): the full snapshot
// matches the hand-written expectation above.
checkDedupeStats("fixture");
// Detached-copy check (outside the timed loop): mutating a
// returned snapshot — rewriting every field — leaves a re-read
// unchanged.
{
  const detached = dedupeStats.stats();
  detached.size = 999;
  detached.hits = 999;
  detached.misses = 999;
  detached.evictions = 999;
  checkDedupeStats("fixture");
}
// Empty-store check (outside the timed loop): a dedupe that has
// recorded nothing reports all-zero stats.
{
  const empty = new SettlementEventDedupe({
    ttlMs: DEDUPE_STATS_TTL_MS,
    maxEntries: DEDUPE_STATS_MAX_ENTRIES,
    now: () => DEDUPE_STATS_NOW_MS,
  });
  const emptyStats = empty.stats();
  if (
    empty.size !== 0 ||
    emptyStats.size !== 0 ||
    emptyStats.hits !== 0 ||
    emptyStats.misses !== 0 ||
    emptyStats.evictions !== 0
  ) {
    throw new Error("benchmark fixture failed: empty dedupe stats shape");
  }
}

// Watchdog screening fixture: one fixed mixed batch of 100 escrows,
// screened at the fixed WATCHDOG_NOW = BASE + 90 days. Composition,
// hand-counted group by group (ids are BENCH-WD-<group>-<nn>):
//   A x30  FUNDED, funded at BASE (90d ago), deadline BASE+30d (past)
//          -> expired YES, stale YES (dwell 90d > FUNDED budget 7d)
//   B x20  FUNDED, funded at BASE+80d (10d ago), deadline BASE+120d
//          (future) -> expired no, stale YES (dwell 10d > 7d)
//   C x10  FUNDED, funded at BASE+88d (2d ago), deadline BASE+120d
//          -> expired no, stale no (dwell 2d < 7d)
//   D x10  MILESTONE_SUBMITTED, funded at BASE, milestone at BASE+50d
//          (40d ago), deadline BASE+30d (past)
//          -> expired YES, stale YES (dwell 40d > MILESTONE budget 30d)
//   E x10  MILESTONE_SUBMITTED, funded at BASE, milestone at BASE+85d
//          (5d ago), deadline BASE+120d -> expired no, stale no (5d < 30d)
//   F x10  RELEASED (terminal; funded/milestone/verify/release at
//          BASE/+1d/+2d/+3d), deadline BASE+30d (past)
//          -> expired no (terminal), stale no (terminal)
//   G x10  FUNDED, funded at BASE (90d ago), NO deadline
//          -> expired no (no deadline), stale YES (dwell 90d > 7d)
// Hand-counted expectations (NOT produced by the implementation):
//   expiredEscrows -> 40 ids: all of A (30) + all of D (10), batch order
//   staleEscrows under WATCHDOG_BUDGETS -> 70 ids: A (30) + B (20) +
//     D (10) + G (10), batch order
const DAY_MS = 24 * 3600_000;
const WATCHDOG_NOW = new Date(BASE_MS + 90 * DAY_MS);
const WATCHDOG_BUDGETS: Partial<Record<EscrowState, number>> = {
  FUNDED: 7 * DAY_MS,
  MILESTONE_SUBMITTED: 30 * DAY_MS,
};
const isoAt = (ms: number): string => new Date(ms).toISOString();
function watchdogFunded(
  id: string,
  fundedMs: number,
  deadlineMs?: number,
): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", undefined, 1000, { at: isoAt(fundedMs) });
  if (deadlineMs !== undefined) escrow.setDeadline(new Date(deadlineMs));
  return escrow;
}
function watchdogMilestone(
  id: string,
  milestoneMs: number,
  deadlineMs: number,
): Escrow {
  const escrow = watchdogFunded(id, BASE_MS);
  escrow.dispatch("SUBMIT_MILESTONE", undefined, undefined, {
    at: isoAt(milestoneMs),
  });
  escrow.setDeadline(new Date(deadlineMs));
  return escrow;
}
function watchdogIds(group: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) => `BENCH-WD-${group}-${String(i + 1).padStart(2, "0")}`,
  );
}
function buildWatchdogBatch(): Escrow[] {
  return [
  ...watchdogIds("A", 30).map((id) =>
    watchdogFunded(id, BASE_MS, BASE_MS + 30 * DAY_MS),
  ),
  ...watchdogIds("B", 20).map((id) =>
    watchdogFunded(id, BASE_MS + 80 * DAY_MS, BASE_MS + 120 * DAY_MS),
  ),
  ...watchdogIds("C", 10).map((id) =>
    watchdogFunded(id, BASE_MS + 88 * DAY_MS, BASE_MS + 120 * DAY_MS),
  ),
  ...watchdogIds("D", 10).map((id) =>
    watchdogMilestone(id, BASE_MS + 50 * DAY_MS, BASE_MS + 30 * DAY_MS),
  ),
  ...watchdogIds("E", 10).map((id) =>
    watchdogMilestone(id, BASE_MS + 85 * DAY_MS, BASE_MS + 120 * DAY_MS),
  ),
  ...watchdogIds("F", 10).map((id) => {
    const escrow = watchdogFunded(id, BASE_MS, BASE_MS + 30 * DAY_MS);
    escrow.dispatch("SUBMIT_MILESTONE", undefined, undefined, {
      at: isoAt(BASE_MS + 1 * DAY_MS),
    });
    escrow.dispatch("VERIFY_PASS", undefined, undefined, {
      at: isoAt(BASE_MS + 2 * DAY_MS),
    });
    escrow.dispatch("RELEASE", undefined, undefined, {
      at: isoAt(BASE_MS + 3 * DAY_MS),
    });
    return escrow;
  }),
  ...watchdogIds("G", 10).map((id) => watchdogFunded(id, BASE_MS)),
  ];
}
const watchdogBatch: Escrow[] = buildWatchdogBatch();
if (watchdogBatch.length !== 100) {
  throw new Error("benchmark fixture failed: watchdog batch size");
}
const WATCHDOG_EXPIRED_IDS: string[] = [
  ...watchdogIds("A", 30),
  ...watchdogIds("D", 10),
];
const WATCHDOG_STALE_IDS: string[] = [
  ...watchdogIds("A", 30),
  ...watchdogIds("B", 20),
  ...watchdogIds("D", 10),
  ...watchdogIds("G", 10),
];
function checkWatchdogIds(
  found: Escrow[],
  expected: string[],
  label: string,
): void {
  if (
    found.length !== expected.length ||
    found.some((e, i) => e.id !== expected[i])
  ) {
    throw new Error(`benchmark watchdog check failed: ${label}`);
  }
}
checkWatchdogIds(
  expiredEscrows(watchdogBatch, WATCHDOG_NOW),
  WATCHDOG_EXPIRED_IDS,
  "expiredEscrows",
);
checkWatchdogIds(
  staleEscrows(watchdogBatch, WATCHDOG_BUDGETS, WATCHDOG_NOW),
  WATCHDOG_STALE_IDS,
  "staleEscrows",
);

// Watchdog-executor expectations, hand-counted from the fixture
// composition above and the transition table — never derived by
// calling the executors:
//   expireOverdueEscrows attempts the 40 expired ids (A x30 FUNDED +
//   D x10 MILESTONE_SUBMITTED), in batch order. EXPIRE has an edge
//   from both states, so expired = true for all 40, no entry carries
//   an error, every attempted escrow ends EXPIRED, and its history
//   grows by exactly the EXPIRE entry (A: 1 -> 2 entries, D: 2 -> 3).
//   actOnStaleEscrows with the action (e) => e.dispatch("EXPIRE")
//   attempts the 70 stale ids (A x30 + B x20 + D x10 + G x10), in
//   batch order. The stale states are FUNDED (A/B/G) and
//   MILESTONE_SUBMITTED (D) — both carry an EXPIRE edge, so acted =
//   true for all 70, no entry carries an error, every attempted
//   escrow ends EXPIRED, and its history grows by the EXPIRE entry
//   (A/B/G: 1 -> 2 entries, D: 2 -> 3).
// Non-attempted escrows are not checked here (they are untouched by
// construction: the checks below run on fresh batches and the
// result lists name exactly the attempted ids).
function checkExpireOverdueResults(
  results: ReturnType<typeof expireOverdueEscrows>,
  label: string,
): void {
  const expectedHistoryLengths = [
    ...Array<number>(30).fill(2),
    ...Array<number>(10).fill(3),
  ];
  if (
    results.length !== WATCHDOG_EXPIRED_IDS.length ||
    results.some(
      (r, i) =>
        r.escrow.id !== WATCHDOG_EXPIRED_IDS[i] ||
        r.expired !== true ||
        r.error !== undefined ||
        r.escrow.state !== "EXPIRED" ||
        r.escrow.history.length !== expectedHistoryLengths[i] ||
        r.escrow.history[r.escrow.history.length - 1].event !== "EXPIRE" ||
        r.escrow.history[r.escrow.history.length - 1].to !== "EXPIRED",
    )
  ) {
    throw new Error(`benchmark watchdog check failed: ${label}`);
  }
}
function checkActOnStaleResults(
  results: ReturnType<typeof actOnStaleEscrows>,
  label: string,
): void {
  const expectedHistoryLengths = [
    ...Array<number>(30).fill(2),
    ...Array<number>(20).fill(2),
    ...Array<number>(10).fill(3),
    ...Array<number>(10).fill(2),
  ];
  if (
    results.length !== WATCHDOG_STALE_IDS.length ||
    results.some(
      (r, i) =>
        r.escrow.id !== WATCHDOG_STALE_IDS[i] ||
        r.acted !== true ||
        r.error !== undefined ||
        r.escrow.state !== "EXPIRED" ||
        r.escrow.history.length !== expectedHistoryLengths[i] ||
        r.escrow.history[r.escrow.history.length - 1].event !== "EXPIRE" ||
        r.escrow.history[r.escrow.history.length - 1].to !== "EXPIRED",
    )
  ) {
    throw new Error(`benchmark watchdog check failed: ${label}`);
  }
}
// One-time executor validation (outside the timed loops), each on a
// throwaway fresh batch so the module-scope screening batch above
// stays unmutated for its own paths.
checkExpireOverdueResults(
  expireOverdueEscrows(buildWatchdogBatch(), WATCHDOG_NOW),
  "expireOverdueEscrows fixture",
);
checkActOnStaleResults(
  actOnStaleEscrows(
    buildWatchdogBatch(),
    (e) => e.dispatch("EXPIRE"),
    WATCHDOG_BUDGETS,
    WATCHDOG_NOW,
  ),
  "actOnStaleEscrows fixture",
);

const ndjsonFixture = historyToNdjson(ndjsonHistoryFixture);
const ndjsonRoundTrip = historyFromNdjson(ndjsonFixture);
// parseEscrowHistory returns entries in canonical key order, so compare
// the round-trip through the canonical serializer (historyToNdjson)
// rather than raw object stringification.
if (
  ndjsonRoundTrip.length !== 8 ||
  ndjsonRoundTrip[7].to !== "RELEASED" ||
  historyToNdjson(ndjsonRoundTrip) !== ndjsonFixture
) {
  throw new Error("benchmark fixture failed: NDJSON round-trip mismatch");
}

// ---------------------------------------------------------------------
// parseRetryAfter fixture: a fixed 11-value corpus parsed against one
// injected fixed instant RETRY_AFTER_NOW_MS = BASE_MS + 300,000 ms
// (2026-01-01T00:05:00.000Z, second-aligned so the HTTP-date strings
// below — which carry one-second precision — land exactly).
// Hand-pinned expectations, written from the documented semantics
// (delay-seconds -> seconds * 1000; an HTTP-date -> max(0, date -
// now); signed numbers, garbage, and absent values -> undefined, the
// caller's cue to fall back to exponential backoff), never derived
// by calling parseRetryAfter itself:
//   "2"                                  -> 2000
//   "1.5"                                -> 1500
//   " 30 " (whitespace is trimmed)      -> 30000
//   "0"                                  -> 0
//   HTTP-date at now + 5 s               -> 5000
//   HTTP-date at now - 1 s (past)        -> 0
//   "-5" (signed)                        -> undefined
//   "+5" (signed)                        -> undefined
//   "banana"                             -> undefined
//   null                                 -> undefined
//   undefined                            -> undefined
// ---------------------------------------------------------------------
const RETRY_AFTER_NOW_MS = BASE_MS + 300_000;
const RETRY_AFTER_CASES: ReadonlyArray<{
  value: string | null | undefined;
  expected: number | undefined;
}> = [
  { value: "2", expected: 2000 },
  { value: "1.5", expected: 1500 },
  { value: " 30 ", expected: 30_000 },
  { value: "0", expected: 0 },
  {
    value: new Date(RETRY_AFTER_NOW_MS + 5000).toUTCString(),
    expected: 5000,
  },
  {
    value: new Date(RETRY_AFTER_NOW_MS - 1000).toUTCString(),
    expected: 0,
  },
  { value: "-5", expected: undefined },
  { value: "+5", expected: undefined },
  { value: "banana", expected: undefined },
  { value: null, expected: undefined },
  { value: undefined, expected: undefined },
];

function checkRetryAfterCorpus(): void {
  for (const c of RETRY_AFTER_CASES) {
    if (parseRetryAfter(c.value, RETRY_AFTER_NOW_MS) !== c.expected) {
      throw new Error("benchmark self-check failed: parseRetryAfter");
    }
  }
}
// Pre-check outside the timed loop: the whole corpus parses to its
// hand-pinned expectations before any number is reported.
checkRetryAfterCorpus();

// ---------------------------------------------------------------------
// depositAmountFromHistory fixture: a fixed 4-shape corpus of audit
// histories, built once outside the timed loop by driving real
// escrows on the shared fixed clock (BASE_MS plus per-step offsets)
// and detaching plain copies — exactly what a persisted audit log
// looks like. Hand-pinned expectations, written out here from the
// documented semantics (the locked total is the SUM of every FUND
// entry's amount, top-ups included; a total that cannot be
// established in full is never silently treated as zero), never
// derived by calling depositAmountFromHistory itself:
//   1. single FUND — one FUND of the golden 10,630
//      (BENCH-DEPOSIT-SINGLE) -> total 10,630.
//   2. top-up sum — FUND 10,630 then a second FUND of 2,000 while
//      still FUNDED (BENCH-DEPOSIT-TOPUP, the #43 top-up shape)
//      -> total 12,630.
//   3. FUND without an amount (BENCH-DEPOSIT-NOAMT) -> throws
//      exactly "settlement requires a FUND amount for
//      BENCH-DEPOSIT-NOAMT: a FUND event was recorded without an
//      amount".
//   4. no FUND at all — the empty history (BENCH-DEPOSIT-NOFUND)
//      -> throws exactly "settlement requires a FUND amount for
//      BENCH-DEPOSIT-NOFUND: no FUND event in the audit history".
// One bench iteration runs all four shapes: the two totals are the
// steady-state scan cost, and the two fail-fast shapes pin the
// error boundary on every iteration at the same time.
// ---------------------------------------------------------------------
function depositCorpusEscrow(
  id: string,
  steps: Array<{ event: EscrowEvent; amount?: number }>,
): EscrowHistoryEntry[] {
  const escrow = new Escrow(id);
  steps.forEach(({ event, amount }, i) => {
    escrow.dispatch(event, undefined, amount, {
      at: new Date(BASE_MS + i * 1000).toISOString(),
    });
  });
  return escrow.history.map((e) => ({ ...e }));
}

const DEPOSIT_CASES: ReadonlyArray<{
  escrowId: string;
  history: EscrowHistoryEntry[];
  total?: number;
  error?: string;
}> = [
  {
    escrowId: "BENCH-DEPOSIT-SINGLE",
    history: depositCorpusEscrow("BENCH-DEPOSIT-SINGLE", [
      { event: "FUND", amount: 10630 },
    ]),
    total: 10630,
  },
  {
    escrowId: "BENCH-DEPOSIT-TOPUP",
    history: depositCorpusEscrow("BENCH-DEPOSIT-TOPUP", [
      { event: "FUND", amount: 10630 },
      { event: "FUND", amount: 2000 },
    ]),
    total: 12630,
  },
  {
    escrowId: "BENCH-DEPOSIT-NOAMT",
    history: depositCorpusEscrow("BENCH-DEPOSIT-NOAMT", [
      { event: "FUND" },
    ]),
    error:
      "settlement requires a FUND amount for BENCH-DEPOSIT-NOAMT: " +
      "a FUND event was recorded without an amount",
  },
  {
    escrowId: "BENCH-DEPOSIT-NOFUND",
    history: [],
    error:
      "settlement requires a FUND amount for BENCH-DEPOSIT-NOFUND: " +
      "no FUND event in the audit history",
  },
];

function checkDepositCorpus(): void {
  for (const c of DEPOSIT_CASES) {
    if (c.error === undefined) {
      if (depositAmountFromHistory(c.history, c.escrowId) !== c.total) {
        throw new Error(
          "benchmark self-check failed: depositAmountFromHistory total",
        );
      }
    } else {
      let thrown: unknown;
      try {
        depositAmountFromHistory(c.history, c.escrowId);
      } catch (err) {
        thrown = err;
      }
      if (!(thrown instanceof Error) || thrown.message !== c.error) {
        throw new Error(
          "benchmark self-check failed: depositAmountFromHistory error",
        );
      }
    }
  }
}
// Pre-check outside the timed loop: the whole corpus sums / fails
// to its hand-pinned expectations before any number is reported.
checkDepositCorpus();

// ---------------------------------------------------------------------
// renderReport fixture: the module-scope `report` above, built once
// outside the timed loop — the fixed golden released report
// (escrow BENCH-001, 4-entry history, deposit 10,630 = pool 10,000 +
// base 600 x1.0 - loyalty 30 + oracle 60, settled at proFeeBps 500:
// platform pro fee 531.50, creator net 10,098.50, sponsor net
// -10,630, referrer 0). renderReport is pure (it only reads the
// report), so the same report is re-rendered on every iteration.
// Hand-written expected lines, written out from the documented
// ledger layout (party label padded to 30 chars, each money column
// padded to 14 chars) and the golden figures above — never produced
// by calling renderReport itself:
//   header:  "Escrow settlement report — BENCH-001"
//   outcome: "Outcome: released (via VERIFY_PASS → RELEASE)"
//   deposit: "Deposit: $10,630.00 (pool $10,000.00 + base
//             $600.00×1 − loyalty $30.00 + oracle $60.00)"
//   creator: label "Creator (payee)", inflow $10,098.50, outflow
//            $0.00, net $10,098.50 in the 30/14/14/14 columns.
// ---------------------------------------------------------------------
const RENDER_EXPECTED_LINES: readonly string[] = [
  "Escrow settlement report — BENCH-001",
  "Outcome: released (via VERIFY_PASS → RELEASE)",
  "Deposit: $10,630.00 (pool $10,000.00 + base $600.00×1 − loyalty $30.00 + oracle $60.00)",
  "Creator (payee)                   $10,098.50         $0.00    $10,098.50",
];

function checkRenderReport(text: string): void {
  for (const line of RENDER_EXPECTED_LINES) {
    if (!text.includes(line)) {
      throw new Error("benchmark self-check failed: renderReport");
    }
  }
}
// Pre-check outside the timed loop: the rendered ledger carries
// every hand-written expected line before any number is reported.
checkRenderReport(renderReport(report));

// ---------------------------------------------------------------------
// allowedEvents fixture: every state of the transition table, in
// declaration order, with its hand-pinned expected event list
// (declaration order within each row; never derived by calling
// allowedEvents itself — read off TRANSITIONS in src/stateMachine.ts
// and cross-checked against test/stateMachine.test.ts):
//   CREATED:             FUND, EXPIRE
//   FUNDED:              FUND, SUBMIT_MILESTONE, DISPUTE, EXPIRE
//   MILESTONE_SUBMITTED: VERIFY_PASS, VERIFY_FAIL, DISPUTE, EXPIRE
//   VERIFIED:            RELEASE, DISPUTE
//   DISPUTED:            ARBITRATE_RELEASE, ARBITRATE_REFUND
//   RELEASED:            (none — terminal)
//   REFUNDED:            (none — terminal)
//   EXPIRED:             (none — terminal)
// One bench pass queries all 8 states once.
// ---------------------------------------------------------------------
const ALLOWED_EVENTS_CASES: ReadonlyArray<{
  state: EscrowState;
  expected: readonly EscrowEvent[];
}> = [
  { state: "CREATED", expected: ["FUND", "EXPIRE"] },
  {
    state: "FUNDED",
    expected: ["FUND", "SUBMIT_MILESTONE", "DISPUTE", "EXPIRE"],
  },
  {
    state: "MILESTONE_SUBMITTED",
    expected: ["VERIFY_PASS", "VERIFY_FAIL", "DISPUTE", "EXPIRE"],
  },
  { state: "VERIFIED", expected: ["RELEASE", "DISPUTE"] },
  {
    state: "DISPUTED",
    expected: ["ARBITRATE_RELEASE", "ARBITRATE_REFUND"],
  },
  { state: "RELEASED", expected: [] },
  { state: "REFUNDED", expected: [] },
  { state: "EXPIRED", expected: [] },
];

function checkAllowedEventsPass(): void {
  for (const c of ALLOWED_EVENTS_CASES) {
    const got = allowedEvents(c.state);
    if (
      got.length !== c.expected.length ||
      got.some((e, i) => e !== c.expected[i])
    ) {
      throw new Error("benchmark self-check failed: allowedEvents");
    }
  }
}
// Pre-check outside the timed loop: every state's allowed-event list
// matches its hand-pinned expectation before any number is reported.
checkAllowedEventsPass();

// ---------------------------------------------------------------------
// calculateDeposit fixture: a fixed 3-shape corpus, built once
// outside the timed loop. Expectations are hand-computed from the
// documented formula (adjustedBaseFee = round2(baseFee x
// complexityMultiplier); deposit = round2(creatorPool +
// adjustedBaseFee - loyaltyDiscount + oracleFee)) — written out as
// arithmetic here, never derived by calling calculateDeposit itself:
//   1. golden vector — pool 10,000, base 600, complexity 1.0,
//      loyalty 30, oracle 60: adjusted = 600 x 1.0 = 600;
//      deposit = 10,000 + 600 - 30 + 60 = 10,630.
//   2. complexity != 1 — pool 5,000, base 800, complexity 1.5,
//      loyalty 50, oracle 40: adjusted = 800 x 1.5 = 1,200;
//      deposit = 5,000 + 1,200 - 50 + 40 = 6,190.
//   3. large pool — pool 1,000,000, base 2,500, complexity 2.25,
//      loyalty 500, oracle 250: adjusted = 2,500 x 2.25 = 5,625;
//      deposit = 1,000,000 + 5,625 - 500 + 250 = 1,005,375.
// One bench pass runs the whole corpus (all 3 shapes).
// ---------------------------------------------------------------------
const CALCULATE_DEPOSIT_CASES: ReadonlyArray<{
  inputs: Parameters<typeof calculateDeposit>[0];
  adjustedBaseFee: number;
  deposit: number;
}> = [
  {
    inputs: {
      creatorPool: 10000,
      baseFee: 600,
      complexityMultiplier: 1.0,
      loyaltyDiscount: 30,
      oracleFee: 60,
    },
    adjustedBaseFee: 600,
    deposit: 10630,
  },
  {
    inputs: {
      creatorPool: 5000,
      baseFee: 800,
      complexityMultiplier: 1.5,
      loyaltyDiscount: 50,
      oracleFee: 40,
    },
    adjustedBaseFee: 1200,
    deposit: 6190,
  },
  {
    inputs: {
      creatorPool: 1000000,
      baseFee: 2500,
      complexityMultiplier: 2.25,
      loyaltyDiscount: 500,
      oracleFee: 250,
    },
    adjustedBaseFee: 5625,
    deposit: 1005375,
  },
];

function checkCalculateDepositCorpus(): void {
  for (const c of CALCULATE_DEPOSIT_CASES) {
    const got = calculateDeposit(c.inputs);
    if (
      got.creatorPool !== c.inputs.creatorPool ||
      got.baseFee !== c.inputs.baseFee ||
      got.complexityMultiplier !== c.inputs.complexityMultiplier ||
      got.loyaltyDiscount !== c.inputs.loyaltyDiscount ||
      got.oracleFee !== c.inputs.oracleFee ||
      got.adjustedBaseFee !== c.adjustedBaseFee ||
      got.deposit !== c.deposit
    ) {
      throw new Error("benchmark self-check failed: calculateDeposit");
    }
  }
}
// Pre-check outside the timed loop: the whole corpus computes to
// its hand-computed expectations before any number is reported.
checkCalculateDepositCorpus();

// ---------------------------------------------------------------------
// dispatchArbitration fixture: a fixed DISPUTED escrow prefix and a
// threshold-reached 5/9 quorum, both rebuilt on every iteration
// because the dispatch mutates the escrow (see the header: the
// rebuild cost is inside the timed region, so the reported number
// is a conservative lower bound on the dispatch-only throughput).
// The prefix is built once, outside the timed loop, by driving a
// real escrow on the shared fixed clock — FUND the golden 10,630
// at BASE_MS, then DISPUTE at BASE_MS + 1s — and detaching plain
// copies, exactly what a persisted audit log looks like (2 entries,
// ending DISPUTED). The quorum is rebuilt per iteration by
// `runQuorumToThreshold` above (a fresh `createQuorum` on the fixed
// clock approving dao-1..dao-5). Hand-pinned expectations, written
// from the documented arbitration semantics — never derived by
// calling dispatchArbitration itself: the call returns REFUNDED,
// the history grows by exactly one entry, and that entry is
// ARBITRATE_REFUND from DISPUTED to REFUNDED carrying the note
// "quorum 5/5" (approvalCount 5 over threshold 5, no caller note)
// at the pinned dispatch timestamp BASE_MS + 2s.
// ---------------------------------------------------------------------
const ARBITRATION_ESCROW_ID = "BENCH-ARB-001";
const ARBITRATION_AT = new Date(BASE_MS + 2000).toISOString();
const arbitrationPrefix: EscrowHistoryEntry[] = ((): EscrowHistoryEntry[] => {
  const escrow = new Escrow(ARBITRATION_ESCROW_ID);
  escrow.dispatch("FUND", undefined, DEPOSIT_AMOUNT, {
    at: new Date(BASE_MS).toISOString(),
  });
  escrow.dispatch("DISPUTE", undefined, undefined, {
    at: new Date(BASE_MS + 1000).toISOString(),
  });
  if (escrow.state !== "DISPUTED" || escrow.history.length !== 2) {
    throw new Error("benchmark fixture failed: arbitration prefix shape");
  }
  return escrow.history.map((e) => ({ ...e }));
})();

function checkDispatchArbitration(): void {
  const escrow = Escrow.fromHistory(
    ARBITRATION_ESCROW_ID,
    arbitrationPrefix.map((e) => ({ ...e })),
  );
  const quorum = runQuorumToThreshold();
  const historyBefore = escrow.history.length;
  const state = dispatchArbitration(escrow, quorum, "refund", undefined, {
    at: ARBITRATION_AT,
  });
  const last = escrow.history[escrow.history.length - 1];
  if (
    escrow.state !== "REFUNDED" ||
    state !== "REFUNDED" ||
    historyBefore !== arbitrationPrefix.length ||
    escrow.history.length !== historyBefore + 1 ||
    last.event !== "ARBITRATE_REFUND" ||
    last.from !== "DISPUTED" ||
    last.to !== "REFUNDED" ||
    last.note !== "quorum 5/5" ||
    last.at !== ARBITRATION_AT
  ) {
    throw new Error("benchmark self-check failed: dispatchArbitration");
  }
}
// Pre-check outside the timed loop: the rebuilt disputed escrow and
// threshold quorum dispatch to the hand-pinned refund outcome
// before any number is reported.
checkDispatchArbitration();

// ---------------------------------------------------------------------
// isOverdue fixture: a fixed 4-case corpus judged against one
// injected fixed instant IS_OVERDUE_NOW = BASE + 90 days (the same
// screening instant as the watchdog batch). The four escrows are
// built once, outside the timed loop, by driving real escrows on
// the shared fixed clock; `isOverdue` is pure, so the same four
// instances are re-judged on every iteration. Hand-pinned
// expectations, written from the documented semantics in
// src/stateMachine.ts — never derived by calling isOverdue
// itself (cross-checked against test/deadline.test.ts):
//   1. FUNDED, deadline BASE+30d (past)               -> true
//   2. FUNDED, deadline BASE+120d (future)            -> false
//   3. FUNDED, no deadline                            -> false
//   4. RELEASED (terminal), deadline BASE+30d (past) -> false
// One bench pass judges all 4 cases once.
// ---------------------------------------------------------------------
const IS_OVERDUE_NOW = new Date(BASE_MS + 90 * DAY_MS);
const IS_OVERDUE_CASES: ReadonlyArray<{
  escrow: Escrow;
  expected: boolean;
}> = (() => {
  const overdue = watchdogFunded(
    "BENCH-OVERDUE-001",
    BASE_MS,
    BASE_MS + 30 * DAY_MS,
  );
  const future = watchdogFunded(
    "BENCH-OVERDUE-002",
    BASE_MS,
    BASE_MS + 120 * DAY_MS,
  );
  const noDeadline = watchdogFunded("BENCH-OVERDUE-003", BASE_MS);
  const terminal = watchdogFunded(
    "BENCH-OVERDUE-004",
    BASE_MS,
    BASE_MS + 30 * DAY_MS,
  );
  terminal.dispatch("SUBMIT_MILESTONE", undefined, undefined, {
    at: isoAt(BASE_MS + 1 * DAY_MS),
  });
  terminal.dispatch("VERIFY_PASS", undefined, undefined, {
    at: isoAt(BASE_MS + 2 * DAY_MS),
  });
  terminal.dispatch("RELEASE", undefined, undefined, {
    at: isoAt(BASE_MS + 3 * DAY_MS),
  });
  if (terminal.state !== "RELEASED" || !terminal.isTerminal) {
    throw new Error("benchmark fixture failed: isOverdue terminal shape");
  }
  return [
    { escrow: overdue, expected: true },
    { escrow: future, expected: false },
    { escrow: noDeadline, expected: false },
    { escrow: terminal, expected: false },
  ];
})();

function checkIsOverdueCorpus(): void {
  for (const c of IS_OVERDUE_CASES) {
    if (isOverdue(c.escrow, IS_OVERDUE_NOW) !== c.expected) {
      throw new Error("benchmark self-check failed: isOverdue");
    }
  }
}
// Pre-check outside the timed loop: every case judges to its
// hand-pinned expectation before any number is reported.
checkIsOverdueCorpus();

// ---------------------------------------------------------------------
// setDeadline/clearDeadline write-cycle fixture: ONE shared FUNDED
// escrow (watchdogFunded at BASE, deposit 1000, 1 history entry, no
// deadline initially). Every timed iteration runs one full write
// cycle on that same escrow and leaves it exactly as it found it:
//   1. setDeadline(new Date(BASE + 30 days)) — a Date input — then
//      getDeadline() must read back the hand-pinned canonical
//      literal "2026-01-31T00:00:00.000Z";
//   2. setDeadline("2026-05-01T00:00:00.000Z") — a string input at
//      BASE + 120 days — overwrites, and getDeadline() must read
//      back that literal;
//   3. clearDeadline() — then getDeadline() must read back
//      undefined, the fixture's initial state, so the next
//      iteration starts from the same shape.
// The expected literals are written out separately from the inputs
// (a Date computed from BASE_MS for step 1), so a drift on either
// side fails the check. State (FUNDED) and history length (1) are
// checked on every iteration: a deadline write is configuration,
// never a dispatch. Hand-pinned from the documented semantics in
// src/stateMachine.ts, cross-checked against test/deadline.test.ts.
// ---------------------------------------------------------------------
const deadlineWriteEscrow = watchdogFunded(
  "BENCH-DEADLINE-WRITE-001",
  BASE_MS,
);
if (
  deadlineWriteEscrow.state !== "FUNDED" ||
  deadlineWriteEscrow.history.length !== 1 ||
  deadlineWriteEscrow.getDeadline() !== undefined
) {
  throw new Error("benchmark fixture failed: deadline write-cycle shape");
}

function runDeadlineWriteCycle(): void {
  deadlineWriteEscrow.setDeadline(new Date(BASE_MS + 30 * DAY_MS));
  if (deadlineWriteEscrow.getDeadline() !== "2026-01-31T00:00:00.000Z") {
    throw new Error(
      "benchmark self-check failed: setDeadline/clearDeadline write cycle (initial set)",
    );
  }
  deadlineWriteEscrow.setDeadline("2026-05-01T00:00:00.000Z");
  if (deadlineWriteEscrow.getDeadline() !== "2026-05-01T00:00:00.000Z") {
    throw new Error(
      "benchmark self-check failed: setDeadline/clearDeadline write cycle (overwrite)",
    );
  }
  deadlineWriteEscrow.clearDeadline();
  if (
    deadlineWriteEscrow.getDeadline() !== undefined ||
    deadlineWriteEscrow.state !== "FUNDED" ||
    deadlineWriteEscrow.history.length !== 1
  ) {
    throw new Error(
      "benchmark self-check failed: setDeadline/clearDeadline write cycle (clear)",
    );
  }
}
// Pre-check outside the timed loop: one full cycle runs clean
// before any number is reported.
runDeadlineWriteCycle();

// Deadline write probes (outside the timed loop, never timed, on
// probe escrows separate from the shared timed fixture):
//   - illegal inputs throw their exact hand-pinned messages and
//     leave nothing stored on a fresh escrow;
//   - an illegal attempt after a valid set preserves the stored
//     value (validation runs before assignment);
//   - a non-canonical parseable input is stored normalized to
//     canonical ISO-8601;
//   - terminal behaviour: the setter carries no state guard, so a
//     RELEASED escrow stores a past deadline and reads it back,
//     yet isOverdue still judges it false — terminal states are
//     never overdue (test/deadline.test.ts pins the same shape).
{
  const probe = new Escrow("BENCH-DEADLINE-WRITE-PROBE");
  let stringError: unknown;
  try {
    probe.setDeadline("not-a-date");
  } catch (err) {
    stringError = err;
  }
  if (
    !(stringError instanceof Error) ||
    stringError.message !== "invalid deadline: not-a-date" ||
    probe.getDeadline() !== undefined
  ) {
    throw new Error(
      "benchmark fixture failed: deadline write probe (string rejection)",
    );
  }
  let dateError: unknown;
  try {
    probe.setDeadline(new Date(NaN));
  } catch (err) {
    dateError = err;
  }
  if (
    !(dateError instanceof Error) ||
    dateError.message !== "invalid deadline: Invalid Date" ||
    probe.getDeadline() !== undefined
  ) {
    throw new Error(
      "benchmark fixture failed: deadline write probe (Date rejection)",
    );
  }
  probe.setDeadline("2027-1-1");
  if (probe.getDeadline() !== "2027-01-01T00:00:00.000Z") {
    throw new Error(
      "benchmark fixture failed: deadline write probe (normalization)",
    );
  }
  let preservedError: unknown;
  try {
    probe.setDeadline("not-a-date");
  } catch (err) {
    preservedError = err;
  }
  if (
    !(preservedError instanceof Error) ||
    preservedError.message !== "invalid deadline: not-a-date" ||
    probe.getDeadline() !== "2027-01-01T00:00:00.000Z"
  ) {
    throw new Error(
      "benchmark fixture failed: deadline write probe (stored value preserved)",
    );
  }
  const terminalProbe = runReleasedLifecycle("BENCH-DEADLINE-WRITE-TERMINAL");
  terminalProbe.setDeadline(new Date(BASE_MS + 30 * DAY_MS));
  if (
    terminalProbe.state !== "RELEASED" ||
    terminalProbe.getDeadline() !== "2026-01-31T00:00:00.000Z" ||
    isOverdue(terminalProbe, IS_OVERDUE_NOW) !== false
  ) {
    throw new Error(
      "benchmark fixture failed: deadline write probe (terminal behaviour)",
    );
  }
  terminalProbe.clearDeadline();
  if (terminalProbe.getDeadline() !== undefined) {
    throw new Error(
      "benchmark fixture failed: deadline write probe (terminal clear)",
    );
  }
}

// ---------------------------------------------------------------------
// assertNonNegativeMoney fixture: a fixed legal corpus and a fixed
// illegal corpus, both hand-pinned from the documented semantics in
// src/stateMachine.ts (a monetary input must be a finite,
// non-negative number; anything else throws
// `${name} must be a finite non-negative number`) — cross-checked
// against test/inputValidation.test.ts, never derived by calling
// the guard itself:
//   legal (must pass without throwing): 0, 0.01, 10630 (the golden
//     deposit), 1000000.25 (a large amount with cents)
//   illegal (must throw the exact message below, with name
//     "amount"): -1, NaN, Infinity, -Infinity, "10630" (a numeric
//     string), undefined, null
// One bench pass runs the whole legal corpus once. The illegal
// corpus is asserted ONCE, outside the timed loop (see
// checkMoneyGuardIllegalCorpus below) — only the legal branch is
// timed, so the reported number is the steady-state cost a valid
// dispatch pays, with no exception construction in the timed
// region.
// ---------------------------------------------------------------------
const MONEY_GUARD_NAME = "amount";
const MONEY_GUARD_ERROR = "amount must be a finite non-negative number";
const MONEY_GUARD_LEGAL: readonly unknown[] = [0, 0.01, 10630, 1000000.25];
const MONEY_GUARD_ILLEGAL: readonly unknown[] = [
  -1,
  NaN,
  Infinity,
  -Infinity,
  "10630",
  undefined,
  null,
];

function checkMoneyGuardLegalCorpus(): void {
  for (const value of MONEY_GUARD_LEGAL) {
    assertNonNegativeMoney(MONEY_GUARD_NAME, value);
  }
}

function checkMoneyGuardIllegalCorpus(): void {
  for (const value of MONEY_GUARD_ILLEGAL) {
    let message: string | undefined;
    try {
      assertNonNegativeMoney(MONEY_GUARD_NAME, value);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    if (message !== MONEY_GUARD_ERROR) {
      throw new Error("benchmark self-check failed: assertNonNegativeMoney");
    }
  }
}
// Pre-checks outside the timed loop: the legal corpus passes and
// every illegal value throws the exact hand-pinned message before
// any number is reported.
checkMoneyGuardLegalCorpus();
checkMoneyGuardIllegalCorpus();

// ---------------------------------------------------------------------
// transitionTableJson fixture: no input — the function exports the
// whole transition table. Expectations are hand-pinned from the
// committed snapshot test/__snapshots__/transitionTable.snapshot.json
// (cross-checked against test/transitionSnapshot.test.ts, which pins
// the same 14-edge count and trailing-newline shape), never derived
// by calling transitionTable() or transitionTableJson() itself:
//   edge count 14; first edge CREATED / FUND / FUNDED; the release
//   edge VERIFIED / RELEASE / RELEASED at index 10; last edge
//   DISPUTED / ARBITRATE_REFUND / REFUNDED; every edge's keys in the
//   pinned order from,event,to; the raw text ends with "]\n" and
//   not "]\n\n".
// ---------------------------------------------------------------------
const TRANSITION_TABLE_JSON_EDGE_COUNT = 14;
const TRANSITION_TABLE_JSON_FIRST = { from: "CREATED", event: "FUND", to: "FUNDED" };
const TRANSITION_TABLE_JSON_RELEASE_INDEX = 10;
const TRANSITION_TABLE_JSON_RELEASE = { from: "VERIFIED", event: "RELEASE", to: "RELEASED" };
const TRANSITION_TABLE_JSON_LAST = { from: "DISPUTED", event: "ARBITRATE_REFUND", to: "REFUNDED" };

function checkTransitionTableJson(): void {
  const text = transitionTableJson();
  if (!text.endsWith("]\n") || text.endsWith("]\n\n")) {
    throw new Error("benchmark self-check failed: transitionTableJson shape");
  }
  const edges = JSON.parse(text) as Array<{ from: string; event: string; to: string }>;
  const pinned = (edge: { from: string; event: string; to: string }, expected: typeof TRANSITION_TABLE_JSON_FIRST) =>
    edge.from === expected.from && edge.event === expected.event && edge.to === expected.to;
  if (
    edges.length !== TRANSITION_TABLE_JSON_EDGE_COUNT ||
    !pinned(edges[0], TRANSITION_TABLE_JSON_FIRST) ||
    !pinned(edges[TRANSITION_TABLE_JSON_RELEASE_INDEX], TRANSITION_TABLE_JSON_RELEASE) ||
    !pinned(edges[edges.length - 1], TRANSITION_TABLE_JSON_LAST) ||
    edges.some((edge) => Object.keys(edge).join(",") !== "from,event,to")
  ) {
    throw new Error("benchmark self-check failed: transitionTableJson");
  }
}
// Pre-check outside the timed loop: the export parses and matches
// every hand-pinned expectation before any number is reported.
checkTransitionTableJson();

// ---------------------------------------------------------------------
// transitionTable fixture: no input — the function builds the whole
// transition table as plain objects. Expectations are hand-pinned
// from the committed snapshot
// test/__snapshots__/transitionTable.snapshot.json (14 edges, in
// declaration order, written out in full below), never derived by
// calling transitionTable() itself:
//   edge count 14; every edge in the pinned order with keys in the
//   pinned order from,event,to; the shared pinned first / release
//   (index 10) / last edges are the same constants the
//   transitionTableJson bench pins, so the per-iteration check also
//   spot-checks consistency with the JSON edge set. Outside the
//   timed loop, an exhaustive check compares the full edge set to
//   the parsed transitionTableJson() edge set edge for edge and
//   confirms the hand-pinned non-existent edge
//   CREATED / RELEASE / RELEASED is absent from both.
// ---------------------------------------------------------------------
const TRANSITION_TABLE_EDGE_COUNT = 14;
const TRANSITION_TABLE_EDGES: readonly TransitionEdge[] = [
  { from: "CREATED", event: "FUND", to: "FUNDED" },
  { from: "CREATED", event: "EXPIRE", to: "EXPIRED" },
  { from: "FUNDED", event: "FUND", to: "FUNDED" },
  { from: "FUNDED", event: "SUBMIT_MILESTONE", to: "MILESTONE_SUBMITTED" },
  { from: "FUNDED", event: "DISPUTE", to: "DISPUTED" },
  { from: "FUNDED", event: "EXPIRE", to: "EXPIRED" },
  { from: "MILESTONE_SUBMITTED", event: "VERIFY_PASS", to: "VERIFIED" },
  { from: "MILESTONE_SUBMITTED", event: "VERIFY_FAIL", to: "DISPUTED" },
  { from: "MILESTONE_SUBMITTED", event: "DISPUTE", to: "DISPUTED" },
  { from: "MILESTONE_SUBMITTED", event: "EXPIRE", to: "EXPIRED" },
  { from: "VERIFIED", event: "RELEASE", to: "RELEASED" },
  { from: "VERIFIED", event: "DISPUTE", to: "DISPUTED" },
  { from: "DISPUTED", event: "ARBITRATE_RELEASE", to: "RELEASED" },
  { from: "DISPUTED", event: "ARBITRATE_REFUND", to: "REFUNDED" },
];
const TRANSITION_TABLE_ABSENT_EDGE: TransitionEdge = {
  from: "CREATED",
  event: "RELEASE",
  to: "RELEASED",
};
const transitionTableTriple = (edge: TransitionEdge): string =>
  `${edge.from}/${edge.event}/${edge.to}`;

function checkTransitionTable(): void {
  const edges = transitionTable();
  if (
    edges.length !== TRANSITION_TABLE_EDGE_COUNT ||
    edges.some(
      (edge, i) =>
        transitionTableTriple(edge) !==
          transitionTableTriple(TRANSITION_TABLE_EDGES[i]) ||
        Object.keys(edge).join(",") !== "from,event,to",
    ) ||
    transitionTableTriple(edges[0]) !==
      `${TRANSITION_TABLE_JSON_FIRST.from}/${TRANSITION_TABLE_JSON_FIRST.event}/${TRANSITION_TABLE_JSON_FIRST.to}` ||
    transitionTableTriple(
      edges[TRANSITION_TABLE_JSON_RELEASE_INDEX],
    ) !==
      `${TRANSITION_TABLE_JSON_RELEASE.from}/${TRANSITION_TABLE_JSON_RELEASE.event}/${TRANSITION_TABLE_JSON_RELEASE.to}` ||
    transitionTableTriple(edges[edges.length - 1]) !==
      `${TRANSITION_TABLE_JSON_LAST.from}/${TRANSITION_TABLE_JSON_LAST.event}/${TRANSITION_TABLE_JSON_LAST.to}`
  ) {
    throw new Error("benchmark self-check failed: transitionTable");
  }
}
// Pre-check outside the timed loop: the pure construction matches
// every hand-pinned expectation before any number is reported.
checkTransitionTable();
// Exhaustive check outside the timed loop: the pure edge set equals
// the parsed transitionTableJson() edge set edge for edge, and the
// pinned non-existent edge is absent from both.
{
  const pureTriples = transitionTable().map(transitionTableTriple);
  const jsonTriples = (
    JSON.parse(transitionTableJson()) as TransitionEdge[]
  ).map(transitionTableTriple);
  const absent = transitionTableTriple(TRANSITION_TABLE_ABSENT_EDGE);
  if (
    pureTriples.length !== TRANSITION_TABLE_EDGE_COUNT ||
    jsonTriples.length !== TRANSITION_TABLE_EDGE_COUNT ||
    pureTriples.some((triple, i) => triple !== jsonTriples[i]) ||
    pureTriples.includes(absent) ||
    jsonTriples.includes(absent)
  ) {
    throw new Error(
      "benchmark fixture failed: transitionTable exhaustive JSON consistency / absent-edge check",
    );
  }
}

// ---------------------------------------------------------------------
// stateDiagram fixture: no input — the function renders the whole
// transition table as a fenced Mermaid block. Expectations are
// hand-pinned from the committed snapshot
// test/__snapshots__/transitionTable.snapshot.json (14 edges) and
// test/diagram.test.ts (21 lines: 2 header lines + the start line
// + 14 edges + 3 terminal lines + the closing fence), never derived
// by calling transitionTable() or stateDiagram() itself:
//   all 14 edge lines, written out in full in declaration order;
//   the start line pins CREATED as the first declared state; the
//   terminal lines pin RELEASED / REFUNDED / EXPIRED (the states
//   with no outgoing edges, in declaration order); and all 8
//   declared states appear as a source or target of an edge line
//   or as the start / a terminal line.
// ---------------------------------------------------------------------
const STATE_DIAGRAM_EDGE_LINES: readonly string[] = [
  "    CREATED --> FUNDED : FUND",
  "    CREATED --> EXPIRED : EXPIRE",
  "    FUNDED --> FUNDED : FUND",
  "    FUNDED --> MILESTONE_SUBMITTED : SUBMIT_MILESTONE",
  "    FUNDED --> DISPUTED : DISPUTE",
  "    FUNDED --> EXPIRED : EXPIRE",
  "    MILESTONE_SUBMITTED --> VERIFIED : VERIFY_PASS",
  "    MILESTONE_SUBMITTED --> DISPUTED : VERIFY_FAIL",
  "    MILESTONE_SUBMITTED --> DISPUTED : DISPUTE",
  "    MILESTONE_SUBMITTED --> EXPIRED : EXPIRE",
  "    VERIFIED --> RELEASED : RELEASE",
  "    VERIFIED --> DISPUTED : DISPUTE",
  "    DISPUTED --> RELEASED : ARBITRATE_RELEASE",
  "    DISPUTED --> REFUNDED : ARBITRATE_REFUND",
];
const STATE_DIAGRAM_STATES: readonly string[] = [
  "CREATED",
  "FUNDED",
  "MILESTONE_SUBMITTED",
  "VERIFIED",
  "DISPUTED",
  "RELEASED",
  "REFUNDED",
  "EXPIRED",
];
const STATE_DIAGRAM_TERMINAL_LINES: readonly string[] = [
  "    RELEASED --> [*]",
  "    REFUNDED --> [*]",
  "    EXPIRED --> [*]",
];

function checkStateDiagram(): void {
  const lines = stateDiagram().split("\n");
  if (
    lines.length !== 21 ||
    lines[0] !== "```mermaid" ||
    lines[1] !== "stateDiagram-v2" ||
    lines[2] !== "    [*] --> CREATED" ||
    lines[lines.length - 1] !== "```"
  ) {
    throw new Error("benchmark self-check failed: stateDiagram shape");
  }
  const edgeLines = lines.slice(3, 3 + STATE_DIAGRAM_EDGE_LINES.length);
  if (
    edgeLines.length !== STATE_DIAGRAM_EDGE_LINES.length ||
    edgeLines.some((line, i) => line !== STATE_DIAGRAM_EDGE_LINES[i])
  ) {
    throw new Error("benchmark self-check failed: stateDiagram edges");
  }
  const terminalLines = lines.slice(
    3 + STATE_DIAGRAM_EDGE_LINES.length,
    3 + STATE_DIAGRAM_EDGE_LINES.length + STATE_DIAGRAM_TERMINAL_LINES.length,
  );
  if (
    terminalLines.some((line, i) => line !== STATE_DIAGRAM_TERMINAL_LINES[i])
  ) {
    throw new Error("benchmark self-check failed: stateDiagram terminals");
  }
  for (const state of STATE_DIAGRAM_STATES) {
    if (
      !edgeLines.some(
        (line) => line.startsWith(`    ${state} -->`) || line.includes(`--> ${state} `) || line.includes(`--> ${state} :`),
      ) &&
      lines[2] !== `    [*] --> ${state}` &&
      !terminalLines.includes(`    ${state} --> [*]`)
    ) {
      throw new Error("benchmark self-check failed: stateDiagram states");
    }
  }
}
// Pre-check outside the timed loop: the rendering matches every
// hand-pinned expectation before any number is reported.
checkStateDiagram();

// ---------------------------------------------------------------------
// readmeDiagramInSync fixture: no input — the checker reads this
// repo's README.md (the only file this bench reads), regenerates the
// diagram, and reports whether the exact block is embedded. The
// expectation is hand-pinned as `true` from the test suite's own
// sync assertions (test/diagram.test.ts: "README embeds the exact
// generated diagram block" and the CLI `--check` pass), never
// derived by reading the README in the bench itself.
// ---------------------------------------------------------------------
const README_DIAGRAM_IN_SYNC_EXPECTED = true;

function checkReadmeDiagramInSync(): void {
  if (readmeDiagramInSync() !== README_DIAGRAM_IN_SYNC_EXPECTED) {
    throw new Error("benchmark self-check failed: readmeDiagramInSync");
  }
}
// Pre-check outside the timed loop: the README is in sync before any
// number is reported.
checkReadmeDiagramInSync();

// ---------------------------------------------------------------------
// Subscribe fixture: one fixed collecting listener subscribed to a
// fresh escrow BEFORE any dispatch, then the escrow is driven through
// the same fixed full lifecycle as `runLifecycle()` (the LIFECYCLE
// table above: same events, amounts, and per-step timestamp offsets
// from BASE_MS).
// Hand-written expectations — written out here from the transition
// table in src/stateMachine.ts and cross-checked against
// test/subscribe.test.ts, never derived by calling subscribe itself:
//   - exactly 4 notifications, one per successful dispatch, in
//     dispatch order, with these (event, from, to) triples:
//       FUND             CREATED            -> FUNDED
//       SUBMIT_MILESTONE FUNDED             -> MILESTONE_SUBMITTED
//       VERIFY_PASS      MILESTONE_SUBMITTED -> VERIFIED
//       RELEASE          VERIFIED           -> RELEASED
//   - notification i carries the audit entry appended by dispatch i:
//     its seq is i + 1 and every recorded field (event, from, to,
//     at, actor, note, amount, evidence, hash-chain links) equals
//     history[i] field for field;
//   - the escrow has exactly 1 listener while subscribed.
// ---------------------------------------------------------------------
const SUBSCRIBE_EXPECTED: Array<{
  event: EscrowEvent;
  from: EscrowState;
  to: EscrowState;
}> = [
  { event: "FUND", from: "CREATED", to: "FUNDED" },
  { event: "SUBMIT_MILESTONE", from: "FUNDED", to: "MILESTONE_SUBMITTED" },
  { event: "VERIFY_PASS", from: "MILESTONE_SUBMITTED", to: "VERIFIED" },
  { event: "RELEASE", from: "VERIFIED", to: "RELEASED" },
];
type SubscribeNotification = {
  event: EscrowEvent;
  from: EscrowState;
  to: EscrowState;
  entry: EscrowHistoryEntry;
};
function runSubscribedLifecycle(): {
  escrow: Escrow;
  notifications: SubscribeNotification[];
} {
  const escrow = new Escrow("BENCH-SUB-001");
  const notifications: SubscribeNotification[] = [];
  escrow.subscribe((event, from, to, entry) => {
    notifications.push({ event, from, to, entry });
  });
  LIFECYCLE.forEach(({ event, amount }, i) => {
    escrow.dispatch(event, undefined, amount, {
      at: new Date(BASE_MS + i * 1000).toISOString(),
    });
  });
  return { escrow, notifications };
}
function checkSubscribe(
  escrow: Escrow,
  notifications: SubscribeNotification[],
  where: string,
): void {
  if (
    escrow.state !== "RELEASED" ||
    escrow.listenerCount !== 1 ||
    escrow.history.length !== SUBSCRIBE_EXPECTED.length ||
    notifications.length !== SUBSCRIBE_EXPECTED.length
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
  for (let i = 0; i < SUBSCRIBE_EXPECTED.length; i++) {
    const n = notifications[i];
    const expected = SUBSCRIBE_EXPECTED[i];
    const entry = escrow.history[i];
    if (
      n.event !== expected.event ||
      n.from !== expected.from ||
      n.to !== expected.to ||
      n.entry.seq !== i + 1 ||
      n.entry.event !== entry.event ||
      n.entry.from !== entry.from ||
      n.entry.to !== entry.to ||
      n.entry.at !== entry.at ||
      n.entry.actor !== entry.actor ||
      n.entry.note !== entry.note ||
      n.entry.amount !== entry.amount ||
      n.entry.evidence !== entry.evidence ||
      n.entry.prevHash !== entry.prevHash ||
      n.entry.hash !== entry.hash
    ) {
      throw new Error(`benchmark self-check failed: ${where}`);
    }
  }
}
// One-time validation (outside the timed loop): a subscribed
// lifecycle produces exactly the hand-written notification
// sequence, entry for entry against the escrow's history.
{
  const { escrow, notifications } = runSubscribedLifecycle();
  checkSubscribe(escrow, notifications, "subscribe fixture");
}
// One-time unsubscribe validation (outside the timed loop): after
// unsubscribe, a further successful dispatch notifies nobody —
// the count stays at the 1 notification collected before it,
// while the escrow itself still moves (hand-written expectations
// from test/subscribe.test.ts: unsubscribe stops delivery and is
// idempotent).
{
  const escrow = new Escrow("BENCH-SUB-002");
  let count = 0;
  const unsubscribe = escrow.subscribe(() => {
    count++;
  });
  escrow.dispatch("FUND", undefined, DEPOSIT_AMOUNT, {
    at: new Date(BASE_MS).toISOString(),
  });
  unsubscribe();
  unsubscribe();
  escrow.dispatch("SUBMIT_MILESTONE", undefined, undefined, {
    at: new Date(BASE_MS + 1000).toISOString(),
  });
  if (
    count !== 1 ||
    escrow.listenerCount !== 0 ||
    escrow.state !== "MILESTONE_SUBMITTED" ||
    escrow.history.length !== 2
  ) {
    throw new Error("benchmark self-check failed: subscribe unsubscribe");
  }
}
// One-time isolation validation (outside the timed loop): a
// throwing listener neither breaks the dispatch nor starves its
// peer — the dispatch returns the new state, the audit entry is
// appended, and the peer still receives the notification
// (hand-written expectations from test/subscribe.test.ts).
{
  const escrow = new Escrow("BENCH-SUB-003");
  const seen: string[] = [];
  escrow.subscribe(() => {
    throw new Error("bench: bad fan-out consumer");
  });
  escrow.subscribe(() => {
    seen.push("peer");
  });
  const to = escrow.dispatch("FUND", undefined, DEPOSIT_AMOUNT, {
    at: new Date(BASE_MS).toISOString(),
  });
  if (
    to !== "FUNDED" ||
    escrow.history.length !== 1 ||
    escrow.history[0].event !== "FUND" ||
    seen.length !== 1
  ) {
    throw new Error("benchmark self-check failed: subscribe isolation");
  }
}

// ---------------------------------------------------------------------
// Subscribe onError fixture: one pinned throwing listener subscribed
// to a fresh escrow with a collecting `onError`, then the escrow is
// driven through a fixed short chain — the first three steps of the
// LIFECYCLE table above (same events, amounts, and per-step timestamp
// offsets from BASE_MS), ending VERIFIED.
// Hand-written expectations — written out here from the documented
// `subscribe()` semantics in src/stateMachine.ts and cross-checked
// against test/subscribe.test.ts, never derived by calling subscribe
// itself:
//   - all three dispatches succeed (a throwing listener never breaks
//     dispatch): the returned states are FUNDED,
//     MILESTONE_SUBMITTED, VERIFIED in order, and the escrow ends
//     VERIFIED with exactly 3 history entries;
//   - `onError` receives exactly 3 reports, one per dispatch, in
//     dispatch order, each carrying the pinned listener error message
//     and the context of its dispatch:
//       FUND             CREATED            -> FUNDED
//       SUBMIT_MILESTONE FUNDED             -> MILESTONE_SUBMITTED
//       VERIFY_PASS      MILESTONE_SUBMITTED -> VERIFIED
//     (the first report's context is FUND CREATED -> FUNDED);
//   - the escrow has exactly 1 listener while subscribed.
// Outside the timed loop, a probe escrow pins that an `onError` that
// itself throws is swallowed too (its FUND dispatch still returns
// FUNDED with 1 history entry), and a non-function `onError` is
// pinned to its exact rejection message at subscribe time,
// registering nothing.
// ---------------------------------------------------------------------
const SUBSCRIBE_ONERROR_LISTENER_ERROR =
  "bench: onError fan-out consumer blew up";
const SUBSCRIBE_ONERROR_INVALID_ERROR =
  "invalid subscribe: onError must be a function, got string";
const SUBSCRIBE_ONERROR_EXPECTED_STATES: readonly EscrowState[] = [
  "FUNDED",
  "MILESTONE_SUBMITTED",
  "VERIFIED",
];
const SUBSCRIBE_ONERROR_EXPECTED_REPORTS: ReadonlyArray<{
  message: string;
  event: EscrowEvent;
  from: EscrowState;
  to: EscrowState;
}> = [
  {
    message: SUBSCRIBE_ONERROR_LISTENER_ERROR,
    event: "FUND",
    from: "CREATED",
    to: "FUNDED",
  },
  {
    message: SUBSCRIBE_ONERROR_LISTENER_ERROR,
    event: "SUBMIT_MILESTONE",
    from: "FUNDED",
    to: "MILESTONE_SUBMITTED",
  },
  {
    message: SUBSCRIBE_ONERROR_LISTENER_ERROR,
    event: "VERIFY_PASS",
    from: "MILESTONE_SUBMITTED",
    to: "VERIFIED",
  },
];
type SubscribeOnErrorReport = {
  message: string;
  event: EscrowEvent;
  from: EscrowState;
  to: EscrowState;
};
function runSubscribeOnError(): {
  escrow: Escrow;
  reports: SubscribeOnErrorReport[];
  states: EscrowState[];
} {
  const escrow = new Escrow("BENCH-SUB-ONERROR-001");
  const reports: SubscribeOnErrorReport[] = [];
  escrow.subscribe(
    () => {
      throw new Error(SUBSCRIBE_ONERROR_LISTENER_ERROR);
    },
    {
      onError: (err, ctx) => {
        reports.push({
          message: err instanceof Error ? err.message : String(err),
          event: ctx.event,
          from: ctx.from,
          to: ctx.to,
        });
      },
    },
  );
  const states: EscrowState[] = [];
  LIFECYCLE.slice(0, 3).forEach(({ event, amount }, i) => {
    states.push(
      escrow.dispatch(event, undefined, amount, {
        at: new Date(BASE_MS + i * 1000).toISOString(),
      }),
    );
  });
  return { escrow, reports, states };
}
function checkSubscribeOnError(
  escrow: Escrow,
  reports: SubscribeOnErrorReport[],
  states: EscrowState[],
  where: string,
): void {
  if (
    escrow.state !== "VERIFIED" ||
    escrow.listenerCount !== 1 ||
    escrow.history.length !== SUBSCRIBE_ONERROR_EXPECTED_REPORTS.length ||
    reports.length !== SUBSCRIBE_ONERROR_EXPECTED_REPORTS.length ||
    states.length !== SUBSCRIBE_ONERROR_EXPECTED_STATES.length ||
    states.some((s, i) => s !== SUBSCRIBE_ONERROR_EXPECTED_STATES[i])
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
  for (let i = 0; i < SUBSCRIBE_ONERROR_EXPECTED_REPORTS.length; i++) {
    const report = reports[i];
    const expected = SUBSCRIBE_ONERROR_EXPECTED_REPORTS[i];
    const entry = escrow.history[i];
    if (
      report.message !== expected.message ||
      report.event !== expected.event ||
      report.from !== expected.from ||
      report.to !== expected.to ||
      entry.event !== expected.event ||
      entry.from !== expected.from ||
      entry.to !== expected.to ||
      entry.seq !== i + 1
    ) {
      throw new Error(`benchmark self-check failed: ${where}`);
    }
  }
}
// One-time validation (outside the timed loop): the onError routing
// path produces exactly the hand-written report sequence.
{
  const { escrow, reports, states } = runSubscribeOnError();
  checkSubscribeOnError(escrow, reports, states, "subscribe onError fixture");
}
// One-time throwing-onError validation (outside the timed loop): an
// `onError` that itself throws is swallowed — the probe escrow's FUND
// dispatch still returns FUNDED and appends its audit entry
// (hand-written expectations from test/subscribe.test.ts).
{
  const probe = new Escrow("BENCH-SUB-ONERROR-002");
  probe.subscribe(
    () => {
      throw new Error(SUBSCRIBE_ONERROR_LISTENER_ERROR);
    },
    {
      onError: () => {
        throw new Error("bench: broken onError hook");
      },
    },
  );
  const probeState = probe.dispatch("FUND", undefined, DEPOSIT_AMOUNT, {
    at: new Date(BASE_MS).toISOString(),
  });
  if (
    probeState !== "FUNDED" ||
    probe.state !== "FUNDED" ||
    probe.history.length !== 1 ||
    probe.listenerCount !== 1
  ) {
    throw new Error("benchmark self-check failed: subscribe onError probe");
  }
}
// One-time invalid-onError validation (outside the timed loop): a
// non-function `onError` is rejected at subscribe time with the exact
// pinned message and registers nothing.
{
  const probe = new Escrow("BENCH-SUB-ONERROR-003");
  let invalidError = "";
  try {
    probe.subscribe(() => {}, {
      onError: "x" as never,
    });
  } catch (err) {
    invalidError = err instanceof Error ? err.message : String(err);
  }
  if (
    invalidError !== SUBSCRIBE_ONERROR_INVALID_ERROR ||
    probe.listenerCount !== 0
  ) {
    throw new Error(
      "benchmark self-check failed: subscribe onError invalid onError",
    );
  }
}

// ---------------------------------------------------------------------
// Snapshot round-trip fixture: the same fixed full lifecycle as
// `runLifecycle()` (the LIFECYCLE table above: same events, amounts,
// and per-step timestamp offsets from BASE_MS, ending RELEASED with
// 4 hash-chained entries), plus one fixed deadline — BASE + 30 days,
// 2026-01-31T00:00:00.000Z — attached after the lifecycle, so the
// snapshot envelope carries the one field a bare history cannot (the
// deadline lives only in the envelope; see the demo's snapshot
// segment). The snapshot itself is exported ONCE, outside the timed
// loop; the timed path restores it with `Escrow.fromJSON()`.
// Hand-written expectations — written out here from the snapshot
// contract in src/stateMachine.ts and cross-checked against
// test/serialization.test.ts ("toJSON: snapshot shape is plain JSON
// and survives a stringify round-trip" / "fromJSON: full round-trip
// restores state, history, and FUND amount" / "fromJSON: valid
// snapshot survives the strict parser byte-for-byte"), never derived
// by calling fromJSON itself:
//   - the envelope is exactly { v: SNAPSHOT_VERSION (1), id
//     BENCH-001, state RELEASED, 4 history entries, deadline
//     2026-01-31T00:00:00.000Z } — no `idempotencyKeys` and no
//     `rolePolicy` field, because the fixture consumed no key and
//     carries no policy, so both stay absent by contract;
//   - a restored escrow carries that id and state, its deadline is
//     the fixture deadline, and every history entry equals the
//     snapshot's entry field for field (seq / event / from / to /
//     at / actor / note / amount / evidence / prevHash / hash);
//   - re-exporting a restored escrow reproduces the source snapshot
//     exactly (canonical JSON text identical);
//   - the snapshot's serialized text, parsed back after a
//     JSON.parse/stringify round-trip, restores an escrow whose
//     re-export is byte-identical to the original text — checked
//     once, outside the timed loop.
// ---------------------------------------------------------------------
const SNAPSHOT_DEADLINE = "2026-01-31T00:00:00.000Z";
const snapshotEscrow = runLifecycle();
snapshotEscrow.setDeadline(new Date(BASE_MS + 30 * DAY_MS));
if (snapshotEscrow.getDeadline() !== SNAPSHOT_DEADLINE) {
  throw new Error("benchmark fixture failed: snapshot deadline shape");
}
const snapshotFixture: EscrowSnapshot = snapshotEscrow.toJSON();
if (
  snapshotFixture.v !== SNAPSHOT_VERSION ||
  snapshotFixture.id !== snapshotEscrow.id ||
  snapshotFixture.state !== "RELEASED" ||
  snapshotFixture.history.length !== historyFixture.length ||
  snapshotFixture.deadline !== SNAPSHOT_DEADLINE ||
  snapshotFixture.idempotencyKeys !== undefined ||
  snapshotFixture.rolePolicy !== undefined
) {
  throw new Error("benchmark fixture failed: snapshot envelope shape");
}
function checkSnapshotRoundTrip(restored: Escrow, where: string): void {
  if (
    restored.id !== snapshotFixture.id ||
    restored.state !== snapshotFixture.state ||
    restored.getDeadline() !== SNAPSHOT_DEADLINE ||
    restored.history.length !== snapshotFixture.history.length
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
  for (let i = 0; i < snapshotFixture.history.length; i++) {
    const a = restored.history[i];
    const b = snapshotFixture.history[i];
    if (
      a.seq !== b.seq ||
      a.event !== b.event ||
      a.from !== b.from ||
      a.to !== b.to ||
      a.at !== b.at ||
      a.actor !== b.actor ||
      a.note !== b.note ||
      a.amount !== b.amount ||
      a.evidence !== b.evidence ||
      a.prevHash !== b.prevHash ||
      a.hash !== b.hash
    ) {
      throw new Error(`benchmark self-check failed: ${where}`);
    }
  }
  if (JSON.stringify(restored.toJSON()) !== JSON.stringify(snapshotFixture)) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
}
// One-time validation (outside the timed loop): the intact snapshot
// restores to exactly the hand-written expectations.
checkSnapshotRoundTrip(
  Escrow.fromJSON(snapshotFixture),
  "snapshot round-trip fixture",
);
// Serialized-text validation (outside the timed loop): the snapshot
// text a document store would keep parses back and restores an
// escrow whose re-export is byte-identical to that text, and the
// source escrow is untouched by the whole round-trip.
{
  const snapshotText = JSON.stringify(snapshotFixture);
  const restoredFromText = Escrow.fromJSON(
    JSON.parse(snapshotText) as unknown,
  );
  checkSnapshotRoundTrip(restoredFromText, "snapshot text round-trip");
  if (JSON.stringify(restoredFromText.toJSON()) !== snapshotText) {
    throw new Error(
      "benchmark fixture failed: snapshot text round-trip mismatch",
    );
  }
  if (
    snapshotEscrow.state !== "RELEASED" ||
    snapshotEscrow.getDeadline() !== SNAPSHOT_DEADLINE ||
    snapshotEscrow.history.length !== historyFixture.length
  ) {
    throw new Error("benchmark fixture failed: snapshot source escrow changed");
  }
}

// ---------------------------------------------------------------------
// parseEscrowHistory fixture: the module-scope `historyFixture`
// above — the same detached 4-entry chained RELEASED history the
// dispatch / replay paths use — serialized ONCE with
// JSON.stringify into the plain JSON text a log shipper or another
// store would hand a recovery tool. The timed path starts from
// that text on every iteration: JSON.parse back to plain values,
// then `parseEscrowHistory()` standalone (no Escrow instance).
// Hand-written expectations — written out here from the documented
// `parseEscrowHistory` semantics in src/stateMachine.ts (the exact
// parseEscrowSnapshot validation: seq from 1 with no gaps, from/to
// chain continuous from CREATED, every edge legal, canonical
// non-decreasing timestamps, amount only on FUND, unknown fields
// rejected, and a fully chained history's hash chain
// re-verified), cross-checked against the demo's standalone
// history-parsing segment (#359) and test/historyParserFuzz's
// independent pinning of the same parser, never derived by calling
// parseEscrowHistory itself:
//   - the intact text parses to the same 4 entries verbatim —
//     seq 1 FUND / 2 SUBMIT_MILESTONE / 3 VERIFY_PASS /
//     4 RELEASE, the final entry landing in RELEASED — every
//     entry equal to the original history field for field
//     (seq / event / from / to / at / actor / note / amount /
//     evidence / prevHash / hash), so its canonical NDJSON form
//     is the fixture's own (the parser returns entries in
//     canonical field order, so the comparison is field-wise and
//     through the canonical serializer, never raw JSON text of
//     the fixture objects);
//   - a detached copy whose middle entry (seq 2,
//     SUBMIT_MILESTONE) carries a rewritten note — the same
//     tampered note the demo pins — is structurally well-formed
//     but no longer recomputes its stored hash, so the parse
//     must throw exactly the demo-pinned error
//     "invalid snapshot: history hash chain is broken (an entry
//     was tampered with, deleted, or reordered)" — checked once,
//     outside the timed loop, and the original text must still
//     parse afterwards, proving the tamper copy was detached.
// ---------------------------------------------------------------------
const PARSE_HISTORY_TAMPERED_SEQ = 2;
const PARSE_HISTORY_TAMPERED_NOTE =
  "REWRITTEN after the fact — milestone note altered";
const PARSE_HISTORY_TAMPER_ERROR =
  "invalid snapshot: history hash chain is broken (an entry was tampered with, deleted, or reordered)";
const parseHistoryText = JSON.stringify(historyFixture);
function checkParsedHistory(
  parsed: EscrowHistoryEntry[],
  where: string,
): void {
  if (
    parsed.length !== historyFixture.length ||
    historyToNdjson(parsed) !== historyToNdjson(historyFixture)
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
  for (let i = 0; i < historyFixture.length; i++) {
    const a = parsed[i];
    const b = historyFixture[i];
    if (
      a.seq !== b.seq ||
      a.event !== b.event ||
      a.from !== b.from ||
      a.to !== b.to ||
      a.at !== b.at ||
      a.actor !== b.actor ||
      a.note !== b.note ||
      a.amount !== b.amount ||
      a.evidence !== b.evidence ||
      a.prevHash !== b.prevHash ||
      a.hash !== b.hash
    ) {
      throw new Error(`benchmark self-check failed: ${where}`);
    }
  }
  const last = parsed[parsed.length - 1];
  if (last.seq !== 4 || last.event !== "RELEASE" || last.to !== "RELEASED") {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
}
// One-time validation (outside the timed loop): the intact text
// parses to exactly the hand-written expectations.
checkParsedHistory(
  parseEscrowHistory(JSON.parse(parseHistoryText) as unknown),
  "parseEscrowHistory fixture",
);
// Tamper rejection (outside the timed loop): the re-serialized
// tampered text must be rejected with the exact hash-chain error —
// and the original text must still parse afterwards, proving the
// tamper copy was detached.
{
  const tamperedHistory = (
    JSON.parse(parseHistoryText) as Array<Record<string, unknown>>
  ).map((entry) => ({ ...entry }));
  const tamperedEntry = tamperedHistory.find(
    (entry) => entry.seq === PARSE_HISTORY_TAMPERED_SEQ,
  );
  if (tamperedEntry === undefined) {
    throw new Error(
      "benchmark fixture failed: serialized history has no entry at the tamper seq",
    );
  }
  tamperedEntry.note = PARSE_HISTORY_TAMPERED_NOTE;
  let tamperError = "";
  try {
    parseEscrowHistory(JSON.parse(JSON.stringify(tamperedHistory)) as unknown);
  } catch (err) {
    tamperError = err instanceof Error ? err.message : String(err);
  }
  if (tamperError !== PARSE_HISTORY_TAMPER_ERROR) {
    throw new Error(
      "benchmark fixture failed: parseEscrowHistory tamper rejection mismatch",
    );
  }
}
checkParsedHistory(
  parseEscrowHistory(JSON.parse(parseHistoryText) as unknown),
  "parseEscrowHistory fixture after tamper check",
);

function benchParseEscrowHistory(): number {
  return measure(() => {
    // Per-iteration self-check: the entries parsed standalone from
    // the serialized text match the original history entry for
    // entry, hash chain included (see the parseEscrowHistory
    // fixture above).
    checkParsedHistory(
      parseEscrowHistory(JSON.parse(parseHistoryText) as unknown),
      "parseEscrowHistory",
    );
  }, ITERATIONS);
}

// ---------------------------------------------------------------------
// Scenarios (each with a self-check so a broken path cannot report a
// plausible-looking number).
// ---------------------------------------------------------------------
function benchDispatchLifecycle(): number {
  return measure(() => {
    const escrow = runLifecycle();
    if (escrow.state !== "RELEASED") {
      throw new Error("benchmark self-check failed: dispatch lifecycle");
    }
  }, ITERATIONS);
}

// ---------------------------------------------------------------------
// Single-step transition fixture: one fixed FUNDED escrow — the
// golden deposit 10,630 funded in a single FUND dispatch at BASE_MS —
// exported ONCE, outside the timed loop, as a plain snapshot. The
// timed path restores that snapshot with `Escrow.fromJSON()` and
// dispatches exactly one legal step, SUBMIT_MILESTONE, pinned to
// BASE_MS + 1s. Hand-written expectations — written out here from
// the transition table in src/stateMachine.ts (FUNDED carries
// SUBMIT_MILESTONE -> MILESTONE_SUBMITTED; RELEASE is not an edge
// from FUNDED) and cross-checked against test/stateMachine.test.ts,
// never derived by calling the timed path itself:
//   - the snapshot is exactly { state FUNDED, 1 history entry:
//     seq 1, FUND, CREATED -> FUNDED, amount 10,630, at BASE_MS };
//   - after the one step, the restored escrow is in
//     MILESTONE_SUBMITTED, its history holds exactly 2 entries, and
//     the appended entry is seq 2 (the snapshot's last seq + 1, no
//     gap), SUBMIT_MILESTONE, FUNDED -> MILESTONE_SUBMITTED, at
//     BASE_MS + 1s.
// ---------------------------------------------------------------------
const TRANSITION_STEP_AT = new Date(BASE_MS + 1000).toISOString();
const transitionFundedEscrow = new Escrow("BENCH-TRANSITION-001");
transitionFundedEscrow.dispatch("FUND", undefined, DEPOSIT_AMOUNT, {
  at: new Date(BASE_MS).toISOString(),
});
const transitionSnapshot: EscrowSnapshot = transitionFundedEscrow.toJSON();
if (
  transitionSnapshot.state !== "FUNDED" ||
  transitionSnapshot.history.length !== 1 ||
  transitionSnapshot.history[0].seq !== 1 ||
  transitionSnapshot.history[0].event !== "FUND" ||
  transitionSnapshot.history[0].from !== "CREATED" ||
  transitionSnapshot.history[0].to !== "FUNDED" ||
  transitionSnapshot.history[0].amount !== DEPOSIT_AMOUNT ||
  transitionSnapshot.history[0].at !== new Date(BASE_MS).toISOString()
) {
  throw new Error("benchmark fixture failed: single-step transition snapshot shape");
}
function checkTransitionStep(restored: Escrow, where: string): void {
  const history = restored.history;
  const last = history[history.length - 1];
  if (
    restored.state !== "MILESTONE_SUBMITTED" ||
    history.length !== transitionSnapshot.history.length + 1 ||
    last.seq !== transitionSnapshot.history[transitionSnapshot.history.length - 1].seq + 1 ||
    last.event !== "SUBMIT_MILESTONE" ||
    last.from !== "FUNDED" ||
    last.to !== "MILESTONE_SUBMITTED" ||
    last.at !== TRANSITION_STEP_AT
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
}
function runTransitionStep(): Escrow {
  const restored = Escrow.fromJSON(transitionSnapshot);
  restored.dispatch("SUBMIT_MILESTONE", undefined, undefined, {
    at: TRANSITION_STEP_AT,
  });
  return restored;
}
// One-time validation (outside the timed loop): the restored +
// stepped escrow matches the hand-written expectations exactly.
checkTransitionStep(runTransitionStep(), "single-step transition fixture");
// Exhaustive pure-transition check (outside the timed loop): every
// state/event pair is pinned — the 14 legal edges (hand-written
// from the transition table, in declaration order below) return
// their target, and every other pair throws the exact message
// `invalid transition: <event> from <state>`.
{
  const states: EscrowState[] = [
    "CREATED",
    "FUNDED",
    "MILESTONE_SUBMITTED",
    "VERIFIED",
    "DISPUTED",
    "RELEASED",
    "REFUNDED",
    "EXPIRED",
  ];
  const events: EscrowEvent[] = [
    "FUND",
    "SUBMIT_MILESTONE",
    "VERIFY_PASS",
    "VERIFY_FAIL",
    "RELEASE",
    "DISPUTE",
    "ARBITRATE_RELEASE",
    "ARBITRATE_REFUND",
    "EXPIRE",
  ];
  const legal = new Map<string, EscrowState>([
    ["CREATED/FUND", "FUNDED"],
    ["CREATED/EXPIRE", "EXPIRED"],
    ["FUNDED/FUND", "FUNDED"],
    ["FUNDED/SUBMIT_MILESTONE", "MILESTONE_SUBMITTED"],
    ["FUNDED/DISPUTE", "DISPUTED"],
    ["FUNDED/EXPIRE", "EXPIRED"],
    ["MILESTONE_SUBMITTED/VERIFY_PASS", "VERIFIED"],
    ["MILESTONE_SUBMITTED/VERIFY_FAIL", "DISPUTED"],
    ["MILESTONE_SUBMITTED/DISPUTE", "DISPUTED"],
    ["MILESTONE_SUBMITTED/EXPIRE", "EXPIRED"],
    ["VERIFIED/RELEASE", "RELEASED"],
    ["VERIFIED/DISPUTE", "DISPUTED"],
    ["DISPUTED/ARBITRATE_RELEASE", "RELEASED"],
    ["DISPUTED/ARBITRATE_REFUND", "REFUNDED"],
  ]);
  if (legal.size !== 14) {
    throw new Error("benchmark fixture failed: single-step legal edge count");
  }
  for (const state of states) {
    for (const event of events) {
      const expected = legal.get(`${state}/${event}`);
      if (expected !== undefined) {
        if (transition(state, event) !== expected) {
          throw new Error(
            `benchmark fixture failed: transition ${event} from ${state}`,
          );
        }
      } else {
        let message = "";
        try {
          transition(state, event);
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        if (message !== `invalid transition: ${event} from ${state}`) {
          throw new Error(
            `benchmark fixture failed: transition rejection for ${event} from ${state}`,
          );
        }
      }
    }
  }
  // The one-step illegal dispatch, through Escrow.dispatch itself:
  // RELEASE from FUNDED is rejected with that same exact message
  // and leaves the restored escrow's state and history untouched.
  const illegal = Escrow.fromJSON(transitionSnapshot);
  let illegalMessage = "";
  try {
    illegal.dispatch("RELEASE", undefined, undefined, {
      at: TRANSITION_STEP_AT,
    });
  } catch (err) {
    illegalMessage = err instanceof Error ? err.message : String(err);
  }
  if (
    illegalMessage !== "invalid transition: RELEASE from FUNDED" ||
    illegal.state !== "FUNDED" ||
    illegal.history.length !== transitionSnapshot.history.length
  ) {
    throw new Error(
      "benchmark fixture failed: single-step illegal dispatch rejection",
    );
  }
}

function benchTransition(): number {
  return measure(() => {
    // Per-iteration self-check: the state advanced exactly one
    // step, the history grew by exactly one entry, and the
    // appended entry's seq continues the snapshot's seq with no
    // gap (see the single-step transition fixture above).
    checkTransitionStep(runTransitionStep(), "benchTransition");
  }, ITERATIONS);
}

// Replay self-checks (outside the timed loop): a rebuild from the
// full fixture must reproduce the original escrow's state and history
// exactly, and a rebuild from the fixture's 3-entry VERIFIED prefix
// must accept the fixture's own RELEASE step with no seq gap,
// landing byte-identical to the full fixture.
{
  const rebuilt = Escrow.fromHistory(releasedEscrow.id, historyFixture);
  if (
    rebuilt.state !== releasedEscrow.state ||
    rebuilt.history.length !== historyFixture.length ||
    historyToNdjson(rebuilt.history) !== historyToNdjson(historyFixture)
  ) {
    throw new Error("benchmark fixture failed: fromHistory rebuild mismatch");
  }
  const continued = Escrow.fromHistory(
    releasedEscrow.id,
    historyFixture.slice(0, 3),
  );
  if (continued.state !== "VERIFIED" || continued.history.length !== 3) {
    throw new Error("benchmark fixture failed: fromHistory prefix shape");
  }
  continued.dispatch("RELEASE", undefined, undefined, {
    at: new Date(BASE_MS + 3 * 1000).toISOString(),
  });
  const continuedState: string = continued.state;
  const continuedLength: number = continued.history.length;
  if (
    continuedState !== "RELEASED" ||
    continuedLength !== 4 ||
    continued.history[3].seq !== 4 ||
    historyToNdjson(continued.history) !== historyToNdjson(historyFixture)
  ) {
    throw new Error("benchmark fixture failed: fromHistory continuation gap");
  }
}

// FromHistory fidelity fixture: reuse the module-scope
// `historyFixture` above — the same detached 4-entry chained
// history the replay path uses. The bench has timed
// `Escrow.fromHistory` with a self-check that pinned only the
// rebuilt escrow's final state and history length; this fixture
// pins the rebuild fidelity itself. Hand-written expectations —
// written out here from the fixture composition and cross-checked
// against test/fromHistory.test.ts ("golden history replays to
// the correct final state with history intact"), never derived by
// calling fromHistory itself:
//   - the rebuilt escrow carries the requested id BENCH-001, lands
//     in RELEASED (the fixture's full CREATED -> RELEASED
//     lifecycle), and holds exactly 4 history entries;
//   - every rebuilt entry equals the source entry field for field
//     (seq / event / from / to / at / actor / note / amount /
//     evidence / prevHash / hash), so its canonical NDJSON form is
//     the fixture's own (fromHistory normalizes history-entry key
//     order on rehydration, so the comparison is field-wise and
//     through the canonical serializer, never raw JSON text);
//   - a detached copy whose FUND entry's amount is altered from
//     10630 to 10631 no longer recomputes its stored hash, so
//     fromHistory must reject it with the hash-chain error —
//     checked once, outside the timed loop, mirroring the
//     dataquest fromHistory tamper check.
function checkFromHistory(rebuilt: Escrow, where: string): void {
  if (
    rebuilt.id !== releasedEscrow.id ||
    rebuilt.state !== "RELEASED" ||
    rebuilt.history.length !== historyFixture.length ||
    historyToNdjson(rebuilt.history) !== historyToNdjson(historyFixture)
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
  for (let i = 0; i < historyFixture.length; i++) {
    const a = rebuilt.history[i];
    const b = historyFixture[i];
    if (
      a.seq !== b.seq ||
      a.event !== b.event ||
      a.from !== b.from ||
      a.to !== b.to ||
      a.at !== b.at ||
      a.actor !== b.actor ||
      a.note !== b.note ||
      a.amount !== b.amount ||
      a.evidence !== b.evidence ||
      a.prevHash !== b.prevHash ||
      a.hash !== b.hash
    ) {
      throw new Error(`benchmark self-check failed: ${where}`);
    }
  }
}
// One-time validation (outside the timed loop): the intact fixture
// rebuilds to exactly the hand-written expectations.
checkFromHistory(
  Escrow.fromHistory(releasedEscrow.id, historyFixture),
  "fromHistory fixture",
);
// Tamper rejection (outside the timed loop): the altered copy must
// be rejected explicitly — and the original fixture must still
// rebuild afterwards, proving the tamper copy was detached.
const fromHistoryTampered: EscrowHistoryEntry[] = historyFixture.map(
  (e) => ({ ...e }),
);
fromHistoryTampered[0] = {
  ...fromHistoryTampered[0],
  amount: DEPOSIT_AMOUNT + 1,
};
let fromHistoryTamperRejected = false;
try {
  Escrow.fromHistory(releasedEscrow.id, fromHistoryTampered);
} catch (err) {
  fromHistoryTamperRejected =
    err instanceof Error && err.message.includes("hash chain is broken");
}
if (!fromHistoryTamperRejected) {
  throw new Error(
    "benchmark fixture failed: fromHistory accepted a tampered history",
  );
}
checkFromHistory(
  Escrow.fromHistory(releasedEscrow.id, historyFixture),
  "fromHistory fixture after tamper check",
);

function benchFromHistory(): number {
  return measure(() => {
    // Per-iteration self-check: the rebuilt escrow's id, state, and
    // full history match the source history entry for entry (see
    // the fromHistory fidelity fixture above).
    checkFromHistory(
      Escrow.fromHistory(releasedEscrow.id, historyFixture),
      "Escrow.fromHistory",
    );
  }, ITERATIONS);
}

// VerifyHistoryChain linkage fixture: reuse the module-scope
// `historyFixture` above — the same detached 4-entry chained
// history the dispatch / replay paths use. The bench has timed
// `verifyHistoryChain` since the first bench commit, but its
// self-check pinned only the boolean verdict on the intact
// fixture; this fixture pins the linkage that verdict rests
// on. Hand-written expectations — written out here from the
// chain convention in src/stateMachine.ts (the genesis entry
// links to GENESIS_PREV_HASH, every later entry links to its
// predecessor's hash) and cross-checked against
// test/historyHashChain.test.ts ("genesis entry links to the
// GENESIS_PREV_HASH constant" / "verifyHistoryChain fails
// when a middle entry's note is tampered with"), never derived
// by calling verifyHistoryChain itself:
//   - the intact fixture verifies (verifyHistoryChain returns
//     true);
//   - the first entry's prevHash is exactly GENESIS_PREV_HASH
//     (the genesis link — the boolean alone would not catch a
//     fixture whose genesis link drifted while its hashes were
//     recomputed to match);
//   - every later entry's prevHash equals its predecessor's
//     hash, entry for entry;
//   - a detached copy whose middle entry (index 1,
//     SUBMIT_MILESTONE) carries a note it never carried no
//     longer recomputes its stored hash, so verifyHistoryChain
//     must return false for it — checked once, outside the
//     timed loop, and the intact fixture must still verify
//     afterwards, proving the tamper copy was detached.
function checkVerifyHistoryChain(where: string): void {
  if (!verifyHistoryChain(historyFixture)) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
  if (historyFixture[0].prevHash !== GENESIS_PREV_HASH) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
  for (let i = 1; i < historyFixture.length; i++) {
    if (historyFixture[i].prevHash !== historyFixture[i - 1].hash) {
      throw new Error(`benchmark self-check failed: ${where}`);
    }
  }
}
// One-time validation (outside the timed loop): the intact
// fixture verifies with its genesis and successor links pinned.
checkVerifyHistoryChain("verifyHistoryChain fixture");
// Tamper rejection (outside the timed loop): the altered copy
// must return false — and the original fixture must still
// verify afterwards, proving the tamper copy was detached.
const verifyChainTampered: EscrowHistoryEntry[] = historyFixture.map(
  (e) => ({ ...e }),
);
verifyChainTampered[1] = {
  ...verifyChainTampered[1],
  note: "rewritten by an attacker",
};
if (verifyHistoryChain(verifyChainTampered)) {
  throw new Error(
    "benchmark fixture failed: verifyHistoryChain accepted a tampered history",
  );
}
checkVerifyHistoryChain("verifyHistoryChain fixture after tamper check");

function benchVerifyHistoryChain(): number {
  return measure(() => {
    // Per-iteration self-check: the intact fixture verifies and
    // its genesis / successor links match the hand-written
    // linkage expectations (see the verifyHistoryChain linkage
    // fixture above).
    checkVerifyHistoryChain("verifyHistoryChain");
  }, ITERATIONS);
}

// Keyed-chain fixture checks: the timed path verifies the keyed
// fixture under the pinned audit key. Hand-written expectations,
// from the keyed-chain semantics in src/stateMachine.ts and
// cross-checked against test/keyedHashChain.test.ts ("keyed chain
// verifies with the correct key" / "keyed chain fails closed
// without a key and with the wrong key" / "tampering with a keyed
// entry breaks verification even for the key holder"), never
// derived by calling verifyHistoryChain itself:
//   - the intact keyed fixture verifies under AUDIT_KEY (exactly
//     true);
//   - its genesis link is GENESIS_PREV_HASH and every successor
//     link equals its predecessor's hash, entry for entry;
//   - a wrong key returns false, and no key returns false — both
//     pinned once at fixture build above and, for the tamper
//     shape, below.
function checkVerifyHistoryChainAuditKey(where: string): void {
  if (verifyHistoryChain(keyedHistoryFixture, AUDIT_KEY) !== true) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
  if (keyedHistoryFixture[0].prevHash !== GENESIS_PREV_HASH) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
  for (let i = 1; i < keyedHistoryFixture.length; i++) {
    if (keyedHistoryFixture[i].prevHash !== keyedHistoryFixture[i - 1].hash) {
      throw new Error(`benchmark self-check failed: ${where}`);
    }
  }
}
// One-time validation (outside the timed loop).
checkVerifyHistoryChainAuditKey("verifyHistoryChain auditKey fixture");
// Tamper rejection under the correct key (outside the timed loop):
// the altered copy must return false — and the intact fixture must
// still verify afterwards, proving the tamper copy was detached.
const keyedChainTampered: EscrowHistoryEntry[] = keyedHistoryFixture.map(
  (e) => ({ ...e }),
);
keyedChainTampered[1] = {
  ...keyedChainTampered[1],
  note: "rewritten by an attacker",
};
if (verifyHistoryChain(keyedChainTampered, AUDIT_KEY)) {
  throw new Error(
    "benchmark fixture failed: verifyHistoryChain accepted a tampered keyed history",
  );
}
checkVerifyHistoryChainAuditKey("verifyHistoryChain auditKey fixture after tamper check");

function benchVerifyHistoryChainAuditKey(): number {
  return measure(() => {
    // Per-iteration self-check: the keyed fixture verifies under
    // the pinned audit key and its genesis / successor links match
    // the hand-written linkage expectations (see above).
    checkVerifyHistoryChainAuditKey("verifyHistoryChain auditKey");
  }, ITERATIONS);
}

function benchBuildSettlementReport(): number {
  return measure(() => {
    const built = buildSettlementReport({
      escrowId: releasedEscrow.id,
      history: historyFixture,
      finalState: "RELEASED",
      deposit,
      settlement: { proFeeBps: 500 },
    });
    if (!built.balanced) {
      throw new Error("benchmark self-check failed: buildSettlementReport");
    }
  }, ITERATIONS);
}

function benchRenderReport(): number {
  return measure(() => {
    checkRenderReport(renderReport(report));
  }, ITERATIONS);
}

function benchDepositAmountFromHistory(): number {
  return measure(() => {
    checkDepositCorpus();
  }, ITERATIONS);
}

function benchBuildSettlementReports(): number {
  return measure(() => {
    checkBatchResults(buildSettlementReports(batchInputs));
  }, ITERATIONS);
}

function benchSummarizeSettlementReports(): number {
  return measure(() => {
    checkBatchSummary(summarizeSettlementReports(batchResults));
  }, ITERATIONS);
}

function benchBuildSettlementWebhooks(): number {
  return measure(() => {
    checkBatchWebhooks(
      buildSettlementWebhooks(batchResults, {
        secret: WEBHOOK_SECRET,
        now: WEBHOOK_NOW,
        eventIdFactory: batchWebhookEventIdFactory(),
      }),
    );
  }, ITERATIONS);
}

function benchBuildSettlementWebhook(): number {
  return measure(() => {
    const built = buildSettlementWebhook(report, {
      secret: WEBHOOK_SECRET,
      now: WEBHOOK_NOW,
      eventId: WEBHOOK_EVENT_ID,
    });
    if (built.signature !== webhook.signature) {
      throw new Error("benchmark self-check failed: buildSettlementWebhook");
    }
  }, ITERATIONS);
}

function benchVerifySettlementWebhook(): number {
  return measure(() => {
    if (!verifySettlementWebhook(webhookBody, webhook.signature, WEBHOOK_SECRET)) {
      throw new Error("benchmark self-check failed: verifySettlementWebhook");
    }
  }, ITERATIONS);
}

function benchVerifySettlementWebhookSecretsRotation(): number {
  return measure(() => {
    if (
      verifySettlementWebhook(
        webhookBody,
        webhook.signature,
        WEBHOOK_ROTATION_OPTS,
      ) !== true
    ) {
      throw new Error(
        "benchmark self-check failed: verifySettlementWebhook secrets rotation",
      );
    }
  }, ITERATIONS);
}

function benchVerifySettlementWebhookMaxAge(): number {
  return measure(() => {
    if (
      verifySettlementWebhook(
        webhookBody,
        webhook.signature,
        WEBHOOK_MAX_AGE_OPTS,
      ) !== true
    ) {
      throw new Error(
        "benchmark self-check failed: verifySettlementWebhook maxAgeMs",
      );
    }
  }, ITERATIONS);
}

function benchVerifySettlementWebhookMaxFutureSkew(): number {
  return measure(() => {
    if (
      verifySettlementWebhook(
        webhookBody,
        webhook.signature,
        WEBHOOK_MAX_FUTURE_SKEW_OPTS,
      ) !== true
    ) {
      throw new Error(
        "benchmark self-check failed: verifySettlementWebhook maxFutureSkewMs",
      );
    }
  }, ITERATIONS);
}

function benchParseRetryAfter(): number {
  return measure(() => {
    checkRetryAfterCorpus();
  }, ITERATIONS);
}

function benchHistoryToNdjson(): number {
  return measure(() => {
    if (historyToNdjson(ndjsonHistoryFixture) !== ndjsonFixture) {
      throw new Error("benchmark self-check failed: historyToNdjson");
    }
  }, ITERATIONS);
}

function benchQuorumApproveToThreshold(): number {
  return measure(() => {
    const quorum = runQuorumToThreshold();
    if (!quorum.hasQuorum() || quorum.approvalCount() !== QUORUM_THRESHOLD) {
      throw new Error("benchmark self-check failed: quorum approve to threshold");
    }
  }, ITERATIONS);
}

function benchRestoreQuorum(): number {
  return measure(() => {
    checkRestoredQuorum(restoreQuorum(RESTORE_CONFIG, restorePersisted));
  }, ITERATIONS);
}

function benchQuorumSnapshotExport(): number {
  return measure(() => {
    // Per-iteration self-check against the hand-written
    // expectations above: the envelope version and key order,
    // the threshold, the 9 signers in config order, no
    // `maxApprovalAgeMs` key, and the 7 approval entries in
    // record order with their pinned timestamps. The
    // detached-copy and JSON round-trip restore checks run
    // once, outside the timed loop, in the fixture validation.
    // `snapshot()` is pure, so the same source quorum is
    // re-exported on every iteration.
    checkQuorumSnapshotExport(
      quorumExportSource.snapshot(),
      "self-check",
    );
  }, ITERATIONS);
}

function benchQuorumRevokeCycle(): number {
  return measure(() => {
    const quorum = runQuorumRevokeCycle();
    checkQuorumRevokeState(
      quorum,
      QUORUM_THRESHOLD,
      true,
      REVOKE_RESTORED_APPROVALS,
      "final",
    );
  }, ITERATIONS);
}

function benchQuorumApprovalExpiry(): number {
  return measure(() => {
    const quorum = runQuorumApprovalExpiry();
    checkQuorumExpiryState(
      quorum,
      QUORUM_THRESHOLD,
      true,
      EXPIRY_RESTORED,
      7,
      "final",
    );
  }, ITERATIONS);
}

async function benchDeliverSettlementWebhookToMany(): Promise<number> {
  return measureAsync(async () => {
    await runFanout();
  }, ITERATIONS);
}

async function benchDeliverSettlementWebhook(): Promise<number> {
  return measureAsync(async () => {
    await runSingleDelivery();
  }, ITERATIONS);
}

async function benchDeliverSettlementWebhookPreAborted(): Promise<number> {
  return measureAsync(async () => {
    await runPreAbortedDelivery();
  }, ITERATIONS);
}

async function benchDeliverSettlementWebhookMaxRetryDelayClamp(): Promise<number> {
  return measureAsync(async () => {
    await runMaxRetryDelayClampDelivery();
  }, ITERATIONS);
}

async function benchDeliverSettlementWebhookTimeout(): Promise<number> {
  return measureAsync(async () => {
    await runTimeoutDelivery();
  }, ITERATIONS);
}

function benchSettlementEventDedupe(): number {
  const hitsBefore = dedupe.stats().hits;
  const ops = measure(() => {
    const id = dedupeIds[dedupeCursor];
    dedupeCursor = (dedupeCursor + 1) % dedupeIds.length;
    if (!dedupe.checkAndRecord(id)) {
      throw new Error("benchmark self-check failed: SettlementEventDedupe hit");
    }
  }, ITERATIONS);
  // Stats consistency across the timed loop: every warmup + timed
  // call was a duplicate hit on a pre-recorded id, nothing else.
  const after = dedupe.stats();
  if (
    after.hits !== hitsBefore + WARMUP + ITERATIONS ||
    after.misses !== DEDUPE_PREFILL + 1 ||
    after.evictions !== 0 ||
    after.size !== DEDUPE_PREFILL + 1
  ) {
    throw new Error("benchmark self-check failed: SettlementEventDedupe stats");
  }
  return ops;
}

function benchSettlementEventDedupeRestore(): number {
  return measure(() => {
    const restored = SettlementEventDedupe.restore(dedupeRestoreSnapshot, {
      now: () => DEDUPE_RESTORE_NOW_MS,
    });
    // Per-iteration self-check against the hand-written
    // expectations above: the restore kept all 1,000 entries, the
    // observability counters restarted at zero, and the first /
    // middle / last snapshot ids are all duplicates (3 hits). The
    // exhaustive all-ids check runs once, outside the timed loop,
    // in the fixture validation.
    const fresh = restored.stats();
    if (
      fresh.size !== DEDUPE_RESTORE_PREFILL ||
      fresh.hits !== 0 ||
      fresh.misses !== 0 ||
      fresh.evictions !== 0 ||
      !restored.checkAndRecord(dedupeRestoreIds[0]) ||
      !restored.checkAndRecord(
        dedupeRestoreIds[DEDUPE_RESTORE_PREFILL / 2],
      ) ||
      !restored.checkAndRecord(
        dedupeRestoreIds[DEDUPE_RESTORE_PREFILL - 1],
      ) ||
      restored.stats().hits !== 3
    ) {
      throw new Error(
        "benchmark self-check failed: SettlementEventDedupe restore",
      );
    }
  }, ITERATIONS);
}

function benchSettlementEventDedupeExportSnapshot(): number {
  return measure(() => {
    // Per-iteration self-check against the hand-written
    // expectations above: the export kept exactly the 1,000 live
    // entries in record order with their pinned first-seen
    // timestamps, and the TTL-boundary entry is absent. The
    // detached-copy and empty-store checks run once, outside the
    // timed loop, in the fixture validation. `exportSnapshot` is
    // pure, so the same source store is re-exported on every
    // iteration.
    checkDedupeExportSnapshot(
      dedupeExportSource.exportSnapshot(),
      "exportSnapshot",
    );
  }, ITERATIONS);
}

function benchSettlementEventDedupeClear(): number {
  return measure(() => {
    // `clear()` mutates the store, so every iteration rebuilds the
    // whole fixture first (see the dedupe clear fixture above):
    // the reported numbers include that rebuild cost. The
    // per-iteration self-check pins the size and every counter at
    // zero right after the clear, and pins that the first id
    // records as a new event again.
    checkDedupeClear("self-check");
  }, ITERATIONS);
}

function benchSettlementEventDedupeStats(): number {
  return measure(() => {
    checkDedupeStats("self-check");
  }, ITERATIONS);
}

function benchHistoryFromNdjson(): number {
  return measure(() => {
    const entries = historyFromNdjson(ndjsonFixture);
    if (
      entries.length !== 8 ||
      entries[7].to !== "RELEASED" ||
      historyToNdjson(entries) !== ndjsonFixture
    ) {
      throw new Error("benchmark self-check failed: historyFromNdjson");
    }
  }, ITERATIONS);
}


// ---------------------------------------------------------------------
// settleRelease fixture: 4 fixed representative settlement inputs.
// Hand-computed expectations (formula: proFee = round2(gross *
// proFeeBps / 10000); net = round2(gross - proFee - referralCredits);
// expectations written by hand here, never re-derived through
// settleRelease itself — the same hand-calc tradition as the golden
// 10630 deposit and the economicsRounding tests):
//   1. golden case: gross 10630, 500 bps (the case study's 5%),
//      no credits -> proFee 531.50, net 10098.50.
//   2. mid-size with credits: gross 1000, 500 bps, credits 100
//      -> proFee 50, net 850.
//   3. large gross: gross 1000000, 250 bps, credits 1250.25
//      -> proFee 25000, net 973749.75.
//   4. half-cent rounding edge: gross 10, 125 bps, no credits
//      -> proFee round2(0.125) = 0.13 (half rounds up), net 9.87.
// ---------------------------------------------------------------------
const SETTLE_RELEASE_CASES: ReadonlyArray<{
  inputs: SettlementInputs;
  proFee: number;
  net: number;
}> = [
  { inputs: { gross: 10630, proFeeBps: 500 }, proFee: 531.5, net: 10098.5 },
  {
    inputs: { gross: 1000, proFeeBps: 500, referralCredits: 100 },
    proFee: 50,
    net: 850,
  },
  {
    inputs: { gross: 1000000, proFeeBps: 250, referralCredits: 1250.25 },
    proFee: 25000,
    net: 973749.75,
  },
  { inputs: { gross: 10, proFeeBps: 125 }, proFee: 0.13, net: 9.87 },
];

function checkSettleReleaseCase(
  result: { gross: number; proFee: number; referralCredits: number; net: number },
  expected: (typeof SETTLE_RELEASE_CASES)[number],
): void {
  if (
    result.gross !== expected.inputs.gross ||
    result.proFee !== expected.proFee ||
    result.referralCredits !== (expected.inputs.referralCredits ?? 0) ||
    result.net !== expected.net ||
    result.net + result.proFee + result.referralCredits !== result.gross
  ) {
    throw new Error("benchmark self-check failed: settleRelease");
  }
}

// Pre-check outside timing: every fixture case nets to its
// hand-written expectation before any number is reported.
for (const c of SETTLE_RELEASE_CASES) {
  checkSettleReleaseCase(settleRelease(c.inputs), c);
}

function benchSettleRelease(): number {
  return measure(() => {
    for (const c of SETTLE_RELEASE_CASES) {
      checkSettleReleaseCase(settleRelease(c.inputs), c);
    }
  }, ITERATIONS);
}

function benchExpiredEscrows(): number {
  return measure(() => {
    checkWatchdogIds(
      expiredEscrows(watchdogBatch, WATCHDOG_NOW),
      WATCHDOG_EXPIRED_IDS,
      "expiredEscrows",
    );
  }, ITERATIONS);
}

function benchStaleEscrows(): number {
  return measure(() => {
    checkWatchdogIds(
      staleEscrows(watchdogBatch, WATCHDOG_BUDGETS, WATCHDOG_NOW),
      WATCHDOG_STALE_IDS,
      "staleEscrows",
    );
  }, ITERATIONS);
}

function benchExpireOverdueEscrows(): number {
  return measure(() => {
    // Fresh fixture per iteration: the executor dispatches EXPIRE on
    // the escrows it expires, so no batch can be reused across calls.
    // The rebuild cost is inside the timed region (see the header).
    const batch = buildWatchdogBatch();
    checkExpireOverdueResults(
      expireOverdueEscrows(batch, WATCHDOG_NOW),
      "expireOverdueEscrows",
    );
  }, ITERATIONS);
}

function benchActOnStaleEscrows(): number {
  return measure(() => {
    // Fresh fixture per iteration, same reason as above: the action
    // dispatches EXPIRE on every stale escrow it can act on.
    const batch = buildWatchdogBatch();
    checkActOnStaleResults(
      actOnStaleEscrows(
        batch,
        (e) => e.dispatch("EXPIRE"),
        WATCHDOG_BUDGETS,
        WATCHDOG_NOW,
      ),
      "actOnStaleEscrows",
    );
  }, ITERATIONS);
}

function benchAllowedEvents(): number {
  return measure(() => {
    checkAllowedEventsPass();
  }, ITERATIONS);
}

function benchCalculateDeposit(): number {
  return measure(() => {
    checkCalculateDepositCorpus();
  }, ITERATIONS);
}

function benchDispatchArbitration(): number {
  return measure(() => {
    checkDispatchArbitration();
  }, ITERATIONS);
}

function benchIsOverdue(): number {
  return measure(() => {
    checkIsOverdueCorpus();
  }, ITERATIONS);
}

function benchDeadlineWriteCycle(): number {
  return measure(() => {
    runDeadlineWriteCycle();
  }, ITERATIONS);
}

function benchAssertNonNegativeMoney(): number {
  return measure(() => {
    checkMoneyGuardLegalCorpus();
  }, ITERATIONS);
}

function benchTransitionTableJson(): number {
  return measure(() => {
    checkTransitionTableJson();
  }, ITERATIONS);
}

function benchTransitionTable(): number {
  return measure(() => {
    checkTransitionTable();
  }, ITERATIONS);
}

function benchStateDiagram(): number {
  return measure(() => {
    checkStateDiagram();
  }, ITERATIONS);
}

function benchReadmeDiagramInSync(): number {
  return measure(() => {
    checkReadmeDiagramInSync();
  }, ITERATIONS);
}

function benchSubscribe(): number {
  return measure(() => {
    // Fresh escrow per iteration: dispatch mutates the escrow, so no
    // subscribed lifecycle can be reused across calls. The
    // fixture rebuild cost is inside the timed region.
    // Per-iteration self-check: the notification sequence matches
    // the hand-written expectations and the escrow's own history,
    // entry for entry (see the fixture above).
    const { escrow, notifications } = runSubscribedLifecycle();
    checkSubscribe(escrow, notifications, "subscribe");
  }, ITERATIONS);
}

function benchSubscribeOnError(): number {
  return measure(() => {
    // Fresh escrow per iteration: dispatch mutates the escrow, so no
    // onError-routed short chain can be reused across calls. The
    // fixture rebuild cost is inside the timed region.
    // Per-iteration self-check: every dispatch succeeded, the history
    // holds exactly 3 entries, and the reports match the hand-pinned
    // expectations report for report (see the fixture above).
    const { escrow, reports, states } = runSubscribeOnError();
    checkSubscribeOnError(escrow, reports, states, "subscribe onError");
  }, ITERATIONS);
}

function benchSnapshotRoundTrip(): number {
  return measure(() => {
    // The snapshot is exported once, outside the timed loop (see
    // the snapshot fixture above); the timed path is the strict
    // restore. Per-iteration self-check: the restored escrow's id,
    // state, deadline, and full history match the source snapshot
    // entry for entry, and its re-export reproduces the source
    // snapshot exactly.
    checkSnapshotRoundTrip(
      Escrow.fromJSON(snapshotFixture),
      "Escrow.fromJSON snapshot round-trip",
    );
  }, ITERATIONS);
}


// ---------------------------------------------------------------------
// requireVerifyEvidence fixture: a strict escrow (flag on) driven
// on fixed timestamps to MILESTONE_SUBMITTED — FUND of the golden
// 10,630 at BASE, SUBMIT_MILESTONE at BASE + 1s (2 entries, the
// gate armed). Hand-pinned expectations — written from the
// documented gate semantics in src/stateMachine.ts (with the flag
// on, a VERIFY_PASS without a non-empty evidence reference throws
// the pinned error BEFORE anything is appended; with evidence it
// proceeds and the reference is recorded verbatim; the library
// records the claim and does NOT verify it), cross-checked
// against src/demo.ts's verify-evidence segment and
// test/verifyEvidence.test.ts, never derived by calling the gated
// dispatch itself:
//   - the timed VERIFY_PASS with the pinned evidence at
//     BASE + 2s returns VERIFIED, the history grows by exactly
//     one entry (2 -> 3), and the appended entry is seq 3 /
//     VERIFY_PASS / MILESTONE_SUBMITTED -> VERIFIED carrying the
//     pinned evidence verbatim;
//   - outside the timed loop, an evidence-free VERIFY_PASS on a
//     strict escrow throws exactly VERIFY_EVIDENCE_ERROR and
//     leaves state (MILESTONE_SUBMITTED) and history (2 entries,
//     entry for entry via the canonical NDJSON serializer)
//     unchanged, after which the same escrow passes with
//     evidence;
//   - a default escrow (flag omitted) dispatches the same
//     evidence-free VERIFY_PASS to VERIFIED and its entry
//     carries no evidence field (pre-gate behavior unchanged);
//   - a non-boolean requireVerifyEvidence value throws exactly
//     VERIFY_EVIDENCE_ILLEGAL_ERROR at construction.
// The strict escrow is rebuilt on every iteration because
// dispatch mutates it; the rebuild cost is inside the timed
// region. Fixed timestamps, no network, no randomness, no wall
// clock.
// ---------------------------------------------------------------------
function buildStrictSubmittedEscrow(id: string): Escrow {
  const escrow = new Escrow(id, { requireVerifyEvidence: true });
  escrow.dispatch("FUND", undefined, DEPOSIT_AMOUNT, {
    at: new Date(BASE_MS).toISOString(),
  });
  escrow.dispatch("SUBMIT_MILESTONE", undefined, undefined, {
    at: new Date(BASE_MS + 1000).toISOString(),
  });
  return escrow;
}

function checkVerifyEvidencePass(escrow: Escrow, where: string): void {
  const last = escrow.history[escrow.history.length - 1];
  if (
    escrow.state !== "VERIFIED" ||
    escrow.history.length !== 3 ||
    last.seq !== 3 ||
    last.event !== "VERIFY_PASS" ||
    last.from !== "MILESTONE_SUBMITTED" ||
    last.to !== "VERIFIED" ||
    last.evidence !== VERIFY_EVIDENCE_REF ||
    last.at !== new Date(BASE_MS + 2000).toISOString()
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
}

function runVerifyEvidencePass(): Escrow {
  const escrow = buildStrictSubmittedEscrow("BENCH-VERIFY-EVIDENCE");
  const beforeLength = escrow.history.length;
  const state = escrow.dispatch("VERIFY_PASS", undefined, undefined, {
    at: new Date(BASE_MS + 2000).toISOString(),
    evidence: VERIFY_EVIDENCE_REF,
  });
  if (
    state !== "VERIFIED" ||
    beforeLength !== 2 ||
    escrow.history.length !== beforeLength + 1
  ) {
    throw new Error("benchmark self-check failed: requireVerifyEvidence");
  }
  return escrow;
}

// Outside the timed loop: the evidence-free rejection leaves no
// residue, then the same escrow passes with evidence.
{
  const strict = buildStrictSubmittedEscrow("BENCH-VERIFY-EVIDENCE-REJECT");
  const historyBefore = historyToNdjson(strict.history);
  let gateError = "";
  try {
    strict.dispatch("VERIFY_PASS", undefined, undefined, {
      at: new Date(BASE_MS + 2000).toISOString(),
    });
  } catch (err) {
    gateError = err instanceof Error ? err.message : String(err);
  }
  if (
    gateError !== VERIFY_EVIDENCE_ERROR ||
    strict.state !== "MILESTONE_SUBMITTED" ||
    strict.history.length !== 2 ||
    historyToNdjson(strict.history) !== historyBefore
  ) {
    throw new Error(
      "benchmark fixture failed: requireVerifyEvidence rejection mismatch",
    );
  }
  strict.dispatch("VERIFY_PASS", undefined, undefined, {
    at: new Date(BASE_MS + 2000).toISOString(),
    evidence: VERIFY_EVIDENCE_REF,
  });
  checkVerifyEvidencePass(strict, "requireVerifyEvidence after rejection");
}
// Outside the timed loop: the default escrow keeps pre-gate behavior.
{
  const plain = new Escrow("BENCH-VERIFY-EVIDENCE-DEFAULT");
  plain.dispatch("FUND", undefined, DEPOSIT_AMOUNT, {
    at: new Date(BASE_MS).toISOString(),
  });
  plain.dispatch("SUBMIT_MILESTONE", undefined, undefined, {
    at: new Date(BASE_MS + 1000).toISOString(),
  });
  const state = plain.dispatch("VERIFY_PASS", undefined, undefined, {
    at: new Date(BASE_MS + 2000).toISOString(),
  });
  const last = plain.history[plain.history.length - 1];
  if (
    state !== "VERIFIED" ||
    plain.history.length !== 3 ||
    "evidence" in last
  ) {
    throw new Error(
      "benchmark fixture failed: requireVerifyEvidence default behavior mismatch",
    );
  }
}
// Outside the timed loop: a non-boolean flag is a constructor error.
{
  let configError = "";
  try {
    new Escrow("BENCH-VERIFY-EVIDENCE-ILLEGAL", {
      requireVerifyEvidence: "yes",
    } as never);
  } catch (err) {
    configError = err instanceof Error ? err.message : String(err);
  }
  if (configError !== VERIFY_EVIDENCE_ILLEGAL_ERROR) {
    throw new Error(
      "benchmark fixture failed: requireVerifyEvidence config error mismatch",
    );
  }
}
// Pre-check outside timing: the timed shape itself is correct.
checkVerifyEvidencePass(runVerifyEvidencePass(), "requireVerifyEvidence fixture");

function benchRequireVerifyEvidence(): number {
  return measure(() => {
    // Fresh strict escrow per iteration: dispatch mutates the
    // escrow, so no gated escrow can be reused across calls. The
    // fixture rebuild cost is inside the timed region.
    // Per-iteration self-check: state and history advance by
    // exactly one entry and the evidence is recorded verbatim
    // (see the fixture above).
    checkVerifyEvidencePass(
      runVerifyEvidencePass(),
      "requireVerifyEvidence",
    );
  }, ITERATIONS);
}

// ---------------------------------------------------------------------
// maxDeposit fixture: a capped escrow (cap pinned to the golden
// deposit 10,630) funded in two dispatches on fixed timestamps —
// an initial FUND of 7,000 at BASE and a 3,630 top-up at
// BASE + 1s, landing the locked total exactly on the cap
// (2 entries). Hand-pinned expectations — written from the
// documented cap semantics in src/stateMachine.ts (the cap is
// checked against the running sum of all FUND amounts before
// anything is appended, so a capped-out FUND throws the pinned
// error and appends nothing; FUND dispatches without an amount
// carry no money and are never capped), cross-checked against
// test/maxDeposit.test.ts, never derived by calling the capped
// dispatch itself:
//   - the timed pair returns FUNDED twice, the history holds
//     exactly 2 entries — seq 1 / FUND / CREATED -> FUNDED /
//     7,000 at BASE and seq 2 / FUND / FUNDED -> FUNDED /
//     3,630 at BASE + 1s — and the two amounts sum to exactly
//     the cap;
//   - outside the timed loop, a FUND one cent over the cap on
//     the at-cap escrow throws exactly MAX_DEPOSIT_OVER_ERROR
//     and leaves state (FUNDED) and history (2 entries, entry
//     for entry via the canonical NDJSON serializer)
//     unchanged;
//   - a FUND without an amount on the at-cap escrow appends
//     (3 entries, no amount field on the new entry) and
//     contributes nothing: a later one-cent FUND still throws
//     the same pinned error naming the same locked total;
//   - an escrow constructed without maxDeposit accepts two
//     very large FUNDs (pre-cap behavior unchanged).
// The capped escrow is rebuilt on every iteration because
// dispatch mutates it; the rebuild cost is inside the timed
// region. Fixed timestamps, no network, no randomness, no wall
// clock.
// ---------------------------------------------------------------------
function runCappedFunding(): Escrow {
  const escrow = new Escrow("BENCH-MAX-DEPOSIT", {
    maxDeposit: MAX_DEPOSIT_CAP,
  });
  const first = escrow.dispatch("FUND", undefined, MAX_DEPOSIT_FIRST_FUND, {
    at: new Date(BASE_MS).toISOString(),
  });
  const second = escrow.dispatch("FUND", undefined, MAX_DEPOSIT_TOP_UP, {
    at: new Date(BASE_MS + 1000).toISOString(),
  });
  if (first !== "FUNDED" || second !== "FUNDED") {
    throw new Error("benchmark self-check failed: maxDeposit");
  }
  return escrow;
}

function checkCappedFunding(escrow: Escrow, where: string): void {
  const [first, second] = escrow.history;
  if (
    escrow.state !== "FUNDED" ||
    escrow.history.length !== 2 ||
    first.seq !== 1 ||
    first.event !== "FUND" ||
    first.from !== "CREATED" ||
    first.to !== "FUNDED" ||
    first.amount !== MAX_DEPOSIT_FIRST_FUND ||
    first.at !== new Date(BASE_MS).toISOString() ||
    second.seq !== 2 ||
    second.event !== "FUND" ||
    second.from !== "FUNDED" ||
    second.to !== "FUNDED" ||
    second.amount !== MAX_DEPOSIT_TOP_UP ||
    second.at !== new Date(BASE_MS + 1000).toISOString() ||
    (first.amount ?? 0) + (second.amount ?? 0) !== MAX_DEPOSIT_CAP
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
}

// Outside the timed loop: one cent over the cap throws the
// pinned error and leaves no residue.
{
  const capped = runCappedFunding();
  const historyBefore = historyToNdjson(capped.history);
  let capError = "";
  try {
    capped.dispatch("FUND", undefined, 0.01, {
      at: new Date(BASE_MS + 2000).toISOString(),
    });
  } catch (err) {
    capError = err instanceof Error ? err.message : String(err);
  }
  if (
    capError !== MAX_DEPOSIT_OVER_ERROR ||
    capped.state !== "FUNDED" ||
    capped.history.length !== 2 ||
    historyToNdjson(capped.history) !== historyBefore
  ) {
    throw new Error(
      "benchmark fixture failed: maxDeposit over-cap rejection mismatch",
    );
  }
}
// Outside the timed loop: a FUND without an amount is never
// capped, even at the cap, and contributes nothing to the
// locked total.
{
  const capped = runCappedFunding();
  const state = capped.dispatch("FUND", undefined, undefined, {
    at: new Date(BASE_MS + 2000).toISOString(),
  });
  const last = capped.history[capped.history.length - 1];
  let capError = "";
  try {
    capped.dispatch("FUND", undefined, 0.01, {
      at: new Date(BASE_MS + 3000).toISOString(),
    });
  } catch (err) {
    capError = err instanceof Error ? err.message : String(err);
  }
  if (
    state !== "FUNDED" ||
    capped.history.length !== 3 ||
    last.seq !== 3 ||
    last.event !== "FUND" ||
    "amount" in last ||
    capError !== MAX_DEPOSIT_OVER_ERROR
  ) {
    throw new Error(
      "benchmark fixture failed: maxDeposit amount-free FUND mismatch",
    );
  }
}
// Outside the timed loop: no cap configured, behavior unchanged.
{
  const uncapped = new Escrow("BENCH-MAX-DEPOSIT-UNCAPPED");
  uncapped.dispatch("FUND", undefined, 100_000_000, {
    at: new Date(BASE_MS).toISOString(),
  });
  uncapped.dispatch("FUND", undefined, 999_999_999, {
    at: new Date(BASE_MS + 1000).toISOString(),
  });
  if (
    uncapped.state !== "FUNDED" ||
    uncapped.history.length !== 2 ||
    uncapped.history[0].amount !== 100_000_000 ||
    uncapped.history[1].amount !== 999_999_999
  ) {
    throw new Error(
      "benchmark fixture failed: maxDeposit uncapped behavior mismatch",
    );
  }
}
// Pre-check outside timing: the timed shape itself is correct.
checkCappedFunding(runCappedFunding(), "maxDeposit fixture");

function benchMaxDeposit(): number {
  return measure(() => {
    // Fresh capped escrow per iteration: dispatch mutates the
    // escrow, so no capped escrow can be reused across calls.
    // The fixture rebuild cost is inside the timed region.
    // Per-iteration self-check: state, history length, and the
    // two pinned FUND amounts summing exactly to the cap (see
    // the fixture above).
    checkCappedFunding(runCappedFunding(), "maxDeposit");
  }, ITERATIONS);
}


// ---------------------------------------------------------------------
// expectedSeq fixture: an escrow driven on fixed timestamps to
// MILESTONE_SUBMITTED — FUND of the golden 10,630 at BASE,
// SUBMIT_MILESTONE at BASE + 1s (2 entries, the guard armed at
// seq 2). Hand-pinned expectations — written from the documented
// guard semantics in src/stateMachine.ts (expectedSeq asserts the
// current history length and is checked before every other
// dispatch validation; a mismatch throws the pinned conflict
// error and changes nothing; a non-integer or negative value
// throws the pinned configuration error), cross-checked against
// test/expectedSeq.test.ts, never derived by calling the guarded
// dispatch itself:
//   - the timed VERIFY_PASS with expectedSeq 2 at BASE + 2s
//     returns VERIFIED, the history grows by exactly one entry
//     (2 -> 3), and the appended entry is seq 3 / VERIFY_PASS /
//     MILESTONE_SUBMITTED -> VERIFIED at BASE + 2s;
//   - outside the timed loop, a stale expectedSeq 1 on the
//     2-entry escrow throws exactly EXPECTED_SEQ_CONFLICT_ERROR
//     and leaves state (MILESTONE_SUBMITTED) and history
//     (2 entries, entry for entry via the canonical NDJSON
//     serializer) unchanged;
//   - an empty-history escrow advances with expectedSeq 0
//     (FUND of the golden deposit at BASE -> FUNDED, 1 entry);
//   - illegal values -1 and 1.5 throw exactly their pinned
//     configuration errors and append nothing;
//   - a dispatch without expectedSeq keeps the pre-guard
//     behavior (the same VERIFY_PASS advances to VERIFIED).
// The guarded escrow is rebuilt on every iteration because
// dispatch mutates it; the rebuild cost is inside the timed
// region. Fixed timestamps, no network, no randomness, no wall
// clock.
// ---------------------------------------------------------------------
function buildExpectedSeqEscrow(id: string): Escrow {
  const escrow = new Escrow(id);
  escrow.dispatch("FUND", undefined, DEPOSIT_AMOUNT, {
    at: new Date(BASE_MS).toISOString(),
  });
  escrow.dispatch("SUBMIT_MILESTONE", undefined, undefined, {
    at: new Date(BASE_MS + 1000).toISOString(),
  });
  return escrow;
}

function checkExpectedSeqAdvance(escrow: Escrow, where: string): void {
  const last = escrow.history[escrow.history.length - 1];
  if (
    escrow.state !== "VERIFIED" ||
    escrow.history.length !== 3 ||
    last.seq !== 3 ||
    last.event !== "VERIFY_PASS" ||
    last.from !== "MILESTONE_SUBMITTED" ||
    last.to !== "VERIFIED" ||
    last.at !== new Date(BASE_MS + 2000).toISOString()
  ) {
    throw new Error(`benchmark self-check failed: ${where}`);
  }
}

function runExpectedSeqDispatch(): Escrow {
  const escrow = buildExpectedSeqEscrow("BENCH-EXPECTED-SEQ");
  const beforeLength = escrow.history.length;
  const state = escrow.dispatch("VERIFY_PASS", undefined, undefined, {
    at: new Date(BASE_MS + 2000).toISOString(),
    expectedSeq: 2,
  });
  if (
    state !== "VERIFIED" ||
    beforeLength !== 2 ||
    escrow.history.length !== beforeLength + 1
  ) {
    throw new Error("benchmark self-check failed: expectedSeq");
  }
  return escrow;
}

// Outside the timed loop: a stale expectedSeq throws the pinned
// conflict error and leaves no residue.
{
  const stale = buildExpectedSeqEscrow("BENCH-EXPECTED-SEQ-STALE");
  const historyBefore = historyToNdjson(stale.history);
  let conflictError = "";
  try {
    stale.dispatch("VERIFY_PASS", undefined, undefined, {
      at: new Date(BASE_MS + 2000).toISOString(),
      expectedSeq: 1,
    });
  } catch (err) {
    conflictError = err instanceof Error ? err.message : String(err);
  }
  if (
    conflictError !== EXPECTED_SEQ_CONFLICT_ERROR ||
    stale.state !== "MILESTONE_SUBMITTED" ||
    stale.history.length !== 2 ||
    historyToNdjson(stale.history) !== historyBefore
  ) {
    throw new Error(
      "benchmark fixture failed: expectedSeq stale conflict mismatch",
    );
  }
}
// Outside the timed loop: expectedSeq 0 advances an empty history.
{
  const empty = new Escrow("BENCH-EXPECTED-SEQ-EMPTY");
  const state = empty.dispatch("FUND", undefined, DEPOSIT_AMOUNT, {
    at: new Date(BASE_MS).toISOString(),
    expectedSeq: 0,
  });
  const only = empty.history[0];
  if (
    state !== "FUNDED" ||
    empty.history.length !== 1 ||
    only.seq !== 1 ||
    only.event !== "FUND" ||
    only.from !== "CREATED" ||
    only.to !== "FUNDED" ||
    only.amount !== DEPOSIT_AMOUNT ||
    only.at !== new Date(BASE_MS).toISOString()
  ) {
    throw new Error(
      "benchmark fixture failed: expectedSeq empty-history mismatch",
    );
  }
}
// Outside the timed loop: illegal expectedSeq values throw their
// pinned configuration errors and append nothing.
{
  const illegal = buildExpectedSeqEscrow("BENCH-EXPECTED-SEQ-ILLEGAL");
  const historyBefore = historyToNdjson(illegal.history);
  let negError = "";
  try {
    illegal.dispatch("VERIFY_PASS", undefined, undefined, {
      at: new Date(BASE_MS + 2000).toISOString(),
      expectedSeq: -1,
    });
  } catch (err) {
    negError = err instanceof Error ? err.message : String(err);
  }
  let fracError = "";
  try {
    illegal.dispatch("VERIFY_PASS", undefined, undefined, {
      at: new Date(BASE_MS + 2000).toISOString(),
      expectedSeq: 1.5,
    });
  } catch (err) {
    fracError = err instanceof Error ? err.message : String(err);
  }
  if (
    negError !== EXPECTED_SEQ_ILLEGAL_NEG_ERROR ||
    fracError !== EXPECTED_SEQ_ILLEGAL_FRAC_ERROR ||
    illegal.state !== "MILESTONE_SUBMITTED" ||
    illegal.history.length !== 2 ||
    historyToNdjson(illegal.history) !== historyBefore
  ) {
    throw new Error(
      "benchmark fixture failed: expectedSeq illegal-value mismatch",
    );
  }
}
// Outside the timed loop: no expectedSeq, pre-guard behavior.
{
  const unguarded = buildExpectedSeqEscrow("BENCH-EXPECTED-SEQ-UNGUARDED");
  const state = unguarded.dispatch("VERIFY_PASS", undefined, undefined, {
    at: new Date(BASE_MS + 2000).toISOString(),
  });
  if (state !== "VERIFIED") {
    throw new Error(
      "benchmark fixture failed: expectedSeq unguarded mismatch",
    );
  }
  checkExpectedSeqAdvance(unguarded, "expectedSeq unguarded fixture");
}
// Pre-check outside timing: the timed shape itself is correct.
checkExpectedSeqAdvance(runExpectedSeqDispatch(), "expectedSeq fixture");

function benchExpectedSeq(): number {
  return measure(() => {
    // Fresh guarded escrow per iteration: dispatch mutates the
    // escrow, so no guarded escrow can be reused across calls.
    // The fixture rebuild cost is inside the timed region.
    // Per-iteration self-check: state, history length, and the
    // appended VERIFY_PASS entry pinned field for field (see
    // the fixture above).
    checkExpectedSeqAdvance(runExpectedSeqDispatch(), "expectedSeq");
  }, ITERATIONS);
}

console.log("escrow-state-machine-ts benchmark");
console.log(`Node: ${process.version} on ${process.platform}/${process.arch}`);
console.log(`CPU: ${cpus()[0]?.model ?? "unknown"}`);
console.log(
  "Fixture: one escrow, full CREATED -> RELEASED lifecycle (4 hash-chained audit entries), golden deposit 10630; settlement webhook HMAC-SHA256 with fixed secret/timestamp/eventId; batch of 4 settlement-report inputs (released/refunded/released, 4 entries each, plus 1 mismatched input expected to land as a per-item error); settlement batch summary over that batch's 4 pre-built results (3 reports + 1 error); settlement batch webhooks over that same batch (3 signed webhooks with distinct deterministic eventIds bench-batch-event-1..3 plus the 1 forwarded per-item error); NDJSON text exported from a fixed 8-entry staged-funding history (5 FUND dispatches summing to 10630, then milestone/verify/release); quorum of 9 signers with threshold 5 on a fixed injected clock, approved one vote at a time to the threshold; settlement webhook fan-out to 4 endpoints through a fake global fetch (immediate 200, no network); settlement webhook single-target delivery (deliverSettlementWebhook to 1 fixed endpoint through a fake global fetch — immediate 200, no network, backoffMs 0 — checked for result {status: 200, attempts: 1}, exactly one captured call, and a captured X-Signature equal to the buildSettlementWebhook signature and verifiable over the captured body on every iteration, with a persistent-500 retry-exhaustion error — failed after 3 attempts at retries 2 — pinned once outside the timed loop); settlement event dedupe duplicate hits cycling over 1,000 pre-recorded eventIds under a fixed injected clock; settlement event dedupe restore from a 1,000-entry JSON-round-tripped snapshot under a fixed injected clock (all entries live at load, default TTL and capacity, observability counters restarting at zero); settlement event dedupe snapshot export from a 1,001-entry dedupe (1,000 live ids plus one entry aged exactly to its TTL boundary, so it is excluded) under a stepped fixed injected clock, checked entry for entry against hand-pinned expectations on every iteration, with a detached-copy mutation and the empty-store export pinned once outside the timed loop; settlement event dedupe clear (SettlementEventDedupe.clear) over a fresh 1,000-id dedupe rebuilt on every iteration under a fixed injected clock (1,000 first sightings plus 1 duplicate hit before the clear, so the reported numbers include the fixture-rebuild cost — prefill plus clear), self-checked on every iteration for an all-zero size and stats right after the clear and the first id recording as a new event again, with an empty-dedupe clear no-op check outside the timed loop; settlement event dedupe stats (SettlementEventDedupe.stats) over a fixed 7-record dedupe under an injectable clock that advances only during fixture construction (60-second TTL, capacity 6 — one id LRU-evicted during construction and one id expired at the stats instant, 5 live ids), self-checked on every iteration for the hand-pinned snapshot {size: 5, hits: 1, misses: 7, evictions: 1} where size counts only the live ids, with a detached-copy mutation check and an empty-dedupe all-zero check outside the timed loop; Escrow.fromHistory replay over the same detached 4-entry history, self-checked per iteration for the rebuilt id and state and the full history entry for entry (hashes included, compared field-wise and through the canonical NDJSON serializer, because rehydration normalizes entry key order), with a detached tampered copy (FUND amount altered from 10630 to 10631) rejected with the hash-chain error outside the timed loop; watchdog screening over a fixed mixed batch of 100 escrows (40 hand-counted expired, 70 hand-counted stale under FUNDED 7d / MILESTONE_SUBMITTED 30d budgets) at a fixed screening instant; watchdog execution (expireOverdueEscrows / actOnStaleEscrows with an EXPIRE-dispatch action) over fresh rebuilds of that same 100-escrow batch on every iteration because the executors mutate their inputs (40 of 40 expire attempts and 70 of 70 stale actions succeed — both selected states carry an EXPIRE edge); quorum snapshot restore from a persisted (JSON round-tripped) snapshot of the 9-signer / threshold-5 quorum carrying 7 recorded approvals; settleRelease netting over 4 fixed representative inputs (golden 10630 at 500 bps, 1000 at 500 bps with 100 credits, large gross 1000000 at 250 bps with 1250.25 credits, rounding edge 10 at 125 bps) checked against hand-computed proFee/net on every iteration; parseRetryAfter over a fixed 11-value corpus (delay-seconds, fractional and whitespace-padded values, zero, future and past HTTP-dates, signed numbers, a garbage string, null and undefined) against one injected fixed now, every result checked against hand-pinned expectations on every iteration; depositAmountFromHistory over a fixed 4-shape corpus (a single FUND of the golden 10630, a two-FUND top-up sequence summing to 12630, a FUND recorded without an amount, and an empty no-FUND history) checked against hand-pinned totals and exact fail-fast error messages on every iteration; renderReport rendering of the fixed golden released report (deposit 10630, released via VERIFY_PASS -> RELEASE, 4 party rows) checked against hand-written expected lines (header/outcome, deposit formula, creator net row) on every iteration; allowedEvents over all 8 states of the transition table (one pass = every state queried once in declaration order — CREATED, FUNDED, MILESTONE_SUBMITTED, VERIFIED, DISPUTED, RELEASED, REFUNDED, EXPIRED — with each result checked against its hand-pinned expected event list in declaration order, the three terminal states expecting the empty list) on every iteration; calculateDeposit over a fixed 3-shape corpus (the golden vector pool 10000 / base 600 / complexity 1.0 / loyalty 30 / oracle 60 -> deposit 10630, a complexity 1.5 case -> deposit 6190, and a large-pool 1000000 case -> deposit 1005375) checked against hand-computed adjustedBaseFee and deposit expectations on every iteration; arbitration dispatch (dispatchArbitration with outcome \"refund\", rebuilding a DISPUTED escrow from its fixed 2-entry history prefix via Escrow.fromHistory and a threshold-reached 5/9 quorum via createQuorum on every iteration — rebuild cost inside the timed region — pinned to a fixed audit timestamp, checked for the REFUNDED terminal state, exactly one appended ARBITRATE_REFUND entry, and its \"quorum 5/5\" note on every iteration; isOverdue over a fixed 4-case corpus (past-deadline FUNDED, future-deadline FUNDED, deadline-less FUNDED, and past-deadline terminal RELEASED escrows) checked against hand-pinned booleans (true/false/false/false) against one injected fixed now on every iteration; assertNonNegativeMoney over a fixed legal corpus (0, 0.01, the golden 10630, and 1000000.25) checked to pass without throwing on every iteration, with the illegal corpus (negative, NaN, Infinity, -Infinity, a numeric string, undefined, and null — each throwing the exact message \"amount must be a finite non-negative number\") asserted once outside the timed loop and never timed); transitionTableJson (fixed no-arg transition-table JSON export, parsed back and checked against hand-pinned expectations — 14 edges, first CREATED/FUND/FUNDED, release edge VERIFIED/RELEASE/RELEASED at index 10, last DISPUTED/ARBITRATE_REFUND/REFUNDED, per-edge key order from,event,to, and a single trailing newline — on every iteration); stateDiagram (fixed no-arg Mermaid rendering, checked against hand-pinned expectations — 21 lines, all 14 edge lines written out in full in declaration order, the start line pinning CREATED, the 3 terminal lines RELEASED/REFUNDED/EXPIRED, and all 8 states present — on every iteration); readmeDiagramInSync (fixed no-arg README diagram sync check — reads only this repo's README.md, regenerates the diagram, and checks the exact block is embedded, checked against the hand-pinned expectation true on every iteration); subscribe (full lifecycle, 1 collecting listener) over the same full 4-dispatch lifecycle on a fresh escrow per iteration, self-checked per iteration against the hand-written (event, from, to) sequence and the escrow's own history entry for entry, with unsubscribe and throwing-listener isolation checks outside the timed loop; subscribe onError error routing (1 pinned throwing listener + collecting onError) over a fixed 3-dispatch short chain (FUND, SUBMIT_MILESTONE, VERIFY_PASS to VERIFIED) on a fresh escrow per iteration, self-checked per iteration that every dispatch succeeded, the history holds exactly 3 entries, and the reports match the hand-pinned expectations report for report (pinned message plus event / from / to context, first report FUND CREATED -> FUNDED), with a throwing-onError-swallowed probe and a non-function onError pinned to its exact rejection message outside the timed loop; hash-chain verification (verifyHistoryChain) over the same fixed 4-entry history, self-checked per iteration for the genesis link (the first entry's prevHash is GENESIS_PREV_HASH) and every successor link (each entry's prevHash equals its predecessor's hash), with a detached tampered copy (the middle SUBMIT_MILESTONE entry gaining a note it never carried) returning false outside the timed loop; snapshot round-trip (Escrow.fromJSON restoring the fixed toJSON snapshot of the same full lifecycle escrow carrying the fixed deadline 2026-01-31T00:00:00.000Z, checked on every iteration for the restored id, state, and deadline and the full history entry for entry — hash chain included — and for a re-export identical to the source snapshot, with the serialized snapshot text additionally restored unchanged after a JSON.parse/stringify round-trip once outside the timed loop); standalone history parsing (parseEscrowHistory over the JSON-serialized text of that same fixed 4-entry RELEASED history, parsed back from the text and validated standalone — no Escrow instance — on every iteration, checked entry for entry against the original history, hash / prevHash chain included, field-wise and through the canonical NDJSON serializer, with a detached tampered text — the middle SUBMIT_MILESTONE entry's note rewritten and re-serialized — rejected with the exact hash-chain error once outside the timed loop and the original text still parsing afterwards); single-step transition dispatch (benchTransition restoring the fixed FUNDED snapshot — 1 FUND entry, golden 10630 at the base instant — on every iteration and dispatching one SUBMIT_MILESTONE step pinned at BASE + 1s, checked on every iteration for the one-step state advance FUNDED -> MILESTONE_SUBMITTED, exactly one appended entry, and a gap-free seq continuation, with an exhaustive pure-transition check over all 8 states x 9 events — 14 legal edges returning their hand-pinned targets, every other pair throwing the exact invalid-transition message, including the illegal RELEASE dispatch from FUNDED — asserted once outside the timed loop); transitionTable (fixed no-arg pure transition-table object construction, checked against hand-pinned 14 edges in declaration order on every iteration, spot-checked against the transitionTableJson edge set via the shared pinned first / release / last edges, with the full edge set compared to the parsed JSON edge set and a pinned non-existent CREATED/RELEASE/RELEASED edge confirmed absent exhaustively once outside the timed loop); deadline write cycle (setDeadline + clearDeadline on one shared FUNDED escrow — set via a Date to 2026-01-31 and read back pinned, overwritten via a string to 2026-05-01 and read back pinned, then cleared to undefined so the escrow returns to its initial deadline-less state for the next iteration, with state and history checked unchanged on every iteration, and, outside the timed loop, illegal-input rejection — invalid deadline: not-a-date and invalid deadline: Invalid Date — pinned to leave any stored value untouched, non-canonical input pinned to its normalized canonical form, and a terminal RELEASED probe pinned to store a past deadline yet never judge overdue); quorum revoke cycle (fresh 5/9 quorum on a fixed injected clock — approve dao-1..dao-5 to the threshold, revoke dao-3 to drop to 4/5 below the threshold, then re-approve dao-3 to return to 5/5, with approvalCount/hasQuorum/approvals checked against hand-pinned expectations at every stage and the re-approved signer returning last in approvals order, and unknown-signer / not-approved revoke rejections — unknown quorum signer: \"mallory\" and cannot revoke: signer \"dao-6\" has not approved — pinned once outside the timed loop); quorum snapshot export (snapshot() over the fixed 9-signer / threshold-5 quorum carrying 7 recorded approvals on a stepped fixed clock — dao-1..dao-7 at BASE + 0..6s — checked on every iteration against hand-pinned envelope expectations: v 1 in the pinned key order v,threshold,signers,approvals, threshold 5, the 9 signers in config order, no maxApprovalAgeMs key, and the 7 approval entries in record order with their pinned canonical timestamps, with a detached-copy mutation pinned to leave a re-export unchanged and the JSON-round-tripped export pinned to restore via restoreQuorum into a quorum re-exporting the group-14 persisted snapshot byte-for-byte, both once outside the timed loop); quorum maxApprovalAgeMs expiry (counting views on a fresh 5/9 quorum with a 60-second window on an advancing injected clock — approvals staggered at BASE, BASE + 30s and BASE + 60s checked while all five count with dao-1 exactly at the inclusive boundary, then expiring one at a time as the clock crosses each window with dao-2 pinned at its own boundary, the audit log pinned at its full 5 entries throughout, and the two expired signers re-approving to restore the quorum with the log grown to 7 — on every iteration, with the fully-expired log retention and the re-approval fresh timestamp pinned once outside the timed loop); settlement webhook secret-rotation verification (verifySettlementWebhook with { secrets: [new, old] } over the old-signed fixed webhook \u2014 the matching candidate is second, so every iteration pays one failed HMAC trial before the match \u2014 checked exactly true on every iteration, with an all-mismatch candidate pair pinned to false and an empty secrets array pinned to its exact configuration error, both once outside the timed loop); settlement webhook maxAgeMs freshness verification (verifySettlementWebhook with { secrets: [secret], maxAgeMs: 300000, now: at + 120s } over the fixed webhook — the injected now is pinned inside the 300,000 ms window, so the freshness gate runs after the signature match on every iteration — checked exactly true on every iteration, with an over-age payload pinned to false, a payload aged exactly to the inclusive boundary pinned to true, and an illegal maxAgeMs of -1 pinned to its exact configuration error, all once outside the timed loop); keyed audit-chain verification (verifyHistoryChain with the pinned auditKey over a fixed 4-entry HMAC-chained history — the same lifecycle, id, and fixed timestamps as the unkeyed fixture, so the two chains differ only in hash function — checked exactly true on every iteration with the genesis and successor links pinned, with a wrong key, no key, and a detached tampered copy (the middle entry gaining a note it never carried) all pinned to false outside the timed loop); settlement webhook maxFutureSkewMs future-skew verification (verifySettlementWebhook with { secrets: [secret], maxFutureSkewMs: 300000, now: at - 120s } over the fixed webhook — the injected now is pinned 120 s before the payload timestamp, so the payload sits in the future inside the 300,000 ms skew window and the freshness gate runs after the signature match on every iteration — checked exactly true on every iteration, with an over-skew payload pinned to false, a payload skewed exactly to the inclusive boundary pinned to true, both bounds set together pinned to reject on each side while a payload inside both windows still verifies, and an illegal maxFutureSkewMs of -1 pinned to its exact configuration error, all once outside the timed loop); settlement webhook pre-aborted delivery (deliverSettlementWebhook with a pre-aborted AbortSignal over the fixed webhook through a counting fake global fetch — rejected with the exact error webhook delivery aborted and the fetch call count pinned at exactly zero on every iteration, with a non-AbortSignal signal value pinned to its exact configuration error before any request and a never-aborting signal pinned to the normal {status: 200, attempts: 1} delivery after exactly one fetch, both once outside the timed loop); settlement webhook maxRetryDelayMs-clamped delivery (deliverSettlementWebhook with maxRetryDelayMs 0 over the fixed webhook through a fake global fetch — first answer 429 with Retry-After 31536000, second answer 200 — checked for result {status: 200, attempts: 2} and exactly two fetch calls on every iteration, the one-year hint clamped to 0 so no real sleep ever happens, with an illegal maxRetryDelayMs of -1 pinned to its exact configuration error before any request and a hint-less 500-then-200 script pinned to the exponential-backoff fallback shape, both once outside the timed loop); requireVerifyEvidence VERIFY_PASS (strict escrow with requireVerifyEvidence: true rebuilt fresh on every iteration — FUND of the golden 10630 at BASE and SUBMIT_MILESTONE at BASE + 1s, so the rebuild cost is inside the timed region — then VERIFY_PASS with the pinned evidence reference at BASE + 2s, checked on every iteration for the VERIFIED state, a history grown by exactly one entry (2 -> 3), and the appended entry carrying the pinned evidence verbatim, with an evidence-free VERIFY_PASS pinned once outside the timed loop to throw the exact gate error and leave state and history unchanged entry for entry before the same escrow passes with evidence, a default escrow pinned to keep the pre-gate evidence-free behavior with no evidence field on its entry, and a non-boolean flag value pinned to its exact constructor configuration error); maxDeposit capped funding (fresh escrow with maxDeposit pinned to the golden 10630 rebuilt on every iteration — FUND 7000 at BASE and a 3630 top-up at BASE + 1s landing exactly on the cap — checked on every iteration for the FUNDED state, exactly two history entries, and the two pinned FUND amounts summing to the cap, with a one-cent-over FUND pinned once outside the timed loop to throw the exact cap error and leave state and history unchanged entry for entry, a FUND without an amount pinned to stay uncapped at the cap and contribute nothing to the locked total, and an uncapped escrow pinned to keep the pre-cap behavior; dispatch expectedSeq optimistic-concurrency dispatch (fresh 2-entry escrow rebuilt on every iteration — FUND of the golden 10630 at BASE and SUBMIT_MILESTONE at BASE + 1s — then VERIFY_PASS with expectedSeq 2 at BASE + 2s, checked on every iteration for the VERIFIED state, a history grown by exactly one entry (2 -> 3), and the appended entry pinned field for field, with a stale expectedSeq pinned once outside the timed loop to throw the exact conflict error and leave state and history unchanged entry for entry, an empty-history expectedSeq 0 pinned to advance, illegal -1 / 1.5 values pinned to their exact configuration errors, and a guard-free dispatch pinned to keep the pre-guard behavior); settlement webhook timeoutMs timeout delivery (deliverSettlementWebhook with timeoutMs 10 and retries 0 over the fixed webhook through a hanging fake global fetch — the fake only rejects on abort, so the pinned short timeout is the only thing that ends the attempt — rejected with the exact error webhook delivery to the single endpoint failed after 1 attempt: webhook delivery timed out after 10ms, annotated attempts 1, after exactly one fetch call on every iteration; the timeout wait itself is the object under test at the pinned short 10 ms and no elapsed-time assertion is made, with an illegal timeoutMs of 0 pinned once outside the timed loop to throw its exact configuration error before any request at zero fetch calls and a generous timeoutMs of 5000 over an immediate 200 pinned to the normal {status: 200, attempts: 1} success shape after exactly one fetch)",
);
console.log(`Iterations per op: ${ITERATIONS} (after ${WARMUP} warmup)`);
console.log("");

const results: Array<{ path: string; ops: number }> = [
  { path: "dispatch (full lifecycle, 4 dispatches)", ops: benchDispatchLifecycle() },
  { path: "benchTransition (single step, snapshot restore)", ops: benchTransition() },
  { path: "verifyHistoryChain (4 entries)", ops: benchVerifyHistoryChain() },
  { path: "verifyHistoryChain auditKey (4 entries, keyed)", ops: benchVerifyHistoryChainAuditKey() },
  { path: "Escrow.fromHistory (4 entries)", ops: benchFromHistory() },
  { path: "settleRelease (4 fixed inputs)", ops: benchSettleRelease() },
  { path: "buildSettlementReport (4 entries)", ops: benchBuildSettlementReport() },
  { path: "renderReport (released report, 4 parties)", ops: benchRenderReport() },
  { path: "depositAmountFromHistory (4-shape corpus)", ops: benchDepositAmountFromHistory() },
  { path: "buildSettlementReports (batch 4 x 4 entries)", ops: benchBuildSettlementReports() },
  { path: "summarizeSettlementReports (batch 4 results)", ops: benchSummarizeSettlementReports() },
  { path: "buildSettlementWebhooks (batch 4 results)", ops: benchBuildSettlementWebhooks() },
  { path: "buildSettlementWebhook (sign)", ops: benchBuildSettlementWebhook() },
  { path: "verifySettlementWebhook", ops: benchVerifySettlementWebhook() },
  { path: "verifySettlementWebhook (secrets rotation, 2 candidates)", ops: benchVerifySettlementWebhookSecretsRotation() },
  { path: "verifySettlementWebhook (maxAgeMs freshness window)", ops: benchVerifySettlementWebhookMaxAge() },
  { path: "verifySettlementWebhook (maxFutureSkewMs future-skew window)", ops: benchVerifySettlementWebhookMaxFutureSkew() },
  { path: "parseRetryAfter (11-value corpus)", ops: benchParseRetryAfter() },
  { path: "historyToNdjson (8 entries)", ops: benchHistoryToNdjson() },
  { path: "historyFromNdjson (8 entries, chain re-verify)", ops: benchHistoryFromNdjson() },
  { path: "quorum approve to threshold (5 of 9)", ops: benchQuorumApproveToThreshold() },
  { path: "restoreQuorum (snapshot, 7 approvals of 9)", ops: benchRestoreQuorum() },
  { path: "quorum snapshot export (7 approvals of 9)", ops: benchQuorumSnapshotExport() },
  { path: "quorum revoke cycle (5 of 9, revoke + re-approve)", ops: benchQuorumRevokeCycle() },
  { path: "quorum maxApprovalAgeMs expiry (5 of 9, 60s window)", ops: benchQuorumApprovalExpiry() },
  { path: "deliverSettlementWebhookToMany (4 endpoints)", ops: await benchDeliverSettlementWebhookToMany() },
  { path: "deliverSettlementWebhook (single endpoint)", ops: await benchDeliverSettlementWebhook() },
  { path: "deliverSettlementWebhook (pre-aborted signal)", ops: await benchDeliverSettlementWebhookPreAborted() },
  { path: "deliverSettlementWebhook (maxRetryDelayMs clamp, 429 hint)", ops: await benchDeliverSettlementWebhookMaxRetryDelayClamp() },
  { path: "deliverSettlementWebhook (timeoutMs timeout)", ops: await benchDeliverSettlementWebhookTimeout() },
  { path: "SettlementEventDedupe checkAndRecord (hit, 1k)", ops: benchSettlementEventDedupe() },
  { path: "SettlementEventDedupe.restore (1,000-entry snapshot)", ops: benchSettlementEventDedupeRestore() },
  { path: "SettlementEventDedupe.exportSnapshot (1,000-entry snapshot)", ops: benchSettlementEventDedupeExportSnapshot() },
  { path: "SettlementEventDedupe.clear (1,000 recorded ids, fresh fixture)", ops: benchSettlementEventDedupeClear() },
  { path: "SettlementEventDedupe.stats (5 live entries, 1 expired)", ops: benchSettlementEventDedupeStats() },
  { path: "expiredEscrows (batch 100 escrows)", ops: benchExpiredEscrows() },
  { path: "staleEscrows (batch 100 escrows)", ops: benchStaleEscrows() },
  { path: "expireOverdueEscrows (batch 100 escrows)", ops: benchExpireOverdueEscrows() },
  { path: "actOnStaleEscrows (batch 100 escrows)", ops: benchActOnStaleEscrows() },
  { path: "allowedEvents (all 8 states)", ops: benchAllowedEvents() },
  { path: "calculateDeposit (3-shape corpus)", ops: benchCalculateDeposit() },
  { path: "dispatchArbitration (refund, rebuilt fixture)", ops: benchDispatchArbitration() },
  { path: "isOverdue (4-case corpus)", ops: benchIsOverdue() },
  { path: "setDeadline + clearDeadline (FUNDED escrow write cycle)", ops: benchDeadlineWriteCycle() },
  { path: "assertNonNegativeMoney (legal corpus)", ops: benchAssertNonNegativeMoney() },
  { path: "transitionTableJson (14 edges)", ops: benchTransitionTableJson() },
  { path: "transitionTable (14 edges)", ops: benchTransitionTable() },
  { path: "stateDiagram (14 edges, 21 lines)", ops: benchStateDiagram() },
  { path: "readmeDiagramInSync (README sync check)", ops: benchReadmeDiagramInSync() },
  { path: "subscribe (full lifecycle, 1 collecting listener)", ops: benchSubscribe() },
  { path: "subscribe onError (short chain, 1 throwing listener)", ops: benchSubscribeOnError() },
  { path: "Escrow.fromJSON (snapshot round-trip, 4 entries)", ops: benchSnapshotRoundTrip() },
  { path: "parseEscrowHistory (4 entries, JSON text)", ops: benchParseEscrowHistory() },
  { path: "requireVerifyEvidence VERIFY_PASS (evidence gate)", ops: benchRequireVerifyEvidence() },
  { path: "maxDeposit FUND (deposit cap, funds to cap)", ops: benchMaxDeposit() },
  { path: "dispatch expectedSeq (optimistic concurrency)", ops: benchExpectedSeq() },
];

console.log("path                                              throughput");
console.log("---------------------------------------------------------------------");
for (const r of results) {
  console.log(`${r.path.padEnd(50)} ${fmt(r.ops)}`);
}
console.log("");
console.log("Numbers are machine-local measurements, not guarantees.");
