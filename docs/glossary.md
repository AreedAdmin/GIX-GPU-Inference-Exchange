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
- **USDC** — Circle-native USD Coin on Sui. The **settlement and quote asset** for
  all markets in v1. The unit of account.
- **Compute Credit** — A fungible Sui coin scoped to a single market. One credit
  represents one **Standardized Compute Unit** of capacity in that market. Minted by
  providers against staked capacity, traded on DeepBook, burned on job completion.
- **Standardized Compute Unit (SCU)** — The normalized unit of inference capacity a
  single Compute Credit represents in a given market (e.g. a bounded request, or *N*
  output tokens at the market's tier). Defined per market as a `Market` parameter.

## Market structure

- **Market** — A standardized capacity class, defined by the tuple
  `(GPU class, model/runtime tier, SLA class)`. Each market has one Compute Credit
  type and one DeepBook `Credit/USDC` pool.
- **GPU class** — Hardware category (e.g. `H100-80GB`, `H200-141GB`). Determines the
  attestation hardware root and capacity accounting.
- **Model/runtime tier** — The specific model + runtime + quantization (e.g.
  `llama-3.1-70b-int8` on vLLM). Bound to a `ModelRecord`.
- **SLA class** — Latency/availability targets for the market (e.g. `p50<2s`,
  `p99<5s`). Enforced at settlement via attestation timestamps.
- **Spot price** — The live `Credit/USDC` price discovered by DeepBook matching for a
  market.

## On-chain objects (Sui `gix` package)

- **Job** — Shared object representing one escrowed unit of work and its lifecycle
  state. The atom of parallel settlement.
- **Escrow** — The locked consumer USDC `Balance` held against a `Job` until
  settlement or refund.
- **ProviderStake** — A provider's posted collateral and capacity accounting; the
  slashable bond that gates credit minting. **v1: a `Balance<USDC>` bond** (GIX
  collateral is a post-MVP upgrade).
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

- **Consumer** — Buys compute: uploads input, places bids, receives verified output.
- **Provider / Node operator** — Sells compute: posts a bond (USDC in v1; GIX
  post-MVP), mints credits, runs the node, gets paid or slashed.
- **Governance** — Manages protocol parameters, measurement/cert allowlists, fee
  schedule, and upgrade authority — via an `AdminCap`/multisig in v1 (token-weighted
  governance is post-MVP). See [tokenomics.md](tokenomics.md).
