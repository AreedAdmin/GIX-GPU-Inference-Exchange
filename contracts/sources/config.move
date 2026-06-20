/// Protocol configuration and root capability for the `gix` package.
///
/// Holds the governance-tunable economic surface (fee bps, collateral ratio `k`,
/// slash magnitudes, minimum stake, pause flag) and the `AdminCap` minted once at
/// publish. In v1 governance is an `AdminCap`/multisig — the GIX token and
/// token-weighted voting are post-MVP (see ../../docs/tokenomics.md scope banner).
module gix::config;

/// On-chain version of the package state, asserted by entry functions and bumped by
/// the upgrade `migrate` flow.
const VERSION: u64 = 1;

const BPS_DENOM: u64 = 10_000;

// === Error codes (1xx: governance / config) ===
const EPaused: u64 = 101;
const EBadVersion: u64 = 102;
const EBadParam: u64 = 103;

/// Root capability minted once at publish. Bearer = protocol admin / multisig. In M1
/// this single cap also fills the `GovernanceCap` role described in the design doc
/// (create_market, allowlist edits) — we keep one cap for the MVP.
public struct AdminCap has key, store {
    id: UID,
}

/// Singleton protocol config. Shared, but written only by rare governance txns, so it
/// does not serialize the hot job path (it is read-only there).
public struct Config has key {
    id: UID,
    version: u64,
    paused: bool,
    /// Protocol fee in basis points, skimmed in USDC at settlement.
    protocol_fee_bps: u64,
    /// Collateralization ratio `k = k_num / k_den` (USDC-vs-USDC in v1). Bond per SCU
    /// of capacity = price_floor * k; in M1 we use it as a simple per-SCU bond multiple.
    k_num: u64,
    k_den: u64,
    /// Minimum total bond (base units of MOCK_USDC) required to register a stake.
    min_stake: u64,
    /// Slash magnitudes in bps of the per-job bond share (B4). `invalid` also carries a
    /// flat penalty; `sla` is the upper bound of the graded 10–50% band; `liveness` is
    /// the small ack/liveness penalty.
    slash_bps_invalid: u64,
    slash_bps_missing: u64,
    slash_bps_sla: u64,
    slash_bps_liveness: u64,
    /// Flat penalty (base units) added on top of an invalid-attestation slash.
    flat_penalty_invalid: u64,
    /// K4 guard: `true` only on localnet deploys. The mock-attestation accept path and
    /// the mock measurement allowlist insert assert this is `true`, so they can never run
    /// against a testnet/mainnet config even if the dev module shipped.
    is_localnet: bool,
}

/// Published once: mint the `AdminCap` to the publisher and share the `Config`.
fun init(ctx: &mut TxContext) {
    let cfg = Config {
        id: object::new(ctx),
        version: VERSION,
        paused: false,
        protocol_fee_bps: 30, // 0.30% — illustrative, governance-tunable
        k_num: 3, // k = 1.5x  ->  3 / 2
        k_den: 2,
        min_stake: 0,
        slash_bps_invalid: 10_000, // 100% of bond share (B4)
        slash_bps_missing: 10_000, // 100% of bond share (B4)
        slash_bps_sla: 5_000, // upper end of 10–50% graded band (B4)
        slash_bps_liveness: 300, // ~3% liveness penalty (B4: ~2–5%)
        flat_penalty_invalid: 0, // governance-tunable flat add-on
        is_localnet: true, // deploy script flips this off for non-localnet
    };
    transfer::share_object(cfg);
    transfer::public_transfer(AdminCap { id: object::new(ctx) }, ctx.sender());
}

// === Version ===

public fun package_version(): u64 { VERSION }

public fun version(cfg: &Config): u64 { cfg.version }

/// Invariant I7: every entry that mutates protocol state asserts the object version.
public fun assert_version(cfg: &Config) {
    assert!(cfg.version == VERSION, EBadVersion);
}

// === Reads ===

public fun is_paused(cfg: &Config): bool { cfg.paused }

public fun assert_not_paused(cfg: &Config) {
    assert!(!cfg.paused, EPaused);
}

public fun protocol_fee_bps(cfg: &Config): u64 { cfg.protocol_fee_bps }

public fun bps_denom(): u64 { BPS_DENOM }

/// Returns the collateral ratio as `(numerator, denominator)`.
public fun k(cfg: &Config): (u64, u64) { (cfg.k_num, cfg.k_den) }

public fun min_stake(cfg: &Config): u64 { cfg.min_stake }

public fun slash_bps_invalid(cfg: &Config): u64 { cfg.slash_bps_invalid }
public fun slash_bps_missing(cfg: &Config): u64 { cfg.slash_bps_missing }
public fun slash_bps_sla(cfg: &Config): u64 { cfg.slash_bps_sla }
public fun slash_bps_liveness(cfg: &Config): u64 { cfg.slash_bps_liveness }
public fun flat_penalty_invalid(cfg: &Config): u64 { cfg.flat_penalty_invalid }

public fun is_localnet(cfg: &Config): bool { cfg.is_localnet }

/// Computes a fee on `amount` using `protocol_fee_bps`. Rounds down (favoring the payer).
public fun fee_amount(cfg: &Config, amount: u64): u64 {
    ((amount as u128) * (cfg.protocol_fee_bps as u128) / (BPS_DENOM as u128)) as u64
}

// === Governance (AdminCap-gated) ===

public fun set_pause(_: &AdminCap, cfg: &mut Config, paused: bool) {
    cfg.paused = paused;
}

public fun set_protocol_fee_bps(_: &AdminCap, cfg: &mut Config, bps: u64) {
    assert!(bps <= BPS_DENOM, EBadParam);
    cfg.protocol_fee_bps = bps;
}

public fun set_k(_: &AdminCap, cfg: &mut Config, num: u64, den: u64) {
    assert!(den > 0, EBadParam);
    cfg.k_num = num;
    cfg.k_den = den;
}

public fun set_min_stake(_: &AdminCap, cfg: &mut Config, min_stake: u64) {
    cfg.min_stake = min_stake;
}

public fun set_slash_bps(
    _: &AdminCap,
    cfg: &mut Config,
    invalid: u64,
    missing: u64,
    sla: u64,
    liveness: u64,
) {
    assert!(invalid <= BPS_DENOM && missing <= BPS_DENOM, EBadParam);
    assert!(sla <= BPS_DENOM && liveness <= BPS_DENOM, EBadParam);
    cfg.slash_bps_invalid = invalid;
    cfg.slash_bps_missing = missing;
    cfg.slash_bps_sla = sla;
    cfg.slash_bps_liveness = liveness;
}

public fun set_flat_penalty_invalid(_: &AdminCap, cfg: &mut Config, flat: u64) {
    cfg.flat_penalty_invalid = flat;
}

/// K4: the deploy checklist flips this off on any non-localnet network. Once `false`,
/// the mock-attestation accept path and mock measurement inserts abort.
public fun set_is_localnet(_: &AdminCap, cfg: &mut Config, is_localnet: bool) {
    cfg.is_localnet = is_localnet;
}

/// One-shot, governance-gated migration after a package upgrade. Bumps the on-chain
/// version so post-upgrade entries (which assert `VERSION`) accept this object.
public fun migrate(_: &AdminCap, cfg: &mut Config) {
    assert!(cfg.version < VERSION, EBadVersion);
    cfg.version = VERSION;
}

// === Test helpers ===

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) { init(ctx) }

#[test_only]
public fun new_admin_cap_for_testing(ctx: &mut TxContext): AdminCap {
    AdminCap { id: object::new(ctx) }
}
