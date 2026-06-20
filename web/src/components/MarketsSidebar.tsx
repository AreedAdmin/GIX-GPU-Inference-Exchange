import { useEffect, useRef } from "react";
import { useGix } from "../store";
import { fmtPct, fmtPrice } from "../lib/format";
import { OnRampWidget } from "./OnRampWidget";

export function MarketsSidebar() {
  const { markets, activeMarketId, setActiveMarket, tickersByMarket } = useGix();

  return (
    <div className="glass flex h-full min-h-0 flex-col rounded-glass">
      <header className="flex h-8 shrink-0 items-center justify-between border-b border-border-glass px-3">
        <span className="label-micro text-secondary">Markets</span>
        <span className="label-micro text-muted">{markets.length}</span>
      </header>
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-2 border-b border-border-glass px-3 py-1.5">
        <span className="label-micro">Pair</span>
        <span className="label-micro text-right">Last</span>
        <span className="label-micro text-right">24h</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {markets.map((m) => {
          const t = tickersByMarket[m.id];
          const last = t?.last ?? m.last;
          const ch = t?.change24h ?? m.change24h;
          const active = m.id === activeMarketId;
          const up = ch >= 0;
          return (
            <button
              key={m.id}
              onClick={() => setActiveMarket(m.id)}
              className={`group focus-amber relative grid w-full grid-cols-[1fr_auto] items-center gap-x-2 px-3 py-2 text-left transition ${
                active ? "bg-accent/[0.08]" : "hover:bg-accent/[0.035]"
              }`}
            >
              {active && (
                <span
                  className="absolute left-0 top-0 h-full w-[2px]"
                  style={{
                    background: "var(--accent)",
                    boxShadow: "0 0 8px var(--accent-glow)",
                  }}
                />
              )}
              <div className="flex min-w-0 flex-col">
                <span
                  className={`num truncate text-[12px] ${
                    active ? "text-primary" : "text-secondary group-hover:text-primary"
                  }`}
                >
                  {shortName(m.name)}
                </span>
                <span className="label-micro mt-0.5 truncate normal-case tracking-normal">
                  {tierTag(m.name)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Spark seed={m.id} up={up} />
                <div className="flex w-[72px] flex-col items-end">
                  <span className="num text-[12px] text-primary">
                    {fmtPrice(last)}
                  </span>
                  <span
                    className="num text-[10px]"
                    style={{ color: up ? "var(--buy)" : "var(--sell)" }}
                  >
                    {fmtPct(ch)}
                  </span>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* SUI → USDC on-ramp — a small funding utility beside the markets. It is
          self-contained (own glass surface) and degrades gracefully when the
          wallet is disconnected or off testnet, so it never disturbs the list. */}
      <div className="shrink-0 border-t border-border-glass p-2">
        <OnRampWidget />
      </div>
    </div>
  );
}

function shortName(n: string): string {
  return n;
}
function tierTag(n: string): string {
  const gpu = n.split("-")[0];
  return `${gpu} · 1 SCU = 1k tok`;
}

/** Lean hand-rolled SVG sparkline; deterministic per market id, tinted by direction. */
function Spark({ seed, up }: { seed: string; up: boolean }) {
  const ref = useRef<SVGPolylineElement>(null);
  const W = 40;
  const H = 18;

  // deterministic pseudo-random series from the id
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const rnd = () => {
    h = (h * 1664525 + 1013904223) >>> 0;
    return h / 4294967296;
  };
  const n = 16;
  const pts: number[] = [];
  let v = 0.5;
  for (let i = 0; i < n; i++) {
    v += (rnd() - 0.5) * 0.32;
    v = Math.max(0.08, Math.min(0.92, v));
    pts.push(v);
  }
  // bias the end up/down per direction
  pts[n - 1] = up ? Math.max(pts[n - 1], 0.62) : Math.min(pts[n - 1], 0.38);

  const path = pts
    .map((p, i) => `${(i / (n - 1)) * W},${H - p * H}`)
    .join(" ");
  const color = up ? "var(--buy)" : "var(--sell)";

  useEffect(() => void 0, []);

  return (
    <svg width={W} height={H} className="opacity-80">
      <polyline
        ref={ref}
        points={path}
        fill="none"
        stroke={color}
        strokeWidth="1.2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
