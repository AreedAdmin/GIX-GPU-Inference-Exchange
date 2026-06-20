import { useEffect, useMemo, useRef, useState } from "react";
import { useGix } from "../store";
import type { BookLevel } from "../data/types";
import { fmtCompact, fmtPrice } from "../lib/format";

type Mode = "both" | "bids" | "asks";

export function OrderBook() {
  const { book, ticker, setPrefillPrice } = useGix();
  const [mode, setMode] = useState<Mode>("both");

  const asks = book?.asks ?? [];
  const bids = book?.bids ?? [];

  // max cumulative across both sides — drives the per-row depth bar width.
  const maxCum = useMemo(() => {
    const a = asks.length ? asks[asks.length - 1].cumScu : 0;
    const b = bids.length ? bids[bids.length - 1].cumScu : 0;
    return Math.max(a, b, 1);
  }, [asks, bids]);

  const bestAsk = asks[0]?.price ?? 0;
  const bestBid = bids[0]?.price ?? 0;
  const spread = bestAsk && bestBid ? bestAsk - bestBid : 0;
  const mid = bestAsk && bestBid ? (bestAsk + bestBid) / 2 : ticker?.last ?? 0;
  const spreadPct = mid ? (spread / mid) * 100 : 0;

  // how many rows to show per side based on mode
  const rows = mode === "both" ? 11 : 22;
  const askRows = (mode === "asks" ? asks.slice(0, rows) : asks.slice(0, rows)).slice(
    0,
    rows,
  );

  return (
    <div className="glass flex h-full min-h-0 flex-col rounded-glass">
      <header className="flex h-8 shrink-0 items-center justify-between border-b border-border-glass px-3">
        <span className="label-micro text-secondary">Order Book</span>
        <div className="flex items-center gap-1">
          <ModeBtn active={mode === "both"} onClick={() => setMode("both")}>
            <BothIcon />
          </ModeBtn>
          <ModeBtn active={mode === "bids"} onClick={() => setMode("bids")}>
            <BidsIcon />
          </ModeBtn>
          <ModeBtn active={mode === "asks"} onClick={() => setMode("asks")}>
            <AsksIcon />
          </ModeBtn>
        </div>
      </header>

      {/* column headers */}
      <div className="grid grid-cols-[1fr_1fr_1fr] gap-x-1 px-3 py-1 text-right">
        <span className="label-micro text-left">Price·USDC</span>
        <span className="label-micro">Size·SCU</span>
        <span className="label-micro">Total·SCU</span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col justify-between">
        {/* asks — red, displayed descending (best ask nearest the spread) */}
        {mode !== "bids" && (
          <div className="flex flex-col-reverse justify-end overflow-hidden">
            {askRows.map((lvl) => (
              <BookRow
                key={`a-${lvl.price}`}
                lvl={lvl}
                side="sell"
                maxCum={maxCum}
                onClick={() => setPrefillPrice(lvl.price)}
              />
            ))}
          </div>
        )}

        {/* spread / mid band */}
        <div className="my-0.5 flex shrink-0 items-center justify-between border-y border-border-glass bg-white/[0.02] px-3 py-1.5">
          <span
            className="num text-[15px] font-semibold tabnum"
            style={{ color: mid >= (ticker?.last ?? mid) ? "var(--buy)" : "var(--sell)" }}
          >
            {fmtPrice(mid)}
          </span>
          <span className="flex items-center gap-2">
            <span className="label-micro">Spread</span>
            <span className="num text-[11px] text-secondary tabnum">
              {fmtPrice(spread)}
            </span>
            <span className="num text-[11px] text-muted tabnum">
              {spreadPct.toFixed(3)}%
            </span>
          </span>
        </div>

        {/* bids — green, ascending (best bid nearest the spread) */}
        {mode !== "asks" && (
          <div className="flex flex-col overflow-hidden">
            {bids.slice(0, rows).map((lvl) => (
              <BookRow
                key={`b-${lvl.price}`}
                lvl={lvl}
                side="buy"
                maxCum={maxCum}
                onClick={() => setPrefillPrice(lvl.price)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function BookRow({
  lvl,
  side,
  maxCum,
  onClick,
}: {
  lvl: BookLevel;
  side: "buy" | "sell";
  maxCum: number;
  onClick: () => void;
}) {
  const color = side === "buy" ? "var(--buy)" : "var(--sell)";
  const depthBg = side === "buy" ? "var(--buy-bg)" : "var(--sell-bg)";
  const pct = Math.min(100, (lvl.cumScu / maxCum) * 100);

  // flash the row when its size changes
  const prevSize = useRef(lvl.sizeScu);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (prevSize.current !== lvl.sizeScu) {
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 420);
      prevSize.current = lvl.sizeScu;
      return () => clearTimeout(t);
    }
  }, [lvl.sizeScu]);

  return (
    <button
      onClick={onClick}
      className={`group relative grid h-[19px] w-full cursor-pointer grid-cols-[1fr_1fr_1fr] items-center gap-x-1 px-3 text-right transition-colors hover:bg-white/[0.05] ${
        flash ? (side === "buy" ? "animate-flash-buy" : "animate-flash-sell") : ""
      }`}
      title="Click to prefill ticket price"
    >
      {/* cumulative depth bar from the right edge */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0"
        style={{ width: `${pct}%`, background: depthBg }}
      />
      <span
        className="num relative z-10 text-left text-[11.5px] tabnum"
        style={{ color }}
      >
        {fmtPrice(lvl.price)}
      </span>
      <span className="num relative z-10 text-[11.5px] text-primary tabnum">
        {fmtCompact(lvl.sizeScu)}
      </span>
      <span className="num relative z-10 text-[11.5px] text-muted tabnum">
        {fmtCompact(lvl.cumScu)}
      </span>
    </button>
  );
}

function ModeBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex h-5 w-5 items-center justify-center rounded transition ${
        active ? "bg-accent/15 text-accent" : "text-muted hover:text-secondary"
      }`}
    >
      {children}
    </button>
  );
}

function BothIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12">
      <rect x="1" y="1" width="10" height="4.5" rx="1" fill="var(--sell)" opacity="0.85" />
      <rect x="1" y="6.5" width="10" height="4.5" rx="1" fill="var(--buy)" opacity="0.85" />
    </svg>
  );
}
function BidsIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12">
      <rect x="1" y="1" width="10" height="10" rx="1" fill="var(--buy)" opacity="0.85" />
    </svg>
  );
}
function AsksIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12">
      <rect x="1" y="1" width="10" height="10" rx="1" fill="var(--sell)" opacity="0.85" />
    </svg>
  );
}
