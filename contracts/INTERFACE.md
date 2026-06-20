# GIX — FINAL on-chain interface (`gix` package)

This file records the **as-built** public entrypoint signatures and the **deviations** from
[`docs/mvp-m1-integration-contract.md`](../docs/mvp-m1-integration-contract.md) and
[`docs/demo-milestone-contract.md`](../docs/demo-milestone-contract.md) that the integrators
(node D0, harness/SDK, ops) must reconcile. Where this file and either contract disagree,
**this file wins** (D1 is the source of truth for final signatures).

- Sui CLI built/tested against: **1.73.1**. Move edition **2024**. (`sui move build/test`
  require `--build-env testnet` or `--build-env mainnet`; localnet deps are resolved at
  publish time via `test-publish`.)
- `sui move build`: green (no warnings). `sui move test`: **32/32 passing** (15 M1 +
  5 soft-attestation + 6 shared-Ask order-book + 6 M2 DeepBook-fill). See §"Soft
  attestation" for the signed path, §"Shared-Ask order book (two-account flow)" for the
  buyer≠seller path, and §"M2 — DeepBook fill jobs (Option B, pay-at-match)" for the new
  no-escrow / refund-from-slash fill path + Walrus blob-id fields.
- Dev quote/escrow/bond coin: **`gix::mock_usdc::MOCK_USDC`** (6 decimals).
- Per-market credit witness for M1: **`gix::markets::M_H100_LLAMA8B`** → coin type
  `gix::credit::Credit<gix::markets::M_H100_LLAMA8B>`.

---

## Module list (15 published modules)

`config`, `events`, `mock_usdc`, `registry`, `credit`, `market`, `markets`, `staking`,
`ask`, `escrow`, `job`, `attestation`, `slashing`, `settlement`, `governance`.

> New in this revision: **`ask`** — the first brick of the on-chain order book (a hand-rolled
> mini-DeepBook). It defines the shared resting-maker-order object `Ask<phantom M>`. Posted
> by `staking::post_ask`, filled by `job::create_job_from_ask`. See
> §"Shared-Ask order book (two-account flow)".

> Note: error codes are declared as **per-module `const`s** (namespaced by decade, e.g.
> `4xx` = job/escrow), not a single shared `errors` module — this is required for clean
> `#[expected_failure(abort_code = module::ECONST)]` matching. The numeric code catalog is
> unchanged from the design doc §10.

---

## Final public entrypoint signatures

### Dev coin — `gix::mock_usdc`
```move
public fun mint(faucet: &mut Faucet, amount: u64, recipient: address, ctx: &mut TxContext)
public fun mint_and_return(faucet: &mut Faucet, amount: u64, ctx: &mut TxContext): Coin<MOCK_USDC>
public fun decimals(): u8
```
`Faucet` is a shared object wrapping the `TreasuryCap<MOCK_USDC>` (created in `init`); its id
is in `deployment.json` as `faucetId`. The faucet is dev-only/unrestricted (localnet).

### Registry — `gix::registry`
```move
// CHANGED for soft attestation: takes &Config + a 32-byte Ed25519 attest_pubkey; operator
// is ctx.sender() (the old `operator: address` first arg is removed). Aborts EBadPubkeyLen
// (205) unless attest_pubkey is exactly 32 bytes. Shares a ProviderRecord carrying the key.
public fun register_provider(cfg: &Config, endpoint: vector<u8>, gpu_class: vector<u8>, attest_pubkey: vector<u8>, ctx: &mut TxContext): ProviderCap
public fun register_model(_: &AdminCap, cfg: &Config, model_uri: vector<u8>, walrus_blob_id: vector<u8>, model_hash: vector<u8>, ctx: &mut TxContext): ID   // shares ModelRecord
public fun add_measurement(_: &AdminCap, cfg: &Config, allow: &mut MeasurementAllowlist, model_id: ID, measurement: vector<u8>)
public fun remove_measurement(_: &AdminCap, allow: &mut MeasurementAllowlist, model_id: ID, measurement: vector<u8>)
public fun is_allowed(allow: &MeasurementAllowlist, model_id: ID, measurement: &vector<u8>): bool
public fun is_mock_measurement(measurement: &vector<u8>): bool
// ProviderRecord reads (shared object; pass the record to submit_signed_attestation):
public fun provider_operator(record: &ProviderRecord): address
public fun provider_endpoint(record: &ProviderRecord): vector<u8>
public fun provider_gpu_class(record: &ProviderRecord): vector<u8>
public fun provider_attest_pubkey(record: &ProviderRecord): vector<u8>   // 32-byte Ed25519 key
```

### Market — `gix::market`
```move
public fun create_market<M>(_: &AdminCap, cfg: &Config, name: vector<u8>, gpu_class: vector<u8>, model_id: ID, scu_tokens: u64, sla_p99_ms: u64, ctx: &mut TxContext): ID   // shares Market<M>
public fun set_active<M>(_: &AdminCap, market: &mut Market<M>, active: bool)
public fun set_fee_tier_bps<M>(_: &AdminCap, market: &mut Market<M>, bps: u64)
public fun set_sla<M>(_: &AdminCap, market: &mut Market<M>, p99_ms: u64, ack_ms: u64, exec_ms: u64, attest_ms: u64)
// NEW (M2): bind/rebind the shared DeepBook Pool<Credit<M>,USDC> id this market trades on.
// AdminCap-gated governance setter. ADDITIVE field `deepbook_pool_id: Option<ID>` on
// Market<M> (none on a fresh market). The on-chain contract NEVER calls DeepBook — this is a
// published pointer the consumer SDK reads to discover the canonical pool, and the anchor for
// the (DEFERRED) fill-provenance / PoA checks. Stored as `ID`, so the package takes NO
// DeepBook Move dependency. `create_job_from_fill` aborts `ENoPool` (202) if it is unset.
public fun set_deepbook_pool_id<M>(_: &AdminCap, market: &mut Market<M>, pool_id: ID)
public fun deepbook_pool_id<M>(market: &Market<M>): Option<ID>
public fun has_deepbook_pool<M>(market: &Market<M>): bool
```

### Staking (USDC bond) — `gix::staking`
```move
public fun stake(cap: &ProviderCap, cfg: &Config, bond: Coin<MOCK_USDC>, capacity_scu: u64, ctx: &mut TxContext): ProviderStake
public fun add_bond(cap: &ProviderCap, stake: &mut ProviderStake, bond: Coin<MOCK_USDC>, extra_capacity_scu: u64)
public fun unstake(cap: &ProviderCap, stake: &mut ProviderStake, amount: u64, clk: &Clock, ctx: &mut TxContext): Coin<MOCK_USDC>
public fun mint_credits<M>(cap: &ProviderCap, stake: &mut ProviderStake, cfg: &Config, market: &mut Market<M>, qty: u64, ctx: &mut TxContext): Coin<Credit<M>>
// NEW (order book): mint `qty_scu` Credit<M> against free capacity and move them into a NEW
// shared Ask<M> priced at `price_usdc_per_scu`. Provider-signed (holds ProviderCap). Same
// capacity accounting as mint_credits (bumps minted_scu, gated at capacity_scu; emits
// CreditsMinted). Emits AskPosted. Returns the new Ask's ID. `market` is &mut (the credit
// Supply lives in the Market). No maker bond beyond the existing stake (E3).
public fun post_ask<M>(cap: &ProviderCap, stake: &mut ProviderStake, cfg: &Config, market: &mut Market<M>, qty_scu: u64, price_usdc_per_scu: u64, ctx: &mut TxContext): ID   // shares Ask<M>
```

### Order book (shared Ask) — `gix::ask`
```move
// Shared resting maker order. Created/shared by staking::post_ask; drawn down by
// job::create_job_from_ask. The credits inside are pre-minted real supply.
public struct Ask<phantom M> has key {
    id: UID,
    version: u64,
    provider: address,                 // seller — payout + slash target at settlement
    market_id: ID,                     // must match the Market<M> a job is created in
    credits: Balance<Credit<M>>,       // remaining offered capacity, as a Balance
    price_usdc_per_scu: u64,           // quoted price; escrow must cover qty * this
    remaining_scu: u64,                // == balance::value(credits); decrements on each fill
}
// Reads (no public constructor/draw — those are package-internal, driven by staking/job):
public fun provider<M>(ask: &Ask<M>): address
public fun market_id<M>(ask: &Ask<M>): ID
public fun price_usdc_per_scu<M>(ask: &Ask<M>): u64
public fun remaining_scu<M>(ask: &Ask<M>): u64
public fun credits_value<M>(ask: &Ask<M>): u64
// Error codes: EZeroQty = 405, EInsufficientRemaining = 406 (over-draw qty > remaining).
```

### Job + escrow — `gix::job`
```move
// BACK-COMPAT single-account path (buyer must own the provider's minted Coin<Credit<M>>):
public fun create_job<M>(cfg: &Config, market: &Market<M>, stake: &mut ProviderStake, provider: address, credits: Coin<Credit<M>>, escrow_in: Coin<MOCK_USDC>, input_hash: vector<u8>, clk: &Clock, ctx: &mut TxContext): ID   // shares Job<M>
// NEW two-account path (buyer ≠ seller): consumer-signed taker fill of a resting shared Ask.
// Asserts ask.market_id == market.market_id (EWrongMarket = 408), qty_scu > 0, and
// escrow.value() >= qty_scu * ask.price_usdc_per_scu (EInsufficientEscrow = 407). Over-draw
// (qty_scu > ask.remaining_scu) aborts inside ask::draw (ask::EInsufficientRemaining = 406).
// Draws qty_scu credits OUT of the shared ask, locks escrow, shares a Job bound to
// ask.provider (consumer = ctx.sender()), advances to Dispatched, decrements
// ask.remaining_scu, emits JobCreated + Dispatched. Returns the new Job's ID. The Job's
// price_usdc = the FULL escrow value (overpay rides along to the provider at settle).
// NO ProviderStake / ProviderCap in scope — the consumer touches only the shared Ask.
public fun create_job_from_ask<M>(cfg: &Config, market: &Market<M>, ask: &mut Ask<M>, qty_scu: u64, escrow_in: Coin<MOCK_USDC>, input_hash: vector<u8>, clk: &Clock, ctx: &mut TxContext): ID   // shares Job<M>
public fun ack<M>(job: &mut Job<M>, clk: &Clock, ctx: &TxContext)

// NEW (M2 — DeepBook fill, Option B / pay-at-match). CONSUMER-SIGNED. In the SAME PTB the
// consumer swaps USDC→Coin<Credit<M>> on the market's DeepBook pool (which PAYS THE PROVIDER
// USDC AT THE FILL, off-chain to GIX), then feeds the returned credits in here. There is NO
// USDC escrow object (the provider was already paid); the Job carries the reserved credit
// only. `price_usdc` is recorded as `scu_qty` (the per-job value-at-risk that caps the
// consumer's refund-from-slash). Reserve-then-burn intact (credits burned at `settle_fill`);
// does NOT bump reserved_scu (consumer can't reach the stake — same as the Ask path). Records
// the Walrus `input_blob_id` COMMITMENT alongside `input_hash` (the sha2_256 verification
// primitive). Requires a bound DeepBook pool (aborts market::ENoPool=202 otherwise); asserts
// scu_qty>0 (EZeroQty=405), market active, not paused. Advances to Dispatched; emits
// JobCreated + Dispatched. Returns the new Job's ID.
//
// Provider assignment (M2 demo): a SINGLE provider serves the market (the GB10), so the
// caller passes that provider's shared ProviderRecord and the Job binds to its operator.
// MULTI-PROVIDER trustless dispatch (resolving the filled maker_balance_manager_id→owner()
// and proving credit provenance) is DEFERRED — see §"DEFERRED (M2)".
public fun create_job_from_fill<M>(cfg: &Config, market: &Market<M>, provider_rec: &ProviderRecord, credits: Coin<Credit<M>>, input_blob_id: u256, input_hash: vector<u8>, clk: &Clock, ctx: &mut TxContext): ID   // shares Job<M>

// NEW (M2) Job reads (Walrus blob-id commitments + fill flag; all ADDITIVE):
public fun job_is_fill<M>(job: &Job<M>): bool          // true ⇒ no escrow, provider paid at fill
public fun job_input_blob_id<M>(job: &Job<M>): u256    // Walrus input (prompt) blob, 0 = none
public fun job_output_blob_id<M>(job: &Job<M>): u256   // Walrus output (completion) blob, 0 = none
public fun job_quote_blob_id<M>(job: &Job<M>): u256    // Walrus attestation-quote blob, 0 = none
// job_escrow_value<M> now returns 0 for a fill-job (no escrow) instead of aborting.
```

### Attestation — `gix::attestation`
```move
// MOCK path (localnet-only, no signature). Unchanged. Gated by cfg.is_localnet() + a
// MOCK-prefixed measurement (K4). Kept so M1/M1.5 demos still pass.
public fun submit_mock_attestation<M>(
    job: &mut Job<M>, cfg: &Config, market: &Market<M>, model: &ModelRecord, allow: &MeasurementAllowlist,
    runtime_measurement: vector<u8>, output_hash: vector<u8>, output_token_count: u64,
    t_start: u64, t_end: u64, clk: &Clock, ctx: &TxContext)

// SIGNED path (off-localnet-safe soft attestation). Verifies a native Ed25519 signature
// over the canonical message (see §"Soft attestation") against provider_rec's registered
// pubkey, then runs the SAME verdict engine + records the verdict. NO is_localnet gate.
// CHANGED (M2): gained `output_blob_id: u256` + `quote_blob_id: u256` (Walrus COMMITMENTS for
// the completion blob and the attestation-quote blob), inserted after `signature` and before
// `clk`. These are NOT part of the signed canonical message (the §"Soft attestation" byte
// layout is UNCHANGED — the signature binds the sha2_256 output_hash, not the blob id), so
// existing node signatures stay valid. Pass 0 for either when no Walrus blob applies. They are
// recorded on the Job (output_blob_id) and on the AttestationRecord (quote_blob_id) alongside
// the sha2_256 hashes, which remain the verification primitive.
public fun submit_signed_attestation<M>(
    job: &mut Job<M>, cfg: &Config, market: &Market<M>, model: &ModelRecord, allow: &MeasurementAllowlist,
    provider_rec: &ProviderRecord,
    runtime_measurement: vector<u8>, input_hash: vector<u8>, output_hash: vector<u8>,
    output_token_count: u64, t_start: u64, t_end: u64,
    signature: vector<u8> /*ed25519, 64B*/, output_blob_id: u256, quote_blob_id: u256,
    clk: &Clock, ctx: &TxContext)

// Canonical-message + hash helpers (also callable off-chain by tooling/tests):
public fun build_attestation_message(job_id: ID, runtime_measurement: &vector<u8>, input_hash: &vector<u8>, output_hash: &vector<u8>, output_token_count: u64, t_start: u64, t_end: u64): vector<u8>
public fun sha2_256(data: vector<u8>): vector<u8>
public fun verdict<M>(job: &Job<M>): u8
```

### Settlement (+ Treasury) — `gix::settlement`
```move
// ESCROW jobs (create_job / create_job_from_ask). `settle`/`resolve_attested` now abort
// EWrongJobKind=409 on a fill-job (route fill-jobs to settle_fill/resolve_fill).
public fun settle<M>(job: &mut Job<M>, market: &mut Market<M>, cfg: &Config, stake: &mut ProviderStake, treasury: &mut Treasury, ctx: &mut TxContext)
public fun resolve_attested<M>(job: &mut Job<M>, market: &mut Market<M>, cfg: &Config, stake: &mut ProviderStake, treasury: &mut Treasury, ctx: &mut TxContext)
// expire_and_resolve + cancel handle BOTH kinds: for a fill-job the escrow leg is a zero
// drain, so the consumer's compensation comes purely from the slash (refund-from-slash).
public fun expire_and_resolve<M>(job: &mut Job<M>, market: &mut Market<M>, cfg: &Config, stake: &mut ProviderStake, treasury: &mut Treasury, clk: &Clock, ctx: &mut TxContext)
public fun cancel<M>(job: &mut Job<M>, cfg: &Config, stake: &mut ProviderStake, ctx: &mut TxContext)
public fun withdraw_treasury(_: &AdminCap, treasury: &mut Treasury, amount: u64, recipient: address, ctx: &mut TxContext)

// NEW (M2) — FILL jobs (create_job_from_fill, Option B / pay-at-match). NO escrow.
// `settle_fill`: Verified fill-job → pays NOTHING extra, moves NO USDC (provider already paid
// at the match); burns the reserved credit + consume_minted → Settled (emits Settled with
// payout=0, fee=0). Note: NO `treasury` arg (no fee leg). Aborts EWrongJobKind=409 on an
// escrow job, ENotVerified=402 unless Verified.
public fun settle_fill<M>(job: &mut Job<M>, market: &mut Market<M>, cfg: &Config, stake: &mut ProviderStake, ctx: &mut TxContext)
// `resolve_fill`: attested-but-failing fill-job → there is no escrow to refund, so the
// consumer is compensated ENTIRELY from the provider's slash (refund-from-slash, capped at
// price_usdc = scu_qty value-at-risk; remainder → treasury). Aborts EWrongJobKind=409 on an
// escrow job. Same verdict→fault routing as resolve_attested.
public fun resolve_fill<M>(job: &mut Job<M>, market: &mut Market<M>, cfg: &Config, stake: &mut ProviderStake, treasury: &mut Treasury, ctx: &mut TxContext)
```

### Governance (bootstrap convenience) — `gix::governance`
```move
public fun register_model_with_measurement(cap: &AdminCap, cfg: &Config, allow: &mut MeasurementAllowlist, model_uri: vector<u8>, walrus_blob_id: vector<u8>, model_hash: vector<u8>, measurement: vector<u8>, ctx: &mut TxContext): ID
public fun migrate(cap: &AdminCap, cfg: &mut Config)
```

### Config / governance setters — `gix::config`
```move
public fun set_pause(_: &AdminCap, cfg: &mut Config, paused: bool)
public fun set_protocol_fee_bps(_: &AdminCap, cfg: &mut Config, bps: u64)
public fun set_k(_: &AdminCap, cfg: &mut Config, num: u64, den: u64)
public fun set_min_stake(_: &AdminCap, cfg: &mut Config, min_stake: u64)
public fun set_slash_bps(_: &AdminCap, cfg: &mut Config, invalid: u64, missing: u64, sla: u64, liveness: u64)
public fun set_flat_penalty_invalid(_: &AdminCap, cfg: &mut Config, flat: u64)
public fun set_is_localnet(_: &AdminCap, cfg: &mut Config, is_localnet: bool)   // K4 deploy gate
```

---

## Soft attestation — signed path (D1 authoritative; node D0 MUST match byte-for-byte)

The off-localnet trust path: register the provider's Ed25519 attestation key once, verify a
native signature per job. Verification is
`sui::ed25519::ed25519_verify(&signature, &provider_rec.attest_pubkey, &msg)` where `msg` is
the canonical message below. On a valid signature the SAME verdict engine as the mock path
runs (measurement allowlisted for the job's model, model active + matching, output_hash
non-empty, latency ≤ market p99); settlement routing is unchanged (`VALID → settle`, else
`resolve_attested`).

### Canonical attestation message — EXACT byte layout

The contract reconstructs these bytes in `attestation::build_attestation_message` and the
node MUST sign exactly this byte string. Order and widths:

```
msg = "GIX_ATTEST_V1"            // 13 ascii bytes (0x4749585f4154544553545f5631), domain sep
    ‖ job_id                     // 32 bytes — the Job object id, RAW (id.to_bytes() = BCS of
    //                              the address = 32 bytes, NO length prefix)
    ‖ runtime_measurement        // the allowlisted measurement bytes, verbatim, variable len,
    //                              NO length prefix
    ‖ input_hash                 // 32 bytes = sha2_256(prompt_utf8)
    ‖ output_hash                // 32 bytes = sha2_256(completion_utf8)
    ‖ u64_le(output_token_count) // 8 bytes, little-endian
    ‖ u64_le(t_start)            // 8 bytes, little-endian (epoch ms)
    ‖ u64_le(t_end)              // 8 bytes, little-endian (epoch ms)
```

- **Hash function: `sha2_256`** (std::hash::sha2_256 on-chain; SHA-256 off-chain) over the
  UTF-8 prompt / completion. The contract does NOT re-hash — it binds the 32-byte digests it
  is given, and additionally asserts `input_hash == job.input_hash()` (the digest the
  consumer committed at `create_job`), so the prompt the provider served matches the order.
- **Integers are little-endian** (`u64_le`), not BCS-tagged, not big-endian.
- **No separators / no length prefixes** between fields — it is a flat concatenation. The
  measurement is variable-length; everything after it is fixed-width, so the layout is
  unambiguous.
- `signature` is a 64-byte raw Ed25519 signature; `attest_pubkey` is a 32-byte raw Ed25519
  public key. Both passed as `vector<u8>`.

### Reproducible test vector (so D0 can confirm the exact bytes)

Produced with Python `cryptography` Ed25519, deterministic all-zero 32-byte seed; the full
generator + self-checks live in `tests/signed_attestation_tests.move` (header comment) and a
runtime assertion (`helpers_reproduce_canonical_bytes`) pins the bytes against the on-chain
builder. Key values:

```
seed        = 00 * 32
pubkey      = 3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29
job_id      = d40679c0295fdd2fe9690e9259794989912738ff8b7c7e12f9c10cff1bbf4377   (deterministic in test_scenario)
measurement = "MOCK-tdx-llama8b-v1"   (19 bytes)
input_hash  = sha2_256("hello gix")        = 920a337685c06a488ac99d78c3a063c6c374468266113d7c5870770d116ef9dc
output_hash = sha2_256("hello from llama") = 4e189c771ae26adff09cb7b5449fab04d2673d86632cd44467858fb977e9bb8e
tokens,t_start,t_end = 9000, 0, 3000
msg (152 B) = 4749585f4154544553545f5631 d40679…f4377 4d4f434b2d7464782d6c6c616d6138622d7631 920a…f9dc 4e18…bb8e 2823000000000000 0000000000000000 b80b000000000000
signature   = a6fe084d82d0846c2e3e8b4ff0fd59b09b4a95387300cd27a2e464442174ac9845c27ca5dd87fdbd77dc3cfaf13930fa6cd86bf1df3cfb5479e3a86ccaee8103
```

### Error codes (signed path)

- `attestation::EBadSignature = 502` — `ed25519_verify` failed (bad sig, wrong key) OR the
  presented `input_hash` ≠ the job's committed `input_hash`.
- `attestation::EWrongProvider = 304` — caller ≠ job provider, or `provider_rec.operator` ≠
  job provider (no key substitution).
- `attestation::EBadState = 400` / `EAlreadyAttested = 503` / `EAttestDeadline = 500` /
  `EBadTiming = 504` — same lifecycle guards as the mock path.
- `registry::EBadPubkeyLen = 205` — `register_provider` pubkey not 32 bytes.

---

## Shared-Ask order book (two-account flow) — D1 authoritative

This is the first brick of the on-chain order book (a hand-rolled mini-DeepBook), enabling
a consumer's wallet to buy compute from a DIFFERENT provider's wallet. Before this, the only
job path was `create_job`, which forces **buyer == seller** because it consumes the
provider's *owned* `Coin<Credit<M>>` (the buyer had to be holding the provider's minted
coin). The shared `Ask<M>` removes that constraint: the provider parks credits in a shared
object, and any stranger fills against it.

### Lifecycle (buyer ≠ seller)

```
PROVIDER wallet (seller)                         CONSUMER wallet (buyer, distinct address)
────────────────────────                         ─────────────────────────────────────────
register_provider  →  ProviderCap (owned)
stake(bond,cap)    →  ProviderStake (owned)
post_ask<M>(cap, &mut stake, cfg,
            &mut market, qty_scu,
            price_usdc_per_scu)
   ├─ mints qty_scu Credit<M> (minted_scu += qty)
   ├─ moves them into a NEW *shared* Ask<M>
   └─ emits CreditsMinted + AskPosted ─────────▶  (Ask<M> is now a SHARED object on chain)

                                                  create_job_from_ask<M>(cfg, &market,
                                                       &mut ask, qty_scu, escrow_in,
                                                       input_hash, clk)
                                                     ├─ assert escrow ≥ qty_scu*price
                                                     ├─ assert qty_scu ≤ remaining_scu
                                                     ├─ draw qty_scu credits OUT of ask
                                                     ├─ share Job<M>{provider=ask.provider,
                                                     │             consumer=ctx.sender()}
                                                     └─ emits JobCreated + Dispatched
ack<M>(&mut job)            ◀─ provider signs ──────  (job.provider == ask.provider)
submit_*_attestation<M>(…)  ◀─ provider signs
settle<M>(&mut job, &mut market, cfg,
          &mut stake, &mut treasury)  ◀─ provider (or anyone) signs, passing the PROVIDER's
                                          own stake:
   ├─ pays job.provider (= ask.provider)  price − fee
   ├─ burns the drawn credits, consume_minted(stake, qty)
   └─ release(stake, qty)  ← tolerant no-op for ask jobs (see capacity note)
```

The consumer (buyer) **never references a provider-owned object** anywhere in the flow. In
`create_job_from_ask` the only provider-side object in scope is the **shared** `Ask<M>`;
`ProviderStake` and `ProviderCap` are never passed by the consumer. The provider drives
ack/attest/settle with its own owned objects exactly as in the single-account path — so the
existing `settlement::settle` / `resolve_attested` / `expire_and_resolve` / `cancel` paths
work unchanged, paying `ask.provider` and slashing the provider's stake via the
provider-signed path.

### Capacity accounting (reserve-then-burn intact)

- `post_ask` performs the SAME mint accounting as `mint_credits`: it asserts
  `minted_scu + qty_scu ≤ capacity_scu` (B6) and bumps `minted_scu`. The credits inside the
  ask are therefore **real minted supply**.
- Ask-created jobs deliberately do **not** bump `reserved_scu` (the consumer cannot reach
  the provider's stake to do so, and minted capacity already bounds exposure). At settlement
  `consume_minted(stake, qty)` retires the minted SCU and `release(stake, qty)` is a tolerant
  no-op (it floors at 0). Net invariant: every credit minted for an ask is either burned at
  `settle` or returned to the provider on fault/cancel — the mint→burn chain is preserved.
- Contrast: the owned-credits `create_job` still reserves (`reserved_scu += qty`) at creation
  because it has `&mut stake` in scope. The two paths thus differ only in whether
  `reserved_scu` reflects the in-flight job; `minted_scu` and bond exposure are identical.

### New event

```move
public struct AskPosted has copy, drop {
    ask_id: ID,
    market_id: ID,
    provider: address,
    qty_scu: u64,
    price_usdc_per_scu: u64,
}
```

### Reconciliation notes for E2 (node) and E3 (Mac client)

- **E2 (node).** A provider node now has two ways to bring capacity to market: (a) legacy —
  `mint_credits` then hand the `Coin<Credit<M>>` to a buyer out of band; (b) order book —
  `post_ask<M>` to publish a resting `Ask<M>`. The node should listen for **`AskPosted`**
  (to track its own resting liquidity / remaining_scu) and for **`JobCreated`/`Dispatched`**
  exactly as before. **Nothing changes on the settle side**: the node still ack/attests/
  settles a `Job<M>` with its own `ProviderStake` — ask-created jobs are indistinguishable
  from owned-credit jobs at ack/attest/settle. `job.provider` is the payout/slash target in
  both cases.
- **E3 (Mac/consumer client).** To buy from a DIFFERENT provider, the client now calls
  **`job::create_job_from_ask<M>`** against a shared `Ask<M>` object id (discovered from
  `AskPosted` events / an off-chain order-book index), funding `escrow_in` ≥
  `qty_scu * ask.price_usdc_per_scu`. The client does **not** need (and must not be given)
  any provider-owned object. The PTB args are: `cfg`, `&market`, `&mut ask`,
  `qty_scu: u64`, `escrow_in: Coin<MOCK_USDC>`, `input_hash`, `clk`. Type-arg `M` =
  `creditType` from `deployment.json` (same as `create_job`). The returned `Job` `ID` is the
  one to poll for state.
- **Pricing semantics.** `price_usdc_per_scu` is a **per-SCU** quote on the ask; the job's
  recorded `price_usdc` is the **full escrow value** the buyer locked (`escrow_in.value()`),
  consistent with the owned-credits path where escrow value == agreed price. Overpaying the
  minimum (`qty_scu * price`) is allowed and the surplus is paid to the provider at settle
  (or refunded on fault) — clients SHOULD fund exactly `qty_scu * price_usdc_per_scu` unless
  a tip is intended.
- **Partial fills.** One `Ask<M>` can be filled by multiple distinct buyers until
  `remaining_scu` hits 0; each fill mints a separate `Job<M>` that settles independently
  (parallel settlement atom preserved). The order-book index should track `remaining_scu` off
  the `JobCreated` deltas or by reading the shared `Ask`.
- **No new deviation from the canon's trust boundary.** `Ask` is the M1.5 stand-in for the
  DeepBook maker order in `sui-move-contracts.md` §5.3 (`create_job_from_fill`); when
  DeepBook lands, `create_job_from_ask` is replaced by `create_job_from_fill` and the `Ask`
  object retires. No maker bond is required at MVP (open-question E3).

---

## M2 — DeepBook fill jobs (Option B, pay-at-match) — authoritative

This is the M2 settlement-rail change: capacity trades on a real **DeepBook**
`Pool<Credit<M>, USDC>`, and the consumer creates a job from the swap output via
**`job::create_job_from_fill`**. It is **ADDITIVE** — `create_job`, `create_job_from_ask`,
and the `ask` module are unchanged and the live localnet demo still uses them. The `gix`
package takes **NO DeepBook or Walrus Move dependency**: composition is at the **PTB level**
(the function just receives a `Coin<Credit<M>>` and stores `u256` blob ids).

### The model (Option B — confirmed, see `docs/m2-phase0-design.md`)

- The provider mints `Credit<M>` and posts a resting **ask on DeepBook** (sells credits for
  USDC). The consumer **swaps USDC→`Credit<M>` atomically in a PTB**; that swap **pays the
  provider (the resting maker) USDC AT THE FILL** — off-chain to GIX. The consumer then feeds
  the returned `Coin<Credit<M>>` into `create_job_from_fill` in the **same PTB**.
- Therefore a fill-job has **NO USDC escrow**. The provider was already paid; the Job carries
  only the **reserved credit**. `job.is_fill == true`, `job.escrow == none`.
- **Consumer protection = refund-from-slash.** On any fault (invalid / missing / SLA) the
  provider's bond is **slashed** and the consumer is **refunded in USDC from the slash**
  (`resolve_fill` / `expire_and_resolve`), capped at the per-job value-at-risk
  (`price_usdc = scu_qty`); the `k`-ratio guarantees the cap is covered. There is no escrow
  leg to refund — this is the deliberate Option-B trade-off (who holds the money in the
  interim shifts from held-escrow to stake/slash). Same cryptographic verification as M1.
- **On success** (`settle_fill`) the on-chain settlement **moves no USDC** and pays nothing
  extra (provider already paid); it just **burns the reserved credit** + `consume_minted`
  and marks **Settled** (emits `Settled` with `payout=0, fee=0`). Protocol-fee capture for
  fill-jobs (a fee skimmed off the DeepBook proceeds) is **not** wired in M2 — the fee in
  Option B would have to be taken on the swap side; deferred.

### The exact PTB the TS side must build (`deepbook swap → create_job_from_fill`)

One signed PTB, consumer-signed, two logical commands:

```
// 1) DeepBook v3 swap: USDC → Credit<M> on the market's bound pool. Returns LOOSE coins
//    usable by the next command (confirmed in m2-phase0-design.md). The provider (resting
//    maker) is PAID USDC here.
let (creditCoin, usdcRemainder, deepRemainder) =
    deepbook::pool::swap_exact_quote_for_base<Credit<M>, USDC>(
        pool,            // = market.deepbook_pool_id  (bound via market::set_deepbook_pool_id)
        usdcIn,          // consumer's USDC
        deepIn /*or input-token fee*/, minBaseOut, clock, ctx);

// 2) GIX fill-job, SAME PTB. consumer-signed; NO escrow coin. Feeds the swap-output credits.
let jobId = gix::job::create_job_from_fill<M>(
        cfg, market, providerRec,   // providerRec = the single market provider's shared record
        creditCoin,                 // ← the Coin<Credit<M>> the swap returned
        inputBlobId /*u256, Walrus commitment*/, inputHash /*sha2_256(prompt)*/,
        clock, ctx);

// return / transfer usdcRemainder + deepRemainder back to the consumer.
```

Type-arg `M` = `creditType` from `deployment.json`. The pool id is read from
`market::deepbook_pool_id<M>` (governance binds it once via `set_deepbook_pool_id`). Testnet
DeepBook package ids come from `@mysten/deepbook-v3/src/utils/constants.ts` (NOT in the
bundled docs). DeepBook + Walrus are **testnet-only**, so M2 live integration runs on testnet.

### Walrus blob-id fields (ADDITIVE — commitments, not content hashes)

GIX's own **`sha2_256`** digests (`input_hash` / `output_hash`) remain the **verification
primitive**. The Walrus `blob_id` is a **storage commitment**, recorded ALONGSIDE the hashes:

- `Job<M>.input_blob_id: u256` — set at `create_job_from_fill` (prompt blob).
- `Job<M>.output_blob_id: u256` — set at attestation (completion blob).
- `AttestationRecord.quote_blob_id: u256` — set at attestation (signed-quote blob).
- `ModelRecord.walrus_blob_id` (pre-existing) carries the model artifact blob (the 4.6 GB
  model fits as a single regular blob). Provider fetches the model → recomputes GIX
  `model_hash` → refuses on mismatch.

`0` means "no blob recorded" (e.g. the localnet mock path, or the M1 escrow paths). Reads:
`job_input_blob_id` / `job_output_blob_id` / `job_quote_blob_id`. The signed-attestation
canonical message is **UNCHANGED** (the §"Soft attestation" byte layout does not include blob
ids — they are not content hashes), so existing node signatures stay valid.

### DEFERRED (M2) — clearly flagged

- **Multi-provider trustless dispatch.** For the M2 demo a **single provider** (the GB10)
  serves the market, so provider assignment is unambiguous: the caller passes that provider's
  shared `ProviderRecord` and the Job binds to its operator. There is **no on-chain proof**
  that this record was the DeepBook maker the swap actually filled against. Resolving the
  filled `maker_balance_manager_id → owner()` and proving credit provenance (so N makers in
  one taker order ⇒ N correctly-assigned jobs) is **deferred**.
- **Walrus PoA / `BlobCertified` dispatch gate.** A future revision will gate dispatch on the
  input blob being **certified** on Walrus (`Blob.certified_epoch` set) so the provider can
  always fetch the prompt. That needs the on-chain `walrus::blob::Blob` (a Walrus Move dep) at
  `create_job_from_fill`; M2 leaves a clearly-commented **no-op stub** in `job.move` and
  records only the `input_blob_id` commitment.
- **Fill-job protocol fee.** In Option B the GIX fee can't be skimmed from a (non-existent)
  escrow; it would be taken on the swap side. `settle_fill` charges no fee (deferred).

---

## Deviations from `mvp-m1-integration-contract.md` (integrator must reconcile)

The integration contract said *"Exact arg lists may shift — the names, the USDC-bond shape,
and the lifecycle states are fixed."* All of those invariants are honored. The arg-list
shifts and additions B/C must account for:

1. **Generic Markets/Jobs/Credits.** `Market`, `Job`, and `Credit` are all parameterized by
   the per-market witness `M` (`gix::markets::M_H100_LLAMA8B` for M1). Every PTB touching
   them must pass the type-arg. `deployment.json.markets[].creditType` carries it.

2. **`mint(faucet, amount, recipient, ctx)`** takes the shared **`Faucet`** object as its
   first arg (the integration contract sketch wrote `mint(amount, recipient, ctx)`). The
   `TreasuryCap` is wrapped in `Faucet` so the faucet is callable by anyone on localnet
   without holding a cap. `faucetId` is in `deployment.json`.

3. **`mint_credits<M>` gained `cfg: &Config` and `market: &mut Market<M>`** (the sketch had
   `market: &Market`). `&mut Market` is required because the credit `Supply<Credit<M>>` lives
   inside the `Market` (mint/burn are co-located with the market, not a free `TreasuryCap`).

4. **`create_job<M>` signature.** As-built:
   `create_job<M>(cfg, market: &Market<M>, stake: &mut ProviderStake, provider, credits, escrow_in, input_hash, clk, ctx): ID`.
   Differences vs the sketch: adds `stake: &mut ProviderStake` (capacity is reserved
   atomically at creation — lifecycle H3); drops the separate `model_id` arg (the model is
   read from the market); `consumer` is `ctx.sender()`. The job is **shared**; the function
   returns the new `Job` **`ID`** (not the object). `price_usdc` is the escrow coin's value
   (the stubbed-match price). The escrow amount must be > 0; SCU qty = `credits` value.

5. **`submit_mock_attestation<M>` gained `cfg`, `model: &ModelRecord`, `allow: &MeasurementAllowlist`.**
   These are required to (a) enforce the K4 localnet gate and (b) check the measurement is
   allowlisted for the job's model. The callable name and the bound tuple
   `(runtime_measurement ‖ output_hash ‖ output_token_count ‖ t_start ‖ t_end)` are as
   specified. **Verdict is recorded on the Job** (it does not abort on a bad attestation);
   settlement then routes the verdict to refund+slash via `resolve_attested`.

6. **Three settlement entrypoints, not one merged `settle`/`expire`.**
   - `settle<M>` — Verified → pay + burn (happy path). Args add `market: &mut Market<M>`
     (to burn credits) and `treasury: &mut Treasury` (fee sink).
   - `resolve_attested<M>` — Attested-but-failing-verdict (invalid binding / SLA breach) →
     refund + slash. **New, not in the sketch** — needed because attestation records a
     verdict rather than aborting.
   - `expire_and_resolve<M>` — deadline miss → refund (+ slash on provider fault). Matches
     the sketch's intent; args add `market`/`treasury`.
   - `cancel<M>` — consumer no-fault pre-ack cancel (full refund, no slash). **New.**

7. **`Treasury` is a shared object** created in `settlement::init` (its id is `treasuryId`
   in `deployment.json`). Every settlement entrypoint takes `&mut Treasury`. The sketch named
   it but didn't pin its provenance.

8. **`deployment.json` additions.** Beyond the sketch schema, A emits: `allowlistId`,
   `treasuryId`, `faucetId`, and per-market `modelId` + `creditCoinType`. `creditType` is the
   witness type param `<pkg>::markets::M_H100_LLAMA8B` (used as `--type-args`).

9. **Lifecycle states** are `u8` constants on `Job.state` exposed via `job::s_*()` accessors
   (`s_dispatched`=3, `s_executing`=4, `s_attested`=5, `s_verified`=6, `s_settled`=7,
   `s_refunded`=8, `s_expired`=9). M1's `create_job` advances straight to `Dispatched`
   (Created/Matched/Escrowed are collapsed into the one creation tx, as the sketch allowed).

10. **Event field shapes.** `gix::events` emits all required events
    (`MarketCreated`, `Staked`, `CreditsMinted`, `JobCreated`, `Dispatched`,
    `AttestationSubmitted`, `Settled`, `Refunded`, `Slashed`) plus `ModelRegistered`,
    `ProviderRegistered`, `MeasurementAdded`, `Unstaked`, and (new) **`AskPosted`**.
    `AttestationSubmitted` carries the `verdict` and `output_token_count`; `Refunded` carries
    `reason: u8` + `slashed: bool`; `Slashed` carries `to_consumer`/`to_treasury`. B should
    key its renderer off these.

---

## M1 simplifications / stubs (clearly flagged)

- **Attestation: two paths.** (1) **MOCK** (`submit_mock_attestation`) — localnet-only dev
  path, fenced three ways (K4): `cfg.is_localnet()` assert + `MOCK`-prefixed-measurement
  requirement + the allowlist's own refusal to insert a mock measurement when not localnet.
  `set_is_localnet(false)` disables the entire mock path. (2) **SIGNED**
  (`submit_signed_attestation`) — the demo-milestone soft attestation: native Ed25519 over
  the canonical message (§"Soft attestation"), verified against the provider's
  register-once attestation pubkey. Works on any network. **Hardware TEE** (Nautilus
  register-once + native P-256 over a BCS tuple) is still M2+; the signed path is the
  software stand-in (trust softened to a registered key, no vendor root).
- **Stubbed match.** No DeepBook in M1; `create_job` takes the `(provider, credits, escrow)`
  tuple directly. The escrow value is the agreed price.
- **Escrow + reserved credits are typed fields on `Job<M>`**, not dynamic object fields. The
  Job is still the single disjoint settlement atom; DOF children can be reintroduced later
  without changing the external interface.
- **`unstake` MVP rule:** bond is fully withdrawable only when `minted_scu == 0 &&
  reserved_scu == 0` (no partial free-bond accounting yet). Unbonding timelock field exists
  but defaults to 0.
- **Slash magnitudes (B4) and D1 split** are implemented and governance-tunable via
  `config::set_slash_bps` / `set_flat_penalty_invalid`. Defaults: invalid/missing = 100% of
  per-job bond share, SLA = 50% (graded band cap), liveness = 3%; D1 = consumer comp up to
  job value → treasury → burn 0.
