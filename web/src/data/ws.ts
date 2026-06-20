// web/src/data/ws.ts
// Agent B — the live WS-backed MarketDataSource for the M1.5 trading terminal.
//
// Connects to the harness `--serve` WebSocket feed (default ws://127.0.0.1:8787,
// override via VITE_WS_URL) and maps its frames 1:1 onto the MarketDataSource
// callbacks (UI contract §3/§4). The wire schema is:
//
//   { t:"hello",  markets: Market[] }
//   { t:"book",   marketId, bids, asks, ts }       → onOrderBook
//   { t:"trade",  ...Trade }                        → onTrades
//   { t:"ticker", ...Ticker }                       → onTicker
//   { t:"job",    ...JobUpdate }                    → onJobs
//
// It reconnects with exponential backoff and re-sends `hello` on every (re)open
// so late subscribers always learn the market set. Self-contained and
// side-effect-free on import: no work happens until connect() is called.
//
// Imports types ONLY from "./types" (Agent A owns that file). Nothing else from
// web/ is imported here, so this file can be dropped in independently.

import type {
  JobUpdate,
  Market,
  MarketDataSource,
  OrderBook,
  Ticker,
  Trade,
  Unsub,
} from "./types";

type Status = "connecting" | "connected" | "disconnected";

// --- wire frames (what the harness `--serve` feed emits) -------------------

interface HelloFrame {
  t: "hello";
  markets: Market[];
}
interface BookFrame extends OrderBook {
  t: "book";
}
interface TradeFrame extends Trade {
  t: "trade";
}
interface TickerFrame extends Ticker {
  t: "ticker";
}
interface JobFrame extends JobUpdate {
  t: "job";
}
type Frame = HelloFrame | BookFrame | TradeFrame | TickerFrame | JobFrame;

/** Resolve the WS URL: explicit arg › VITE_WS_URL › localnet default. */
function resolveUrl(explicit?: string): string {
  if (explicit && explicit.length > 0) return explicit;
  // import.meta.env is Vite-only; guard so the module is also safe under Node/tests.
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return env?.VITE_WS_URL ?? "ws://127.0.0.1:8787";
}

/** A tiny per-key fan-out registry. */
class Emitter<T> {
  private byKey = new Map<string, Set<(v: T) => void>>();

  on(key: string, cb: (v: T) => void): Unsub {
    let set = this.byKey.get(key);
    if (!set) this.byKey.set(key, (set = new Set()));
    set.add(cb);
    return () => {
      set!.delete(cb);
      if (set!.size === 0) this.byKey.delete(key);
    };
  }

  emit(key: string, v: T): void {
    const set = this.byKey.get(key);
    if (!set) return;
    // Copy so an unsubscribe during dispatch can't mutate the set we iterate.
    for (const cb of [...set]) {
      try {
        cb(v);
      } catch {
        // A subscriber throwing must not break the feed or sibling subscribers.
      }
    }
  }
}

export class WsDataSource implements MarketDataSource {
  readonly kind = "ws" as const;

  private readonly url: string;
  private ws: WebSocket | null = null;
  private _status: Status = "disconnected";

  private _markets: Market[] = [];

  private readonly books = new Emitter<OrderBook>();
  private readonly trades = new Emitter<Trade>();
  private readonly tickers = new Emitter<Ticker>();
  private readonly jobSubs = new Set<(j: JobUpdate) => void>();

  // Reconnect/backoff state.
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  private connectResolved = false;
  private connectResolve: (() => void) | null = null;
  private helloGraceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Exponential backoff bounds (ms). */
  private static readonly BACKOFF_BASE = 500;
  private static readonly BACKOFF_MAX = 15_000;
  /** Max wait for the `hello` frame after open before resolving connect() anyway. */
  private static readonly HELLO_GRACE_MS = 1_500;

  constructor(url?: string) {
    this.url = resolveUrl(url);
  }

  /**
   * Open the socket. Resolves once the connection is live AND the `hello` frame
   * (the market set) has been received — so `markets()` is populated the moment
   * connect() resolves. If `hello` does not arrive within a short grace window
   * after open, it resolves anyway so the caller never hangs. Subsequent
   * reconnects are transparent. Never rejects — the source degrades to
   * "disconnected" and keeps retrying in the background, letting the caller fall
   * back to Mock if it prefers.
   */
  connect(): Promise<void> {
    this.closedByUser = false;
    if (this._status === "connected") return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.connectResolve = resolve;
      this.connectResolved = false;
      this.open();
    });
  }

  markets(): Market[] {
    return this._markets;
  }

  onOrderBook(marketId: string, cb: (b: OrderBook) => void): Unsub {
    return this.books.on(marketId, cb);
  }

  onTrades(marketId: string, cb: (t: Trade) => void): Unsub {
    return this.trades.on(marketId, cb);
  }

  onTicker(marketId: string, cb: (t: Ticker) => void): Unsub {
    return this.tickers.on(marketId, cb);
  }

  onJobs(cb: (j: JobUpdate) => void): Unsub {
    this.jobSubs.add(cb);
    return () => {
      this.jobSubs.delete(cb);
    };
  }

  status(): Status {
    return this._status;
  }

  /** Tear down the socket and stop reconnecting. */
  disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.helloGraceTimer) {
      clearTimeout(this.helloGraceTimer);
      this.helloGraceTimer = null;
    }
    if (this.ws) {
      // Drop handlers so the close doesn't trigger a reconnect.
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this._status = "disconnected";
  }

  // --- internals -----------------------------------------------------------

  private open(): void {
    if (this.closedByUser) return;
    this._status = "connecting";
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      // Construction itself can throw (e.g. a malformed URL) — schedule a retry.
      this._status = "disconnected";
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this._status = "connected";
      this.reconnectAttempts = 0;
      // Prefer to resolve connect() on the `hello` frame (so markets() is ready),
      // but arm a grace timer so we never hang if the server is silent.
      if (!this.connectResolved && !this.helloGraceTimer) {
        this.helloGraceTimer = setTimeout(() => {
          this.helloGraceTimer = null;
          this.resolveConnectOnce();
        }, WsDataSource.HELLO_GRACE_MS);
      }
    };

    ws.onmessage = (ev: MessageEvent) => {
      this.handleMessage(ev.data);
    };

    ws.onerror = () => {
      // `error` always precedes `close`; let onclose drive the reconnect so we
      // don't double-schedule.
    };

    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      if (this.closedByUser) {
        this._status = "disconnected";
        return;
      }
      this._status = "disconnected";
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer) return;
    const attempt = this.reconnectAttempts++;
    const delay = Math.min(
      WsDataSource.BACKOFF_MAX,
      WsDataSource.BACKOFF_BASE * 2 ** attempt,
    );
    // Full jitter so many clients don't reconnect in lockstep.
    const jittered = Math.round(delay * (0.5 + Math.random() * 0.5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, jittered);
  }

  /** Resolve the connect() promise exactly once (on `hello`, or the grace timer). */
  private resolveConnectOnce(): void {
    if (this.helloGraceTimer) {
      clearTimeout(this.helloGraceTimer);
      this.helloGraceTimer = null;
    }
    if (this.connectResolved) return;
    this.connectResolved = true;
    const r = this.connectResolve;
    this.connectResolve = null;
    r?.();
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== "string") {
      // Browsers deliver text frames as strings; ignore Blob/ArrayBuffer here.
      return;
    }
    let frame: Frame;
    try {
      frame = JSON.parse(raw) as Frame;
    } catch {
      return;
    }
    switch (frame.t) {
      case "hello":
        this._markets = Array.isArray(frame.markets) ? frame.markets : [];
        // The market set is now known — connect() can resolve with markets() ready.
        this.resolveConnectOnce();
        break;
      case "book": {
        const { t: _t, ...book } = frame;
        void _t;
        this.books.emit(book.marketId, book);
        break;
      }
      case "trade": {
        const { t: _t, ...trade } = frame;
        void _t;
        this.trades.emit(trade.marketId, trade);
        break;
      }
      case "ticker": {
        const { t: _t, ...ticker } = frame;
        void _t;
        this.tickers.emit(ticker.marketId, ticker);
        break;
      }
      case "job": {
        const { t: _t, ...job } = frame;
        void _t;
        for (const cb of [...this.jobSubs]) {
          try {
            cb(job);
          } catch {
            /* a subscriber throwing must not break the feed */
          }
        }
        break;
      }
      default:
        // Unknown frame type — ignore forward-compatibly.
        break;
    }
  }
}

export default WsDataSource;
