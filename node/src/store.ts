/**
 * In-memory stores for the node:
 *   - promptByHash: consumer prompts submitted via POST /inputs, keyed by
 *     sha2_256(prompt_utf8) hex. The serve loop looks the prompt up by the
 *     `input_hash` carried on the Dispatched event.
 *   - resultByJob:  finished job results, served by GET /result/:jobId.
 *
 * M1/demo scope: process-local memory (Walrus replaces /inputs in M2). Both maps are
 * bounded only by demo volume; that is acceptable for the milestone.
 */

export interface JobResult {
  jobId: string;
  model: string;
  output: string;
  outputHash: string; // hex (no 0x)
  inputHash: string; // hex (no 0x)
  outputTokenCount: number;
  tStart: number;
  tEnd: number;
  measurement: string;
  /** 0x-hex 64-byte Ed25519 signature over the §2 message. */
  signature: string;
  /** 0x-hex 32-byte Ed25519 attestation pubkey. */
  attestPubkey: string;
  /** On-chain submit digest, if the attestation was submitted. */
  submitDigest?: string;
}

export class NodeStore {
  /** input_hash (hex, no 0x) -> prompt text. */
  private promptByHash = new Map<string, string>();
  /** jobId -> finished result. */
  private resultByJob = new Map<string, JobResult>();

  putPrompt(inputHashHex: string, prompt: string): void {
    this.promptByHash.set(normHash(inputHashHex), prompt);
  }

  getPrompt(inputHashHex: string): string | undefined {
    return this.promptByHash.get(normHash(inputHashHex));
  }

  hasPrompt(inputHashHex: string): boolean {
    return this.promptByHash.has(normHash(inputHashHex));
  }

  putResult(r: JobResult): void {
    this.resultByJob.set(normId(r.jobId), r);
  }

  getResult(jobId: string): JobResult | undefined {
    return this.resultByJob.get(normId(jobId));
  }
}

function normHash(h: string): string {
  return (h.startsWith("0x") ? h.slice(2) : h).toLowerCase();
}

function normId(id: string): string {
  return id.toLowerCase();
}
