/**
 * Walrus blob-store abstraction for the E2E harness.
 *
 * The pool-free path stores job I/O on Walrus (input prompt + output completion blobs),
 * but **Walrus has no localnet**. So the harness abstracts the store behind one interface:
 *   - `InMemoryWalrus`  — localnet / CI. A deterministic `Map<u256, bytes>` whose blob ids
 *     are computed from `sha2_256(bytes)` so the same bytes always get the same id (a stable
 *     commitment, exactly like Walrus's content-addressed blob id). No network, no WAL.
 *   - `RealWalrus`      — testnet. Wraps the node's `WalrusIO` (lazy `@mysten/walrus`), which
 *     uploads PERMANENT blobs and reads them back by u256 commitment. NEVER constructed on
 *     localnet (and never run by this delivery — testnet is wired-not-run).
 *
 * The id is a u256 (the on-chain `input_blob_id` / `output_blob_id` field type). The audit
 * verifier (`audit.ts`) reads bytes back by that id and recomputes `sha2_256` — the blob id is
 * a RETRIEVAL commitment, never the integrity primitive (§4 F4).
 */

import { createHash } from "node:crypto";

/** A minimal content-addressed blob store: upload bytes → u256 id; read by u256 id. */
export interface WalrusBlobStore {
  /** Upload bytes, returning the u256 commitment to store on-chain. */
  upload(bytes: Uint8Array): Promise<bigint>;
  /** Read bytes back by their u256 commitment. Throws if absent / unreachable. */
  readByInt(blobIdInt: bigint): Promise<Uint8Array>;
  /** A human label for logs ("in-memory" | "testnet"). */
  readonly kind: string;
}

/** sha2_256(bytes) as a bigint, truncated to a u256 — a deterministic, content-addressed id
 * that mimics Walrus's blob_id commitment (stable for identical bytes; 0 reserved for none). */
function contentId(bytes: Uint8Array): bigint {
  const hex = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
  const id = BigInt("0x" + hex);
  // Reserve 0n for "no blob"; the astronomically-unlikely all-zero hash maps to 1n.
  return id === 0n ? 1n : id;
}

/**
 * Deterministic in-memory Walrus for localnet / CI. Content-addressed: identical bytes always
 * yield the same id, so re-uploading the same output is idempotent and the audit verifier can
 * always find the blob. A fault hook can corrupt a stored blob or make a read fail.
 */
export class InMemoryWalrus implements WalrusBlobStore {
  readonly kind = "in-memory";
  private readonly blobs = new Map<string, Uint8Array>();
  /** Ids for which a read should fail (Walrus-read-fail fault injection). */
  private readonly unreadable = new Set<string>();

  async upload(bytes: Uint8Array): Promise<bigint> {
    const id = contentId(bytes);
    this.blobs.set(id.toString(), Uint8Array.from(bytes));
    return id;
  }

  async readByInt(blobIdInt: bigint): Promise<Uint8Array> {
    const key = blobIdInt.toString();
    if (this.unreadable.has(key)) {
      throw new Error(`InMemoryWalrus: read of blob ${key} forced to fail (fault injection)`);
    }
    const b = this.blobs.get(key);
    if (!b) throw new Error(`InMemoryWalrus: no blob for id ${key}`);
    return b;
  }

  // ---- fault-injection hooks (used by faults.ts) -------------------------

  /** Overwrite the bytes stored under `id` (corrupt-output fault) — the id no longer
   * content-addresses these bytes, so the audit's `sha2_256` check must fail. */
  corrupt(id: bigint, corrupted: Uint8Array): void {
    this.blobs.set(id.toString(), Uint8Array.from(corrupted));
  }

  /** Make subsequent reads of `id` throw (Walrus-unavailable fault). */
  failReads(id: bigint): void {
    this.unreadable.add(id.toString());
  }

  /** Clear a forced read failure. */
  healReads(id: bigint): void {
    this.unreadable.delete(id.toString());
  }

  /** Raw store inspection (tests). */
  has(id: bigint): boolean {
    return this.blobs.has(id.toString());
  }
}

/**
 * Real Walrus over testnet, wrapping the provider node's `WalrusIO`. Lazy-imported so localnet
 * runs never pull in the Walrus WASM. NEVER constructed on localnet. Not executed by this
 * delivery (testnet is wired-not-run); present so the gb10/testnet mode is complete.
 */
export class RealWalrus implements WalrusBlobStore {
  readonly kind = "testnet";
  // `io` is the node's WalrusIO instance; typed loosely to avoid a hard import here.
  constructor(private readonly io: { upload(b: Uint8Array): Promise<{ blobIdInt: bigint }>; readByInt(n: bigint | string): Promise<Uint8Array> }) {}

  async upload(bytes: Uint8Array): Promise<bigint> {
    const { blobIdInt } = await this.io.upload(bytes);
    return blobIdInt;
  }

  async readByInt(blobIdInt: bigint): Promise<Uint8Array> {
    return this.io.readByInt(blobIdInt);
  }
}
