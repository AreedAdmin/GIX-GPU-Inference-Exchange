# Run on your Mac — buy compute from the GB10

A GPU-less Mac buys real inference from the GB10 over the LAN, pays on-chain with its own
wallet, and prints the verified answer. **Proven working** consumer↔provider (distinct wallets).

## Prerequisites
- Mac on the **same Wi-Fi/LAN** as the GB10 (the GB10 is `192.168.1.81`).
- **Node 18+** on the Mac (`node -v`). Nothing else — no GPU, no Ollama, no chain.
- The **GB10 services running** (localnet + provider node) — see "GB10 side" below.

## Mac side — 3 steps
1. **Copy this folder** (`examples/no-gpu-client/`) to the Mac — e.g.
   `scp -r shehab@192.168.1.81:".../examples/no-gpu-client" ~/` (skip `.wallet` + `node_modules`;
   they're regenerated). `config.mac.json` is already inside, pre-filled with the GB10's LAN IP +
   the live deployment ids + the provider's Ask.
2. **Install + fund** (one time — creates the Mac's own consumer wallet and funds it):
   ```bash
   cd no-gpu-client
   npm install
   npm start -- --config config.mac.json --fund
   ```
3. **Buy compute** — run any prompt:
   ```bash
   npm start -- --config config.mac.json "In one sentence, what is a GPU inference exchange?"
   ```
   → prints the GB10-computed answer, `✓ verified`, jobId, USDC cost, and the tx.

If you see `missing: askId/providerUrl`, the GB10 node restarted and posted a **new** Ask — grab
the new `ask id` from the node log and update `ASK_ID` in `config.mac.json` (or pass
`--ask 0x…`).

## GB10 side — keep these running (already up now)
```bash
# 1. localnet (already running, bound 0.0.0.0 → LAN-reachable)
bash ops/scripts/localnet.sh status        # or: localnet.sh start

# 2. (re)deploy the shared-Ask contract → deployment.json   (only if redeploying)
GIX_GAS_BUDGET=2000000000 GIX_OUT="$PWD/deployment.json" bash contracts/scripts/deploy.sh

# 3. provider node — registers, posts an Ask, serves llama3.1:8b on the GPU
cd node && GIX_DEPLOYMENT="$PWD/../deployment.json" GIX_RPC_URL=http://127.0.0.1:9000 \
  GIX_HTTP_HOST=0.0.0.0 GIX_HTTP_PORT=8081 GIX_PUBLIC_ENDPOINT=http://192.168.1.81:8081 \
  GIX_ATTEST_MODE=signed GIX_CHAIN_ENABLED=true GIX_MODEL=llama3.1:8b \
  GIX_CAPACITY_SCU=1000 GIX_ASK_QTY_SCU=100 GIX_ASK_PRICE_USDC=1000 \
  GIX_MINT_SCU=0 GIX_BOND_USDC=100000000 npm start
# → logs "RESTING ASK published — ask id = 0x…"; put that ask id in config.mac.json
```

## Going to the investor demo (different LAN → testnet)
The Mac may be on a different network at the demo, so localnet-over-LAN won't reach. Switch to
**testnet** (public chain + a `cloudflared` tunnel for the node endpoint) — same code, only the
config changes. Full switch checklist: `docs/two-machine-networking.md` (Environment B).
