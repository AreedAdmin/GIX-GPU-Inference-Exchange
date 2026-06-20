/**
 * node-state.json — the node's discovery artifact for the EXTERNAL consumer (E3).
 *
 * After the node registers, stakes, and posts a resting shared `Ask<M>`, it writes the
 * Ask object id + its public HTTP endpoint here so the consumer client (running on a
 * different machine, with a different wallet) can discover what to buy and where to
 * POST /inputs + GET /result — without any provider-owned object or out-of-band coordination.
 *
 * This is the two-machine demo's "order-book index" in miniature: one provider, one Ask.
 * The consumer's `job::create_job_from_ask<M>` targets `askId` in `market` (= `marketId`),
 * funding `escrow_in >= askQtyScu * priceUsdcPerScu`.
 *
 * Re-written on every (re-)post so it always reflects the current resting Ask + remaining_scu.
 */

import { writeFileSync } from "node:fs";

export interface NodeState {
  /** Sui network from deployment.json (localnet/testnet/...). */
  network: string;
  /** gix package id (so the consumer builds the right move target). */
  packageId: string;
  /** Shared Config object id. */
  configId: string;
  /** Clock object id. */
  clockId: string;
  /** MOCK_USDC coin type the escrow must be funded in. */
  usdcType: string;
  /** Market<M> object id the Ask + Job live in. */
  marketId: string;
  /** Type-arg M (creditType) for create_job_from_ask<M>. */
  creditType: string;
  /** The provider (= Ask/Job `provider`, payout/slash target). */
  provider: string;
  /** Provider's registered + advertised public HTTP endpoint (where /inputs + /result live). */
  publicEndpoint: string;
  /** The shared Ask<M> object id the consumer fills against (undefined until posted). */
  askId?: string;
  /** Per-SCU price quoted on the Ask (USDC base units). */
  priceUsdcPerScu: number;
  /** SCU offered on the (most recent) Ask post. */
  askQtyScu: number;
  /** Last-observed remaining_scu on the resting Ask (refreshed by the top-up loop). */
  remainingScu?: number;
  /** ISO timestamp this file was last written. */
  updatedAt: string;
}

/** Atomically write node-state.json (the consumer polls/reads this to discover the Ask). */
export function writeNodeState(path: string, state: NodeState): void {
  const body = { ...state, updatedAt: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(body, null, 2) + "\n", { encoding: "utf8", mode: 0o644 });
}
