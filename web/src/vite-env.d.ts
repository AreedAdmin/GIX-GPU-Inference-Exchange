/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DATA_SOURCE?: "mock" | "ws" | "deepbook";
  readonly VITE_WS_URL?: string;
  readonly VITE_RPC_URL?: string;
  readonly VITE_FAUCET_URL?: string;

  // ── DeepBook market data source (M2; VITE_DATA_SOURCE=deepbook) ─────────────
  /** Network for DeepBook reads (testnet-only for GIX M2). */
  readonly VITE_DEEPBOOK_NETWORK?: "testnet" | "mainnet" | "devnet" | "localnet";
  /** The market's bound DeepBook pool id (deployment.markets[0].deepbookPoolId). */
  readonly VITE_DEEPBOOK_POOL_ID?: string;
  /** Base coin (Credit<M>) fully-qualified type. Defaults to VITE_MARKET_CREDIT_COIN_TYPE. */
  readonly VITE_DEEPBOOK_BASE_TYPE?: string;
  /** Base coin on-chain decimals (Credit is whole-SCU ⇒ 1). */
  readonly VITE_DEEPBOOK_BASE_SCALAR?: string;
  /** Quote coin (USDC) fully-qualified type. Defaults to VITE_USDC_TYPE. */
  readonly VITE_DEEPBOOK_QUOTE_TYPE?: string;
  /** Quote coin on-chain decimals (USDC ⇒ 1_000_000). */
  readonly VITE_DEEPBOOK_QUOTE_SCALAR?: string;
  /** Inner Credit<M> coin type, used as the DeepBook base coin type. */
  readonly VITE_MARKET_CREDIT_COIN_TYPE?: string;
  /** Public DeepBook indexer base for recent trades. */
  readonly VITE_DEEPBOOK_INDEXER_URL?: string;
  readonly VITE_DEEPBOOK_BOOK_POLL_MS?: string;
  readonly VITE_DEEPBOOK_TRADES_POLL_MS?: string;
  readonly VITE_DEEPBOOK_TICKS?: string;

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
