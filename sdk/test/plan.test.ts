import { describe, expect, it } from "vitest";
import { buildCreateJobPlan } from "../src/chain.js";
import { hexToBytes, sha2_256Hex } from "../src/hash.js";
import type { MarketDeployment } from "../src/types.js";

/**
 * Assert the create_job PTB plan against contracts/INTERFACE.md:
 *   create_job<M>(cfg, market: &Market<M>, stake: &mut ProviderStake, provider,
 *     credits: Coin<Credit<M>>, escrow_in: Coin<MOCK_USDC>, input_hash, clk, ctx): ID
 * Target, type-arg (the Credit<M> witness), and the 8-arg ORDER are load-bearing.
 */
const PKG = "0x91bca1cd13a5131119467e8bf4867f76ab1c12fcc7200f8c0bbf3acd9dee72ee";
const market: MarketDeployment = {
  id: "0xMARKET",
  name: "H100-llama3.1-8b-int8",
  creditType: `${PKG}::markets::M_H100_LLAMA8B`,
};

describe("buildCreateJobPlan — ABI conformance (contracts/INTERFACE.md)", () => {
  const inputHashHex = sha2_256Hex("what is 2+2?");
  const plan = buildCreateJobPlan({
    packageId: PKG,
    configId: "0xCFG",
    clockId: "0x6",
    market,
    stakeId: "0xSTAKE",
    provider: "0xPROVIDER",
    creditCoinId: "0xCREDIT",
    scuQty: 1n,
    escrowUsdc: 5n,
    inputHashHex,
  });

  it("targets job::create_job", () => {
    expect(plan.createJob.target).toBe(`${PKG}::job::create_job`);
  });

  it("passes the Credit<M> witness as the sole type-arg", () => {
    expect(plan.createJob.typeArguments).toEqual([`${PKG}::markets::M_H100_LLAMA8B`]);
  });

  it("has exactly 8 args in the contract order", () => {
    const roles = plan.createJob.arguments.map((a) => a.role);
    expect(roles).toEqual([
      "cfg",
      "market",
      "stake(&mut ProviderStake)",
      "provider",
      "credits: Coin<Credit<M>>",
      "escrow_in: Coin<MOCK_USDC>",
      "input_hash",
      "clk",
    ]);
  });

  it("cfg/market/stake/clk are object refs to the right ids", () => {
    const a = plan.createJob.arguments;
    expect(a[0]).toMatchObject({ kind: "object", id: "0xCFG" });
    expect(a[1]).toMatchObject({ kind: "object", id: "0xMARKET" });
    expect(a[2]).toMatchObject({ kind: "object", id: "0xSTAKE" });
    expect(a[7]).toMatchObject({ kind: "object", id: "0x6" });
  });

  it("provider is a pure address; credits/escrow are PTB results", () => {
    const a = plan.createJob.arguments;
    expect(a[3]).toMatchObject({ kind: "address", value: "0xPROVIDER" });
    expect(a[4]).toMatchObject({ kind: "result", from: "splitCredit" });
    expect(a[5]).toMatchObject({ kind: "result", from: "splitEscrow" });
  });

  it("input_hash is the sha2_256 prompt digest as vector<u8>", () => {
    const a = plan.createJob.arguments[6];
    expect(a.kind).toBe("vector<u8>");
    if (a.kind === "vector<u8>") {
      expect(a.bytes).toEqual(hexToBytes(inputHashHex));
      expect(a.bytes).toHaveLength(32); // sha2_256 = 32 bytes
    }
  });

  it("escrow split = maxPrice * qty; credit split = qty", () => {
    expect(plan.splitEscrow.amount).toBe(5n);
    expect(plan.splitCredit.qty).toBe(1n);
    expect(plan.splitCredit.fromCreditCoin).toBe("0xCREDIT");
  });
});
