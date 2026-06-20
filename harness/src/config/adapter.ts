/**
 * Scenario schema adapter.
 *
 * Workstream C (ops/examples) ships the CANONICAL external scenario schema in
 * `examples/scenarios/scenario.schema.json`, which differs from the harness's
 * internal `Scenario` shape:
 *
 *   external (C)                     internal (B)
 *   ----------------------------     -----------------------------------------
 *   orderRatePerMin: number          orderRatePerSec  = perMin / 60
 *   durationSec: number              orderCount       = round(perMin/60 * durationSec)
 *   providers: int                   providers.{count,bondUsdc,capacityScu,mintCreditsScu}
 *   consumers: int                   consumers.{count,budgetUsdc}
 *   qty.{distribution,…}             qtyScu (kind/min/max/…)
 *   price.{distribution,… USDC}      priceUsdcPerScu (base units = USDC * 1e6)
 *   faults.{skip,late,wrong,abandon} faults.{skip,late,wrong}   (abandon → D2, M2)
 *
 * This adapter detects the external shape and normalizes it so
 * `examples/scenarios/*.json` loads directly via `npm run stream --scenario`.
 * The harness's own native shape (used by its bundled scenarios + tests) passes
 * through untouched.
 */

import type { Distribution, Scenario } from "./types.js";

const USDC_DECIMALS = 1_000_000; // MOCK_USDC is 6dp

/** Is this an external (C) scenario doc rather than the internal shape? */
export function isExternalScenario(o: Record<string, unknown>): boolean {
  // External docs carry orderRatePerMin/durationSec and integer providers; the
  // internal shape uses orderRatePerSec/orderCount and a providers OBJECT.
  return (
    o.orderRatePerMin !== undefined ||
    o.durationSec !== undefined ||
    typeof o.providers === "number" ||
    (typeof o.qty === "object" && o.qty !== null) ||
    (typeof o.price === "object" && o.price !== null)
  );
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Map an external `{distribution,…}` block to an internal Distribution. */
function mapDistribution(
  block: Record<string, unknown> | undefined,
  scale: number,
  fallback: Distribution,
): Distribution {
  if (!block) return fallback;
  const dist = String(block.distribution ?? "");
  const sc = (v: unknown, d: number) => num(v, d) * scale;
  switch (dist) {
    case "fixed":
      return { kind: "fixed", value: sc(block.value, 1) };
    case "uniform":
    case "uniform-int":
      return { kind: "uniform", min: sc(block.min, 1), max: sc(block.max, 1) };
    case "normal":
    case "lognormal": // approximate lognormal as a clamped normal for M1
      return {
        kind: "normal",
        mean: sc(block.mean ?? block.median, 1),
        stddev: sc(block.stddev ?? block.sigma, 1),
        min: block.min !== undefined ? sc(block.min, 1) : undefined,
        max: block.max !== undefined ? sc(block.max, 1) : undefined,
      };
    default:
      return fallback;
  }
}

/**
 * Normalize an external (C) scenario object into the internal `Scenario`.
 * Provider bond/capacity and consumer budget are not in C's schema (they are an
 * on-chain staking concern), so we derive sensible M1 defaults sized to the
 * order flow so the run has enough collateral/credits/budget to not starve.
 */
export function normalizeExternalScenario(o: Record<string, unknown>): Scenario {
  const perMin = num(o.orderRatePerMin, 120);
  const durationSec = num(o.durationSec, 60);
  const orderRatePerSec = perMin / 60;
  const orderCount = Math.max(1, Math.round(orderRatePerSec * durationSec));

  const providerCount = Math.max(1, Math.trunc(num(o.providers, 2)));
  const consumerCount = Math.max(1, Math.trunc(num(o.consumers, 3)));

  const qtyScu = mapDistribution(o.qty as Record<string, unknown>, 1, {
    kind: "uniform",
    min: 1,
    max: 20,
  });
  // Prices in C are USDC-per-SCU floats; convert to base units (×1e6).
  const priceUsdcPerScu = mapDistribution(o.price as Record<string, unknown>, USDC_DECIMALS, {
    kind: "normal",
    mean: 12_000,
    stddev: 2_000,
    min: 6_000,
  });

  // Size collateral/credits/budget generously for M1 so the flow isn't starved.
  // Heuristic: each provider mints enough SCU to cover the whole order stream;
  // each consumer is funded for many max-size orders.
  const mintCreditsScu = Math.max(5_000, orderCount * 30);
  const capacityScu = mintCreditsScu * 2;
  const bondUsdc = 1_000_000_000; // 1,000 USDC
  const budgetUsdc = 2_000_000_000; // 2,000 USDC

  const faults = (o.faults as Record<string, unknown>) ?? {};

  return {
    name: String(o.name ?? "external"),
    description: o.description as string | undefined,
    orderRatePerSec,
    orderCount,
    providers: { count: providerCount, bondUsdc, capacityScu, mintCreditsScu },
    consumers: { count: consumerCount, budgetUsdc },
    qtyScu,
    priceUsdcPerScu,
    // C carries latency via examples/fixtures/latency-profiles.json + settleDelaySec;
    // M1 harness derives an exec-latency distribution from a default profile.
    execLatencyMs: { kind: "normal", mean: 2_000, stddev: 800, min: 100, max: 12_000 },
    faults: {
      skipAttest: num(faults.skipAttest, 0),
      lateAttest: num(faults.lateAttest, 0),
      wrongOutput: num(faults.wrongOutput, 0),
      // consumerAbandon (D2 forfeit) is an M2 path; ignored in M1 fault routing.
    },
    seed: o.seed !== undefined ? Number(o.seed) : undefined,
  };
}
