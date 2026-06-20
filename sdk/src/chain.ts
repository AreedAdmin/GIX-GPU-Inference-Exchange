/**
 * GixChain — the consumer-side on-chain client.
 *
 * MIRRORS the verified PTB logic in `harness/src/chain/sui.ts` (workstream B),
 * narrowed to what the consumer does:
 *   - create_job<M>(cfg, market, stake, provider, credits, escrow_in, input_hash, clk, ctx): ID
 *   - await the job's AttestationSubmitted / Settled event (the node attests + settles)
 *   - read MOCK_USDC + SUI balances, list markets.
 *
 * It does NOT submit attestations or settle — the provider node does that
 * (demo-milestone-contract §3/§4). The consumer funds escrow at create_job and
 * watches for terminal events.
 *
 * Hermetic by design: nothing imports @mysten/sui at module load; the SDK is
 * dynamically imported the first time `connect()` runs. The pure PTB plan
 * (`buildCreateJobPlan`) is exported for unit tests against contracts/README.md.
 *
 * NOTE (integration reconcile): this mirrors sui.ts rather than importing it to
 * keep the SDK a standalone package; the two will be reconciled to one chain lib.
 */

import {
  buildFillJobPlan,
  loadDeepbookTestnetConstants,
} from "./deepbook.js";
import { hexToBytes } from "./hash.js";
import type {
  Deployment,
  MarketDeployment,
  WalletSigner,
} from "./types.js";

type SuiClientT = import("@mysten/sui/jsonRpc").SuiJsonRpcClient;
type TransactionT = import("@mysten/sui/transactions").Transaction;

/** A declarative description of the create_job PTB — the load-bearing argument
 * construction, separated from any live @mysten/sui objects so it can be asserted
 * in unit tests against the ABI in contracts/README.md. */
export interface MoveCallPlan {
  target: string;
  typeArguments: string[];
  /** Ordered, tagged arguments mirroring the move signature arg order. */
  arguments: PlanArg[];
}

export type PlanArg =
  | { kind: "object"; id: string; role: string }
  | { kind: "address"; value: string; role: string }
  | { kind: "vector<u8>"; bytes: number[]; role: string }
  | { kind: "result"; from: string; role: string }; // a prior PTB command output

export interface CreateJobPlan {
  /** The split that carves the exact escrow coin out of the consumer's MOCK_USDC. */
  splitEscrow: { fromMergedPrimary: true; amount: bigint };
  /** The split that carves the credit slice out of the provider's Credit<M> coin. */
  splitCredit: { fromCreditCoin: string; qty: bigint };
  /** The create_job move call. */
  createJob: MoveCallPlan;
}

/**
 * Build the create_job PTB plan purely from ids + amounts (no SDK objects).
 * Arg ORDER and target MUST match `job::create_job<M>` in contracts/README.md:
 *   create_job<M>(cfg, market: &Market<M>, stake: &mut ProviderStake, provider,
 *     credits: Coin<Credit<M>>, escrow_in: Coin<MOCK_USDC>, input_hash, clk, ctx): ID
 */
export function buildCreateJobPlan(args: {
  packageId: string;
  configId: string;
  clockId: string;
  market: MarketDeployment;
  stakeId: string;
  provider: string;
  creditCoinId: string;
  scuQty: bigint;
  escrowUsdc: bigint;
  inputHashHex: string;
}): CreateJobPlan {
  return {
    splitEscrow: { fromMergedPrimary: true, amount: args.escrowUsdc },
    splitCredit: { fromCreditCoin: args.creditCoinId, qty: args.scuQty },
    createJob: {
      target: `${args.packageId}::job::create_job`,
      typeArguments: [args.market.creditType],
      arguments: [
        { kind: "object", id: args.configId, role: "cfg" },
        { kind: "object", id: args.market.id, role: "market" },
        { kind: "object", id: args.stakeId, role: "stake(&mut ProviderStake)" },
        { kind: "address", value: args.provider, role: "provider" },
        { kind: "result", from: "splitCredit", role: "credits: Coin<Credit<M>>" },
        { kind: "result", from: "splitEscrow", role: "escrow_in: Coin<MOCK_USDC>" },
        { kind: "vector<u8>", bytes: hexToBytes(args.inputHashHex), role: "input_hash" },
        { kind: "object", id: args.clockId, role: "clk" },
      ],
    },
  };
}

export interface CreateJobOutcome {
  jobId: string;
  digest: string;
}

export interface TerminalOutcome {
  /** "Settled" | "Refunded" | "Expired" — derived from the observed event. */
  state: "Settled" | "Refunded" | "Expired" | "Attested";
  outputHashOnChain?: string;
  payoutUsdc?: number;
  verdict?: number;
}

/** Default public fullnodes per network (localnet via the SDK's getFullnodeUrl). */
type Network = "localnet" | "devnet" | "testnet" | "mainnet";

export class GixChain {
  private client!: SuiClientT;
  private Transaction!: new () => TransactionT;
  private connected = false;

  private readonly pkg: string;
  private readonly cfgId: string;
  private readonly usdcType: string;
  private readonly clockId: string;

  constructor(
    private readonly deployment: Deployment,
    private readonly opts: { rpcUrl?: string; logger?: (m: string, x?: object) => void },
  ) {
    this.pkg = deployment.packageId;
    this.cfgId = deployment.configId;
    this.usdcType = deployment.usdcType;
    this.clockId = deployment.clockId;
  }

  private log(m: string, x?: object) {
    this.opts.logger?.(m, x);
  }

  /** The connected SuiJsonRpcClient (used to seed the Walrus client). Connects
   * lazily on first call. */
  async suiClient(): Promise<SuiClientT> {
    await this.connect();
    return this.client;
  }

  private async connect(): Promise<void> {
    if (this.connected) return;
    const { SuiJsonRpcClient, getJsonRpcFullnodeUrl } = await import("@mysten/sui/jsonRpc");
    const { Transaction } = await import("@mysten/sui/transactions");
    const network = (this.deployment.network as Network) ?? "localnet";
    const url = this.opts.rpcUrl ?? getJsonRpcFullnodeUrl(network);
    this.client = new SuiJsonRpcClient({ network, url });
    this.Transaction = Transaction as unknown as new () => TransactionT;
    this.connected = true;
  }

  /** Resolve the provider's ProviderStake + Credit<M> coin object ids by owner+type. */
  private async resolveProviderObjects(
    provider: string,
    market: MarketDeployment,
  ): Promise<{ stakeId: string; creditCoinId: string }> {
    const stake = await this.firstOwnedOfType(provider, `${this.pkg}::staking::ProviderStake`);
    if (!stake) {
      throw new Error(
        `create_job: provider ${provider} holds no ProviderStake (provider must stake first)`,
      );
    }
    // Credits are minted as `Coin<Credit<M>>` — the on-chain object type is the
    // 0x2::coin::Coin wrapper, NOT the bare Credit<M> witness. (deployment.json's
    // `creditCoinType` records the inner Credit<M> type; we wrap it here.)
    const innerCredit = market.creditCoinType ?? `${this.pkg}::credit::Credit<${market.creditType}>`;
    const creditCoinType = `0x2::coin::Coin<${innerCredit}>`;
    const credit = await this.firstOwnedOfType(provider, creditCoinType);
    if (!credit) {
      throw new Error(
        `create_job: provider ${provider} holds no ${creditCoinType} (provider must mint credits)`,
      );
    }
    return { stakeId: stake, creditCoinId: credit };
  }

  private async firstOwnedOfType(owner: string, typePrefix: string): Promise<string | undefined> {
    let cursor: string | null | undefined = undefined;
    for (let page = 0; page < 10; page++) {
      const res = await this.client.getOwnedObjects({
        owner,
        cursor: cursor ?? undefined,
        options: { showType: true },
      });
      for (const o of res.data) {
        const t = o.data?.type ?? "";
        if (t.startsWith(typePrefix)) return o.data?.objectId;
      }
      if (!res.hasNextPage) break;
      cursor = res.nextCursor;
    }
    return undefined;
  }

  /**
   * Create the job + fund MOCK_USDC escrow, signed by the configured signer.
   * Returns the new Job id + the create_job tx digest.
   */
  async createJob(args: {
    signer: WalletSigner;
    market: MarketDeployment;
    provider: string;
    scuQty: bigint;
    escrowUsdc: bigint;
    inputHashHex: string;
  }): Promise<CreateJobOutcome> {
    await this.connect();
    const consumer = args.signer.toSuiAddress();
    const { stakeId, creditCoinId } = await this.resolveProviderObjects(args.provider, args.market);

    const tx = new this.Transaction();

    // escrow_in: resolve the consumer's MOCK_USDC coins, merge, split exact escrow.
    const escrowCoin = await this.splitEscrowCoin(tx, consumer, args.escrowUsdc);
    // credits: split the qty slice from the provider's minted Credit<M> coin.
    const [creditSlice] = tx.splitCoins(tx.object(creditCoinId), [tx.pure.u64(args.scuQty)]);

    const plan = buildCreateJobPlan({
      packageId: this.pkg,
      configId: this.cfgId,
      clockId: this.clockId,
      market: args.market,
      stakeId,
      provider: args.provider,
      creditCoinId,
      scuQty: args.scuQty,
      escrowUsdc: args.escrowUsdc,
      inputHashHex: args.inputHashHex,
    });

    // Materialize the plan into a live moveCall. The two `result` args map to the
    // split outputs above; everything else maps 1:1 from the plan.
    tx.moveCall({
      target: plan.createJob.target,
      typeArguments: plan.createJob.typeArguments,
      arguments: plan.createJob.arguments.map((a) => {
        switch (a.kind) {
          case "object":
            return tx.object(a.id);
          case "address":
            return tx.pure.address(a.value);
          case "vector<u8>":
            return tx.pure.vector("u8", a.bytes);
          case "result":
            return a.from === "splitCredit" ? creditSlice : escrowCoin;
        }
      }),
    });

    const res = await this.execute(tx, args.signer);
    const status = res.effects?.status;
    if (status && status.status !== "success") {
      throw new Error(`create_job tx ${res.digest} failed: ${status.error ?? "unknown"}`);
    }
    const jobId = this.firstCreatedOfType(res, `${this.pkg}::job::Job`);
    if (!jobId) throw new Error(`create_job: no Job object created in tx ${res.digest}`);
    this.log("create_job ok", { jobId, digest: res.digest });
    return { jobId, digest: res.digest };
  }

  private async splitEscrowCoin(tx: TransactionT, consumer: string, amount: bigint) {
    const { data } = await this.client.getCoins({ owner: consumer, coinType: this.usdcType });
    if (data.length === 0) {
      throw new Error(
        `create_job: consumer ${consumer} holds no ${this.usdcType} (fund MOCK_USDC first)`,
      );
    }
    const primary = tx.object(data[0]!.coinObjectId);
    if (data.length > 1) {
      tx.mergeCoins(
        primary,
        data.slice(1).map((c) => tx.object(c.coinObjectId)),
      );
    }
    const [coin] = tx.splitCoins(primary, [tx.pure.u64(amount)]);
    return coin;
  }

  // ---- M2 testnet buy-path: DeepBook swap → create_job_from_fill ----------

  /**
   * Resolve the consumer's MOCK_USDC into ONE exact-amount coin to feed the
   * DeepBook swap (`usdc_in`). Same merge-then-split shape as the escrow coin.
   */
  private async splitUsdcInput(tx: TransactionT, consumer: string, amount: bigint) {
    return this.splitEscrowCoin(tx, consumer, amount);
  }

  /**
   * Resolve the consumer's DEEP into ONE exact-amount coin to pay the swap fee,
   * OR a zero coin when `amount == 0` (input-token-fee path / `pay_with_deep:false`).
   */
  private async splitDeepInput(
    tx: TransactionT,
    consumer: string,
    deepCoinType: string,
    amount: bigint,
  ) {
    if (amount === 0n) {
      // No DEEP fee — mint a typed empty Coin<DEEP> (input-token-fee path).
      const [deepZero] = tx.moveCall({
        target: "0x2::coin::zero",
        typeArguments: [deepCoinType],
        arguments: [],
      });
      return deepZero;
    }
    const { data } = await this.client.getCoins({ owner: consumer, coinType: deepCoinType });
    if (data.length === 0) {
      throw new Error(
        `create_job_from_fill: consumer ${consumer} holds no ${deepCoinType} (fund test DEEP first)`,
      );
    }
    const primary = tx.object(data[0]!.coinObjectId);
    if (data.length > 1) {
      tx.mergeCoins(primary, data.slice(1).map((c) => tx.object(c.coinObjectId)));
    }
    const [coin] = tx.splitCoins(primary, [tx.pure.u64(amount)]);
    return coin;
  }

  /**
   * The M2 testnet buy-path (Option B, pay-at-match). Builds the ONE atomic,
   * consumer-signed PTB:
   *
   *   1) deepbook::pool::swap_exact_quote_for_base<Credit<M>, MOCK_USDC>(
   *          pool, usdcIn, deepIn, minBaseOut, clock)
   *        -> (Coin<Credit<M>>, Coin<MOCK_USDC>, Coin<DEEP>)   // PAYS the maker
   *   2) gix::job::create_job_from_fill<M>(cfg, market, providerRec,
   *          credits(=swap.0), input_blob_id, input_hash, clock)   // NO escrow
   *
   * The USDC + DEEP remainders are transferred back to the consumer. The pool
   * id comes from `market.deepbookPoolId` (governance-bound on-chain); the
   * DeepBook package id + DEEP coin type come from `@mysten/deepbook-v3`
   * testnet constants. See contracts/README.md §"M2 — DeepBook fill jobs".
   */
  async createJobFromFill(args: {
    signer: WalletSigner;
    market: MarketDeployment;
    /** The single market provider's shared ProviderRecord id (M2 demo). */
    providerRecordId: string;
    /** The shared DeepBook Pool<Credit<M>, MOCK_USDC> id. */
    poolId: string;
    /** USDC to spend on the swap (base units, 6dp). */
    usdcIn: bigint;
    /** DEEP to spend on the swap fee (base units; 0 ⇒ input-token fee). Default 0. */
    deepIn?: bigint;
    /** Minimum Credit<M> base out (slippage floor); SCU base units. Default 1. */
    minBaseOut?: bigint;
    /** Walrus input-blob commitment (u256; 0 = none). */
    inputBlobId: bigint;
    /** sha2_256(prompt) hex — the verification primitive. */
    inputHashHex: string;
  }): Promise<CreateJobOutcome> {
    await this.connect();
    if ((this.deployment.network ?? "localnet") !== "testnet") {
      throw new Error(
        `createJobFromFill: DeepBook is testnet-only (deployment.network=${this.deployment.network})`,
      );
    }
    const consumer = args.signer.toSuiAddress();
    const deepbook = await loadDeepbookTestnetConstants();
    const deepIn = args.deepIn ?? 0n;
    const minBaseOut = args.minBaseOut ?? 1n;

    const plan = buildFillJobPlan({
      gixPackageId: this.pkg,
      deepbookPackageId: deepbook.packageId,
      deepCoinType: deepbook.deepCoinType,
      usdcType: this.usdcType,
      configId: this.cfgId,
      clockId: this.clockId,
      market: args.market,
      poolId: args.poolId,
      providerRecordId: args.providerRecordId,
      usdcIn: args.usdcIn,
      deepIn,
      minBaseOut,
      inputBlobId: args.inputBlobId,
      inputHashHex: args.inputHashHex,
    });

    const tx = new this.Transaction();
    const usdcCoin = await this.splitUsdcInput(tx, consumer, args.usdcIn);
    const deepCoin = await this.splitDeepInput(tx, consumer, deepbook.deepCoinType, deepIn);

    // Command 1 — the DeepBook swap. Returns [credit, usdcRemainder, deepRemainder].
    const swapOut = tx.moveCall({
      target: plan.swap.target,
      typeArguments: plan.swap.typeArguments,
      arguments: plan.swap.arguments.map((a) => {
        switch (a.kind) {
          case "object":
            return tx.object(a.id);
          case "u64":
            return tx.pure.u64(a.value);
          case "u256":
            return tx.pure.u256(a.value);
          case "vector<u8>":
            return tx.pure.vector("u8", a.bytes);
          case "result":
            return a.from === "usdcIn" ? usdcCoin : deepCoin;
        }
      }),
    });
    const creditCoin = swapOut[0];
    const usdcRemainder = swapOut[1];
    const deepRemainder = swapOut[2];

    // Command 2 — create_job_from_fill, consuming the swap's Credit<M> output.
    tx.moveCall({
      target: plan.createJobFromFill.target,
      typeArguments: plan.createJobFromFill.typeArguments,
      arguments: plan.createJobFromFill.arguments.map((a) => {
        switch (a.kind) {
          case "object":
            return tx.object(a.id);
          case "u64":
            return tx.pure.u64(a.value);
          case "u256":
            return tx.pure.u256(a.value);
          case "vector<u8>":
            return tx.pure.vector("u8", a.bytes);
          case "result":
            return creditCoin; // the sole result arg is `credits` (= swap.0)
        }
      }),
    });

    // Return the leftover USDC + DEEP to the consumer (all-or-nothing PTB).
    tx.transferObjects([usdcRemainder, deepRemainder], tx.pure.address(consumer));

    const res = await this.execute(tx, args.signer);
    const status = res.effects?.status;
    if (status && status.status !== "success") {
      throw new Error(`create_job_from_fill tx ${res.digest} failed: ${status.error ?? "unknown"}`);
    }
    const jobId = this.firstCreatedOfType(res, `${this.pkg}::job::Job`);
    if (!jobId) throw new Error(`create_job_from_fill: no Job object created in tx ${res.digest}`);
    this.log("create_job_from_fill ok", { jobId, digest: res.digest });
    return { jobId, digest: res.digest };
  }

  /** Sign + execute via the WalletSigner seam (keypair OR injected wallet). */
  private async execute(tx: TransactionT, signer: WalletSigner) {
    // The sender must be set before building (a raw Keypair signer carries no
    // sender; dapp-kit sets it itself, but setting it here is idempotent).
    tx.setSenderIfNotSet(signer.toSuiAddress());
    const bytes = await tx.build({ client: this.client });
    const { signature } = await signer.signTransaction(bytes);
    const res = await this.client.executeTransactionBlock({
      transactionBlock: toB64(bytes),
      signature,
      options: { showEffects: true, showEvents: true, showObjectChanges: true },
    });
    await this.client.waitForTransaction({ digest: res.digest });
    return res;
  }

  /**
   * Await the terminal event for a job: poll `queryEvents` for the package's
   * AttestationSubmitted (carries output_hash) and Settled (carries payout)
   * events filtered to this job. The node attests + settles, so we watch.
   */
  async awaitSettlement(
    jobId: string,
    opts: { timeoutMs: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> },
  ): Promise<TerminalOutcome> {
    await this.connect();
    const interval = opts.intervalMs ?? 2000;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const deadline = Date.now() + opts.timeoutMs;
    let attestedHash: string | undefined;
    let verdict: number | undefined;

    while (Date.now() < deadline) {
      const events = await this.queryJobEvents(jobId);
      for (const e of events) {
        if (e.name === "AttestationSubmitted") {
          attestedHash = asHex(e.fields.output_hash);
          verdict = numOf(e.fields.verdict);
        }
      }
      const settled = events.find((e) => e.name === "Settled");
      if (settled) {
        return {
          state: "Settled",
          outputHashOnChain: asHex(settled.fields.output_hash) ?? attestedHash,
          payoutUsdc: numOf(settled.fields.payout),
          verdict,
        };
      }
      const refunded = events.find((e) => e.name === "Refunded");
      if (refunded) {
        return { state: "Refunded", outputHashOnChain: attestedHash, verdict };
      }
      await sleep(interval);
    }
    // Timed out waiting for a terminal event; surface whatever attestation we saw.
    if (attestedHash) return { state: "Attested", outputHashOnChain: attestedHash, verdict };
    throw new Error(`awaitSettlement: no terminal event for job ${jobId} within ${opts.timeoutMs}ms`);
  }

  /** Query this package's events, keeping ones for the given job id. */
  private async queryJobEvents(
    jobId: string,
  ): Promise<Array<{ name: string; fields: Record<string, unknown> }>> {
    // Filter by the events module; cheap on localnet. We post-filter by job_id
    // since MoveEventModule covers all of the package's emitted events.
    const res = await this.client.queryEvents({
      query: { MoveEventModule: { package: this.pkg, module: "events" } },
      order: "descending",
      limit: 200,
    });
    const out: Array<{ name: string; fields: Record<string, unknown> }> = [];
    for (const ev of res.data) {
      const name = ev.type.split("::").pop() ?? "";
      const fields = (ev.parsedJson ?? {}) as Record<string, unknown>;
      if (fields.job_id === jobId) out.push({ name, fields });
    }
    return out;
  }

  // ---- read paths --------------------------------------------------------

  async usdcBalance(address: string): Promise<bigint> {
    await this.connect();
    const bal = await this.client.getBalance({ owner: address, coinType: this.usdcType });
    return BigInt(bal.totalBalance);
  }

  async suiBalance(address: string): Promise<bigint> {
    await this.connect();
    const bal = await this.client.getBalance({ owner: address });
    return BigInt(bal.totalBalance);
  }

  /**
   * Read a fill-job's `output_blob_id` (the Walrus completion-blob commitment,
   * a u256) directly off the shared Job object. The provider sets it at
   * attestation; the `AttestationSubmitted` / `Settled` events do NOT carry it,
   * so the consumer reads the object's field to know which blob to download.
   * Returns 0n when no blob is recorded (e.g. localnet / escrow paths).
   */
  async jobOutputBlobId(jobId: string): Promise<bigint> {
    await this.connect();
    const obj = await this.client.getObject({ id: jobId, options: { showContent: true } });
    const content = obj.data?.content as
      | { dataType?: string; fields?: Record<string, unknown> }
      | undefined;
    if (!content || content.dataType !== "moveObject") return 0n;
    const raw = content.fields?.output_blob_id;
    if (raw === undefined || raw === null) return 0n;
    try {
      return BigInt(raw as string | number);
    } catch {
      return 0n;
    }
  }

  private firstCreatedOfType(
    res: { objectChanges?: unknown[] | null },
    typeStr: string,
  ): string | undefined {
    for (const raw of res.objectChanges ?? []) {
      const ch = raw as { type?: string; objectType?: string; objectId?: string };
      if (ch.type === "created" && ch.objectType?.startsWith(typeStr)) return ch.objectId;
    }
    return undefined;
  }
}

// --- pure helpers ----------------------------------------------------------

function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function asHex(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    return v.map((b) => Number(b).toString(16).padStart(2, "0")).join("");
  }
  return undefined;
}

function numOf(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return undefined;
}
