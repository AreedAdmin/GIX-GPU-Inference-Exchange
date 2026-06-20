/**
 * Ed25519 attestation signer.
 *
 * This is the key registered on-chain via `register_provider(..., attest_pubkey)`.
 * It is SEPARATE from the Sui tx keypair (gas/txns): the contract verifies a raw
 * Ed25519 signature over the §2 canonical message against this pubkey, using
 * `sui::ed25519::ed25519_verify`. Sui's native verify expects a 64-byte signature
 * and a 32-byte pubkey over the raw message (no Sui-tx intent prefix), which is
 * exactly what @noble/ed25519 produces.
 */

import { createHash, randomBytes } from "node:crypto";
import * as ed from "@noble/ed25519";

// @noble/ed25519 v2's synchronous sign()/verify()/getPublicKey() require the
// consumer to wire a sync sha512. We use Node's built-in crypto so there is no extra
// hash dependency. This must run once at module load, before any sign/verify call.
if (!ed.etc.sha512Sync) {
  ed.etc.sha512Sync = (...m: Uint8Array[]) =>
    new Uint8Array(createHash("sha512").update(Buffer.from(ed.etc.concatBytes(...m))).digest());
}

export interface AttestSigner {
  /** 32-byte Ed25519 public key (what register_provider records). */
  publicKey: Uint8Array;
  /** 32-byte Ed25519 secret seed. */
  secretKey: Uint8Array;
  /** Sign a message → 64-byte detached signature. */
  sign(message: Uint8Array): Uint8Array;
}

/** Build an AttestSigner from a 32-byte secret seed. */
export function attestSignerFromSeed(seed: Uint8Array): AttestSigner {
  if (seed.length !== 32) throw new Error(`attest seed must be 32 bytes, got ${seed.length}`);
  const publicKey = ed.getPublicKey(seed);
  return {
    publicKey,
    secretKey: seed,
    sign: (message: Uint8Array) => ed.sign(message, seed),
  };
}

/** Generate a fresh random Ed25519 attestation key. Uses Node's CSPRNG directly so
 *  it does not depend on a WebCrypto global being present (absent under Node 18 in
 *  some runtimes). */
export function generateAttestSigner(): AttestSigner {
  return attestSignerFromSeed(new Uint8Array(randomBytes(32)));
}

/** Verify a detached signature against a pubkey + message (used by the unit test). */
export function verifyAttestation(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  return ed.verify(signature, message, publicKey);
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
