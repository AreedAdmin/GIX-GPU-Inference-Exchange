/// Inline on-chain input (Option 3 — tunnel-free demo) scenario tests.
///
/// These prove the `create_job_from_ask` inline-input ABI pinned in
/// docs/option3-inline-input-interface.md §A: a consumer may carry the raw prompt bytes
/// INLINE in the creation transaction (instead of via a Walrus blob / HTTP `/inputs`
/// endpoint). The contract enforces on-chain that the bytes hash to the committed
/// `input_hash` (`sha2_256`) and fit the inline size bound (`MAX_INLINE_INPUT`), then stores
/// them in `Job.input` (readable via `job::job_input`). An empty `input` is the unchanged
/// Walrus-blob path.
///
/// Coverage:
///   - happy: inline input with a matching `sha2_256` hash is stored; `job_input` returns it;
///   - negative: `sha2_256(input) != input_hash` aborts with `gix::job::EBadInlineInput`;
///   - negative: input longer than `MAX_INLINE_INPUT` aborts with `gix::job::EBadInlineInput`;
///   - self-check: the on-chain digest matches the pinned `sha2_256(b"hello gix")` bytes.
///
/// Determinism: no `sui::random`; the harness `Clock` is a deterministic test handle.
#[test_only]
module gix::inline_input_tests;

use gix::attestation;
use gix::harness;
use gix::job::{Self, Job};
use gix::markets::M_H100_LLAMA8B;
use gix::mock_usdc::MOCK_USDC;
use sui::test_scenario::{Self as ts};

const BOND: u64 = 10_000_000; // 10 mUSDC
const CAPACITY: u64 = 100;
const PRICE_PER_SCU: u64 = 100_000; // 0.1 mUSDC / SCU
const QTY: u64 = 10;
// Exact escrow for QTY at PRICE_PER_SCU = 10 * 100_000 = 1_000_000.
const ESCROW: u64 = 1_000_000;

// The canonical inline prompt and its pinned sha2_256 digest (same fixture the signed
// attestation tests use), so the test is self-documenting and the digest is auditable.
fun prompt(): vector<u8> { b"hello gix" }
fun prompt_hash(): vector<u8> {
    x"920a337685c06a488ac99d78c3a063c6c374468266113d7c5870770d116ef9dc"
}

// === Happy path: inline input with a matching hash is stored and read back ===

#[test]
fun inline_input_with_matching_hash_is_stored() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    harness::provider_register_and_stake(&mut sc, BOND, CAPACITY);
    let _ask_id = harness::post_ask(&mut sc, QTY, PRICE_PER_SCU);

    // Hash computed on-chain (the same digest the node/audit use), so the commitment matches
    // by construction; we also pin it below to catch any drift in the digest fixture.
    let input = prompt();
    let input_hash = attestation::sha2_256(input);
    assert!(input_hash == prompt_hash(), 0);

    let job_id = harness::create_job_from_ask_inline(
        &mut sc, harness::consumer2(), QTY, ESCROW, input, input_hash,
    );

    // The Job stored the inline bytes verbatim and is otherwise an ordinary dispatched job.
    sc.next_tx(harness::consumer2());
    {
        let job = sc.take_shared<Job<M_H100_LLAMA8B, MOCK_USDC>>();
        assert!(object::id(&job) == job_id, 1);
        assert!(job::job_state(&job) == job::s_dispatched(), 2);
        assert!(job::job_consumer(&job) == harness::consumer2(), 3);
        assert!(job::job_provider(&job) == harness::provider(), 4);
        // The accessor returns the exact inline bytes...
        assert!(*job::job_input(&job) == prompt(), 5);
        // ...and they hash to the committed input_hash (the on-chain integrity invariant).
        assert!(attestation::sha2_256(*job::job_input(&job)) == prompt_hash(), 6);
        // No Walrus input blob was committed (inline path uses input_blob_id == 0).
        assert!(job::job_input_blob_id(&job) == 0, 7);
        ts::return_shared(job);
    };

    sc.end();
}

// === Empty inline input keeps the unchanged Walrus-blob behavior (input stays empty) ===

#[test]
fun empty_inline_input_leaves_job_input_empty() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    harness::provider_register_and_stake(&mut sc, BOND, CAPACITY);
    let _ask_id = harness::post_ask(&mut sc, QTY, PRICE_PER_SCU);

    // The standard (non-inline) helper passes an empty `input`; the hash is NOT enforced.
    let _job_id = harness::create_job_from_ask(&mut sc, harness::consumer2(), QTY, ESCROW);

    sc.next_tx(harness::consumer2());
    {
        let job = sc.take_shared<Job<M_H100_LLAMA8B, MOCK_USDC>>();
        assert!(job::job_input(&job).is_empty(), 1);
        ts::return_shared(job);
    };

    sc.end();
}

// === Negative: sha2_256(input) != input_hash aborts ===

#[test]
#[expected_failure(abort_code = gix::job::EBadInlineInput)]
fun inline_input_hash_mismatch_aborts() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    harness::provider_register_and_stake(&mut sc, BOND, CAPACITY);
    let _ask_id = harness::post_ask(&mut sc, QTY, PRICE_PER_SCU);

    // Commit a hash that does NOT match sha2_256(b"hello gix") — a single flipped byte.
    let mut wrong_hash = prompt_hash();
    *wrong_hash.borrow_mut(0) = 0x00;

    harness::create_job_from_ask_inline(
        &mut sc, harness::consumer2(), QTY, ESCROW, prompt(), wrong_hash,
    );
    sc.end();
}

// === Negative: input longer than MAX_INLINE_INPUT aborts ===

#[test]
#[expected_failure(abort_code = gix::job::EBadInlineInput)]
fun inline_input_oversize_aborts() {
    let mut sc = harness::begin();
    harness::bootstrap_market(&mut sc);
    harness::provider_register_and_stake(&mut sc, BOND, CAPACITY);
    let _ask_id = harness::post_ask(&mut sc, QTY, PRICE_PER_SCU);

    // Build an input of MAX_INLINE_INPUT + 1 bytes. We pass its REAL hash so the size guard
    // (asserted first in the contract) is unambiguously the cause of the abort, not the hash.
    let oversize = max_inline_input() + 1;
    let mut input = vector[];
    let mut i = 0;
    while (i < oversize) {
        input.push_back(0x61); // 'a'
        i = i + 1;
    };
    assert!(input.length() == oversize, 0);
    let input_hash = attestation::sha2_256(input);

    harness::create_job_from_ask_inline(
        &mut sc, harness::consumer2(), QTY, ESCROW, input, input_hash,
    );
    sc.end();
}

fun max_inline_input(): u64 { job::max_inline_input() }
