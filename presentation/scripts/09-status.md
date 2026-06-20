# Slide 09 — Status & roadmap

**On screen:** Left = "Shipped" list; right = "What's next" list; footer = testnet package id.

**Duration:** ~70s

---

## Script

Let me ground this in what's actually done versus what's ahead.

**Shipped, and live on testnet:**

- The **`gix` Move package** — 14 modules with a test suite — deployed to Sui testnet.
- **Real DeepBook v3 matching and Walrus storage** — that was our M2 milestone, replacing the early stand-ins with the real systems.
- The **provider node** with Ed25519 attestation signing and an Ollama runtime.
- The **gateway, SDK, web console, and simulation harness.**
- The **two-machine demo** — buyer and seller on separate machines — and the **SUI→USDC on-ramp.**

So the full loop runs today: real inference, bought on-chain, attested, settled, hash-verified.

**What's next:**

- **Real TEE attestation — milestone M3.** Hardening from the current soft attestation to genuine **Intel TDX**, then **NVIDIA GPU-CC** verified on-chain.
- An **external security audit** and economic-security modeling of the staking and slashing parameters.
- **Mainnet launch.**
- **Confidential markets** — using **Seal** to seal inputs and outputs to the attested enclave, so the operator can't even see the data — and **tradeable credits** for a secondary market.

The honest status: the architecture and the full software stack are built and demonstrable; the path from here is hardening the trust root and getting audited before real value is at stake.

> **Transition:** "Let me close on why this matters."
