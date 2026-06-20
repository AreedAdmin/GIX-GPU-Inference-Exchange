#!/usr/bin/env node
/**
 * upload-model.ts — bind a local GGUF model artifact to its on-chain ModelRecord.
 *
 * Given a local GGUF weights file, this tool:
 *   1. Computes the CANONICAL `model_hash = sha2_256(file)` (streamed — the
 *      llama3.1:8b weights are ~4.6 GB). This is the value the provider
 *      recomputes after fetching the model from Walrus and refuses on mismatch.
 *   2. (OPTIONAL, guarded by --upload) Uploads the blob to Walrus → `blob_id`.
 *      The upload needs WAL + is large (a single regular blob, < 13.3 GiB, not a
 *      quilt member), so it is OFF by default; the orchestrator runs it at
 *      integration. Hashing + command emission work WITHOUT uploading.
 *   3. Prints `model_hash` + `blob_id` and a ready `sui client call` (against
 *      `gix::registry::register_model`) to bind them into the on-chain
 *      `ModelRecord`, replacing the deploy-time placeholder strings.
 *
 * Usage:
 *   tsx scripts/upload-model.ts --file <gguf> [--deployment deployment.testnet.json]
 *                               [--model-uri ollama:llama3.1:8b] [--upload]
 *                               [--epochs 30] [--privkey suiprivkey1...]
 *
 * The default --file is the bundled llama3.1:8b GGUF blob.
 *
 * NOTE: `walrus_blob_id` is stored on-chain as `vector<u8>` (free-form). We
 * encode it as the UTF-8 bytes of the base64 blob-id STRING so the consumer can
 * round-trip it via `@mysten/walrus` `blobIdFromInt`/string compare. `model_hash`
 * is the raw 32 sha2_256 bytes. Both are emitted as JSON byte arrays for the CLI.
 */

import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { basename } from "node:path";

const DEFAULT_GGUF =
  "/usr/share/ollama/.ollama/models/blobs/sha256-667b0c1932bc6ffc593ed1d03f895bf2dc8dc6df21db3042284a6f4416b06a29";

interface Args {
  file: string;
  deployment?: string;
  modelUri: string;
  upload: boolean;
  epochs: number;
  privkey?: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  return {
    file: get("--file") ?? DEFAULT_GGUF,
    deployment: get("--deployment"),
    modelUri: get("--model-uri") ?? "ollama:llama3.1:8b",
    upload: argv.includes("--upload"),
    epochs: Number(get("--epochs") ?? "30"),
    privkey: get("--privkey") ?? process.env.SUI_PRIVKEY,
  };
}

/** Stream a sha2_256 over the file (handles multi-GB without buffering). */
function sha2_256File(path: string): Promise<{ hex: string; bytes: number[]; size: number }> {
  return new Promise((resolve, reject) => {
    const size = statSync(path).size;
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk as Buffer));
    stream.on("error", reject);
    stream.on("end", () => {
      const digest = hash.digest();
      resolve({ hex: digest.toString("hex"), bytes: Array.from(digest), size });
    });
  });
}

/** UTF-8 string → JSON byte array (the CLI vector<u8> literal form). */
function strToBytes(s: string): number[] {
  return Array.from(Buffer.from(s, "utf8"));
}

/** Render a JSON byte array compactly for a `sui client call --args` literal. */
function bytesLiteral(bytes: number[]): string {
  return `[${bytes.join(",")}]`;
}

async function loadDeployment(path?: string): Promise<{
  packageId?: string;
  adminCapId?: string;
  configId?: string;
  allowlistId?: string;
  mockMeasurement?: string;
} | null> {
  if (!path) return null;
  const { readFile } = await import("node:fs/promises");
  try {
    const txt = await readFile(path, "utf8");
    return JSON.parse(txt);
  } catch (e) {
    console.error(`! could not read deployment ${path}: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Upload the model blob to Walrus. Guarded: only called under --upload. Reads
 * the full file into memory then writes it as one regular blob.
 */
async function uploadToWalrus(
  file: string,
  epochs: number,
  privkey: string,
): Promise<{ blobId: string; blobObjectId?: string }> {
  const { readFile } = await import("node:fs/promises");
  const { SuiJsonRpcClient, getJsonRpcFullnodeUrl } = await import("@mysten/sui/jsonRpc");
  const { decodeSuiPrivateKey } = await import("@mysten/sui/cryptography");
  const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
  const { WalrusClient } = await import("@mysten/walrus");

  const { secretKey } = decodeSuiPrivateKey(privkey);
  const signer = Ed25519Keypair.fromSecretKey(secretKey);
  const suiClient = new SuiJsonRpcClient({
    network: "testnet",
    url: getJsonRpcFullnodeUrl("testnet"),
  });
  const walrus = new WalrusClient({
    network: "testnet",
    suiClient: suiClient as unknown as never,
  });

  const blob = new Uint8Array(await readFile(file));
  const { blobId, blobObject } = await walrus.writeBlob({
    blob,
    deletable: false,
    epochs,
    signer,
  });
  return { blobId, blobObjectId: blobObject?.id };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // 1. Canonical model_hash = sha2_256(file) (streamed).
  console.error(`Hashing ${args.file} (sha2_256, streamed)…`);
  let hash: { hex: string; bytes: number[]; size: number };
  try {
    hash = await sha2_256File(args.file);
  } catch (e) {
    console.error(`! cannot hash ${args.file}: ${(e as Error).message}`);
    console.error("  (pass --file <path-to-gguf>)");
    process.exit(1);
    return;
  }
  const sizeGiB = (hash.size / 1024 ** 3).toFixed(2);
  console.error(`  size = ${hash.size} bytes (${sizeGiB} GiB)`);

  // 2. Optional Walrus upload (guarded — needs WAL + is large).
  let blobId: string | undefined;
  let blobObjectId: string | undefined;
  if (args.upload) {
    if (!args.privkey) {
      console.error("! --upload requires --privkey (or SUI_PRIVKEY env) — a funded testnet key with WAL");
      process.exit(1);
      return;
    }
    console.error(`Uploading to Walrus (testnet, ${args.epochs} epochs)… this is ~${sizeGiB} GiB.`);
    const up = await uploadToWalrus(args.file, args.epochs, args.privkey);
    blobId = up.blobId;
    blobObjectId = up.blobObjectId;
    console.error(`  uploaded: blob_id=${blobId} blobObject=${blobObjectId ?? "?"}`);
  } else {
    console.error("Skipping Walrus upload (no --upload). model_hash + command emitted below.");
  }

  // 3. Emit model_hash, blob_id, and the binding `sui client call`.
  const dep = await loadDeployment(args.deployment);
  const blobIdForChain = blobId ?? "<WALRUS_BLOB_ID>";
  const walrusBlobBytes = blobId ? strToBytes(blobId) : null;
  const modelUriBytes = strToBytes(args.modelUri);

  const out = {
    file: basename(args.file),
    sizeBytes: hash.size,
    modelHashHex: hash.hex,
    modelHashBytes: hash.bytes,
    modelUri: args.modelUri,
    walrusBlobId: blobId ?? null,
    walrusBlobObjectId: blobObjectId ?? null,
  };
  console.log(JSON.stringify(out, null, 2));

  // Human-facing bind command (replaces the deploy-time placeholder strings).
  const pkg = dep?.packageId ?? "<PACKAGE_ID>";
  const adminCap = dep?.adminCapId ?? "<ADMIN_CAP_ID>";
  const cfg = dep?.configId ?? "<CONFIG_ID>";

  console.error("\n— Bind into the on-chain ModelRecord —");
  console.error("registry::register_model(_: &AdminCap, cfg, model_uri, walrus_blob_id, model_hash, ctx): ID\n");
  console.error(
    [
      `sui client call \\`,
      `  --package ${pkg} \\`,
      `  --module registry \\`,
      `  --function register_model \\`,
      `  --args \\`,
      `    ${adminCap} \\`,
      `    ${cfg} \\`,
      `    '${bytesLiteral(modelUriBytes)}' \\   # model_uri = "${args.modelUri}"`,
      `    '${walrusBlobBytes ? bytesLiteral(walrusBlobBytes) : `<utf8-bytes-of "${blobIdForChain}">`}' \\   # walrus_blob_id`,
      `    '${bytesLiteral(hash.bytes)}'   # model_hash = sha2_256(file) = ${hash.hex}`,
      ``,
    ].join("\n"),
  );
  console.error(
    "Tip: to also wire the approved measurement in one call, use " +
      "gix::governance::register_model_with_measurement(cap, cfg, allow, model_uri, " +
      "walrus_blob_id, model_hash, measurement, ctx) — " +
      `allow=${dep?.allowlistId ?? "<ALLOWLIST_ID>"}, measurement="${dep?.mockMeasurement ?? "<MEASUREMENT>"}".`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
