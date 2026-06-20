# Glossary

Canonical terminology and identifiers for GIX. Other documents use these terms
exactly as defined here.

## Protocol & assets

- **GIX** — The GPU Inference Exchange protocol (and the name of its `gix` Move
  package). Also the ticker of the planned **native token** for provider
  staking/collateral, governance, and fee economics. **The token is deferred to a
  post-MVP additive upgrade**: in v1 provider bonds are denominated in **USDC**,
  governance runs through an `AdminCap`/multisig, and fees are taken in USDC. Most
  uses of "GIX" in the docs refer to the protocol/package; token mechanics
  (tokenomics §3, §8–9) describe the post-MVP end state.
- **USDC** — Circle-native USD Coin on Sui. The **canonical settlement, quote, and bond
  asset** for all markets in v1 — the unit of account. USDC is **the** quote asset; what
  varies is only its **per-network instantiation**: the contracts parameterize the quote
  coin as a generic phantom `Q` and instantiate it as **`MOCK_USDC` on localnet, `DBUSDC`
  on testnet, real Circle USDC on mainnet** (see *DBUSDC*, *Quote coin (`Q`)*, and
  [onramp-dbusdc-plan.md](onramp-dbusdc-plan.md)).
- **DBUSDC** — DeepBook's **testnet USD** coin (`…::DBUSDC::DBUSDC`); GIX's **testnet
  stand-in for USDC**. Used because real Circle USDC has **no liquid DeepBook *testnet*
  pool** (those pools are mainnet-only), whereas DeepBook ships a live `SUI/DBUSDC` testnet
  pool. On testnet, DBUSDC is the quote/settlement/bond dollar and the on-ramp output;
  transactions against it are **real on-chain testnet txns**, not mocks. (localnet uses
  `MOCK_USDC`; mainnet uses real USDC.)
- **Quote coin (`Q`)** — The generic **phantom type parameter** the `gix` contracts use
  for the dollar, instantiated per network (`MOCK_USDC` / `DBUSDC` / `USDC`). One codebase,
  no hardcoded dollar: `Escrow`, `ProviderStake`, settlement, fees, and refunds are all
  written over `Coin<Q>` / `Balance<Q>`.
- **On-ramp** — An in-app **SUI→USD swap** that funds compute purchases: a small utility
  widget (**not** a DEX) that swaps `SUI → DBUSDC` (testnet) / `SUI → USDC` (mainnet) on an
  **existing** DeepBook pool, so it needs **no DEEP** and works today. It is a consumer
  *funding convenience*, distinct from each market's DEEP-gated `Credit<Market>/Q` compute
  pool. See [onramp-dbusdc-plan.md](onramp-dbusdc-plan.md) and
  [deepbook §13](architecture/deepbook-integration.md).
- **Compute Credit** — A fungible Sui coin scoped to a single market. One credit
  represents one **Standardized Compute Unit** of that market. Minted by providers
  against staked capacity, traded on DeepBook, burned on job completion. **v1/M2:
  single-use** (the credit is consumed by its buyer's job; the filling provider is the
  obligated server) — freely-resellable **bearer** credits are a post-MVP milestone
  (the *tradeable-credits upgrade*).
- **Standardized Compute Unit (SCU)** — The traded/priced unit: **one unit of verified
  useful output** of a market's registered model — **not** a unit of GPU time. Defined
  **per market** as a `Market` parameter: for **LLM markets**, 1 SCU = *N* output
  tokens at the tier (bounded input/context); for **other markets**, a bounded
  request/item (e.g. one image). What a buyer purchases is the model's *verified
  output*; the GPU class only qualifies which hardware serves it. Raw GPU-time is
  explicitly **not** an SCU (not cryptographically verifiable).

## Market structure

- **Spot exchange (for a perishable commodity)** — GIX's market model. Compute capacity,
  like electricity, **cannot be hoarded** (an idle GPU-second is lost), so GIX clears a
  *flow* of present demand against present supply rather than warehousing a stock. In
  scope: real-time price discovery, market-maker liquidity, hedging. Long-horizon
  speculation/hoarding is naturally bounded by perishability + credit expiry.
- **Market** — A standardized **verified-output** class, defined by the tuple
  `(GPU class, model/runtime tier, SLA class)`. What it sells is the **verified output
  of its registered model**; the GPU class is a *qualifier*, not the product (see SCU).
  Each market has one Compute Credit type and one DeepBook `Credit/USDC` pool.
- **GPU class** — Hardware category (e.g. `H100-80GB`, `H200-141GB`). A **market
  qualifier**: it fixes the hardware tier that serves the model (and so the
  speed/SLA/price) and determines the attestation hardware root and capacity
  accounting. It is **not** the unit sold or priced.
- **Model/runtime tier** — The specific model + runtime + quantization (e.g.
  `llama-3.1-70b-int8` on vLLM). Bound to a `ModelRecord`. This is *what is sold* — the
  buyer receives this model's verified output.
- **SLA class** — Latency/availability targets for the market (e.g. `p50<2s`,
  `p99<5s`). Enforced at settlement via attestation timestamps.
- **Spot price** — The live `Credit/USDC` price discovered by DeepBook matching for a
  market — i.e. the present price of one SCU of verified output.
- **Tradeable-credits upgrade** — The post-MVP milestone that turns single-use credits
  into freely-resellable **bearer credits** redeemable against *any* staked provider,
  adding a dispatch + clearing layer that decouples "who bought" from "who serves." v1/M2
  ships single-use credits (filling provider = obligated server). See
  [roadmap](roadmap.md) Phase 8.

## On-chain objects (Sui `gix` package)

- **Job** — Shared object representing one escrowed unit of work and its lifecycle
  state. The atom of parallel settlement.
- **Escrow** — The locked consumer USDC `Balance` held against a `Job` until
  settlement or refund. Typed `Balance<Q>` — the per-network quote dollar (see *Quote
  coin (`Q`)*).
- **ProviderStake** — A provider's posted collateral and capacity accounting; the
  slashable bond that gates credit minting. **v1: a `Balance<Q>` bond** denominated in
  the quote dollar (GIX collateral is a post-MVP upgrade) — `Q` is the per-network dollar
  (see *Quote coin (`Q`)*).
- **ModelRecord** — Shared object binding a model's Walrus content id to its set of
  approved TEE measurements.
- **AttestationRecord** — The verified summary of a node's attestation quote,
  retained as on-chain audit evidence (child of the `Job`).
- **MeasurementAllowlist / CertRoots** — Governance-pinned approved enclave/runtime
  measurements and vendor root certificates.

## Verification

- **TEE (Trusted Execution Environment)** — Hardware-isolated execution (CPU TEE such
  as Intel TDX / AMD SEV-SNP, plus confidential-computing GPU) used to produce a
  trustworthy attestation of execution.
- **Attestation quote** — A vendor-signed report binding the runtime measurement and
  the `model_hash ‖ input_hash ‖ output_hash ‖ timestamps` for a job.
- **Measurement** — A reproducible cryptographic hash of the loaded runtime/enclave
  (analogous to `MRENCLAVE`), checked against the allowlist for the target model.
- **Vendor attestation service** — The hardware vendor's service that signs/endorses
  quotes (e.g. NVIDIA NRAS for GPU CC; Intel/AMD for the CPU TEE). Roots pinned by
  governance.
- **zkML (non-goal, v1)** — Zero-knowledge proof of model execution. Not used in v1;
  the attestation interface leaves room to add it later as an alternative backend.

## Sui platform primitives

- **Nautilus** — Sui's official framework for **verifiable off-chain compute in a TEE
  with on-chain attestation verification in Move**. Pattern: register an enclave's
  measurements (PCRs) + ephemeral key on-chain once, then verify a native **Ed25519**
  signature over each result. Supports **AWS Nitro Enclaves only** today (no TDX/SEV-SNP/
  GPU-CC). GIX adopts its register-once model; GPU-CC verification is GIX-specific work.
- **Seal** — Sui **threshold identity-based encryption** with decentralized key servers
  and **on-chain access control** via Move `seal_approve` policy functions. The substrate
  for GIX's future confidential markets (decryption gated on the attested enclave).
- **PoA (Point of Availability)** — Walrus's `BlobCertified` event / `Blob.certified_epoch`,
  the on-chain proof that a blob is stored for its paid epochs. GIX's dispatch availability
  gate.
- **BalanceManager / Pool (DeepBook v3)** — A `BalanceManager` is a per-trader shared
  object custodying funds across pools; a `Pool` is a **single** shared object (its
  Book/State/Vault are internal components, *not* separate objects) implementing the CLOB
  for one `Credit/USDC` pair.
- **PTB (Programmable Transaction Block)** — An all-or-nothing Sui transaction chaining
  multiple Move calls, where each command's output can feed the next. The mechanism that
  makes DeepBook-fill → `create_job` atomic without a trusted relayer.

## Lifecycle states

`Created → Matched → Escrowed → Dispatched → Executing → Attested → Verified →
Settled`, with terminal failure states `Refunded`, `Slashed`, and `Expired`. Defined
in [protocol/task-lifecycle.md](protocol/task-lifecycle.md).

## Off-chain software

- **Node** — The Rust provider software: runs inference inside the TEE, produces
  attestations, manages stake/credits, posts asks. See
  [architecture/node-architecture.md](architecture/node-architecture.md).
- **Relayer / Indexer** — A Rust service that turns DeepBook fills into on-chain Jobs
  and indexes events. Holds no settlement authority.
- **Settlement watcher** — A Rust service that observes deadlines and nudges
  expiries. Holds no settlement authority.
- **SDK** — The TypeScript client library for consumers and providers. See
  [architecture/sdk.md](architecture/sdk.md).

## Roles

The three participant roles of a spot exchange (see *Spot exchange* above):

- **Consumer / developer** — **Demand side.** Buys to run inference *now* (per-inference
  / API use case — the anchor demand): uploads input, places bids, receives verified
  output.
- **Provider / Node operator** — **Supply side.** Sells capacity: posts a bond (USDC in
  v1; GIX post-MVP), mints credits, posts asks, runs the node, serves jobs, gets paid or
  slashed.
- **Market maker / Liquidity provider** — Posts bids *and* asks to **trade credits and
  earn the spread**, **without owning a GPU or consuming inference**. Makes the book
  liquid; the reason GIX matches on a real CLOB (DeepBook). (In v1/M2's single-use-credit
  model they trade the order book; onward resale of a filled credit arrives with the
  *tradeable-credits upgrade*.)
- **Governance** — Manages protocol parameters, measurement/cert allowlists, fee
  schedule, and upgrade authority — via an `AdminCap`/multisig in v1 (token-weighted
  governance is post-MVP). See [tokenomics.md](tokenomics.md).
