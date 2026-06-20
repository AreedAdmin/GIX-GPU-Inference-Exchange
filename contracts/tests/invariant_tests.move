/// Negative + invariant tests: the guards that MUST abort.
///
/// Covers: no payout without Verified (I5/settle guard); exactly-once settlement
/// (double-settle aborts on terminal-state guard); no over-mint beyond capacity (I3);
/// K4 mock-attestation isolation (mock measurement refused on a non-localnet allowlist);
/// pause blocks the job path; deadline-not-passed guard.
#[test_only]
module gix::invariant_tests;

use gix::config::{Self, Config, AdminCap};
use gix::harness;
use gix::job::{Self, Job};
use gix::market::{Self, Market};
use gix::markets::M_H100_LLAMA8B;
use gix::registry::{Self, MeasurementAllowlist};
use gix::settlement::{Self, Treasury};
use gix::staking::{Self, ProviderStake};
use sui::test_scenario::{Self as ts};

const PRICE: u64 = 1_000_000;
const BOND: u64 = 10_000_000;
const CAPACITY: u64 = 100;
const QTY: u64 = 10;

// === I5 / settle guard: cannot settle a non-Verified job ===

#[test]
#[expected_failure(abort_code = gix::settlement::ENotVerified)]
fun cannot_settle_without_verified() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    let credits = harness::provider_setup(&mut sc, BOND, CAPACITY, QTY);
    harness::create_job(&mut sc, credits, PRICE);
    harness::ack(&mut sc);
    // Job is Executing, NOT Verified. settle must abort.
    harness::settle(&mut sc);
    sc.end();
}

// === Exactly-once settlement: double-settle aborts ===

#[test]
#[expected_failure(abort_code = gix::settlement::EBadState)]
fun cannot_double_settle() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    let credits = harness::provider_setup(&mut sc, BOND, CAPACITY, QTY);
    harness::create_job(&mut sc, credits, PRICE);
    harness::ack(&mut sc);
    harness::submit_attestation(&mut sc, harness::mock_measurement(), harness::output_hash(), 9000, 0, 3000);
    harness::settle(&mut sc);
    // Second settle on a now-Settled (terminal) job must abort.
    harness::settle(&mut sc);
    sc.end();
}

// === I3: cannot mint beyond capacity ===

#[test]
#[expected_failure(abort_code = gix::staking::EInsufficientCapacity)]
fun cannot_mint_beyond_capacity() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    // capacity = 10 but request 11 credits.
    sc.next_tx(harness::provider());
    let cfg = sc.take_shared<Config>();
    let cap = registry::register_provider(&cfg, b"http://node", b"H100-80GB", harness::dummy_pubkey(), sc.ctx());
    let mut market = sc.take_shared<Market<M_H100_LLAMA8B>>();
    let bond = harness::mint_usdc(&mut sc, BOND);
    let mut stake = staking::stake(&cap, &cfg, bond, 10, sc.ctx());
    let credits = staking::mint_credits<M_H100_LLAMA8B>(&cap, &mut stake, &cfg, &mut market, 11, sc.ctx());
    // unreachable; cleanup for the type checker.
    transfer::public_transfer(credits, harness::provider());
    ts::return_shared(cfg);
    ts::return_shared(market);
    transfer::public_transfer(cap, harness::provider());
    transfer::public_transfer(stake, harness::provider());
    sc.end();
}

// === K4: mock measurement refused on a non-localnet allowlist ===

#[test]
#[expected_failure(abort_code = gix::registry::EMockMeasurementOnLiveAllowlist)]
fun mock_measurement_rejected_when_not_localnet() {
    let mut sc = harness::begin();
    sc.next_tx(harness::admin());
    let cap = sc.take_from_sender<AdminCap>();
    let mut cfg = sc.take_shared<Config>();
    let mut allow = sc.take_shared<MeasurementAllowlist>();

    // Flip off the localnet flag (simulating testnet/mainnet deploy).
    config::set_is_localnet(&cap, &mut cfg, false);

    // Register a model, then try to add a MOCK-prefixed measurement → must abort.
    let model_id = registry::register_model(&cap, &cfg, b"m", b"b", harness::model_hash(), sc.ctx());
    registry::add_measurement(&cap, &cfg, &mut allow, model_id, harness::mock_measurement());

    ts::return_shared(cfg);
    ts::return_shared(allow);
    sc.return_to_sender(cap);
    sc.end();
}

// === K4: mock attestation accept path refuses when not localnet ===

#[test]
#[expected_failure(abort_code = gix::attestation::EMockMeasurementOnLiveAllowlist)]
fun mock_attestation_rejected_when_not_localnet() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    let credits = harness::provider_setup(&mut sc, BOND, CAPACITY, QTY);
    harness::create_job(&mut sc, credits, PRICE);
    harness::ack(&mut sc);

    // Flip localnet off after the (localnet) allowlist was seeded.
    sc.next_tx(harness::admin());
    {
        let cap = sc.take_from_sender<AdminCap>();
        let mut cfg = sc.take_shared<Config>();
        config::set_is_localnet(&cap, &mut cfg, false);
        ts::return_shared(cfg);
        sc.return_to_sender(cap);
    };

    // Now submit_mock_attestation must abort on the is_localnet guard.
    harness::submit_attestation(&mut sc, harness::mock_measurement(), harness::output_hash(), 9000, 0, 3000);
    sc.end();
}

// === Pause blocks the job path ===

#[test]
#[expected_failure(abort_code = gix::config::EPaused)]
fun pause_blocks_job_creation() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    let credits = harness::provider_setup(&mut sc, BOND, CAPACITY, QTY);

    // Admin pauses.
    sc.next_tx(harness::admin());
    {
        let cap = sc.take_from_sender<AdminCap>();
        let mut cfg = sc.take_shared<Config>();
        config::set_pause(&cap, &mut cfg, true);
        ts::return_shared(cfg);
        sc.return_to_sender(cap);
    };

    // create_job must abort with EPaused.
    harness::create_job(&mut sc, credits, PRICE);
    sc.end();
}

// === Deadline-not-passed: expire before any deadline aborts ===

#[test]
#[expected_failure(abort_code = gix::settlement::EDeadlineNotPassed)]
fun cannot_expire_before_deadline() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    let credits = harness::provider_setup(&mut sc, BOND, CAPACITY, QTY);
    harness::create_job(&mut sc, credits, PRICE);
    // Clock is at 0; ack_deadline is 30_000. Expire must abort (deadline not passed).
    harness::expire_and_resolve(&mut sc);
    sc.end();
}

// === Wrong provider cannot ack ===

#[test]
#[expected_failure(abort_code = gix::job::EWrongProvider)]
fun wrong_party_cannot_ack() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    let credits = harness::provider_setup(&mut sc, BOND, CAPACITY, QTY);
    harness::create_job(&mut sc, credits, PRICE);

    // Consumer (not provider) tries to ack.
    sc.next_tx(harness::consumer());
    {
        let mut job = sc.take_shared<Job<M_H100_LLAMA8B>>();
        let clk = sc.take_shared<sui::clock::Clock>();
        job::ack<M_H100_LLAMA8B>(&mut job, &clk, sc.ctx());
        ts::return_shared(job);
        ts::return_shared(clk);
    };
    sc.end();
}

// === Escrow conservation across settle: provider payout + fee == escrow ===

#[test]
fun escrow_conservation_on_settle() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    let credits = harness::provider_setup(&mut sc, BOND, CAPACITY, QTY);
    harness::create_job(&mut sc, credits, PRICE);
    harness::ack(&mut sc);
    harness::submit_attestation(&mut sc, harness::mock_measurement(), harness::output_hash(), 9000, 0, 3000);
    harness::settle(&mut sc);

    sc.next_tx(harness::provider());
    {
        let cfg = sc.take_shared<Config>();
        let treasury = sc.take_shared<Treasury>();
        let payout = harness::take_usdc(&mut sc, harness::provider());
        let fee = cfg.fee_amount(PRICE);
        // I1 + §9.2: payout + fee == escrow == PRICE.
        assert!(harness::coin_value(&payout) + settlement::treasury_balance(&treasury) == PRICE, 1);
        assert!(harness::coin_value(&payout) == PRICE - fee, 2);
        transfer::public_transfer(payout, harness::provider());
        ts::return_shared(cfg);
        ts::return_shared(treasury);
    };
    sc.end();
}
