// web/src/store.tsx
// App-wide live state, fed by the injected MarketDataSource and OrderClient.
// Components read slices of this via the useGix() hook. Subscriptions are wired
// per active market; switching markets re-subscribes.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createDataSource } from "./data";
import { MockDataSource } from "./data/mock";
import type {
  JobState,
  JobUpdate,
  Market,
  MarketDataSource,
  OrderBook,
  Ticker,
  Trade,
} from "./data/types";
import { MockOrderClient } from "./trade/mock";
import { SuiOrderClient } from "./trade/sui";
import { orderClientKind, loadChainConfig, explorerTxUrl } from "./trade/config";
import type { JobResult } from "./trade/result";
import { sha2_256Hex as sha2_256HexBrowser } from "./trade/result";
import type { Account, Balances, OrderClient } from "./trade/types";

/** Build the injected OrderClient: real on-chain (VITE_ORDER_CLIENT=sui) or the mock. */
function makeOrderClient(source: MarketDataSource): OrderClient {
  if (orderClientKind() === "sui") return new SuiOrderClient();
  return new MockOrderClient(source instanceof MockDataSource ? source : undefined);
}

const MAX_TRADES = 60;
const MAX_JOBS = 80;

export interface OpenOrder {
  id: string;
  marketId: string;
  side: "buy" | "sell";
  type: "limit" | "market";
  price: number;
  sizeScu: number;
  filledScu: number;
  ts: number;
  status: "open" | "filled" | "canceled";
}

export interface JobRow {
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
  createdTs: number;
  updatedTs: number;
}

interface GixState {
  source: MarketDataSource;
  orderClient: OrderClient;
  status: "connecting" | "connected" | "disconnected";
  markets: Market[];
  activeMarketId: string;
  setActiveMarket: (id: string) => void;

  book: OrderBook | null;
  trades: Trade[];
  ticker: Ticker | null;
  tickersByMarket: Record<string, Ticker>;
  jobs: JobRow[];
  openOrders: OpenOrder[];

  // ticket prefill (set when a book row is clicked)
  prefillPrice: number | null;
  setPrefillPrice: (p: number | null) => void;

  // wallet
  account: Account | null;
  balances: Balances | null;
  connecting: boolean;
  funding: boolean;
  connectWallet: () => Promise<void>;
  fundWallet: () => Promise<void>;
  refreshBalances: () => Promise<void>;

  // order submission helper — wraps OrderClient.buy/sell + records an open order.
  // `prompt` is the real inference task to run (demo-contract runTask); buys with a
  // prompt route through SuiOrderClient.runTask when the real client is wired.
  submitOrder: (args: {
    side: "buy" | "sell";
    type: "limit" | "market";
    price: number;
    sizeScu: number;
    prompt?: string;
  }) => Promise<{ ok: boolean; error?: string; jobId?: string; digest?: string }>;
  cancelOrder: (id: string) => void;

  // ── verifiable results (demo-contract §3.1 result viewer) ──────────────────
  /** Whether the real on-chain OrderClient is wired (vs the mock). */
  isLiveChain: boolean;
  /** Verified results fetched from the provider, keyed by jobId. */
  results: Record<string, JobResult>;
  /** Per-job result-fetch status for the viewer UI. */
  resultStatus: Record<string, "idle" | "loading" | "error">;
  resultErrors: Record<string, string>;
  /** Fetch + verify GET /result/:jobId, store it, and open the viewer on that job. */
  fetchResult: (jobId: string) => Promise<void>;
  /** jobId currently shown in the ResultViewer (null = closed). */
  viewingJobId: string | null;
  openResult: (jobId: string) => void;
  closeResult: () => void;
  /** Explorer URL for a tx digest (empty on localnet). */
  explorerUrl: (digest?: string) => string | undefined;
}

/** Per-job metadata captured at buy time so the result viewer can show cost + digest. */
interface JobMeta {
  prompt?: string;
  costUsdc?: number;
  digest?: string;
}

const Ctx = createContext<GixState | null>(null);

export function GixProvider({ children }: { children: ReactNode }) {
  // The data source kind is configurable; default mock. createDataSource('ws') /
  // createDataSource('deepbook') guard their lazy imports so a missing/uncon-
  // figured source never breaks the app (each degrades to mock).
  const kindEnv =
    (import.meta.env?.VITE_DATA_SOURCE as "mock" | "ws" | "deepbook") ?? "mock";

  const [source, setSource] = useState<MarketDataSource>(() => new MockDataSource());
  const sourceRef = useRef(source);
  sourceRef.current = source;

  const orderClientRef = useRef<OrderClient>(makeOrderClient(source));

  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected">(
    "connecting",
  );
  const [markets, setMarkets] = useState<Market[]>([]);
  const [activeMarketId, setActiveMarketId] = useState<string>("");

  const [book, setBook] = useState<OrderBook | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [ticker, setTicker] = useState<Ticker | null>(null);
  const [tickersByMarket, setTickersByMarket] = useState<Record<string, Ticker>>({});
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [openOrders, setOpenOrders] = useState<OpenOrder[]>([]);
  const [prefillPrice, setPrefillPrice] = useState<number | null>(null);

  const [account, setAccount] = useState<Account | null>(null);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [funding, setFunding] = useState(false);

  // verifiable-result state
  const isLiveChain = orderClientKind() === "sui";
  const chainCfgRef = useRef(loadChainConfig());
  const [results, setResults] = useState<Record<string, JobResult>>({});
  const [resultStatus, setResultStatus] = useState<
    Record<string, "idle" | "loading" | "error">
  >({});
  const [resultErrors, setResultErrors] = useState<Record<string, string>>({});
  const [viewingJobId, setViewingJobId] = useState<string | null>(null);
  // per-job buy-time metadata (prompt/cost/digest) for the viewer
  const jobMetaRef = useRef<Record<string, JobMeta>>({});

  // ── connect the data source once ──────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    (async () => {
      const src =
        kindEnv === "ws" || kindEnv === "deepbook"
          ? await createDataSource(kindEnv)
          : sourceRef.current;
      if (!alive) return;
      if (src !== sourceRef.current) {
        setSource(src);
        orderClientRef.current = makeOrderClient(src);
      }
      await src.connect();
      if (!alive) return;
      const ms = src.markets();
      setMarkets(ms);
      setActiveMarketId((cur) => cur || ms[0]?.id || "");
      setStatus(src.status());
    })();

    const poll = setInterval(() => {
      setStatus(sourceRef.current.status());
      setMarkets(sourceRef.current.markets());
    }, 2000);

    return () => {
      alive = false;
      clearInterval(poll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── per-market subscriptions ────────────────────────────────────────────────
  useEffect(() => {
    if (!activeMarketId) return;
    const src = sourceRef.current;
    setTrades([]);
    setBook(null);

    const unBook = src.onOrderBook(activeMarketId, (b) => setBook(b));
    const unTrades = src.onTrades(activeMarketId, (t) => {
      setTrades((prev) => [t, ...prev].slice(0, MAX_TRADES));
    });
    const unTicker = src.onTicker(activeMarketId, (t) => {
      setTicker(t);
      setTickersByMarket((prev) => ({ ...prev, [t.marketId]: t }));
    });
    return () => {
      unBook();
      unTrades();
      unTicker();
    };
  }, [activeMarketId, source]);

  // ── ticker for ALL markets (so the sidebar mini-prices move) ────────────────
  useEffect(() => {
    const src = sourceRef.current;
    const unsubs = src.markets().map((m) =>
      src.onTicker(m.id, (t) =>
        setTickersByMarket((prev) => ({ ...prev, [t.marketId]: t })),
      ),
    );
    return () => unsubs.forEach((u) => u());
  }, [source, markets.length]);

  // ── job lifecycle feed (global) ─────────────────────────────────────────────
  useEffect(() => {
    const src = sourceRef.current;
    const un = src.onJobs((j: JobUpdate) => {
      setJobs((prev) => {
        const idx = prev.findIndex((r) => r.jobId === j.jobId);
        const row: JobRow = {
          jobId: j.jobId,
          marketId: j.marketId,
          state: j.state,
          provider: j.provider ?? prev[idx]?.provider,
          consumer: j.consumer ?? prev[idx]?.consumer,
          sizeScu: j.sizeScu,
          price: j.price,
          payoutUsdc: j.payoutUsdc ?? prev[idx]?.payoutUsdc,
          refundUsdc: j.refundUsdc ?? prev[idx]?.refundUsdc,
          slashUsdc: j.slashUsdc ?? prev[idx]?.slashUsdc,
          createdTs: idx >= 0 ? prev[idx].createdTs : j.ts,
          updatedTs: j.ts,
        };
        let next: JobRow[];
        if (idx >= 0) {
          next = prev.slice();
          next[idx] = row;
        } else {
          next = [row, ...prev];
        }
        // newest-updated first
        next.sort((a, b) => b.updatedTs - a.updatedTs);
        return next.slice(0, MAX_JOBS);
      });

      // reconcile open orders: when a job tied to one of our orders progresses past
      // Matched, mark it filled.
      setOpenOrders((prev) =>
        prev.map((o) =>
          o.id === j.jobId && j.state !== "Created"
            ? { ...o, status: "filled", filledScu: o.sizeScu }
            : o,
        ),
      );
    });
    return () => un();
  }, [source]);

  const setActiveMarket = useCallback((id: string) => {
    setActiveMarketId(id);
    setPrefillPrice(null);
  }, []);

  // ── wallet actions ──────────────────────────────────────────────────────────
  const refreshBalances = useCallback(async () => {
    try {
      const b = await orderClientRef.current.balances();
      setBalances(b);
    } catch {
      /* noop */
    }
  }, []);

  const connectWallet = useCallback(async () => {
    setConnecting(true);
    try {
      const acc = await orderClientRef.current.connect();
      setAccount(acc);
      await refreshBalances();
    } finally {
      setConnecting(false);
    }
  }, [refreshBalances]);

  const fundWallet = useCallback(async () => {
    setFunding(true);
    try {
      await orderClientRef.current.fund();
      await refreshBalances();
    } finally {
      setFunding(false);
    }
  }, [refreshBalances]);

  const submitOrder = useCallback<GixState["submitOrder"]>(
    async ({ side, type, price, sizeScu, prompt }) => {
      const client = orderClientRef.current;
      const mkt = activeMarketId;
      // A buy with the real client routes through runTask so the prompt (the actual
      // inference task) is POSTed to the provider /inputs before create_job.
      let res;
      if (side === "buy" && client instanceof SuiOrderClient) {
        res = await client.runTask({
          marketId: mkt,
          qtyScu: sizeScu,
          priceUsdcPerScu: price,
          prompt: prompt ?? "",
        });
      } else if (side === "buy") {
        res = await client.buy(mkt, sizeScu, price);
      } else {
        res = await client.sell(mkt, sizeScu, price);
      }
      if (res.ok) {
        const order: OpenOrder = {
          id: res.jobId ?? `ord-${Date.now().toString(36)}`,
          marketId: mkt,
          side,
          type,
          price,
          sizeScu,
          filledScu: 0,
          ts: Date.now(),
          status: "open",
        };
        setOpenOrders((prev) => [order, ...prev].slice(0, 40));

        // Record buy-time metadata + (for the real chain, where there's no WS feed
        // injecting it) an optimistic My Jobs row so the bought job is trackable and
        // the result viewer has a target. The mock source injects its own job.
        if (res.jobId) {
          jobMetaRef.current[res.jobId] = {
            prompt,
            costUsdc: price * sizeScu,
            digest: res.digest,
          };
          if (client instanceof SuiOrderClient) {
            const now = Date.now();
            setJobs((prev) => {
              if (prev.some((j) => j.jobId === res!.jobId)) return prev;
              const row: JobRow = {
                jobId: res!.jobId!,
                marketId: mkt,
                state: "Dispatched",
                consumer: account?.address,
                sizeScu,
                price,
                createdTs: now,
                updatedTs: now,
              };
              return [row, ...prev].slice(0, MAX_JOBS);
            });
          }
        }
        await refreshBalances();
      }
      return res;
    },
    [activeMarketId, refreshBalances, account],
  );

  const cancelOrder = useCallback((id: string) => {
    setOpenOrders((prev) =>
      prev.map((o) => (o.id === id ? { ...o, status: "canceled" } : o)),
    );
  }, []);

  // ── verifiable result actions (demo-contract §3.1) ──────────────────────────
  const fetchResult = useCallback(
    async (jobId: string) => {
      const client = orderClientRef.current;
      // Only the real SuiOrderClient can GET /result/:jobId from the provider.
      if (!(client instanceof SuiOrderClient)) {
        const job = jobs.find((j) => j.jobId === jobId);
        // Mock/demo fallback: synthesize a believable verified result so the viewer
        // works end-to-end on mock data (no provider running).
        const meta = jobMetaRef.current[jobId];
        const output =
          meta?.prompt && meta.prompt.length > 0
            ? mockCompletion(meta.prompt)
            : "Mock completion — run with VITE_ORDER_CLIENT=sui + a live provider for the real model output.";
        const localHash = await sha2_256HexBrowser(output);
        setResults((prev) => ({
          ...prev,
          [jobId]: {
            jobId,
            model: chainCfgRef.current.market.name,
            output,
            localOutputHash: localHash,
            reportedOutputHash: localHash,
            verified: true,
            outputTokenCount: Math.ceil(output.length / 4),
            tStart: job?.createdTs ?? Date.now() - 1500,
            tEnd: job?.updatedTs ?? Date.now(),
            providerPubkey: "mock-attestation-key",
            costUsdc: meta?.costUsdc ?? (job ? job.price * job.sizeScu : undefined),
            digest: meta?.digest,
          },
        }));
        setResultStatus((prev) => ({ ...prev, [jobId]: "idle" }));
        return;
      }

      setResultStatus((prev) => ({ ...prev, [jobId]: "loading" }));
      setResultErrors((prev) => {
        const next = { ...prev };
        delete next[jobId];
        return next;
      });
      try {
        const meta = jobMetaRef.current[jobId];
        const r = await client.getResult(jobId, {
          costUsdc: meta?.costUsdc,
          digest: meta?.digest,
        });
        setResults((prev) => ({ ...prev, [jobId]: r }));
        setResultStatus((prev) => ({ ...prev, [jobId]: "idle" }));
      } catch (e) {
        setResultStatus((prev) => ({ ...prev, [jobId]: "error" }));
        setResultErrors((prev) => ({ ...prev, [jobId]: (e as Error).message }));
      }
    },
    [jobs],
  );

  const openResult = useCallback(
    (jobId: string) => {
      setViewingJobId(jobId);
      if (!results[jobId]) void fetchResult(jobId);
    },
    [results, fetchResult],
  );
  const closeResult = useCallback(() => setViewingJobId(null), []);
  const explorerUrl = useCallback(
    (digest?: string) => explorerTxUrl(chainCfgRef.current, digest),
    [],
  );

  const value = useMemo<GixState>(
    () => ({
      source,
      orderClient: orderClientRef.current,
      status,
      markets,
      activeMarketId,
      setActiveMarket,
      book,
      trades,
      ticker,
      tickersByMarket,
      jobs,
      openOrders,
      prefillPrice,
      setPrefillPrice,
      account,
      balances,
      connecting,
      funding,
      connectWallet,
      fundWallet,
      refreshBalances,
      submitOrder,
      cancelOrder,
      isLiveChain,
      results,
      resultStatus,
      resultErrors,
      fetchResult,
      viewingJobId,
      openResult,
      closeResult,
      explorerUrl,
    }),
    [
      source,
      status,
      markets,
      activeMarketId,
      setActiveMarket,
      book,
      trades,
      ticker,
      tickersByMarket,
      jobs,
      openOrders,
      prefillPrice,
      account,
      balances,
      connecting,
      funding,
      connectWallet,
      fundWallet,
      refreshBalances,
      submitOrder,
      cancelOrder,
      isLiveChain,
      results,
      resultStatus,
      resultErrors,
      fetchResult,
      viewingJobId,
      openResult,
      closeResult,
      explorerUrl,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useGix(): GixState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useGix must be used within <GixProvider>");
  return v;
}

export function useActiveMarket(): Market | undefined {
  const { markets, activeMarketId } = useGix();
  return markets.find((m) => m.id === activeMarketId);
}

/** A believable canned completion for the mock result viewer (no provider running).
 *  The real model output comes from the provider /result with VITE_ORDER_CLIENT=sui. */
function mockCompletion(prompt: string): string {
  const p = prompt.trim();
  return (
    `[demo completion · llama3.1:8b]\n\n` +
    `In response to: "${p.length > 120 ? p.slice(0, 120) + "…" : p}"\n\n` +
    `This output is generated by the mock client so the verifiable-result panel works ` +
    `without a live provider. Re-hashing this text yields the hash shown below, which a ` +
    `real run checks against the on-chain output_hash recorded in the job's attestation.`
  );
}
