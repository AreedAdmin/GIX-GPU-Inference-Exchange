# M2 Phase 0 — Design Spike (research-grounded)

Two doc-grounded research passes (bundled DeepBook v3 + Walrus docs) + a dependency probe.
SDKs available: `@mysten/deepbook-v3@1.5.1`, `@mysten/walrus@1.2.1`, `@mysten/sui@2.19.0`.

## The crux: payment model — research changed the recommendation

**Finding (DeepBook):** DeepBook has **no third-party-escrow hook**. Every fill moves funds to
the **maker's / taker's own `BalanceManager`** (order path) or returns loose `Coin`s (swap path).
There is **no native way to route a taker's USDC into a GIX-controlled escrow at fill.** GIX's own
`deepbook-integration.md` §9 already flags this exact reconciliation as an open question with
"direct settlement implications."

**Consequence:** my earlier rec (*escrow-until-verified + assigned-from-fill*) is **not cleanly
compatible with using DeepBook as the settlement rail.** Held-escrow and DeepBook-as-payment are
mutually exclusive. So the real choice is:

### Option B (RECOMMENDED) — pay-at-match + stake-guarantees-delivery
- Provider (maker) posts a resting **ask** (sells minted `Credit<M>`). Consumer **swaps USDC→Credit
  atomically in a PTB**, then feeds the returned `Credit` into `gix::create_job` in the **same PTB**
  (DeepBook swap returns loose `Coin`s usable by the next command — confirmed).
- The **USDC pays the maker at fill** (the price of the capacity claim). The **serving provider is
  the maker the order filled against** (identified via `maker_balance_manager_id → owner()`), bound
  to deliver, **stake-backed**.
- On failure (invalid/missing/SLA): the provider is **slashed → consumer refunded from the slash**.
  The `k`-ratio (stake ≥ k × value-at-risk) guarantees the refund is covered.
- **Credits are single-use** (no secondary market in M2) so the maker-on-fill is always the original
  provider-minter → "assigned-from-fill" holds. (Reselling fungible credits would break the
  server↔credit link; deferred.)
- **Trade-off vs M1:** consumer protection shifts from *held escrow* → *stake/slash refund*. Same
  cryptographic verification; the difference is who holds the money in the interim. This is the
  standard staking-secured model and is the **natural, native DeepBook fit**.

### Option A (alternative) — keep held-escrow, DeepBook = price oracle only
- Use DeepBook only to discover the spot price; route the consumer's USDC into `gix::escrow` at
  `create_job`; the credit is priced nominally. Preserves M1's "paid-for-what-was-run."
- **Cost:** it's no longer *real* DeepBook matching/settlement (DeepBook becomes a price feed), the
  economics get awkward (credit price ≠ work price), and it's more custom plumbing. Weaker realism
  for the "real exchange" investor story.

**Recommendation: Option B.** It's the only model that makes DeepBook the actual matching+settlement
engine; the slash-refund + `k`-ratio preserves consumer protection.

## Pinned interface (assuming Option B)
```move
// PTB-composed: deepbook::pool::swap_exact_quote_for_base<Credit<M>,USDC>(...) -> (Coin<Credit<M>>, Coin<USDC>, Coin<DEEP>)
// then, same PTB:
public fun create_job_from_fill<M>(
    cfg: &Config, market: &Market<M>, provider_rec: &ProviderRecord,
    credits: Coin<Credit<M>>,            // from the swap (reserve-then-burn)
    input_blob_id: u256, input_hash: vector<u8>,
    clk: &Clock, ctx
): ID                                     // shares the Job, provider = filled maker
// settlement: on Verified, burn credits + finalize; on fault, refund-from-slash. (provider already paid at fill)
```
Provider↔BalanceManager bound at registration so the fill's `maker_balance_manager_id` resolves to
the obligated server. One taker order can fill across N makers → **N jobs** (SDK aggregates, E4).

## Other confirmed facts (feed the build)
- **DeepBook:** one shared `Pool` per pair; permissionless pool = **500 DEEP**; **input-token fees**
  via `pay_with_deep:false` (a doc note says "must be true" — *stale*, verify against live v6).
  **Lot size must be a power of 10, ≥ 1000 MIST of base** → constrains `Credit<M>` decimals so 1 SCU
  is a valid lot. Live book reads + recent fills via the SDK + public **DeepBook indexer** (testnet
  `deepbook-indexer.testnet.mystenlabs.com`). **Testnet package IDs are NOT in the bundled docs** —
  read them from `@mysten/deepbook-v3/src/utils/constants.ts`.
- **Walrus:** `client.walrus.writeBlob/readBlob`; availability gate = on-chain **`Blob.certified_epoch`
  (PoA)**; **`blob_id` is a commitment, not a content hash** → keep GIX's `sha2_256`. ~**5x** encoded
  blowup, $0.023/GB/mo in WAL; **shared blobs** = treasury-sponsored retention; **Quilt** for small
  I/O (but quilt members lose stable content-addressing). The **4.6 GB model fits as a single regular
  blob** (< 13.3 GiB; > 4 GiB quilt-member cap, so not a quilt member). Provider fetches model →
  recomputes GIX `model_hash` → refuses on mismatch. No `walrus` binary → use the SDK.
- **⚠️ SDK version risk:** the Walrus/DeepBook 2.0 SDKs (`SuiGrpcClient`, `$extend(walrus())`) want
  **`@mysten/sui` 2.x**, but GIX pins `@mysten/sui ^1.x`. M2 likely needs a coordinated **`@mysten/sui`
  → 2.x bump** across packages, or pinning SDK versions compatible with sui 1.x. Resolve before fan-out.
- **Network:** DeepBook + Walrus are **testnet-only** (not localnet) → M2 live integration is on
  **testnet** (test SUI via captcha faucet; test DEEP from SDK constants; WAL via `get-wal` swap).

## Remaining decisions (carry into the build)
Payment model (B vs A — **the gate**) · `Credit<M>` decimals/lot sizing · input-token-fee vs DEEP ·
escrow-refund sizing vs `k` · Walrus retention epochs + Quilt usage · the `@mysten/sui` 2.x bump.
