/**
 * Harness-side domain model: orders, the Job record the harness tracks, and the
 * lifecycle state enum. These mirror the on-chain `Job` state machine from
 * docs/protocol/task-lifecycle.md but only carry what the streamer needs to
 * render and reconcile the flow.
 */

/** Job lifecycle states (subset relevant to M1), per task-lifecycle.md §1.1. */
export enum JobState {
  Created = "Created",
  Matched = "Matched",
  Escrowed = "Escrowed",
  Dispatched = "Dispatched",
  Executing = "Executing",
  Attested = "Attested",
  Verified = "Verified",
  Settled = "Settled",
  Refunded = "Refunded",
  Expired = "Expired",
}

/** Fault classes the harness injects (map to lifecycle F-transitions). */
export enum FaultClass {
  None = "None",
  /** Provider never submits → F7 AttTimeout, missing-attestation slash. */
  SkipAttest = "SkipAttest",
  /** Exec exceeds SLA → F6 SlaOverrun, graded SLA slash. */
  LateAttest = "LateAttest",
  /** Wrong output_hash → F8 InvalidAttestation, 100% + flat penalty. */
  WrongOutput = "WrongOutput",
}

/** Refund/slash reason, mirrors task-lifecycle.md Refunded `reason` enum. */
export enum FailureReason {
  None = "None",
  AckTimeout = "AckTimeout",
  SlaOverrun = "SlaOverrun",
  AttTimeout = "AttTimeout",
  InvalidAttestation = "InvalidAttestation",
}

/** A consumer "bid": demand for SCU at a price. */
export interface Bid {
  id: string;
  consumer: string;
  marketId: string;
  qtyScu: number;
  priceUsdcPerScu: number;
  /** BLAKE-style hash hex of the synthetic prompt (consumer input commitment). */
  inputHash: string;
}

/** A provider "ask": offered SCU at a price. */
export interface Ask {
  id: string;
  provider: string;
  marketId: string;
  qtyScu: number;
  priceUsdcPerScu: number;
}

/** A bid matched to an ask by the Matcher. */
export interface Match {
  bid: Bid;
  ask: Ask;
  marketId: string;
  provider: string;
  consumer: string;
  /** Filled quantity = min(bid.qty, ask.qty). */
  qtyScu: number;
  /** Clearing price (ask price in M1 stub — maker price). */
  priceUsdcPerScu: number;
  /** Total escrow = qtyScu * priceUsdcPerScu. */
  escrowUsdc: number;
}

/** The harness's record of a Job as it walks the lifecycle. */
export interface JobRecord {
  jobId: string;
  marketId: string;
  provider: string;
  consumer: string;
  qtyScu: number;
  priceUsdcPerScu: number;
  escrowUsdc: number;
  inputHash: string;
  /** output_hash bound at (mock) attestation; "" until attested. */
  outputHash: string;
  state: JobState;
  fault: FaultClass;
  failureReason: FailureReason;
  /** Simulated execution time window (ms epoch) used for the SLA check. */
  tStart: number;
  tEnd: number;
  /** USDC slashed from the provider's bond on a fault settlement. */
  slashedUsdc: number;
  /** Fee skimmed to treasury on a successful settle. */
  feeUsdc: number;
  /** Net payout to provider on settle (escrow − fee). */
  payoutUsdc: number;
  slashed: boolean;
}
