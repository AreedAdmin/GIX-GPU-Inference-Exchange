/* Manual smoke (not part of vitest): boots the HTTP server + a real serveJob against
   Ollama, with chain disabled. Run: npx tsx test/http-serve.smoke.ts */
import { OllamaClient } from "../src/ollama.js";
import { NodeStore } from "../src/store.js";
import { createHttpServer } from "../src/http.js";
import { attestSignerFromSeed } from "../src/attest/signer.js";
import { serveJob } from "../src/serve.js";
import { sha2_256Hex } from "../src/attest/canonical.js";

const model = process.env.GIX_MODEL ?? "llama3.1:8b";
const ollama = new OllamaClient(process.env.GIX_OLLAMA_URL ?? "http://127.0.0.1:11434", model);
const store = new NodeStore();
const attest = attestSignerFromSeed(new Uint8Array(32).fill(9));
const attestPubkeyHex = "0x" + Buffer.from(attest.publicKey).toString("hex");
const PORT = 18080;

const server = createHttpServer({ store, model, gpu: "GB10", ollamaOk: () => true });
server.listen(PORT, "127.0.0.1", async () => {
  const log = (m: string) => console.log(m);
  const prompt = "Reply with exactly the word: pong";

  // 1. POST /inputs
  const inRes = await fetch(`http://127.0.0.1:${PORT}/inputs`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  const { inputHash } = await inRes.json() as { inputHash: string };
  console.log("POST /inputs ->", inputHash, "(expected 0x" + sha2_256Hex(prompt) + ")");

  // 2. simulate a Dispatched event for a fake job id and serve it
  const jobId = "0x" + "22".repeat(32);
  const result = await serveJob(
    { jobId, provider: "0xprov", modelId: "0xmodel", inputHash, execDeadline: 0 },
    { ollama, attest, attestPubkeyHex, chain: null, store, model, measurement: "MOCK-tdx-llama8b-v1", log },
  );
  console.log("serveJob done, submitDigest:", result?.submitDigest ?? "(chain disabled)");

  // 3. GET /result/:jobId and verify the output re-hashes to the on-chain output_hash
  const rRes = await fetch(`http://127.0.0.1:${PORT}/result/${jobId}`);
  const r = await rRes.json() as any;
  const reHash = "0x" + sha2_256Hex(r.output);
  console.log("GET /result/:jobId =>");
  console.log("  output           :", JSON.stringify(r.output));
  console.log("  outputHash       :", r.outputHash);
  console.log("  re-hash matches  :", reHash === r.outputHash ? "YES ✓" : "NO ✗");
  console.log("  outputTokenCount :", r.outputTokenCount);
  console.log("  signature        :", r.signature.slice(0, 26) + "...");
  console.log("  attestPubkey     :", r.attestPubkey);

  // 4. GET /health
  const h = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
  console.log("GET /health =>", JSON.stringify(h));
  server.close();
  process.exit(0);
});
