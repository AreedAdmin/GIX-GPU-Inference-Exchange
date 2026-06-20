/**
 * Byte-exact canonical attestation message (§2 of docs/demo-milestone-contract.md).
 *
 * This MUST match, byte-for-byte, what the contract reconstructs and passes to
 * `sui::ed25519::ed25519_verify`. Any drift here makes D1's verifier reject every
 * signature, so this is the single source of truth for the layout and is unit-tested
 * against a frozen golden vector (test/canonical.test.ts).
 *
 * Layout (§2):
 *   msg = "GIX_ATTEST_V1"                    // 13 ascii bytes, domain separator
 *       ‖ job_id                              // 32 bytes (object id, raw)
 *       ‖ runtime_measurement                 // allowlisted measurement bytes (utf8, var-len)
 *       ‖ input_hash                          // 32 bytes = sha2_256(prompt_utf8)
 *       ‖ output_hash                         // 32 bytes = sha2_256(completion_utf8)
 *       ‖ u64_le(output_token_count)          // 8 bytes
 *       ‖ u64_le(t_start_ms)                  // 8 bytes
 *       ‖ u64_le(t_end_ms)                    // 8 bytes
 *
 * Hashes are sha2_256 over UTF-8 bytes (native `sui::hash::sha2_256` in Move).
 * Integers are little-endian.
 */

import { createHash } from "node:crypto";

/** The §2 domain separator, exactly "GIX_ATTEST_V1" (13 ASCII bytes). */
export const DOMAIN_SEPARATOR = "GIX_ATTEST_V1";

export interface AttestationFields {
  /** Sui object id of the Job, e.g. "0xabc…" (must decode to exactly 32 bytes). */
  jobId: string;
  /** The runtime_measurement bytes (the allowlisted measurement string, utf8). */
  measurement: string | Uint8Array;
  /** sha2_256(prompt_utf8), 32 bytes — hex string ("0x"-optional) or raw bytes. */
  inputHash: string | Uint8Array;
  /** sha2_256(completion_utf8), 32 bytes — hex string ("0x"-optional) or raw bytes. */
  outputHash: string | Uint8Array;
  /** Ollama-reported completion token count. */
  outputTokenCount: number | bigint;
  /** Inference start time, ms since epoch. */
  tStart: number | bigint;
  /** Inference end time, ms since epoch. */
  tEnd: number | bigint;
}

/** sha2_256 of a UTF-8 string, returned as a 32-byte Buffer. */
export function sha2_256Utf8(s: string): Buffer {
  return createHash("sha256").update(Buffer.from(s, "utf8")).digest();
}

/** sha2_256 of a UTF-8 string, returned as a lowercase hex string (no "0x"). */
export function sha2_256Hex(s: string): string {
  return sha2_256Utf8(s).toString("hex");
}

/** Decode a "0x"-optional hex string to bytes. */
export function hexToBytes(hex: string): Buffer {
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error(`odd-length hex: ${hex}`);
  return Buffer.from(clean, "hex");
}

/** Decode a Sui object id (hex) into its raw 32-byte form (left-zero-padded). */
export function objectIdToBytes(id: string): Buffer {
  const raw = hexToBytes(id);
  if (raw.length > 32) throw new Error(`object id longer than 32 bytes: ${id}`);
  if (raw.length === 32) return raw;
  // Sui addresses/ids are 32 bytes; pad shorter hex on the left with zeros.
  const out = Buffer.alloc(32);
  raw.copy(out, 32 - raw.length);
  return out;
}

function toBytes(v: string | Uint8Array, expectHexHash = false): Buffer {
  if (typeof v !== "string") return Buffer.from(v);
  // Heuristic only used for hashes: a 32-byte hash is 64 hex chars (or 66 with 0x).
  if (expectHexHash) return hexToBytes(v);
  // Measurement is utf8 (e.g. "MOCK-tdx-llama8b-v1").
  return Buffer.from(v, "utf8");
}

/** Encode a u64 as 8 little-endian bytes. */
export function u64LE(n: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(typeof n === "bigint" ? n : BigInt(n));
  return b;
}

/**
 * Build the byte-exact §2 canonical message. Returns the concatenated bytes the
 * node signs and the contract verifies. Throws on any malformed field so a bad
 * input can never silently produce a signature the contract will reject.
 */
export function buildCanonicalMessage(f: AttestationFields): Buffer {
  const job = objectIdToBytes(f.jobId);
  if (job.length !== 32) throw new Error("job_id must be 32 bytes");

  const measurement = toBytes(f.measurement, false);

  const inputHash = toBytes(f.inputHash, true);
  if (inputHash.length !== 32) {
    throw new Error(`input_hash must be 32 bytes, got ${inputHash.length}`);
  }
  const outputHash = toBytes(f.outputHash, true);
  if (outputHash.length !== 32) {
    throw new Error(`output_hash must be 32 bytes, got ${outputHash.length}`);
  }

  return Buffer.concat([
    Buffer.from(DOMAIN_SEPARATOR, "ascii"), // 13 bytes
    job, // 32 bytes
    measurement, // var-len
    inputHash, // 32 bytes
    outputHash, // 32 bytes
    u64LE(f.outputTokenCount), // 8 bytes
    u64LE(f.tStart), // 8 bytes
    u64LE(f.tEnd), // 8 bytes
  ]);
}
