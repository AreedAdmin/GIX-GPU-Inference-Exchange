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
