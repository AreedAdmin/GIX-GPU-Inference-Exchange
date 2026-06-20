// web/src/data/types.ts
// BINDING data interface for the GIX trading terminal (MVP M1.5 UI contract §3).
// The UI consumes exactly ONE injected `MarketDataSource`. Default = MockDataSource;
// swap to WsDataSource (Agent B, web/src/data/ws.ts) with a single line. Keep the UI
// backend-agnostic — this is the M2/DeepBook seam.

export type Side = "buy" | "sell";

export type JobState =
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

export interface Market {
  id: string;
  name: string;
  base: "SCU";
  quote: "USDC";
  scuTokens: number;
  slaP99Ms: number;
  last: number;
  change24h: number;
}

export interface BookLevel {
  price: number;
  sizeScu: number;
  cumScu: number;
}

export interface OrderBook {
  marketId: string;
  bids: BookLevel[];
  asks: BookLevel[];
  ts: number;
}

export interface Trade {
  id: string;
  marketId: string;
  ts: number;
  price: number;
  sizeScu: number;
  side: Side;
  jobId?: string;
  state?: JobState;
}

export interface Ticker {
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

export interface JobUpdate {
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

export type Unsub = () => void;

export interface MarketDataSource {
  readonly kind: "mock" | "ws" | "deepbook";
  connect(): Promise<void>;
  markets(): Market[];
  onOrderBook(marketId: string, cb: (b: OrderBook) => void): Unsub;
  onTrades(marketId: string, cb: (t: Trade) => void): Unsub;
  onTicker(marketId: string, cb: (t: Ticker) => void): Unsub;
  onJobs(cb: (j: JobUpdate) => void): Unsub;
  status(): "connecting" | "connected" | "disconnected";
}
