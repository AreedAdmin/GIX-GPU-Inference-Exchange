/**
 * Config loader.
 *
 * Precedence (low -> high): bundled `deployment.json` defaults  <  an optional
 * `config.json` (--config <path>)  <  process.env  <  explicit CLI flags.
 *
 * The same binary therefore runs against localnet, a LAN node, or testnet just
 * by overriding a few values; out of the box it reads the bundled
 * `deployment.json` that the chain deploy emits. The two integration seams that
 * a static deployment.json cannot provide — the provider's shared `ASK_ID` and
 * its public `PROVIDER_URL` — must come from the running provider node, so they
 * are surfaced as first-class required fields.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** examples/no-gpu-client/ */
const PKG_ROOT = resolve(__dirname, "..");
/** repo-root deployment.json bundled as the default network params. */
const DEFAULT_DEPLOYMENT_PATH = resolve(PKG_ROOT, "..", "..", "deployment.json");

export interface GixConfig {
  /** Sui JSON-RPC fullnode URL. */
  rpcUrl: string;
  /** SUI gas faucet base URL (localnet :9123 / devnet / testnet). Empty = none. */
  suiFaucetUrl: string;
  network: "localnet" | "devnet" | "testnet" | "mainnet";

  packageId: string;
  configId: string;
  marketId: string;
  /** Credit<M> witness type — the `--type-args` for create_job_from_ask / _from_fill. */
  creditType: string;
  /** Inner Credit<M> coin type (the DeepBook base coin) — from deployment.json. */
  creditCoinType: string;
  usdcType: string;
  /** mock_usdc::Faucet shared object id (mints MOCK_USDC on dev networks). */
  faucetId: string;
  clockId: string;

  /** The provider's shared Ask<M> object id — from the running node (AskPosted). */
  askId: string;
  /** The provider's public base URL serving /inputs + /result. */
  providerUrl: string;

  // ── M2 testnet DeepBook fill-path (used when network === "testnet") ──────────
  /** Which on-chain buy path to use. "ask" = localnet shared-Ask (M1.5);
   *  "fill" = M2 DeepBook swap → create_job_from_fill. Defaults: testnet ⇒ fill,
   *  otherwise ⇒ ask. Override via BUY_PATH. */
  buyPath: "ask" | "fill";
  /** The market's bound DeepBook `Pool<Credit<M>, USDC>` id
   *  (deployment.markets[0].deepbookPoolId). Required for the fill path. */
  deepbookPoolId: string;
  /** The single market provider's shared `ProviderRecord` id (fill path —
   *  `create_job_from_fill` binds the Job to its operator). */
  providerRecordId: string;
  /** DEEP base units to spend on the swap fee (0 ⇒ input-token fee). Default 0. */
  deepIn: bigint;

  /** SCU quantity to buy. Default 1. */
  scuQty: number;
  /** Explorer tx base, e.g. https://suiscan.xyz/testnet/tx */
  explorerTxBase: string;
}

export interface RawDeployment {
  network?: string;
  packageId?: string;
  configId?: string;
  usdcType?: string;
  faucetId?: string;
  clockId?: string;
  markets?: Array<{
    id?: string;
    creditType?: string;
    creditCoinType?: string;
    deepbookPoolId?: string | null;
  }>;
}

const DEFAULT_RPC: Record<string, string> = {
  localnet: "http://127.0.0.1:9000",
  devnet: "https://fullnode.devnet.sui.io:443",
  testnet: "https://fullnode.testnet.sui.io:443",
  mainnet: "https://fullnode.mainnet.sui.io:443",
};
const DEFAULT_SUI_FAUCET: Record<string, string> = {
  localnet: "http://127.0.0.1:9123/gas",
  devnet: "https://faucet.devnet.sui.io/v2/gas",
  testnet: "https://faucet.testnet.sui.io/v2/gas",
  mainnet: "",
};
const DEFAULT_EXPLORER: Record<string, string> = {
  localnet: "",
  devnet: "https://suiscan.xyz/devnet/tx",
  testnet: "https://suiscan.xyz/testnet/tx",
  mainnet: "https://suiscan.xyz/mainnet/tx",
};

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Pull network params out of a deployment.json shape (first market). */
function fromDeployment(d: RawDeployment | undefined): Partial<GixConfig> {
  if (!d) return {};
  const m = d.markets?.[0];
  const out: Partial<GixConfig> = {};
  if (d.network) out.network = d.network as GixConfig["network"];
  if (d.packageId) out.packageId = d.packageId;
  if (d.configId) out.configId = d.configId;
  if (d.usdcType) out.usdcType = d.usdcType;
  if (d.faucetId) out.faucetId = d.faucetId;
  if (d.clockId) out.clockId = d.clockId;
  if (m?.id) out.marketId = m.id;
  if (m?.creditType) out.creditType = m.creditType;
  if (m?.creditCoinType) out.creditCoinType = m.creditCoinType;
  if (m?.deepbookPoolId) out.deepbookPoolId = m.deepbookPoolId; // null ⇒ unset
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return undefined;
}

export interface LoadOptions {
  /** --config <path> to a config.json (overrides deployment defaults). */
  configPath?: string;
  /** Explicit CLI overrides (highest precedence). */
  overrides?: Partial<GixConfig>;
  /** Override the bundled deployment.json path (tests). */
  deploymentPath?: string;
  /** Injected env (tests); defaults to process.env. */
  env?: Record<string, string | undefined>;
  /**
   * Throw if any required field (incl. the ASK_ID/PROVIDER_URL node seams) is
   * unset. Default true. The CLI loads with `requireAll:false` so the wallet /
   * `--fund` helper works before the node's ask is known, then re-checks via
   * `missingRequired` right before the buy.
   */
  requireAll?: boolean;
}

/**
 * Resolve the effective config. Throws (with the list of missing keys) if a
 * required field cannot be sourced from any layer.
 */
export function loadConfig(opts: LoadOptions = {}): GixConfig {
  const env = opts.env ?? process.env;

  // Layer 1: bundled deployment.json (network params).
  const deployment = readJson(opts.deploymentPath ?? DEFAULT_DEPLOYMENT_PATH) as
    | RawDeployment
    | undefined;
  const fromDep = fromDeployment(deployment);

  // Layer 2: optional config.json.
  const fileCfg = opts.configPath ? readJson(absPath(opts.configPath)) ?? {} : {};

  // Layer 3: env. Layer 4: explicit CLI overrides.
  const ov = opts.overrides ?? {};

  const network = (str(ov.network) ??
    str(env.GIX_NETWORK) ??
    str(fileCfg.NETWORK) ??
    fromDep.network ??
    "localnet") as GixConfig["network"];

  const pick = (
    overrideVal: string | undefined,
    envKey: string,
    fileKey: string,
    depVal: string | undefined,
    dflt?: string,
  ): string | undefined =>
    overrideVal ?? str(env[envKey]) ?? str(fileCfg[fileKey]) ?? depVal ?? dflt;

  // The buy path defaults to the M2 DeepBook fill on testnet, the M1.5 shared-Ask
  // otherwise. Explicitly overridable via BUY_PATH / --path.
  const buyPath = ((str(ov.buyPath) ??
    str(env.BUY_PATH) ??
    str(fileCfg.BUY_PATH) ??
    (network === "testnet" ? "fill" : "ask")) === "fill"
    ? "fill"
    : "ask") as GixConfig["buyPath"];

  const deepInStr = pick(
    ov.deepIn !== undefined ? String(ov.deepIn) : undefined,
    "DEEP_IN",
    "DEEP_IN",
    undefined,
    "0",
  );

  const cfg: GixConfig = {
    network,
    rpcUrl:
      pick(ov.rpcUrl, "RPC_URL", "RPC_URL", undefined, DEFAULT_RPC[network]) ?? "",
    suiFaucetUrl:
      pick(ov.suiFaucetUrl, "SUI_FAUCET_URL", "SUI_FAUCET_URL", undefined, DEFAULT_SUI_FAUCET[network]) ??
      "",
    packageId: pick(ov.packageId, "PACKAGE_ID", "PACKAGE_ID", fromDep.packageId) ?? "",
    configId: pick(ov.configId, "CONFIG_ID", "CONFIG_ID", fromDep.configId) ?? "",
    marketId: pick(ov.marketId, "MARKET_ID", "MARKET_ID", fromDep.marketId) ?? "",
    creditType: pick(ov.creditType, "CREDIT_TYPE", "CREDIT_TYPE", fromDep.creditType) ?? "",
    creditCoinType:
      pick(ov.creditCoinType, "CREDIT_COIN_TYPE", "CREDIT_COIN_TYPE", fromDep.creditCoinType) ?? "",
    usdcType: pick(ov.usdcType, "USDC_TYPE", "USDC_TYPE", fromDep.usdcType) ?? "",
    faucetId: pick(ov.faucetId, "FAUCET_ID", "FAUCET_ID", fromDep.faucetId) ?? "",
    clockId: pick(ov.clockId, "CLOCK_ID", "CLOCK_ID", fromDep.clockId, "0x6") ?? "0x6",
    askId: pick(ov.askId, "ASK_ID", "ASK_ID", undefined) ?? "",
    providerUrl: pick(ov.providerUrl, "PROVIDER_URL", "PROVIDER_URL", undefined) ?? "",
    buyPath,
    deepbookPoolId:
      pick(ov.deepbookPoolId, "DEEPBOOK_POOL_ID", "DEEPBOOK_POOL_ID", fromDep.deepbookPoolId) ?? "",
    providerRecordId:
      pick(ov.providerRecordId, "PROVIDER_RECORD_ID", "PROVIDER_RECORD_ID", undefined) ?? "",
    deepIn: (() => {
      try {
        return BigInt(deepInStr ?? "0");
      } catch {
        return 0n;
      }
    })(),
    explorerTxBase:
      pick(ov.explorerTxBase, "EXPLORER_TX_BASE", "EXPLORER_TX_BASE", undefined, DEFAULT_EXPLORER[network]) ??
      "",
    scuQty:
      ov.scuQty ?? num(env.SCU_QTY) ?? num(fileCfg.SCU_QTY) ?? 1,
  };

  if (cfg.scuQty <= 0) throw new Error(`SCU_QTY must be > 0 (got ${cfg.scuQty})`);
  if (opts.requireAll !== false) validate(cfg);
  return cfg;
}

/** Fields every buy path needs (default from deployment.json or the node). */
const REQUIRED_BASE: Array<keyof GixConfig> = [
  "rpcUrl",
  "packageId",
  "configId",
  "marketId",
  "creditType",
  "usdcType",
  "providerUrl",
];
/** The M1.5 shared-Ask path also needs the resting Ask id. */
const REQUIRED_ASK: Array<keyof GixConfig> = ["askId"];
/** The M2 DeepBook fill path needs the bound pool, the credit coin type, and the
 *  single market provider's ProviderRecord (instead of an Ask id). */
const REQUIRED_FILL: Array<keyof GixConfig> = [
  "deepbookPoolId",
  "creditCoinType",
  "providerRecordId",
];

/** The required-field set for the configured buy path. */
function requiredFor(cfg: GixConfig): Array<keyof GixConfig> {
  return [
    ...REQUIRED_BASE,
    ...(cfg.buyPath === "fill" ? REQUIRED_FILL : REQUIRED_ASK),
  ];
}

export function missingRequired(cfg: GixConfig): Array<keyof GixConfig> {
  return requiredFor(cfg).filter((k) => !cfg[k] || String(cfg[k]).length === 0);
}

function validate(cfg: GixConfig): void {
  const missing = missingRequired(cfg);
  if (missing.length > 0) {
    const hint = missing
      .map((k) => `  - ${ENV_OF[k] ?? String(k)}${SEAM[k] ? `   (${SEAM[k]})` : ""}`)
      .join("\n");
    const seamHint =
      cfg.buyPath === "fill"
        ? `DEEPBOOK_POOL_ID + PROVIDER_RECORD_ID come from the testnet deploy / running ` +
          `provider node; the rest default from the bundled deployment.json.`
        : `ASK_ID + PROVIDER_URL come from the running provider node; the rest default ` +
          `from the bundled deployment.json.`;
    throw new Error(
      `Missing required config (${cfg.buyPath} path):\n${hint}\n\n` +
        `Set them in config.json, as env vars, or pass CLI flags.\n${seamHint}`,
    );
  }
}

const ENV_OF: Partial<Record<keyof GixConfig, string>> = {
  rpcUrl: "RPC_URL",
  packageId: "PACKAGE_ID",
  configId: "CONFIG_ID",
  marketId: "MARKET_ID",
  creditType: "CREDIT_TYPE",
  creditCoinType: "CREDIT_COIN_TYPE",
  usdcType: "USDC_TYPE",
  askId: "ASK_ID",
  providerUrl: "PROVIDER_URL",
  deepbookPoolId: "DEEPBOOK_POOL_ID",
  providerRecordId: "PROVIDER_RECORD_ID",
};
const SEAM: Partial<Record<keyof GixConfig, string>> = {
  askId: "from the running provider node — AskPosted event",
  providerUrl: "the provider node's public /inputs + /result base URL",
  deepbookPoolId: "market.deepbookPoolId — set on the testnet deploy",
  providerRecordId: "the single market provider's shared ProviderRecord id",
};

function absPath(p: string): string {
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}
