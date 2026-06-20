/**
 * Deterministic, seedable PRNG (mulberry32) + distribution sampling.
 *
 * Determinism matters: a seeded run lets unit tests assert exact fault counts
 * and lets a demo reproduce the same order flow on every invocation.
 */

import type { Distribution } from "../config/types.js";

export class Rng {
  private state: number;

  constructor(seed = 0x9e3779b9) {
    // Force into uint32 range; avoid a zero state which mulberry32 dislikes.
    this.state = (seed >>> 0) || 0x9e3779b9;
  }

  /** Next float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    if (max < min) [min, max] = [max, min];
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Uniformly pick one element. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("Rng.pick: empty array");
    return items[this.int(0, items.length - 1)]!;
  }

  /** Standard normal via Box–Muller. */
  private gaussian(): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Sample a `Distribution`, rounded to an integer (SCU/USDC are integers). */
  sample(d: Distribution): number {
    switch (d.kind) {
      case "fixed":
        return Math.round(d.value);
      case "uniform":
        return Math.round(d.min + this.next() * (d.max - d.min));
      case "normal": {
        let x = d.mean + this.gaussian() * d.stddev;
        if (d.min !== undefined) x = Math.max(d.min, x);
        if (d.max !== undefined) x = Math.min(d.max, x);
        return Math.round(x);
      }
    }
  }
}
