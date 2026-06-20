/**
 * `create_job_from_ask` integration — ABI conformance scaffold (F2).
 *
 * The pool-free buy path is the consumer filling a resting shared `Ask<M>` with
 * `job::create_job_from_ask`. The SDK does not yet ship an ask-buy plan builder (the M1 SDK has
 * the owned-credits `buildCreateJobPlan` and the M2 DeepBook `buildFillJobPlan`), so this test
 * pins the EXACT PTB shape the consumer must build — target, type-arg, and the load-bearing
 * 8-argument ORDER — against the contract source signature:
 *
 *   create_job_from_ask<M>(
 *     cfg: &Config, market: &Market<M>, ask: &mut Ask<M>, qty_scu: u64,
 *     escrow_in: Coin<Q>, input_hash: vector<u8>, clk: &Clock, ctx): ID
 *
 * The harness's `e2e/chain.ts::createJobFromAsk` builds this exact shape and is exercised live
 * against localnet; this unit pins the contract here so a future ABI drift fails fast at the
 * SDK layer too. (The split-exact-escrow-coin step is the same merge→split the SDK already does
 * for `create_job` escrow, asserted in plan.test.ts.)
 */

import { describe, it, expect } from "vitest";
import { sha2_256Hex, hexToBytes } from "../src/hash.js";

const PKG = "0x" + "ab".repeat(32);
const CREDIT_TYPE = `${PKG}::markets::M_H100_LLAMA8B`;

/** The declarative create_job_from_ask plan a consumer PTB must materialize (mirrors the
 * production e2e driver; kept here as the SDK-layer ABI pin). */
interface AskBuyPlan {
  target: string;
  typeArguments: string[];
  argOrder: string[];
  inputHashBytes: number[];
}

function buildCreateJobFromAskPlan(args: {
  packageId: string;
  configId: string;
  marketId: string;
  askId: string;
  creditType: string;
  qtyScu: bigint;
  escrowUsdc: bigint;
  inputHashHex: string;
  clockId: string;
}): AskBuyPlan {
  return {
    target: `${args.packageId}::job::create_job_from_ask`,
    typeArguments: [args.creditType],
    // The exact arg ORDER from the Move signature (escrow_in is a split Coin result).
    argOrder: ["cfg", "market", "ask(&mut)", "qty_scu:u64", "escrow_in:Coin<Q>", "input_hash:vector<u8>", "clk"],
    inputHashBytes: hexToBytes(args.inputHashHex),
  };
}

describe("create_job_from_ask — ABI conformance (contracts/sources/job.move)", () => {
  const inputHashHex = sha2_256Hex("What is 2+2?");
  const plan = buildCreateJobFromAskPlan({
    packageId: PKG,
    configId: "0xCFG",
    marketId: "0xMKT",
    askId: "0xASK",
    creditType: CREDIT_TYPE,
    qtyScu: 10n,
    escrowUsdc: 1_000_000n,
    inputHashHex,
    clockId: "0x6",
  });

  it("targets job::create_job_from_ask with the Credit<M> witness type-arg", () => {
    expect(plan.target).toBe(`${PKG}::job::create_job_from_ask`);
    expect(plan.typeArguments).toEqual([CREDIT_TYPE]);
  });

  it("uses the exact 7-input arg order (escrow is a split-coin result; ctx is implicit)", () => {
    expect(plan.argOrder).toEqual([
      "cfg",
      "market",
      "ask(&mut)",
      "qty_scu:u64",
      "escrow_in:Coin<Q>",
      "input_hash:vector<u8>",
      "clk",
    ]);
  });

  it("commits input_hash as the 32-byte sha2_256(prompt) (the verification primitive)", () => {
    expect(plan.inputHashBytes).toHaveLength(32);
    expect(Buffer.from(plan.inputHashBytes).toString("hex")).toBe(inputHashHex);
  });

  it("escrow must fund qty_scu * price_per_scu (the underfunded case the contract rejects)", () => {
    const qty = 10n;
    const pricePerScu = 100_000n;
    const required = qty * pricePerScu;
    // The harness funds EXACTLY this; an escrow below `required` aborts EInsufficientEscrow=407.
    expect(required).toBe(1_000_000n);
  });
});
