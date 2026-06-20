// web/src/wallet/WalletProvider.tsx
// dapp-kit wallet plumbing (demo-milestone-contract §5). Wraps the app in
// QueryClient + SuiClientProvider + WalletProvider so the testnet path can use a real
// wallet (Sui Wallet / Slush). On localnet the burner key (trade/burner.ts) is used
// instead, but mounting the providers is harmless + lets the ConnectButton render.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  SuiClientProvider,
  WalletProvider as DappKitWalletProvider,
  createNetworkConfig,
} from "@mysten/dapp-kit";
import "@mysten/dapp-kit/dist/index.css";
import type { ReactNode } from "react";
import { loadChainConfig } from "../trade/config";

const cfg = loadChainConfig();

const { networkConfig } = createNetworkConfig({
  localnet: { url: cfg.rpcUrl },
  testnet: { url: cfg.network === "testnet" ? cfg.rpcUrl : "https://fullnode.testnet.sui.io:443" },
  mainnet: { url: "https://fullnode.mainnet.sui.io:443" },
});

const queryClient = new QueryClient();

export function WalletProvider({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider
        networks={networkConfig}
        defaultNetwork={cfg.network === "localnet" ? "localnet" : "testnet"}
      >
        <DappKitWalletProvider autoConnect>{children}</DappKitWalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  );
}
