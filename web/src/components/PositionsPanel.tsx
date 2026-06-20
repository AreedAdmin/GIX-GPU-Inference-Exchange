import { useState } from "react";
import { useGix, type JobRow, type OpenOrder } from "../store";
import type { JobState } from "../data/types";
import { fmtScu, fmtTime, fmtUsdc, fmtPrice } from "../lib/format";
import { shortId } from "../lib/config";

type Tab = "orders" | "jobs" | "balances" | "history";

const TABS: { id: Tab; label: string }[] = [
  { id: "orders", label: "Open Orders" },
  { id: "jobs", label: "My Jobs" },
  { id: "balances", label: "Balances" },
  { id: "history", label: "History" },
];

const TERMINAL: JobState[] = ["Settled", "Refunded", "Slashed", "Expired"];

export function PositionsPanel() {
  const [tab, setTab] = useState<Tab>("jobs");
  const { jobs, openOrders } = useGix();

  const liveJobs = jobs.filter((j) => !TERMINAL.includes(j.state)).length;
  const openCount = openOrders.filter((o) => o.status === "open").length;

  return (
    <div className="glass flex h-full min-h-0 flex-col rounded-glass">
      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-border-glass px-2">
        {TABS.map((t) => {
          const active = tab === t.id;
          const badge =
            t.id === "jobs" ? liveJobs : t.id === "orders" ? openCount : 0;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`focus-amber relative flex items-center gap-1.5 rounded px-3 py-1.5 text-[12px] transition ${
                active
                  ? "text-primary"
                  : "text-muted hover:text-secondary"
              }`}
            >
              {t.label}
              {badge > 0 && (
                <span
                  className="num inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9.5px]"
                  style={{
                    background: active ? "var(--accent)" : "rgba(159,176,192,0.16)",
                    color: active ? "var(--bg-0)" : "var(--text-secondary)",
                  }}
                >
                  {badge}
                </span>
              )}
              {active && (
                <span
                  className="absolute inset-x-2 -bottom-[1px] h-[2px] rounded"
                  style={{ background: "var(--accent)" }}
                />
              )}
            </button>
          );
        })}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "orders" && <OpenOrdersTab />}
        {tab === "jobs" && <MyJobsTab />}
        {tab === "balances" && <BalancesTab />}
        {tab === "history" && <HistoryTab />}
      </div>
    </div>
  );
}

// ── My Jobs — the GIX live lifecycle "positions" view ─────────────────────────
const STAGES: JobState[] = [
  "Created",
  "Matched",
  "Escrowed",
  "Dispatched",
  "Executing",
  "Attested",
  "Verified",
  "Settled",
];

function stageIndex(s: JobState): number {
  if (s === "Expired" || s === "Refunded") return 5; // diverged around execution
  if (s === "Slashed") return 6;
  const i = STAGES.indexOf(s);
  return i < 0 ? 0 : i;
}

function MyJobsTab() {
  const { jobs, markets } = useGix();
  const nameOf = (id: string) => markets.find((m) => m.id === id)?.name ?? shortId(id);

  if (jobs.length === 0) return <Empty msg="no jobs yet — place an order or wait for the stream" />;

  return (
    <table className="w-full border-collapse text-[11.5px]">
      <thead>
        <tr className="sticky top-0 z-10 bg-elev/80 backdrop-blur">
          <Th className="text-left">Job</Th>
          <Th className="text-left">Market</Th>
          <Th>Size·SCU</Th>
          <Th>Price·USDC</Th>
          <Th className="w-[30%] text-left">Lifecycle</Th>
          <Th>USDC</Th>
          <Th>Result</Th>
          <Th>Updated</Th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((j) => (
          <JobRowView key={j.jobId} job={j} market={nameOf(j.marketId)} />
        ))}
      </tbody>
    </table>
  );
}

// states at/after which the provider can serve a /result (attestation recorded)
const RESULT_READY: JobState[] = ["Attested", "Verified", "Settled"];

function JobRowView({ job, market }: { job: JobRow; market: string }) {
  const { openResult, results } = useGix();
  const settled = job.state === "Settled";
  const slashed = job.state === "Slashed";
  const refunded = job.state === "Refunded" || job.state === "Expired";
  const terminal = TERMINAL.includes(job.state);
  const resultReady = RESULT_READY.includes(job.state);
  const fetched = results[job.jobId];

  const amountCell = slashed
    ? { v: `-${fmtUsdc(job.slashUsdc ?? 0, 2)}`, c: "var(--sell)" }
    : settled
      ? { v: `+${fmtUsdc(job.payoutUsdc ?? 0, 2)}`, c: "var(--buy)" }
      : refunded
        ? { v: `↩ ${fmtUsdc(job.refundUsdc ?? job.price * job.sizeScu, 2)}`, c: "var(--amber)" }
        : { v: fmtUsdc(job.price * job.sizeScu, 2), c: "var(--text-muted)" };

  return (
    <tr className="border-b border-border-glass/60 transition hover:bg-white/[0.03]">
      <Td className="text-left">
        <span className="num text-secondary">{shortId(job.jobId)}</span>
      </Td>
      <Td className="text-left">
        <span className="num text-[11px] text-secondary">{market}</span>
      </Td>
      <Td>
        <span className="num text-primary">{fmtScu(job.sizeScu)}</span>
      </Td>
      <Td>
        <span className="num text-secondary">{fmtPrice(job.price)}</span>
      </Td>
      <Td className="text-left">
        <Lifecycle state={job.state} />
      </Td>
      <Td>
        <span className="num font-medium" style={{ color: amountCell.c }}>
          {amountCell.v}
        </span>
      </Td>
      <Td>
        {resultReady ? (
          <button
            onClick={() => openResult(job.jobId)}
            className="num rounded border px-2 py-0.5 text-[10px] transition"
            style={{
              borderColor: fetched
                ? "rgba(14,203,129,0.4)"
                : "var(--border-glass)",
              color: fetched ? "var(--buy)" : "var(--accent)",
              background: fetched ? "var(--buy-bg)" : "transparent",
            }}
          >
            {fetched ? `${fetched.verified ? "✓" : "✗"} view` : "view"}
          </button>
        ) : (
          <span className="text-muted">—</span>
        )}
      </Td>
      <Td>
        <span className="num text-[10.5px] text-muted">
          {terminal ? "—" : ""}
          {fmtTime(job.updatedTs)}
        </span>
      </Td>
    </tr>
  );
}

function Lifecycle({ state }: { state: JobState }) {
  const idx = stageIndex(state);
  const slashed = state === "Slashed";
  const refunded = state === "Refunded" || state === "Expired";
  const settled = state === "Settled";
  const active = !TERMINAL.includes(state);

  let endColor = "var(--accent)";
  if (settled) endColor = "var(--buy)";
  else if (slashed) endColor = "var(--sell)";
  else if (refunded) endColor = "var(--amber)";

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-[3px]">
        {STAGES.map((_, i) => {
          const done = i <= idx;
          const isHead = i === idx && active;
          let bg = "rgba(159,176,192,0.16)";
          if (done) bg = endColor;
          return (
            <span
              key={i}
              className={`h-1.5 w-3 rounded-sm ${isHead ? "animate-pulse-dot" : ""}`}
              style={{ background: bg }}
            />
          );
        })}
      </div>
      <span
        className="num text-[10.5px]"
        style={{
          color: settled
            ? "var(--buy)"
            : slashed
              ? "var(--sell)"
              : refunded
                ? "var(--amber)"
                : "var(--accent)",
        }}
      >
        {state}
      </span>
    </div>
  );
}

// ── Open Orders ───────────────────────────────────────────────────────────────
function OpenOrdersTab() {
  const { openOrders, markets, cancelOrder } = useGix();
  const nameOf = (id: string) => markets.find((m) => m.id === id)?.name ?? shortId(id);
  if (openOrders.length === 0)
    return <Empty msg="no open orders — submit from the ticket" />;
  return (
    <table className="w-full border-collapse text-[11.5px]">
      <thead>
        <tr className="sticky top-0 z-10 bg-elev/80 backdrop-blur">
          <Th className="text-left">Time</Th>
          <Th className="text-left">Market</Th>
          <Th className="text-left">Side</Th>
          <Th className="text-left">Type</Th>
          <Th>Price</Th>
          <Th>Amount·SCU</Th>
          <Th>Filled</Th>
          <Th className="text-left">Status</Th>
          <Th></Th>
        </tr>
      </thead>
      <tbody>
        {openOrders.map((o) => (
          <OrderRowView key={o.id} o={o} market={nameOf(o.marketId)} onCancel={() => cancelOrder(o.id)} />
        ))}
      </tbody>
    </table>
  );
}

function OrderRowView({
  o,
  market,
  onCancel,
}: {
  o: OpenOrder;
  market: string;
  onCancel: () => void;
}) {
  const color = o.side === "buy" ? "var(--buy)" : "var(--sell)";
  const statusColor =
    o.status === "filled"
      ? "var(--buy)"
      : o.status === "canceled"
        ? "var(--text-muted)"
        : "var(--amber)";
  return (
    <tr className="border-b border-border-glass/60 hover:bg-white/[0.03]">
      <Td className="text-left">
        <span className="num text-[10.5px] text-muted">{fmtTime(o.ts)}</span>
      </Td>
      <Td className="text-left">
        <span className="num text-[11px] text-secondary">{market}</span>
      </Td>
      <Td className="text-left">
        <span className="num uppercase" style={{ color }}>
          {o.side}
        </span>
      </Td>
      <Td className="text-left">
        <span className="num capitalize text-secondary">{o.type}</span>
      </Td>
      <Td>
        <span className="num text-secondary">{fmtPrice(o.price)}</span>
      </Td>
      <Td>
        <span className="num text-primary">{fmtScu(o.sizeScu)}</span>
      </Td>
      <Td>
        <span className="num text-secondary">
          {Math.round((o.filledScu / o.sizeScu) * 100)}%
        </span>
      </Td>
      <Td className="text-left">
        <span className="num capitalize" style={{ color: statusColor }}>
          {o.status}
        </span>
      </Td>
      <Td>
        {o.status === "open" ? (
          <button
            onClick={onCancel}
            className="num rounded border border-border-glass px-2 py-0.5 text-[10px] text-muted transition hover:border-sell/50 hover:text-sell"
          >
            cancel
          </button>
        ) : (
          <span className="text-muted">—</span>
        )}
      </Td>
    </tr>
  );
}

// ── Balances ──────────────────────────────────────────────────────────────────
function BalancesTab() {
  const { balances, account, ticker } = useGix();
  if (!account)
    return <Empty msg="connect the burner wallet to view balances" />;
  const usdc = balances?.usdc ?? 0;
  const credits = balances?.creditsScu ?? 0;
  const px = ticker?.last ?? 0;
  const creditsValue = credits * px;
  const rows = [
    { asset: "USDC", label: "Quote · MOCK_USDC", amount: fmtUsdc(usdc, 4), value: usdc },
    { asset: "SCU", label: "Compute credits", amount: fmtScu(credits), value: creditsValue },
    { asset: "SUI", label: "Gas", amount: fmtUsdc(balances?.sui ?? 0, 4), value: 0 },
  ];
  return (
    <table className="w-full border-collapse text-[12px]">
      <thead>
        <tr className="sticky top-0 z-10 bg-elev/80 backdrop-blur">
          <Th className="text-left">Asset</Th>
          <Th className="text-left">Description</Th>
          <Th>Balance</Th>
          <Th>≈ USDC Value</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.asset} className="border-b border-border-glass/60 hover:bg-white/[0.03]">
            <Td className="text-left">
              <span className="num font-medium text-primary">{r.asset}</span>
            </Td>
            <Td className="text-left">
              <span className="text-[11px] text-muted">{r.label}</span>
            </Td>
            <Td>
              <span className="num text-primary">{r.amount}</span>
            </Td>
            <Td>
              <span className="num text-secondary">
                {r.value ? fmtUsdc(r.value, 2) : "—"}
              </span>
            </Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── History (terminal jobs) ───────────────────────────────────────────────────
function HistoryTab() {
  const { jobs, markets } = useGix();
  const nameOf = (id: string) => markets.find((m) => m.id === id)?.name ?? shortId(id);
  const hist = jobs.filter((j) => TERMINAL.includes(j.state));
  if (hist.length === 0)
    return <Empty msg="no settled / refunded / slashed jobs yet" />;
  return (
    <table className="w-full border-collapse text-[11.5px]">
      <thead>
        <tr className="sticky top-0 z-10 bg-elev/80 backdrop-blur">
          <Th className="text-left">Time</Th>
          <Th className="text-left">Job</Th>
          <Th className="text-left">Market</Th>
          <Th>Size·SCU</Th>
          <Th>Price</Th>
          <Th className="text-left">Outcome</Th>
          <Th>USDC</Th>
        </tr>
      </thead>
      <tbody>
        {hist.map((j) => {
          const settled = j.state === "Settled";
          const slashed = j.state === "Slashed";
          const c = settled ? "var(--buy)" : slashed ? "var(--sell)" : "var(--amber)";
          const amt = settled
            ? `+${fmtUsdc(j.payoutUsdc ?? 0, 2)}`
            : slashed
              ? `-${fmtUsdc(j.slashUsdc ?? 0, 2)}`
              : `↩ ${fmtUsdc(j.refundUsdc ?? j.price * j.sizeScu, 2)}`;
          return (
            <tr key={j.jobId} className="border-b border-border-glass/60 hover:bg-white/[0.03]">
              <Td className="text-left">
                <span className="num text-[10.5px] text-muted">{fmtTime(j.updatedTs)}</span>
              </Td>
              <Td className="text-left">
                <span className="num text-secondary">{shortId(j.jobId)}</span>
              </Td>
              <Td className="text-left">
                <span className="num text-[11px] text-secondary">{nameOf(j.marketId)}</span>
              </Td>
              <Td><span className="num text-primary">{fmtScu(j.sizeScu)}</span></Td>
              <Td><span className="num text-secondary">{fmtPrice(j.price)}</span></Td>
              <Td className="text-left">
                <span className="num" style={{ color: c }}>{j.state}</span>
              </Td>
              <Td><span className="num font-medium" style={{ color: c }}>{amt}</span></Td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ── table primitives ──────────────────────────────────────────────────────────
function Th({
  children,
  className = "",
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={`label-micro border-b border-border-glass px-3 py-2 text-right font-normal ${className}`}
    >
      {children}
    </th>
  );
}
function Td({
  children,
  className = "",
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-3 py-1.5 text-right ${className}`}>{children}</td>;
}
function Empty({ msg }: { msg: string }) {
  return (
    <div className="flex h-full min-h-[80px] items-center justify-center px-4 py-8 text-center text-[11px] text-muted">
      {msg}
    </div>
  );
}
