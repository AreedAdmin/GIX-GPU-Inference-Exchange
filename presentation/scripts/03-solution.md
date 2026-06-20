# Slide 03 — The solution

**On screen:** "A neutral, verifiable exchange for compute" + a value-flow diagram (3 GPU providers → *provides spare compute* → **GIX** → *provides compute* → User) + three cards: 01 Match (DeepBook), 02 Verify (TEE), 03 Settle (Sui + Walrus).

**Duration:** ~70s

---

## Script

GIX is **a neutral, verifiable exchange for compute** — and it's built on three Sui-native substrates that form one loop: **match, verify, settle.**

**Match — on DeepBook.** Each market tokenizes compute capacity as a fungible "credit" that trades against USDC on **DeepBook**, Sui's on-chain central limit order book. That gives us a real, continuous **spot price** for compute — no auctions, no list prices, just supply meeting demand.

**Verify — with hardware attestation.** When a provider runs your job, the hardware produces a **signed attestation** — a cryptographic quote that says *this exact model ran on this exact input and produced this output.* We verify that quote **on-chain**. So you're paid-for-what-was-run: settlement only happens if the proof checks out.

**Settle — on Sui, audited on Walrus.** The consumer's USDC sits in **escrow** and is released only against a verified proof. Every artifact — the model, the input, the output, the attestation — is stored on **Walrus**, content-addressed, so there's a tamper-evident audit trail anyone can check.

One principle ties it together: **off-chain software is for UX and liveness only — it holds no authority.** No relayer, no gateway, no indexer can move funds or fake a result. Settlement is decided **solely on-chain**. That's what makes GIX neutral market *infrastructure* rather than just another vendor.

> **Transition:** "Let me show you how those pieces stack up — the architecture, in layers."
