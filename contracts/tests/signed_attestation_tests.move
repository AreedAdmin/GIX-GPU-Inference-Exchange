/// Soft (registered-key Ed25519) attestation tests — the off-localnet trust path.
///
/// These verify a REAL native Ed25519 signature over the byte-exact canonical message
/// (§2 of docs/demo-milestone-contract.md) through `attestation::submit_signed_attestation`.
/// Because Move has no on-chain signing primitive, signatures are PRECOMPUTED offline and
/// pinned here as vectors; the construction is fully documented below so the node (D0) and
/// any reviewer can reproduce the exact bytes.
///
/// ── How the vectors were produced ────────────────────────────────────────────────────
/// Tool: Python `cryptography` (Ed25519), deterministic all-zero 32-byte seed.
///   seed       = 00 * 32
///   PUBKEY     = 3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29
///                (RFC-8032 / Sui test-vector pubkey for the all-zero seed)
///   WRONG_KEY  = cecc1507dc1ddd7295951c290888f095adb9044d1b73d696e6df065d683bd4fc
///                (pubkey of a different seed = 01 00..00)
///
/// The job id is DETERMINISTIC under `test_scenario` for this exact tx flow:
///   JOB_ID     = d40679c0295fdd2fe9690e9259794989912738ff8b7c7e12f9c10cff1bbf4377
/// (asserted at runtime below so a flow change can never silently desync the vectors.)
///
/// Content hashes (sha2_256 over utf8), exactly as the node computes them:
///   prompt      = b"hello gix"        -> input_hash  = 920a3376...116ef9dc
///   completion  = b"hello from llama" -> output_hash = 4e189c77...77e9bb8e
///
/// Canonical message (152 bytes for the 19-byte measurement), per build_attestation_message:
///   "GIX_ATTEST_V1" ‖ JOB_ID(32) ‖ measurement(19) ‖ input_hash(32) ‖ output_hash(32)
///     ‖ u64_le(tokens) ‖ u64_le(t_start) ‖ u64_le(t_end)
///
/// Two signed instances over that message (both VALID signatures; verdict differs by SLA):
///   HAPPY  : tokens=9000 t_start=0 t_end=3000 (latency 3s < 5s p99) -> VALID     -> settle
///   BREACH : tokens=9000 t_start=0 t_end=8000 (latency 8s > 5s p99) -> SLA_BREACH-> resolve
/// BAD_SIG  = HAPPY signature with byte[0] flipped (still 64 bytes, invalid).
#[test_only]
module gix::signed_attestation_tests;

use gix::attestation;
use gix::config::Config;
use gix::harness;
use gix::job::{Self, Job};
use gix::markets::M_H100_LLAMA8B;
use gix::mock_usdc::MOCK_USDC;
use gix::settlement::{Self, Treasury};
use gix::staking::{Self, ProviderStake};
use sui::test_scenario::{Self as ts};

const PRICE: u64 = 1_000_000;
const BOND: u64 = 10_000_000;
const CAPACITY: u64 = 100;
const QTY: u64 = 10;

// === Pinned vectors (see module header for provenance) ===

fun provider_pubkey(): vector<u8> {
    x"3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29"
}

fun wrong_pubkey(): vector<u8> {
    x"cecc1507dc1ddd7295951c290888f095adb9044d1b73d696e6df065d683bd4fc"
}

fun expected_job_id(): vector<u8> {
    x"d40679c0295fdd2fe9690e9259794989912738ff8b7c7e12f9c10cff1bbf4377"
}

// sha2_256(b"hello gix")
fun prompt(): vector<u8> { b"hello gix" }
fun input_hash(): vector<u8> {
    x"920a337685c06a488ac99d78c3a063c6c374468266113d7c5870770d116ef9dc"
}

// sha2_256(b"hello from llama")
fun output_hash(): vector<u8> {
    x"4e189c771ae26adff09cb7b5449fab04d2673d86632cd44467858fb977e9bb8e"
}

// Ed25519 signature over the HAPPY message (tokens=9000, t_start=0, t_end=3000).
fun sig_happy(): vector<u8> {
    x"a6fe084d82d0846c2e3e8b4ff0fd59b09b4a95387300cd27a2e464442174ac9845c27ca5dd87fdbd77dc3cfaf13930fa6cd86bf1df3cfb5479e3a86ccaee8103"
}

// Ed25519 signature over the SLA-BREACH message (tokens=9000, t_start=0, t_end=8000).
fun sig_breach(): vector<u8> {
    x"d612184fdba31206472a625d6eca7c8f743665d276e283dc1a555e988b13259f300db8c6497c875c8a36cff75efbafbe51b40b479d9d5b05e66fc4772da77508"
}

// HAPPY signature with byte[0] flipped — a structurally valid 64-byte but invalid signature.
fun sig_bad(): vector<u8> {
    x"a7fe084d82d0846c2e3e8b4ff0fd59b09b4a95387300cd27a2e464442174ac9845c27ca5dd87fdbd77dc3cfaf13930fa6cd86bf1df3cfb5479e3a86ccaee8103"
}

// === Self-checks: the on-chain helpers reproduce the pinned bytes exactly ===

#[test]
fun helpers_reproduce_canonical_bytes() {
    // The hash helper matches the pinned digests (so the node's sha2_256 must too).
    assert!(attestation::sha2_256(prompt()) == input_hash(), 100);
    assert!(attestation::sha2_256(b"hello from llama") == output_hash(), 101);

    // The message builder reproduces the exact 152-byte canonical message we signed.
    let job_id = object::id_from_bytes(expected_job_id());
    let msg = attestation::build_attestation_message(
        job_id,
        &b"MOCK-tdx-llama8b-v1",
        &input_hash(),
        &output_hash(),
        9000,
        0,
        3000,
    );
    let expected = x"4749585f4154544553545f5631d40679c0295fdd2fe9690e9259794989912738ff8b7c7e12f9c10cff1bbf43774d4f434b2d7464782d6c6c616d6138622d7631920a337685c06a488ac99d78c3a063c6c374468266113d7c5870770d116ef9dc4e189c771ae26adff09cb7b5449fab04d2673d86632cd44467858fb977e9bb8e28230000000000000000000000000000b80b000000000000";
    assert!(msg == expected, 102);
}

// === Happy path: real signature → VALID → settle → provider paid ===

#[test]
fun signed_happy_path_settles() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    let credits = harness::provider_setup_with_key(&mut sc, BOND, CAPACITY, QTY, provider_pubkey());
    let job_id = harness::create_job_with_input(&mut sc, credits, PRICE, input_hash());
    // Pin the deterministic job id the vectors were signed against.
    assert!(job_id.to_bytes() == expected_job_id(), 1);
    harness::ack(&mut sc);

    // VALID signed attestation (latency 3s < 5s p99).
    harness::submit_signed(
        &mut sc,
        harness::mock_measurement(),
        input_hash(),
        output_hash(),
        9000,
        0,
        3000,
        sig_happy(),
    );

    sc.next_tx(harness::consumer());
    {
        let job = sc.take_shared<Job<M_H100_LLAMA8B, MOCK_USDC>>();
        assert!(job::job_state(&job) == job::s_verified(), 2);
        assert!(job::job_output_hash(&job) == output_hash(), 3);
        ts::return_shared(job);
    };

    harness::settle(&mut sc);

    sc.next_tx(harness::provider());
    {
        let cfg = sc.take_shared<Config>();
        let fee = cfg.fee_amount(PRICE);
        let payout = harness::take_usdc(&mut sc, harness::provider());
        assert!(harness::coin_value(&payout) == PRICE - fee, 4);
        transfer::public_transfer(payout, harness::provider());
        ts::return_shared(cfg);
    };
    sc.end();
}

// === Bad signature: correct key, tampered signature → aborts EBadSignature ===

#[test]
#[expected_failure(abort_code = gix::attestation::EBadSignature)]
fun signed_bad_signature_rejected() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    let credits = harness::provider_setup_with_key(&mut sc, BOND, CAPACITY, QTY, provider_pubkey());
    let job_id = harness::create_job_with_input(&mut sc, credits, PRICE, input_hash());
    assert!(job_id.to_bytes() == expected_job_id(), 1);
    harness::ack(&mut sc);

    // Tampered signature over the happy message → ed25519_verify fails.
    harness::submit_signed(
        &mut sc,
        harness::mock_measurement(),
        input_hash(),
        output_hash(),
        9000,
        0,
        3000,
        sig_bad(),
    );
    sc.end();
}

// === Wrong key: valid signature, but provider registered a DIFFERENT pubkey → aborts ===

#[test]
#[expected_failure(abort_code = gix::attestation::EBadSignature)]
fun signed_wrong_key_rejected() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    // Provider registers the WRONG pubkey, but presents the signature made with the real key.
    let credits = harness::provider_setup_with_key(&mut sc, BOND, CAPACITY, QTY, wrong_pubkey());
    let job_id = harness::create_job_with_input(&mut sc, credits, PRICE, input_hash());
    assert!(job_id.to_bytes() == expected_job_id(), 1);
    harness::ack(&mut sc);

    harness::submit_signed(
        &mut sc,
        harness::mock_measurement(),
        input_hash(),
        output_hash(),
        9000,
        0,
        3000,
        sig_happy(),
    );
    sc.end();
}

// === SLA breach via signed path: valid sig, latency over p99 → SLA_BREACH → resolve ===

#[test]
fun signed_sla_breach_refunds_and_slashes() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    let credits = harness::provider_setup_with_key(&mut sc, BOND, CAPACITY, QTY, provider_pubkey());
    let job_id = harness::create_job_with_input(&mut sc, credits, PRICE, input_hash());
    assert!(job_id.to_bytes() == expected_job_id(), 1);
    harness::ack(&mut sc);

    // Valid signature, but latency 8s > 5s p99 → SLA_BREACH verdict (job Attested, not Verified).
    harness::submit_signed(
        &mut sc,
        harness::mock_measurement(),
        input_hash(),
        output_hash(),
        9000,
        0,
        8000,
        sig_breach(),
    );

    sc.next_tx(harness::consumer());
    {
        let job = sc.take_shared<Job<M_H100_LLAMA8B, MOCK_USDC>>();
        assert!(job::job_state(&job) == job::s_attested(), 2);
        ts::return_shared(job);
    };

    harness::resolve_attested(&mut sc);

    sc.next_tx(harness::consumer());
    {
        let job = sc.take_shared<Job<M_H100_LLAMA8B, MOCK_USDC>>();
        assert!(job::job_state(&job) == job::s_refunded(), 3);
        assert!(job::job_slashed(&job) == true, 4);
        assert!(job::job_escrow_value(&job) == 0, 5);
        ts::return_shared(job);
    };

    // SLA slash = slash_bps_sla (5000 = 50%) of bond_share(BOND*QTY/CAPACITY = 1_000_000) = 500_000.
    sc.next_tx(harness::provider());
    {
        let stake = ts::take_from_address<ProviderStake<MOCK_USDC>>(&sc, harness::provider());
        assert!(staking::slashed_total(&stake) == 500_000, 6);
        ts::return_to_address(harness::provider(), stake);
    };

    // No fee on a faulted job; consumer was refunded in full.
    sc.next_tx(harness::consumer());
    {
        let treasury = sc.take_shared<Treasury<MOCK_USDC>>();
        assert!(settlement::treasury_fees_collected(&treasury) == 0, 7);
        ts::return_shared(treasury);
    };
    sc.end();
}
