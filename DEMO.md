# GIX investor-demo — live vertical slice runbook

This is the **demo-milestone** end-to-end loop (`docs/demo-milestone-contract.md`):
a real `llama3.1:8b` inference on the **NVIDIA GB10**, purchased **on-chain** with
**MOCK_USDC**, attested with a **registered-key Ed25519 signature verified on-chain**,
**settled** to the provider, and returned with a **hash-verifiable** result — exposed
through an **OpenAI-compatible** gateway and a **web** buy flow.

Wired and proven on **localnet**. Testnet is parameterised and ready (blocked only on
the gated testnet faucet — see §Testnet).

---

## Components & ports

| Component        | Where                 | Port  | Role |
| ---------------- | --------------------- | ----- | ---- |
| Sui localnet     | `sui start` (running) | 9000 / 9123 | chain + faucet |
| Ollama + GB10    | `ollama serve`        | 11434 | real inference |
| Provider node    | `node/`               | 8081  | register, serve, attest, **settle** |
| OpenAI gateway   | `services/gateway/`   | 8088  | `/v1/chat/completions` |
| Web terminal     | `web/`                | 5173+ | wallet buy + result viewer |

> The node runs on **8081** (not the documented 8080) because an unrelated
> `fleet-route-solver` Docker container holds 8080 on this machine.

---

## Run the localnet demo (from scratch)

```bash
cd contracts
# 1. Redeploy the soft-attestation gix package + bootstrap market/model/funding.
GIX_OUT="$PWD/../deployment.json" bash scripts/deploy.sh
#    -> writes a fresh deployment.json (packageId, market, model, allowlist, treasury…)

cd ..
# 2. Run the provider node (signed mode) — registers its Ed25519 attest key, stakes
#    MOCK_USDC, mints credits, serves llama3.1:8b on the GB10, attests + settles.
#    Fund its tx address first (the node logs the address on first start):
#      curl -s -X POST http://127.0.0.1:9123/gas \
#        -d "{\"FixedAmountRequest\":{\"recipient\":\"<NODE_TX_ADDR>\"}}"
#    and faucet it MOCK_USDC if it will also be the consumer (single-account demo).
cd node && npm install
GIX_DEPLOYMENT="$PWD/../deployment.json" \
GIX_HTTP_PORT=8081 GIX_PUBLIC_ENDPOINT=http://127.0.0.1:8081 \
GIX_ATTEST_MODE=signed GIX_CHAIN_ENABLED=true \
  npm start            # wait for "[node] ready"; GET http://127.0.0.1:8081/health

# 3a. Drive a purchase via the OpenAI-compatible gateway:
cd ../sdk && npm install && npm run build
cd ../services/gateway && npm install && npm run build
GIX_DEPLOYMENT="$PWD/../../deployment.json" \
GIX_PROVIDER_URL=http://127.0.0.1:8081 \
GIX_PROVIDER_ADDRESS=<NODE_TX_ADDR> \
GIX_SUI_PRIVKEY=<consumer suiprivkey1…> \
GIX_MAX_PRICE_USDC=5 GIX_GATEWAY_PORT=8088 \
  npm start

curl -s http://127.0.0.1:8088/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"H100-llama3.1-8b-int8",
       "messages":[{"role":"user","content":"In one sentence, what is a GPU inference exchange?"}]}' -i
#  -> 200 OK, x-gix-verified: true, x-gix-cost-usdc: 5, real completion in choices[0].

# 3b. Or drive it via the web buy flow:
cd ../../web && npm install
#    web/.env.local is already wired to the live deployment (VITE_ORDER_CLIENT=sui).
npm run build && npm run dev      # open the printed http://127.0.0.1:<port>/
```

### The stubbed-match constraint (important)

`create_job<M>(… , provider, credits: Coin<Credit<M>>, escrow_in, …)` is signed by the
**consumer**, but the `credits` argument is the **provider's** coin. A Sui tx can only
split coins the **signer owns**, so for the demo the **consumer == provider == the node's
key** (the same single-account model the verified `harness/` uses). On localnet that is
the node tx address, funded with both SUI gas and MOCK_USDC. (Production M2 removes this
via DeepBook matching / sponsored txns; out of scope for the demo.)

### SLA note

The market `sla_p99_ms` must exceed real GB10 latency or every job is `SLA_BREACH →
refund` instead of `VALID → settle`. The deploy default is now **30000 ms** (a cold
llama3.1:8b 8B completion is ~6 s; warm ~1.5 s). Tune with
`market::set_sla(adminCap, market, p99, ack, exec, attest)`.

---

## Proven localnet evidence (this run)

- Package: `0x107495d41e26ae42f3345b94fc448ad77f6f3e8d1072a096dcaf7cb558eff7e3`
- Market: `0xbf8785784cf08435ddc8d7d40394dc54103fcdd297edebc5f650c6e1db8de5f7`
- Provider node tx addr / attest pubkey:
  `0x5d11b7bceb20471ed879c5b12f2f84f5e9064e929378ad514608170b22fa9549` /
  `0xfd2e2dc2d6483e931045feb3470806976a129e67d4aa27778b0c9912eca078f2`

A settled job (`0xb948fe46…`):
- create_job: `ARMtZ2K1CFGfEgG9L5MtzGFGnm4oRCZx4ddDKhXySGhy`
- submit_signed_attestation (verdict 0 = VALID, Ed25519 verified on-chain):
  `9SWEvokYsJjkW2HSLhRcwxoXRxHnX7Z4daAXBshnzLR3`
- settle (Settled event, payout 5 MOCK_USDC to provider):
  `7RAWYoiRZZFm8Ppf95LSD7fpq3tvzABFLx6XEmt39YBm`
- Output (real GB10 llama3.1): *"A GPU (Graphics Processing Unit) inference exchange is
  an online marketplace … without having to train their own models from scratch."*
- `verified: true` (consumer re-hash of output == on-chain output_hash).

Three `Settled` events recorded — one each via SDK, gateway, and the web SuiOrderClient.

---

## Testnet (Step 5 — ready, blocked on faucet)

The deploy script, node, SDK, gateway, and web are all network-parameterised, so testnet
is a config flip. The only blocker in this environment was the **testnet faucet**, which
now requires the captcha Web UI (`https://faucet.sui.io/?address=<addr>`) and rate-limits
the programmatic endpoint. Once the active address has test SUI, run:

```bash
sui client switch --env testnet
# Fund via the Web UI: https://faucet.sui.io/?address=$(sui client active-address)
sui client gas          # confirm a gas coin landed

cd contracts
# testnet is a built-in env → the deploy script uses `sui client publish` automatically.
GIX_OUT="$PWD/../deployment.json" bash scripts/deploy.sh

# K4: disable the localnet-only mock attestation path before any non-localnet use.
PKG=$(jq -r .packageId ../deployment.json); CFG=$(jq -r .configId ../deployment.json)
CAP=$(jq -r .adminCapId ../deployment.json)
sui client call --package "$PKG" --module config --function set_is_localnet \
  --args "$CAP" "$CFG" false --gas-budget 100000000

# Run the node against testnet (it self-registers + stakes + serves):
cd ../node
GIX_DEPLOYMENT="$PWD/../deployment.json" GIX_RPC_URL=https://fullnode.testnet.sui.io:443 \
GIX_HTTP_PORT=8081 GIX_PUBLIC_ENDPOINT=http://<public-host>:8081 \
GIX_ATTEST_MODE=signed npm start
#   (fund the node tx addr with testnet SUI + MOCK_USDC from our faucet first).

# Gateway call works identically; explorer links resolve at
# https://suiscan.xyz/testnet/tx/<digest>.
```

For the web on testnet, set in `web/.env.local`: `VITE_NETWORK=testnet`,
`VITE_RPC_URL=https://fullnode.testnet.sui.io:443`,
`VITE_EXPLORER_TX_BASE=https://suiscan.xyz/testnet/tx`, and the new deployment ids; the
wallet layer switches from the localnet burner to dapp-kit wallet-connect automatically.
