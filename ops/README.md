# GIX M1 — Ops & Demo Runbook (workstream C)

One-command, end-to-end demo of the GPU Inference Exchange (GIX) MVP "M1" on a
**local Sui network**: publish the `gix` package, fund synthetic test accounts,
stream synthetic orders through the market, and watch jobs **settle / refund /
slash** live — then render a run summary.

This directory is **workstream C** in the M1 split (see
[`../docs/mvp-m1-integration-contract.md`](../docs/mvp-m1-integration-contract.md)).
It is the *glue*: it does **not** own the contracts (workstream A, `contracts/`)
or the streamer (workstream B, `harness/`); it orchestrates them.

---

## TL;DR

```bash
# from the repo root
make demo                 # localnet + deploy + fund + stream baseline + summary
```

Other targets:

```bash
make localnet             # start an ephemeral localnet (+faucet), background
make deploy               # publish gix -> deployment.json  (needs localnet up)
make fund                 # create + fund test accounts (SUI gas + MOCK_USDC)
make demo SCENARIO=examples/scenarios/fault-heavy.json   # pick a scenario
make demo SUMMARY_MD=out/summary.md                       # also write Markdown
make check                # offline sanity checks (no localnet needed)
make clean                # stop localnet + remove ops/.run scratch
make clean-all            # clean + remove deployment.json
make localnet-status      # is the localnet up?
make localnet-reset       # full wipe + fresh genesis
make help                 # list all targets
```

---

## Prerequisites

| Tool | Version | Why | Check |
| --- | --- | --- | --- |
| `sui` | 1.73.x | localnet (`sui start`), publish, calls, faucet | `sui --version` |
| `jq`  | any | JSON parsing in the shell scripts | `jq --version` |
| `curl`| any | localnet liveness + faucet probes | `curl --version` |
| `node`| 18+ | run-summary renderer + (later) the harness | `node --version` |
| `npm` | bundled | runs the harness `stream` script | `npm --version` |

`make check` verifies the scripts/scenarios/fixtures themselves without a
localnet. The scripts also self-check prerequisites and print install hints when
something is missing.

> **No `sui-test-validator`.** This toolchain (sui 1.73) starts localnet with
> `sui start`, not the retired `sui-test-validator` binary. `localnet.sh` detects
> support for `sui start` and, if absent, prints manual start instructions and
> exits cleanly (graceful degradation) rather than failing opaquely.

---

## The demo flow (`make demo`)

`make demo` runs `ops/scripts/demo.sh`, which executes five steps. Each is also a
standalone target so you can run them piecemeal or re-run one.

```
1/5  localnet   sui start --force-regenesis --with-faucet   (background, pidfile)
2/5  deploy     run contracts/ deploy script -> deployment.json   (else fallback publish)
3/5  fund       new-address x(providers+consumers); faucet SUI; mint MOCK_USDC
4/5  stream     cd harness && npm run stream -- --scenario <scenario>
5/5  summary    node ops/scripts/run-summary.js  (console; optional Markdown)
```

### Exact commands the demo issues

```bash
# 1. localnet (ephemeral, wiped every run; RPC :9000, faucet :9123)
RUST_LOG=off sui start --force-regenesis --with-faucet      # background

# 2. deploy: delegates to contracts/scripts/deploy.sh if present, else:
sui client publish ./contracts --gas-budget 2000000000 --json   # fallback only

# 3. fund (per provider/consumer; counts come from the scenario)
sui client new-address ed25519 gix-provider-1
sui client faucet --address <addr> --url http://127.0.0.1:9123/gas
sui client call --package <pkg> --module mock_usdc --function mint \
  --args <amount> <addr> --gas-budget 200000000

# 4. stream (workstream B owns this; run from harness/)
cd harness && npm run stream -- --scenario examples/scenarios/baseline.json

# 5. summary
node ops/scripts/run-summary.js --input ops/.run/tally.json --format console
```

---

## What each piece does

### `ops/lib/common.sh`
Shared helpers sourced by every script: repo-path resolution, colored logging,
prerequisite checks (`require_base_tools`, `require_node`), localnet liveness
(`localnet_is_up`, `wait_for_localnet`), `sui` env wiring (`ensure_localnet_env`),
and **`deployment.json` discovery + schema validation** (`validate_deployment_json`).

### `ops/scripts/localnet.sh  {start|stop|reset|status}`
Manages an **ephemeral** localnet via `sui start --force-regenesis --with-faucet`.
`start` runs it in the background, records the PID under `ops/.run/localnet.pid`,
logs to `ops/.run/localnet.log`, and blocks until the RPC answers. `--foreground`
runs it attached. `reset` is stop+start (state is ephemeral, so that is a wipe).

### `ops/scripts/deploy.sh`
**Delegates to workstream A.** If `contracts/scripts/deploy.{sh,ts,js}` exists,
it runs it (A owns `deployment.json`). If not, it **falls back** to
`sui client publish` and synthesizes a *dev-only, clearly-labeled* `deployment.json`
so the loop still runs before A lands. Either way it validates the result against
the binding schema. `--force-fallback` skips A's script.

### `ops/scripts/fund.sh  [--providers N] [--consumers M]`
Creates (or reuses, by alias `gix-provider-*` / `gix-consumer-*`) test accounts,
funds them with localnet SUI via the faucet, mints **MOCK_USDC** into each via
`gix::mock_usdc::mint`, and writes the addresses into `deployment.json`'s
`accounts` block. If the `mock_usdc` module isn't present yet, it warns and leaves
accounts with SUI gas only (graceful degradation).

### `ops/scripts/run-summary.js`
Renders the streamer's end-of-run **tally** (orders, fills, jobs, settled,
refunded, slashed, USDC escrowed/settled/refunded/slashed, slash breakdown,
per-market) as a **console table and/or Markdown**. Reads a tally file
(`--input`), stdin (whole-JSON or NDJSON — last tally-shaped object wins), or
renders a zeroed template. See the schema in the file header.

### `ops/scripts/demo.sh`
The orchestrator described above. Degrades gracefully if `harness/` isn't built
yet: it completes deploy+fund and prints exactly what to run once B lands.

### `ops/scripts/check.sh`  (`make check`)
Offline CI smoke test: `bash -n` every script, `node --check` the renderer,
validate every scenario's JSON + required keys, validate fixtures (JSON + JSONL),
and render a sample tally. No localnet required.

---

## Scenarios & fixtures

- **`examples/scenarios/*.json`** — `baseline`, `fault-heavy`, `high-throughput`.
  Schema + field docs: `examples/scenarios/scenario.schema.json`. Each sets order
  rate, #providers, #consumers, qty/price distributions, and **fault-injection
  rates** (`skipAttest` → missing, `lateAttest` → SLA, `wrongOutput` → invalid,
  `consumerAbandon` → forfeit+refund).
- **`examples/fixtures/prompts.jsonl`** — 25 synthetic prompts with token-count
  hints (short Q&A → long-context), for the streamer to attach to orders.
- **`examples/fixtures/latency-profiles.json`** — per-market SCU / SLA (p50/p99) /
  lifecycle deadlines (C1) / latency model, so simulated providers produce
  realistic timings and the harness can decide missing-vs-late attestation.
  Schema: `examples/fixtures/latency-profiles.schema.json`.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `required command not found: sui` | Install Sui 1.x; ensure it's on `PATH`. |
| `localnet did not come up within Ns` | Check `ops/.run/localnet.log`; raise timeout: `make localnet LOCALNET_ARGS="--timeout 180"`. |
| `deployment.json not found` | Run `make deploy` (which needs `make localnet` first). |
| `0 markets in deployment.json` | A hasn't created markets yet, or fallback publish ran. The stream has nothing to trade until A's `create_market` runs. |
| `MOCK_USDC NOT minted` | `gix::mock_usdc` isn't in the published package yet (A not built). Accounts still get SUI gas. |
| `harness/ not built yet` | Workstream B not landed; deploy+fund still complete. Run the stream manually once `harness/package.json` exists. |
| Port already in use | A stray localnet is running: `make localnet-stop` (or `make clean`). |

## Files this layer generates (all under scratch, gitignored)

- `deployment.json` (repo root) — the network manifest (A's, or fallback). `make clean-all` removes it.
- `ops/.run/localnet.{pid,log}` — localnet process state.
- `ops/.run/publish.json`, `publish.err`, `mint.err` — deploy/fund transcripts.
- `ops/.run/stream.log`, `tally.json` — streamer output + recovered tally.
