/// `Ask<phantom M>` — a resting maker order on the hand-rolled GIX order book.
///
/// An `Ask` is the first brick of the on-chain order book (a minimal stand-in for a
/// DeepBook maker order, see `docs/architecture/sui-move-contracts.md` §5.3
/// `create_job_from_fill`). A provider posts offered capacity at a fixed USDC/SCU price
/// by moving already-minted `Credit<M>` into a **shared** `Ask<M>`; any consumer can then
/// fill against it from their OWN wallet — buyer ≠ seller — by drawing credits out of the
/// shared object (`job::create_job_from_ask`). The consumer never touches a provider-owned
/// object (the `ProviderStake`, the `ProviderCap`): the Ask is the only thing they share.
///
/// Reserve-then-burn invariant: the credits parked in an `Ask` are real minted supply
/// (`staking::mint_credits` already debited the provider's free mintable capacity and bumped
/// `minted_scu`). Drawing them into a `Job` and burning them at `settle` keeps the
/// mint→reserve→burn chain intact. Because the credits are pre-minted, capacity is already
/// bounded; ask-created jobs therefore do NOT additionally bump the provider's
/// `reserved_scu` (the consumer has no access to the provider's stake to do so), and
/// settlement's `release` is a tolerant no-op for them.
module gix::ask;

use gix::credit::Credit;
use gix::events;
use sui::balance::{Self, Balance};

const VERSION: u64 = 1;

// === Error codes (4xx: job / order book) ===
const EInsufficientRemaining: u64 = 406;
const EZeroQty: u64 = 405;

/// A resting provider Ask: offered `remaining_scu` of `Credit<M>` at `price_usdc_per_scu`.
/// Shared so any consumer can fill against it without owning provider objects.
public struct Ask<phantom M> has key {
    id: UID,
    version: u64,
    provider: address,
    market_id: ID,
    credits: Balance<Credit<M>>,
    price_usdc_per_scu: u64,
    remaining_scu: u64,
}

/// Create and share a new `Ask` holding `credits` from `provider`, priced per SCU. Called
/// by `staking::post_ask` (which owns the capacity accounting). The parked credit balance
/// must equal `remaining_scu`.
public(package) fun post<M>(
    provider: address,
    market_id: ID,
    credits: Balance<Credit<M>>,
    price_usdc_per_scu: u64,
    ctx: &mut TxContext,
): ID {
    let qty = balance::value(&credits);
    assert!(qty > 0, EZeroQty);
    let ask = Ask<M> {
        id: object::new(ctx),
        version: VERSION,
        provider,
        market_id,
        credits,
        price_usdc_per_scu,
        remaining_scu: qty,
    };
    let ask_id = object::id(&ask);
    events::ask_posted(ask_id, market_id, provider, qty, price_usdc_per_scu);
    transfer::share_object(ask);
    ask_id
}

/// Draw `qty` SCU of credits out of the resting ask, decrementing `remaining_scu`. Called by
/// `job::create_job_from_ask` (the taker fill). Aborts if the ask cannot cover `qty`.
public(package) fun draw<M>(ask: &mut Ask<M>, qty: u64): Balance<Credit<M>> {
    assert!(qty > 0, EZeroQty);
    assert!(qty <= ask.remaining_scu, EInsufficientRemaining);
    ask.remaining_scu = ask.remaining_scu - qty;
    ask.credits.split(qty)
}

// === Reads ===

public fun provider<M>(ask: &Ask<M>): address { ask.provider }
public fun market_id<M>(ask: &Ask<M>): ID { ask.market_id }
public fun price_usdc_per_scu<M>(ask: &Ask<M>): u64 { ask.price_usdc_per_scu }
public fun remaining_scu<M>(ask: &Ask<M>): u64 { ask.remaining_scu }
public fun credits_value<M>(ask: &Ask<M>): u64 { balance::value(&ask.credits) }

// === Error-code accessors (for tests) ===

public fun e_insufficient_remaining(): u64 { EInsufficientRemaining }
public fun e_zero_qty(): u64 { EZeroQty }
