/// M2 DeepBook fill-job (Option B — pay-at-match) scenario tests.
///
/// These prove the new `job::create_job_from_fill` path: a consumer who has (in production, in
/// the SAME PTB) swapped USDC→`Coin<Credit<M>>` on the market's DeepBook pool — PAYING THE
/// PROVIDER USDC AT THE FILL, off-chain to GIX — feeds the returned credits into a fill-job.
/// The defining property of a fill-job vs. the M1 escrow paths: there is **NO USDC escrow**.
/// The provider was already paid, so:
///   - on success (`settle_fill`): settlement pays NOTHING extra and moves NO USDC — it just
///     burns the reserved credit and retires the minted SCU → Settled (payout=0, fee=0);
///   - on fault (`resolve_fill`): there is no escrow to refund, so the consumer is compensated
///     ENTIRELY from the provider's slash (refund-from-slash) → Refunded(+Slashed).
///
/// The harness simulates the DeepBook swap by minting the provider's credits and transferring
/// them to the buyer (the swap's on-chain effect): GIX takes no DeepBook Move dependency; the
/// real composition is at the PTB level. A dummy `deepbook_pool_id` is bound onto the market
/// so the path's `assert_has_deepbook_pool` guard is satisfied.
///
/// Coverage:
///   - happy path: fill-job → ack → mock attest → `settle_fill` moves no USDC, burns credit,
///     consumes minted SCU, Settles (provider paid nothing extra on-chain);
///   - fault path: a fill-job whose attestation is an SLA breach → `resolve_fill` slashes the
///     provider and refunds the CONSUMER in USDC from the slash (no escrow leg);
///   - credit single-spend: the swap-output credit is consumed by `create_job_from_fill` and
///     cannot be reused (it is moved into the Job, then burned at settle);
///   - guards: no bound pool rejects creation; escrow-path settle on a fill-job and fill-path
///     settle on an escrow job both abort `EWrongJobKind`.
#[test_only]
module gix::fill_flow_tests;

use gix::config::Config;
use gix::harness;
use gix::job::{Self, Job};
use gix::markets::M_H100_LLAMA8B;
use gix::settlement::{Self, Treasury};
use gix::staking::{Self, ProviderStake};
use sui::test_scenario::{Self as ts};

const BOND: u64 = 10_000_000; // 10 mUSDC
const CAPACITY: u64 = 100;
const QTY: u64 = 10;
const IN_BLOB: u256 = 0xABCD; // Walrus input blob id (commitment, not a hash)

// A 32-byte dummy attestation pubkey — the mock attestation path never verifies a signature.
fun dummy_key(): vector<u8> {
    x"0000000000000000000000000000000000000000000000000000000000000000"
}

// === Happy path: fill-job settles with NO extra USDC moved (provider paid at the match) ===

#[test]
fun fill_job_settles_no_escrow_burns_credit() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    harness::bind_deepbook_pool(&mut sc);
    // Provider mints + (simulated swap) hands the credits to the buyer; provider "already paid".
    harness::fill_setup_with_key(&mut sc, harness::consumer(), BOND, CAPACITY, QTY, dummy_key());

    let job_id = harness::create_job_from_fill(&mut sc, harness::consumer(), IN_BLOB, harness::input_hash());

    // The fill-job: no escrow, is_fill flag set, input blob recorded, price = qty (value-at-risk).
    sc.next_tx(harness::consumer());
    {
        let job = sc.take_shared<Job<M_H100_LLAMA8B>>();
        assert!(object::id(&job) == job_id, 1);
        assert!(job::job_is_fill(&job), 2);
        assert!(job::job_escrow_value(&job) == 0, 3);
        assert!(job::job_input_blob_id(&job) == IN_BLOB, 4);
        assert!(job::job_provider(&job) == harness::provider(), 5);
        assert!(job::job_consumer(&job) == harness::consumer(), 6);
        assert!(job::job_qty(&job) == QTY, 7);
        ts::return_shared(job);
    };

    harness::ack(&mut sc);
    harness::submit_attestation(&mut sc, harness::mock_measurement(), harness::output_hash(), 9000, 0, 3000);

    sc.next_tx(harness::consumer());
    {
        let job = sc.take_shared<Job<M_H100_LLAMA8B>>();
        assert!(job::job_state(&job) == job::s_verified(), 8);
        ts::return_shared(job);
    };

    // Settle the fill-job: NO escrow release, NO payout, NO fee — provider already paid.
    harness::settle_fill(&mut sc);

    // Job Settled; minted SCU consumed; treasury untouched (no fee on a fill-job settle).
    sc.next_tx(harness::provider());
    {
        let job = sc.take_shared<Job<M_H100_LLAMA8B>>();
        let stake = ts::take_from_address<ProviderStake>(&sc, harness::provider());
        let treasury = sc.take_shared<Treasury>();
        assert!(job::job_state(&job) == job::s_settled(), 9);
        assert!(staking::minted_scu(&stake) == 0, 10); // QTY minted, consumed at settle_fill
        assert!(staking::reserved_scu(&stake) == 0, 11);
        assert!(settlement::treasury_balance(&treasury) == 0, 12); // no USDC moved on-chain
        ts::return_shared(job);
        ts::return_to_address(harness::provider(), stake);
        ts::return_shared(treasury);
    };

    // The provider received NO on-chain payout coin (it was paid at the fill, off-chain to GIX).
    assert!(!harness::has_usdc(harness::provider()), 13);
    sc.end();
}

// === Fault path: refund-from-slash (no escrow) — SLA breach slashes provider, refunds buyer ===

#[test]
fun fill_job_fault_refunds_consumer_from_slash() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    harness::bind_deepbook_pool(&mut sc);
    harness::fill_setup_with_key(&mut sc, harness::consumer(), BOND, CAPACITY, QTY, dummy_key());
    harness::create_job_from_fill(&mut sc, harness::consumer(), IN_BLOB, harness::input_hash());
    harness::ack(&mut sc);

    // Mock attestation with latency 8s > 5s p99 → SLA_BREACH verdict (Attested, not Verified).
    harness::submit_attestation(&mut sc, harness::mock_measurement(), harness::output_hash(), 9000, 0, 8000);

    sc.next_tx(harness::consumer());
    {
        let job = sc.take_shared<Job<M_H100_LLAMA8B>>();
        assert!(job::job_state(&job) == job::s_attested(), 1);
        assert!(job::job_escrow_value(&job) == 0, 2); // never had escrow
        ts::return_shared(job);
    };

    // No escrow to refund → the consumer's whole compensation comes from the slash.
    harness::resolve_fill(&mut sc);

    sc.next_tx(harness::consumer());
    {
        let job = sc.take_shared<Job<M_H100_LLAMA8B>>();
        assert!(job::job_state(&job) == job::s_refunded(), 3);
        assert!(job::job_slashed(&job), 4);
        ts::return_shared(job);
    };

    // SLA slash = slash_bps_sla (5000 = 50%) of bond_share (BOND*QTY/CAPACITY = 1_000_000) =
    // 500_000. price_usdc = QTY = 10, so the consumer is compensated min(500_000, 10) = 10 USDC
    // from the slash and the remainder (499_990) lands in the treasury.
    sc.next_tx(harness::provider());
    {
        let stake = ts::take_from_address<ProviderStake>(&sc, harness::provider());
        assert!(staking::slashed_total(&stake) == 500_000, 5);
        ts::return_to_address(harness::provider(), stake);
    };

    // Consumer was compensated in USDC FROM THE SLASH (refund-from-slash), even with no escrow.
    sc.next_tx(harness::consumer());
    {
        let comp = harness::take_usdc(&mut sc, harness::consumer());
        assert!(harness::coin_value(&comp) == QTY, 6); // == price_usdc (value-at-risk cap)
        transfer::public_transfer(comp, harness::consumer());
    };

    // Treasury holds the slash remainder; no protocol fee on a faulted job.
    sc.next_tx(harness::consumer());
    {
        let treasury = sc.take_shared<Treasury>();
        assert!(settlement::treasury_slash_collected(&treasury) == 500_000 - QTY, 7);
        assert!(settlement::treasury_fees_collected(&treasury) == 0, 8);
        ts::return_shared(treasury);
    };
    sc.end();
}

// === Credit single-spend: the swap-output credit is consumed once and burned at settle ===

#[test]
fun fill_credit_single_spend() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    harness::bind_deepbook_pool(&mut sc);
    harness::fill_setup_with_key(&mut sc, harness::consumer(), BOND, CAPACITY, QTY, dummy_key());

    // The buyer holds exactly one credit coin worth QTY before creating the job.
    sc.next_tx(harness::consumer());
    {
        assert!(ts::has_most_recent_for_address<sui::coin::Coin<gix::credit::Credit<M_H100_LLAMA8B>>>(harness::consumer()), 1);
    };

    harness::create_job_from_fill(&mut sc, harness::consumer(), IN_BLOB, harness::input_hash());

    // After creation the credit coin is GONE from the buyer (moved into the Job, to be burned).
    sc.next_tx(harness::consumer());
    {
        assert!(!ts::has_most_recent_for_address<sui::coin::Coin<gix::credit::Credit<M_H100_LLAMA8B>>>(harness::consumer()), 2);
    };

    harness::ack(&mut sc);
    harness::submit_attestation(&mut sc, harness::mock_measurement(), harness::output_hash(), 9000, 0, 3000);
    harness::settle_fill(&mut sc);

    // Credits fully burned at settle: market supply back to zero.
    sc.next_tx(harness::provider());
    {
        let market = sc.take_shared<gix::market::Market<M_H100_LLAMA8B>>();
        assert!(gix::market::outstanding_credits<M_H100_LLAMA8B>(&market) == 0, 3);
        ts::return_shared(market);
    };
    sc.end();
}

// === Guard: a market with no bound DeepBook pool rejects fill-job creation ===

#[test]
#[expected_failure(abort_code = gix::market::ENoPool)]
fun fill_requires_bound_pool() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    // NOTE: deliberately NOT binding a pool.
    harness::fill_setup_with_key(&mut sc, harness::consumer(), BOND, CAPACITY, QTY, dummy_key());
    harness::create_job_from_fill(&mut sc, harness::consumer(), IN_BLOB, harness::input_hash());
    sc.end();
}

// === Guard: the escrow-path `settle` rejects a fill-job (EWrongJobKind) ===

#[test]
#[expected_failure(abort_code = gix::settlement::EWrongJobKind)]
fun escrow_settle_rejects_fill_job() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    harness::bind_deepbook_pool(&mut sc);
    harness::fill_setup_with_key(&mut sc, harness::consumer(), BOND, CAPACITY, QTY, dummy_key());
    harness::create_job_from_fill(&mut sc, harness::consumer(), IN_BLOB, harness::input_hash());
    harness::ack(&mut sc);
    harness::submit_attestation(&mut sc, harness::mock_measurement(), harness::output_hash(), 9000, 0, 3000);
    // Wrong settlement entrypoint for a fill-job → aborts.
    harness::settle(&mut sc);
    sc.end();
}

// === Guard: the fill-path `settle_fill` rejects an escrow job (EWrongJobKind) ===

#[test]
#[expected_failure(abort_code = gix::settlement::EWrongJobKind)]
fun fill_settle_rejects_escrow_job() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    // A normal M1 owned-credits escrow job (NOT a fill-job).
    let credits = harness::provider_setup(&mut sc, BOND, CAPACITY, QTY);
    harness::create_job(&mut sc, credits, 1_000_000);
    harness::ack(&mut sc);
    harness::submit_attestation(&mut sc, harness::mock_measurement(), harness::output_hash(), 9000, 0, 3000);
    // Wrong settlement entrypoint for an escrow job → aborts.
    harness::settle_fill(&mut sc);
    sc.end();
}
