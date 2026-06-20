import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { MarketInfo, RunTaskResult } from "@gix/sdk";
import { createGateway, type GixRunner } from "../src/server.js";

/** A fake GixRunner — no chain, no provider HTTP. Records the last runTask args. */
class FakeRunner implements GixRunner {
  lastArgs?: { market: string; prompt: string; maxPriceUsdcPerScu: number };
  shouldThrow = false;
  result: RunTaskResult = {
    output: "The capital of France is Paris.",
    jobId: "0xJOB",
    digest: "0xDIGEST",
    verified: true,
    payoutUsdc: 5,
    providerPubkey: "abcdef00",
  };

  markets(): MarketInfo[] {
    return [{ id: "0xMARKET", name: "H100-llama3.1-8b-int8", creditType: "0xPKG::markets::M_H100_LLAMA8B" }];
  }
  async runTask(args: { market: string; prompt: string; maxPriceUsdcPerScu: number }): Promise<RunTaskResult> {
    this.lastArgs = args;
    if (this.shouldThrow) throw new Error("provider GPU unavailable");
    return this.result;
  }
}

let server: Server;
let base: string;
const runner = new FakeRunner();

beforeAll(async () => {
  server = createGateway({ runner, maxPriceUsdcPerScu: 7, logger: () => {} });
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("GET /v1/models", () => {
  it("returns markets as OpenAI models", async () => {
    const res = await fetch(`${base}/v1/models`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("list");
    expect(body.data[0].id).toBe("H100-llama3.1-8b-int8");
    expect(body.data[0].object).toBe("model");
  });
});

describe("POST /v1/chat/completions", () => {
  it("returns an OpenAI response with output + GIX headers", async () => {
    runner.shouldThrow = false;
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "H100-llama3.1-8b-int8",
        messages: [{ role: "user", content: "What is the capital of France?" }],
      }),
    });
    expect(res.status).toBe(200);

    // GIX provenance headers (§4).
    expect(res.headers.get("x-gix-job-id")).toBe("0xJOB");
    expect(res.headers.get("x-gix-digest")).toBe("0xDIGEST");
    expect(res.headers.get("x-gix-verified")).toBe("true");
    expect(res.headers.get("x-gix-cost-usdc")).toBe("5");

    const body = await res.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("The capital of France is Paris.");
    expect(body.x_gix.job_id).toBe("0xJOB");

    // The prompt was built from messages and the price came from the gateway.
    expect(runner.lastArgs?.prompt).toContain("User: What is the capital of France?");
    expect(runner.lastArgs?.prompt.endsWith("Assistant:")).toBe(true);
    expect(runner.lastArgs?.maxPriceUsdcPerScu).toBe(7);
    expect(runner.lastArgs?.market).toBe("H100-llama3.1-8b-int8");
  });

  it("defaults the model to the first market when omitted", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    expect(runner.lastArgs?.market).toBe("H100-llama3.1-8b-int8");
  });

  it("400s on a missing messages array", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "H100-llama3.1-8b-int8" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/messages/);
  });

  it("400s on an unknown model", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-9", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/not found/);
  });

  it("502s when the on-chain purchase / GPU serve fails", async () => {
    runner.shouldThrow = true;
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "H100-llama3.1-8b-int8",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.message).toMatch(/GPU unavailable/);
    runner.shouldThrow = false;
  });
});

describe("unknown routes", () => {
  it("404s", async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });
  it("healthz ok", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});
