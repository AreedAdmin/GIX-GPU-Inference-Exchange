// web/src/trade/config.ts
// Chain + provider config for the REAL OrderClient (demo-milestone-contract §5/§6).
// Mirrors deployment.json (localnet) but every field is overridable via VITE_* env so
// the same build runs against localnet or testnet. The OrderClient + wallet layer read
// ONLY from here, so the integrator flips networks by editing .env, never code.

import { DEPLOYMENT } from "../lib/config";

export type GixNetwork = "localnet" | "testnet" | "mainnet" | "devnet";

/** Loaded `deployment.json` subset the OrderClient needs. Defaults mirror the
 *  bundled localnet DEPLOYMENT; testnet swaps these via VITE_* (see .env.example). */
export interface ChainConfig {
  network: GixNetwork;
  rpcUrl: string;
  faucetUrl: string;
  packageId: string;
  configId: string;
  clockId: string;
  usdcType: string;
  faucetId: string;
  /** The provider operator address that fills the stubbed match (holds the
   *  ProviderStake + Credit<M> the buy reserves). Defaults to deployment provider[0]. */
  providerAddress: string;
  /** Provider node base URL serving /inputs + /result/:jobId + /health (node §3.1). */
  providerUrl: string;
  market: MarketChainConfig;
  /** Block-explorer base; an empty string disables explorer links (localnet). */
  explorerTxBase: string;
  /** Object-explorer base (for Job ids), e.g. https://suiscan.xyz/testnet/object. Empty = off. */
  explorerObjectBase: string;
  /** Public Walrus aggregator base for blob retrieval in the in-browser auditor. */
  walrusAggregator: string;
}

export interface MarketChainConfig {
  id: string;
  name: string;
  /** Fully-qualified `M` witness type param for every Market/Job/Credit PTB. */
  creditType: string;
  /** Per-market registry::ModelRecord id. */
  modelId: string;
  scuTokens: number;
  slaP99Ms: number;
  /** Shared `Ask<M>` object id the consumer fills via `job::create_job_from_ask`
   *  (Option 3 inline-input, tunnel-free buy). The PROVIDER posts the Ask at deploy
   *  time (`staking::post_ask`) and publishes its id; the web reads it from here
   *  (VITE_MARKET_ASK_ID / deployment). Empty until provisioned → the buy degrades
   *  gracefully with a helpful message rather than building an invalid PTB. */
  askId: string;
}

function env(key: string): string | undefined {
  const v = (import.meta.env as Record<string, string | undefined>)?.[key];
  return v && v.length > 0 ? v : undefined;
}

/** Default localnet creditType / modelId from the bundled deployment.json (lib/config
 *  carries the slimmer DEPLOYMENT; these full ids live here so the PTB layer is complete). */
const LOCALNET_MARKET: MarketChainConfig = {
  id: DEPLOYMENT.market.id,
  name: DEPLOYMENT.market.name,
  creditType:
    "0x91bca1cd13a5131119467e8bf4867f76ab1c12fcc7200f8c0bbf3acd9dee72ee::markets::M_H100_LLAMA8B",
  modelId:
    "0x8266691ba5652e694d978f83fefbc9edc5028949f8523fa65c11773264e69d34",
  scuTokens: DEPLOYMENT.market.scuTokens,
  slaP99Ms: DEPLOYMENT.market.slaP99Ms,
  // The shared Ask is posted by the provider at deploy time; localnet leaves it unset
  // (the demo provisions it via VITE_MARKET_ASK_ID) so the buy degrades gracefully.
  askId: "",
};

const LOCALNET_FAUCET_ID =
  "0x1a290a06864e188fca32bd823ad1bc92d602d7ddb1b8075ac8c2024db170c807";
const LOCALNET_PROVIDER =
  "0xb8e7af9d7be92710d38b1f867c6bc99db9171e47d7bc1afef87ba8a4350ee4e7";

/** Build the live ChainConfig from env + bundled deployment defaults. */
export function loadChainConfig(): ChainConfig {
  const network = (env("VITE_NETWORK") as GixNetwork) ?? "localnet";
  const rpcUrl =
    env("VITE_RPC_URL") ??
    (network === "localnet"
      ? "http://127.0.0.1:9000"
      : `https://fullnode.${network}.sui.io:443`);
  const faucetUrl =
    env("VITE_FAUCET_URL") ??
    (network === "localnet"
      ? "http://127.0.0.1:9123"
      : `https://faucet.${network}.sui.io`);

  const explorerTxBase =
    env("VITE_EXPLORER_TX_BASE") ??
    (network === "localnet" ? "" : `https://suiscan.xyz/${network}/tx`);

  const explorerObjectBase =
    env("VITE_EXPLORER_OBJECT_BASE") ??
    (network === "localnet" ? "" : `https://suiscan.xyz/${network}/object`);

  // Public Walrus aggregator (testnet by default — read-only blob retrieval for the F7
  // in-browser auditor). Mainnet/devnet swap via VITE_WALRUS_AGGREGATOR.
  const walrusAggregator =
    env("VITE_WALRUS_AGGREGATOR") ??
    "https://aggregator.walrus-testnet.walrus.space";

  return {
    network,
    rpcUrl,
    faucetUrl,
    packageId: env("VITE_PACKAGE_ID") ?? DEPLOYMENT.packageId,
    configId: env("VITE_CONFIG_ID") ?? DEPLOYMENT.configId,
    clockId: env("VITE_CLOCK_ID") ?? "0x6",
    usdcType: env("VITE_USDC_TYPE") ?? DEPLOYMENT.usdcType,
    faucetId: env("VITE_FAUCET_ID") ?? LOCALNET_FAUCET_ID,
    providerAddress: env("VITE_PROVIDER_ADDRESS") ?? LOCALNET_PROVIDER,
    providerUrl: env("VITE_PROVIDER_URL") ?? "http://127.0.0.1:8080",
    market: {
      id: env("VITE_MARKET_ID") ?? LOCALNET_MARKET.id,
      name: env("VITE_MARKET_NAME") ?? LOCALNET_MARKET.name,
      creditType: env("VITE_MARKET_CREDIT_TYPE") ?? LOCALNET_MARKET.creditType,
      modelId: env("VITE_MARKET_MODEL_ID") ?? LOCALNET_MARKET.modelId,
      scuTokens: LOCALNET_MARKET.scuTokens,
      slaP99Ms: LOCALNET_MARKET.slaP99Ms,
      askId: env("VITE_MARKET_ASK_ID") ?? LOCALNET_MARKET.askId,
    },
    explorerTxBase,
    explorerObjectBase,
    walrusAggregator,
  };
}

/** Build an explorer URL for a tx digest, or undefined on localnet (no explorer). */
export function explorerTxUrl(cfg: ChainConfig, digest?: string): string | undefined {
  if (!digest || !cfg.explorerTxBase) return undefined;
  return `${cfg.explorerTxBase}/${digest}`;
}

/** Which OrderClient the store wires: "mock" (default, no chain) or "sui" (real). */
export function orderClientKind(): "mock" | "sui" {
  return (env("VITE_ORDER_CLIENT") as "mock" | "sui") ?? "mock";
}
