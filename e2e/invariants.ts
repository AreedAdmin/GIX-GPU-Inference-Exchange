/**
 * Reusable money/state invariant checkers (§4 F6). Each takes a before/after snapshot of the
 * relevant balances + job state and asserts one of the four economic invariants, returning a
 * structured result (so the harness can record per-invariant pass/fail and the negatives
 * scenario can assert the EXPECTED outcome of each fault).
 *
 *   1. Escrow conservation:  Σ escrow_locked == Σ paid_to_provider + Σ refunded_to_consumer + Σ slashed_to_consumer + Σ fee_to_treasury
 *                            (no USDC minted/burned outside settlement; the locked escrow is fully accounted for).
 *   2. No payout without Verified:  a provider payout requires the job to have reached `Verified`.
 *   3. Exactly-once terminal:  a job ends in exactly one of {Settled, Refunded, Expired}; a 2nd settle aborts.
 *   4. No slash without fault:  a correctly-served (Verified→Settled) job is never slashed.
 *
 * These are PURE functions over snapshots — no chain access — so they're unit-testable and
 * reused by both the live harness and the Move-mirroring sanity tests.
 */

/** A balance + state snapshot taken before/after a settlement op. Amounts are MOCK_USDC base
 * units (6dp); `bond` is the provider's remaining stake bond. */
export interface Snapshot {
  /** Provider's total MOCK_USDC wallet balance. */
  providerUsdc: bigint;
  /** Consumer's total MOCK_USDC wallet balance. */
  consumerUsdc: bigint;
  /** Treasury MOCK_USDC balance. */
  treasuryUsdc: bigint;
  /** Provider stake bond remaining (slashable collateral). */
  bond: bigint;
  /** Provider stake `slashed_total` counter. */
  slashedTotal: bigint;
  /** The job's escrow value (the locked amount; 0 once drained / for a fill-job). */
  jobEscrow: bigint;
  /** The job lifecycle state (job.move STATE_*). */
  jobState: number;
  /** Whether the job is flagged slashed. */
  jobSlashed: boolean;
}

/** job.move lifecycle states (mirrored for assertions). */
export const STATE = {
  DISPATCHED: 3,
  EXECUTING: 4,
  ATTESTED: 5,
  VERIFIED: 6,
  SETTLED: 7,
  REFUNDED: 8,
  EXPIRED: 9,
} as const;

export interface InvariantResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** The escrow the consumer locked at job creation, and the verdict the attestation recorded. */
export interface SettleContext {
  /** The escrow value the consumer locked at create_job_from_ask (= job.price_usdc). */
  escrowLocked: bigint;
  /** The fee bps the market charges (for the conservation split). */
  feeBps: bigint;
  /** verdict: 0 VALID | 1 SLA_BREACH | 2 INVALID | undefined (expired/no-attestation). */
  verdict?: number;
}

/**
 * (1) Escrow conservation. Diffs before/after and asserts every base unit of the locked
 * escrow is accounted for as provider payout + consumer refund + slash-comp + treasury fee,
 * AND that no USDC appeared from nowhere (total system USDC across the three parties is
 * conserved up to the slash, which moves bond→consumer/treasury, not new mint).
 */
export function checkEscrowConservation(before: Snapshot, after: Snapshot, _ctx: SettleContext): InvariantResult {
  const providerGain = after.providerUsdc - before.providerUsdc;
  const consumerGain = after.consumerUsdc - before.consumerUsdc;
  const treasuryGain = after.treasuryUsdc - before.treasuryUsdc;
  const bondDrop = before.bond - after.bond; // slashed bond leaves the stake
  const escrowReleased = before.jobEscrow - after.jobEscrow;

  // The escrow that left the job must equal what the three USDC sinks gained MINUS whatever
  // came out of the bond (a slash funds consumer comp + treasury from the bond, not the escrow).
  // i.e.  escrowReleased + bondDrop == providerGain + consumerGain + treasuryGain.
  const inflow = providerGain + consumerGain + treasuryGain;
  const outflow = escrowReleased + bondDrop;
  const ok = inflow === outflow;
  return {
    name: "escrow_conservation",
    ok,
    detail:
      `escrowReleased(${escrowReleased}) + bondSlashed(${bondDrop}) = ${outflow}; ` +
      `providerGain(${providerGain}) + consumerGain(${consumerGain}) + treasuryGain(${treasuryGain}) = ${inflow}` +
      (ok ? "" : "  ← MISMATCH"),
  };
}

/**
 * (2) No payout without Verified. If the provider's USDC increased (a payout occurred), the
 * job MUST have passed through Verified (final state Settled). A payout from any non-Verified
 * path is a violation.
 */
export function checkNoPayoutWithoutVerified(before: Snapshot, after: Snapshot): InvariantResult {
  const providerGain = after.providerUsdc - before.providerUsdc;
  // A payout is a strict provider USDC gain. (Slash-comp goes to the CONSUMER, never the
  // provider, so a provider gain can only be a settle payout.)
  const paid = providerGain > 0n;
  const ok = !paid || after.jobState === STATE.SETTLED;
  return {
    name: "no_payout_without_verified",
    ok,
    detail: paid
      ? `provider paid +${providerGain}; final state=${after.jobState} (Settled=${STATE.SETTLED})` + (ok ? "" : "  ← PAID WITHOUT SETTLED")
      : "no provider payout — invariant trivially holds",
  };
}

/**
 * (3) Exactly-once terminal. Asserts the job reached exactly one terminal state and that it
 * was non-terminal before. The "second settle aborts" half is asserted live by the harness
 * (a repeat settle tx must throw) — this checks the single-transition shape.
 */
export function checkExactlyOnceTerminal(before: Snapshot, after: Snapshot): InvariantResult {
  const terminals: number[] = [STATE.SETTLED as number, STATE.REFUNDED as number, STATE.EXPIRED as number];
  const wasNonTerminal = !terminals.includes(before.jobState);
  const isTerminal = terminals.includes(after.jobState);
  const ok = wasNonTerminal && isTerminal;
  return {
    name: "exactly_once_terminal",
    ok,
    detail: `before=${before.jobState} (non-terminal=${wasNonTerminal}), after=${after.jobState} (terminal=${isTerminal})` + (ok ? "" : "  ← NOT A SINGLE TERMINAL TRANSITION"),
  };
}

/**
 * (4) No slash without fault. A job whose attestation verdict is VALID (correctly served) must
 * never be slashed: the bond is unchanged and `slashed` stays false. Conversely, this does NOT
 * require a slash on fault (that's asserted by the negatives scenario), only that a clean job
 * is never slashed.
 */
export function checkNoSlashWithoutFault(before: Snapshot, after: Snapshot, ctx: SettleContext): InvariantResult {
  const wasValid = ctx.verdict === 0;
  const bondDropped = after.bond < before.bond;
  const slashed = after.jobSlashed || after.slashedTotal > before.slashedTotal;
  if (!wasValid) {
    return { name: "no_slash_without_fault", ok: true, detail: `verdict=${ctx.verdict} (faulty) — slash permitted; not checked here` };
  }
  const ok = !bondDropped && !slashed;
  return {
    name: "no_slash_without_fault",
    ok,
    detail: `VALID verdict: bondDropped=${bondDropped}, slashed=${slashed}` + (ok ? "" : "  ← CLEAN JOB WAS SLASHED"),
  };
}

/** Run all four invariants for a settlement and return the combined result set. */
export function checkAllInvariants(before: Snapshot, after: Snapshot, ctx: SettleContext): InvariantResult[] {
  return [
    checkEscrowConservation(before, after, ctx),
    checkNoPayoutWithoutVerified(before, after),
    checkExactlyOnceTerminal(before, after),
    checkNoSlashWithoutFault(before, after, ctx),
  ];
}
