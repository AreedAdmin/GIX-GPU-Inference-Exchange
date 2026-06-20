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
import { WalrusHelper } from "./walrus.js";
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
   * verified completion. Network-switched:
   *   - testnet → DeepBook buy (`swap_exact_quote_for_base` → create_job_from_fill,
   *     one PTB) + Walrus for input/output blobs (Option B, pay-at-match).
   *   - otherwise (localnet) → the M1 escrow path (POST /inputs → create_job →
   *     await → GET /result → verify).
   */
  async runTask(args: RunTaskArgs): Promise<RunTaskResult> {
    if (!args.prompt || args.prompt.length === 0) {
      throw new Error("runTask: prompt is required");
    }
    if ((this.opts.deployment.network ?? "localnet") === "testnet") {
      return this.runTaskTestnet(args);
    }
    return this.runTaskLocalnet(args);
  }

  /** The M1 localnet path: provider `/inputs` + escrow `create_job` + `/result`. */
  private async runTaskLocalnet(args: RunTaskArgs): Promise<RunTaskResult> {
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

  /**
   * The M2 testnet path (Option B, pay-at-match):
   *   1. Upload the prompt to Walrus → {blobId(u256), inputHash}.
   *   2. Buy via DeepBook in ONE PTB: swap_exact_quote_for_base (USDC→Credit)
   *      → create_job_from_fill (NO escrow; the maker/provider is paid at the
   *      fill). Returns leftover USDC/DEEP to the consumer.
   *   3. Await the job's terminal event (the node attests + settles via
   *      settle_fill / resolve_fill).
   *   4. Download the output from Walrus by the job's `output_blob_id` and
   *      verify the bytes against the on-chain output_hash (sha2_256). Falls
   *      back to the provider `/result` when no output blob was recorded.
   */
  private async runTaskTestnet(args: RunTaskArgs): Promise<RunTaskResult> {
    const market = this.resolveMarket(args.market);
    const scuQty = BigInt(args.scuQty ?? 1);
    if (args.maxPriceUsdcPerScu <= 0) throw new Error("runTask: maxPriceUsdcPerScu must be > 0");
    const usdcIn = BigInt(args.maxPriceUsdcPerScu) * scuQty;

    const fill = this.opts.fill ?? {};
    const poolId = fill.poolId ?? market.deepbookPoolId ?? undefined;
    if (!poolId) {
      throw new Error(
        "runTask(testnet): no DeepBook pool id (set options.fill.poolId or " +
          "deployment.markets[].deepbookPoolId — governance must bind it via set_deepbook_pool_id)",
      );
    }
    const providerRecordId =
      fill.providerRecordId ?? this.opts.deployment.accounts?.providerRecords?.[0];
    if (!providerRecordId) {
      throw new Error(
        "runTask(testnet): no provider ProviderRecord id (set options.fill.providerRecordId or " +
          "deployment.accounts.providerRecords[0])",
      );
    }
    if (!this.opts.walrusSigner) {
      throw new Error(
        "runTask(testnet): a walrusSigner (a @mysten/sui Signer/Keypair) is required to upload the prompt to Walrus",
      );
    }

    const timeoutMs = this.opts.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
    const walrus = new WalrusHelper({
      network: "testnet",
      suiClient: await this.chain.suiClient(),
      epochs: fill.walrusEpochs,
      logger: this.opts.logger,
    });

    // 1. Upload the prompt to Walrus (commitment + input_hash).
    const up = await walrus.uploadInput(args.prompt, this.opts.walrusSigner);
    this.log("walrus input uploaded", { blobId: up.blobId, inputHash: up.inputHash });

    // 2. Buy via DeepBook → create_job_from_fill (one atomic PTB, no escrow).
    const { jobId, digest } = await this.chain.createJobFromFill({
      signer: this.opts.signer,
      market,
      providerRecordId,
      poolId,
      usdcIn,
      deepIn: fill.deepIn,
      minBaseOut: fill.minBaseOut ?? scuQty,
      inputBlobId: up.blobIdU256,
      inputHashHex: up.inputHash,
    });
    this.log("fill job created", { jobId, digest });

    // 3. Await the job's terminal event (node attests + settles).
    const terminal = await this.chain.awaitSettlement(jobId, { timeoutMs });
    this.log("job terminal", { state: terminal.state, verdict: terminal.verdict });

    // 4. Download + verify the output from Walrus by the job's output_blob_id.
    const onChainOutputHash = terminal.outputHashOnChain;
    let output = "";
    let verified = false;
    let outputBlobId: string | undefined;
    const outputBlobU256 = await this.chain.jobOutputBlobId(jobId);
    if (outputBlobU256 !== 0n && onChainOutputHash) {
      const dl = await walrus.downloadAndVerify(outputBlobU256, onChainOutputHash);
      output = dl.output;
      verified = dl.verified;
      outputBlobId = String(outputBlobU256);
      this.log("walrus output verified", { verified, outputBlobId });
    } else {
      // Fallback: the provider may still serve /result (no Walrus output blob).
      const result = await this.provider.awaitResult(jobId, { timeoutMs });
      output = result.output;
      verified = verifyOutput(result.output, onChainOutputHash ?? result.outputHash);
      this.log("provider result fallback", { verified });
    }

    return {
      output,
      jobId,
      digest,
      verified,
      payoutUsdc: terminal.payoutUsdc,
      inputBlobId: up.blobId,
      outputBlobId,
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
