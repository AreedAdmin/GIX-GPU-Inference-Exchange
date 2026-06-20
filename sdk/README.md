# @gix/sdk — GIX consumer SDK

Turns an inference request into an **on-chain compute purchase** served by a
provider's GPU, with a **cryptographically verifiable** result. This is the
consumer (D2) side of the demo-milestone slice
(`docs/demo-milestone-contract.md` §4).

## What `runTask` does

```ts
import { GixClient, fromSuiPrivateKey } from "@gix/sdk";
import deployment from "../deployment.json" assert { type: "json" };

const gix = new GixClient({
  deployment,                                   // deployment.json (markets, ids, usdcType)
  signer: await fromSuiPrivateKey(process.env.GIX_SUI_PRIVKEY!), // or an injected wallet
  providerUrl: "http://localhost:8080",         // the provider node (node §3.1)
});

const res = await gix.runTask({
  market: "H100-llama3.1-8b-int8",  // market id OR name
  prompt: "What is the capital of France?",
  maxPriceUsdcPerScu: 5,            // MOCK_USDC base units (6dp) per SCU
  // scuQty: 1                      // optional, default 1
});
// res: { output, jobId, digest, verified, payoutUsdc?, providerPubkey? }
```

The flow (each step BINDING per §4):

1. **`POST {prompt}` → provider `/inputs`** → `{ inputHash }` (the node caches the
   prompt by hash).
2. **`create_job<M>(cfg, market, stake, provider, credits, escrow_in, input_hash, clk, ctx)`**
   — funds a `MOCK_USDC` escrow of `maxPriceUsdcPerScu * scuQty`, reserving the
   provider's stake + credits. Signed by the configured signer.
3. **Await the job's `Settled` / `AttestationSubmitted` event** (the node attests
   then settles). The `AttestationSubmitted` / `Settled` event carries the
   on-chain `output_hash`.
4. **`GET /result/:jobId`** from the provider, **re-hash `output` with `sha2_256`
   and compare to the on-chain `output_hash`** → sets `verified`.

Verification (`verifyOutput`, §2): `sha2_256(output_utf8)` (Node `crypto`
SHA-256, byte-identical to Move's `sui::hash::sha2_256`) compared hex-tolerantly
to the on-chain hash.

## M2 — testnet DeepBook + Walrus path (Option B, pay-at-match)

When `deployment.network === "testnet"`, `runTask` switches rails: it **buys
capacity on a real DeepBook pool** and uses **Walrus** for the input/output
blobs (`contracts/INTERFACE.md` §"M2 — DeepBook fill jobs"). The localnet escrow
path above is unchanged (network-switched).

```ts
const gix = new GixClient({
  deployment,                                  // deployment.testnet.json (markets[].deepbookPoolId set)
  signer: await fromSuiPrivateKey(consumerKey),// signs the buy PTB
  walrusSigner: ed25519Keypair,                // a real @mysten/sui Signer — Walrus writeBlob needs WAL
  providerUrl: "http://provider:8080",         // only used as a /result fallback
  fill: { providerRecordId, poolId },          // default to deployment.* if omitted
});
const res = await gix.runTask({ market, prompt, maxPriceUsdcPerScu: 5 });
// res adds { inputBlobId, outputBlobId }
```

Testnet flow:

1. **Walrus `uploadInput(prompt)`** → `{ blobId, blobIdU256, inputHash }`
   (replaces `POST /inputs`). `inputHash = sha2_256(prompt)` stays the
   verification primitive; the `blob_id` is a storage commitment.
2. **One atomic, consumer-signed PTB**:
   - `deepbook::pool::swap_exact_quote_for_base<Credit<M>, MOCK_USDC>(pool,
     usdcIn, deepIn, minBaseOut, clock)` → `(Coin<Credit<M>>, Coin<MOCK_USDC>,
     Coin<DEEP>)` — the resting maker (provider) is **paid USDC at the fill**.
   - `gix::job::create_job_from_fill<M>(cfg, market, providerRec, credits,
     input_blob_id:u256, input_hash, clock)` — **NO escrow**; consumes the swap's
     `Credit<M>`. USDC + DEEP remainders are transferred back to the consumer.
   - DeepBook testnet package id + DEEP coin (`0x36dbef86…::deep::DEEP`) are read
     from `@mysten/deepbook-v3` testnet constants; the pool id from
     `deployment.markets[].deepbookPoolId`.
3. **Await the terminal event** (node attests → `settle_fill` / `resolve_fill`).
4. **Walrus `downloadOutput(output_blob_id)` + `verify`** — read the job's
   `output_blob_id` off the Job object, download the bytes, and check
   `sha2_256(bytes) == on-chain output_hash`. Falls back to provider `/result`
   when no output blob was recorded.

### Walrus helpers (standalone)

```ts
import { WalrusHelper, verifyBlob, blobIdToU256, u256ToBlobId } from "@gix/sdk";
const w = new WalrusHelper({ network: "testnet", suiClient });
const { blobId, blobIdU256, inputHash } = await w.uploadInput(prompt, signer);
const { output, verified } = await w.downloadAndVerify(blobIdU256, onChainOutputHash);
```

### Model-on-Walrus tool

`scripts/upload-model.ts` computes the canonical **`model_hash = sha2_256(file)`**
for a local GGUF, optionally uploads it to Walrus (`--upload`, guarded — needs
WAL + is ~4.6 GB), and prints a ready `sui client call …::registry::register_model`
to bind `model_hash` + `walrus_blob_id` into the on-chain `ModelRecord`.

```bash
# hash + emit command WITHOUT uploading (default file = the bundled llama3.1:8b GGUF):
npx tsx scripts/upload-model.ts --deployment ../deployment.testnet.json
# also upload to Walrus (testnet):
npx tsx scripts/upload-model.ts --upload --privkey suiprivkey1… --epochs 30
```

## Other methods

```ts
gix.markets();    // MarketInfo[] — surfaced by the gateway as OpenAI models
await gix.balances(); // { address, usdc: bigint, sui: bigint } for the signer
```

## Signers (the `WalletSigner` seam)

- **Server / CLI**: `await fromSuiPrivateKey("suiprivkey1…")` or
  `keypairSigner(ed25519Keypair)`.
- **UI**: inject a `WalletSigner` wrapping `@mysten/dapp-kit`'s `signTransaction`
  — `{ toSuiAddress(), signTransaction(bytes) -> { bytes, signature } }`. A raw
  `@mysten/sui` `Keypair` already satisfies the interface.

## Build & test

```bash
npm install
npm test          # unit tests: hash/verification, create_job PTB plan, runTask flow (mocked chain + provider)
npm run build     # emits dist/ (consumed by the gateway)
```

Tests are hermetic — no validator, no network: `@mysten/sui` is only imported on
a real run; the `runTask` test mocks the chain module and injects a fake `fetch`.

## Integration must confirm

- **Provider node HTTP** (node §3.1): `POST /inputs {prompt} -> {inputHash}`;
  `GET /result/:jobId -> { jobId, model, output, outputHash, outputTokenCount,
  tStart, tEnd, measurement, signature, attestPubkey }`. The node serves
  `/result` only *after* settlement (the SDK polls).
- **`create_job` ABI** (`contracts/INTERFACE.md`): target `…::job::create_job`,
  one type-arg `Credit<M>` witness, 8 args in order
  `(cfg, market, stake, provider, credits, escrow_in, input_hash, clk)`.
- **Event names** (`gix::events`): `AttestationSubmitted` (carries `output_hash`,
  `verdict`) and `Settled` (carries `payout`, `output_hash`), keyed by `job_id`.
- The provider operator address holding the `ProviderStake` + `Credit<M>` coin —
  defaults to `deployment.accounts.providers[0]`; override via `options.provider`.
