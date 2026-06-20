#!/usr/bin/env -S npx tsx
/**
 * Standalone Ollama smoke test — proves the GB10 inference path without any chain.
 *
 *   npm run ollama-check                 # uses GIX_MODEL / GIX_OLLAMA_URL
 *   GIX_MODEL=llama3.2:1b npm run ollama-check
 *
 * Pulls the model if missing, runs one real completion, prints the completion plus
 * the sha2_256 input/output hashes and the §2 signed attestation for the result.
 */

import { OllamaClient } from "../ollama.js";
import { sha2_256Hex, buildCanonicalMessage } from "../attest/canonical.js";
import { attestSignerFromSeed, verifyAttestation } from "../attest/signer.js";

async function main(): Promise<void> {
  const baseUrl = process.env.GIX_OLLAMA_URL ?? "http://127.0.0.1:11434";
  const model = process.env.GIX_MODEL ?? "llama3.1:8b";
  const prompt =
    process.env.GIX_PROMPT ??
    "In one short sentence, what is a GPU inference exchange?";

  const ollama = new OllamaClient(baseUrl, model);
  console.log(`[ollama-check] ${baseUrl} model=${model}`);
  const pulled = await ollama.ensureModel((s) => process.stderr.write(`\r[pull] ${s}        `));
  if (pulled) process.stderr.write("\n");
  console.log(`[ollama-check] model present; running inference...`);

  const gen = await ollama.generate(prompt);
  const inputHash = sha2_256Hex(prompt);
  const outputHash = sha2_256Hex(gen.completion);

  console.log("\n===== INFERENCE =====");
  console.log(`prompt           : ${prompt}`);
  console.log(`completion       : ${gen.completion}`);
  console.log(`outputTokenCount : ${gen.outputTokenCount}`);
  console.log(`promptTokenCount : ${gen.promptTokenCount}`);
  console.log(`latency_ms       : ${gen.tEnd - gen.tStart}`);
  console.log(`input_hash       : 0x${inputHash}`);
  console.log(`output_hash      : 0x${outputHash}`);

  // Sign a §2 message with an ephemeral key just to show the path round-trips.
  const seed = new Uint8Array(32).fill(7);
  const signer = attestSignerFromSeed(seed);
  const msg = buildCanonicalMessage({
    jobId: "0x" + "ab".repeat(32),
    measurement: process.env.GIX_MEASUREMENT ?? "MOCK-tdx-llama8b-v1",
    inputHash,
    outputHash,
    outputTokenCount: gen.outputTokenCount,
    tStart: gen.tStart,
    tEnd: gen.tEnd,
  });
  const sig = signer.sign(msg);
  const ok = verifyAttestation(sig, msg, signer.publicKey);
  console.log("\n===== ATTESTATION (ephemeral key) =====");
  console.log(`attestPubkey     : 0x${Buffer.from(signer.publicKey).toString("hex")}`);
  console.log(`message_len      : ${msg.length} bytes`);
  console.log(`signature        : 0x${Buffer.from(sig).toString("hex")}`);
  console.log(`verify           : ${ok ? "OK ✓" : "FAIL ✗"}`);
}

main().catch((e) => {
  console.error(`[ollama-check] error: ${(e as Error).message}`);
  process.exit(1);
});
