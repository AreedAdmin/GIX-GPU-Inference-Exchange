# Slide 01 — Intro / What we built

**On screen:** GIX title, the one-line thesis, six "what we built" chips, "Live on Sui testnet."

**Duration:** ~60s

---

## Script

Good [morning/afternoon]. This is **GIX — the GPU Inference Exchange**.

In one sentence: GIX is a **decentralized, hardware-verified spot market for GPU inference, settled on Sui**. Compute gets matched on an order book, every job is *proven* by a hardware attestation that's verified on-chain, and payment settles automatically — so you don't have to trust any single provider, and you're not stuck with a black-box API.

The important thing to know up front: **this is a working build, not a concept deck.** We've shipped six pieces and wired them together end to end:

- the **`gix` Move package** on Sui — the on-chain settlement logic,
- a **provider node** that runs real inference and produces attestations,
- an **OpenAI-compatible gateway** so any AI app can plug in,
- a **TypeScript SDK**, a **web trading console**, and a **simulation harness**.

A full vertical slice runs today — a real model is purchased on-chain, executed, attested, settled, and the result is hash-verified — and it's **live on Sui testnet**.

Over the next few minutes I'll cover the problem we're solving, the architecture in layers, how a single job flows through the system, the key features, and where this is going.

> **Transition:** "So let's start with *why* — what's actually broken about how we buy compute today."
