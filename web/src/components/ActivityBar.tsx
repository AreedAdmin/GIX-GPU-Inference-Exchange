// web/src/components/ActivityBar.tsx
// Per-wallet order/activity history surfaced in the bottom bar (StatusBar footer).
// A compact strip shows the connected wallet's most-recent on-chain actions; each row
// links to Suiscan for its tx so a live demo can click through to the real transaction.
// An "Activity (N) ▾" affordance expands a GlassPanel(3) popover with the FULL scrollable
// history (newest first). Real digests → working Suiscan links; localnet / mock degrade to
// a plain truncated digest with a "sim" / "no explorer" hint instead of a dead link.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ActivityEntry } from "../store";
import { useGix } from "../store";
import { shortId } from "../lib/config";
import { fmtScu } from "../lib/format";
import { loadChainConfig, explorerTxUrl } from "../trade/config";
import { GlassPanel } from "./GlassPanel";

const cfg = loadChainConfig();

// ── presentation helpers ─────────────────────────────────────────────────────

const KIND_LABEL: Record<ActivityEntry["kind"], string> = {
  buy: "Buy",
  sell: "Sell",
  run: "Run",
  buyAndRun: "Buy+Run",
  settle: "Settle",
};

/** Amber for the action verbs; directional tint only where it's genuinely a side. */
function kindColor(kind: ActivityEntry["kind"]): string {
  switch (kind) {
    case "buy":
    case "buyAndRun":
      return "var(--buy)";
    case "sell":
      return "var(--sell)";
    default:
      return "var(--accent)";
  }
}

function statusColor(status: ActivityEntry["status"]): string {
  switch (status) {
    case "settled":
      return "var(--buy)";
    case "failed":
      return "var(--sell)";
    default:
      return "var(--text-secondary)";
  }
}

function relTime(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** A short, stable name for a market id (falls back to the truncated id). */
function useMarketName(): (marketId: string) => string {
  const { markets } = useGix();
  return useCallback(
    (marketId: string) => {
      const m = markets.find((mk) => mk.id === marketId);
      return m?.name ?? shortId(marketId, 6, 4);
    },
    [markets],
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export function ActivityBar() {
  const { activity, account } = useGix();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const anchorRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const marketName = useMarketName();

  // tick relative timestamps once a minute (cheap; the strip is small)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // only the CONNECTED wallet's actions (filter by active account; clears on switch).
  const mine = useMemo(() => {
    if (!account?.address) return [];
    return activity.filter(
      (e) => e.account == null || e.account === account.address,
    );
  }, [activity, account?.address]);

  // close the popover whenever the wallet changes (segment per wallet)
  useEffect(() => {
    setOpen(false);
  }, [account?.address]);

  // click-outside + Esc on the popover
  useEffect(() => {
    if (!open) return;
    function onDocMouse(e: MouseEvent) {
      if (anchorRef.current && !anchorRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onDocMouse);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouse);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const connected = !!account?.address;
  const recent = mine.slice(0, 3);

  return (
    <div ref={anchorRef} className="relative flex min-w-0 items-center gap-2">
      <span className="label-micro shrink-0">activity</span>

      {/* compact inline strip — most-recent entries as chips */}
      <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
        {!connected && (
          <span className="num text-[10px] text-muted">connect wallet</span>
        )}
        {connected && recent.length === 0 && (
          <span className="num text-[10px] text-muted">no actions yet</span>
        )}
        {connected &&
          recent.map((e) => (
            <ActivityChip key={e.id} entry={e} marketName={marketName} now={now} />
          ))}
      </div>

      {/* "Activity (N) ▾" expander */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!connected}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="focus-amber shrink-0 rounded border border-border-glass px-1.5 py-0.5 text-[10px] text-secondary transition enabled:hover:border-accent/50 enabled:hover:text-accent disabled:opacity-40"
        title="Show full activity history"
      >
        Activity ({connected ? mine.length : 0}){" "}
        <span aria-hidden className={open ? "inline-block rotate-180" : "inline-block"}>
          ▾
        </span>
      </button>

      {open && (
        <ActivityPopover
          entries={mine}
          marketName={marketName}
          now={now}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

// ── inline chip (compact strip) ──────────────────────────────────────────────
function ActivityChip({
  entry,
  marketName,
  now,
}: {
  entry: ActivityEntry;
  marketName: (id: string) => string;
  now: number;
}) {
  const url = explorerTxUrl(cfg, entry.digest);
  const label = `${KIND_LABEL[entry.kind]} · ${fmtScu(entry.sizeScu)} SCU · ${marketName(
    entry.marketId,
  )}`;
  return (
    <span
      className="flex shrink-0 items-center gap-1 rounded-full border border-border-glass px-1.5 py-0.5 text-[10px]"
      title={`${label} · ${entry.status} · ${relTime(entry.ts, now)}`}
    >
      <span className="num font-medium" style={{ color: kindColor(entry.kind) }}>
        {KIND_LABEL[entry.kind]}
      </span>
      <SuiscanLink digest={entry.digest} url={url} compact />
    </span>
  );
}

// ── full-history popover ─────────────────────────────────────────────────────
function ActivityPopover({
  entries,
  marketName,
  now,
  onClose,
}: {
  entries: ActivityEntry[];
  marketName: (id: string) => string;
  now: number;
  onClose: () => void;
}) {
  return (
    <div
      className="absolute bottom-[calc(100%+8px)] left-0 z-50 w-[420px] max-w-[90vw] animate-slide-in"
      role="dialog"
      aria-label="Activity history"
    >
      <GlassPanel elevation={3} className="rounded-glass">
        <header className="flex items-center justify-between border-b border-border-glass px-3 py-2">
          <span className="label-micro text-secondary">
            Activity · {entries.length}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close activity history"
            className="focus-amber rounded p-0.5 text-muted transition hover:text-primary"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>

        <div className="max-h-[46vh] min-h-0 overflow-y-auto">
          {entries.length === 0 ? (
            <div className="px-3 py-8 text-center text-[11px] leading-relaxed text-muted">
              Your on-chain actions will appear here.
            </div>
          ) : (
            <ul className="divide-y divide-border-glass">
              {entries.map((e) => (
                <ActivityRow
                  key={e.id}
                  entry={e}
                  marketName={marketName}
                  now={now}
                />
              ))}
            </ul>
          )}
        </div>
      </GlassPanel>
    </div>
  );
}

function ActivityRow({
  entry,
  marketName,
  now,
}: {
  entry: ActivityEntry;
  marketName: (id: string) => string;
  now: number;
}) {
  const url = explorerTxUrl(cfg, entry.digest);
  return (
    <li className="flex items-center gap-2 px-3 py-2 text-[11px]">
      <span
        className="num w-[58px] shrink-0 font-medium"
        style={{ color: kindColor(entry.kind) }}
      >
        {KIND_LABEL[entry.kind]}
      </span>
      <span className="min-w-0 flex-1 truncate text-secondary" title={marketName(entry.marketId)}>
        {marketName(entry.marketId)}
      </span>
      <span className="num shrink-0 tabnum text-muted">{fmtScu(entry.sizeScu)} SCU</span>
      <span
        className="shrink-0 capitalize"
        style={{ color: statusColor(entry.status) }}
      >
        {entry.status}
      </span>
      <span className="num shrink-0 tabnum text-muted" title={new Date(entry.ts).toLocaleString()}>
        {relTime(entry.ts, now)}
      </span>
      <span className="shrink-0">
        <SuiscanLink digest={entry.digest} url={url} />
      </span>
    </li>
  );
}

// ── Suiscan link / degraded fallback ─────────────────────────────────────────
// Real digest on a real network → ↗ Suiscan (amber). Otherwise (no explorer on localnet,
// or no digest in mock) → the truncated digest as plain text with a subtle hint.
function SuiscanLink({
  digest,
  url,
  compact = false,
}: {
  digest?: string;
  url?: string;
  compact?: boolean;
}) {
  if (url && digest) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="inline-flex items-center gap-0.5 text-[10px] text-accent transition hover:text-accent-strong hover:underline"
        title={`View tx ${digest} on Suiscan`}
      >
        {compact ? "↗" : "↗ Suiscan"}
      </a>
    );
  }
  // degraded: show the (truncated) digest as plain text, or a "sim" tag if there's none.
  if (digest) {
    return (
      <span
        className="num inline-flex items-center gap-1 text-[10px] text-muted"
        title={`${digest} · no explorer on this network`}
      >
        {shortId(digest, 5, 3)}
        {!compact && <span className="opacity-60">no explorer</span>}
      </span>
    );
  }
  return (
    <span
      className="num text-[10px] text-muted opacity-70"
      title="Simulated action — no on-chain tx (mock mode)"
    >
      sim
    </span>
  );
}
