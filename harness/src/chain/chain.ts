/**
 * The `Chain` seam.
 *
 * The orchestrator drives the lifecycle through this interface; two
 * implementations exist:
 *   - DryRunChain (src/chain/dryrun.ts): in-memory state machine, no validator.
 *   - SuiChain    (src/chain/sui.ts):    builds & submits real PTBs via @mysten/sui.
 *
 * Every method returns the harness events it produced so the orchestrator can
 * feed them to the Tally + Logger uniformly, regardless of backend. On chain the
 * events are reconstructed from `gix::events` / tx effects; in dry-run they are
 * synthesized by the state machine.
 */

import type { MockAttestation } from "../actors/attestation.js";
import type { HarnessEvent } from "../observability/events.js";
import type { JobRecord, Match } from "../orchestrator/model.js";

export interface CreateJobResult {
  job: JobRecord;
  events: HarnessEvent[];
}

export interface Chain {
  readonly mode: "dry-run" | "sui";

  /**
   * Provider setup: faucet MOCK_USDC → stake (USDC bond) → mint_credits →
   * register availability. Returns the setup events (Staked, CreditsMinted).
   * Idempotent per provider address.
   */
  setupProvider(address: string, bondUsdc: number, capacityScu: number, mintScu: number): Promise<HarnessEvent[]>;

  /** Consumer setup: faucet MOCK_USDC for the consumer's budget. */
  setupConsumer(address: string, budgetUsdc: number): Promise<HarnessEvent[]>;

  /**
   * Create a Job + escrow from a stubbed match (M1 calls `create_job` directly).
   * Advances Created→…→Dispatched in one shot, mirroring create_job_from_fill.
   */
  createJob(match: Match, marketId: string, nowMs: number): Promise<CreateJobResult>;

  /**
   * Submit the (mock) attestation for a job, if the provider intends to submit.
   * On SkipAttest the caller does not invoke this. Returns AttestationSubmitted.
   */
  submitMockAttestation(
    job: JobRecord,
    att: MockAttestation,
    slaP99Ms: number,
    nowMs: number,
  ): Promise<HarnessEvent[]>;

  /**
   * Settle or expire-and-resolve the job: drives Verified→Settled, or the
   * fault paths to Refunded(+Slashed)/Expired. Returns the terminal events.
   */
  resolve(job: JobRecord, slaP99Ms: number, nowMs: number): Promise<HarnessEvent[]>;
}
