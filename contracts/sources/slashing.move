/// Slashing magnitudes and execution (B4 magnitudes, D1 split).
///
/// `slashing` is the only module that debits a `ProviderStake` bond. It is driven solely
/// by the `settlement` verdict path — the provider never signs a slash. All functions are
/// package-internal; `settlement` calls them with the fault classification.
///
/// B4 magnitudes (fraction of the per-job bond share):
///   - invalid attestation : 100% of bond share + flat penalty
///   - missing attestation  : 100% of bond share
///   - SLA breach           : graded (here: `slash_bps_sla`, the 50% band cap)
///   - liveness (ack/no-ack): ~2–5% (`slash_bps_liveness`) + reputation de-rate
///
/// "Bond share" = the slice of the bond backing THIS job = `bond * qty / capacity` (each
/// in-flight job's proportional collateral). In M1 we bound it by the available bond.
module gix::slashing;

use gix::config::Config;
use gix::staking::{Self, ProviderStake};
use sui::balance::Balance;

use gix::mock_usdc::MOCK_USDC;

// Fault classes, in increasing severity.
const FAULT_LIVENESS: u8 = 0; // missed ack
const FAULT_SLA: u8 = 1; // SLA breach / overrun
const FAULT_MISSING: u8 = 2; // missing attestation by deadline
const FAULT_INVALID: u8 = 3; // invalid attestation

public fun fault_liveness(): u8 { FAULT_LIVENESS }
public fun fault_sla(): u8 { FAULT_SLA }
public fun fault_missing(): u8 { FAULT_MISSING }
public fun fault_invalid(): u8 { FAULT_INVALID }

/// The per-job bond share = `bond * qty / capacity`, the proportional collateral this job
/// commits. Falls back to the full bond if capacity is zero (degenerate).
public fun bond_share(stake: &ProviderStake, qty: u64): u64 {
    let cap = staking::capacity_scu(stake);
    let bond = staking::bond_value(stake);
    if (cap == 0) { return bond };
    let share = (bond as u128) * (qty as u128) / (cap as u128);
    share as u64
}

/// Compute the slash amount (base units) for a fault on this job.
public fun slash_amount(cfg: &Config, stake: &ProviderStake, qty: u64, fault: u8): u64 {
    let share = bond_share(stake, qty);
    let denom = gix::config::bps_denom();
    let amount = if (fault == FAULT_INVALID) {
        let frac = (share as u128) * (cfg.slash_bps_invalid() as u128) / (denom as u128);
        (frac as u64) + cfg.flat_penalty_invalid()
    } else if (fault == FAULT_MISSING) {
        ((share as u128) * (cfg.slash_bps_missing() as u128) / (denom as u128)) as u64
    } else if (fault == FAULT_SLA) {
        ((share as u128) * (cfg.slash_bps_sla() as u128) / (denom as u128)) as u64
    } else {
        // liveness
        ((share as u128) * (cfg.slash_bps_liveness() as u128) / (denom as u128)) as u64
    };
    // Never slash more than the available bond.
    let bond = staking::bond_value(stake);
    if (amount > bond) bond else amount
}

/// Execute the slash: debit the bond and de-rate capacity (B5). Returns the slashed
/// `Balance` for `settlement` to distribute. Package-internal.
public(package) fun execute(
    cfg: &Config,
    stake: &mut ProviderStake,
    qty: u64,
    fault: u8,
): Balance<MOCK_USDC> {
    let amount = slash_amount(cfg, stake, qty, fault);
    let penalty = staking::slash(stake, amount);
    staking::derate(stake); // linear capacity de-rate per fault
    penalty
}
