/**
 * Public types for the GIX consumer SDK.
 *
 * The `Deployment` / `MarketDeployment` shapes MIRROR a minimal subset of
 * `harness/src/config/types.ts` (the deployment.json A's deploy script emits).
 * Kept local so the SDK is a standalone package; integration will reconcile the
 * two against the single deployment.json schema.
 */

/** One market entry from deployment.json `markets[]`. */
export interface MarketDeployment {
  /** Shared `Market<M>` object id. */
  id: string;
  /** Human label, e.g. "H100-llama3.1-8b-int8" — surfaced as the OpenAI model id. */
  name: string;
  /** Fully-qualified `Credit<M>` witness type, the `--type-args` for every PTB. */
  creditType: string;
  /** Per-market `registry::ModelRecord` id. */
  modelId?: string;
  /** Tokens per 1 SCU (token-metered). */
  scuTokens?: number;
  /** SLA p99 latency budget (ms). */
  slaP99Ms?: number;
}

/** Named on-chain accounts (from deployment.json). */
export interface DeploymentAccounts {
  admin: string;
  providers: string[];
  consumers: string[];
}

/** The deployment.json document (minimal subset the SDK reads). */
export interface Deployment {
  network: string;
  packageId: string;
  configId: string;
  adminCapId?: string;
  /** Fully-qualified MOCK_USDC coin type. */
  usdcType: string;
  /** Clock object id, conventionally "0x6". */
  clockId: string;
  treasuryId?: string;
  allowlistId?: string;
  faucetId?: string;
  mockMeasurement?: string;
  markets: MarketDeployment[];
  accounts?: DeploymentAccounts;
}

/**
 * A wallet-signer seam so the UI can inject a `@mysten/dapp-kit` connected
 * wallet instead of a raw keypair. A Sui `Keypair` already satisfies this
 * (it exposes `toSuiAddress` + `signTransaction`), so a keypair can be passed
 * directly. The UI adapter wraps the wallet's `signTransactionBlock`.
 */
export interface WalletSigner {
  /** The signer's Sui address (0x…). */
  toSuiAddress(): string;
  /**
   * Sign a serialized transaction. Mirrors `@mysten/sui` Keypair.signTransaction
   * and dapp-kit's signing result: returns `{ bytes, signature }` (base64).
   */
  signTransaction(
    bytes: Uint8Array,
  ): Promise<{ bytes: string; signature: string }>;
}

/** Options for constructing a {@link GixClient}. */
export interface GixClientOptions {
  /** Loaded deployment.json. */
  deployment: Deployment;
  /** Raw keypair (server/CLI) or an injected wallet (UI). */
  signer: WalletSigner;
  /** Provider node base URL serving `/inputs` + `/result/:jobId`, e.g. http://localhost:8080 */
  providerUrl: string;
  /** RPC url. Defaults to the network's public fullnode for `deployment.network`. */
  rpcUrl?: string;
  /**
   * The provider operator address that fills the (stubbed) match. Defaults to
   * `deployment.accounts.providers[0]`. The SDK reserves that provider's stake
   * + credits when it creates the job.
   */
  provider?: string;
  /** Optional logger; defaults to a no-op. */
  logger?: (msg: string, meta?: Record<string, unknown>) => void;
  /** Override the wall-clock event/settlement poll timeout (ms). Default 120_000. */
  settleTimeoutMs?: number;
  /**
   * Injected fetch (for tests / non-global-fetch runtimes). Defaults to the
   * global `fetch` (Node 18+).
   */
  fetchImpl?: typeof fetch;
}

/** Args for {@link GixClient.runTask}. */
export interface RunTaskArgs {
  /** Market id OR market name (resolved against the deployment). */
  market: string;
  /** The prompt (UTF-8). Submitted to the provider `/inputs`; hashed for the job. */
  prompt: string;
  /**
   * Max price the consumer will pay, in MOCK_USDC base units (6dp) per SCU.
   * The escrow funded = `maxPriceUsdcPerScu * scuQty` (the stubbed-match price).
   */
  maxPriceUsdcPerScu: number;
  /** SCU quantity for the job. Default 1. */
  scuQty?: number;
}

/** Result of {@link GixClient.runTask}. */
export interface RunTaskResult {
  /** The model completion text returned by the provider. */
  output: string;
  /** The settled Job object id (0x…). */
  jobId: string;
  /** The create_job transaction digest. */
  digest: string;
  /**
   * True iff `sha2_256(output_utf8)` equals the on-chain `output_hash` recorded
   * in the job's attestation (the verifiable-result check, §2/§3.1).
   */
  verified: boolean;
  /** Provider payout in MOCK_USDC base units (from the Settled event), if observed. */
  payoutUsdc?: number;
  /** The provider's Ed25519 attestation pubkey (hex), as returned by /result. */
  providerPubkey?: string;
}

/** A market as surfaced by {@link GixClient.markets}. */
export interface MarketInfo {
  id: string;
  name: string;
  creditType: string;
  scuTokens?: number;
  slaP99Ms?: number;
}

/** A balance line as surfaced by {@link GixClient.balances}. */
export interface Balances {
  address: string;
  /** Total MOCK_USDC the signer holds (base units, 6dp). */
  usdc: bigint;
  /** Total SUI gas the signer holds (MIST). */
  sui: bigint;
}

/** The provider node `/result/:jobId` response shape (node §3.1). */
export interface ProviderResult {
  jobId: string;
  model: string;
  output: string;
  outputHash: string;
  outputTokenCount: number;
  tStart: number;
  tEnd: number;
  measurement: string;
  signature: string;
  attestPubkey: string;
}
