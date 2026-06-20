import { useEffect, useRef, useState } from "react";
import { useActiveMarket, useGix } from "../store";
import { fmtCompact, fmtPct, fmtPrice, fmtUsdc } from "../lib/format";
import { ConnectionDot } from "./ConnectionDot";
import { WalletBar } from "./WalletBar";

export function TopBar() {
  const { markets, activeMarketId, setActiveMarket, ticker, status } = useGix();
  const market = useActiveMarket();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const change = ticker?.change24h ?? market?.change24h ?? 0;
  const up = change >= 0;
  const last = ticker?.last ?? market?.last ?? 0;

  return (
    <header className="glass z-30 flex h-full items-center gap-4 rounded-glass px-4">
      {/* wordmark */}
      <div className="flex items-center gap-2 pr-2">
        <span
          className="num text-[18px] font-semibold tracking-[0.18em]"
          style={{ color: "var(--text-primary)" }}
        >
          GIX
        </span>
        <span
          className="hidden text-[10px] uppercase leading-none tracking-[0.2em] text-muted sm:inline"
        >
          Inference&nbsp;Exchange
        </span>
        <span
          aria-hidden
          className="ml-1 inline-block h-3.5 w-px"
          style={{ background: "var(--border-glass-2)" }}
        />
      </div>

      {/* market selector */}
      <div ref={ref} className="relative">
        <button
          onClick={() => setOpen((v) => !v)}
          className="group flex items-center gap-2 rounded-md border border-border-glass bg-elev/60 px-3 py-1.5 text-left transition hover:border-border-glass-2"
        >
          <span className="num text-[13px] font-medium text-primary">
            {market?.name ?? "—"}
          </span>
          <span className="label-micro text-accent">SCU/USDC</span>
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            className={`text-muted transition-transform ${open ? "rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        {open && (
          <div className="absolute left-0 top-[calc(100%+6px)] z-40 w-72 animate-fade-in glass-2 rounded-lg p-1">
            {markets.map((m) => {
              const sel = m.id === activeMarketId;
              const mu = m.change24h >= 0;
              return (
                <button
                  key={m.id}
                  onClick={() => {
                    setActiveMarket(m.id);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left transition ${
                    sel ? "bg-accent/10" : "hover:bg-white/[0.04]"
                  }`}
                >
                  <span className="num text-[12px] text-primary">{m.name}</span>
                  <span className="flex items-center gap-3">
                    <span className="num text-[12px] text-secondary">
                      {fmtPrice(m.last)}
                    </span>
                    <span
                      className="num w-14 text-right text-[11px]"
                      style={{ color: mu ? "var(--buy)" : "var(--sell)" }}
                    >
                      {fmtPct(m.change24h)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* live ticker tiles */}
      <div className="flex min-w-0 flex-1 items-center gap-5 overflow-x-auto no-scrollbar pl-1">
        <Tile
          label="Last · USDC/SCU"
          value={fmtPrice(last)}
          color={up ? "var(--buy)" : "var(--sell)"}
          flashKey={last}
        />
        <Tile
          label="24h Change"
          value={fmtPct(change)}
          color={up ? "var(--buy)" : "var(--sell)"}
        />
        <Tile label="24h High" value={fmtPrice(ticker?.high24h ?? last)} />
        <Tile label="24h Low" value={fmtPrice(ticker?.low24h ?? last)} />
        <Tile
          label="24h Vol · SCU"
          value={fmtCompact(ticker?.volScu24h ?? 0)}
        />
        <Tile
          label="USDC Escrowed"
          value={fmtUsdc(ticker?.usdcEscrowed ?? 0, 2)}
          color="var(--accent-blue)"
        />
        <Tile
          label="USDC Settled"
          value={fmtUsdc(ticker?.usdcSettled ?? 0, 2)}
          color="var(--buy)"
        />
        <Tile
          label="USDC Slashed"
          value={fmtUsdc(ticker?.usdcSlashed ?? 0, 2)}
          color="var(--sell)"
        />
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-4 pl-2">
        <WalletBar />
        <span
          aria-hidden
          className="inline-block h-5 w-px"
          style={{ background: "var(--border-glass-2)" }}
        />
        <ConnectionDot status={status} label={status} />
      </div>
    </header>
  );
}

function Tile({
  label,
  value,
  color,
  flashKey,
}: {
  label: string;
  value: string;
  color?: string;
  flashKey?: number;
}) {
  // flash on tick (price up/down)
  const prev = useRef<number | undefined>(flashKey);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  useEffect(() => {
    if (flashKey === undefined) return;
    if (prev.current !== undefined && flashKey !== prev.current) {
      setFlash(flashKey > prev.current ? "up" : "down");
      const t = setTimeout(() => setFlash(null), 420);
      prev.current = flashKey;
      return () => clearTimeout(t);
    }
    prev.current = flashKey;
  }, [flashKey]);

  return (
    <div className="flex shrink-0 flex-col leading-tight">
      <span className="label-micro whitespace-nowrap">{label}</span>
      <span
        className={`num text-[13px] font-medium tabnum transition-colors ${
          flash === "up"
            ? "animate-flash-buy"
            : flash === "down"
              ? "animate-flash-sell"
              : ""
        }`}
        style={{ color: color ?? "var(--text-primary)" }}
      >
        {value}
      </span>
    </div>
  );
}
