// web/src/trade/mock.ts
// Default OrderClient used by the ticket until Agent C ships the real tx client.
// It simulates the burner-wallet flow (connect → fund → balances) and, on buy/sell,
// emits an OPTIMISTIC trade + job into the running MockDataSource so the user sees
// their order hit the tape and flow through My Jobs to Settled.

import type { MockDataSource } from "../data/mock";
import type { Side } from "../data/types";
import type {
  Account,
  Balances,
  OrderClient,
  OrderResult,
} from "./types";

function fakeAddress(): string {
  const hex = Array.from({ length: 40 }, () =>
    "0123456789abcdef"[Math.floor(Math.random() * 16)],
  ).join("");
  return `0x${hex}`;
}

function fakeDigest(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz123456789";
  return Array.from({ length: 44 }, () =>
    chars[Math.floor(Math.random() * chars.length)],
  ).join("");
}

export class MockOrderClient implements OrderClient {
  private account: Account | null = null;
  private bal: Balances = { sui: 0, usdc: 0, creditsScu: 0 };

  // optional handle to the live data source so orders surface on the tape + My Jobs
  constructor(private source?: MockDataSource) {}

  async connect(): Promise<Account> {
    await wait(220);
    this.account = { address: fakeAddress() };
    // start with a small non-zero balance so the % slider is usable pre-fund
    if (this.bal.usdc === 0 && this.bal.sui === 0) {
      this.bal = { sui: 0, usdc: 0, creditsScu: 0 };
    }
    return this.account;
  }

  async fund(): Promise<void> {
    await wait(420);
    this.bal = {
      sui: round(this.bal.sui + 10, 4),
      usdc: round(this.bal.usdc + 50_000, 4),
      creditsScu: (this.bal.creditsScu ?? 0) + 250_000,
    };
  }

  async balances(): Promise<Balances> {
    await wait(60);
    return { ...this.bal };
  }

  async buy(
    marketId: string,
    qtyScu: number,
    priceUsdcPerScu: number,
  ): Promise<OrderResult> {
    return this.place("buy", marketId, qtyScu, priceUsdcPerScu);
  }

  async sell(
    marketId: string,
    qtyScu: number,
    priceUsdcPerScu: number,
  ): Promise<OrderResult> {
    return this.place("sell", marketId, qtyScu, priceUsdcPerScu);
  }

  private async place(
    side: Side,
    marketId: string,
    qtyScu: number,
    priceUsdcPerScu: number,
  ): Promise<OrderResult> {
    if (!this.account) {
      return { ok: false, error: "wallet not connected" };
    }
    if (qtyScu <= 0) return { ok: false, error: "quantity must be > 0" };

    const cost = qtyScu * priceUsdcPerScu;
    await wait(380);

    if (side === "buy") {
      if (cost > this.bal.usdc) {
        return { ok: false, error: "insufficient USDC — fund the burner first" };
      }
      this.bal.usdc = round(this.bal.usdc - cost, 4);
      this.bal.creditsScu = (this.bal.creditsScu ?? 0); // credits arrive via job settle
    } else {
      const have = this.bal.creditsScu ?? 0;
      if (qtyScu > have) {
        return { ok: false, error: "insufficient SCU credits to sell" };
      }
      this.bal.creditsScu = round(have - qtyScu, 4);
      this.bal.usdc = round(this.bal.usdc + cost, 4);
    }

    const jobId = this.source?.injectOrder(marketId, side, qtyScu, priceUsdcPerScu);
    return { ok: true, digest: fakeDigest(), jobId };
  }
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
function round(n: number, dp: number) {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}
