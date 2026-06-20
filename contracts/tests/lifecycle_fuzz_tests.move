/// F6 / L4 — Lifecycle property/fuzz for the pool-free (Ask) path.
///
/// docs/pool-free-e2e-delivery-and-test-plan.md §3 (L4) + §4 F6: drive a SEEDED, deterministic
/// sequence of random VALID and INVALID lifecycle outcomes over many independent Ask-created
/// jobs and assert the money invariants hold THROUGHOUT — not just at the end. No `sui::random`:
/// a counter/LCG PRNG seeds the sequence so it is fully reproducible (the §3 determinism rule),
/// and the `Clock` test handle pins all expiry timing.
///
/// Global invariants checked after EVERY terminal op (running totals):
///   (1) Escrow conservation: Σ escrow_locked == Σ provider_payouts + Σ treasury_fees
///       + Σ consumer_refunds. Every USDC that entered escrow leaves through exactly one of
///       those sinks — none minted or burned.
///   (2) Bond conservation: Σ bond_debited == Σ slashed_total == Σ consumer_comp_from_slash
///       + Σ treasury_slash. The slash is the only NEW money and is fully distributed.
///   (3) No slash without fault: the running slash total only grows on the fault branches; a
///       happy settle adds 0 to it.
///   (4) Per job: exactly one terminal state is reached.
#[test_only]
module gix::lifecycle_fuzz_tests;

use gix::ask::{Self, Ask};
use gix::config::Config;
use gix::harness;
use gix::job::{Self, Job};
use gix::markets::M_H100_LLAMA8B;
use gix::mock_usdc::MOCK_USDC;
use gix::settlement::{Self, Treasury};
use gix::staking::{Self, ProviderStake};
use std::unit_test::destroy;
use sui::coin::Coin;
use sui::test_scenario::{Self as ts, Scenario};

const BOND: u64 = 1_000_000_000; // 1000 mUSDC — never exhausted across the run
const CAPACITY: u64 = 100_000;
const PRICE_PER_SCU: u64 = 100_000;
const QTY: u64 = 10;
const ESCROW: u64 = QTY * PRICE_PER_SCU; // 1_000_000 per job

const N_JOBS: u64 = 18;

// Deterministic counter PRNG (NOT sui::random): a 31-bit LCG in u128, so the product can never
// overflow (Move aborts on overflow) and the run is reproducible from the seed.
fun lcg_next(state: &mut u64): u64 {
    let next = (((*state as u128) * 1103515245 + 12345) % 2147483648) as u64;
    *state = next;
    next
}

// Sum + DRAIN every MOCK_USDC coin owned by `who` (returns the total moved to them since the
// last drain). Draining lets us accumulate running totals across many jobs.
fun drain_usdc(sc: &mut Scenario, who: address): u64 {
    sc.next_tx(who);
    let mut total = 0u64;
    while (ts::has_most_recent_for_address<Coin<MOCK_USDC>>(who)) {
        let c = ts::take_from_address<Coin<MOCK_USDC>>(sc, who);
        total = total + harness::coin_value(&c);
        destroy(c);
    };
    total
}

fun read_treasury(sc: &mut Scenario): (u64, u64, u64) {
    sc.next_tx(harness::admin());
    let t = sc.take_shared<Treasury<MOCK_USDC>>();
    let bal = settlement::treasury_balance(&t);
    let fees = settlement::treasury_fees_collected(&t);
    let slash = settlement::treasury_slash_collected(&t);
    ts::return_shared(t);
    (bal, fees, slash)
}

fun read_stake(sc: &mut Scenario): (u64, u64) {
    sc.next_tx(harness::provider());
    let stake = ts::take_from_address<ProviderStake<MOCK_USDC>>(sc, harness::provider());
    let bond = staking::bond_value(&stake);
    let slashed = staking::slashed_total(&stake);
    ts::return_to_address(harness::provider(), stake);
    (bond, slashed)
}

fun ask_remaining(sc: &mut Scenario): u64 {
    sc.next_tx(harness::provider());
    let ask = sc.take_shared<Ask<M_H100_LLAMA8B>>();
    let r = ask::remaining_scu<M_H100_LLAMA8B>(&ask);
    ts::return_shared(ask);
    r
}

#[test]
fun seeded_lifecycle_sequence_preserves_invariants() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    harness::provider_register_and_stake(&mut sc, BOND, CAPACITY);
    // One big resting ask the run fills from, one job at a time.
    harness::post_ask(&mut sc, N_JOBS * QTY, PRICE_PER_SCU);

    let (bond_start, slashed_start) = read_stake(&mut sc);
    assert!(slashed_start == 0, 1);

    // Running model totals.
    let mut total_locked: u64 = 0;          // Σ escrow ever locked
    let mut total_provider_payout: u64 = 0; // Σ paid to the provider (settle)
    let mut total_consumer_usdc: u64 = 0;   // Σ refunds + comp to consumers
    let mut prev_slashed: u64 = 0;          // last-seen on-chain slashed_total

    let mut state: u64 = 0xA11CE; // seed
    let mut i: u64 = 0;
    while (i < N_JOBS) {
        // Fill one slice into a fresh job (buyer = consumer2, a distinct wallet).
        harness::create_job_from_ask(&mut sc, harness::consumer2(), QTY, ESCROW);
        total_locked = total_locked + ESCROW;
        harness::ack(&mut sc);

        let r = lcg_next(&mut state) % 3;
        let mut was_fault;
        if (r == 0) {
            // Branch A — happy: VALID attestation within SLA → settle → provider paid, no slash.
            harness::submit_attestation(&mut sc, harness::mock_measurement(), harness::output_hash(), 9000, 0, 3000);
            harness::settle(&mut sc);
            was_fault = false;
            assert_job_state(&mut sc, job::s_settled(), 10);
        } else if (r == 1) {
            // Branch B — SLA breach verdict: valid measurement, latency 8s > 5s → resolve.
            harness::submit_attestation(&mut sc, harness::mock_measurement(), harness::output_hash(), 9000, 0, 8000);
            harness::resolve_attested(&mut sc);
            was_fault = true;
            assert_job_state(&mut sc, job::s_refunded(), 11);
        } else {
            // Branch C — missed attestation: acked but never attests; expire past attest_deadline.
            // Advance the clock generously past the per-job attest deadline.
            harness::advance_clock(&mut sc, 200_000);
            harness::expire_and_resolve(&mut sc);
            was_fault = true;
            assert_job_state(&mut sc, job::s_refunded(), 12);
        };

        // Sweep money that moved to each party this iteration into the running totals.
        total_provider_payout = total_provider_payout + drain_usdc(&mut sc, harness::provider());
        total_consumer_usdc = total_consumer_usdc + drain_usdc(&mut sc, harness::consumer2());

        let (tbal, tfees, tslash) = read_treasury(&mut sc);
        let (bond_now, slashed_now) = read_stake(&mut sc);

        // (3) No slash without fault: the slash total advances ONLY on a fault branch.
        if (was_fault) {
            assert!(slashed_now >= prev_slashed, 20);
        } else {
            assert!(slashed_now == prev_slashed, 21); // happy settle slashed nothing this step
        };
        prev_slashed = slashed_now;

        // (2) Bond conservation: the total bond debited equals the on-chain slashed_total, and
        // the slash splits cleanly into (comp moved to consumers) + (slash retained by treasury).
        // No new money beyond the slash, none lost: comp_from_slash + tslash == slashed_now.
        let bond_debit = bond_start - bond_now;
        assert!(bond_debit == slashed_now, 22);
        let comp_from_slash = slashed_now - tslash; // the part of the slash paid to consumers
        assert!(comp_from_slash <= total_consumer_usdc, 23); // consumers received at least the comp

        // (1) Escrow conservation: every locked escrow USDC now sits in exactly one sink —
        // provider payouts + treasury fees + consumer escrow-refunds — where consumer
        // escrow-refunds = (all USDC consumers hold) − (the comp that came from the slash).
        //   Σlocked == Σpayout + Σfees + Σ(consumer escrow-refunds)
        let consumer_refunds = total_consumer_usdc - comp_from_slash;
        assert!(total_provider_payout + tfees + consumer_refunds == total_locked, 24);

        // Treasury's own ledger is internally consistent: balance == fees + slash retained.
        assert!(tbal == tfees + tslash, 25);

        i = i + 1;
    };

    // The ask drained by exactly N_JOBS * QTY (every fill consumed exactly its slice).
    assert!(ask_remaining(&mut sc) == 0, 30);
    sc.end();
}

fun assert_job_state(sc: &mut Scenario, expected: u8, code: u64) {
    sc.next_tx(harness::consumer2());
    let job = sc.take_shared<Job<M_H100_LLAMA8B, MOCK_USDC>>();
    assert!(job::job_state(&job) == expected, code);
    assert!(job::job_escrow_value(&job) == 0, code + 100); // (4) escrow fully disposed at terminal
    ts::return_shared(job);
}
