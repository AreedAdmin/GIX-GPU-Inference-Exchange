#!/usr/bin/env node
/**
 * walrus-smoke.ts — LIVE testnet Walrus round-trip for a single GIX job.
 *
 * Proves the M2 input/output blob plumbing end to end against real testnet
 * Walrus storage nodes using the shared `WalrusHelper`:
 *   1. uploadInput(prompt)      -> a real INPUT blob  (blobId + sha2_256 input_hash)
 *   2. uploadInput(completion)  -> a real OUTPUT blob (blobId + sha2_256 output_hash)
 *      (uploadInput is just "upload a string to Walrus + compute its sha2_256";
 *       we reuse it for the output so the verify primitive is identical)
 *   3. downloadAndVerify(blobId, hash) for BOTH -> sha2_256(downloaded) == hash
 *
 * Permanent (deletable: false) blobs, a few epochs. Needs WAL + SUI on the
 * signer (run scripts/get-wal.ts first). Signer is the local Sui keystore key
 * (same funded testnet address as the Sui CLI).
 *
 * Usage:
 *   tsx scripts/walrus-smoke.ts [--epochs 3]
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { webcrypto } from "node:crypto";

// Node 18 does not expose WebCrypto as the `crypto` global by default (it
// became a default global in Node 19+). The Walrus SDK / WASM uses the global
// `crypto` to compute blob metadata, so polyfill it before any upload.
if (!(globalThis as { crypto?: unknown }).crypto) {
  (globalThis as { crypto?: unknown }).crypto = webcrypto;
}

import { WalrusHelper } from "../src/walrus.js";
import { sha2_256Hex } from "../src/hash.js";

const AGG = "https://aggregator.walrus-testnet.walrus.space/v1/blobs";

function getArg(flag: string, def?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

async function main() {
  const epochs = Number(getArg("--epochs", "3"));

  const { SuiJsonRpcClient, getJsonRpcFullnodeUrl } = await import("@mysten/sui/jsonRpc");
  const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");

  const raw = Buffer.from(
    JSON.parse(readFileSync(homedir() + "/.sui/sui_config/sui.keystore", "utf8"))[0],
    "base64",
  );
  if (raw[0] !== 0) throw new Error(`expected Ed25519 keystore key (flag 0), got ${raw[0]}`);
  const signer = Ed25519Keypair.fromSecretKey(new Uint8Array(raw.subarray(1)));
  const sender = signer.getPublicKey().toSuiAddress();
  console.error(`signer: ${sender}`);
  console.error(`epochs: ${epochs}  (testnet epoch = ~1 day)\n`);

  const suiClient = new SuiJsonRpcClient({
    network: "testnet",
    url: getJsonRpcFullnodeUrl("testnet"),
  });

  const helper = new WalrusHelper({
    network: "testnet",
    suiClient,
    epochs,
    // Use the testnet upload relay: direct-to-node writes (~2200 reqs) are flaky
    // against slow testnet nodes (NotEnoughBlobConfirmationsError). The relay
    // offloads the sliver writes. max tip in MIST; client auto-determines it.
    uploadRelay: {
      host: "https://upload-relay.testnet.walrus.space",
      sendTip: { max: 1_000 },
    },
    // Give slow testnet nodes more than the default 10s on reads.
    storageNodeClientOptions: { timeout: 60_000 },
    logger: (m, x) => console.error(`  [walrus] ${m}`, x ?? ""),
  });

  // --- realistic GIX job artifacts ---
  const prompt =
    "Explain, in two sentences, why verifiable GPU inference needs both a " +
    "content hash (sha2_256) and a storage commitment (Walrus blob id).";
  const completion =
    "A content hash lets the consumer prove the bytes they received are exactly " +
    "the bytes the provider committed to on-chain, independent of where they are " +
    "stored. The Walrus blob id is only a storage pointer, so GIX keeps its own " +
    "sha2_256 as the trust-minimized verification primitive.";

  const inputBytes = new TextEncoder().encode(prompt);
  const outputBytes = new TextEncoder().encode(completion);
  console.error(`INPUT  prompt:      ${inputBytes.length} bytes`);
  console.error(`OUTPUT completion:  ${outputBytes.length} bytes\n`);

  // 1. upload INPUT
  console.error("→ uploading INPUT blob …");
  const t0 = Date.now();
  const inUp = await helper.uploadInput(prompt, signer);
  console.error(`  input blobId:       ${inUp.blobId}`);
  console.error(`  input blobObjectId: ${inUp.blobObjectId ?? "?"}`);
  console.error(`  input_hash:         ${inUp.inputHash}`);
  console.error(`  blobId u256:        ${inUp.blobIdU256}`);

  // 2. upload OUTPUT
  console.error("\n→ uploading OUTPUT blob …");
  const outUp = await helper.uploadInput(completion, signer);
  const outputHash = sha2_256Hex(completion);
  console.error(`  output blobId:       ${outUp.blobId}`);
  console.error(`  output blobObjectId: ${outUp.blobObjectId ?? "?"}`);
  console.error(`  output_hash:         ${outputHash}`);
  console.error(`  blobId u256:         ${outUp.blobIdU256}`);
  console.error(`\nupload elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  // 3. download BOTH by blob id + verify sha2_256
  console.error("→ downloading INPUT by blobId + verifying sha2_256 …");
  const inDl = await helper.downloadAndVerify(inUp.blobId, inUp.inputHash);
  const inRoundtrips = inDl.output === prompt;
  console.error(`  bytes back: ${inDl.bytes.length}  verify(sha2_256)=${inDl.verified}  text-match=${inRoundtrips}`);

  console.error("\n→ downloading OUTPUT by blobId + verifying sha2_256 …");
  const outDl = await helper.downloadAndVerify(outUp.blobId, outputHash);
  const outRoundtrips = outDl.output === completion;
  console.error(`  bytes back: ${outDl.bytes.length}  verify(sha2_256)=${outDl.verified}  text-match=${outRoundtrips}`);

  // Also prove the u256 round-trip path (the form committed on-chain).
  console.error("\n→ downloading OUTPUT by u256 commitment (on-chain form) …");
  const outByU256 = await helper.downloadOutput(outUp.blobIdU256);
  const u256Ok = new TextDecoder().decode(outByU256) === completion;
  console.error(`  bytes back: ${outByU256.length}  text-match=${u256Ok}`);

  const allOk =
    inDl.verified && outDl.verified && inRoundtrips && outRoundtrips && u256Ok;

  const report = {
    ok: allOk,
    network: "testnet",
    epochs,
    input: {
      bytes: inputBytes.length,
      blobId: inUp.blobId,
      blobIdU256: inUp.blobIdU256.toString(),
      blobObjectId: inUp.blobObjectId,
      sha2_256: inUp.inputHash,
      verified: inDl.verified,
      aggregatorUrl: `${AGG}/${inUp.blobId}`,
    },
    output: {
      bytes: outputBytes.length,
      blobId: outUp.blobId,
      blobIdU256: outUp.blobIdU256.toString(),
      blobObjectId: outUp.blobObjectId,
      sha2_256: outputHash,
      verified: outDl.verified,
      verifiedViaU256: u256Ok,
      aggregatorUrl: `${AGG}/${outUp.blobId}`,
    },
  };
  console.error(`\n${allOk ? "✓ ALL VERIFIED" : "✗ VERIFICATION FAILED"}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!allOk) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
