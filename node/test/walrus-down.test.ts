/**
 * F4 L3 — Walrus-unavailable must not cause a false settle / bad binding.
 *
 * Two failure modes, both hermetic (fake chain + fake Walrus):
 *   (a) The job committed a Walrus INPUT blob, but the Walrus READ fails and the prompt is not
 *       cached. The serve loop must NOT fabricate a prompt — it returns null and never attests.
 *   (b) The job committed a Walrus input blob whose bytes hash to the WRONG value (a tampered
 *       blob). The serve loop must refuse (the blob id is a commitment, the sha2_256 is the
 *       integrity primitive) — no attestation, no settle.
 *
 * Either way: the provider is never paid for work whose input could not be authenticated.
 */

import { describe, it, expect, vi } from "vitest";
import { serveJob, type ServeDeps } from "../src/serve.js";
import { sha2_256Hex } from "../src/attest/canonical.js";

const PROMPT = "Name the capital of France.";

function fakeOllama() {
  return {
    generate: vi.fn(async () => ({
      completion: "[gix-mock] echo: Name the capital of France.",
      outputTokenCount: 6,
      promptTokenCount: 4,
      tStart: 1_700_000_000_000,
      tEnd: 1_700_000_000_200,
    })),
  };
}
function fakeAttest() {
  return { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32).fill(7), sign: () => new Uint8Array(64).fill(9) };
}
function fakeChain(inputBlobId: bigint) {
  return {
    submitCount: 0,
    settleCount: 0,
    getJobMeta: vi.fn(async () => ({ isFill: false, inputBlobId })),
    submitSignedAttestation: vi.fn(async function (this: ReturnType<typeof fakeChain>) {
      this.submitCount++;
      return { digest: "0xsubmit", verdict: 0 };
    }),
    settleJob: vi.fn(async function (this: ReturnType<typeof fakeChain>) {
      this.settleCount++;
      return { digest: "0xsettle", fn: "settle" };
    }),
  };
}
function emptyStore() {
  const prompts = new Map<string, string>();
  return {
    getPrompt(h: string) {
      return prompts.get((h.startsWith("0x") ? h.slice(2) : h).toLowerCase());
    },
    putPrompt(h: string, p: string) {
      prompts.set((h.startsWith("0x") ? h.slice(2) : h).toLowerCase(), p);
    },
    putResult: vi.fn(),
  };
}

describe("Walrus-down — no false settle", () => {
  it("(a) Walrus read throws + no cache ⇒ serve returns null, never attests", async () => {
    const inputBlobId = 777n;
    const chain = fakeChain(inputBlobId);
    chain.submitSignedAttestation = chain.submitSignedAttestation.bind(chain);
    chain.settleJob = chain.settleJob.bind(chain);
    const walrus = {
      readByInt: vi.fn(async () => {
        throw new Error("walrus: storage nodes unreachable");
      }),
      uploadUtf8: vi.fn(),
    };
    const job = {
      jobId: "0x" + "33".repeat(32),
      provider: "0xprov",
      modelId: "0xmodel",
      inputHash: "0x" + sha2_256Hex(PROMPT),
      execDeadline: 0,
    };
    const deps = {
      ollama: fakeOllama(),
      attest: fakeAttest(),
      attestPubkeyHex: "0x" + "00".repeat(32),
      chain,
      store: emptyStore(),
      model: "mock",
      measurement: "MOCK-tdx-llama8b-v1",
      walrus,
      log: () => {},
    } as unknown as ServeDeps;

    const r = await serveJob(job, deps);
    expect(r).toBeNull();
    expect(walrus.readByInt).toHaveBeenCalledWith(inputBlobId);
    expect(chain.submitCount).toBe(0);
    expect(chain.settleCount).toBe(0);
  });

  it("(b) tampered Walrus input blob (hash mismatch) ⇒ serve refuses, never attests", async () => {
    const inputBlobId = 888n;
    const chain = fakeChain(inputBlobId);
    chain.submitSignedAttestation = chain.submitSignedAttestation.bind(chain);
    chain.settleJob = chain.settleJob.bind(chain);
    const walrus = {
      // Returns bytes that do NOT hash to the on-chain input_hash.
      readByInt: vi.fn(async () => new TextEncoder().encode("a different prompt entirely")),
      uploadUtf8: vi.fn(),
    };
    const job = {
      jobId: "0x" + "44".repeat(32),
      provider: "0xprov",
      modelId: "0xmodel",
      inputHash: "0x" + sha2_256Hex(PROMPT), // commits the REAL prompt's hash
      execDeadline: 0,
    };
    const deps = {
      ollama: fakeOllama(),
      attest: fakeAttest(),
      attestPubkeyHex: "0x" + "00".repeat(32),
      chain,
      store: emptyStore(),
      model: "mock",
      measurement: "MOCK-tdx-llama8b-v1",
      walrus,
      log: () => {},
    } as unknown as ServeDeps;

    const r = await serveJob(job, deps);
    expect(r).toBeNull();
    expect(chain.submitCount).toBe(0);
    expect(chain.settleCount).toBe(0);
  });
});
