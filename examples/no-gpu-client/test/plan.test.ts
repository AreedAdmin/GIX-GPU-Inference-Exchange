import { describe, expect, it } from "vitest";
import {
  buildCreateJobFromAskPlan,
  buildCreateJobFromFillPlan,
  escrowFor,
} from "../src/chain.js";
import { hexToBytes, sha2_256Hex } from "../src/hash.js";

/**
 * Assert the create_job_from_ask PTB plan against contracts/README.md:
 *   job::create_job_from_ask<M>(
 *     cfg, market: &Market<M>, ask: &mut Ask<M>, qty_scu: u64,
 *     escrow_in: Coin<MOCK_USDC>, input_hash: vector<u8>, clk: &Clock, ctx): ID
 * Target, type-arg (the Credit<M> witness), arg ORDER, and the escrow math are
 * load-bearing. The consumer NEVER references a provider-owned object.
 */
const PKG = "0x107495d41e26ae42f3345b94fc448ad77f6f3e8d1072a096dcaf7cb558eff7e3";
const CREDIT_TYPE = `${PKG}::markets::M_H100_LLAMA8B`;

const inputHashHex = sha2_256Hex("What is the capital of France?");
const plan = buildCreateJobFromAskPlan({
  packageId: PKG,
  configId: "0xCFG",
  marketId: "0xMARKET",
  askId: "0xASK",
  creditType: CREDIT_TYPE,
  clockId: "0x6",
  scuQty: 2n,
  pricePerScu: 5n,
  inputHashHex,
});

describe("create_job_from_ask PTB plan (two-account buy)", () => {
  it("targets job::create_job_from_ask", () => {
    expect(plan.createJob.target).toBe(`${PKG}::job::create_job_from_ask`);
  });

  it("passes the Credit<M> witness as the sole type-arg", () => {
    expect(plan.createJob.typeArguments).toEqual([CREDIT_TYPE]);
  });

  it("has exactly 7 PTB-visible args in the contract order", () => {
    // ctx is implicit; contracts/README.md lists 8 params including ctx.
    const roles = plan.createJob.arguments.map((a) => a.role);
    expect(roles).toEqual([
      "cfg",
      "market: &Market<M>",
      "ask: &mut Ask<M>",
      "qty_scu",
      "escrow_in: Coin<MOCK_USDC>",
      "input_hash",
      "clk",
    ]);
  });

  it("cfg/market/ask/clk are object refs to the right ids", () => {
    const a = plan.createJob.arguments;
    expect(a[0]).toMatchObject({ kind: "object", id: "0xCFG" });
    expect(a[1]).toMatchObject({ kind: "object", id: "0xMARKET" });
    expect(a[2]).toMatchObject({ kind: "object", id: "0xASK" });
    expect(a[6]).toMatchObject({ kind: "object", id: "0x6" });
  });

  it("qty_scu is a pure u64; escrow is the PTB split result", () => {
    const a = plan.createJob.arguments;
    expect(a[3]).toMatchObject({ kind: "u64", value: 2n });
    expect(a[4]).toMatchObject({ kind: "result", from: "splitEscrow" });
  });

  it("input_hash is the sha2_256 prompt digest as a 32-byte vector<u8>", () => {
    const a = plan.createJob.arguments[5]!;
    expect(a.kind).toBe("vector<u8>");
    if (a.kind === "vector<u8>") {
      expect(a.bytes).toEqual(hexToBytes(inputHashHex));
      expect(a.bytes).toHaveLength(32);
    }
  });

  it("NEVER references a provider-owned object (no stake / cap / provider addr)", () => {
    const roles = plan.createJob.arguments.map((a) => a.role).join(" ");
    expect(roles).not.toMatch(/ProviderStake|ProviderCap|provider/i);
  });

  it("escrow = qty_scu * price_usdc_per_scu (>= contract minimum)", () => {
    expect(plan.splitEscrow.amount).toBe(2n * 5n);
    expect(plan.splitEscrow.amount).toBe(escrowFor(2n, 5n));
  });

  it("escrowFor multiplies qty by per-SCU price", () => {
    expect(escrowFor(1n, 1n)).toBe(1n);
    expect(escrowFor(3n, 7n)).toBe(21n);
    expect(escrowFor(1000n, 1000n)).toBe(1_000_000n);
  });
});

/**
 * Assert the M2 create_job_from_fill PTB plan against contracts/README.md:
 *   job::create_job_from_fill<M>(
 *     cfg, market: &Market<M>, provider_rec: &ProviderRecord,
 *     credits: Coin<Credit<M>>, input_blob_id: u256, input_hash: vector<u8>,
 *     clk: &Clock, ctx): ID
 * The credits arg is the DeepBook swap output (a PTB result); there is NO escrow
 * coin (Option B / pay-at-match — the provider was paid USDC at the fill).
 */
const fillBlobId = 123456789012345678901234567890n;
const fillPlan = buildCreateJobFromFillPlan({
  packageId: PKG,
  configId: "0xCFG",
  marketId: "0xMARKET",
  providerRecordId: "0xREC",
  creditType: CREDIT_TYPE,
  clockId: "0x6",
  inputBlobId: fillBlobId,
  inputHashHex,
});

describe("create_job_from_fill PTB plan (M2 DeepBook fill)", () => {
  it("targets job::create_job_from_fill", () => {
    expect(fillPlan.createJob.target).toBe(`${PKG}::job::create_job_from_fill`);
  });

  it("passes the Credit<M> witness as the sole type-arg", () => {
    expect(fillPlan.createJob.typeArguments).toEqual([CREDIT_TYPE]);
  });

  it("has exactly 7 PTB-visible args in the contract order", () => {
    const roles = fillPlan.createJob.arguments.map((a) => a.role);
    expect(roles).toEqual([
      "cfg",
      "market: &Market<M>",
      "provider_rec: &ProviderRecord",
      "credits: Coin<Credit<M>>",
      "input_blob_id",
      "input_hash",
      "clk",
    ]);
  });

  it("cfg/market/provider_rec/clk are object refs to the right ids", () => {
    const a = fillPlan.createJob.arguments;
    expect(a[0]).toMatchObject({ kind: "object", id: "0xCFG" });
    expect(a[1]).toMatchObject({ kind: "object", id: "0xMARKET" });
    expect(a[2]).toMatchObject({ kind: "object", id: "0xREC" });
    expect(a[6]).toMatchObject({ kind: "object", id: "0x6" });
  });

  it("credits is the DeepBook swap PTB result (no escrow coin)", () => {
    const a = fillPlan.createJob.arguments;
    expect(a[3]).toMatchObject({ kind: "result", from: "swapCredits" });
    // NO escrow coin anywhere — Option B pays the provider at the swap.
    const roles = a.map((x) => x.role).join(" ");
    expect(roles).not.toMatch(/escrow/i);
  });

  it("input_blob_id is a u256 Walrus commitment", () => {
    const a = fillPlan.createJob.arguments[4]!;
    expect(a.kind).toBe("u256");
    if (a.kind === "u256") expect(a.value).toBe(fillBlobId);
  });

  it("input_hash is the sha2_256 prompt digest as a 32-byte vector<u8>", () => {
    const a = fillPlan.createJob.arguments[5]!;
    expect(a.kind).toBe("vector<u8>");
    if (a.kind === "vector<u8>") {
      expect(a.bytes).toEqual(hexToBytes(inputHashHex));
      expect(a.bytes).toHaveLength(32);
    }
  });
});
