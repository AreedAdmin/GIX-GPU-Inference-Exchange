import { describe, it, expect } from "vitest";
import {
  validateDeployment,
  validateScenario,
  loadScenario,
  ConfigError,
} from "../src/config/load.js";
import { BASELINE_SCENARIO } from "../src/scenarios/baseline.js";

const validDeployment = {
  network: "localnet",
  packageId: "0xpkg",
  configId: "0xcfg",
  adminCapId: "0xadm",
  usdcType: "0xpkg::mock_usdc::MOCK_USDC",
  clockId: "0x6",
  markets: [
    {
      id: "0xmkt",
      name: "H100-llama3.1-8b-int8",
      creditType: "0xpkg::markets::M_H100_LLAMA8B",
      scuTokens: 1000,
      slaP99Ms: 5000,
    },
  ],
  accounts: { admin: "0xa", providers: ["0xp"], consumers: ["0xc"] },
};

describe("validateDeployment", () => {
  it("accepts a well-formed deployment", () => {
    const d = validateDeployment(validDeployment);
    expect(d.packageId).toBe("0xpkg");
    expect(d.markets[0]!.scuTokens).toBe(1000);
  });

  it("rejects a missing required field", () => {
    const bad = { ...validDeployment } as Record<string, unknown>;
    delete bad.usdcType;
    expect(() => validateDeployment(bad)).toThrow(ConfigError);
  });

  it("tolerates an empty markets array (C's fallback deploy mode)", () => {
    // ops/scripts/deploy.sh fallback_publish may emit markets: [] before A's
    // create_market is exposed; the harness must load it (and report nothing to
    // trade at runtime) rather than fail.
    const d = validateDeployment({ ...validDeployment, markets: [] });
    expect(d.markets).toEqual([]);
  });

  it("rejects a non-array markets field", () => {
    expect(() => validateDeployment({ ...validDeployment, markets: "nope" })).toThrow(
      /expected an array/,
    );
  });

  it("defaults clockId to 0x6", () => {
    const bad = { ...validDeployment } as Record<string, unknown>;
    delete bad.clockId;
    expect(validateDeployment(bad).clockId).toBe("0x6");
  });
});

describe("validateScenario", () => {
  it("validates the built-in baseline", () => {
    expect(() => validateScenario(BASELINE_SCENARIO)).not.toThrow();
  });

  it("rejects fault rates summing > 1", () => {
    const bad = { ...BASELINE_SCENARIO, faults: { skipAttest: 0.5, lateAttest: 0.4, wrongOutput: 0.2 } };
    expect(() => validateScenario(bad)).toThrow(/≤ 1/);
  });

  it("rejects an out-of-range probability", () => {
    const bad = { ...BASELINE_SCENARIO, faults: { skipAttest: 1.5, lateAttest: 0, wrongOutput: 0 } };
    expect(() => validateScenario(bad)).toThrow(/probability/);
  });

  it("rejects an unknown distribution kind", () => {
    const bad = { ...BASELINE_SCENARIO, qtyScu: { kind: "poisson", lambda: 3 } };
    expect(() => validateScenario(bad)).toThrow(/unknown distribution/);
  });
});

describe("loadScenario fallback", () => {
  it("returns the built-in baseline when no path is given", () => {
    expect(loadScenario()).toBe(BASELINE_SCENARIO);
  });

  it("throws a ConfigError for a missing file", () => {
    expect(() => loadScenario("/no/such/scenario.json")).toThrow(ConfigError);
  });
});
