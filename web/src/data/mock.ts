// web/src/data/mock.ts
// A rich, self-driving MarketDataSource. With NO backend it produces:
//   • a believable resting order book around a drifting mid (depth, cumulative sizes)
//   • a steady trade stream (each trade = a Job fill)
//   • a moving 24h ticker (vol, escrow/settled/slashed totals)
//   • a job lifecycle feed advancing Dispatched → Executing → Attested → Settled/Slashed
// It is the offline/dev fallback and the reference impl for the WS feed (Agent B).

import type {
  BookLevel,
  JobState,
  JobUpdate,
  Market,
  MarketDataSource,
  OrderBook,
  Side,
  Ticker,
  Trade,
  Unsub,
} from "./types";
import { loadChainConfig } from "../trade/config";
import { CRYPTO_PAIRS } from "./cryptoPairs";

type Cb<T> = (v: T) => void;

// The live, on-chain buyable market (VITE_MARKET_ID). The mock list's PRIMARY entry uses
// these ids so the default-selected market matches the deployment — otherwise every buy
// hits "only the live deployment market can be bought (others are simulated)".
const CHAIN_MARKET = loadChainConfig().market;

// ── Market universe ─────────────────────────────────────────────────────────
// Primary market is the live deployment market; the others are plausible sibling
// tiers so the MarketsSidebar feels like a real exchange. Only the primary streams
// the full lifecycle; the rest get their own light drift so mini-prices move.
interface SimMarket extends Market {
  basePrice: number;
  vol: number; // per-tick volatility fraction
}

const SECONDS = 1000;

function mkMarket(
  id: string,
  name: string,
  basePrice: number,
  vol: number,
  scuTokens: number,
  slaP99Ms: number,
): SimMarket {
  return {
    id,
    name,
    base: "SCU",
    quote: "USDC",
    scuTokens,
    slaP99Ms,
    last: basePrice,
    change24h: 0,
    basePrice,
    vol,
  };
}

const MARKETS: SimMarket[] = [
  // Live demo market — the GB10 (DGX Spark) provider serving qwen3.6:35b.
  // Headline market; its Credit/USDC DeepBook pool is created once test DEEP lands.
  mkMarket(
    CHAIN_MARKET.id,                    // live on-chain market id (VITE_MARKET_ID) — buyable
    CHAIN_MARKET.name,                  // its display name
    0.0042,
    0.0011,
    CHAIN_MARKET.scuTokens ?? 1000,
    CHAIN_MARKET.slaP99Ms ?? 30000,
  ),
  mkMarket(
    "0x816c8da0ce624cb62e84948bad3fe1fad60a8aa945d85661b29bcd73dffc55b1",
    "H100-llama3.1-8b-int8",
    0.00105,
    0.0009,
    1000,
    5000,
  ),
  mkMarket("mkt-h100-llama70b", "H100-llama3.1-70b-fp8", 0.0072, 0.0011, 1000, 9000),
  mkMarket("mkt-a100-mistral7b", "A100-mistral-7b-int8", 0.00082, 0.0012, 1000, 4500),
  mkMarket("mkt-h200-qwen72b", "H200-qwen2.5-72b-fp8", 0.0094, 0.0014, 1000, 8000),
  mkMarket("mkt-l40s-phi3", "L40S-phi3-mini-int4", 0.00031, 0.0016, 1000, 3000),
  mkMarket("mkt-h100-mixtral", "H100-mixtral-8x7b-fp8", 0.0051, 0.0013, 1000, 7000),
];

// ── PRNG (seeded, deterministic-ish but lively) ─────────────────────────────
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PROVIDERS = [
  "0xb8e7af9d…ee4e7",
  "0x4f1a90c2…7b3d1",
  "0x9c02e7d3…0a14e",
  "0x2e84948b…fc55b1",
  "0x7be92710…c6bc9",
];
const CONSUMERS = [
  "0xa31d402f…6a3e1",
  "0x5b8def00…c4d22",
  "0x0ecb8100…f6465",
  "0x34d2c3aa…d2c3b",
];

let _jobSeq = 1000;
function nextJobId(): string {
  _jobSeq += 1;
  const hex = (_jobSeq * 2654435761 >>> 0).toString(16).padStart(8, "0");
  return `0x${hex}${hex.slice(0, 4)}…job`;
}
let _tradeSeq = 0;
function nextTradeId(): string {
  _tradeSeq += 1;
  return `t${_tradeSeq.toString(36)}-${Date.now().toString(36)}`;
}

// Per-market live mid + a resting book model.
interface MarketState {
  mid: number;
  open: number; // 24h-ago reference for change%
  high: number;
  low: number;
  volScu: number;
  usdcEscrowed: number;
  usdcSettled: number;
  usdcSlashed: number;
  bookBids: BookLevel[];
  bookAsks: BookLevel[];
}

function round(n: number, dp: number) {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

// Crypto pairs are chartable too: seed them into the sim universe (state + book + ticker +
// trades) so selecting one in the sidebar drives the chart. They are intentionally NOT
// returned by markets() — that stays GPU-only (TopBar dropdown + the GPU list). Their
// base/quote labels are cosmetic here; only id + price seed the simulator.
const CRYPTO_SIM: SimMarket[] = CRYPTO_PAIRS.map((p) =>
  mkMarket(p.id, `${p.base} / ${p.quote}`, p.last, 0.004, 0, 0),
);
// Everything the simulator drives (GPU markets + crypto pairs). markets() returns MARKETS.
const UNIVERSE: SimMarket[] = [...MARKETS, ...CRYPTO_SIM];

export class MockDataSource implements MarketDataSource {
  readonly kind = "mock" as const;

  private rng = mulberry32(0xc0ffee ^ Date.now());
  private _status: "connecting" | "connected" | "disconnected" = "disconnected";
  private timers: ReturnType<typeof setInterval>[] = [];
  private started = false;

  private state = new Map<string, MarketState>();

  private bookSubs = new Map<string, Set<Cb<OrderBook>>>();
  private tradeSubs = new Map<string, Set<Cb<Trade>>>();
  private tickerSubs = new Map<string, Set<Cb<Ticker>>>();
  private jobSubs = new Set<Cb<JobUpdate>>();

  // jobs currently advancing through their lifecycle
  private liveJobs: {
    jobId: string;
    marketId: string;
    sizeScu: number;
    price: number;
    provider: string;
    consumer: string;
    state: JobState;
    nextAt: number;
    fault: "none" | "slash" | "refund";
  }[] = [];

  constructor() {
    for (const m of UNIVERSE) {
      const mid = m.basePrice;
      this.state.set(m.id, {
        mid,
        open: mid * (1 + (this.rng() - 0.5) * 0.04),
        high: mid,
        low: mid,
        volScu: Math.floor(this.rng() * 400_000) + 120_000,
        usdcEscrowed: round(this.rng() * 8000 + 2000, 2),
        usdcSettled: round(this.rng() * 60_000 + 20_000, 2),
        usdcSlashed: round(this.rng() * 900 + 50, 2),
        bookBids: [],
        bookAsks: [],
      });
      this.rebuildBook(m.id);
    }
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  async connect(): Promise<void> {
    if (this.started) return;
    this._status = "connecting";
    // brief "handshake" so the connection dot animates through connecting → connected
    await new Promise((r) => setTimeout(r, 280));
    this._status = "connected";
    this.started = true;

    // mid drift + book mutation (fast, makes the book feel alive)
    this.timers.push(setInterval(() => this.tickBooks(), 900));
    // trade stream
    this.timers.push(setInterval(() => this.tickTrades(), 1100));
    // ticker push
    this.timers.push(setInterval(() => this.tickTickers(), 1500));
    // job lifecycle advance
    this.timers.push(setInterval(() => this.tickJobs(), 700));
    // occasionally seed a fresh job
    this.timers.push(setInterval(() => this.spawnJob(), 4200));

    // seed a couple of in-flight jobs immediately so My Jobs isn't empty
    this.spawnJob();
    this.spawnJob();
    // emit one immediate snapshot per market so the UI paints instantly
    for (const m of UNIVERSE) {
      this.emitBook(m.id);
      this.emitTicker(m.id);
    }
  }

  disconnect(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this._status = "disconnected";
    this.started = false;
  }

  status() {
    return this._status;
  }

  markets(): Market[] {
    return MARKETS.map((m) => {
      const st = this.state.get(m.id)!;
      return {
        id: m.id,
        name: m.name,
        base: m.base,
        quote: m.quote,
        scuTokens: m.scuTokens,
        slaP99Ms: m.slaP99Ms,
        last: round(st.mid, 6),
        change24h: ((st.mid - st.open) / st.open) * 100,
      };
    });
  }

  // ── subscriptions ──────────────────────────────────────────────────────────
  onOrderBook(marketId: string, cb: Cb<OrderBook>): Unsub {
    const set = this.bookSubs.get(marketId) ?? new Set();
    set.add(cb);
    this.bookSubs.set(marketId, set);
    if (this.started) queueMicrotask(() => cb(this.snapshotBook(marketId)));
    return () => set.delete(cb);
  }

  onTrades(marketId: string, cb: Cb<Trade>): Unsub {
    const set = this.tradeSubs.get(marketId) ?? new Set();
    set.add(cb);
    this.tradeSubs.set(marketId, set);
    return () => set.delete(cb);
  }

  onTicker(marketId: string, cb: Cb<Ticker>): Unsub {
    const set = this.tickerSubs.get(marketId) ?? new Set();
    set.add(cb);
    this.tickerSubs.set(marketId, set);
    if (this.started) queueMicrotask(() => cb(this.snapshotTicker(marketId)));
    return () => set.delete(cb);
  }

  onJobs(cb: Cb<JobUpdate>): Unsub {
    this.jobSubs.add(cb);
    return () => this.jobSubs.delete(cb);
  }

  /** Current live mid for a market (used when redeeming credits → a run job needs a
   *  display price even though the redemption itself doesn't re-swap). */
  midPrice(marketId: string): number {
    return this.state.get(marketId)?.mid ?? 0;
  }

  // Allow the OrderTicket's MockOrderClient to inject an optimistic trade + job so
  // a user-placed order shows up in the stream + My Jobs immediately.
  injectOrder(marketId: string, side: Side, sizeScu: number, price: number): string {
    const jobId = nextJobId();
    const st = this.state.get(marketId);
    const px = price || st?.mid || 0.001;
    const trade: Trade = {
      id: nextTradeId(),
      marketId,
      ts: Date.now(),
      price: px,
      sizeScu,
      side,
      jobId,
      state: "Created",
    };
    this.emitTrade(trade);
    this.liveJobs.push({
      jobId,
      marketId,
      sizeScu,
      price: px,
      provider: PROVIDERS[Math.floor(this.rng() * PROVIDERS.length)],
      consumer: CONSUMERS[0],
      state: "Created",
      nextAt: Date.now() + 600,
      fault: "none",
    });
    this.emitJob({
      jobId,
      marketId,
      state: "Created",
      sizeScu,
      price: px,
      provider: this.liveJobs[this.liveJobs.length - 1].provider,
      consumer: CONSUMERS[0],
      ts: Date.now(),
    });
    return jobId;
  }

  // ── book model ──────────────────────────────────────────────────────────────
  private rebuildBook(marketId: string) {
    const st = this.state.get(marketId)!;
    const mid = st.mid;
    // tick size scales with price magnitude
    const tick = mid > 0.005 ? 0.00002 : mid > 0.001 ? 0.000005 : 0.000002;
    const spread = tick * (1 + Math.floor(this.rng() * 3));
    const levels = 14;

    const bids: BookLevel[] = [];
    const asks: BookLevel[] = [];
    let bidCum = 0;
    let askCum = 0;
    for (let i = 0; i < levels; i++) {
      const bidPx = round(mid - spread / 2 - i * tick * (1 + this.rng() * 0.4), 7);
      const askPx = round(mid + spread / 2 + i * tick * (1 + this.rng() * 0.4), 7);
      // size: larger near top, with chunky walls occasionally
      const wall = this.rng() > 0.86 ? 3.2 : 1;
      const bidSize = Math.floor((1400 + this.rng() * 5200) * wall * (1 - i / (levels * 1.6)));
      const askSize = Math.floor((1400 + this.rng() * 5200) * (this.rng() > 0.88 ? 3.0 : 1) * (1 - i / (levels * 1.6)));
      bidCum += Math.max(bidSize, 200);
      askCum += Math.max(askSize, 200);
      bids.push({ price: bidPx, sizeScu: Math.max(bidSize, 200), cumScu: bidCum });
      asks.push({ price: askPx, sizeScu: Math.max(askSize, 200), cumScu: askCum });
    }
    st.bookBids = bids;
    st.bookAsks = asks;
  }

  private tickBooks() {
    for (const m of UNIVERSE) {
      const st = this.state.get(m.id)!;
      // drift the mid (mean-reverting random walk)
      const drift = (this.rng() - 0.5) * 2 * m.vol * st.mid;
      const revert = (m.basePrice - st.mid) * 0.02;
      st.mid = Math.max(st.mid + drift + revert, m.basePrice * 0.4);
      st.high = Math.max(st.high, st.mid);
      st.low = st.low === 0 ? st.mid : Math.min(st.low, st.mid);

      // mutate a few existing levels in place (so depth bars fade/flash), and
      // occasionally rebuild for fresh structure.
      if (this.rng() > 0.7) {
        this.rebuildBook(m.id);
      } else {
        this.jitterBook(st);
      }
      // only push books for markets with active subscribers
      if (this.bookSubs.get(m.id)?.size) this.emitBook(m.id);
    }
  }

  private jitterBook(st: MarketState) {
    const touch = (arr: BookLevel[], asc: boolean) => {
      let cum = 0;
      for (let i = 0; i < arr.length; i++) {
        if (this.rng() > 0.6) {
          const delta = Math.floor((this.rng() - 0.45) * 1800);
          arr[i].sizeScu = Math.max(200, arr[i].sizeScu + delta);
        }
        cum += arr[i].sizeScu;
        arr[i].cumScu = cum;
      }
      void asc;
    };
    touch(st.bookBids, false);
    touch(st.bookAsks, true);
  }

  private snapshotBook(marketId: string): OrderBook {
    const st = this.state.get(marketId)!;
    return {
      marketId,
      bids: st.bookBids.map((b) => ({ ...b })),
      asks: st.bookAsks.map((a) => ({ ...a })),
      ts: Date.now(),
    };
  }

  private emitBook(marketId: string) {
    const snap = this.snapshotBook(marketId);
    this.bookSubs.get(marketId)?.forEach((cb) => cb(snap));
  }

  // ── trade stream ────────────────────────────────────────────────────────────
  private tickTrades() {
    for (const m of UNIVERSE) {
      if (!this.tradeSubs.get(m.id)?.size) continue;
      const burst = 1 + Math.floor(this.rng() * 2);
      for (let i = 0; i < burst; i++) {
        const st = this.state.get(m.id)!;
        const side: Side = this.rng() > 0.5 ? "buy" : "sell";
        const px = round(
          st.mid * (1 + (this.rng() - 0.5) * 0.0006),
          6,
        );
        const sizeScu = Math.floor(300 + this.rng() * 4200);
        st.volScu += sizeScu;
        st.usdcEscrowed = round(st.usdcEscrowed + px * sizeScu * 0.4, 2);
        this.emitTrade({
          id: nextTradeId(),
          marketId: m.id,
          ts: Date.now(),
          price: px,
          sizeScu,
          side,
          state: "Matched",
        });
      }
    }
  }

  private emitTrade(t: Trade) {
    this.tradeSubs.get(t.marketId)?.forEach((cb) => cb(t));
  }

  // ── ticker ────────────────────────────────────────────────────────────────
  private tickTickers() {
    for (const m of UNIVERSE) {
      if (!this.tickerSubs.get(m.id)?.size) continue;
      this.emitTicker(m.id);
    }
  }

  private snapshotTicker(marketId: string): Ticker {
    const st = this.state.get(marketId)!;
    return {
      marketId,
      last: round(st.mid, 6),
      change24h: ((st.mid - st.open) / st.open) * 100,
      high24h: round(st.high, 6),
      low24h: round(st.low, 6),
      volScu24h: st.volScu,
      usdcEscrowed: st.usdcEscrowed,
      usdcSettled: st.usdcSettled,
      usdcSlashed: st.usdcSlashed,
    };
  }

  private emitTicker(marketId: string) {
    const snap = this.snapshotTicker(marketId);
    this.tickerSubs.get(marketId)?.forEach((cb) => cb(snap));
  }

  // ── job lifecycle ───────────────────────────────────────────────────────────
  private spawnJob() {
    // jobs spawn on the primary live market
    const m = MARKETS[0];
    const st = this.state.get(m.id)!;
    const sizeScu = Math.floor(500 + this.rng() * 6000);
    const price = round(st.mid, 6);
    const r = this.rng();
    const fault: "none" | "slash" | "refund" =
      r > 0.9 ? "slash" : r > 0.8 ? "refund" : "none";
    const jobId = nextJobId();
    const provider = PROVIDERS[Math.floor(this.rng() * PROVIDERS.length)];
    const consumer = CONSUMERS[Math.floor(this.rng() * CONSUMERS.length)];
    this.liveJobs.push({
      jobId,
      marketId: m.id,
      sizeScu,
      price,
      provider,
      consumer,
      state: "Created",
      nextAt: Date.now() + 500 + this.rng() * 700,
      fault,
    });
    st.usdcEscrowed = round(st.usdcEscrowed + price * sizeScu, 2);
    this.emitJob({
      jobId,
      marketId: m.id,
      state: "Created",
      provider,
      consumer,
      sizeScu,
      price,
      ts: Date.now(),
    });
  }

  // happy path: Created→Matched→Escrowed→Dispatched→Executing→Attested→Verified→Settled
  private static HAPPY: JobState[] = [
    "Created",
    "Matched",
    "Escrowed",
    "Dispatched",
    "Executing",
    "Attested",
    "Verified",
    "Settled",
  ];

  private tickJobs() {
    const now = Date.now();
    for (const job of this.liveJobs) {
      if (now < job.nextAt) continue;
      // terminal states stop advancing (Expired is an intermediate fault step → Refunded)
      if (
        job.state === "Settled" ||
        job.state === "Slashed" ||
        job.state === "Refunded"
      )
        continue;

      const idx = MockDataSource.HAPPY.indexOf(job.state);
      let next: JobState;
      // fault forks: a "refund" job misses its deadline (Executing → Expired → Refunded);
      // a "slash" job is attested-but-invalid (Attested → Verified → Slashed).
      if (job.state === "Expired") {
        next = "Refunded";
      } else if (job.fault === "refund" && job.state === "Executing") {
        next = "Expired";
      } else if (job.fault === "slash" && job.state === "Verified") {
        next = "Slashed";
      } else {
        next = MockDataSource.HAPPY[Math.min(idx + 1, MockDataSource.HAPPY.length - 1)];
      }
      job.state = next;
      job.nextAt = now + 700 + this.rng() * 1300;

      const update: JobUpdate = {
        jobId: job.jobId,
        marketId: job.marketId,
        state: next,
        provider: job.provider,
        consumer: job.consumer,
        sizeScu: job.sizeScu,
        price: job.price,
        ts: now,
      };

      const st = this.state.get(job.marketId)!;
      const value = round(job.price * job.sizeScu, 4);
      if (next === "Settled") {
        update.payoutUsdc = value;
        st.usdcSettled = round(st.usdcSettled + value, 2);
        st.usdcEscrowed = round(Math.max(0, st.usdcEscrowed - value), 2);
      } else if (next === "Refunded") {
        update.refundUsdc = value;
        st.usdcEscrowed = round(Math.max(0, st.usdcEscrowed - value), 2);
      } else if (next === "Slashed") {
        const slash = round(value * 1.0, 4); // 100% bond share (invalid attestation)
        update.slashUsdc = slash;
        update.refundUsdc = value; // consumer made whole
        st.usdcSlashed = round(st.usdcSlashed + slash, 2);
        st.usdcEscrowed = round(Math.max(0, st.usdcEscrowed - value), 2);
      }
      this.emitJob(update);
    }
    // prune finished jobs occasionally to keep the array bounded
    if (this.liveJobs.length > 60) {
      this.liveJobs = this.liveJobs.filter(
        (j) =>
          !["Settled", "Slashed", "Refunded", "Expired"].includes(j.state) ||
          now - j.nextAt < 12_000,
      );
    }
  }

  private emitJob(j: JobUpdate) {
    this.jobSubs.forEach((cb) => cb(j));
  }
}

void SECONDS;
