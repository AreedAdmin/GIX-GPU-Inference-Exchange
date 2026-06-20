# MVP M2 — Scope & Plan: Real DeepBook Matching + Walrus Storage

**Goal:** replace the two M1/E stand-ins with the real systems —
- the hand-rolled shared **`Ask`** → **DeepBook v3 CLOB** (real bids/asks, depth, price-time priority),
- the node's **HTTP `/inputs` + `/result`** → **Walrus** (durable, content-addressed, auditable I/O).

**Runs on testnet** (DeepBook + Walrus are both live there — no mainnet needed). Trust stays soft
(TEE = M3); inference + the core job lifecycle are unchanged.

---

## ⚠️ Phase 0 — Design spike (DO THIS FIRST): payment + provider-dispatch model

This is the one hard fork, and everything else depends on it. **DeepBook makes `Credit<M>` fully
fungible** (it must be, to trade in a single pool), which **decouples "who bought" from "who
serves."** Two coupled questions:

**(a) When is the provider paid?**
- **Pay-at-match:** the consumer's USDC goes to the provider on the DeepBook fill; the provider's
  **stake guarantees delivery** (failure → slash → consumer refunded from the slash). Simpler;
  weaker consumer protection.
- **Escrow-until-verified (today's model):** USDC held by GIX until the job is verified; DeepBook is
  used only for **matching + price discovery + provider selection**. Preserves GIX's core promise
  ("paid-for-what-was-run"). More PTB plumbing.

**(b) Which provider serves a fungible-credit job?**
- **Assigned-from-fill:** the **maker whose ask filled** is the obligated server (their stake is at
  risk). Natural with DeepBook's fill data.
- **Open-claim queue:** any staked provider claims an open job. More like a worker pool; more moving
  parts (claim races, re-claim on timeout).

**Recommendation:** **escrow-until-verified + assigned-from-fill.** Keep the consumer-protective
escrow (it's a core value prop), and assign the job to the maker(s) the taker's order filled
against (read from the DeepBook fill, stake-backed). A single market order can fill across several
makers → **one buy may create several jobs** (ties to open question E4 — SDK aggregates them).

**Deliverable of Phase 0:** a 1-page design note + the new contract interface
(`create_job_from_fill<M>`, settlement changes), pinned before any building. ~the only "thinking"
part of M2; the rest is integration.

---

## Workstream A — DeepBook matching

| Layer | Change |
|---|---|
| **contracts/** | Bind `deepbook_pool_id` into `Market`; add `create_job_from_fill<M>` (PTB-composed with a DeepBook swap/fill — `swap_exact_quote_for_base` returns real `Coin`, all-or-nothing, so no trusted relayer); settlement assigns/pays the filled maker; **deprecate the `ask` module**. Capacity-mint-against-stake stays. |
| **node/** | Replace `post_ask` with DeepBook **limit-order management** (a `BalanceManager`, place/cancel/replace asks); serve loop unchanged. Use **input-token fees** (`pay_with_deep:false`) so the node doesn't need DEEP per trade. |
| **pools** | Create one DeepBook `Credit<M>/USDC` pool per market (permissionless = 500 DEEP, or a whitelisted pool). **Consolidate markets** to amortize per-pool cost (open question E2). |
| **sdk/ + gateway + no-gpu-client** | Buy = **swap → create_job** PTB (replaces `create_job_from_ask`). One SDK change flows to the gateway + the Mac client + the UI. |
| **web/** | Swap `MarketDataSource` from the synthetic WS feed → a **DeepBook reader** (live book, depth, real trades, real sell side). **UI components/design unchanged** (this is exactly what that abstraction was built for). |
| **harness/** | Place real DeepBook orders (replaces the stubbed matcher + synthetic `--serve` book). |

**New considerations:** DEEP token (or input-token fees), and **real two-sided liquidity** matters
now — a CLOB with no resting asks gives bad fills, so providers must keep asks posted
(market-making / bootstrapping).

## Workstream B — Walrus storage

| Layer | Change |
|---|---|
| **node/** | Upload **output** (+ attestation quote) to Walrus → `blob_id`; read **input** from Walrus by `blob_id`. The `/inputs`+`/result` HTTP server becomes optional (keep `/health`). |
| **sdk/ + clients** | Upload **input** → Walrus → pass `blob_id` in the job; **download output** from Walrus + re-hash (sha2_256) to verify. Provider-HTTP client → Walrus client. |
| **contracts/** | Store input/output/quote `blob_id`s alongside the existing hashes (**additive** fields); optionally gate dispatch on the **`BlobCertified`/PoA** availability event (open question D4). |
| **model registry** | Upload the **real model weights** (the 4.6 GB `llama3.1:8b` GGUF, `sha256:667b0c19…`) to Walrus; bind the **real `model_hash` + `walrus_blob_id`** in `ModelRecord` (replaces today's placeholder strings) → genuinely verifiable "correct model ran." Fits under Walrus's ~13.3 GiB blob cap. Pin the **quantization** (8B@Q4 ≠ 8B@fp16). |
| **infra** | Add a Walrus client (TS SDK / upload-relay — **no `walrus` binary installed**, use the SDK); WAL token for storage (or **treasury-sponsored shared blobs**, open question H1). Quilt for small per-job I/O (H3). |

**Keep GIX's own `sha2_256` hashes** for on-chain binding — a Walrus `blob_id` is a *commitment*
(encoding‖length‖merkle-root), not a plain content hash, so it's for retrieval, not verification.

---

## Sequencing & parallel build
1. **Phase 0 design spike** (resolve payment/dispatch; pin `create_job_from_fill` + settlement).
2. **Parallel agents** against the pinned interface (same pattern as M1/E):
   - **A1 (sui-pilot):** DeepBook contracts — pool binding, `create_job_from_fill`, settlement, deprecate `ask`.
   - **A2:** node — DeepBook order management + Walrus I/O.
   - **A3:** Walrus — contract blob-id fields + model-on-Walrus + SDK/client Walrus upload/download.
   - **A4:** buy-path (sdk/gateway/no-gpu-client) + the **web DeepBook book reader**.
3. **Integration on testnet:** deploy package, create a real pool, seed liquidity (provider asks),
   one real swap→job→served→settled, UI shows the live book. Needs test SUI (captcha faucet) + test
   DEEP + test WAL.

## Decisions M2 forces (parked questions it activates)
- **Payment/dispatch model** (Phase 0) · **E2** market granularity / 500-DEEP-per-pool · **H1**
  storage cost-bearer · **D4** input-availability via PoA · **H3** sharding/Quilt · DEEP handling
  (input-token fees vs holding DEEP) · liquidity bootstrapping.

## Definition of done
- A real DeepBook `Credit/USDC` pool with resting liquidity; a consumer **swap fills against a real
  provider ask → job → GB10 serves → settled**, on **testnet**, with the **UI showing the live
  book + depth**.
- Inputs/outputs on **Walrus**, retrievable + hash-verified by an independent party; **model weights
  on Walrus** with a real `model_hash`.
- The Mac/no-gpu-client + OpenAI gateway buy flows work against the real CLOB + Walrus.

## What M2 does NOT change
- Soft attestation (hardware **TEE = M3**); the node's inference; the job lifecycle; the UI's look.

## Honest effort note
Bigger than the E-phase: **two external systems** (DeepBook + Walrus) + the **Phase-0 design fork**
+ **token costs** (DEEP/WAL) + **liquidity**. But the per-component changes are contained seams the
abstractions already anticipate, so once Phase 0 is pinned it parallelizes cleanly.
