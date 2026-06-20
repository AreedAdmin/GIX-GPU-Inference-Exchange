/**
 * Harness event surface.
 *
 * Mirrors `gix::events` (sui-move-contracts.md §6) for the events the M1 flow
 * emits, plus a few harness-only lifecycle markers (Order, Match) the chain does
 * not emit. On chain these are reconstructed from the subscribed `gix::events`
 * stream and/or tx effects; in dry-run the orchestrator emits them directly.
 */

export type HarnessEventType =
  // harness-only
  | "Order"
  | "Match"
  | "NoMatch"
  // mirror gix::events
  | "Staked"
  | "CreditsMinted"
  | "JobCreated"
  | "Dispatched"
  | "AttestationSubmitted"
  | "Settled"
  | "Refunded"
  | "Slashed"
  | "Expired";

export interface HarnessEvent {
  type: HarnessEventType;
  /** ms epoch (simulated clock in dry-run, wall clock on chain). */
  ts: number;
  jobId?: string;
  provider?: string;
  consumer?: string;
  marketId?: string;
  /** Free-form numeric payload (amounts, qty, penalty, etc.). */
  data?: Record<string, number | string>;
}
