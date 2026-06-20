/**
 * Orchestrator — streams synthetic orders through the exchange.
 *
 * For each order it: generates a consumer bid + provider asks, runs the Matcher,
 * and (on a match) drives the job through create → (mock) attest → settle/expire
 * via the `Chain` seam, honoring the scenario's fault injection. Every event is
 * folded into the Tally and emitted through the Logger.
 *
 * The same orchestrator runs in dry-run and on chain — only the injected `Chain`
 * differs. A simulated clock advances by `1000/orderRatePerSec` ms per order so
 * SLA windows are evaluated deterministically regardless of wall-clock pacing.
 */

import { makeMockAttestationForJob } from "./drive.js";
import { selectFault } from "../actors/faults.js";
import {
  makeBid,
  makeAsk,
  makeConsumers,
  makeProviders,
  type ConsumerActor,
  type ProviderActor,
} from "../actors/actors.js";
import type { Chain } from "../chain/chain.js";
import type { Deployment } from "../config/types.js";
import type { Scenario } from "../config/types.js";
import type { Matcher } from "../matcher/matcher.js";
import type { Logger } from "../observability/logger.js";
import { Tally } from "../observability/tally.js";
import { Rng } from "../util/rng.js";
import { FaultClass, JobState, type Ask, type JobRecord } from "./model.js";

export interface OrchestratorDeps {
  scenario: Scenario;
  deployment: Deployment;
  chain: Chain;
  matcher: Matcher;
  logger: Logger;
  tally: Tally;
  /** Override the scenario seed (e.g. for tests). */
  seed?: number;
  /**
   * Real-time pacing between orders. Default false: run as fast as possible with
   * a simulated clock (used by tests + dry-run demo). When true, sleeps to honor
   * orderRatePerSec (used for a live on-chain demo).
   */
  realtime?: boolean;
  /**
   * Optional read-only tap on every emitted `HarnessEvent`, fired alongside the
   * Tally + Logger. The `--serve` WS feed subscribes here to derive trade/job/
   * ticker frames from the live event stream. Must not throw (errors are the
   * caller's problem; the orchestrator does not catch them).
   */
  onEvent?: (e: import("../observability/events.js").HarnessEvent) => void;
}

export interface RunResult {
  tally: ReturnType<Tally["snapshot"]>;
  jobs: JobRecord[];
}

export class Orchestrator {
  private readonly s: Scenario;
  private readonly chain: Chain;
  private readonly matcher: Matcher;
  private readonly logger: Logger;
  private readonly tally: Tally;
  private readonly rng: Rng;
  private readonly realtime: boolean;
  private readonly onEvent?: (e: import("../observability/events.js").HarnessEvent) => void;
  private readonly marketIds: string[];
  private readonly scuTokensByMarket: Map<string, number>;
  private readonly slaByMarket: Map<string, number>;

  private providers: ProviderActor[] = [];
  private consumers: ConsumerActor[] = [];

  constructor(deps: OrchestratorDeps) {
    this.s = deps.scenario;
    this.chain = deps.chain;
    this.matcher = deps.matcher;
    this.logger = deps.logger;
    this.tally = deps.tally;
    this.rng = new Rng(deps.seed ?? this.s.seed ?? 0x1234);
    this.realtime = deps.realtime ?? false;
    this.onEvent = deps.onEvent;
    this.marketIds = deps.deployment.markets.map((m) => m.id);
    this.scuTokensByMarket = new Map(deps.deployment.markets.map((m) => [m.id, m.scuTokens]));
    this.slaByMarket = new Map(deps.deployment.markets.map((m) => [m.id, m.slaP99Ms]));

    this.providers = makeProviders(
      this.s,
      deps.deployment.accounts.providers.length
        ? deps.deployment.accounts.providers
        : syntheticAddrs("provider", this.s.providers.count),
    );
    this.consumers = makeConsumers(
      this.s,
      deps.deployment.accounts.consumers.length
        ? deps.deployment.accounts.consumers
        : syntheticAddrs("consumer", this.s.consumers.count),
    );
  }

  /** One-time provider/consumer setup (faucet, stake, mint, fund). */
  async setup(): Promise<void> {
    for (const p of this.providers) {
      const evs = await this.chain.setupProvider(
        p.address,
        p.bondUsdc,
        p.capacityScu,
        p.mintedScu,
      );
      this.emit(evs);
    }
    for (const c of this.consumers) {
      const evs = await this.chain.setupConsumer(c.address, c.budgetUsdc);
      this.emit(evs);
    }
  }

  /** Stream all orders, driving each matched job to a terminal state. */
  async run(): Promise<RunResult> {
    const jobs: JobRecord[] = [];
    const stepMs = Math.max(1, Math.round(1000 / Math.max(0.001, this.s.orderRatePerSec)));
    let clock = Date.now();

    for (let i = 0; i < this.s.orderCount; i++) {
      clock += stepMs;
      const job = await this.streamOne(i, clock);
      if (job) jobs.push(job);

      if (this.realtime) await sleep(stepMs);

      if ((i + 1) % 10 === 0 || i + 1 === this.s.orderCount) {
        this.logger.info(`  … ${i + 1}/${this.s.orderCount} orders`);
      }
    }
    return { tally: this.tally.snapshot(), jobs };
  }

  /** Generate + process a single order. Returns the JobRecord if one was created. */
  private async streamOne(nonce: number, nowMs: number): Promise<JobRecord | null> {
    const marketId = this.rng.pick(this.marketIds);
    const consumer = this.rng.pick(this.consumers);
    const qtyScu = Math.max(1, this.rng.sample(this.s.qtyScu));
    const bidPrice = Math.max(1, this.rng.sample(this.s.priceUsdcPerScu));

    // Affordability gate: skip if the consumer can't fund this escrow.
    if (consumer.budgetUsdc < qtyScu * bidPrice) {
      this.emit([{ type: "Order", ts: nowMs, consumer: consumer.address, marketId }]);
      this.emit([{ type: "NoMatch", ts: nowMs, consumer: consumer.address, data: { reason: "budget" } }]);
      return null;
    }

    const bid = makeBid({
      id: `bid-${nonce}`,
      consumer,
      marketId,
      qtyScu,
      priceUsdcPerScu: bidPrice,
      rng: this.rng,
      nonce,
    });
    this.emit([
      {
        type: "Order",
        ts: nowMs,
        consumer: consumer.address,
        marketId,
        data: { qtyScu, priceUsdcPerScu: bidPrice },
      },
    ]);

    // Provider asks: each provider posts at a price near (slightly below) the
    // scenario price so some cross the bid. Priced off the maker's own draw.
    const asks: Ask[] = this.providers
      .map((p) =>
        makeAsk({
          id: `ask-${p.address}`,
          provider: p,
          marketId,
          priceUsdcPerScu: Math.max(1, this.rng.sample(this.s.priceUsdcPerScu)),
        }),
      )
      .filter((a) => a.qtyScu > 0);

    const match = this.matcher.match(bid, asks);
    if (!match) {
      this.emit([{ type: "NoMatch", ts: nowMs, consumer: consumer.address, data: { reason: "no-cross" } }]);
      return null;
    }
    this.emit([
      {
        type: "Match",
        ts: nowMs,
        provider: match.provider,
        consumer: match.consumer,
        marketId,
        data: { qtyScu: match.qtyScu, priceUsdcPerScu: match.priceUsdcPerScu, escrowUsdc: match.escrowUsdc },
      },
    ]);

    // Reflect the reservation on the harness-side provider actor so its next ask
    // is sized to remaining capacity.
    const providerActor = this.providers.find((p) => p.address === match.provider)!;
    providerActor.reservedScu += match.qtyScu;
    // Mirror budget decrement (chain does the real one; this keeps actor view).
    consumer.budgetUsdc -= match.escrowUsdc;

    // 1. create job + escrow (Created→…→Dispatched).
    const { job, events } = await this.chain.createJob(match, marketId, nowMs);
    this.emit(events);

    // 2. fault selection + (mock) attestation.
    job.fault = selectFault(this.s.faults, this.rng);
    const slaP99 = this.slaByMarket.get(marketId) ?? 5000;
    const scuTokens = this.scuTokensByMarket.get(marketId) ?? 1000;

    if (job.fault !== FaultClass.SkipAttest) {
      const att = makeMockAttestationForJob(job, {
        scuTokens,
        slaP99Ms: slaP99,
        execLatency: () => this.rng.sample(this.s.execLatencyMs),
      });
      this.emit(await this.chain.submitMockAttestation(job, att, slaP99, nowMs));
    }

    // 3. resolve: settle (VALID), or refund+slash (fault), or expire (skip).
    this.emit(await this.chain.resolve(job, slaP99, nowMs));

    // Release the harness-side reservation now that the job is terminal.
    providerActor.reservedScu -= match.qtyScu;
    if (job.state === JobState.Settled) {
      // Reserve-then-burn (L1): a settled job burns its reserved credits, so the
      // provider's minted capacity is consumed. Mirror that on the actor view so
      // subsequent asks are sized off live remaining capacity.
      providerActor.mintedScu -= match.qtyScu;
    } else if (job.state === JobState.Refunded || job.state === JobState.Expired) {
      // Failure terminals release (un-reserve) credits without burning, and the
      // consumer's escrow is refunded on-chain — mirror both on the actor view.
      consumer.budgetUsdc += match.escrowUsdc;
    }
    return job;
  }

  private emit(events: import("../observability/events.js").HarnessEvent[]): void {
    for (const e of events) {
      this.tally.record(e);
      this.logger.event(e);
      this.onEvent?.(e);
    }
  }
}

function syntheticAddrs(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `0x${prefix}${String(i).padStart(40 - prefix.length, "0")}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
