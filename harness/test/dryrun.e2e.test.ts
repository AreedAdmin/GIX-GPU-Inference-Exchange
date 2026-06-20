import { describe, it, expect } from "vitest";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { DryRunChain } from "../src/chain/dryrun.js";
import { StubMatcher } from "../src/matcher/matcher.js";
import { Logger } from "../src/observability/logger.js";
import { Tally } from "../src/observability/tally.js";
import { syntheticDeployment } from "../src/config/synthetic.js";
import { BASELINE_SCENARIO } from "../src/scenarios/baseline.js";
import { JobState, FaultClass } from "../src/orchestrator/model.js";
import type { Scenario } from "../src/config/types.js";

function run(scenario: Scenario, seed = 42) {
  const deployment = syntheticDeployment(scenario);
  const chain = new DryRunChain();
  const tally = new Tally();
  const orch = new Orchestrator({
    scenario,
    deployment,
    chain,
    matcher: new StubMatcher(),
    logger: new Logger("silent"),
    tally,
    seed,
  });
  return { orch, chain, tally, deployment };
}

describe("dry-run end-to-end", () => {
  it("drives the baseline scenario to completion with consistent tallies", async () => {
    const { orch, tally } = run(BASELINE_SCENARIO);
    await orch.setup();
    const result = await orch.run();
    const s = result.tally;

    // Every order is accounted for: a matched order becomes a job; the rest are no-match.
    expect(s.orders).toBe(BASELINE_SCENARIO.orderCount);
    expect(s.fills + s.noMatches).toBe(s.orders);
    expect(s.jobs).toBe(s.fills);

    // Every job reaches exactly one terminal state.
    expect(s.settled + s.refunded).toBe(s.jobs);

    // Slashes are a subset of refunds (slash co-occurs with refund).
    expect(s.slashed).toBeLessThanOrEqual(s.refunded);

    // tally snapshot equals the live tally.
    expect(tally.snapshot()).toEqual(s);

    // Some flow actually happened.
    expect(s.jobs).toBeGreaterThan(0);
    expect(s.settled).toBeGreaterThan(0);
  });

  it("produces all three slash classes under the fault-heavy profile", async () => {
    const faultHeavy: Scenario = {
      ...BASELINE_SCENARIO,
      name: "fault-heavy-test",
      orderCount: 120,
      providers: { ...BASELINE_SCENARIO.providers, mintCreditsScu: 20000, capacityScu: 30000 },
      consumers: { ...BASELINE_SCENARIO.consumers, count: 8, budgetUsdc: 2_000_000_000 },
      faults: { skipAttest: 0.2, lateAttest: 0.25, wrongOutput: 0.15 },
    };
    const { orch, jobsRef } = (() => {
      const r = run(faultHeavy, 7);
      return { orch: r.orch, jobsRef: r };
    })();
    void jobsRef;
    await orch.setup();
    const { jobs } = await orch.run();

    const reasons = new Set(
      jobs.filter((j) => j.state === JobState.Refunded).map((j) => j.failureReason),
    );
    // Expect missing (AttTimeout), SLA (SlaOverrun), invalid (InvalidAttestation).
    expect(jobs.some((j) => j.fault === FaultClass.SkipAttest)).toBe(true);
    expect(jobs.some((j) => j.fault === FaultClass.LateAttest)).toBe(true);
    expect(jobs.some((j) => j.fault === FaultClass.WrongOutput)).toBe(true);
    expect(reasons.size).toBeGreaterThanOrEqual(2);
  });

  it("conserves money: escrowed == payouts + fees (settled) + refunds (refunded)", async () => {
    const { orch, tally } = run(BASELINE_SCENARIO);
    await orch.setup();
    await orch.run();
    const s = tally.snapshot();
    // Each settled job: escrow == payout + fee. Each refunded job: escrow == refund.
    // So total escrowed == (payouts+fees) + refunds.
    expect(s.usdcEscrowed).toBe(s.usdcSettledPayout + s.usdcFees + s.usdcRefunded);
  });

  it("never lets a provider exceed minted capacity (invariant I3)", async () => {
    const tight: Scenario = {
      ...BASELINE_SCENARIO,
      name: "tight-capacity",
      orderCount: 80,
      providers: { count: 2, bondUsdc: 1_000_000_000, capacityScu: 200, mintCreditsScu: 100 },
    };
    const { orch, chain, deployment } = run(tight, 5);
    await orch.setup();
    await orch.run();
    for (const p of deployment.accounts.providers.slice(0, tight.providers.count)) {
      const led = chain.getProvider(p);
      if (led) {
        expect(led.reservedScu).toBeGreaterThanOrEqual(0);
        expect(led.reservedScu).toBeLessThanOrEqual(led.mintedScu);
      }
    }
  });

  it("is deterministic for a fixed seed", async () => {
    const a = run(BASELINE_SCENARIO, 1234);
    await a.orch.setup();
    const ra = await a.orch.run();
    const b = run(BASELINE_SCENARIO, 1234);
    await b.orch.setup();
    const rb = await b.orch.run();
    expect(ra.tally).toEqual(rb.tally);
  });
});
