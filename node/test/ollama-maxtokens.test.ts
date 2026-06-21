/**
 * Generation token cap → Ollama `num_predict`.
 *
 * Hermetic: stubs the global `fetch` so no real Ollama is needed, then drives
 * `OllamaClient.generate` and inspects the request body it POSTs to /api/generate.
 * Asserts:
 *   - when a positive cap is configured, `options.num_predict` carries that value;
 *   - the existing `.response` reading path is unchanged (and a separate `thinking`
 *     field, as qwen3.6 returns, is ignored — we still read `.response`);
 *   - when uncapped (<= 0), no `options` block is sent (back-compat with M1 body).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { OllamaClient } from "../src/ollama.js";

interface CapturedRequest {
  model: string;
  prompt: string;
  stream: boolean;
  options?: { num_predict?: number };
}

/** Install a fake `fetch` that records the /api/generate body and returns `body`. */
function stubGenerate(responseBody: Record<string, unknown>): { captured: () => CapturedRequest } {
  let last: CapturedRequest | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: { body?: string }) => {
      last = JSON.parse(init?.body ?? "{}") as CapturedRequest;
      return {
        ok: true,
        status: 200,
        json: async () => responseBody,
        text: async () => "",
      } as unknown as Response;
    }),
  );
  return {
    captured: () => {
      if (!last) throw new Error("fetch was not called");
      return last;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OllamaClient generation token cap", () => {
  it("sends options.num_predict when a positive maxTokens is configured", async () => {
    const s = stubGenerate({ response: "hi", eval_count: 2, prompt_eval_count: 3 });
    const client = new OllamaClient("http://127.0.0.1:11434", "qwen3.6", 1000);

    const res = await client.generate("hello");

    const body = s.captured();
    expect(body.options?.num_predict).toBe(1000);
    expect(body.model).toBe("qwen3.6");
    expect(body.stream).toBe(false);
    // The reasoning-model path is untouched: we still read `.response`.
    expect(res.completion).toBe("hi");
    expect(res.outputTokenCount).toBe(2);
  });

  it("still reads .response even when a reasoning model also returns a `thinking` field", async () => {
    stubGenerate({ response: "the answer", thinking: "let me think...", eval_count: 4 });
    const client = new OllamaClient("http://127.0.0.1:11434", "qwen3.6", 500);

    const res = await client.generate("q");

    expect(res.completion).toBe("the answer");
  });

  it("omits options entirely when maxTokens is 0 (uncapped)", async () => {
    const s = stubGenerate({ response: "x", eval_count: 1 });
    const client = new OllamaClient("http://127.0.0.1:11434", "llama3.1:8b", 0);

    await client.generate("hello");

    const body = s.captured();
    expect(body.options).toBeUndefined();
    expect("options" in body).toBe(false);
  });
});
