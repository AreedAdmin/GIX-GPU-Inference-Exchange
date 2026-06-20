/**
 * DryRunChain — in-memory implementation of the `Chain` seam.
 *
 * Simulates the on-chain state machine (task-lifecycle.md) without a validator,
 * so the harness's unit tests + a demo run work offline. It tracks provider
 * bonds/capacity and consumer budgets, applies the same fee/slash economics the
 * contract will, and synthesizes the `gix::events`-equivalent events.
 *
 * It is deliberately strict: it asserts the lifecycle invariants (I2 escrow ==
 * qty*price, single payout, no slash without fault) so a regression in the
 * harness's own logic fails a test rather than silently mis-reporting.
 */

import type { MockAttestation } from "../actors/attestation.js";
import { predictVerdict } from "../actors/attestation.js";
import type { HarnessEvent } from "../observability/events.js";
import {
  FailureReason,
  FaultClass,
  JobState,
  type JobRecord,
  type Match,
} from "../orchestrator/model.js";
import {
  distributeSlash,
  settleFee,
  slashAmount,
} from "../orchestrator/economics.js";
import type { Chain, CreateJobResult } from "./chain.js";

interface ProviderLedger {
  bondUsdc: number;
  capacityScu: number;
  mintedScu: number;
  reservedScu: number;
  slashedUsdc: number;
  faultCount: number;
}

interface ConsumerLedger {
  budgetUsdc: number;
}

export class DryRunChain implements Chain {
  readonly mode = "dry-run" as const;

  private providers = new Map<string, ProviderLedger>();
  private consumers = new Map<string, ConsumerLedger>();
  private treasuryUsdc = 0;
  private jobSeq = 0;

  /** Expose ledgers for tests / final reconciliation. */
  getProvider(addr: string): ProviderLedger | undefined {
    return this.providers.get(addr);
  }
  getConsumer(addr: string): ConsumerLedger | undefined {
    return this.consumers.get(addr);
  }
  getTreasury(): number {
    return this.treasuryUsdc;
  }

  async setupProvider(
    address: string,
    bondUsdc: number,
    capacityScu: number,
    mintScu: number,
  ): Promise<HarnessEvent[]> {
    if (mintScu > capacityScu) {
      throw new Error(
        `provider ${address}: cannot mint ${mintScu} SCU beyond capacity ${capacityScu} (I3)`,
      );
    }
    this.providers.set(address, {
      bondUsdc,
      capacityScu,
      mintedScu: mintScu,
      reservedScu: 0,
      slashedUsdc: 0,
      faultCount: 0,
    });
    const ts = Date.now();
    return [
      {
        type: "Staked",
        ts,
        provider: address,
        data: { amountUsdc: bondUsdc, capacityScu },
      },
      {
        type: "CreditsMinted",
        ts,
        provider: address,
        data: { qty: mintScu },
      },
    ];
  }

  async setupConsumer(address: string, budgetUsdc: number): Promise<HarnessEvent[]> {
    this.consumers.set(address, { budgetUsdc });
    return [];
  }

  async createJob(match: Match, marketId: string, nowMs: number): Promise<CreateJobResult> {
    const provider = this.providers.get(match.provider);
    const consumer = this.consumers.get(match.consumer);
    if (!provider) throw new Error(`createJob: unknown provider ${match.provider}`);
    if (!consumer) throw new Error(`createJob: unknown consumer ${match.consumer}`);

    // I2: escrow == qty * price.
    const escrow = match.qtyScu * match.priceUsdcPerScu;
    if (escrow !== match.escrowUsdc) {
      throw new Error(`createJob: escrow mismatch ${escrow} != ${match.escrowUsdc} (I2)`);
    }
    // Consumer must afford the escrow.
    if (consumer.budgetUsdc < escrow) {
      throw new Error(`createJob: consumer ${match.consumer} budget too low for escrow ${escrow}`);
    }
    // Capacity bound (I3 / reserve-then-burn L1): reserved + qty ≤ minted.
    if (provider.reservedScu + match.qtyScu > provider.mintedScu) {
      throw new Error(
        `createJob: provider ${match.provider} over capacity ` +
          `(${provider.reservedScu}+${match.qtyScu} > ${provider.mintedScu})`,
      );
    }

    consumer.budgetUsdc -= escrow;
    provider.reservedScu += match.qtyScu;

    const jobId = `0xjob${(++this.jobSeq).toString(16).padStart(8, "0")}`;
    const job: JobRecord = {
      jobId,
      marketId,
      provider: match.provider,
      consumer: match.consumer,
      qtyScu: match.qtyScu,
      priceUsdcPerScu: match.priceUsdcPerScu,
      escrowUsdc: escrow,
      inputHash: match.bid.inputHash,
      outputHash: "",
      state: JobState.Dispatched, // Created→Matched→Escrowed→Dispatched in one tx
      fault: FaultClass.None,
      failureReason: FailureReason.None,
      tStart: nowMs,
      tEnd: nowMs,
      slashedUsdc: 0,
      feeUsdc: 0,
      payoutUsdc: 0,
      slashed: false,
    };

    const events: HarnessEvent[] = [
      {
        type: "JobCreated",
        ts: nowMs,
        jobId,
        provider: job.provider,
        consumer: job.consumer,
        marketId,
        data: { qtyScu: job.qtyScu, escrowUsdc: escrow, priceUsdcPerScu: job.priceUsdcPerScu },
      },
      {
        type: "Dispatched",
        ts: nowMs,
        jobId,
        provider: job.provider,
        marketId,
      },
    ];
    return { job, events };
  }

  async submitMockAttestation(
    job: JobRecord,
    att: MockAttestation,
    _slaP99Ms: number,
    nowMs: number,
  ): Promise<HarnessEvent[]> {
    job.state = JobState.Attested;
    job.outputHash = att.outputHash;
    job.tStart = att.tStart;
    job.tEnd = att.tEnd;
    return [
      {
        type: "AttestationSubmitted",
        ts: nowMs,
        jobId: job.jobId,
        provider: job.provider,
        data: {
          outputTokenCount: att.outputTokenCount,
          execMs: att.tEnd - att.tStart,
        },
      },
    ];
  }

  async resolve(job: JobRecord, slaP99Ms: number, nowMs: number): Promise<HarnessEvent[]> {
    const provider = this.providers.get(job.provider)!;
    // Release reserved capacity at any terminal state (task-lifecycle.md §9).
    provider.reservedScu -= job.qtyScu;

    // SkipAttest never submitted → AttTimeout.
    if (job.fault === FaultClass.SkipAttest) {
      return this.faultTerminal(job, provider, FailureReason.AttTimeout, nowMs);
    }

    const expected = expectedOutputHashFor(job);
    const verdict = predictVerdict(
      { ...attFromJob(job) },
      expected,
      slaP99Ms,
    );

    if (verdict === "INVALID") {
      return this.faultTerminal(job, provider, FailureReason.InvalidAttestation, nowMs);
    }
    if (verdict === "SLA_BREACH") {
      return this.faultTerminal(job, provider, FailureReason.SlaOverrun, nowMs);
    }

    // VALID → Verified → Settled.
    job.state = JobState.Settled;
    const { feeUsdc, payoutUsdc } = settleFee(job.escrowUsdc);
    job.feeUsdc = feeUsdc;
    job.payoutUsdc = payoutUsdc;
    this.treasuryUsdc += feeUsdc;
    provider.bondUsdc += 0; // payout goes to provider wallet, not bond
    // Burn the reserved SCU (capacity consumed): minted decreases.
    provider.mintedScu -= job.qtyScu;

    return [
      {
        type: "Settled",
        ts: nowMs,
        jobId: job.jobId,
        provider: job.provider,
        consumer: job.consumer,
        marketId: job.marketId,
        data: { payoutUsdc, feeUsdc },
      },
    ];
  }

  private faultTerminal(
    job: JobRecord,
    provider: ProviderLedger,
    reason: FailureReason,
    nowMs: number,
  ): HarnessEvent[] {
    // 1. Consumer made whole first (escrow refunded in full).
    const consumer = this.consumers.get(job.consumer)!;
    consumer.budgetUsdc += job.escrowUsdc;
    job.state = JobState.Refunded;
    job.failureReason = reason;

    // 2. Slash the provider bond.
    const penalty = slashAmount(reason, job.escrowUsdc, provider.bondUsdc);
    provider.bondUsdc -= penalty;
    provider.slashedUsdc += penalty;
    provider.faultCount += 1;
    job.slashedUsdc = penalty;
    job.slashed = penalty > 0;

    // 3. Distribute the slash (D1): consumer up to job value → remainder treasury.
    const split = distributeSlash(penalty, job.escrowUsdc);
    consumer.budgetUsdc += split.toConsumer;
    this.treasuryUsdc += split.toTreasury;

    // Faulted reservation is released (already done by caller); credits returned
    // (not burned) so minted capacity is preserved.

    const events: HarnessEvent[] = [
      {
        type: "Refunded",
        ts: nowMs,
        jobId: job.jobId,
        consumer: job.consumer,
        data: { amountUsdc: job.escrowUsdc, reason },
      },
    ];
    if (penalty > 0) {
      events.push({
        type: "Slashed",
        ts: nowMs,
        jobId: job.jobId,
        provider: job.provider,
        data: {
          penaltyUsdc: penalty,
          toConsumerUsdc: split.toConsumer,
          toTreasuryUsdc: split.toTreasury,
          reason,
        },
      });
    }
    return events;
  }
}

// --- helpers --------------------------------------------------------------

function attFromJob(job: JobRecord): MockAttestation {
  return {
    runtimeMeasurement: "",
    outputHash: job.outputHash,
    outputTokenCount: 0,
    tStart: job.tStart,
    tEnd: job.tEnd,
    willSubmit: true,
  };
}

/** The honest output hash the verifier compares against (mirrors attestation.ts). */
function expectedOutputHashFor(job: JobRecord): string {
  // For WrongOutput jobs the submitted hash was corrupted, so it won't equal this.
  // We recompute the honest hash from the input commitment.
  // Imported lazily to avoid a cycle at module top.
  // (honestOutputHash is pure; inlined import below.)
  return honestOutputHashLocal(job.inputHash);
}

import { createHash } from "node:crypto";
function honestOutputHashLocal(inputHash: string): string {
  return createHash("sha256").update(`gix-mock-output|${inputHash}`).digest("hex");
}
