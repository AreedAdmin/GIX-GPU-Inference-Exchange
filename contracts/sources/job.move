/// The `Job<phantom M, phantom Q>` shared object — the atom of parallel settlement.
///
/// A Job binds one consumer, one provider, one market's credits + `Q` escrow, the content
/// hashes, and the three deadlines (ack / exec / attest) copied from the market SLA at
/// creation. `M` brands the market's compute credit; `Q` is the per-network quote/settlement
/// dollar (`MOCK_USDC` localnet, `DBUSDC` testnet, real `USDC` mainnet — see
/// docs/onramp-dbusdc-plan.md). Each Job is its own shared object, so two jobs settle
/// concurrently (sui-move-contracts.md §8).
///
/// M1 deviation from the canonical multi-step creation: the integration contract's
/// "stubbed match" creates the Job directly from `(provider, credits, escrow)` and
/// advances `Created → … → Dispatched` in one call. The reserved credits and escrow are
/// embedded as typed fields on `Job<M>` (not dynamic object fields) for M1 simplicity;
/// the Job is still the single disjoint settlement atom.
module gix::job;

use gix::ask::{Self, Ask};
use gix::config::Config;
use gix::credit::{Self, Credit};
use gix::escrow::{Self, Escrow};
use gix::events;
use gix::market::Market;
use gix::registry::{Self, ProviderRecord};
use gix::staking::{Self, ProviderStake};
use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::Coin;

// === Error codes (4xx: job / escrow) ===
const EBadState: u64 = 400;
const EEscrowMismatch: u64 = 401;
const EWrongProvider: u64 = 304;
const EZeroQty: u64 = 405;
const EInsufficientEscrow: u64 = 407;
const EWrongMarket: u64 = 408;
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
///
/// `output_hash` is the verification primitive (GIX's own `sha2_256` digest of the
/// completion). `quote_blob_id` (M2, additive) is the Walrus `blob_id` COMMITMENT under
/// which the signed attestation quote / receipt is stored — it is a storage pointer, NOT a
/// content hash, so it sits alongside `output_hash` rather than replacing it. `0` means "no
/// Walrus quote recorded" (e.g. the localnet mock path).
public struct AttestationRecord has store, drop {
    measurement: vector<u8>,
    output_hash: vector<u8>,
    output_token_count: u64,
    t_start: u64,
    t_end: u64,
    verified_at: u64,
    verdict: u8,
    /// Walrus blob id of the attestation quote (commitment, not a hash). 0 = none.
    quote_blob_id: u256,
}

public struct Job<phantom M, phantom Q> has key {
    id: UID,
    version: u64,
    market_id: ID,
    model_id: ID,
    consumer: address,
    provider: address,
    state: u8,
    /// M2: this Job was created via the DeepBook fill path (`create_job_from_fill`), so the
    /// provider was ALREADY PAID USDC at the fill (off-chain to GIX) and there is NO escrow.
    /// `false` for the M1 owned-credits (`create_job`) and Ask (`create_job_from_ask`) paths,
    /// which DO hold a USDC escrow. Settlement branches on this: fill-jobs pay nothing extra
    /// on success (just burn the credit) and, on fault, refund the consumer FROM the slash.
    is_fill: bool,
    // content bindings
    input_hash: vector<u8>,
    output_hash: vector<u8>,
    /// M2 (additive): Walrus blob id COMMITMENTS for the job I/O. `input_blob_id` is the
    /// prompt blob the consumer committed at creation; `output_blob_id` is the completion
    /// blob recorded at attestation. Both are commitments, NOT content hashes — GIX's own
    /// `input_hash`/`output_hash` (`sha2_256`) remain the verification primitive. `0` = none.
    input_blob_id: u256,
    output_blob_id: u256,
    // economics
    scu_qty: u64,
    price_usdc: u64,
    /// `Q` escrow held against delivery. `some` for the M1 escrow paths; `none` for M2
    /// fill-jobs (the provider was paid at the DeepBook match — Option B, pay-at-match).
    escrow: Option<Escrow<Q>>,
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
public fun create_job<M, Q>(
    cfg: &Config,
    market: &Market<M>,
    stake: &mut ProviderStake<Q>,
    provider: address,
    credits: Coin<Credit<M>>,
    escrow_in: Coin<Q>,
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

    build_and_share<M, Q>(
        cfg,
        market,
        provider,
        ctx.sender(),
        credit::from_coin(credits),
        scu_qty,
        option::some(escrow::lock(escrow_in, ctx.sender())),
        price_usdc,
        false, // M1 owned-credits path: USDC escrow held against delivery.
        input_hash,
        0, // no Walrus input blob on the M1 owned-credits path
        clk,
        ctx,
    )
}

// === Creation from a DeepBook fill (Option B — pay-at-match) ===

/// Create a Job from a DeepBook fill: the M2 fill-job path. **Consumer-signed.** The consumer
/// has, in the SAME PTB, swapped USDC→`Coin<Credit<M>>` on the market's DeepBook pool — which
/// PAID THE PROVIDER (the resting maker) USDC AT THE FILL (off-chain to GIX) — and now feeds
/// the returned credits straight into this function. Because the provider was already paid,
/// **there is NO USDC escrow** for a fill-job (`escrow = none`). The consumer's protection is
/// **refund-from-slash**: on a fault the provider's bond is slashed and the consumer is
/// refunded in USDC out of the slash (the `k`-ratio guarantees the refund is covered).
///
/// Reserve-then-burn: the `credits` are real minted supply (the provider minted them to post
/// the DeepBook ask). We reserve them into the Job and burn them at `settle_fill` — the
/// mint→reserve→burn chain is preserved, and `consume_minted` retires the minted SCU. This
/// path does NOT bump `reserved_scu` (the consumer cannot reach the provider's stake; minted
/// capacity already bounds exposure — same accounting note as `create_job_from_ask`).
///
/// Provider assignment (M2 demo): a **single provider** serves the market (the GB10), so the
/// caller passes that provider's `ProviderRecord` and the Job is bound to its operator. We
/// assert the record's gpu_class is sane only by binding the operator address — there is no
/// on-chain proof that THIS record was the DeepBook maker the swap filled against. Multi-
/// provider trustless dispatch (resolving the filled `maker_balance_manager_id → owner()` and
/// proving the credit provenance) is **DEFERRED** — see INTERFACE.md "DEFERRED".
///
/// Requires the market to have a bound DeepBook pool (`assert_has_deepbook_pool`).
public fun create_job_from_fill<M, Q>(
    cfg: &Config,
    market: &Market<M>,
    provider_rec: &ProviderRecord,
    credits: Coin<Credit<M>>,
    input_blob_id: u256,
    input_hash: vector<u8>,
    clk: &Clock,
    ctx: &mut TxContext,
): ID {
    cfg.assert_version();
    cfg.assert_not_paused();
    market.assert_active();
    // M2 fill-jobs only exist against a market governance has wired to a DeepBook pool.
    market.assert_has_deepbook_pool();

    let scu_qty = credit::value(&credits);
    assert!(scu_qty > 0, EZeroQty);

    // ── DEFERRED: Walrus PoA / BlobCertified dispatch gate ──────────────────────────────
    // A future revision will gate dispatch on the consumer's input blob being CERTIFIED on
    // Walrus (Proof-of-Availability: `Blob.certified_epoch` set), so the provider can always
    // fetch the prompt. That requires receiving the on-chain `walrus::blob::Blob` (or its
    // certified-epoch proof) here and asserting availability. We deliberately DO NOT take a
    // Walrus Move dependency in M2 (composition is PTB-level) and we record only the
    // `input_blob_id` COMMITMENT below — the availability check is a no-op stub for now.
    // ────────────────────────────────────────────────────────────────────────────────────

    let provider = registry::provider_operator(provider_rec);

    // No escrow: the provider was paid USDC at the fill. `price_usdc` records the work value
    // (= scu_qty) so the slash→refund split has a value-at-risk to cap the consumer comp at.
    // (In USDC terms the at-risk amount the consumer paid on DeepBook is off-chain; we use the
    // SCU quantity as the per-job exposure unit, consistent with `bond_share`'s qty weighting.)
    let price_usdc = scu_qty;

    build_and_share<M, Q>(
        cfg,
        market,
        provider,
        ctx.sender(),
        credit::from_coin(credits),
        scu_qty,
        option::none<Escrow<Q>>(), // Option B: no Q escrow — provider already paid at the fill.
        price_usdc,
        true, // fill-job
        input_hash,
        input_blob_id,
        clk,
        ctx,
    )
}

// === Creation from a resting Ask (two-account / order-book path) ===

/// Create a Job by filling a resting shared `Ask<M>` — the consumer-signed taker path that
/// lets a DISTINCT consumer wallet (buyer ≠ seller) buy compute from a provider's offered
/// capacity WITHOUT ever touching a provider-owned object (no `ProviderStake`, no
/// `ProviderCap`). The only provider object in scope is the shared `Ask` itself.
///
/// Draws `qty_scu` credits out of the shared ask, locks the consumer's escrow, and shares a
/// `Job<M>` bound to `ask.provider` (consumer = `ctx.sender()`), advancing straight to
/// `Dispatched`. The escrow must fund the ask's quoted price (`escrow ≥ qty_scu *
/// price_usdc_per_scu`); the job's `price_usdc` is the FULL escrow value (any overpay sits
/// in escrow and is paid to the provider at settle / refunded on fault, exactly like the
/// owned-credits path).
///
/// Capacity note: the ask's credits are pre-minted real supply (`minted_scu` already bumped
/// at `post_ask`), so this path does NOT bump `reserved_scu` — the consumer cannot reach the
/// provider's stake to do so, and minted capacity already bounds exposure. At `settle` the
/// provider signs with its own stake; `consume_minted` retires the minted SCU and `release`
/// is a tolerant no-op. Settlement therefore pays `ask.provider` (and, on fault, slashes the
/// provider's bond) entirely through the existing provider-signed paths.
public fun create_job_from_ask<M, Q>(
    cfg: &Config,
    market: &Market<M>,
    ask: &mut Ask<M>,
    qty_scu: u64,
    escrow_in: Coin<Q>,
    input_hash: vector<u8>,
    clk: &Clock,
    ctx: &mut TxContext,
): ID {
    cfg.assert_version();
    cfg.assert_not_paused();
    market.assert_active();
    assert!(ask::market_id<M>(ask) == market.market_id(), EWrongMarket);
    assert!(qty_scu > 0, EZeroQty);

    // Underfunded escrow rejected; over-draw rejected (inside ask::draw).
    let price = escrow_in.value();
    let required = (qty_scu as u128) * (ask::price_usdc_per_scu<M>(ask) as u128);
    assert!((price as u128) >= required, EInsufficientEscrow);

    let provider = ask::provider<M>(ask);
    let credits = ask::draw<M>(ask, qty_scu);

    build_and_share<M, Q>(
        cfg,
        market,
        provider,
        ctx.sender(),
        credits,
        qty_scu,
        option::some(escrow::lock(escrow_in, ctx.sender())),
        price,
        false, // M1.5 Ask path: USDC escrow held against delivery.
        input_hash,
        0, // no Walrus input blob on the M1.5 Ask path
        clk,
        ctx,
    )
}

/// Shared Job constructor: stores the (optional) escrow, copies SLA deadlines, advances to
/// `Dispatched`, emits `JobCreated` + `Dispatched`, shares the Job and returns its `ID`. Used
/// by the owned-credits path (`create_job`), the order-book path (`create_job_from_ask`), and
/// the DeepBook fill path (`create_job_from_fill`). `escrow_opt` is `some` for the escrow
/// paths and `none` for fill-jobs (Option B — provider already paid at the match).
fun build_and_share<M, Q>(
    cfg: &Config,
    market: &Market<M>,
    provider: address,
    consumer: address,
    credits: Balance<Credit<M>>,
    scu_qty: u64,
    escrow_opt: Option<Escrow<Q>>,
    price_usdc: u64,
    is_fill: bool,
    input_hash: vector<u8>,
    input_blob_id: u256,
    clk: &Clock,
    ctx: &mut TxContext,
): ID {
    let now = clk.timestamp_ms();
    let job = Job<M, Q> {
        id: object::new(ctx),
        version: cfg.version(),
        market_id: market.market_id(),
        model_id: market.model_id(),
        consumer,
        provider,
        state: STATE_DISPATCHED,
        is_fill,
        input_hash,
        output_hash: vector[],
        input_blob_id,
        output_blob_id: 0,
        scu_qty,
        price_usdc,
        escrow: escrow_opt,
        reserved_credits: credits,
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
public fun ack<M, Q>(job: &mut Job<M, Q>, clk: &Clock, ctx: &TxContext) {
    assert!(ctx.sender() == job.provider, EWrongProvider);
    assert!(job.state == STATE_DISPATCHED || job.state == STATE_EXECUTING, EBadState);
    if (job.state == STATE_EXECUTING) { return };
    assert!(clk.timestamp_ms() <= job.ack_deadline, EAttestDeadline);
    job.acked = true;
    job.state = STATE_EXECUTING;
}

// === Package-internal accessors / mutators (attestation, settlement) ===

public(package) fun state<M, Q>(job: &Job<M, Q>): u8 { job.state }
public(package) fun consumer<M, Q>(job: &Job<M, Q>): address { job.consumer }
public(package) fun provider<M, Q>(job: &Job<M, Q>): address { job.provider }
public(package) fun market_id<M, Q>(job: &Job<M, Q>): ID { job.market_id }
public(package) fun model_id<M, Q>(job: &Job<M, Q>): ID { job.model_id }
public(package) fun scu_qty<M, Q>(job: &Job<M, Q>): u64 { job.scu_qty }
public(package) fun price_usdc<M, Q>(job: &Job<M, Q>): u64 { job.price_usdc }
public(package) fun input_hash<M, Q>(job: &Job<M, Q>): vector<u8> { job.input_hash }
public(package) fun attest_deadline<M, Q>(job: &Job<M, Q>): u64 { job.attest_deadline }
public(package) fun exec_deadline<M, Q>(job: &Job<M, Q>): u64 { job.exec_deadline }
public(package) fun ack_deadline<M, Q>(job: &Job<M, Q>): u64 { job.ack_deadline }
public(package) fun is_acked<M, Q>(job: &Job<M, Q>): bool { job.acked }
public(package) fun is_terminal<M, Q>(job: &Job<M, Q>): bool {
    job.state == STATE_SETTLED || job.state == STATE_REFUNDED || job.state == STATE_EXPIRED
}

/// Whether this job carries a `Q` escrow (M1 escrow paths) vs. is a fill-job (Option B —
/// no escrow, provider paid at the DeepBook match).
public(package) fun has_escrow<M, Q>(job: &Job<M, Q>): bool { option::is_some(&job.escrow) }
public(package) fun is_fill<M, Q>(job: &Job<M, Q>): bool { job.is_fill }

public(package) fun escrow_mut<M, Q>(job: &mut Job<M, Q>): &mut Escrow<Q> { option::borrow_mut(&mut job.escrow) }
public(package) fun escrow_ref<M, Q>(job: &Job<M, Q>): &Escrow<Q> { option::borrow(&job.escrow) }

/// Take the reserved credit balance out of the Job (settlement burns it; refund returns
/// it to the provider). Leaves a zero balance in its place.
public(package) fun take_reserved_credits<M, Q>(job: &mut Job<M, Q>): Balance<Credit<M>> {
    balance::withdraw_all(&mut job.reserved_credits)
}

/// Drain the job's USDC escrow as a `Balance`. For an escrow job this withdraws the locked
/// funds (leaving an empty, still-present escrow as the M1 paths do). For a fill-job there
/// is NO escrow, so this returns a zero balance — settlement therefore moves no USDC out of
/// a fill-job on the happy path (the provider was already paid at the DeepBook match).
public(package) fun take_escrow_funds<M, Q>(job: &mut Job<M, Q>): Balance<Q> {
    if (option::is_some(&job.escrow)) {
        escrow::withdraw_all(option::borrow_mut(&mut job.escrow))
    } else {
        balance::zero<Q>()
    }
}

/// Record the attestation result and advance state (Executing → Attested → Verified, or
/// → flagged for refund on a failing verdict). Called by `attestation`.
///
/// M2 (additive): `output_blob_id` is the Walrus blob id of the completion and
/// `quote_blob_id` the Walrus blob id of the signed attestation quote — both COMMITMENTS,
/// stored alongside the `output_hash` (`sha2_256`) verification primitive, not in place of
/// it. Pass `0` for either when there is no Walrus blob (e.g. the localnet mock path).
public(package) fun record_attestation<M, Q>(
    job: &mut Job<M, Q>,
    measurement: vector<u8>,
    output_hash: vector<u8>,
    output_token_count: u64,
    t_start: u64,
    t_end: u64,
    verdict: u8,
    verified_at: u64,
    output_blob_id: u256,
    quote_blob_id: u256,
) {
    assert!(option::is_none(&job.attestation), EAlreadyAttested);
    job.output_hash = output_hash;
    job.output_blob_id = output_blob_id;
    job.attestation = option::some(AttestationRecord {
        measurement,
        output_hash,
        output_token_count,
        t_start,
        t_end,
        verified_at,
        verdict,
        quote_blob_id,
    });
    job.state = if (verdict == VERDICT_VALID) {
        STATE_VERIFIED
    } else {
        STATE_ATTESTED // failing verdicts stay non-verified; settlement routes to refund+slash
    };
}

public(package) fun set_state_settled<M, Q>(job: &mut Job<M, Q>) { job.state = STATE_SETTLED; }
public(package) fun set_state_refunded<M, Q>(job: &mut Job<M, Q>) { job.state = STATE_REFUNDED; }
public(package) fun set_state_expired<M, Q>(job: &mut Job<M, Q>) { job.state = STATE_EXPIRED; }
public(package) fun set_slashed<M, Q>(job: &mut Job<M, Q>) { job.slashed = true; }

public(package) fun attestation_verdict<M, Q>(job: &Job<M, Q>): u8 {
    if (option::is_some(&job.attestation)) {
        option::borrow(&job.attestation).verdict
    } else {
        VERDICT_INVALID
    }
}

public(package) fun has_attestation<M, Q>(job: &Job<M, Q>): bool { option::is_some(&job.attestation) }
public(package) fun output_hash<M, Q>(job: &Job<M, Q>): vector<u8> { job.output_hash }

// === Public reads ===

public fun job_state<M, Q>(job: &Job<M, Q>): u8 { job.state }
public fun job_consumer<M, Q>(job: &Job<M, Q>): address { job.consumer }
public fun job_provider<M, Q>(job: &Job<M, Q>): address { job.provider }
public fun job_price<M, Q>(job: &Job<M, Q>): u64 { job.price_usdc }
public fun job_qty<M, Q>(job: &Job<M, Q>): u64 { job.scu_qty }
public fun job_slashed<M, Q>(job: &Job<M, Q>): bool { job.slashed }
/// Escrow value held by the job; `0` for a fill-job (Option B — no escrow).
public fun job_escrow_value<M, Q>(job: &Job<M, Q>): u64 {
    if (option::is_some(&job.escrow)) escrow::value(option::borrow(&job.escrow)) else 0
}
public fun job_output_hash<M, Q>(job: &Job<M, Q>): vector<u8> { job.output_hash }
/// Whether this is a DeepBook fill-job (Option B — no escrow, provider paid at the match).
public fun job_is_fill<M, Q>(job: &Job<M, Q>): bool { job.is_fill }
/// Walrus blob id COMMITMENTS (not content hashes). `0` = none recorded.
public fun job_input_blob_id<M, Q>(job: &Job<M, Q>): u256 { job.input_blob_id }
public fun job_output_blob_id<M, Q>(job: &Job<M, Q>): u256 { job.output_blob_id }
/// Walrus blob id of the attestation quote, if attested; `0` otherwise.
public fun job_quote_blob_id<M, Q>(job: &Job<M, Q>): u256 {
    if (option::is_some(&job.attestation)) option::borrow(&job.attestation).quote_blob_id else 0
}

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
