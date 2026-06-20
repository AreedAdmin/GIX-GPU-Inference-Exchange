// web/src/components/OnRampWidget.tsx
// GIX "Get USDC" on-ramp — a small glass utility that swaps SUI → USDC on the
// LIVE DeepBook testnet pool SUI_DBUSDC, with NO DEEP (input-coin fees).
//
// Why: users hold SUI (gas) but compute is priced in USDC. On testnet the dollar
// is DBUSDC (the testnet USDC stand-in, docs/onramp-dbusdc-plan.md). This widget
// runs `pool::swap_exact_base_for_quote<SUI, DBUSDC>` on the existing pool with
// `deepAmount: 0` (pay_with_deep: false), so it needs no DEEP and works today.
// It is a funding convenience, NOT a DEX.
//
// Surface (matches the amber glass system + GlassPanel API, m1_5-ui-polish):
//   • amount input (SUI) with a live SUI_DBUSDC price + DBUSDC estimate,
//   • a "Swap SUI → USDC" CTA wired through the connected wallet (dapp-kit
//     useSignTransaction → executeTransactionBlock), and
//   • the user's SUI + DBUSDC balances.
//
// Degrades gracefully: disconnected / non-testnet / unreachable pool all render a
// quiet hint instead of a broken control. Price comes from the public DeepBook
// indexer (highest bid) with an on-chain devInspect fallback. Owns ONLY this file
// (+ its mount in MarketsSidebar); touches no other agent's files or index.css.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useCurrentAccount,
  useSignTransaction,
  useSuiClientContext,
} from "@mysten/dapp-kit";
import { GlassPanel } from "./GlassPanel";

type SuiJsonRpcClientT = import("@mysten/sui/jsonRpc").SuiJsonRpcClient;

// ── pinned constants (deepbook-v3 testnet + docs/onramp-dbusdc-plan.md) ────────
const DBUSDC_TYPE =
  "0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC";
const SUI_DBUSDC_POOL_KEY = "SUI_DBUSDC";
const INDEXER_URL = "https://deepbook-indexer.testnet.mystenlabs.com";

const SUI_DECIMALS = 9;
const DBUSDC_DECIMALS = 6;
const DBUSDC_SCALAR = 10 ** DBUSDC_DECIMALS;

// The live pool enforces a 1-SUI minimum order size; below it nothing matches.
const POOL_MIN_SIZE_SUI = 1;
const DEFAULT_AMOUNT_SUI = "1.1";
const SLIPPAGE_BPS = 100; // 1.00%
const PRICE_POLL_MS = 8000;

type Status = "idle" | "quoting" | "swapping" | "ok" | "err";

interface SwapDone {
  digest: string;
  dbusdcReceived: number;
}

function fmt(n: number, dp: number): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function shortDigest(d: string): string {
  return d.length <= 14 ? d : `${d.slice(0, 8)}…${d.slice(-4)}`;
}

/** Lazily build + cache one SuiJsonRpcClient (testnet fullnode), mirroring
 * web/src/data/deepbook.ts — the dapp-kit `useSuiClient` returns the new
 * core-API client whose method shape differs from the legacy jsonRpc client we
 * (and the DeepBook SDK) use for reads/exec. */
let _rpc: Promise<SuiJsonRpcClientT> | null = null;
async function getRpc(rpcUrl?: string): Promise<SuiJsonRpcClientT> {
  if (_rpc) return _rpc;
  _rpc = (async () => {
    const { SuiJsonRpcClient, getJsonRpcFullnodeUrl } = await import("@mysten/sui/jsonRpc");
    return new SuiJsonRpcClient({
      network: "testnet",
      url: rpcUrl ?? getJsonRpcFullnodeUrl("testnet"),
    });
  })();
  return _rpc;
}

export function OnRampWidget() {
  const account = useCurrentAccount();
  const ctx = useSuiClientContext();
  const { mutateAsync: signTransaction } = useSignTransaction();

  const network = ctx.network;
  const isTestnet = network === "testnet";
  const address = account?.address ?? null;
  const rpcUrl = ctx.networks?.testnet
    ? (ctx.networks.testnet as { url?: string }).url
    : undefined;

  const [amount, setAmount] = useState<string>(DEFAULT_AMOUNT_SUI);
  const [price, setPrice] = useState<number | null>(null); // DBUSDC per SUI (bid)
  const [status, setStatus] = useState<Status>("idle");
  const [errMsg, setErrMsg] = useState<string>("");
  const [done, setDone] = useState<SwapDone | null>(null);
  const [bal, setBal] = useState<{ sui: number; dbusdc: number } | null>(null);

  const amountNum = parseFloat(amount) || 0;
  const estDbusdc = price != null && amountNum > 0 ? price * amountNum : null;
  const belowMin = amountNum > 0 && amountNum < POOL_MIN_SIZE_SUI;

  // ── live SUI_DBUSDC price (indexer highest-bid, on-chain fallback) ───────────
  const pollPrice = useCallback(async () => {
    if (!isTestnet) return;
    // 1. Indexer summary — cheap, cached, gives the SUI→DBUSDC bid directly.
    try {
      const res = await fetch(`${INDEXER_URL}/summary`);
      if (res.ok) {
        const rows = (await res.json()) as Array<{
          trading_pairs?: string;
          highest_bid?: number;
          last_price?: number;
        }>;
        const row = rows.find((r) => r.trading_pairs === SUI_DBUSDC_POOL_KEY);
        const p = Number(row?.highest_bid ?? row?.last_price ?? 0);
        if (p > 0) {
          setPrice(p);
          return;
        }
      }
    } catch {
      /* fall through to on-chain */
    }
    // 2. On-chain devInspect fallback via the DeepBook SDK (no wallet needed).
    try {
      const rpc = await getRpc(rpcUrl);
      const { DeepBookClient } = await import("@mysten/deepbook-v3");
      const db = new DeepBookClient({
        client: rpc as unknown as never,
        address:
          address ??
          "0x0000000000000000000000000000000000000000000000000000000000000000",
        network: "testnet" as never,
      });
      // Price a 2-SUI fill (≥ the pool min) so the read returns a non-zero quote.
      const q = await db.getQuoteQuantityOutInputFee(SUI_DBUSDC_POOL_KEY, 2);
      const filled = 2 - Number(q.baseOut ?? 0);
      const out = Number(q.quoteOut ?? 0);
      if (filled > 0 && out > 0) setPrice(out / filled);
    } catch {
      /* leave price null → UI shows a quiet hint */
    }
  }, [isTestnet, rpcUrl, address]);

  useEffect(() => {
    if (!isTestnet) return;
    void pollPrice();
    const t = setInterval(() => void pollPrice(), PRICE_POLL_MS);
    return () => clearInterval(t);
  }, [isTestnet, pollPrice]);

  // ── balances (SUI + DBUSDC) ──────────────────────────────────────────────────
  const refreshBalances = useCallback(async () => {
    if (!address) {
      setBal(null);
      return;
    }
    try {
      const rpc = await getRpc(rpcUrl);
      const [s, d] = await Promise.all([
        rpc.getBalance({ owner: address }),
        rpc.getBalance({ owner: address, coinType: DBUSDC_TYPE }),
      ]);
      setBal({
        sui: Number(s.totalBalance) / 10 ** SUI_DECIMALS,
        dbusdc: Number(d.totalBalance) / DBUSDC_SCALAR,
      });
    } catch {
      /* transient — keep last */
    }
  }, [address, rpcUrl]);

  useEffect(() => {
    void refreshBalances();
  }, [refreshBalances]);

  // ── the swap (build PTB via DeepBook SDK, sign via wallet, execute) ───────────
  const onSwap = useCallback(async () => {
    if (!address || !isTestnet) return;
    setStatus("quoting");
    setErrMsg("");
    setDone(null);
    try {
      const rpc = await getRpc(rpcUrl);
      const { DeepBookClient } = await import("@mysten/deepbook-v3");
      const { Transaction } = await import("@mysten/sui/transactions");

      const db = new DeepBookClient({
        client: rpc as unknown as never,
        address,
        network: "testnet" as never,
      });

      // Price the swap on-chain (input-fee path) to derive the slippage floor +
      // confirm it actually fills (≥ the 1-SUI pool minimum).
      const q = await db.getQuoteQuantityOutInputFee(SUI_DBUSDC_POOL_KEY, amountNum);
      const out = Number(q.quoteOut ?? 0);
      if (!(out > 0)) {
        throw new Error(
          `That amount fills 0 USDC — the pool needs ≥ ${POOL_MIN_SIZE_SUI} SUI per swap.`,
        );
      }
      const minOutBase = BigInt(
        Math.max(0, Math.floor(((out * (10_000 - SLIPPAGE_BPS)) / 10_000) * DBUSDC_SCALAR)),
      );

      // Build the swap PTB: swap_exact_base_for_quote<SUI, DBUSDC>(input-coin fees).
      const tx = new Transaction();
      tx.setSenderIfNotSet(address);
      const [suiRemainder, dbusdcOut, deepRemainder] = db.deepBook.swapExactBaseForQuote({
        poolKey: SUI_DBUSDC_POOL_KEY,
        amount: amountNum, // whole SUI; SDK scales by 1e9, sources from gas coin
        deepAmount: 0, // input-coin fees ⇒ pay_with_deep: false, NO DEEP
        minOut: minOutBase, // bigint ⇒ raw u64 floor (6dp)
      })(tx as never) as unknown as [unknown, unknown, unknown];
      // Hand all three result coins back so the PTB has no dangling values.
      tx.transferObjects(
        [suiRemainder as never, dbusdcOut as never, deepRemainder as never],
        tx.pure.address(address),
      );

      setStatus("swapping");
      // The wallet builds + signs the PTB (returns signed bytes + signature), then
      // we broadcast + confirm via our jsonRpc client.
      const signed = await signTransaction({
        transaction: tx as never,
        chain: `sui:${network}`,
      });
      const exec = await rpc.executeTransactionBlock({
        transactionBlock: signed.bytes,
        signature: signed.signature,
        options: { showEffects: true, showBalanceChanges: true },
      });
      await rpc.waitForTransaction({ digest: exec.digest });

      const st = exec.effects?.status;
      if (st && st.status !== "success") {
        throw new Error(st.error ?? "swap failed on-chain");
      }

      // Measure DBUSDC received from the sender's balance changes.
      let received = 0;
      for (const bc of exec.balanceChanges ?? []) {
        const owner = bc.owner as { AddressOwner?: string } | undefined;
        if (owner?.AddressOwner === address && bc.coinType === DBUSDC_TYPE) {
          received += Number(BigInt(bc.amount)) / DBUSDC_SCALAR;
        }
      }

      setDone({ digest: exec.digest, dbusdcReceived: received });
      setStatus("ok");
      void refreshBalances();
    } catch (e) {
      setErrMsg((e as Error).message ?? "swap failed");
      setStatus("err");
    }
  }, [address, isTestnet, rpcUrl, amountNum, signTransaction, network, refreshBalances]);

  const explorerBase = useMemo(
    () => (isTestnet ? "https://suiscan.xyz/testnet/tx" : ""),
    [isTestnet],
  );

  const busy = status === "quoting" || status === "swapping";
  const canSwap =
    !!address && isTestnet && amountNum >= POOL_MIN_SIZE_SUI && !busy;

  return (
    <GlassPanel elevation={1} className="rounded-glass" title="Get USDC" flush>
      <div className="flex flex-col gap-2.5 p-3">
        <p className="text-[10.5px] leading-relaxed text-muted">
          Swap SUI → USDC on DeepBook. No DEEP needed.
        </p>

        {/* amount input */}
        <label className="flex items-center justify-between gap-2 rounded-md border border-border-glass bg-elev/40 px-3 py-2 transition focus-within:border-accent/60 focus-within:shadow-accent-glow">
          <span className="label-micro shrink-0">Pay</span>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="0"
            disabled={!isTestnet}
            className="num tabnum min-w-0 flex-1 bg-transparent text-right text-[13px] text-primary outline-none placeholder:text-muted disabled:text-muted"
          />
          <span className="label-micro shrink-0">SUI</span>
        </label>

        {/* live price + estimate */}
        <div className="flex items-center justify-between px-0.5">
          <span className="label-micro">Price</span>
          <span className="num text-[11px] text-secondary tabnum">
            {price != null ? `${fmt(price, 4)} USDC/SUI` : "—"}
          </span>
        </div>
        <div className="flex items-center justify-between rounded-md border border-border-glass bg-elev/30 px-3 py-2">
          <span className="label-micro">Receive ≈</span>
          <span className="num text-[13px] font-medium text-primary tabnum">
            {estDbusdc != null ? fmt(estDbusdc, 4) : "—"}{" "}
            <span className="text-[10px] text-muted">USDC</span>
          </span>
        </div>

        {belowMin && isTestnet && (
          <p className="text-[10px] leading-snug text-muted">
            Pool minimum is {POOL_MIN_SIZE_SUI} SUI per swap.
          </p>
        )}

        {/* CTA */}
        <button
          onClick={onSwap}
          disabled={!canSwap}
          className="focus-amber relative mt-0.5 flex h-9 items-center justify-center rounded-md text-[12.5px] font-semibold tracking-wide transition hover:brightness-[1.06] active:translate-y-px disabled:opacity-50"
          style={{
            background: "var(--accent)",
            color: "var(--bg-0)",
            boxShadow: "0 6px 18px var(--accent-dim)",
          }}
        >
          {status === "swapping"
            ? "Swapping…"
            : status === "quoting"
              ? "Pricing…"
              : "Swap SUI → USDC"}
        </button>

        {/* disconnected / wrong-network hints (graceful degrade) */}
        {!isTestnet && (
          <p className="text-[10px] leading-snug text-muted">
            On-ramp is testnet-only. Switch your wallet network to testnet.
          </p>
        )}
        {isTestnet && !address && (
          <p className="text-[10px] leading-snug text-muted">
            Connect a wallet to swap.
          </p>
        )}

        {/* result / error */}
        {status === "ok" && done && (
          <div
            className="animate-fade-in rounded border px-2.5 py-1.5 text-[10.5px] leading-snug"
            style={{
              borderColor: "rgba(46,189,133,0.4)",
              color: "var(--up)",
              background: "var(--buy-bg)",
            }}
          >
            +{fmt(done.dbusdcReceived, 4)} USDC ·{" "}
            {explorerBase ? (
              <a
                href={`${explorerBase}/${done.digest}`}
                target="_blank"
                rel="noreferrer"
                className="underline decoration-dotted underline-offset-2"
              >
                {shortDigest(done.digest)}
              </a>
            ) : (
              shortDigest(done.digest)
            )}
          </div>
        )}
        {status === "err" && (
          <div
            className="animate-fade-in rounded border px-2.5 py-1.5 text-[10.5px] leading-snug"
            style={{
              borderColor: "rgba(246,70,93,0.4)",
              color: "var(--down)",
              background: "var(--sell-bg)",
            }}
          >
            {errMsg}
          </div>
        )}

        {/* balances */}
        {address && (
          <div className="mt-0.5 flex flex-col gap-1 border-t border-border-glass pt-2">
            <BalLine label="SUI" value={bal ? fmt(bal.sui, 4) : "—"} />
            <BalLine label="USDC" value={bal ? fmt(bal.dbusdc, 2) : "—"} />
          </div>
        )}
      </div>
    </GlassPanel>
  );
}

function BalLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[10.5px] text-muted">{label}</span>
      <span className="num text-[11px] text-secondary tabnum">{value}</span>
    </div>
  );
}
