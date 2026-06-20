# Two-Machine Networking — Dev (same-LAN) vs Demo (remote)

GIX runs the **buyer** (a GPU-less client, e.g. a Mac) and the **seller** (the GB10 provider
node) on two machines. There are two deployment environments. **The code is identical across
both** — the node (`node/`) and the client (`examples/no-gpu-client/`) are fully
env/config-parameterized, so switching environments is a config change, not a code change.

| | Buyer (Mac) | Seller (GB10) | Chain | Reachability | Funding |
|---|---|---|---|---|---|
| **A — Dev (now)** | same LAN as GB10 | localnet + node | **localnet on the GB10**, bound to the LAN | GB10 **LAN IP** (e.g. `192.168.x.x`) — no tunnel | open localnet faucet (no captcha) |
| **B — Demo (later)** | remote (different LAN) | testnet + node | **public Sui testnet** (real explorer links) | node endpoint via a **tunnel** (cloudflared → public https) | testnet faucet (**captcha**, manual) + on-chain MOCK_USDC faucet |

The on-chain purchase is a **real two-wallet transaction in both** — only the chain location and
how the Mac reaches the node differ.

## Environment A — Dev: same-LAN, GB10-hosted localnet (use this now)
- **GB10 runs:** localnet (RPC `:9000`, faucet `:9123`, reachable on the LAN), the `gix` package
  (via `test-publish --build-env localnet`), and the provider node (`:8081`, `post_ask` + serve,
  `llama3.1:8b` on the GPU). `GIX_PUBLIC_ENDPOINT=http://<GB10-LAN-IP>:8081`.
- **Mac runs:** `examples/no-gpu-client` with a `config.json` pointing at `<GB10-LAN-IP>` for RPC,
  faucet, and the provider endpoint, plus the fresh `deployment.json` ids + the node's `ASK_ID`.
- **Pros:** fully self-contained, no captcha, no tunnel, instant resets. **Con:** chain is local
  (no public explorer) — fine for internal dev.

## Environment B — Demo: remote, testnet (switch for investors)
- **Chain:** public **Sui testnet** — `sui client switch --env testnet`, deploy via
  `sui client publish` (testnet is a built-in env), and **`set_is_localnet false`** (decision K4:
  disables the mock-attestation path; only the signed path runs).
- **GB10 runs:** the node against testnet; expose its `:8081` HTTP via a **cloudflared quick
  tunnel** (`cloudflared tunnel --url http://localhost:8081` → a public `https://…` URL, no auth);
  set `GIX_PUBLIC_ENDPOINT` to that URL so a remote Mac can reach `/inputs` + `/result`.
- **Mac runs:** the same client, `config.json` pointed at testnet RPC + the tunnel URL + the
  testnet `deployment.json` ids + `ASK_ID`.
- **Funding (one-time, manual):** the testnet faucet now requires the captcha web UI
  (`https://faucet.sui.io/?address=…`) — fund the **deployer**, the **node tx address**, and the
  **Mac consumer address** with test SUI. MOCK_USDC comes from our on-chain faucet (open).
- **Explorer:** `https://suiscan.xyz/testnet/tx/<digest>` for investor-facing links.

## Dev → Demo switch checklist
1. `sui client switch --env testnet`; fund deployer via the web faucet; `sui client publish`
   (+ bootstrap market) → testnet `deployment.json`; `set_is_localnet false`.
2. Run the node against testnet; start `cloudflared tunnel --url http://localhost:8081`; set
   `GIX_PUBLIC_ENDPOINT` to the tunnel URL; `post_ask`.
3. Fund the node tx address + the Mac consumer address with test SUI (web faucet).
4. Give the Mac a testnet `config.json` (RPC, `PROVIDER_URL`=tunnel, deployment ids, `ASK_ID`).
5. On the Mac: `npm install && npm start -- "<prompt>"` — unchanged.

No source changes between A and B — only the client/node config (RPC, provider URL, network,
faucet, deployment ids).
