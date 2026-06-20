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

export interface NodeConfig {
  /** Parsed deployment.json. */
  deployment: Deployment;
  /** Path the deployment was read from (for log lines). */
  deploymentPath: string;
  /** Sui JSON-RPC fullnode URL. */
  rpcUrl: string;
  /** Ollama HTTP base, default http://127.0.0.1:11434. */
  ollamaUrl: string;
  /** Model tag served, default llama3.1:8b. */
  model: string;
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
}

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

/** Load and validate the node config from env + deployment.json. */
export function loadConfig(): NodeConfig {
  const repoRoot = resolve(process.cwd());
  const deploymentPath = resolve(
    env("GIX_DEPLOYMENT", resolve(repoRoot, "..", "deployment.json")),
  );

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

  const marketId = env("GIX_MARKET_ID", deployment.markets[0]!.id);
  // Default to 0.0.0.0 so a remote consumer (different machine) can reach /inputs + /result
  // for the two-account demo. Override to 127.0.0.1 to keep it loopback-only.
  const httpHost = env("GIX_HTTP_HOST", "0.0.0.0");
  const httpPort = envInt("GIX_HTTP_PORT", 8080);

  return {
    deployment,
    deploymentPath,
    rpcUrl: env("GIX_RPC_URL", "http://127.0.0.1:9000"),
    ollamaUrl: env("GIX_OLLAMA_URL", "http://127.0.0.1:11434"),
    model: env("GIX_MODEL", "llama3.1:8b"),
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
  };
}

export function marketOf(cfg: NodeConfig): MarketDeployment {
  const m = cfg.deployment.markets.find((x) => x.id === cfg.marketId);
  if (!m) throw new Error(`market ${cfg.marketId} not found in deployment.json`);
  return m;
}
