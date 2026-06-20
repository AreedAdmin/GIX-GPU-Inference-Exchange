/// The `Job<phantom M>` shared object — the atom of parallel settlement.
///
/// A Job binds one consumer, one provider, one market's credits + USDC escrow, the
/// content hashes, and the three deadlines (ack / exec / attest) copied from the market
/// SLA at creation. Each Job is its own shared object, so two jobs settle concurrently
/// (sui-move-contracts.md §8).
///
/// M1 deviation from the canonical multi-step creation: the integration contract's
/// "stubbed match" creates the Job directly from `(provider, credits, escrow)` and
/// advances `Created → … → Dispatched` in one call. The reserved credits and escrow are
/// embedded as typed fields on `Job<M>` (not dynamic object fields) for M1 simplicity;
/// the Job is still the single disjoint settlement atom.
module gix::job;

use gix::config::Config;
use gix::credit::{Self, Credit};
use gix::escrow::{Self, Escrow};
use gix::events;
use gix::market::Market;
use gix::staking::{Self, ProviderStake};
use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::Coin;

use gix::mock_usdc::MOCK_USDC;

// === Error codes (4xx: job / escrow) ===
const EBadState: u64 = 400;
const EEscrowMismatch: u64 = 401;
const EWrongProvider: u64 = 304;
const EZeroQty: u64 = 405;
const EAttestDeadline: u64 = 500;
const EAlreadyAttested: u64 = 503;

// === Lifecycle states (Job.state) ===
const STATE_DISPATCHED: u8 = 3; // created+escrowed+dispatched in one tx
const STATE_EXECUTING: u8 = 4;
const STATE_ATTESTED: u8 = 5;
const STATE_VERIFIED: u8 = 6;
const STATE_SETTLED: u8 = 7;
const STATE_REFUNDED: u8 = 8;
const STATE_EXPIRED: u8 = 9;

// === Attestation verdicts ===
const VERDICT_VALID: u8 = 0;
const VERDICT_SLA_BREACH: u8 = 1;
const VERDICT_INVALID: u8 = 2;

// === Refund/fault reasons (mirror lifecycle §3) ===
const REASON_CANCELLED: u8 = 0;
const REASON_ACK_TIMEOUT: u8 = 1;
const REASON_SLA_OVERRUN: u8 = 2;
const REASON_ATT_TIMEOUT: u8 = 3;
const REASON_INVALID_ATTESTATION: u8 = 4;
const REASON_SLA_BREACH: u8 = 5;

/// Permanent on-chain attestation summary, attached once the provider submits.
public struct AttestationRecord has store, drop {
    measurement: vector<u8>,
    output_hash: vector<u8>,
    output_token_count: u64,
    t_start: u64,
    t_end: u64,
    verified_at: u64,
    verdict: u8,
}

public struct Job<phantom M> has key {
    id: UID,
    version: u64,
    market_id: ID,
    model_id: ID,
    consumer: address,
    provider: address,
    state: u8,
    // content bindings
    input_hash: vector<u8>,
    output_hash: vector<u8>,
    // economics
    scu_qty: u64,
    price_usdc: u64,
    escrow: Escrow,
    reserved_credits: Balance<Credit<M>>,
    // timing (epoch ms)
    created_at: u64,
    ack_deadline: u64,
    exec_deadline: u64,
    attest_deadline: u64,
    acked: bool,
    // attestation outcome
    attestation: Option<AttestationRecord>,
    // terminal annotations
    slashed: bool,
}

// === Creation ("stubbed match" entry) ===

/// Create a Job from a (provider, credits, escrow) tuple and share it. In M1 this stands
/// in for the DeepBook fill: the credits + escrow are the proof of a match. Advances the
/// Job straight to `Dispatched` and reserves provider capacity atomically.
///
/// Asserts: market active, escrow == credits.value * (effective price implied), capacity
/// available. The escrow amount IS the agreed price (price discovery is off-chain/stubbed
/// in M1), so we assert `escrow == price_usdc` and that `credits.value == scu_qty`.
public fun create_job<M>(
    cfg: &Config,
    market: &Market<M>,
    stake: &mut ProviderStake,
    provider: address,
    credits: Coin<Credit<M>>,
    escrow_in: Coin<MOCK_USDC>,
    input_hash: vector<u8>,
    clk: &Clock,
    ctx: &mut TxContext,
): ID {
    cfg.assert_version();
    cfg.assert_not_paused();
    market.assert_active();
    assert!(stake.provider() == provider, EWrongProvider);

    let scu_qty = credit::value(&credits);
    assert!(scu_qty > 0, EZeroQty);
    let price_usdc = escrow_in.value();
    assert!(price_usdc > 0, EEscrowMismatch);

    // Reserve provider capacity for this in-flight job (bounds concurrent exposure).
    staking::reserve(stake, scu_qty);

    let now = clk.timestamp_ms();
    let consumer = ctx.sender();
    let job = Job<M> {
        id: object::new(ctx),
        version: cfg.version(),
        market_id: market.market_id(),
        model_id: market.model_id(),
        consumer,
        provider,
        state: STATE_DISPATCHED,
        input_hash,
        output_hash: vector[],
        scu_qty,
        price_usdc,
        escrow: escrow::lock(escrow_in, consumer),
        reserved_credits: credit::from_coin(credits),
        created_at: now,
        ack_deadline: now + market.ack_deadline_ms(),
        exec_deadline: now + market.exec_deadline_ms(),
        attest_deadline: now + market.attest_deadline_ms(),
        acked: false,
        attestation: option::none(),
        slashed: false,
    };
    let job_id = object::id(&job);
    events::job_created(job_id, market.market_id(), consumer, provider, scu_qty, price_usdc);
    events::dispatched(job_id, provider, market.model_id(), input_hash, job.exec_deadline);
    transfer::share_object(job);
    job_id
}

/// Provider acknowledges dispatch within `t_ack`, moving the job to `Executing`. Anyone
/// else attempting to ack aborts; re-acking is idempotent (no-op) (lifecycle §7).
public fun ack<M>(job: &mut Job<M>, clk: &Clock, ctx: &TxContext) {
    assert!(ctx.sender() == job.provider, EWrongProvider);
    assert!(job.state == STATE_DISPATCHED || job.state == STATE_EXECUTING, EBadState);
    if (job.state == STATE_EXECUTING) { return };
    assert!(clk.timestamp_ms() <= job.ack_deadline, EAttestDeadline);
    job.acked = true;
    job.state = STATE_EXECUTING;
}

// === Package-internal accessors / mutators (attestation, settlement) ===

public(package) fun state<M>(job: &Job<M>): u8 { job.state }
public(package) fun consumer<M>(job: &Job<M>): address { job.consumer }
public(package) fun provider<M>(job: &Job<M>): address { job.provider }
public(package) fun market_id<M>(job: &Job<M>): ID { job.market_id }
public(package) fun model_id<M>(job: &Job<M>): ID { job.model_id }
public(package) fun scu_qty<M>(job: &Job<M>): u64 { job.scu_qty }
public(package) fun price_usdc<M>(job: &Job<M>): u64 { job.price_usdc }
public(package) fun input_hash<M>(job: &Job<M>): vector<u8> { job.input_hash }
public(package) fun attest_deadline<M>(job: &Job<M>): u64 { job.attest_deadline }
public(package) fun exec_deadline<M>(job: &Job<M>): u64 { job.exec_deadline }
public(package) fun ack_deadline<M>(job: &Job<M>): u64 { job.ack_deadline }
public(package) fun is_acked<M>(job: &Job<M>): bool { job.acked }
public(package) fun is_terminal<M>(job: &Job<M>): bool {
    job.state == STATE_SETTLED || job.state == STATE_REFUNDED || job.state == STATE_EXPIRED
}

public(package) fun escrow_mut<M>(job: &mut Job<M>): &mut Escrow { &mut job.escrow }
public(package) fun escrow_ref<M>(job: &Job<M>): &Escrow { &job.escrow }

/// Take the reserved credit balance out of the Job (settlement burns it; refund returns
/// it to the provider). Leaves a zero balance in its place.
public(package) fun take_reserved_credits<M>(job: &mut Job<M>): Balance<Credit<M>> {
    balance::withdraw_all(&mut job.reserved_credits)
}

/// Record the attestation result and advance state (Executing → Attested → Verified, or
/// → flagged for refund on a failing verdict). Called by `attestation`.
public(package) fun record_attestation<M>(
    job: &mut Job<M>,
    measurement: vector<u8>,
    output_hash: vector<u8>,
    output_token_count: u64,
    t_start: u64,
    t_end: u64,
    verdict: u8,
    verified_at: u64,
) {
    assert!(option::is_none(&job.attestation), EAlreadyAttested);
    job.output_hash = output_hash;
    job.attestation = option::some(AttestationRecord {
        measurement,
        output_hash,
        output_token_count,
        t_start,
        t_end,
        verified_at,
        verdict,
    });
    job.state = if (verdict == VERDICT_VALID) {
        STATE_VERIFIED
    } else {
        STATE_ATTESTED // failing verdicts stay non-verified; settlement routes to refund+slash
    };
}

public(package) fun set_state_settled<M>(job: &mut Job<M>) { job.state = STATE_SETTLED; }
public(package) fun set_state_refunded<M>(job: &mut Job<M>) { job.state = STATE_REFUNDED; }
public(package) fun set_state_expired<M>(job: &mut Job<M>) { job.state = STATE_EXPIRED; }
public(package) fun set_slashed<M>(job: &mut Job<M>) { job.slashed = true; }

public(package) fun attestation_verdict<M>(job: &Job<M>): u8 {
    if (option::is_some(&job.attestation)) {
        option::borrow(&job.attestation).verdict
    } else {
        VERDICT_INVALID
    }
}

public(package) fun has_attestation<M>(job: &Job<M>): bool { option::is_some(&job.attestation) }
public(package) fun output_hash<M>(job: &Job<M>): vector<u8> { job.output_hash }

// === Public reads ===

public fun job_state<M>(job: &Job<M>): u8 { job.state }
public fun job_consumer<M>(job: &Job<M>): address { job.consumer }
public fun job_provider<M>(job: &Job<M>): address { job.provider }
public fun job_price<M>(job: &Job<M>): u64 { job.price_usdc }
public fun job_qty<M>(job: &Job<M>): u64 { job.scu_qty }
public fun job_slashed<M>(job: &Job<M>): bool { job.slashed }
public fun job_escrow_value<M>(job: &Job<M>): u64 { escrow::value(&job.escrow) }
public fun job_output_hash<M>(job: &Job<M>): vector<u8> { job.output_hash }

// === State constant accessors (for tests / settlement) ===

public fun s_dispatched(): u8 { STATE_DISPATCHED }
public fun s_executing(): u8 { STATE_EXECUTING }
public fun s_attested(): u8 { STATE_ATTESTED }
public fun s_verified(): u8 { STATE_VERIFIED }
public fun s_settled(): u8 { STATE_SETTLED }
public fun s_refunded(): u8 { STATE_REFUNDED }
public fun s_expired(): u8 { STATE_EXPIRED }

public fun verdict_valid(): u8 { VERDICT_VALID }
public fun verdict_sla_breach(): u8 { VERDICT_SLA_BREACH }
public fun verdict_invalid(): u8 { VERDICT_INVALID }

public fun reason_cancelled(): u8 { REASON_CANCELLED }
public fun reason_ack_timeout(): u8 { REASON_ACK_TIMEOUT }
public fun reason_sla_overrun(): u8 { REASON_SLA_OVERRUN }
public fun reason_att_timeout(): u8 { REASON_ATT_TIMEOUT }
public fun reason_invalid_attestation(): u8 { REASON_INVALID_ATTESTATION }
public fun reason_sla_breach(): u8 { REASON_SLA_BREACH }
