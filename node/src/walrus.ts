/**
 * Walrus I/O for the provider node (M2).
 *
 * After inference the node UPLOADS the completion + the signed attestation quote to
 * Walrus as permanent blobs (`writeBlob`, `deletable:false`), and stores their u256
 * `blob_id` commitments on-chain (passed into `submit_signed_attestation` /
 * `create_job_from_fill`). When a fill-job carries `input_blob_id != 0` the node READS
 * the prompt back from Walrus by that id; otherwise it falls back to the /inputs cache.
 *
 * Important framing (docs/m2-phase0-design.md + contracts/README.md):
 *   - The Walrus `blob_id` is a STORAGE COMMITMENT, not a content hash. GIX's `sha2_256`
 *     digests (input_hash / output_hash) stay the verification primitive. We recompute
 *     sha2_256 over whatever we read from Walrus and the serve loop refuses on mismatch.
 *   - On-chain the blob id is a `u256`. The SDK's `blobIdToInt` / `blobIdFromInt` convert
 *     between the base64url blob-id string and that integer; `0` means "no blob".
 *
 * Walrus is TESTNET-ONLY and needs WAL to pay for storage (and SUI for gas). This module
 * is lazy (dynamic import) and config-gated so localnet / HTTP-only / unit-test runs never
 * touch it and stay hermetic. The client is built per SDK-2.0:
 *   new SuiJsonRpcClient({network:'testnet', url}).$extend(walrus({ wasmUrl? }))
 */

import type { Keypair } from "@mysten/sui/cryptography";
import { createHash } from "node:crypto";

type WalrusExtendedClient = {
  walrus: {
    writeBlob(opts: {
      blob: Uint8Array;
      deletable: boolean;
      epochs: number;
      signer: Keypair;
      attributes?: Record<string, string | null>;
    }): Promise<{ blobId: string; blobObject: { id: string; blob_id: string } }>;
    readBlob(opts: { blobId: string }): Promise<Uint8Array>;
  };
};

export interface WalrusDeps {
  /** "testnet" etc. — Walrus needs a known public network. */
  network: "testnet" | "mainnet" | "devnet" | "localnet";
  /** Sui JSON-RPC url (also used by the underlying SuiJsonRpcClient). */
  rpcUrl: string;
  /** The Sui keypair that pays for blob storage (WAL) + gas. */
  signer: Keypair;
  /** Epochs to retain output/quote blobs (cover settlement + dispute window). */
  epochs: number;
  /** Optional Walrus WASM url override. */
  wasmUrl?: string;
  log: (msg: string) => void;
}

/** sha2_256 of raw bytes as lowercase hex (no 0x) — same primitive as attest/canonical. */
export function sha2_256BytesHex(bytes: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

/**
 * Thin, lazily-connected Walrus client. Reused across jobs. All methods are no-throw at
 * construction; failures surface only when the node actually uploads/reads, so the serve
 * loop can degrade gracefully (store result off-chain, fall back to /inputs cache).
 */
export class WalrusIO {
  private client?: WalrusExtendedClient;
  private blobIdToInt!: (s: string) => bigint;
  private blobIdFromInt!: (n: bigint | string) => string;
  private connected = false;

  constructor(private readonly deps: WalrusDeps) {}

  private async connect(): Promise<void> {
    if (this.connected) return;
    const { SuiJsonRpcClient } = await import("@mysten/sui/jsonRpc");
    const { walrus, blobIdToInt, blobIdFromInt } = await import("@mysten/walrus");
    if (this.deps.network !== "testnet" && this.deps.network !== "mainnet") {
      throw new Error(`Walrus is not available on ${this.deps.network} (use testnet/mainnet)`);
    }
    const base = new SuiJsonRpcClient({ network: this.deps.network, url: this.deps.rpcUrl });
    const extended = base.$extend(
      walrus(this.deps.wasmUrl ? { wasmUrl: this.deps.wasmUrl } : undefined),
    );
    this.client = extended as unknown as WalrusExtendedClient;
    this.blobIdToInt = blobIdToInt;
    this.blobIdFromInt = blobIdFromInt;
    this.connected = true;
  }

  /** base64url blob-id string -> u256 (as bigint) for the on-chain field. */
  toInt(blobId: string): bigint {
    return this.blobIdToInt(blobId);
  }
  /** u256 (bigint/string) -> base64url blob-id string for readBlob. */
  fromInt(n: bigint | string): string {
    return this.blobIdFromInt(n);
  }

  /**
   * Upload bytes as a PERMANENT blob (deletable:false), retained for `epochs`. Returns
   * the base64url blob id + its u256 form for the on-chain commitment.
   */
  async upload(
    bytes: Uint8Array,
    attributes?: Record<string, string>,
  ): Promise<{ blobId: string; blobIdInt: bigint; objectId: string }> {
    await this.connect();
    const { blobId, blobObject } = await this.client!.walrus.writeBlob({
      blob: bytes,
      deletable: false,
      epochs: this.deps.epochs,
      signer: this.deps.signer,
      attributes,
    });
    return { blobId, blobIdInt: this.blobIdToInt(blobId), objectId: blobObject.id };
  }

  /** Upload a UTF-8 string (e.g. the completion). */
  async uploadUtf8(
    s: string,
    attributes?: Record<string, string>,
  ): Promise<{ blobId: string; blobIdInt: bigint; objectId: string }> {
    return this.upload(new TextEncoder().encode(s), attributes);
  }

  /** Read a blob by its u256 commitment (as stored on-chain). Returns raw bytes. */
  async readByInt(blobIdInt: bigint | string): Promise<Uint8Array> {
    await this.connect();
    const blobId = this.blobIdFromInt(blobIdInt);
    return this.client!.walrus.readBlob({ blobId });
  }

  /** Read a blob by its u256 commitment and decode UTF-8 (e.g. the prompt). */
  async readUtf8ByInt(blobIdInt: bigint | string): Promise<string> {
    const bytes = await this.readByInt(blobIdInt);
    return new TextDecoder().decode(bytes);
  }
}
