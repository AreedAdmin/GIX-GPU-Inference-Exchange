import { describe, it, expect } from "vitest";
import { Tally, fmtUsdc, renderSummary } from "../src/observability/tally.js";
import type { HarnessEvent } from "../src/observability/events.js";

function ev(type: HarnessEvent["type"], data?: Record<string, number | string>): HarnessEvent {
  return { type, ts: 0, data };
}

describe("Tally", () => {
  it("counts orders, fills, and jobs", () => {
    const t = new Tally();
    t.record(ev("Order"));
    t.record(ev("Order"));
    t.record(ev("Match"));
    t.record(ev("JobCreated", { escrowUsdc: 1000 }));
    const s = t.snapshot();
    expect(s.orders).toBe(2);
    expect(s.fills).toBe(1);
    expect(s.jobs).toBe(1);
    expect(s.usdcEscrowed).toBe(1000);
  });

  it("accumulates settle payouts + fees", () => {
    const t = new Tally();
    t.record(ev("Settled", { payoutUsdc: 970, feeUsdc: 30 }));
    t.record(ev("Settled", { payoutUsdc: 485, feeUsdc: 15 }));
    const s = t.snapshot();
    expect(s.settled).toBe(2);
    expect(s.usdcSettledPayout).toBe(1455);
    expect(s.usdcFees).toBe(45);
  });

  it("accumulates refunds and slashes", () => {
    const t = new Tally();
    t.record(ev("Refunded", { amountUsdc: 5000 }));
    t.record(ev("Slashed", { penaltyUsdc: 5000 }));
    const s = t.snapshot();
    expect(s.refunded).toBe(1);
    expect(s.slashed).toBe(1);
    expect(s.usdcRefunded).toBe(5000);
    expect(s.usdcSlashed).toBe(5000);
  });

  it("ignores non-numeric data fields safely", () => {
    const t = new Tally();
    t.record(ev("Refunded", { amountUsdc: 100, reason: "AttTimeout" }));
    expect(t.snapshot().usdcRefunded).toBe(100);
  });

  it("reset clears all counters", () => {
    const t = new Tally();
    t.record(ev("Order"));
    t.reset();
    expect(t.snapshot().orders).toBe(0);
  });
});

describe("fmtUsdc", () => {
  it("formats 6-decimal base units", () => {
    expect(fmtUsdc(1_000_000)).toBe("1.000000");
    expect(fmtUsdc(1_234_500_000)).toBe("1,234.500000");
    expect(fmtUsdc(0)).toBe("0.000000");
    expect(fmtUsdc(-2_000_000)).toBe("-2.000000");
  });
});

describe("renderSummary", () => {
  it("includes all key lines", () => {
    const t = new Tally();
    t.record(ev("Order"));
    t.record(ev("JobCreated", { escrowUsdc: 1000 }));
    t.record(ev("Settled", { payoutUsdc: 970, feeUsdc: 30 }));
    const out = renderSummary(t.snapshot());
    expect(out).toContain("orders generated");
    expect(out).toContain("settled (success)");
    expect(out).toContain("bond slashed");
  });
});
