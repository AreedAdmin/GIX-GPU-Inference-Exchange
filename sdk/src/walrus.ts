/**
 * Walrus storage helpers — M2 testnet input/output blob plumbing.
 *
 * Replaces the M1 "POST prompt to the node /inputs" step: the consumer uploads
 * the prompt to Walrus and commits the returned blob id (as a u256) on-chain at
 * create_job_from_fill; the provider fetches it from Walrus by id. The output
 * (completion) is likewise published to Walrus by the provider; the consumer
 * downloads it by the job's `output_blob_id` and verifies it against the
 * on-chain sha2_256 `output_hash`.
 *
 * Key facts (docs/m2-phase0-design.md):
 *   - `blob_id` is a STORAGE COMMITMENT, not a content hash. GIX keeps its own
 *     sha2_256 (`input_hash` / `output_hash`) as the verification primitive.
 *   - The on-chain Job stores the blob id as a `u256`; `@mysten/walrus`
 *     `blobIdToInt` / `blobIdFromInt` convert to/from the base64 string form.
 *   - Walrus is testnet-only; writeBlob needs WAL + a real `Signer` (a keypair).
 *
 * Hermetic by design: `@mysten/walrus` is dynamically imported on first use, so
 * importing the SDK alone never pulls in the Walrus WASM. The pure helpers
 * (`verifyBlob`, `blobIdToU256` / `u256ToBlobId` re-exports) are testable without
 * a network.
 */

import { hexEquals, sha2_256Hex, sha2_256HexBytes } from "./hash.js";

type SuiClientT = import("@mysten/sui/jsonRpc").SuiJsonRpcClient;
type SignerT = import("@mysten/sui/cryptography").Signer;
type WalrusClientT = import("@mysten/walrus").WalrusClient;

/** Default Walrus storage duration (epochs) for input/output blobs. Short —
 * these are ephemeral job artifacts, not the long-lived model. Tunable. */
export const DEFAULT_BLOB_EPOCHS = 3;

/** The result of uploading the prompt to Walrus. */
export interface UploadInputResult {
  /** The Walrus blob id (base64 string form). */
  blobId: string;
  /** The Walrus blob id as a u256 — the value committed on-chain. */
  blobIdU256: bigint;
  /** sha2_256(prompt_utf8) hex — the GIX verification primitive (input_hash). */
  inputHash: string;
  /** The created Walrus Blob object id (for PoA / certification follow-up). */
  blobObjectId?: string;
}

export interface WalrusHelperOptions {
  /** "testnet" | "mainnet" — the Walrus network. M2 is testnet. */
  network?: "testnet" | "mainnet";
  /** A connected SuiJsonRpcClient (the WalrusClient needs the Sui core API). */
  suiClient: SuiClientT;
  /** Storage duration in epochs for uploaded blobs. Default {@link DEFAULT_BLOB_EPOCHS}. */
  epochs?: number;
  /** Optional logger. */
  logger?: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * Thin wrapper over `@mysten/walrus`'s WalrusClient for the GIX job I/O blobs.
 * Construct once per consumer session; the underlying WalrusClient is built
 * lazily on the first upload/download.
 */
export class WalrusHelper {
  private client?: WalrusClientT;
  private readonly network: "testnet" | "mainnet";
  private readonly epochs: number;

  constructor(private readonly opts: WalrusHelperOptions) {
    this.network = opts.network ?? "testnet";
    this.epochs = opts.epochs ?? DEFAULT_BLOB_EPOCHS;
  }

  private log(m: string, x?: Record<string, unknown>) {
    this.opts.logger?.(m, x);
  }

  /** Lazily build the WalrusClient (pulls in the WASM on first use). */
  private async walrus(): Promise<WalrusClientT> {
    if (this.client) return this.client;
    const { WalrusClient } = await import("@mysten/walrus");
    // The WalrusClient wants a ClientWithCoreApi; SuiJsonRpcClient supplies the
    // core API. Cast through unknown — skipLibCheck keeps this safe at build.
    this.client = new WalrusClient({
      network: this.network,
      suiClient: this.opts.suiClient as unknown as never,
    });
    return this.client;
  }

  /**
   * Upload the prompt to Walrus and compute the GIX input commitment.
   * Returns the blob id (string + u256) and the sha2_256(prompt) `input_hash`.
   * Requires WAL on the signer (testnet swap via `get-wal`).
   */
  async uploadInput(prompt: string, signer: SignerT): Promise<UploadInputResult> {
    const blob = new TextEncoder().encode(prompt);
    const walrus = await this.walrus();
    const { blobId, blobObject } = await walrus.writeBlob({
      blob,
      deletable: false,
      epochs: this.epochs,
      signer,
    });
    const inputHash = sha2_256Hex(prompt);
    const blobIdU256 = await blobIdToU256(blobId);
    this.log("walrus input uploaded", { blobId, blobObjectId: blobObject?.id });
    return { blobId, blobIdU256, inputHash, blobObjectId: blobObject?.id };
  }

  /**
   * Download an output (completion) blob from Walrus by its blob id. Accepts
   * either the base64 string id or the on-chain u256 commitment.
   */
  async downloadOutput(blobIdOrU256: string | bigint): Promise<Uint8Array> {
    const blobId =
      typeof blobIdOrU256 === "bigint" ? await u256ToBlobId(blobIdOrU256) : blobIdOrU256;
    const walrus = await this.walrus();
    const bytes = await walrus.readBlob({ blobId });
    this.log("walrus output downloaded", { blobId, bytes: bytes.length });
    return bytes;
  }

  /**
   * Download the output blob and verify it against the on-chain sha2_256
   * `output_hash`, returning both the decoded text and the verified flag.
   */
  async downloadAndVerify(
    blobIdOrU256: string | bigint,
    onchainOutputHash: string,
  ): Promise<{ output: string; bytes: Uint8Array; verified: boolean }> {
    const bytes = await this.downloadOutput(blobIdOrU256);
    const verified = verifyBlob(bytes, onchainOutputHash);
    const output = new TextDecoder().decode(bytes);
    return { output, bytes, verified };
  }
}

/**
 * The verifiable-result check over raw bytes: sha2_256(bytes) == on-chain
 * `output_hash` (hex-tolerant). This is the SAME primitive as `verifyOutput`,
 * but over the Walrus-downloaded bytes rather than a decoded string — exported
 * for direct unit testing. Returns false on any malformed hash.
 */
export function verifyBlob(bytes: Uint8Array, onchainOutputHash: string): boolean {
  const hex = sha2_256HexBytes(bytes);
  return hexEquals(hex, onchainOutputHash);
}

/**
 * Convert a Walrus blob id (base64 string) to the u256 the contract stores.
 * Dynamically imports `@mysten/walrus`'s `blobIdToInt`.
 */
export async function blobIdToU256(blobId: string): Promise<bigint> {
  const { blobIdToInt } = await import("@mysten/walrus");
  return blobIdToInt(blobId);
}

/**
 * Convert an on-chain u256 blob commitment back to the base64 blob id Walrus
 * reads by. Dynamically imports `@mysten/walrus`'s `blobIdFromInt`.
 */
export async function u256ToBlobId(blobIdU256: bigint): Promise<string> {
  const { blobIdFromInt } = await import("@mysten/walrus");
  return blobIdFromInt(blobIdU256);
}
