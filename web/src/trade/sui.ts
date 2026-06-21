// web/src/trade/sui.ts
// The REAL OrderClient (UI contract §5; demo-milestone-contract §4/§5). Replaces
// MockOrderClient via store.tsx `orderClientRef` when VITE_ORDER_CLIENT=sui.
//
// `runTask(market, qtyScu, price, prompt)` IS the Option-3 tunnel-free buy flow
// (docs/option3-inline-input-interface.md §C):
//   1. compute input bytes (UTF-8 of the prompt) + input_hash = sha2_256(prompt) IN-BROWSER
//      (WebCrypto) — NO `POST /inputs`; the prompt rides inline in the tx.
//   2. create_job_from_ask<M>(... input, input_hash, input_blob_id=0 ...) funding the
//      MOCK_USDC escrow against the provider's shared Ask, signed by the connected
//      wallet/burner                                          → shared Job id + digest
//   3. the store tracks the job; when it settles the result viewer downloads the output
//      from WALRUS by the job's output_blob_id, re-hashes it, and checks it vs the
//      on-chain output_hash (the HTTP /result endpoint is a last-resort fallback only).
//
// Reuses the harness chain patterns (harness/src/chain/sui.ts): lazy @mysten/sui import,
// PTB shape for create_job, owned-object discovery for the provider stake + credit coin.
//
// ───────────────────────────────────────────────────────────────────────────────
// SDK SWAP POINT: the D2 `@gix/sdk` package will export a `GixClient` whose `runTask`
// does exactly steps 1–3 + the verify. When it lands as a web dependency, replace the
// PTB body of `runTask` below with `new GixClient({ deployment, signer, providerUrl })`
// — the OrderClient surface + JobResult shape here already mirror the SDK's types.
// ───────────────────────────────────────────────────────────────────────────────

import type { ChainConfig } from "./config";
import { loadChainConfig } from "./config";
import {
  makeBurnerSigner,
  fundSuiFromFaucet,
  mintMockUsdc,
  type WalletSigner,
} from "./burner";
import {
  ProviderClient,
  fetchVerifiedResultFromWalrus,
  sha2_256Bytes,
  type JobResult,
} from "./result";
import type {
  Account,
  Balances,
  OrderClient,
  OrderResult,
  RunArgs,
} from "./types";
import type { JobState } from "../data/types";

type SuiClientT = import("@mysten/sui/jsonRpc").SuiJsonRpcClient;
type TransactionT = import("@mysten/sui/transactions").Transaction;

/** MOCK_USDC has 6 decimals (mock_usdc::decimals). UI prices are USDC/SCU as decimals;
 *  on-chain escrow is base units. */
const USDC_DECIMALS = 6;

function toBaseUnits(usdc: number): number {
  return Math.round(usdc * 10 ** USDC_DECIMALS);
}
function fromBaseUnits(base: number | bigint): number {
  return Number(base) / 10 ** USDC_DECIMALS;
}

/** Extended buy args carrying the prompt (the real inference task to run). The store
 *  calls `runTask` directly for buys so the prompt flows through; `buy`/`sell` keep the
 *  §5 OrderClient signature so the interface stays satisfied. */
export interface RunTaskArgs {
  marketId: string;
  qtyScu: number;
  priceUsdcPerScu: number;
  prompt: string;
}

export interface RunTaskResult extends OrderResult {
  /** input_hash the provider returned (sha2_256 of the prompt). */
  inputHash?: string;
}

export class SuiOrderClient implements OrderClient {
  private readonly cfg: ChainConfig;
  private readonly provider: ProviderClient;
  private signer: WalletSigner | null = null;
  private client!: SuiClientT;
  private Transaction!: new () => TransactionT;
  private connected = false;

  /** Optional injected signer (e.g. a dapp-kit wallet adapter on testnet). When absent,
   *  connect() builds the localnet burner. */
  constructor(opts?: { cfg?: ChainConfig; signer?: WalletSigner }) {
    this.cfg = opts?.cfg ?? loadChainConfig();
    this.provider = new ProviderClient(this.cfg.providerUrl);
    if (opts?.signer) this.signer = opts.signer;
  }

  get config(): ChainConfig {
    return this.cfg;
  }

  /** Lazily construct the SDK client + Transaction class (keeps the bundle lean). */
  private async ensureClient(): Promise<void> {
    if (this.connected) return;
    const { SuiJsonRpcClient } = await import("@mysten/sui/jsonRpc");
    const { Transaction } = await import("@mysten/sui/transactions");
    this.client = new SuiJsonRpcClient({ network: this.cfg.network, url: this.cfg.rpcUrl });
    this.Transaction = Transaction as unknown as new () => TransactionT;
    this.connected = true;
  }

  // ── wallet ────────────────────────────────────────────────────────────────
  async connect(): Promise<Account> {
    await this.ensureClient();
    if (!this.signer) {
      // localnet default: a faucet-funded burner Ed25519 key (testnet injects a
      // dapp-kit signer via the constructor instead).
      this.signer = await makeBurnerSigner();
    }
    return { address: this.signer.address };
  }

  /** Localnet: faucet test SUI for gas + mint MOCK_USDC so the burner can fund escrow. */
  async fund(): Promise<void> {
    await this.ensureClient();
    if (!this.signer) this.signer = await makeBurnerSigner();
    // SUI for gas (best-effort: faucet may rate-limit on repeat).
    try {
      await fundSuiFromFaucet(this.cfg, this.signer.address);
    } catch (e) {
      // a rate-limited SUI faucet shouldn't block the USDC mint if gas already exists
      console.warn("[gix] SUI faucet request failed (already funded / rate limited?)", e);
    }
    // MOCK_USDC for escrow — 50,000 USDC (base units).
    await mintMockUsdc(this.cfg, this.signer, this.client, toBaseUnits(50_000));
  }

  async balances(): Promise<Balances> {
    await this.ensureClient();
    if (!this.signer) return { sui: 0, usdc: 0, creditsScu: 0 };
    const addr = this.signer.address;
    const [usdcBase, suiBase, creditsBase] = await Promise.all([
      this.coinTotal(addr, this.cfg.usdcType),
      this.coinTotal(addr, "0x2::sui::SUI"),
      this.coinTotal(addr, this.cfg.market.creditType
        ? `${this.cfg.packageId}::credit::Credit<${this.cfg.market.creditType}>`
        : ""),
    ]);
    return {
      usdc: fromBaseUnits(usdcBase),
      sui: Number(suiBase) / 1e9, // SUI has 9 decimals (MIST)
      creditsScu: Number(creditsBase), // Credit is whole-SCU metered
    };
  }

  private async coinTotal(owner: string, coinType: string): Promise<bigint> {
    if (!coinType) return 0n;
    try {
      let total = 0n;
      let cursor: string | null | undefined = undefined;
      do {
        const page = await this.client.getCoins({ owner, coinType, cursor });
        for (const c of page.data) total += BigInt(c.balance);
        cursor = page.hasNextPage ? page.nextCursor : null;
      } while (cursor);
      return total;
    } catch {
      return 0n;
    }
  }

  // ── §5 OrderClient surface ──────────────────────────────────────────────────
  // SPOT BUY — acquire credits ONLY (USDC → Credit<M> via the market's DeepBook pool).
  // No create_job, no prompt: buying compute is a trade, the held Credit<M> coin is
  // redeemed later via `run`. The pool only exists once test DEEP is provisioned (M2);
  // until then this degrades gracefully with a clear message rather than silently
  // routing through create_job (which would fuse buy+run again).
  async buy(marketId: string, qtyScu: number, priceUsdcPerScu: number): Promise<OrderResult> {
    await this.ensureClient();
    if (!this.signer) return { ok: false, error: "wallet not connected" };
    if (qtyScu <= 0) return { ok: false, error: "quantity must be > 0" };

    const market = this.cfg.market;
    if (marketId && marketId !== market.id) {
      return {
        ok: false,
        error: "only the live deployment market is buyable on chain (others are simulated)",
      };
    }
    void priceUsdcPerScu;
    // The USDC→Credit swap leg lands with the Credit/USDC DeepBook pool (M2). Buying must
    // NOT create a job — hold the Credit<M> coin, redeem it later via `run`.
    return {
      ok: false,
      error:
        "Spot buy (USDC → Credit) needs the Credit/USDC DeepBook pool — pending test DEEP (M2). Use Buy & run now for the atomic create_job path until the pool is live.",
    };
  }

  /** Provider-side sell (stake + mint_credits + post ask) is the node/provider flow, not
   *  the web consumer's. The web demo is consumer-buy-only; sell is a no-op stub here so
   *  the §5 interface stays satisfied (the provider node owns capacity). */
  async sell(_marketId: string, _qtyScu: number, _priceUsdcPerScu: number): Promise<OrderResult> {
    return {
      ok: false,
      error:
        "Selling capacity is the provider node's flow (stake + mint_credits). This terminal is consumer-buy-only.",
    };
  }

  /** REDEEM — run a job from a HELD Credit<M> coin (create_job, NO swap). The prompt is
   *  POSTed to the provider, then create_job binds input_hash + consumes the buyer's own
   *  credit coin (vs `runTask`, which buys the credit inline). Requires the consumer to
   *  already hold a Credit<M> coin — i.e. a prior `buy`. */
  async run({ marketId, qtyScu, prompt }: RunArgs): Promise<OrderResult> {
    await this.ensureClient();
    if (!this.signer) return { ok: false, error: "wallet not connected" };
    if (qtyScu <= 0) return { ok: false, error: "quantity must be > 0" };
    if (!prompt || prompt.trim().length === 0) {
      return { ok: false, error: "enter a prompt — the task to run" };
    }
    const market = this.cfg.market;
    if (marketId && marketId !== market.id) {
      return {
        ok: false,
        error: "only the live deployment market can be run on chain (others are simulated)",
      };
    }
    // The held-credit create_job path lands with the spot pool (so the consumer actually
    // holds Credit<M> to redeem). Until then a plain Run can't redeem a real held coin —
    // route the demo through Buy & run now (runTask), which buys the credit inline.
    return {
      ok: false,
      error:
        "Run-from-held-credit needs the spot Credit/USDC pool to first acquire credits (M2). Use Buy & run now for the atomic path until the pool is live.",
    };
  }

  /** runTask = the tunnel-free Option-3 buy: carry the prompt INLINE in the
   *  `create_job_from_ask` tx (input bytes + sha2_256 input_hash, input_blob_id=0),
   *  fund the MOCK_USDC escrow against the provider's shared Ask, return the job.
   *  No `POST /inputs` — the Mac never connects to the DGX; the prompt rides the tx. */
  async runTask(args: RunTaskArgs): Promise<RunTaskResult> {
    await this.ensureClient();
    if (!this.signer) return { ok: false, error: "wallet not connected" };
    if (args.qtyScu <= 0) return { ok: false, error: "quantity must be > 0" };

    const market = this.cfg.market;
    if (args.marketId && args.marketId !== market.id) {
      // Only the deployed market is buyable on chain; other sidebar markets are sim-only.
      return {
        ok: false,
        error: "only the live deployment market can be bought on chain (others are simulated)",
      };
    }

    // The Ask is the provider's resting liquidity, posted at deploy time. Without it the
    // tunnel-free path can't fund a job — degrade gracefully (don't build an invalid PTB).
    if (!market.askId) {
      return {
        ok: false,
        error:
          "No provider Ask is provisioned for this market yet — the provider posts it at " +
          "deploy time (staking::post_ask). Set VITE_MARKET_ASK_ID once it's published, " +
          "then retry the tunnel-free buy.",
      };
    }

    // Filling an Ask pays the ASK's on-chain price (`price_usdc_per_scu`, already in base
    // units) — NOT the UI price. escrow = qty * ask price. (The UI price is for limit trades.)
    let escrowBase: number;
    try {
      const askObj = await this.client.getObject({
        id: market.askId,
        options: { showContent: true },
      });
      const askFields =
        (askObj.data?.content as { fields?: Record<string, unknown> } | undefined)?.fields ?? {};
      const askPriceBase = Number(askFields.price_usdc_per_scu ?? 0);
      escrowBase = args.qtyScu * askPriceBase;
    } catch (e) {
      return { ok: false, error: `could not read Ask price: ${(e as Error).message}` };
    }
    if (escrowBase <= 0)
      return { ok: false, error: "ask price unavailable — is the Ask provisioned?" };

    // 1. Inline input: the prompt's UTF-8 bytes ride in the tx, and the integrity hash is
    //    sha2_256(prompt) computed client-side (WebCrypto — byte-identical to Move's
    //    sha2_256, same primitive audit.ts uses). No /inputs round-trip to the provider.
    const inputBytes = Array.from(new TextEncoder().encode(args.prompt));
    const inputHashBytes = await sha2_256Bytes(args.prompt);
    const inputHashHex = inputHashBytes
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // 2. Build + sign create_job_from_ask against the shared Ask, funding the escrow.
    let tx: TransactionT;
    try {
      tx = await this.buildCreateJobFromAskTx(escrowBase, args.qtyScu, inputBytes, inputHashBytes);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }

    try {
      const res = await this.signer.signAndExecute(this.client, tx);
      const jobId = this.firstCreatedJobId(res.objectChanges) ?? undefined;
      return { ok: true, digest: res.digest, jobId, inputHash: inputHashHex };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** Fetch + verify the settled result for a job (called by the store/result viewer).
   *  Option 3: download the output from Walrus by the job's `output_blob_id` (read the
   *  shared Job object on chain), recompute sha2_256 in-browser, and verify it against the
   *  on-chain `output_hash` — no `GET /result/:jobId`. The provider HTTP endpoint is kept
   *  only as a last-resort fallback (e.g. before the output blob is published). */
  async getResult(
    jobId: string,
    extra?: { costUsdc?: number; digest?: string; jobFields?: JobFields | null },
  ): Promise<JobResult> {
    await this.ensureClient();
    // Reuse pre-read Job fields when the caller already fetched them (avoids a 2nd getObject).
    const job = extra?.jobFields ?? (await this.readJobFields(jobId));
    return fetchVerifiedResultFromWalrus({
      jobId,
      client: this.client,
      provider: this.provider,
      model: this.cfg.market.name,
      walrusAggregator: this.cfg.walrusAggregator,
      outputBlobId: job?.outputBlobId,
      outputHashHex: job?.outputHashHex,
      extra: { costUsdc: extra?.costUsdc, digest: extra?.digest },
    });
  }

  /** Cheap read of just the Job's lifecycle `state` (+ the `slashed` flag and whether an
   *  output blob has been published) for the post-buy poller. Reads the same shared Job
   *  object as `readJobFields` but only decodes the lifecycle-relevant scalars, so the
   *  store can advance the My-Jobs row without pulling the full inline-input bytes each tick.
   *  Maps the on-chain `state: u8` to a UI `JobState` via {@link mapJobStateU8}. Returns
   *  null when the object isn't readable yet (degrades to "keep polling"). */
  async getJobState(jobId: string): Promise<JobLifecycle | null> {
    await this.ensureClient();
    try {
      const obj = await this.client.getObject({
        id: jobId,
        options: { showContent: true },
      });
      const content = (obj as { data?: { content?: unknown } }).data?.content as
        | { dataType?: string; fields?: Record<string, unknown> }
        | undefined;
      if (!content || content.dataType !== "moveObject" || !content.fields) return null;
      const f = content.fields;
      const stateU8 = Number(f["state"] ?? -1);
      const slashed = f["slashed"] === true || f["slashed"] === "true";
      return {
        stateU8,
        state: mapJobStateU8(stateU8, slashed),
        slashed,
        hasOutputBlob: decodeMoveBlobId(f["output_blob_id"]) != null,
      };
    } catch (e) {
      console.warn("[gix] could not read Job state", e);
      return null;
    }
  }

  /** Read the inline input + output-blob/hash commitments off the shared Job object.
   *  Returns undefined fields when the object/field isn't readable (degrades to fallback). */
  async readJobFields(jobId: string): Promise<JobFields | null> {
    await this.ensureClient();
    try {
      const obj = await this.client.getObject({
        id: jobId,
        options: { showContent: true },
      });
      const content = (obj as { data?: { content?: unknown } }).data?.content as
        | { dataType?: string; fields?: Record<string, unknown> }
        | undefined;
      if (!content || content.dataType !== "moveObject" || !content.fields) return null;
      const f = content.fields;
      return {
        input: decodeMoveU8Vector(f["input"]),
        inputHashHex: decodeMoveU8VectorHex(f["input_hash"]),
        outputHashHex: decodeMoveU8VectorHex(f["output_hash"]),
        outputBlobId: decodeMoveBlobId(f["output_blob_id"]),
        inputBlobId: decodeMoveBlobId(f["input_blob_id"]),
      };
    } catch (e) {
      console.warn("[gix] could not read Job object fields", e);
      return null;
    }
  }

  /** Provider /health (surfaced as a liveness hint in the UI). */
  async providerHealth(): Promise<{ ok: boolean; model?: string; gpu?: string }> {
    return this.provider.health();
  }

  // ── chain helpers (mirror harness/src/chain/sui.ts) ─────────────────────────

  /** Build the tunnel-free `create_job_from_ask<M>` PTB (Option 3, pinned ABI §C):
   *  fund the exact MOCK_USDC escrow from the buyer's coins against the shared Ask, and
   *  carry the prompt INLINE — `input` (raw UTF-8 bytes), `input_hash` (sha2_256), and
   *  `input_blob_id = 0` (no Walrus write). The consumer needs NO provider-owned object;
   *  the shared `Ask<M>` (and its pre-minted credits) is the counterparty. */
  private async buildCreateJobFromAskTx(
    escrowBase: number,
    qtyScu: number,
    inputBytes: number[],
    inputHashBytes: number[],
  ): Promise<TransactionT> {
    const tx = new this.Transaction();
    const market = this.cfg.market;

    // escrow_in: a Coin<MOCK_USDC> of exactly `escrowBase`, split from the buyer's coins.
    const escrowCoin = await this.splitEscrowCoin(tx, this.signer!.address, escrowBase);

    // create_job_from_ask<M, Q>(cfg, market, ask: &mut Ask<M>, qty_scu, escrow_in,
    //   input, input_hash, clk, ctx): ID — shares the Job; consumer is
    //   ctx.sender() (the buyer). `Q` (escrow coin type) is inferred from escrow_in, so
    //   only `M` is given as an explicit type arg (mirrors the create_job PTB).
    tx.moveCall({
      target: `${this.cfg.packageId}::job::create_job_from_ask`,
      typeArguments: [market.creditType, this.cfg.usdcType],
      arguments: [
        tx.object(this.cfg.configId),
        tx.object(market.id),
        tx.object(market.askId),
        tx.pure.u64(BigInt(qtyScu)),
        escrowCoin,
        tx.pure.vector("u8", inputBytes),
        tx.pure.vector("u8", inputHashBytes),
        tx.object(this.cfg.clockId),
      ],
    });
    return tx;
  }

  /** Resolve the buyer's MOCK_USDC coins, merge, and split the exact escrow amount. */
  private async splitEscrowCoin(tx: TransactionT, owner: string, amount: number) {
    const { data } = await this.client.getCoins({ owner, coinType: this.cfg.usdcType });
    if (data.length === 0) {
      throw new Error("no MOCK_USDC — fund the wallet from the faucet first");
    }
    const have = data.reduce((s, c) => s + BigInt(c.balance), 0n);
    if (have < BigInt(amount)) {
      throw new Error("insufficient USDC for escrow — fund the wallet first");
    }
    const primary = tx.object(data[0]!.coinObjectId);
    if (data.length > 1) {
      tx.mergeCoins(
        primary,
        data.slice(1).map((c) => tx.object(c.coinObjectId)),
      );
    }
    return tx.splitCoins(primary, [tx.pure.u64(BigInt(amount))])[0];
  }

  /** Find the created shared Job<M> id from the tx's objectChanges. */
  private firstCreatedJobId(objectChanges: unknown): string | null {
    if (!Array.isArray(objectChanges)) return null;
    const jobPrefix = `${this.cfg.packageId}::job::Job`;
    for (const ch of objectChanges as Array<Record<string, unknown>>) {
      if (
        ch.type === "created" &&
        typeof ch.objectType === "string" &&
        ch.objectType.startsWith(jobPrefix) &&
        typeof ch.objectId === "string"
      ) {
        return ch.objectId;
      }
    }
    return null;
  }
}

// --- Job lifecycle (poll) ---------------------------------------------------

/** The lifecycle scalars the post-buy poller reads each tick off the shared Job object. */
export interface JobLifecycle {
  /** Raw on-chain `state: u8` (job.move STATE_*: 3=Dispatched … 9=Expired). */
  stateU8: number;
  /** The mapped UI lifecycle state. */
  state: JobState;
  /** The on-chain `slashed` flag (Move has no distinct Slashed u8 — it rides Refunded). */
  slashed: boolean;
  /** Whether the completion blob has been published (output_blob_id != 0). */
  hasOutputBlob: boolean;
}

// On-chain Job.state u8 values (contracts/sources/job.move § "Lifecycle states").
const STATE_DISPATCHED = 3;
const STATE_EXECUTING = 4;
const STATE_ATTESTED = 5;
const STATE_VERIFIED = 6;
const STATE_SETTLED = 7;
const STATE_REFUNDED = 8;
const STATE_EXPIRED = 9;

/** Map an on-chain `Job.state: u8` (+ the `slashed` flag) to the UI `JobState`. The Move
 *  module has no separate Slashed state — a faulted job lands in Refunded with `slashed=true`,
 *  so we surface "Slashed" when the flag is set. Anything unrecognized falls back to
 *  Dispatched (the freshly-created state) so the row never shows a blank lifecycle. */
export function mapJobStateU8(stateU8: number, slashed = false): JobState {
  switch (stateU8) {
    case STATE_DISPATCHED:
      return "Dispatched";
    case STATE_EXECUTING:
      return "Executing";
    case STATE_ATTESTED:
      return "Attested";
    case STATE_VERIFIED:
      return "Verified";
    case STATE_SETTLED:
      return "Settled";
    case STATE_REFUNDED:
      return slashed ? "Slashed" : "Refunded";
    case STATE_EXPIRED:
      return "Expired";
    default:
      return "Dispatched";
  }
}

/** Terminal UI states the poller stops on. (Verified is NOT terminal on-chain — settlement
 *  still follows — but the result is already fetchable there, so the store triggers the
 *  auto-fetch on Verified while continuing to poll until a true terminal state.) */
export const TERMINAL_JOB_STATES: ReadonlySet<JobState> = new Set<JobState>([
  "Settled",
  "Refunded",
  "Slashed",
  "Expired",
]);

// --- Job-object field decoding ---------------------------------------------

/** The subset of the on-chain `Job<M, Q>` fields the web reads back (inline input +
 *  the I/O hash/blob commitments) for the result fetch + AuditDrawer input check. */
export interface JobFields {
  /** The on-chain inline `input: vector<u8>` (empty when the Walrus-blob path was used). */
  input?: Uint8Array;
  /** sha2_256 of the input, hex (no 0x). */
  inputHashHex?: string;
  /** sha2_256 of the output, hex (no 0x). */
  outputHashHex?: string;
  /** Walrus blob id of the completion (`0`/none → undefined). */
  outputBlobId?: string;
  /** Walrus blob id of the prompt (`0`/none → undefined; inline jobs leave this 0). */
  inputBlobId?: string;
}

/** Decode a Move `vector<u8>` from the JSON-RPC `showContent` shape (a number[] or a
 *  base64 string, depending on serialization) into raw bytes. */
function decodeMoveU8Vector(v: unknown): Uint8Array | undefined {
  if (v == null) return undefined;
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  if (typeof v === "string") {
    // Some RPC encodings return vector<u8> as base64.
    try {
      const bin = atob(v);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Decode a Move `vector<u8>` into lowercase hex (no 0x). */
function decodeMoveU8VectorHex(v: unknown): string | undefined {
  const bytes = decodeMoveU8Vector(v);
  if (!bytes) return undefined;
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Decode a Move `u256` blob id (string|number) → a non-zero decimal string, or undefined
 *  when it's `0`/absent (the inline-input path commits no Walrus blob). */
function decodeMoveBlobId(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
  if (!s || s === "0") return undefined;
  return s;
}
