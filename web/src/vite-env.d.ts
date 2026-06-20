/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DATA_SOURCE?: "mock" | "ws";
  readonly VITE_WS_URL?: string;
  readonly VITE_RPC_URL?: string;
  readonly VITE_FAUCET_URL?: string;

  // ── trade/wallet/result layer (demo-milestone-contract §5/§6) ──────────────
  /** "sui" wires the real on-chain OrderClient; "mock" (default) uses the simulator. */
  readonly VITE_ORDER_CLIENT?: "mock" | "sui";
  /** Network for the chain config + faucet/explorer derivation. */
  readonly VITE_NETWORK?: "localnet" | "testnet" | "devnet" | "mainnet";
  /** Provider node base URL serving /inputs + /result/:jobId + /health. */
  readonly VITE_PROVIDER_URL?: string;
  /** Provider operator address (holds the ProviderStake + Credit<M> the buy reserves). */
  readonly VITE_PROVIDER_ADDRESS?: string;
  /** deployment.json overrides (testnet redeploy) — default to the bundled localnet ids. */
  readonly VITE_PACKAGE_ID?: string;
  readonly VITE_CONFIG_ID?: string;
  readonly VITE_CLOCK_ID?: string;
  readonly VITE_USDC_TYPE?: string;
  readonly VITE_FAUCET_ID?: string;
  readonly VITE_MARKET_ID?: string;
  readonly VITE_MARKET_NAME?: string;
  readonly VITE_MARKET_CREDIT_TYPE?: string;
  readonly VITE_MARKET_MODEL_ID?: string;
  /** Explorer tx base, e.g. https://suiscan.xyz/testnet/tx (empty disables links). */
  readonly VITE_EXPLORER_TX_BASE?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
