/**
 * DeepBook buy-path plan — the M2 testnet settlement rail (Option B, pay-at-match).
 *
 * Builds the pure, SDK-object-free description of the atomic PTB
 *   1) deepbook::pool::swap_exact_quote_for_base<Credit<M>, MOCK_USDC>(...)
 *        -> (Coin<Credit<M>>, Coin<MOCK_USDC>, Coin<DEEP>)
 *   2) gix::job::create_job_from_fill<M>(cfg, market, providerRec, credits,
 *        input_blob_id: u256, input_hash: vector<u8>, clk)   // NO escrow
 *
 * The two commands compose in ONE consumer-signed PTB: the swap returns LOOSE
 * coins the next command consumes (the resting maker — the provider — is paid
 * USDC at the fill). See contracts/INTERFACE.md §"M2 — DeepBook fill jobs" and
 * docs/m2-phase0-design.md (Option B).
 *
 * Kept pure (no @mysten/* objects at module load) so the load-bearing argument
 * construction — targets, type-args, arg ORDER vs INTERFACE.md — is unit-tested.
 * `GixChain.createJobFromFill` materializes this plan into a live Transaction.
 */

import { hexToBytes } from "./hash.js";
import type { MarketDeployment } from "./types.js";

/** DeepBook testnet package id + DEEP coin type, read from
 * `@mysten/deepbook-v3` testnet constants (NOT in the bundled docs). Surfaced
 * here as a typed shape so the plan builder stays pure; the live values are
 * resolved by `loadDeepbookTestnetConstants()` (dynamic import). */
export interface DeepbookTestnetConstants {
  /** `testnetPackageIds.DEEPBOOK_PACKAGE_ID`. */
  packageId: string;
  /** `testnetCoins.DEEP.type` = `0x36dbef86…::deep::DEEP`. */
  deepCoinType: string;
}

/** The canonical testnet DEEP coin type (pinned, per docs/m2-phase0-design.md +
 * INTERFACE.md). Used as a fallback assertion target in tests. */
export const TESTNET_DEEP_COIN_TYPE =
  "0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP";

/**
 * Load the DeepBook testnet package id + DEEP coin type from the
 * `@mysten/deepbook-v3` package constants. Dynamically imported so the SDK
 * stays hermetic until the testnet buy-path actually runs.
 */
export async function loadDeepbookTestnetConstants(): Promise<DeepbookTestnetConstants> {
  const { testnetPackageIds, testnetCoins } = await import("@mysten/deepbook-v3");
  return {
    packageId: testnetPackageIds.DEEPBOOK_PACKAGE_ID,
    deepCoinType: testnetCoins.DEEP.type,
  };
}

/** A declarative move-call description (mirrors chain.ts `MoveCallPlan`). */
export interface FillMoveCall {
  target: string;
  typeArguments: string[];
  arguments: FillArg[];
}

export type FillArg =
  | { kind: "object"; id: string; role: string }
  | { kind: "u64"; value: bigint; role: string }
  | { kind: "u256"; value: bigint; role: string }
  | { kind: "vector<u8>"; bytes: number[]; role: string }
  | { kind: "result"; from: string; role: string }; // a prior PTB command output

/**
 * The full two-command fill PTB plan: the DeepBook swap and the GIX fill-job,
 * plus the leftover coins the executor must hand back to the consumer.
 */
export interface FillJobPlan {
  /** DeepBook `swap_exact_quote_for_base` — pays the maker, returns 3 coins. */
  swap: FillMoveCall;
  /** GIX `create_job_from_fill` — consumes the swap's Credit output, no escrow. */
  createJobFromFill: FillMoveCall;
  /** Names of the swap outputs to transfer back to the consumer (USDC + DEEP
   * remainder). The Credit output is consumed by the fill job. */
  returnToConsumer: { usdcRemainder: "swap.1"; deepRemainder: "swap.2" };
}

/**
 * Build the DeepBook-swap → create_job_from_fill plan, purely from ids/amounts.
 *
 * Command 1 (DeepBook v3 — matches `swap_exact_quote_for_base`'s on-chain ABI,
 * confirmed against `@mysten/deepbook-v3` transactions/deepbook.ts):
 *   target    = `${deepbookPkg}::pool::swap_exact_quote_for_base`
 *   typeArgs  = [ Credit<M> (base), MOCK_USDC (quote) ]
 *   args      = [ pool, usdcIn: Coin<MOCK_USDC>, deepIn: Coin<DEEP>,
 *                 minBaseOut: u64, clock ]
 *   returns   = (Coin<Credit<M>>, Coin<MOCK_USDC>, Coin<DEEP>)
 *
 * Command 2 (GIX — contracts/INTERFACE.md §M2):
 *   create_job_from_fill<M>(cfg, market, provider_rec, credits, input_blob_id,
 *     input_hash, clk, ctx): ID
 *   typeArgs  = [ M ]   (the Credit<M> witness, = market.creditType)
 *   args      = [ cfg, market, providerRec, credits (← swap.0), input_blob_id:u256,
 *                 input_hash:vector<u8>, clk ]
 */
export function buildFillJobPlan(args: {
  /** GIX package id (deployment.packageId). */
  gixPackageId: string;
  /** DeepBook testnet package id (testnetPackageIds.DEEPBOOK_PACKAGE_ID). */
  deepbookPackageId: string;
  /** DEEP coin type (testnetCoins.DEEP.type). */
  deepCoinType: string;
  /** MOCK_USDC coin type (deployment.usdcType). */
  usdcType: string;
  configId: string;
  clockId: string;
  market: MarketDeployment;
  /** The shared `Pool<Credit<M>, MOCK_USDC>` object id — from
   * `market::deepbook_pool_id` / deployment.markets[].deepbookPoolId. */
  poolId: string;
  /** The single market provider's shared ProviderRecord id (M2 demo). */
  providerRecordId: string;
  /** USDC the consumer spends on the swap (base units, 6dp). */
  usdcIn: bigint;
  /** DEEP the consumer spends on the swap fee (DEEP base units; 0 ⇒ input-token fee). */
  deepIn: bigint;
  /** Minimum Credit<M> base out (slippage floor); SCU base units. */
  minBaseOut: bigint;
  /** Walrus input-blob commitment (u256; 0 = none). */
  inputBlobId: bigint;
  /** sha2_256(prompt) hex (the verification primitive). */
  inputHashHex: string;
}): FillJobPlan {
  const baseType = args.market.creditCoinType ??
    `${args.gixPackageId}::credit::Credit<${args.market.creditType}>`;

  return {
    swap: {
      target: `${args.deepbookPackageId}::pool::swap_exact_quote_for_base`,
      // base = Credit<M>, quote = MOCK_USDC (the quote-for-base direction).
      typeArguments: [baseType, args.usdcType],
      arguments: [
        { kind: "object", id: args.poolId, role: "pool" },
        { kind: "result", from: "usdcIn", role: "usdc_in: Coin<MOCK_USDC>" },
        { kind: "result", from: "deepIn", role: "deep_in: Coin<DEEP>" },
        { kind: "u64", value: args.minBaseOut, role: "min_base_out" },
        { kind: "object", id: args.clockId, role: "clk" },
      ],
    },
    createJobFromFill: {
      target: `${args.gixPackageId}::job::create_job_from_fill`,
      typeArguments: [args.market.creditType],
      arguments: [
        { kind: "object", id: args.configId, role: "cfg" },
        { kind: "object", id: args.market.id, role: "market" },
        { kind: "object", id: args.providerRecordId, role: "provider_rec" },
        { kind: "result", from: "swap.credit", role: "credits: Coin<Credit<M>>" },
        { kind: "u256", value: args.inputBlobId, role: "input_blob_id" },
        { kind: "vector<u8>", bytes: hexToBytes(args.inputHashHex), role: "input_hash" },
        { kind: "object", id: args.clockId, role: "clk" },
      ],
    },
    returnToConsumer: { usdcRemainder: "swap.1", deepRemainder: "swap.2" },
  };
}
