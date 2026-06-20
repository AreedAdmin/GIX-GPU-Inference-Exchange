# MVP M1 — Integration Contract (BINDING for parallel build)

This file is the **shared interface** the three M1 workstreams build against so they
integrate cleanly:

- **A — contracts/** (on-chain `gix` Move package + localnet deploy)
- **B — harness/** (TypeScript test-data streaming driver)
- **C — ops/ + examples/** (localnet bootstrap, synthetic fixtures, run orchestration)

Canon: [architecture/overview.md](architecture/overview.md),
[architecture/sui-move-contracts.md](architecture/sui-move-contracts.md) §1–10,
[protocol/task-lifecycle.md](protocol/task-lifecycle.md), and the **Batch-decision
table** in [open-ended-questions.md](open-ended-questions.md) (authoritative for all
v1 defaults). **A is the source of truth for final signatures**; if A must deviate from
the signatures below, it records the final shape in `contracts/README.md` and the
integrator reconciles B/C.

## Scope of M1
A **functional `Credit/USDC` market exchange on localnet**, driven by **mock
attestation**, that you can **stream synthetic data through** end-to-end:
synthetic orders → match (stubbed in M1) → `Job` + USDC escrow → mock attestation →
settle / refund / slash — all observable. Real DeepBook + Walrus + TDX are M2–M3.

## v1 invariants every workstream honors
- **Bonds are USDC** (`ProviderStake` holds `Balance<MOCK_USDC>` on localnet). No GIX token.
- **Governance = `AdminCap`/multisig** (no token voting).
- **Reserve-then-burn** credits (reserve into `Job` at creation, burn at `Settled`, release on no-fault refund).
- **Mock attestation verifier lives behind `#[test_only]` / a dev-only module** and can never be on a non-localnet allowlist (decision K4).
- **Slash magnitudes (B4):** invalid attestation = 100% of job bond share + flat penalty; missing = 100% of bond share; SLA breach = graded 10–50%; liveness = ~2–5% + reputation.
- **Slash split (D1):** compensate harmed consumer up to 100% of job value → remainder to treasury → burn = 0.
- **SCU metering (E1):** 1 SCU = N output tokens at the tier; attestation binds `output_token_count` alongside `output_hash`.

## A → world: dev coin + key entrypoints (target signatures)
Localnet has no real USDC, so A defines a dev coin:

- **`gix::mock_usdc::MOCK_USDC`** — 6 decimals. Public faucet for tests/bootstrap:
  `public fun mint(amount: u64, recipient: address, ctx: &mut TxContext)` (unrestricted on localnet; clearly dev-only).

Core public entrypoints (USDC = `MOCK_USDC` in M1), aligned with sui-move-contracts.md §5:
```
// staking (USDC bond)
public fun stake(cap: &ProviderCap, cfg: &Config, bond: Coin<MOCK_USDC>, capacity_scu: u64, ctx): ProviderStake
public fun unstake(cap: &ProviderCap, stake: &mut ProviderStake, amount: u64, clk: &Clock, ctx): Coin<MOCK_USDC>
public fun mint_credits<M>(cap: &ProviderCap, stake: &mut ProviderStake, market: &Market, qty: u64, ctx): Coin<Credit<M>>

// market / governance (AdminCap-gated)
public fun create_market<M>(_: &AdminCap, cfg: &Config, scu_tokens: u64, sla_p99_ms: u64, ctx): Market   // shared

// job + escrow  (M1 may create the Job directly from a (provider, consumer, qty, price) tuple — the "stubbed match")
public fun create_job<M>(cfg, market: &Market, provider: address, credits: Coin<Credit<M>>, escrow_in: Coin<MOCK_USDC>, input_hash: vector<u8>, model_id: ID, clk: &Clock, ctx): Job  // shared

// attestation (MOCK in M1) + settlement
public fun submit_mock_attestation(job: &mut Job, market: &Market, runtime_measurement: vector<u8>, output_hash: vector<u8>, output_token_count: u64, t_start: u64, t_end: u64, clk: &Clock, ctx)
public fun settle<M>(job: &mut Job, market: &Market, cfg: &Config, stake: &mut ProviderStake, treasury: &mut Treasury, clk: &Clock, ctx)
public fun expire_and_resolve<M>(job: &mut Job, market: &Market, cfg: &Config, stake: &mut ProviderStake, treasury: &mut Treasury, clk: &Clock, ctx)  // deadline miss → refund (+ slash if provider fault)
```
Exact arg lists may shift — **the names, the USDC-bond shape, and the lifecycle states are fixed**.

## A → C/B: `deployment.json` (A's deploy script emits this at repo root or ops/)
```json
{
  "network": "localnet",
  "packageId": "0x...",
  "configId": "0x...",
  "adminCapId": "0x...",
  "usdcType": "0x...::mock_usdc::MOCK_USDC",
  "clockId": "0x6",
  "markets": [
    { "id": "0x...", "name": "H100-llama3.1-8b-int8", "creditType": "0x...::markets::M_H100_LLAMA8B", "scuTokens": 1000, "slaP99Ms": 5000 }
  ],
  "accounts": { "admin": "0x...", "providers": ["0x..."], "consumers": ["0x..."] }
}
```

## Lifecycle event surface (A emits; B/C observe via `sui` events)
`gix::events` emits structured events for: `MarketCreated`, `Staked`, `CreditsMinted`,
`JobCreated`, `Dispatched`, `AttestationSubmitted`, `Settled`, `Refunded`, `Slashed`.
Each carries `job_id` / `provider` / amounts so the streamer can render the flow.

## B (harness) contract
- Reads `deployment.json` + a **scenario config** (`examples/scenarios/*.json`): order rate,
  #providers, #consumers, qty/price distributions, **fault-injection rates** (skip-attest,
  late-attest, wrong-output → exercise missing/SLA/invalid slashes).
- Builds PTBs with `@mysten/sui` to: faucet MOCK_USDC, stake, mint credits, create jobs,
  submit mock attestations, settle/expire — at the configured rate.
- Streams structured logs + a running tally (orders, fills, jobs, settled, refunded, slashed,
  $ escrowed, $ slashed). Has a **dry-run mode** (no chain) for its own unit tests.
- Entry: `npm run stream -- --scenario examples/scenarios/baseline.json`.

## C (ops/fixtures) contract
- `ops/`: localnet bootstrap (`sui` localnet start/stop), wrapper that runs A's deploy,
  account creation + MOCK_USDC funding, and a top-level `Makefile`/npm scripts:
  `make localnet`, `make deploy`, `make demo` (deploy + run baseline scenario).
- `examples/scenarios/*.json`: synthetic scenarios (baseline, fault-heavy, high-throughput).
- `examples/fixtures/`: synthetic prompt/input datasets + a mock latency/SLA profile per
  market so simulated providers produce realistic timings.
- A console/markdown **run summary** renderer for the streamer's tally.

## Definition of done (M1)
- A: `sui move build` + `sui move test` green; all lifecycle + fault paths covered; deploy script emits `deployment.json`.
- B: `npm run stream` drives the documented flow; dry-run unit tests pass.
- C: `make demo` deploys to localnet and runs the baseline scenario end-to-end.
- Integration (owner: orchestrator): one command streams synthetic orders and you watch jobs settle/refund/slash live.
