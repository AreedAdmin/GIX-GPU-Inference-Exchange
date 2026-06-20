/**
 * Keystore signer loader (on-chain runs only).
 *
 * Loads real keypairs for the deployment's accounts from the local `sui` keystore
 * by shelling out to `sui keytool export` (which yields the bech32 `suiprivkey1…`
 * form for any key scheme) and decoding it with the @mysten/sui SDK. This keeps
 * the harness's signer wiring identical regardless of whether the accounts are the
 * single funded admin or extra accounts created by ops/scripts/fund.sh.
 *
 * This module is only imported on the on-chain path (dynamic import in cli.ts), so
 * the dry-run/test path never loads the SDK or touches the keystore.
 */

import { execFileSync } from "node:child_process";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1";
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1";
import type { Keypair } from "@mysten/sui/cryptography";

/** Export the bech32 private key for `address` from the sui keystore. */
function exportPrivateKey(address: string): string | null {
  try {
    const out = execFileSync(
      "sui",
      ["keytool", "export", "--key-identity", address, "--json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const parsed = JSON.parse(out) as { exportedPrivateKey?: string };
    return parsed.exportedPrivateKey ?? null;
  } catch {
    return null;
  }
}

/** Build a Keypair from a bech32 `suiprivkey1…` string, honoring its scheme. */
function keypairFromBech32(bech32: string): Keypair {
  const { schema, secretKey } = decodeSuiPrivateKey(bech32);
  switch (schema) {
    case "ED25519":
      return Ed25519Keypair.fromSecretKey(secretKey);
    case "Secp256k1":
      return Secp256k1Keypair.fromSecretKey(secretKey);
    case "Secp256r1":
      return Secp256r1Keypair.fromSecretKey(secretKey);
    default:
      throw new Error(`unsupported key scheme ${schema}`);
  }
}

/**
 * Load a signer for each requested address that the keystore can export. Addresses
 * not present in the keystore are silently skipped (the caller errors only if one
 * it actually needs is missing).
 */
export function loadKeystoreSigners(addresses: string[]): Map<string, Keypair> {
  const out = new Map<string, Keypair>();
  for (const addr of addresses) {
    if (!addr || out.has(addr)) continue;
    const bech32 = exportPrivateKey(addr);
    if (!bech32) continue;
    const kp = keypairFromBech32(bech32);
    // Sanity: the derived address must match what we asked for.
    if (kp.getPublicKey().toSuiAddress() === addr) {
      out.set(addr, kp);
    }
  }
  return out;
}
