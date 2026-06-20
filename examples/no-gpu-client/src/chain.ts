/**
 * The on-chain half of the GPU-less buy: the two-account taker fill.
 *
 * The consumer buys from a DIFFERENT provider's wallet by filling a shared
 * `Ask<M>` — it NEVER touches a provider-owned object (contracts/INTERFACE.md
 * §"Shared-Ask order book"):
 *
 *   job::create_job_from_ask<M>(
 *       cfg, market: &Market<M>, ask: &mut Ask<M>, qty_scu: u64,
 *       escrow_in: Coin<MOCK_USDC>, input_hash: vector<u8>, clk: &Clock, ctx
 *   ): ID
 *
 * Fund `escrow_in >= qty_scu * ask.price_usdc_per_scu`. The provider serves +
 * ack/attests/settles with its own objects; the consumer funds escrow at create
 * and then watches for the terminal `Settled` / `AttestationSubmitted` event.
 *
 * The pure PTB plan (`buildCreateJobFromAskPlan`) is exported and asserted in
 * unit tests against the ABI — it carries no live @mysten/sui objects.
 */

import { hexToBytes } from "./hash.js";

type SuiClientT = import("@mysten/sui/jsonRpc").SuiJsonRpcClient;
type TransactionT = import("@mysten/sui/transactions").Transaction;
type KeypairT = import("@mysten/sui/keypairs/ed25519").Ed25519Keypair;

/** A declarative, SDK-object-free description of the create_job_from_ask PTB. */
export interface MoveCallPlan {
  target: string;
  typeArguments: string[];
  arguments: PlanArg[];
}

export type PlanArg =
  | { kind: "object"; id: string; role: string }
  | { kind: "u64"; value: bigint; role: string }
  | { kind: "u256"; value: bigint; role: string }
  | { kind: "vector<u8>"; bytes: number[]; role: string }
  | { kind: "result"; from: string; role: string };

export interface CreateJobFromAskPlan {
  /** Split the exact escrow coin out of the consumer's merged MOCK_USDC. */
  splitEscrow: { fromMergedPrimary: true; amount: bigint };
  createJob: MoveCallPlan;
}

/**
 * Build the create_job_from_ask PTB plan from ids + amounts only.
 * Arg ORDER + target MUST match `job::create_job_from_ask<M>`:
 *   (cfg, market: &Market<M>, ask: &mut Ask<M>, qty_scu: u64,
 *    escrow_in: Coin<MOCK_USDC>, input_hash, clk, ctx): ID
 */
export function buildCreateJobFromAskPlan(args: {
  packageId: string;
  configId: string;
  marketId: string;
  askId: string;
  creditType: string;
  clockId: string;
  scuQty: bigint;
  /** price_usdc_per_scu on the ask; escrow must cover qty * this. */
  pricePerScu: bigint;
  inputHashHex: string;
}): CreateJobFromAskPlan {
  // escrow >= qty_scu * price_usdc_per_scu  (EInsufficientEscrow = 407 otherwise).
  // Clients SHOULD fund exactly the minimum unless a tip is intended (INTERFACE.md).
  const escrow = args.scuQty * args.pricePerScu;
  return {
    splitEscrow: { fromMergedPrimary: true, amount: escrow },
    createJob: {
      target: `${args.packageId}::job::create_job_from_ask`,
      typeArguments: [args.creditType],
      arguments: [
        { kind: "object", id: args.configId, role: "cfg" },
        { kind: "object", id: args.marketId, role: "market: &Market<M>" },
        { kind: "object", id: args.askId, role: "ask: &mut Ask<M>" },
        { kind: "u64", value: args.scuQty, role: "qty_scu" },
        { kind: "result", from: "splitEscrow", role: "escrow_in: Coin<MOCK_USDC>" },
        { kind: "vector<u8>", bytes: hexToBytes(args.inputHashHex), role: "input_hash" },
        { kind: "object", id: args.clockId, role: "clk" },
      ],
    },
  };
}

/** The minimum MOCK_USDC escrow for a fill: qty_scu * price_usdc_per_scu. */
export function escrowFor(scuQty: bigint, pricePerScu: bigint): bigint {
  return scuQty * pricePerScu;
}

// ════════════════════════════════════════════════════════════════════════════
// M2 — DeepBook fill path (testnet; Option B / pay-at-match).
//
// ┌─ SDK SEAM ────────────────────────────────────────────────────────────────┐
// │ The `@gix/sdk` package (owned by another agent) will expose a testnet       │
// │ `runTask` that builds EXACTLY this PTB (DeepBook `swap_exact_quote_for_base`│
// │ → `gix::job::create_job_from_fill`, one signed PTB) and uploads input/output│
// │ blobs to Walrus. Its intended surface is already typed there as `FillConfig`│
// │ { providerRecordId, poolId, deepIn, minBaseOut, walrusEpochs }. We mirror    │
// │ those names below so reconciliation is a straight swap: when the SDK lands as│
// │ a dependency, replace `Chain.createJobFromFill` with `GixClient.runTask`     │
// │ (the on-chain plan + the create_job_from_fill ABI here are the contract).    │
// └─────────────────────────────────────────────────────────────────────────────┘
//
// create_job_from_fill<M>(cfg, market, provider_rec, credits: Coin<Credit<M>>,
//   input_blob_id: u256, input_hash: vector<u8>, clk, ctx): ID   (INTERFACE.md)
// ════════════════════════════════════════════════════════════════════════════

/** A declarative, SDK-object-free description of the create_job_from_fill PTB.
 *  `credits` is a PTB result (the Coin<Credit<M>> the DeepBook swap returned). */
export interface CreateJobFromFillPlan {
  createJob: MoveCallPlan;
}

/**
 * Build the create_job_from_fill PTB plan from ids + amounts only. Arg ORDER +
 * target MUST match `job::create_job_from_fill<M>`:
 *   (cfg, market: &Market<M>, provider_rec: &ProviderRecord,
 *    credits: Coin<Credit<M>>, input_blob_id: u256, input_hash: vector<u8>,
 *    clk: &Clock, ctx): ID
 * `credits` is the swap output (a PTB `result`); there is NO escrow coin (the
 * provider was paid USDC at the DeepBook fill — Option B pay-at-match).
 */
export function buildCreateJobFromFillPlan(args: {
  packageId: string;
  configId: string;
  marketId: string;
  providerRecordId: string;
  creditType: string;
  clockId: string;
  /** Walrus input (prompt) blob commitment as u256; 0 = none recorded. */
  inputBlobId: bigint;
  inputHashHex: string;
}): CreateJobFromFillPlan {
  return {
    createJob: {
      target: `${args.packageId}::job::create_job_from_fill`,
      typeArguments: [args.creditType],
      arguments: [
        { kind: "object", id: args.configId, role: "cfg" },
        { kind: "object", id: args.marketId, role: "market: &Market<M>" },
        { kind: "object", id: args.providerRecordId, role: "provider_rec: &ProviderRecord" },
        { kind: "result", from: "swapCredits", role: "credits: Coin<Credit<M>>" },
        { kind: "u256", value: args.inputBlobId, role: "input_blob_id" },
        { kind: "vector<u8>", bytes: hexToBytes(args.inputHashHex), role: "input_hash" },
        { kind: "object", id: args.clockId, role: "clk" },
      ],
    },
  };
}

export interface AskInfo {
  provider: string;
  marketId: string;
  pricePerScu: bigint;
  remainingScu: bigint;
}

export interface CreateJobOutcome {
  jobId: string;
  digest: string;
}

export interface TerminalOutcome {
  state: "Settled" | "Refunded" | "Attested";
  outputHashOnChain?: string;
  payoutUsdc?: number;
  verdict?: number;
}

export interface ChainOpts {
  packageId: string;
  configId: string;
  marketId: string;
  creditType: string;
  usdcType: string;
  clockId: string;
  /** Network — drives the DeepBook package ids for the fill path. */
  network?: "localnet" | "devnet" | "testnet" | "mainnet";
  /** Inner Credit<M> coin type (the DeepBook base coin). Fill path only. */
  creditCoinType?: string;
  logger?: (m: string, x?: Record<string, unknown>) => void;
}

/** Result of the testnet DeepBook fill buy. The provider was paid in USDC at the
 *  swap; the consumer's exposure is the per-job value-at-risk (refund-from-slash). */
export interface FillOutcome extends CreateJobOutcome {
  /** Walrus input blob commitment recorded on the Job (0 if none). */
  inputBlobId: bigint;
}

export class Chain {
  constructor(
    private readonly client: SuiClientT,
    private readonly Transaction: new () => TransactionT,
    private readonly opts: ChainOpts,
  ) {}

  private log(m: string, x?: Record<string, unknown>) {
    this.opts.logger?.(m, x);
  }

  /** Read the shared Ask<M> to learn price, remaining capacity, and provider. */
  async readAsk(askId: string): Promise<AskInfo> {
    const obj = await this.client.getObject({ id: askId, options: { showContent: true } });
    const content = obj.data?.content;
    if (!content || content.dataType !== "moveObject") {
      throw new Error(`ask ${askId} not found or not a Move object`);
    }
    const f = content.fields as Record<string, unknown>;
    return {
      provider: String(f.provider ?? ""),
      marketId: String(f.market_id ?? ""),
      pricePerScu: BigInt(String(f.price_usdc_per_scu ?? "0")),
      remainingScu: BigInt(String(f.remaining_scu ?? "0")),
    };
  }

  /**
   * Fill the shared ask: split exact escrow, call create_job_from_ask, share Job.
   * Returns the new Job id + the create tx digest.
   */
  async createJobFromAsk(args: {
    keypair: KeypairT;
    askId: string;
    scuQty: bigint;
    pricePerScu: bigint;
    inputHashHex: string;
  }): Promise<CreateJobOutcome> {
    const consumer = args.keypair.toSuiAddress();
    const tx = new this.Transaction();

    const plan = buildCreateJobFromAskPlan({
      packageId: this.opts.packageId,
      configId: this.opts.configId,
      marketId: this.opts.marketId,
      askId: args.askId,
      creditType: this.opts.creditType,
      clockId: this.opts.clockId,
      scuQty: args.scuQty,
      pricePerScu: args.pricePerScu,
      inputHashHex: args.inputHashHex,
    });

    const escrowCoin = await this.splitEscrowCoin(tx, consumer, plan.splitEscrow.amount);

    tx.moveCall({
      target: plan.createJob.target,
      typeArguments: plan.createJob.typeArguments,
      arguments: plan.createJob.arguments.map((a) => {
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
            return escrowCoin;
        }
      }),
    });

    tx.setSender(consumer);
    const res = await this.client.signAndExecuteTransaction({
      transaction: tx,
      signer: args.keypair,
      options: { showEffects: true, showObjectChanges: true },
    });
    await this.client.waitForTransaction({ digest: res.digest });
    if (res.effects?.status.status !== "success") {
      throw new Error(
        `create_job_from_ask tx ${res.digest} failed: ${res.effects?.status.error ?? "unknown"}`,
      );
    }
    const jobId = this.firstCreatedOfType(res, `${this.opts.packageId}::job::Job`);
    if (!jobId) throw new Error(`create_job_from_ask: no Job created in tx ${res.digest}`);
    this.log("create_job_from_ask ok", { jobId, digest: res.digest });
    return { jobId, digest: res.digest };
  }

  /**
   * M2 TESTNET buy: DeepBook swap (USDC → Credit<M>) → create_job_from_fill, in
   * ONE consumer-signed PTB (Option B, pay-at-match). The swap PAYS THE PROVIDER
   * (the resting maker) USDC at the fill; the returned Coin<Credit<M>> is fed
   * straight into create_job_from_fill. There is NO escrow object — the Job
   * carries the reserved credit, and consumer protection is refund-from-slash.
   *
   * SDK SEAM: see the big comment above buildCreateJobFromFillPlan. This is the
   * local stand-in for `@gix/sdk`'s testnet runTask; reconcile at integration.
   */
  async createJobFromFill(args: {
    keypair: KeypairT;
    poolId: string;
    providerRecordId: string;
    /** SCU (= Credit<M> base units) to buy. */
    scuQty: bigint;
    /** Max USDC (base units) to spend on the swap (the quote side / value-at-risk). */
    maxQuoteIn: bigint;
    /** DEEP base units for the swap fee (0 ⇒ input-token fee). */
    deepIn: bigint;
    /** Walrus input blob commitment (u256); 0 if none. */
    inputBlobId: bigint;
    inputHashHex: string;
  }): Promise<FillOutcome> {
    if (!this.opts.creditCoinType) {
      throw new Error(
        "createJobFromFill: creditCoinType (the DeepBook base coin) is required — set CREDIT_COIN_TYPE / deployment.markets[].creditCoinType",
      );
    }
    const consumer = args.keypair.toSuiAddress();
    const tx = new this.Transaction();

    // 1) DeepBook v3 swap: USDC → Credit<M> on the market's bound pool. Returns
    //    LOOSE coins [creditCoin, usdcRemainder, deepRemainder] usable by the next
    //    command. We register the GIX pool/coins on a per-call DeepBookClient so
    //    its swap helper resolves getPool/getCoin for our Credit<M>/USDC pair.
    const { creditCoin, usdcRemainder, deepRemainder } = await this.deepbookSwap(tx, {
      poolId: args.poolId,
      consumer,
      maxQuoteIn: args.maxQuoteIn,
      deepIn: args.deepIn,
      minBaseOut: args.scuQty, // slippage floor: at least the SCU we asked for
    });

    // 2) GIX fill-job, SAME PTB. Consumer-signed; NO escrow coin. Feeds the swap
    //    output credits. Binds the Job to the single market provider's record.
    const plan = buildCreateJobFromFillPlan({
      packageId: this.opts.packageId,
      configId: this.opts.configId,
      marketId: this.opts.marketId,
      providerRecordId: args.providerRecordId,
      creditType: this.opts.creditType,
      clockId: this.opts.clockId,
      inputBlobId: args.inputBlobId,
      inputHashHex: args.inputHashHex,
    });

    tx.moveCall({
      target: plan.createJob.target,
      typeArguments: plan.createJob.typeArguments,
      arguments: plan.createJob.arguments.map((a) => {
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
            return creditCoin; // the Coin<Credit<M>> the swap returned
        }
      }),
    });

    // 3) Return the swap leftovers (unspent USDC + DEEP) to the consumer.
    tx.transferObjects([usdcRemainder, deepRemainder], tx.pure.address(consumer));

    tx.setSender(consumer);
    const res = await this.client.signAndExecuteTransaction({
      transaction: tx,
      signer: args.keypair,
      options: { showEffects: true, showObjectChanges: true },
    });
    await this.client.waitForTransaction({ digest: res.digest });
    if (res.effects?.status.status !== "success") {
      throw new Error(
        `create_job_from_fill tx ${res.digest} failed: ${res.effects?.status.error ?? "unknown"}`,
      );
    }
    const jobId = this.firstCreatedOfType(res, `${this.opts.packageId}::job::Job`);
    if (!jobId) throw new Error(`create_job_from_fill: no Job created in tx ${res.digest}`);
    this.log("create_job_from_fill ok", { jobId, digest: res.digest });
    return { jobId, digest: res.digest, inputBlobId: args.inputBlobId };
  }

  /** Read the DeepBook pool mid price (USDC/SCU). Returns 0 if unavailable (e.g.
   *  an empty book / unreachable pool) so the caller can size conservatively. */
  async deepbookMidPrice(
    poolId: string,
    creditCoinType: string,
    usdcType: string,
  ): Promise<number> {
    try {
      const { DeepBookClient } = await import("@mysten/deepbook-v3");
      const db = new DeepBookClient({
        client: this.client as unknown as never,
        address: "0x0000000000000000000000000000000000000000000000000000000000000000",
        network: (this.opts.network ?? "testnet") as never,
        coins: {
          GIX_SCU: { address: creditCoinType, type: creditCoinType, scalar: 1 },
          GIX_USDC: { address: usdcType, type: usdcType, scalar: 1_000_000 },
        } as never,
        pools: {
          GIX_POOL: { address: poolId, baseCoin: "GIX_SCU", quoteCoin: "GIX_USDC" },
        } as never,
      });
      const mid = await db.midPrice("GIX_POOL");
      return Number.isFinite(mid) && mid > 0 ? mid : 0;
    } catch (e) {
      this.log("deepbook midPrice unavailable", { error: (e as Error).message });
      return 0;
    }
  }

  /**
   * Add a DeepBook `swap_exact_quote_for_base` command to `tx`, returning the
   * three loose result coins. Builds a per-call DeepBookClient that registers the
   * GIX pool + Credit<M>/USDC coins by id (the SDK's built-in maps don't know our
   * pair). Uses `@mysten/deepbook-v3` lazily so importing this module is cheap.
   */
  private async deepbookSwap(
    tx: TransactionT,
    args: {
      poolId: string;
      consumer: string;
      maxQuoteIn: bigint;
      deepIn: bigint;
      minBaseOut: bigint;
    },
  ): Promise<{
    creditCoin: ReturnType<TransactionT["splitCoins"]>[number];
    usdcRemainder: ReturnType<TransactionT["splitCoins"]>[number];
    deepRemainder: ReturnType<TransactionT["splitCoins"]>[number];
  }> {
    const { DeepBookClient } = await import("@mysten/deepbook-v3");
    const network = this.opts.network ?? "testnet";

    const POOL_KEY = "GIX_POOL";
    const BASE_KEY = "GIX_SCU";
    const QUOTE_KEY = "GIX_USDC";

    const db = new DeepBookClient({
      client: this.client as unknown as never,
      address: args.consumer,
      network: network as never,
      coins: {
        [BASE_KEY]: { address: this.opts.creditCoinType!, type: this.opts.creditCoinType!, scalar: 1 },
        [QUOTE_KEY]: { address: this.opts.usdcType, type: this.opts.usdcType, scalar: 1_000_000 },
      } as never,
      pools: {
        [POOL_KEY]: { address: args.poolId, baseCoin: BASE_KEY, quoteCoin: QUOTE_KEY },
      } as never,
    });

    // The swap helper sources the quote (USDC) + DEEP coins itself via
    // coinWithBalance, and returns [base, quoteRemainder, deepRemainder].
    const [creditCoin, usdcRemainder, deepRemainder] = (
      db.deepBook.swapExactQuoteForBase({
        poolKey: POOL_KEY,
        amount: args.maxQuoteIn,
        deepAmount: args.deepIn,
        minOut: args.minBaseOut,
      }) as unknown as (t: TransactionT) => readonly [unknown, unknown, unknown]
    )(tx) as unknown as [
      ReturnType<TransactionT["splitCoins"]>[number],
      ReturnType<TransactionT["splitCoins"]>[number],
      ReturnType<TransactionT["splitCoins"]>[number],
    ];
    return { creditCoin, usdcRemainder, deepRemainder };
  }

  /** Merge the consumer's MOCK_USDC and split out the exact escrow amount. */
  private async splitEscrowCoin(tx: TransactionT, consumer: string, amount: bigint) {
    const { data } = await this.client.getCoins({ owner: consumer, coinType: this.opts.usdcType });
    if (data.length === 0) {
      throw new Error(
        `consumer ${consumer} holds no MOCK_USDC (${this.opts.usdcType}). Run with --fund first.`,
      );
    }
    const total = data.reduce((s, c) => s + BigInt(c.balance), 0n);
    if (total < amount) {
      throw new Error(
        `insufficient MOCK_USDC: have ${total}, need ${amount} base units. Run with --fund.`,
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
   * Await the terminal event for a job: poll the package's `events` module for
   * AttestationSubmitted (carries output_hash + verdict) then Settled (payout).
   * The provider attests + settles; we watch.
   */
  async awaitSettlement(
    jobId: string,
    opts: { timeoutMs: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> },
  ): Promise<TerminalOutcome> {
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
      if (events.some((e) => e.name === "Refunded")) {
        return { state: "Refunded", outputHashOnChain: attestedHash, verdict };
      }
      await sleep(interval);
    }
    if (attestedHash) return { state: "Attested", outputHashOnChain: attestedHash, verdict };
    throw new Error(`no terminal event for job ${jobId} within ${opts.timeoutMs}ms`);
  }

  private async queryJobEvents(
    jobId: string,
  ): Promise<Array<{ name: string; fields: Record<string, unknown> }>> {
    const res = await this.client.queryEvents({
      query: { MoveEventModule: { package: this.opts.packageId, module: "events" } },
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

  async usdcBalance(address: string): Promise<bigint> {
    const bal = await this.client.getBalance({ owner: address, coinType: this.opts.usdcType });
    return BigInt(bal.totalBalance);
  }

  async suiBalance(address: string): Promise<bigint> {
    const bal = await this.client.getBalance({ owner: address });
    return BigInt(bal.totalBalance);
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

function asHex(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((b) => Number(b).toString(16).padStart(2, "0")).join("");
  return undefined;
}

function numOf(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return undefined;
}
