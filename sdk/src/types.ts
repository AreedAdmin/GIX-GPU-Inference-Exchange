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
  /** Fully-qualified inner `credit::Credit<M>` coin type (wrapped as `Coin<...>`
   * on-chain). From deployment.json; used to locate the provider's credit coin. */
  creditCoinType?: string;
  /** Per-market `registry::ModelRecord` id. */
  modelId?: string;
  /** Tokens per 1 SCU (token-metered). */
  scuTokens?: number;
  /** SLA p99 latency budget (ms). */
  slaP99Ms?: number;
  /** M2: the shared DeepBook `Pool<Credit<M>, MOCK_USDC>` id this market trades
   * on (governance-bound on-chain via `market::set_deepbook_pool_id`). `null`
   * until bound. The consumer reads this to discover the canonical pool. */
  deepbookPoolId?: string | null;
}

/** Named on-chain accounts (from deployment.json). */
export interface DeploymentAccounts {
  admin: string;
  providers: string[];
  consumers: string[];
  /** M2: shared `registry::ProviderRecord` object ids, one per provider. The
   * testnet fill-path passes `providerRecords[0]` to `create_job_from_fill`
   * (single-provider demo; multi-provider dispatch deferred). */
  providerRecords?: string[];
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
  /**
   * M2 testnet DeepBook buy-path config. When `deployment.network === "testnet"`,
   * `runTask` buys via a DeepBook swap (`swap_exact_quote_for_base`) composed
   * with `create_job_from_fill` in one PTB, and uses Walrus for input/output
   * blobs instead of the provider node `/inputs` + `/result`.
   */
  fill?: FillConfig;
  /**
   * A real `@mysten/sui` `Signer` (a keypair) used to write blobs to Walrus
   * (Walrus's writeBlob needs an actual Signer, not the WalletSigner seam).
   * Required only for the testnet Walrus upload. Typed loosely to avoid a hard
   * dependency on the SDK's Signer type in this hermetic module.
   */
  walrusSigner?: WalrusUploadSigner;
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

/**
 * A real `@mysten/sui` Signer for the Walrus upload leg. A Sui `Keypair`
 * already satisfies this (Walrus's `writeBlob` accepts a `Signer`). Kept as an
 * opaque type so the SDK does not eagerly import the SDK crypto.
 */
export type WalrusUploadSigner = import("@mysten/sui/cryptography").Signer;

/** M2 testnet DeepBook buy-path configuration. */
export interface FillConfig {
  /**
   * The single market provider's shared `ProviderRecord` object id (M2 demo:
   * one provider serves the market, so assignment is unambiguous). Defaults to
   * resolution from discovery/deployment if omitted.
   */
  providerRecordId?: string;
  /**
   * The shared DeepBook `Pool<Credit<M>, MOCK_USDC>` object id. Defaults to
   * `deployment.markets[].deepbookPoolId`.
   */
  poolId?: string;
  /** DEEP (base units) to spend on the swap fee. 0 ⇒ input-token fee. Default 0. */
  deepIn?: bigint;
  /** Minimum Credit<M> base out (slippage floor; SCU base units). Default = scuQty. */
  minBaseOut?: bigint;
  /** Walrus storage epochs for the input/output blobs. Default 3. */
  walrusEpochs?: number;
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
  /** M2 testnet: the Walrus input (prompt) blob id, if the Walrus path was used. */
  inputBlobId?: string;
  /** M2 testnet: the Walrus output (completion) blob id, if the output came from Walrus. */
  outputBlobId?: string;
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
