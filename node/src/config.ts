/**
 * Node configuration — sourced from env (§6 of docs/demo-milestone-contract.md)
 * plus the on-chain object ids in `deployment.json`.
 *
 * Everything that varies between localnet and testnet, or between machines, comes
 * from env so the same binary runs in either network. Nothing here is secret; the
 * keypairs live under node/.keys/ (gitignored) and are loaded by keys.ts.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Mirrors the parts of deployment.json this node needs. Tolerant of extra fields. */
export interface MarketDeployment {
  id: string;
  name: string;
  creditType: string;
  creditCoinType?: string;
  modelId?: string;
  scuTokens?: number;
  slaP99Ms?: number;
  /**
   * M2: the shared DeepBook `Pool<Credit<M>, USDC>` id this market trades on (bound
   * on-chain via market::set_deepbook_pool_id). `null`/absent until the orchestrator
   * creates the pool + binds it. When unset, the testnet maker path no-ops (clear log)
   * and the node keeps using the shared-Ask flow.
   */
  deepbookPoolId?: string | null;
}

export interface Deployment {
  network: string;
  packageId: string;
  configId: string;
  adminCapId?: string;
  allowlistId?: string;
  treasuryId?: string;
  faucetId?: string;
  usdcType: string;
  clockId: string;
  markets: MarketDeployment[];
  /** The MOCK-prefixed measurement allowlisted for the model (localnet mock path). */
  mockMeasurement?: string;
  accounts?: { admin?: string; providers?: string[]; consumers?: string[] };
}

/**
 * Which network the node runs against. Gates the M2 paths:
 *   - "localnet" (default) keeps the shared-Ask + /inputs-cache flow (the running qwen demo).
 *   - "testnet" enables DeepBook limit asks + Walrus I/O (both are testnet-only).
 * Falls back to deployment.json `network` when GIX_NETWORK is unset.
 */
export type GixNetwork = "localnet" | "testnet" | "devnet" | "mainnet";

export interface NodeConfig {
  /** Parsed deployment.json. */
  deployment: Deployment;
  /** Path the deployment was read from (for log lines). */
  deploymentPath: string;
  /** Network this node runs against (GIX_NETWORK | deployment.network). */
  network: GixNetwork;
  /** Sui JSON-RPC fullnode URL. */
  rpcUrl: string;
  /** Ollama HTTP base, default http://127.0.0.1:11434. */
  ollamaUrl: string;
  /** Model tag served, default llama3.1:8b. */
  model: string;
  /**
   * Generation token cap passed to Ollama as `num_predict` in /api/generate options.
   * Bounds qwen output so inference stays fast and comfortably inside the SLA.
   * Sourced from GIX_MAX_TOKENS; default 1000. (Empty/unset → default.)
   */
  maxTokens: number;
  /** GPU class advertised on registration, default GB10. */
  gpuClass: string;
  /** Public HTTP endpoint advertised on-chain (where consumers POST /inputs). */
  publicEndpoint: string;
  /** Port the node's HTTP server (§3.1) binds. */
  httpPort: number;
  /** HTTP bind host. */
  httpHost: string;
  /** Directory holding the persisted keypairs. */
  keysDir: string;
  /** The market this node serves (defaults to the first market in deployment). */
  marketId: string;
  /** The runtime_measurement bytes used in the §2 canonical message + attestation. */
  measurement: string;
  /** USDC bond (base units) to stake at registration. */
  bondUsdc: number;
  /** SCU capacity to stake for. */
  capacityScu: number;
  /** SCU credits to mint up front. */
  mintScu: number;
  /** Whether to perform on-chain register/stake/serve (false ⇒ HTTP+Ollama only). */
  chainEnabled: boolean;
  /** SCU quantity to publish as a resting shared Ask (two-account order book). */
  askQtyScu: number;
  /** Price (USDC base units) per SCU on the published Ask. */
  askPriceUsdc: number;
  /**
   * When the Ask's `remaining_scu` drops to/below this, the node re-posts (tops up) a
   * fresh Ask of `askQtyScu`. 0 disables auto top-up.
   */
  askTopupThresholdScu: number;
  /** How often (ms) to poll the resting Ask's remaining_scu for top-up. */
  askTopupPollMs: number;
  /** Where the node writes its discoverable state (Ask id + endpoint) for the consumer. */
  nodeStatePath: string;

  // ---- M2: DeepBook maker (testnet) ------------------------------------------
  /**
   * Use DeepBook limit asks instead of the gix shared-Ask. Auto-derived: true when
   * network=="testnet" AND the market has a non-null deepbookPoolId. Forceable via
   * GIX_DEEPBOOK=1/0 (e.g. 0 to keep the Ask flow on testnet during bring-up).
   */
  deepbookEnabled: boolean;
  /**
   * Pay DeepBook fees with input tokens (the Credit base) rather than DEEP when the
   * pool supports it (payWithDeep:false). Default true per m2-phase0-design.md.
   */
  deepbookInputTokenFees: boolean;
  /** Re-place / refresh the DeepBook ask when its remaining base drops to/below this (SCU). 0 disables. */
  deepbookRefreshThresholdScu: number;
  /** Poll interval (ms) for the DeepBook ask refresh loop. */
  deepbookPollMs: number;

  /**
   * Whether the deployed contract's `submit_signed_attestation` / `*_fill` entrypoints carry
   * the M2 Walrus `u256` blob-id args + the fill-job settlement path. The testnet deploy
   * (deployment.testnet.json) is the M2 contract; the running localnet deploy is the older
   * M1 contract WITHOUT those args. Auto-derived: true when network=="testnet". Override via
   * GIX_M2_ABI=1/0 (e.g. set 1 if you redeploy the M2 contract to localnet).
   */
  m2Abi: boolean;

  // ---- M2: Walrus I/O (testnet) ----------------------------------------------
  /**
   * Use Walrus for job I/O (upload output + quote, read input by blob id). Auto-derived:
   * true when network=="testnet". Forceable via GIX_WALRUS=1/0.
   */
  walrusEnabled: boolean;
  /**
   * Number of Walrus epochs to store output/quote blobs for — must cover the
   * settlement + dispute window. Walrus testnet epoch ~= 1 day; default 5.
   */
  walrusEpochs: number;
  /** Optional override for the Walrus WASM url (else the SDK default is used). */
  walrusWasmUrl?: string;
  /**
   * Walrus upload-relay host for output/quote blob writes. Direct-to-storage-node writes are
   * flaky on testnet (NotEnoughBlobConfirmationsError); the relay offloads the sliver writes.
   * Defaults to the testnet relay on testnet; undefined (direct writes) on localnet. Override
   * via GIX_WALRUS_RELAY (set to "off"/"none"/"0"/"" to disable even on testnet).
   */
  walrusRelayHost?: string;
}

/** The default Walrus upload relay for testnet output/quote blob writes. */
export const DEFAULT_WALRUS_RELAY = "https://upload-relay.testnet.walrus.space";

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var ${name}`);
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number, got "${v}"`);
  return n;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

/** Normalize an arbitrary network string to the supported set, defaulting to localnet. */
function normNetwork(s: string | undefined): GixNetwork {
  const v = (s ?? "").toLowerCase();
  if (v === "testnet" || v === "devnet" || v === "mainnet") return v;
  return "localnet";
}

/** Load and validate the node config from env + deployment.json. */
export function loadConfig(): NodeConfig {
  const repoRoot = resolve(process.cwd());
  // M2: GIX_NETWORK selects the rail. When testnet (and GIX_DEPLOYMENT is unset) we
  // default to deployment.testnet.json so the DeepBook/Walrus path reads testnet ids.
  const requestedNetwork = process.env.GIX_NETWORK;
  const defaultDeployment =
    normNetwork(requestedNetwork) === "testnet"
      ? resolve(repoRoot, "..", "deployment.testnet.json")
      : resolve(repoRoot, "..", "deployment.json");
  const deploymentPath = resolve(env("GIX_DEPLOYMENT", defaultDeployment));

  let deployment: Deployment;
  try {
    deployment = JSON.parse(readFileSync(deploymentPath, "utf8")) as Deployment;
  } catch (e) {
    throw new Error(
      `Could not read deployment.json at ${deploymentPath} ` +
        `(set GIX_DEPLOYMENT). Underlying: ${(e as Error).message}`,
    );
  }
  if (!deployment.packageId || deployment.markets?.length === 0) {
    throw new Error(`deployment.json at ${deploymentPath} is missing packageId/markets`);
  }

  // GIX_NETWORK wins; else the deployment file's declared network; else localnet.
  const network = normNetwork(requestedNetwork ?? deployment.network);

  const marketId = env("GIX_MARKET_ID", deployment.markets[0]!.id);
  const selectedMarket = deployment.markets.find((m) => m.id === marketId) ?? deployment.markets[0]!;
  const hasPool = typeof selectedMarket.deepbookPoolId === "string" && selectedMarket.deepbookPoolId.length > 0;
  // DeepBook is a testnet rail and needs a bound pool; force on/off via GIX_DEEPBOOK.
  const deepbookEnabled = envBool("GIX_DEEPBOOK", network === "testnet" && hasPool);
  // Walrus is a testnet rail; force on/off via GIX_WALRUS.
  const walrusEnabled = envBool("GIX_WALRUS", network === "testnet");
  // Default to 0.0.0.0 so a remote consumer (different machine) can reach /inputs + /result
  // for the two-account demo. Override to 127.0.0.1 to keep it loopback-only.
  const httpHost = env("GIX_HTTP_HOST", "0.0.0.0");
  const httpPort = envInt("GIX_HTTP_PORT", 8080);

  // Default the RPC to the matching public fullnode on testnet; loopback on localnet.
  const defaultRpc =
    network === "testnet"
      ? "https://fullnode.testnet.sui.io:443"
      : network === "devnet"
        ? "https://fullnode.devnet.sui.io:443"
        : network === "mainnet"
          ? "https://fullnode.mainnet.sui.io:443"
          : "http://127.0.0.1:9000";

  return {
    deployment,
    deploymentPath,
    network,
    rpcUrl: env("GIX_RPC_URL", defaultRpc),
    ollamaUrl: env("GIX_OLLAMA_URL", "http://127.0.0.1:11434"),
    model: env("GIX_MODEL", "llama3.1:8b"),
    maxTokens: envInt("GIX_MAX_TOKENS", 1000),
    gpuClass: env("GIX_GPU_CLASS", "GB10"),
    // The endpoint recorded ON-CHAIN and written to node-state.json. A remote consumer must
    // be able to resolve this, so the bind host 0.0.0.0 is NOT a usable default — fall back
    // to 127.0.0.1 and rely on GIX_PUBLIC_ENDPOINT (LAN IP / tunnel URL) for cross-machine.
    publicEndpoint: env(
      "GIX_PUBLIC_ENDPOINT",
      `http://${httpHost === "0.0.0.0" ? "127.0.0.1" : httpHost}:${httpPort}`,
    ),
    httpPort,
    httpHost,
    keysDir: resolve(env("GIX_KEYS_DIR", resolve(repoRoot, ".keys"))),
    marketId,
    measurement: env("GIX_MEASUREMENT", deployment.mockMeasurement ?? "MOCK-tdx-llama8b-v1"),
    bondUsdc: envInt("GIX_BOND_USDC", 1_000_000),
    capacityScu: envInt("GIX_CAPACITY_SCU", 1000),
    mintScu: envInt("GIX_MINT_SCU", 0),
    chainEnabled: envBool("GIX_CHAIN_ENABLED", true),
    askQtyScu: envInt("GIX_ASK_QTY_SCU", 100),
    askPriceUsdc: envInt("GIX_ASK_PRICE_USDC", 1000),
    askTopupThresholdScu: envInt("GIX_ASK_TOPUP_THRESHOLD_SCU", 10),
    askTopupPollMs: envInt("GIX_ASK_TOPUP_POLL_MS", 15_000),
    nodeStatePath: resolve(env("GIX_NODE_STATE", resolve(repoRoot, "node", "node-state.json"))),

    // M2 — DeepBook maker.
    deepbookEnabled,
    deepbookInputTokenFees: envBool("GIX_DEEPBOOK_INPUT_TOKEN_FEES", true),
    deepbookRefreshThresholdScu: envInt("GIX_DEEPBOOK_REFRESH_THRESHOLD_SCU", 10),
    deepbookPollMs: envInt("GIX_DEEPBOOK_POLL_MS", 15_000),

    // M2 — contract ABI gate (testnet deploy has the M2 entrypoints; localnet M1 does not).
    m2Abi: envBool("GIX_M2_ABI", network === "testnet"),

    // M2 — Walrus I/O.
    walrusEnabled,
    walrusEpochs: envInt("GIX_WALRUS_EPOCHS", 5),
    walrusWasmUrl: process.env.GIX_WALRUS_WASM_URL || undefined,
    // Upload-relay reliability fix: default the testnet relay on testnet, off on localnet.
    // GIX_WALRUS_RELAY overrides; "off"/"none"/"0"/"" disables (direct-to-node writes).
    walrusRelayHost: resolveWalrusRelay(network),
  };
}

/**
 * Resolve the Walrus upload-relay host. On testnet defaults to {@link DEFAULT_WALRUS_RELAY};
 * elsewhere off by default. GIX_WALRUS_RELAY overrides the host, or disables it when set to
 * one of off/none/0 or empty.
 */
function resolveWalrusRelay(network: GixNetwork): string | undefined {
  const v = process.env.GIX_WALRUS_RELAY;
  if (v !== undefined) {
    const t = v.trim();
    if (t === "" || /^(off|none|0|false)$/i.test(t)) return undefined;
    return t;
  }
  return network === "testnet" ? DEFAULT_WALRUS_RELAY : undefined;
}

/** The bound DeepBook pool id for a market, or undefined when unset. */
export function deepbookPoolIdOf(m: MarketDeployment): string | undefined {
  return typeof m.deepbookPoolId === "string" && m.deepbookPoolId.length > 0
    ? m.deepbookPoolId
    : undefined;
}

export function marketOf(cfg: NodeConfig): MarketDeployment {
  const m = cfg.deployment.markets.find((x) => x.id === cfg.marketId);
  if (!m) throw new Error(`market ${cfg.marketId} not found in deployment.json`);
  return m;
}
