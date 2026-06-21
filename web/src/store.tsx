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
import {
  SuiOrderClient,
  TERMINAL_JOB_STATES,
  type JobFields,
  type JobLifecycle,
} from "./trade/sui";
import { orderClientKind, loadChainConfig, explorerTxUrl } from "./trade/config";
import type { JobResult } from "./trade/result";
import { sha2_256Hex as sha2_256HexBrowser } from "./trade/result";
import { runAudit, type AuditResult, type AuditTarget } from "./trade/audit";
import type { Account, Balances, OrderClient } from "./trade/types";

/** Build the injected OrderClient: real on-chain (VITE_ORDER_CLIENT=sui) or the mock. */
function makeOrderClient(source: MarketDataSource): OrderClient {
  if (orderClientKind() === "sui") return new SuiOrderClient();
  return new MockOrderClient(source instanceof MockDataSource ? source : undefined);
}

const MAX_TRADES = 60;
const MAX_JOBS = 80;

// ── real-chain job poll cadence (no WS feed on chain) ────────────────────────
/** How often the post-buy poller reads the Job object's on-chain `state`. */
const JOB_POLL_INTERVAL_MS = 3_000;
/** Hard stop for the poller — the GB10 demo settles in ~10-15s, so ~4 min is generous. */
const JOB_POLL_TIMEOUT_MS = 4 * 60_000;

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

/** One row in the per-wallet activity log surfaced in the ActivityBar (bottom bar).
 *  Pushed on every successful submitOrder, then updated when the tied job settles. */
export interface ActivityEntry {
  id: string;
  kind: "buy" | "sell" | "run" | "buyAndRun" | "settle";
  marketId: string;
  sizeScu: number;
  price: number;
  /** Tx digest of the submitting action (links to Suiscan when on a real network). */
  digest?: string;
  /** Job id, for run/buyAndRun entries (so a settle update can find this row). */
  jobId?: string;
  /** Wallet that performed the action; the UI filters to the connected account. */
  account?: string;
  status: "submitted" | "settled" | "failed";
  ts: number;
}

const MAX_ACTIVITY = 50;

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

  /** Per-wallet order/activity log (newest first, bounded). The ActivityBar filters
   *  this to the connected account and links each entry to Suiscan. */
  activity: ActivityEntry[];

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

  // order submission helper — wraps the OrderClient actions + records an open order.
  // The spot model decouples buying compute from running a job:
  //   • mode "buy"       → acquire credits (USDC → Credit), held in balance. NO job, NO prompt.
  //   • mode "sell"      → post an ask (sell capacity). NO job, NO prompt.
  //   • mode "run"       → redeem HELD credits → create_job + dispatch. prompt REQUIRED.
  //   • mode "buyAndRun" → atomic buy + run (SuiOrderClient.runTask). prompt REQUIRED.
  // Only the job-creating paths (run, buyAndRun) record jobMeta + a My-Jobs row.
  submitOrder: (args: {
    mode: "buy" | "sell" | "run" | "buyAndRun";
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

  // ── F7 in-browser audit (pool-free-e2e §4) ─────────────────────────────────
  /** Per-job F7 audit result (hash/sig/model checks), keyed by jobId. */
  audits: Record<string, AuditResult>;
  /** Per-job audit-run status for the drawer UI. */
  auditStatus: Record<string, "idle" | "running" | "error">;
  /** jobId currently shown in the AuditDrawer (null = closed). */
  auditingJobId: string | null;
  /** Open the AuditDrawer for a job and run the F7 audit if not already run. */
  openAudit: (jobId: string) => void;
  closeAudit: () => void;
  /** (Re)run the F7 audit for a job. */
  runJobAudit: (jobId: string) => Promise<void>;
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
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [prefillPrice, setPrefillPrice] = useState<number | null>(null);

  const [account, setAccount] = useState<Account | null>(null);
  // mirror for callbacks (onJobs) that resubscribe only on `source`, so a settle update
  // attributes to the wallet connected at settle time without re-running the effect.
  const accountRef = useRef<Account | null>(account);
  accountRef.current = account;
  const [balances, setBalances] = useState<Balances | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [funding, setFunding] = useState(false);

  // verifiable-result state
  const isLiveChain = orderClientKind() === "sui";
  const chainCfgRef = useRef(loadChainConfig());
  const [results, setResults] = useState<Record<string, JobResult>>({});
  // mirror of `results` for callbacks that read it right after an async fetch (avoids
  // stale-closure reads when the audit runs immediately after fetchResult resolves).
  const resultsRef = useRef<Record<string, JobResult>>({});
  resultsRef.current = results;
  const [resultStatus, setResultStatus] = useState<
    Record<string, "idle" | "loading" | "error">
  >({});
  const [resultErrors, setResultErrors] = useState<Record<string, string>>({});
  const [viewingJobId, setViewingJobId] = useState<string | null>(null);
  // per-job buy-time metadata (prompt/cost/digest) for the viewer
  const jobMetaRef = useRef<Record<string, JobMeta>>({});
  // per-job on-chain Job fields (inline input + I/O hash/blob commitments), read once at
  // result-fetch time and reused by the F7 audit so the input check uses real chain bytes.
  const jobFieldsRef = useRef<Record<string, JobFields>>({});

  // Active real-chain job pollers, keyed by jobId. Each entry is an interval handle started
  // after a real-chain run/buyAndRun; cleared on terminal state, timeout, or unmount.
  const jobPollersRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  // Forward refs so the poller (started inside submitOrder) can trigger the result fetch +
  // viewer open, which are declared further down. Filled in an effect below.
  const fetchResultRef = useRef<((jobId: string) => Promise<void>) | null>(null);
  const openResultRef = useRef<((jobId: string) => void) | null>(null);
  // submitOrder is declared before pollJobOnChain, so it reaches the poller via this ref.
  const pollJobOnChainRef = useRef<((jobId: string) => void) | null>(null);

  // F7 in-browser audit state
  const [audits, setAudits] = useState<Record<string, AuditResult>>({});
  const [auditStatus, setAuditStatus] = useState<
    Record<string, "idle" | "running" | "error">
  >({});
  const [auditingJobId, setAuditingJobId] = useState<string | null>(null);

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

  // ── job lifecycle feed (mock/demo only) ─────────────────────────────────────
  // On the live chain, "My Jobs"/"History" must reflect ONLY the connected wallet's
  // real jobs — those are added directly by submitOrder / runTask. The data source's
  // onJobs feed is the mock simulator's synthetic *global* activity, so injecting it
  // would randomly fill history with trades that aren't yours. Skip it entirely when live.
  useEffect(() => {
    if (isLiveChain) return;
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

      // Activity log: when a job reaches a terminal on-chain outcome, reflect it on the
      // entry that created the job (run/buyAndRun) — or append a standalone settle row if
      // we never saw the create (e.g. mock-injected jobs). Keyed by jobId.
      const terminal =
        j.state === "Settled" || j.state === "Slashed" || j.state === "Refunded";
      if (terminal) {
        setActivity((prev) => {
          const idx = prev.findIndex(
            (e) => e.jobId === j.jobId && e.kind !== "settle",
          );
          if (idx >= 0) {
            // mark the originating run/buyAndRun row as settled (or failed on slash).
            const next = prev.slice();
            next[idx] = {
              ...next[idx],
              status: j.state === "Slashed" ? "failed" : "settled",
              ts: j.ts,
            };
            return next;
          }
          // no originating row (mock job) — append a settle entry so the outcome shows.
          if (prev.some((e) => e.id === `settle-${j.jobId}`)) return prev;
          const entry: ActivityEntry = {
            id: `settle-${j.jobId}`,
            kind: "settle",
            marketId: j.marketId,
            sizeScu: j.sizeScu,
            price: j.price,
            jobId: j.jobId,
            account: j.consumer ?? accountRef.current?.address,
            status: j.state === "Slashed" ? "failed" : "settled",
            ts: j.ts,
          };
          return [entry, ...prev].slice(0, MAX_ACTIVITY);
        });
      }
    });
    return () => un();
  }, [source, isLiveChain]);

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
    async ({ mode, side, type, price, sizeScu, prompt }) => {
      const client = orderClientRef.current;
      const mkt = activeMarketId;
      // A run/buyAndRun creates a job (and a result target); a plain buy/sell is just a
      // trade — credits move, but nothing is dispatched.
      const createsJob = mode === "run" || mode === "buyAndRun";

      let res;
      if (mode === "buyAndRun") {
        // The one-click consumer shortcut: atomic buy + run. The real client POSTs the
        // prompt to /inputs then create_jobs inline (runTask); the mock buys then runs.
        if (client instanceof SuiOrderClient) {
          res = await client.runTask({
            marketId: mkt,
            qtyScu: sizeScu,
            priceUsdcPerScu: price,
            prompt: prompt ?? "",
          });
        } else {
          const bought = await client.buy(mkt, sizeScu, price);
          res = bought.ok
            ? await client.run({ marketId: mkt, qtyScu: sizeScu, prompt: prompt ?? "" })
            : bought;
        }
      } else if (mode === "run") {
        // Redeem held credits → create_job + dispatch. No swap.
        res = await client.run({ marketId: mkt, qtyScu: sizeScu, prompt: prompt ?? "" });
      } else if (mode === "buy") {
        // Acquire credits only — held in balance, no job, no prompt.
        res = await client.buy(mkt, sizeScu, price);
      } else {
        res = await client.sell(mkt, sizeScu, price);
      }

      if (res.ok) {
        const now = Date.now();
        const order: OpenOrder = {
          id: res.jobId ?? `ord-${now.toString(36)}`,
          marketId: mkt,
          side,
          type,
          price,
          sizeScu,
          filledScu: 0,
          ts: now,
          status: "open",
        };
        setOpenOrders((prev) => [order, ...prev].slice(0, 40));

        // Record the activity entry for EVERY mode (buy/sell/run/buyAndRun). A run/
        // buyAndRun row is later flipped to settled/failed by the job-lifecycle feed
        // (matched on jobId). Tied to the connected wallet for per-account filtering.
        const entry: ActivityEntry = {
          id: res.jobId ?? `act-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          kind: mode,
          marketId: mkt,
          sizeScu,
          price,
          digest: res.digest,
          jobId: res.jobId,
          account: account?.address,
          status: "submitted",
          ts: now,
        };
        setActivity((prev) => [entry, ...prev].slice(0, MAX_ACTIVITY));

        // Only job-creating paths (run, buyAndRun) record job metadata + a My Jobs row.
        // Record buy-time metadata + (for the real chain, where there's no WS feed
        // injecting it) an optimistic My Jobs row so the job is trackable and the result
        // viewer has a target. The mock source injects its own job.
        if (createsJob && res.jobId) {
          jobMetaRef.current[res.jobId] = {
            prompt,
            costUsdc: price * sizeScu,
            digest: res.digest,
          };
          if (client instanceof SuiOrderClient) {
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
            // The live chain has no WS lifecycle feed, so poll the Job object on-chain to
            // advance Dispatched→…→Settled and auto-fetch + render the result on settle.
            pollJobOnChainRef.current?.(res.jobId);
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

  // ── real-chain job poller ────────────────────────────────────────────────────
  // On the live chain there is NO WS lifecycle feed (the mock's onJobs is gated off when
  // live — see the job-lifecycle effect). So after a run/buyAndRun creates a Job we poll the
  // shared Job object's on-chain `state` every JOB_POLL_INTERVAL_MS until it reaches a
  // terminal state (or the timeout). Each tick maps state u8 → JobState and advances the
  // matching JobRow + OpenOrder; once the result is fetchable (Verified/Settled) it auto-
  // fetches the output and surfaces the ResultViewer so the answer renders without a click.
  const pollJobOnChain = useCallback((jobId: string) => {
    const client = orderClientRef.current;
    // Gate strictly to the real-chain client — mock jobs are driven by the onJobs feed.
    if (!(client instanceof SuiOrderClient)) return;
    // Don't double-poll a job already being watched (e.g. a quick re-submit of the same id).
    if (jobPollersRef.current[jobId]) return;

    const startedAt = Date.now();
    // Whether we've already kicked the auto result fetch (only do it once, on first ready).
    let resultTriggered = false;

    const stop = () => {
      const handle = jobPollersRef.current[jobId];
      if (handle) {
        clearInterval(handle);
        delete jobPollersRef.current[jobId];
      }
    };

    const applyLifecycle = (life: JobLifecycle) => {
      const { state } = life;
      const now = Date.now();

      // Advance the My-Jobs row to the live on-chain state.
      setJobs((prev) => {
        const idx = prev.findIndex((j) => j.jobId === jobId);
        if (idx < 0) return prev;
        if (prev[idx].state === state) return prev; // no change → no re-render churn
        const next = prev.slice();
        next[idx] = { ...next[idx], state, updatedTs: now };
        return next;
      });

      // Reconcile the open order: past Dispatched the fill is real → mark filled/100%.
      setOpenOrders((prev) =>
        prev.map((o) =>
          o.id === jobId && o.status === "open"
            ? { ...o, status: "filled", filledScu: o.sizeScu }
            : o,
        ),
      );

      // Mirror a terminal outcome onto the originating activity row (the live path has no
      // onJobs feed to do this), matching the mock feed's behavior.
      if (TERMINAL_JOB_STATES.has(state)) {
        setActivity((prev) => {
          const i = prev.findIndex((e) => e.jobId === jobId && e.kind !== "settle");
          if (i < 0) return prev;
          const updated = prev.slice();
          updated[i] = {
            ...updated[i],
            status: state === "Slashed" ? "failed" : "settled",
            ts: now,
          };
          return updated;
        });
      }

      // Auto-fetch + surface the result the moment it's available. On a VALID verdict the
      // chain jumps Executing→Verified→Settled (job.move record_attestation), so Verified/
      // Settled mean the output + on-chain output_hash are recorded — trigger once and open
      // the viewer so the answer renders without a manual "view" click. A bare `Attested`
      // only happens for a FAILING verdict (→ refund/slash) and carries no usable result, so
      // it's deliberately excluded. Slashed/Refunded/Expired likewise carry no result.
      const resultReady = state === "Verified" || state === "Settled";
      if (resultReady && !resultTriggered) {
        resultTriggered = true;
        const open = openResultRef.current;
        const fetch = fetchResultRef.current;
        // openResult both fetches (if not cached) AND opens the ResultViewer.
        if (open) open(jobId);
        else if (fetch) void fetch(jobId);
      }

      // Stop on any terminal state — settlement is done, nothing more to poll.
      if (TERMINAL_JOB_STATES.has(state)) stop();
    };

    const tick = async () => {
      if (Date.now() - startedAt > JOB_POLL_TIMEOUT_MS) {
        stop();
        return;
      }
      try {
        const life = await client.getJobState(jobId);
        if (life) applyLifecycle(life);
      } catch (e) {
        // Transient RPC error — keep polling; the timeout bounds the retries.
        console.warn("[gix] job poll tick failed", e);
      }
    };

    // Kick an immediate read (the GB10 can settle before the first interval fires), then poll.
    void tick();
    jobPollersRef.current[jobId] = setInterval(() => void tick(), JOB_POLL_INTERVAL_MS);
  }, []);
  pollJobOnChainRef.current = pollJobOnChain;

  // Stop every active poller on unmount (or when the order client changes).
  useEffect(() => {
    const pollers = jobPollersRef.current;
    return () => {
      for (const id of Object.keys(pollers)) clearInterval(pollers[id]);
      jobPollersRef.current = {};
    };
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
        const mockResult: JobResult = {
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
        };
        resultsRef.current = { ...resultsRef.current, [jobId]: mockResult };
        setResults((prev) => ({ ...prev, [jobId]: mockResult }));
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
        // Read the on-chain Job fields once (inline input + I/O hash/blob commitments) and
        // cache them so the F7 audit reuses the same authoritative bytes (no double read).
        const jobFields = await client.readJobFields(jobId);
        if (jobFields) jobFieldsRef.current[jobId] = jobFields;
        const r = await client.getResult(jobId, {
          costUsdc: meta?.costUsdc,
          digest: meta?.digest,
          jobFields,
        });
        resultsRef.current = { ...resultsRef.current, [jobId]: r };
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

  // Keep the forward refs the poller uses in sync (it's created before these callbacks).
  fetchResultRef.current = fetchResult;
  openResultRef.current = openResult;

  const explorerUrl = useCallback(
    (digest?: string) => explorerTxUrl(chainCfgRef.current, digest),
    [],
  );

  // ── F7 in-browser audit (pool-free-e2e §4) ──────────────────────────────────
  // Assemble an AuditTarget from the verified result + per-job metadata + chain config,
  // then run the F7 independent audit. Real on-chain values (blob ids, input/model hash,
  // signature) aren't surfaced to the UI yet, so the auditor degrades to mock-synthesis
  // for those (clearly labelled) while verifying whatever IS available live.
  const runJobAudit = useCallback(
    async (jobId: string) => {
      setAuditStatus((prev) => ({ ...prev, [jobId]: "running" }));
      try {
        const cfg = chainCfgRef.current;
        const r = resultsRef.current[jobId];
        const meta = jobMetaRef.current[jobId];
        const jf = jobFieldsRef.current[jobId];
        const target: AuditTarget = {
          jobId,
          live: isLiveChain,
          model: r?.model ?? cfg.market.name,
          inputText: meta?.prompt,
          outputText: r?.output,
          // Option 3 (§C): for inline-input jobs the input is verified from the on-chain
          // job.input bytes (+ sha2_256) — not Walrus. Output check stays Walrus (by blob
          // id). Hashes come straight off the on-chain Job object when live.
          inlineInputBytes: jf?.input && jf.input.length > 0 ? jf.input : undefined,
          inputHash: jf?.inputHashHex,
          outputHash: jf?.outputHashHex ?? r?.reportedOutputHash,
          outputBlobId: jf?.outputBlobId,
          attestPubkey: r?.providerPubkey,
          explorerObjectBase: cfg.explorerObjectBase,
          walrusAggregator: cfg.walrusAggregator,
        };
        const audit = await runAudit(target);
        setAudits((prev) => ({ ...prev, [jobId]: audit }));
        setAuditStatus((prev) => ({ ...prev, [jobId]: "idle" }));
      } catch {
        setAuditStatus((prev) => ({ ...prev, [jobId]: "error" }));
      }
    },
    [results, isLiveChain],
  );

  const openAudit = useCallback(
    (jobId: string) => {
      setAuditingJobId(jobId);
      // ensure we have the result first (it carries the output + on-chain output_hash the
      // audit re-hashes), THEN run the F7 audit so it audits the real bytes, not a stub.
      void (async () => {
        if (!results[jobId]) await fetchResult(jobId);
        if (!audits[jobId]) await runJobAudit(jobId);
      })();
    },
    [results, audits, fetchResult, runJobAudit],
  );
  const closeAudit = useCallback(() => setAuditingJobId(null), []);

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
      activity,
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
      audits,
      auditStatus,
      auditingJobId,
      openAudit,
      closeAudit,
      runJobAudit,
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
      activity,
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
      audits,
      auditStatus,
      auditingJobId,
      openAudit,
      closeAudit,
      runJobAudit,
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
