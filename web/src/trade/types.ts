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

export interface OrderClient {
  connect(): Promise<Account>; // burner key
  fund(): Promise<void>; // localnet SUI + MOCK_USDC faucet
  balances(): Promise<Balances>;
  // consumer buys compute → in M1 this drives the stubbed match → create_job lifecycle
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
}
