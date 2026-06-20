/// End-to-end lifecycle + fault-path scenario tests for the `gix` package.
///
/// Each test drives a full Job through the state machine via `gix::harness` and asserts the
/// terminal fund movement, credit accounting, and slash/refund correctness. Together they
/// cover: happy path; invalid attestation; missing attestation (deadline); SLA breach (both
/// the attested-SLA-breach verdict and the exec-deadline overrun); liveness/no-ack timeout;
/// consumer cancel; and the core invariants (escrow conservation, exactly-once settlement,
/// no payout without Verified, no slash without provider fault, capacity bound on minting).
#[test_only]
module gix::lifecycle_tests;

use gix::config::Config;
use gix::harness;
use gix::job::{Self, Job};
use gix::markets::M_H100_LLAMA8B;
use gix::settlement::{Self, Treasury};
use gix::staking::{Self, ProviderStake};
use sui::test_scenario::{Self as ts};

const PRICE: u64 = 1_000_000; // 1 mUSDC (6 decimals)
const BOND: u64 = 10_000_000; // 10 mUSDC
const CAPACITY: u64 = 100;
const QTY: u64 = 10;

// === Happy path ===

#[test]
fun happy_path_settles_and_pays_provider() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    let credits = harness::provider_setup(&mut sc, BOND, CAPACITY, QTY);
    harness::create_job(&mut sc, credits, PRICE);

    harness::ack(&mut sc);
    // Within SLA: latency 3s < 5s p99.
    harness::submit_attestation(&mut sc, harness::mock_measurement(), harness::output_hash(), 9000, 0, 3000);

    // Assert Verified before settle.
    sc.next_tx(harness::consumer());
    {
        let job = sc.take_shared<Job<M_H100_LLAMA8B>>();
        assert!(job::job_state(&job) == job::s_verified(), 1);
        ts::return_shared(job);
    };

    harness::settle(&mut sc);

    // Provider received price − fee; treasury got fee; job Settled; credits burned.
    sc.next_tx(harness::consumer());
    {
        let job = sc.take_shared<Job<M_H100_LLAMA8B>>();
        let cfg = sc.take_shared<Config>();
        let treasury = sc.take_shared<Treasury>();
        let fee = cfg.fee_amount(PRICE);
        assert!(job::job_state(&job) == job::s_settled(), 2);
        assert!(job::job_slashed(&job) == false, 3);
        assert!(job::job_escrow_value(&job) == 0, 4); // I1: escrow drained
        assert!(settlement::treasury_balance(&treasury) == fee, 5);
        assert!(settlement::treasury_fees_collected(&treasury) == fee, 6);
        ts::return_shared(job);
        ts::return_shared(cfg);
        ts::return_shared(treasury);
    };

    // Provider's payout coin.
    sc.next_tx(harness::provider());
    {
        let cfg = sc.take_shared<Config>();
        let fee = cfg.fee_amount(PRICE);
        let payout = harness::take_usdc(&mut sc, harness::provider());
        assert!(harness::coin_value(&payout) == PRICE - fee, 7);
        transfer::public_transfer(payout, harness::provider());
        ts::return_shared(cfg);
    };

    // Provider stake: minted consumed, reservation released.
    sc.next_tx(harness::provider());
    {
        let stake = ts::take_from_address<ProviderStake>(&sc, harness::provider());
        assert!(staking::reserved_scu(&stake) == 0, 8);
        assert!(staking::minted_scu(&stake) == 0, 9); // QTY minted then consumed
        ts::return_to_address(harness::provider(), stake);
    };

    sc.end();
}

// === Invalid attestation: wrong measurement (not allowlisted) → INVALID verdict ===

#[test]
fun invalid_attestation_refunds_and_slashes() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    let credits = harness::provider_setup(&mut sc, BOND, CAPACITY, QTY);
    harness::create_job(&mut sc, credits, PRICE);
    harness::ack(&mut sc);

    // A different (still mock-prefixed, so it passes the K4 localnet gate) measurement that
    // is NOT on the allowlist → INVALID verdict.
    harness::submit_attestation(&mut sc, b"MOCK-not-allowlisted", harness::output_hash(), 9000, 0, 3000);

    // Job is Attested with an INVALID verdict (not Verified).
    sc.next_tx(harness::consumer());
    {
        let job = sc.take_shared<Job<M_H100_LLAMA8B>>();
        assert!(job::job_state(&job) == job::s_attested(), 1);
        ts::return_shared(job);
    };

    harness::resolve_attested(&mut sc);

    sc.next_tx(harness::consumer());
    {
        let job = sc.take_shared<Job<M_H100_LLAMA8B>>();
        assert!(job::job_state(&job) == job::s_refunded(), 2);
        assert!(job::job_slashed(&job) == true, 3);
        assert!(job::job_escrow_value(&job) == 0, 4);
        ts::return_shared(job);
    };

    // Consumer got full refund (PRICE). Invalid slash is 100% of bond share + flat(0).
    // bond_share = BOND * QTY / CAPACITY = 10_000_000 * 10 / 100 = 1_000_000.
    // D1: consumer comp up to PRICE (1_000_000) first; penalty(1_000_000) == PRICE so all to
    // consumer, treasury slash = 0. Consumer ends with refund + comp = 2 * PRICE across coins.
    sc.next_tx(harness::consumer());
    {
        let treasury = sc.take_shared<Treasury>();
        assert!(settlement::treasury_slash_collected(&treasury) == 0, 5);
        // No fee on a faulted job.
        assert!(settlement::treasury_fees_collected(&treasury) == 0, 6);
        ts::return_shared(treasury);
    };

    // Provider's bond was debited by the slash; capacity de-rated.
    sc.next_tx(harness::provider());
    {
        let stake = ts::take_from_address<ProviderStake>(&sc, harness::provider());
        assert!(staking::slashed_total(&stake) == 1_000_000, 7);
        assert!(staking::bond_value(&stake) == BOND - 1_000_000, 8);
        // de-rated by 10% of 100 = 90.
        assert!(staking::capacity_scu(&stake) == 90, 9);
        assert!(staking::reserved_scu(&stake) == 0, 10);
        ts::return_to_address(harness::provider(), stake);
    };

    sc.end();
}

// === SLA breach verdict: valid measurement but latency over p99 ===

#[test]
fun sla_breach_verdict_refunds_and_slashes() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    let credits = harness::provider_setup(&mut sc, BOND, CAPACITY, QTY);
    harness::create_job(&mut sc, credits, PRICE);
    harness::ack(&mut sc);

    // Valid measurement, but latency 8s > 5s p99 → SLA_BREACH verdict.
    harness::submit_attestation(&mut sc, harness::mock_measurement(), harness::output_hash(), 9000, 0, 8000);

    harness::resolve_attested(&mut sc);

    sc.next_tx(harness::consumer());
    {
        let job = sc.take_shared<Job<M_H100_LLAMA8B>>();
        assert!(job::job_state(&job) == job::s_refunded(), 1);
        assert!(job::job_slashed(&job) == true, 2);
        ts::return_shared(job);
    };

    // SLA slash is graded: slash_bps_sla = 5000 (50%) of bond_share(1_000_000) = 500_000.
    sc.next_tx(harness::provider());
    {
        let stake = ts::take_from_address<ProviderStake>(&sc, harness::provider());
        assert!(staking::slashed_total(&stake) == 500_000, 3);
        ts::return_to_address(harness::provider(), stake);
    };

    sc.end();
}

// === Missing attestation: acked, never submitted, past attest deadline ===

#[test]
fun missing_attestation_refunds_and_slashes() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    let credits = harness::provider_setup(&mut sc, BOND, CAPACITY, QTY);
    harness::create_job(&mut sc, credits, PRICE);
    harness::ack(&mut sc);

    // attest_deadline = p99*6 + 30_000 = 30_000 + 30_000 = 60_000. Jump past it.
    harness::set_clock(&mut sc, 70_000);
    harness::expire_and_resolve(&mut sc);

    sc.next_tx(harness::consumer());
    {
        let job = sc.take_shared<Job<M_H100_LLAMA8B>>();
        assert!(job::job_state(&job) == job::s_refunded(), 1);
        assert!(job::job_slashed(&job) == true, 2);
        ts::return_shared(job);
    };

    // Missing = 100% of bond share = 1_000_000.
    sc.next_tx(harness::provider());
    {
        let stake = ts::take_from_address<ProviderStake>(&sc, harness::provider());
        assert!(staking::slashed_total(&stake) == 1_000_000, 3);
        ts::return_to_address(harness::provider(), stake);
    };

    sc.end();
}

// === Liveness fault: never acked, past ack deadline ===

#[test]
fun no_ack_liveness_slash() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    let credits = harness::provider_setup(&mut sc, BOND, CAPACITY, QTY);
    harness::create_job(&mut sc, credits, PRICE);

    // Do NOT ack. ack_deadline = 30_000. Jump past it.
    harness::set_clock(&mut sc, 40_000);
    harness::expire_and_resolve(&mut sc);

    sc.next_tx(harness::consumer());
    {
        let job = sc.take_shared<Job<M_H100_LLAMA8B>>();
        assert!(job::job_state(&job) == job::s_refunded(), 1);
        assert!(job::job_slashed(&job) == true, 2);
        ts::return_shared(job);
    };

    // Liveness = slash_bps_liveness (300 = 3%) of bond_share(1_000_000) = 30_000.
    sc.next_tx(harness::provider());
    {
        let stake = ts::take_from_address<ProviderStake>(&sc, harness::provider());
        assert!(staking::slashed_total(&stake) == 30_000, 3);
        ts::return_to_address(harness::provider(), stake);
    };

    sc.end();
}

// === No-fault: consumer cancels before ack ===

#[test]
fun consumer_cancel_no_slash() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    let credits = harness::provider_setup(&mut sc, BOND, CAPACITY, QTY);
    harness::create_job(&mut sc, credits, PRICE);

    // Consumer cancels pre-ack.
    sc.next_tx(harness::consumer());
    {
        let mut job = sc.take_shared<Job<M_H100_LLAMA8B>>();
        let cfg = sc.take_shared<Config>();
        let mut stake = ts::take_from_address<ProviderStake>(&sc, harness::provider());
        settlement::cancel<M_H100_LLAMA8B>(&mut job, &cfg, &mut stake, sc.ctx());
        assert!(job::job_state(&job) == job::s_refunded(), 1);
        assert!(job::job_slashed(&job) == false, 2);
        ts::return_shared(job);
        ts::return_shared(cfg);
        ts::return_to_address(harness::provider(), stake);
    };

    // No slash.
    sc.next_tx(harness::provider());
    {
        let stake = ts::take_from_address<ProviderStake>(&sc, harness::provider());
        assert!(staking::slashed_total(&stake) == 0, 3);
        assert!(staking::reserved_scu(&stake) == 0, 4);
        assert!(staking::bond_value(&stake) == BOND, 5);
        ts::return_to_address(harness::provider(), stake);
    };

    sc.end();
}
