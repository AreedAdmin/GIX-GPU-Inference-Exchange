# GIX provider node (D0)

Serves **real inference** on this machine's **NVIDIA GB10** via **Ollama**, produces
**signed Ed25519 attestations** over the byte-exact §2 canonical message, submits them
on-chain to the `gix` package, and serves verifiable results over HTTP.

Implements the D0 workstream of [`docs/demo-milestone-contract.md`](../docs/demo-milestone-contract.md)
(§2 canonical message, §3 lifecycle, §3.1 HTTP, §6 config). Reuses the chain patterns
from `harness/src/chain/sui.ts` (lazy `@mysten/sui` import, PTB construction with the
verified gix ABI, object-id capture, `waitForTransaction` sequencing).

## Layout

```
src/
  config.ts            env + deployment.json loader (§6)
  keys.ts              persists Sui tx keypair + Ed25519 attestation keypair (.keys/)
  ollama.ts            Ollama HTTP client (pull / generate, token accounting)
  attest/
    canonical.ts       byte-exact §2 canonical message builder + sha2_256 + u64_le
    signer.ts          Ed25519 sign/verify (@noble/ed25519, Node-crypto sha512 shim)
  chain.ts             NodeChain: register_provider + stake + mint + Dispatched poll + submit
  serve.ts             serve loop: prompt -> inference -> hashes -> sign -> submit -> store
  store.ts             in-memory prompt-by-hash + result-by-job caches
  http.ts              HTTP server: POST /inputs, GET /result/:jobId, GET /health (§3.1)
  main.ts              entrypoint wiring the lifecycle together
  cli/ollama-check.ts  standalone GB10 inference smoke (no chain)
test/
  canonical.test.ts    §2 golden-vector + signature round-trip (vitest)
  http-serve.smoke.ts  manual HTTP+serve smoke against real Ollama (npx tsx)
.keys/                 gitignored: sui-tx.key, attest.key (0600)
```

## Run

```bash
npm install

# 1. Prove the GB10 inference path (pulls llama3.1:8b if missing, runs a real completion):
npm run ollama-check

# 2. Unit-test the §2 canonical message + signature (byte-match the contract):
npm test

# 3. Run the node (HTTP + Ollama + on-chain register/serve):
npm start
# HTTP-only mode (no chain — demo /inputs -> inference -> /result without a deploy):
GIX_CHAIN_ENABLED=false npm start
```

Lifecycle on `npm start`:
1. Load/create keys under `.keys/` (logs the Sui tx address to fund + the attest pubkey).
2. Probe Ollama, pull `GIX_MODEL` if absent, start the HTTP server (bound `0.0.0.0` by default).
3. If chain enabled: `register_provider(endpoint, "GB10", attest_pubkey)` + stake
   (MOCK_USDC), then **`post_ask<M>(qty_scu, price_usdc_per_scu)`** to publish resting
   capacity as a **shared `Ask<M>`** (the two-account order book), then poll `Dispatched`
   events and serve each job. The serve loop handles both legacy owned-credit jobs and
   **Ask-created jobs bought by a DIFFERENT consumer wallet** identically.
4. Writes `node-state.json` (the Ask id + public endpoint + market/creditType) so an
   external consumer client (E3) can **discover what to buy and where**, and logs the same
   in a boxed `RESTING ASK published` banner.
5. Tops up the Ask (re-posts a fresh shared `Ask<M>`) when consumers draw `remaining_scu`
   down to/below `GIX_ASK_TOPUP_THRESHOLD_SCU`.

## Two-account flow (external consumer)

The node publishes a **shared `Ask<M>`**; an external consumer wallet buys against it with
`job::create_job_from_ask<M>` — the consumer never touches any provider-owned object. The
node advertises the Ask for discovery two ways:

- **`node-state.json`** (path `GIX_NODE_STATE`, default `node/node-state.json`): a small JSON
  with `{ packageId, configId, clockId, usdcType, marketId, creditType, provider,
  publicEndpoint, askId, priceUsdcPerScu, askQtyScu, remainingScu }` — everything the
  consumer needs to build the `create_job_from_ask<M>` PTB and reach `/inputs` + `/result`.
- a startup **log banner** printing `ask id`, `public endpoint`, `market`, `creditType (M)`,
  `price/SCU`, and `qty offered`.

The consumer funds `escrow_in ≥ askQtyScu × priceUsdcPerScu`, POSTs its prompt to
`<publicEndpoint>/inputs` (getting back the `inputHash`), then calls
`create_job_from_ask<M>(cfg, &market, &mut ask, qty_scu, escrow_in, input_hash, clk)`. The
node's serve loop reacts to the resulting `Dispatched`, runs Ollama, signs, submits the
signed attestation, and settles with its **own** `ProviderStake` (`job.provider` = this node).

## HTTP (§3.1)

```
POST /inputs    { "prompt": "..." }  -> { "inputHash": "0x<sha2_256(prompt)>" }
GET  /result/:jobId                  -> { jobId, model, output, outputHash,
                                          outputTokenCount, tStart, tEnd,
                                          measurement, signature, attestPubkey }
GET  /health                         -> { ok, model, gpu }
```

`output_hash` is on-chain in the attestation, so any consumer can re-hash `output`
and confirm it matches the settled job — a **verifiable result** without trusting the node.

## Env (§6)

| var | default | meaning |
|-----|---------|---------|
| `GIX_DEPLOYMENT` | `../deployment.json` | path to the deploy manifest |
| `GIX_RPC_URL` | `http://127.0.0.1:9000` | Sui JSON-RPC fullnode |
| `GIX_OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama HTTP base |
| `GIX_MODEL` | `llama3.1:8b` | served model tag |
| `GIX_GPU_CLASS` | `GB10` | GPU class advertised on register |
| `GIX_PUBLIC_ENDPOINT` | `http://127.0.0.1:<port>` | endpoint recorded on-chain + in `node-state.json`. **Set to a LAN IP / tunnel URL** for a remote consumer. |
| `GIX_HTTP_HOST` / `GIX_HTTP_PORT` | `0.0.0.0` / `8080` | HTTP bind (0.0.0.0 = reachable cross-machine) |
| `GIX_KEYS_DIR` | `./.keys` | keypair directory (gitignored) |
| `GIX_MARKET_ID` | first market in deployment | market this node serves |
| `GIX_MEASUREMENT` | `deployment.mockMeasurement` | runtime_measurement bytes |
| `GIX_BOND_USDC` / `GIX_CAPACITY_SCU` / `GIX_MINT_SCU` | `1_000_000` / `1000` / `0` | stake params. `GIX_MINT_SCU` is the OPTIONAL up-front owned-credit mint (default 0 so full capacity is free for asks). |
| `GIX_ASK_QTY_SCU` | `100` | SCU published per `post_ask` (shared `Ask<M>`) |
| `GIX_ASK_PRICE_USDC` | `1000` | per-SCU price (USDC base units) quoted on the Ask |
| `GIX_ASK_TOPUP_THRESHOLD_SCU` | `10` | re-post a fresh Ask when `remaining_scu` ≤ this (0 disables) |
| `GIX_ASK_TOPUP_POLL_MS` | `15000` | how often to poll the Ask's `remaining_scu` |
| `GIX_NODE_STATE` | `node/node-state.json` | where the discovery artifact (Ask id + endpoint) is written |
| `GIX_CHAIN_ENABLED` | `true` | run on-chain register/serve |
| `GIX_ATTEST_MODE` | `signed` | `signed` (§1 soft-attest) or `mock` (M1 `submit_mock_attestation`) |

## ABI reconciliation note

The demo §1 target signatures (`register_provider(cfg, endpoint, gpu_class,
attest_pubkey, ctx)` and `submit_signed_attestation(...)`) are being finalized by D1.
`chain.ts` targets those by default (`GIX_ATTEST_MODE=signed`) **and** falls back to the
as-built M1 ABI (`register_provider(operator, endpoint, gpu_class, ctx)` +
`submit_mock_attestation`) under `GIX_ATTEST_MODE=mock` so the node can smoke-test the
full register→stake→mint→serve loop against the current localnet deploy today. When D1
publishes the final `submit_signed_attestation` arg list in `contracts/INTERFACE.md`,
reconcile the `signed`-mode `moveCall` args there.
