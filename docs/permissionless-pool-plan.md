# Permissionless DeepBook Pool — Implementation Plan

**Goal:** stand up the real `Credit<M> / DBUSDC` DeepBook v3 pool on **testnet** so the order
book, tape, and price become **live** (not the mock simulator), and consumer buys execute a
real on-chain `create_job_from_fill` → real Jobs in History.

**Status:** Plan. The republish + market creation are already scaffolded
([`contracts/scripts/stage-testnet-dbusdc.sh`](../contracts/scripts/stage-testnet-dbusdc.sh));
pool creation + binding are the new pieces ([`sdk/scripts/create-deepbook-pool.ts`](../sdk/scripts/create-deepbook-pool.ts)).

---

## Does this fix the "simulated market / history" situation?

Yes — these are the two switches:

| Surface | Today (no pool) | After this plan |
| --- | --- | --- |
| **My Jobs / History** | mock job feed gated off on live → shows only your real in-session jobs (already fixed) | real fills create real Jobs → real history |
| **Order book · tape · price** | mock simulator (`VITE_DATA_SOURCE=mock`) | **real** (`VITE_DATA_SOURCE=deepbook`, reads the live pool/indexer) |
| **Buy → Job** | blocked: `create_job_from_fill` aborts `ENoPool` (202) | works: PTB swaps on the pool, pays the provider, creates the Job |

> **Caveat — cross-session history.** Even with the pool live, the web app only records Jobs
> created **in the current session**. A full historical backfill needs a separate on-chain
> query (your `Job` objects / `JobCreated` events for your address) on connect — tracked as a
> follow-up, *not* part of this plan.

---

## ⚠️ The gate: DEEP, not SUI

Permissionless pool creation costs a fixed **500 DEEP** (input-coin fees don't apply to the
*creation* fee). Current testnet balance: **54 SUI / 1000 mUSDC / 0.49 WAL / 0 DEEP**. So the
hard prerequisite is acquiring **≥ 500 DEEP** on testnet. Everything else is gas-only.

---

## Phase 0 — Prerequisites (the DEEP gate) — ⛔ CURRENTLY BLOCKED

Permissionless pool creation costs **500 DEEP**. We need ≥ 500 DEEP on the admin address.

**Findings (measured 2026-06, testnet):**

| Fact | Value |
| --- | --- |
| DEEP coin type (testnet) | `0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP` |
| `DEEP_SUI` pool | `0x48c95963e9eac37a316b7ae04a0deb761bcdcc2b67912374d6036e7f0e9bae9f` (price ≈ 0.0238 SUI/DEEP) |
| `DEEP_SUI` ask depth | **≈ 20 DEEP** total |
| `DEEP_DBUSDC` ask depth | **≈ 20 DEEP** total |
| Admin DEEP balance | **0** |

**Result: the swap route can't reach 500 DEEP** — total DEEP liquidity on testnet DeepBook is
~20 DEEP. A 13-SUI `swapExactQuoteForBase` with a 500-DEEP floor aborts
(`pool::swap_exact_quantity` abort 12 — min-out unmet). The DEEP package exposes no public
faucet/mint. So **Phase 0 is blocked on DEEP supply, not on SUI.**

**Ways to actually get 500 testnet DEEP (manual / external):**
1. **Request from Mysten** — DeepBook team / Sui Discord developer channels; the DeepBook
   Predict testnet token-request form (`https://tally.so/r/Xx102L`) hands out testnet assets —
   ask whether it can include DEEP, or request DEEP directly.
2. **Accumulate via repeated small swaps** as the `DEEP_SUI` book refills (impractical for 500
   — only ~20 available at a time).
3. **Wait for deeper DEEP liquidity** on testnet.

Helper (works once liquidity/DEEP exists): [`sdk/scripts/get-deep.ts`](../sdk/scripts/get-deep.ts)
swaps SUI→DEEP on `DEEP_SUI` (set `GIX_SUI_IN` / `GIX_MIN_DEEP`).

> **Fallback while blocked (recommended for the demo):** keep `VITE_DATA_SOURCE=mock` for the
> market view and demo the **buy path** via the hand-rolled shared-`Ask` route (no pool, no
> DEEP needed — already implemented). The real-pool upgrade (Phases A–F) lands the moment 500
> DEEP is in hand.

---

## Phase A — Stand up the DBUSDC package + market (gas-only, no DEEP)

Run the existing staging script with execute:

```bash
sui client switch --env testnet
bash contracts/scripts/stage-testnet-dbusdc.sh --confirm
```

It republishes the **quote-coin-parameterized** `gix` package, publishes `Treasury<DBUSDC>`,
turns `is_localnet=false`, registers the Qwen model, creates the **GB10·Qwen** market, and
writes `deployment.testnet.staged.json` with `deepbookPoolId: null`.

**Capture from its output:** `PKG`, `MARKET_ID`, `ADMIN_CAP_ID`, the credit witness type
`PKG::markets::M_GB10_QWEN35B`, and `DBUSDC_TYPE`
(`0xf7152c05…::DBUSDC::DBUSDC`).

*(The pool's base coin must come from THIS republished package — its `Credit<M>` settles in
DBUSDC, matching the pool's quote. The live `0x0ed2…` package settles in MOCK_USDC and is left
untouched.)*

---

## Phase B — Create the permissionless pool (the 500-DEEP step)

Create `Credit<M_GB10_QWEN35B> / DBUSDC` via the DeepBook SDK
([`sdk/scripts/create-deepbook-pool.ts`](../sdk/scripts/create-deepbook-pool.ts)):

```bash
# dry run (prints the exact plan, touches nothing):
npx tsx sdk/scripts/create-deepbook-pool.ts
# execute (pays 500 DEEP, prints the new pool id):
npx tsx sdk/scripts/create-deepbook-pool.ts --confirm
```

**Pool params (SCU micro-trading):**

| Param | Value | Why |
| --- | --- | --- |
| `base` | `Credit<M_GB10_QWEN35B>` (1 credit = 1 SCU) | the tradable capacity unit |
| `quote` | `DBUSDC` (6 dp) | the testnet dollar |
| `lotSize` | **1 SCU** | a single task is one lot |
| `minSize` | **1 SCU** | allow single-task buys (respect DeepBook's protocol min) |
| `tickSize` | fine enough for a sub-cent SCU (e.g. `0.0001` DBUSDC/SCU) | competitive spread without dust levels |

> Lot/tick/min must satisfy DeepBook's protocol constraints (lot/tick are powers of 10; the
> protocol enforces a minimum order notional — the on-ramp pool, for example, enforced a 1-SUI
> floor). The script prints DeepBook's accepted bounds before committing.

Capture the printed **`POOL_ID`**.

---

## Phase C — Bind the pool + enable fees

1. **Bind to the market** (step 6 of the staging script):
   ```bash
   sui client call --package $PKG --module market --function set_deepbook_pool_id \
     --type-args $PKG::markets::M_GB10_QWEN35B \
     --args $ADMIN_CAP_ID $MARKET_ID $POOL_ID --gas-budget 50000000
   ```
   After this, `create_job_from_fill` no longer aborts `ENoPool`.
2. **DEEP price point (optional, recommended).** To let the pool *collect* fees in DEEP, run a
   cron calling `add_deep_price_point` every 1–10 min. Consumers paying fees in the **input
   coin** (DBUSDC, `pay_with_deep:false`) work **without** this — so it's optional for v1.
3. **Post-upgrade upkeep:** after any DeepBook package upgrade, call
   `update_pool_allowed_versions` on the pool or it stops accepting orders.
4. Set `deepbookPoolId` in `deployment.testnet.staged.json` (and promote to
   `deployment.testnet.json` once validated).

---

## Phase D — Seed liquidity (cold-start)

A pool with an empty book can't be filled. Stand up at least one provider:

1. **Stake** a USDC/DBUSDC bond and open capacity (`staking::stake`).
2. **Mint** `Credit<M>` against capacity (`staking::mint_credits` / the node flow).
3. Create a **`BalanceManager`**, deposit the credits, and **post resting asks** at a
   reference price (provider node's ask loop — point it at `POOL_ID`).
4. Keep ask quantity ≈ free GPU capacity (over-posting risks SLA-breach slashing).

---

## Phase E — Switch the app to real data + verify

Update `web/.env` (then **restart** the dev server — env loads at boot):

```ini
VITE_DATA_SOURCE=deepbook
VITE_DEEPBOOK_NETWORK=testnet
VITE_DEEPBOOK_POOL_ID=0x<POOL_ID>
VITE_DEEPBOOK_BASE_TYPE=0x<PKG>::credit::Credit<0x<PKG>::markets::M_GB10_QWEN35B>
VITE_DEEPBOOK_BASE_SCALAR=1
VITE_DEEPBOOK_QUOTE_TYPE=0xf7152c05…::DBUSDC::DBUSDC
VITE_DEEPBOOK_QUOTE_SCALAR=1000000
VITE_DEEPBOOK_INDEXER_URL=https://deepbook-indexer.testnet.mystenlabs.com
# point the order/job layer at the staged package:
VITE_PACKAGE_ID=0x<PKG>   VITE_CONFIG_ID=0x<CONFIG>   VITE_MARKET_ID=0x<MARKET_ID>
VITE_MARKET_CREDIT_TYPE=0x<PKG>::markets::M_GB10_QWEN35B   VITE_USDC_TYPE=0xf7152c05…::DBUSDC::DBUSDC
```

**Verify the loop:**
- Order book + tape + price now read from the live pool (no mock).
- Place a small buy (web or SDK) → a real DeepBook fill → a real `Job` → it appears in
  **History** (scoped to your wallet).
- Open the **audit drawer** → it re-verifies the job from Sui + Walrus.

---

## Phase F — Promote / rollback

- **Promote:** once validated, copy the staged manifest to `deployment.testnet.json` and
  commit; document the new package/pool ids.
- **Rollback (always available):** set `web/.env` `VITE_DATA_SOURCE=mock` to return to the
  simulator; the staging script never touched the live deployment, so nothing else changes.

---

## Checklist

- [ ] ≥ 500 DEEP on testnet (Phase 0)
- [ ] `stage-testnet-dbusdc.sh --confirm` run; PKG / MARKET_ID / CREDIT type captured (A)
- [ ] `Credit<M>/DBUSDC` pool created; POOL_ID captured (B)
- [ ] `set_deepbook_pool_id` bound; (optional) DEEP price-point cron (C)
- [ ] ≥ 1 provider staked + minted + resting asks (D)
- [ ] `web/.env` → `deepbook` + ids; dev server restarted; buy→Job→History verified (E)
- [ ] staged manifest promoted (F)

*Cross-references:* [deepbook-integration.md](architecture/deepbook-integration.md) ·
[onramp-dbusdc-plan.md](onramp-dbusdc-plan.md) ·
[m2-scope.md](m2-scope.md) · [pool-free-e2e-delivery-and-test-plan.md](pool-free-e2e-delivery-and-test-plan.md)
