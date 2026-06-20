/**
 * Key management — persists two keypairs under node/.keys/ (gitignored):
 *
 *   1. sui-tx.key       — the Sui transaction keypair (gas + on-chain calls).
 *   2. attest.key       — the Ed25519 attestation keypair (signs §2 messages,
 *                         registered on-chain via register_provider).
 *
 * They are DISTINCT (§3.1): the attestation key is what the contract verifies per
 * job; the tx key only pays gas / sends txns. The attestation key happens to also be
 * Ed25519, but it is never used as a Sui signer.
 *
 * Persistence format is a tiny JSON file with the bech32 / hex seed; both are created
 * on first run if absent. The Sui keypair is also exposed as a Sui SDK Keypair (via
 * the harness-style decode) so chain.ts can reuse the harness PTB-signing patterns.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type { Keypair } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { attestSignerFromSeed, generateAttestSigner, type AttestSigner } from "./attest/signer.js";

export interface NodeKeys {
  /** Sui tx keypair (gas/txns). */
  suiKeypair: Keypair;
  /** Sui address of the tx keypair. */
  suiAddress: string;
  /** Ed25519 attestation signer (registered + per-job signing). */
  attest: AttestSigner;
  /** 32-byte attestation pubkey as 0x-hex (what register_provider records). */
  attestPubkeyHex: string;
}

interface SuiKeyFile {
  scheme: "ed25519";
  /** 32-byte seed, hex. */
  seedHex: string;
}

interface AttestKeyFile {
  scheme: "ed25519";
  /** 32-byte seed, hex. */
  seedHex: string;
}

function loadOrCreate<T>(path: string, create: () => T): { value: T; created: boolean } {
  if (existsSync(path)) {
    return { value: JSON.parse(readFileSync(path, "utf8")) as T, created: false };
  }
  const value = create();
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
  return { value, created: true };
}

/**
 * Load both keypairs from `keysDir`, creating them on first run. Logs which were
 * freshly generated so the operator can fund/note them.
 */
export function loadKeys(
  keysDir: string,
  log: (msg: string) => void = () => {},
): NodeKeys {
  mkdirSync(keysDir, { recursive: true, mode: 0o700 });

  // --- Sui tx keypair ---
  const suiPath = resolve(keysDir, "sui-tx.key");
  const sui = loadOrCreate<SuiKeyFile>(suiPath, () => {
    // A Sui Ed25519 secret key is just a 32-byte seed; generate it directly so the
    // stored file format is self-contained and scheme-tagged.
    const seed = randomBytes(32);
    return { scheme: "ed25519", seedHex: seed.toString("hex") };
  });
  const suiSeed = Buffer.from(sui.value.seedHex, "hex");
  const suiKeypair = Ed25519Keypair.fromSecretKey(suiSeed);
  const suiAddress = suiKeypair.getPublicKey().toSuiAddress();
  if (sui.created) {
    log(`[keys] generated Sui tx keypair -> ${suiAddress} (FUND THIS with gas + MOCK_USDC)`);
  } else {
    log(`[keys] loaded Sui tx keypair -> ${suiAddress}`);
  }

  // --- Ed25519 attestation keypair ---
  const attestPath = resolve(keysDir, "attest.key");
  const at = loadOrCreate<AttestKeyFile>(attestPath, () => {
    const s = generateAttestSigner();
    return { scheme: "ed25519", seedHex: Buffer.from(s.secretKey).toString("hex") };
  });
  const attest = attestSignerFromSeed(Buffer.from(at.value.seedHex, "hex"));
  const attestPubkeyHex = "0x" + Buffer.from(attest.publicKey).toString("hex");
  if (at.created) {
    log(`[keys] generated Ed25519 attestation key -> pubkey ${attestPubkeyHex}`);
  } else {
    log(`[keys] loaded Ed25519 attestation key -> pubkey ${attestPubkeyHex}`);
  }

  return { suiKeypair, suiAddress, attest, attestPubkeyHex };
}
