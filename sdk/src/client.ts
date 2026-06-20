/**
 * GixClient — the consumer SDK entrypoint.
 *
 * runTask(): POST prompt → /inputs (inputHash) → create_job (funds MOCK_USDC
 * escrow) → await Settled/Attested event → GET /result/:jobId → re-hash output
 * (sha2_256) and compare to the on-chain output_hash → set `verified`.
 * (demo-milestone-contract §4.)
 */

import { GixChain } from "./chain.js";
import { hexEquals, sha2_256Bytes, sha2_256Hex } from "./hash.js";
import { ProviderClient } from "./provider.js";
import type {
  Balances,
  GixClientOptions,
  MarketDeployment,
  MarketInfo,
  RunTaskArgs,
  RunTaskResult,
} from "./types.js";

const DEFAULT_SETTLE_TIMEOUT_MS = 120_000;

export class GixClient {
  private readonly opts: GixClientOptions;
  private readonly provider: ProviderClient;
  private readonly chain: GixChain;

  constructor(opts: GixClientOptions) {
    this.opts = opts;
    this.provider = new ProviderClient(opts.providerUrl, opts.fetchImpl);
    this.chain = new GixChain(opts.deployment, {
      rpcUrl: opts.rpcUrl,
      logger: opts.logger
        ? (m, x) => opts.logger!(m, x as Record<string, unknown>)
        : undefined,
    });
  }

  private log(m: string, meta?: Record<string, unknown>) {
    this.opts.logger?.(m, meta);
  }

  /** Markets exposed by the deployment (surfaced as OpenAI "models" by the gateway). */
  markets(): MarketInfo[] {
    return this.opts.deployment.markets.map((m) => ({
      id: m.id,
      name: m.name,
      creditType: m.creditType,
      scuTokens: m.scuTokens,
      slaP99Ms: m.slaP99Ms,
    }));
  }

  /** The signer's MOCK_USDC + SUI balances. */
  async balances(): Promise<Balances> {
    const address = this.opts.signer.toSuiAddress();
    const [usdc, sui] = await Promise.all([
      this.chain.usdcBalance(address),
      this.chain.suiBalance(address),
    ]);
    return { address, usdc, sui };
  }

  /** Resolve a market by id or by name. */
  private resolveMarket(marketRef: string): MarketDeployment {
    const m =
      this.opts.deployment.markets.find((x) => x.id === marketRef) ??
      this.opts.deployment.markets.find((x) => x.name === marketRef);
    if (!m) {
      const known = this.opts.deployment.markets.map((x) => x.name).join(", ");
      throw new Error(`runTask: unknown market "${marketRef}" (known: ${known || "none"})`);
    }
    return m;
  }

  /**
   * The headline flow: buy on-chain compute for a prompt and return the
   * verified completion. See class doc for the step ordering.
   */
  async runTask(args: RunTaskArgs): Promise<RunTaskResult> {
    if (!args.prompt || args.prompt.length === 0) {
      throw new Error("runTask: prompt is required");
    }
    const market = this.resolveMarket(args.market);
    const provider = this.opts.provider ?? this.opts.deployment.accounts?.providers?.[0];
    if (!provider) {
      throw new Error("runTask: no provider configured (set options.provider or deployment.accounts.providers)");
    }
    const scuQty = BigInt(args.scuQty ?? 1);
    if (args.maxPriceUsdcPerScu <= 0) throw new Error("runTask: maxPriceUsdcPerScu must be > 0");
    const escrowUsdc = BigInt(args.maxPriceUsdcPerScu) * scuQty;

    // 1. Submit the prompt to the provider; it caches by hash, returns inputHash.
    const { inputHash } = await this.provider.submitInput(args.prompt);
    // Defensively confirm the node's hash matches our local sha2_256(prompt). If
    // the node returns a different hash we trust the node's value for create_job
    // (it's what it indexes by) but flag the mismatch.
    const localInputHash = sha2_256Hex(args.prompt);
    if (!hexEquals(inputHash, localInputHash)) {
      this.log("warning: provider inputHash != local sha2_256(prompt)", {
        providerHash: inputHash,
        localHash: localInputHash,
      });
    }
    this.log("input submitted", { inputHash });

    // 2. create_job: fund MOCK_USDC escrow, reserve provider stake+credits.
    const { jobId, digest } = await this.chain.createJob({
      signer: this.opts.signer,
      market,
      provider,
      scuQty,
      escrowUsdc,
      inputHashHex: inputHash,
    });
    this.log("job created", { jobId, digest });

    // 3. Await the job's terminal event (the node attests + settles).
    const timeoutMs = this.opts.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
    const terminal = await this.chain.awaitSettlement(jobId, { timeoutMs });
    this.log("job terminal", { state: terminal.state, verdict: terminal.verdict });

    // 4. Fetch the result and verify: re-hash output, compare to on-chain hash.
    const result = await this.provider.awaitResult(jobId, { timeoutMs });
    const verified = verifyOutput(result.output, terminal.outputHashOnChain ?? result.outputHash);
    this.log("result fetched", { verified, outputTokens: result.outputTokenCount });

    return {
      output: result.output,
      jobId,
      digest,
      verified,
      payoutUsdc: terminal.payoutUsdc,
      providerPubkey: result.attestPubkey,
    };
  }
}

/**
 * The verifiable-result check (demo-milestone-contract §2): re-hash the output
 * with sha2_256 and compare (hex-tolerant) to the on-chain output_hash. Exported
 * for direct unit testing.
 */
export function verifyOutput(output: string, onChainHashHex: string): boolean {
  const recomputed = sha2_256Hex(output);
  return hexEquals(recomputed, onChainHashHex);
}

export { sha2_256Bytes, sha2_256Hex };
