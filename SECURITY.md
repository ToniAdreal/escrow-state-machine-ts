# Security policy and trust boundaries

> This is a demo/state-machine library, not a production payment system.
> Every claim below is verifiable against the source in `src/`.

## Scope

`escrow-state-machine-ts` models the rules of an off-chain milestone escrow:
state transitions, fee math, settlement reporting, quorum counting, and
webhook signing. It holds no real money, runs no on-chain code, and its
cryptography is HMAC (webhook signatures, and the optional keyed audit
hash chain described below) plus Ed25519 verification for opt-in signed
quorum approvals (`approveSigned()`).

## Trust model

### Caller-trust decisions (NOT enforced by this library)

- **`quorum.approve()` records caller-trust approvals.** `src/quorum.ts`
  stores signer id strings; plain `approve()` performs no signature
  verification, no key management, and no DAO governance. Calling
  `approve("dao-3")` is only as trustworthy as the caller who says
  "dao-3 approved". The optional `maxApprovalAgeMs` expiry window only
  bounds how long a recorded approval *counts* (the audit log keeps
  expired entries); it does not authenticate the approval itself.
  Opt-in verification exists: `approveSigned()` verifies an Ed25519
  signature over the canonical statement
  `escrow-quorum:approve:<signerId>` against a public key registered
  in `QuorumConfig.signerPublicKeys` (non-Ed25519/private keys are
  rejected at construction), marks the log entry `verified: true`,
  and throws without recording anything on failure. The statement
  binds the signer id only — not an escrow or outcome — so a signature
  is meaningful only inside the quorum it was collected for; use one
  quorum per arbitration. A snapshot carries recorded `verified`
  flags as data and restoring one does not re-verify signatures.
  Quorum approval `evidence` is capped at 32,768 characters (the
  same `MAX_EVIDENCE_LENGTH` ceiling as escrow history evidence),
  enforced at `approve()`, `approveSigned()`, and snapshot restore,
  so an oversized reference can neither be recorded live nor smuggled
  in through a rehydrated snapshot; signer ids are capped at 256
  characters (`MAX_ACTOR_LENGTH`) because they are written verbatim
  into the approval log and snapshots. Both caps reject outright,
  never truncate.
  `src/arbitration.ts` wires the *count* to `dispatchArbitration` (it refuses
  to dispatch below threshold and records `quorum <approvals>/<threshold> [signer, …]`
  in the audit note — the counted signers, approval-time order, expired approvals
  excluded — but it does not make the approvals cryptographic —
  see the honesty note in its header comment.
- **`VERIFY_PASS` is a caller trust decision.** Dispatching it verifies no
  oracle signatures, zero-knowledge proofs, or TEE attestations
  (README FAQ: "Where is that here?" — it isn't, deliberately).
  The opt-in `requireVerifyEvidence` constructor flag only requires a
  non-empty `evidence` reference on the audit entry; the library records
  the caller's claim, it does not check it.
- **Webhook secret distribution is the caller's responsibility.**
  `src/webhooks.ts` documents this in its header comment and the README
  repeats it: whoever holds the secret can forge `sha256=<hex>` signatures.
  This library does not generate, store, or distribute secrets — store the
  secret like any other API credential. What the library *does* offer is
  rotation support on the verify side: `verifySettlementWebhook` accepts a
  `{ secrets: [...] }` candidate set, so during the caller's own rotation
  window signatures made with either the old or the new secret verify
  (any-match wins, all-mismatch fails closed). The rotation schedule itself
  stays entirely with the caller.
- **The RBAC actor is a caller assertion, NOT identity.**
  `EscrowOptions.rolePolicy` maps events to allowed actor names and
  `dispatch(..., { actor })` checks the supplied string against that
  allowlist — but the caller *asserts* the actor string and nothing
  verifies who the caller is. Anyone who can call `dispatch` can
  claim to be `"treasury"`. The policy guarantees only that
  dispatches violating the *declared* allowlist do not happen and
  that the audit trail records the actor string it was given (the
  actor is covered by the entry's hash chain). Real identity
  authentication — sessions, signatures, verified credentials —
  remains entirely the caller's responsibility.
- **Receiver-side trust.** `buildSettlementWebhook` derives every payload
  field from the audit-backed `SettlementReport` (nothing is invented),
  but the receiver must verify the signature over the raw body bytes;
  an unverified receiver is trusting the network, not the escrow.

### Enforced by the library (verifiable in `src/`)

- **Money boundary checks.** `assertNonNegativeMoney` (`src/stateMachine.ts`)
  rejects non-number, non-finite, and negative amounts with a descriptive
  error at the `dispatch("FUND", …)` boundary; `calculateDeposit` and
  `settleRelease` apply the same finite/non-negative checks to their inputs.
  Illegal money fails fast instead of silently poisoning downstream
  accounting.
- **Webhook verification is constant-time and fail-closed.**
  `verifySettlementWebhook` compares with `timingSafeEqual`; malformed
  signatures (anything not matching `sha256=<64 hex>`) return `false`
  rather than throwing, so hostile input cannot turn verification into an
  unhandled exception. Verify over the raw body bytes — the object overload
  re-stringifies with a fixed key order for in-process convenience, but raw
  bytes are the transport-safe path (documented in `src/webhooks.ts`).
  Note the one throwing case: an empty `secrets` array (or an empty secret
  inside it) is a caller configuration error and throws
  `cannot verify settlement webhook: …` — it never silently passes.
  **Signatures don't expire on their own:** without the opt-in
  `maxAgeMs`, a legitimately-signed payload from a year ago still verifies.
  Pass `VerifyWebhookOptions.maxAgeMs` to fail-closed reject payloads older
  than the window (signature is checked first; an unparseable `at` returns
  `false`). Future timestamps are not bounded by `maxAgeMs` alone — pass
  the companion opt-in `VerifyWebhookOptions.maxFutureSkewMs` to also
  fail-closed reject payloads whose `at` lies further in the future than
  the tolerated clock skew (same inclusive boundary, same
  signature-first order); together the two form a two-sided freshness
  window. With neither set, verification is signature-only.
- **Settlement never runs on uncorroborated amounts.**
  `depositAmountFromHistory` (`src/settlementReport.ts`) throws
  `settlement requires a FUND amount` when the audit history has no FUND
  event or any FUND lacks an `amount` — undefined/NaN never silently poisons
  the settlement math. `buildSettlementReport` additionally cross-checks the
  caller-supplied deposit against the audit-history total.
- **Event-level RBAC allowlist (when a policy is set).**
  `Escrow` constructed with `rolePolicy` rejects a dispatch of a
  listed event whose `actor` is missing or not in the allowlist with
  `actor not authorized for …`, before any transition — no history
  is appended and no idempotency key is consumed. Events the policy
  does not list are unrestricted, and an escrow with no policy skips
  the check entirely. Invalid policies throw at construction
  (`invalid option: rolePolicy …`). This enforces the *declared*
  allowlist only; it does not authenticate the actor (see the
  caller-trust section above).
- **Audit-attribution gate (when `requireActor: true`).**
  `Escrow` constructed with `requireActor` rejects any dispatch
  without an `actor` with `actor required: …`, after the
  transition/RBAC/amount-cap checks and before any append — no
  history is appended and no idempotency key is consumed. A listed
  event without an actor reports the RBAC error first (that check
  runs earlier), so this gate only speaks for events the policy
  does not list. The switch is configuration, not audit data: it is
  never written into snapshots and must be re-enabled on restore.
  Like the policy, it does not authenticate the actor — it only
  guarantees the audit trail names one.
- **Settlement-reference gate (when `requireSettlementRef: true`).**
  `Escrow` constructed with `requireSettlementRef` rejects a RELEASE
  without a `settlementRef` with `settlement reference required: …`,
  after the transition/RBAC/amount-cap checks (after the
  `requireActor` gate) and before any append — no history is
  appended and no idempotency key is consumed. Other events are
  unaffected, and the default (gate off) keeps a reference-free
  RELEASE legal. The switch is configuration, not audit data: it is
  never written into snapshots and must be re-enabled on restore.
  Like the evidence gate, it does not verify the external settlement
  — it only guarantees the audit trail names the transfer.
- **Optimistic-concurrency guard (when `expectedSeq` is passed).**
  `dispatch` rejects a caller whose `expectedSeq` no longer equals the
  current history length with `dispatch conflict: …`, before any
  other check and with no side effects (no append, no idempotency
  key consumed, no listener notified) — two writers racing off the
  same snapshot cannot both advance the escrow in-process. It is
  not a distributed lock: separate processes hold separate histories
  and still need store-level compare-and-swap.
- **Strict snapshot validation.** `Escrow.fromJSON` runs
  `parseEscrowSnapshot` on untrusted input: non-empty id, seq from 1 with no
  gaps, continuous from/to chain starting at CREATED, canonical ISO-8601
  non-decreasing timestamps, `amount` only on FUND and PARTIAL_RELEASE
  entries (a `PARTIAL_RELEASE` amount must also be greater than zero and
  no larger than the still-locked balance), string-only
  notes, `actor` (when present) a non-empty string, `rolePolicy`
  (when present) a valid allowlist of known events, and
  `idempotencyKeys` (when present) an array of non-empty
  strings. Anything else throws `invalid snapshot: …`.
- **Delivery fail-fast.** `deliverSettlementWebhook` rejects invalid URLs,
  non-http(s) protocols, and bad retry/timeout options before any request,
  and never retries 3xx/4xx other than 429 (the request itself is at fault);
  only 429/5xx/network errors get retries, with a 429 `Retry-After` hint
  honored over the exponential backoff — the hint is clamped to
  `maxRetryDelayMs` (default 60s), so a runaway value cannot park the
  delivery promise for longer than the cap. **Plaintext transport is
  refused by default:** an `http:` endpoint URL throws before any request
  unless the caller explicitly passes `allowInsecureHttp: true` — the
  signed payload plus the `X-Signature` header are replayable over the
  clear, so plaintext delivery is a real replay threat. Honest limit: the
  refusal only blocks plaintext; it does not validate certificates or
  pin TLS.

## Money precision (known limitation)

All amounts use cents rounding (`round2`: `Math.round(n * 100) / 100` in
`src/settlement.ts` and `src/feeCalculator.ts`). This is **not** big-decimal
arithmetic and has **not** been audited. Invariant tests assert fund
conservation within ±1 cent only (`test/invariants.test.ts`). Do not use
for precision-critical accounting.

## Audit-history integrity (in-process + persisted)

`Escrow.history` returns a detached, frozen snapshot on every call: the
array is `Object.freeze`d and each entry is a frozen copy
(`src/stateMachine.ts`). In-process callers cannot push, splice, or
rewrite entry fields to tamper with the audit log; `dispatch()` remains
the only way to append. (`toJSON()` returns a detached deep copy as
well, so snapshots exported for persistence are detached and safe.)

Persisted snapshots get a second layer: every entry is **hash-chained**
(`prevHash`/`hash`, SHA-256 over the canonical entry serialization, genesis
`prevHash` is `"GENESIS"`). `Escrow.fromJSON()` re-verifies the chain on
chained snapshots and rejects a broken one, so an entry rewritten on disk
(amount/note/evidence/actor changed, an entry deleted or reordered) is detected
on rehydration instead of silently accepted. `verifyHistoryChain()` is
exported for standalone checks (watchdogs, log-shipper validation).

Honest limits: the default chain is **unkeyed** — it is tamper *evidence*,
not a MAC. It catches edits by anyone who rewrites entries without
recomputing the chain (manual edits, log-shipper corruption, partial
restores). It does **not** stop an attacker who rewrites the whole JSON and
recomputes the hashes.

That gap has an opt-in fix: construct the escrow with an `auditKey`
(`new Escrow(id, { auditKey })`, a non-empty string or Buffer) and every
chain link becomes **HMAC-SHA256** over the same canonical input. Rewriting
the JSON then requires the key as well as the data. Verification is
fail-closed across modes: a keyed chain does not verify without the key or
with the wrong one (`verifyHistoryChain(history, key)`,
`Escrow.fromJSON(snapshot, { auditKey })`), and an unkeyed chain does not
verify when a key is supplied. In keyed mode the stored MAC is compared
in constant time (`timingSafeEqual` with a length guard), so an online
verifier leaks no per-byte timing signal; a forged digest of the wrong
shape fails verification instead of throwing. In keyed mode the residual risks move to
the key itself: anyone who obtains the key can rewrite the log and re-MAC
it, so key generation, storage, and distribution are the caller's
responsibility — the library never generates, stores, or transmits keys,
and the key is never written into snapshots (a restored escrow must be
handed the key again, and a legacy hashless snapshot restored with a key
is chained in keyed mode on rehydration). Legacy (hashless) snapshots are
still accepted and deterministically chained on rehydration; a snapshot
that mixes chained and hashless entries is rejected.

Dedupe snapshots get the same treatment as an opt-in layer:
`SettlementEventDedupe.exportSignedSnapshot(secret)` wraps the
unsigned `{ v: 1, entries }` snapshot in an HMAC-SHA256 envelope
`{ v: 1, snapshot, mac }` (same shape and canonical form as the
sibling rfc9421 `ReplayCache` signed snapshot), and
`restoreSignedSnapshot(envelope, secret)` verifies the MAC in
constant time before any snapshot parsing. A rewritten persisted
file — a deleted consumed `eventId`, an injected forged one, a
shifted `seenAtMs` — then fails closed at startup instead of
silently reopening the double-settlement window or discarding a
legitimate settlement as an apparent duplicate. The unsigned
snapshot stays accepted as trusted configuration, and the two
forms never accept each other, so a signed restore cannot
silently downgrade. The MAC is integrity protection only, not
encryption: the eventIds inside are wire-visible values, and the
secret is never written into the envelope — a restored dedupe
must be handed the secret again, like the audit key above, and
key storage and distribution remain the caller's responsibility.

Escrow snapshots get the same treatment at the snapshot level:
`Escrow.exportSignedSnapshot(secret)` wraps the whole
`EscrowSnapshot` in an HMAC-SHA256 envelope `{ v: 1, snapshot, mac }`
(same shape and canonical form as the dedupe envelope), and
`Escrow.restoreSignedSnapshot(envelope, secret, opts?)` verifies
the MAC in constant time before any snapshot parsing. This closes
the gap the hash chain leaves open: the chain covers history
entries only, so without the envelope a rewritten persisted file
could push a deadline back, loosen a `rolePolicy`, clear consumed
idempotency keys, or lift a deposit cap without breaking any
history link — with the envelope, any such rewrite fails closed
at restore. The envelope secret need not equal the escrow's
`auditKey` (they protect different things and are managed
independently); `opts.auditKey` is still handed to `fromJSON` on
restore so a keyed chain re-verifies under its own key. The
unsigned `fromJSON()` path stays accepted as trusted
configuration, and the two forms never accept each other.

Outbox snapshots get the same treatment:
`SettlementWebhookOutbox.exportSignedSnapshot(secret)` wraps the
unsigned `{ v: 1, entries }` snapshot in an HMAC-SHA256 envelope
`{ v: 1, snapshot, mac }` (same shape and canonical form as the
dedupe envelope), and `restoreSignedSnapshot(envelope, secret,
opts)` (alias `fromSignedSnapshot`) verifies the MAC in constant
time before any snapshot parsing. A rewritten persisted file — a
lowered `attempts` count that resurrects a dead letter, an inflated
one that pushes a still-retryable pair into the dead letter, a
forged `lastError`/`lastAt` or `(endpoint, eventId)` key — then
fails closed at startup instead of silently rewriting the failure
ledger. The unsigned snapshot stays accepted as trusted
configuration, and the two forms never accept each other, so a
signed restore cannot silently downgrade. The MAC is integrity
protection only, not encryption: the endpoints and eventIds inside
are wire-visible values, and the secret is never written into the
envelope — a restored outbox must be handed the secret again, like
the audit key above, and key storage and distribution remain the
caller's responsibility.

## Deliberately NOT here (production would need it)

- Real oracle/Chainlink/zk-SNARK/TEE verification behind `VERIFY_PASS`
- Cryptographic multi-sig (this repo *counts* approvals; it does not verify
  signatures)
- Secret management, storage, or distribution for webhook secrets
  (rotation-window *verification* accepts multiple candidate secrets, but
  the library never generates, stores, or schedules the rotation itself)
- A deadline scheduler (`EXPIRE` is dispatched by the caller)
- Identity authentication (this repo's `rolePolicy` is only a
  caller-supplied actor allowlist — see above), concurrency control
  beyond the single-process `expectedSeq` optimistic guard on
  `dispatch` (two processes restoring the same snapshot can still
  race; cross-process writers need store-level compare-and-swap),
  durable storage, a
  shared/distributed idempotency store (this repo's consumed keys
  persist only inside each escrow's own `toJSON()` snapshot)
- Audited money math

## Reporting a security issue

If you find a security problem in this demo, please open an issue on
this repository describing it. Do not include secrets, private keys, or
any credentials in the report.

Even though this is a demo / reproduction library, reports are still
welcome — especially for the areas this file makes security claims
about: webhook signature verification, the audit hash chain (keyed and
unkeyed), and money conservation in settlement and fee math. No
response-time commitment is made; reports are triaged as time permits.

Reference and demo use only.
