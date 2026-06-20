# MVP M1.5 — Live Trading UI: Design + Data Contract (BINDING)

A web trading terminal for GIX compute markets: **Binance spot-trading UX/layout** rendered
in a **Palantir-style, dark, glassmorphic** aesthetic. Built by parallel agents against this
contract so the screen is one cohesive surface.

- **Agent A — `web/`**: Vite+React+TS+Tailwind scaffold, design system, all read-only screen
  components, `MarketDataSource` interface + `MockDataSource`, DI seams.
- **Agent B — `harness/` + `web/src/data/ws.ts`**: `--serve` WS feed + `WsDataSource`.
- **Agent C — `web/src/trade/`**: order ticket + burner wallet + `OrderClient` (tx submit).

Product framing: each market is a `Credit<M>/USDC` pair. **Base = compute credits** (1 SCU =
1k output tokens at the tier), **quote = USDC**. **Bids** = consumers buying compute, **asks**
= providers selling capacity, **spot = USDC/SCU**, **fills = Jobs** that run + settle/slash.
Live chain artifacts come from `deployment.json` + `gix::events` (see
[mvp-m1-integration-contract.md](mvp-m1-integration-contract.md), `contracts/README.md`).

---

## 1. Aesthetic — "Palantir glass"

Dark, dense, technical, high-signal — an intelligence-terminal feel, not a consumer app.
Frosted-glass panels floating over a deep obsidian field with faint grid + soft accent glows.

### Design tokens (pin these exactly — Tailwind theme + CSS vars)
```
/* surfaces */
--bg-base:            #05070A   /* obsidian field */
--bg-elev:            #0A0E15
--surface-glass:      rgba(18, 24, 34, 0.55)
--surface-glass-2:    rgba(20, 27, 38, 0.72)   /* stronger panels (ticket, modals) */
--border-glass:       rgba(150, 170, 200, 0.10)
--border-glass-2:     rgba(150, 170, 200, 0.18)

/* text */
--text-primary:       #E6EDF5
--text-secondary:     #8A99AD
--text-muted:         #566678

/* accents (Palantir cool) */
--accent:             #34D2C3   /* teal — primary highlight, focus rings, active */
--accent-blue:        #5B8DEF
--amber:              #F5A623   /* warnings / pending */

/* market semantics (Binance-exact, for familiarity) */
--buy:                #0ECB81   /* bids / up / settled */
--sell:               #F6465D   /* asks / down / slashed */
--buy-bg:             rgba(14, 203, 129, 0.12)
--sell-bg:            rgba(246, 70, 93, 0.12)

/* texture */
--grid-line:          rgba(120, 140, 170, 0.06)
```

### Glass recipe (a `.glass` utility / `<GlassPanel>` primitive)
```css
background: var(--surface-glass);
backdrop-filter: blur(20px) saturate(140%);
-webkit-backdrop-filter: blur(20px) saturate(140%);
border: 1px solid var(--border-glass);
border-radius: 12px;
box-shadow: 0 10px 30px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.04);
```

### Background field
Layered, fixed: deep base `--bg-base` + two faint radial glows (teal top-left, blue bottom-right,
~6% alpha) + a faint grid (`--grid-line`, ~32px) + optional subtle noise. Panels float above it.

### Typography
- UI font: **Inter** (or system stack). Numerics/IDs/prices: **JetBrains Mono** (or IBM Plex
  Mono), `font-variant-numeric: tabular-nums`. Load via `@fontsource/*` (no network at runtime).
- Dense scale: base 13px, small 11px, micro 10px (labels uppercase, letter-spaced, `--text-muted`).
- All money/price/size right-aligned, tabular, fixed decimals (USDC 6dp display-truncated to
  4–6; SCU integer).

### Motion (subtle, "alive")
- Order-book row tints buy/sell-bg briefly on size change, fading out (~400ms).
- New trade rows slide/fade in at top.
- Ticker price flashes buy/sell on up/down tick.
- Connection dot pulses. No bouncy/playful motion — restrained, precise.

---

## 2. Layout — Binance spot-trading template

Full-viewport CSS grid. Familiar Binance regions, GIX content.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ TOPBAR  GIX▸ │ [H100-llama3.1-8b-int8 ▾]  ●last 0.001050  ▲+2.3%  24h H/L/Vol  │  56px
├────────────┬───────────────────────────────────────────┬───────────────────────┤
│ MARKETS    │ CHART  (price line + depth toggle)         │  ORDER TICKET         │
│ sidebar    │                                            │  [ Buy │ Sell ]       │
│ pairs +    │                                            │  [Limit│Market]       │
│ mini price ├──────────────────────┬─────────────────────┤  price  (USDC/SCU)    │
│            │ ORDER BOOK           │  RECENT TRADES       │  amount (SCU)         │
│            │  asks (red, desc)    │   time price sizeSCU │  ── % slider ──       │
│            │  ── spread / mid ──  │   (buy/sell colored) │  total (USDC)         │
│            │  bids (green, asc)   │                      │  [ BUY COMPUTE ]      │
│            │  depth bars + cum.   │                      │  balances: USDC/SCU   │
├────────────┴──────────────────────┴─────────────────────┴───────────────────────┤
│ BOTTOM TABS: [Open Orders] [My Jobs] [Balances] [History]   (lifecycle feed)     │ ~200px
├──────────────────────────────────────────────────────────────────────────────────┤
│ STATUSBAR: ● localnet · pkg 0x91bc… · epoch/checkpoint · ws ●connected            │  24px
└──────────────────────────────────────────────────────────────────────────────────┘
```
Grid: `cols [ markets 220px | center 1fr | ticket 320px ]`; center is `rows [ chart 1fr |
book+trades 1fr ]`. Responsive: collapse markets + ticket into drawers under ~1100px.

### Component inventory (Agent A owns all, except OrderTicket submit = Agent C)
`AppShell` · `BackgroundField` · `GlassPanel` · `TopBar` (wordmark, market selector, ticker
tiles) · `MarketsSidebar` (rows: name, last, Δ%, mini-spark) · `PriceChart` (price line +
toggle to depth chart; a light lib like `lightweight-charts` OR custom SVG — keep deps lean) ·
`OrderBook` (asks/mid/bids, per-row depth bar = size/maxCum, cumulative column, click-a-row →
prefill ticket price) · `RecentTrades` · `OrderTicket` (Buy/Sell + Limit/Market tabs, price,
amount SCU, % slider, total, submit button, balance line) · `PositionsPanel` (tabs: Open
Orders, My Jobs = live lifecycle, Balances, History) · `StatusBar` · `ConnectionDot`.

The **My Jobs** tab is the GIX twist: shows each job advancing Dispatched→Executing→Attested→
Settled/Refunded(Slashed) with the USDC payout/refund/slash — a live, on-chain "positions" view.

---

## 3. Data interface — `web/src/data/types.ts` (Agent A authors; B implements WS)

The UI consumes ONE injected `MarketDataSource`; default = `MockDataSource`, swap to
`WsDataSource` with one line. Keep the UI backend-agnostic (this is the M2/DeepBook seam).

```ts
export type Side = "buy" | "sell";
export type JobState =
  | "Created" | "Matched" | "Escrowed" | "Dispatched" | "Executing"
  | "Attested" | "Verified" | "Settled" | "Refunded" | "Slashed" | "Expired";

export interface Market {
  id: string; name: string; base: "SCU"; quote: "USDC";
  scuTokens: number; slaP99Ms: number; last: number; change24h: number;
}
export interface BookLevel { price: number; sizeScu: number; cumScu: number; }
export interface OrderBook { marketId: string; bids: BookLevel[]; asks: BookLevel[]; ts: number; }
export interface Trade {
  id: string; marketId: string; ts: number; price: number; sizeScu: number;
  side: Side; jobId?: string; state?: JobState;
}
export interface Ticker {
  marketId: string; last: number; change24h: number; high24h: number; low24h: number;
  volScu24h: number; usdcEscrowed: number; usdcSettled: number; usdcSlashed: number;
}
export interface JobUpdate {
  jobId: string; marketId: string; state: JobState; provider?: string; consumer?: string;
  sizeScu: number; price: number; payoutUsdc?: number; refundUsdc?: number; slashUsdc?: number; ts: number;
}
export type Unsub = () => void;

export interface MarketDataSource {
  readonly kind: "mock" | "ws";
  connect(): Promise<void>;
  markets(): Market[];
  onOrderBook(marketId: string, cb: (b: OrderBook) => void): Unsub;
  onTrades(marketId: string, cb: (t: Trade) => void): Unsub;
  onTicker(marketId: string, cb: (t: Ticker) => void): Unsub;
  onJobs(cb: (j: JobUpdate) => void): Unsub;
  status(): "connecting" | "connected" | "disconnected";
}
```
`MockDataSource` must generate a believable, animated book (resting bids/asks around a drifting
mid), a steady trade stream, a moving ticker, and job lifecycle updates — so the screen looks
live with zero backend. It is also the offline/dev fallback.

---

## 4. Live feed — harness `--serve` WS (Agent B)

`npm run stream -- --serve [--port 8787] --deployment <deployment.json> [--scenario <s>]`
runs the existing streamer AND a WS server. It maintains a synthetic order book (resting
pre-match orders the M1 matcher will consume) and emits real settlement events from chain.

WS messages (JSON, one per frame); `WsDataSource` maps these to the interface above:
```
{ "t": "hello",  "markets": Market[] }
{ "t": "book",   "marketId": string, "bids": BookLevel[], "asks": BookLevel[], "ts": number }
{ "t": "trade",  ...Trade }
{ "t": "ticker", ...Ticker }
{ "t": "job",    ...JobUpdate }
```
Real `gix::events` (JobCreated/Dispatched/AttestationSubmitted/Settled/Refunded/Slashed) drive
`trade`/`job`/`ticker`; the synthetic resting orders drive `book` (until M2/DeepBook makes the
book real). `WsDataSource` reconnects with backoff and falls back to Mock on failure.

---

## 5. Order submission — `OrderClient`, `web/src/trade/` (Agent C)

Dev signing on localnet uses a **faucet-funded burner Ed25519 key** generated in-browser
(persist in localStorage; a "fund" button hits the localnet faucet + MOCK_USDC faucet). Real
wallet-connect (`@mysten/dapp-kit`) arrives with testnet (M4).
```ts
export interface Account { address: string; }
export interface Balances { sui: number; usdc: number; creditsScu?: number; }
export interface OrderResult { ok: boolean; digest?: string; jobId?: string; error?: string; }
export interface OrderClient {
  connect(): Promise<Account>;           // burner key
  fund(): Promise<void>;                  // localnet SUI + MOCK_USDC faucet
  balances(): Promise<Balances>;
  // consumer buys compute → in M1 this drives the stubbed match → create_job lifecycle
  buy(marketId: string, qtyScu: number, priceUsdcPerScu: number): Promise<OrderResult>;
  // provider sells capacity → stake (if needed) + mint_credits + post ask
  sell(marketId: string, qtyScu: number, priceUsdcPerScu: number): Promise<OrderResult>;
}
```
Targets the live ABI in `contracts/README.md` (reuse `harness/src/chain/sui.ts` logic).
On submit, optimistic row in Open Orders → tracked into My Jobs as chain events arrive.

---

## 6. Stack + conventions
- Vite + React 18 + TypeScript (strict) + Tailwind CSS v3 (theme = the tokens above) + a thin
  set of primitives. Keep dependencies lean; prefer one small chart lib or hand-rolled SVG.
- ESM, Node 18, npm. `npm run dev` (Vite), `npm run build`, `npm run typecheck`.
- No secrets; localnet RPC `http://127.0.0.1:9000`, faucet `:9123`, WS `:8787` (configurable via
  `.env`/`VITE_*`). Read chain via `@mysten/sui` `SuiClient`.
- a11y-reasonable, keyboard-usable ticket; but density + the terminal aesthetic come first.

## 7. Definition of done (M1.5)
- A: `npm run dev` shows the full Palantir-glass Binance screen, alive on `MockDataSource`.
- B: `npm run stream -- --serve` broadcasts book/trades/ticker/job; `WsDataSource` renders them.
- C: connect burner → fund → place a Buy → watch it flow to Settled in My Jobs, on localnet.
- Integration: one screen, live localnet data, a real order placed from the UI settles on chain.
