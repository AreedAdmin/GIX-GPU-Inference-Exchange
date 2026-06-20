import { describe, it, expect } from "vitest";
import { isExternalScenario, normalizeExternalScenario } from "../src/config/adapter.js";
import { validateScenario } from "../src/config/load.js";

// A representative external (workstream C) scenario doc.
const external = {
  $schema: "./scenario.schema.json",
  name: "baseline",
  seed: 42,
  durationSec: 60,
  orderRatePerMin: 120,
  providers: 2,
  consumers: 3,
  markets: ["H100-llama3.1-8b-int8"],
  qty: { distribution: "uniform-int", min: 1, max: 20, unit: "SCU" },
  price: { distribution: "normal", mean: 0.012, stddev: 0.002, min: 0.006, max: 0.03, unit: "USDC_per_SCU" },
  faults: { skipAttest: 0.02, lateAttest: 0.03, wrongOutput: 0.01, consumerAbandon: 0.01 },
};

describe("external scenario adapter (workstream C schema)", () => {
  it("detects the external shape", () => {
    expect(isExternalScenario(external)).toBe(true);
  });

  it("does not flag the internal shape as external", () => {
    const internal = {
      name: "x",
      orderRatePerSec: 5,
      orderCount: 40,
      providers: { count: 3, bondUsdc: 1, capacityScu: 1, mintCreditsScu: 1 },
      consumers: { count: 5, budgetUsdc: 1 },
      faults: {},
    };
    expect(isExternalScenario(internal)).toBe(false);
  });

  it("converts per-minute rate × duration into an order count", () => {
    const s = normalizeExternalScenario(external);
    expect(s.orderRatePerSec).toBeCloseTo(2, 5); // 120/60
    expect(s.orderCount).toBe(120); // 2/s * 60s
  });

  it("scales USDC-per-SCU prices into 6dp base units", () => {
    const s = normalizeExternalScenario(external);
    expect(s.priceUsdcPerScu.kind).toBe("normal");
    if (s.priceUsdcPerScu.kind === "normal") {
      expect(s.priceUsdcPerScu.mean).toBe(12_000); // 0.012 * 1e6
      expect(s.priceUsdcPerScu.stddev).toBe(2_000);
    }
  });

  it("maps uniform-int qty to a uniform distribution", () => {
    const s = normalizeExternalScenario(external);
    expect(s.qtyScu).toEqual({ kind: "uniform", min: 1, max: 20 });
  });

  it("carries fault rates through (skip/late/wrong)", () => {
    const s = normalizeExternalScenario(external);
    expect(s.faults).toEqual({ skipAttest: 0.02, lateAttest: 0.03, wrongOutput: 0.01 });
  });

  it("expands int providers/consumers into actor profiles with collateral", () => {
    const s = normalizeExternalScenario(external);
    expect(s.providers.count).toBe(2);
    expect(s.consumers.count).toBe(3);
    expect(s.providers.bondUsdc).toBeGreaterThan(0);
    expect(s.providers.mintCreditsScu).toBeGreaterThan(0);
    expect(s.consumers.budgetUsdc).toBeGreaterThan(0);
  });

  it("validateScenario accepts the external doc end-to-end", () => {
    const s = validateScenario(external);
    expect(s.name).toBe("baseline");
    expect(s.orderCount).toBe(120);
  });
});
