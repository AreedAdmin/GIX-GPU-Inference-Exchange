/**
 * Serve loop — the heart of D0.
 *
 * For each Dispatched(job_id, input_hash, ...) event:
 *   1. Look up the cached prompt by input_hash (submitted via POST /inputs).
 *   2. Run real inference on the GB10 via Ollama → completion, output_token_count.
 *   3. Compute input_hash/output_hash = sha2_256(utf8), capture t_start/t_end (ms).
 *   4. Build the byte-exact §2 canonical message, sign with the Ed25519 attest key.
 *   5. Submit submit_signed_attestation(...) on-chain.
 *   6. Store the result for GET /result/:jobId.
 *
 * The function is pure of HTTP/chain wiring — those are injected — so it is testable
 * and reusable. Each job is processed independently; one failure never wedges the loop.
 */

import {
  buildCanonicalMessage,
  sha2_256Hex,
} from "./attest/canonical.js";
import type { AttestSigner } from "./attest/signer.js";
import type { OllamaClient } from "./ollama.js";
import type { NodeChain, DispatchedJob } from "./chain.js";
import type { NodeStore, JobResult } from "./store.js";

export interface ServeDeps {
  ollama: OllamaClient;
  attest: AttestSigner;
  attestPubkeyHex: string;
  chain: NodeChain | null; // null in HTTP/Ollama-only mode
  store: NodeStore;
  model: string;
  measurement: string;
  log: (msg: string) => void;
}

/**
 * Process a single dispatched job end-to-end. Returns the stored JobResult, or null
 * if the prompt for its input_hash was never submitted (a real, recoverable case:
 * the consumer must POST /inputs before creating the job).
 */
export async function serveJob(
  job: DispatchedJob,
  deps: ServeDeps,
): Promise<JobResult | null> {
  const { ollama, attest, store, model, measurement, log } = deps;

  const prompt = store.getPrompt(job.inputHash);
  if (prompt === undefined) {
    log(
      `[serve] job ${job.jobId}: no cached prompt for input_hash ${job.inputHash} ` +
        `(consumer must POST /inputs first) — skipping`,
    );
    return null;
  }

  // Defensive: the on-chain input_hash MUST equal sha2_256(prompt). If a prompt was
  // cached under a mismatching hash, refuse rather than sign a bad binding.
  const recomputedInput = sha2_256Hex(prompt);
  const onChainInput = job.inputHash.startsWith("0x") ? job.inputHash.slice(2) : job.inputHash;
  if (recomputedInput.toLowerCase() !== onChainInput.toLowerCase()) {
    log(
      `[serve] job ${job.jobId}: input_hash mismatch ` +
        `(chain=${onChainInput} computed=${recomputedInput}) — skipping`,
    );
    return null;
  }

  // 2. Real inference on the GB10.
  log(`[serve] job ${job.jobId}: running ${model} inference (${prompt.length} prompt chars)`);
  const gen = await ollama.generate(prompt);

  // 3. Hashes + timing.
  const outputHashHex = sha2_256Hex(gen.completion);

  // 4. Build the byte-exact §2 message and sign.
  const message = buildCanonicalMessage({
    jobId: job.jobId,
    measurement,
    inputHash: recomputedInput,
    outputHash: outputHashHex,
    outputTokenCount: gen.outputTokenCount,
    tStart: gen.tStart,
    tEnd: gen.tEnd,
  });
  const signature = attest.sign(message);
  const signatureHex = "0x" + Buffer.from(signature).toString("hex");

  const result: JobResult = {
    jobId: job.jobId,
    model,
    output: gen.completion,
    outputHash: outputHashHex,
    inputHash: recomputedInput,
    outputTokenCount: gen.outputTokenCount,
    tStart: gen.tStart,
    tEnd: gen.tEnd,
    measurement,
    signature: signatureHex,
    attestPubkey: deps.attestPubkeyHex,
  };

  // 5. Submit on-chain (skipped in HTTP/Ollama-only mode), then settle.
  if (deps.chain) {
    try {
      const { digest, verdict } = await deps.chain.submitSignedAttestation({
        jobId: job.jobId,
        measurement,
        inputHash: "0x" + recomputedInput,
        outputHash: "0x" + outputHashHex,
        outputTokenCount: gen.outputTokenCount,
        tStart: gen.tStart,
        tEnd: gen.tEnd,
        signature,
      });
      result.submitDigest = digest;
      log(
        `[serve] job ${job.jobId}: attestation submitted (digest ${digest}, verdict ${verdict ?? "?"})`,
      );

      // Close the loop: the stubbed-match design has no separate settler, so the
      // provider node settles. VALID → settle (pays provider); else → resolve_attested.
      try {
        const settled = await deps.chain.settleJob(job.jobId, verdict);
        result.settleDigest = settled.digest;
        log(`[serve] job ${job.jobId}: ${settled.fn} (digest ${settled.digest})`);
      } catch (e) {
        log(`[serve] job ${job.jobId}: settlement FAILED: ${(e as Error).message}`);
      }
    } catch (e) {
      log(`[serve] job ${job.jobId}: on-chain submit FAILED: ${(e as Error).message}`);
      // Still store the signed result so /result/:jobId is verifiable off-chain.
    }
  }

  // 6. Store for retrieval.
  store.putResult(result);
  log(
    `[serve] job ${job.jobId}: served ${gen.outputTokenCount} tokens in ` +
      `${gen.tEnd - gen.tStart}ms (output_hash 0x${outputHashHex})`,
  );
  return result;
}
