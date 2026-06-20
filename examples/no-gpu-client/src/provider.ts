/**
 * Thin HTTP client for the remote provider node (demo-milestone-contract §3.1).
 *
 *   POST /inputs        { prompt }      -> { inputHash }
 *   GET  /result/:jobId                 -> ProviderResult
 *   GET  /health                        -> { ok, model, gpu }
 *
 * Uses the global `fetch` (Node 18+). This is the only network the GPU-less
 * client talks to besides the Sui RPC.
 */

export interface ProviderResult {
  jobId: string;
  model: string;
  output: string;
  outputHash: string;
  outputTokenCount: number;
  tStart: number;
  tEnd: number;
  measurement: string;
  signature: string;
  attestPubkey: string;
}

export class ProviderClient {
  private readonly base: string;

  constructor(baseUrl: string) {
    this.base = baseUrl.replace(/\/+$/, "");
    if (typeof globalThis.fetch !== "function") {
      throw new Error("ProviderClient: no global fetch (needs Node 18+)");
    }
  }

  /** POST the prompt; node caches it by hash and returns the input hash. */
  async submitInput(prompt: string): Promise<{ inputHash: string }> {
    const res = await fetch(`${this.base}/inputs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) {
      throw new Error(`provider POST /inputs failed: ${res.status} ${await safeText(res)}`);
    }
    const body = (await res.json()) as { inputHash?: string };
    if (!body || typeof body.inputHash !== "string") {
      throw new Error("provider POST /inputs: missing inputHash in response");
    }
    return { inputHash: body.inputHash };
  }

  /** GET the settled result (output + signed attestation fields) for a job. */
  async getResult(jobId: string): Promise<ProviderResult> {
    const res = await fetch(`${this.base}/result/${encodeURIComponent(jobId)}`);
    if (!res.ok) {
      throw new Error(`provider GET /result/${jobId} failed: ${res.status} ${await safeText(res)}`);
    }
    const body = (await res.json()) as ProviderResult;
    if (!body || typeof body.output !== "string" || typeof body.outputHash !== "string") {
      throw new Error(`provider GET /result/${jobId}: malformed result (need output + outputHash)`);
    }
    return body;
  }

  /** Poll /result until the node serves the settled output. */
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
    try {
      const res = await fetch(`${this.base}/health`);
      if (!res.ok) return { ok: false };
      return (await res.json()) as { ok: boolean; model?: string; gpu?: string };
    } catch {
      return { ok: false };
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}
