/**
 * Matcher abstraction.
 *
 * M1 has no real DeepBook (that is M2), so the harness pairs a consumer bid with
 * a provider ask directly and the orchestrator calls `create_job` on the result.
 * Keeping this behind a `Matcher` interface means M2 can drop in a
 * `DeepBookMatcher` that observes real fills without touching the orchestrator.
 */

import type { Ask, Bid, Match } from "../orchestrator/model.js";

export interface Matcher {
  /** Try to pair one bid against the resting asks. Returns null if no fit. */
  match(bid: Bid, asks: readonly Ask[]): Match | null;
}

/**
 * M1 stub: price-time-priority-ish greedy match within the same market.
 *
 * Crossing rule: an ask fills a bid when `ask.price ≤ bid.price` (the consumer is
 * willing to pay at least what the provider asks) and the market matches. Among
 * crossing asks we pick the cheapest (best for the consumer), tie-broken by
 * largest available qty so a single ask can fill more of the bid.
 *
 * The clearing price is the **ask (maker) price** — mirroring DeepBook taker-fill
 * semantics where the resting maker order sets the fill price. Escrow is
 * `qty * clearingPrice` (invariant I2: locked USDC == scu_qty * fill_price).
 */
export class StubMatcher implements Matcher {
  match(bid: Bid, asks: readonly Ask[]): Match | null {
    let best: Ask | null = null;
    for (const ask of asks) {
      if (ask.marketId !== bid.marketId) continue;
      if (ask.qtyScu <= 0) continue;
      if (ask.priceUsdcPerScu > bid.priceUsdcPerScu) continue; // doesn't cross
      if (
        best === null ||
        ask.priceUsdcPerScu < best.priceUsdcPerScu ||
        (ask.priceUsdcPerScu === best.priceUsdcPerScu && ask.qtyScu > best.qtyScu)
      ) {
        best = ask;
      }
    }
    if (!best) return null;

    const qtyScu = Math.min(bid.qtyScu, best.qtyScu);
    const priceUsdcPerScu = best.priceUsdcPerScu; // maker price sets the fill
    return {
      bid,
      ask: best,
      marketId: bid.marketId,
      provider: best.provider,
      consumer: bid.consumer,
      qtyScu,
      priceUsdcPerScu,
      escrowUsdc: qtyScu * priceUsdcPerScu,
    };
  }
}
