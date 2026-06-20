/**
 * Unit tests for the consumer-side audit verifier (F7), at the SDK layer.
 *
 * The SDK is what the web/consumer runs to prove "paid-for-what-was-run". This pins the two
 * primitives the audit relies on:
 *   - `verifyOutput(output, onChainHash)` — the verifiable-result check the UI shows ✅/❌;
 *   - `sha2_256HexBytes(bytes)` over raw Walrus-downloaded bytes — equals the on-chain hash.
 *
 * It also cross-checks the SDK primitive against the standalone e2e audit verifier
 * (`e2e/audit.ts`) so the two never drift: the SAME bytes + hash must produce the SAME verdict
 * in both. (Imports the e2e verifier by relative path — both are in this repo.)
 */

import { describe, it, expect } from "vitest";
import { verifyOutput } from "../src/client.js";
import { sha2_256Hex, sha2_256HexBytes, hexEquals } from "../src/hash.js";
import { verifyBlob } from "../src/walrus.js";
import { auditJob, type JobAuditView } from "../../e2e/audit.js";
import { InMemoryWalrus } from "../../e2e/walrus.js";

const PROMPT = "What is 2+2?";
const COMPLETION = "[gix-mock] echo: What is 2+2?";

describe("SDK verifyOutput / hash primitive", () => {
  it("verifyOutput true iff sha2_256(output) == on-chain output_hash", () => {
    const onchain = sha2_256Hex(COMPLETION);
    expect(verifyOutput(COMPLETION, onchain)).toBe(true);
    expect(verifyOutput(COMPLETION, "0x" + onchain)).toBe(true); // 0x-tolerant
    expect(verifyOutput(COMPLETION + " tampered", onchain)).toBe(false);
  });

  it("sha2_256HexBytes over raw bytes equals the on-chain hash", () => {
    const bytes = new TextEncoder().encode(COMPLETION);
    expect(sha2_256HexBytes(bytes)).toBe(sha2_256Hex(COMPLETION));
    expect(verifyBlob(bytes, sha2_256Hex(COMPLETION))).toBe(true);
    expect(verifyBlob(new TextEncoder().encode("other"), sha2_256Hex(COMPLETION))).toBe(false);
  });

  it("hexEquals is case- and 0x-tolerant, exact on bytes", () => {
    const h = sha2_256Hex(PROMPT);
    expect(hexEquals(h, "0x" + h.toUpperCase())).toBe(true);
    expect(hexEquals(h, h.slice(0, -1) + "0")).toBe(false);
  });
});

describe("SDK ↔ e2e audit agreement (no drift)", () => {
  it("a clean (input,output,model) view audits GREEN in both layers", async () => {
    const walrus = new InMemoryWalrus();
    const inputBlobId = await walrus.upload(new TextEncoder().encode(PROMPT));
    const outputBlobId = await walrus.upload(new TextEncoder().encode(COMPLETION));
    const modelHash = sha2_256Hex("model");
    const view: JobAuditView = {
      jobId: "0x" + "11".repeat(32),
      inputHash: sha2_256Hex(PROMPT),
      outputHash: sha2_256Hex(COMPLETION),
      modelHash,
      measurement: "MOCK-tdx-llama8b-v1",
      outputTokenCount: 5,
      tStart: 1_700_000_000_000,
      tEnd: 1_700_000_000_200,
      verdict: 0,
      // No signature in this view ⇒ the signature leg is N/A (skipped), exercised live elsewhere.
      inputBlobId,
      outputBlobId,
    };
    const report = await auditJob(view, walrus, { expectModelHash: modelHash });
    expect(report.ok).toBe(true);
    // The SDK's own output check agrees with the e2e output_hash leg.
    const outputCheck = report.checks.find((c) => c.name === "output_hash")!;
    expect(outputCheck.ok).toBe(verifyOutput(COMPLETION, view.outputHash));
  });

  it("a tampered output flips BOTH the SDK check and the e2e audit to RED", async () => {
    const walrus = new InMemoryWalrus();
    const inputBlobId = await walrus.upload(new TextEncoder().encode(PROMPT));
    const outputBlobId = await walrus.upload(new TextEncoder().encode(COMPLETION));
    walrus.corrupt(outputBlobId, new TextEncoder().encode("tampered output"));
    const modelHash = sha2_256Hex("model");
    const report = await auditJob(
      {
        jobId: "0x" + "11".repeat(32),
        inputHash: sha2_256Hex(PROMPT),
        outputHash: sha2_256Hex(COMPLETION),
        modelHash,
        measurement: "m",
        outputTokenCount: 5,
        tStart: 0,
        tEnd: 1,
        verdict: 0,
        inputBlobId,
        outputBlobId,
      },
      walrus,
      { expectModelHash: modelHash },
    );
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "output_hash")!.ok).toBe(false);
    expect(verifyOutput("tampered output", sha2_256Hex(COMPLETION))).toBe(false);
  });
});
