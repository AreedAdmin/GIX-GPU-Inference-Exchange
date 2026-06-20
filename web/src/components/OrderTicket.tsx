import { useEffect, useMemo, useState } from "react";
import { useActiveMarket, useGix } from "../store";
import { fmtScu, fmtUsdc, fmtPrice } from "../lib/format";
import { shortId } from "../lib/config";

// Top-level: TRADE (spot — buy/sell credits, no prompt) vs RUN (redeem held credits → job).
// Buying compute ≠ running a job: a credit is a holdable Coin<Credit<M>>, so the two flows
// are decoupled. The prompt lives ONLY in Run mode and the Buy & run toggle.
type Mode = "trade" | "run";
type Side = "buy" | "sell";
type OrderType = "limit" | "market";

export function OrderTicket() {
  const {
    ticker,
    prefillPrice,
    setPrefillPrice,
    account,
    balances,
    connecting,
    funding,
    connectWallet,
    fundWallet,
    submitOrder,
  } = useGix();
  const market = useActiveMarket();

  const [mode, setMode] = useState<Mode>("trade");
  const [side, setSide] = useState<Side>("buy");
  const [type, setType] = useState<OrderType>("limit");
  const [price, setPrice] = useState<string>("");
  const [amount, setAmount] = useState<string>("");
  const [prompt, setPrompt] = useState<string>("");
  const [buyAndRun, setBuyAndRun] = useState(false);
  const [pctSel, setPctSel] = useState<number>(0);
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; msg: string } | null>(
    null,
  );
  const [submitting, setSubmitting] = useState(false);

  const mid = ticker?.last ?? market?.last ?? 0;

  // seed/refresh the price field from the live mid until the user edits it
  const [priceTouched, setPriceTouched] = useState(false);
  useEffect(() => {
    if (!priceTouched && mid) setPrice(fmtPrice(mid));
  }, [mid, priceTouched]);

  // book-row click prefills price (and switches to Trade — price is a trade concept)
  useEffect(() => {
    if (prefillPrice != null) {
      setPrice(fmtPrice(prefillPrice));
      setPriceTouched(true);
      setMode("trade");
      setPrefillPrice(null);
    }
  }, [prefillPrice, setPrefillPrice]);

  const priceNum = type === "market" ? mid : parseFloat(price) || 0;
  const amountNum = parseFloat(amount) || 0;
  const total = priceNum * amountNum;

  const usdc = balances?.usdc ?? 0;
  const credits = balances?.creditsScu ?? 0;

  // Run-tab empty state: the user holds 0 compute credits, so there's nothing to redeem.
  // Show a friendly nudge to buy credits on the Trade tab instead of a dead submit.
  const runEmpty = mode === "run" && credits <= 0;
  function goBuyCredits() {
    setMode("trade");
    setSide("buy");
    setBuyAndRun(false);
  }

  // The prompt is required on Run, and on a Trade-Buy with the "Buy & run now" toggle on.
  const isRun = mode === "run";
  const promptShown = isRun || (mode === "trade" && side === "buy" && buyAndRun);
  const promptRequired = promptShown;
  // Run consumes credits; Buy spends USDC; Sell sells held credits.
  const spendsCredits = isRun;

  // available depends on mode/side
  const maxAffordableScu = useMemo(() => {
    if (isRun) return credits; // redeem held credits
    if (side === "buy") return priceNum > 0 ? usdc / priceNum : 0;
    return credits; // sell held credits
  }, [isRun, side, priceNum, usdc, credits]);

  function applyPct(p: number) {
    setPctSel(p);
    const qty = Math.floor(maxAffordableScu * (p / 100));
    setAmount(qty > 0 ? String(qty) : "");
  }

  // keep slider in sync if user types amount
  useEffect(() => {
    if (maxAffordableScu > 0) {
      const p = Math.round((amountNum / maxAffordableScu) * 100);
      setPctSel(Math.max(0, Math.min(100, p)));
    }
  }, [amountNum, maxAffordableScu]);

  // reset amount/slider when switching mode/side so % presets re-base on the new max
  useEffect(() => {
    setAmount("");
    setPctSel(0);
  }, [mode, side]);

  async function onSubmit() {
    setFlash(null);
    if (!account) {
      await connectWallet();
      return;
    }
    if (amountNum <= 0) {
      setFlash({ kind: "err", msg: "enter an amount" });
      return;
    }
    if (promptRequired && prompt.trim().length === 0) {
      setFlash({ kind: "err", msg: "enter a prompt — the task to run" });
      return;
    }

    // resolve the action mode for the store
    const submitMode: "buy" | "sell" | "run" | "buyAndRun" = isRun
      ? "run"
      : side === "sell"
        ? "sell"
        : buyAndRun
          ? "buyAndRun"
          : "buy";

    setSubmitting(true);
    const res = await submitOrder({
      mode: submitMode,
      side: isRun ? "buy" : side,
      type,
      price: priceNum,
      sizeScu: amountNum,
      prompt: promptShown ? prompt : undefined,
    });
    setSubmitting(false);
    if (res.ok) {
      const verb =
        submitMode === "run"
          ? "job dispatched"
          : submitMode === "buyAndRun"
            ? "bought & running"
            : submitMode === "sell"
              ? "ask posted"
              : "credits bought";
      setFlash({
        kind: "ok",
        msg: `${verb} · ${res.jobId ? shortId(res.jobId) : res.digest ? shortId(res.digest) : "ok"}`,
      });
      setAmount("");
      setPctSel(0);
      setPrompt("");
    } else {
      setFlash({ kind: "err", msg: res.error ?? "order failed" });
    }
    setTimeout(() => setFlash(null), 4000);
  }

  // accent: Run = accent amber; Trade-Buy = green, Trade-Sell = red
  const accent = isRun ? "var(--accent)" : side === "buy" ? "var(--buy)" : "var(--sell)";
  const submitLabel = !account
    ? "Connect Burner"
    : isRun
      ? "RUN JOB"
      : side === "buy"
        ? buyAndRun
          ? "BUY & RUN"
          : "BUY CREDITS"
        : "SELL CAPACITY";

  return (
    <div className="glass-2 flex h-full min-h-0 flex-col rounded-glass">
      {/* Trade / Run top-level tabs — buying compute is decoupled from running a job */}
      <div className="grid grid-cols-2 gap-0 p-2 pb-0">
        <TabBtn
          active={mode === "trade"}
          color="var(--accent)"
          onClick={() => setMode("trade")}
        >
          Trade
        </TabBtn>
        <TabBtn
          active={mode === "run"}
          color="var(--accent)"
          onClick={() => setMode("run")}
        >
          Run
        </TabBtn>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {/* Trade: Buy / Sell sub-tabs */}
        {mode === "trade" && (
          <div className="grid grid-cols-2 gap-0 border-b border-border-glass pb-0">
            <TabBtn
              active={side === "buy"}
              color="var(--buy)"
              onClick={() => setSide("buy")}
            >
              Buy · Bid
            </TabBtn>
            <TabBtn
              active={side === "sell"}
              color="var(--sell)"
              onClick={() => setSide("sell")}
            >
              Sell · Ask
            </TabBtn>
          </div>
        )}

        {mode === "run" && !runEmpty && (
          <p className="rounded-md border border-border-glass bg-elev/40 px-3 py-2 text-[11px] leading-relaxed text-muted">
            Redeem your held SCU credits to run an inference job. Buying credits
            (Trade) and running a job are separate — no swap happens here.
          </p>
        )}

        {/* Run-tab empty state — 0 credits held: nudge to buy on Trade instead of a dead submit. */}
        {runEmpty && (
          <div className="flex flex-col items-center gap-3 rounded-glass border border-border-glass bg-elev/40 px-5 py-8 text-center">
            <div
              className="flex h-11 w-11 items-center justify-center rounded-full text-[20px]"
              style={{ background: "var(--accent-dim)", color: "var(--accent)" }}
            >
              ⚡
            </div>
            <div className="space-y-1.5">
              <p className="text-[13px] font-medium text-primary">
                You hold no compute credits
              </p>
              <p className="text-[11.5px] leading-relaxed text-muted">
                Running a job redeems held SCU credits. Buy some on the{" "}
                <span className="font-medium text-accent">Trade</span> tab first, then come
                back here to run your prompt.
              </p>
            </div>
            <button
              onClick={goBuyCredits}
              className="focus-amber mt-1 flex h-9 items-center justify-center rounded-md px-5 text-[12.5px] font-semibold tracking-wide transition hover:brightness-[1.06] active:translate-y-px"
              style={{
                background: "var(--accent)",
                color: "var(--bg-0)",
                boxShadow: "0 6px 20px var(--accent-dim)",
              }}
            >
              Buy credits on Trade →
            </button>
          </div>
        )}

        {/* Limit / Market — trade-only (Run redeems at no price) */}
        {!runEmpty && mode === "trade" && (
          <div className="flex items-center gap-3 border-b border-border-glass pb-2">
            {(["limit", "market"] as OrderType[]).map((t) => (
              <button
                key={t}
                onClick={() => setType(t)}
                className={`text-[12px] capitalize transition ${
                  type === t
                    ? "font-medium text-primary"
                    : "text-muted hover:text-secondary"
                }`}
              >
                {t}
                {type === t && (
                  <span
                    className="mt-0.5 block h-[2px] w-full rounded"
                    style={{ background: "var(--accent)" }}
                  />
                )}
              </button>
            ))}
          </div>
        )}

        {/* available balance line */}
        {!runEmpty && (
          <div className="flex items-center justify-between">
            <span className="label-micro">Available</span>
            <span className="num text-[11.5px] text-secondary tabnum">
              {isRun
                ? `${fmtScu(credits)} SCU credits`
                : side === "buy"
                  ? `${fmtUsdc(usdc, 2)} USDC`
                  : `${fmtScu(credits)} SCU`}
            </span>
          </div>
        )}

        {/* price — trade-only */}
        {!runEmpty && mode === "trade" && (
          <Field
            label="Price"
            unit="USDC"
            disabled={type === "market"}
            value={type === "market" ? "Market" : price}
            onChange={(v) => {
              setPrice(v);
              setPriceTouched(true);
            }}
            mono
          />
        )}

        {/* amount */}
        {!runEmpty && (
          <Field
            label="Amount"
            unit="SCU"
            value={amount}
            onChange={setAmount}
            placeholder="0"
            mono
          />
        )}

        {/* Buy & run now — the one-click consumer shortcut (combined buy + run). Only on
            a Trade-Buy; toggling it on reveals the prompt below. */}
        {!runEmpty && mode === "trade" && side === "buy" && (
          <label className="flex cursor-pointer items-center justify-between rounded-md border border-border-glass bg-elev/40 px-3 py-2 transition hover:border-accent/40">
            <span className="label-micro flex items-center gap-1.5">
              <span className="text-accent">⚡</span>
              <span>Buy &amp; run now</span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={buyAndRun}
              onClick={() => setBuyAndRun((v) => !v)}
              className="focus-amber relative h-[18px] w-[32px] rounded-full transition"
              style={{
                background: buyAndRun ? "var(--accent)" : "var(--border-glass)",
              }}
            >
              <span
                className="absolute top-[2px] h-[14px] w-[14px] rounded-full transition-all"
                style={{
                  left: buyAndRun ? "16px" : "2px",
                  background: buyAndRun ? "var(--bg-0)" : "var(--text-dim)",
                }}
              />
            </button>
          </label>
        )}

        {/* prompt — ONLY in Run mode or under the Buy & run toggle. Never on plain Buy/Sell. */}
        {!runEmpty && promptShown && (
          <label className="flex flex-col gap-1.5 rounded-md border border-border-glass bg-elev/40 px-3 py-2 transition focus-within:border-accent/60 focus-within:shadow-accent-glow">
            <span className="label-micro flex items-center justify-between">
              <span>Prompt · task to run</span>
              <span className="text-accent">required</span>
            </span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Ask the GPU anything — e.g. Explain attention in one paragraph."
              rows={3}
              className="min-h-0 w-full resize-y bg-transparent text-[12px] leading-relaxed text-primary outline-none placeholder:text-muted"
            />
          </label>
        )}

        {/* % slider */}
        {!runEmpty && (
        <div className="pt-1">
          <input
            type="range"
            min={0}
            max={100}
            value={pctSel}
            onChange={(e) => applyPct(Number(e.target.value))}
            className="gix-range w-full"
            style={
              {
                "--sel": `${pctSel}%`,
                "--accent": accent,
              } as React.CSSProperties
            }
          />
          <div className="mt-1.5 grid grid-cols-4 gap-1">
            {[25, 50, 75, 100].map((p) => (
              <button
                key={p}
                onClick={() => applyPct(p)}
                className={`focus-amber rounded border py-1 text-[10.5px] transition ${
                  pctSel === p
                    ? "border-accent/45 bg-accent/[0.08] text-primary"
                    : "border-border-glass text-muted hover:border-accent/30 hover:text-secondary"
                }`}
              >
                {p}%
              </button>
            ))}
          </div>
        </div>
        )}

        {/* total — a cost in Trade, an SCU spend in Run */}
        {!runEmpty && (
          <div className="flex items-center justify-between border-t border-border-glass pt-2.5">
            <span className="label-micro">{spendsCredits ? "Spends" : "Total"}</span>
            <span className="num text-[13px] font-medium text-primary tabnum">
              {spendsCredits ? (
                <>
                  {fmtScu(amountNum)}{" "}
                  <span className="text-[10px] text-muted">SCU</span>
                </>
              ) : (
                <>
                  {fmtUsdc(total, 4)}{" "}
                  <span className="text-[10px] text-muted">USDC</span>
                </>
              )}
            </span>
          </div>
        )}

        {/* submit */}
        {!runEmpty && (
        <button
          onClick={onSubmit}
          disabled={submitting || connecting}
          className="focus-amber relative mt-1 flex h-10 items-center justify-center rounded-md text-[13px] font-semibold tracking-wide text-base transition hover:brightness-[1.06] active:translate-y-px disabled:opacity-60"
          style={{
            background: account ? accent : "var(--accent)",
            color: "var(--bg-0)",
            boxShadow: `0 6px 20px ${
              account
                ? isRun
                  ? "var(--accent-dim)"
                  : side === "buy"
                    ? "rgba(46,189,133,0.25)"
                    : "rgba(246,70,93,0.25)"
                : "var(--accent-dim)"
            }`,
          }}
        >
          {submitting ? "Submitting…" : connecting ? "Connecting…" : submitLabel}
        </button>
        )}

        {flash && (
          <div
            className="animate-fade-in rounded border px-2.5 py-1.5 text-[11px]"
            style={{
              borderColor:
                flash.kind === "ok" ? "rgba(14,203,129,0.4)" : "rgba(246,70,93,0.4)",
              color: flash.kind === "ok" ? "var(--buy)" : "var(--sell)",
              background: flash.kind === "ok" ? "var(--buy-bg)" : "var(--sell-bg)",
            }}
          >
            {flash.msg}
          </div>
        )}

        {/* wallet / balances footer */}
        <div className="mt-auto flex flex-col gap-2 border-t border-border-glass pt-3">
          {account ? (
            <>
              <div className="flex items-center justify-between">
                <span className="label-micro">Burner</span>
                <span className="num text-[11px] text-secondary">
                  {shortId(account.address)}
                </span>
              </div>
              <BalLine label="USDC" value={fmtUsdc(usdc, 2)} />
              <BalLine label="SCU Credits" value={fmtScu(credits)} />
              <BalLine label="SUI (gas)" value={fmtUsdc(balances?.sui ?? 0, 4)} />
              <button
                onClick={fundWallet}
                disabled={funding}
                className="focus-amber mt-1 rounded border border-border-glass px-2 py-1.5 text-[11px] text-accent transition hover:border-accent/40 hover:bg-accent/5 disabled:opacity-60"
              >
                {funding ? "Funding…" : "Fund from localnet faucet"}
              </button>
            </>
          ) : (
            <p className="text-[11px] leading-relaxed text-muted">
              Dev signing uses a faucet-funded burner key (localnet). Connect to
              place orders; real wallet-connect arrives with testnet.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function TabBtn({
  active,
  color,
  onClick,
  children,
}: {
  active: boolean;
  color: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="relative py-1.5 text-[12.5px] font-medium transition"
      style={{ color: active ? color : "var(--text-muted)" }}
    >
      {children}
      <span
        className="absolute inset-x-2 bottom-0 h-[2px] rounded transition-opacity"
        style={{ background: color, opacity: active ? 1 : 0 }}
      />
    </button>
  );
}

function Field({
  label,
  unit,
  value,
  onChange,
  disabled,
  placeholder,
  mono,
}: {
  label: string;
  unit: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <label className="flex items-center justify-between gap-2 rounded-md border border-border-glass bg-elev/40 px-3 py-2 transition focus-within:border-accent/60 focus-within:shadow-accent-glow">
      <span className="label-micro shrink-0">{label}</span>
      <input
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        inputMode="decimal"
        className={`min-w-0 flex-1 bg-transparent text-right text-[13px] text-primary outline-none placeholder:text-muted disabled:text-muted ${
          mono ? "num tabnum" : ""
        }`}
      />
      <span className="label-micro shrink-0">{unit}</span>
    </label>
  );
}

function BalLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] text-muted">{label}</span>
      <span className="num text-[11.5px] text-secondary tabnum">{value}</span>
    </div>
  );
}
