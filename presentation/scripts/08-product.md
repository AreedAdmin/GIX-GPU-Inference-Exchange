# Slide 08 — Product surfaces (how you use it)

**On screen:** Four cards — Gateway, Web console, SDK, Provider node + GPU-less client; closing line about the wedge.

**Duration:** ~75s

---

## Script

So how do you actually use GIX? There are four surfaces.

**The OpenAI-compatible gateway.** This is the easiest on-ramp for AI builders: point your existing OpenAI client at our endpoint and you're done. Behind it, the gateway handles matching, escrow, attestation, and settlement — **USDC in, verified tokens out.** No wallets or PTBs to think about.

**The web trading console.** This is the full market view: a markets sidebar that toggles between **GPU Compute** and **Crypto Pairs**, an order book, an order ticket, your wallet with real balances, the built-in **SUI→USDC on-ramp**, and a result viewer that **hash-verifies** the output you got back.

**The TypeScript SDK.** For programmatic use: quote, order, await, fetch, and then **independently verify**, plus the full provider flow. It's trust-minimized by design — nothing is reported as "verified" unless it actually checks out against the chain and Walrus.

**The provider node and the GPU-less client.** A provider serves real inference through the Ollama runtime and signs attestations; a buyer on a *different* machine purchases on-chain and verifies the result. That's the **buyer-≠-seller** proof — two parties, no shared trust.

And to be clear about positioning: the wedge isn't *cheapest tokens* — you can't beat hyperscale inference APIs on raw price. The wedge is **verifiable, neutral, pay-per-use** compute, for the workloads that actually need it: **agents, regulated and audit-heavy use cases, bursty demand, and long-tail or custom models.**

> **Transition:** "Here's where we are, and where we're headed."
