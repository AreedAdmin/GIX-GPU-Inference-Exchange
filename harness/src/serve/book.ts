/**
 * Synthetic order book engine for the `--serve` WS feed.
 *
 * Until M2/DeepBook makes the book real, the trading UI still needs a believable,
 * animated book: resting bids/asks stacked around a drifting mid, with sizes and
 * prices consistent with the scenario's `priceUsdcPerScu` / `qtyScu` distributions.
 * The M1 matcher consumes these resting orders; here we only render them.
 *
 * Per market we keep a mid that random-walks (mean-reverting toward the scenario
 * center) and, on each tick, lay `depth` levels each side at a fixed tick spacing
 * with jittered sizes. A trade print nudges the mid toward the trade price so the
 * book visibly reacts to real fills.
 *
 * Prices/sizes are emitted in the UI contract's units: price = USDC base units
 * (6dp) per SCU, sizeScu = integer SCU. `cumScu` is the running cumulative depth
 * from the inside of the book outward (§3 BookLevel).
 */

import type { Distribution } from "../config/types.js";
import { Rng } from "../util/rng.js";

/** §3 BookLevel — one price level with its size and cumulative depth. */
export interface BookLevel {
  price: number;
  sizeScu: number;
  cumScu: number;
}

/** §4 `book` frame body (without the `t` discriminator). */
export interface BookSnapshot {
  marketId: string;
  bids: BookLevel[];
  asks: BookLevel[];
  ts: number;
}

export interface BookConfig {
  marketId: string;
  /** Center price (USDC base units per SCU) — the distribution mean/center. */
  centerPrice: number;
  /** Typical order size (SCU) — the qty distribution center. */
  typicalQty: number;
  /** Number of price levels per side. */
  depth?: number;
  /** Tick size (USDC base units per SCU) between adjacent levels. */
  tick?: number;
}

/** Center value of a distribution, used to seed the mid + per-level sizes. */
export function distributionCenter(d: Distribution): number {
  switch (d.kind) {
    case "fixed":
      return d.value;
    case "uniform":
      return (d.min + d.max) / 2;
    case "normal":
      return d.mean;
  }
}

/**
 * One market's synthetic book. Deterministic for a fixed seed so a `--serve` run
 * is reproducible alongside the rest of the harness.
 */
export class SyntheticBook {
  private readonly marketId: string;
  private readonly center: number;
  private readonly typicalQty: number;
  private readonly depth: number;
  private readonly tick: number;
  private readonly rng: Rng;

  /** Current drifting mid (USDC base units per SCU). */
  private mid: number;

  constructor(cfg: BookConfig, seed: number) {
    this.marketId = cfg.marketId;
    this.center = Math.max(1, Math.round(cfg.centerPrice));
    this.typicalQty = Math.max(1, Math.round(cfg.typicalQty));
    this.depth = Math.max(1, cfg.depth ?? 12);
    // Default tick ≈ 0.05% of center (min 1 base unit) so the ladder has visible
    // spacing without collapsing to a single price.
    this.tick = Math.max(1, cfg.tick ?? Math.round(this.center * 0.0005));
    this.rng = new Rng(seed);
    this.mid = this.center;
  }

  /** Current mid (USDC base units per SCU). */
  midPrice(): number {
    return this.mid;
  }

  /**
   * Advance the mid one step: a small mean-reverting random walk toward the
   * scenario center, so the book drifts but does not run away.
   */
  drift(): void {
    const stepFrac = (this.rng.next() - 0.5) * 0.004; // ±0.2% per tick
    const revert = (this.center - this.mid) * 0.05; // pull 5% back to center
    this.mid = Math.max(1, Math.round(this.mid * (1 + stepFrac) + revert));
  }

  /** Nudge the mid toward a real trade print so the book reacts to fills. */
  onTradePrice(price: number): void {
    if (price <= 0) return;
    this.mid = Math.max(1, Math.round(this.mid + (price - this.mid) * 0.3));
  }

  /**
   * Lay a fresh ladder of resting bids/asks around the current mid. Levels step
   * outward by `tick`; the half-spread is one tick. Sizes are jittered around the
   * typical qty and grow slightly with depth (a fuller book away from the touch).
   */
  snapshot(ts: number): BookSnapshot {
    const half = this.tick;
    const bids: BookLevel[] = [];
    const asks: BookLevel[] = [];
    let cumBid = 0;
    let cumAsk = 0;
    for (let i = 0; i < this.depth; i++) {
      const bidPrice = Math.max(1, this.mid - half - i * this.tick);
      const askPrice = this.mid + half + i * this.tick;
      const bidSize = this.levelSize(i);
      const askSize = this.levelSize(i + this.depth);
      cumBid += bidSize;
      cumAsk += askSize;
      bids.push({ price: bidPrice, sizeScu: bidSize, cumScu: cumBid });
      asks.push({ price: askPrice, sizeScu: askSize, cumScu: cumAsk });
    }
    return { marketId: this.marketId, bids, asks, ts };
  }

  /** Jittered size for a level: typical qty × [0.5, 2.0], growing with depth. */
  private levelSize(levelHint: number): number {
    const growth = 1 + (levelHint % this.depth) * 0.12;
    const jitter = 0.5 + this.rng.next() * 1.5;
    return Math.max(1, Math.round(this.typicalQty * jitter * growth));
  }
}
