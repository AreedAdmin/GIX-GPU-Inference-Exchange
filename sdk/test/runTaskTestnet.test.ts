import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha2_256Hex } from "../src/hash.js";
import type { Deployment, WalletSigner } from "../src/types.js";

/**
 * Exercise the M2 testnet path of runTask end-to-end WITHOUT @mysten/sui,
 * DeepBook, Walrus, or a validator. The chain (createJobFromFill + reads) and
 * the WalrusHelper are mocked; we assert the buy-via-fill args and the
 * download-from-Walrus + verify flow.
 */
const createJobFromFillMock = vi.fn();
const awaitSettlementMock = vi.fn();
const jobOutputBlobIdMock = vi.fn();
const suiClientMock = vi.fn();

const uploadInputMock = vi.fn();
const downloadAndVerifyMock = vi.fn();

vi.mock("../src/chain.js", async () => {
  const actual = await vi.importActual<typeof import("../src/chain.js")>("../src/chain.js");
  return {
    ...actual,
    GixChain: class {
      createJobFromFill = createJobFromFillMock;
      awaitSettlement = awaitSettlementMock;
      jobOutputBlobId = jobOutputBlobIdMock;
      suiClient = suiClientMock;
      usdcBalance = vi.fn().mockResolvedValue(1_000_000n);
      suiBalance = vi.fn().mockResolvedValue(5_000_000_000n);
    },
  };
});

vi.mock("../src/walrus.js", async () => {
  const actual = await vi.importActual<typeof import("../src/walrus.js")>("../src/walrus.js");
  return {
    ...actual,
    WalrusHelper: class {
      uploadInput = uploadInputMock;
      downloadAndVerify = downloadAndVerifyMock;
    },
  };
});

const { GixClient } = await import("../src/client.js");

const PKG = "0xPKG";
const deployment: Deployment = {
  network: "testnet",
  packageId: PKG,
  configId: "0xCFG",
  usdcType: `${PKG}::mock_usdc::MOCK_USDC`,
  clockId: "0x6",
  markets: [
    {
      id: "0xMARKET",
      name: "H100-llama3.1-8b-int8",
      creditType: `${PKG}::markets::M_H100_LLAMA8B`,
      deepbookPoolId: "0xPOOL",
    },
  ],
  accounts: {
    admin: "0xADMIN",
    providers: ["0xPROVIDER"],
    consumers: ["0xCONSUMER"],
    providerRecords: ["0xPROVREC"],
  },
};

const signer: WalletSigner = {
  toSuiAddress: () => "0xCONSUMER",
  signTransaction: async () => ({ bytes: "AA==", signature: "SIG" }),
};
const walrusSigner = {} as unknown as import("@mysten/sui/cryptography").Signer;

const PROMPT = "What is the capital of France?";
const OUTPUT = "The capital of France is Paris.";
const OUTPUT_HASH = sha2_256Hex(OUTPUT);
const INPUT_HASH = sha2_256Hex(PROMPT);

beforeEach(() => {
  createJobFromFillMock.mockReset();
  awaitSettlementMock.mockReset();
  jobOutputBlobIdMock.mockReset();
  suiClientMock.mockReset();
  uploadInputMock.mockReset();
  downloadAndVerifyMock.mockReset();

  createJobFromFillMock.mockResolvedValue({ jobId: "0xJOB", digest: "0xDIGEST" });
  awaitSettlementMock.mockResolvedValue({
    state: "Settled",
    outputHashOnChain: OUTPUT_HASH,
    payoutUsdc: 0,
    verdict: 0,
  });
  jobOutputBlobIdMock.mockResolvedValue(98765n);
  suiClientMock.mockResolvedValue({});
  uploadInputMock.mockResolvedValue({
    blobId: "BLOB_in",
    blobIdU256: 1234n,
    inputHash: INPUT_HASH,
    blobObjectId: "0xBLOBOBJ",
  });
  downloadAndVerifyMock.mockResolvedValue({
    output: OUTPUT,
    bytes: new TextEncoder().encode(OUTPUT),
    verified: true,
  });
});

function newClient() {
  return new GixClient({
    deployment,
    signer,
    walrusSigner,
    providerUrl: "http://node:8080",
  });
}

describe("runTask — testnet DeepBook + Walrus path", () => {
  it("uploads to Walrus, buys via fill, downloads + verifies the output", async () => {
    const gix = newClient();
    const res = await gix.runTask({ market: "0xMARKET", prompt: PROMPT, maxPriceUsdcPerScu: 5 });

    expect(res.output).toBe(OUTPUT);
    expect(res.jobId).toBe("0xJOB");
    expect(res.digest).toBe("0xDIGEST");
    expect(res.verified).toBe(true);
    expect(res.inputBlobId).toBe("BLOB_in");
    expect(res.outputBlobId).toBe("98765");

    // The prompt was uploaded to Walrus (not POSTed to the node /inputs).
    expect(uploadInputMock).toHaveBeenCalledWith(PROMPT, walrusSigner);

    // create_job_from_fill got the pool, provider record, USDC (price*qty), the
    // Walrus input commitment, and the input_hash.
    expect(createJobFromFillMock).toHaveBeenCalledWith(
      expect.objectContaining({
        poolId: "0xPOOL",
        providerRecordId: "0xPROVREC",
        usdcIn: 5n,
        inputBlobId: 1234n,
        inputHashHex: INPUT_HASH,
      }),
    );

    // The output was downloaded from Walrus by the job's output_blob_id u256.
    expect(downloadAndVerifyMock).toHaveBeenCalledWith(98765n, OUTPUT_HASH);
  });

  it("usdcIn scales with scuQty; minBaseOut defaults to scuQty", async () => {
    const gix = newClient();
    await gix.runTask({ market: "0xMARKET", prompt: PROMPT, maxPriceUsdcPerScu: 3, scuQty: 4 });
    expect(createJobFromFillMock).toHaveBeenCalledWith(
      expect.objectContaining({ usdcIn: 12n, minBaseOut: 4n }),
    );
  });

  it("falls back to provider /result when no output blob is recorded", async () => {
    jobOutputBlobIdMock.mockResolvedValue(0n);
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("/result/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ jobId: "0xJOB", model: "m", output: OUTPUT, outputHash: OUTPUT_HASH, outputTokenCount: 7, tStart: 0, tEnd: 1, measurement: "", signature: "", attestPubkey: "" }),
          text: async () => "",
        } as unknown as Response;
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;
    const gix = new GixClient({ deployment, signer, walrusSigner, providerUrl: "http://node:8080", fetchImpl });
    const res = await gix.runTask({ market: "0xMARKET", prompt: PROMPT, maxPriceUsdcPerScu: 5 });
    expect(res.verified).toBe(true);
    expect(res.output).toBe(OUTPUT);
    expect(downloadAndVerifyMock).not.toHaveBeenCalled();
  });

  it("requires a walrusSigner on testnet", async () => {
    const gix = new GixClient({ deployment, signer, providerUrl: "http://node:8080" });
    await expect(
      gix.runTask({ market: "0xMARKET", prompt: PROMPT, maxPriceUsdcPerScu: 5 }),
    ).rejects.toThrow(/walrusSigner/);
  });

  it("requires a DeepBook pool id", async () => {
    const noPool: Deployment = {
      ...deployment,
      markets: [{ ...deployment.markets[0]!, deepbookPoolId: null }],
    };
    const gix = new GixClient({ deployment: noPool, signer, walrusSigner, providerUrl: "http://node:8080" });
    await expect(
      gix.runTask({ market: "0xMARKET", prompt: PROMPT, maxPriceUsdcPerScu: 5 }),
    ).rejects.toThrow(/DeepBook pool id/);
  });

  it("requires a provider ProviderRecord id", async () => {
    const noRec: Deployment = {
      ...deployment,
      accounts: { ...deployment.accounts!, providerRecords: [] },
    };
    const gix = new GixClient({ deployment: noRec, signer, walrusSigner, providerUrl: "http://node:8080" });
    await expect(
      gix.runTask({ market: "0xMARKET", prompt: PROMPT, maxPriceUsdcPerScu: 5 }),
    ).rejects.toThrow(/ProviderRecord/);
  });
});
