/**
 * The GIX OpenAI-compatible HTTP server (Node `http`, no framework).
 *
 *   POST /v1/chat/completions   (OpenAI shape) -> OpenAI shape, choices[0].message.content = output
 *   GET  /v1/models                            -> markets as models
 *   GET  /healthz                              -> { ok }
 *
 * Adds GIX provenance headers on the chat response:
 *   x-gix-job-id, x-gix-digest, x-gix-verified, x-gix-cost-usdc.
 *
 * The server depends only on a narrow `GixRunner` (the SDK's GixClient
 * satisfies it), so it is unit-testable without a chain.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { MarketInfo, RunTaskResult } from "@gix/sdk";
import {
  ChatRequestError,
  errorEnvelope,
  estimateTokens,
  gixHeaders,
  messagesToPrompt,
  parseChatRequest,
  shapeChatResponse,
  shapeModelsList,
} from "./openai.js";

/** The slice of GixClient the gateway needs (keeps the server SDK-agnostic). */
export interface GixRunner {
  markets(): MarketInfo[];
  runTask(args: { market: string; prompt: string; maxPriceUsdcPerScu: number }): Promise<RunTaskResult>;
}

export interface GatewayOptions {
  runner: GixRunner;
  /** Max MOCK_USDC base units per SCU the gateway will spend per request. Default 1_000_000 (=1 USDC). */
  maxPriceUsdcPerScu?: number;
  /** Logger; defaults to console. */
  logger?: (msg: string, meta?: Record<string, unknown>) => void;
}

const DEFAULT_MAX_PRICE = 1_000_000;

export function createGateway(opts: GatewayOptions): Server {
  const log = opts.logger ?? ((m, x) => console.log(`[gix-gateway] ${m}`, x ?? ""));
  const maxPrice = opts.maxPriceUsdcPerScu ?? DEFAULT_MAX_PRICE;

  return createServer((req, res) => {
    handle(req, res, opts.runner, maxPrice, log).catch((err) => {
      log("unhandled error", { error: (err as Error).message });
      if (!res.headersSent) sendJson(res, 500, errorEnvelope((err as Error).message, "internal_error"));
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  runner: GixRunner,
  maxPrice: number,
  log: (m: string, x?: Record<string, unknown>) => void,
): Promise<void> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  if (method === "GET" && (url === "/healthz" || url === "/health")) {
    return sendJson(res, 200, { ok: true });
  }

  if (method === "GET" && (url === "/v1/models" || url === "/models")) {
    const list = shapeModelsList(runner.markets().map((m) => ({ id: m.id, name: m.name })));
    return sendJson(res, 200, list);
  }

  if (method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
    return chatCompletions(req, res, runner, maxPrice, log);
  }

  return sendJson(res, 404, errorEnvelope(`no route for ${method} ${url}`, "not_found"));
}

async function chatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  runner: GixRunner,
  maxPrice: number,
  log: (m: string, x?: Record<string, unknown>) => void,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, errorEnvelope("invalid JSON body"));
  }

  let prompt: string;
  let model: string;
  let promptTokens: number;
  try {
    const reqBody = parseChatRequest(body);
    prompt = messagesToPrompt(reqBody.messages);
    promptTokens = estimateTokens(prompt);
    // The OpenAI `model` is the GIX market name. Default to the first market.
    const markets = runner.markets();
    model = (typeof reqBody.model === "string" && reqBody.model) || markets[0]?.name || "gix";
    // Validate the requested model resolves (by name or id).
    if (markets.length > 0 && !markets.some((m) => m.name === model || m.id === model)) {
      throw new ChatRequestError(
        `model "${model}" not found (available: ${markets.map((m) => m.name).join(", ")})`,
      );
    }
  } catch (e) {
    const status = e instanceof ChatRequestError ? e.status : 400;
    return sendJson(res, status, errorEnvelope((e as Error).message));
  }

  let result: RunTaskResult;
  try {
    log("runTask", { model, promptTokens });
    result = await runner.runTask({ market: model, prompt, maxPriceUsdcPerScu: maxPrice });
  } catch (e) {
    log("runTask failed", { error: (e as Error).message });
    // Upstream/chain failure → 502 (the on-chain purchase or GPU serve failed).
    return sendJson(res, 502, errorEnvelope((e as Error).message, "upstream_error"));
  }

  const payload = shapeChatResponse(result, { model, promptTokens });
  return sendJson(res, 200, payload, gixHeaders(result));
}

// --- HTTP helpers ----------------------------------------------------------

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 2_000_000) reject(new Error("body too large"));
      else chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim().length === 0) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
    ...extraHeaders,
  });
  res.end(data);
}
