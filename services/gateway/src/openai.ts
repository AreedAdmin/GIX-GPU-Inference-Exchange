/**
 * OpenAI-compatible request/response shaping (pure — unit-tested).
 *
 * Maps an OpenAI Chat Completions request to a single prompt for the SDK's
 * runTask, and shapes the SDK result back into the OpenAI response object. The
 * GIX-specific provenance (jobId, digest, verified, cost) rides as both response
 * headers (set by the server) and `x_gix` fields on the body (set here).
 */

import type { RunTaskResult } from "@gix/sdk";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool" | "function" | string;
  content: string | Array<{ type?: string; text?: string }> | null;
  name?: string;
}

export interface ChatCompletionRequest {
  model?: string;
  messages?: ChatMessage[];
  // Other OpenAI params are accepted and ignored in the demo (no streaming).
  [k: string]: unknown;
}

/** Flatten a message's content (string OR OpenAI content-parts) to text. */
export function messageText(content: ChatMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  // content-parts array (vision-style): concatenate the text parts.
  return content
    .map((p) => (typeof p === "string" ? p : (p?.text ?? "")))
    .filter((s) => s.length > 0)
    .join("\n");
}

/**
 * Map OpenAI `messages` → a single prompt string. We label each turn so the
 * model has the conversation context; the last user turn drives the completion.
 * (llama3.1 chat templates accept this plain transcript fine for the demo.)
 */
export function messagesToPrompt(messages: ChatMessage[] | undefined): string {
  if (!messages || messages.length === 0) {
    throw new ChatRequestError("`messages` must be a non-empty array");
  }
  const lines: string[] = [];
  let sawContent = false;
  for (const m of messages) {
    const text = messageText(m.content).trim();
    if (text.length === 0) continue;
    sawContent = true;
    const role = m.role ?? "user";
    const label = role === "system" ? "System" : role === "assistant" ? "Assistant" : role === "user" ? "User" : capitalize(role);
    lines.push(`${label}: ${text}`);
  }
  if (!sawContent) {
    throw new ChatRequestError("no message content to build a prompt from");
  }
  // Prime the model to continue as the assistant.
  lines.push("Assistant:");
  return lines.join("\n");
}

/** Validate + normalize an incoming chat-completions request. */
export function parseChatRequest(body: unknown): ChatCompletionRequest {
  if (typeof body !== "object" || body === null) {
    throw new ChatRequestError("request body must be a JSON object");
  }
  const req = body as ChatCompletionRequest;
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    throw new ChatRequestError("`messages` is required and must be a non-empty array");
  }
  if (req.stream === true) {
    throw new ChatRequestError("streaming is not supported in the GIX demo gateway");
  }
  return req;
}

export interface ShapeOptions {
  /** The model id echoed back (the OpenAI `model`, i.e. the GIX market name). */
  model: string;
  /** Rough prompt token estimate for the usage block. */
  promptTokens?: number;
  /** Completion token count (from the provider attestation). */
  completionTokens?: number;
  /** Clock for the `created` field (seconds). Injectable for tests. */
  now?: () => number;
  /** Id generator (injectable for tests). */
  idgen?: () => string;
}

export interface OpenAIChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string };
    finish_reason: "stop";
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  /** GIX provenance, mirrored from the response headers for body-only clients. */
  x_gix: {
    job_id: string;
    digest: string;
    verified: boolean;
    cost_usdc: number | null;
    provider_pubkey?: string;
  };
}

/** Shape an SDK runTask result into the OpenAI chat-completion response object. */
export function shapeChatResponse(result: RunTaskResult, opts: ShapeOptions): OpenAIChatResponse {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const idgen = opts.idgen ?? (() => `chatcmpl-gix-${Math.random().toString(36).slice(2, 12)}`);
  const promptTokens = opts.promptTokens ?? 0;
  const completionTokens = opts.completionTokens ?? estimateTokens(result.output);
  return {
    id: idgen(),
    object: "chat.completion",
    created: now(),
    model: opts.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: result.output },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
    x_gix: {
      job_id: result.jobId,
      digest: result.digest,
      verified: result.verified,
      cost_usdc: result.payoutUsdc ?? null,
      provider_pubkey: result.providerPubkey,
    },
  };
}

/** GIX response headers derived from a runTask result (§4). */
export function gixHeaders(result: RunTaskResult): Record<string, string> {
  const h: Record<string, string> = {
    "x-gix-job-id": result.jobId,
    "x-gix-digest": result.digest,
    "x-gix-verified": String(result.verified),
  };
  if (result.payoutUsdc != null) h["x-gix-cost-usdc"] = String(result.payoutUsdc);
  return h;
}

/** Shape the markets list as an OpenAI /v1/models list. */
export function shapeModelsList(
  markets: Array<{ id: string; name: string }>,
  now: () => number = () => Math.floor(Date.now() / 1000),
): { object: "list"; data: Array<{ id: string; object: "model"; created: number; owned_by: string }> } {
  const created = now();
  return {
    object: "list",
    data: markets.map((m) => ({
      // The OpenAI model id is the human market NAME (what a client passes back
      // as `model`); the market object id is not OpenAI-shaped.
      id: m.name,
      object: "model",
      created,
      owned_by: "gix",
    })),
  };
}

/** A roughly-OpenAI error envelope. */
export function errorEnvelope(message: string, type = "invalid_request_error", code?: string) {
  return { error: { message, type, param: null, code: code ?? null } };
}

export class ChatRequestError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ChatRequestError";
  }
}

// --- helpers ---------------------------------------------------------------

/** A cheap ~4-chars-per-token estimate (good enough for the demo usage block). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function capitalize(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}
