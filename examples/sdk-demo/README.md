# GIX SDK demo — a narrated CLI buy

The developer-facing complement to the UI video. One command drives the **same**
end-to-end consumer flow the dApp does, but programmatically via `@gix/sdk`, and
narrates every step so you can watch a prompt become an on-chain compute purchase
served by a real **GB10** GPU — with a cryptographically verifiable answer.

```bash
npx tsx examples/sdk-demo/run.ts "What is the capital of France? Answer in one short sentence."
```

(or, from this directory, after `npm install`: `npm run demo -- "your prompt"`)

## What it does (one run, consumer-only)

The GB10 provider node already runs separately on testnet; this script is the
**buyer**. It prints a config header, then five steps:

- **[1/5] Market & order book** — reads the GB10·Qwen market and the provider's
  **current resting Ask straight from chain** (price USDC/SCU, qty available,
  maker address).
- **[2/5] Buy — fill the ask** — fills 1 SCU via `job::create_job_from_ask<M,Q>`,
  carrying the prompt **inline** (`input` = UTF-8 bytes, `input_hash` =
  `sha2_256(prompt)`), escrow = `qty × ask price`. Prints the job id + buy tx
  Suiscan link.
- **[3/5] Dispatch → inference** — polls the on-chain Job `state` (spinner) while
  the provider runs qwen, until terminal; prints "served N tokens in Xs".
- **[4/5] Verify (trustless)** — fetches the result and checks **three
  independent proofs**: `sha2_256(output) == on-chain output_hash`, the **Ed25519
  attestation signature** over the canonical `GIX_ATTEST_V1` message (key matches
  the registered provider key), and the served **model matches the registered
  ModelRecord**. Prints the answer + a VALID/INVALID verdict.
- **[5/5] Settle** — confirms `Settled`, the provider paid, escrow released, with
  the attest+settle tx Suiscan link.

A summary footer prints `✓ verified inference · Xs · price USDC · 3 on-chain proofs`.

## How it finds the ask (survives node restarts)

The node posts a fresh `Ask<M>` at startup, so any hardcoded id goes stale. The
demo instead calls `chain.findLatestAsk(market)`, which queries the package's
`AskPosted` events (newest first), keeps the ones for this market, and returns
the most recent one whose **live `Ask<M>` object still exists and has SCU
remaining** — reading the authoritative `price_usdc_per_scu` / `remaining_scu`
off the object, not the stale event.

## Config

Everything is read from the repo's `deployment.testnet.json` (package id, config
id, market id + credit type, MOCK_USDC type, clock `0x6`, the model record, and
the consumer/provider/node addresses) — nothing chain-specific is hardcoded. The
consumer key is the local **sui CLI keystore** key for `deployment.accounts.consumers[0]`.

Overridable via env:

- `GIX_PROVIDER_URL` — provider node base URL (default `http://127.0.0.1:8082`).
- `GIX_DEBUG=1` — print the full stack trace on error.

## Requirements

- The GB10 provider node live on testnet (the demo checks `/health`).
- The consumer address funded with a little SUI (gas) + MOCK_USDC (a single buy
  costs ~0.01 SUI gas + ~0.001 USDC escrow).
- Node 18+, and the sui CLI keystore holding the consumer key.

## The SDK surface it uses

`GixChain.findLatestAsk`, `GixChain.createJobFromAsk` (the inline-input
`create_job_from_ask` PTB), `GixChain.readJobState`, `GixChain.awaitSettlement`,
`sha2_256Hex` / `verifyOutput`, and `ProviderClient` — all from `@gix/sdk`. The
load-bearing logic lives in the SDK; `run.ts` is the narration around it.
