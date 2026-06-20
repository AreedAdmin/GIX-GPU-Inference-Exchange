/// `MOCK_USDC` — the dev USDC coin for localnet M1.
///
/// Localnet has no real USDC, so this module defines a stand-in fungible coin with
/// **6 decimals** (matching real USDC) that the harness and bootstrap scripts can
/// faucet freely. It is the quote/escrow asset AND the bond asset in v1 (the GIX
/// token is post-MVP).
///
/// DEV-ONLY: `mint` is an unrestricted public faucet. This is acceptable only on
/// localnet — on any real network this entire coin type would be replaced by canonical
/// USDC. The faucet keeps the `TreasuryCap` frozen-shared so any caller can mint test
/// funds without coordinating a cap holder.
module gix::mock_usdc;

use sui::coin::{Self, TreasuryCap};
use sui::url;

/// The one-time witness for this currency (name == module name, uppercased).
public struct MOCK_USDC has drop {}

/// Wraps the `TreasuryCap` so it can be shared and the faucet `mint` is callable by
/// anyone on localnet. The cap never leaves this object.
public struct Faucet has key {
    id: UID,
    cap: TreasuryCap<MOCK_USDC>,
}

/// 6 decimals, like real USDC.
const DECIMALS: u8 = 6;

// `coin::create_currency` is marked deprecated in favor of the newer
// `coin_registry::new_currency_with_otw` (which needs the shared `CoinRegistry` system
// object + a finalize step). For a dev-only localnet faucet coin the classic path is
// simpler and fully functional; M2 can migrate to the registry alongside real USDC.
#[allow(deprecated_usage)]
fun init(witness: MOCK_USDC, ctx: &mut TxContext) {
    let (treasury_cap, metadata) = coin::create_currency(
        witness,
        DECIMALS,
        b"mUSDC",
        b"Mock USDC (GIX devnet)",
        b"Dev-only USDC stand-in for GIX localnet M1. Not real money.",
        option::some(url::new_unsafe_from_bytes(
            b"https://raw.githubusercontent.com/MystenLabs/sui/main/docs/site/static/img/logo.svg",
        )),
        ctx,
    );
    // Metadata is immutable public reference data.
    transfer::public_freeze_object(metadata);
    // Share the faucet so the public `mint` below works for any test sender.
    transfer::share_object(Faucet { id: object::new(ctx), cap: treasury_cap });
}

/// Dev-only faucet. Mints `amount` base units of MOCK_USDC to `recipient`.
/// Unrestricted on purpose for localnet test data streaming.
public fun mint(faucet: &mut Faucet, amount: u64, recipient: address, ctx: &mut TxContext) {
    let coin = coin::mint(&mut faucet.cap, amount, ctx);
    transfer::public_transfer(coin, recipient);
}

/// Convenience: mint and return the coin to the caller (useful inside PTBs/tests).
public fun mint_and_return(faucet: &mut Faucet, amount: u64, ctx: &mut TxContext): coin::Coin<MOCK_USDC> {
    coin::mint(&mut faucet.cap, amount, ctx)
}

public fun decimals(): u8 { DECIMALS }

// === Test helpers ===

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(MOCK_USDC {}, ctx)
}

#[test_only]
public fun mint_for_testing(amount: u64, ctx: &mut TxContext): coin::Coin<MOCK_USDC> {
    coin::mint_for_testing<MOCK_USDC>(amount, ctx)
}
