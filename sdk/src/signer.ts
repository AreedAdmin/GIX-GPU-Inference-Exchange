/**
 * Signer adapters for the WalletSigner seam.
 *
 * - `keypairSigner(kp)` wraps a raw @mysten/sui Keypair (server/CLI path).
 * - `fromSuiPrivateKey(suiprivkey…)` builds a keypair signer from a bech32 key.
 *
 * The UI passes its own WalletSigner (a thin wrapper over dapp-kit's
 * signTransaction), so it does not use these — they keep `@mysten/sui` crypto
 * lazily imported so the SDK stays hermetic until a real signer is built.
 */

import type { WalletSigner } from "./types.js";

type KeypairT = import("@mysten/sui/cryptography").Keypair;

/** Wrap a @mysten/sui Keypair as a WalletSigner. */
export function keypairSigner(kp: KeypairT): WalletSigner {
  return {
    toSuiAddress: () => kp.toSuiAddress(),
    async signTransaction(bytes: Uint8Array) {
      // Keypair.signTransaction returns { bytes, signature } (both base64).
      const res = await kp.signTransaction(bytes);
      return { bytes: res.bytes, signature: res.signature };
    },
  };
}

/**
 * Build a WalletSigner from a Sui bech32 private key (`suiprivkey1…`).
 * Dynamically imports the SDK crypto so importing the SDK alone stays hermetic.
 */
export async function fromSuiPrivateKey(suiPrivKey: string): Promise<WalletSigner> {
  const { decodeSuiPrivateKey } = await import("@mysten/sui/cryptography");
  const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
  const { secretKey } = decodeSuiPrivateKey(suiPrivKey);
  const kp = Ed25519Keypair.fromSecretKey(secretKey);
  return keypairSigner(kp);
}
