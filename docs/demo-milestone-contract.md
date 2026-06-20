# Demo Milestone — Interface Contract (BINDING)

Goal: a **real vertical slice** for the investor demo — your GB10 serves a **real inference
task**, paid for **on-chain**, purchased via a **real wallet** and an **OpenAI-compatible API**,
with the result returned + cryptographically checked. Trust is **softened** (registered-key
signature, not yet hardware TEE) and the **order book is still stubbed** (DeepBook = M2); those
are the funded roadmap, not the demo.

Builds on M1 (`contracts/README.md`, `docs/mvp-m1-integration-contract.md`) and M1.5
(`docs/mvp-m1_5-ui-contract.md`). Networks: build/iterate on **localnet**, demo on **testnet**.
Settlement asset: **MOCK_USDC** (test). Model: **llama3.1:8b** via **Ollama** (installed on the
GB10); larger models are a runtime config flip.

Workstreams (disjoint dirs; integrate against this contract):
- **D1 — `contracts/`** (sui-pilot): soft attestation. **Authoritative for the final ABI** →
  records it in `contracts/README.md`; others reconcile to that.
- **D0 — `node/`**: provider node (Ollama) — produces signed attestations + serves results.
- **D2 — `services/gateway/` + `sdk/`**: OpenAI-compatible gateway + TS SDK (consumer side).
- **D3 — `web/`** (trade/wallet only): wallet connect + real buy + result viewer.
- **D4 — `ops/`** (integrator): testnet deploy + runbook.

---

## 1. Soft attestation — the new on-chain trust (D1 authoritative)

Pattern: **register a provider attestation key once, verify a native Ed25519 signature per job**
(Nautilus "register-once" minus the hardware vendor root). This replaces the localnet-only mock
for off-localnet use; **keep `submit_mock_attestation` (gated by `is_localnet`) so M1/M1.5 demos
still work**.

ABI (target signatures — D1 may refine, must publish final in `contracts/README.md`):
```
// registry: a provider registers its Ed25519 attestation pubkey (32 bytes) + HTTP endpoint.
public fun register_provider(
    cfg: &Config, endpoint: vector<u8> /*utf8 url*/, gpu_class: vector<u8>,
    attest_pubkey: vector<u8> /*ed25519, 32B*/, ctx
): ProviderCap   // (also records pubkey+endpoint in a ProviderRecord)

// attestation: verify a real signature over the canonical message, off-localnet-safe.
public fun submit_signed_attestation<M>(
    job: &mut Job<M>, cfg: &Config, market: &Market<M>, model: &ModelRecord,
    allow: &MeasurementAllowlist, provider_rec: &ProviderRecord,
    runtime_measurement: vector<u8>, input_hash: vector<u8>, output_hash: vector<u8>,
    output_token_count: u64, t_start: u64, t_end: u64,
    signature: vector<u8> /*ed25519, 64B*/, clk: &Clock, ctx
)
```
Verification: `sui::ed25519::ed25519_verify(&signature, &provider_rec.attest_pubkey, &msg)` where
`msg` is the canonical layout in §2; then the same verdict/SLA/measurement checks as the mock path
(measurement allowlisted, output non-empty, SLA window) → records verdict; settlement routes
VALID→`settle`, else `resolve_attested` exactly as today.

## 2. Canonical attestation message (byte-exact — node §3 and contract §1 MUST match)

```
msg = "GIX_ATTEST_V1"                       // 13 ascii bytes, domain separator
    ‖ job_id                                 // 32 bytes (object id)
    ‖ runtime_measurement                    // the allowlisted measurement bytes
    ‖ input_hash                             // 32 bytes = sha2_256(prompt_utf8)
    ‖ output_hash                            // 32 bytes = sha2_256(completion_utf8)
    ‖ u64_le(output_token_count)             // 8 bytes
    ‖ u64_le(t_start_ms) ‖ u64_le(t_end_ms)  // 8 + 8 bytes
```
Hashes are **`sha2_256`** (native in Move, trivial in TS) over UTF-8 bytes. Integers little-endian.
The node signs `msg` with its Ed25519 attestation key; the contract verifies against the registered
pubkey.

## 3. Provider node — `node/` (D0)

TypeScript service (reuse `harness/src/chain/sui.ts`). Lifecycle:
1. **Keys**: a Sui tx keypair (gas/txns) + an **Ed25519 attestation keypair** (persisted). Register
   via `register_provider(endpoint, gpu_class="GB10", attest_pubkey)`; stake (USDC) + mint credits.
2. **Model**: ensure Ollama has the model (`ollama pull llama3.1:8b`); serve via Ollama's API.
3. **Serve loop**: subscribe to `Dispatched(job_id, input_hash, ...)`. Look up the prompt for
   `input_hash` (received via `POST /inputs`, §3.1); run Ollama → `completion`,
   `output_token_count`. Compute `input_hash`/`output_hash` (sha2_256), `t_start/t_end` (ms),
   build §2 `msg`, sign, call `submit_signed_attestation`. Store the result (§3.1).
4. Robust to Ollama-not-ready (clear errors); configurable model/endpoint via env.

### 3.1 Node HTTP (the demo's input/output delivery; Walrus replaces this in M2)
```
POST /inputs        { prompt }            -> { inputHash }   // consumer submits prompt; node caches by hash
GET  /result/:jobId                       -> { jobId, model, output, outputHash, outputTokenCount,
                                               tStart, tEnd, measurement, signature, attestPubkey }
GET  /health                              -> { ok, model, gpu }
```
`output_hash` is on-chain (in the attestation), so any consumer can re-hash `output` and confirm it
matches the settled job → **verifiable result** without trusting the node's word.

## 4. Consumer SDK + gateway — `sdk/` + `services/gateway/` (D2)

### SDK (`sdk/`)
```ts
const gix = new GixClient({ network, deployment, signer /*keypair or wallet*/, providerUrl });
const res = await gix.runTask({ market, prompt, maxPriceUsdcPerScu });
// res: { output: string, jobId, digest, verified: boolean, payoutUsdc, providerPubkey }
```
`runTask` = `POST {prompt}` to the provider `/inputs` → `create_job(... input_hash ...)` (funds
MOCK_USDC escrow) → await the job's `Settled`/`Attested` event → `GET /result/:jobId` → re-hash
`output` and check it equals the on-chain `output_hash` (sets `verified`).

### Gateway (`services/gateway/`) — OpenAI-compatible
```
POST /v1/chat/completions   (OpenAI request shape)  -> OpenAI response shape (choices[0].message.content = output)
GET  /v1/models                                      -> markets as models
```
Internally calls the SDK `runTask`. Adds GIX headers/fields to the response (`x-gix-job-id`,
`x-gix-digest`, `x-gix-verified`, `x-gix-cost-usdc`). The investor line: *drop-in OpenAI API,
served by a decentralized GPU, settled on-chain.*

## 5. Wallet + UI buy — `web/` trade layer (D3)

- **Wallet**: `@mysten/dapp-kit` `WalletProvider` + connect button. On **localnet**, default to a
  **faucet-funded burner** (dapp-kit wallets target testnet/mainnet); on **testnet**, real wallet
  connect (Sui Wallet / Slush).
- **Real `OrderClient`** (replaces MockOrderClient via `web/src/store.tsx` `orderClientRef`): `buy`
  = the SDK `runTask` (place order with the connected signer). Reuse the `sdk/` package; do not
  re-implement chain logic.
- **Result viewer**: when a bought job settles, show the **actual model output** in a panel, plus
  verified ✓/✗, jobId, cost, explorer link. Job still tracks through *My Jobs*.

## 6. Config / networks / env
- Localnet (build): RPC `:9000`, faucet `:9123`, MOCK_USDC faucet, node `:11434` Ollama + `:8080`
  HTTP, gateway `:8088`, web `VITE_*`.
- Testnet (demo): `sui client switch --env testnet`; deploy package + market; real wallet; explorer
  `https://suiscan.xyz/testnet`. Faucet test SUI; MOCK_USDC via our faucet.
- No secrets committed. Keys: node keypairs in `node/.keys/` (gitignored); web burner in
  localStorage.

## 7. Definition of done
- D1: `sui move test` green incl. new signed-attestation tests; `submit_signed_attestation` verifies
  a real Ed25519 sig off-localnet; contracts/README.md updated.
- D0: node registers + serves a real `llama3.1:8b` completion on the GB10 and submits a signature
  the contract accepts; `/result/:jobId` returns a hash-matching output.
- D2: `curl POST /v1/chat/completions` returns a real completion paid on-chain; SDK `runTask` works
  and sets `verified:true`.
- D3: connect wallet → Buy → watch the GB10 serve it → see the answer + on-chain payment in the UI.
- D4 (integrator): the full loop runs on **testnet**, with explorer links and a runbook.
