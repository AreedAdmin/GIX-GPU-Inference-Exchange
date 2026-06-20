/// Shared test harness: bootstraps the full `gix` protocol on a `test_scenario` ledger and
/// drives the job lifecycle so each scenario test reads as a high-level flow.
#[test_only]
module gix::harness;

use gix::ask::{Ask};
use gix::attestation;
use gix::config::{Self, Config, AdminCap};
use gix::credit::Credit;
use gix::governance;
use gix::job::{Self, Job};
use gix::market::{Self, Market};
use gix::markets::M_H100_LLAMA8B;
use gix::mock_usdc::{Self, MOCK_USDC};
use gix::registry::{Self, ModelRecord, MeasurementAllowlist, ProviderCap, ProviderRecord};
use gix::settlement::{Self, Treasury};
use gix::staking::{Self, ProviderStake};
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::test_scenario::{Self as ts, Scenario};

// Canonical actors.
public fun admin(): address { @0xAD }
public fun provider(): address { @0xB0B }
public fun consumer(): address { @0xCAFE }
/// A second, DISTINCT consumer wallet (buyer ≠ seller, buyer ≠ default consumer) used by the
/// two-account order-book flow to prove a stranger can buy from a provider's Ask.
public fun consumer2(): address { @0xC02 }

// M1 market parameters.
public fun scu_tokens(): u64 { 1000 }
public fun sla_p99_ms(): u64 { 5000 }
public fun mock_measurement(): vector<u8> { b"MOCK-tdx-llama8b-v1" }
public fun model_hash(): vector<u8> { b"model-hash-llama8b" }
public fun input_hash(): vector<u8> { b"input-hash-1" }
public fun output_hash(): vector<u8> { b"output-hash-1" }

/// A throwaway 32-byte Ed25519 pubkey for the mock-path harness flows (which never verify a
/// signature). The signed-attestation tests use real keys from `gix::signed_attestation_tests`.
public fun dummy_pubkey(): vector<u8> {
    x"0000000000000000000000000000000000000000000000000000000000000000"
}

/// Begin a scenario as admin and publish all singletons (Config+AdminCap, registry
/// allowlist, treasury, mock USDC faucet, and a Clock).
public fun begin(): Scenario {
    let mut sc = ts::begin(admin());
    {
        let ctx = sc.ctx();
        config::init_for_testing(ctx);
        registry::init_for_testing(ctx);
        settlement::init_for_testing(ctx);
        mock_usdc::init_for_testing(ctx);
        let clk = clock::create_for_testing(ctx);
        clk.share_for_testing();
    };
    sc.next_tx(admin());
    sc
}

/// Mint `amount` MOCK_USDC to the current sender and return the coin.
public fun mint_usdc(sc: &mut Scenario, amount: u64): Coin<MOCK_USDC> {
    mock_usdc::mint_for_testing(amount, sc.ctx())
}

/// Admin creates the M1 market, registers the model + mock measurement, and returns the
/// model id. Leaves Config/AdminCap/allowlist shared.
public fun bootstrap_market(sc: &mut Scenario): ID {
    sc.next_tx(admin());
    let cap = sc.take_from_sender<AdminCap>();
    let cfg = sc.take_shared<Config>();
    let mut allow = sc.take_shared<MeasurementAllowlist>();

    let model_id = governance::register_model_with_measurement(
        &cap,
        &cfg,
        &mut allow,
        b"llama-3.1-8b-int8/vllm",
        b"walrus-blob-model-1",
        model_hash(),
        mock_measurement(),
        sc.ctx(),
    );

    market::create_market<M_H100_LLAMA8B>(
        &cap,
        &cfg,
        b"H100-llama3.1-8b-int8",
        b"H100-80GB",
        model_id,
        scu_tokens(),
        sla_p99_ms(),
        sc.ctx(),
    );

    ts::return_shared(cfg);
    ts::return_shared(allow);
    sc.return_to_sender(cap);
    model_id
}

/// Provider registers (with a dummy attestation pubkey), stakes `bond_amt` USDC opening
/// `capacity` SCU, and mints `qty` credits. Used by the mock-path flows.
public fun provider_setup(
    sc: &mut Scenario,
    bond_amt: u64,
    capacity: u64,
    qty: u64,
): Coin<Credit<M_H100_LLAMA8B>> {
    provider_setup_with_key(sc, bond_amt, capacity, qty, dummy_pubkey())
}

/// Provider registers with an explicit 32-byte Ed25519 `attest_pubkey`, stakes `bond_amt`
/// USDC opening `capacity` SCU, and mints `qty` credits. Returns the minted credits; the
/// ProviderCap + stake are transferred to the provider as owned objects.
public fun provider_setup_with_key(
    sc: &mut Scenario,
    bond_amt: u64,
    capacity: u64,
    qty: u64,
    attest_pubkey: vector<u8>,
): Coin<Credit<M_H100_LLAMA8B>> {
    sc.next_tx(provider());
    let cfg = sc.take_shared<Config>();
    let cap = registry::register_provider(&cfg, b"http://node", b"H100-80GB", attest_pubkey, sc.ctx());

    let mut market = sc.take_shared<Market<M_H100_LLAMA8B>>();
    let bond = mint_usdc(sc, bond_amt);
    let mut stake = staking::stake<MOCK_USDC>(&cap, &cfg, bond, capacity, sc.ctx());
    let credits = staking::mint_credits<M_H100_LLAMA8B, MOCK_USDC>(
        &cap,
        &mut stake,
        &cfg,
        &mut market,
        qty,
        sc.ctx(),
    );

    ts::return_shared(cfg);
    ts::return_shared(market);
    transfer::public_transfer(cap, provider());
    transfer::public_transfer(stake, provider());
    credits
}

/// Provider registers (dummy attest key) and stakes `bond_amt` USDC opening `capacity` SCU,
/// but mints NOTHING here — the cap + stake stay owned by the provider so the order-book
/// flow can `post_ask` (which mints inside). Used by the two-account ask tests.
public fun provider_register_and_stake(sc: &mut Scenario, bond_amt: u64, capacity: u64) {
    sc.next_tx(provider());
    let cfg = sc.take_shared<Config>();
    let cap = registry::register_provider(&cfg, b"http://node", b"H100-80GB", dummy_pubkey(), sc.ctx());
    let bond = mint_usdc(sc, bond_amt);
    let stake = staking::stake<MOCK_USDC>(&cap, &cfg, bond, capacity, sc.ctx());
    ts::return_shared(cfg);
    transfer::public_transfer(cap, provider());
    transfer::public_transfer(stake, provider());
}

/// Provider posts a resting `Ask<M>` for `qty` SCU at `price_per_scu` USDC/SCU using its
/// owned cap + stake (signed by the provider). Mints the credits inside `post_ask`. Returns
/// the new ask's id.
public fun post_ask(sc: &mut Scenario, qty: u64, price_per_scu: u64): ID {
    sc.next_tx(provider());
    let cfg = sc.take_shared<Config>();
    let mut market = sc.take_shared<Market<M_H100_LLAMA8B>>();
    let cap = ts::take_from_address<ProviderCap>(sc, provider());
    let mut stake = ts::take_from_address<ProviderStake<MOCK_USDC>>(sc, provider());

    let ask_id = staking::post_ask<M_H100_LLAMA8B, MOCK_USDC>(
        &cap,
        &mut stake,
        &cfg,
        &mut market,
        qty,
        price_per_scu,
        sc.ctx(),
    );

    ts::return_shared(cfg);
    ts::return_shared(market);
    ts::return_to_address(provider(), cap);
    ts::return_to_address(provider(), stake);
    ask_id
}

/// `buyer` fills the shared `Ask` for `qty` SCU, funding `escrow` USDC, WITHOUT touching any
/// provider-owned object (no ProviderStake / ProviderCap in scope). Returns the new Job id.
public fun create_job_from_ask(
    sc: &mut Scenario,
    buyer: address,
    qty: u64,
    escrow_amt: u64,
): ID {
    sc.next_tx(buyer);
    let cfg = sc.take_shared<Config>();
    let market = sc.take_shared<Market<M_H100_LLAMA8B>>();
    let mut ask = sc.take_shared<Ask<M_H100_LLAMA8B>>();
    let clk = sc.take_shared<Clock>();
    let escrow = mint_usdc(sc, escrow_amt);

    let job_id = job::create_job_from_ask<M_H100_LLAMA8B, MOCK_USDC>(
        &cfg,
        &market,
        &mut ask,
        qty,
        escrow,
        input_hash(),
        &clk,
        sc.ctx(),
    );

    ts::return_shared(cfg);
    ts::return_shared(market);
    ts::return_shared(ask);
    ts::return_shared(clk);
    job_id
}

// === M2 DeepBook fill path (Option B — pay-at-match) ===

/// Admin binds a (dummy) DeepBook pool id onto the market so the fill path's
/// `assert_has_deepbook_pool` is satisfied. Returns the bound id. The on-chain contract never
/// calls DeepBook; this is a governance-published pointer (real composition is PTB-level).
public fun bind_deepbook_pool(sc: &mut Scenario): ID {
    sc.next_tx(admin());
    let cap = sc.take_from_sender<AdminCap>();
    let mut market = sc.take_shared<Market<M_H100_LLAMA8B>>();
    // A deterministic stand-in pool id (no DeepBook on the test ledger).
    let pool_id = object::id_from_address(@0xDEE9);
    market::set_deepbook_pool_id<M_H100_LLAMA8B>(&cap, &mut market, pool_id);
    ts::return_shared(market);
    sc.return_to_sender(cap);
    pool_id
}

/// Provider registers (explicit `attest_pubkey`) and stakes + mints `qty` credits, then
/// TRANSFERS the minted `Coin<Credit<M>>` to `buyer`. This stands in for the DeepBook swap:
/// in production the consumer swaps USDC→Credit on the pool (paying the provider USDC at the
/// fill) and the swap RETURNS the `Coin<Credit<M>>` into the same PTB. Here we simulate that
/// outcome — the buyer ends up holding the credit, the provider already "got paid" off-chain.
/// Leaves the ProviderCap + ProviderStake owned by the provider; shares the ProviderRecord.
public fun fill_setup_with_key(
    sc: &mut Scenario,
    buyer: address,
    bond_amt: u64,
    capacity: u64,
    qty: u64,
    attest_pubkey: vector<u8>,
) {
    sc.next_tx(provider());
    let cfg = sc.take_shared<Config>();
    let cap = registry::register_provider(&cfg, b"http://node", b"H100-80GB", attest_pubkey, sc.ctx());
    let mut market = sc.take_shared<Market<M_H100_LLAMA8B>>();
    let bond = mint_usdc(sc, bond_amt);
    let mut stake = staking::stake<MOCK_USDC>(&cap, &cfg, bond, capacity, sc.ctx());
    let credits = staking::mint_credits<M_H100_LLAMA8B, MOCK_USDC>(&cap, &mut stake, &cfg, &mut market, qty, sc.ctx());
    ts::return_shared(cfg);
    ts::return_shared(market);
    transfer::public_transfer(cap, provider());
    transfer::public_transfer(stake, provider());
    // Hand the swap-output credits to the buyer (simulated DeepBook fill).
    transfer::public_transfer(credits, buyer);
}

/// `buyer` creates a fill-job from the credits it received from the (simulated) DeepBook swap,
/// WITHOUT any escrow and WITHOUT touching the provider's stake/cap — it only references the
/// shared ProviderRecord. Returns the new Job id. Binds `in_blob`/`in_hash`.
public fun create_job_from_fill(
    sc: &mut Scenario,
    buyer: address,
    in_blob: u256,
    in_hash: vector<u8>,
): ID {
    sc.next_tx(buyer);
    let cfg = sc.take_shared<Config>();
    let market = sc.take_shared<Market<M_H100_LLAMA8B>>();
    let provider_rec = sc.take_shared<ProviderRecord>();
    let clk = sc.take_shared<Clock>();
    let credits = ts::take_from_address<Coin<Credit<M_H100_LLAMA8B>>>(sc, buyer);

    let job_id = job::create_job_from_fill<M_H100_LLAMA8B, MOCK_USDC>(
        &cfg,
        &market,
        &provider_rec,
        credits,
        in_blob,
        in_hash,
        &clk,
        sc.ctx(),
    );

    ts::return_shared(cfg);
    ts::return_shared(market);
    ts::return_shared(provider_rec);
    ts::return_shared(clk);
    job_id
}

/// Settle a Verified fill-job (no escrow, no payout — provider already paid at the match).
public fun settle_fill(sc: &mut Scenario) {
    sc.next_tx(consumer());
    let mut job = sc.take_shared<Job<M_H100_LLAMA8B, MOCK_USDC>>();
    let mut market = sc.take_shared<Market<M_H100_LLAMA8B>>();
    let cfg = sc.take_shared<Config>();
    let mut stake = ts::take_from_address<ProviderStake<MOCK_USDC>>(sc, provider());

    settlement::settle_fill<M_H100_LLAMA8B, MOCK_USDC>(&mut job, &mut market, &cfg, &mut stake, sc.ctx());

    ts::return_shared(job);
    ts::return_shared(market);
    ts::return_shared(cfg);
    ts::return_to_address(provider(), stake);
}

/// Resolve an attested-but-failing fill-job (refund the consumer in USDC from the slash).
public fun resolve_fill(sc: &mut Scenario) {
    sc.next_tx(consumer());
    let mut job = sc.take_shared<Job<M_H100_LLAMA8B, MOCK_USDC>>();
    let mut market = sc.take_shared<Market<M_H100_LLAMA8B>>();
    let cfg = sc.take_shared<Config>();
    let mut stake = ts::take_from_address<ProviderStake<MOCK_USDC>>(sc, provider());
    let mut treasury = sc.take_shared<Treasury<MOCK_USDC>>();

    settlement::resolve_fill<M_H100_LLAMA8B, MOCK_USDC>(&mut job, &mut market, &cfg, &mut stake, &mut treasury, sc.ctx());

    ts::return_shared(job);
    ts::return_shared(market);
    ts::return_shared(cfg);
    ts::return_to_address(provider(), stake);
    ts::return_shared(treasury);
}

/// Consumer creates a Job from the provided credits + escrow at the current clock time.
/// Returns the new Job's id. Runs in a consumer tx. Uses the default `input_hash()`.
public fun create_job(
    sc: &mut Scenario,
    credits: Coin<Credit<M_H100_LLAMA8B>>,
    price: u64,
): ID {
    create_job_with_input(sc, credits, price, input_hash())
}

/// Like `create_job` but binds an explicit `input_hash` (e.g. a real `sha2_256(prompt)`
/// digest the signed-attestation flow signs over).
public fun create_job_with_input(
    sc: &mut Scenario,
    credits: Coin<Credit<M_H100_LLAMA8B>>,
    price: u64,
    in_hash: vector<u8>,
): ID {
    sc.next_tx(consumer());
    let cfg = sc.take_shared<Config>();
    let market = sc.take_shared<Market<M_H100_LLAMA8B>>();
    let clk = sc.take_shared<Clock>();
    let mut stake = ts::take_from_address<ProviderStake<MOCK_USDC>>(sc, provider());
    let escrow = mint_usdc(sc, price);

    let job_id = job::create_job<M_H100_LLAMA8B, MOCK_USDC>(
        &cfg,
        &market,
        &mut stake,
        provider(),
        credits,
        escrow,
        in_hash,
        &clk,
        sc.ctx(),
    );

    ts::return_shared(cfg);
    ts::return_shared(market);
    ts::return_shared(clk);
    ts::return_to_address(provider(), stake);
    job_id
}

/// Provider acks the job.
public fun ack(sc: &mut Scenario) {
    sc.next_tx(provider());
    let mut job = sc.take_shared<Job<M_H100_LLAMA8B, MOCK_USDC>>();
    let clk = sc.take_shared<Clock>();
    job::ack<M_H100_LLAMA8B, MOCK_USDC>(&mut job, &clk, sc.ctx());
    ts::return_shared(job);
    ts::return_shared(clk);
}

/// Provider submits a mock attestation with the given timing + output hash.
public fun submit_attestation(
    sc: &mut Scenario,
    measurement: vector<u8>,
    out_hash: vector<u8>,
    output_token_count: u64,
    t_start: u64,
    t_end: u64,
) {
    sc.next_tx(provider());
    let mut job = sc.take_shared<Job<M_H100_LLAMA8B, MOCK_USDC>>();
    let cfg = sc.take_shared<Config>();
    let market = sc.take_shared<Market<M_H100_LLAMA8B>>();
    let model = sc.take_shared<ModelRecord>();
    let allow = sc.take_shared<MeasurementAllowlist>();
    let clk = sc.take_shared<Clock>();

    attestation::submit_mock_attestation<M_H100_LLAMA8B, MOCK_USDC>(
        &mut job,
        &cfg,
        &market,
        &model,
        &allow,
        measurement,
        out_hash,
        output_token_count,
        t_start,
        t_end,
        &clk,
        sc.ctx(),
    );

    ts::return_shared(job);
    ts::return_shared(cfg);
    ts::return_shared(market);
    ts::return_shared(model);
    ts::return_shared(allow);
    ts::return_shared(clk);
}

/// Provider submits a SIGNED attestation: verifies a real Ed25519 `signature` over the
/// canonical message against the provider's registered `ProviderRecord` pubkey.
public fun submit_signed(
    sc: &mut Scenario,
    measurement: vector<u8>,
    in_hash: vector<u8>,
    out_hash: vector<u8>,
    output_token_count: u64,
    t_start: u64,
    t_end: u64,
    signature: vector<u8>,
) {
    sc.next_tx(provider());
    let mut job = sc.take_shared<Job<M_H100_LLAMA8B, MOCK_USDC>>();
    let cfg = sc.take_shared<Config>();
    let market = sc.take_shared<Market<M_H100_LLAMA8B>>();
    let model = sc.take_shared<ModelRecord>();
    let allow = sc.take_shared<MeasurementAllowlist>();
    let provider_rec = sc.take_shared<ProviderRecord>();
    let clk = sc.take_shared<Clock>();

    attestation::submit_signed_attestation<M_H100_LLAMA8B, MOCK_USDC>(
        &mut job,
        &cfg,
        &market,
        &model,
        &allow,
        &provider_rec,
        measurement,
        in_hash,
        out_hash,
        output_token_count,
        t_start,
        t_end,
        signature,
        0, // M2 output_blob_id (unused by these tests)
        0, // M2 quote_blob_id (unused by these tests)
        &clk,
        sc.ctx(),
    );

    ts::return_shared(job);
    ts::return_shared(cfg);
    ts::return_shared(market);
    ts::return_shared(model);
    ts::return_shared(allow);
    ts::return_shared(provider_rec);
    ts::return_shared(clk);
}

/// Advance the shared Clock by `ms`.
public fun advance_clock(sc: &mut Scenario, ms: u64) {
    sc.next_tx(admin());
    let mut clk = sc.take_shared<Clock>();
    clk.increment_for_testing(ms);
    ts::return_shared(clk);
}

/// Set the absolute clock time.
public fun set_clock(sc: &mut Scenario, ms: u64) {
    sc.next_tx(admin());
    let mut clk = sc.take_shared<Clock>();
    clk.set_for_testing(ms);
    ts::return_shared(clk);
}

/// Settle a verified job. Returns nothing; assertions read from objects afterward.
public fun settle(sc: &mut Scenario) {
    sc.next_tx(consumer());
    let mut job = sc.take_shared<Job<M_H100_LLAMA8B, MOCK_USDC>>();
    let mut market = sc.take_shared<Market<M_H100_LLAMA8B>>();
    let cfg = sc.take_shared<Config>();
    let mut stake = ts::take_from_address<ProviderStake<MOCK_USDC>>(sc, provider());
    let mut treasury = sc.take_shared<Treasury<MOCK_USDC>>();

    settlement::settle<M_H100_LLAMA8B, MOCK_USDC>(
        &mut job,
        &mut market,
        &cfg,
        &mut stake,
        &mut treasury,
        sc.ctx(),
    );

    ts::return_shared(job);
    ts::return_shared(market);
    ts::return_shared(cfg);
    ts::return_to_address(provider(), stake);
    ts::return_shared(treasury);
}

/// Resolve an attested-but-failing job (invalid / SLA breach verdict).
public fun resolve_attested(sc: &mut Scenario) {
    sc.next_tx(consumer());
    let mut job = sc.take_shared<Job<M_H100_LLAMA8B, MOCK_USDC>>();
    let mut market = sc.take_shared<Market<M_H100_LLAMA8B>>();
    let cfg = sc.take_shared<Config>();
    let mut stake = ts::take_from_address<ProviderStake<MOCK_USDC>>(sc, provider());
    let mut treasury = sc.take_shared<Treasury<MOCK_USDC>>();

    settlement::resolve_attested<M_H100_LLAMA8B, MOCK_USDC>(
        &mut job,
        &mut market,
        &cfg,
        &mut stake,
        &mut treasury,
        sc.ctx(),
    );

    ts::return_shared(job);
    ts::return_shared(market);
    ts::return_shared(cfg);
    ts::return_to_address(provider(), stake);
    ts::return_shared(treasury);
}

/// Expire-and-resolve a job past a deadline.
public fun expire_and_resolve(sc: &mut Scenario) {
    sc.next_tx(consumer());
    let mut job = sc.take_shared<Job<M_H100_LLAMA8B, MOCK_USDC>>();
    let mut market = sc.take_shared<Market<M_H100_LLAMA8B>>();
    let cfg = sc.take_shared<Config>();
    let mut stake = ts::take_from_address<ProviderStake<MOCK_USDC>>(sc, provider());
    let mut treasury = sc.take_shared<Treasury<MOCK_USDC>>();
    let clk = sc.take_shared<Clock>();

    settlement::expire_and_resolve<M_H100_LLAMA8B, MOCK_USDC>(
        &mut job,
        &mut market,
        &cfg,
        &mut stake,
        &mut treasury,
        &clk,
        sc.ctx(),
    );

    ts::return_shared(job);
    ts::return_shared(market);
    ts::return_shared(cfg);
    ts::return_to_address(provider(), stake);
    ts::return_shared(treasury);
    ts::return_shared(clk);
}

// === Read helpers used by assertions ===

/// Returns the USDC coin balance held by `who` (sums all their MOCK_USDC coins is overkill;
/// tests transfer exactly one payout, so we take the most recent).
public fun take_usdc(sc: &mut Scenario, who: address): Coin<MOCK_USDC> {
    ts::take_from_address<Coin<MOCK_USDC>>(sc, who)
}

public fun has_usdc(who: address): bool {
    ts::has_most_recent_for_address<Coin<MOCK_USDC>>(who)
}

public fun coin_value(c: &Coin<MOCK_USDC>): u64 { coin::value(c) }
