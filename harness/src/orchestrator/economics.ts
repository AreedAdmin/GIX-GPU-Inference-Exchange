/**
 * Economics shared by the dry-run engine and the on-chain reconciler.
 *
 * These reproduce the on-chain money rules so dry-run is faithful and on-chain
 * runs can predict-then-verify. Values mirror the v1 defaults:
 *   - protocol fee: 30 bps (config.move `protocol_fee_bps = 30`).
 *   - slash magnitudes (decision B4):
 *       invalid attestation = 100% of bond share + flat penalty
 *       missing attestation = 100% of bond share
 *       SLA breach          = graded 10–50% of bond share
 *       liveness (ack)      = ~2–5% of bond share + reputation
 *
 * "bond share" is interpreted (ASSUMPTION, flagged) as the portion of the
 * provider's bond backing this job's escrow, capped at the escrow value:
 *   bondShare = min(escrowUsdc, providerBondUsdc).
 * Integration must confirm how `gix::slashing` sizes the share.
 */

import { FailureReason } from "./model.js";

export const DEFAULT_FEE_BPS = 30; // 0.30%, from config.move
export const BPS_DEN = 10_000;

/** Flat penalty added on an invalid attestation (ASSUMPTION: small fixed USDC). */
export const INVALID_FLAT_PENALTY_USDC = 1_000_000; // 1 USDC

/** SLA-breach graded fraction (B4: 10–50%); we use a mid 30% by default. */
export const SLA_SLASH_BPS = 3_000; // 30%

/** Liveness (ack-timeout) fraction (B4: ~2–5%); 3% default. */
export const LIVENESS_SLASH_BPS = 300; // 3%

export interface FeeSplit {
  feeUsdc: number;
  payoutUsdc: number;
}

/** Settle fee math (sui-move-contracts.md §9.2). fee = floor(price * bps / 10000). */
export function settleFee(escrowUsdc: number, feeBps = DEFAULT_FEE_BPS): FeeSplit {
  const feeUsdc = Math.floor((escrowUsdc * feeBps) / BPS_DEN);
  return { feeUsdc, payoutUsdc: escrowUsdc - feeUsdc };
}

/** The portion of bond backing this job (capped at escrow). */
export function bondShare(escrowUsdc: number, providerBondUsdc: number): number {
  return Math.min(escrowUsdc, providerBondUsdc);
}

/**
 * Slash magnitude for a provider-fault terminal, per decision B4.
 * Returns the USDC debited from the provider's bond.
 */
export function slashAmount(
  reason: FailureReason,
  escrowUsdc: number,
  providerBondUsdc: number,
): number {
  const share = bondShare(escrowUsdc, providerBondUsdc);
  switch (reason) {
    case FailureReason.InvalidAttestation:
      return Math.min(providerBondUsdc, share + INVALID_FLAT_PENALTY_USDC);
    case FailureReason.AttTimeout:
      return share; // 100% of bond share
    case FailureReason.SlaOverrun:
      return Math.floor((share * SLA_SLASH_BPS) / BPS_DEN);
    case FailureReason.AckTimeout:
      return Math.floor((share * LIVENESS_SLASH_BPS) / BPS_DEN);
    case FailureReason.None:
    default:
      return 0;
  }
}

/**
 * Slash distribution (decision D1): compensate harmed consumer up to 100% of job
 * value first → remainder to treasury → burn = 0. Note the consumer's escrow is
 * already refunded in full separately; this is the *additional* compensation out
 * of the slashed bond.
 */
export interface SlashSplit {
  toConsumer: number;
  toTreasury: number;
}

export function distributeSlash(penaltyUsdc: number, escrowUsdc: number): SlashSplit {
  const toConsumer = Math.min(penaltyUsdc, escrowUsdc);
  return { toConsumer, toTreasury: penaltyUsdc - toConsumer };
}
