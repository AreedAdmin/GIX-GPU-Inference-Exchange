/// Escrow custody for a `Job`'s consumer USDC.
///
/// Custody is a `Balance<MOCK_USDC>` (no `UID`, the right primitive for vaulted funds)
/// wrapped in an `Escrow` with `store` so it can be embedded in the `Job<M>`. Invariant
/// I1: `funded_amount == value(funds)` until a single settlement drains it. Only the
/// `settlement` module (a package-internal caller) may withdraw — there is no `public`
/// withdraw, so neither governance nor a consumer can pull escrow out of band.
module gix::escrow;

use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};

use gix::mock_usdc::MOCK_USDC;

/// Escrow invariant violation (I1): tried to drop a non-empty escrow.
const EEscrowMismatch: u64 = 401;

public struct Escrow has store {
    funds: Balance<MOCK_USDC>,
    funded_amount: u64,
    refundable_to: address,
}

/// Lock a consumer's `Coin<MOCK_USDC>` into a fresh escrow. The locked value must equal
/// the expected job price (I2), asserted by the caller (`job`).
public(package) fun lock(funds: Coin<MOCK_USDC>, refundable_to: address): Escrow {
    let amount = coin::value(&funds);
    Escrow { funds: coin::into_balance(funds), funded_amount: amount, refundable_to }
}

/// Drain the entire escrow balance. Only settlement calls this; it flips the Job to a
/// terminal state in the same tx, so funds can be released xor refunded, never both (I8).
public(package) fun withdraw_all(e: &mut Escrow): Balance<MOCK_USDC> {
    let all = balance::withdraw_all(&mut e.funds);
    e.funded_amount = 0;
    all
}

/// Split `amount` off the escrow (used to skim the protocol fee before paying provider).
public(package) fun split(e: &mut Escrow, amount: u64): Balance<MOCK_USDC> {
    let part = e.funds.split(amount);
    e.funded_amount = e.funded_amount - amount;
    part
}

public(package) fun destroy_empty(e: Escrow) {
    let Escrow { funds, funded_amount, refundable_to: _ } = e;
    assert!(funded_amount == 0, EEscrowMismatch);
    balance::destroy_zero(funds);
}

// === Reads ===

public fun value(e: &Escrow): u64 { balance::value(&e.funds) }
public fun funded_amount(e: &Escrow): u64 { e.funded_amount }
public fun refundable_to(e: &Escrow): address { e.refundable_to }
