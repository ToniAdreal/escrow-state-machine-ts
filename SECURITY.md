# Security policy and trust boundaries

> This is a demo/state-machine library, not a production payment system.
> Every claim below is verifiable against the source in `src/`.

## Scope

`escrow-state-machine-ts` models the rules of an off-chain milestone escrow:
state transitions, fee math, settlement reporting, quorum counting, and
webhook signing. It holds no real money, runs no on-chain code, and its only
cryptography is HMAC: webhook signatures, and the optional keyed audit hash
chain described below.

## Trust model

### Caller-trust decisions (NOT enforced by this library)

- **`quorum.approve()` records caller-trust approvals.** `src/quorum.ts`
  stores signer id strings; there is no signature verification, no key
  management, and no DAO governance. Calling `approve("dao-3")` is only as
  trustworthy as the caller who says "dao-3 approved".
  `src/arbitration.ts` wires the *count* to `dispatchArbitration` (it refuses
  to dispatch below threshold and records `quorum <approvals>/<threshold>`
  in the audit note), but it does not make the approvals cryptographic —
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
  `false`). Future timestamps are not bounded — this is an old-payload
  replay bound, not a full clock-skew policy.
- **Settlement never runs on uncorroborated amounts.**
  `depositAmountFromHistory` (`src/settlementReport.ts`) throws
  `settlement requires a FUND amount` when the audit history has no FUND
  event or any FUND lacks an `amount` — undefined/NaN never silently poisons
  the settlement math. `buildSettlementReport` additionally cross-checks the
  caller-supplied deposit against the audit-history total.
- **Strict snapshot validation.** `Escrow.fromJSON` runs
  `parseEscrowSnapshot` on untrusted input: non-empty id, seq from 1 with no
  gaps, continuous from/to chain starting at CREATED, canonical ISO-8601
  non-decreasing timestamps, `amount` only on FUND entries, string-only
  notes, and `idempotencyKeys` (when present) an array of non-empty
  strings. Anything else throws `invalid snapshot: …`.
- **Delivery fail-fast.** `deliverSettlementWebhook` rejects invalid URLs,
  non-http(s) protocols, and bad retry/timeout options before any request,
  and never retries 3xx/4xx other than 429 (the request itself is at fault);
  only 429/5xx/network errors get retries, with a 429 `Retry-After` hint
  honored over the exponential backoff — the hint is clamped to
  `maxRetryDelayMs` (default 60s), so a runaway value cannot park the
  delivery promise for longer than the cap.

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
(amount/note/evidence changed, an entry deleted or reordered) is detected
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
verify when a key is supplied. In keyed mode the residual risks move to
the key itself: anyone who obtains the key can rewrite the log and re-MAC
it, so key generation, storage, and distribution are the caller's
responsibility — the library never generates, stores, or transmits keys,
and the key is never written into snapshots (a restored escrow must be
handed the key again, and a legacy hashless snapshot restored with a key
is chained in keyed mode on rehydration). Legacy (hashless) snapshots are
still accepted and deterministically chained on rehydration; a snapshot
that mixes chained and hashless entries is rejected.

## Deliberately NOT here (production would need it)

- Real oracle/Chainlink/zk-SNARK/TEE verification behind `VERIFY_PASS`
- Cryptographic multi-sig (this repo *counts* approvals; it does not verify
  signatures)
- Secret management, storage, or distribution for webhook secrets
  (rotation-window *verification* accepts multiple candidate secrets, but
  the library never generates, stores, or schedules the rotation itself)
- A deadline scheduler (`EXPIRE` is dispatched by the caller)
- Identity/RBAC, concurrency control, durable storage, a
  shared/distributed idempotency store (this repo's consumed keys
  persist only inside each escrow's own `toJSON()` snapshot)
- Audited money math

Reference and demo use only.
