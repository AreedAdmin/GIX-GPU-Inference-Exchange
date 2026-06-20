# GIX — GPU-less consumer client

**Run this on any computer (no GPU).** It buys a real AI inference from a remote
GPU provider, pays for it on-chain, and prints the answer — and it
*cryptographically verifies* that the answer is the one the chain was paid for.

No GPU. No Ollama. No local blockchain. Just Node 18+ and network access to a
Sui RPC and the provider's URL.

---

## The one command

```bash
npm install
npm start -- "What is the capital of France?"
```

That's it. First run generates a wallet; fund it once (below) and you're buying
compute from a remote GPU.

---

## Steps (copy-paste, Mac)

```bash
# 0. You need Node 18 or newer.  (macOS: `brew install node`)
node --version

# 1. Install deps (only @mysten/sui).
cd examples/no-gpu-client
npm install

# 2. Point it at a network + provider.  Copy the example and fill the two
#    values that come from the running provider node: ASK_ID and PROVIDER_URL.
cp config.json.example config.json
#    ...edit config.json (everything else defaults from ../../deployment.json)

# 3. Create + fund your wallet (SUI for gas, MOCK_USDC to pay).  One time.
npm start -- --fund

# 4. Buy an inference.  The remote GPU runs it; you get a verified answer.
npm start -- "Explain transformers in one sentence."
```

Example output:

```
────────────────────────────────────────────────────────────────
ANSWER
────────────────────────────────────────────────────────────────
The capital of France is Paris.
────────────────────────────────────────────────────────────────
✓ verified   (sha2_256 matches)
model     llama3.1:8b
jobId     0x4e4a2ce3…aafc
cost      0.000005 USDC (5 base units)
latency   6.3s
explorer  https://suiscan.xyz/testnet/tx/Cejr4LWQ…
────────────────────────────────────────────────────────────────
```

`✓ verified` means the client re-hashed the returned text with `sha2_256` and it
**matched the `output_hash` the contract recorded on-chain** — so you are
trusting math, not the provider's word. If it ever prints `✗ NOT VERIFIED`, the
answer was tampered with and the process exits non-zero.

---

## What it does (the flow)

1. `POST {prompt}` → provider `/inputs` → get back the `inputHash`.
2. `job::create_job_from_ask<M>(…)` — fill the provider's resting **shared Ask**,
   funding a MOCK_USDC escrow of `qty_scu × price_usdc_per_scu`. Signed by your
   wallet. You **never touch a provider-owned object** (two-account buy).
3. Wait for the job's `Settled` / `AttestationSubmitted` event (the provider
   serves the inference + settles on-chain).
4. `GET /result/:jobId` → the answer.
5. Re-hash the answer (`sha2_256`) and compare to the on-chain `output_hash` →
   `verified`.
6. Pretty-print: the answer, ✓verified, jobId, cost in USDC, latency, explorer
   link.

---

## Configuration

Sources, lowest to highest precedence:

```
bundled ../../deployment.json   <   config.json   <   env vars   <   CLI flags
```

| Key | Where it comes from | Default |
|-----|--------------------|---------|
| `PACKAGE_ID` | `deployment.json` | — |
| `CONFIG_ID` | `deployment.json` | — |
| `MARKET_ID` | `deployment.json` `markets[0].id` | — |
| `CREDIT_TYPE` | `deployment.json` `markets[0].creditType` (the `<M>` type-arg) | — |
| `USDC_TYPE` | `deployment.json` `usdcType` | — |
| `FAUCET_ID` | `deployment.json` `faucetId` (MOCK_USDC mint) | — |
| `CLOCK_ID` | `deployment.json` | `0x6` |
| `RPC_URL` | you / network | per-network public fullnode |
| `SUI_FAUCET_URL` | you / network | localnet `:9123`, devnet, testnet |
| `EXPLORER_TX_BASE` | you / network | suiscan per network |
| `SCU_QTY` | you | `1` |
| **`ASK_ID`** | **the running provider node** (`AskPosted` event) | **— (required to buy)** |
| **`PROVIDER_URL`** | **the running provider node** (its public URL) | **— (required to buy)** |

The same binary runs **localnet / LAN / testnet** by changing only `NETWORK`,
`RPC_URL`, `ASK_ID`, and `PROVIDER_URL`.

CLI flags: `--prompt/-p`, `--config/-c <path>`, `--fund`, `--scu <n>`,
`--ask <0x…>`, `--provider <url>`, `--rpc <url>`, `--help/-h`.

Env vars mirror the table (`RPC_URL`, `PACKAGE_ID`, `ASK_ID`, `PROVIDER_URL`, …).

### Funding a fresh wallet

`--fund` requests **SUI gas** from the configured faucet and mints **MOCK_USDC**
via the package faucet (`mock_usdc::mint`). Works automatically on localnet and
test deploys. On testnet, if MOCK_USDC minting is gated, the client prints the
faucet info so you can fund manually. On mainnet there is no faucet.

---

## The wallet

Your private key lives in **`./.wallet`** (a bech32 `suiprivkey1…`, file mode
`0600`, gitignored). It is generated on first run and reused after. Your address
is printed on every run. Back up `.wallet` if you fund it with anything you care
about.

---

## Build & test

```bash
npm run build       # tsc → dist/
npm test            # vitest: PTB plan, sha2_256 verification, config loader
npm run typecheck   # tsc --noEmit
```

The unit tests pin the `create_job_from_ask` PTB (target, `<M>` type-arg, arg
order, escrow math) against `contracts/README.md`, the `sha2_256` verifiable-
result check, and the config precedence. The live buy is wired and runs against a
node that has posted an `Ask` on a package built from the current contracts.
