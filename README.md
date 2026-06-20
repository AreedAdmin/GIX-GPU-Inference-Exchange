# GPU Inference Exchange (GIX)

> A decentralized, production-grade **spot market for GPU inference**, settled on Sui.

The GPU Inference Exchange (**GIX**) commoditizes computational power. It replaces
centralized cloud provisioning with an algorithmic spot market: compute capacity
becomes a liquid asset traded on a central limit order book (CLOB), and every job
is governed by hardware-attested verification and autonomous on-chain settlement
rather than trust in a single provider.

This repository is currently **documentation-first**. It contains the full
production engineering plan — architecture, protocol, tokenomics, threat model,
and roadmap — that the implementation will be built against.

---

## The thesis

| Layer | Technology | Role |
| --- | --- | --- |
| **Matching** | **DeepBook** | Central limit order book where tokenized compute supply meets demand continuously, establishing a real-time spot price without auction latency. |
| **Storage & Audit** | **Walrus** | Decentralized storage for model artifacts, job inputs/outputs, and attestation evidence — the tamper-evident audit trail. |
| **Orchestration & Settlement** | **Sui** | Move smart contracts enforce market rules, escrow consumer funds, verify node attestations, and settle payment or slash collateral autonomously. |

Because each inference job and its escrow are independent Sui objects, the protocol
settles thousands of compute transactions in parallel with sub-second finality.

## How a job flows (one paragraph)

A provider mints **Compute Credits** for its market and posts asks on a DeepBook
pool priced in **USDC**. A consumer's bid is matched; Sui locks the consumer's
USDC in **escrow** and binds a **Job** object to the fill. The provider's node
pulls the input from Walrus, runs the exact attested model inside a hardware TEE,
writes the output and a signed **attestation quote** back to Walrus, and submits
the attestation to Sui. The `attestation` contract verifies the vendor signature
chain, the model/input/output hash binding, and the latency SLA. On success the
escrow is released to the provider; on a missing or invalid attestation the
consumer is refunded and the provider's staked **GIX** collateral is slashed.

See **[docs/architecture/overview.md](docs/architecture/overview.md)** for the full picture.

---

## Core design decisions

These are locked for v1 and are the source of truth for every other document:

- **Verification — hardware TEE remote attestation only.** Confidential-computing
  GPUs (e.g. NVIDIA H100/H200 CC) plus a CPU TEE (Intel TDX / AMD SEV-SNP) produce
  a vendor-signed quote binding the runtime measurement, model hash, input hash,
  output hash, and execution timestamps. Sui verifies the signature chain against a
  governance-managed measurement allowlist. **No zero-knowledge proofs and no
  re-execution challenges in v1.** zkML is an explicit non-goal tracked as future
  research (see [verification doc](docs/architecture/verification-attestation.md)).
  *(v1 MVP scope, 2026-06: CPU TEE = **Intel TDX (P-256)** only — natively verifiable on
  Sui; **AMD SEV-SNP deferred** (P-384) and **on-chain GPU-CC verification phased to a
  post-MVP fast-follow**. See verification doc §4.)*
- **Privacy — integrity-only in v1.** The TEE attests *correct execution*, not data
  secrecy; operators may observe inputs. Confidential markets (TEE-isolated I/O) are
  a roadmap item, not a v1 guarantee.
- **Market — tokenized Compute Credits.** Each market is a `(GPU class, model/runtime
  tier, SLA class)` tuple with its own fungible Compute Credit coin, traded against
  **USDC** on a DeepBook pool.
- **Settlement asset — USDC** (Circle-native on Sui). **Native token — GIX** for
  provider staking/collateral, governance, and fee economics.
- **Stack —** Sui **Move** contracts (`gix` package), **Rust** node + off-chain
  services, **TypeScript** SDK.

---

## Repository layout

```
gpu-inference-exchange/
├── contracts/   # Sui Move package `gix` (markets, escrow, attestation, settlement…)
├── node/        # Rust GPU node — the provider software (inference + attestation)
├── services/    # Rust off-chain services (indexer, matching relayer, settlement watcher)
├── sdk/         # TypeScript SDK for consumers and providers
├── examples/    # Sample consumer & provider integrations
├── ops/         # Deployment / infrastructure (future)
└── docs/        # The production engineering plan (start here)
```

## Documentation index

Start with the overview, then read by area. See **[docs/README.md](docs/README.md)**
for the annotated index.

| Document | What it covers |
| --- | --- |
| [Architecture Overview](docs/architecture/overview.md) | System architecture, components, end-to-end lifecycle, object & module map. **Canonical.** |
| [Sui / Move Contracts](docs/architecture/sui-move-contracts.md) | Move package design, modules, object model, entry functions, events, parallelism, upgradeability. |
| [DeepBook Integration](docs/architecture/deepbook-integration.md) | Compute-credit tokenization, market/pool structure, order placement & matching, price discovery. |
| [Walrus Integration](docs/architecture/walrus-integration.md) | Model registry, content addressing, I/O & attestation blob storage, availability, audit trail. |
| [Verification & Attestation](docs/architecture/verification-attestation.md) | TEE hardware, attestation flow, quote contents, on-chain verification, slashing triggers, zkML non-goal. |
| [Node Architecture](docs/architecture/node-architecture.md) | Rust provider node: agent, runtime adapters, attestation, Walrus/Sui clients, SLA metering. |
| [TypeScript SDK](docs/architecture/sdk.md) | Consumer/provider client API, order flow, job submission, result & audit retrieval. |
| [Task Lifecycle & State Machine](docs/protocol/task-lifecycle.md) | Detailed job state machine, timeouts, edge cases, settlement/refund/slash paths. |
| [Tokenomics](docs/tokenomics.md) | USDC settlement, GIX token, Compute Credits, staking, fees, emissions, incentives. |
| [Threat Model](docs/security/threat-model.md) | Assets, trust boundaries, per-component threats, mitigations, economic & TEE risks, residual risk. |
| [Deployment & Operations](docs/operations/deployment.md) | Networks, contract deployment, node operator runbook, monitoring, incident response. |
| [Roadmap](docs/roadmap.md) | Phased plan from devnet MVP to mainnet, with production-readiness gates. |
| [Glossary](docs/glossary.md) | Canonical terminology and identifiers. |

---

## Status

**Phase 0 — Design.** No code yet; this is the engineering plan. The implementation
roadmap and production-readiness gates are in [docs/roadmap.md](docs/roadmap.md).

## License

To be determined before first public release.
