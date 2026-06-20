/**
 * Hashing + byte helpers.
 *
 * The verifiable-result check (demo-milestone-contract §2): both input_hash and
 * output_hash are `sha2_256` over UTF-8 bytes — the SAME primitive Move's native
 * `sui::hash::sha2_256` computes. Node's `crypto.createHash('sha256')` is SHA-2
 * 256, byte-identical to Move's `sha2_256`. (Do NOT use sha3/keccak.)
 */

import { createHash } from "node:crypto";

/** sha2_256 of a UTF-8 string → lowercase hex (no 0x prefix). */
export function sha2_256Hex(input: string): string {
  return createHash("sha256").update(Buffer.from(input, "utf8")).digest("hex");
}

/** sha2_256 of a UTF-8 string → byte array (for PTB `vector<u8>` args). */
export function sha2_256Bytes(input: string): number[] {
  return Array.from(createHash("sha256").update(Buffer.from(input, "utf8")).digest());
}

/** Normalize a hex string: strip an optional `0x`, lowercase. */
export function normalizeHex(hex: string): string {
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  return clean.toLowerCase();
}

/**
 * Constant-shape hex compare used for the verified check: tolerant of an `0x`
 * prefix and case, exact on the bytes. Returns false on any malformed input.
 */
export function hexEquals(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const na = normalizeHex(a);
  const nb = normalizeHex(b);
  if (na.length === 0 || nb.length === 0) return false;
  return na === nb;
}

/** UTF-8 string → byte array. */
export function strBytes(s: string): number[] {
  return Array.from(Buffer.from(s, "utf8"));
}

/** Hex string (optional 0x) → byte array. */
export function hexToBytes(hex: string): number[] {
  const clean = normalizeHex(hex);
  const out: number[] = [];
  for (let i = 0; i + 1 < clean.length; i += 2) {
    out.push(parseInt(clean.slice(i, i + 2), 16));
  }
  return out;
}
