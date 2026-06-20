# On-chain interface — reconciliation checklist (B ↔ A)

Status note: the `gix` Move package (workstream A) landed its module set
**during** this harness build. The on-chain path in `src/chain/sui.ts` was
therefore reconciled against the **actual** `contracts/sources/*.move`
signatures (marked "Verified ABI" below) rather than only the integration-contract
sketch. A handful of items still need confirmation against the *deploy script's*
`deployment.json` output and the *final* settlement routing. Each is enumerated
here. The dry-run path and the orchestrator above the `Chain` seam are
ABI-agnostic and need no change.

## Verified against `contracts/sources` (already reconciled in `sui.ts`)

- **Faucet** — `mock_usdc::mint(faucet: &mut Faucet, amount, recipient, ctx)` and
  `mock_usdc::mint_and_return(faucet, amount, ctx): Coin<MOCK_USDC>`. There is a
  shared `Faucet` object; the harness uses `mint_and_return` to compose the bond
  coin inside a PTB and `mint` to fund consumers.
- **`stake`** — `staking::stake(cap: &ProviderCap, cfg: &Config, bond:
  Coin<MOCK_USDC>, capacity_scu: u64, ctx): ProviderStake`. Matches.
- **`mint_credits`** — `staking::mint_credits<M>(cap, stake: &mut ProviderStake,
  cfg: &Config, market: &mut Market<M>, qty, ctx): Coin<Credit<M>>`. NOTE it lives
  in `staking` (not `credit`), takes `cfg`, and the `Market<M>` is **mutable**.
- **`create_job`** — `job::create_job<M>(cfg, market: &Market<M>, stake: &mut
  ProviderStake, provider: address, credits: Coin<Credit<M>>, escrow_in:
  Coin<MOCK_USDC>, input_hash: vector<u8>, clk, ctx): ID`. NOTE: it **returns the
  Job's `ID`** (and shares the `Job<M>` itself), takes a **`&mut ProviderStake`**,
  and reads `model_id` from the market internally — so the earlier "deployment
  must carry modelId for create_job" gap is **resolved**; create_job needs no
  model id. `Market`/`Job`/`Credit` are all generic over the market witness `M`.
- **`submit_mock_attestation`** — `attestation::submit_mock_attestation<M>(job:
  &mut Job<M>, cfg, market: &Market<M>, model: &ModelRecord, allow:
  &MeasurementAllowlist, runtime_measurement, output_hash, output_token_count,
  t_start, t_end, clk, ctx)`. It is **generic over M**, needs `cfg`, the
  `ModelRecord`, and the `MeasurementAllowlist`, and asserts `cfg.is_localnet()`
  before accepting the mock measurement (decision K4, layer 1). It records the
  VALID / SLA_BREACH / INVALID verdict on the Job.
- **`settle` / `expire_and_resolve`** — `settlement::settle<M>(job, market: &mut
  Market<M>, cfg, stake: &mut ProviderStake, treasury: &mut Treasury, ctx)` (no
  clock) and `settlement::expire_and_resolve<M>(job, &mut market, cfg, stake,
  treasury, clk, ctx)`. Both need a shared **`Treasury`** and a **mutable**
  `Market<M>`.

## Still to confirm

1. **Settlement routing for a *failing* attestation.** `submit_mock_attestation`
   records an INVALID / SLA_BREACH verdict on the Job, but `settle<M>` asserts
   `state == Verified`. So a faulted-but-attested job is **not** settled by
   `settle` — `settlement.move` exposes a `resolve_attested<M>(...)` (or similar)
   that drives the refund+slash path. `sui.ts#resolve` currently calls `settle`
   for all attested jobs; **wire `resolve_attested` for the non-VALID verdict
   case** once its exact name/args are confirmed. (Dry-run already routes
   INVALID/SLA correctly; only the on-chain call target needs this split.)

2. **The mock measurement sentinel.** The harness emits `MOCK-MEASUREMENT-V1`
   (UTF-8 → hex) as `runtime_measurement`. The localnet `MeasurementAllowlist`
   must have **this exact value** allowlisted for the job's model (the deploy /
   bootstrap step must `add_measurement` it), or the mock verdict is INVALID.
   *Confirm the value the contract's localnet bootstrap allowlists, and align.*

3. **`ProviderCap` resolution.** `registry::register_provider` mints a
   `ProviderCap` to the operator. `sui.ts#resolveProviderCap` uses a placeholder
   id; the production client must `getOwnedObjects(owner, type=ProviderCap)`.
   *Confirm whether the deploy script pre-registers `deployment.accounts.providers`.*

4. **Consumer MOCK_USDC for escrow.** `sui.ts#splitEscrowCoin` currently splits
   from `tx.gas` as a structural placeholder. The production path must
   `getCoins(consumer, usdcType)`, merge, then split exactly `qty*price`. (The
   consumer is faucet-funded in `setupConsumer`.)

## `deployment.json` schema — extra ids the verified ABI requires

The deploy script (A is the source of truth; C's `ops/scripts/deploy.sh`
delegates to it) must surface these object ids so the harness can build PTBs.
`sui.ts` reads them from these **optional top-level fields** and errors clearly if
absent on an on-chain run:

- `faucetId` — the shared `mock_usdc::Faucet`.
- `treasuryId` — the shared `settlement::Treasury`.
- `allowlistId` — the shared `governance::MeasurementAllowlist`.
- `modelRecordId` (or per-market `markets[].modelId`) — the `registry::ModelRecord`
  bound to each market (needed by `submit_mock_attestation`).
- (optional) `markets[].deepbookPoolId` — unused in M1; needed for the M2 DeepBook
  matcher.

The harness **tolerates** `markets: []` and an absent `accounts` block (C's
fallback deploy mode emits these before A's `create_market` is wired) — it loads
the deployment and reports "nothing to trade" at runtime rather than failing.

## Economic assumptions (mirrored in `src/orchestrator/economics.ts`)

- **Protocol fee = 30 bps** (`config.move protocol_fee_bps = 30`).
- **Slash magnitudes (decision B4)** — missing (`AttTimeout`) = 100% of bond
  share; invalid = 100% of bond share + flat penalty (harness uses a 1 USDC flat
  penalty — *confirm the contract constant*); SLA breach = graded 10–50% (harness
  uses 30%); liveness/ack = ~2–5% (harness uses 3%). "**bond share**" is assumed
  `min(escrowUsdc, providerBondUsdc)` — *confirm how `slashing.move` sizes it*.
- **Slash distribution (decision D1)** — consumer up to 100% of job value → rest
  to treasury → burn = 0. The harness reads actual `to_consumer`/`to_treasury`
  from the `Slashed` event when on chain.

## Event surface (mirrored in `src/observability/events.ts`)

`gix::events` emits `Staked`, `CreditsMinted`, `JobCreated`, `Dispatched`,
`AttestationSubmitted`, `Settled`, `Refunded`, `Slashed`, `Expired`. The harness
maps the move-event `type` suffix to its event names and reads `parsedJson`
fields (`job_id`, `provider`, `consumer`, `market_id`, plus amount fields). M1
reconstructs events from per-tx `showEvents` effects; a streaming subscription is
the M2 optimization. *Confirm the exact amount field names per event struct
(e.g. `payout`/`fee` on `Settled`, `penalty`/`to_consumer`/`to_treasury` on
`Slashed`).*
