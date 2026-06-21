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
import { sha2_256BytesHex } from "./walrus.js";
import type { WalrusIO } from "./walrus.js";
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
  /** M2: Walrus I/O (testnet). null when disabled (localnet / HTTP-only) ⇒ /inputs cache. */
  walrus?: WalrusIO | null;
  log: (msg: string) => void;
}

/**
 * Resolve the prompt for a job, in priority order (docs/option3-inline-input-interface.md §B):
 *   1. Inline on-chain input (`job.input`, non-empty) → UTF-8 decode it. Verify
 *      sha2_256(input) == on-chain input_hash (defense in depth) before trusting it.
 *      No Walrus read, no /inputs cache — the tunnel-free path.
 *   2. else input_blob_id != 0 → read from Walrus (M2 path).
 *   3. else → the /inputs cache (legacy / localnet fallback).
 */
async function resolvePrompt(
  job: DispatchedJob,
  inputBlobId: bigint,
  input: Uint8Array,
  deps: ServeDeps,
): Promise<string | undefined> {
  const { store, walrus, log } = deps;

  // 1. Inline on-chain input (Option 3 — tunnel-free). The contract already enforces
  //    sha2_256(input) == input_hash on create_job_from_ask; we re-verify here (defense in
  //    depth) before signing a binding over it.
  if (input.length > 0) {
    const onChain = job.inputHash.startsWith("0x") ? job.inputHash.slice(2) : job.inputHash;
    if (sha2_256BytesHex(input).toLowerCase() !== onChain.toLowerCase()) {
      log(`[serve] job ${job.jobId}: inline on-chain input hash != input_hash — refusing`);
      return undefined;
    }
    const prompt = new TextDecoder().decode(input);
    log(`[serve] job ${job.jobId}: using inline on-chain input (${input.length} bytes) — tunnel-free`);
    // Cache so /result and any retry are fast.
    store.putPrompt(onChain, prompt);
    return prompt;
  }

  // 2. M2: if the job committed a Walrus input blob and Walrus is available, read it from there.
  if (inputBlobId !== 0n && walrus) {
    try {
      const bytes = await walrus.readByInt(inputBlobId);
      const prompt = new TextDecoder().decode(bytes);
      // The blob id is a storage commitment, not a content hash: verify sha2_256 against
      // the on-chain input_hash before trusting it.
      const onChain = job.inputHash.startsWith("0x") ? job.inputHash.slice(2) : job.inputHash;
      if (sha2_256BytesHex(bytes).toLowerCase() !== onChain.toLowerCase()) {
        log(`[serve] job ${job.jobId}: Walrus input blob hash != on-chain input_hash — refusing`);
        return undefined;
      }
      log(`[serve] job ${job.jobId}: read prompt from Walrus (blob_id ${inputBlobId})`);
      // Cache it so /result and any retry are fast.
      store.putPrompt(onChain, prompt);
      return prompt;
    } catch (e) {
      log(`[serve] job ${job.jobId}: Walrus read failed (${(e as Error).message}); trying /inputs cache`);
    }
  }
  return store.getPrompt(job.inputHash);
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
  const { ollama, attest, store, model, measurement, walrus, log } = deps;

  // M2: read the job's kind (escrow vs fill) + its Walrus input commitment. This drives
  // both where we fetch the prompt and which settlement path we take. On localnet / when
  // the chain is disabled, this defaults to {isFill:false, inputBlobId:0} and the flow is
  // identical to M1 (prompt from /inputs cache, settle via settle/resolve_attested).
  let isFill = false;
  let inputBlobId = 0n;
  let input: Uint8Array = new Uint8Array(0);
  if (deps.chain) {
    const meta = await deps.chain.getJobMeta(job.jobId);
    isFill = meta.isFill;
    inputBlobId = meta.inputBlobId;
    input = meta.input ?? input;
  }

  const prompt = await resolvePrompt(job, inputBlobId, input, deps);
  if (prompt === undefined) {
    log(
      `[serve] job ${job.jobId}: no prompt available for input_hash ${job.inputHash} ` +
        `(consumer must carry inline input, upload the Walrus input blob, or POST /inputs first) — skipping`,
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

  // 1b. Ack FIRST (Dispatched → Executing), in its own tx, BEFORE inference. The job's
  //     ack_deadline is a fixed ~30 s window from job creation; inference can take far
  //     longer (a real qwen run took ~75 s). Acking up front lands well inside the 30 s
  //     window, then inference fits the generous 180 s exec window. The ack inside the
  //     later attestation PTB then becomes a harmless no-op (job already EXECUTING).
  //     Tolerant: on failure we log and proceed — ackJob swallows benign aborts, and the
  //     attest PTB still attempts the ack.
  if (deps.chain) {
    try {
      await deps.chain.ackJob(job.jobId);
    } catch (e) {
      log(`[serve] job ${job.jobId}: ackJob failed (${(e as Error).message}); proceeding to inference`);
    }
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

  // 4b. M2 — Walrus upload (testnet). Upload the completion + the signed attestation quote
  // as permanent blobs; their u256 blob ids ride along into submit_signed_attestation as
  // COMMITMENTS (the sha2_256 hashes remain the verification primitive). Best-effort: if the
  // upload fails we still submit (with blob_id 0) and store the result off-chain.
  let outputBlobId = 0n;
  let quoteBlobId = 0n;
  if (walrus) {
    try {
      const out = await walrus.uploadUtf8(gen.completion, {
        gix: "output",
        job: job.jobId,
        output_hash: outputHashHex,
      });
      outputBlobId = out.blobIdInt;
      result.outputBlobId = out.blobId;
      // The "quote" blob: the canonical signed attestation envelope (verifiable off-chain).
      const quote = JSON.stringify({
        jobId: job.jobId,
        measurement,
        inputHash: "0x" + recomputedInput,
        outputHash: "0x" + outputHashHex,
        outputTokenCount: gen.outputTokenCount,
        tStart: gen.tStart,
        tEnd: gen.tEnd,
        signature: signatureHex,
        attestPubkey: deps.attestPubkeyHex,
        message: "0x" + message.toString("hex"),
      });
      const q = await walrus.uploadUtf8(quote, { gix: "quote", job: job.jobId });
      quoteBlobId = q.blobIdInt;
      result.quoteBlobId = q.blobId;
      log(
        `[serve] job ${job.jobId}: Walrus uploaded output (blob ${out.blobId}) + quote (blob ${q.blobId})`,
      );
    } catch (e) {
      log(`[serve] job ${job.jobId}: Walrus upload FAILED: ${(e as Error).message} (submitting without blob ids)`);
    }
  }

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
        outputBlobId,
        quoteBlobId,
      });
      result.submitDigest = digest;
      log(
        `[serve] job ${job.jobId}: attestation submitted (digest ${digest}, verdict ${verdict ?? "?"})`,
      );

      // Close the loop: the provider node settles. Branch on the JOB KIND (M2):
      //   escrow job → settle / resolve_attested
      //   fill job   → settle_fill / resolve_fill (the contract rejects the old settle here)
      try {
        const settled = await deps.chain.settleJob(job.jobId, verdict, isFill);
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
