/**
 * Node HTTP server (§3.1 of docs/demo-milestone-contract.md).
 *
 *   POST /inputs        { prompt }   -> { inputHash }   // cache prompt by sha2_256
 *   GET  /result/:jobId              -> { jobId, model, output, outputHash,
 *                                         outputTokenCount, tStart, tEnd, measurement,
 *                                         signature, attestPubkey }
 *   GET  /health                     -> { ok, model, gpu }
 *
 * Plain `node:http` (no framework dep). The consumer POSTs the prompt before
 * creating the job (the on-chain input_hash is sha2_256 of that prompt); the node
 * caches it so the serve loop can run inference when the Dispatched event arrives.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { sha2_256Hex } from "./attest/canonical.js";
import type { NodeStore } from "./store.js";

export interface HttpDeps {
  store: NodeStore;
  model: string;
  gpu: string;
  ollamaOk: () => boolean;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

export function createHttpServer(deps: HttpDeps): Server {
  return createServer((req, res) => {
    void handle(req, res, deps).catch((e) => {
      send(res, 500, { error: (e as Error).message });
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: HttpDeps): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  // GET /health
  if (method === "GET" && path === "/health") {
    send(res, 200, { ok: deps.ollamaOk(), model: deps.model, gpu: deps.gpu });
    return;
  }

  // POST /inputs { prompt } -> { inputHash }
  if (method === "POST" && path === "/inputs") {
    const body = (await readJson(req)) as { prompt?: unknown };
    if (typeof body.prompt !== "string" || body.prompt.length === 0) {
      send(res, 400, { error: "body must be { prompt: <non-empty string> }" });
      return;
    }
    const inputHash = sha2_256Hex(body.prompt);
    deps.store.putPrompt(inputHash, body.prompt);
    // Return 0x-prefixed to match the on-chain vector<u8> hex convention consumers use.
    send(res, 200, { inputHash: "0x" + inputHash });
    return;
  }

  // GET /result/:jobId
  if (method === "GET" && path.startsWith("/result/")) {
    const jobId = decodeURIComponent(path.slice("/result/".length));
    const r = deps.store.getResult(jobId);
    if (!r) {
      send(res, 404, { error: `no result for job ${jobId} (not served yet?)` });
      return;
    }
    send(res, 200, {
      jobId: r.jobId,
      model: r.model,
      output: r.output,
      outputHash: "0x" + r.outputHash,
      outputTokenCount: r.outputTokenCount,
      tStart: r.tStart,
      tEnd: r.tEnd,
      measurement: r.measurement,
      signature: r.signature,
      attestPubkey: r.attestPubkey,
      // M2: Walrus blob ids (base64url) when uploaded; omitted on localnet / Walrus-disabled.
      ...(r.outputBlobId ? { outputBlobId: r.outputBlobId } : {}),
      ...(r.quoteBlobId ? { quoteBlobId: r.quoteBlobId } : {}),
    });
    return;
  }

  send(res, 404, { error: `no route ${method} ${path}` });
}
