import { describe, expect, it, vi } from "vitest";
import {
  OnRampClient,
  SUI_COIN_TYPE,
  SUI_DBUSDC_POOL_KEY,
  TESTNET_DBUSDC_COIN_TYPE,
  TESTNET_SUI_DBUSDC_POOL_ID,
} from "../src/onramp.js";

/**
 * On-ramp (SUI → DBUSDC) unit coverage. The live swap is exercised by
 * scripts/onramp-smoke.ts against testnet; here we pin the load-bearing
 * constants and the pure quote/min-out math without touching the network.
 */
describe("on-ramp constants — PINNED (docs/onramp-dbusdc-plan.md + deepbook-v3 testnet)", () => {
  it("DBUSDC coin type is the testnet USDC stand-in", () => {
    expect(TESTNET_DBUSDC_COIN_TYPE).toBe(
      "0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC",
    );
  });

  it("SUI_DBUSDC pool id + key match the live testnet pool", () => {
    expect(TESTNET_SUI_DBUSDC_POOL_ID).toBe(
      "0x1c19362ca52b8ffd7a33cee805a67d40f31e6ba303753fd3a4cfdfacea7163a5",
    );
    expect(SUI_DBUSDC_POOL_KEY).toBe("SUI_DBUSDC");
  });

  it("SUI native coin type is 0x2::sui::SUI", () => {
    expect(SUI_COIN_TYPE).toBe("0x2::sui::SUI");
  });
});

describe("OnRampClient.quote — derives DBUSDC-out + price from the input-fee read", () => {
  function clientWithStubbedDeepBook(quoteOut: number, baseOut = 0, deepRequired = 0) {
    const c = new OnRampClient({ network: "testnet" });
    // Stub the private DeepBookClient builder so no network is touched.
    const getQuoteQuantityOutInputFee = vi.fn().mockResolvedValue({
      baseQuantity: 0,
      baseOut, // unfilled sub-lot remainder
      quoteOut,
      deepRequired,
    });
    (c as unknown as { deepBookClient: () => Promise<unknown> }).deepBookClient = vi
      .fn()
      .mockResolvedValue({ getQuoteQuantityOutInputFee });
    return { c, getQuoteQuantityOutInputFee };
  }

  it("returns dbusdcOut + price + suiFilled for a priceable amount, deepRequired 0", async () => {
    // 2 SUI in, 0.1 SUI unfillable remainder ⇒ 1.9 SUI filled for 1.33 DBUSDC.
    const { c, getQuoteQuantityOutInputFee } = clientWithStubbedDeepBook(1.33, 0.1);
    const q = await c.quote(2);
    expect(getQuoteQuantityOutInputFee).toHaveBeenCalledWith(SUI_DBUSDC_POOL_KEY, 2);
    expect(q.amountSui).toBe(2);
    expect(q.dbusdcOut).toBeCloseTo(1.33, 6);
    expect(q.priceDbusdcPerSui).toBeCloseTo(0.665, 6);
    expect(q.suiFilled).toBeCloseTo(1.9, 6);
    expect(q.deepRequired).toBe(0);
  });

  it("throws when nothing fills (amount below the pool min order size)", async () => {
    // 0.1 SUI in, fully unfilled (baseOut = 0.1), 0 DBUSDC out.
    const { c } = clientWithStubbedDeepBook(0, 0.1);
    await expect(c.quote(0.1)).rejects.toThrow(/below the pool min order/);
  });

  it("rejects non-positive amounts before any read", async () => {
    const c = new OnRampClient({ network: "testnet" });
    await expect(c.quote(0)).rejects.toThrow(/amountSui must be > 0/);
    await expect(c.quote(-1)).rejects.toThrow(/amountSui must be > 0/);
  });
});
