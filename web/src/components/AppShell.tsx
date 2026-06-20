import { useEffect, useState } from "react";
import { BackgroundField } from "./BackgroundField";
import { TopBar } from "./TopBar";
import { MarketsSidebar } from "./MarketsSidebar";
import { PriceChart } from "./PriceChart";
import { OrderBook } from "./OrderBook";
import { RecentTrades } from "./RecentTrades";
import { OrderTicket } from "./OrderTicket";
import { PositionsPanel } from "./PositionsPanel";
import { StatusBar } from "./StatusBar";
import { ResultViewer } from "./ResultViewer";

// Binance-style spot layout (contract §2):
//   cols  [ markets 220px | center 1fr | ticket 320px ]
//   center rows [ chart 1fr | book + trades 1fr ]
//   topbar 56px · positions ~200px · statusbar 24px
// Under ~1100px the markets + ticket collapse into drawers.

export function AppShell() {
  const [wide, setWide] = useState(true);
  const [drawer, setDrawer] = useState<null | "markets" | "ticket">(null);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1100px)");
    const onChange = () => setWide(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return (
    <div className="relative h-screen w-screen overflow-hidden p-2 text-base">
      <BackgroundField />

      <div className="grid h-full min-h-0 grid-rows-[56px_minmax(0,1fr)_minmax(160px,210px)_26px] gap-2">
        {/* TOPBAR */}
        <div className="min-h-0">
          <TopBar />
        </div>

        {/* MIDDLE: markets | center | ticket */}
        <div
          className={`grid min-h-0 gap-2 ${
            wide
              ? "grid-cols-[220px_minmax(0,1fr)_320px]"
              : "grid-cols-[minmax(0,1fr)]"
          }`}
        >
          {wide && (
            <div className="min-h-0">
              <MarketsSidebar />
            </div>
          )}

          {/* center column: chart over (book | trades) */}
          <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
            <div className="min-h-0">
              <PriceChart />
            </div>
            <div className="grid min-h-0 grid-cols-2 gap-2">
              <div className="min-h-0">
                <OrderBook />
              </div>
              <div className="min-h-0">
                <RecentTrades />
              </div>
            </div>
          </div>

          {wide && (
            <div className="min-h-0">
              <OrderTicket />
            </div>
          )}
        </div>

        {/* POSITIONS */}
        <div className="min-h-0">
          <PositionsPanel />
        </div>

        {/* STATUSBAR */}
        <div className="min-h-0">
          <StatusBar />
        </div>
      </div>

      {/* mobile drawer triggers */}
      {!wide && (
        <div className="pointer-events-none fixed inset-x-0 bottom-2 z-40 flex justify-center gap-2">
          <button
            onClick={() => setDrawer("markets")}
            className="pointer-events-auto glass-2 rounded-full px-4 py-2 text-[12px] text-secondary"
          >
            Markets
          </button>
          <button
            onClick={() => setDrawer("ticket")}
            className="pointer-events-auto rounded-full px-4 py-2 text-[12px] font-medium text-base transition hover:brightness-[1.06]"
            style={{
              background: "var(--accent)",
              color: "var(--bg-0)",
              boxShadow: "0 6px 20px var(--accent-dim)",
            }}
          >
            Trade
          </button>
        </div>
      )}

      {/* drawers */}
      {!wide && drawer && (
        <div
          className="fixed inset-0 z-50 flex animate-fade-in"
          onClick={() => setDrawer(null)}
        >
          <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" />
          <div
            className={`absolute top-2 bottom-2 ${
              drawer === "markets" ? "left-2 w-[260px]" : "right-2 w-[340px]"
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            {drawer === "markets" ? <MarketsSidebar /> : <OrderTicket />}
          </div>
        </div>
      )}

      {/* verifiable-result viewer (opens over everything when a job is selected) */}
      <ResultViewer />
    </div>
  );
}
