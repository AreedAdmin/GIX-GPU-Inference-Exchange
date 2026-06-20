/**
 * Provider and consumer actor state.
 *
 * Providers: faucet MOCK_USDC → stake (USDC bond) → mint_credits → post asks.
 * Consumers: hash a synthetic prompt → post bids.
 *
 * In dry-run these are pure in-memory records; on chain the orchestrator maps
 * each to a keypair / ProviderStake / Credit<M> coin and submits PTBs.
 */

import type { Scenario } from "../config/types.js";
import type { Ask, Bid } from "../orchestrator/model.js";
import { hashHex } from "./attestation.js";
import type { Rng } from "../util/rng.js";

export interface ProviderActor {
  address: string;
  /** Posted USDC bond (base units). */
  bondUsdc: number;
  capacityScu: number;
  /** Credits minted per market (key = marketId). */
  mintedScu: number;
  /** Currently-reserved SCU across in-flight jobs (reserve-then-burn, L1). */
  reservedScu: number;
  /** Lifetime USDC slashed from the bond. */
  slashedUsdc: number;
  /** Lifetime fault count (drives the −10% de-rating, decision B5). */
  faultCount: number;
}

export interface ConsumerActor {
  address: string;
  /** Remaining USDC budget (base units), decremented as escrow locks. */
  budgetUsdc: number;
}

export function makeProviders(scenario: Scenario, addresses: string[]): ProviderActor[] {
  const p = scenario.providers;
  return addresses.slice(0, p.count).map((address) => ({
    address,
    bondUsdc: p.bondUsdc,
    capacityScu: p.capacityScu,
    mintedScu: p.mintCreditsScu,
    reservedScu: 0,
    slashedUsdc: 0,
    faultCount: 0,
  }));
}

export function makeConsumers(scenario: Scenario, addresses: string[]): ConsumerActor[] {
  const c = scenario.consumers;
  return addresses.slice(0, c.count).map((address) => ({
    address,
    budgetUsdc: c.budgetUsdc,
  }));
}

/** A monotonically-increasing prompt corpus so each bid hashes to a unique ref. */
const PROMPTS = [
  "Summarize the quarterly earnings call in three bullet points.",
  "Translate this paragraph to French.",
  "Write a unit test for a binary search.",
  "Explain transformer attention to a five year old.",
  "Refactor this function for readability.",
  "Generate a SQL query for monthly active users.",
  "Draft a polite follow-up email.",
  "Classify the sentiment of this review.",
];

/** Build a consumer bid with a hashed synthetic prompt as the input ref. */
export function makeBid(args: {
  id: string;
  consumer: ConsumerActor;
  marketId: string;
  qtyScu: number;
  priceUsdcPerScu: number;
  rng: Rng;
  nonce: number;
}): Bid {
  const prompt = `${args.rng.pick(PROMPTS)} [#${args.nonce}]`;
  return {
    id: args.id,
    consumer: args.consumer.address,
    marketId: args.marketId,
    qtyScu: args.qtyScu,
    priceUsdcPerScu: args.priceUsdcPerScu,
    inputHash: hashHex(prompt),
  };
}

/** Post a provider ask, sized to the provider's free (unreserved) capacity. */
export function makeAsk(args: {
  id: string;
  provider: ProviderActor;
  marketId: string;
  priceUsdcPerScu: number;
}): Ask {
  const free = Math.max(0, args.provider.mintedScu - args.provider.reservedScu);
  return {
    id: args.id,
    provider: args.provider.address,
    marketId: args.marketId,
    qtyScu: free,
    priceUsdcPerScu: args.priceUsdcPerScu,
  };
}
