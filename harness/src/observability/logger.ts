/**
 * Structured per-event logger. Emits one line per event; `json` mode emits NDJSON
 * (machine-readable for an indexer), `pretty` mode emits a colourized human line.
 */

import type { HarnessEvent } from "./events.js";
import { fmtUsdc } from "./tally.js";

export type LogFormat = "pretty" | "json" | "silent";

const ICON: Record<string, string> = {
  Order: "•",
  Match: "↔",
  NoMatch: "∅",
  Staked: "⊕",
  CreditsMinted: "✦",
  JobCreated: "▣",
  Dispatched: "➤",
  AttestationSubmitted: "✍",
  Settled: "✓",
  Refunded: "↩",
  Slashed: "✂",
  Expired: "⌛",
};

function shortId(id?: string): string {
  if (!id) return "";
  return id.length > 10 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

function fmtData(data?: Record<string, number | string>): string {
  if (!data) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === "number" && /usdc/i.test(k)) {
      parts.push(`${k}=${fmtUsdc(v)}`);
    } else {
      parts.push(`${k}=${v}`);
    }
  }
  return parts.join(" ");
}

export class Logger {
  constructor(private format: LogFormat = "pretty") {}

  event(e: HarnessEvent): void {
    if (this.format === "silent") return;
    if (this.format === "json") {
      process.stdout.write(`${JSON.stringify(e)}\n`);
      return;
    }
    const icon = ICON[e.type] ?? "·";
    const job = e.jobId ? ` job=${shortId(e.jobId)}` : "";
    const data = fmtData(e.data);
    process.stdout.write(
      `${icon} ${e.type.padEnd(20)}${job}${data ? `  ${data}` : ""}\n`,
    );
  }

  info(msg: string): void {
    if (this.format === "silent" || this.format === "json") return;
    process.stdout.write(`${msg}\n`);
  }

  /** Always-on (even in json mode) line for summaries. */
  raw(msg: string): void {
    if (this.format === "silent") return;
    process.stdout.write(`${msg}\n`);
  }
}
