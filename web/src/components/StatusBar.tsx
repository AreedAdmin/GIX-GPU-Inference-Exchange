import { useEffect, useState } from "react";
import { useGix } from "../store";
import { ConnectionDot } from "./ConnectionDot";
import { ActivityBar } from "./ActivityBar";
import { DEPLOYMENT, shortId } from "../lib/config";
import { fmtClock } from "../lib/format";

export function StatusBar() {
  const { status, source, jobs } = useGix();
  const [now, setNow] = useState(Date.now());
  // simulated epoch/checkpoint counters (real values arrive via chain/WS)
  const [checkpoint, setCheckpoint] = useState(184_220);

  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
      setCheckpoint((c) => c + (Math.random() > 0.4 ? 1 : 0));
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const epoch = 42;
  const settled = jobs.filter((j) => j.state === "Settled").length;
  const slashed = jobs.filter((j) => j.state === "Slashed").length;

  return (
    <footer className="glass flex h-full items-center gap-4 rounded-glass px-3 text-[10.5px]">
      <Seg>
        <ConnectionDot status={status} />
        <span className="num uppercase tracking-wide text-secondary">
          {DEPLOYMENT.network}
        </span>
      </Seg>
      <Div />
      <Seg>
        <span className="label-micro">pkg</span>
        <span className="num text-muted">{shortId(DEPLOYMENT.packageId)}</span>
      </Seg>
      <Seg>
        <span className="label-micro">market</span>
        <span className="num text-muted">{shortId(DEPLOYMENT.market.id)}</span>
      </Seg>
      <Div />
      <Seg>
        <span className="label-micro">epoch</span>
        <span className="num text-secondary">{epoch}</span>
      </Seg>
      <Seg>
        <span className="label-micro">checkpoint</span>
        <span className="num text-secondary tabnum">
          {checkpoint.toLocaleString()}
        </span>
      </Seg>
      <Div />
      <Seg>
        <span className="label-micro">settled</span>
        <span className="num" style={{ color: "var(--buy)" }}>{settled}</span>
      </Seg>
      <Seg>
        <span className="label-micro">slashed</span>
        <span className="num" style={{ color: "var(--sell)" }}>{slashed}</span>
      </Seg>

      <Div />
      {/* per-wallet order/activity history — links each tx to Suiscan */}
      <div className="min-w-0 flex-1 overflow-visible">
        <ActivityBar />
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-4">
        <Seg>
          <span className="label-micro">feed</span>
          <span className="num uppercase text-muted">{source.kind}</span>
        </Seg>
        <Div />
        <Seg>
          <ConnectionDot status={status} label={`ws ${status}`} />
        </Seg>
        <Div />
        <span className="num text-muted tabnum">{fmtClock(now)} UTC</span>
      </div>
    </footer>
  );
}

function Seg({ children }: { children: React.ReactNode }) {
  return <span className="flex items-center gap-1.5">{children}</span>;
}
function Div() {
  return (
    <span
      aria-hidden
      className="h-3 w-px shrink-0"
      style={{ background: "var(--border-glass)" }}
    />
  );
}
