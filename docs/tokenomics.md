# Tokenomics

**Purpose:** The economic design spec for GIX — how USDC, the GIX token, and
per-market Compute Credits interact to make GPU inference a liquid, trust-minimized
commodity, and why honest provision is the dominant strategy.

> **Status:** Economic design. Conforms to the canonical naming and flows in
> [overview](architecture/overview.md) and [glossary](glossary.md). Every specific
> number below is an **illustrative parameter, subject to governance and modeling**
> — none is a launch commitment. Parameter authority lives in `gix::governance`.

> **⚠️ v1 scope (decided 2026-06): the GIX token is deferred.** To cut launch
> complexity, **v1 ships without the GIX native token.** Concretely, in v1:
> - **Provider bonds are denominated in USDC** — the same asset as escrow/settlement.
>   `ProviderStake` holds a `Balance<USDC>`. The slashing, capacity-gating, and
>   cost-of-cheating logic below all hold unchanged; only the bond's *denomination*
>   changes.
> - **Governance is an `AdminCap`/multisig**, not token voting.
> - **Fees are taken in USDC** (already the v1 design — see §7).
> - **No emissions / liquidity mining / token incentives.** §3.2–§3.3 (supply,
>   distribution, emissions) and the GIX-specific utilities in §3.1 describe the
>   **post-MVP end state**, not v1.
>
> **Why USDC bonds for v1:** the bond and the value it secures (escrowed USDC) are
> then the *same asset*, so there is no GIX/USDC valuation mismatch to manage — this
> **collapses open question [B1](open-ended-questions.md#b1--collateralization-ratio-k--price-oracle)**
> (`k` becomes a clean USDC-vs-USDC multiple needing no price oracle) and largely
> neutralizes threat-model **T-ECON-4 / T-ECON-6** for v1. The trade-off is that v1
> has no emissions-funded bootstrap lever and no token value-accrual; those return
> when GIX is introduced as an **additive upgrade** (the bond is re-denominated in GIX
> and token governance switches on). Sections describing GIX-the-token are marked as
> end-state where it matters.

---

## 1. The three-asset system

GIX deliberately separates **money**, **stake**, and **capacity claims** into three
distinct assets. Conflating them (e.g. paying for inference in a volatile native
token, or letting capacity be minted without collateral) is the classic failure
mode of compute-token projects. The split is the core of the design.

| Asset | What it is | Role | Volatility tolerance | Module touchpoints |
| --- | --- | --- | --- | --- |
| **USDC** | Circle-native stablecoin on Sui | Settlement & quote asset; unit of account; escrow; payout; fee denomination | Must be stable | `escrow`, `settlement` |
| **GIX** | Native protocol token *(post-MVP)* | Provider stake/collateral; governance; fee rebates/discounts; security-budget emissions | Volatile by design | `staking`, `slashing`, `governance` |
| **Compute Credit** | Fungible coin scoped to one **Market** (`gix::credit`) | Tradeable claim on one **SCU** = one unit of **verified model output** (not GPU time); floats vs USDC on DeepBook | Floats with spot price | `credit`, `market` |

The mental model:

- **USDC is what changes hands.** Consumers pay USDC; providers receive USDC. All
  fees are denominated and skimmed in USDC.
- **Stake is what is at risk.** A provider posts a bond as a `ProviderStake`
  (**USDC in v1**; GIX post-MVP). Misbehavior burns or redistributes that stake. The
  GIX token additionally confers governance and fee benefits — post-MVP.
- **Compute Credits are what is traded for price discovery.** A `Credit<Market>` is
  not money; it is a redeemable claim on one **Standardized Compute Unit (SCU)** in
  one market — one unit of the market model's **verified output** (e.g. *N* tokens at
  the tier), **not** a unit of GPU time. Its USDC price *is* the spot price of compute
  for that market.

> **What GIX sells (canon, [overview §1/§3](architecture/overview.md)).** GIX trades the
> **verified output of a registered model**, priced in SCUs of useful output. The **GPU
> class is a market qualifier**, not the product and not the pricing unit; **raw GPU-time
> is explicitly not the unit** (not cryptographically verifiable). A pure GPU-rental
> product, if pursued, would be a separate later line with weaker, non-cryptographic
> guarantees. The economics below price *verified output*.

> **Market model (canon, [overview §3.1](architecture/overview.md)).** GIX is a **spot
> exchange for a perishable commodity** (the electricity analogy: capacity can't be
> hoarded). Three roles transact: **consumers** (demand — run inference now),
> **providers** (supply — sell capacity), and **market makers** (trade credits for the
> spread, owning no GPU and consuming nothing) — the last is why GIX uses a real CLOB.
> Price discovery, MM liquidity, and hedging are in scope; long-horizon hoarding is
> bounded by perishability + credit expiry ([§4.6](#46-credit-expiry--staleness),
> [A4](open-ended-questions.md#a4--credit-expiry-window-per-market)).

### 1.1 Value-flow diagram

```mermaid
flowchart TB
    subgraph Consumer
      C[Consumer]
    end
    subgraph Provider
      P[Provider Node + TEE]
      PS[ProviderStake - GIX]
    end

    DB[(DeepBook\nCredit/USDC pool)]
    ESC[[Escrow - USDC\nheld by Job]]
    SET[gix::settlement]
    TRE[(Treasury - USDC)]
    STK[Stakers - GIX]
    BURN[((GIX burn / redistribute))]

    %% capacity side
    PS -. gates minting .-> MINT[mint Credits<Market>]
    MINT -->|post asks| DB
    C -->|post bids USDC| DB
    DB -->|fill: Credits to consumer, USDC reserved| ESC

    %% settlement side
    ESC --> SET
    SET -->|payout USDC minus fee| P
    SET -->|protocol fee bps| TRE
    SET -->|staker share of fee| STK
    SET -. burn Credit on completion .-> BURNC[((Credit burned))]

    %% failure side
    SET -. on fault: refund USDC .-> C
    SET -. slash stake .-> BURN
    BURN -. compensation .-> C
```

The two halves to keep separate while reading this document:

1. **Capacity / price-discovery loop** (top): GIX stake gates Credit minting →
   Credits trade on DeepBook → a fill establishes the spot price and reserves USDC.
2. **Settlement loop** (bottom): on success, escrowed USDC flows to the provider
   minus the protocol fee (split treasury/stakers) and the Credit burns; on fault,
   USDC refunds to the consumer and the provider's GIX stake is slashed.

---

## 2. USDC — the money

USDC is the **unit of account, escrow asset, payout asset, and fee denomination**
for every market in v1.

- **Quote asset on DeepBook.** Every market pool is `Credit<Market> / USDC`. The
  USDC leg is what gives the spot price a meaning a consumer can budget against.
- **Escrow.** When a fill occurs, the relayer creates a `Job` and locks the
  consumer's USDC into `Escrow` (held by the `Job` per the
  [overview](architecture/overview.md) object model). Funds are immobilized until
  `settlement` releases or refunds them — no intermediary custodies them.
- **Payout.** On a verified job, `settlement` releases escrowed USDC to the provider
  minus the protocol fee.
- **Fee denomination.** Protocol fees are skimmed in USDC (see §7). This keeps the
  fee a stable, predictable fraction of settled value rather than a bet on token
  price.

### 2.1 Why a stablecoin quote (and not GIX)

Pricing compute in a volatile native token is a well-known anti-pattern:

- **Provider cost basis is fiat.** Hardware amortization, electricity, bandwidth,
  and Walrus storage are paid in fiat. A provider quoting in a volatile token bears
  FX risk on every job and will price in a risk premium — raising consumer cost.
- **Consumer budgeting requires stability.** An inference buyer needs a cost per
  1M tokens they can forecast. A stablecoin quote makes the spot price directly
  comparable to centralized API pricing.
- **No forced token exposure.** Demand for the protocol must not require demand for
  the token to use it. Forcing consumers to hold GIX to pay for inference suppresses
  adoption and turns the token into a toll, not a utility.

GIX captures value through **staking demand, fee accrual, and governance** (§3, §7),
not by being the medium of exchange. This is an intentional decoupling.

---

## 3. GIX — the native token

> **Post-MVP.** This entire section describes the **end-state** token. v1 ships
> without GIX (USDC bonds + `AdminCap` governance — see the scope banner at the top).
> Treat §3.1–§3.4 as the design GIX activates into when introduced as an additive
> upgrade.

GIX is the protocol's security and coordination asset. It is **volatile by design**
and is never required to *consume* inference.

### 3.1 Utilities

| Utility | Mechanism | Module |
| --- | --- | --- |
| **Provider staking / collateral** | A provider locks GIX as a `ProviderStake`; the bond gates how many Credits (SCUs) it may mint and is the slashable security deposit. | `staking`, `slashing` |
| **Governance** | GIX (typically staked/locked) votes on protocol parameters, fee schedule, measurement/cert allowlists, and upgrade authority. | `governance` |
| **Fee rebates / discounts** | Stakers and high-reputation providers receive a share of protocol fees and/or reduced effective fee tiers. | `settlement`, `governance` |
| **Security-budget emissions** | Time-bounded emissions fund the staking/security budget and bootstrap incentives (§11). | `governance` |

### 3.2 Illustrative supply & distribution

> Illustrative parameters, subject to governance and modeling. A fixed maximum
> supply of **1,000,000,000 GIX** is assumed for the worked examples below.

| Allocation | Share | Vesting (illustrative) | Rationale |
| --- | --- | --- | --- |
| Community & ecosystem incentives | 35% | Emitted over ~4–6 years per the schedule in §3.3 | Liquidity mining, provider subsidies, consumer credits |
| Treasury (protocol-controlled) | 20% | Unlocked to a governance-controlled treasury; spend rate set by governance | Grants, audits, market-making, contingency |
| Team & contributors | 18% | 1-year cliff, 4-year linear thereafter | Long-horizon alignment |
| Early investors | 17% | 1-year cliff, 3–4-year linear thereafter | Capital |
| Public / launch liquidity | 6% | Mostly unlocked at TGE for DEX/CEX liquidity | Price discovery, two-sided liquidity |
| Initial core stakers / validators of security | 4% | 6-month cliff, 2-year linear | Bootstrap the security set |

Design intent of the distribution:

- **Community + ecosystem is the largest bucket** because a two-sided market must
  *subsidize* both sides through cold-start (§11). Under-funding this bucket is the
  single biggest economic risk.
- **Insider unlocks (team + investors = 35%) carry a 1-year cliff** so that no
  insider liquidity hits the market before the protocol has organic usage. Cliff
  cliffs that coincide with thin liquidity are a known failure mode and should be
  smoothed.

### 3.3 Emissions schedule (illustrative)

Emissions fund the **security budget** (staking rewards) and **bootstrap
incentives**. They are front-loaded and decay so that the protocol transitions from
emission-funded to fee-funded security over time.

| Epoch (year) | Annual emission (% of max supply) | Primary use |
| --- | --- | --- |
| 1 | 8% | Heavy provider subsidy + liquidity mining + consumer credits |
| 2 | 6% | Tapering subsidy; staking rewards |
| 3 | 4% | Mostly staking rewards |
| 4 | 2.5% | Staking rewards; subsidy mostly off |
| 5+ | ~1% tail or 0, governance-set | Maintenance security budget |

> The honest framing: **emissions are dilution.** They are justified only to the
> extent they purchase security (staked GIX) and durable two-sided liquidity. The
> exit condition is **fee revenue covering the desired security budget** so the tail
> emission can go to zero. Whether that crossover is reachable is an open question
> (§13).

### 3.4 Demand drivers and sinks

**Demand drivers (buy/lock pressure):**

- **Staking demand scales with GPU supply.** Every SCU of mintable capacity requires
  bonded GIX (§4, §8). As provider throughput grows, required stake grows — a direct
  link between protocol usage and token demand that does *not* tax consumers.
- **Fee accrual to stakers.** A share of USDC protocol fees flows to stakers,
  giving GIX a cash-flow-like return that rises with volume.
- **Governance value.** Control over fee schedule, allowlists, and treasury.

**Sinks (sell/burn pressure offsets):**

| Sink | Mechanism | Notes |
| --- | --- | --- |
| **Slashing burn** | A fraction of slashed stake is burned | Net-deflationary on faults; see §8 |
| **Slashing redistribution** | The remainder compensates harmed consumers / funds treasury | Not a burn, but removes it from the offender |
| **Optional fee buyback** | Governance may route part of the treasury's USDC fee take to buy and burn (or buy and stake-reward) GIX | Off by default; a governance lever, not a baseline assumption |

> We do **not** assume a buyback as a baseline value-accrual mechanism. Token value
> should be justified by staking demand and fee accrual first; buyback is an
> optional, governance-gated amplifier.

---

## 4. Compute Credits — capacity claims

A **Compute Credit** (`gix::credit`) is a fungible coin scoped to a single
**Market**. One credit = one **SCU** in that market — one unit of the model's
**verified output** (a bounded request/item, or *N* output tokens at the market's
tier; per the [glossary](glossary.md)), **not** a unit of GPU time. Credits are
**claims on verified output, not money.**

> **v1/M2 credits are single-use.** A filled credit is consumed by its buyer's job and
> the **filling provider is the obligated server** (assigned-from-fill). Freely-
> resellable **bearer** credits — redeemable against *any* staked provider, with a
> dispatch/clearing layer — are the post-MVP **tradeable-credits upgrade**
> ([roadmap](roadmap.md) Phase 8). The minting/expiry/slashing economics below hold for
> both; only credit *fungibility-on-resale* changes.

### 4.1 Minting against staked capacity

Credits are minted by providers, gated by **two simultaneous constraints**:

1. **Collateral constraint (GIX stake).** The provider's `ProviderStake` must back
   the credits it mints. Mintable SCUs are bounded by stake via a collateralization
   ratio (§4.2).
2. **Physical-capacity constraint (hardware accounting).** A provider may not mint
   more SCUs than its registered, attestable hardware can serve within the market's
   SLA window. `staking` tracks committed-vs-available capacity per provider and
   per market.

`mintable_SCU = min( capacity_from_stake , physical_capacity_remaining )`

Both gates matter: stake makes over-issuance *costly*, hardware accounting makes it
*physically bounded*. A provider cannot mint a credit it has no GPU to honor, and
cannot mint past what its bond secures.

### 4.2 Collateralization ratio (illustrative)

Let:

- `S` = stake value. **v1: the bond's face USDC amount** (no reference price, no
  haircut — the bond is already USDC). *Post-MVP:* GIX stake in USDC-equivalent value
  at a conservative, governance-set reference price with a haircut for volatility.
- `p̄` = a reference/expected USDC spot price per SCU for the market. (This is the
  *compute* spot price, not a GIX price — it is needed for capacity sizing in both v1
  and post-MVP, and is **not** the settlement-path oracle B1 warns about.)
- `k` = collateralization ratio (illustrative target **1.5×–3×** of escrow-at-risk).

Then the stake-bounded mintable capacity is:

```
capacity_from_stake = S / (k · p̄)
```

i.e. the stake must over-collateralize the USDC value of the capacity the provider can
have in flight. **v1:** `S` is USDC, so no price haircut applies and `k` is a clean
USDC-vs-USDC multiple. **Post-MVP:** because GIX is volatile, governance applies a
**price haircut** to `S` and a **conservatism margin** to `p̄` (this is what reopens
B1). The binding quantity for security is **escrowed USDC per provider at any instant**,
not nominal minted credits (see §8).

### 4.3 Redemption / burn on completion

When a job settles successfully, the Credit reserved for it is **burned** by
`settlement` (the [overview](architecture/overview.md) lifecycle: "finalize
credits"). The capacity it represented is consumed; the provider receives USDC from
escrow. The credit's life is: **mint → sell on DeepBook → reserve on fill → burn on
completion.**

### 4.4 Why the credit price floats on DeepBook

The credit/USDC price is *the spot price of compute* and must float:

- **It clears supply and demand in real time.** When GPU demand spikes, bids lift
  the credit price; providers mint and sell more; price re-equilibrates. This is the
  price-discovery function that justifies using a CLOB at all
  ([deepbook](architecture/deepbook-integration.md)).
- **It is a claim with a hard backing.** Unlike money, a credit is redeemable for a
  defined unit of service, so its price is anchored to the marginal cost of serving
  an SCU (energy + amortization + fee + risk) from below and to consumer
  willingness-to-pay from above. It is not a free-floating governance token.

### 4.5 Preventing over-minting (capacity accounting)

Over-minting — issuing more claims than can be honored — is the credit system's
central risk. Three layers prevent it:

1. **Stake gate.** Minting decrements available stake-backed capacity (§4.2); you
   cannot mint past your bond.
2. **Hardware gate.** `staking` capacity accounting decrements physical SCUs
   committed; you cannot mint past your attestable throughput.
3. **Settlement reality.** Credits only convert to revenue when a job is *attested
   and verified* ([verification](architecture/verification-attestation.md)). A
   provider that mints and sells credits it cannot serve will fail attestation, be
   slashed, and refund consumers (§8, §9). Over-minting is therefore not merely
   blocked at mint time — it is *punished* at settlement time.

### 4.6 Credit expiry / staleness

Credits represent capacity in a *time window*; capacity is **perishable** (an idle GPU
hour is lost) — this is the defining property of GIX as a **spot exchange for a
perishable commodity** ([overview §3.1](architecture/overview.md)). Expiry is also what
**bounds long-horizon speculation/hoarding**: there is no durable inventory to corner.
To prevent stale claims accumulating against a provider's accounting:

- Credits carry (or the market enforces) an **expiry / epoch tag**; expired credits
  are not redeemable and free the corresponding capacity accounting back to the
  provider.
- **Staleness handling is a market parameter.** Short-lived credits keep capacity
  accounting honest but raise inventory churn for providers; long-lived credits ease
  trading but risk over-commitment if hardware availability changes. The right
  expiry window is per-market and governance-tunable (§13).

---

## 5. Provider economics

A provider's job is to convert bonded GIX + GPU hours into USDC revenue, net of
costs and slashing risk.

### 5.1 Stake requirement vs throughput

Required stake scales with **in-flight escrowed value**, which scales with
throughput × spot price (§4.2). A provider sizing up:

- More throughput (more SCUs/hour served) ⇒ more credits minted ⇒ more bonded GIX
  required at ratio `k`. Stake is a *working-capital* requirement, not a one-time
  fee.
- This couples GPU supply growth to GIX demand growth (the §3.4 demand driver) and
  ensures every unit of capacity is collateralized.

### 5.2 Revenue and costs per SCU

| Line item | Direction | Denomination | Notes |
| --- | --- | --- | --- |
| Spot revenue per SCU | + | USDC | DeepBook fill price |
| Protocol fee | − | USDC | bps on settled USDC (§7) |
| DeepBook maker fee | − | USDC | Provider usually posts asks → maker side |
| Hardware amortization | − | fiat | GPU capex / useful life |
| Energy | − | fiat | Dominant marginal cost |
| Sui gas | − | SUI | Attestation submit + settlement txns |
| Walrus storage | − | WAL/USDC | Output + quote blobs ([overview](architecture/overview.md)) |
| Expected slashing | − | GIX | Probability × slash fraction (§8) |

### 5.3 Illustrative provider P&L

> Illustrative parameters, subject to governance and modeling. Single H100-80GB
> node, one market, one month. Numbers are round and intentionally conservative.

| Item | Assumption | Monthly value |
| --- | --- | --- |
| SCUs served | 1.0M SCU/mo (well below max; reflects utilization) | 1,000,000 SCU |
| Spot price | $0.004 / SCU | +$4,000 gross |
| Protocol fee | 10 bps on settled USDC | −$4 |
| DeepBook maker fee | ~1 bp effective | −$0.40 |
| Energy | 700W avg, $0.08/kWh, ~85% uptime | −$43 |
| Hardware amortization | $30k GPU / 36 mo | −$833 |
| Sui gas | ~1M settlement txns at trivial per-tx cost | −$50 |
| Walrus storage | output+quote blobs, short retention | −$20 |
| **Net before slashing risk** | | **≈ +$3,049** |
| Expected slashing cost | 0.1% fault rate × partial slash on in-flight value | small, modeled as −$10–50 |
| Bonded GIX (opportunity cost) | stake at ratio `k`; capital tied up | implicit cost of capital |

Takeaways:

- **Energy and hardware amortization dominate marginal cost**, exactly as in
  off-chain GPU economics. Protocol and DeepBook fees are negligible per SCU at the
  illustrative tiers — the protocol is cheap to *transact* on; it is expensive to
  *cheat* on.
- **The binding economic constraint is utilization**, not fee drag. Cold-start
  utilization risk (§11) is the real threat to provider P&L, not protocol take.
- **Bonded GIX is a cost of capital**, not a sunk fee; it is returned on honest
  unbonding (§8).

---

## 6. Consumer economics

The consumer's headline question is "what does one inference cost, and is it
predictable?" The total cost stack:

```
Total consumer cost  =  spot_price · SCUs            (USDC, DeepBook fill)
                     +  protocol_fee (bps)           (USDC)
                     +  DeepBook taker fee            (USDC, consumer usually takes)
                     +  Sui gas                       (SUI)
                     +  Walrus storage (input blob)   (WAL/USDC)
```

| Component | Who sets it | Predictability |
| --- | --- | --- |
| Spot price | DeepBook matching | Floats; bounded by limit orders the consumer sets |
| Protocol fee | `governance` (bps) | Fixed, known in advance |
| DeepBook taker fee | DeepBook | Fixed schedule |
| Sui gas | Network | Low, near-constant |
| Walrus input storage | Walrus | Small, size-proportional |

Predictability properties:

- **The dominant, variable term is the spot price**, which the consumer controls
  with **limit orders** — placing a bid caps the per-SCU price paid. Market orders
  trade price certainty for fill certainty.
- **All other terms are fixed schedules** denominated in USDC (plus trivial gas),
  so the consumer can compute a worst-case total before submitting.
- **No token exposure.** A consumer never needs to hold GIX. This is the §2.1
  decoupling realized on the demand side.

---

## 7. Fee model

### 7.1 Protocol fee

- The protocol fee is a **basis-point charge on settled USDC**, skimmed by
  `settlement` at payout time. Illustrative: **10 bps (0.10%)**, governance-tunable.
- The fee is taken **only on successful settlement.** Refunded jobs pay no protocol
  fee (a provider fault should not also tax the wronged consumer).

### 7.2 Fee split

The skimmed USDC fee is split:

| Recipient | Illustrative share | Purpose |
| --- | --- | --- |
| Stakers | 60% | Cash-flow return on GIX stake; funds security demand (§3.4) |
| Treasury | 40% | Audits, grants, market-making, contingency (§10) |

> Split is a governance parameter. The staker share is the mechanism by which
> **protocol revenue accrues to GIX** without taxing consumers in the native token.

### 7.3 Interaction with DeepBook fees

DeepBook charges its own **maker/taker fees** on the `Credit/USDC` trade, *separate
from* the GIX protocol fee. The two stack on the consumer's cost (see §6) and on the
provider's costs (§5.2). The protocol fee is on **settled job value**; the DeepBook
fee is on **the trade that matched the order**. Design notes and exact schedules:
[deepbook](architecture/deepbook-integration.md).

### 7.4 Fee governance

`gix::governance` controls the protocol fee bps, the treasury/staker split, and any
fee-tier discounts/rebates (e.g. reduced effective fees for high-stake or
high-reputation providers). Fee changes are parameter votes, subject to the
progressive-decentralization schedule in §10.

---

## 8. Economic security

The security claim GIX must make: **a provider's cost of cheating exceeds its gain
from cheating, for every fault, at all times.** Verification gives us the
*detection* (a bad or missing attestation is caught on-chain —
[verification](architecture/verification-attestation.md)); tokenomics must supply
the *punishment* that makes detection deterring.

### 8.1 Stake at risk vs escrowed value

The invariant the bond sizing must maintain, **per provider**:

```
stake_at_risk(provider)  ≥  k · escrowed_value_in_flight(provider)
```

where `escrowed_value_in_flight` is the sum of USDC in `Escrow` across all of that
provider's active jobs, and `k > 1` (illustrative 1.5×–3×). Intuitively: at any
instant, a provider has **more stake slashable than the USDC it could steal or destroy
by defaulting on all in-flight jobs simultaneously.** `staking` re-checks the bound at
mint time.

> **v1 (USDC bonds):** bond and obligation are the same asset, so no price conversion
> is involved — `k` is a pure USDC-vs-USDC over-collateralization multiple and the
> bound holds at face value, with no oracle and no volatility haircut. This is the
> simplification that resolves [B1](open-ended-questions.md) for v1.
>
> **Post-MVP (GIX bonds):** because GIX price is volatile, the *value* of stake must
> then be haircut conservatively when computing this (§4.2) and tracked against a
> price reference — reopening B1 (dynamic `k` + a trustworthy GIX/USDC oracle) as a
> prerequisite for the token launch.

### 8.2 Slashing fractions per fault type (illustrative)

| Fault | Detection | Illustrative slash | Rationale |
| --- | --- | --- | --- |
| **Invalid attestation** (wrong model/hash, bad measurement, forged quote) | `attestation` rejects | 100% of the job's required bond share + flat penalty | Provable fraud; must be ruinous |
| **Missing attestation** (no quote before deadline) | deadline expiry | Job's bond share | Could be liveness or evasion; punished, but less than fraud |
| **SLA breach** (attested but too slow) | attestation timestamps vs market SLA | Partial (e.g. 10–50%) + refund | Result may still be usable; graded |
| **Liveness fault** (registered capacity not serving dispatches) | dispatch-ack timeout | Small per-incident + reputation hit; repeated → larger | Protects matching, not yet fraud |
| **Repeated/correlated faults** | reputation accounting | Escalating, up to full stake | Deters strategic recidivism |

### 8.3 Why honest behavior dominates

For any single job, define for the provider:

- `gain_cheat` ≤ escrowed USDC it could fail to honor / divert ≈ `p̄ · SCUs`.
- `cost_cheat` = `slash_fraction · bond_share` (in USDC-equivalent) + forfeited
  honest revenue + reputation loss.

With the §8.1 invariant and a meaningful slash fraction on provable faults,
`cost_cheat > gain_cheat` for fraud (invalid attestation), because the bond
over-collateralizes the very escrow at stake and the cheat additionally forfeits
future honest cash flow. The honest path yields positive expected value (§5.3) and
returns the bond; the cheating path is negative-EV. This is the economic
counterpart to the cryptographic guarantee in
[verification](architecture/verification-attestation.md); the full adversary
treatment is in [threat model](security/threat-model.md).

---

## 9. Staking & slashing economics

### 9.1 Bond sizing formula (illustrative)

A provider that wants to serve `q` SCUs/epoch at expected price `p̄` must bond:

```
required_stake_value  =  k · p̄ · in_flight_SCU_cap
```

where `in_flight_SCU_cap` is the max SCUs it can have *simultaneously escrowed*
(not total throughput — capacity recycles as jobs settle). Bonding is therefore
proportional to **peak concurrent exposure**, which makes stake efficient: a fast
provider that settles quickly needs less bond per unit of throughput.

### 9.2 Slash distribution

When stake is slashed, the proceeds split:

| Destination | Illustrative share | Notes |
| --- | --- | --- |
| Harmed consumer(s) | Up to 100% of their job value as compensation | Make the wronged party whole first |
| Treasury | Remainder after compensation | Funds insurance backstop / operations |
| Burn | Configurable fraction on pure-fraud faults | Net-deflationary deterrent (§3.4) |

The ordering is deliberate: **compensation before treasury before burn.** A consumer
who was defrauded should be made whole from the offender's stake; only the surplus
funds the treasury or is burned.

### 9.3 Unbonding period & restaking

- **Unbonding period (illustrative 7–14 days).** GIX withdrawn from a
  `ProviderStake` is locked through an unbonding window so that faults discovered
  *after* a provider stops serving can still be slashed. Without it, a provider could
  cheat and immediately exit with the bond.
- **Restaking.** Earned GIX rewards/fees can be compounded back into the
  `ProviderStake` to expand mintable capacity (§4.2) without external capital —
  aligning long-run providers and deepening the security set.

---

## 10. Governance & treasury

### 10.1 Parameter control

`gix::governance` controls the economic surface: protocol fee bps and split,
collateralization ratio `k`, slash fractions, unbonding period, emission schedule,
credit expiry windows, SCU definitions per market, and the measurement/cert
allowlists. These are the levers this document marks as illustrative.

### 10.2 Treasury funding & use

- **Funding:** the treasury share of protocol fees (USDC, §7.2), the treasury GIX
  allocation (§3.2), and the treasury share of slashing proceeds (§9.2).
- **Use:** security audits, ecosystem grants, **market-making / liquidity provision**
  during cold-start (§11), an **insurance backstop** for consumer compensation beyond
  a single offender's stake, and contingency.
- The treasury holds **both USDC and GIX**, letting it pay fiat-denominated costs
  without forced token sales and deploy GIX for incentives.

### 10.3 Progressive decentralization

Governance is expected to start more centralized (core team / multisig with
time-locks) and progressively hand parameter and upgrade authority to GIX
stakers, as the parameter space stabilizes and the security set grows. The honest
caveat: early parameters (fees, `k`, slash fractions, emissions) will need active
tuning, so **fast iteration and decentralization are in tension** early on. The
sequencing is a roadmap item, not a solved problem.

---

## 11. Bootstrapping & cold-start

A two-sided spot market has a **chicken-and-egg problem**: providers will not stake
GPUs without demand; consumers will not arrive without liquid, well-priced supply.
This is the single hardest economic risk and we treat it as such, not as an
afterthought.

### 11.1 The chicken-and-egg

- **Thin supply ⇒ wide spreads ⇒ poor consumer price ⇒ no consumers.**
- **No consumers ⇒ no utilization ⇒ provider P&L underwater (§5.3) ⇒ no providers.**

Neither side moves first without subsidy. Emissions (§3.3) and the
community/ecosystem allocation (§3.2) exist primarily to break this deadlock.

### 11.2 Bootstrap levers (illustrative)

| Lever | Side | Mechanism | Risk to manage |
| --- | --- | --- | --- |
| **Provider subsidies** | Supply | GIX emissions reward staked, *serving* capacity early (rewards on settled SCUs, not just on stake) | Mercenary capacity that leaves when emissions taper |
| **Liquidity mining** | Both | Reward makers who post tight `Credit/USDC` quotes | Wash trading to farm rewards (§12) |
| **Consumer credits** | Demand | Grant first-party USDC or fee rebates to early consumers | Sybil consumers farming credits |
| **Treasury market-making** | Both | Treasury seeds DeepBook depth to tighten spreads at launch | Treasury inventory/price risk |
| **Anchor demand** | Demand | Onboard a few high-volume consumers (committed flow) before public launch | Concentration / dependence |

### 11.3 Honest assessment

- Subsidies buy **temporary** liquidity; the test is whether **organic utilization**
  rises to replace them before emissions taper (§3.3). If it does not, the market
  collapses when subsidies end. This crossover is the central go/no-go for the
  economic design.
- **Reward only *serving* capacity**, never idle stake, to avoid paying for
  GPUs that never answer a dispatch.
- **Demand-side anchor tenants** (a handful of committed high-volume consumers) are
  probably more decisive than supply subsidies: utilization, not raw supply, is the
  binding constraint (§5.3).

---

## 12. Incentive & attack analysis

Each attack is paired with its economic cost and mitigation; the full adversary
model is in [threat model](security/threat-model.md).

| Attack | Description | Economic cost to attacker | Mitigation |
| --- | --- | --- | --- |
| **Sybil providers** | Many fake identities to win matches / farm subsidies | Each identity needs its own bonded GIX + attestable hardware (§4.1) | Stake + hardware attestation make identities costly; subsidies tied to *settled* SCUs, not registration |
| **Credit over-mint** | Mint more SCUs than serviceable | Bounded at mint (stake + hardware gates, §4.5); punished at settlement (slash + refund) | Dual mint gate + settlement reality; over-minted credits fail attestation |
| **Griefing (lock-and-abandon)** | Provider takes a job, locks consumer escrow, never delivers | Missing-attestation slash (§8.2) + refund to consumer + reputation/liveness penalty | Deadlines drive auto-refund; slash exceeds any grief value; consumer made whole from stake (§9.2) |
| **Wash trading** | Self-trade `Credit/USDC` to fake volume / farm liquidity rewards | Pays DeepBook maker+taker fees on every wash; subsidy designs cap reward per unit real settled work | Reward settled jobs over raw volume; fee drag makes wash unprofitable; monitoring |
| **Collusion (provider+consumer)** | Collude to extract subsidies or fake settlements | Both must post real stake/USDC and produce a *valid attestation* to settle — a real model must actually run (§4.5) | Attestation binds real execution; subsidy caps; no payout without verified work |
| **Price manipulation** | Spoof/ramp the spot price | Capital + DeepBook fees at risk; CLOB price-time priority | DeepBook microstructure; consumers use limit orders (§6) |
| **Stake-value attack** | GIX price crash makes bonds under-collateralize escrow | Bond value falls below `k · escrow` | Conservative price haircut (§4.2), re-check at mint, governance can raise `k` |

The recurring theme: **every profitable attack requires either real bonded stake to
burn, real fees to pay, or a real valid attestation to forge** — and forging an
attestation is the cryptographically hard problem v1 explicitly roots security in
([verification](architecture/verification-attestation.md)).

---

## 13. Open questions

> **Migrated to the central ledger.** These economic decisions now live in
> **[open-ended-questions.md](open-ended-questions.md)** so all questions needing your
> input are in one place. From this doc:
> - **A1** fee revenue vs security budget · **A2** subsidy taper / cold-start ·
>   **A3** staker vs treasury fee share · **A4** credit expiry window
> - **B1** collateralization ratio `k` + oracle · **B2** cross-market stake (siloed vs
>   shared) · **B3** insurance backstop sizing · **B4** slashing severity calibration
>
> Answer them there; answers are then propagated back into this doc's models.

---

> See also: [overview](architecture/overview.md) ·
> [contracts](architecture/sui-move-contracts.md) ·
> [deepbook](architecture/deepbook-integration.md) ·
> [verification](architecture/verification-attestation.md) ·
> [lifecycle](protocol/task-lifecycle.md) ·
> [threat model](security/threat-model.md) · [glossary](glossary.md)
