/**
 * Unit tests for the F7 audit verifier + the fixtures' determinism contract.
 *
 * Hermetic: no chain, no real Walrus. Uses the in-memory Walrus and the deterministic mock node
 * so the same prompt → same completion → same hashes → same signature every run. These assert:
 *   - the golden hashes are the exact sha2_256 of the fixtures (so the mock-node contract holds);
 *   - a clean served job audits GREEN across all four F7 checks;
 *   - each tamper (corrupt output, forged signature, wrong model_hash, Walrus read-fail) flips
 *     exactly the right check to RED and the overall audit to FAIL.
 */

import { describe, it, expect } from "vitest";
import { auditJob } from "../audit.js";
import { InMemoryWalrus } from "../walrus.js";
import { MockNode } from "../mock-node.js";
import { GOLDEN_PROMPTS, GOLDEN_HASHES, sha2, mockComplete } from "../fixtures/index.js";

const JOB_ID = "0x" + "11".repeat(32);

async function setup(prompt: string) {
  const node = new MockNode();
  const walrus = new InMemoryWalrus();
  const served = node.serve({ jobId: JOB_ID, prompt, nowMs: 1_700_000_000_000 });
  const inputBlobId = await walrus.upload(new TextEncoder().encode(prompt));
  const outputBlobId = await walrus.upload(new TextEncoder().encode(served.completion));
  const modelHash = sha2("model-bytes"); // a stand-in registered hash for the unit test
  const view = {
    jobId: JOB_ID,
    inputHash: served.inputHash,
    outputHash: served.outputHash,
    modelHash,
    measurement: served.measurement,
    outputTokenCount: served.outputTokenCount,
    tStart: served.tStart,
    tEnd: served.tEnd,
    verdict: 0,
    signature: served.signature,
    attestPubkey: node.attestPubkey,
    inputBlobId,
    outputBlobId,
  };
  return { node, walrus, served, view, modelHash, inputBlobId, outputBlobId };
}

describe("fixtures determinism contract", () => {
  it("golden input/output hashes are the exact sha2_256 of the fixtures", () => {
    for (const key of ["P1", "P2", "P3"] as const) {
      const g = GOLDEN_PROMPTS[key];
      expect(g.inputHash).toBe(GOLDEN_HASHES[key].inputHash);
      expect(g.outputHash).toBe(GOLDEN_HASHES[key].outputHash);
      // The mock-node completion is a pure function of the prompt.
      expect(g.completion).toBe(mockComplete(g.prompt));
      expect(sha2(g.prompt)).toBe(g.inputHash);
      expect(sha2(g.completion)).toBe(g.outputHash);
    }
  });

  it("the mock node serves the golden output hash for a golden prompt", () => {
    const node = new MockNode();
    const served = node.serve({ jobId: JOB_ID, prompt: GOLDEN_PROMPTS.P1.prompt, nowMs: 1_700_000_000_000 });
    expect(served.outputHash).toBe(GOLDEN_HASHES.P1.outputHash);
  });
});

describe("F7 audit verifier", () => {
  it("a clean served job passes all four checks", async () => {
    const { walrus, view, modelHash } = await setup(GOLDEN_PROMPTS.P1.prompt);
    const report = await auditJob(view, walrus, { expectModelHash: modelHash });
    expect(report.ok).toBe(true);
    for (const c of report.checks) expect(c.ok, `${c.name}: ${c.detail}`).toBe(true);
  });

  it("corrupt output bytes → output_hash check FAILS, overall FAILS", async () => {
    const { walrus, view, modelHash, outputBlobId } = await setup(GOLDEN_PROMPTS.P2.prompt);
    walrus.corrupt(outputBlobId, new TextEncoder().encode("tampered"));
    const report = await auditJob(view, walrus, { expectModelHash: modelHash });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "output_hash")!.ok).toBe(false);
    // The other legs still pass — only the output integrity flipped.
    expect(report.checks.find((c) => c.name === "input_hash")!.ok).toBe(true);
    expect(report.checks.find((c) => c.name === "signature")!.ok).toBe(true);
  });

  it("forged signature → signature check FAILS, overall FAILS", async () => {
    const { walrus, view, modelHash } = await setup(GOLDEN_PROMPTS.P1.prompt);
    const bad = Uint8Array.from(view.signature!);
    bad[0] ^= 0xff;
    const report = await auditJob({ ...view, signature: bad }, walrus, { expectModelHash: modelHash });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "signature")!.ok).toBe(false);
  });

  it("wrong registered model_hash → model_hash check FAILS", async () => {
    const { walrus, view } = await setup(GOLDEN_PROMPTS.P3.prompt);
    const report = await auditJob(view, walrus, { expectModelHash: sha2("a-different-model") });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "model_hash")!.ok).toBe(false);
  });

  it("Walrus read-fail → output_hash check FAILS (no false trust)", async () => {
    const { walrus, view, modelHash, outputBlobId } = await setup(GOLDEN_PROMPTS.P1.prompt);
    walrus.failReads(outputBlobId);
    const report = await auditJob(view, walrus, { expectModelHash: modelHash });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "output_hash")!.ok).toBe(false);
  });

  it("blob id 0n falls back to provided bytes (localnet mock-path)", async () => {
    const { view, modelHash } = await setup(GOLDEN_PROMPTS.P1.prompt);
    const walrus = new InMemoryWalrus(); // empty store
    const report = await auditJob(
      { ...view, inputBlobId: 0n, outputBlobId: 0n },
      walrus,
      {
        expectModelHash: modelHash,
        inputBytes: new TextEncoder().encode(GOLDEN_PROMPTS.P1.prompt),
        outputBytes: new TextEncoder().encode(mockComplete(GOLDEN_PROMPTS.P1.prompt)),
      },
    );
    expect(report.ok).toBe(true);
  });
});
