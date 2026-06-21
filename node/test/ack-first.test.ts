/**
 * Deadline-bug fix: ack FIRST, then run inference.
 *
 * The job's `ack_deadline` is a FIXED ~30 s window from job creation (DEFAULT_ACK_MS),
 * while `exec_deadline` (≈180 s) and `attest_deadline` (≈210 s) are generous. The old
 * flow ran inference FIRST and acked together with the attestation PTB — so a slow answer
 * (a real qwen run took ~75 s) landed the ack at ~75 s > 30 s ⇒ MoveAbort 500
 * (EAttestDeadline) in job::ack, and settlement failed.
 *
 * The fix: serveJob calls `chain.ackJob(jobId)` in its own tx BEFORE `ollama.generate`.
 * The ack lands within ~5–10 s (inside the 30 s window); inference then uses the full
 * 180 s exec window; the ack still inside the attest PTB is a harmless no-op (EXECUTING).
 *
 * These tests assert (a) the call ORDER (ack strictly before generate), and (b) that a
 * failing ack is tolerated — serveJob proceeds to inference and still attests/settles.
 *
 * Hermetic: fake chain + fake Ollama, no RPC / Walrus.
 */

import { describe, it, expect, vi } from "vitest";
import { serveJob, type ServeDeps } from "../src/serve.js";
import { sha2_256Hex } from "../src/attest/canonical.js";

const PROMPT = "Write a long essay about distributed GPU markets.";
const COMPLETION = "A long essay would go here.";

function jobFor(prompt: string, idByte: string) {
  return {
    jobId: "0x" + idByte.repeat(32),
    provider: "0xprov",
    modelId: "0xmodel",
    inputHash: "0x" + sha2_256Hex(prompt),
    execDeadline: 0,
  };
}

function fakeAttest() {
  return {
    publicKey: new Uint8Array(32),
    secretKey: new Uint8Array(32),
    sign: () => new Uint8Array(64),
  };
}

function makeStore() {
  return {
    prompts: new Map<string, string>([[sha2_256Hex(PROMPT), PROMPT]]),
    getPrompt(h: string) {
      return this.prompts.get((h.startsWith("0x") ? h.slice(2) : h).toLowerCase());
    },
    putPrompt(h: string, p: string) {
      this.prompts.set((h.startsWith("0x") ? h.slice(2) : h).toLowerCase(), p);
    },
    putResult: vi.fn(),
  };
}

describe("serveJob — ack first (deadline-bug fix)", () => {
  it("calls chain.ackJob BEFORE ollama.generate", async () => {
    const calls: string[] = [];
    const job = jobFor(PROMPT, "a1");

    const ollama = {
      generate: vi.fn(async () => {
        calls.push("generate");
        return {
          completion: COMPLETION,
          outputTokenCount: 5,
          promptTokenCount: 8,
          tStart: 1_700_000_000_000,
          tEnd: 1_700_000_075_000, // ~75 s — the slow-answer case the bug bit on
        };
      }),
    };
    const chain = {
      ackJob: vi.fn(async () => {
        calls.push("ack");
      }),
      getJobMeta: vi.fn(async () => ({ isFill: false, inputBlobId: 0n, input: new Uint8Array(0) })),
      submitSignedAttestation: vi.fn(async () => ({ digest: "0xsubmit", verdict: 0 })),
      settleJob: vi.fn(async () => ({ digest: "0xsettle", fn: "settle" })),
    };
    const deps = {
      ollama,
      attest: fakeAttest(),
      attestPubkeyHex: "0x" + "00".repeat(32),
      chain,
      store: makeStore(),
      model: "qwen",
      measurement: "MOCK-tdx-qwen-v1",
      walrus: null,
      log: () => {},
    } as unknown as ServeDeps;

    const result = await serveJob(job, deps);

    expect(result?.output).toBe(COMPLETION);
    expect(chain.ackJob).toHaveBeenCalledWith(job.jobId);
    // The fix is fundamentally an ORDERING guarantee: ack must precede inference.
    expect(calls).toEqual(["ack", "generate"]);
    // And the standalone ack runs exactly once (the attest-PTB's own ack is a no-op).
    expect(chain.ackJob).toHaveBeenCalledTimes(1);
  });

  it("tolerates a failing ackJob — proceeds to inference and still attests/settles", async () => {
    const job = jobFor(PROMPT, "b2");
    const ollama = {
      generate: vi.fn(async () => ({
        completion: COMPLETION,
        outputTokenCount: 5,
        promptTokenCount: 8,
        tStart: 1_700_000_000_000,
        tEnd: 1_700_000_000_200,
      })),
    };
    const chain = {
      // ackJob itself swallows benign aborts; but even if it rejected, serveJob's
      // try/catch must keep serving. Simulate the harsher reject case here.
      ackJob: vi.fn(async () => {
        throw new Error("EAttestDeadline(500): simulated");
      }),
      getJobMeta: vi.fn(async () => ({ isFill: false, inputBlobId: 0n, input: new Uint8Array(0) })),
      submitSignedAttestation: vi.fn(async () => ({ digest: "0xsubmit", verdict: 0 })),
      settleJob: vi.fn(async () => ({ digest: "0xsettle", fn: "settle" })),
    };
    const deps = {
      ollama,
      attest: fakeAttest(),
      attestPubkeyHex: "0x" + "00".repeat(32),
      chain,
      store: makeStore(),
      model: "qwen",
      measurement: "MOCK-tdx-qwen-v1",
      walrus: null,
      log: () => {},
    } as unknown as ServeDeps;

    const result = await serveJob(job, deps);

    expect(result?.output).toBe(COMPLETION);
    expect(ollama.generate).toHaveBeenCalledTimes(1);
    expect(chain.submitSignedAttestation).toHaveBeenCalledTimes(1);
    expect(chain.settleJob).toHaveBeenCalledTimes(1);
  });
});
