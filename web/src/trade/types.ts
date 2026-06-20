// web/src/trade/types.ts
// Order submission seam (MVP M1.5 UI contract §5). The OrderTicket calls an INJECTED
// OrderClient; the real tx client (burner Ed25519 key + localnet faucet + PTB submit)
// is owned by Agent C in web/src/trade/. The UI only ever depends on this interface.

export interface Account {
  address: string;
}

export interface Balances {
  sui: number;
  usdc: number;
  creditsScu?: number;
}

export interface OrderResult {
  ok: boolean;
  digest?: string;
  jobId?: string;
  error?: string;
}

/** Redeem held credits → run a job. The prompt (the real inference task) lives HERE,
 *  not on a plain buy — buying credits is a trade, running a job consumes them. */
export interface RunArgs {
  marketId: string;
  qtyScu: number;
  prompt: string;
}

export interface OrderClient {
  connect(): Promise<Account>; // burner key
  fund(): Promise<void>; // localnet SUI + MOCK_USDC faucet
  balances(): Promise<Balances>;
  // SPOT TRADE — acquire credits only (USDC → Credit<M>). Holds the coin in balance;
  // NO create_job, NO prompt. Buying compute ≠ running a job.
  buy(
    marketId: string,
    qtyScu: number,
    priceUsdcPerScu: number,
  ): Promise<OrderResult>;
  // provider sells capacity → stake (if needed) + mint_credits + post ask
  sell(
    marketId: string,
    qtyScu: number,
    priceUsdcPerScu: number,
  ): Promise<OrderResult>;
  // REDEEM — consume held credits to run a job (create_job from a held Credit<M>; NO swap).
  // The prompt is required here — this is where a credit turns into an inference job.
  run(args: RunArgs): Promise<OrderResult>;
}
