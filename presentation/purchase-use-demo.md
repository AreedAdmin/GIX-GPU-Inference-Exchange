# Demo — Purchasing &amp; Using Compute on GIX

Three ways to show how anyone interacts with GIX: **click it** (web console), **code it**
(SDK), and **drop it in** (OpenAI-compatible gateway). Each ends in a **verifiable** result
you can prove on-chain. Pick the path that fits the audience; together they tell the whole
story — *a neutral, verifiable spot market for compute that AI apps can build on for cheaper
inference.*

> **Prereqs (one-time bring-up):** a running **provider node** (serves the model + signs
> attestations), a funded **wallet**, and a deployment (`deployment.json` localnet — proven
> end-to-end — or `deployment.testnet.json`). Full bring-up: [`../DEMO.md`](../DEMO.md).
> SuiScan links assume testnet; on localnet there's no explorer (use the in-app digests).

---

## Way 1 — Web console (the visual walkthrough)

**Audience:** anyone. **Shows:** buy → history → on-chain proof (SuiScan) → use the SCUs → verified output.

1. **Connect wallet.** Top-right dropdown shows your real address + SUI / USDC balances.
2. **Buy compute.** In the **Order Ticket**, pick the market (e.g. `H100-llama3.1-8b-int8`),
   set size (e.g. **1 SCU**), and **Buy**. This is a real on-chain purchase — USDC into escrow,
   credits reserved.
   - *Say:* "That's one inference's worth of compute, bought at the live spot price — pay-per-use, no committed GPU."
3. **Show history.** Open the **Positions** panel → **My Jobs** / **History**. The job you just
   created appears, scoped to *your* wallet (no random fills). Watch it move
   `Created → Dispatched → Attested → Settled`.
4. **Show SuiScan (the on-chain proof).** Click the tx digest (Activity bar / Result viewer) or:
   - Transaction: `https://suiscan.xyz/testnet/tx/<DIGEST>`
   - Job object: `https://suiscan.xyz/testnet/object/<JOB_ID>`
   - *Say:* "Settlement happened on Sui, not on our server — here's the escrow release and the attestation record, publicly."
5. **Use the SCUs for inference.** Run the job (or use **buy + run**) with a prompt; the provider
   serves it and the **Result Viewer** shows the output with a **✓ verified** badge.
6. **Prove it (optional).** Open the **Audit drawer** → it re-fetches the artifacts and
   re-checks `sha2_256(output) == on-chain output_hash` from **Sui + Walrus alone**.
   - *Say:* "Anyone can independently verify the exact model ran on the exact input — no trust in us."

---

## Way 2 — SDK (build it into your app)

**Audience:** developers. **Shows:** a few lines of TypeScript turn into an on-chain compute
purchase + a verifiable result — i.e. how others build **AI-native apps on GIX for cheaper compute**.

```ts
// demo.ts  —  npx tsx demo.ts
import { GixClient, fromSuiPrivateKey } from "@gix/sdk";
import deployment from "../deployment.json" assert { type: "json" };

const gix = new GixClient({
  deployment,
  signer: await fromSuiPrivateKey(process.env.GIX_SUI_PRIVKEY!),
  providerUrl: process.env.GIX_PROVIDER_URL ?? "http://localhost:8080",
});

const res = await gix.runTask({
  market: "H100-llama3.1-8b-int8",   // market name or id
  prompt: "Write a haiku about verifiable compute.",
  maxPriceUsdcPerScu: 5,             // your price cap (USDC base units, 6dp)
});

console.log("output   :", res.output);     // the model's completion
console.log("verified :", res.verified);   // true → re-hash matched the on-chain output_hash
console.log("jobId    :", res.jobId);      // settled Job object on Sui
console.log("digest   :", res.digest);     // create_job tx → SuiScan
console.log("paid     :", res.payoutUsdc, "USDC");
```

Run it:

```bash
cd sdk && npm install && npm run build
GIX_SUI_PRIVKEY=suiprivkey1... GIX_PROVIDER_URL=http://localhost:8080 npx tsx demo.ts
```

**Expected output (illustrative):**

```
output   : Proof in the chain / weights hum on a far GPU / truth you can recompute
verified : true
jobId    : 0x9c1f…ab30
digest   : 0x4d2e…77f1
paid     : 5 USDC
```

- *Say:* "Under those ~10 lines: it bought compute on-chain, a GPU ran the model, and the
  result is cryptographically verifiable. That `digest` is on SuiScan; `verified: true` means
  the bytes match what was attested." → open `https://suiscan.xyz/testnet/tx/<digest>`.

Helper calls for a richer demo:

```ts
await gix.markets();    // available markets (also what the gateway exposes as "models")
await gix.balances();   // { address, usdc, sui } for the signer
```

---

## Way 3 — OpenAI-compatible gateway (zero-rewrite drop-in)

**Audience:** any AI builder already using OpenAI. **Shows:** point an existing app at GIX and
it *just works* — same API, but each call is **settled on-chain and verifiable**, on cheaper
decentralized GPUs. This is the strongest "build on top of GIX" moment.

Start the gateway:

```bash
cd services/gateway && npm install
GIX_SUI_PRIVKEY=suiprivkey1... GIX_PROVIDER_URL=http://localhost:8080 \
GIX_DEPLOYMENT=../../deployment.json GIX_GATEWAY_PORT=8088 npm start
```

**A) curl (shows the on-chain provenance headers):**

```bash
curl -s http://localhost:8088/v1/chat/completions -i \
  -H 'content-type: application/json' \
  -d '{ "model": "H100-llama3.1-8b-int8",
        "messages": [ { "role": "user", "content": "What is the capital of France?" } ] }'
```

```
HTTP/1.1 200 OK
x-gix-job-id: 0x…          ← the settled Job (open on SuiScan)
x-gix-digest: 0x…          ← the on-chain purchase tx
x-gix-verified: true       ← output re-hash matched the attested hash
x-gix-cost-usdc: 5
...
{ "choices": [ { "message": { "role": "assistant", "content": "The capital of France is Paris." } } ],
  "x_gix": { "job_id": "0x…", "digest": "0x…", "verified": true, "cost_usdc": 5 } }
```

**B) the official OpenAI SDK — only the `baseURL` changes:**

```ts
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "http://localhost:8088/v1", apiKey: "gix-demo" });

const r = await client.chat.completions.create({
  model: "H100-llama3.1-8b-int8",
  messages: [{ role: "user", content: "Give me 3 uses for verifiable inference." }],
});
console.log(r.choices[0].message.content);
// every response carries x-gix-* provenance headers → on-chain job + verified flag
```

- *Say:* "No SDK migration, no new client — they change one URL and their app now runs on a
  neutral, verifiable compute market. That's how the ecosystem builds on GIX for cheaper
  inference." → `curl -s http://localhost:8088/v1/models` lists the markets as models.

---

## The through-line (what each "way" proves)

| Way | Who it's for | What it proves |
| --- | --- | --- |
| **1 · Web console** | anyone | buying compute is a real, visible on-chain action; output is verifiable in-app |
| **2 · SDK** | developers | a handful of lines = on-chain purchase + verifiable result; build it into a product |
| **3 · OpenAI gateway** | existing AI apps | drop-in; switch one URL to run on GIX — cheaper, neutral, **provable** compute |

**Close:** "Buy it by clicking, by code, or by pointing your existing OpenAI app at us — and in
every case you can *prove* on Sui that the right model ran on your input. That's the moat:
verifiable, neutral, pay-per-use compute anyone can build on."

> **Demo honesty:** today the live matching is the **Ask order book / mock book** (the
> DeepBook pool is gated on testnet DEEP) and attestation is a **registered-key signature
> verified on-chain** (real hardware-TEE attestation is **M3**). The purchase, settlement,
> and hash-verification shown above are real; present the DeepBook pool and hardware TEE as
> the funded next steps. See [`../docs/permissionless-pool-plan.md`](../docs/permissionless-pool-plan.md).
