import { describe, it, expect } from "vitest";
import { StubMatcher } from "../src/matcher/matcher.js";
import type { Ask, Bid } from "../src/orchestrator/model.js";

const bid = (over: Partial<Bid> = {}): Bid => ({
  id: "bid-1",
  consumer: "0xc1",
  marketId: "0xmkt",
  qtyScu: 10,
  priceUsdcPerScu: 2000,
  inputHash: "deadbeef",
  ...over,
});

const ask = (over: Partial<Ask> = {}): Ask => ({
  id: "ask-1",
  provider: "0xp1",
  marketId: "0xmkt",
  qtyScu: 5,
  priceUsdcPerScu: 1800,
  ...over,
});

describe("StubMatcher", () => {
  const m = new StubMatcher();

  it("matches a crossing ask and clears at the maker (ask) price", () => {
    const r = m.match(bid(), [ask()]);
    expect(r).not.toBeNull();
    expect(r!.priceUsdcPerScu).toBe(1800); // ask price, not bid price
    expect(r!.provider).toBe("0xp1");
    expect(r!.consumer).toBe("0xc1");
  });

  it("fills min(bid.qty, ask.qty) and escrows qty*price (invariant I2)", () => {
    const r = m.match(bid({ qtyScu: 10 }), [ask({ qtyScu: 5, priceUsdcPerScu: 1800 })]);
    expect(r!.qtyScu).toBe(5);
    expect(r!.escrowUsdc).toBe(5 * 1800);
  });

  it("does not cross when ask price exceeds bid price", () => {
    const r = m.match(bid({ priceUsdcPerScu: 1500 }), [ask({ priceUsdcPerScu: 1800 })]);
    expect(r).toBeNull();
  });

  it("does not match across different markets", () => {
    const r = m.match(bid({ marketId: "0xmktA" }), [ask({ marketId: "0xmktB" })]);
    expect(r).toBeNull();
  });

  it("ignores asks with no remaining qty", () => {
    const r = m.match(bid(), [ask({ qtyScu: 0 })]);
    expect(r).toBeNull();
  });

  it("picks the cheapest crossing ask", () => {
    const r = m.match(bid({ priceUsdcPerScu: 2500 }), [
      ask({ id: "a", provider: "0xpA", priceUsdcPerScu: 2000, qtyScu: 5 }),
      ask({ id: "b", provider: "0xpB", priceUsdcPerScu: 1700, qtyScu: 5 }),
      ask({ id: "c", provider: "0xpC", priceUsdcPerScu: 1900, qtyScu: 5 }),
    ]);
    expect(r!.provider).toBe("0xpB");
    expect(r!.priceUsdcPerScu).toBe(1700);
  });

  it("tie-breaks equal-price asks by larger qty", () => {
    const r = m.match(bid({ qtyScu: 20, priceUsdcPerScu: 2500 }), [
      ask({ id: "a", provider: "0xpA", priceUsdcPerScu: 2000, qtyScu: 5 }),
      ask({ id: "b", provider: "0xpB", priceUsdcPerScu: 2000, qtyScu: 12 }),
    ]);
    expect(r!.provider).toBe("0xpB");
    expect(r!.qtyScu).toBe(12);
  });

  it("returns null when there are no asks", () => {
    expect(m.match(bid(), [])).toBeNull();
  });
});
