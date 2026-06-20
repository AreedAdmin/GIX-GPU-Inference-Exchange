/// Provider & model registry, plus the governance measurement allowlist.
///
/// - `ProviderRecord` / `ProviderCap`: provider identity; the cap authorizes staking,
///   minting, and unstaking against that provider's `ProviderStake`.
/// - `ModelRecord`: the canonical model artifact (Walrus blob id + content hash) bound
///   in attestation.
/// - `MeasurementAllowlist`: the single governance authority (L2) mapping a model to its
///   set of approved runtime measurements. `attestation` reads it; only the `AdminCap`
///   writes it.
///
/// The allowlist stores entries in a dynamic field keyed per model id so that adding a
/// measurement for model A touches a different slot than reading model B's set — keeping
/// the parent object small and contention-free (sui-move-contracts.md §3.1).
module gix::registry;

use gix::config::{Config, AdminCap};
use gix::events;
use sui::dynamic_field as df;
use sui::vec_set::{Self, VecSet};

// === Error codes (2xx: registry) ===
const EModelInactive: u64 = 201;
const EMockMeasurementOnLiveAllowlist: u64 = 204;
const EBadPubkeyLen: u64 = 205;

/// Length of an Ed25519 public key (the provider's attestation key), in bytes.
const ED25519_PUBKEY_LEN: u64 = 32;

/// Singleton allowlist of approved runtime measurements, keyed per model id.
public struct MeasurementAllowlist has key {
    id: UID,
    version: u64,
    // dynamic fields: model_id (ID) -> VecSet<vector<u8>>  (approved measurements)
}

/// Provider operator identity. Shared so it is discoverable; read-mostly.
///
/// `attest_pubkey` is the provider's **Ed25519 attestation public key** (32 bytes),
/// registered once. `attestation::submit_signed_attestation` verifies each per-job
/// signature against this key — the soft-attestation analogue of Nautilus' register-once
/// (minus the hardware vendor root). It is distinct from the provider's Sui tx keypair.
public struct ProviderRecord has key, store {
    id: UID,
    version: u64,
    operator: address,
    endpoint: vector<u8>,
    gpu_class: vector<u8>,
    attest_pubkey: vector<u8>,
}

/// Bearer authority for a provider: gates `stake` / `mint_credits` / `unstake`.
public struct ProviderCap has key, store {
    id: UID,
    provider: address,
}

/// Canonical model artifact. Shared, read-mostly, referenced by jobs + attestation.
public struct ModelRecord has key {
    id: UID,
    version: u64,
    model_uri: vector<u8>,
    walrus_blob_id: vector<u8>,
    model_hash: vector<u8>,
    active: bool,
}

const VERSION: u64 = 1;

/// Publish the singleton allowlist. Called from `init`.
fun init(ctx: &mut TxContext) {
    transfer::share_object(MeasurementAllowlist { id: object::new(ctx), version: VERSION });
}

// === Provider registry ===

/// Register a provider and mint its `ProviderCap` to the caller. Permissionless in M1
/// (providers self-register); the cap and the `ProviderRecord` bind `ctx.sender()` as the
/// operator. `attest_pubkey` is the provider's 32-byte Ed25519 attestation key, recorded
/// in the shared `ProviderRecord` for `submit_signed_attestation` to verify against.
public fun register_provider(
    cfg: &Config,
    endpoint: vector<u8>,
    gpu_class: vector<u8>,
    attest_pubkey: vector<u8>,
    ctx: &mut TxContext,
): ProviderCap {
    cfg.assert_version();
    assert!(attest_pubkey.length() == ED25519_PUBKEY_LEN, EBadPubkeyLen);
    let operator = ctx.sender();
    let record = ProviderRecord {
        id: object::new(ctx),
        version: VERSION,
        operator,
        endpoint,
        gpu_class,
        attest_pubkey,
    };
    let provider_id = object::id(&record);
    let cap = ProviderCap { id: object::new(ctx), provider: operator };
    events::provider_registered(provider_id, operator);
    transfer::share_object(record);
    cap
}

public fun cap_provider(cap: &ProviderCap): address { cap.provider }

public fun provider_operator(record: &ProviderRecord): address { record.operator }

public fun provider_gpu_class(record: &ProviderRecord): vector<u8> { record.gpu_class }

public fun provider_endpoint(record: &ProviderRecord): vector<u8> { record.endpoint }

/// The provider's registered 32-byte Ed25519 attestation public key. Read by
/// `attestation::submit_signed_attestation` to verify the per-job signature.
public fun provider_attest_pubkey(record: &ProviderRecord): vector<u8> { record.attest_pubkey }

// === Model registry (AdminCap-gated) ===

public fun register_model(
    _: &AdminCap,
    cfg: &Config,
    model_uri: vector<u8>,
    walrus_blob_id: vector<u8>,
    model_hash: vector<u8>,
    ctx: &mut TxContext,
): ID {
    cfg.assert_version();
    let record = ModelRecord {
        id: object::new(ctx),
        version: VERSION,
        model_uri,
        walrus_blob_id,
        model_hash,
        active: true,
    };
    let model_id = object::id(&record);
    events::model_registered(model_id, model_hash, walrus_blob_id);
    transfer::share_object(record);
    model_id
}

public fun set_model_active(_: &AdminCap, model: &mut ModelRecord, active: bool) {
    model.active = active;
}

public fun model_id(model: &ModelRecord): ID { object::id(model) }
public fun model_hash(model: &ModelRecord): vector<u8> { model.model_hash }
public fun model_active(model: &ModelRecord): bool { model.active }
public fun model_walrus_blob_id(model: &ModelRecord): vector<u8> { model.walrus_blob_id }

public fun assert_model_active(model: &ModelRecord) {
    assert!(model.active, EModelInactive);
}

// === Measurement allowlist (AdminCap-gated; single authority per L2) ===

/// Add an approved runtime measurement for a model.
///
/// K4 guard: mock measurements (those flagged via `is_mock_measurement`) may only be
/// added while `cfg.is_localnet == true`. On any non-localnet config this aborts, so a
/// mock-accept measurement can never reach a live allowlist even by operator error.
public fun add_measurement(
    _: &AdminCap,
    cfg: &Config,
    allow: &mut MeasurementAllowlist,
    model_id: ID,
    measurement: vector<u8>,
) {
    cfg.assert_version();
    if (is_mock_measurement(&measurement)) {
        assert!(cfg.is_localnet(), EMockMeasurementOnLiveAllowlist);
    };
    if (!df::exists(&allow.id, model_id)) {
        df::add(&mut allow.id, model_id, vec_set::empty<vector<u8>>());
    };
    let set: &mut VecSet<vector<u8>> = df::borrow_mut(&mut allow.id, model_id);
    if (!set.contains(&measurement)) {
        set.insert(measurement);
    };
    events::measurement_added(model_id, measurement);
}

public fun remove_measurement(
    _: &AdminCap,
    allow: &mut MeasurementAllowlist,
    model_id: ID,
    measurement: vector<u8>,
) {
    if (df::exists(&allow.id, model_id)) {
        let set: &mut VecSet<vector<u8>> = df::borrow_mut(&mut allow.id, model_id);
        if (set.contains(&measurement)) {
            set.remove(&measurement);
        };
    };
}

/// Whether `measurement` is on the allowlist for `model_id`.
public fun is_allowed(allow: &MeasurementAllowlist, model_id: ID, measurement: &vector<u8>): bool {
    if (!df::exists(&allow.id, model_id)) {
        return false
    };
    let set: &VecSet<vector<u8>> = df::borrow(&allow.id, model_id);
    set.contains(measurement)
}

/// A mock measurement is any measurement prefixed with the `MOCK` magic bytes. The dev
/// attestation module produces only such measurements; the allowlist guard above keys off
/// this so the dev path is structurally fenced to localnet.
public fun is_mock_measurement(measurement: &vector<u8>): bool {
    let prefix = b"MOCK";
    if (measurement.length() < prefix.length()) {
        return false
    };
    let mut i = 0;
    while (i < prefix.length()) {
        if (measurement[i] != prefix[i]) {
            return false
        };
        i = i + 1;
    };
    true
}

// === Test helpers ===

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) { init(ctx) }
