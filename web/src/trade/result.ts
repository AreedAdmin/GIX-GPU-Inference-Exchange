// web/src/trade/result.ts
// Provider-node HTTP + the verifiable-result check (demo-milestone-contract §2/§3.1).
//
// Browser-native: sha2_256 via WebCrypto's `crypto.subtle.digest("SHA-256", ...)` —
// byte-identical to Move's `sui::hash::sha2_256` and the SDK's `node:crypto` sha256.
// (The D2 `sdk/` package uses `node:crypto`; that's Node-only, so the web re-implements
// the same primitive here. Shapes mirror `@gix/sdk`'s ProviderResult/RunTaskResult so a
// future swap to the SDK's GixClient is a drop-in — see sui.ts SDK SWAP POINT.)

/** The provider node `/result/:jobId` response (node §3.1). */
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

/** A verified inference result surfaced in the UI (output + the on-chain checks). */
export interface JobResult {
  jobId: string;
  model: string;
  output: string;
  /** sha2_256(output_utf8), recomputed in-browser. */
  localOutputHash: string;
  /** output_hash as reported by the provider (and recorded on-chain in the attestation). */
  reportedOutputHash: string;
  /** True iff localOutputHash === reportedOutputHash (re-hash matches → verifiable). */
  verified: boolean;
  outputTokenCount: number;
  tStart: number;
  tEnd: number;
  providerPubkey: string;
  /** USDC cost of the job (qty * price), base units 6dp, for display. */
  costUsdc?: number;
  /** create_job tx digest (for the explorer link). */
  digest?: string;
}

/** sha2_256 of a UTF-8 string → lowercase hex (no 0x). WebCrypto SHA-256 == Move sha2_256. */
export async function sha2_256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** sha2_256 of a UTF-8 string → byte array (for PTB `vector<u8>` args). */
export async function sha2_256Bytes(input: string): Promise<number[]> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)];
}

/** Normalize hex: strip optional 0x, lowercase. */
export function normalizeHex(hex: string): string {
  const clean = /^0x/i.test(hex) ? hex.slice(2) : hex;
  return clean.toLowerCase();
}

/** Tolerant-of-0x, case-insensitive, byte-exact hex compare. False on malformed input. */
export function hexEquals(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const na = normalizeHex(a);
  const nb = normalizeHex(b);
  if (na.length === 0 || nb.length === 0) return false;
  return na === nb;
}

/** Thin client for the provider node HTTP surface (node §3.1). */
export class ProviderClient {
  private readonly base: string;

  constructor(baseUrl: string) {
    this.base = baseUrl.replace(/\/+$/, "");
  }

  /** POST the prompt; the node caches it by hash and returns the input hash. */
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

  /** GET the settled result (output + signed-attestation fields) for a job. */
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

  /** GET /health — used to surface provider liveness in the UI. */
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

/** Fetch /result, re-hash the output, and assemble the verified JobResult (§3.1). */
export async function fetchVerifiedResult(
  provider: ProviderClient,
  jobId: string,
  extra?: { costUsdc?: number; digest?: string },
): Promise<JobResult> {
  const r = await provider.getResult(jobId);
  const localOutputHash = await sha2_256Hex(r.output);
  const verified = hexEquals(localOutputHash, r.outputHash);
  return {
    jobId: r.jobId || jobId,
    model: r.model,
    output: r.output,
    localOutputHash,
    reportedOutputHash: r.outputHash,
    verified,
    outputTokenCount: r.outputTokenCount,
    tStart: r.tStart,
    tEnd: r.tEnd,
    providerPubkey: r.attestPubkey,
    costUsdc: extra?.costUsdc,
    digest: extra?.digest,
  };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}
