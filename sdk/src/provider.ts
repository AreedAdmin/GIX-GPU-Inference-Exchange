/**
 * Thin HTTP client for the provider node (node §3.1).
 *
 *   POST /inputs        { prompt }      -> { inputHash }
 *   GET  /result/:jobId                 -> ProviderResult
 *   GET  /health                        -> { ok, model, gpu }
 *
 * Uses the global `fetch` (Node 18+) by default; an injected fetch is accepted
 * for tests / alternate runtimes.
 */

import type { ProviderResult } from "./types.js";

export class ProviderClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, fetchImpl?: typeof fetch) {
    // Strip a trailing slash so `${base}/inputs` is well-formed.
    this.base = baseUrl.replace(/\/+$/, "");
    const f = fetchImpl ?? globalThis.fetch;
    if (typeof f !== "function") {
      throw new Error(
        "ProviderClient: no fetch available (Node 18+ or pass options.fetchImpl)",
      );
    }
    this.fetchImpl = f;
  }

  /** POST the prompt; the node caches it by hash and returns the input hash. */
  async submitInput(prompt: string): Promise<{ inputHash: string }> {
    const res = await this.fetchImpl(`${this.base}/inputs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) {
      throw new Error(
        `provider POST /inputs failed: ${res.status} ${await safeText(res)}`,
      );
    }
    const body = (await res.json()) as { inputHash?: string };
    if (!body || typeof body.inputHash !== "string") {
      throw new Error("provider POST /inputs: missing inputHash in response");
    }
    return { inputHash: body.inputHash };
  }

  /** GET the settled result (output + signed attestation fields) for a job. */
  async getResult(jobId: string): Promise<ProviderResult> {
    const res = await this.fetchImpl(`${this.base}/result/${encodeURIComponent(jobId)}`);
    if (!res.ok) {
      throw new Error(
        `provider GET /result/${jobId} failed: ${res.status} ${await safeText(res)}`,
      );
    }
    const body = (await res.json()) as ProviderResult;
    if (!body || typeof body.output !== "string" || typeof body.outputHash !== "string") {
      throw new Error(
        `provider GET /result/${jobId}: malformed result (need output + outputHash)`,
      );
    }
    return body;
  }

  /** Poll /result until the node has the settled output (it serves only post-settlement). */
  async awaitResult(
    jobId: string,
    opts: { timeoutMs: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> },
  ): Promise<ProviderResult> {
    const interval = opts.intervalMs ?? 1500;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const deadline = Date.now() + opts.timeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        return await this.getResult(jobId);
      } catch (e) {
        lastErr = e;
        await sleep(interval);
      }
    }
    throw new Error(
      `provider /result/${jobId} not available within ${opts.timeoutMs}ms` +
        (lastErr ? `: ${(lastErr as Error).message}` : ""),
    );
  }

  async health(): Promise<{ ok: boolean; model?: string; gpu?: string }> {
    const res = await this.fetchImpl(`${this.base}/health`);
    if (!res.ok) return { ok: false };
    return (await res.json()) as { ok: boolean; model?: string; gpu?: string };
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}
