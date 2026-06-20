/// Per-market Compute Credit coin (`Credit<phantom M>`).
///
/// One credit == one SCU for the market. `M` is the per-market witness type (e.g.
/// `gix::markets::M_H100_LLAMA8B`), so `Credit<M>` is a distinct fungible coin per market.
/// Credits are claims on capacity, not money — USDC is the money. Providers mint credits
/// against staked capacity (gated in `staking`) and they are burned at `Settled`
/// (reserve-then-burn, L1).
///
/// The `Supply<Credit<M>>` lives inside the `Market` (see `market` module) — there is no
/// freestanding `TreasuryCap`, which keeps mint/burn authority co-located with the market
/// and gated by package-internal calls only.
module gix::credit;

use sui::balance::{Self, Balance, Supply};
use sui::coin::{Self, Coin};

/// The phantom-branded compute credit. `M` brands the market. `store` lets it sit in a
/// DeepBook pool / be transferred; `copy`/`drop` intentionally absent (it is money-like).
public struct Credit<phantom M> has drop {}

/// Internal: create the supply for a market's credit. Called once at market creation.
public(package) fun new_supply<M>(): Supply<Credit<M>> {
    balance::create_supply(Credit<M> {})
}

/// Internal: mint `qty` credits as a `Balance`. Caller (market/staking) gates capacity.
public(package) fun mint_balance<M>(supply: &mut Supply<Credit<M>>, qty: u64): Balance<Credit<M>> {
    supply.increase_supply(qty)
}

/// Internal: burn a credit balance, decreasing supply; returns the burned amount.
public(package) fun burn_balance<M>(supply: &mut Supply<Credit<M>>, bal: Balance<Credit<M>>): u64 {
    supply.decrease_supply(bal)
}

/// Internal: wrap a credit balance into a `Coin` for return to a provider/PTB.
public(package) fun to_coin<M>(bal: Balance<Credit<M>>, ctx: &mut TxContext): Coin<Credit<M>> {
    coin::from_balance(bal, ctx)
}

/// Internal: unwrap a `Coin<Credit<M>>` into a `Balance` for reserving into a Job.
public(package) fun from_coin<M>(c: Coin<Credit<M>>): Balance<Credit<M>> {
    coin::into_balance(c)
}

public fun value<M>(c: &Coin<Credit<M>>): u64 { coin::value(c) }

public fun supply_value<M>(supply: &Supply<Credit<M>>): u64 { balance::supply_value(supply) }
