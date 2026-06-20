/**
 * Unit test for the byte-exact §2 canonical message + Ed25519 signature.
 *
 * These bytes MUST match the contract's §2 layout so D1's
 * `sui::ed25519::ed25519_verify(&signature, &attest_pubkey, &msg)` accepts them.
 * The test:
 *   1. builds the message for a fully-frozen input (deterministic key, fixed job_id,
 *      fixed prompt/completion), and asserts the EXACT hex of every field + the whole
 *      message → this is the golden vector D1 must reproduce on-chain.
 *   2. signs with the Ed25519 attestation key and verifies the signature round-trips
 *      via @noble/ed25519 (the same primitive Sui's native verify uses).
 *   3. asserts field offsets/lengths so any layout drift fails loudly.
 */

import { describe, it, expect } from "vitest";
import {
  buildCanonicalMessage,
  sha2_256Hex,
  u64LE,
  objectIdToBytes,
  DOMAIN_SEPARATOR,
} from "../src/attest/canonical.js";
import { attestSignerFromSeed, verifyAttestation } from "../src/attest/signer.js";

// --- Frozen golden inputs --------------------------------------------------

// A deterministic 32-byte Ed25519 seed (all 0x01) → fixed pubkey/signature.
const SEED = new Uint8Array(32).fill(1);

// Fixed job id (32 bytes = 0x11..11).
const JOB_ID = "0x" + "11".repeat(32);

const MEASUREMENT = "MOCK-tdx-llama8b-v1";
const PROMPT = "What is 2+2?";
const COMPLETION = "2 + 2 = 4.";
const OUTPUT_TOKENS = 7;
const T_START = 1_700_000_000_000;
const T_END = 1_700_000_000_456;

describe("§2 canonical attestation message", () => {
  const inputHash = sha2_256Hex(PROMPT);
  const outputHash = sha2_256Hex(COMPLETION);

  it("hashes are sha2_256(utf8), 32 bytes", () => {
    // Frozen sha2_256 of the exact UTF-8 strings (independently verifiable with
    //   printf 'What is 2+2?' | sha256sum
    //   printf '2 + 2 = 4.'  | sha256sum
    expect(inputHash).toBe(GOLDEN_INPUT_HASH);
    expect(outputHash).toBe(GOLDEN_OUTPUT_HASH);
    expect(inputHash).toHaveLength(64);
    expect(outputHash).toHaveLength(64);
  });

  it("u64_le encodes little-endian", () => {
    expect(u64LE(1).toString("hex")).toBe("0100000000000000");
    expect(u64LE(456).toString("hex")).toBe("c801000000000000");
    // 1_700_000_000_000 little-endian.
    expect(u64LE(T_START).toString("hex")).toBe("0068e5cf8b010000");
    // 1_700_000_000_456 little-endian (= T_START + 456).
    expect(u64LE(T_END).toString("hex")).toBe("c869e5cf8b010000");
  });

  it("job_id decodes to exactly 32 raw bytes", () => {
    expect(objectIdToBytes(JOB_ID)).toHaveLength(32);
    expect(objectIdToBytes(JOB_ID).toString("hex")).toBe("11".repeat(32));
  });

  it("builds the byte-exact §2 layout with correct offsets", () => {
    const msg = buildCanonicalMessage({
      jobId: JOB_ID,
      measurement: MEASUREMENT,
      inputHash,
      outputHash,
      outputTokenCount: OUTPUT_TOKENS,
      tStart: T_START,
      tEnd: T_END,
    });

    const ds = Buffer.from(DOMAIN_SEPARATOR, "ascii");
    expect(ds).toHaveLength(13);
    const measBytes = Buffer.from(MEASUREMENT, "utf8");

    // Field offsets per §2.
    let off = 0;
    expect(msg.subarray(off, off + 13).toString("ascii")).toBe("GIX_ATTEST_V1");
    off += 13;
    expect(msg.subarray(off, off + 32).toString("hex")).toBe("11".repeat(32)); // job_id
    off += 32;
    expect(msg.subarray(off, off + measBytes.length).toString("utf8")).toBe(MEASUREMENT);
    off += measBytes.length;
    expect(msg.subarray(off, off + 32).toString("hex")).toBe(inputHash);
    off += 32;
    expect(msg.subarray(off, off + 32).toString("hex")).toBe(outputHash);
    off += 32;
    expect(msg.subarray(off, off + 8).toString("hex")).toBe(u64LE(OUTPUT_TOKENS).toString("hex"));
    off += 8;
    expect(msg.subarray(off, off + 8).toString("hex")).toBe(u64LE(T_START).toString("hex"));
    off += 8;
    expect(msg.subarray(off, off + 8).toString("hex")).toBe(u64LE(T_END).toString("hex"));
    off += 8;

    // Total length is fixed: 13 + 32 + |meas| + 32 + 32 + 8 + 8 + 8.
    expect(off).toBe(msg.length);
    expect(msg.length).toBe(13 + 32 + measBytes.length + 32 + 32 + 8 + 8 + 8);
  });

  it("signs and round-trips via @noble/ed25519 (Sui native verify primitive)", () => {
    const signer = attestSignerFromSeed(SEED);
    const msg = buildCanonicalMessage({
      jobId: JOB_ID,
      measurement: MEASUREMENT,
      inputHash,
      outputHash,
      outputTokenCount: OUTPUT_TOKENS,
      tStart: T_START,
      tEnd: T_END,
    });
    const sig = signer.sign(msg);

    // 32-byte pubkey, 64-byte signature — exactly what ed25519_verify expects.
    expect(signer.publicKey).toHaveLength(32);
    expect(sig).toHaveLength(64);

    // The (pubkey, message, signature) triple the contract receives must verify.
    expect(verifyAttestation(sig, msg, signer.publicKey)).toBe(true);

    // Tamper detection: flipping one message byte must reject.
    const bad = Buffer.from(msg);
    bad[20] ^= 0xff;
    expect(verifyAttestation(sig, bad, signer.publicKey)).toBe(false);
  });

  it("emits the frozen GOLDEN VECTOR (D1 must reproduce these exact hexes)", () => {
    const signer = attestSignerFromSeed(SEED);
    const msg = buildCanonicalMessage({
      jobId: JOB_ID,
      measurement: MEASUREMENT,
      inputHash,
      outputHash,
      outputTokenCount: OUTPUT_TOKENS,
      tStart: T_START,
      tEnd: T_END,
    });
    const sig = signer.sign(msg);
    const golden = {
      attestPubkey: "0x" + Buffer.from(signer.publicKey).toString("hex"),
      jobId: JOB_ID,
      measurement: MEASUREMENT,
      inputHash: "0x" + inputHash,
      outputHash: "0x" + outputHash,
      outputTokenCount: OUTPUT_TOKENS,
      tStart: T_START,
      tEnd: T_END,
      message: "0x" + msg.toString("hex"),
      signature: "0x" + Buffer.from(sig).toString("hex"),
    };
    // Print it so the report and D1 can copy the exact bytes.
    // eslint-disable-next-line no-console
    console.log("GOLDEN_VECTOR=" + JSON.stringify(golden, null, 2));

    // Lock the message + signature so any future drift fails CI.
    expect(golden.message).toBe(GOLDEN_MESSAGE);
    expect(golden.signature).toBe(GOLDEN_SIGNATURE);
    expect(golden.attestPubkey).toBe(GOLDEN_PUBKEY);
    expect(verifyAttestation(sig, msg, signer.publicKey)).toBe(true);
  });
});

// Frozen expected values (computed from the deterministic inputs above).
// Cross-checked: INPUT/OUTPUT hashes equal `printf '<str>' | sha256sum`.
// PUBKEY is the standard Ed25519 pubkey for the all-0x01 seed.
const GOLDEN_INPUT_HASH =
  "52cb6b5e4a038af1756708f98afb718a08c75b87b2f03dbee4dd9c8139c15c5e";
const GOLDEN_OUTPUT_HASH =
  "4eeeaa2b74ff4fd8be484d19f321ea7289550af2ec3887782543f6d8edc579cd";
const GOLDEN_PUBKEY =
  "0x8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c";
const GOLDEN_MESSAGE =
  "0x4749585f4154544553545f563111111111111111111111111111111111111111111111111111111111111111114d4f434b2d7464782d6c6c616d6138622d763152cb6b5e4a038af1756708f98afb718a08c75b87b2f03dbee4dd9c8139c15c5e4eeeaa2b74ff4fd8be484d19f321ea7289550af2ec3887782543f6d8edc579cd07000000000000000068e5cf8b010000c869e5cf8b010000";
const GOLDEN_SIGNATURE =
  "0xee63465a9bd17ed00088ccc99eb318ce9da266ce77c7fbce315b100b77c6df958acbb3a3aebda8fcba1ba30a2c7e59a1f1ab755eeac03d52a39a5c6daed91b02";
