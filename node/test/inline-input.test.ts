/**
 * Option 3 — inline on-chain input (tunnel-free path) unit tests.
 *
 * Covers serveJob's resolvePrompt priority order (docs/option3-inline-input-interface.md §B):
 *   1. job.input (non-empty) → UTF-8 decode + sha2_256 == input_hash check; NO Walrus read,
 *      NO /inputs cache. Wins over inputBlobId.
 *   2. else inputBlobId != 0 → Walrus.
 *   3. else → /inputs cache.
 * Plus the defense-in-depth hash check: a tampered inline input (bytes whose sha2_256 != the
 * on-chain input_hash) must be refused — the node never attests / settles.
 *
 * Hermetic: fake chain + fake Walrus + fake Ollama, no RPC / WAL.
 */

import { describe, it, expect, vi } from "vitest";
import { serveJob, type ServeDeps } from "../src/serve.js";
import { sha2_256Hex } from "../src/attest/canonical.js";

const PROMPT = "Summarize the GIX inline-input tunnel-free path.";
const COMPLETION = "Inline input rides in the create_job_from_ask tx; output via Walrus.";

function fakeOllama() {
  return {
    generate: vi.fn(async () => ({
      completion: COMPLETION,
      outputTokenCount: 9,
      promptTokenCount: 6,
      tStart: 1_700_000_000_000,
      tEnd: 1_700_000_000_321,
    })),
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
    prompts: new Map<string, string>(),
    getPrompt(h: string) {
      return this.prompts.get((h.startsWith("0x") ? h.slice(2) : h).toLowerCase());
    },
    putPrompt(h: string, p: string) {
      this.prompts.set((h.startsWith("0x") ? h.slice(2) : h).toLowerCase(), p);
    },
    putResult: vi.fn(),
  };
}

function jobFor(prompt: string, idByte: string) {
  return {
    jobId: "0x" + idByte.repeat(32),
    provider: "0xprov",
    modelId: "0xmodel",
    inputHash: "0x" + sha2_256Hex(prompt),
    execDeadline: 0,
  };
}

describe("serveJob — Option 3 inline on-chain input", () => {
  it("priority 1: uses inline job.input, verifies its hash, and never touches Walrus or /inputs", async () => {
    const input = new TextEncoder().encode(PROMPT);
    const job = jobFor(PROMPT, "a1");

    // Inline input present; ALSO advertise a Walrus blob id + a different cached prompt to prove
    // neither is consulted when inline input is present.
    const chain = {
      ackJob: vi.fn(async () => {}),
      getJobMeta: vi.fn(async () => ({ isFill: false, inputBlobId: 999n, input })),
      submitSignedAttestation: vi.fn(async () => ({ digest: "0xsubmit", verdict: 0 })),
      settleJob: vi.fn(async () => ({ digest: "0xsettle", fn: "settle" })),
    };
    const walrus = {
      readByInt: vi.fn(async () => new TextEncoder().encode("WALRUS SHOULD NOT BE READ")),
      uploadUtf8: vi.fn(async (_s: string, attrs?: Record<string, string>) => ({
        blobId: attrs?.gix === "quote" ? "Q" : "O",
        blobIdInt: attrs?.gix === "quote" ? 2n : 1n,
        objectId: "0xobj",
      })),
    };
    const store = makeStore();
    // Poison the /inputs cache to prove it is not used.
    store.prompts.set(sha2_256Hex(PROMPT), "POISONED CACHE PROMPT");

    const deps = {
      ollama: fakeOllama(),
      attest: fakeAttest(),
      attestPubkeyHex: "0x" + "00".repeat(32),
      chain,
      store,
      model: "llama3.1:8b",
      measurement: "MOCK-tdx-llama8b-v1",
      walrus,
      log: () => {},
    } as unknown as ServeDeps;

    const result = await serveJob(job, deps);

    // Served from inline input.
    expect(result?.output).toBe(COMPLETION);
    // Ollama was called with the inline-decoded prompt (NOT the poisoned cache value).
    expect(deps.ollama.generate).toHaveBeenCalledWith(PROMPT);
    // Walrus was NEVER read for the input despite inputBlobId=999.
    expect(walrus.readByInt).not.toHaveBeenCalled();
    expect(result?.inputHash).toBe(sha2_256Hex(PROMPT));
  });

  it("refuses a tampered inline input (sha2_256(input) != input_hash) — never attests/settles", async () => {
    // input_hash commits the REAL prompt, but the inline bytes are different.
    const job = jobFor(PROMPT, "b2");
    const tampered = new TextEncoder().encode("a totally different prompt");

    let submitCount = 0;
    let settleCount = 0;
    const chain = {
      ackJob: vi.fn(async () => {}),
      getJobMeta: vi.fn(async () => ({ isFill: false, inputBlobId: 0n, input: tampered })),
      submitSignedAttestation: vi.fn(async () => {
        submitCount++;
        return { digest: "0xsubmit", verdict: 0 };
      }),
      settleJob: vi.fn(async () => {
        settleCount++;
        return { digest: "0xsettle", fn: "settle" };
      }),
    };
    const deps = {
      ollama: fakeOllama(),
      attest: fakeAttest(),
      attestPubkeyHex: "0x" + "00".repeat(32),
      chain,
      store: makeStore(),
      model: "llama3.1:8b",
      measurement: "MOCK-tdx-llama8b-v1",
      walrus: null,
      log: () => {},
    } as unknown as ServeDeps;

    const result = await serveJob(job, deps);
    expect(result).toBeNull();
    expect(deps.ollama.generate).not.toHaveBeenCalled();
    expect(submitCount).toBe(0);
    expect(settleCount).toBe(0);
  });

  it("priority 2: empty inline input + inputBlobId != 0 → reads from Walrus", async () => {
    const job = jobFor(PROMPT, "c3");
    const chain = {
      ackJob: vi.fn(async () => {}),
      getJobMeta: vi.fn(async () => ({
        isFill: false,
        inputBlobId: 555n,
        input: new Uint8Array(0), // empty ⇒ inline path skipped
      })),
      submitSignedAttestation: vi.fn(async () => ({ digest: "0xsubmit", verdict: 0 })),
      settleJob: vi.fn(async () => ({ digest: "0xsettle", fn: "settle" })),
    };
    const walrus = {
      readByInt: vi.fn(async () => new TextEncoder().encode(PROMPT)),
      uploadUtf8: vi.fn(async (_s: string, attrs?: Record<string, string>) => ({
        blobId: attrs?.gix === "quote" ? "Q" : "O",
        blobIdInt: attrs?.gix === "quote" ? 2n : 1n,
        objectId: "0xobj",
      })),
    };
    const deps = {
      ollama: fakeOllama(),
      attest: fakeAttest(),
      attestPubkeyHex: "0x" + "00".repeat(32),
      chain,
      store: makeStore(),
      model: "llama3.1:8b",
      measurement: "MOCK-tdx-llama8b-v1",
      walrus,
      log: () => {},
    } as unknown as ServeDeps;

    const result = await serveJob(job, deps);
    expect(walrus.readByInt).toHaveBeenCalledWith(555n);
    expect(result?.output).toBe(COMPLETION);
  });

  it("priority 3: empty inline input + inputBlobId 0 → /inputs cache fallback", async () => {
    const job = jobFor(PROMPT, "d4");
    const chain = {
      ackJob: vi.fn(async () => {}),
      getJobMeta: vi.fn(async () => ({ isFill: false, inputBlobId: 0n, input: new Uint8Array(0) })),
      submitSignedAttestation: vi.fn(async () => ({ digest: "0xsubmit", verdict: 0 })),
      settleJob: vi.fn(async () => ({ digest: "0xsettle", fn: "settle" })),
    };
    const store = makeStore();
    store.prompts.set(sha2_256Hex(PROMPT), PROMPT); // the cached prompt
    const deps = {
      ollama: fakeOllama(),
      attest: fakeAttest(),
      attestPubkeyHex: "0x" + "00".repeat(32),
      chain,
      store,
      model: "llama3.1:8b",
      measurement: "MOCK-tdx-llama8b-v1",
      walrus: null,
      log: () => {},
    } as unknown as ServeDeps;

    const result = await serveJob(job, deps);
    expect(deps.ollama.generate).toHaveBeenCalledWith(PROMPT);
    expect(result?.output).toBe(COMPLETION);
  });
});
