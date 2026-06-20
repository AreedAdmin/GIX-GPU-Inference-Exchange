// web/src/components/WalletBar.tsx
// Compact wallet affordance for the TopBar (demo-milestone-contract §5). On localnet it
// drives the faucet-funded burner (connect → fund → show address + SUI/USDC balances).
// On testnet it surfaces dapp-kit's ConnectButton for a real wallet. Matches the existing
// Palantir-glass aesthetic (no dapp-kit default chrome on localnet).

import { ConnectButton } from "@mysten/dapp-kit";
import { useGix } from "../store";
import { shortId } from "../lib/config";
import { fmtUsdc } from "../lib/format";
import { loadChainConfig } from "../trade/config";

const cfg = loadChainConfig();

export function WalletBar() {
  const {
    account,
    balances,
    connecting,
    funding,
    connectWallet,
    fundWallet,
    isLiveChain,
  } = useGix();

  // Testnet + real chain: hand off to dapp-kit's wallet connect.
  if (isLiveChain && cfg.network !== "localnet") {
    return (
      <div className="gix-connect-slot flex items-center">
        <ConnectButton />
      </div>
    );
  }

  if (!account) {
    return (
      <button
        onClick={connectWallet}
        disabled={connecting}
        className="flex items-center gap-2 rounded-md border border-border-glass bg-elev/60 px-3 py-1.5 text-[12px] font-medium text-accent transition hover:border-accent/50 hover:bg-accent/5 disabled:opacity-60"
      >
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: "var(--accent)" }}
        />
        {connecting ? "Connecting…" : "Connect Burner"}
      </button>
    );
  }

  const usdc = balances?.usdc ?? 0;
  const sui = balances?.sui ?? 0;
  const lowGas = isLiveChain && sui <= 0;

  return (
    <div className="flex items-center gap-2.5">
      <div className="flex flex-col items-end leading-tight">
        <span className="num text-[11.5px] text-secondary" title={account.address}>
          {shortId(account.address)}
        </span>
        <span className="num text-[10px] tabnum text-muted">
          {fmtUsdc(usdc, 2)} USDC · {fmtUsdc(sui, 3)} SUI
        </span>
      </div>
      <button
        onClick={fundWallet}
        disabled={funding}
        className="rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition disabled:opacity-60"
        style={{
          borderColor: lowGas ? "var(--amber)" : "var(--border-glass)",
          color: lowGas ? "var(--amber)" : "var(--accent)",
          background: lowGas ? "rgba(245,166,35,0.08)" : "transparent",
        }}
      >
        {funding ? "Funding…" : lowGas ? "Fund (gas low)" : "Fund"}
      </button>
    </div>
  );
}
