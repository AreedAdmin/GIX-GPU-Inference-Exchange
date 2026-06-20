/// Two-account order-book (shared `Ask`) scenario tests.
///
/// These prove the first brick of the on-chain order book: a provider posts a resting
/// `Ask<M>` (offered capacity at a fixed USDC/SCU price), and a DISTINCT consumer wallet
/// (`consumer2` ≠ provider, ≠ the default `consumer`) fills it from its OWN wallet — buyer ≠
/// seller — without ever touching a provider-owned object. The resulting Job settles down
/// the existing provider-signed paths, paying `ask.provider` (and, on fault, slashing the
/// provider's bond).
///
/// Coverage:
///   - happy path: post_ask → consumer2 fills → ack → mock attest → settle pays the PROVIDER;
///   - escrow conservation (payout + fee == escrow == price);
///   - over-draw rejected (`qty > remaining_scu`);
///   - underfunded escrow rejected (`escrow < qty * price_per_scu`);
///   - fault path: an ask-created job that misses its attestation slashes the provider's bond
///     via the provider-signed expire path (no consumer access to the stake);
///   - partial fill: two distinct buyers draw from one ask, remaining decrements correctly.
#[test_only]
module gix::ask_flow_tests;

use gix::ask::{Self, Ask};
use gix::config::Config;
use gix::harness;
use gix::job::{Self, Job};
use gix::markets::M_H100_LLAMA8B;
use gix::settlement::{Self, Treasury};
use gix::staking::{Self, ProviderStake};
use sui::test_scenario::{Self as ts};

const BOND: u64 = 10_000_000; // 10 mUSDC
const CAPACITY: u64 = 100;
const PRICE_PER_SCU: u64 = 100_000; // 0.1 mUSDC / SCU
const QTY: u64 = 10;
// Exact escrow for QTY at PRICE_PER_SCU = 10 * 100_000 = 1_000_000.
const ESCROW: u64 = 1_000_000;

// === Happy path: a STRANGER buys from the provider's Ask; provider gets paid ===

#[test]
fun two_account_ask_settles_and_pays_provider() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);

    // Provider registers + stakes (keeps cap + stake owned); posts a resting Ask.
    harness::provider_register_and_stake(&mut sc, BOND, CAPACITY);
    let _ask_id = harness::post_ask(&mut sc, QTY, PRICE_PER_SCU);

    // The Ask holds QTY credits, fully remaining.
    sc.next_tx(harness::consumer2());
    {
        let ask = sc.take_shared<Ask<M_H100_LLAMA8B>>();
        assert!(ask::remaining_scu<M_H100_LLAMA8B>(&ask) == QTY, 1);
        assert!(ask::credits_value<M_H100_LLAMA8B>(&ask) == QTY, 2);
        assert!(ask::provider<M_H100_LLAMA8B>(&ask) == harness::provider(), 3);
        ts::return_shared(ask);
    };

    // consumer2 (≠ provider, ≠ default consumer) fills from its OWN wallet — no provider
    // object touched (the helper only takes shared Config/Market/Ask/Clock).
    let job_id = harness::create_job_from_ask(&mut sc, harness::consumer2(), QTY, ESCROW);

    // Job is bound to the provider as seller, consumer2 as buyer; ask drained by QTY.
    sc.next_tx(harness::consumer2());
    {
        let job = sc.take_shared<Job<M_H100_LLAMA8B>>();
        let ask = sc.take_shared<Ask<M_H100_LLAMA8B>>();
        assert!(job::job_provider(&job) == harness::provider(), 4);
        assert!(job::job_consumer(&job) == harness::consumer2(), 5);
        assert!(job::job_qty(&job) == QTY, 6);
        assert!(job::job_price(&job) == ESCROW, 7);
        assert!(object::id(&job) == job_id, 8);
        assert!(ask::remaining_scu<M_H100_LLAMA8B>(&ask) == 0, 9);
        ts::return_shared(job);
        ts::return_shared(ask);
    };

    // Provider drives the rest with its OWN objects (ack + attest + settle).
    harness::ack(&mut sc);
    harness::submit_attestation(&mut sc, harness::mock_measurement(), harness::output_hash(), 9000, 0, 3000);
    harness::settle(&mut sc);

    // The PROVIDER (seller) received price − fee; treasury got the fee; job Settled.
    sc.next_tx(harness::admin());
    {
        let cfg = sc.take_shared<Config>();
        let treasury = sc.take_shared<Treasury>();
        let fee = cfg.fee_amount(ESCROW);
        assert!(settlement::treasury_balance(&treasury) == fee, 10);
        ts::return_shared(cfg);
        ts::return_shared(treasury);
    };
    sc.next_tx(harness::provider());
    {
        let cfg = sc.take_shared<Config>();
        let fee = cfg.fee_amount(ESCROW);
        let payout = harness::take_usdc(&mut sc, harness::provider());
        assert!(harness::coin_value(&payout) == ESCROW - fee, 11);
        transfer::public_transfer(payout, harness::provider());
        ts::return_shared(cfg);
    };

    // Job terminal; minted SCU consumed, no dangling reservation.
    sc.next_tx(harness::provider());
    {
        let job = sc.take_shared<Job<M_H100_LLAMA8B>>();
        let stake = ts::take_from_address<ProviderStake>(&sc, harness::provider());
        assert!(job::job_state(&job) == job::s_settled(), 12);
        assert!(staking::minted_scu(&stake) == 0, 13); // QTY minted at post_ask, consumed at settle
        assert!(staking::reserved_scu(&stake) == 0, 14);
        ts::return_shared(job);
        ts::return_to_address(harness::provider(), stake);
    };

    sc.end();
}

// === Escrow conservation: payout + fee == escrow == price ===

#[test]
fun ask_escrow_conservation_on_settle() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    harness::provider_register_and_stake(&mut sc, BOND, CAPACITY);
    harness::post_ask(&mut sc, QTY, PRICE_PER_SCU);
    harness::create_job_from_ask(&mut sc, harness::consumer2(), QTY, ESCROW);
    harness::ack(&mut sc);
    harness::submit_attestation(&mut sc, harness::mock_measurement(), harness::output_hash(), 9000, 0, 3000);
    harness::settle(&mut sc);

    sc.next_tx(harness::provider());
    {
        let cfg = sc.take_shared<Config>();
        let treasury = sc.take_shared<Treasury>();
        let payout = harness::take_usdc(&mut sc, harness::provider());
        let fee = cfg.fee_amount(ESCROW);
        // payout + fee == escrow == ESCROW (nothing created or destroyed).
        assert!(harness::coin_value(&payout) + settlement::treasury_balance(&treasury) == ESCROW, 1);
        assert!(harness::coin_value(&payout) == ESCROW - fee, 2);
        transfer::public_transfer(payout, harness::provider());
        ts::return_shared(cfg);
        ts::return_shared(treasury);
    };
    sc.end();
}

// === Over-draw rejected: qty > remaining_scu ===

#[test]
#[expected_failure(abort_code = gix::ask::EInsufficientRemaining)]
fun over_draw_rejected() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    harness::provider_register_and_stake(&mut sc, BOND, CAPACITY);
    harness::post_ask(&mut sc, QTY, PRICE_PER_SCU);

    // Ask only has QTY (10) remaining; request QTY + 1, funded generously so the underfund
    // guard does not pre-empt the over-draw guard.
    harness::create_job_from_ask(&mut sc, harness::consumer2(), QTY + 1, ESCROW * 2);
    sc.end();
}

// === Underfunded escrow rejected: escrow < qty * price_per_scu ===

#[test]
#[expected_failure(abort_code = gix::job::EInsufficientEscrow)]
fun underfunded_escrow_rejected() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    harness::provider_register_and_stake(&mut sc, BOND, CAPACITY);
    harness::post_ask(&mut sc, QTY, PRICE_PER_SCU);

    // Required = QTY * PRICE_PER_SCU = 1_000_000; fund one base unit short.
    harness::create_job_from_ask(&mut sc, harness::consumer2(), QTY, ESCROW - 1);
    sc.end();
}

// === Fault path: ask-created job misses attestation → provider's bond slashed (provider-signed) ===

#[test]
fun ask_job_fault_slashes_provider_via_provider_signed_path() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    harness::provider_register_and_stake(&mut sc, BOND, CAPACITY);
    harness::post_ask(&mut sc, QTY, PRICE_PER_SCU);
    harness::create_job_from_ask(&mut sc, harness::consumer2(), QTY, ESCROW);
    harness::ack(&mut sc);

    // Past attest_deadline (= p99*6 + 30_000 = 60_000) with no attestation.
    harness::set_clock(&mut sc, 70_000);
    harness::expire_and_resolve(&mut sc);

    // Buyer refunded in full; provider's bond slashed (missing = 100% of bond share).
    // bond_share = BOND * QTY / CAPACITY = 10_000_000 * 10 / 100 = 1_000_000.
    sc.next_tx(harness::consumer2());
    {
        let job = sc.take_shared<Job<M_H100_LLAMA8B>>();
        assert!(job::job_state(&job) == job::s_refunded(), 1);
        assert!(job::job_slashed(&job) == true, 2);
        assert!(job::job_escrow_value(&job) == 0, 3);
        ts::return_shared(job);
    };
    sc.next_tx(harness::provider());
    {
        let stake = ts::take_from_address<ProviderStake>(&sc, harness::provider());
        assert!(staking::slashed_total(&stake) == 1_000_000, 4);
        assert!(staking::bond_value(&stake) == BOND - 1_000_000, 5);
        ts::return_to_address(harness::provider(), stake);
    };
    sc.end();
}

// === Partial fill: two distinct buyers draw from one ask; remaining decrements ===

#[test]
fun two_buyers_partial_fill_one_ask() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    harness::provider_register_and_stake(&mut sc, BOND, CAPACITY);
    harness::post_ask(&mut sc, QTY, PRICE_PER_SCU); // 10 SCU resting

    // Buyer A draws 4 SCU.
    harness::create_job_from_ask(&mut sc, harness::consumer2(), 4, 4 * PRICE_PER_SCU);
    sc.next_tx(harness::consumer2());
    {
        let ask = sc.take_shared<Ask<M_H100_LLAMA8B>>();
        assert!(ask::remaining_scu<M_H100_LLAMA8B>(&ask) == 6, 1);
        assert!(ask::credits_value<M_H100_LLAMA8B>(&ask) == 6, 2);
        ts::return_shared(ask);
    };

    // Buyer B (the default `consumer`, a THIRD distinct wallet) draws 6 SCU; ask now empty.
    harness::create_job_from_ask(&mut sc, harness::consumer(), 6, 6 * PRICE_PER_SCU);
    sc.next_tx(harness::consumer());
    {
        let ask = sc.take_shared<Ask<M_H100_LLAMA8B>>();
        assert!(ask::remaining_scu<M_H100_LLAMA8B>(&ask) == 0, 3);
        assert!(ask::credits_value<M_H100_LLAMA8B>(&ask) == 0, 4);
        ts::return_shared(ask);
    };

    sc.end();
}
