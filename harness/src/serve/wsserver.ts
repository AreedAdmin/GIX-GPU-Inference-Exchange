/**
 * GIX `--serve` WebSocket feed.
 *
 * Runs ALONGSIDE the existing streamer (the orchestrator). It:
 *   - sends `{t:"hello", markets}` to each new client, from the deployment,
 *   - maintains a synthetic order book per market (see ./book.ts) and broadcasts
 *     `{t:"book", ...}` on a ~5-10 Hz throttle while the mid drifts,
 *   - derives `{t:"trade"}`, `{t:"job"}` and `{t:"ticker"}` frames from the REAL
 *     harness event stream (on-chain `gix::events` when live, the dry-run state
 *     machine when `--dry-run`), tapped via the orchestrator's `onEvent` hook.
 *
 * The wire schema matches the M1.5 UI contract §3/§4 EXACTLY so `web/src/data/ws.ts`
 * maps frames 1:1 onto `MarketDataSource`. Nothing here imports from `web/`.
 */

import { WebSocketServer, WebSocket } from "ws";
import type { Deployment } from "../config/types.js";
import type { Scenario } from "../config/types.js";
import type { HarnessEvent } from "../observability/events.js";
import type { Logger } from "../observability/logger.js";
import { SyntheticBook, distributionCenter, type BookLevel } from "./book.js";

// ---------------------------------------------------------------------------
// Wire types — these mirror web/src/data/types.ts (§3) field-for-field.
// ---------------------------------------------------------------------------

/** §3 Market. base/quote are fixed for GIX compute pairs. */
export interface WireMarket {
  id: string;
  name: string;
  base: "SCU";
  quote: "USDC";
  scuTokens: number;
  slaP99Ms: number;
  last: number;
  change24h: number;
}

type Side = "buy" | "sell";
type JobState =
  | "Created"
  | "Matched"
  | "Escrowed"
  | "Dispatched"
  | "Executing"
  | "Attested"
  | "Verified"
  | "Settled"
  | "Refunded"
  | "Slashed"
  | "Expired";

interface HelloFrame {
  t: "hello";
  markets: WireMarket[];
}
interface BookFrame {
  t: "book";
  marketId: string;
  bids: BookLevel[];
  asks: BookLevel[];
  ts: number;
}
interface TradeFrame {
  t: "trade";
  id: string;
  marketId: string;
  ts: number;
  price: number;
  sizeScu: number;
  side: Side;
  jobId?: string;
  state?: JobState;
}
interface TickerFrame {
  t: "ticker";
  marketId: string;
  last: number;
  change24h: number;
  high24h: number;
  low24h: number;
  volScu24h: number;
  usdcEscrowed: number;
  usdcSettled: number;
  usdcSlashed: number;
}
interface JobFrame {
  t: "job";
  jobId: string;
  marketId: string;
  state: JobState;
  provider?: string;
  consumer?: string;
  sizeScu: number;
  price: number;
  payoutUsdc?: number;
  refundUsdc?: number;
  slashUsdc?: number;
  ts: number;
}

type Frame = HelloFrame | BookFrame | TradeFrame | TickerFrame | JobFrame;

// ---------------------------------------------------------------------------
// Per-market running ticker state (24h rollup; the demo run is the "24h").
// ---------------------------------------------------------------------------

interface TickerState {
  marketId: string;
  open: number; // first trade price (the change24h anchor)
  last: number;
  high: number;
  low: number;
  volScu: number;
  usdcEscrowed: number;
  usdcSettled: number;
  usdcSlashed: number;
}

/** Light in-flight job index so a `job` frame can carry size/price as events arrive. */
interface JobMeta {
  marketId: string;
  provider?: string;
  consumer?: string;
  sizeScu: number;
  price: number;
}

export interface ServeOptions {
  port: number;
  deployment: Deployment;
  scenario: Scenario;
  logger: Logger;
  /** Book broadcast rate (Hz). Clamped to [5, 10]. Default 8. */
  bookHz?: number;
  /** Seed for the synthetic book RNG. */
  seed?: number;
}

export class WsFeedServer {
  private readonly wss: WebSocketServer;
  private readonly logger: Logger;
  private readonly markets: WireMarket[];
  private readonly books = new Map<string, SyntheticBook>();
  private readonly tickers = new Map<string, TickerState>();
  private readonly jobs = new Map<string, JobMeta>();
  private readonly marketSet: Set<string>;
  private readonly fallbackMarketId: string;
  private bookTimer: ReturnType<typeof setInterval> | undefined;
  private tradeSeq = 0;
  private closed = false;

  constructor(opts: ServeOptions) {
    this.logger = opts.logger;
    const center = Math.max(1, Math.round(distributionCenter(opts.scenario.priceUsdcPerScu)));
    const typicalQty = Math.max(1, Math.round(distributionCenter(opts.scenario.qtyScu)));
    const seed = (opts.seed ?? opts.scenario.seed ?? 0x5e2e) >>> 0;

    this.markets = opts.deployment.markets.map((m) => ({
      id: m.id,
      name: m.name,
      base: "SCU",
      quote: "USDC",
      scuTokens: m.scuTokens,
      slaP99Ms: m.slaP99Ms,
      last: center,
      change24h: 0,
    }));
    this.marketSet = new Set(this.markets.map((m) => m.id));
    this.fallbackMarketId = this.markets[0]?.id ?? "";

    let s = seed;
    for (const m of this.markets) {
      this.books.set(m.id, new SyntheticBook({ marketId: m.id, centerPrice: center, typicalQty }, (s = (s * 1664525 + 1013904223) >>> 0)));
      this.tickers.set(m.id, {
        marketId: m.id,
        open: center,
        last: center,
        high: center,
        low: center,
        volScu: 0,
        usdcEscrowed: 0,
        usdcSettled: 0,
        usdcSlashed: 0,
      });
    }

    const hz = Math.min(10, Math.max(5, opts.bookHz ?? 8));
    this.wss = new WebSocketServer({ port: opts.port, host: "127.0.0.1" });
    this.wss.on("connection", (ws) => this.onConnection(ws));
    this.wss.on("listening", () =>
      this.logger.info(`WS feed: ws://127.0.0.1:${opts.port} (${this.markets.length} market(s), book ${hz}Hz)`),
    );
    this.wss.on("error", (err) => this.logger.info(`WS feed error: ${err.message}`));

    const periodMs = Math.round(1000 / hz);
    this.bookTimer = setInterval(() => this.tickBooks(), periodMs);
  }

  /** Resolve a usable market id (events without one fall back to the first market). */
  private marketOf(id?: string): string {
    return id && this.marketSet.has(id) ? id : this.fallbackMarketId;
  }

  private onConnection(ws: WebSocket): void {
    this.send(ws, { t: "hello", markets: this.markets });
    // Prime the new client with the current book + ticker for each market.
    const ts = Date.now();
    for (const [id, book] of this.books) {
      const snap = book.snapshot(ts);
      this.send(ws, { t: "book", marketId: id, bids: snap.bids, asks: snap.asks, ts: snap.ts });
      this.send(ws, this.tickerFrame(id));
    }
  }

  /** Drift each book one step and broadcast its fresh snapshot. */
  private tickBooks(): void {
    if (this.closed || this.wss.clients.size === 0) {
      // Still drift so the book keeps moving even with no listeners attached.
      for (const book of this.books.values()) book.drift();
      return;
    }
    const ts = Date.now();
    for (const [id, book] of this.books) {
      book.drift();
      // Keep the market.last in sync with the drifting mid for the hello frame.
      const m = this.markets.find((x) => x.id === id);
      if (m) m.last = book.midPrice();
      const snap = book.snapshot(ts);
      this.broadcast({ t: "book", marketId: id, bids: snap.bids, asks: snap.asks, ts: snap.ts });
    }
  }

  /**
   * Fold one harness event into trade/job/ticker frames and broadcast them.
   * Wired from the orchestrator via `onEvent`. Read-only with respect to the
   * orchestrator; never throws back into the run loop.
   */
  onHarnessEvent(e: HarnessEvent): void {
    try {
      this.handle(e);
    } catch (err) {
      this.logger.info(`WS feed: event handler error: ${(err as Error).message}`);
    }
  }

  private handle(e: HarnessEvent): void {
    switch (e.type) {
      case "JobCreated":
        this.onJobCreated(e);
        break;
      case "Dispatched":
        this.emitJob(e, "Dispatched");
        break;
      case "AttestationSubmitted":
        this.emitJob(e, "Attested");
        break;
      case "Settled":
        this.onSettled(e);
        break;
      case "Refunded":
        this.onRefunded(e);
        break;
      case "Slashed":
        this.onSlashed(e);
        break;
      case "Expired":
        this.emitJob(e, "Expired");
        break;
      default:
        // Order / Match / NoMatch / Staked / CreditsMinted carry no UI frame.
        break;
    }
  }

  private num(e: HarnessEvent, k: string): number {
    const v = e.data?.[k];
    return typeof v === "number" ? v : 0;
  }

  private onJobCreated(e: HarnessEvent): void {
    const marketId = this.marketOf(e.marketId);
    const sizeScu = this.num(e, "qtyScu");
    const price = this.num(e, "priceUsdcPerScu");
    const escrow = this.num(e, "escrowUsdc");
    if (e.jobId) {
      this.jobs.set(e.jobId, { marketId, provider: e.provider, consumer: e.consumer, sizeScu, price });
    }
    // A created job IS a fill in M1 → print a trade. Side = "buy": a consumer
    // bought compute (consumer-initiated taker). Drive the ticker last/high/low/vol.
    const ts = e.ts ?? Date.now();
    this.recordTrade(marketId, price, sizeScu);
    this.books.get(marketId)?.onTradePrice(price);
    const tk = this.tickers.get(marketId);
    if (tk) tk.usdcEscrowed += escrow;

    this.broadcast({
      t: "trade",
      id: `t-${++this.tradeSeq}`,
      marketId,
      ts,
      price,
      sizeScu,
      side: "buy",
      jobId: e.jobId,
      state: "Created",
    });
    this.broadcast(this.tickerFrame(marketId));
    // The chain advances Created→…→Dispatched in one tx; surface a Dispatched job row.
    this.emitJob(e, "Dispatched");
  }

  private onSettled(e: HarnessEvent): void {
    const meta = e.jobId ? this.jobs.get(e.jobId) : undefined;
    const marketId = this.marketOf(e.marketId ?? meta?.marketId);
    const tk = this.tickers.get(marketId);
    if (tk) tk.usdcSettled += this.num(e, "payoutUsdc");
    this.emitJob(e, "Settled", { payoutUsdc: this.num(e, "payoutUsdc") });
    this.broadcast(this.tickerFrame(marketId));
    if (e.jobId) this.jobs.delete(e.jobId);
  }

  private onRefunded(e: HarnessEvent): void {
    const meta = e.jobId ? this.jobs.get(e.jobId) : undefined;
    const marketId = this.marketOf(e.marketId ?? meta?.marketId);
    this.emitJob(e, "Refunded", { refundUsdc: this.num(e, "amountUsdc") });
    this.broadcast(this.tickerFrame(marketId));
    // Keep meta until a possible co-emitted Slashed lands, then drop on next settle/expire.
  }

  private onSlashed(e: HarnessEvent): void {
    const meta = e.jobId ? this.jobs.get(e.jobId) : undefined;
    const marketId = this.marketOf(e.marketId ?? meta?.marketId);
    const tk = this.tickers.get(marketId);
    if (tk) tk.usdcSlashed += this.num(e, "penaltyUsdc");
    this.emitJob(e, "Slashed", { slashUsdc: this.num(e, "penaltyUsdc") });
    this.broadcast(this.tickerFrame(marketId));
    if (e.jobId) this.jobs.delete(e.jobId);
  }

  private emitJob(
    e: HarnessEvent,
    state: JobState,
    extra?: { payoutUsdc?: number; refundUsdc?: number; slashUsdc?: number },
  ): void {
    if (!e.jobId) return;
    const meta = this.jobs.get(e.jobId);
    const marketId = this.marketOf(e.marketId ?? meta?.marketId);
    const frame: JobFrame = {
      t: "job",
      jobId: e.jobId,
      marketId,
      state,
      provider: e.provider ?? meta?.provider,
      consumer: e.consumer ?? meta?.consumer,
      sizeScu: meta?.sizeScu ?? this.num(e, "qtyScu"),
      price: meta?.price ?? this.num(e, "priceUsdcPerScu"),
      ts: e.ts ?? Date.now(),
      ...extra,
    };
    this.broadcast(frame);
  }

  private recordTrade(marketId: string, price: number, sizeScu: number): void {
    const tk = this.tickers.get(marketId);
    if (!tk || price <= 0) return;
    tk.last = price;
    tk.high = Math.max(tk.high, price);
    tk.low = Math.min(tk.low, price);
    tk.volScu += sizeScu;
    const m = this.markets.find((x) => x.id === marketId);
    if (m) {
      m.last = price;
      m.change24h = tk.open > 0 ? (price - tk.open) / tk.open : 0;
    }
  }

  private tickerFrame(marketId: string): TickerFrame {
    const tk = this.tickers.get(marketId)!;
    const change24h = tk.open > 0 ? (tk.last - tk.open) / tk.open : 0;
    return {
      t: "ticker",
      marketId,
      last: tk.last,
      change24h,
      high24h: tk.high,
      low24h: tk.low,
      volScu24h: tk.volScu,
      usdcEscrowed: tk.usdcEscrowed,
      usdcSettled: tk.usdcSettled,
      usdcSlashed: tk.usdcSlashed,
    };
  }

  private send(ws: WebSocket, frame: Frame): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }

  private broadcast(frame: Frame): void {
    const msg = JSON.stringify(frame);
    for (const ws of this.wss.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  /** Stop accepting connections and clear timers. Resolves once closed. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.bookTimer) clearInterval(this.bookTimer);
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}
