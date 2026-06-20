import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha2_256Hex } from "../src/hash.js";
import type { Deployment, WalletSigner } from "../src/types.js";

/**
 * Mock the chain module so runTask is exercised end-to-end WITHOUT @mysten/sui
 * or a validator. The provider HTTP is mocked via an injected fetch.
 */
const createJobMock = vi.fn();
const awaitSettlementMock = vi.fn();

vi.mock("../src/chain.js", async () => {
  const actual = await vi.importActual<typeof import("../src/chain.js")>("../src/chain.js");
  return {
    ...actual,
    GixChain: class {
      createJob = createJobMock;
      awaitSettlement = awaitSettlementMock;
      usdcBalance = vi.fn().mockResolvedValue(1_000_000n);
      suiBalance = vi.fn().mockResolvedValue(5_000_000_000n);
    },
  };
});

// Import AFTER the mock is registered.
const { GixClient } = await import("../src/client.js");

const PKG = "0xPKG";
const deployment: Deployment = {
  network: "localnet",
  packageId: PKG,
  configId: "0xCFG",
  usdcType: `${PKG}::mock_usdc::MOCK_USDC`,
  clockId: "0x6",
  markets: [
    { id: "0xMARKET", name: "H100-llama3.1-8b-int8", creditType: `${PKG}::markets::M_H100_LLAMA8B` },
  ],
  accounts: { admin: "0xADMIN", providers: ["0xPROVIDER"], consumers: ["0xCONSUMER"] },
};

const signer: WalletSigner = {
  toSuiAddress: () => "0xCONSUMER",
  signTransaction: async () => ({ bytes: "AA==", signature: "SIG" }),
};

const PROMPT = "What is the capital of France?";
const OUTPUT = "The capital of France is Paris.";
const OUTPUT_HASH = sha2_256Hex(OUTPUT);
const INPUT_HASH = sha2_256Hex(PROMPT);

/** A fetch stub for the provider node: POST /inputs and GET /result/:jobId. */
function makeFetch(opts: { output?: string; outputHash?: string } = {}): typeof fetch {
  const output = opts.output ?? OUTPUT;
  const outputHash = opts.outputHash ?? OUTPUT_HASH;
  return (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/inputs") && init?.method === "POST") {
      return jsonResponse({ inputHash: INPUT_HASH });
    }
    if (u.includes("/result/")) {
      return jsonResponse({
        jobId: "0xJOB",
        model: "llama3.1:8b",
        output,
        outputHash,
        outputTokenCount: 7,
        tStart: 1000,
        tEnd: 1200,
        measurement: "MOCK-tdx-llama8b-v1",
        signature: "ed25519sig",
        attestPubkey: "abcdef00",
      });
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(() => {
  createJobMock.mockReset();
  awaitSettlementMock.mockReset();
  createJobMock.mockResolvedValue({ jobId: "0xJOB", digest: "0xDIGEST" });
});

describe("runTask flow", () => {
  it("verified=true when output re-hash matches on-chain output_hash", async () => {
    awaitSettlementMock.mockResolvedValue({
      state: "Settled",
      outputHashOnChain: OUTPUT_HASH,
      payoutUsdc: 5,
      verdict: 0,
    });
    const gix = new GixClient({ deployment, signer, providerUrl: "http://node:8080", fetchImpl: makeFetch() });
    const res = await gix.runTask({ market: "H100-llama3.1-8b-int8", prompt: PROMPT, maxPriceUsdcPerScu: 5 });

    expect(res.output).toBe(OUTPUT);
    expect(res.jobId).toBe("0xJOB");
    expect(res.digest).toBe("0xDIGEST");
    expect(res.verified).toBe(true);
    expect(res.payoutUsdc).toBe(5);
    expect(res.providerPubkey).toBe("abcdef00");

    // create_job funded escrow = maxPrice * qty(default 1), inputHash, provider.
    expect(createJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        escrowUsdc: 5n,
        scuQty: 1n,
        provider: "0xPROVIDER",
        inputHashHex: INPUT_HASH,
      }),
    );
  });

  it("verified=false when the on-chain hash does not match the served output", async () => {
    awaitSettlementMock.mockResolvedValue({
      state: "Settled",
      outputHashOnChain: sha2_256Hex("a DIFFERENT completion"),
      payoutUsdc: 5,
      verdict: 0,
    });
    const gix = new GixClient({ deployment, signer, providerUrl: "http://node:8080", fetchImpl: makeFetch() });
    const res = await gix.runTask({ market: "0xMARKET", prompt: PROMPT, maxPriceUsdcPerScu: 5 });
    expect(res.verified).toBe(false);
  });

  it("escrow scales with scuQty", async () => {
    awaitSettlementMock.mockResolvedValue({ state: "Settled", outputHashOnChain: OUTPUT_HASH });
    const gix = new GixClient({ deployment, signer, providerUrl: "http://node:8080", fetchImpl: makeFetch() });
    await gix.runTask({ market: "0xMARKET", prompt: PROMPT, maxPriceUsdcPerScu: 3, scuQty: 4 });
    expect(createJobMock).toHaveBeenCalledWith(expect.objectContaining({ escrowUsdc: 12n, scuQty: 4n }));
  });

  it("rejects an unknown market", async () => {
    const gix = new GixClient({ deployment, signer, providerUrl: "http://node:8080", fetchImpl: makeFetch() });
    await expect(
      gix.runTask({ market: "no-such-market", prompt: PROMPT, maxPriceUsdcPerScu: 5 }),
    ).rejects.toThrow(/unknown market/);
  });

  it("rejects a non-positive price", async () => {
    const gix = new GixClient({ deployment, signer, providerUrl: "http://node:8080", fetchImpl: makeFetch() });
    await expect(
      gix.runTask({ market: "0xMARKET", prompt: PROMPT, maxPriceUsdcPerScu: 0 }),
    ).rejects.toThrow(/maxPriceUsdcPerScu/);
  });

  it("markets() surfaces the deployment markets", () => {
    const gix = new GixClient({ deployment, signer, providerUrl: "http://node:8080", fetchImpl: makeFetch() });
    expect(gix.markets()).toEqual([
      expect.objectContaining({ id: "0xMARKET", name: "H100-llama3.1-8b-int8" }),
    ]);
  });

  it("balances() returns usdc + sui for the signer", async () => {
    const gix = new GixClient({ deployment, signer, providerUrl: "http://node:8080", fetchImpl: makeFetch() });
    const b = await gix.balances();
    expect(b.address).toBe("0xCONSUMER");
    expect(b.usdc).toBe(1_000_000n);
    expect(b.sui).toBe(5_000_000_000n);
  });
});
