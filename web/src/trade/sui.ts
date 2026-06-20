// web/src/trade/sui.ts
// The REAL OrderClient (UI contract §5; demo-milestone-contract §4/§5). Replaces
// MockOrderClient via store.tsx `orderClientRef` when VITE_ORDER_CLIENT=sui.
//
// `buy(market, qtyScu, price, prompt)` IS the demo-contract runTask flow:
//   1. POST {prompt} to the provider node /inputs            → { inputHash }
//   2. create_job<M>(... input_hash ...) funding MOCK_USDC escrow, signed by the
//      connected wallet/burner                                → shared Job id + digest
//   3. the store tracks the job; when it reaches Attested/Settled the result viewer
//      GETs /result/:jobId, re-hashes the output, and checks it vs the on-chain hash.
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
  fetchVerifiedResult,
  sha2_256Bytes,
  type JobResult,
} from "./result";
import type { Account, Balances, OrderClient, OrderResult } from "./types";

type SuiClientT = import("@mysten/sui/client").SuiClient;
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

  /** Discovered once per provider: its ProviderStake id + a Credit<M> coin id. */
  private providerStakeId: string | null = null;
  private providerCreditCoinId: string | null = null;

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
    const { SuiClient } = await import("@mysten/sui/client");
    const { Transaction } = await import("@mysten/sui/transactions");
    this.client = new SuiClient({ url: this.cfg.rpcUrl });
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
  // A buy WITHOUT a prompt still works (empty prompt → input_hash of ""), but the demo
  // path is runTask(prompt). The store calls runTask for buys so the prompt flows.
  async buy(marketId: string, qtyScu: number, priceUsdcPerScu: number): Promise<OrderResult> {
    const r = await this.runTask({ marketId, qtyScu, priceUsdcPerScu, prompt: "" });
    return r;
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

  /** runTask = the demo-contract buy: POST prompt → create_job (fund escrow) → return job. */
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

    const escrowBase = toBaseUnits(args.qtyScu * args.priceUsdcPerScu);
    if (escrowBase <= 0) return { ok: false, error: "escrow must be > 0 (set a price)" };

    // 1. Submit the prompt to the provider; it caches by hash and returns input_hash.
    //    Fall back to a local sha2_256 if the provider is unreachable so the on-chain
    //    create_job still binds the right hash for the node to match against later.
    let inputHashHex: string;
    try {
      const { inputHash } = await this.provider.submitInput(args.prompt);
      inputHashHex = inputHash;
    } catch (e) {
      console.warn("[gix] provider /inputs unreachable; computing input_hash locally", e);
      const bytes = await sha2_256Bytes(args.prompt);
      inputHashHex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
    }

    // 2. Resolve the provider's ProviderStake + Credit<M> coin (the stubbed match
    //    counterparty), then build + sign create_job funding the MOCK_USDC escrow.
    try {
      await this.resolveProviderObjects();
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }

    let tx: TransactionT;
    try {
      tx = await this.buildCreateJobTx(escrowBase, args.qtyScu, inputHashHex);
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

  /** Fetch + verify the settled result for a job (called by the store/result viewer). */
  async getResult(
    jobId: string,
    extra?: { costUsdc?: number; digest?: string },
  ): Promise<JobResult> {
    return fetchVerifiedResult(this.provider, jobId, extra);
  }

  /** Provider /health (surfaced as a liveness hint in the UI). */
  async providerHealth(): Promise<{ ok: boolean; model?: string; gpu?: string }> {
    return this.provider.health();
  }

  // ── chain helpers (mirror harness/src/chain/sui.ts) ─────────────────────────

  /** Discover the provider's ProviderStake id + a Credit<M> coin id via owned objects.
   *  In M1/the demo the provider operator (cfg.providerAddress) holds both, minted at
   *  node setup. Cached after the first resolve. */
  private async resolveProviderObjects(): Promise<void> {
    if (this.providerStakeId && this.providerCreditCoinId) return;
    const owner = this.cfg.providerAddress;
    const stakeType = `${this.cfg.packageId}::staking::ProviderStake`;
    const creditType = `${this.cfg.packageId}::credit::Credit<${this.cfg.market.creditType}>`;

    let cursor: string | null | undefined = undefined;
    do {
      const page = await this.client.getOwnedObjects({
        owner,
        cursor,
        options: { showType: true },
      });
      for (const o of page.data) {
        const t = o.data?.type ?? "";
        if (!this.providerStakeId && t === stakeType) {
          this.providerStakeId = o.data!.objectId;
        }
        if (!this.providerCreditCoinId && t.startsWith(`0x2::coin::Coin<${creditType}`)) {
          this.providerCreditCoinId = o.data!.objectId;
        }
      }
      cursor = page.hasNextPage ? page.nextCursor : null;
    } while (cursor && (!this.providerStakeId || !this.providerCreditCoinId));

    if (!this.providerStakeId) {
      throw new Error(
        `no ProviderStake owned by provider ${owner.slice(0, 10)}… — is the provider node registered + staked?`,
      );
    }
    if (!this.providerCreditCoinId) {
      throw new Error(
        `no Credit<M> coin owned by provider ${owner.slice(0, 10)}… — has it minted credits for this market?`,
      );
    }
  }

  /** Build the create_job<M> PTB. Splits the exact MOCK_USDC escrow from the buyer's
   *  coins and a Credit<M> slice from the provider's coin (matches harness createJob). */
  private async buildCreateJobTx(
    escrowBase: number,
    qtyScu: number,
    inputHashHex: string,
  ): Promise<TransactionT> {
    const tx = new this.Transaction();
    const market = this.cfg.market;

    // escrow_in: a Coin<MOCK_USDC> of exactly `escrowBase`, split from the buyer's coins.
    const escrowCoin = await this.splitEscrowCoin(tx, this.signer!.address, escrowBase);
    // credits: a Credit<M> slice for qtyScu out of the provider's minted coin.
    const creditCoin = tx.splitCoins(tx.object(this.providerCreditCoinId!), [
      tx.pure.u64(BigInt(qtyScu)),
    ])[0];

    // create_job<M>(cfg, market, stake: &mut ProviderStake, provider, credits, escrow_in,
    //   input_hash, clk, ctx): ID — shares the Job; consumer is ctx.sender() (the buyer).
    tx.moveCall({
      target: `${this.cfg.packageId}::job::create_job`,
      typeArguments: [market.creditType],
      arguments: [
        tx.object(this.cfg.configId),
        tx.object(market.id),
        tx.object(this.providerStakeId!),
        tx.pure.address(this.cfg.providerAddress),
        creditCoin,
        escrowCoin,
        tx.pure.vector("u8", hexToBytes(inputHashHex)),
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

// --- pure helpers ----------------------------------------------------------
function hexToBytes(hex: string): number[] {
  const clean = /^0x/i.test(hex) ? hex.slice(2) : hex;
  const out: number[] = [];
  for (let i = 0; i + 1 < clean.length; i += 2) {
    out.push(parseInt(clean.slice(i, i + 2), 16));
  }
  return out;
}
