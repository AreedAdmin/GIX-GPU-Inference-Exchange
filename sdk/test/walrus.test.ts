import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha2_256Hex, sha2_256HexBytes } from "../src/hash.js";

/**
 * Mock @mysten/walrus so the Walrus helpers are exercised WITHOUT the WASM,
 * storage nodes, WAL, or a signer. We assert:
 *   - verifyBlob: sha2_256(bytes) == on-chain output_hash (the verify primitive)
 *   - blobId <-> u256 round-trip via the mocked blobIdToInt/blobIdFromInt
 *   - WalrusHelper.uploadInput / downloadAndVerify wire the client correctly.
 */
const writeBlobMock = vi.fn();
const readBlobMock = vi.fn();

vi.mock("@mysten/walrus", () => ({
  WalrusClient: class {
    writeBlob = writeBlobMock;
    readBlob = readBlobMock;
  },
  // A deterministic, reversible toy codec for the tests.
  blobIdToInt: (blobId: string) => BigInt("0x" + Buffer.from(blobId, "utf8").toString("hex")),
  blobIdFromInt: (n: bigint) => {
    let hex = n.toString(16);
    if (hex.length % 2) hex = "0" + hex;
    return Buffer.from(hex, "hex").toString("utf8");
  },
}));

const { WalrusHelper, verifyBlob, blobIdToU256, u256ToBlobId } = await import("../src/walrus.js");

const PROMPT = "What is the capital of France?";
const OUTPUT = "The capital of France is Paris.";
const OUTPUT_HASH = sha2_256Hex(OUTPUT);

function fakeSuiClient() {
  return {} as unknown as import("@mysten/sui/jsonRpc").SuiJsonRpcClient;
}
function fakeSigner() {
  return {} as unknown as import("@mysten/sui/cryptography").Signer;
}

beforeEach(() => {
  writeBlobMock.mockReset();
  readBlobMock.mockReset();
});

describe("verifyBlob (the verifiable-result check over bytes)", () => {
  it("true when sha2_256(bytes) matches the on-chain output_hash", () => {
    const bytes = new TextEncoder().encode(OUTPUT);
    expect(verifyBlob(bytes, OUTPUT_HASH)).toBe(true);
    expect(verifyBlob(bytes, "0x" + OUTPUT_HASH)).toBe(true);
  });
  it("false on tampered bytes", () => {
    const bytes = new TextEncoder().encode(OUTPUT + " (tampered)");
    expect(verifyBlob(bytes, OUTPUT_HASH)).toBe(false);
  });
  it("sha2_256HexBytes(utf8 bytes) == sha2_256Hex(string)", () => {
    expect(sha2_256HexBytes(new TextEncoder().encode(OUTPUT))).toBe(OUTPUT_HASH);
  });
});

describe("blobId <-> u256 round-trip", () => {
  it("u256ToBlobId(blobIdToU256(id)) === id", async () => {
    const id = "BLOB_abc123";
    const n = await blobIdToU256(id);
    expect(typeof n).toBe("bigint");
    expect(await u256ToBlobId(n)).toBe(id);
  });
});

describe("WalrusHelper", () => {
  it("uploadInput writes the prompt bytes and returns blobId + input_hash", async () => {
    writeBlobMock.mockResolvedValue({ blobId: "BLOB_in", blobObject: { id: "0xBLOBOBJ" } });
    const helper = new WalrusHelper({ network: "testnet", suiClient: fakeSuiClient() });
    const res = await helper.uploadInput(PROMPT, fakeSigner());

    expect(res.blobId).toBe("BLOB_in");
    expect(res.blobObjectId).toBe("0xBLOBOBJ");
    expect(res.inputHash).toBe(sha2_256Hex(PROMPT));
    expect(res.blobIdU256).toBe(await blobIdToU256("BLOB_in"));

    // It uploaded the UTF-8 prompt bytes, non-deletable, with a positive epoch.
    const call = writeBlobMock.mock.calls[0][0];
    expect(new TextDecoder().decode(call.blob)).toBe(PROMPT);
    expect(call.deletable).toBe(false);
    expect(call.epochs).toBeGreaterThan(0);
  });

  it("downloadAndVerify reads by blob id and verifies against the on-chain hash", async () => {
    readBlobMock.mockResolvedValue(new TextEncoder().encode(OUTPUT));
    const helper = new WalrusHelper({ network: "testnet", suiClient: fakeSuiClient() });
    const out = await helper.downloadAndVerify("BLOB_out", OUTPUT_HASH);

    expect(out.output).toBe(OUTPUT);
    expect(out.verified).toBe(true);
    expect(readBlobMock).toHaveBeenCalledWith({ blobId: "BLOB_out" });
  });

  it("downloadAndVerify accepts a u256 blob id (resolves it to the base64 form)", async () => {
    readBlobMock.mockResolvedValue(new TextEncoder().encode(OUTPUT));
    const helper = new WalrusHelper({ network: "testnet", suiClient: fakeSuiClient() });
    const u256 = await blobIdToU256("BLOB_out");
    const out = await helper.downloadAndVerify(u256, OUTPUT_HASH);

    expect(out.verified).toBe(true);
    expect(readBlobMock).toHaveBeenCalledWith({ blobId: "BLOB_out" });
  });

  it("verified=false when the downloaded bytes do not match the on-chain hash", async () => {
    readBlobMock.mockResolvedValue(new TextEncoder().encode("a DIFFERENT completion"));
    const helper = new WalrusHelper({ network: "testnet", suiClient: fakeSuiClient() });
    const out = await helper.downloadAndVerify("BLOB_out", OUTPUT_HASH);
    expect(out.verified).toBe(false);
  });
});
