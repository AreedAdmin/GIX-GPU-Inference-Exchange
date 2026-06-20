# GIX Documentation

This is the production engineering plan for the **GPU Inference Exchange (GIX)** — a
decentralized spot market for GPU inference settled on **Sui**, matched on
**DeepBook**, and audited on **Walrus**. The repository is documentation-first; this
plan is the spec the implementation is built against.

> **Questions needing your input** are consolidated in
> **[open-ended-questions.md](open-ended-questions.md)** — the single ledger of economic,
> policy, and design decisions that need a human answer. Each doc's "Open questions"
> section now points there by ID.

## Read in this order

1. **[Architecture Overview](architecture/overview.md)** — *Canonical.* Start here.
   System decomposition, the `gix` Move module map, the Sui object model, and the
   end-to-end job lifecycle. Every other document conforms to its names and flows.
2. **[Glossary](glossary.md)** — Canonical terminology and identifiers. Keep it open
   while reading the rest.

## By area

### Architecture & components
- **[Sui / Move Contracts](architecture/sui-move-contracts.md)** — Move package
  design: modules, object model, entry functions, events, capability-based access
  control, parallel-execution design, money handling, and upgradeability.
- **[DeepBook Integration](architecture/deepbook-integration.md)** — Tokenized
  Compute Credits, per-market `Credit/USDC` pools, order placement and matching,
  fill→Job conversion, and high-frequency / micro-transaction considerations.
- **[Walrus Integration](architecture/walrus-integration.md)** — Model registry and
  content addressing, input/output and attestation-quote storage, the audit trail,
  availability/retention, and integrity verification.
- **[Verification & Attestation](architecture/verification-attestation.md)** — The
  trust model: hardware TEE remote attestation, quote contents, on-chain
  verification, slashing triggers, and why zkML is a v1 non-goal.
- **[Node Architecture](architecture/node-architecture.md)** — The Rust provider
  node: crate layout, inference runtime adapters, TEE integration, Sui/DeepBook/
  Walrus clients, SLA metering, and fault tolerance.
- **[TypeScript SDK](architecture/sdk.md)** — Consumer and provider client API, the
  end-to-end order flow, and independent client-side verification of settled jobs.

### Protocol
- **[Task Lifecycle & State Machine](protocol/task-lifecycle.md)** — The
  authoritative job state machine: states, deadlines, the full transition table,
  fund/credit/slashing accounting, idempotency, and concurrency.

### Economics & security
- **[Tokenomics](tokenomics.md)** — The three-asset economy (USDC / GIX / Compute
  Credits), staking and slashing economics, fees, emissions, economic security, and
  bootstrapping.
- **[Threat Model](security/threat-model.md)** — Assets, trust boundaries, the STRIDE
  threat catalog, mitigations, the explicit residual risks, and the security process.

### Operations
- **[Deployment & Operations](operations/deployment.md)** — Networks and config,
  contract deployment and upgrade runbooks, the node operator runbook, monitoring,
  and incident response.

### Plan
- **[Roadmap](roadmap.md)** — Phased plan from devnet MVP to mainnet, with explicit
  production-readiness gates.

## Locked v1 decisions (source of truth)

These were settled at project initialization and constrain every document above:

| Decision | Choice |
| --- | --- |
| Verification | Hardware **TEE remote attestation only** (no zk, no re-execution). zkML = future research. |
| Privacy | **Integrity-only** in v1. Confidential markets = future. |
| Matching | **DeepBook** CLOB over **tokenized Compute Credits**. |
| Quote / settlement asset | **USDC** (Circle-native on Sui). |
| Native token | **GIX deferred to post-MVP.** v1 has no token: bonds are **USDC**, governance is an `AdminCap`/multisig, fees are USDC. GIX (staking, token governance, emissions) lands as an additive upgrade. |
| Contracts | Sui **Move** package `gix`. |
| Off-chain | **Rust** node + services, **TypeScript** SDK. |

A change to any of these is a cross-cutting change: update
[architecture/overview.md](architecture/overview.md) and the
[glossary](glossary.md) first, then propagate.
