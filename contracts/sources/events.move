/// Structured event surface for the `gix` package.
///
/// This is the indexer/SDK contract: the harness (workstream B) and ops tooling
/// (workstream C) observe these via `sui` events to render the job flow. Each event
/// is `copy, drop` and carries the IDs/amounts needed to join off-chain.
///
/// Required surface (mvp-m1-integration-contract.md §"Lifecycle event surface"):
/// `MarketCreated`, `Staked`, `CreditsMinted`, `JobCreated`, `Dispatched`,
/// `AttestationSubmitted`, `Settled`, `Refunded`, `Slashed`.
module gix::events;

use sui::event;

// === Event structs ===

public struct MarketCreated has copy, drop {
    market_id: ID,
    name: vector<u8>,
    model_id: ID,
    scu_tokens: u64,
    sla_p99_ms: u64,
}

public struct ModelRegistered has copy, drop {
    model_id: ID,
    model_hash: vector<u8>,
    walrus_blob_id: vector<u8>,
}

public struct ProviderRegistered has copy, drop {
    provider_id: ID,
    operator: address,
}

public struct MeasurementAdded has copy, drop {
    model_id: ID,
    measurement: vector<u8>,
}

public struct Staked has copy, drop {
    stake_id: ID,
    provider: address,
    amount: u64,
    capacity_scu: u64,
}

public struct Unstaked has copy, drop {
    stake_id: ID,
    provider: address,
    amount: u64,
}

public struct CreditsMinted has copy, drop {
    stake_id: ID,
    market_id: ID,
    provider: address,
    qty: u64,
}

public struct JobCreated has copy, drop {
    job_id: ID,
    market_id: ID,
    consumer: address,
    provider: address,
    scu_qty: u64,
    price_usdc: u64,
}

public struct Dispatched has copy, drop {
    job_id: ID,
    provider: address,
    model_id: ID,
    input_hash: vector<u8>,
    exec_deadline: u64,
}

public struct AttestationSubmitted has copy, drop {
    job_id: ID,
    measurement: vector<u8>,
    output_hash: vector<u8>,
    output_token_count: u64,
    t_start: u64,
    t_end: u64,
    verdict: u8,
}

public struct Settled has copy, drop {
    job_id: ID,
    provider: address,
    payout: u64,
    fee: u64,
    output_hash: vector<u8>,
}

public struct Refunded has copy, drop {
    job_id: ID,
    consumer: address,
    amount: u64,
    reason: u8,
    slashed: bool,
}

public struct Slashed has copy, drop {
    job_id: ID,
    provider: address,
    penalty: u64,
    to_consumer: u64,
    to_treasury: u64,
    reason: u8,
}

// === Emit helpers (package-internal callers) ===

public(package) fun market_created(
    market_id: ID,
    name: vector<u8>,
    model_id: ID,
    scu_tokens: u64,
    sla_p99_ms: u64,
) {
    event::emit(MarketCreated { market_id, name, model_id, scu_tokens, sla_p99_ms });
}

public(package) fun model_registered(
    model_id: ID,
    model_hash: vector<u8>,
    walrus_blob_id: vector<u8>,
) {
    event::emit(ModelRegistered { model_id, model_hash, walrus_blob_id });
}

public(package) fun provider_registered(provider_id: ID, operator: address) {
    event::emit(ProviderRegistered { provider_id, operator });
}

public(package) fun measurement_added(model_id: ID, measurement: vector<u8>) {
    event::emit(MeasurementAdded { model_id, measurement });
}

public(package) fun staked(stake_id: ID, provider: address, amount: u64, capacity_scu: u64) {
    event::emit(Staked { stake_id, provider, amount, capacity_scu });
}

public(package) fun unstaked(stake_id: ID, provider: address, amount: u64) {
    event::emit(Unstaked { stake_id, provider, amount });
}

public(package) fun credits_minted(stake_id: ID, market_id: ID, provider: address, qty: u64) {
    event::emit(CreditsMinted { stake_id, market_id, provider, qty });
}

public(package) fun job_created(
    job_id: ID,
    market_id: ID,
    consumer: address,
    provider: address,
    scu_qty: u64,
    price_usdc: u64,
) {
    event::emit(JobCreated { job_id, market_id, consumer, provider, scu_qty, price_usdc });
}

public(package) fun dispatched(
    job_id: ID,
    provider: address,
    model_id: ID,
    input_hash: vector<u8>,
    exec_deadline: u64,
) {
    event::emit(Dispatched { job_id, provider, model_id, input_hash, exec_deadline });
}

public(package) fun attestation_submitted(
    job_id: ID,
    measurement: vector<u8>,
    output_hash: vector<u8>,
    output_token_count: u64,
    t_start: u64,
    t_end: u64,
    verdict: u8,
) {
    event::emit(AttestationSubmitted {
        job_id,
        measurement,
        output_hash,
        output_token_count,
        t_start,
        t_end,
        verdict,
    });
}

public(package) fun settled(
    job_id: ID,
    provider: address,
    payout: u64,
    fee: u64,
    output_hash: vector<u8>,
) {
    event::emit(Settled { job_id, provider, payout, fee, output_hash });
}

public(package) fun refunded(
    job_id: ID,
    consumer: address,
    amount: u64,
    reason: u8,
    slashed: bool,
) {
    event::emit(Refunded { job_id, consumer, amount, reason, slashed });
}

public(package) fun slashed(
    job_id: ID,
    provider: address,
    penalty: u64,
    to_consumer: u64,
    to_treasury: u64,
    reason: u8,
) {
    event::emit(Slashed { job_id, provider, penalty, to_consumer, to_treasury, reason });
}
