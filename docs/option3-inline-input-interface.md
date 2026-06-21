# Option 3 — inline on-chain input (tunnel-free) · pinned interface

**Goal:** make the demo **tunnel-free without DEEP** by carrying the (small) prompt
**inline in the `create_job_from_ask` transaction** instead of via the node's `/inputs`
HTTP endpoint, and delivering the result via **Walrus** (provider-paid) instead of the
node's `/result` endpoint. The Mac (consumer) and DGX (provider) then never connect —
only outbound to the public Sui testnet + Walrus. Dispatch is already decentralized
(node polls `Dispatched` events). All hashes stay `sha2_256` of the raw bytes so the
audit + negative-test rigor is unchanged.

This file is the **pinned interface** — every agent codes against it so the lanes compose.

## A. Contract ABI (lane: `contracts/`)
- `Job<phantom M, phantom Q>` gains a field **`input: vector<u8>`** — the raw prompt bytes
  (empty `vector[]` when the Walrus-blob path is used instead).
- `create_job_from_ask<M, Q>(…)` gains an **`input: vector<u8>`** parameter (place it
  immediately before `input_hash`). Keep the existing `input_hash: vector<u8>` and
  `input_blob_id: u256` parameters. Semantics:
  - If `input` is non-empty: **assert `sha2_256(input) == input_hash`** (on-chain integrity)
    and **assert `vector::length(&input) <= MAX_INLINE_INPUT`** (a new const, **16384** bytes).
    Store `input` in the `Job`. `input_blob_id` is expected to be `0`.
  - If `input` is empty: behaves exactly as today (Walrus-blob path via `input_blob_id`).
- Add a read accessor: `public fun job_input<M, Q>(job: &Job<M, Q>): &vector<u8>`.
- The same change is **not** required on `create_job_from_fill` for this milestone (Ask path only).
- Keep `MOCK_USDC`-on-localnet behavior and all existing tests green; add inline-input tests
  (happy: hash matches → stored; negative: `sha2_256(input) != input_hash` aborts; oversize aborts).

## B. Node (lane: `node/`)
- Extend the job read (`getJobMeta` in `src/chain.ts`) to also return the inline input:
  `{ kind, inputBlobId, input: Uint8Array /* the on-chain job.input bytes, possibly empty */ }`.
- In the serve loop (`src/serve.ts` `resolvePrompt`), **priority order:**
  1. `input.length > 0` → prompt = `utf8Decode(input)`; **verify `sha2_256(input) == input_hash`** (defense in depth); use it. *(No Walrus read, no `/inputs` cache.)*
  2. else `inputBlobId != 0` → read from Walrus (today's path).
  3. else → `/inputs` cache (legacy/localnet fallback).
- **Walrus upload-relay fix:** add `uploadRelay`/`storageNodeClientOptions` passthrough to the
  node's Walrus writer (`src/walrus.ts`), mirroring `sdk/src/walrus.ts`, and use the testnet relay
  `https://upload-relay.testnet.walrus.space` (const tip) for output-blob writes. Env:
  `GIX_WALRUS_RELAY` (default the testnet relay on testnet; unset/off on localnet).
- The HTTP server may still start (harmless) but must **not** be required when inline input is used.

## C. Web (lane: `web/`)
- Buy path (`src/trade/sui.ts`): switch the on-chain call to **`create_job_from_ask`** carrying
  **`input` = UTF-8 bytes of the prompt**, **`input_hash` = `sha2_256(prompt)`** (compute client-side
  via WebCrypto), **`input_blob_id` = 0**. Remove the `POST /inputs` call from this path.
- Result fetch: download the output from **Walrus** by the job's `output_blob_id` via the public
  aggregator (reuse `src/trade/audit.ts`'s aggregator fetch), recompute `sha2_256`, verify — instead
  of `GET /result/:jobId`.
- `AuditDrawer`: for inline-input jobs, verify the **input** by reading `job.input` from chain (+ hash),
  not from Walrus (output still from Walrus). Keep the per-check ✅/❌ UI.
- No browser Walrus **write** client and **no consumer WAL** are needed (input is in the tx; Walrus
  reads are free).

## D. E2E harness (lane: `e2e/`)
- `chain.ts`: pass `input` (raw bytes) into `create_job_from_ask`; set `input_blob_id = 0`.
- `audit.ts`: input-integrity check reads the on-chain `job.input` (+ `sha2_256`) for inline jobs;
  output check stays Walrus. Keep the F6 money invariants + F7 audit assertions.
- Add a scenario asserting the **tunnel-free inline path**: job created with inline input, served by the
  (mock) node reading input from chain, output to (mock/real) Walrus, settled, audited — with **no HTTP
  `/inputs` or `/result`** call anywhere in the flow. Keep localnet mock-node green; testnet/gb10 guarded off.

## Integrity invariant (unchanged)
`input_hash == sha2_256(input_bytes)` and `output_hash == sha2_256(output_bytes)` regardless of transport.
On-chain we now *enforce* the input equality for inline jobs. The independent audit still recomputes both.
