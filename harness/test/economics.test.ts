import { describe, it, expect } from "vitest";
import {
  settleFee,
  slashAmount,
  bondShare,
  distributeSlash,
  DEFAULT_FEE_BPS,
  INVALID_FLAT_PENALTY_USDC,
} from "../src/orchestrator/economics.js";
import { FailureReason } from "../src/orchestrator/model.js";

describe("settleFee", () => {
  it("takes 30 bps by default (config.move)", () => {
    expect(DEFAULT_FEE_BPS).toBe(30);
    const { feeUsdc, payoutUsdc } = settleFee(1_000_000);
    expect(feeUsdc).toBe(3000); // 0.30% of 1 USDC
    expect(payoutUsdc).toBe(997_000);
    expect(feeUsdc + payoutUsdc).toBe(1_000_000); // conservation
  });

  it("floors the fee (no value created)", () => {
    const { feeUsdc, payoutUsdc } = settleFee(101);
    expect(feeUsdc).toBe(0); // floor(101*30/10000) = 0
    expect(payoutUsdc).toBe(101);
  });
});

describe("slashAmount (decision B4)", () => {
  const escrow = 10_000;
  const bond = 10_000_000; // large enough that share+flat penalty isn't clamped

  it("AttTimeout (missing) = 100% of bond share", () => {
    expect(slashAmount(FailureReason.AttTimeout, escrow, bond)).toBe(escrow);
  });

  it("InvalidAttestation = bond share + flat penalty", () => {
    expect(slashAmount(FailureReason.InvalidAttestation, escrow, bond)).toBe(
      escrow + INVALID_FLAT_PENALTY_USDC,
    );
  });

  it("SlaOverrun is graded (30% of share)", () => {
    expect(slashAmount(FailureReason.SlaOverrun, escrow, bond)).toBe(3000);
  });

  it("AckTimeout liveness is small (3% of share)", () => {
    expect(slashAmount(FailureReason.AckTimeout, escrow, bond)).toBe(300);
  });

  it("never slashes more than the whole bond", () => {
    const tiny = 50; // bond smaller than escrow + penalty
    expect(slashAmount(FailureReason.InvalidAttestation, escrow, tiny)).toBe(tiny);
  });

  it("None → 0", () => {
    expect(slashAmount(FailureReason.None, escrow, bond)).toBe(0);
  });
});

describe("bondShare", () => {
  it("is capped at the escrow value", () => {
    expect(bondShare(10_000, 1_000_000)).toBe(10_000);
    expect(bondShare(2_000_000, 1_000_000)).toBe(1_000_000);
  });
});

describe("distributeSlash (decision D1: consumer first → treasury → burn=0)", () => {
  it("compensates the consumer up to job value, remainder to treasury", () => {
    const split = distributeSlash(11_000, 10_000);
    expect(split.toConsumer).toBe(10_000);
    expect(split.toTreasury).toBe(1_000);
  });

  it("all to consumer when penalty ≤ job value", () => {
    const split = distributeSlash(8_000, 10_000);
    expect(split.toConsumer).toBe(8_000);
    expect(split.toTreasury).toBe(0);
  });
});
