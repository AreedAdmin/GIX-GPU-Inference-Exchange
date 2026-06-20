/// Attestation: binds a provider's `(runtime_measurement, output_hash,
/// output_token_count, t_start, t_end)` tuple to a Job and produces a verdict.
///
/// Two entry paths, one verdict engine:
///   - `submit_mock_attestation`   — **localnet-only** dev path (no signature). Gated by
///     `cfg.is_localnet()` and a `MOCK`-prefixed measurement (K4). Kept so M1/M1.5 demos
///     still pass off the real signature path.
///   - `submit_signed_attestation` — **off-localnet-safe** soft attestation. Verifies a
///     native Ed25519 signature over the canonical message (§2 of
///     docs/demo-milestone-contract.md) against the provider's registered attestation
///     pubkey. This is the Nautilus "register-once, verify-per-job" pattern minus the
///     hardware vendor root. Real hardware TEE (Nautilus / native P-256) is M2+.
///
/// Both paths funnel through the same `compute_verdict` + `job.record_attestation`, so
/// settlement routing (VALID → `settle`, else `resolve_attested`) is identical.
///
/// K4 — mock isolation in three structural layers:
///   1. `submit_mock_attestation` asserts `cfg.is_localnet()` — it cannot run on a
///      testnet/mainnet `Config` (the deploy script flips the flag off).
///   2. acceptance requires the measurement to be on the `MeasurementAllowlist`, and the
///      allowlist's `add_measurement` *itself* refuses to insert a `MOCK`-prefixed
///      measurement unless `is_localnet` (registry.move). So a mock measurement can never
///      reach a live allowlist.
///   3. (off-chain) deploy checklist gate. Together these are the K4 guardrails.
module gix::attestation;

use gix::config::Config;
use gix::events;
use gix::job::{Self, Job};
use gix::market::Market;
use gix::registry::{Self, ModelRecord, MeasurementAllowlist, ProviderRecord};
use std::hash;
use sui::clock::Clock;
use sui::ed25519;

// === Error codes (5xx: attestation; 3xx/4xx shared) ===
const EMockMeasurementOnLiveAllowlist: u64 = 204;
const EWrongProvider: u64 = 304;
const EBadState: u64 = 400;
const EAttestDeadline: u64 = 500;
const EMeasurementNotAllowed: u64 = 501;
const EBadSignature: u64 = 502;
const EAlreadyAttested: u64 = 503;
const EBadTiming: u64 = 504;

/// Domain separator for the canonical attestation message (§2). 13 ascii bytes.
const ATTEST_DOMAIN: vector<u8> = b"GIX_ATTEST_V1";

/// Submit a MOCK attestation for `job`. Binds the tuple, checks the measurement is
/// allowlisted for the job's model, checks the hash binding and SLA timing, and records a
/// verdict on the Job (VALID / SLA_BREACH / INVALID). Settlement then routes off the verdict.
///
/// Callable by the provider only (the party that ran the work), within `t_att`.
public fun submit_mock_attestation<M, Q>(
    job: &mut Job<M, Q>,
    cfg: &Config,
    market: &Market<M>,
    model: &ModelRecord,
    allow: &MeasurementAllowlist,
    runtime_measurement: vector<u8>,
    output_hash: vector<u8>,
    output_token_count: u64,
    t_start: u64,
    t_end: u64,
    clk: &Clock,
    ctx: &TxContext,
) {
    cfg.assert_version();
    // K4 layer 1: the mock accept path is fenced to localnet.
    assert!(cfg.is_localnet(), EMockMeasurementOnLiveAllowlist);
    // M1 mock requires a mock-prefixed measurement, so it can never collide with a real one.
    assert!(registry::is_mock_measurement(&runtime_measurement), EMeasurementNotAllowed);

    assert!(ctx.sender() == job.provider(), EWrongProvider);
    assert!(job.state() == job::s_executing(), EBadState);
    assert!(!job.has_attestation(), EAlreadyAttested);

    let now = clk.timestamp_ms();
    assert!(now <= job.attest_deadline(), EAttestDeadline);
    assert!(t_end >= t_start, EBadTiming);

    // Compute the verdict. A non-VALID verdict still records the attestation but leaves the
    // Job non-Verified; settlement turns it into refund+slash.
    let verdict = compute_verdict<M, Q>(job, market, model, allow, &runtime_measurement, &output_hash, t_start, t_end);

    job.record_attestation(
        runtime_measurement,
        output_hash,
        output_token_count,
        t_start,
        t_end,
        verdict,
        now,
        0, // mock path: no Walrus output blob
        0, // mock path: no Walrus quote blob
    );

    events::attestation_submitted(
        object::id(job),
        job.output_hash(),
        output_hash,
        output_token_count,
        t_start,
        t_end,
        verdict,
    );
}

/// Submit a **signed** attestation for `job`, verifying a native Ed25519 signature over the
/// canonical message (§2) against the provider's registered attestation pubkey. Works on
/// any network (no `is_localnet` gate). After signature verification, applies the SAME
/// verdict / measurement-allowlist / SLA checks and verdict recording as the mock path;
/// settlement then routes off the recorded verdict exactly as today.
///
/// Callable by the provider only, within `t_att`. The signature MUST be over
/// `build_attestation_message(job_id, runtime_measurement, input_hash, output_hash,
/// output_token_count, t_start, t_end)`, where `input_hash`/`output_hash` are the
/// node-computed `sha2_256` digests of the prompt / completion (§2). The contract binds
/// the digests it is given; it does not see the plaintext.
///
/// M2 (additive): `output_blob_id` / `quote_blob_id` are Walrus blob id COMMITMENTS for the
/// completion blob and the attestation-quote blob. They are NOT part of the signed canonical
/// message (the signature binds the `sha2_256` `output_hash`, the verification primitive; the
/// blob ids are storage pointers, not content hashes), so the §2 byte layout is UNCHANGED and
/// existing node signatures stay valid. Pass `0` for either when no Walrus blob applies.
public fun submit_signed_attestation<M, Q>(
    job: &mut Job<M, Q>,
    cfg: &Config,
    market: &Market<M>,
    model: &ModelRecord,
    allow: &MeasurementAllowlist,
    provider_rec: &ProviderRecord,
    runtime_measurement: vector<u8>,
    input_hash: vector<u8>,
    output_hash: vector<u8>,
    output_token_count: u64,
    t_start: u64,
    t_end: u64,
    signature: vector<u8>,
    output_blob_id: u256,
    quote_blob_id: u256,
    clk: &Clock,
    ctx: &TxContext,
) {
    cfg.assert_version();

    // Authorization: only the job's provider, and the `ProviderRecord` whose registered key
    // we verify against must belong to that same provider (no key substitution).
    assert!(ctx.sender() == job.provider(), EWrongProvider);
    assert!(registry::provider_operator(provider_rec) == job.provider(), EWrongProvider);

    assert!(job.state() == job::s_executing(), EBadState);
    assert!(!job.has_attestation(), EAlreadyAttested);

    let now = clk.timestamp_ms();
    assert!(now <= job.attest_deadline(), EAttestDeadline);
    assert!(t_end >= t_start, EBadTiming);

    // The signed message also binds the consumer's prompt: the input_hash the consumer
    // committed at job creation must match the one the provider signed over.
    assert!(input_hash == job.input_hash(), EBadSignature);

    // Reconstruct the byte-exact canonical message and verify the Ed25519 signature against
    // the provider's REGISTERED attestation key (soft attestation, register-once).
    let msg = build_attestation_message(
        object::id(job),
        &runtime_measurement,
        &input_hash,
        &output_hash,
        output_token_count,
        t_start,
        t_end,
    );
    let pubkey = registry::provider_attest_pubkey(provider_rec);
    assert!(ed25519::ed25519_verify(&signature, &pubkey, &msg), EBadSignature);

    // Same verdict engine as the mock path (measurement allowlisted, model active/match,
    // output non-empty, SLA window). A non-VALID verdict still records the attestation but
    // leaves the Job non-Verified; settlement turns it into refund+slash.
    let verdict = compute_verdict<M, Q>(job, market, model, allow, &runtime_measurement, &output_hash, t_start, t_end);

    job.record_attestation(
        runtime_measurement,
        output_hash,
        output_token_count,
        t_start,
        t_end,
        verdict,
        now,
        output_blob_id,
        quote_blob_id,
    );

    events::attestation_submitted(
        object::id(job),
        job.output_hash(),
        output_hash,
        output_token_count,
        t_start,
        t_end,
        verdict,
    );
}

/// Reconstruct the **byte-exact** canonical attestation message (§2 of
/// docs/demo-milestone-contract.md) that the provider's node signs. Layout, in order:
///
/// ```
/// "GIX_ATTEST_V1"            // 13 ascii bytes, domain separator
///   ‖ job_id                 // 32 bytes — object id (BCS of the address = raw 32 bytes)
///   ‖ runtime_measurement    // the allowlisted measurement bytes (variable length)
///   ‖ input_hash             // 32 bytes = sha2_256(prompt_utf8)
///   ‖ output_hash            // 32 bytes = sha2_256(completion_utf8)
///   ‖ u64_le(output_token_count)  // 8 bytes, little-endian
///   ‖ u64_le(t_start)        // 8 bytes, little-endian
///   ‖ u64_le(t_end)          // 8 bytes, little-endian
/// ```
///
/// `job_id.to_bytes()` is `bcs::to_bytes` of the underlying address, which for Sui's
/// fixed-size address is exactly the 32 raw id bytes with NO length prefix — matching the
/// node's `jobId` 32-byte object id. Integers are appended little-endian via `u64_to_le`.
public fun build_attestation_message(
    job_id: ID,
    runtime_measurement: &vector<u8>,
    input_hash: &vector<u8>,
    output_hash: &vector<u8>,
    output_token_count: u64,
    t_start: u64,
    t_end: u64,
): vector<u8> {
    let mut msg = ATTEST_DOMAIN;
    msg.append(job_id.to_bytes());
    msg.append(*runtime_measurement);
    msg.append(*input_hash);
    msg.append(*output_hash);
    msg.append(u64_to_le(output_token_count));
    msg.append(u64_to_le(t_start));
    msg.append(u64_to_le(t_end));
    msg
}

/// Little-endian 8-byte encoding of a `u64` (matches the node's `u64_le`).
fun u64_to_le(n: u64): vector<u8> {
    let mut out = vector<u8>[];
    let mut i = 0u8;
    let mut v = n;
    while (i < 8) {
        out.push_back((v & 0xff) as u8);
        v = v >> 8;
        i = i + 1;
    };
    out
}

/// Convenience helper used by tests / off-chain tooling to obtain the `sha2_256` digest of
/// a UTF-8 input exactly as the node computes `input_hash` / `output_hash` (§2).
public fun sha2_256(data: vector<u8>): vector<u8> { hash::sha2_256(data) }

/// Deterministic verdict computation, shared by mock (and, later, real) paths.
fun compute_verdict<M, Q>(
    job: &Job<M, Q>,
    market: &Market<M>,
    model: &ModelRecord,
    allow: &MeasurementAllowlist,
    measurement: &vector<u8>,
    output_hash: &vector<u8>,
    t_start: u64,
    t_end: u64,
): u8 {
    // Hash/identity binding: model must be active and match the job's model; measurement
    // must be allowlisted for that model; output hash must be non-empty.
    if (!model.model_active()) { return job::verdict_invalid() };
    if (model.model_id() != job.model_id()) { return job::verdict_invalid() };
    if (!registry::is_allowed(allow, job.model_id(), measurement)) { return job::verdict_invalid() };
    if (output_hash.is_empty()) { return job::verdict_invalid() };

    // SLA timing: measured latency must be within the market's p99 SLA window.
    let latency = t_end - t_start;
    if (latency > market.p99_ms()) { return job::verdict_sla_breach() };

    job::verdict_valid()
}

/// Read-only verdict accessor for settlement/tests.
public fun verdict<M, Q>(job: &Job<M, Q>): u8 { job.attestation_verdict() }
