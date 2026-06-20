import { describe, it, expect } from "vitest";
import { selectFault } from "../src/actors/faults.js";
import { FaultClass } from "../src/orchestrator/model.js";
import { Rng } from "../src/util/rng.js";
import type { FaultRates } from "../src/config/types.js";

function tally(rates: FaultRates, n: number, seed = 1): Record<FaultClass, number> {
  const rng = new Rng(seed);
  const counts: Record<FaultClass, number> = {
    [FaultClass.None]: 0,
    [FaultClass.SkipAttest]: 0,
    [FaultClass.LateAttest]: 0,
    [FaultClass.WrongOutput]: 0,
  };
  for (let i = 0; i < n; i++) counts[selectFault(rates, rng)] += 1;
  return counts;
}

describe("fault injection", () => {
  it("zero rates always yield None", () => {
    const c = tally({ skipAttest: 0, lateAttest: 0, wrongOutput: 0 }, 1000);
    expect(c[FaultClass.None]).toBe(1000);
  });

  it("rate 1.0 on skip always yields SkipAttest", () => {
    const c = tally({ skipAttest: 1, lateAttest: 0, wrongOutput: 0 }, 500);
    expect(c[FaultClass.SkipAttest]).toBe(500);
  });

  it("empirical frequencies converge to configured rates", () => {
    const rates = { skipAttest: 0.1, lateAttest: 0.2, wrongOutput: 0.05 };
    const n = 20000;
    const c = tally(rates, n);
    expect(c[FaultClass.SkipAttest] / n).toBeCloseTo(0.1, 1);
    expect(c[FaultClass.LateAttest] / n).toBeCloseTo(0.2, 1);
    expect(c[FaultClass.WrongOutput] / n).toBeCloseTo(0.05, 1);
    expect(c[FaultClass.None] / n).toBeCloseTo(0.65, 1);
  });

  it("is deterministic for a fixed seed", () => {
    const a = tally({ skipAttest: 0.1, lateAttest: 0.1, wrongOutput: 0.1 }, 100, 123);
    const b = tally({ skipAttest: 0.1, lateAttest: 0.1, wrongOutput: 0.1 }, 100, 123);
    expect(a).toEqual(b);
  });

  it("resolves overlapping mass in priority order skip→late→wrong", () => {
    // All three at 0.34 sum > 1 is rejected at config; here use 0.33 each.
    const c = tally({ skipAttest: 0.33, lateAttest: 0.33, wrongOutput: 0.33 }, 30000);
    // skip should be ~0.33, none ~0.01
    expect(c[FaultClass.SkipAttest] / 30000).toBeCloseTo(0.33, 1);
    expect(c[FaultClass.None] / 30000).toBeLessThan(0.05);
  });
});
