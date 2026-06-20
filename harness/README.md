# GIX M1 — test-data streaming harness (`harness/`)

Off-chain TypeScript driver (workstream **B** of the
[MVP M1 integration contract](../docs/mvp-m1-integration-contract.md)) that
streams **synthetic order flow** through the on-chain `gix` exchange so the whole
project can be tested and demoed end-to-end:

> synthetic orders → match (M1 stub) → `Job` + USDC escrow → mock attestation →
> settle / refund / slash — all observable, with a live running tally.

It runs in two modes:

- **`--dry-run`** — no chain; an in-memory state machine simulates the full
  lifecycle. This is what the unit tests and the offline demo use.
- **on chain** — builds PTBs with `@mysten/sui` against a localnet running the
  `gix` package (targets the documented entrypoints; see assumptions below).

## Quick start

```bash
cd harness
npm install

# Offline demo (built-in baseline scenario, no validator needed):
npm run stream -- --dry-run

# A specific scenario, dry-run:
npm run stream -- --scenario scenarios/fault-heavy.json --dry-run

# Unit tests (all dry-run / pure — hermetic):
npm test
```

On-chain run (once `contracts/` deploys and emits `deployment.json`):

```bash
npm run stream -- --scenario scenarios/baseline.json --deployment ../deployment.json
```

## CLI flags

| Flag | Meaning |
| --- | --- |
| `--scenario <path>` | scenario JSON (default: built-in `baseline`) |
| `--deployment <path>` | `deployment.json` (required on chain; synthetic in dry-run) |
| `--dry-run` | simulate the state machine in-memory, no chain |
| `--log <fmt>` | `pretty` \| `json` (NDJSON) \| `silent` (default `pretty`) |
| `--realtime` | pace orders to `orderRatePerSec` (live demo) |
| `--seed <n>` | override the scenario RNG seed (determinism) |

## File tree

```
harness/
  package.json            scripts: stream, test, typecheck
  tsconfig.json
  vitest.config.ts
  scenarios/              ready-made scenario JSONs (baseline / fault-heavy / high-throughput)
  src/
    cli.ts                entrypoint: parses flags, wires config→chain→orchestrator
    config/
      types.ts            Deployment + Scenario TS types (the two binding schemas)
      load.ts             JSON load + explicit validation, baseline fallback
      synthetic.ts        fabricated deployment for dry-run/tests
    scenarios/baseline.ts built-in baseline scenario (fallback)
    actors/
      actors.ts           provider/consumer actor state + bid/ask generation
      attestation.ts      mock-attestation producer + verdict prediction
      faults.ts           fault-class selection from scenario rates
    matcher/
      matcher.ts          Matcher interface + StubMatcher (M2 swaps in DeepBook)
    orchestrator/
      model.ts            Job/Bid/Ask/Match types + lifecycle enums
      economics.ts        fee + slash magnitudes + slash distribution (v1 defaults)
      drive.ts            JobRecord → MockAttestation (forces SLA timing per fault)
      orchestrator.ts     streams orders, drives each job to a terminal state
    chain/
      chain.ts            the Chain seam (dry-run vs on-chain)
      dryrun.ts           DryRunChain: in-memory state machine
      sui.ts              SuiChain: builds & submits real PTBs via @mysten/sui
      INTERFACE_ASSUMPTIONS.md   every on-chain ABI assumption to reconcile with A
    observability/
      events.ts           harness event surface (mirrors gix::events)
      tally.ts            running tally + summary renderer
      logger.ts           structured per-event logger (pretty / json)
    util/rng.ts           seedable deterministic PRNG + distribution sampler
  test/                   vitest: matcher, attestation, faults, tally, economics, config, e2e
```

## How it maps to the contract

- **Config layer** loads `deployment.json` (package/object IDs, `usdcType`,
  markets, accounts) and a scenario (order rate, #providers/#consumers, qty/price
  distributions, fault-injection rates). A built-in `baseline` runs before
  `examples/` exists.
- **Providers** faucet MOCK_USDC → `stake` (USDC bond) → `mint_credits` → post
  asks. On dispatch they produce a **mock attestation**, bent by the scenario's
  fault injection (skip → missing/`AttTimeout` slash; late → SLA slash; wrong
  output → invalid slash).
- **Consumers** hash a synthetic prompt → post bids.
- **Matcher (M1 stub)** pairs a bid with an ask and the orchestrator calls
  `create_job` directly. It is behind a `Matcher` interface so M2 drops in
  DeepBook fills without changing the orchestrator.
- **Orchestrator** streams at the configured rate and drives create → attest →
  settle/expire.
- **Observability** emits structured per-event logs and a live tally (orders,
  fills, jobs, settled, refunded, slashed, USDC escrowed/slashed). On chain it
  reconstructs events from tx effects (`gix::events`); in dry-run it synthesizes
  them. Both feed the *same* `Tally`.

## On-chain interface assumptions

The on-chain path targets the **documented target signatures** in the integration
contract (the `gix` package was pre-implementation at build time). Every concrete
ABI assumption — call targets, argument orders, the mock-measurement sentinel,
slash sizing, and two `deployment.json` schema gaps (`modelId`, `treasuryId`) — is
enumerated in [`src/chain/INTERFACE_ASSUMPTIONS.md`](src/chain/INTERFACE_ASSUMPTIONS.md).
That file is the single reconciliation checklist for integration against the real
`gix` package / `contracts/INTERFACE.md`.
