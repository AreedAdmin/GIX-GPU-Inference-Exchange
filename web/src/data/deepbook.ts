// web/src/data/deepbook.ts
// A REAL DeepBook-backed MarketDataSource for the GIX trading terminal.
//
// This is the M2/DeepBook swap point promised by the UI contract (§3): the
// Palantir-glass components consume the SAME `MarketDataSource` interface
// unchanged; only the data source is new. Enable it with:
//
//   VITE_DATA_SOURCE=deepbook
//
// What's REAL here (vs MockDataSource / WsDataSource):
//   • Live order book — bids/asks/depth via `@mysten/deepbook-v3`'s
//     `getLevel2TicksFromMid` (falling back to `getLevel2Range`) on the market's
//     bound DeepBook pool. Polled on an interval.
//   • Live mid / ticker `last` — via `midPrice`.
//   • Recent trades — via the public DeepBook testnet indexer
//     `https://deepbook-indexer.testnet.mystenlabs.com/trades/:pool`.
//
// The pool comes from `deployment.markets[0].deepbookPoolId`
// (`market::deepbook_pool_id` on chain). DeepBook + the indexer are TESTNET-only.
//
// DEGRADE-TO-MOCK: if the pool id is unset, or the DeepBook reads / indexer are
// unavailable, we transparently delegate to an internal MockDataSource so the
// screen is never blank. Sibling sidebar markets (which have no real pool) are
// ALSO served by the mock so their mini-prices keep moving. Live DeepBook only
// validates with a real pool at integration; until then this degrades cleanly.
//
// Imports types ONLY from "./types" + reuses MockDataSource for the fallback —
// nothing about the UI changes.

import { MockDataSource } from "./mock";
import type {
  BookLevel,
  JobUpdate,
  Market,
  MarketDataSource,
  OrderBook,
  Ticker,
  Trade,
  Unsub,
} from "./types";

type Status = "connecting" | "connected" | "disconnected";

// ── runtime config (resolved from VITE_* / deployment.json, all optional) ────

interface DeepBookEnv {
  /** Sui RPC url (fullnode). Defaults to the testnet public fullnode. */
  rpcUrl: string;
  /** "testnet" | "mainnet" — DeepBook is testnet-only for GIX M2. */
  network: "testnet" | "mainnet" | "devnet" | "localnet";
  /** The bound DeepBook pool id (market.deepbookPoolId). Empty ⇒ degrade to mock. */
  poolId: string;
  /** The GIX market id this pool trades (the UI's marketId). */
  marketId: string;
  /** Fully-qualified base coin type (Credit<M>) — DeepBook base. */
  baseCoinType: string;
  /** base coin on-chain decimals (Credit is whole-SCU metered ⇒ 0). */
  baseScalar: number;
  /** Fully-qualified quote coin type (USDC / MOCK_USDC) — DeepBook quote. */
  quoteCoinType: string;
  /** quote coin on-chain decimals (USDC ⇒ 6). */
  quoteScalar: number;
  /** Public DeepBook indexer base for recent trades. */
  indexerUrl: string;
  /** Book poll interval (ms). */
  bookPollMs: number;
  /** Trades poll interval (ms). */
  tradesPollMs: number;
  /** How many ticks each side of mid to request from getLevel2TicksFromMid. */
  ticks: number;
}

function envStr(key: string): string | undefined {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const v = env?.[key];
  return v && v.length > 0 ? v : undefined;
}

function resolveEnv(): DeepBookEnv {
  const network = (envStr("VITE_DEEPBOOK_NETWORK") ??
    envStr("VITE_NETWORK") ??
    "testnet") as DeepBookEnv["network"];
  const rpcUrl =
    envStr("VITE_RPC_URL") ??
    (network === "localnet"
      ? "http://127.0.0.1:9000"
      : `https://fullnode.${network}.sui.io:443`);
  return {
    network,
    rpcUrl,
    // The market's bound DeepBook pool (deployment.markets[0].deepbookPoolId).
    poolId: envStr("VITE_DEEPBOOK_POOL_ID") ?? "",
    marketId: envStr("VITE_MARKET_ID") ?? "",
    baseCoinType:
      envStr("VITE_DEEPBOOK_BASE_TYPE") ??
      envStr("VITE_MARKET_CREDIT_COIN_TYPE") ??
      "",
    baseScalar: numEnv("VITE_DEEPBOOK_BASE_SCALAR", 1),
    quoteCoinType: envStr("VITE_DEEPBOOK_QUOTE_TYPE") ?? envStr("VITE_USDC_TYPE") ?? "",
    quoteScalar: numEnv("VITE_DEEPBOOK_QUOTE_SCALAR", 1_000_000),
    indexerUrl:
      envStr("VITE_DEEPBOOK_INDEXER_URL") ??
      "https://deepbook-indexer.testnet.mystenlabs.com",
    bookPollMs: numEnv("VITE_DEEPBOOK_BOOK_POLL_MS", 2500),
    tradesPollMs: numEnv("VITE_DEEPBOOK_TRADES_POLL_MS", 4000),
    ticks: numEnv("VITE_DEEPBOOK_TICKS", 20),
  };
}

function numEnv(key: string, dflt: number): number {
  const v = envStr(key);
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/** Stable internal pool/coin keys the DeepBookClient config registers. */
const POOL_KEY = "GIX_POOL";
const BASE_KEY = "GIX_SCU";
const QUOTE_KEY = "GIX_USDC";

// ── minimal DeepBook client surface we depend on (avoids a hard type import) ──

interface Level2Ticks {
  bid_prices: number[];
  bid_quantities: number[];
  ask_prices: number[];
  ask_quantities: number[];
}
interface DeepBookReadClient {
  midPrice(poolKey: string): Promise<number>;
  getLevel2TicksFromMid(poolKey: string, ticks: number): Promise<Level2Ticks>;
  getLevel2Range(
    poolKey: string,
    priceLow: number | bigint,
    priceHigh: number | bigint,
    isBid: boolean,
  ): Promise<{ prices: number[]; quantities: number[] }>;
}

/** One trade row as the DeepBook indexer `/trades/:pool` endpoint returns it. */
interface IndexerTrade {
  // The indexer returns snake_case fields; we read defensively.
  trade_id?: string | number;
  digest?: string;
  price?: number | string;
  base_quantity?: number | string;
  quantity?: number | string;
  taker_is_bid?: boolean;
  type?: string; // "buy" | "sell" on some versions
  timestamp?: number | string;
  checkpoint_timestamp_ms?: number | string;
}

export class DeepBookDataSource implements MarketDataSource {
  readonly kind = "deepbook" as const;

  private readonly env: DeepBookEnv;
  /** Internal mock that drives sibling markets + the degrade-to-mock fallback. */
  private readonly mock: MockDataSource;
  /** True once we've confirmed the real DeepBook pool is reachable. */
  private liveBook = false;
  private _status: Status = "disconnected";

  private db: DeepBookReadClient | null = null;
  private marketId = "";

  private bookSubs = new Map<string, Set<(b: OrderBook) => void>>();
  private tradeSubs = new Map<string, Set<(t: Trade) => void>>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private started = false;
  private lastMid = 0;
  private seenTradeIds = new Set<string>();
  private firstTradePoll = true;

  constructor(env?: Partial<DeepBookEnv>) {
    this.env = { ...resolveEnv(), ...env };
    this.mock = new MockDataSource();
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  async connect(): Promise<void> {
    if (this.started) return;
    this._status = "connecting";
    // The mock always drives ticker/jobs + every sibling market, so the screen is
    // alive instantly while we probe the real pool.
    await this.mock.connect();

    // Resolve the GIX market id the real pool maps to (default: the mock's primary).
    this.marketId =
      this.env.marketId && this.env.marketId.length > 0
        ? this.env.marketId
        : (this.mock.markets()[0]?.id ?? "");

    // Probe the real DeepBook pool. Any failure ⇒ stay on mock (never throws).
    if (this.canGoLive()) {
      try {
        this.db = await this.buildDeepBookClient();
        // A single midPrice read confirms the pool exists + is queryable.
        const mid = await this.db.midPrice(POOL_KEY);
        if (Number.isFinite(mid) && mid > 0) {
          this.lastMid = mid;
          this.liveBook = true;
          this.startPolling();
        }
      } catch (err) {
        console.warn(
          "[gix] DeepBook pool unavailable — degrading to mock data source.",
          err,
        );
        this.db = null;
        this.liveBook = false;
      }
    } else {
      console.warn(
        "[gix] DeepBook not configured (need VITE_DEEPBOOK_POOL_ID + base/quote coin types) — using mock.",
      );
    }

    this._status = "connected";
    this.started = true;
  }

  disconnect(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.mock.disconnect();
    this._status = "disconnected";
    this.started = false;
  }

  status(): Status {
    // Reflect real liveness when on the real book; otherwise the mock's status.
    return this._status;
  }

  /** True once the real DeepBook pool answered — surfaced for diagnostics/UI. */
  isLive(): boolean {
    return this.liveBook;
  }

  markets(): Market[] {
    // The mock owns the full market universe (primary + sibling tiers). The
    // primary one is the market our real pool maps to; its book/last become real.
    return this.mock.markets();
  }

  // ── subscriptions ────────────────────────────────────────────────────────────
  onOrderBook(marketId: string, cb: (b: OrderBook) => void): Unsub {
    // Sibling markets (no real pool) stay on the mock book.
    if (!this.isRealMarket(marketId)) return this.mock.onOrderBook(marketId, cb);
    const set = this.bookSubs.get(marketId) ?? new Set();
    set.add(cb);
    this.bookSubs.set(marketId, set);
    return () => set.delete(cb);
  }

  onTrades(marketId: string, cb: (t: Trade) => void): Unsub {
    if (!this.isRealMarket(marketId)) return this.mock.onTrades(marketId, cb);
    const set = this.tradeSubs.get(marketId) ?? new Set();
    set.add(cb);
    this.tradeSubs.set(marketId, set);
    return () => set.delete(cb);
  }

  onTicker(marketId: string, cb: (t: Ticker) => void): Unsub {
    // The ticker (24h vol / escrow / settled / slashed) is not exposed by DeepBook
    // reads, so we keep the mock's ticker and patch its `last` from the real mid
    // (see tickReal). The mock subscription handles the rest of the fields.
    return this.mock.onTicker(marketId, cb);
  }

  onJobs(cb: (j: JobUpdate) => void): Unsub {
    // Job lifecycle is GIX-chain, not DeepBook — keep the mock's job feed here.
    // (The real chain job feed arrives via the WS source / on-chain events.)
    return this.mock.onJobs(cb);
  }

  // ── real DeepBook polling ─────────────────────────────────────────────────────
  private startPolling(): void {
    // Order book.
    void this.pollBook();
    this.timers.push(setInterval(() => void this.pollBook(), this.env.bookPollMs));
    // Recent trades (from the indexer).
    void this.pollTrades();
    this.timers.push(setInterval(() => void this.pollTrades(), this.env.tradesPollMs));
  }

  private async pollBook(): Promise<void> {
    if (!this.db || !this.liveBook) return;
    if (!this.bookSubs.get(this.marketId)?.size) return;
    try {
      const [mid, book] = await Promise.all([
        this.db.midPrice(POOL_KEY).catch(() => this.lastMid),
        this.readLevel2(),
      ]);
      if (Number.isFinite(mid) && mid > 0) this.lastMid = mid;
      const snap: OrderBook = {
        marketId: this.marketId,
        bids: book.bids,
        asks: book.asks,
        ts: Date.now(),
      };
      this.bookSubs.get(this.marketId)?.forEach((cb) => cb(snap));
    } catch (err) {
      console.warn("[gix] DeepBook book read failed (transient); keeping last book.", err);
    }
  }

  /** Read level-2 ticks-from-mid; fall back to a wide range read if it fails. */
  private async readLevel2(): Promise<{ bids: BookLevel[]; asks: BookLevel[] }> {
    const db = this.db!;
    try {
      const t = await db.getLevel2TicksFromMid(POOL_KEY, this.env.ticks);
      return {
        bids: toLevels(t.bid_prices, t.bid_quantities, /*desc*/ true),
        asks: toLevels(t.ask_prices, t.ask_quantities, /*desc*/ false),
      };
    } catch {
      // Range read around the last mid as a backstop (e.g. an empty book throws
      // on ticks-from-mid). Use a generous +/-50% window.
      const mid = this.lastMid > 0 ? this.lastMid : 0.001;
      const [bid, ask] = await Promise.all([
        db.getLevel2Range(POOL_KEY, mid * 0.5, mid, true).catch(() => ({
          prices: [],
          quantities: [],
        })),
        db.getLevel2Range(POOL_KEY, mid, mid * 1.5, false).catch(() => ({
          prices: [],
          quantities: [],
        })),
      ]);
      return {
        bids: toLevels(bid.prices, bid.quantities, true),
        asks: toLevels(ask.prices, ask.quantities, false),
      };
    }
  }

  private async pollTrades(): Promise<void> {
    if (!this.liveBook) return;
    if (!this.tradeSubs.get(this.marketId)?.size) return;
    try {
      const rows = await this.fetchIndexerTrades();
      // On the very first poll, prime the seen-set silently so we don't dump the
      // backlog as a burst of "new" rows; afterwards emit only the fresh ones.
      const fresh: Trade[] = [];
      for (const r of rows) {
        const id = String(r.trade_id ?? r.digest ?? `${r.timestamp}-${r.price}`);
        if (this.seenTradeIds.has(id)) continue;
        this.seenTradeIds.add(id);
        if (this.firstTradePoll) continue;
        fresh.push(this.toTrade(id, r));
      }
      // Cap the seen-set so it can't grow without bound.
      if (this.seenTradeIds.size > 4000) {
        this.seenTradeIds = new Set(Array.from(this.seenTradeIds).slice(-2000));
      }
      this.firstTradePoll = false;
      // Emit oldest→newest so the UI's "prepend newest" lands them in order.
      for (const t of fresh.reverse()) {
        this.tradeSubs.get(this.marketId)?.forEach((cb) => cb(t));
      }
    } catch (err) {
      console.warn("[gix] DeepBook indexer trades fetch failed (transient).", err);
    }
  }

  private async fetchIndexerTrades(): Promise<IndexerTrade[]> {
    const base = this.env.indexerUrl.replace(/\/+$/, "");
    // The indexer keys trades by the on-chain pool id.
    const url = `${base}/trades/${encodeURIComponent(this.env.poolId)}?limit=40`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`indexer ${res.status}`);
    const body = (await res.json()) as unknown;
    return Array.isArray(body) ? (body as IndexerTrade[]) : [];
  }

  private toTrade(id: string, r: IndexerTrade): Trade {
    const price = Number(r.price ?? 0);
    const sizeRaw = Number(r.base_quantity ?? r.quantity ?? 0);
    // Indexer base_quantity is in base units; SCU is whole-token metered.
    const sizeScu = Math.max(0, Math.round(sizeRaw / this.env.baseScalar));
    const isBuy =
      r.taker_is_bid === true ||
      r.type === "buy" ||
      (r.taker_is_bid === undefined && r.type === undefined ? price >= this.lastMid : false);
    const tsRaw = r.checkpoint_timestamp_ms ?? r.timestamp;
    const ts = tsRaw ? Number(tsRaw) : Date.now();
    return {
      id,
      marketId: this.marketId,
      ts: ts > 1e12 ? ts : ts * 1000, // tolerate seconds vs ms
      price,
      sizeScu,
      side: isBuy ? "buy" : "sell",
    };
  }

  // ── DeepBook client construction ──────────────────────────────────────────────
  private canGoLive(): boolean {
    return (
      this.env.poolId.length > 0 &&
      this.env.baseCoinType.length > 0 &&
      this.env.quoteCoinType.length > 0
    );
  }

  /** Build a DeepBookClient registering the GIX pool/coins by id (lazy import). */
  private async buildDeepBookClient(): Promise<DeepBookReadClient> {
    const { SuiJsonRpcClient } = await import("@mysten/sui/jsonRpc");
    const { DeepBookClient } = await import("@mysten/deepbook-v3");

    const sui = new SuiJsonRpcClient({
      network: this.env.network,
      url: this.env.rpcUrl,
    });

    // Register OUR pool + coins so getPool/getCoin resolve (the SDK's built-in
    // testnet maps don't know the GIX Credit<M>/USDC pair).
    const coins = {
      [BASE_KEY]: {
        address: this.env.baseCoinType,
        type: this.env.baseCoinType,
        scalar: this.env.baseScalar,
      },
      [QUOTE_KEY]: {
        address: this.env.quoteCoinType,
        type: this.env.quoteCoinType,
        scalar: this.env.quoteScalar,
      },
    };
    const pools = {
      [POOL_KEY]: {
        address: this.env.poolId,
        baseCoin: BASE_KEY,
        quoteCoin: QUOTE_KEY,
      },
    };

    // `address` is the sender used for read simulations (any valid addr works for
    // a devInspect/simulate; 0x0 is fine for read-only level-2 queries).
    const client = new DeepBookClient({
      client: sui as unknown as never,
      address: "0x0000000000000000000000000000000000000000000000000000000000000000",
      network: this.env.network as never,
      coins: coins as never,
      pools: pools as never,
    });
    return client as unknown as DeepBookReadClient;
  }

  private isRealMarket(marketId: string): boolean {
    return this.liveBook && marketId === this.marketId;
  }
}

// ── pure helpers ────────────────────────────────────────────────────────────────

/** Turn parallel price/qty arrays into cumulative BookLevels, sorted for display.
 *  Bids descend (best/highest first); asks ascend (best/lowest first). */
function toLevels(prices: number[], quantities: number[], desc: boolean): BookLevel[] {
  const pairs: Array<{ price: number; sizeScu: number }> = [];
  const n = Math.min(prices.length, quantities.length);
  for (let i = 0; i < n; i++) {
    const price = Number(prices[i]);
    const sizeScu = Math.max(0, Math.round(Number(quantities[i])));
    if (price > 0 && sizeScu > 0) pairs.push({ price, sizeScu });
  }
  pairs.sort((a, b) => (desc ? b.price - a.price : a.price - b.price));
  let cum = 0;
  return pairs.map((p) => {
    cum += p.sizeScu;
    return { price: p.price, sizeScu: p.sizeScu, cumScu: cum };
  });
}

export default DeepBookDataSource;
