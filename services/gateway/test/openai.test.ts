import { describe, expect, it } from "vitest";
import type { RunTaskResult } from "@gix/sdk";
import {
  ChatRequestError,
  estimateTokens,
  gixHeaders,
  messageText,
  messagesToPrompt,
  parseChatRequest,
  shapeChatResponse,
  shapeModelsList,
} from "../src/openai.js";

describe("messagesToPrompt — OpenAI messages → prompt", () => {
  it("labels turns and primes the assistant continuation", () => {
    const prompt = messagesToPrompt([
      { role: "system", content: "You are concise." },
      { role: "user", content: "What is 2+2?" },
    ]);
    expect(prompt).toBe("System: You are concise.\nUser: What is 2+2?\nAssistant:");
  });

  it("includes prior assistant turns for multi-turn context", () => {
    const prompt = messagesToPrompt([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
      { role: "user", content: "Tell me a joke" },
    ]);
    expect(prompt).toContain("User: Hi");
    expect(prompt).toContain("Assistant: Hello!");
    expect(prompt).toContain("User: Tell me a joke");
    expect(prompt.endsWith("Assistant:")).toBe(true);
  });

  it("flattens content-parts arrays", () => {
    expect(
      messageText([
        { type: "text", text: "part one" },
        { type: "text", text: "part two" },
      ]),
    ).toBe("part one\npart two");
  });

  it("throws on empty messages", () => {
    expect(() => messagesToPrompt([])).toThrow(ChatRequestError);
    expect(() => messagesToPrompt([{ role: "user", content: "" }])).toThrow(/no message content/);
  });
});

describe("parseChatRequest validation", () => {
  it("accepts a valid request", () => {
    const req = parseChatRequest({ model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(req.messages).toHaveLength(1);
  });
  it("rejects missing messages", () => {
    expect(() => parseChatRequest({ model: "m" })).toThrow(/messages/);
  });
  it("rejects streaming", () => {
    expect(() =>
      parseChatRequest({ messages: [{ role: "user", content: "hi" }], stream: true }),
    ).toThrow(/streaming/);
  });
  it("rejects non-object body", () => {
    expect(() => parseChatRequest("nope")).toThrow();
  });
});

const sampleResult: RunTaskResult = {
  output: "The capital of France is Paris.",
  jobId: "0xJOB",
  digest: "0xDIGEST",
  verified: true,
  payoutUsdc: 5,
  providerPubkey: "abcdef00",
};

describe("shapeChatResponse — SDK result → OpenAI response", () => {
  const resp = shapeChatResponse(sampleResult, {
    model: "H100-llama3.1-8b-int8",
    promptTokens: 12,
    completionTokens: 7,
    now: () => 1_700_000_000,
    idgen: () => "chatcmpl-test",
  });

  it("puts the output in choices[0].message.content", () => {
    expect(resp.choices[0].message.content).toBe("The capital of France is Paris.");
    expect(resp.choices[0].message.role).toBe("assistant");
    expect(resp.choices[0].finish_reason).toBe("stop");
  });

  it("is the OpenAI chat.completion object shape", () => {
    expect(resp.object).toBe("chat.completion");
    expect(resp.id).toBe("chatcmpl-test");
    expect(resp.created).toBe(1_700_000_000);
    expect(resp.model).toBe("H100-llama3.1-8b-int8");
  });

  it("reports usage with totals", () => {
    expect(resp.usage).toEqual({ prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 });
  });

  it("mirrors GIX provenance in x_gix", () => {
    expect(resp.x_gix).toEqual({
      job_id: "0xJOB",
      digest: "0xDIGEST",
      verified: true,
      cost_usdc: 5,
      provider_pubkey: "abcdef00",
    });
  });
});

describe("gixHeaders", () => {
  it("emits the four GIX headers", () => {
    expect(gixHeaders(sampleResult)).toEqual({
      "x-gix-job-id": "0xJOB",
      "x-gix-digest": "0xDIGEST",
      "x-gix-verified": "true",
      "x-gix-cost-usdc": "5",
    });
  });
  it("omits cost header when payout unknown", () => {
    const h = gixHeaders({ ...sampleResult, payoutUsdc: undefined });
    expect(h["x-gix-cost-usdc"]).toBeUndefined();
    expect(h["x-gix-verified"]).toBe("true");
  });
  it("reflects verified=false", () => {
    expect(gixHeaders({ ...sampleResult, verified: false })["x-gix-verified"]).toBe("false");
  });
});

describe("shapeModelsList", () => {
  it("lists markets as models keyed by NAME", () => {
    const list = shapeModelsList(
      [{ id: "0xMARKET", name: "H100-llama3.1-8b-int8" }],
      () => 1_700_000_000,
    );
    expect(list.object).toBe("list");
    expect(list.data[0]).toEqual({
      id: "H100-llama3.1-8b-int8",
      object: "model",
      created: 1_700_000_000,
      owned_by: "gix",
    });
  });
});

describe("estimateTokens", () => {
  it("is ~chars/4, min 1 for non-empty", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(40))).toBe(10);
  });
});
