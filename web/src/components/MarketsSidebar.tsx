import { useEffect, useRef, useState } from "react";
import { useGix } from "../store";
import { fmtPct, fmtPrice } from "../lib/format";
import { CRYPTO_PAIRS } from "../data/cryptoPairs";

type Category = "gpu" | "crypto";
const CATEGORY_LABEL: Record<Category, string> = {
  gpu: "GPU Compute",
  crypto: "Crypto Pairs",
};

export function MarketsSidebar() {
  const { markets, activeMarketId, setActiveMarket, tickersByMarket } = useGix();

  // Sidebar-local view: which market family to list. GPU = the compute markets
  // (drive the trading view); Crypto = currency→dollar exchange routes (drive the
  // on-ramp swap below). Switching here only changes the list, never the trade panel.
  const [category, setCategory] = useState<Category>("gpu");
  const [selectedPair, setSelectedPair] = useState<string>(CRYPTO_PAIRS[0]?.id ?? "");

  const count = category === "gpu" ? markets.length : CRYPTO_PAIRS.length;

  return (
    <div className="glass flex h-full min-h-0 flex-col rounded-glass">
      <header className="flex h-8 shrink-0 items-center justify-between border-b border-border-glass px-3">
        <span className="label-micro text-secondary">Markets</span>
        <span className="label-micro text-muted">{count}</span>
      </header>

      {/* category selector: GPU Compute ⇄ Crypto Pairs.
          Native <select> on purpose — its option list renders at the OS layer, so it can
          never be clipped by the glass card's overflow/backdrop-filter or stacked out of
          view (the bug a custom popover hit here). */}
      <div className="shrink-0 border-b border-border-glass px-2 py-2">
        <div className="relative">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2">
            <CatIcon category={category} />
          </span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as Category)}
            aria-label="Market category"
            className="focus-amber w-full cursor-pointer appearance-none rounded-md border border-border-glass bg-elev/40 py-1.5 pl-8 pr-8 text-[12px] font-medium text-primary transition hover:border-accent/40"
            style={{ colorScheme: "dark" }}
          >
            {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2">
            <Caret open={false} />
          </span>
        </div>
      </div>

      <div className="grid grid-cols-[1fr_auto_auto] gap-x-2 border-b border-border-glass px-3 py-1.5">
        <span className="label-micro">Pair</span>
        <span className="label-micro text-right">{category === "gpu" ? "Last" : "Rate"}</span>
        <span className="label-micro text-right">24h</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {category === "gpu"
          ? markets.map((m) => {
              const t = tickersByMarket[m.id];
              const last = t?.last ?? m.last;
              const ch = t?.change24h ?? m.change24h;
              const active = m.id === activeMarketId;
              return (
                <Row
                  key={m.id}
                  title={shortName(m.name)}
                  subtitle={tierTag(m.name)}
                  seed={m.id}
                  last={last}
                  change={ch}
                  active={active}
                  onClick={() => setActiveMarket(m.id)}
                />
              );
            })
          : CRYPTO_PAIRS.map((p) => (
              <Row
                key={p.id}
                title={`${p.base} / ${p.quote}`}
                subtitle={`${p.live ? "Live · DeepBook" : "Indicative"} · → ${p.quote}`}
                seed={p.id}
                last={p.last}
                change={p.change24h}
                active={p.id === selectedPair}
                onClick={() => setSelectedPair(p.id)}
              />
            ))}
      </div>

      {category === "crypto" && (
        <div className="shrink-0 border-t border-border-glass px-3 py-1.5">
          <span className="label-micro normal-case tracking-normal text-muted">
            Reference rates into USDC · DBUSDC · MOCK_USDC.
          </span>
        </div>
      )}
    </div>
  );
}

/** One market/pair row — shared by both categories for a consistent look. */
function Row({
  title,
  subtitle,
  seed,
  last,
  change,
  active,
  onClick,
}: {
  title: string;
  subtitle: string;
  seed: string;
  last: number;
  change: number;
  active: boolean;
  onClick: () => void;
}) {
  const up = change >= 0;
  return (
    <button
      onClick={onClick}
      className={`group focus-amber relative grid w-full grid-cols-[1fr_auto] items-center gap-x-2 px-3 py-2 text-left transition ${
        active ? "bg-accent/[0.08]" : "hover:bg-accent/[0.035]"
      }`}
    >
      {active && (
        <span
          className="absolute left-0 top-0 h-full w-[2px]"
          style={{ background: "var(--accent)", boxShadow: "0 0 8px var(--accent-glow)" }}
        />
      )}
      <div className="flex min-w-0 flex-col">
        <span
          className={`num truncate text-[12px] ${
            active ? "text-primary" : "text-secondary group-hover:text-primary"
          }`}
        >
          {title}
        </span>
        <span className="label-micro mt-0.5 truncate normal-case tracking-normal">
          {subtitle}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Spark seed={seed} up={up} />
        <div className="flex w-[72px] flex-col items-end">
          <span className="num text-[12px] text-primary">{fmtPrice(last)}</span>
          <span
            className="num text-[10px]"
            style={{ color: up ? "var(--buy)" : "var(--sell)" }}
          >
            {fmtPct(change)}
          </span>
        </div>
      </div>
    </button>
  );
}

/** Category glyph — a chip for GPU compute, stacked coins for crypto pairs. */
function CatIcon({ category }: { category: Category }) {
  if (category === "gpu") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <rect x="9" y="9" width="6" height="6" />
        <path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6" />
      <path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
    </svg>
  );
}

function Caret({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--text-dim, #5c6b7a)"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 transition-transform"
      style={{ transform: open ? "rotate(180deg)" : "none" }}
      aria-hidden
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
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
