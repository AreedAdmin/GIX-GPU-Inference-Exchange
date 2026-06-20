# Job Lifecycle & State Machine

The authoritative, contract-level state machine for a GIX `Job`: every state, every
transition, and the exact fund movement, credit accounting, and slashing at each step.

**Status:** Canonical for the job state machine. Conforms to the names, objects, and
flows in [overview](../architecture/overview.md) and [glossary](../glossary.md); when
the two disagree on decomposition or naming, the overview wins and this document is
corrected to match.

Cross-links: [overview](../architecture/overview.md) ·
[contracts](../architecture/sui-move-contracts.md) ·
[verification](../architecture/verification-attestation.md) ·
[deepbook](../architecture/deepbook-integration.md) ·
[walrus](../architecture/walrus-integration.md) ·
[tokenomics](../tokenomics.md) ·
[threat model](../security/threat-model.md) ·
[node](../architecture/node-architecture.md).

---

## 1. Scope and objects

This document defines the lifecycle of a single `Job` shared object from creation to a
terminal state. It is the contract that `gix::job`, `gix::escrow`,
`gix::attestation`, `gix::settlement`, and `gix::slashing` jointly enforce. Off-chain
software (relayer, settlement watcher, node) may *drive* transitions by submitting
transactions, but **holds no authority**: every state change is gated by an on-chain
guard, and only the contracts move funds or stake.

The four objects that the lifecycle reads and mutates:

| Object | Module | Ownership | Role in the lifecycle |
| --- | --- | --- | --- |
| `Job` | `gix::job` | Shared | Holds `state`, parties, market ref, hashes, deadlines. The atom of parallel settlement. |
| `Escrow` | `gix::escrow` | Held by `Job` | Locked consumer USDC `Balance`; released to provider or refunded to consumer, never both. |
| `ProviderStake` | `gix::staking` | Owned (provider) | Collateral + capacity accounting; the slashable bond (USDC in v1; GIX post-MVP). Reserves capacity per concurrent job. |
| `AttestationRecord` | `gix::attestation` | Child of `Job` | Verified summary of the TEE quote (measurement, hashes, timings); the on-chain audit artifact. |

Supporting shared/governance objects (`Market`, `ModelRecord`, `MeasurementAllowlist`,
`CertRoots`) are read-only on the job path; see [overview §5](../architecture/overview.md).

### 1.1 The canonical states

```
Created → Matched → Escrowed → Dispatched → Executing → Attested → Verified → Settled
```

with terminal failure states **Refunded**, **Slashed**, and **Expired**.

- `Settled` is the sole terminal *success* state.
- `Refunded` is the consumer-protecting terminal state: escrow has been returned in
  full (or net of an explicitly-defined fee, see §8). It may co-occur with `Slashed`.
- `Slashed` is the provider-fault terminal state: stake was reduced and distributed.
  It is reached *together with* `Refunded` (consumer is made whole and the provider is
  penalized) — the contract records both facts on the same `Job`.
- `Expired` is the no-fault terminal state: a deadline elapsed before any party
  committed work or fault, so escrow is refunded and **no stake is touched**.

> **Naming of the joint terminal.** When a provider is at fault, the `Job` ends with
> `state = Refunded` and a `slashed: true` flag set by `gix::slashing`; the
> `Slashed` "state" in the diagram denotes that flag. There is exactly one terminal
> `state` value per `Job`, but a `Refunded` job records whether a slash accompanied it.

---

## 2. Full state machine

```mermaid
stateDiagram-v2
    [*] --> Created

    Created --> Matched: relayer/permissionless binds DeepBook fill
    Created --> Expired: t_match deadline elapsed (no fill bound)

    Matched --> Escrowed: consumer USDC locked + credits reserved
    Matched --> Expired: escrow-funding window elapsed
    Matched --> Refunded: input blob unavailable on Walrus (pre-escrow abort)

    Escrowed --> Dispatched: Dispatched event emitted to provider
    Escrowed --> Refunded: consumer cancels before dispatch
    Escrowed --> Refunded: input unavailable on Walrus at dispatch (no fault)

    Dispatched --> Executing: provider acks dispatch within dispatch-ack deadline
    Dispatched --> Refunded: dispatch-ack deadline missed (provider fault)
    note right of Dispatched
        Missed dispatch-ack ⇒ Refunded + Slashed
        (liveness fault)
    end note

    Executing --> Attested: provider submits attestation within attestation deadline
    Executing --> Refunded: execution/SLA deadline overrun (provider fault)
    Executing --> Refunded: attestation-submission deadline missed (provider fault)
    note right of Executing
        SLA overrun or missing attestation
        ⇒ Refunded + Slashed
    end note

    Attested --> Verified: gix::attestation passes all checks
    Attested --> Refunded: attestation invalid (sig / measurement / hash / SLA)
    note right of Attested
        Invalid attestation ⇒ Refunded + Slashed
        Replay/double-submit ⇒ rejected (no state change)
    end note

    Verified --> Settled: gix::settlement releases escrow to provider (− fee)

    Refunded --> [*]
    Settled --> [*]
    Expired --> [*]

    state Slashed <<choice>>
    Refunded --> Slashed: if provider at fault (informational)
```

`Slashed` is rendered as a branch off `Refunded` to reflect that it is the
provider-fault annotation on a refund, not an independent escrow disposition.

---

## 3. Per-state reference

Each state lists: **entry condition**, **fields set on entry**, **who may act**,
**invariants held while in the state**, and **allowed outgoing transitions**.

### Created
- **Entry:** A `Job` shared object is created from a DeepBook fill candidate (or a
  permissionless order, see §10). `gix::job::new` is called.
- **Fields set:** `job_id` (object id), `market`, `consumer`, `nonce`,
  `model_id` (`ModelRecord` ref), `input_hash`, `input_blob_id` (Walrus), `qty` (SCU),
  `created_at`; `state = Created`; deadlines are computed and stamped (`t_match`,
  later `t_ack`, `t_exec`, `t_att` — see §5). `provider` is **unset**.
- **Who may act:** the relayer (or any caller via the permissionless path) to bind the
  matching DeepBook fill and advance to `Matched`.
- **Invariants:** no `Escrow` exists yet; no funds or credits are committed; no
  `ProviderStake` capacity is reserved. The `Job` is inert and cannot pay anyone.
- **Outgoing:** → `Matched` (fill bound); → `Expired` (`t_match` elapsed).

### Matched
- **Entry:** A specific DeepBook fill (maker = provider's ask, taker = consumer's bid)
  has been bound to the `Job`, fixing `provider`, `price`, and `qty`.
- **Fields set:** `provider` (from the ask's `ProviderStake` owner), `price`,
  `fill_ref` (DeepBook trade id), `state = Matched`.
- **Who may act:** the consumer (or relayer on the consumer's behalf) to fund escrow;
  `gix::escrow::lock`.
- **Invariants:** the bound fill is final and price-time-priority correct (DeepBook
  guarantee); the provider's capacity is *earmarked* but stake is not yet reserved
  against this `Job` until escrow locks (capacity reservation is atomic with escrow,
  §9). No USDC has moved.
- **Outgoing:** → `Escrowed` (escrow locked + credits reserved); → `Expired`
  (funding window elapsed); → `Refunded` (input verified missing on Walrus before any
  escrow — a no-fault abort that returns any in-flight funds).

### Escrowed
- **Entry:** Consumer USDC equal to `price × qty` is moved into the `Job`'s `Escrow`
  balance, and the matched Compute Credits are **reserved** (held, not yet burned).
- **Fields set:** `escrow.amount`, `escrow.locked_at`; credit reservation handle;
  `ProviderStake.reserved_capacity += qty`; `state = Escrowed`.
- **Who may act:** the relayer/settlement watcher (or permissionless caller) to emit
  the `Dispatched` event; `gix::job::dispatch`.
- **Invariants:** escrow holds exactly `price × qty` USDC, owned by no party until a
  terminal state; reserved credits are immovable; `ProviderStake` shows the increased
  reserved capacity bounding the provider's concurrent exposure (§9). **No payout is
  possible from this or any earlier state.**
- **Outgoing:** → `Dispatched`; → `Refunded` (consumer cancels before dispatch, or
  input found unavailable on Walrus at dispatch — both no-fault).

### Dispatched
- **Entry:** A `Dispatched` event carrying `(job_id, model_id, input_blob_id, t_ack,
  t_exec, t_att)` has been emitted. The provider's node is expected to observe it.
- **Fields set:** `dispatched_at`; `t_ack` deadline armed; `state = Dispatched`.
- **Who may act:** the **provider node only** — it acknowledges dispatch (proving
  liveness and that it has begun fetching model+input) via `gix::job::ack`. Anyone may
  call the timeout path once `t_ack` passes.
- **Invariants:** escrow and credit reservation unchanged; stake still reserved.
  Acknowledgement is idempotent (re-acking is a no-op, §7).
- **Outgoing:** → `Executing` (ack within `t_ack`); → `Refunded` + **Slashed**
  (`t_ack` missed — provider liveness fault).

### Executing
- **Entry:** The provider acknowledged dispatch; the node is running inference inside
  the TEE.
- **Fields set:** `ack_at`, `t_exec` and `t_att` deadlines armed; `state = Executing`.
- **Who may act:** the **provider node only** — submits the attestation via
  `gix::attestation::submit`. Anyone may call the timeout path once a deadline passes.
- **Invariants:** escrow/credits/stake unchanged; the node must complete and submit
  before `t_att` (and execution must finish within the SLA window `t_exec`). No partial
  payment exists; work is all-or-nothing for settlement.
- **Outgoing:** → `Attested` (attestation submitted in time); → `Refunded` +
  **Slashed** (`t_exec` SLA overrun, or `t_att` attestation deadline missed — both
  provider fault).

### Attested
- **Entry:** The provider submitted a TEE quote and `output_blob_id`/`output_hash`.
  An `AttestationRecord` child object is created (pending verification).
- **Fields set:** `AttestationRecord{ measurement, model_hash, input_hash,
  output_hash, t_start, t_end, quote_ref }`; `output_blob_id`, `output_hash` on `Job`;
  `attested_at`; `state = Attested`.
- **Who may act:** `gix::attestation` runs verification (callable by anyone; the
  verification logic is deterministic and trustless). A duplicate submission is
  rejected by the exactly-once guard (§7) and causes **no** state change.
- **Invariants:** the submitted quote is recorded but **not yet trusted**; no funds
  have moved; the exactly-once flag for `(job_id, nonce)` is now set so replays cannot
  re-enter this state.
- **Outgoing:** → `Verified` (all checks pass); → `Refunded` + **Slashed**
  (signature chain / measurement allowlist / hash binding / SLA timing check fails).

### Verified
- **Entry:** `gix::attestation` confirmed: vendor cert chain to a pinned `CertRoots`
  root; `measurement ∈ MeasurementAllowlist` for `model_id`; quote hashes equal the
  `Job`'s `model_hash`, `input_hash`, and the submitted `output_hash`; and
  `t_end − t_start` within the market SLA. See [verification](../architecture/verification-attestation.md).
- **Fields set:** `AttestationRecord.verified = true`; `verified_at`;
  `state = Verified`.
- **Who may act:** `gix::settlement::settle` (callable by anyone) to disburse.
- **Invariants:** the result is provably correct under the v1 trust model; escrow is
  now *eligible* for release but still locked until `settle` runs; **payout is
  impossible from any state other than `Verified`** (no payout without `Verified`).
- **Outgoing:** → `Settled` only.

### Settled (terminal, success)
- **Entry:** `gix::settlement` ran: protocol fee split out of escrow, provider paid,
  reserved credits **burned**, provider capacity released.
- **Fields set:** `settled_at`; `fee_paid`; `provider_payout`; `credits_burned = qty`;
  `ProviderStake.reserved_capacity -= qty`; `state = Settled`.
- **Who may act:** none — terminal.
- **Invariants:** `Escrow` balance is zero; `provider_payout + fee_paid =
  escrow.amount` exactly; credits for this `Job` are burned (capacity consumed);
  `ProviderStake` is untouched except for the capacity release. Audit refs
  (`output_blob_id`, `AttestationRecord`) are permanent.
- **Outgoing:** none.

### Refunded (terminal, consumer made whole)
- **Entry:** A no-fault abort or a provider-fault failure routed escrow back to the
  consumer; if provider-fault, accompanied by a slash (see `Slashed`).
- **Fields set:** `refunded_at`; `refund_amount`; `reason` (enum: `Cancelled`,
  `InputUnavailable`, `AckTimeout`, `SlaOverrun`, `AttTimeout`, `InvalidAttestation`);
  `slashed: bool`; `state = Refunded`.
- **Who may act:** none — terminal.
- **Invariants:** `Escrow` balance is zero; the consumer received `refund_amount`;
  reserved credits are **returned/released** (un-reserved, not burned) so the provider
  can re-sell capacity; `ProviderStake.reserved_capacity -= qty`. On provider fault the
  stake was additionally reduced (§8). No provider payout occurred.
- **Outgoing:** none.

### Slashed (terminal annotation, provider fault)
- **Entry:** `gix::slashing` executed against the provider's `ProviderStake` because
  the provider was at fault (missed ack, SLA overrun, missed attestation, invalid
  attestation). Always co-occurs with `Refunded`.
- **Fields set:** on `Job`: `slashed = true`, `slash_amount`, `slash_reason`. On
  `ProviderStake`: `staked -= slash_amount`, capacity de-rated.
- **Who may act:** none — terminal.
- **Invariants:** **no slash without a recorded provider fault** (the timeout/verify
  guard that triggered it is on-chain and reproducible); the slashed amount is
  conserved and distributed (§8); the consumer's refund is independent of and prior to
  any slash distribution.
- **Outgoing:** none.

### Expired (terminal, no fault)
- **Entry:** A pre-commitment deadline (`t_match` in `Created`, or the funding window
  in `Matched`) elapsed before escrow was ever locked, so there is nothing to settle
  and no committed counterparty fault.
- **Fields set:** `expired_at`; `reason`; `state = Expired`.
- **Who may act:** none — terminal.
- **Invariants:** any in-flight funds returned; **no stake touched** (no provider had
  committed); credit earmark released. Distinguished from `Refunded` precisely because
  no `Escrow` was active and/or no provider was bound.
- **Outgoing:** none.

---

## 4. State summary table

| State | Escrow | Credits | Stake reserved | Payout possible? | Terminal |
| --- | --- | --- | --- | --- | --- |
| Created | none | earmarked | no | no | no |
| Matched | none | earmarked | no | no | no |
| Escrowed | locked | reserved | yes | no | no |
| Dispatched | locked | reserved | yes | no | no |
| Executing | locked | reserved | yes | no | no |
| Attested | locked | reserved | yes | no | no |
| Verified | locked | reserved | yes | **yes** | no |
| Settled | released → provider+fee | burned | released | done | yes |
| Refunded | returned → consumer | returned | released | no | yes |
| Slashed | (refund applies) | returned | released + reduced | no | yes |
| Expired | returned (if any) | released | n/a | no | yes |

---

## 5. The three deadlines

All three are **governance parameters** (set per `Market` / SLA class in
`gix::governance`); the defaults below are starting points, not protocol constants.
Each deadline is stamped on the `Job` so that timeout transitions are evaluated purely
on-chain against `Clock`, with no trusted off-chain timer.

| Deadline | Field | Armed in state | Protects | Default (governance) | Timeout transition |
| --- | --- | --- | --- | --- | --- |
| **dispatch-ack** | `t_ack` | Dispatched | **Consumer** (and the market's liveness) — bounds how long a matched provider may sit on a job without starting. | ~30 s after `Dispatched` | Dispatched → Refunded + **Slashed** (`AckTimeout`) |
| **execution / SLA** | `t_exec` | Executing | **Consumer** — bounds end-to-end latency to the market's SLA class; enforced via attestation `t_end − t_start` and wall-clock. | market SLA (e.g. `p99 < 5 s` → `t_exec` ≈ 30 s hard cap) | Executing → Refunded + **Slashed** (`SlaOverrun`) |
| **attestation-submission** | `t_att` | Executing | **Consumer** — bounds how long after dispatch a provider has to deliver a *verifiable* result on-chain, covering Walrus writes + quote generation. | ~2× SLA (e.g. ~60 s after `ack`) | Executing → Refunded + **Slashed** (`AttTimeout`) |

Additional pre-commitment windows (no slash, no provider fault):

| Window | Field | State | Timeout transition |
| --- | --- | --- | --- |
| match window | `t_match` | Created | Created → Expired |
| funding window | `t_fund` | Matched | Matched → Expired |

Notes:
- `t_exec` and `t_att` are both armed at `ack`; `t_exec` is the *latency SLA* (used by
  the SLA check) while `t_att` is the *on-chain submission* deadline. A provider can
  satisfy the SLA on `t_end − t_start` yet still miss `t_att` if it fails to submit;
  that is an `AttTimeout` fault.
- A **grace period** (`t_grace`, governance param, default small/zero) may be added to
  `t_att` to absorb chain congestion; whether grace applies and its size is an open
  question (§13).

---

## 6. Transition table

`Δescrow`, `Δcredits`, `Δstake` describe the fund/credit/stake effects. Every
transition is guarded on-chain; "trigger" names the event/tx and who submits it.

| # | From | Trigger (who) | Guard / precondition | To | Δescrow | Δcredits | Δstake / slash |
| --- | --- | --- | --- | --- | --- | --- | --- |
| H1 | — | `job::new` (relayer / permissionless) | valid DeepBook fill candidate or on-chain order; market exists; model_id valid | Created | — | earmark | — |
| H2 | Created | `job::bind_fill` (relayer / permissionless) | fill maker ask & taker bid match this job; within `t_match` | Matched | — | earmark | capacity earmarked on provider's stake |
| H3 | Matched | `escrow::lock` (consumer / relayer) | consumer USDC ≥ `price×qty`; input blob present on Walrus; within `t_fund` | Escrowed | **+lock** `price×qty` | reserve `qty` | `reserved_capacity += qty`; reverts if over capacity |
| H4 | Escrowed | `job::dispatch` (relayer / permissionless) | escrow locked; provider registered & live | Dispatched | held | held | held |
| H5 | Dispatched | `job::ack` (**provider**) | caller == job.provider; within `t_ack` | Executing | held | held | held |
| H6 | Executing | `attestation::submit` (**provider**) | caller == job.provider; within `t_att`; exactly-once `(job_id,nonce)` unset | Attested | held | held | held; sets exactly-once flag |
| H7 | Attested | `attestation::verify` (anyone) | cert chain → pinned root; measurement allowlisted for model; all hashes bind; `t_end−t_start` ≤ SLA | Verified | held | held | held |
| H8 | Verified | `settlement::settle` (anyone) | `state == Verified` | Settled | **−release**: provider `+= amount−fee`, treasury `+= fee` | **burn** `qty` | `reserved_capacity -= qty` |
| F1 | Created | `job::expire` (anyone) | `now > t_match`; no fill bound | Expired | — | release earmark | — (no provider) |
| F2 | Matched | `job::expire` (anyone) | `now > t_fund`; escrow not locked | Expired | return any in-flight | release earmark | release earmark; **no slash** |
| F3 | Matched/Escrowed | `escrow::abort_input` (anyone) | input blob proven unavailable on Walrus before/at dispatch | Refunded | **−return** to consumer | release reservation | release; **no slash** (no provider fault) |
| F4 | Escrowed | `escrow::cancel` (**consumer**) | caller == job.consumer; `state == Escrowed` (pre-dispatch) | Refunded | **−return** to consumer | release reservation | release; **no slash** |
| F5 | Dispatched | `job::timeout_ack` (anyone) | `now > t_ack`; not acked | Refunded | **−return** to consumer | release reservation | release; **slash** `s_ack` (`AckTimeout`) |
| F6 | Executing | `job::timeout_sla` (anyone) | `now > t_exec`; not attested | Refunded | **−return** to consumer | release reservation | release; **slash** `s_sla` (`SlaOverrun`) |
| F7 | Executing | `job::timeout_att` (anyone) | `now > t_att`; not attested | Refunded | **−return** to consumer | release reservation | release; **slash** `s_att` (`AttTimeout`) |
| F8 | Attested | `attestation::verify` (anyone) | any verify check fails (sig / measurement / hash / SLA) | Refunded | **−return** to consumer | release reservation | release; **slash** `s_invalid` (`InvalidAttestation`) |
| R1 | Dispatched/Executing | `job::ack` / `attestation::submit` (provider) | `(job_id,nonce)` already consumed OR wrong state | (no change) | held | held | held — **replay rejected** |

`s_ack, s_sla, s_att, s_invalid` are governance-set slash magnitudes (§8). The
provider-fault failure transitions (F5–F8) all produce `Refunded` with `slashed = true`.

---

## 7. Idempotency & replay protection

- **Job identity.** Each `Job` carries `(job_id, nonce)`. `job_id` is the Sui object id
  (globally unique); `nonce` is set at creation from the consumer's order + `fill_ref`
  so that re-running the relayer over the same DeepBook fill cannot mint a second `Job`
  for the same fill. Duplicate creation for the same `fill_ref` is rejected by a
  per-fill guard in `gix::job`.
- **Exactly-once attestation.** `attestation::submit` sets a one-shot consumed flag
  keyed by `(job_id, nonce)` *atomically* with creating the `AttestationRecord`. A
  second submission (replay, or a racing duplicate) finds the flag set and aborts with
  no state change (transition R1). Because verification reads the recorded quote, a
  replayed quote cannot be "re-verified" into a second payout.
- **Quote freshness.** The quote binds `t_start ‖ t_end` and the job's `nonce`/`job_id`
  (via the bound hashes), so a quote from a *different* job cannot be replayed onto this
  one — the hash binding check (H7) fails.
- **Safe retries.** `ack` is idempotent (re-acking in `Executing` is a no-op).
  `settle` and the timeout entrypoints are guarded by the terminal-state check: once a
  `Job` is `Settled`/`Refunded`/`Expired`, all further entrypoints abort. This makes
  every off-chain driver safe to retry blindly — at most one transition takes effect.
- **No double-spend of escrow.** Escrow is a single `Balance` owned by the `Job`;
  `settle` and the refund/timeout paths each fully drain it and flip `state` in the
  same transaction, so the funds can be released *xor* refunded, never both, and never
  twice.

---

## 8. Fund & credit accounting per transition

Let `E = price × qty` be the locked escrow, `f` the protocol fee rate (governance,
per fee tier), `S = ProviderStake.staked`.

**Escrow lock (H3).** `E` USDC moves consumer → `Job.Escrow`. From here the funds are
owned by no party; only a terminal transition disposes of them.

**Happy-path release (H8, Verified → Settled).**
- Fee: `fee = f × E` → protocol **treasury**.
- Provider payout: `E − fee` → provider.
- Credits: the reserved `qty` credits are **burned** (capacity is now consumed).
- Stake: untouched; `reserved_capacity -= qty` (capacity freed for the next job).
- Conservation: `provider_payout + fee = E`.

**No-fault refunds (F2 Expired, F3 InputUnavailable, F4 Cancel).**
- Escrow: full `E` returned to consumer (v1 default; a small cancellation fee on F4 is
  an open policy question, §13).
- Credits: reservation **released** (un-reserved, *not* burned) — capacity returns to
  the provider to re-sell.
- Stake: untouched, `reserved_capacity -= qty`. **No slash.**

**Provider-fault refunds + slash (F5 Ack, F6 SLA, F7 Att, F8 Invalid).**
- Escrow: full `E` returned to consumer **first and unconditionally** — the consumer's
  refund never depends on the slash succeeding.
- Credits: reservation released (un-reserved).
- Stake: `gix::slashing` reduces `staked` by the governance magnitude for the fault
  (`s_ack ≤ s_sla ≤ s_att ≤ s_invalid` is the expected ordering — invalid/bad-faith
  attestation is the most severe; exact values are governance params).
- **Slash distribution (governance policy):** the slashed amount is split between a
  **consumer compensation** portion (paid on top of the refund, to cover the
  consumer's wasted time/opportunity) and the protocol **treasury** (insurance/burn).
  The exact split and whether GIX is converted to USDC for the consumer is an open
  question (§13).
- `reserved_capacity -= qty`; persistent faults additionally de-rate the provider's
  capacity (lower future `max_capacity`), reducing how much they can mint.

**Compute Credit invariant.** Credits are *reserved* at escrow, and at a terminal state
are either **burned** (success — capacity consumed) or **returned** (any failure —
capacity preserved). They are never both, and a credit is never burned without a
matching `Settled` job. This keeps minted-credit supply tied to real performed work.

---

## 9. Concurrency & capacity

- **Many concurrent jobs per provider.** A provider serves many `Job`s simultaneously;
  because each `Job` is a disjoint shared object, Sui executes their transactions in
  parallel ([overview §5](../architecture/overview.md)). Two jobs for the same provider
  contend only on the shared `ProviderStake` capacity counter, briefly, at escrow-lock
  and at terminal release.
- **Stake bounds concurrent exposure.** `ProviderStake` tracks
  `max_capacity` (a function of the posted bond — USDC in v1, GIX post-MVP) and
  `reserved_capacity`. Escrow-lock (H3)
  asserts `reserved_capacity + qty ≤ max_capacity` and reverts otherwise. Thus a
  provider can never have more *in-flight, slashable* work than its bond can cover —
  the stake is the cap on simultaneous obligations, which bounds the maximum slash the
  protocol can owe consumers at any instant.
- **Reservation lifecycle.** Capacity is reserved at `Escrowed` (H3) and released at
  *every* terminal state (Settled H8, Refunded F3–F8, Expired F2). Reservation is
  never leaked because the terminal transition that releases it is the same one that
  drains escrow.
- **Credit vs capacity.** Minted credits are the *tradable* representation of capacity;
  `reserved_capacity` is the *committed* portion. A provider cannot oversell: minting
  is gated by `max_capacity` in `gix::credit`/`gix::staking`, and reservation is gated
  again at escrow-lock.

---

## 10. Job creation paths & gas

Two paths create a `Job`; both produce identical on-chain state (the contract does not
trust the creator).

1. **Relayer-driven (default).** The relayer/indexer observes a DeepBook fill and
   submits `job::new` + `bind_fill`. The relayer pays gas for creation; this is the
   low-latency happy path. The relayer holds **no authority** — it cannot alter
   parties, hashes, or deadlines beyond what the fill and market dictate.
2. **Permissionless on-chain fallback (liveness).** If the relayer is offline, the
   **consumer** (whose order filled) may call `job::new` + `bind_fill` directly,
   referencing the same DeepBook fill, paying gas themselves. This guarantees liveness:
   no off-chain party can censor job creation. The per-`fill_ref` guard (§7) prevents
   the relayer and the consumer from both creating a job for the same fill.

**Who pays gas, per step:**

| Step | Default payer | Fallback payer |
| --- | --- | --- |
| Upload input to Walrus | Consumer | — |
| `job::new` + `bind_fill` | Relayer | Consumer (permissionless) |
| `escrow::lock` | Consumer | Consumer |
| `job::dispatch` | Relayer | Consumer or provider (permissionless) |
| `job::ack` | **Provider** | — |
| `attestation::submit` | **Provider** | — |
| `attestation::verify` | Relayer / anyone | Consumer (to claim refund faster) |
| `settlement::settle` | Provider / anyone | Provider (to claim payout) |
| Timeout entrypoints (F5–F7) | Settlement watcher / anyone | Consumer (to claim refund) |

Because the timeout and verify/settle entrypoints are **callable by anyone**, the party
who benefits (consumer wanting a refund, provider wanting payout) can always self-serve
the transition even if every service is down — the core liveness guarantee.

---

## 11. Failure paths in detail

1. **No dispatch-ack.** Provider never acks before `t_ack`. Anyone calls
   `timeout_ack` (F5) → `Refunded` + **Slashed** (`AckTimeout`, magnitude `s_ack`).
   Consumer fully refunded; capacity released.
2. **Execution overruns SLA.** `t_exec` passes with no attestation → `timeout_sla` (F6)
   → `Refunded` + **Slashed** (`SlaOverrun`). Even if a late attestation later arrives,
   the terminal-state guard rejects it (R1).
3. **Missing attestation by deadline.** Provider acked and may even have produced
   output, but did not submit on-chain by `t_att` → `timeout_att` (F7) → `Refunded` +
   **Slashed** (`AttTimeout`).
4. **Invalid attestation.** Submitted in time but fails a verify check — bad vendor
   signature, measurement not allowlisted for the model, hash mismatch
   (`model/input/output`), or `t_end − t_start` over SLA → verify (F8) → `Refunded` +
   **Slashed** (`InvalidAttestation`, the most severe magnitude).
5. **Input unavailable on Walrus at dispatch.** If the input blob cannot be retrieved
   when the provider attempts to fetch (or a pre-dispatch availability check fails),
   the failure is the consumer's, not the provider's → `abort_input` (F3) → `Refunded`,
   **no slash**. Reservation released so the provider loses nothing.
6. **Consumer cancels before dispatch.** While `Escrowed` and pre-dispatch, the
   consumer calls `escrow::cancel` (F4) → `Refunded`, **no slash**. After dispatch,
   cancellation is not allowed (the provider may already be working); the consumer must
   instead rely on the SLA/attestation deadlines.
7. **Provider offline.** Manifests as one of the liveness timeouts: missed ack (F5) if
   offline at dispatch, or missed SLA/attestation (F6/F7) if it dies mid-job. All route
   to `Refunded` + **Slashed**. The provider's `ProviderStake` is the consumer's
   protection against an offline provider.
8. **Partial fill from DeepBook.** A DeepBook order may fill in multiple trades against
   multiple asks. Each distinct fill (`fill_ref`) binds to **its own `Job`** with its
   own `qty`, escrow, provider, and lifecycle — there is no partially-settled `Job`.
   A consumer order that fills across three asks yields three independent `Job`s, each
   running the full state machine. Unfilled remainder rests on the book (or is
   cancelled) per DeepBook semantics — see [deepbook](../architecture/deepbook-integration.md).
9. **Double-submit / replay.** A second `ack`, `submit`, or `settle` is rejected by the
   exactly-once / terminal-state guards (§7, R1) with no state change and no second
   fund movement.

---

## 12. Edge cases & invariants summary

- **No double-spend of escrow.** Escrow is drained exactly once, in the same
  transaction that flips the `Job` to a terminal state; release and refund are mutually
  exclusive (§7).
- **No payout without `Verified`.** `settlement::settle` asserts `state == Verified`.
  No earlier state — and no failure state — can pay the provider.
- **No slash without provider fault.** Every slash is triggered by an on-chain,
  reproducible guard (a missed deadline measured against `Clock`, or a failed
  deterministic verify). No-fault terminals (`Expired`, `Cancelled`, `InputUnavailable`)
  never touch stake.
- **Consumer is always made whole on failure.** Every non-`Settled` terminal returns
  the full escrow to the consumer; provider-fault terminals add (governance) slash-based
  compensation on top.
- **Capacity is conserved.** `reserved_capacity` is incremented exactly at `Escrowed`
  and decremented exactly once at the terminal state; it can never exceed `max_capacity`
  (gated at H3) and can never leak.
- **Credits track real work.** A credit is burned **iff** its `Job` reaches `Settled`;
  otherwise it is returned. Minted-but-unsettled credits remain claims on capacity.
- **Single terminal.** Exactly one of `Settled` / `Refunded` / `Expired` is the `Job`'s
  final `state`; `Slashed` is the provider-fault flag on a `Refunded` job.
- **Off-chain has no authority.** Relayer/watcher/node can only *propose* transitions;
  every effect is gated by an on-chain guard. See [threat model](../security/threat-model.md).

---

## 13. Open questions

> **Migrated to the central ledger** —
> **[open-ended-questions.md](../open-ended-questions.md)**. From this doc:
> - **C1** exact deadline values · **C2** grace periods · **C3** master durations
>   consistency (dispute/retention/unbonding)
> - **B4** slash magnitudes & ordering · **B5** capacity de-rating curve
> - **D1** slash distribution / compensation split · **D3** cancellation fee ·
>   **D4** input-availability check ownership
> - **E4** multi-fill consumer UX
>
> Answer them there; answers are propagated back into this state machine.
