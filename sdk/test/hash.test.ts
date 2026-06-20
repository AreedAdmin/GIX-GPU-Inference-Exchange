import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  hexEquals,
  hexToBytes,
  normalizeHex,
  sha2_256Bytes,
  sha2_256Hex,
} from "../src/hash.js";
import { verifyOutput } from "../src/client.js";

describe("sha2_256 (matches Move sui::hash::sha2_256)", () => {
  it("hashes UTF-8 with SHA-256, hex output", () => {
    const out = "Hello, GPU world.";
    const expected = createHash("sha256").update(Buffer.from(out, "utf8")).digest("hex");
    expect(sha2_256Hex(out)).toBe(expected);
  });

  it("known vector: sha2_256('') ", () => {
    // Empty string SHA-256 is a well-known constant.
    expect(sha2_256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("bytes form equals hex form", () => {
    const s = "deterministic";
    expect(hexToBytes(sha2_256Hex(s))).toEqual(sha2_256Bytes(s));
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
    expect(normalizeHex("AbCd")).toBe("abcd");
  });
});

describe("verifyOutput (the verifiable-result check)", () => {
  const output = "The capital of France is Paris.";
  const matching = sha2_256Hex(output);

  it("verified=true when re-hash matches on-chain output_hash", () => {
    expect(verifyOutput(output, matching)).toBe(true);
    expect(verifyOutput(output, "0x" + matching)).toBe(true);
  });

  it("verified=false on a tampered output", () => {
    expect(verifyOutput(output + " (tampered)", matching)).toBe(false);
  });

  it("verified=false on a mismatching hash", () => {
    const wrong = sha2_256Hex("some other completion");
    expect(verifyOutput(output, wrong)).toBe(false);
  });
});
