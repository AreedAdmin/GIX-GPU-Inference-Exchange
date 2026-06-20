/// F5 — Attestation negative matrix (soft Ed25519), the core adversarial rigor.
///
/// docs/pool-free-e2e-delivery-and-test-plan.md §4 F5: for EACH mutation the contract must
/// FAIL CLOSED — reject (abort) or record a non-VALID verdict that settlement turns into
/// refund + slash — and NEVER pay the provider. The canonical message is bound EXACTLY:
///   "GIX_ATTEST_V1" ‖ job_id ‖ measurement ‖ input_hash ‖ output_hash
///     ‖ u64le(tokens) ‖ u64le(t_start) ‖ u64le(t_end)
/// (verified byte-for-byte by `gix::signed_attestation_tests::helpers_reproduce_canonical_bytes`).
///
/// The matrix (each row its own test):
///   | mutation                         | path   | expected                                   |
///   |----------------------------------|--------|--------------------------------------------|
///   | forged / tampered signature      | signed | abort EBadSignature, no payout             |
///   | unregistered signer key          | signed | abort EBadSignature                        |
///   | wrong runtime measurement        | signed | VALID sig but INVALID verdict → refund+slash|
///   | model inactive (model binding)   | mock   | INVALID verdict → refund+slash             |
///   | input_hash mismatch              | signed | abort EBadSignature                        |
///   | output_hash mismatch (vs signed) | signed | abort EBadSignature                        |
///   | output_hash empty (binding)      | signed | VALID sig but INVALID verdict → refund+slash|
///   | replayed attestation (same job)  | signed | abort EAlreadyAttested                      |
///   | stale quote (past attest deadline)| signed | abort EAttestDeadline                       |
///   | SLA breach (t_end−t_start > SLA) | signed | SLA_BREACH verdict → refund+slash (slash)  |
///
/// Signature provenance (all over the all-zero-seed Ed25519 key, the harness pinned key):
///   PUBKEY = 3b6a27bc…59da29 ; WRONG = cecc1507…83bd4fc ; JOB_ID = d40679c0…1bbf4377
///   input_hash  = sha2_256("hello gix"),  output_hash = sha2_256("hello from llama").
/// The two NEW signatures below were produced with the same Python pipeline that reproduces
/// the pinned `sig_happy` exactly (verified at generation time), over the SAME fixed JOB_ID:
///   - sig_valid_wrong_measurement : valid sig over measurement b"MOCK-not-allowlisted"
///   - sig_valid_empty_output      : valid sig over an EMPTY output_hash
#[test_only]
module gix::attestation_negative_tests;

use gix::config::AdminCap;
use gix::harness;
use gix::job::{Self, Job};
use gix::markets::M_H100_LLAMA8B;
use gix::mock_usdc::MOCK_USDC;
use gix::staking::{Self, ProviderStake};
use sui::test_scenario::{Self as ts};

const PRICE: u64 = 1_000_000;
const BOND: u64 = 10_000_000;
const CAPACITY: u64 = 100;
const QTY: u64 = 10;

// === Pinned vectors (provenance in the module header; see signed_attestation_tests) ===

fun provider_pubkey(): vector<u8> {
    x"3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29"
}
fun wrong_pubkey(): vector<u8> {
    x"cecc1507dc1ddd7295951c290888f095adb9044d1b73d696e6df065d683bd4fc"
}
fun expected_job_id(): vector<u8> {
    x"d40679c0295fdd2fe9690e9259794989912738ff8b7c7e12f9c10cff1bbf4377"
}
fun input_hash(): vector<u8> {
    x"920a337685c06a488ac99d78c3a063c6c374468266113d7c5870770d116ef9dc"
}
fun output_hash(): vector<u8> {
    x"4e189c771ae26adff09cb7b5449fab04d2673d86632cd44467858fb977e9bb8e"
}
// Valid Ed25519 sig over the HAPPY message (measurement allowlisted, 0..3000).
fun sig_happy(): vector<u8> {
    x"a6fe084d82d0846c2e3e8b4ff0fd59b09b4a95387300cd27a2e464442174ac9845c27ca5dd87fdbd77dc3cfaf13930fa6cd86bf1df3cfb5479e3a86ccaee8103"
}
// Valid Ed25519 sig over the SLA-BREACH message (0..8000, latency 8s > 5s p99).
fun sig_breach(): vector<u8> {
    x"d612184fdba31206472a625d6eca7c8f743665d276e283dc1a555e988b13259f300db8c6497c875c8a36cff75efbafbe51b40b479d9d5b05e66fc4772da77508"
}
// HAPPY sig with byte[0] flipped: structurally valid 64 bytes, cryptographically invalid.
fun sig_bad(): vector<u8> {
    x"a7fe084d82d0846c2e3e8b4ff0fd59b09b4a95387300cd27a2e464442174ac9845c27ca5dd87fdbd77dc3cfaf13930fa6cd86bf1df3cfb5479e3a86ccaee8103"
}
// NEW: valid sig over measurement b"MOCK-not-allowlisted" (else identical to HAPPY).
fun sig_valid_wrong_measurement(): vector<u8> {
    x"a855532b42c94dd0955ae00fcbf877c145a7006426d2460161b4de9fd0fa3f679b8879bfca5b667066913b3de276617518762053846f32f74c745114b241cc04"
}
// NEW: valid sig over an EMPTY output_hash (else identical to HAPPY).
fun sig_valid_empty_output(): vector<u8> {
    x"cf392b413f5034c83dbd3246104ff9e2cf1daef7b07439db505410b9af6c85265a82b9fa02cfd32bc17bf0cd008bdb8b5c75db5e723d90fe319b33647dd21309"
}

// Drive a registered-key job to the point of attestation. Returns nothing; the job is shared.
fun setup_signed_job(sc: &mut sui::test_scenario::Scenario, pubkey: vector<u8>) {
    harness::bootstrap_market(sc);
    let credits = harness::provider_setup_with_key(sc, BOND, CAPACITY, QTY, pubkey);
    let job_id = harness::create_job_with_input(sc, credits, PRICE, input_hash());
    // Pin the deterministic job id the signatures were bound against.
    assert!(job_id.to_bytes() == expected_job_id(), 999);
    harness::ack(sc);
}

/// Assert the provider received NO payout AND the job is in a non-Verified, refunded state.
fun assert_refunded_no_payout(sc: &mut sui::test_scenario::Scenario) {
    sc.next_tx(harness::consumer());
    {
        let job = sc.take_shared<Job<M_H100_LLAMA8B, MOCK_USDC>>();
        assert!(job::job_state(&job) == job::s_refunded(), 1);
        assert!(job::job_slashed(&job) == true, 2);       // a fault was proven
        assert!(job::job_escrow_value(&job) == 0, 3);     // escrow drained to refund, not payout
        ts::return_shared(job);
    };
    // The provider never received a USDC payout coin.
    assert!(!harness::has_usdc(harness::provider()), 4);
}

// === Row 1: forged / tampered signature → abort EBadSignature, no payout ===

#[test]
#[expected_failure(abort_code = gix::attestation::EBadSignature)]
fun forged_signature_rejected() {
    let mut sc = harness::begin();
    setup_signed_job(&mut sc, provider_pubkey());
    harness::submit_signed(&mut sc, harness::mock_measurement(), input_hash(), output_hash(), 9000, 0, 3000, sig_bad());
    sc.end();
}

// === Row 2: unregistered signer key (provider registered a DIFFERENT pubkey) → abort ===

#[test]
#[expected_failure(abort_code = gix::attestation::EBadSignature)]
fun unregistered_signer_rejected() {
    let mut sc = harness::begin();
    // Provider registers WRONG key but presents a sig made with the real key.
    setup_signed_job(&mut sc, wrong_pubkey());
    harness::submit_signed(&mut sc, harness::mock_measurement(), input_hash(), output_hash(), 9000, 0, 3000, sig_happy());
    sc.end();
}

// === Row 3: wrong runtime measurement (valid sig, NOT allowlisted) → INVALID verdict, never payout ===

#[test]
fun wrong_measurement_invalid_verdict_no_payout() {
    let mut sc = harness::begin();
    setup_signed_job(&mut sc, provider_pubkey());

    // The signature is VALID over this measurement, so it passes ed25519_verify — but
    // "MOCK-not-allowlisted" is not on the model's allowlist, so compute_verdict → INVALID.
    harness::submit_signed(
        &mut sc, b"MOCK-not-allowlisted", input_hash(), output_hash(), 9000, 0, 3000,
        sig_valid_wrong_measurement(),
    );

    // Job recorded Attested (not Verified): settle is therefore unreachable; resolve refunds+slashes.
    sc.next_tx(harness::consumer());
    {
        let job = sc.take_shared<Job<M_H100_LLAMA8B, MOCK_USDC>>();
        assert!(job::job_state(&job) == job::s_attested(), 1);
        assert!(attestation_verdict(&job) == job::verdict_invalid(), 2);
        ts::return_shared(job);
    };
    harness::resolve_attested(&mut sc);
    assert_refunded_no_payout(&mut sc);
    sc.end();
}

fun attestation_verdict(job: &Job<M_H100_LLAMA8B, MOCK_USDC>): u8 {
    gix::attestation::verdict<M_H100_LLAMA8B, MOCK_USDC>(job)
}

// === Row 4: model binding — an INACTIVE model yields an INVALID verdict (mock path) ===

#[test]
fun inactive_model_invalid_verdict_no_payout() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    let credits = harness::provider_setup(&mut sc, BOND, CAPACITY, QTY);
    harness::create_job(&mut sc, credits, PRICE);
    harness::ack(&mut sc);

    // Admin deactivates the model the job is bound to → compute_verdict's model_active() guard
    // fails → INVALID verdict, even with a perfectly allowlisted measurement.
    sc.next_tx(harness::admin());
    {
        let cap = sc.take_from_sender<AdminCap>();
        let mut model = sc.take_shared<gix::registry::ModelRecord>();
        gix::governance::set_model_active(&cap, &mut model, false);
        ts::return_shared(model);
        sc.return_to_sender(cap);
    };

    harness::submit_attestation(&mut sc, harness::mock_measurement(), output_hash(), 9000, 0, 3000);

    sc.next_tx(harness::consumer());
    {
        let job = sc.take_shared<Job<M_H100_LLAMA8B, MOCK_USDC>>();
        assert!(job::job_state(&job) == job::s_attested(), 1);
        assert!(attestation_verdict(&job) == job::verdict_invalid(), 2);
        ts::return_shared(job);
    };
    harness::resolve_attested(&mut sc);
    assert_refunded_no_payout(&mut sc);
    sc.end();
}

// === Row 5: input_hash mismatch → abort EBadSignature (the prompt binding guard) ===

#[test]
#[expected_failure(abort_code = gix::attestation::EBadSignature)]
fun input_hash_mismatch_rejected() {
    let mut sc = harness::begin();
    setup_signed_job(&mut sc, provider_pubkey());
    // Present an input_hash that differs from the one committed at job creation. The signed
    // path asserts `input_hash == job.input_hash()` BEFORE verifying, → EBadSignature.
    let wrong_input = x"0000000000000000000000000000000000000000000000000000000000000000";
    harness::submit_signed(&mut sc, harness::mock_measurement(), wrong_input, output_hash(), 9000, 0, 3000, sig_happy());
    sc.end();
}

// === Row 6: output_hash mismatch (vs the signed message) → signature fails → abort ===

#[test]
#[expected_failure(abort_code = gix::attestation::EBadSignature)]
fun output_hash_mismatch_rejected() {
    let mut sc = harness::begin();
    setup_signed_job(&mut sc, provider_pubkey());
    // sig_happy was made over the REAL output_hash; present a different output_hash → the
    // reconstructed canonical message differs → ed25519_verify fails → EBadSignature.
    let other_output = x"1111111111111111111111111111111111111111111111111111111111111111";
    harness::submit_signed(&mut sc, harness::mock_measurement(), input_hash(), other_output, 9000, 0, 3000, sig_happy());
    sc.end();
}

// === Row 7: empty output_hash (valid sig over it) → INVALID verdict, never payout ===

#[test]
fun empty_output_hash_invalid_verdict_no_payout() {
    let mut sc = harness::begin();
    setup_signed_job(&mut sc, provider_pubkey());

    // Valid sig over an EMPTY output_hash → passes ed25519_verify, but compute_verdict's
    // `output_hash.is_empty()` guard → INVALID verdict.
    harness::submit_signed(&mut sc, harness::mock_measurement(), input_hash(), b"", 9000, 0, 3000, sig_valid_empty_output());

    sc.next_tx(harness::consumer());
    {
        let job = sc.take_shared<Job<M_H100_LLAMA8B, MOCK_USDC>>();
        assert!(job::job_state(&job) == job::s_attested(), 1);
        assert!(attestation_verdict(&job) == job::verdict_invalid(), 2);
        ts::return_shared(job);
    };
    harness::resolve_attested(&mut sc);
    assert_refunded_no_payout(&mut sc);
    sc.end();
}

// === Row 8: replayed attestation (resubmit on the same job) → rejected, ≤1 record per job ===
//
// After the first VALID attestation the job is Verified (no longer Executing), so the state
// guard (`state == Executing`, EBadState 400) fires FIRST on a replay — strictly before the
// `EAlreadyAttested` (503) guard. Either way the replay is refused: a job can carry at most one
// AttestationRecord, so a stale/replayed quote can never be re-applied or double-paid.

#[test]
#[expected_failure(abort_code = gix::attestation::EBadState)]
fun replayed_attestation_rejected() {
    let mut sc = harness::begin();
    setup_signed_job(&mut sc, provider_pubkey());
    // First submission: VALID, moves job → Verified.
    harness::submit_signed(&mut sc, harness::mock_measurement(), input_hash(), output_hash(), 9000, 0, 3000, sig_happy());
    sc.next_tx(harness::consumer());
    {
        let job = sc.take_shared<Job<M_H100_LLAMA8B, MOCK_USDC>>();
        assert!(job::job_state(&job) == job::s_verified(), 1);
        ts::return_shared(job);
    };
    // Replay the exact same (valid) quote → the job is no longer Executing AND already carries
    // an attestation; resubmission must abort (the state guard refuses it first).
    harness::submit_signed(&mut sc, harness::mock_measurement(), input_hash(), output_hash(), 9000, 0, 3000, sig_happy());
    sc.end();
}

// === Row 9: stale quote (clock past attest_deadline) → abort EAttestDeadline ===

#[test]
#[expected_failure(abort_code = gix::attestation::EAttestDeadline)]
fun stale_quote_past_deadline_rejected() {
    let mut sc = harness::begin();
    setup_signed_job(&mut sc, provider_pubkey());
    // attest_deadline = p99*6 + 30_000 = 60_000. Jump the clock past it, then present an
    // otherwise-VALID signature — the freshness guard must refuse the stale quote.
    harness::set_clock(&mut sc, 70_000);
    harness::submit_signed(&mut sc, harness::mock_measurement(), input_hash(), output_hash(), 9000, 0, 3000, sig_happy());
    sc.end();
}

// === Row 10: SLA breach (valid sig, latency > p99) → SLA_BREACH verdict → refund+slash, never payout ===

#[test]
fun sla_breach_resolves_to_refund_slash_no_payout() {
    let mut sc = harness::begin();
    setup_signed_job(&mut sc, provider_pubkey());

    // VALID signature, but latency 8s > 5s p99 → SLA_BREACH verdict (Attested, not Verified).
    harness::submit_signed(&mut sc, harness::mock_measurement(), input_hash(), output_hash(), 9000, 0, 8000, sig_breach());

    sc.next_tx(harness::consumer());
    {
        let job = sc.take_shared<Job<M_H100_LLAMA8B, MOCK_USDC>>();
        assert!(job::job_state(&job) == job::s_attested(), 1);
        assert!(attestation_verdict(&job) == job::verdict_sla_breach(), 2);
        ts::return_shared(job);
    };

    harness::resolve_attested(&mut sc);
    assert_refunded_no_payout(&mut sc);

    // The slash is the graded SLA penalty (50% of bond_share = 500_000), proving fault was punished.
    sc.next_tx(harness::provider());
    {
        let stake = ts::take_from_address<ProviderStake<MOCK_USDC>>(&sc, harness::provider());
        assert!(staking::slashed_total(&stake) == 500_000, 3);
        ts::return_to_address(harness::provider(), stake);
    };
    sc.end();
}

// === Cross-cutting: a non-Verified (Attested/INVALID) job can NEVER be settled (no payout) ===

#[test]
#[expected_failure(abort_code = gix::settlement::ENotVerified)]
fun attested_invalid_cannot_be_settled() {
    let mut sc = harness::begin();
    setup_signed_job(&mut sc, provider_pubkey());
    // INVALID verdict (wrong measurement) → Attested.
    harness::submit_signed(
        &mut sc, b"MOCK-not-allowlisted", input_hash(), output_hash(), 9000, 0, 3000,
        sig_valid_wrong_measurement(),
    );
    // Attempting the HAPPY-path settle on a non-Verified job must abort ENotVerified — there is
    // no code path that pays the provider without a VALID attestation.
    harness::settle(&mut sc);
    sc.end();
}
