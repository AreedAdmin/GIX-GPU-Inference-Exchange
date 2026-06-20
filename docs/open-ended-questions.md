# Open-Ended Questions

**The single ledger of decisions that need _your_ (Shehab's) input.** Claude adds to this
file whenever a question that requires a human/product/economic decision surfaces during
the build; you answer inline. Questions that can be resolved from the Sui/DeepBook/Walrus/
Seal/Nautilus docs are answered directly in the relevant doc and are **not** parked here —
this file is only for things that genuinely need you.

> **Status:** This is a working file, not part of the canonical engineering plan. When a
> question is answered, fill in its `**Decision:**` line; once a decision is reflected in
> the affected docs, mark it `✅ answered → propagated`.

## How to use
- Each question has a stable **ID** (e.g. `A1`), the question, why it matters / what it
  blocks, considerations, the **source doc(s)** it was migrated from, and a `**Decision:**`
  line for you to fill in.
- Type your answer after `**Decision:**`. Add free-form notes freely.
- When you've answered some, tell Claude and they'll write the answers into the affected
  docs and keep cross-referenced spots consistent.
- IDs are referenced from each doc's "Open questions" section (which now points here).

## Legend
- 🟥 **blocking** — gates implementation or another decision; answer early (Phase 0–2).
- 🟧 **shaping** — materially changes design but not strictly blocking yet.
- 🟦 **tuning/research** — needs data, a spike, or later calibration.

## Already-decided (for reference, not open)
- **What GIX sells — verified model inference, not raw GPU time (2026-06):** the traded
  good is the **verified output of a registered model**, priced in **SCUs = units of
  verified useful output** (per-market: *N* tokens for LLMs, a bounded request/item
  otherwise). The **GPU class is a market *qualifier***, not the product or the pricing
  unit; **raw GPU-time is ruled out** (not cryptographically verifiable; implies arbitrary
  consumer code). A pure GPU-rental product would be a separate later line with weaker,
  non-cryptographic guarantees. This is a wording/clarity lock-in of the existing design
  (Market = (GPU class, model/runtime tier, SLA); per-market SCU) and **tightens/resolves
  E1**. Propagated to overview §1/§3/§3.1, glossary, tokenomics §1/§4, deepbook §1/§3.1.
- **Market structure — spot exchange for a perishable commodity (2026-06):** GIX is a
  **spot exchange** (electricity-market analogy: capacity can't be hoarded) with **three
  roles** — consumers (demand), providers (supply), and **market makers** (trade credits
  for the spread, owning no GPU and consuming nothing — the reason GIX uses DeepBook).
  Price discovery + MM liquidity + hedging are in scope; long-horizon speculation/hoarding
  is bounded by perishability + credit expiry (consistent with A4 long-expiry).
  **Sequencing:** M2 ships a live DeepBook order book + per-inference purchasing with
  **single-use credits** (filling provider = obligated server; assigned-from-fill,
  single-provider demo). A **full free-resale secondary market** — *fungible bearer
  credits* redeemable against any staked provider, with a dispatch + clearing layer — is a
  deliberate later milestone (the **"tradeable-credits upgrade"**, roadmap Phase 8).
  Propagated to overview §3.1, glossary, tokenomics §1/§4, deepbook §1/§10, roadmap Phase 8.
- **GIX token deferred to post-MVP (2026-06):** v1 ships **without** the native token —
  provider bonds are denominated in **USDC** (`ProviderStake` = `Balance<USDC>`), governance
  is an **`AdminCap`/multisig**, fees are taken in USDC, and there are **no emissions /
  token incentives** in v1. GIX (GIX-denominated staking, token-weighted governance,
  emissions-funded bootstrap) returns as an **additive upgrade** later. This dissolves **B1**
  for v1 and de-fangs **T-ECON-4/T-ECON-6**; it also moots the GIX-payout question in **D1**
  (v1 compensation is USDC). Propagated to overview §1/§4/§5, glossary, tokenomics (banner,
  §1, §3, §8), threat-model §13/§14, sui-move-contracts, roadmap.
- **Verification hardware (2026-06):** v1 CPU TEE = **Intel TDX (P-256) only** (Sui has no
  native P-384); **AMD SEV-SNP deferred**; **on-chain NVIDIA GPU-CC/NRAS verification
  phased to a post-MVP fast-follow**. (verification-attestation.md §4, §9)
- **On-chain verification model:** Nautilus register-once + native-signature-per-job.
- **Upgrade policy:** publish **Compatible**, `UpgradeCap` under governance; policies only
  tighten. (sui-move-contracts.md §11)
- **Fill→Job atomicity:** single PTB (swap interface / in-PTB withdraw); relayer is
  liveness-only. (deepbook-integration.md §6, §12)
- **Confidential-markets substrate:** Seal (enclave-gated `seal_approve` + envelope
  encryption), shippable as an additive upgrade.
- **Content hash:** off-chain BLAKE3/SHA-256 compared on-chain; native hash
  (`sha2_256`/`blake2b256`) for any on-chain re-hash.

---

## Batch decision — adopt recommended defaults (2026-06)

> Shehab: *"for all of these open-ended questions we will go with your recommendation."*
> This table is **authoritative** and resolves every item still marked `_(pending — Shehab)_`
> in sections A–L. Individual `**Decision:**` lines are flipped to `✅ answered → propagated`
> as each is carried into the affected docs/code. Guiding constraint: **ship a functional
> market-exchange MVP, streamable with synthetic test data, built phase by phase** — so every
> default favors the simplest correct v1 and defers optimizations/tuning to post-MVP or to
> data-driven calibration in Phase 5–6.

| ID | Adopted default |
| --- | --- |
| B2 | **Siloed per-market stake** for v1 (isolates slashing risk, simplest accounting); shared-stake capital efficiency is post-MVP. |
| B3 | **Nominal treasury-funded USDC backstop** + guarded per-market exposure caps; not solvent vs full tail correlation at MVP (stated residual). Size with real volume data in Phase 5–6. |
| B4 | Scale fraud/SLA with the job's bond share; small flat liveness penalty. **Invalid attestation = 100% of bond share + flat penalty; missing = 100% of bond share; SLA breach = graded 10–50%; liveness = ~2–5% + escalating reputation.** Magnitudes ratified in Phase 6. |
| B5 | **Linear de-rating**: each fault −10% `max_capacity`; cure path restores after N clean settlements / cooldown. |
| B6 | **Conservative minting**: never mint beyond `physical_capacity_remaining`; small near-term demand buffer only. |
| C1 | **Per-SLA-class deadlines**, provisional until Phase-4 benchmarking. Interactive class: `t_ack≈5s`, `t_exec≈SLA p99+10s`, `t_att≈30s` (slack var), `t_fund` in-PTB. |
| C2 | **Congestion grace on `t_att` only** (≈+50% under detected chain congestion); none on `t_ack`/`t_exec`. |
| C3 | Order **retention ≥ unbonding ≥ (max in-flight + dispute)**. Dispute ≈7d, unbonding ≈14d, Walrus retention ≈30d. **Auto-couple** unbonding to computed longest in-flight exposure + dispute window. |
| C4 | **On-chain `Clock` authoritative** for `t_start`/`t_end`, cross-checked vs the TEE quote timestamp; tolerate a few seconds skew before flagging; min safe SLA p99 set conservatively to vendor trusted-time granularity. |
| D1 | **Compensate harmed consumer up to 100% of job value first → remainder to treasury → burn = 0 in v1** (USDC isn't meaningfully burnable; burn returns with GIX). |
| D2 | Lock-and-abandon consumer **forfeits ~10% of escrow** to the provider; remainder refunded. |
| D3 | `escrow::cancel` **free before match**, small fee after; post-dispatch the D2 forfeit applies. |
| D4 | Assert input availability **at dispatch via Walrus `BlobCertified` PoA**; unavailable ⇒ **no-fault `InputUnavailable`** (no provider slash), consumer refunded. |
| E1 | **Token-based SCU for LLM markets** (1 SCU = N output tokens at the tier, bounded max input/context); attestation binds the **output token count** alongside `output_hash`. Request-based only for fixed-shape/non-LLM markets. SCU stays a per-`Market` param. |
| E2 | **Few coarse markets** at MVP (consolidate SLA tiers); governance avoids fine-grained proliferation. |
| E3 | **No maker bonds** at MVP; revisit if spoofing is observed in thin pools. |
| E4 | **SDK aggregates** partial-fill `Job`s into one logical result (basic at MVP). |
| F1 | **Single root + revocation** (v1 is Intel TDX P-256 only); multi-root quorum is post-MVP for high-value markets. |
| F2 | **Governance-set TCB recency floor** at the current vendor baseline; raises carry a grace window for in-flight providers. |
| F3 | **Fast multisig `CertRoots` rotation** (24–48h target); **no retroactive invalidation** of already-settled jobs at MVP. |
| F4 | Defer (zk path is post-MVP); v1 binds the **actual** `output_hash` a measured runtime produced. |
| G1 | N/A in v1 (confidential markets ship later with Seal); reduced-but-cryptographic audit accepted **when** that upgrade lands. |
| H1 | **Provider-funded storage folded into the protocol fee**; treasury sponsors retention (shared blobs) for the audit window. |
| H3 | **Single blob per artifact** (≤13.3 GiB) default; Quilt for high-volume small I/O post-MVP. |
| I1 | **Bind the actual output** a measured runtime produced — no promise of bit-identical output across driver versions. |
| I2 | **Single-GPU-per-node** at MVP; multi-GPU/multi-tenant scheduling post-MVP. |
| I3 | Reproducible build down to runtime+model layers; **pin vendor firmware/driver versions** in the allowlist; pinned vendor blobs accepted. |
| I4 | **Cache verified models in local protected storage; re-check hash on load**; full re-verify after host compromise. |
| J1 | **`AdminCap`/multisig governance** at MVP (token governance deferred with GIX); decentralization schedule is post-MVP. |
| K1 | **No vendor-outage special-casing at MVP** — missing attestation = liveness fault (graded, not fraud); provider bears liveness risk under guarded caps. Vendor-health signal post-MVP. |
| K2 | **Team-run relayer + treasury-sponsored transactions** at MVP; permissionless-relay bounty post-MVP. |
| K3 | **Walrus-published, multisig-signed manifest** at MVP; on-chain canonical-manifest registry post-MVP. |
| K4 | Enforce mock-attestation isolation at **three layers**: `#[test_only]` (absent from prod bytecode) + governance assert (no mock measurement on a non-localnet allowlist) + deploy-checklist gate. |
| K5 | **Single region / no per-region SLA classes** at MVP. |
| K6 | **No indexer snapshots** at MVP (full event replay suffices at this scale). |
| K7 | **Team-hosted reference indexer + raw-RPC / DeepBook-public-indexer fallback**; hosted path holds no authority. |
| K9 | **Pin the newest stable Sui TS SDK** (gRPC client + `deepbook()/walrus()/seal()` extensions); fix the exact version in Phase 4. |
| L1 | **Reserve-then-burn** (reserve into `Job` at creation, burn at `Settled`, release on no-fault refund). |
| L2 | **Single authority** in `governance::MeasurementAllowlist` + optional read-cache mirror on `ModelRecord`. |
| L3 | **Single `ProviderStake` + PTB-batched** stake-touching ops at MVP; shard only if equivocation/concurrency demands it later. |
| L4 | Define a **version-stable TDX-only quote byte layout** now; extend for the GPU-CC composite post-MVP. |

Also confirmed: **A3** 70/30 staker/treasury is a *post-MVP* number (**v1 fees → 100% treasury**, no stakers yet); **v1 provider bootstrapping** relies on the spare-compute thesis (no token emissions), with optional treasury-funded **USDC** incentives held in reserve.

---

## A. Token economics & incentives

### A1 🟥 Will fee revenue ever cover the security budget?
The §3.3 exit condition (emissions → 0, security funded by fees) depends on
volume × fee-bps reaching target security spend. What volume/bps makes the crossover, and
if it never crosses, is permanent emission-subsidy (dilution) acceptable?
*Source: tokenomics.md §13.*
**Decision:** yes fee revenue will cover the security budget, for v1 we would not need to worry. out of curisoty share what the costs of security would be based on

### A2 🟥 Subsidy taper vs organic demand (cold-start crossover)
How fast can emissions taper before utilization is self-sustaining? Too fast → collapse;
too slow → over-dilution. Highest-stakes economic unknown.
*Source: tokenomics.md §13.*
**Decision:** we will use the proof of concept of this build which is v1 to raise moeny for the porject additionally the idea is that providers initially are providing spare compute and thus i wouldnt expect the need to provide huge subsidies for gpu providers to join.

### A3 🟧 Staker fee share vs treasury share
Split of protocol fees between stakers (token value-accrual/security demand) and treasury
(public goods/insurance). The current **60/40** is a placeholder guess.
*Source: tokenomics.md §13.*
**Decision:** this can be 70/30

### A4 🟧 Credit expiry window (per market)
Short expiry keeps capacity accounting honest but fragments liquidity / raises provider
inventory churn; long expiry eases trading but risks stale over-commitment.
*Source: tokenomics.md §13.*
**Decision:** this shouldnt be a concern for the time being we will let it be long expiry

---

## B. Collateral, staking & slashing economics

### B1 🟥 Collateralization ratio `k` + price oracle
A fixed `k` is fragile to GIX/USDC price crashes (stake-value attack). Dynamic
(vol-adjusted) `k`? Which GIX/USDC oracle is trustworthy enough to gate minting **without**
adding settlement-path oracle risk?
*Source: tokenomics.md §13 + threat-model.md §16 (collateral-ratio governance).*
**Decision:** ✅ answered → propagated (2026-06). **Dissolved for v1 by deferring the GIX
token** (see "Already-decided"). v1 bonds in **USDC**, the same asset as escrow, so there
is no bond-vs-obligation valuation mismatch: `k` is a plain USDC-vs-USDC over-collateral
multiple (illustrative 1.5×–3×), **no price oracle is needed**, and no settlement-path
oracle risk is introduced. The dynamic-`k` + GIX/USDC-oracle question **re-arms when GIX is
introduced post-MVP** (it becomes a prerequisite of the token launch, not of v1). Propagated
to tokenomics.md (scope banner + §8.1) and threat-model.md (T-ECON-4/6).

### B2 🟧 Cross-market capital efficiency: siloed vs shared stake
Sharing one stake across a provider's markets improves capital efficiency but correlates
slashing risk across markets.
*Source: tokenomics.md §13.*
**Decision:** _(pending — Shehab)_

### B3 🟧 Insurance backstop sizing
When one offender's stake can't compensate all harmed consumers (correlated failure), how
large must the treasury backstop be, and is it solvent under tail scenarios?
*Source: tokenomics.md §13.*
**Decision:** _(pending — Shehab)_

### B4 🟥 Slashing severity calibration & magnitudes/ordering
Final values for `s_ack`, `s_sla`, `s_att`, `s_invalid`; whether they scale with escrow,
qty, or are flat; and the fraud-vs-liveness boundary (too harsh deters honest providers;
too soft fails the cost-of-attack bound).
*Source: tokenomics.md §13 + task-lifecycle.md §13.*
**Decision:** im not sure for this , i would need guidance and recommendation here

### B5 🟦 Capacity de-rating curve after faults
How repeated faults reduce a provider's `max_capacity`, and the recovery/cure path back to
full capacity.
*Source: task-lifecycle.md §13.*
**Decision:** _(pending — Shehab)_

### B6 🟦 Credit minting aggressiveness vs realized capacity
How far ahead of demand the Node mints credits without risking over-commitment that forces
cancellations or near-deadline declines.
*Source: node-architecture.md §13.*
**Decision:** _(pending — Shehab)_

---

## C. Timing & deadlines (these must be mutually consistent — decide together)

### C1 🟥 Exact lifecycle deadline values
Concrete defaults for `t_ack`, `t_exec`, `t_att`, `t_match`, `t_fund` per SLA class
(currently placeholders pending benchmarking).
*Source: task-lifecycle.md §13.*
**Decision:** im not sure yet,here add a typical benchmark till pahase 4, we can do per SLA class as you metnioned

### C2 🟧 Grace periods
Whether `t_att` carries a congestion grace window, its size, and whether grace ever applies
to `t_ack`/`t_exec`.
*Source: task-lifecycle.md §13.*
**Decision:** _(pending — Shehab)_

### C3 🟥 Master durations consistency: dispute/appeal window vs Walrus retention vs unbonding vs SLA tail
One coupled decision: the slashing-appeal/dispute window, Walrus audit-retention window,
and stake unbonding period must be set so **evidence always outlives disputes** and **stake
stays slashable** across the longest in-flight SLA + attestation deadline. Should unbonding
auto-couple to the longest possible in-flight exposure?
*Source: threat-model.md §16 + walrus-integration.md (retention) + operations/deployment.md (unbonding vs SLA tail).*
**Decision:** _(pending — Shehab)_

### C4 🟧 Trusted-time: source, skew tolerance, min safe SLA p99
Which clock is authoritative for `t_start`/`t_end` (TEE secure clock vs vendor quote stamp
vs on-chain `Clock`); how much TEE-vs-`Clock` skew to tolerate before flagging time-source
manipulation (without false-positiving on drift); and the minimum SLA p99 enforceable given
vendor trusted-time granularity.
*Source: node-architecture.md §13 + threat-model.md §16 + verification-attestation.md (clock skew).*
**Decision:** _(pending — Shehab)_

---

## D. Compensation & fault policy

### D1 🟥 Slash distribution (consumer compensation vs treasury) + payout asset
What fraction of a slash goes to the harmed consumer vs treasury (vs burn); whether consumer
compensation is paid in GIX or converted to USDC; and how it interacts with the insurance
backstop (B3).
*Source: task-lifecycle.md §13 + threat-model.md §16.*
**Decision:** _Payout-asset sub-question resolved by the GIX deferral:_ since v1 bonds are
**USDC**, a slash pays the harmed consumer directly in **USDC** — no GIX→USDC conversion,
no burn-vs-redistribute asset mismatch. The **fraction split** (consumer vs treasury vs
burn) is still open and couples to B3. _(split — pending Shehab)_

### D2 🟧 Consumer-fault forfeit (lock-and-abandon griefing)
How much escrow a consumer who locks-and-abandons forfeits to the provider — enough to deter
griefing without enabling provider-side abuse of the consumer-fault path.
*Source: threat-model.md §16.*
**Decision:** _(pending — Shehab)_

### D3 🟧 Cancellation fee
Whether `escrow::cancel` charges a small fee to deter griefing, or refunds escrow in full
(current default). Related to D2.
*Source: task-lifecycle.md §13.*
**Decision:** _(pending — Shehab)_

### D4 🟧 Input-availability check ownership & no-fault classification
Whether input availability is asserted at dispatch by an on-chain Walrus proof
(`BlobCertified`), by the provider's first fetch, or both — and how that interacts with the
no-fault `InputUnavailable` classification (no provider slash).
*Source: task-lifecycle.md §13. (Mechanism available: Walrus PoA — walrus-integration.md §6.)*
**Decision:** _(pending — Shehab)_

---

## E. Market structure & matching

### E1 🟥 Per-market SCU definition & metering
What 1 Compute Credit (1 SCU) buys per market (a bounded request vs N output tokens at the
tier) and exactly how realized output is metered into SCUs.
*Source: roadmap.md consolidated list (overview §3 / glossary).*
**Decision:** ✅ answered → propagated (2026-06). **GIX sells verified model *output*, not
raw GPU time**, so **1 SCU = one unit of verified useful output**, defined **per `Market`**:
LLM markets → 1 SCU = *N* output tokens at the tier (bounded input/context), with the
attestation binding the **output token count** alongside `output_hash`; non-LLM /
fixed-shape markets → a bounded request/item (e.g. one image). The **GPU class is a market
*qualifier*** (fixes the serving hardware tier → speed/SLA/price), **not** the unit sold or
priced. **Raw GPU-time is explicitly ruled out** as the unit — it is not cryptographically
verifiable (throttling/sharing/contention) and implies running arbitrary consumer code,
outside v1's integrity-only, known-model scope; any pure GPU-rental product would be a
**separate later line with weaker (non-cryptographic) guarantees**. Propagated to overview
(§1 callout + §3/§3.1), glossary (Compute Credit / SCU / Market / GPU class), tokenomics
(§1, §4), deepbook-integration (§1, §3.1).

### E2 🟧 Market granularity / dimension consolidation
DeepBook research recommends consolidating market dimensions (e.g. collapse fine SLA tiers)
to concentrate liquidity and amortize the per-pool 500-DEEP + cron overhead. Confirm the
governance policy on how finely markets may be defined.
*Source: deepbook-integration.md §8.3, §12 Q5.*
**Decision:** _(pending — Shehab)_

### E3 🟦 Maker bonds for spoofing in thin markets
Whether to require maker bonds / post-only economics to blunt spoofing/layering, and at what
liquidity threshold they switch on.
*Source: threat-model.md §16.*
**Decision:** _(pending — Shehab)_

### E4 🟦 Multi-fill consumer UX
Whether the SDK aggregates the independent `Job`s from a partially-filled order into one
logical result for the consumer.
*Source: task-lifecycle.md §13 + sdk.md.*
**Decision:** _(pending — Shehab)_

---

## F. Verification & attestation policy

### F1 🟧 Multi-root quorum for high-value markets
Should high-value markets *require* attestation under two independent vendor roots (defends
vendor-key compromise) at the cost/latency, or is single-root-plus-revocation enough?
*Source: threat-model.md §16 + verification-attestation.md §13.*
**Decision:** _(pending — Shehab)_

### F2 🟧 TCB-freshness floor & escalation policy
Where to set the firmware/TCB recency floor, and how aggressively governance raises it after
a vendor advisory — too aggressive strands honest providers mid-job.
*Source: verification-attestation.md (Open questions).*
**Decision:** _(pending — Shehab)_

### F3 🟧 Cert-root revocation latency + retroactive challengeability
Target time-to-rotate `CertRoots` after a vendor key event, and whether in-flight jobs
settled under a now-revoked root are retroactively challengeable.
*Source: verification-attestation.md (Open questions).*
**Decision:** _(pending — Shehab)_

### F4 🟦 Output reproducibility for a future zk path
Which runtimes can be made deterministic enough (output-hash-stable) that a future zk backend
could attest the *same* `output_hash` the TEE path commits to. (Research; ties to I1.)
*Source: verification-attestation.md (Open questions).*
**Decision:** _(pending — Shehab)_

---

## G. Confidentiality & audit posture

### G1 🟧 Confidential-markets audit posture
With Seal, Walrus blobs become opaque ciphertext: the public audit can verify *integrity*
(blob ids, attestation, on-chain `seal_approve` policy + version) but cannot *read*
inputs/outputs. Is that reduced-but-cryptographic audit acceptable for confidential markets,
and is any auditor-access escrow offered?
*Source: threat-model.md §16 + walrus-integration.md (Still open).*
**Decision:** _(pending — Shehab)_

---

## H. Storage policy

### H1 🟧 Storage cost-bearer policy
Mechanism is settled (shared blobs let the treasury sponsor retention). The *policy*: who
funds each artifact class, and whether output/quote storage folds into the GIX protocol fee
(provider-funded but protocol-guaranteed).
*Source: walrus-integration.md (Still open) + tokenomics.md.*
**Decision:** _(pending — Shehab)_

### H3 🟦 Sharding strategy & Quilt
Single blob vs manifest+shards as default, optimal shard size / fetch-parallelism for
frontier weights (note: single Walrus blob caps ~13.3 GiB), and whether to use **Quilt** for
high-volume small per-job I/O (Quilt members aren't content-addressed → still bind own hash).
*Source: walrus-integration.md (Still open).*
**Decision:** _(pending — Shehab)_

---

## I. Node / hardware / determinism (team + research)

### I1 🟧 Runtime determinism across driver versions
Can we guarantee bit-identical `output_hash` across GPU driver / CUDA / kernel versions, or
does the protocol only ever bind the *actual* output a given measured runtime produced?
*Source: node-architecture.md §13.*
**Decision:** _(pending — Shehab)_

### I2 🟦 Multi-GPU / multi-tenant scheduling
How one Node schedules across several GPUs (and confidential domains) while keeping per-Job
attestation, capacity accounting, and SCU metering isolated and correct.
*Source: node-architecture.md §13.*
**Decision:** _(pending — Shehab)_

### I3 🟧 Reproducible-build depth at the kernel boundary
How far down the stack (CUDA, cuDNN, vendor firmware) the reproducible build must reach for a
stable-yet-upgradeable measurement, and how unavoidable vendor-binary blobs are handled in
the allowlist.
*Source: node-architecture.md §13 + verification-attestation.md §5.*
**Decision:** _(pending — Shehab)_

### I4 🟦 Model cache trust across restarts
Can a verified-once model blob be safely served from local protected storage across restarts,
and what re-verification is required after a host compromise?
*Source: node-architecture.md §13.*
**Decision:** _(pending — Shehab)_

---

## J. Governance & decentralization

### J1 🟧 Governance decentralization schedule
Concrete quorum, timelock, and token-concentration limits that define "sufficiently
decentralized," and what triggers each step.
*Source: threat-model.md §16.*
**Decision:** _(pending — Shehab)_

---

## K. Operations & infrastructure

### K1 🟧 Vendor-outage fault attribution
How the protocol distinguishes a *vendor attestation-service outage* (no provider fault) from
*provider misconfiguration* at settlement, on-chain, without a trusted oracle. What signal
proves "the vendor was down"?
*Source: operations/deployment.md (Open questions).*
**Decision:** _(pending — Shehab)_

### K2 🟧 Permissionless-relay incentive funding
Mechanism is settled (sponsored transactions). Who funds the sponsor (treasury vs a small
on-chain bounty from escrow/slash), and how is the bounty sized so liveness survives a
relayer outage without inviting spam?
*Source: operations/deployment.md (Open questions).*
**Decision:** _(pending — Shehab)_

### K3 🟧 Manifest distribution & trust
Is a Walrus-published, multisig-signed manifest sufficient, or do we need an on-chain registry
of canonical manifest blob ids per network to close counterfeit-package risk?
*Source: operations/deployment.md (Open questions).*
**Decision:** _(pending — Shehab)_

### K4 🟥 Mock-attestation isolation
Guardrails that guarantee mock-attestation mode can never be enabled on a testnet/mainnet
`MeasurementAllowlist`, even by operator error.
*Source: operations/deployment.md (Open questions).*
**Decision:** _(pending — Shehab)_

### K5 🟦 Cross-region attestation latency / per-region SLA classes
Do geographically distributed providers need per-region SLA classes to keep
`dispatch_to_attest_latency` within budget given vendor attestation round-trips?
*Source: operations/deployment.md (Open questions).*
**Decision:** _(pending — Shehab)_

### K6 🟦 Indexer rebuild time / snapshots
At mainnet scale, how long a full event-replay rebuild of the indexer cache takes, and whether
periodic snapshots are needed to bound recovery time.
*Source: operations/deployment.md (Open questions).*
**Decision:** _(pending — Shehab)_

### K7 🟧 Indexer hosting & trust
Is the reference indexer self-hostable by every consumer, and what is the canonical public
endpoint? (SDK must work with none/raw RPC.) What SLA for the hosted path without granting it
authority? (Note: DeepBook ships a public indexer GIX can lean on for order/fill correlation.)
*Source: sdk.md (Still open).*
**Decision:** _(pending — Shehab)_

### K9 🟦 Client-construction migration (pin SDK)
Pin the target Sui SDK version and client-construction shape (SDK 2.0 deprecates JSON-RPC in
favor of `SuiGrpcClient` + `.$extend(deepbook()/walrus()/seal())`; `WalrusClient` no longer
builds from a bare RPC URL).
*Source: sdk.md (Still open).*
**Decision:** _(pending — Shehab)_

---

## L. Contract / implementation design choices

### L1 🟧 Credit reserve vs burn-on-creation (final call)
*Leaning resolved:* use **reserve-then-burn** (reserve into the `Job` at creation, burn at
`Settled`, release on no-fault refund). Confirm vs burn-on-creation + re-mint. Interacts with
tokenomics.
*Source: sui-move-contracts.md §13 + deepbook-integration.md §12 Q3.*
**Decision:** _(pending — Shehab)_

### L2 🟦 Measurement co-location
Keep approved measurements only in `governance::MeasurementAllowlist` (single authority) vs
mirror on `ModelRecord` as a dynamic field for cheaper co-located reads at attestation time.
*Recommendation: single authority, optional read-cache mirror.*
*Source: sui-move-contracts.md §13.*
**Decision:** _(pending — Shehab)_

### L3 🟧 ProviderStake sharding (concurrency safety)
The driver is **equivocation safety** of a hot owned object, not just throughput. At what
concurrency does a provider need per-market/per-shard stake objects (or a consensus party
object) vs simply batching stake-touching ops into one PTB?
*Source: sui-move-contracts.md §8, §13.*
**Decision:** _(pending — Shehab)_

### L4 🟦 Composite-quote canonical byte layout
The exact, version-stable byte layout for combining the CPU TEE quote and the (deferred) GPU-CC
report into one `measurement` and one signed `report_data`.
*Source: verification-attestation.md (Open questions).*
**Decision:** _(pending — Shehab)_

---

*New questions are appended to the relevant section above as the build progresses. Per-doc
"Open questions" sections point here by ID.*
