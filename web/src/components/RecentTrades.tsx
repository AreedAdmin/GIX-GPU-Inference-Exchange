import { useGix } from "../store";
import { fmtCompact, fmtPrice, fmtTime } from "../lib/format";

export function RecentTrades() {
  const { trades } = useGix();

  return (
    <div className="glass flex h-full min-h-0 flex-col rounded-glass">
      <header className="flex h-8 shrink-0 items-center justify-between border-b border-border-glass px-3">
        <span className="label-micro text-secondary">Recent Trades</span>
        <span className="label-micro text-muted">fills = jobs</span>
      </header>
      <div className="grid grid-cols-[1fr_1fr_auto] gap-x-2 px-3 py-1 text-right">
        <span className="label-micro text-left">Price·USDC</span>
        <span className="label-micro">Size·SCU</span>
        <span className="label-micro">Time</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {trades.length === 0 && (
          <div className="px-3 py-6 text-center text-[11px] text-muted">
            awaiting tape…
          </div>
        )}
        {trades.map((t, i) => {
          const color = t.side === "buy" ? "var(--buy)" : "var(--sell)";
          return (
            <div
              key={t.id}
              className={`grid grid-cols-[1fr_1fr_auto] items-center gap-x-2 px-3 py-[2px] text-right ${
                i === 0 ? "animate-slide-in" : ""
              }`}
            >
              <span
                className="num flex items-center gap-1 text-left text-[11.5px] tabnum"
                style={{ color }}
              >
                <Caret up={t.side === "buy"} />
                {fmtPrice(t.price)}
              </span>
              <span className="num text-[11.5px] text-primary tabnum">
                {fmtCompact(t.sizeScu)}
              </span>
              <span className="num text-[10.5px] text-muted tabnum">
                {fmtTime(t.ts)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Caret({ up }: { up: boolean }) {
  return (
    <svg width="7" height="7" viewBox="0 0 8 8" className="shrink-0">
      {up ? (
        <path d="M4 1l3 5H1z" fill="var(--buy)" />
      ) : (
        <path d="M4 7L1 2h6z" fill="var(--sell)" />
      )}
    </svg>
  );
}
