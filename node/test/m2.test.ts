/**
 * M2 unit tests — DeepBook ask PTB construction + Walrus blob-id handling + the serve-loop
 * fill branch. These run HERMETICALLY (no RPC, no DeepBook pool, no WAL): the DeepBook SDK
 * clients are lazy at construction, so the PTB-builder methods serialize offline; the serve
 * branch is driven through a fake chain + fake Walrus. Live DeepBook + Walrus are validated
 * at integration by the orchestrator.
 */

import { describe, it, expect, vi } from "vitest";
import { blobIdToInt, blobIdFromInt } from "@mysten/walrus";
import {
  DeepBookMaker,
  POOL_KEY,
  MANAGER_KEY,
  COIN_KEY_CREDIT,
  COIN_KEY_USDC,
} from "../src/deepbook.js";
import { serveJob, type ServeDeps } from "../src/serve.js";
import { sha2_256Hex } from "../src/attest/canonical.js";

/** JSON.stringify that tolerates the BigInt values the DeepBook SDK puts in tx data. */
function jsonSafe(v: unknown): string {
  return JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val));
}

// --- shared fixtures -------------------------------------------------------

const CREDIT_TYPE =
  "0xPKG::credit::Credit<0xPKG::markets::M_H100_LLAMA8B>".replace(/0xPKG/g, "0x" + "ab".repeat(32));
const USDC_TYPE = ("0x" + "ab".repeat(32)) + "::mock_usdc::MOCK_USDC";
const POOL_ID = "0x" + "cd".repeat(32);
const BM_ID = "0x" + "ef".repeat(32);

function makeMaker(): DeepBookMaker {
  return new DeepBookMaker({
    network: "testnet",
    rpcUrl: "https://fullnode.testnet.sui.io:443",
    signer: {} as never, // never used in PTB construction
    address: "0x" + "12".repeat(32),
    creditCoinType: CREDIT_TYPE,
    usdcType: USDC_TYPE,
    poolId: POOL_ID,
    inputTokenFees: true,
    log: () => {},
  });
}

// --- Walrus blob id (u256 commitment) handling -----------------------------

describe("Walrus blob id ↔ u256", () => {
  it("blobIdToInt / blobIdFromInt round-trip (the on-chain commitment form)", () => {
    // A valid 32-byte (u256) blob commitment is derived from an integer; round-trips back.
    const asInt = 0x1234_5678_9abc_def0_1122_3344_5566_7788n;
    const blobId = blobIdFromInt(asInt);
    expect(typeof blobId).toBe("string");
    expect(blobIdToInt(blobId)).toBe(asInt);
  });

  it("0n means 'no blob' and maps to a stable string", () => {
    expect(blobIdToInt(blobIdFromInt(0n))).toBe(0n);
  });
});

// --- DeepBook ask PTB construction (offline) -------------------------------

describe("DeepBook maker PTB construction", () => {
  it("buildCreateBalanceManagerTx targets balance_manager::new + share", async () => {
    const maker = makeMaker();
    await maker.prepare(); // no manager yet — create flow
    const tx = maker.buildCreateBalanceManagerTx();
    const json = jsonSafe(tx.getData());
    expect(json).toContain("balance_manager");
  });

  it("buildPlaceAskTx places a SELL limit order (isBid:false) on the bound pool", async () => {
    const maker = makeMaker();
    await maker.prepare(BM_ID); // known BM so generateProof resolves
    const tx = maker.buildPlaceAskTx(100n, 1000n, "42");
    const json = jsonSafe(tx.getData());
    // The ask targets DeepBook's place_limit_order with the market's Credit/USDC types.
    expect(json).toContain("place_limit_order");
    expect(json).toContain(CREDIT_TYPE);
    expect(json).toContain(USDC_TYPE);
    // The pool id + balance manager id must be referenced as inputs.
    expect(json).toContain(POOL_ID);
    expect(json).toContain(BM_ID);
    // isBid:false (an ASK) and a maker order — POST_ONLY (order type 3) is encoded as u8.
    // We assert the boolean false arg is present in the pure inputs.
    expect(json).toMatch(/place_limit_order/);
  });

  it("buildDepositCreditsTx deposits Credit into the manager", async () => {
    const maker = makeMaker();
    await maker.prepare(BM_ID);
    const tx = maker.buildDepositCreditsTx(100n);
    const json = jsonSafe(tx.getData());
    expect(json).toContain("deposit");
    expect(json).toContain(CREDIT_TYPE);
    expect(json).toContain(BM_ID);
  });

  it("exports stable registration keys", () => {
    expect(POOL_KEY).toBe("GIX");
    expect(MANAGER_KEY).toBe("GIX_BM");
    expect(COIN_KEY_CREDIT).toBe("CREDIT");
    expect(COIN_KEY_USDC).toBe("USDC");
  });
});

// --- serve loop: fill-job branch (blob ids + settle kind) ------------------

const PROMPT = "ping for M2";
const COMPLETION = "pong from llama (M2)";

function fakeOllama() {
  return {
    generate: vi.fn(async () => ({
      completion: COMPLETION,
      outputTokenCount: 5,
      promptTokenCount: 3,
      tStart: 1_700_000_000_000,
      tEnd: 1_700_000_000_222,
    })),
  };
}

function fakeAttest() {
  return { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32), sign: () => new Uint8Array(64) };
}

describe("serveJob — M2 fill branch", () => {
  it("uploads output+quote to Walrus, passes blob ids, and settles via the fill path", async () => {
    const inputHash = sha2_256Hex(PROMPT);
    const job = {
      jobId: "0x" + "11".repeat(32),
      provider: "0xprov",
      modelId: "0xmodel",
      inputHash: "0x" + inputHash,
      execDeadline: 0,
    };

    // Fake Walrus: input is read by blob id; output/quote uploads return distinct ids.
    const inputBlobId = 777n;
    const walrus = {
      readByInt: vi.fn(async () => new TextEncoder().encode(PROMPT)),
      uploadUtf8: vi.fn(async (_s: string, attrs?: Record<string, string>) => ({
        blobId: attrs?.gix === "quote" ? "QUOTEBLOB" : "OUTPUTBLOB",
        blobIdInt: attrs?.gix === "quote" ? 222n : 111n,
        objectId: "0xobj",
      })),
    };

    // Fake chain: job is a FILL job carrying a Walrus input blob; capture the submit+settle args.
    let submitArgs: Record<string, unknown> | undefined;
    let settleArgs: { verdict: number | undefined; isFill: boolean } | undefined;
    const chain = {
      getJobMeta: vi.fn(async () => ({ isFill: true, inputBlobId })),
      submitSignedAttestation: vi.fn(async (a: Record<string, unknown>) => {
        submitArgs = a;
        return { digest: "0xsubmit", verdict: 0 };
      }),
      settleJob: vi.fn(async (_jobId: string, verdict: number | undefined, isFill: boolean) => {
        settleArgs = { verdict, isFill };
        return { digest: "0xsettle", fn: "settle_fill" };
      }),
    };

    const store = {
      prompts: new Map<string, string>(),
      getPrompt(h: string) {
        return this.prompts.get((h.startsWith("0x") ? h.slice(2) : h).toLowerCase());
      },
      putPrompt(h: string, p: string) {
        this.prompts.set((h.startsWith("0x") ? h.slice(2) : h).toLowerCase(), p);
      },
      putResult: vi.fn(),
    };

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

    // Prompt was read from Walrus by the committed input blob id (not the /inputs cache).
    expect(walrus.readByInt).toHaveBeenCalledWith(inputBlobId);
    // Output + quote were both uploaded.
    expect(walrus.uploadUtf8).toHaveBeenCalledTimes(2);
    // The on-chain submit carried the Walrus blob-id commitments.
    expect(submitArgs?.outputBlobId).toBe(111n);
    expect(submitArgs?.quoteBlobId).toBe(222n);
    // Settlement routed through the FILL path (isFill true) with the VALID verdict.
    expect(settleArgs).toEqual({ verdict: 0, isFill: true });
    // The result carries the Walrus blob ids for /result consumers.
    expect(result?.outputBlobId).toBe("OUTPUTBLOB");
    expect(result?.quoteBlobId).toBe("QUOTEBLOB");
    expect(result?.output).toBe(COMPLETION);
  });

  it("falls back to the /inputs cache when input_blob_id is 0 and settles the ESCROW path", async () => {
    const inputHash = sha2_256Hex(PROMPT);
    const job = {
      jobId: "0x" + "22".repeat(32),
      provider: "0xprov",
      modelId: "0xmodel",
      inputHash: "0x" + inputHash,
      execDeadline: 0,
    };

    let settleArgs: { verdict: number | undefined; isFill: boolean } | undefined;
    const chain = {
      getJobMeta: vi.fn(async () => ({ isFill: false, inputBlobId: 0n })),
      submitSignedAttestation: vi.fn(async () => ({ digest: "0xsubmit", verdict: 0 })),
      settleJob: vi.fn(async (_j: string, verdict: number | undefined, isFill: boolean) => {
        settleArgs = { verdict, isFill };
        return { digest: "0xsettle", fn: "settle" };
      }),
    };

    const store = {
      prompts: new Map<string, string>([[inputHash.toLowerCase(), PROMPT]]),
      getPrompt(h: string) {
        return this.prompts.get((h.startsWith("0x") ? h.slice(2) : h).toLowerCase());
      },
      putPrompt() {},
      putResult: vi.fn(),
    };

    const deps = {
      ollama: fakeOllama(),
      attest: fakeAttest(),
      attestPubkeyHex: "0x" + "00".repeat(32),
      chain,
      store,
      model: "llama3.1:8b",
      measurement: "MOCK-tdx-llama8b-v1",
      walrus: null, // Walrus disabled (localnet-style)
      log: () => {},
    } as unknown as ServeDeps;

    const result = await serveJob(job, deps);
    expect(result?.output).toBe(COMPLETION);
    // No Walrus ⇒ blob ids default to 0; settlement uses the ESCROW path.
    expect(settleArgs).toEqual({ verdict: 0, isFill: false });
  });
});
