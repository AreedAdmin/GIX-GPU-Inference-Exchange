/**
 * Running tally — the live scoreboard the integration contract requires:
 * "orders, fills, jobs, settled, refunded, slashed, USDC escrowed, USDC slashed".
 *
 * The tally is fed by `record(event)` so it works identically whether events
 * come from the dry-run state machine or from subscribed `gix::events`. It is a
 * pure accumulator (no I/O) so unit tests can assert on it directly.
 */

import type { HarnessEvent } from "./events.js";

export interface TallySnapshot {
  orders: number;
  fills: number; // matched bids
  noMatches: number;
  jobs: number; // JobCreated
  dispatched: number;
  attestations: number;
  settled: number;
  refunded: number;
  slashed: number; // jobs ending with a slash
  expired: number;
  usdcEscrowed: number; // total locked into jobs
  usdcSettledPayout: number; // total paid to providers
  usdcFees: number; // total to treasury
  usdcRefunded: number; // total returned to consumers
  usdcSlashed: number; // total debited from provider bonds
}

const ZERO: TallySnapshot = {
  orders: 0,
  fills: 0,
  noMatches: 0,
  jobs: 0,
  dispatched: 0,
  attestations: 0,
  settled: 0,
  refunded: 0,
  slashed: 0,
  expired: 0,
  usdcEscrowed: 0,
  usdcSettledPayout: 0,
  usdcFees: 0,
  usdcRefunded: 0,
  usdcSlashed: 0,
};

export class Tally {
  private s: TallySnapshot = { ...ZERO };

  /** Fold one event into the running totals. */
  record(e: HarnessEvent): void {
    const num = (k: string): number => {
      const v = e.data?.[k];
      return typeof v === "number" ? v : 0;
    };
    switch (e.type) {
      case "Order":
        this.s.orders += 1;
        break;
      case "Match":
        this.s.fills += 1;
        break;
      case "NoMatch":
        this.s.noMatches += 1;
        break;
      case "JobCreated":
        this.s.jobs += 1;
        this.s.usdcEscrowed += num("escrowUsdc");
        break;
      case "Dispatched":
        this.s.dispatched += 1;
        break;
      case "AttestationSubmitted":
        this.s.attestations += 1;
        break;
      case "Settled":
        this.s.settled += 1;
        this.s.usdcSettledPayout += num("payoutUsdc");
        this.s.usdcFees += num("feeUsdc");
        break;
      case "Refunded":
        this.s.refunded += 1;
        this.s.usdcRefunded += num("amountUsdc");
        break;
      case "Slashed":
        this.s.slashed += 1;
        this.s.usdcSlashed += num("penaltyUsdc");
        break;
      case "Expired":
        this.s.expired += 1;
        break;
    }
  }

  snapshot(): TallySnapshot {
    return { ...this.s };
  }

  reset(): void {
    this.s = { ...ZERO };
  }
}

/** Format USDC base units (6dp) as a human "1,234.500000" string. */
export function fmtUsdc(base: number): string {
  const sign = base < 0 ? "-" : "";
  const abs = Math.abs(base);
  const whole = Math.floor(abs / 1_000_000);
  const frac = String(abs % 1_000_000).padStart(6, "0");
  return `${sign}${whole.toLocaleString("en-US")}.${frac}`;
}

/** Render a one-line live tally banner. */
export function renderTallyLine(s: TallySnapshot): string {
  return (
    `orders=${s.orders} fills=${s.fills} jobs=${s.jobs} ` +
    `settled=${s.settled} refunded=${s.refunded} slashed=${s.slashed} ` +
    `escrow=${fmtUsdc(s.usdcEscrowed)} slashed$=${fmtUsdc(s.usdcSlashed)}`
  );
}

/** Render the final multi-line run summary. */
export function renderSummary(s: TallySnapshot): string {
  const lines = [
    "──────────────────────────────────────────────",
    " GIX M1 harness — run summary",
    "──────────────────────────────────────────────",
    ` orders generated     : ${s.orders}`,
    ` matched (fills)       : ${s.fills}`,
    ` unmatched orders      : ${s.noMatches}`,
    ` jobs created          : ${s.jobs}`,
    ` dispatched            : ${s.dispatched}`,
    ` attestations submitted: ${s.attestations}`,
    "  ─ terminal states ─",
    ` settled (success)     : ${s.settled}`,
    ` refunded              : ${s.refunded}`,
    `   ↳ of which slashed   : ${s.slashed}`,
    ` expired               : ${s.expired}`,
    "  ─ USDC flow (6dp) ─",
    ` escrowed total        : ${fmtUsdc(s.usdcEscrowed)}`,
    ` provider payouts      : ${fmtUsdc(s.usdcSettledPayout)}`,
    ` treasury fees         : ${fmtUsdc(s.usdcFees)}`,
    ` consumer refunds      : ${fmtUsdc(s.usdcRefunded)}`,
    ` bond slashed          : ${fmtUsdc(s.usdcSlashed)}`,
    "──────────────────────────────────────────────",
  ];
  return lines.join("\n");
}
