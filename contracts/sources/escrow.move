/// Escrow custody for a `Job`'s consumer quote-coin funds.
///
/// Custody is a `Balance<Q>` (no `UID`, the right primitive for vaulted funds) wrapped in an
/// `Escrow<phantom Q>` with `store` so it can be embedded in the `Job<M, Q>`. `Q` is the
/// quote/settlement dollar, chosen per network at instantiation: `MOCK_USDC` on localnet,
/// `DBUSDC` on testnet, real `USDC` on mainnet (see docs/onramp-dbusdc-plan.md). Invariant
/// I1: `funded_amount == value(funds)` until a single settlement drains it. Only the
/// `settlement` module (a package-internal caller) may withdraw — there is no `public`
/// withdraw, so neither governance nor a consumer can pull escrow out of band.
module gix::escrow;

use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};

/// Escrow invariant violation (I1): tried to drop a non-empty escrow.
const EEscrowMismatch: u64 = 401;

public struct Escrow<phantom Q> has store {
    funds: Balance<Q>,
    funded_amount: u64,
    refundable_to: address,
}

/// Lock a consumer's `Coin<Q>` into a fresh escrow. The locked value must equal
/// the expected job price (I2), asserted by the caller (`job`).
public(package) fun lock<Q>(funds: Coin<Q>, refundable_to: address): Escrow<Q> {
    let amount = coin::value(&funds);
    Escrow { funds: coin::into_balance(funds), funded_amount: amount, refundable_to }
}

/// Drain the entire escrow balance. Only settlement calls this; it flips the Job to a
/// terminal state in the same tx, so funds can be released xor refunded, never both (I8).
public(package) fun withdraw_all<Q>(e: &mut Escrow<Q>): Balance<Q> {
    let all = balance::withdraw_all(&mut e.funds);
    e.funded_amount = 0;
    all
}

/// Split `amount` off the escrow (used to skim the protocol fee before paying provider).
public(package) fun split<Q>(e: &mut Escrow<Q>, amount: u64): Balance<Q> {
    let part = e.funds.split(amount);
    e.funded_amount = e.funded_amount - amount;
    part
}

public(package) fun destroy_empty<Q>(e: Escrow<Q>) {
    let Escrow { funds, funded_amount, refundable_to: _ } = e;
    assert!(funded_amount == 0, EEscrowMismatch);
    balance::destroy_zero(funds);
}

// === Reads ===

public fun value<Q>(e: &Escrow<Q>): u64 { balance::value(&e.funds) }
public fun funded_amount<Q>(e: &Escrow<Q>): u64 { e.funded_amount }
public fun refundable_to<Q>(e: &Escrow<Q>): address { e.refundable_to }
