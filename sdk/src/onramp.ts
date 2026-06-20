/**
 * SUI → DBUSDC on-ramp — a real DeepBook swap that needs NO DEEP.
 *
 * Users hold SUI (gas) but compute is priced in USDC. On testnet the dollar is
 * DBUSDC (the testnet USDC stand-in, per docs/onramp-dbusdc-plan.md). This module
 * swaps `SUI → DBUSDC` on the EXISTING, liquid DeepBook testnet pool
 *   SUI_DBUSDC  (0x1c19362ca5… , base = SUI, quote = DBUSDC)
 * via `pool::swap_exact_base_for_quote` with **input-coin fees**
 * (`deepAmount: 0` ⇒ `pay_with_deep: false`), so it requires no DEEP at all and
 * works against the live pool today.
 *
 * The pool, the SUI/DBUSDC/DEEP coins, and the DeepBook package id are all
 * pre-registered in `@mysten/deepbook-v3`'s testnet constants, so we drive the
 * swap straight off `DeepBookClient.deepBook.swapExactBaseForQuote` (it sources
 * the SUI in from the gas coin via `coinWithBalance` and mints a zero Coin<DEEP>
 * for the input-fee path). Client is `SuiJsonRpcClient` (sui 2.x, testnet).
 *
 * Hermetic by design: nothing imports @mysten/* at module load; the SDK + DeepBook
 * client are dynamically imported the first time a swap or quote runs.
 */

import type { WalletSigner } from "./types.js";

type SuiClientT = import("@mysten/sui/jsonRpc").SuiJsonRpcClient;
type TransactionT = import("@mysten/sui/transactions").Transaction;

/** The testnet DBUSDC coin type (the testnet USDC stand-in). PINNED — matches
 * `@mysten/deepbook-v3` `testnetCoins.DBUSDC.type` and docs/onramp-dbusdc-plan.md. */
export const TESTNET_DBUSDC_COIN_TYPE =
  "0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC";

/** SUI native coin type. */
export const SUI_COIN_TYPE = "0x2::sui::SUI";

/** The live testnet SUI_DBUSDC pool id (base = SUI, quote = DBUSDC). PINNED —
 * matches `@mysten/deepbook-v3` `testnetPools.SUI_DBUSDC.address`. */
export const TESTNET_SUI_DBUSDC_POOL_ID =
  "0x1c19362ca52b8ffd7a33cee805a67d40f31e6ba303753fd3a4cfdfacea7163a5";

/** The DeepBook pool KEY (not id) for the SUI/DBUSDC pair in the SDK's testnet
 * constant map; `DeepBookClient` resolves the pool object by this key. */
export const SUI_DBUSDC_POOL_KEY = "SUI_DBUSDC";

/** On-chain decimals. SUI = 9 (MIST), DBUSDC = 6 (matches USDC). */
export const SUI_DECIMALS = 9;
export const DBUSDC_DECIMALS = 6;
const SUI_SCALAR = 10 ** SUI_DECIMALS; // 1e9
const DBUSDC_SCALAR = 10 ** DBUSDC_DECIMALS; // 1e6

/** Default slippage tolerance applied to the quoted DBUSDC-out to derive `minOut`. */
const DEFAULT_SLIPPAGE_BPS = 100; // 1.00%

/** A priced quote for a SUI → DBUSDC swap (input-fee path; no DEEP). */
export interface SuiDbusdcQuote {
  /** SUI being sold (whole SUI, e.g. 0.1). */
  amountSui: number;
  /** DBUSDC the pool would pay out (whole DBUSDC), net of the input-coin fee. */
  dbusdcOut: number;
  /** Effective price, DBUSDC per SUI (dbusdcOut / amountSui). 0 if unpriceable. */
  priceDbusdcPerSui: number;
  /** DEEP required for this path — always 0 (input-coin fees). */
  deepRequired: number;
  /** SUI that actually fills (amountSui − the unfillable sub-lot remainder). 0 ⇒
   * the amount is below the pool's min order size and nothing would match. */
  suiFilled: number;
}

/** The outcome of an executed SUI → DBUSDC swap. */
export interface SwapSuiForDbusdcResult {
  /** The swap transaction digest. */
  digest: string;
  /** SUI sold (whole SUI). */
  amountSui: number;
  /** DBUSDC received (whole DBUSDC), measured from the tx's balance changes. */
  dbusdcReceived: number;
  /** DBUSDC received in base units (6dp), from balance changes. */
  dbusdcReceivedBase: bigint;
  /** Net SUI spent (incl. gas), from balance changes (whole SUI; negative = spent). */
  suiDelta: number;
  /** The min DBUSDC-out floor (base units) the swap enforced. */
  minOutBase: bigint;
}

/** A `@mysten/sui` Signer (keypair) OR the WalletSigner seam (injected wallet). */
export type OnRampSigner = WalletSigner | import("@mysten/sui/cryptography").Signer;

export interface OnRampClientOptions {
  /** Sui RPC url. Defaults to the public testnet fullnode. */
  rpcUrl?: string;
  /** Network — DeepBook on-ramp is testnet-only for GIX. Default "testnet". */
  network?: "testnet" | "mainnet";
  /** Optional logger; defaults to a no-op. */
  logger?: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * OnRampClient — the SUI → DBUSDC swap surface (no DEEP).
 *
 * Build once, then:
 *   • `quote(amountSui)` — read the live DBUSDC-out for a SUI-in (input-fee path).
 *   • `swapSuiForDbusdc(amountSui, signer)` — execute the real swap, returning the
 *     digest + DBUSDC received.
 *   • `balances(address)` — read SUI + DBUSDC balances.
 */
export class OnRampClient {
  private client?: SuiClientT;
  private Transaction!: new () => TransactionT;
  private readonly rpcUrl?: string;
  private readonly network: "testnet" | "mainnet";

  constructor(opts: OnRampClientOptions = {}) {
    this.rpcUrl = opts.rpcUrl;
    this.network = opts.network ?? "testnet";
    this.log = opts.logger ?? (() => {});
  }

  private readonly log: (msg: string, meta?: Record<string, unknown>) => void;

  /** The connected SuiJsonRpcClient (lazy). */
  async suiClient(): Promise<SuiClientT> {
    if (this.client) return this.client;
    const { SuiJsonRpcClient, getJsonRpcFullnodeUrl } = await import("@mysten/sui/jsonRpc");
    const { Transaction } = await import("@mysten/sui/transactions");
    const url = this.rpcUrl ?? getJsonRpcFullnodeUrl(this.network);
    this.client = new SuiJsonRpcClient({ network: this.network, url });
    this.Transaction = Transaction as unknown as new () => TransactionT;
    return this.client;
  }

  /** Build a read/build DeepBookClient bound to `address` (any valid addr works
   * for read simulations; the SUI/DBUSDC/DEEP coins + SUI_DBUSDC pool come from
   * the SDK's built-in testnet constant maps). */
  private async deepBookClient(address: string) {
    const sui = await this.suiClient();
    const { DeepBookClient } = await import("@mysten/deepbook-v3");
    return new DeepBookClient({
      client: sui as unknown as never,
      address,
      network: this.network as never,
    });
  }

  /**
   * Live price for a SUI → DBUSDC swap on SUI_DBUSDC, input-coin-fee path (no
   * DEEP). Reads `getQuoteQuantityOutInputFee(SUI_DBUSDC, amountSui)` — the
   * pool's devInspect of base→quote with the input-fee charged in SUI. Returns
   * the DBUSDC out (whole) + effective DBUSDC/SUI price.
   *
   * Throws if the pool is unreachable or cannot price the amount (so callers can
   * STOP before spending) — see the smoke script's dry-run gate.
   */
  async quote(amountSui: number): Promise<SuiDbusdcQuote> {
    if (!(amountSui > 0)) throw new Error("quote: amountSui must be > 0");
    const db = await this.deepBookClient(ZERO_ADDR);
    // baseQuantity is in whole SUI units; the SDK scales internally. The
    // input-fee read returns `baseOut` = the UNFILLED base remainder (sub-lot
    // dust) + `quoteOut` = the DBUSDC the fill would pay.
    const q = await db.getQuoteQuantityOutInputFee(SUI_DBUSDC_POOL_KEY, amountSui);
    const dbusdcOut = Number(q.quoteOut ?? 0);
    const suiFilled = Math.max(0, amountSui - Number(q.baseOut ?? 0));
    if (!(dbusdcOut > 0)) {
      throw new Error(
        `quote: SUI_DBUSDC filled 0 for ${amountSui} SUI — below the pool min order ` +
          `size (1 SUI) or empty book. Increase the amount (≥ ~1.1 SUI fills on the live pool).`,
      );
    }
    return {
      amountSui,
      dbusdcOut,
      priceDbusdcPerSui: dbusdcOut / amountSui,
      deepRequired: Number(q.deepRequired ?? 0),
      suiFilled,
    };
  }

  /** SUI + DBUSDC balances for an address (base units). */
  async balances(address: string): Promise<{ sui: bigint; dbusdc: bigint }> {
    const sui = await this.suiClient();
    const [s, d] = await Promise.all([
      sui.getBalance({ owner: address }),
      sui.getBalance({ owner: address, coinType: TESTNET_DBUSDC_COIN_TYPE }),
    ]);
    return { sui: BigInt(s.totalBalance), dbusdc: BigInt(d.totalBalance) };
  }

  /**
   * Execute the real SUI → DBUSDC swap on SUI_DBUSDC (input-coin fees, NO DEEP).
   *
   * Builds the PTB via `DeepBookClient.deepBook.swapExactBaseForQuote`:
   *   pool::swap_exact_base_for_quote<SUI, DBUSDC>(pool, suiIn, deep(0), minOut, clk)
   *     -> (Coin<SUI>, Coin<DBUSDC>, Coin<DEEP>)
   * The helper sources `suiIn` from the gas coin (`coinWithBalance`) and mints a
   * zero `Coin<DEEP>` (deepAmount: 0). The three result coins (the SUI remainder
   * — drained to ~0, the DBUSDC out, and the zero DEEP coin) are transferred back
   * to the sender so the PTB has no unused values.
   *
   * `minOut` is derived from the live quote minus `slippageBps` (default 1%), so
   * the swap reverts rather than fill at a worse price. Pass `minDbusdcOut`
   * (whole DBUSDC) to set the floor explicitly.
   */
  /**
   * Build (but do NOT sign) the SUI → DBUSDC swap PTB + return the live quote and
   * derived min-out floor. The UI uses this to sign via the connected wallet
   * (dapp-kit `useSignTransaction`/`signAndExecute`), reusing the exact same
   * priced/slippage-guarded PTB the keypair path executes.
   */
  async buildSwapTransaction(
    amountSui: number,
    sender: string,
    opts: { slippageBps?: number; minDbusdcOut?: number } = {},
  ): Promise<{ tx: TransactionT; quote: SuiDbusdcQuote; minOutBase: bigint }> {
    if (!(amountSui > 0)) throw new Error("buildSwapTransaction: amountSui must be > 0");
    await this.suiClient(); // ensure the client + Transaction ctor are connected

    // 1. Price the swap (also confirms the pool is live + can fill the amount).
    const quote = await this.quote(amountSui);

    // 2. Derive the min-out floor (base units, 6dp).
    const slippageBps = opts.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
    const minOutWhole =
      opts.minDbusdcOut != null
        ? opts.minDbusdcOut
        : (quote.dbusdcOut * (10_000 - slippageBps)) / 10_000;
    const minOutBase = BigInt(Math.max(0, Math.floor(minOutWhole * DBUSDC_SCALAR)));

    // 3. Build the swap PTB via the DeepBook SDK (input-coin fees: deepAmount 0).
    const db = await this.deepBookClient(sender);
    const tx = new this.Transaction();
    tx.setSenderIfNotSet(sender);

    const [suiRemainder, dbusdcOutCoin, deepRemainder] = db.deepBook.swapExactBaseForQuote({
      poolKey: SUI_DBUSDC_POOL_KEY,
      amount: amountSui, // whole SUI; SDK scales by 1e9
      deepAmount: 0, // input-coin fees ⇒ pay_with_deep: false, no DEEP needed
      minOut: minOutBase, // bigint ⇒ used as the raw u64 floor (6dp)
    })(tx as never) as unknown as [unknown, unknown, unknown];

    // Hand back all three result coins so the PTB has no dangling values. The
    // DBUSDC out is what the user came for; the SUI remainder (drained to ~0) +
    // the zero DEEP coin must still be transferred to avoid UnusedValue.
    tx.transferObjects(
      [suiRemainder as never, dbusdcOutCoin as never, deepRemainder as never],
      tx.pure.address(sender),
    );

    this.log("onramp swap built", {
      amountSui,
      minOutBase: minOutBase.toString(),
      estDbusdcOut: quote.dbusdcOut,
    });
    return { tx, quote, minOutBase };
  }

  /**
   * Parse an executed swap's effects/balance-changes into the on-ramp result.
   * Exposed so the wallet (dapp-kit) path can reuse the SAME accounting the
   * keypair path uses, after it signs + executes the built PTB itself.
   */
  parseSwapResult(
    res: {
      digest: string;
      balanceChanges?: Array<{ coinType?: string; owner?: unknown; amount?: string }> | null;
    },
    amountSui: number,
    sender: string,
    minOutBase: bigint,
  ): SwapSuiForDbusdcResult {
    const { dbusdcBase, suiBase } = readBalanceChanges(res, sender);
    return {
      digest: res.digest,
      amountSui,
      dbusdcReceived: Number(dbusdcBase) / DBUSDC_SCALAR,
      dbusdcReceivedBase: dbusdcBase,
      suiDelta: Number(suiBase) / SUI_SCALAR,
      minOutBase,
    };
  }

  async swapSuiForDbusdc(
    amountSui: number,
    signer: OnRampSigner,
    opts: { slippageBps?: number; minDbusdcOut?: number } = {},
  ): Promise<SwapSuiForDbusdcResult> {
    if (!(amountSui > 0)) throw new Error("swapSuiForDbusdc: amountSui must be > 0");
    const sender = signer.toSuiAddress();

    // Build the priced, slippage-guarded PTB (steps 1–3), then sign + execute.
    const { tx, minOutBase } = await this.buildSwapTransaction(amountSui, sender, opts);
    const res = await this.execute(tx, signer);
    const status = res.effects?.status;
    if (status && status.status !== "success") {
      throw new Error(`swapSuiForDbusdc tx ${res.digest} failed: ${status.error ?? "unknown"}`);
    }

    // Measure DBUSDC received + net SUI delta from the tx balance changes.
    return this.parseSwapResult(res, amountSui, sender, minOutBase);
  }

  /** Sign + execute via the WalletSigner seam OR a raw @mysten/sui Signer. */
  private async execute(tx: TransactionT, signer: OnRampSigner) {
    const sui = this.client!;
    tx.setSenderIfNotSet(signer.toSuiAddress());
    const bytes = await tx.build({ client: sui });
    const { signature } = await signer.signTransaction(bytes);
    const res = await sui.executeTransactionBlock({
      transactionBlock: toB64(bytes),
      signature,
      options: { showEffects: true, showBalanceChanges: true, showObjectChanges: true },
    });
    await sui.waitForTransaction({ digest: res.digest });
    return res;
  }
}

const ZERO_ADDR =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

/** Sum the sender's SUI + DBUSDC net balance changes (base units) from a tx. */
function readBalanceChanges(
  res: { balanceChanges?: Array<{ coinType?: string; owner?: unknown; amount?: string }> | null },
  sender: string,
): { dbusdcBase: bigint; suiBase: bigint } {
  let dbusdcBase = 0n;
  let suiBase = 0n;
  for (const bc of res.balanceChanges ?? []) {
    const owner = bc.owner as { AddressOwner?: string } | undefined;
    if (owner?.AddressOwner !== sender) continue;
    const amt = BigInt(bc.amount ?? "0");
    if (bc.coinType === TESTNET_DBUSDC_COIN_TYPE) dbusdcBase += amt;
    else if (bc.coinType === SUI_COIN_TYPE) suiBase += amt;
  }
  return { dbusdcBase, suiBase };
}

function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
