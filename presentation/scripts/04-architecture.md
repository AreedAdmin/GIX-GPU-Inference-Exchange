# Slide 04 — Technical architecture (in layers)

**On screen:** Six stacked layers, L1 → L6, with L2 (Sui · gix) and L6 (Hardware TEE) highlighted.

**Duration:** ~90s

---

## Script

Here's the whole system as a stack of **six layers**. I'll go top to bottom.

**L1 — Experience.** This is what people touch: a **web trading console**, an **OpenAI-compatible gateway** so existing AI apps plug in unchanged, a **TypeScript SDK**, and a **GPU-less client** for the two-machine demo.

**L2 — Settlement and logic: the `gix` Move package on Sui.** This is the brain and the only place with authority. It's a set of Move modules — `market` and `credit` for the tokenized markets, `job` and `escrow` for the unit of work and its locked funds, `attestation` for on-chain verification, `settlement`, `staking` and `slashing` for the economics, and `governance` for protocol parameters. *Everything else in the stack is convenience or supply — authority concentrates here.*

**L3 — Matching: DeepBook v3.** The `Credit / USDC` central limit order book. Price-time priority, a live spot price.

**L4 — Storage and audit: Walrus.** Content-addressed blobs for the model, input, output, and attestation quote, plus an on-chain availability certificate. Sui holds the hashes; Walrus holds the bytes.

**L5 — Execution: the provider node.** It pulls the model and input, runs the inference through a **runtime adapter — currently Ollama** — meters the SLA, and produces the output.

**L6 — Trust: the hardware TEE.** The execution happens inside a Trusted Execution Environment that signs a quote. v1 targets **Intel TDX**, whose signatures Sui can verify natively; **NVIDIA GPU Confidential Computing** verification is the next step. The enclave's signature is what L2 checks on-chain.

The key takeaway: **each layer sits behind a clean interface, so it's swappable** — a different runtime, a different storage layer — but the trust and the money always resolve in L2, on Sui.

> **Transition:** "Now let's trace a single job through those layers, start to finish."
