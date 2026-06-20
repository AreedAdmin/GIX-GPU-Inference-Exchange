import { useEffect, useMemo, useRef, useState } from "react";
import { useGix } from "../store";
import { fmtCompact, fmtPrice, fmtPct } from "../lib/format";

type View = "price" | "depth";

// rolling price history per active market (kept in-component; resets on market switch)
const MAX_POINTS = 160;

export function PriceChart() {
  const { ticker, book, activeMarketId } = useGix();
  const [view, setView] = useState<View>("price");
  const [series, setSeries] = useState<number[]>([]);
  const lastMarket = useRef(activeMarketId);

  // reset on market change
  useEffect(() => {
    if (lastMarket.current !== activeMarketId) {
      setSeries([]);
      lastMarket.current = activeMarketId;
    }
  }, [activeMarketId]);

  // append the live last price
  useEffect(() => {
    if (ticker?.last == null) return;
    setSeries((prev) => {
      const next = [...prev, ticker.last];
      return next.length > MAX_POINTS ? next.slice(-MAX_POINTS) : next;
    });
  }, [ticker?.last]);

  const last = ticker?.last ?? 0;
  const change = ticker?.change24h ?? 0;
  const up = change >= 0;

  return (
    <div className="glass flex h-full min-h-0 flex-col rounded-glass">
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-border-glass px-3">
        <div className="flex items-baseline gap-3">
          <span
            className="num text-[16px] font-semibold tabnum"
            style={{ color: up ? "var(--buy)" : "var(--sell)" }}
          >
            {fmtPrice(last)}
          </span>
          <span
            className="num text-[12px] tabnum"
            style={{ color: up ? "var(--buy)" : "var(--sell)" }}
          >
            {fmtPct(change)}
          </span>
          <span className="label-micro hidden md:inline">USDC / SCU · 1 SCU = 1k tok</span>
        </div>
        <div className="flex items-center gap-1">
          <Toggle active={view === "price"} onClick={() => setView("price")}>
            Price
          </Toggle>
          <Toggle active={view === "depth"} onClick={() => setView("depth")}>
            Depth
          </Toggle>
        </div>
      </header>
      <div className="relative min-h-0 flex-1">
        {view === "price" ? (
          <PriceLine series={series} up={up} />
        ) : (
          <DepthChart
            bids={book?.bids ?? []}
            asks={book?.asks ?? []}
          />
        )}
      </div>
    </div>
  );
}

function Toggle({
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
      className={`rounded px-2 py-0.5 text-[11px] transition ${
        active
          ? "bg-accent/15 text-accent"
          : "text-muted hover:text-secondary"
      }`}
    >
      {children}
    </button>
  );
}

// ── price line (SVG) ──────────────────────────────────────────────────────────
function PriceLine({ series, up }: { series: number[]; up: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 600, h: 240 });

  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize({ w: Math.max(120, r.width), h: Math.max(80, r.height) });
    });
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  const { w, h } = size;
  const pad = { l: 0, r: 56, t: 14, b: 18 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;

  const { line, area, min, max, lastY } = useMemo(() => {
    if (series.length < 2)
      return { line: "", area: "", min: 0, max: 0, lastY: 0 };
    const lo = Math.min(...series);
    const hi = Math.max(...series);
    const range = hi - lo || hi || 1;
    const x = (i: number) => pad.l + (i / (series.length - 1)) * innerW;
    const y = (v: number) => pad.t + innerH - ((v - lo) / range) * innerH;
    const pts = series.map((v, i) => `${x(i)},${y(v)}`);
    const lineStr = "M" + pts.join(" L");
    const areaStr =
      `M${pad.l},${pad.t + innerH} L` +
      pts.join(" L") +
      ` L${pad.l + innerW},${pad.t + innerH} Z`;
    return {
      line: lineStr,
      area: areaStr,
      min: lo,
      max: hi,
      lastY: y(series[series.length - 1]),
    };
  }, [series, innerW, innerH, pad.l, pad.t]);

  const stroke = up ? "var(--buy)" : "var(--sell)";

  return (
    <div ref={wrap} className="absolute inset-0">
      <svg width={w} height={h} className="block">
        <defs>
          <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.20" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* horizontal gridlines + right-axis labels */}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const y = pad.t + innerH - f * innerH;
          const v = min + f * (max - min);
          return (
            <g key={f}>
              <line
                x1={pad.l}
                x2={pad.l + innerW}
                y1={y}
                y2={y}
                stroke="var(--grid-line)"
                strokeWidth="1"
              />
              <text
                x={w - pad.r + 6}
                y={y + 3}
                className="num"
                fontSize="9.5"
                fill="var(--text-muted)"
              >
                {series.length >= 2 ? fmtPrice(v) : ""}
              </text>
            </g>
          );
        })}
        {series.length >= 2 ? (
          <>
            <path d={area} fill="url(#priceFill)" />
            <path
              d={line}
              fill="none"
              stroke={stroke}
              strokeWidth="1.5"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {/* live last marker */}
            <line
              x1={pad.l}
              x2={pad.l + innerW}
              y1={lastY}
              y2={lastY}
              stroke={stroke}
              strokeWidth="0.75"
              strokeDasharray="3 3"
              opacity="0.5"
            />
            <circle cx={pad.l + innerW} cy={lastY} r="2.5" fill={stroke} />
          </>
        ) : (
          <text
            x={w / 2}
            y={h / 2}
            textAnchor="middle"
            fontSize="11"
            fill="var(--text-muted)"
          >
            buffering price stream…
          </text>
        )}
      </svg>
    </div>
  );
}

// ── depth chart (cumulative SVG) ─────────────────────────────────────────────
function DepthChart({
  bids,
  asks,
}: {
  bids: { price: number; cumScu: number }[];
  asks: { price: number; cumScu: number }[];
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 600, h: 240 });
  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver((e) => {
      const r = e[0].contentRect;
      setSize({ w: Math.max(120, r.width), h: Math.max(80, r.height) });
    });
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  const { w, h } = size;
  const pad = { t: 14, b: 18, l: 4, r: 4 };
  const innerH = h - pad.t - pad.b;
  const innerW = w - pad.l - pad.r;

  const content = useMemo(() => {
    if (!bids.length || !asks.length) return null;
    const allPrices = [...bids.map((b) => b.price), ...asks.map((a) => a.price)];
    const pMin = Math.min(...allPrices);
    const pMax = Math.max(...allPrices);
    const pRange = pMax - pMin || 1;
    const maxCum = Math.max(
      bids[bids.length - 1]?.cumScu ?? 0,
      asks[asks.length - 1]?.cumScu ?? 0,
      1,
    );
    const x = (p: number) => pad.l + ((p - pMin) / pRange) * innerW;
    const y = (c: number) => pad.t + innerH - (c / maxCum) * innerH;

    // bids: from mid (right) descending in price to left; asks: from mid (left) ascending right
    const bidsSorted = [...bids].sort((a, b) => b.price - a.price); // high→low
    const asksSorted = [...asks].sort((a, b) => a.price - b.price); // low→high

    const bidPts = bidsSorted.map((b) => `${x(b.price)},${y(b.cumScu)}`);
    const askPts = asksSorted.map((a) => `${x(a.price)},${y(a.cumScu)}`);

    const bidArea =
      `M${x(bidsSorted[0].price)},${pad.t + innerH} L` +
      bidPts.join(" L") +
      ` L${x(bidsSorted[bidsSorted.length - 1].price)},${pad.t + innerH} Z`;
    const askArea =
      `M${x(asksSorted[0].price)},${pad.t + innerH} L` +
      askPts.join(" L") +
      ` L${x(asksSorted[asksSorted.length - 1].price)},${pad.t + innerH} Z`;

    return {
      bidLine: "M" + bidPts.join(" L"),
      askLine: "M" + askPts.join(" L"),
      bidArea,
      askArea,
      maxCum,
      pMin,
      pMax,
    };
  }, [bids, asks, innerW, innerH, pad.l, pad.t]);

  return (
    <div ref={wrap} className="absolute inset-0">
      <svg width={w} height={h} className="block">
        <defs>
          <linearGradient id="bidFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--buy)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--buy)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="askFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--sell)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--sell)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={pad.l}
            x2={pad.l + innerW}
            y1={pad.t + innerH - f * innerH}
            y2={pad.t + innerH - f * innerH}
            stroke="var(--grid-line)"
          />
        ))}
        {content ? (
          <>
            <path d={content.bidArea} fill="url(#bidFill)" />
            <path
              d={content.bidLine}
              fill="none"
              stroke="var(--buy)"
              strokeWidth="1.5"
            />
            <path d={content.askArea} fill="url(#askFill)" />
            <path
              d={content.askLine}
              fill="none"
              stroke="var(--sell)"
              strokeWidth="1.5"
            />
            <text x={pad.l + 4} y={h - 5} fontSize="9.5" fill="var(--buy)" className="num">
              bids {fmtCompact(content.maxCum)} SCU
            </text>
            <text
              x={w - pad.r - 4}
              y={h - 5}
              fontSize="9.5"
              fill="var(--sell)"
              textAnchor="end"
              className="num"
            >
              asks
            </text>
          </>
        ) : (
          <text
            x={w / 2}
            y={h / 2}
            textAnchor="middle"
            fontSize="11"
            fill="var(--text-muted)"
          >
            building depth…
          </text>
        )}
      </svg>
    </div>
  );
}
