/// Settlement: the only module that disposes of a Job's escrow + drives slashing payouts.
///
/// Terminal outcomes, each draining the escrow at most once (I8) and flipping the Job to a
/// terminal state in the same call:
///   - `settle`             : Verified ESCROW job → provider paid (− fee), fee → treasury,
///                            reserved credits burned, capacity consumed → Settled.
///   - `resolve_attested`   : Attested ESCROW job with a failing verdict (invalid / SLA
///                            breach) → full refund + slash → Refunded(+Slashed).
///   - `expire_and_resolve` : a deadline lapsed with no valid attestation → full refund;
///                            slash if the miss was the provider's fault → Refunded(+Slashed).
///
/// M2 — DeepBook fill jobs (Option B, pay-at-match). A fill-job carries NO USDC escrow: the
/// provider was already paid USDC at the DeepBook match (off-chain to GIX). Its terminal
/// paths therefore differ in WHO holds the money in the interim, not in the verdict engine:
///   - `settle_fill`        : Verified FILL job → NO escrow release / NO payout (provider
///                            already paid); just burn the reserved credit + consume_minted
///                            → Settled.
///   - `resolve_fill`       : Attested FILL job with a failing verdict → slash the provider
///                            and REFUND THE CONSUMER IN USDC FROM THE SLASH (there is no
///                            escrow to refund) → Refunded(+Slashed).
///   - `expire_and_resolve` : also handles fill-jobs (deadline miss) — the shared
///                            `refund_and_slash` drains a zero escrow and compensates the
///                            consumer purely from the slash.
///
/// D1 split (escrow jobs): the consumer's full escrow is refunded first and unconditionally;
/// the *slash penalty* then compensates the consumer up to 100% of job value, remainder to
/// treasury, burn = 0. For FILL jobs there is no escrow leg, so the consumer's protection is
/// entirely the slash→refund (the `k`-ratio guarantees the value-at-risk is covered).
module gix::settlement;

use gix::config::Config;
use gix::credit::Credit;
use gix::events;
use gix::job::{Self, Job};
use gix::market::Market;
use gix::slashing;
use gix::staking::{Self, ProviderStake};
use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin;

// === Error codes (4xx: job / settlement) ===
const EBadState: u64 = 400;
const ENotVerified: u64 = 402;
const EDeadlineNotPassed: u64 = 403;
const EWrongConsumer: u64 = 404;
/// Called an escrow path on a fill-job, or a fill path on an escrow job.
const EWrongJobKind: u64 = 409;

/// Protocol fee sink + treasury-funded backstop pool (B3 nominal), denominated in the
/// per-network quote dollar `Q` (`MOCK_USDC` localnet, `DBUSDC` testnet, real `USDC` mainnet —
/// see docs/onramp-dbusdc-plan.md). Shared so any settlement can deposit into it; only the
/// AdminCap can withdraw. The treasury is published once per `Q` at deploy time (via
/// `init_treasury`), so a republish that switches `Q` shares a fresh treasury for that dollar.
public struct Treasury<phantom Q> has key {
    id: UID,
    version: u64,
    funds: Balance<Q>,
    fees_collected: u64,
    slash_collected: u64,
}

const VERSION: u64 = 1;

/// Publish a `Treasury<Q>` for the network's quote dollar. AdminCap-gated so a deploy can pick
/// the dollar (`MOCK_USDC` / `DBUSDC` / `USDC`) by the `Q` type-arg at the call. The package
/// `init` seeds the localnet `MOCK_USDC` treasury automatically (`init` cannot take type args);
/// non-localnet deploys call `init_treasury<DBUSDC>` / `init_treasury<USDC>` once after publish.
public fun init_treasury<Q>(_: &gix::config::AdminCap, ctx: &mut TxContext): ID {
    let treasury = Treasury<Q> {
        id: object::new(ctx),
        version: VERSION,
        funds: balance::zero<Q>(),
        fees_collected: 0,
        slash_collected: 0,
    };
    let id = object::id(&treasury);
    transfer::share_object(treasury);
    id
}

/// Package `init`: seed the default localnet `MOCK_USDC` treasury so the localnet flow is
/// unchanged (it always settled in `MOCK_USDC`). A republish targeting testnet/mainnet still
/// gets this `MOCK_USDC` treasury for free, but ALSO calls `init_treasury<DBUSDC>` (or
/// `<USDC>`) once to publish the treasury that network actually settles in.
fun init(ctx: &mut TxContext) {
    transfer::share_object(Treasury<gix::mock_usdc::MOCK_USDC> {
        id: object::new(ctx),
        version: VERSION,
        funds: balance::zero(),
        fees_collected: 0,
        slash_collected: 0,
    });
}

// === Happy path ===

/// Settle a Verified ESCROW job: pay provider `price − fee`, fee → treasury, burn the
/// reserved credits (capacity consumed), release the reservation. Callable by anyone.
/// Aborts `EWrongJobKind` on a fill-job (use `settle_fill`).
public fun settle<M, Q>(
    job: &mut Job<M, Q>,
    market: &mut Market<M>,
    cfg: &Config,
    stake: &mut ProviderStake<Q>,
    treasury: &mut Treasury<Q>,
    ctx: &mut TxContext,
) {
    cfg.assert_version();
    assert!(!job.is_terminal(), EBadState);
    assert!(!job.is_fill(), EWrongJobKind);
    assert!(job.state() == job::s_verified(), ENotVerified);

    let price = job.price_usdc();
    let qty = job.scu_qty();
    let provider = job.provider();

    // Drain escrow, split fee, pay provider.
    let mut funds: Balance<Q> = job.take_escrow_funds();
    let fee_bps = market.effective_fee_bps(cfg);
    let fee = ((price as u128) * (fee_bps as u128) / (gix::config::bps_denom() as u128)) as u64;
    let fee_bal = funds.split(fee);
    deposit_fee(treasury, fee_bal);
    // Remainder to provider.
    let payout = balance::value(&funds);
    transfer::public_transfer(coin::from_balance(funds, ctx), provider);

    // Burn the reserved credits (capacity consumed); release the in-flight reservation.
    let credits: Balance<Credit<M>> = job.take_reserved_credits();
    market.burn_credit(credits);
    staking::consume_minted(stake, qty);
    staking::release(stake, qty);

    job.set_state_settled();
    events::settled(object::id(job), provider, payout, fee, job.output_hash());
}

// === Happy path: DeepBook fill-job (Option B — provider already paid at the match) ===

/// Settle a Verified FILL job. There is NO escrow and the provider was ALREADY PAID USDC at
/// the DeepBook match, so settlement pays NOTHING EXTRA on the happy path — it simply burns
/// the reserved credit (capacity consumed) and retires the minted SCU, then marks Settled.
/// Emits `Settled` with `payout = 0, fee = 0` (the on-chain settlement moves no USDC).
/// Aborts `EWrongJobKind` on an escrow job (use `settle`). Callable by anyone.
public fun settle_fill<M, Q>(
    job: &mut Job<M, Q>,
    market: &mut Market<M>,
    cfg: &Config,
    stake: &mut ProviderStake<Q>,
    ctx: &mut TxContext,
) {
    cfg.assert_version();
    assert!(!job.is_terminal(), EBadState);
    assert!(job.is_fill(), EWrongJobKind);
    assert!(job.state() == job::s_verified(), ENotVerified);

    let qty = job.scu_qty();
    let provider = job.provider();

    // No escrow to drain, no payout, no fee — the provider was paid at the fill.
    // Burn the reserved credit (capacity consumed); retire the minted SCU. `reserved_scu` was
    // NOT bumped for a fill-job (consumer never reached the stake), so `release` is a tolerant
    // no-op — identical to the Ask path's capacity accounting.
    let credits: Balance<Credit<M>> = job.take_reserved_credits();
    market.burn_credit(credits);
    staking::consume_minted(stake, qty);
    staking::release(stake, qty);

    job.set_state_settled();
    events::settled(object::id(job), provider, 0, 0, job.output_hash());
    // `ctx` is retained for signature symmetry with `settle` and a future fee/payout leg; no
    // coin/object is created here (the on-chain settlement moves no USDC for a fill-job).
    let _ = ctx;
}

// === Fault path: a submitted attestation that failed verification ===

/// Resolve an ESCROW job that was attested but whose verdict is non-VALID (invalid binding or
/// SLA breach): refund the consumer in full and slash the provider per the fault class.
/// Aborts `EWrongJobKind` on a fill-job (use `resolve_fill`).
public fun resolve_attested<M, Q>(
    job: &mut Job<M, Q>,
    market: &mut Market<M>,
    cfg: &Config,
    stake: &mut ProviderStake<Q>,
    treasury: &mut Treasury<Q>,
    ctx: &mut TxContext,
) {
    cfg.assert_version();
    assert!(!job.is_terminal(), EBadState);
    assert!(!job.is_fill(), EWrongJobKind);
    assert!(job.state() == job::s_attested(), EBadState);
    assert!(job.has_attestation(), EBadState);

    let verdict = job.attestation_verdict();
    let (fault, reason) = if (verdict == job::verdict_sla_breach()) {
        (slashing::fault_sla(), job::reason_sla_breach())
    } else {
        (slashing::fault_invalid(), job::reason_invalid_attestation())
    };
    refund_and_slash(job, market, cfg, stake, treasury, fault, reason, ctx);
}

// === Fault path: a fill-job whose attestation failed verification (refund-from-slash) ===

/// Resolve a FILL job that was attested but whose verdict is non-VALID. There is no escrow to
/// refund (Option B — provider paid at the match), so the consumer is compensated ENTIRELY
/// from the provider's slash: the bond is slashed per the fault class and the penalty
/// compensates the consumer up to the job's value-at-risk, remainder to treasury. Shares the
/// `refund_and_slash` machinery (which drains a zero escrow for a fill-job). Aborts
/// `EWrongJobKind` on an escrow job (use `resolve_attested`).
public fun resolve_fill<M, Q>(
    job: &mut Job<M, Q>,
    market: &mut Market<M>,
    cfg: &Config,
    stake: &mut ProviderStake<Q>,
    treasury: &mut Treasury<Q>,
    ctx: &mut TxContext,
) {
    cfg.assert_version();
    assert!(!job.is_terminal(), EBadState);
    assert!(job.is_fill(), EWrongJobKind);
    assert!(job.state() == job::s_attested(), EBadState);
    assert!(job.has_attestation(), EBadState);

    let verdict = job.attestation_verdict();
    let (fault, reason) = if (verdict == job::verdict_sla_breach()) {
        (slashing::fault_sla(), job::reason_sla_breach())
    } else {
        (slashing::fault_invalid(), job::reason_invalid_attestation())
    };
    refund_and_slash(job, market, cfg, stake, treasury, fault, reason, ctx);
}

// === Fault / no-fault path: deadline expiry ===

/// Resolve a job whose deadline lapsed with no valid attestation. Determines the fault and
/// routes to refund(+slash). Callable by anyone once the relevant deadline passes.
///
/// - never acked & past `ack_deadline`  → liveness fault (AckTimeout)
/// - acked, no attestation, past `attest_deadline` → missing attestation (AttTimeout)
/// - acked, no attestation, past `exec_deadline`   → SLA overrun (SlaOverrun)
public fun expire_and_resolve<M, Q>(
    job: &mut Job<M, Q>,
    market: &mut Market<M>,
    cfg: &Config,
    stake: &mut ProviderStake<Q>,
    treasury: &mut Treasury<Q>,
    clk: &Clock,
    ctx: &mut TxContext,
) {
    cfg.assert_version();
    assert!(!job.is_terminal(), EBadState);
    // Only pre-verification states can expire.
    assert!(
        job.state() == job::s_dispatched() || job.state() == job::s_executing(),
        EBadState,
    );
    // A job that already has a (failing) attestation must go through resolve_attested.
    assert!(!job.has_attestation(), EBadState);

    let now = clk.timestamp_ms();
    let (fault, reason) = if (!job.is_acked()) {
        // Provider never acked.
        assert!(now > job.ack_deadline(), EDeadlineNotPassed);
        (slashing::fault_liveness(), job::reason_ack_timeout())
    } else {
        // Acked but no attestation: classify by which deadline we are past.
        if (now > job.attest_deadline()) {
            (slashing::fault_missing(), job::reason_att_timeout())
        } else {
            assert!(now > job.exec_deadline(), EDeadlineNotPassed);
            (slashing::fault_sla(), job::reason_sla_overrun())
        }
    };
    refund_and_slash(job, market, cfg, stake, treasury, fault, reason, ctx);
}

// === No-fault refund: consumer cancels pre-dispatch-ack ===

/// Consumer cancels before the provider acked. No provider fault ⇒ no slash. Full refund,
/// reserved credits returned to the provider, reservation released.
public fun cancel<M, Q>(
    job: &mut Job<M, Q>,
    cfg: &Config,
    stake: &mut ProviderStake<Q>,
    ctx: &mut TxContext,
) {
    cfg.assert_version();
    assert!(!job.is_terminal(), EBadState);
    assert!(ctx.sender() == job.consumer(), EWrongConsumer);
    // Only pre-ack cancellation is allowed (provider hasn't started).
    assert!(job.state() == job::s_dispatched() && !job.is_acked(), EBadState);

    let qty = job.scu_qty();
    let consumer = job.consumer();
    let provider = job.provider();

    // For a FILL job there is no escrow to refund (the provider was paid at the match and
    // keeps it — a pre-ack consumer cancel is a no-fault walk-away, so no slash); the credit
    // simply returns to the provider. For an escrow job this refunds the full escrow.
    let funds = job.take_escrow_funds();
    let amount = balance::value(&funds);
    if (amount > 0) {
        transfer::public_transfer(coin::from_balance(funds, ctx), consumer);
    } else {
        balance::destroy_zero(funds);
    };

    // Return reserved credits to the provider to re-sell (un-reserved, not burned).
    return_credits_to_provider<M, Q>(job, provider, ctx);
    staking::release(stake, qty);

    job.set_state_refunded();
    events::refunded(object::id(job), consumer, amount, job::reason_cancelled(), false);
}

// === Internal helpers ===

/// Full refund to the consumer + slash the provider per `fault`, distributing the penalty
/// per D1 (consumer comp up to job value → treasury). Returns reserved credits to provider.
fun refund_and_slash<M, Q>(
    job: &mut Job<M, Q>,
    market: &Market<M>,
    cfg: &Config,
    stake: &mut ProviderStake<Q>,
    treasury: &mut Treasury<Q>,
    fault: u8,
    reason: u8,
    ctx: &mut TxContext,
) {
    let qty = job.scu_qty();
    let price = job.price_usdc();
    let consumer = job.consumer();
    let provider = job.provider();

    // 1. Refund the escrow to the consumer FIRST and unconditionally. For a FILL job there is
    //    no escrow (Option B), so this is a zero refund and the consumer's whole compensation
    //    comes from the slash in step 2.
    let funds: Balance<Q> = job.take_escrow_funds();
    let refund_amount = balance::value(&funds);
    if (refund_amount > 0) {
        transfer::public_transfer(coin::from_balance(funds, ctx), consumer);
    } else {
        balance::destroy_zero(funds);
    };

    // 2. Slash the provider's bond and distribute (D1: consumer comp up to job value,
    //    remainder to treasury, burn = 0).
    let mut penalty: Balance<Q> = slashing::execute(cfg, stake, qty, fault);
    let penalty_total = balance::value(&penalty);
    let to_consumer = if (penalty_total > price) price else penalty_total;
    if (to_consumer > 0) {
        let comp = penalty.split(to_consumer);
        transfer::public_transfer(coin::from_balance(comp, ctx), consumer);
    };
    let to_treasury = balance::value(&penalty);
    deposit_slash(treasury, penalty);

    // 3. Return reserved credits to the provider (capacity preserved on failure).
    let _ = market; // market kept in signature for symmetry / future fee-on-fault use
    return_credits_to_provider<M, Q>(job, provider, ctx);
    staking::release(stake, qty);

    // 4. Terminal annotations.
    job.set_slashed();
    job.set_state_refunded();
    events::refunded(object::id(job), consumer, refund_amount, reason, true);
    events::slashed(object::id(job), provider, penalty_total, to_consumer, to_treasury, reason);
}

/// Hand the Job's reserved credit balance back to the provider as a `Coin` (un-reserved,
/// not burned) so they can re-sell the capacity.
fun return_credits_to_provider<M, Q>(job: &mut Job<M, Q>, provider: address, ctx: &mut TxContext) {
    let credits: Balance<Credit<M>> = job.take_reserved_credits();
    if (balance::value(&credits) > 0) {
        transfer::public_transfer(coin::from_balance(credits, ctx), provider);
    } else {
        balance::destroy_zero(credits);
    }
}

fun deposit_fee<Q>(treasury: &mut Treasury<Q>, fee: Balance<Q>) {
    treasury.fees_collected = treasury.fees_collected + balance::value(&fee);
    treasury.funds.join(fee);
}

fun deposit_slash<Q>(treasury: &mut Treasury<Q>, slash: Balance<Q>) {
    treasury.slash_collected = treasury.slash_collected + balance::value(&slash);
    treasury.funds.join(slash);
}

// === Treasury reads / admin ===

public fun treasury_balance<Q>(t: &Treasury<Q>): u64 { balance::value(&t.funds) }
public fun treasury_fees_collected<Q>(t: &Treasury<Q>): u64 { t.fees_collected }
public fun treasury_slash_collected<Q>(t: &Treasury<Q>): u64 { t.slash_collected }

/// AdminCap-gated withdrawal of treasury funds.
public fun withdraw_treasury<Q>(
    _: &gix::config::AdminCap,
    treasury: &mut Treasury<Q>,
    amount: u64,
    recipient: address,
    ctx: &mut TxContext,
) {
    let out = treasury.funds.split(amount);
    transfer::public_transfer(coin::from_balance(out, ctx), recipient);
}

// === Test helpers ===

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) { init(ctx) }
