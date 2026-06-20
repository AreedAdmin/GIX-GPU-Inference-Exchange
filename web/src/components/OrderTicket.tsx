import { useEffect, useMemo, useState } from "react";
import { useActiveMarket, useGix } from "../store";
import { fmtScu, fmtUsdc, fmtPrice } from "../lib/format";
import { shortId } from "../lib/config";

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
    isLiveChain,
  } = useGix();
  const market = useActiveMarket();

  const [side, setSide] = useState<Side>("buy");
  const [type, setType] = useState<OrderType>("limit");
  const [price, setPrice] = useState<string>("");
  const [amount, setAmount] = useState<string>("");
  const [prompt, setPrompt] = useState<string>("");
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

  // book-row click prefills price
  useEffect(() => {
    if (prefillPrice != null) {
      setPrice(fmtPrice(prefillPrice));
      setPriceTouched(true);
      setPrefillPrice(null);
    }
  }, [prefillPrice, setPrefillPrice]);

  const priceNum = type === "market" ? mid : parseFloat(price) || 0;
  const amountNum = parseFloat(amount) || 0;
  const total = priceNum * amountNum;

  const usdc = balances?.usdc ?? 0;
  const credits = balances?.creditsScu ?? 0;

  // available depends on side
  const maxAffordableScu = useMemo(() => {
    if (side === "buy") return priceNum > 0 ? usdc / priceNum : 0;
    return credits;
  }, [side, priceNum, usdc, credits]);

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
    if (side === "buy" && isLiveChain && prompt.trim().length === 0) {
      setFlash({ kind: "err", msg: "enter a prompt — the task to run" });
      return;
    }
    setSubmitting(true);
    const res = await submitOrder({
      side,
      type,
      price: priceNum,
      sizeScu: amountNum,
      prompt: side === "buy" ? prompt : undefined,
    });
    setSubmitting(false);
    if (res.ok) {
      setFlash({
        kind: "ok",
        msg: `order sent · ${res.jobId ? shortId(res.jobId) : res.digest ? shortId(res.digest) : "ok"}`,
      });
      setAmount("");
      setPctSel(0);
      setPrompt("");
    } else {
      setFlash({ kind: "err", msg: res.error ?? "order failed" });
    }
    setTimeout(() => setFlash(null), 4000);
  }

  const accent = side === "buy" ? "var(--buy)" : "var(--sell)";
  const submitLabel = !account
    ? "Connect Burner"
    : side === "buy"
      ? "BUY COMPUTE"
      : "SELL CAPACITY";

  return (
    <div className="glass-2 flex h-full min-h-0 flex-col rounded-glass">
      {/* Buy / Sell tabs */}
      <div className="grid grid-cols-2 gap-0 p-2 pb-0">
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

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {/* Limit / Market */}
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

        {/* available balance line */}
        <div className="flex items-center justify-between">
          <span className="label-micro">Available</span>
          <span className="num text-[11.5px] text-secondary tabnum">
            {side === "buy"
              ? `${fmtUsdc(usdc, 2)} USDC`
              : `${fmtScu(credits)} SCU`}
          </span>
        </div>

        {/* price */}
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

        {/* amount */}
        <Field
          label="Amount"
          unit="SCU"
          value={amount}
          onChange={setAmount}
          placeholder="0"
          mono
        />

        {/* prompt — the real inference task to run (demo-contract runTask). Buy only. */}
        {side === "buy" && (
          <label className="flex flex-col gap-1.5 rounded-md border border-border-glass bg-elev/40 px-3 py-2 transition focus-within:border-accent/60 focus-within:shadow-accent-glow">
            <span className="label-micro flex items-center justify-between">
              <span>Prompt · task to run</span>
              {isLiveChain && <span className="text-accent">required</span>}
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

        {/* total */}
        <div className="flex items-center justify-between border-t border-border-glass pt-2.5">
          <span className="label-micro">Total</span>
          <span className="num text-[13px] font-medium text-primary tabnum">
            {fmtUsdc(total, 4)}{" "}
            <span className="text-[10px] text-muted">USDC</span>
          </span>
        </div>

        {/* submit */}
        <button
          onClick={onSubmit}
          disabled={submitting || connecting}
          className="focus-amber relative mt-1 flex h-10 items-center justify-center rounded-md text-[13px] font-semibold tracking-wide text-base transition hover:brightness-[1.06] active:translate-y-px disabled:opacity-60"
          style={{
            background: account ? accent : "var(--accent)",
            color: "var(--bg-0)",
            boxShadow: `0 6px 20px ${account ? (side === "buy" ? "rgba(46,189,133,0.25)" : "rgba(246,70,93,0.25)") : "var(--accent-dim)"}`,
          }}
        >
          {submitting ? "Submitting…" : connecting ? "Connecting…" : submitLabel}
        </button>

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
