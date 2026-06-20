/// F6 — Settlement money invariants for the pool-free (Ask) path.
///
/// docs/pool-free-e2e-delivery-and-test-plan.md §4 F6 — assert after EVERY lifecycle op:
///   (1) Escrow conservation: every locked escrow USDC leaves as exactly one of
///       {provider payout + protocol fee}  (settle / Verified)  OR
///       {full refund to consumer}          (fault paths) — nothing minted or burned outside
///       these. The slash is a SEPARATE flow from the provider's BOND (not the escrow): on a
///       fault the bond debit equals consumer-comp + treasury-slash exactly (bond conservation).
///   (2) No payout without `Verified`: a non-Verified job can never pay the provider (settle
///       aborts ENotVerified; the only payout site requires state Verified).
///   (3) Exactly-once terminal: a second settlement/resolution aborts (EBadState).
///   (4) No slash without fault: a correctly-served, settled job slashes nothing.
///
/// Every job here is an ASK-created job (`create_job_from_ask`) — the pool-free direct path —
/// driven through the existing provider-signed settlement entrypoints. The `Clock` test handle
/// pins all deadline/SLA/expiry timing; everything is deterministic.
#[test_only]
module gix::money_invariant_tests;

use gix::config::Config;
use gix::harness;
use gix::job::{Self, Job};
use gix::markets::M_H100_LLAMA8B;
use gix::mock_usdc::MOCK_USDC;
use gix::settlement::{Self, Treasury};
use gix::staking::{Self, ProviderStake};
use std::unit_test::destroy;
use sui::test_scenario::{Self as ts, Scenario};

const BOND: u64 = 100_000_000; // generous bond so multi-job slashes never exhaust it
const CAPACITY: u64 = 1000;
const PRICE_PER_SCU: u64 = 100_000;
const QTY: u64 = 10;
const ESCROW: u64 = QTY * PRICE_PER_SCU; // 1_000_000

// Read provider bond + slashed_total.
fun read_stake(sc: &mut Scenario): (u64, u64) {
    sc.next_tx(harness::provider());
    let stake = ts::take_from_address<ProviderStake<MOCK_USDC>>(sc, harness::provider());
    let bond = staking::bond_value(&stake);
    let slashed = staking::slashed_total(&stake);
    ts::return_to_address(harness::provider(), stake);
    (bond, slashed)
}

// Read treasury (balance, fees, slash).
fun read_treasury(sc: &mut Scenario): (u64, u64, u64) {
    sc.next_tx(harness::admin());
    let t = sc.take_shared<Treasury<MOCK_USDC>>();
    let bal = settlement::treasury_balance(&t);
    let fees = settlement::treasury_fees_collected(&t);
    let slash = settlement::treasury_slash_collected(&t);
    ts::return_shared(t);
    (bal, fees, slash)
}

// Sum all MOCK_USDC coins owned by `who` (drains then restores them). Used to total payouts /
// refunds / compensations that settlement transferred to a party as owned coins.
fun usdc_held_by(sc: &mut Scenario, who: address): u64 {
    sc.next_tx(who);
    let mut total = 0u64;
    while (ts::has_most_recent_for_address<sui::coin::Coin<MOCK_USDC>>(who)) {
        let c = ts::take_from_address<sui::coin::Coin<MOCK_USDC>>(sc, who);
        total = total + harness::coin_value(&c);
        // Discard it; the next iteration sees the NEXT coin in this party's inventory.
        destroy(c);
    };
    total
}

fun fee_on(sc: &mut Scenario, amount: u64): u64 {
    sc.next_tx(harness::admin());
    let cfg = sc.take_shared<Config>();
    let f = cfg.fee_amount(amount);
    ts::return_shared(cfg);
    f
}

// === Invariant 1 (settle): escrow == payout + fee; Invariant 4: no slash on a good job ===

#[test]
fun settle_conserves_escrow_and_does_not_slash() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    harness::provider_register_and_stake(&mut sc, BOND, CAPACITY);
    harness::post_ask(&mut sc, QTY, PRICE_PER_SCU);

    let (bond0, slashed0) = read_stake(&mut sc);
    assert!(slashed0 == 0, 1);

    harness::create_job_from_ask(&mut sc, harness::consumer2(), QTY, ESCROW);
    harness::ack(&mut sc);
    harness::submit_attestation(&mut sc, harness::mock_measurement(), harness::output_hash(), 9000, 0, 3000);
    harness::settle(&mut sc);

    let fee = fee_on(&mut sc, ESCROW);
    let payout = usdc_held_by(&mut sc, harness::provider());
    let (tbal, tfees, tslash) = read_treasury(&mut sc);

    // (1) escrow conservation: provider payout + treasury fee == the locked escrow, exactly.
    assert!(payout + tbal == ESCROW, 2);
    assert!(payout == ESCROW - fee, 3);
    assert!(tfees == fee, 4);
    assert!(tslash == 0, 5);

    // (4) no slash without fault: a correctly-served job never debits the bond.
    let (bond1, slashed1) = read_stake(&mut sc);
    assert!(bond1 == bond0, 6);
    assert!(slashed1 == 0, 7);

    // Job escrow fully drained (no USDC stranded inside the Job).
    sc.next_tx(harness::consumer2());
    {
        let job = sc.take_shared<Job<M_H100_LLAMA8B, MOCK_USDC>>();
        assert!(job::job_escrow_value(&job) == 0, 8);
        assert!(job::job_state(&job) == job::s_settled(), 9);
        ts::return_shared(job);
    };
    sc.end();
}

// === Invariant 1 (fault): escrow fully refunded; bond debit == comp + treasury-slash ===

#[test]
fun fault_refunds_full_escrow_and_conserves_bond() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    harness::provider_register_and_stake(&mut sc, BOND, CAPACITY);
    harness::post_ask(&mut sc, QTY, PRICE_PER_SCU);

    let (bond0, _s0) = read_stake(&mut sc);

    harness::create_job_from_ask(&mut sc, harness::consumer2(), QTY, ESCROW);
    harness::ack(&mut sc);
    // SLA breach verdict → fault path.
    harness::submit_attestation(&mut sc, harness::mock_measurement(), harness::output_hash(), 9000, 0, 8000);
    harness::resolve_attested(&mut sc);

    // Consumer holds: full escrow refund + slash compensation (capped at job value).
    let consumer_total = usdc_held_by(&mut sc, harness::consumer2());
    let (bond1, slashed1) = read_stake(&mut sc);
    let (_tbal, tfees, tslash) = read_treasury(&mut sc);

    // Escrow conservation: the consumer got the WHOLE escrow back (refund == ESCROW); the
    // additional comp comes from the slash, not the escrow. consumer_total = ESCROW + comp.
    let comp = consumer_total - ESCROW;

    // Bond conservation: the bond debit == what the slash distributed (comp to consumer +
    // remainder to treasury). Nothing minted or burned: the slash is the only new money.
    let bond_debit = bond0 - bond1;
    assert!(bond_debit == slashed1, 1);               // slashed_total tracks the debit
    assert!(bond_debit == comp + tslash, 2);          // distributed entirely (consumer + treasury)

    // No protocol fee is taken on a faulted job.
    assert!(tfees == 0, 3);

    // The job escrow is drained and the job is terminal Refunded(+Slashed).
    sc.next_tx(harness::consumer2());
    {
        let job = sc.take_shared<Job<M_H100_LLAMA8B, MOCK_USDC>>();
        assert!(job::job_escrow_value(&job) == 0, 4);
        assert!(job::job_state(&job) == job::s_refunded(), 5);
        assert!(job::job_slashed(&job), 6);
        ts::return_shared(job);
    };
    sc.end();
}

// === Invariant 1 (expire): a missed deadline refunds the full escrow + slashes (bond conserved) ===

#[test]
fun expire_refunds_full_escrow_and_conserves_bond() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    harness::provider_register_and_stake(&mut sc, BOND, CAPACITY);
    harness::post_ask(&mut sc, QTY, PRICE_PER_SCU);

    let (bond0, _s0) = read_stake(&mut sc);

    harness::create_job_from_ask(&mut sc, harness::consumer2(), QTY, ESCROW);
    harness::ack(&mut sc);
    // Acked but never attest; jump past attest_deadline (60_000).
    harness::set_clock(&mut sc, 70_000);
    harness::expire_and_resolve(&mut sc);

    let consumer_total = usdc_held_by(&mut sc, harness::consumer2());
    let (bond1, slashed1) = read_stake(&mut sc);
    let (_tbal, tfees, tslash) = read_treasury(&mut sc);

    let comp = consumer_total - ESCROW; // full escrow refunded, comp from slash
    let bond_debit = bond0 - bond1;
    assert!(bond_debit == slashed1, 1);
    assert!(bond_debit == comp + tslash, 2);
    assert!(tfees == 0, 3); // no fee on a faulted job
    sc.end();
}

// === Invariant 2: no payout without Verified — an un-attested job cannot be settled ===

#[test]
#[expected_failure(abort_code = gix::settlement::ENotVerified)]
fun no_payout_without_verified() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    harness::provider_register_and_stake(&mut sc, BOND, CAPACITY);
    harness::post_ask(&mut sc, QTY, PRICE_PER_SCU);
    harness::create_job_from_ask(&mut sc, harness::consumer2(), QTY, ESCROW);
    harness::ack(&mut sc);
    // Executing, not Verified. settle must abort — no payout site is reachable.
    harness::settle(&mut sc);
    sc.end();
}

// === Invariant 3: exactly-once terminal — a second settle aborts ===

#[test]
#[expected_failure(abort_code = gix::settlement::EBadState)]
fun exactly_once_terminal_double_settle_aborts() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    harness::provider_register_and_stake(&mut sc, BOND, CAPACITY);
    harness::post_ask(&mut sc, QTY, PRICE_PER_SCU);
    harness::create_job_from_ask(&mut sc, harness::consumer2(), QTY, ESCROW);
    harness::ack(&mut sc);
    harness::submit_attestation(&mut sc, harness::mock_measurement(), harness::output_hash(), 9000, 0, 3000);
    harness::settle(&mut sc);
    // Second settle on the now-Settled (terminal) job must abort.
    harness::settle(&mut sc);
    sc.end();
}

// === Invariant 3: exactly-once terminal — resolving an already-settled job aborts ===

#[test]
#[expected_failure(abort_code = gix::settlement::EBadState)]
fun exactly_once_terminal_resolve_after_settle_aborts() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    harness::provider_register_and_stake(&mut sc, BOND, CAPACITY);
    harness::post_ask(&mut sc, QTY, PRICE_PER_SCU);
    harness::create_job_from_ask(&mut sc, harness::consumer2(), QTY, ESCROW);
    harness::ack(&mut sc);
    harness::submit_attestation(&mut sc, harness::mock_measurement(), harness::output_hash(), 9000, 0, 3000);
    harness::settle(&mut sc);
    // Trying the fault path on an already-terminal job must also abort.
    harness::resolve_attested(&mut sc);
    sc.end();
}
