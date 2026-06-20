# GIX contracts — deploy scripts

`deploy.sh` publishes the `gix` package to the **active Sui network** (intended: a local
validator) and bootstraps the M1 state: the H100/llama8b `Market`, its `ModelRecord` + mock
measurement, MOCK_USDC funding for test accounts, and a `deployment.json` (schema per
[`docs/mvp-m1-integration-contract.md`](../../docs/mvp-m1-integration-contract.md)).

## Prerequisites

- `sui` CLI (this repo built/tested against **1.73**), on `PATH`.
- `jq`.
- A funded active address (it becomes `admin` and holds the `AdminCap`).

## Run a localnet, deploy, fund

This environment did **not** have a localnet validator running (the active env was
`testnet`), so the validator was not started here. Run these exact commands on a machine
where you can start one:

```bash
# 1. Start a local validator + faucet (separate terminal; keep it running).
RUST_LOG="off,sui_node=info" sui start --with-faucet --force-regenesis
#   ... or via the standalone binary:
#   sui-test-validator

# 2. Point the CLI at localnet and make sure the active address has gas.
sui client new-env --alias localnet --rpc http://127.0.0.1:9000
sui client switch --env localnet
sui client faucet            # gas for the admin/publisher address

# 3. Publish + bootstrap + fund + emit deployment.json.
#    Fund specific provider/consumer addresses by passing them in:
GIX_PROVIDERS="0xPROVIDER1,0xPROVIDER2" \
GIX_CONSUMERS="0xCONSUMER1" \
GIX_OUT="../ops/deployment.json" \
  ./scripts/deploy.sh
```

With no env overrides the script funds the admin address itself and writes
`contracts/deployment.json`.

## What the script does (equivalent raw CLI)

Each step the script automates, as a standalone command:

```bash
# Publish.
sui client publish . --gas-budget 200000000 --json

# Register model + its mock measurement (one governance call).
sui client call --package $PKG --module governance \
  --function register_model_with_measurement \
  --args $ADMIN_CAP $CONFIG $ALLOWLIST \
         "llama-3.1-8b-int8/vllm" "walrus-blob-model-1" "model-hash-llama8b" "MOCK-tdx-llama8b-v1" \
  --gas-budget 200000000

# Create the market (type-arg is the per-market credit witness).
sui client call --package $PKG --module market --function create_market \
  --type-args $PKG::markets::M_H100_LLAMA8B \
  --args $ADMIN_CAP $CONFIG "H100-llama3.1-8b-int8" "H100-80GB" $MODEL_ID 1000 5000 \
  --gas-budget 200000000

# Faucet MOCK_USDC (6 decimals; 1_000_000 = 1 mUSDC).
sui client call --package $PKG --module mock_usdc --function mint \
  --args $FAUCET 1000000000 $RECIPIENT --gas-budget 200000000
```

## Provider registration (run by the node, D0 — not by deploy.sh)

`deploy.sh` only *funds* providers; each provider self-registers from the node at startup.
As of the demo milestone (soft attestation) the registration carries the provider's 32-byte
**Ed25519 attestation pubkey** so `submit_signed_attestation` can verify per-job signatures:

```bash
# register_provider(cfg, endpoint, gpu_class, attest_pubkey) -> ProviderCap
#   attest_pubkey = the node's Ed25519 attestation public key, 32 bytes, as a u8 vector.
sui client call --package $PKG --module registry --function register_provider \
  --args $CONFIG "http://node:8080" "GB10" "[0x3b,0x6a,...32 bytes...]" \
  --gas-budget 200000000
```

The operator is `ctx.sender()` (the registering address); the `ProviderRecord` is shared and
discoverable, and its id is passed to `submit_signed_attestation` as `provider_rec`. The
pubkey MUST be exactly 32 bytes or the call aborts (`registry::EBadPubkeyLen = 205`).

## K4 — going to a non-localnet network

The mock attestation path is fenced to localnet three ways (decision K4). Before any
testnet/mainnet deploy, flip the on-chain flag off so the dev path can never run:

```bash
sui client call --package $PKG --module config --function set_is_localnet \
  --args $ADMIN_CAP $CONFIG false --gas-budget 200000000
```

After this, `submit_mock_attestation` and adding any `MOCK`-prefixed measurement both abort.

## Configuration env vars

| Var | Default | Meaning |
| --- | --- | --- |
| `GIX_OUT` | `contracts/deployment.json` | Output path for the manifest. |
| `GIX_PROVIDERS` | active address | Comma-separated provider addresses to fund. |
| `GIX_CONSUMERS` | active address | Comma-separated consumer addresses to fund. |
| `GIX_FUND_AMOUNT` | `1000000000` | MOCK_USDC base units per account (1000 mUSDC). |
| `GIX_SCU_TOKENS` | `1000` | SCU tokens per credit for the M1 market. |
| `GIX_SLA_P99_MS` | `5000` | Market p99 SLA. |
| `GIX_GAS_BUDGET` | `200000000` | Gas budget per tx. |

## The quote dollar is a generic phantom `Q` (no hardcoded coin)

As of the DBUSDC work, the quote/bond/settlement coin is **not hardcoded**. It is a generic
phantom type `Q` on the money-bearing structs (`Treasury<Q>`, `ProviderStake<Q>`, `Job<M, Q>`,
`Escrow<Q>`) and the functions over them. The dollar is chosen **per network at
instantiation**:

| Network | `Q` | How it's selected |
| --- | --- | --- |
| **localnet** | `MOCK_USDC` (ours) | `init` auto-seeds a `Treasury<MOCK_USDC>`; `deploy.sh` unchanged |
| **testnet** | `DBUSDC` (external) | `settlement::init_treasury<DBUSDC>` after publish; `Q` is a `--type-args` STRING only |
| **mainnet** | real `USDC` (Circle) | `settlement::init_treasury<USDC>` |

Because `Q` is generic, **the contract source never imports DBUSDC** — DBUSDC enters purely as
the type-arg `0xf7152c05…::DBUSDC::DBUSDC` at call time (treasury, DeepBook pool, buy PTBs). So
there is **no new `Move.toml` dependency**. `deploy.sh` and the localnet flow keep settling in
`MOCK_USDC` exactly as before (the package `init` still seeds the `MOCK_USDC` treasury).

## `stage-testnet-dbusdc.sh` — staged testnet bring-up (DEEP-gated, NOT executed)

`stage-testnet-dbusdc.sh` stages the testnet (re)publish of the generic-`Q` package with the
quote dollar pinned to **DBUSDC** plus the new **GB10 · Qwen3.6-35b** credit market. It is a
**dry-run by default** — it prints the exact plan and touches nothing. It NEVER writes the live
`deployment.testnet.json` and refuses to reuse the live package id `0x0ed255b1…`; under
`--confirm` it writes a separate `deployment.testnet.staged.json`.

```bash
scripts/stage-testnet-dbusdc.sh            # DRY RUN — print the plan, touch nothing
scripts/stage-testnet-dbusdc.sh --confirm  # EXECUTE — republish + setup, write staged manifest
```

Under `--confirm` it: (1) republishes the package (fresh id — parameterizing `Q` changed
struct shapes, so this is a publish, not a compatible upgrade); (2) `init_treasury<DBUSDC>`;
(3) `set_is_localnet false` (K4); (4) registers the Qwen `ModelRecord` (no MOCK measurement on
testnet); (5) `create_market<M_GB10_QWEN35B>` (GB10, qwen3.6-35b, p99 30s); and (6) prints —
but defers — `set_deepbook_pool_id` (it needs the `Credit<M_GB10_QWEN35B>/DBUSDC` DeepBook pool,
the only DEEP-gated piece). Env overrides: `GIX_QWEN_MEASUREMENT`, `GIX_QWEN_WALRUS_BLOB_ID`,
`GIX_QWEN_MODEL_HASH`, `GIX_SCU_TOKENS`, `GIX_SLA_P99_MS`, `GIX_GAS_BUDGET`, `GIX_OUT`.
