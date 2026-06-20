/// Market: the unit of standardization. Binds a per-market Compute Credit type to its
/// SCU definition, SLA/deadline params, the model it serves, and a fee-tier override.
///
/// The market owns the `Supply<Credit<M>>` for its credit type, so credit mint/burn is
/// co-located with — and gated through — the market. Shared and read-mostly: the job path
/// only ever takes `&Market`, never `&mut`, so two jobs in the same market do not serialize
/// (sui-move-contracts.md §8). Mint/burn take `&mut Market` but happen off the settlement
/// hot path's critical contention (provider-side mint, package-internal burn at settle).
module gix::market;

use gix::config::{Config, AdminCap};
use gix::credit::{Self, Credit};
use gix::events;
use sui::balance::{Balance, Supply};
use sui::coin::Coin;

// === Error codes (2xx: market) ===
const EMarketInactive: u64 = 200;
const EBadParam: u64 = 103;
/// `deepbook_pool_id` was never bound by governance (M2 fill path needs it set).
const ENoPool: u64 = 202;

/// SLA + deadline parameters, copied onto each Job at creation. Times in ms.
public struct SlaParams has store, copy, drop {
    p99_ms: u64,
    ack_deadline_ms: u64,
    exec_deadline_ms: u64,
    attest_deadline_ms: u64,
}

public struct Market<phantom M> has key {
    id: UID,
    version: u64,
    name: vector<u8>, // e.g. b"H100-llama3.1-8b-int8"
    gpu_class: vector<u8>,
    model_id: ID,
    /// SCU metering (E1): 1 SCU = `scu_tokens` output tokens at this tier.
    scu_tokens: u64,
    sla: SlaParams,
    /// Per-market fee override; 0 means "use Config default".
    fee_tier_bps: u64,
    active: bool,
    /// Mint/burn authority for this market's credit, co-located here.
    supply: Supply<Credit<M>>,
    /// M2: the shared DeepBook `Pool<Credit<M>, USDC>` this market's capacity trades on.
    /// `none` until governance binds it via `set_deepbook_pool_id` (additive — the M1
    /// owned-credits / Ask paths never read it). The on-chain contract does NOT call into
    /// DeepBook (composition is at the PTB level); this is a governance-published pointer
    /// so the consumer SDK can discover the canonical pool for the market and so the
    /// (deferred) PoA/fill-provenance checks have an anchor. Stored as `ID`, not a typed
    /// reference, so the `gix` package takes no DeepBook Move dependency.
    deepbook_pool_id: Option<ID>,
}

const VERSION: u64 = 1;

// Default deadline shape for the interactive SLA class (C1 provisional benchmark):
// ack ≈ 30s, exec ≈ SLA p99 hard cap, attest ≈ 2× SLA. The deploy script / governance
// can override per market.
const DEFAULT_ACK_MS: u64 = 30_000;
const ATTEST_SLACK_MS: u64 = 30_000;

/// Create a market and share it. AdminCap-gated (in M1 the AdminCap fills the
/// GovernanceCap role). `scu_tokens` defines the SCU; `sla_p99_ms` drives the deadlines.
public fun create_market<M>(
    _: &AdminCap,
    cfg: &Config,
    name: vector<u8>,
    gpu_class: vector<u8>,
    model_id: ID,
    scu_tokens: u64,
    sla_p99_ms: u64,
    ctx: &mut TxContext,
): ID {
    cfg.assert_version();
    assert!(scu_tokens > 0, EBadParam);
    let sla = SlaParams {
        p99_ms: sla_p99_ms,
        ack_deadline_ms: DEFAULT_ACK_MS,
        // exec hard cap: generous multiple of p99 to absorb tail latency.
        exec_deadline_ms: sla_p99_ms * 6,
        // attest window covers exec + Walrus writes + quote gen.
        attest_deadline_ms: sla_p99_ms * 6 + ATTEST_SLACK_MS,
    };
    let market = Market<M> {
        id: object::new(ctx),
        version: VERSION,
        name,
        gpu_class,
        model_id,
        scu_tokens,
        sla,
        fee_tier_bps: 0,
        active: true,
        supply: credit::new_supply<M>(),
        deepbook_pool_id: option::none(),
    };
    let market_id = object::id(&market);
    events::market_created(market_id, name, model_id, scu_tokens, sla_p99_ms);
    transfer::share_object(market);
    market_id
}

// === Governance setters (AdminCap-gated) ===

public fun set_active<M>(_: &AdminCap, market: &mut Market<M>, active: bool) {
    market.active = active;
}

public fun set_fee_tier_bps<M>(_: &AdminCap, market: &mut Market<M>, bps: u64) {
    assert!(bps <= gix::config::bps_denom(), EBadParam);
    market.fee_tier_bps = bps;
}

public fun set_sla<M>(
    _: &AdminCap,
    market: &mut Market<M>,
    p99_ms: u64,
    ack_ms: u64,
    exec_ms: u64,
    attest_ms: u64,
) {
    market.sla = SlaParams {
        p99_ms,
        ack_deadline_ms: ack_ms,
        exec_deadline_ms: exec_ms,
        attest_deadline_ms: attest_ms,
    };
}

/// M2 governance: bind (or rebind) the shared DeepBook `Pool<Credit<M>, USDC>` id this
/// market trades on. AdminCap-gated. Additive — the on-chain contract does not call
/// DeepBook; this is a published pointer for the SDK to discover the canonical pool and a
/// future anchor for fill-provenance / PoA checks (deferred).
public fun set_deepbook_pool_id<M>(_: &AdminCap, market: &mut Market<M>, pool_id: ID) {
    market.deepbook_pool_id = option::some(pool_id);
}

// === Reads ===

public fun market_id<M>(market: &Market<M>): ID { object::id(market) }
public fun model_id<M>(market: &Market<M>): ID { market.model_id }
public fun name<M>(market: &Market<M>): vector<u8> { market.name }
public fun gpu_class<M>(market: &Market<M>): vector<u8> { market.gpu_class }
public fun scu_tokens<M>(market: &Market<M>): u64 { market.scu_tokens }
public fun is_active<M>(market: &Market<M>): bool { market.active }
public fun fee_tier_bps<M>(market: &Market<M>): u64 { market.fee_tier_bps }

/// The bound DeepBook pool id, if governance has set one. `none` on a fresh market.
public fun deepbook_pool_id<M>(market: &Market<M>): Option<ID> { market.deepbook_pool_id }

/// Whether a DeepBook pool has been bound. The M2 `create_job_from_fill` requires this so a
/// fill-job can only be created against a market governance has actually wired to a pool.
public fun has_deepbook_pool<M>(market: &Market<M>): bool { option::is_some(&market.deepbook_pool_id) }

/// Abort `ENoPool` unless a DeepBook pool is bound (used by the fill-job creation path).
public fun assert_has_deepbook_pool<M>(market: &Market<M>) {
    assert!(option::is_some(&market.deepbook_pool_id), ENoPool);
}

public fun p99_ms<M>(market: &Market<M>): u64 { market.sla.p99_ms }
public fun ack_deadline_ms<M>(market: &Market<M>): u64 { market.sla.ack_deadline_ms }
public fun exec_deadline_ms<M>(market: &Market<M>): u64 { market.sla.exec_deadline_ms }
public fun attest_deadline_ms<M>(market: &Market<M>): u64 { market.sla.attest_deadline_ms }

public fun assert_active<M>(market: &Market<M>) {
    assert!(market.active, EMarketInactive);
}

/// Effective fee bps for this market: the per-market override if set, else Config default.
public fun effective_fee_bps<M>(market: &Market<M>, cfg: &Config): u64 {
    if (market.fee_tier_bps > 0) market.fee_tier_bps else cfg.protocol_fee_bps()
}

// === Credit mint/burn (package-internal; capacity gated by staking) ===

/// Mint `qty` credits for this market into a `Coin`. Capacity is checked by the caller
/// (`staking::mint_credits`), which holds the provider's free-capacity accounting.
public(package) fun mint_credit<M>(market: &mut Market<M>, qty: u64, ctx: &mut TxContext): Coin<Credit<M>> {
    let bal = credit::mint_balance(&mut market.supply, qty);
    credit::to_coin(bal, ctx)
}

/// Burn a reserved credit balance at settlement; returns the burned amount.
public(package) fun burn_credit<M>(market: &mut Market<M>, bal: Balance<Credit<M>>): u64 {
    credit::burn_balance(&mut market.supply, bal)
}

public fun outstanding_credits<M>(market: &Market<M>): u64 { credit::supply_value(&market.supply) }
