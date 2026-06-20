/**
 * DeepBook v3 maker for the provider node (M2, testnet).
 *
 * Replaces the gix shared-Ask (`staking::post_ask`) on testnet: instead of parking
 * credits in a gix `Ask<M>`, the provider posts a resting **limit ask** on the market's
 * DeepBook `Pool<Credit<M>, USDC>` — it sells minted `Credit<M>` for the quote coin (our
 * MOCK_USDC) at `GIX_ASK_PRICE_USDC`. A consumer then swaps USDC→Credit on that pool
 * (which pays this maker at the fill, off-chain to GIX) and feeds the credits into
 * `job::create_job_from_fill` in the same PTB. See docs/m2-phase0-design.md (Option B).
 *
 * Composition (per contracts/README.md): the gix package takes NO DeepBook Move dependency — the
 * link is purely the `Pool` id bound on `Market<M>` (market::set_deepbook_pool_id) and the
 * DEEP coin / package ids the SDK supplies. This module owns the DeepBook side only:
 *   1. createBalanceManager()   — create + share a BalanceManager (owned by this node).
 *   2. depositCredits(qtyScu)   — deposit minted Coin<Credit<M>> into the manager.
 *   3. placeAsk(qtyScu, price)  — placeLimitOrder isBid:false, payWithDeep:false where
 *                                 possible (input-token fees), POST_ONLY (a true maker).
 *   4. refresh / cancel         — cancel + re-place when remaining base runs low.
 *
 * Coins/pools are registered under stable keys ("CREDIT", "USDC", "GIX") in custom maps so
 * the SDK resolves our market's types instead of the canonical testnet pairs. Quantities,
 * prices and deposits are passed as BIGINT so the SDK treats them as RAW on-chain u64
 * (no decimal scaling) — matching gix's base-unit accounting (1 SCU = 1 Credit base unit).
 *
 * Testnet DeepBook package ids + the DEEP coin (0x36dbef86…::deep::DEEP) come from the
 * SDK's `testnetPackageIds` / `testnetCoins` (NOT in the bundled docs). Lazy-imported and
 * gated so non-testnet runs never load it.
 */

import type { Keypair } from "@mysten/sui/cryptography";
import type { TransactionT } from "./txtypes.js";

/** The stable keys we register our market's coins + pool under in the DeepBook SDK maps. */
export const COIN_KEY_CREDIT = "CREDIT";
export const COIN_KEY_USDC = "USDC";
export const COIN_KEY_DEEP = "DEEP";
export const POOL_KEY = "GIX";
/** The single BalanceManager this node owns + trades through. */
export const MANAGER_KEY = "GIX_BM";

export interface DeepBookMakerDeps {
  network: "testnet" | "mainnet";
  rpcUrl: string;
  signer: Keypair;
  /** This node's Sui address (BalanceManager owner / order owner). */
  address: string;
  /** The base coin type — Credit<M> (deployment.markets[].creditCoinType). */
  creditCoinType: string;
  /** The quote coin type — MOCK_USDC (deployment.usdcType). */
  usdcType: string;
  /** The bound DeepBook Pool<Credit<M>,USDC> id (market.deepbookPoolId). */
  poolId: string;
  /** Pay fees with the input token rather than DEEP where the pool allows it. */
  inputTokenFees: boolean;
  log: (msg: string) => void;
}

type DeepBookClientT = import("@mysten/deepbook-v3").DeepBookClient;

/**
 * DeepBook maker. The BalanceManager id is captured on first creation and threaded back
 * into the client (so subsequent deposits/orders resolve it by key).
 */
export class DeepBookMaker {
  private dbClient?: DeepBookClientT;
  private Transaction!: new () => TransactionT;
  private balanceManagerId?: string;
  /** Live order ids placed by this maker (so we can cancel/refresh them). */
  private orderIds = new Set<string>();
  private connected = false;

  constructor(private readonly deps: DeepBookMakerDeps) {}

  get managerId(): string | undefined {
    return this.balanceManagerId;
  }
  get liveOrderIds(): string[] {
    return [...this.orderIds];
  }

  // ---- connection -----------------------------------------------------------

  /**
   * Initialize the DeepBook + Transaction clients WITHOUT any RPC call (the SDK clients are
   * lazy at construction). Exposed so the PTB-builder methods (buildPlaceAskTx etc.) can be
   * exercised hermetically in unit tests by passing a known BalanceManager id.
   */
  async prepare(balanceManagerId?: string): Promise<void> {
    if (balanceManagerId) this.balanceManagerId = balanceManagerId;
    await this.connect(balanceManagerId);
  }

  /** Build the DeepBookClient with our market's coins + pool registered under stable keys. */
  private async connect(balanceManagerId?: string): Promise<void> {
    if (this.connected && !balanceManagerId) return;
    const { SuiJsonRpcClient } = await import("@mysten/sui/jsonRpc");
    const { Transaction } = await import("@mysten/sui/transactions");
    const { DeepBookClient, testnetCoins, testnetPackageIds, mainnetCoins, mainnetPackageIds } =
      await import("@mysten/deepbook-v3");

    this.Transaction = Transaction as unknown as new () => TransactionT;

    const base = new SuiJsonRpcClient({ network: this.deps.network, url: this.deps.rpcUrl });
    const canonCoins = this.deps.network === "mainnet" ? mainnetCoins : testnetCoins;
    const packageIds = this.deps.network === "mainnet" ? mainnetPackageIds : testnetPackageIds;
    const deep = canonCoins.DEEP;

    // Our market's coins. scalar:1 => quantities/prices passed as bigint are used RAW.
    const coins = {
      [COIN_KEY_CREDIT]: { address: this.deps.creditCoinType, type: this.deps.creditCoinType, scalar: 1 },
      [COIN_KEY_USDC]: { address: this.deps.usdcType, type: this.deps.usdcType, scalar: 1 },
      // DEEP is needed for fee payment when payWithDeep:true (fallback path).
      [COIN_KEY_DEEP]: { address: deep.address, type: deep.type, scalar: deep.scalar },
    };
    const pools = {
      [POOL_KEY]: { address: this.deps.poolId, baseCoin: COIN_KEY_CREDIT, quoteCoin: COIN_KEY_USDC },
    };
    const balanceManagers = balanceManagerId
      ? { [MANAGER_KEY]: { address: balanceManagerId } }
      : undefined;

    this.dbClient = new DeepBookClient({
      client: base as unknown as ConstructorParameters<typeof DeepBookClient>[0]["client"],
      address: this.deps.address,
      network: this.deps.network,
      coins,
      pools,
      packageIds,
      ...(balanceManagers ? { balanceManagers } : {}),
    });
    this.connected = true;
  }

  // ---- balance manager ------------------------------------------------------

  /**
   * Create + share a BalanceManager owned by this node, if it does not have one yet.
   * Idempotent: first checks for an existing manager via getBalanceManagerIds(owner).
   * Returns the manager id. The manager is the on-chain account the maker's orders and
   * deposited credits live in.
   */
  async ensureBalanceManager(): Promise<string> {
    await this.connect(this.balanceManagerId);
    if (this.balanceManagerId) return this.balanceManagerId;

    // Reuse an existing manager if this address already owns one (restart-safe).
    try {
      const existing = await this.dbClient!.getBalanceManagerIds(this.deps.address);
      if (existing.length > 0) {
        this.balanceManagerId = existing[0];
        await this.connect(this.balanceManagerId);
        this.deps.log(`[deepbook] reusing BalanceManager ${this.balanceManagerId}`);
        return this.balanceManagerId!;
      }
    } catch (e) {
      this.deps.log(`[deepbook] getBalanceManagerIds failed (will create): ${(e as Error).message}`);
    }

    const tx = this.buildCreateBalanceManagerTx();
    const res = await this.exec(tx, "createBalanceManager");
    let bmId: string | undefined;
    for (const ch of res.objectChanges ?? []) {
      if (ch.type === "created" && ch.objectType.includes("::balance_manager::BalanceManager")) {
        bmId = ch.objectId;
      }
    }
    if (!bmId) throw new Error(`createBalanceManager: tx ${res.digest} created no BalanceManager`);
    this.balanceManagerId = bmId;
    await this.connect(bmId);
    this.deps.log(`[deepbook] created BalanceManager ${bmId} (digest ${res.digest})`);
    return bmId;
  }

  /** PTB: create + share a BalanceManager. Exposed for unit tests. */
  buildCreateBalanceManagerTx(): TransactionT {
    const tx = new this.Transaction();
    tx.add(this.dbClient!.balanceManager.createAndShareBalanceManager());
    return tx;
  }

  // ---- deposit credits ------------------------------------------------------

  /**
   * Deposit `qtyScu` of owned Coin<Credit<M>> into the BalanceManager. The minted credits
   * must already be in this node's wallet (mint via gix staking::mint_credits first). The
   * SDK's coinWithBalance auto-selects the owned Credit coins of that type.
   */
  async depositCredits(qtyScu: number | bigint): Promise<{ digest: string }> {
    if (!this.balanceManagerId) throw new Error("depositCredits: call ensureBalanceManager() first");
    await this.connect(this.balanceManagerId);
    const tx = this.buildDepositCreditsTx(qtyScu);
    const res = await this.exec(tx, "depositCredits");
    this.deps.log(`[deepbook] deposited ${qtyScu} SCU Credit into BM (digest ${res.digest})`);
    return { digest: res.digest };
  }

  /** PTB: deposit Credit into the manager (bigint = raw base units). Exposed for tests. */
  buildDepositCreditsTx(qtyScu: number | bigint): TransactionT {
    const tx = new this.Transaction();
    tx.add(
      this.dbClient!.balanceManager.depositIntoManager(
        MANAGER_KEY,
        COIN_KEY_CREDIT,
        qtyScu as unknown as number, // SDK signature is number; bigint passes through raw
      ),
    );
    return tx;
  }

  // ---- place / refresh / cancel the ask -------------------------------------

  /**
   * Place a resting limit ASK: sell `qtyScu` Credit for USDC at `priceUsdcPerScu` (RAW
   * on-chain price; the orchestrator aligns it to the pool tick). isBid:false (sell),
   * POST_ONLY (a true maker — never crosses), payWithDeep:false when input-token fees are
   * enabled. Returns the digest; the new order id is captured from the OrderPlaced event.
   */
  async placeAsk(
    qtyScu: number | bigint,
    priceUsdcPerScu: number | bigint,
    clientOrderId?: string,
  ): Promise<{ digest: string; orderId?: string }> {
    if (!this.balanceManagerId) throw new Error("placeAsk: call ensureBalanceManager() first");
    await this.connect(this.balanceManagerId);
    const tx = this.buildPlaceAskTx(qtyScu, priceUsdcPerScu, clientOrderId);
    const res = await this.exec(tx, "placeAsk");
    let orderId: string | undefined;
    for (const ev of res.events ?? []) {
      if (ev.type.endsWith("::order_info::OrderPlaced") || ev.type.includes("OrderPlaced")) {
        const f = (ev.parsedJson ?? {}) as Record<string, unknown>;
        orderId = (f.order_id as string) ?? (f.orderId as string) ?? undefined;
      }
    }
    if (orderId) this.orderIds.add(orderId);
    this.deps.log(
      `[deepbook] placed ASK ${qtyScu} SCU @ ${priceUsdcPerScu} (order ${orderId ?? "?"}, digest ${res.digest})`,
    );
    return { digest: res.digest, orderId };
  }

  /**
   * PTB: a resting maker ask. payWithDeep:false (input-token fees) when configured; the
   * SDK note that it "must be true" is stale (m2-phase0-design.md). Exposed for tests.
   */
  buildPlaceAskTx(
    qtyScu: number | bigint,
    priceUsdcPerScu: number | bigint,
    clientOrderId?: string,
  ): TransactionT {
    const tx = new this.Transaction();
    // OrderType.POST_ONLY = 3 (declared in the SDK enum); literal keeps this tree-shake-safe.
    const POST_ONLY = 3;
    tx.add(
      this.dbClient!.deepBook.placeLimitOrder({
        poolKey: POOL_KEY,
        balanceManagerKey: MANAGER_KEY,
        clientOrderId: clientOrderId ?? String(Date.now()),
        price: priceUsdcPerScu,
        quantity: qtyScu,
        isBid: false, // ASK: sell Credit for USDC
        orderType: POST_ONLY,
        payWithDeep: !this.deps.inputTokenFees,
      }),
    );
    return tx;
  }

  /** Cancel a single live order by id. */
  async cancelAsk(orderId: string): Promise<{ digest: string }> {
    if (!this.balanceManagerId) throw new Error("cancelAsk: call ensureBalanceManager() first");
    await this.connect(this.balanceManagerId);
    const tx = new this.Transaction();
    tx.add(this.dbClient!.deepBook.cancelOrder(POOL_KEY, MANAGER_KEY, orderId));
    const res = await this.exec(tx, "cancelAsk");
    this.orderIds.delete(orderId);
    this.deps.log(`[deepbook] cancelled order ${orderId} (digest ${res.digest})`);
    return { digest: res.digest };
  }

  /** Cancel every live order this manager has (used on refresh / shutdown). */
  async cancelAllAsks(): Promise<{ digest: string } | null> {
    if (!this.balanceManagerId) return null;
    await this.connect(this.balanceManagerId);
    const tx = new this.Transaction();
    tx.add(this.dbClient!.deepBook.cancelAllOrders(POOL_KEY, MANAGER_KEY));
    const res = await this.exec(tx, "cancelAllAsks");
    this.orderIds.clear();
    this.deps.log(`[deepbook] cancelled all orders (digest ${res.digest})`);
    return { digest: res.digest };
  }

  /**
   * Read the remaining (unfilled) base quantity resting across this manager's open ask
   * orders, in SCU. Used by the refresh loop to decide when to re-post. Best-effort:
   * returns undefined if the read fails.
   */
  async getRestingBaseScu(): Promise<number | undefined> {
    if (!this.balanceManagerId) return undefined;
    await this.connect(this.balanceManagerId);
    try {
      const details = await this.dbClient!.getAccountOrderDetails(POOL_KEY, MANAGER_KEY);
      if (!Array.isArray(details)) return 0;
      let remaining = 0;
      for (const o of details) {
        const qty = Number(o.quantity ?? 0);
        const filled = Number(o.filled_quantity ?? 0);
        remaining += Math.max(0, qty - filled);
      }
      return remaining;
    } catch (e) {
      this.deps.log(`[deepbook] getRestingBaseScu failed: ${(e as Error).message}`);
      return undefined;
    }
  }

  // ---- low-level exec (mirrors NodeChain.exec) ------------------------------

  private async exec(tx: TransactionT, where: string) {
    const { SuiJsonRpcClient } = await import("@mysten/sui/jsonRpc");
    const client = new SuiJsonRpcClient({ network: this.deps.network, url: this.deps.rpcUrl });
    const res = await client.signAndExecuteTransaction({
      transaction: tx as unknown as Parameters<
        typeof client.signAndExecuteTransaction
      >[0]["transaction"],
      signer: this.deps.signer,
      options: { showEffects: true, showEvents: true, showObjectChanges: true },
    });
    await client.waitForTransaction({ digest: res.digest });
    const status = res.effects?.status;
    if (status && status.status !== "success") {
      throw new Error(`DeepBookMaker.${where}: tx ${res.digest} failed: ${status.error ?? "unknown"}`);
    }
    return res;
  }
}
