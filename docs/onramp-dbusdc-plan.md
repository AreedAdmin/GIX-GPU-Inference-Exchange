# On-ramp + testnet dollar (DBUSDC) — design & plan

**Status:** Plan. Adds an in-app **SUI→USD on-ramp** and pins the **testnet quote dollar to
DBUSDC** so the on-ramp output equals what compute is priced in. Demonstrates the DeepBook
integration **live now, with no DEEP**. Conforms to canon: USDC remains *the* quote asset;
DBUSDC is the **testnet stand-in for USDC**, real USDC on mainnet, MOCK_USDC on localnet.

## Why
Users hold **SUI** (gas token) but compute is priced in **USDC**. An in-app swap lets them
fund a purchase without leaving the site. It also turns the "DeepBook works without our pool"
capability into a real feature: a SUI→dollar swap runs on an **existing** DeepBook pool, so it
needs **no DEEP** and works today.

## The dollar, per network (PINNED)
The quote/settlement/bond asset is the **same coin** as the on-ramp output, per network:

| Network | Quote dollar | On-ramp pool | Notes |
|---|---|---|---|
| **localnet** | `MOCK_USDC` (ours) | n/a (mint freely) | unchanged dev flow |
| **testnet** | **`DBUSDC`** `0xf7152c05…::DBUSDC::DBUSDC` | **`SUI_DBUSDC`** `0x1c19362ca5…` | only liquid USD + SUI pair on testnet (verified live) |
| **mainnet** | real **USDC** (Circle) | `SUI_USDC` | natively coherent; real USDC pools exist on mainnet |

**Real USDC on *testnet* is not usable** here: MOCK_USDC has no pool (our coin), and Circle's
testnet USDC has **no liquid DeepBook testnet pool** (those pools are mainnet-only). DBUSDC is
the honest, working testnet dollar — and transactions against it are **real on-chain testnet txns**.

**Design rule:** parameterize the quote coin as a **generic phantom type** in the contracts
(`Q`), instantiated per network (MOCK_USDC / DBUSDC / USDC). One codebase, no hardcoded dollar.
This replaces today's hardcoded `MOCK_USDC` in staking bond / settlement / refund / escrow.

## On-ramp flow (no DEEP)
1. User holds SUI. Widget: **"Get USDC"** → swap `SUI → DBUSDC` on `SUI_DBUSDC`.
2. DeepBook swap PTB, **input-coin fees** (`pay_with_deep: false`) → no DEEP needed.
3. User now holds DBUSDC → buys compute (priced in DBUSDC) via the existing buy path.
   - Direct/Ask path works now; the `Credit/DBUSDC` DeepBook order book is the only DEEP-gated piece.

## Scope (keep it small)
- A **single SUI→DBUSDC on-ramp widget** beside the markets — a utility "Get USDC," **not a DEX**.
  Primary pair SUI→DBUSDC; additional tokens (WAL, etc.) are a later nicety.
- GIX's identity stays "compute exchange"; the swap is a funding convenience.

## What needs DEEP vs not
- **No DEEP:** the on-ramp swap (existing pool), the DBUSDC quote-asset switch, the
  `M_GB10_QWEN` credit witness + GB10·Qwen market, republish (gas-only).
- **DEEP (later):** creating the `Credit<GB10_Qwen>/DBUSDC` permissionless pool + the
  `swap → create_job_from_fill` composition on it.

## Build plan
1. **Contracts** — parameterize the quote coin (generic `Q`); add `M_GB10_QWEN35B` witness +
   GB10·Qwen market; `sui move test` green; stage a republish+setup script (do **not** disturb
   the live deployment yet).
2. **SDK** — `swapSuiForDbusdc()` PTB against `SUI_DBUSDC` (input-coin fees); a live smoke
   (tiny, frugal, ~0.1 SUI) that does a real testnet swap and confirms DBUSDC received.
3. **Web** — a glass **on-ramp widget** ("Get USDC": SUI→DBUSDC) using the amber glass system,
   wired to the SDK swap; shows balances + the live `SUI_DBUSDC` price.
4. **Docs** — canon updated (DBUSDC = testnet USDC stand-in; on-ramp role).

## Honest framing for the demo
"Swap your SUI → USDC on DeepBook (testnet uses DBUSDC; mainnet uses real Circle USDC) → buy
verified GPU inference priced in USDC → GB10 runs it → settled on-chain, I/O on Walrus." Every
step is a **real testnet transaction**; the only stand-in is the test-dollar's brand.
