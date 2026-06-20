/**
 * Built-in `baseline` scenario.
 *
 * This is the fallback the harness uses when no `--scenario` path is given (or
 * the file is absent), so `npm run stream` and the unit tests run even before
 * `examples/scenarios/` exists. It mirrors the shape C will later ship in
 * `examples/scenarios/baseline.json`.
 *
 * Economic units (decisions in open-ended-questions.md / integration contract):
 *   - USDC is MOCK_USDC, 6 decimals → 1 USDC = 1_000_000 base units.
 *   - 1 SCU = N output tokens (token-metered, E1). Price is base-USDC per SCU.
 */

import type { Scenario } from "../config/types.js";

export const BASELINE_SCENARIO: Scenario = {
  name: "baseline",
  description:
    "Steady synthetic flow with light fault injection — exercises the happy path plus a few slashes.",
  orderRatePerSec: 5,
  orderCount: 40,
  providers: {
    count: 3,
    bondUsdc: 1_000_000_000, // 1,000 USDC
    capacityScu: 10_000,
    mintCreditsScu: 5_000,
  },
  consumers: {
    count: 5,
    budgetUsdc: 500_000_000, // 500 USDC
  },
  qtyScu: { kind: "uniform", min: 1, max: 10 },
  priceUsdcPerScu: { kind: "normal", mean: 2_000, stddev: 400, min: 500 }, // ~0.002 USDC/SCU
  execLatencyMs: { kind: "normal", mean: 2_000, stddev: 800, min: 100, max: 12_000 },
  faults: {
    skipAttest: 0.05, // missing attestation → 100% bond-share slash
    lateAttest: 0.08, // SLA breach → graded slash
    wrongOutput: 0.04, // invalid attestation → 100% bond-share + flat penalty
  },
  seed: 42,
};
