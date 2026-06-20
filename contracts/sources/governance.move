/// Governance facade.
///
/// In M1 the `AdminCap` (minted once in `config::init`) is the single governance authority
/// (J1: `AdminCap`/multisig; token-weighted voting is post-MVP). The concrete
/// AdminCap-gated setters live in their home modules to keep authority co-located with the
/// state each one mutates:
///   - protocol params / pause / slash bps / localnet flag → `gix::config`
///   - market creation / SLA / fee tier / active           → `gix::market`
///   - model registry / measurement allowlist              → `gix::registry`
///   - treasury withdrawal                                 → `gix::settlement`
///
/// This module provides bootstrap convenience that composes several of those into one call
/// for the deploy script, and the version migrate entry. It holds no new authority.
module gix::governance;

use gix::config::{Config, AdminCap};
use gix::registry::{Self, ModelRecord, MeasurementAllowlist};

/// Bootstrap a model + its (single) approved measurement in one governance call. Returns
/// the new model id. Used by the deploy script to wire up the M1 market's model.
public fun register_model_with_measurement(
    cap: &AdminCap,
    cfg: &Config,
    allow: &mut MeasurementAllowlist,
    model_uri: vector<u8>,
    walrus_blob_id: vector<u8>,
    model_hash: vector<u8>,
    measurement: vector<u8>,
    ctx: &mut TxContext,
): ID {
    let model_id = registry::register_model(cap, cfg, model_uri, walrus_blob_id, model_hash, ctx);
    registry::add_measurement(cap, cfg, allow, model_id, measurement);
    model_id
}

/// Re-export of `registry::set_model_active` under the governance namespace for clarity.
public fun set_model_active(cap: &AdminCap, model: &mut ModelRecord, active: bool) {
    registry::set_model_active(cap, model, active);
}

/// Version migrate entry (governance-gated). Delegates to `config::migrate`.
public fun migrate(cap: &AdminCap, cfg: &mut Config) {
    gix::config::migrate(cap, cfg);
}
