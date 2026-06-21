/**
 * Hermetic unit tests for the inline (Option 3) tunnel-free machinery in the mock node:
 *   - `resolveInlinePrompt` reads the prompt from the on-chain `input` bytes and verifies
 *     sha2_256(input) == input_hash, WITHOUT touching the HTTP `/inputs` tripwire;
 *   - a hash mismatch aborts (a tampered tx can never be silently served);
 *   - the `HttpCacheTripwire` flips + records when any `/inputs` or `/result` endpoint is consulted,
 *     which is exactly what the live `inline` scenario asserts stays untouched.
 *
 * These pin the no-HTTP guarantee deterministically so the scenario's assertion can't silently rot.
 */

import { describe, it, expect } from "vitest";
import { MockNode, HttpCacheTripwire } from "../mock-node.js";
import { GOLDEN_PROMPTS } from "../fixtures/index.js";

const JOB_ID = "0x" + "22".repeat(32);

describe("inline tunnel-free (Option 3) mock-node path", () => {
  it("resolveInlinePrompt reads from on-chain input and never touches the HTTP cache", () => {
    const node = new MockNode();
    const g = GOLDEN_PROMPTS.P1;
    const input = new TextEncoder().encode(g.prompt);
    const prompt = node.resolveInlinePrompt({ jobId: JOB_ID, input, inputHashHex: g.inputHash });
    expect(prompt).toBe(g.prompt);
    // The tunnel-free guarantee: no /inputs or /result access occurred.
    expect(node.httpCache.consulted).toBe(false);
    expect(node.httpCache.assertUntouched().ok).toBe(true);
  });

  it("resolveInlinePrompt aborts when sha2_256(input) != input_hash (tampered tx)", () => {
    const node = new MockNode();
    const g = GOLDEN_PROMPTS.P2;
    const tampered = new TextEncoder().encode(g.prompt + " <TAMPERED>");
    expect(() => node.resolveInlinePrompt({ jobId: JOB_ID, input: tampered, inputHashHex: g.inputHash })).toThrow(/sha2_256/);
    // Still no HTTP fallback on the mismatch — it aborts, it does not silently read /inputs.
    expect(node.httpCache.consulted).toBe(false);
  });

  it("empty inline input falls back to the HTTP tripwire, which records the access (no-HTTP guard)", () => {
    const node = new MockNode();
    expect(() => node.resolveInlinePrompt({ jobId: JOB_ID, input: new Uint8Array(), inputHashHex: GOLDEN_PROMPTS.P1.inputHash })).toThrow(/inputs/i);
    expect(node.httpCache.consulted).toBe(true);
    const tw = node.httpCache.assertUntouched();
    expect(tw.ok).toBe(false);
    expect(tw.detail).toContain("/inputs");
  });

  it("HttpCacheTripwire records every endpoint access for the failure detail", () => {
    const tw = new HttpCacheTripwire();
    expect(tw.consulted).toBe(false);
    expect(() => tw.getResult(JOB_ID)).toThrow(/result/);
    expect(tw.consulted).toBe(true);
    expect(tw.assertUntouched().ok).toBe(false);
    expect(tw.accesses[0]).toContain("/result");
  });
});
