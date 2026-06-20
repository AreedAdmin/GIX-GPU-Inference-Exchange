/**
 * Unit tests for the money/state invariant checkers (§4 F6) over synthetic before/after
 * snapshots. These prove the checkers themselves are correct (so a real violation in the live
 * harness is reliably caught) — independent of any chain.
 */

import { describe, it, expect } from "vitest";
import {
  checkEscrowConservation,
  checkNoPayoutWithoutVerified,
  checkExactlyOnceTerminal,
  checkNoSlashWithoutFault,
  checkAllInvariants,
  STATE,
  type Snapshot,
} from "../invariants.js";

const ESCROW = 1_000_000n;

/** A Verified→Settled happy snapshot pair: escrow drains, provider paid escrow - fee, fee to
 * treasury, no slash. fee = 0 here for a clean conservation identity. */
function happyPair(): { before: Snapshot; after: Snapshot } {
  const before: Snapshot = {
    providerUsdc: 0n,
    consumerUsdc: 5_000_000n,
    treasuryUsdc: 0n,
    bond: 10_000_000n,
    slashedTotal: 0n,
    jobEscrow: ESCROW,
    jobState: STATE.VERIFIED,
    jobSlashed: false,
  };
  const after: Snapshot = {
    ...before,
    providerUsdc: ESCROW, // paid full escrow (fee 0)
    jobEscrow: 0n,
    jobState: STATE.SETTLED,
  };
  return { before, after };
}

/** A faulty Attested→Refunded(+slash) pair: escrow refunded to consumer, bond slashed, the
 * slash comp goes to the consumer up to job value. */
function faultPair(): { before: Snapshot; after: Snapshot } {
  const before: Snapshot = {
    providerUsdc: 0n,
    consumerUsdc: 5_000_000n,
    treasuryUsdc: 0n,
    bond: 10_000_000n,
    slashedTotal: 0n,
    jobEscrow: ESCROW,
    jobState: STATE.ATTESTED,
    jobSlashed: false,
  };
  // refund escrow back to consumer (+ESCROW), slash 500_000 from bond → all to consumer as comp.
  const slash = 500_000n;
  const after: Snapshot = {
    ...before,
    consumerUsdc: before.consumerUsdc + ESCROW + slash,
    bond: before.bond - slash,
    slashedTotal: slash,
    jobEscrow: 0n,
    jobState: STATE.REFUNDED,
    jobSlashed: true,
  };
  return { before, after };
}

describe("escrow conservation", () => {
  it("balances for a clean settle (escrow → provider, fee 0)", () => {
    const { before, after } = happyPair();
    expect(checkEscrowConservation(before, after, { escrowLocked: ESCROW, feeBps: 0n, verdict: 0 }).ok).toBe(true);
  });
  it("balances for a refund+slash (escrow → consumer, slash → consumer)", () => {
    const { before, after } = faultPair();
    expect(checkEscrowConservation(before, after, { escrowLocked: ESCROW, feeBps: 0n, verdict: 2 }).ok).toBe(true);
  });
  it("DETECTS minted USDC (provider paid more than the escrow released)", () => {
    const { before, after } = happyPair();
    const tampered = { ...after, providerUsdc: after.providerUsdc + 1n };
    expect(checkEscrowConservation(before, tampered, { escrowLocked: ESCROW, feeBps: 0n, verdict: 0 }).ok).toBe(false);
  });
});

describe("no payout without Verified", () => {
  it("passes when a payout lands in Settled", () => {
    const { before, after } = happyPair();
    expect(checkNoPayoutWithoutVerified(before, after).ok).toBe(true);
  });
  it("FAILS a provider payout that ended Refunded", () => {
    const { before } = happyPair();
    const bad: Snapshot = { ...before, providerUsdc: before.providerUsdc + ESCROW, jobState: STATE.REFUNDED, jobEscrow: 0n };
    expect(checkNoPayoutWithoutVerified(before, bad).ok).toBe(false);
  });
  it("holds trivially when nobody was paid (a pure refund)", () => {
    const { before, after } = faultPair();
    expect(checkNoPayoutWithoutVerified(before, after).ok).toBe(true);
  });
});

describe("exactly-once terminal", () => {
  it("a single non-terminal → terminal transition passes", () => {
    const { before, after } = happyPair();
    expect(checkExactlyOnceTerminal(before, after).ok).toBe(true);
  });
  it("FAILS if it was already terminal before", () => {
    const { after } = happyPair();
    expect(checkExactlyOnceTerminal(after, after).ok).toBe(false);
  });
});

describe("no slash without fault", () => {
  it("a clean (VALID) job is never slashed", () => {
    const { before, after } = happyPair();
    expect(checkNoSlashWithoutFault(before, after, { escrowLocked: ESCROW, feeBps: 0n, verdict: 0 }).ok).toBe(true);
  });
  it("FAILS if a VALID job's bond dropped", () => {
    const { before, after } = happyPair();
    const bad = { ...after, bond: after.bond - 1n, jobSlashed: true };
    expect(checkNoSlashWithoutFault(before, bad, { escrowLocked: ESCROW, feeBps: 0n, verdict: 0 }).ok).toBe(false);
  });
  it("does not constrain a faulty verdict", () => {
    const { before, after } = faultPair();
    expect(checkNoSlashWithoutFault(before, after, { escrowLocked: ESCROW, feeBps: 0n, verdict: 2 }).ok).toBe(true);
  });
});

describe("checkAllInvariants", () => {
  it("a clean settle is all-green", () => {
    const { before, after } = happyPair();
    const rs = checkAllInvariants(before, after, { escrowLocked: ESCROW, feeBps: 0n, verdict: 0 });
    expect(rs.every((r) => r.ok)).toBe(true);
  });
});
