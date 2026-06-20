/// Provider collateral staking + capacity accounting (v1 bond is USDC).
///
/// `ProviderStake` is an **owned** object (one per provider) holding the slashable
/// `Balance<MOCK_USDC>` bond and the capacity counters that gate credit minting and
/// concurrent job exposure. Owned ⇒ a provider's stake-touching txns only serialize
/// against *themselves*, never the whole system; L3 says batch them into one PTB at MVP.
///
/// Capacity model (token-SCU, E1):
/// - `capacity_scu`        — total SCU this bond authorizes (set at stake time).
/// - `minted_scu`          — credits currently minted and outstanding (claims on capacity).
/// - `reserved_scu`        — SCU committed to in-flight (Escrowed→terminal) jobs.
/// Invariants: `minted_scu ≤ capacity_scu` and `reserved_scu ≤ capacity_scu` at all times
/// (I3). Minting is gated on free *mintable* capacity; job reservation on free
/// *physical* capacity, so a provider can never oversell (lifecycle §9).
module gix::staking;

use gix::ask;
use gix::config::Config;
use gix::credit::{Self, Credit};
use gix::events;
use gix::market::Market;
use gix::registry::ProviderCap;
use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin};

use gix::mock_usdc::MOCK_USDC;

// === Error codes (3xx: staking / credit) ===
const EInsufficientStake: u64 = 300;
const EInsufficientCapacity: u64 = 301;
const EStakeLocked: u64 = 302;
const EUnbonding: u64 = 303;
const EWrongProvider: u64 = 304;
const EInsufficientBond: u64 = 305;
const EZeroQty: u64 = 405;

public struct ProviderStake has key, store {
    id: UID,
    version: u64,
    provider: address,
    bond: Balance<MOCK_USDC>,
    capacity_scu: u64,
    minted_scu: u64,
    reserved_scu: u64,
    locked_until: u64, // unbonding timelock (ms epoch); 0 = unlocked
    slashed_total: u64,
}

const VERSION: u64 = 1;

// === Stake / unstake ===

/// Post a USDC bond and open `capacity_scu` of capacity. Returns the owned stake to the
/// provider. Asserts the bond meets `cfg.min_stake`.
public fun stake(
    cap: &ProviderCap,
    cfg: &Config,
    bond: Coin<MOCK_USDC>,
    capacity_scu: u64,
    ctx: &mut TxContext,
): ProviderStake {
    cfg.assert_version();
    cfg.assert_not_paused();
    let amount = coin::value(&bond);
    assert!(amount >= cfg.min_stake(), EInsufficientStake);
    let provider = cap.cap_provider();
    let stake = ProviderStake {
        id: object::new(ctx),
        version: VERSION,
        provider,
        bond: coin::into_balance(bond),
        capacity_scu,
        minted_scu: 0,
        reserved_scu: 0,
        locked_until: 0,
        slashed_total: 0,
    };
    events::staked(object::id(&stake), provider, amount, capacity_scu);
    stake
}

/// Add more bond to an existing stake and (optionally) extend capacity.
public fun add_bond(
    cap: &ProviderCap,
    stake: &mut ProviderStake,
    bond: Coin<MOCK_USDC>,
    extra_capacity_scu: u64,
) {
    assert!(cap.cap_provider() == stake.provider, EWrongProvider);
    stake.bond.join(coin::into_balance(bond));
    stake.capacity_scu = stake.capacity_scu + extra_capacity_scu;
}

/// Withdraw `amount` of free (unreserved, unminted-against) bond. Cannot pull bond that
/// backs outstanding credits or in-flight jobs, and respects the unbonding timelock.
public fun unstake(
    cap: &ProviderCap,
    stake: &mut ProviderStake,
    amount: u64,
    clk: &Clock,
    ctx: &mut TxContext,
): Coin<MOCK_USDC> {
    assert!(cap.cap_provider() == stake.provider, EWrongProvider);
    assert!(clk.timestamp_ms() >= stake.locked_until, EUnbonding);
    // Free capacity must cover what we are de-committing: a simplifying MVP rule keeps
    // the bond fully available only when nothing is minted/reserved.
    assert!(stake.minted_scu == 0 && stake.reserved_scu == 0, EStakeLocked);
    assert!(balance::value(&stake.bond) >= amount, EInsufficientBond);
    let out = coin::take(&mut stake.bond, amount, ctx);
    events::unstaked(object::id(stake), stake.provider, amount);
    out
}

// === Credit minting (gated by free mintable capacity) ===

/// Mint `qty` credits for `market` against this stake's free capacity. The credits are a
/// `Coin<Credit<M>>` the provider can sell on DeepBook (M1: feed straight into a Job).
public fun mint_credits<M>(
    cap: &ProviderCap,
    stake: &mut ProviderStake,
    cfg: &Config,
    market: &mut Market<M>,
    qty: u64,
    ctx: &mut TxContext,
): Coin<Credit<M>> {
    cfg.assert_version();
    cfg.assert_not_paused();
    assert!(cap.cap_provider() == stake.provider, EWrongProvider);
    market.assert_active();
    assert!(qty > 0, EZeroQty);
    // B6: never mint beyond physical capacity.
    assert!(stake.minted_scu + qty <= stake.capacity_scu, EInsufficientCapacity);
    stake.minted_scu = stake.minted_scu + qty;
    let credits = market.mint_credit(qty, ctx);
    events::credits_minted(object::id(stake), market.market_id(), stake.provider, qty);
    credits
}

// === Order book: post a resting Ask ===

/// Post a resting `Ask<M>` onto the order book: mint `qty_scu` of this market's `Credit<M>`
/// against this stake's free capacity (same accounting as `mint_credits` — bumps
/// `minted_scu`, gated at `capacity_scu`) and move the freshly minted credits into a NEW
/// **shared** `Ask<M>` priced at `price_usdc_per_scu`. Returns the new ask's `ID`.
///
/// Provider-signed: holds the `ProviderCap`. The credits are pre-minted real supply, so the
/// reserve-then-burn invariant is intact — a consumer fills the ask from their own wallet
/// (`job::create_job_from_ask`) and the drawn credits are burned at `settle`. No maker bond
/// beyond the existing stake is required (open-question E3: no maker bonds at MVP).
///
/// NOTE: `market` is `&mut` (not `&`) because the credit `Supply<Credit<M>>` lives inside the
/// `Market` — minting co-locates with the market exactly as `mint_credits` does.
public fun post_ask<M>(
    cap: &ProviderCap,
    stake: &mut ProviderStake,
    cfg: &Config,
    market: &mut Market<M>,
    qty_scu: u64,
    price_usdc_per_scu: u64,
    ctx: &mut TxContext,
): ID {
    cfg.assert_version();
    cfg.assert_not_paused();
    assert!(cap.cap_provider() == stake.provider, EWrongProvider);
    market.assert_active();
    assert!(qty_scu > 0, EZeroQty);
    // B6: never mint beyond physical capacity (same gate as mint_credits).
    assert!(stake.minted_scu + qty_scu <= stake.capacity_scu, EInsufficientCapacity);
    stake.minted_scu = stake.minted_scu + qty_scu;
    let credits_coin = market.mint_credit(qty_scu, ctx);
    events::credits_minted(object::id(stake), market.market_id(), stake.provider, qty_scu);
    ask::post<M>(
        stake.provider,
        market.market_id(),
        credit::from_coin(credits_coin),
        price_usdc_per_scu,
        ctx,
    )
}

// === Capacity reservation (package-internal: job / settlement) ===

/// Reserve `qty` SCU for an in-flight job (called at Job creation). Bounds concurrent
/// exposure to the bond.
public(package) fun reserve(stake: &mut ProviderStake, qty: u64) {
    assert!(stake.reserved_scu + qty <= stake.capacity_scu, EInsufficientCapacity);
    stake.reserved_scu = stake.reserved_scu + qty;
}

/// Release a reservation at any terminal state.
public(package) fun release(stake: &mut ProviderStake, qty: u64) {
    if (stake.reserved_scu >= qty) {
        stake.reserved_scu = stake.reserved_scu - qty;
    } else {
        stake.reserved_scu = 0;
    }
}

/// Consume minted capacity when credits are burned at `Settled` (capacity is spent).
public(package) fun consume_minted(stake: &mut ProviderStake, qty: u64) {
    if (stake.minted_scu >= qty) {
        stake.minted_scu = stake.minted_scu - qty;
    } else {
        stake.minted_scu = 0;
    }
}

/// Debit `amount` from the bond as a slash; records the lifetime total. Returns the
/// slashed `Balance` for distribution by `settlement`. Capped at the available bond.
public(package) fun slash(stake: &mut ProviderStake, amount: u64): Balance<MOCK_USDC> {
    let avail = balance::value(&stake.bond);
    let take = if (amount > avail) avail else amount;
    stake.slashed_total = stake.slashed_total + take;
    stake.bond.split(take)
}

/// De-rate capacity after a fault (B5: linear −10% per fault, floored at 0).
public(package) fun derate(stake: &mut ProviderStake) {
    let cut = stake.capacity_scu / 10;
    stake.capacity_scu = if (stake.capacity_scu > cut) stake.capacity_scu - cut else 0;
}

public(package) fun set_unbonding(stake: &mut ProviderStake, until_ms: u64) {
    stake.locked_until = until_ms;
}

// === Reads ===

public fun provider(stake: &ProviderStake): address { stake.provider }
public fun bond_value(stake: &ProviderStake): u64 { balance::value(&stake.bond) }
public fun capacity_scu(stake: &ProviderStake): u64 { stake.capacity_scu }
public fun minted_scu(stake: &ProviderStake): u64 { stake.minted_scu }
public fun reserved_scu(stake: &ProviderStake): u64 { stake.reserved_scu }
public fun slashed_total(stake: &ProviderStake): u64 { stake.slashed_total }
public fun free_capacity(stake: &ProviderStake): u64 {
    if (stake.capacity_scu > stake.reserved_scu) stake.capacity_scu - stake.reserved_scu else 0
}

// === Test helpers ===

#[test_only]
public fun destroy_for_testing(stake: ProviderStake) {
    let ProviderStake {
        id,
        version: _,
        provider: _,
        bond,
        capacity_scu: _,
        minted_scu: _,
        reserved_scu: _,
        locked_until: _,
        slashed_total: _,
    } = stake;
    id.delete();
    balance::destroy_for_testing(bond);
}
