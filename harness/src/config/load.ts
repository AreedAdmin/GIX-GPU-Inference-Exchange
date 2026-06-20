/**
 * Config layer: load + validate `deployment.json` and a scenario JSON, with a
 * built-in `baseline` fallback so the harness runs before `examples/` exists.
 *
 * Validation is intentionally explicit (not a schema lib) so the error messages
 * name the exact missing field — this is what an operator wiring up localnet
 * sees first.
 */

import { readFileSync } from "node:fs";
import type {
  Deployment,
  Distribution,
  Scenario,
} from "./types.js";
import { BASELINE_SCENARIO } from "../scenarios/baseline.js";
import { isExternalScenario, normalizeExternalScenario } from "./adapter.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function readJson(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(`could not read file: ${path}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(`invalid JSON in ${path}: ${(e as Error).message}`);
  }
}

function req<T>(obj: Record<string, unknown>, key: string, ctx: string): T {
  if (obj[key] === undefined || obj[key] === null) {
    throw new ConfigError(`${ctx}: missing required field "${key}"`);
  }
  return obj[key] as T;
}

// ---------------------------------------------------------------------------
// deployment.json
// ---------------------------------------------------------------------------

export function validateDeployment(input: unknown): Deployment {
  if (typeof input !== "object" || input === null) {
    throw new ConfigError("deployment: expected a JSON object");
  }
  const o = input as Record<string, unknown>;
  // `markets` may be [] in C's fallback deploy mode (A's create_market not yet
  // exposed); the harness tolerates it and reports "nothing to trade" at runtime
  // rather than failing to load. See ops/scripts/deploy.sh `fallback_publish`.
  const markets = req<unknown[]>(o, "markets", "deployment");
  if (!Array.isArray(markets)) {
    throw new ConfigError("deployment.markets: expected an array");
  }
  // `accounts` is optional in fallback deployments — default to empty lists.
  const accounts = (o.accounts as Record<string, unknown> | undefined) ?? {};

  const dep: Deployment = {
    network: req(o, "network", "deployment"),
    packageId: req(o, "packageId", "deployment"),
    configId: req(o, "configId", "deployment"),
    adminCapId: req(o, "adminCapId", "deployment"),
    usdcType: req(o, "usdcType", "deployment"),
    clockId: (o.clockId as string) ?? "0x6",
    // Shared-object ids + mock measurement the verified `gix` ABI now needs on an
    // on-chain run. Optional (absent in C's fallback deploy / dry-run synthetic),
    // carried through verbatim so the SuiChain can build PTBs.
    treasuryId: (o.treasuryId as string | undefined) ?? undefined,
    allowlistId: (o.allowlistId as string | undefined) ?? undefined,
    faucetId: (o.faucetId as string | undefined) ?? undefined,
    mockMeasurement: (o.mockMeasurement as string | undefined) ?? undefined,
    markets: markets.map((m, i) => {
      const mm = m as Record<string, unknown>;
      const ctx = `deployment.markets[${i}]`;
      return {
        id: req(mm, "id", ctx),
        name: req(mm, "name", ctx),
        creditType: req(mm, "creditType", ctx),
        scuTokens: Number(req(mm, "scuTokens", ctx)),
        slaP99Ms: Number(req(mm, "slaP99Ms", ctx)),
        modelId: (mm.modelId as string | undefined) ?? undefined,
      };
    }),
    accounts: {
      admin: (accounts.admin as string) ?? "",
      providers: (accounts.providers as string[] | undefined) ?? [],
      consumers: (accounts.consumers as string[] | undefined) ?? [],
    },
  };
  return dep;
}

export function loadDeployment(path: string): Deployment {
  return validateDeployment(readJson(path));
}

// ---------------------------------------------------------------------------
// scenario.json
// ---------------------------------------------------------------------------

function validateDistribution(input: unknown, ctx: string): Distribution {
  if (typeof input !== "object" || input === null) {
    throw new ConfigError(`${ctx}: expected a distribution object`);
  }
  const d = input as Record<string, unknown>;
  switch (d.kind) {
    case "fixed":
      return { kind: "fixed", value: Number(req(d, "value", ctx)) };
    case "uniform":
      return {
        kind: "uniform",
        min: Number(req(d, "min", ctx)),
        max: Number(req(d, "max", ctx)),
      };
    case "normal":
      return {
        kind: "normal",
        mean: Number(req(d, "mean", ctx)),
        stddev: Number(req(d, "stddev", ctx)),
        min: d.min !== undefined ? Number(d.min) : undefined,
        max: d.max !== undefined ? Number(d.max) : undefined,
      };
    default:
      throw new ConfigError(
        `${ctx}: unknown distribution kind "${String(d.kind)}" (expected fixed|uniform|normal)`,
      );
  }
}

function validateRate(v: unknown, ctx: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new ConfigError(`${ctx}: expected a probability in [0,1], got ${String(v)}`);
  }
  return n;
}

export function validateScenario(input: unknown): Scenario {
  if (typeof input !== "object" || input === null) {
    throw new ConfigError("scenario: expected a JSON object");
  }
  let o = input as Record<string, unknown>;

  // Accept workstream C's canonical external schema (examples/scenarios/*.json)
  // by normalizing it into the internal shape before validation.
  if (isExternalScenario(o)) {
    o = normalizeExternalScenario(o) as unknown as Record<string, unknown>;
  }

  const providers = req<Record<string, unknown>>(o, "providers", "scenario");
  const consumers = req<Record<string, unknown>>(o, "consumers", "scenario");
  const faults = req<Record<string, unknown>>(o, "faults", "scenario");

  const skip = validateRate(faults.skipAttest ?? 0, "scenario.faults.skipAttest");
  const late = validateRate(faults.lateAttest ?? 0, "scenario.faults.lateAttest");
  const wrong = validateRate(faults.wrongOutput ?? 0, "scenario.faults.wrongOutput");
  if (skip + late + wrong > 1) {
    throw new ConfigError(
      `scenario.faults: rates sum to ${(skip + late + wrong).toFixed(2)} > 1 (must be ≤ 1)`,
    );
  }

  const scenario: Scenario = {
    name: req(o, "name", "scenario"),
    description: o.description as string | undefined,
    orderRatePerSec: Number(req(o, "orderRatePerSec", "scenario")),
    orderCount: Number(req(o, "orderCount", "scenario")),
    providers: {
      count: Number(req(providers, "count", "scenario.providers")),
      bondUsdc: Number(req(providers, "bondUsdc", "scenario.providers")),
      capacityScu: Number(req(providers, "capacityScu", "scenario.providers")),
      mintCreditsScu: Number(req(providers, "mintCreditsScu", "scenario.providers")),
    },
    consumers: {
      count: Number(req(consumers, "count", "scenario.consumers")),
      budgetUsdc: Number(req(consumers, "budgetUsdc", "scenario.consumers")),
    },
    qtyScu: validateDistribution(req(o, "qtyScu", "scenario"), "scenario.qtyScu"),
    priceUsdcPerScu: validateDistribution(
      req(o, "priceUsdcPerScu", "scenario"),
      "scenario.priceUsdcPerScu",
    ),
    execLatencyMs: validateDistribution(
      req(o, "execLatencyMs", "scenario"),
      "scenario.execLatencyMs",
    ),
    faults: { skipAttest: skip, lateAttest: late, wrongOutput: wrong },
    seed: o.seed !== undefined ? Number(o.seed) : undefined,
  };

  if (scenario.providers.count < 1) {
    throw new ConfigError("scenario.providers.count: must be ≥ 1");
  }
  if (scenario.consumers.count < 1) {
    throw new ConfigError("scenario.consumers.count: must be ≥ 1");
  }
  return scenario;
}

/**
 * Load a scenario from `path`. If `path` is undefined, returns the built-in
 * `baseline`. Throws ConfigError if a path is given but the file is unusable.
 */
export function loadScenario(path?: string): Scenario {
  if (!path) return BASELINE_SCENARIO;
  return validateScenario(readJson(path));
}
