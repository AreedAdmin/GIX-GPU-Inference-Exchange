import { describe, expect, it } from "vitest";
import { buildFillJobPlan, TESTNET_DEEP_COIN_TYPE } from "../src/deepbook.js";
import { hexToBytes, sha2_256Hex } from "../src/hash.js";
import type { MarketDeployment } from "../src/types.js";

/**
 * Assert the M2 testnet buy-path PTB plan against contracts/INTERFACE.md §"M2 —
 * DeepBook fill jobs" and the exact PTB in m2-phase0-design.md:
 *
 *   1) deepbook::pool::swap_exact_quote_for_base<Credit<M>, MOCK_USDC>(
 *          pool, usdcIn, deepIn, minBaseOut, clock)
 *        -> (Coin<Credit<M>>, Coin<MOCK_USDC>, Coin<DEEP>)
 *   2) gix::job::create_job_from_fill<M>(cfg, market, provider_rec, credits,
 *          input_blob_id: u256, input_hash: vector<u8>, clk): ID
 *
 * Targets, type-args, and arg ORDER are load-bearing.
 */
const GIX = "0x0ed255b19e62f034d3c38130959bf94e459e48b7fb4296d57ac42b1a34c93f0f";
const DEEPBOOK = "0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c";
const USDC = `${GIX}::mock_usdc::MOCK_USDC`;
const CREDIT_TYPE = `${GIX}::markets::M_H100_LLAMA8B`;
const CREDIT_COIN_TYPE = `${GIX}::credit::Credit<${CREDIT_TYPE}>`;

const market: MarketDeployment = {
  id: "0xMARKET",
  name: "H100-llama3.1-8b-int8",
  creditType: CREDIT_TYPE,
  creditCoinType: CREDIT_COIN_TYPE,
  deepbookPoolId: "0xPOOL",
};

describe("buildFillJobPlan — ABI conformance (contracts/INTERFACE.md §M2)", () => {
  const inputHashHex = sha2_256Hex("what is 2+2?");
  const plan = buildFillJobPlan({
    gixPackageId: GIX,
    deepbookPackageId: DEEPBOOK,
    deepCoinType: TESTNET_DEEP_COIN_TYPE,
    usdcType: USDC,
    configId: "0xCFG",
    clockId: "0x6",
    market,
    poolId: "0xPOOL",
    providerRecordId: "0xPROVREC",
    usdcIn: 5n,
    deepIn: 0n,
    minBaseOut: 1n,
    inputBlobId: 123456789n,
    inputHashHex,
  });

  // --- Command 1: the DeepBook swap -------------------------------------
  it("swap targets deepbook::pool::swap_exact_quote_for_base", () => {
    expect(plan.swap.target).toBe(`${DEEPBOOK}::pool::swap_exact_quote_for_base`);
  });

  it("swap type-args are [Credit<M> (base), MOCK_USDC (quote)]", () => {
    expect(plan.swap.typeArguments).toEqual([CREDIT_COIN_TYPE, USDC]);
  });

  it("swap args = [pool, usdcIn, deepIn, minBaseOut, clk] in order", () => {
    const roles = plan.swap.arguments.map((a) => a.role);
    expect(roles).toEqual([
      "pool",
      "usdc_in: Coin<MOCK_USDC>",
      "deep_in: Coin<DEEP>",
      "min_base_out",
      "clk",
    ]);
    const a = plan.swap.arguments;
    expect(a[0]).toMatchObject({ kind: "object", id: "0xPOOL" });
    expect(a[1]).toMatchObject({ kind: "result", from: "usdcIn" });
    expect(a[2]).toMatchObject({ kind: "result", from: "deepIn" });
    expect(a[3]).toMatchObject({ kind: "u64", value: 1n });
    expect(a[4]).toMatchObject({ kind: "object", id: "0x6" });
  });

  // --- Command 2: create_job_from_fill ----------------------------------
  it("fill targets job::create_job_from_fill", () => {
    expect(plan.createJobFromFill.target).toBe(`${GIX}::job::create_job_from_fill`);
  });

  it("fill type-arg is the Credit<M> witness (M)", () => {
    expect(plan.createJobFromFill.typeArguments).toEqual([CREDIT_TYPE]);
  });

  it("fill args = [cfg, market, provider_rec, credits, input_blob_id, input_hash, clk]", () => {
    const roles = plan.createJobFromFill.arguments.map((a) => a.role);
    expect(roles).toEqual([
      "cfg",
      "market",
      "provider_rec",
      "credits: Coin<Credit<M>>",
      "input_blob_id",
      "input_hash",
      "clk",
    ]);
  });

  it("fill cfg/market/provider_rec/clk are object refs; credits is swap.0 result", () => {
    const a = plan.createJobFromFill.arguments;
    expect(a[0]).toMatchObject({ kind: "object", id: "0xCFG" });
    expect(a[1]).toMatchObject({ kind: "object", id: "0xMARKET" });
    expect(a[2]).toMatchObject({ kind: "object", id: "0xPROVREC" });
    expect(a[3]).toMatchObject({ kind: "result", from: "swap.credit" });
    expect(a[6]).toMatchObject({ kind: "object", id: "0x6" });
  });

  it("input_blob_id is a u256; input_hash is the sha2_256 prompt digest vector<u8>", () => {
    const a = plan.createJobFromFill.arguments;
    expect(a[4]).toMatchObject({ kind: "u256", value: 123456789n });
    const ih = a[5];
    expect(ih.kind).toBe("vector<u8>");
    if (ih.kind === "vector<u8>") {
      expect(ih.bytes).toEqual(hexToBytes(inputHashHex));
      expect(ih.bytes).toHaveLength(32);
    }
  });

  it("returns the USDC + DEEP swap remainders to the consumer", () => {
    expect(plan.returnToConsumer).toEqual({
      usdcRemainder: "swap.1",
      deepRemainder: "swap.2",
    });
  });

  it("pins the testnet DEEP coin type from m2-phase0-design.md / INTERFACE.md", () => {
    expect(TESTNET_DEEP_COIN_TYPE).toBe(
      "0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP",
    );
  });

  it("falls back to a derived Credit<M> base type when creditCoinType is absent", () => {
    const p = buildFillJobPlan({
      gixPackageId: GIX,
      deepbookPackageId: DEEPBOOK,
      deepCoinType: TESTNET_DEEP_COIN_TYPE,
      usdcType: USDC,
      configId: "0xCFG",
      clockId: "0x6",
      market: { id: "0xM", name: "m", creditType: CREDIT_TYPE },
      poolId: "0xPOOL",
      providerRecordId: "0xPROVREC",
      usdcIn: 1n,
      deepIn: 0n,
      minBaseOut: 1n,
      inputBlobId: 0n,
      inputHashHex,
    });
    expect(p.swap.typeArguments[0]).toBe(`${GIX}::credit::Credit<${CREDIT_TYPE}>`);
  });
});
