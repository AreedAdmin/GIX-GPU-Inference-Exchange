import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  hexEquals,
  hexToBytes,
  normalizeHex,
  sha2_256Bytes,
  sha2_256Hex,
  verifyOutput,
} from "../src/hash.js";

/**
 * The verifiable-result check (demo-milestone-contract §2/§3.1): both hashes are
 * sha2_256 over UTF-8 — byte-identical to Move's native sui::hash::sha2_256.
 */
describe("sha2_256 (matches Move sui::hash::sha2_256)", () => {
  it("hashes UTF-8 with SHA-256, hex output", () => {
    const out = "Hello, GPU world.";
    const expected = createHash("sha256").update(Buffer.from(out, "utf8")).digest("hex");
    expect(sha2_256Hex(out)).toBe(expected);
  });

  it("known vector: sha2_256('')", () => {
    expect(sha2_256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("contracts/README.md vector: sha2_256('hello gix')", () => {
    expect(sha2_256Hex("hello gix")).toBe(
      "920a337685c06a488ac99d78c3a063c6c374468266113d7c5870770d116ef9dc",
    );
  });

  it("contracts/README.md vector: sha2_256('hello from llama')", () => {
    expect(sha2_256Hex("hello from llama")).toBe(
      "4e189c771ae26adff09cb7b5449fab04d2673d86632cd44467858fb977e9bb8e",
    );
  });

  it("bytes form equals hex form", () => {
    expect(hexToBytes(sha2_256Hex("deterministic"))).toEqual(sha2_256Bytes("deterministic"));
  });
});

describe("hexEquals / normalizeHex", () => {
  it("tolerates 0x prefix and case, exact on bytes", () => {
    expect(hexEquals("0xABCD", "abcd")).toBe(true);
    expect(hexEquals("ABCD", "0xabcd")).toBe(true);
    expect(hexEquals("abce", "abcd")).toBe(false);
  });
  it("rejects empty / malformed", () => {
    expect(hexEquals("", "abcd")).toBe(false);
    expect(hexEquals("abcd", "")).toBe(false);
  });
  it("normalizeHex strips prefix and lowercases", () => {
    expect(normalizeHex("0xAbCd")).toBe("abcd");
  });
});

describe("verifyOutput (re-hash output vs on-chain output_hash)", () => {
  const output = "The capital of France is Paris.";
  const onChain = sha2_256Hex(output);

  it("verified=true when re-hash matches (with or without 0x)", () => {
    expect(verifyOutput(output, onChain)).toBe(true);
    expect(verifyOutput(output, "0x" + onChain.toUpperCase())).toBe(true);
  });

  it("verified=false on a tampered output", () => {
    expect(verifyOutput(output + " (tampered)", onChain)).toBe(false);
  });

  it("verified=false on a malformed on-chain hash", () => {
    expect(verifyOutput(output, "")).toBe(false);
  });
});
