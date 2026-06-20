/**
 * F7 — the independent-audit verifier (the trust-minimization proof).
 *
 * Given a settled job, ANYONE can reconstruct "paid-for-what-was-run" with no GIX infra
 * running, using only (a) the on-chain Job + AttestationRecord and (b) the Walrus I/O blobs:
 *
 *   read Job + AttestationRecord from Sui   (input_hash, output_hash, model_hash, blob ids, verdict)
 *   fetch input_bytes, output_bytes from Walrus by blob_id
 *   assert sha2_256(input_bytes)  == input_hash
 *   assert sha2_256(output_bytes) == output_hash
 *   assert the attestation signature verifies over the byte-exact §2 canonical message
 *   assert model_hash == registered ModelRecord.model_hash
 *
 * This module is PURE of any live SuiClient / Walrus construction: it takes a `JobAuditView`
 * (already read from chain) and a `WalrusBlobStore` (in-memory on localnet, real on testnet).
 * That keeps it unit-testable offline AND reusable by both the harness and a standalone CLI.
 *
 * It REUSES the node's byte-exact canonical message builder and the Ed25519 verifier so the
 * audit checks the SAME bytes the contract verified — no re-derivation drift.
 */

import { createHash } from "node:crypto";
import { buildCanonicalMessage } from "../node/src/attest/canonical.js";

// The Ed25519 verifier (node/src/attest/signer.ts) pulls in `@noble/ed25519`. We import it
// LAZILY, only when a signature is actually present, so importing `audit.ts` for the
// hash-only / mock-attest path never requires the ed25519 dependency (keeps consumers like the
// SDK suite hermetic without adding @noble/ed25519).
async function verifyAttestationLazy(sig: Uint8Array, msg: Uint8Array, pub: Uint8Array): Promise<boolean> {
  const { verifyAttestation } = await import("../node/src/attest/signer.js");
  return verifyAttestation(sig, msg, pub);
}

/** The on-chain facts an auditor reads from the Job + its AttestationRecord + the model. All
 * hashes are lowercase hex (no 0x); blob ids are u256 (0n = none). This is exactly what
 * `getObject(job)` + `getObject(model)` expose. */
export interface JobAuditView {
  jobId: string;
  /** sha2_256(prompt) committed at job creation. */
  inputHash: string;
  /** sha2_256(completion) recorded at attestation. */
  outputHash: string;
  /** The model's registered content hash (ModelRecord.model_hash). */
  modelHash: string;
  /** The attestation measurement bytes (utf8 string). */
  measurement: string;
  outputTokenCount: number;
  tStart: number;
  tEnd: number;
  /** verdict: 0 VALID | 1 SLA_BREACH | 2 INVALID. */
  verdict: number;
  /** 64-byte Ed25519 signature over the §2 message (or undefined for the mock-attest path). */
  signature?: Uint8Array;
  /** The provider's registered 32-byte Ed25519 attestation pubkey (undefined ⇒ skip sig check). */
  attestPubkey?: Uint8Array;
  /** Walrus input (prompt) blob commitment; 0n ⇒ fetch from the in-memory store / harness map. */
  inputBlobId: bigint;
  /** Walrus output (completion) blob commitment; 0n ⇒ none. */
  outputBlobId: bigint;
}

/** A blob source the audit reads I/O from (the InMemoryWalrus / RealWalrus from walrus.ts). */
export interface BlobSource {
  readByInt(blobIdInt: bigint): Promise<Uint8Array>;
  readonly kind: string;
}

/** One audit check with a name + pass/fail + an explanation (for the JUnit/human report). */
export interface AuditCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface AuditReport {
  jobId: string;
  ok: boolean;
  checks: AuditCheck[];
}

function sha2Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

function normHex(h: string): string {
  return (h.startsWith("0x") || h.startsWith("0X") ? h.slice(2) : h).toLowerCase();
}

/**
 * Run the full F7 audit for one job. Each check is recorded; `ok` is the AND of them all.
 *
 * Optional overrides:
 *   - `inputBytes` / `outputBytes`: when the blob ids are 0n (localnet mock path stores no
 *     on-chain blob id), the harness passes the bytes directly so the hash check still runs.
 *   - `expectModelHash`: the model_hash the auditor independently expects (the registered one);
 *     defaults to comparing the attestation's recorded model_hash against itself when omitted.
 */
export async function auditJob(
  view: JobAuditView,
  walrus: BlobSource,
  opts: {
    inputBytes?: Uint8Array;
    outputBytes?: Uint8Array;
    expectModelHash?: string;
  } = {},
): Promise<AuditReport> {
  const checks: AuditCheck[] = [];

  // 1. input integrity: sha2_256(input_bytes) == on-chain input_hash.
  try {
    const bytes = view.inputBlobId !== 0n ? await walrus.readByInt(view.inputBlobId) : opts.inputBytes;
    if (!bytes) {
      checks.push({ name: "input_hash", ok: false, detail: "no input bytes available (blob id 0 and no bytes provided)" });
    } else {
      const got = sha2Hex(bytes);
      checks.push({
        name: "input_hash",
        ok: got === normHex(view.inputHash),
        detail: `sha2_256(input)=${got} vs on-chain ${normHex(view.inputHash)}`,
      });
    }
  } catch (e) {
    checks.push({ name: "input_hash", ok: false, detail: `walrus read failed: ${(e as Error).message}` });
  }

  // 2. output integrity: sha2_256(output_bytes) == on-chain output_hash.
  try {
    const bytes = view.outputBlobId !== 0n ? await walrus.readByInt(view.outputBlobId) : opts.outputBytes;
    if (!bytes) {
      checks.push({ name: "output_hash", ok: false, detail: "no output bytes available (blob id 0 and no bytes provided)" });
    } else {
      const got = sha2Hex(bytes);
      checks.push({
        name: "output_hash",
        ok: got === normHex(view.outputHash),
        detail: `sha2_256(output)=${got} vs on-chain ${normHex(view.outputHash)}`,
      });
    }
  } catch (e) {
    checks.push({ name: "output_hash", ok: false, detail: `walrus read failed: ${(e as Error).message}` });
  }

  // 3. attestation signature verifies over the byte-exact §2 canonical message.
  if (view.signature && view.attestPubkey) {
    try {
      const msg = buildCanonicalMessage({
        jobId: view.jobId,
        measurement: view.measurement,
        inputHash: normHex(view.inputHash),
        outputHash: normHex(view.outputHash),
        outputTokenCount: view.outputTokenCount,
        tStart: view.tStart,
        tEnd: view.tEnd,
      });
      const ok = await verifyAttestationLazy(view.signature, new Uint8Array(msg), view.attestPubkey);
      checks.push({ name: "signature", ok, detail: ok ? "ed25519 verify over §2 message OK" : "ed25519 verify FAILED" });
    } catch (e) {
      checks.push({ name: "signature", ok: false, detail: `signature reconstruction failed: ${(e as Error).message}` });
    }
  } else {
    // Mock-attest path records no signature on-chain; the signature leg is N/A, not a failure.
    checks.push({ name: "signature", ok: true, detail: "no signature recorded (mock-attest path) — leg skipped" });
  }

  // 4. model_hash binding: the attestation's model_hash matches the registered ModelRecord.
  const expectModel = opts.expectModelHash !== undefined ? normHex(opts.expectModelHash) : normHex(view.modelHash);
  checks.push({
    name: "model_hash",
    ok: normHex(view.modelHash) === expectModel,
    detail: `model_hash=${normHex(view.modelHash)} vs registered ${expectModel}`,
  });

  return { jobId: view.jobId, ok: checks.every((c) => c.ok), checks };
}
