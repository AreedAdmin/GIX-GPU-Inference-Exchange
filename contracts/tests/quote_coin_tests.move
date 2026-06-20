/// Proves the quote/bond/settlement dollar is a *generic phantom* `Q`, not a hardcoded
/// `MOCK_USDC`, and that the new `M_GB10_QWEN35B` (GB10 · Qwen3.6-35b) market works.
///
/// The existing 32 tests already exercise the full lifecycle with `Q = MOCK_USDC` (localnet),
/// proving the localnet behavior is preserved. THIS module instead instantiates the SAME code
/// paths with a *different* quote coin — `TUSD`, a test stand-in for `DBUSDC` (the real
/// testnet `DBUSDC` is an external coin not present on the test ledger). If the protocol were
/// still hardcoded to `MOCK_USDC` this would not type-check; that it settles end-to-end with
/// `Q = TUSD` is the proof the dollar is chosen at instantiation.
#[test_only]
module gix::quote_coin_tests;

use gix::ask::Ask;
use gix::config::{Self, Config, AdminCap};
use gix::credit::Credit;
use gix::governance;
use gix::job::{Self, Job};
use gix::market::{Self, Market};
use gix::markets::M_GB10_QWEN35B;
use gix::registry::{Self, MeasurementAllowlist, ProviderCap};
use gix::settlement::{Self, Treasury};
use gix::staking::{Self, ProviderStake};
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::test_scenario::{Self as ts, Scenario};

/// Test-only quote dollar standing in for testnet `DBUSDC`. A distinct phantom type from
/// `MOCK_USDC`, so a passing test proves the protocol is coin-agnostic over `Q`.
public struct TUSD has drop {}

const ADMIN: address = @0xAD;
const PROVIDER: address = @0xB0B;
const CONSUMER: address = @0xCAFE;

const BOND: u64 = 10_000_000; // 10 TUSD (6 decimals)
const CAPACITY: u64 = 100;
const QTY: u64 = 10;
const PRICE: u64 = 1_000_000; // 1 TUSD escrow

// GB10 · Qwen3.6-35b market params.
const SCU_TOKENS: u64 = 1000;
const SLA_P99_MS: u64 = 30_000; // ~p99 30s interactive SLA
const MOCK_MEASUREMENT: vector<u8> = b"MOCK-tdx-qwen35b-v1";

fun mint_tusd(sc: &mut Scenario, amount: u64): Coin<TUSD> {
    coin::mint_for_testing<TUSD>(amount, sc.ctx())
}

fun begin(): Scenario {
    let mut sc = ts::begin(ADMIN);
    {
        let ctx = sc.ctx();
        config::init_for_testing(ctx);
        registry::init_for_testing(ctx);
        // Publish a TUSD-denominated treasury (mirrors `init_treasury<DBUSDC>` on testnet).
        let cap = config::new_admin_cap_for_testing(ctx);
        settlement::init_treasury<TUSD>(&cap, ctx);
        transfer::public_transfer(cap, ADMIN);
        let clk = clock::create_for_testing(ctx);
        clk.share_for_testing();
    };
    sc.next_tx(ADMIN);
    sc
}

/// Admin creates the GB10 · Qwen3.6-35b market + registers the qwen model/measurement.
fun bootstrap_gb10_qwen(sc: &mut Scenario): ID {
    sc.next_tx(ADMIN);
    let cap = sc.take_from_sender<AdminCap>();
    let cfg = sc.take_shared<Config>();
    let mut allow = sc.take_shared<MeasurementAllowlist>();

    let model_id = governance::register_model_with_measurement(
        &cap,
        &cfg,
        &mut allow,
        b"qwen3.6-35b/vllm",
        b"walrus-blob-qwen35b",
        b"model-hash-qwen35b",
        MOCK_MEASUREMENT,
        sc.ctx(),
    );

    market::create_market<M_GB10_QWEN35B>(
        &cap,
        &cfg,
        b"GB10-qwen3.6-35b",
        b"GB10",
        model_id,
        SCU_TOKENS,
        SLA_P99_MS,
        sc.ctx(),
    );

    ts::return_shared(cfg);
    ts::return_shared(allow);
    sc.return_to_sender(cap);
    model_id
}

/// Provider registers, stakes a TUSD bond, mints credits — all over `Q = TUSD`.
fun provider_setup(sc: &mut Scenario): Coin<Credit<M_GB10_QWEN35B>> {
    sc.next_tx(PROVIDER);
    let cfg = sc.take_shared<Config>();
    let cap = registry::register_provider(
        &cfg,
        b"http://gb10-node",
        b"GB10",
        x"0000000000000000000000000000000000000000000000000000000000000000",
        sc.ctx(),
    );
    let mut market = sc.take_shared<Market<M_GB10_QWEN35B>>();
    let bond = mint_tusd(sc, BOND);
    // `Q = TUSD` inferred from the bond coin — no MOCK_USDC anywhere.
    let mut stake = staking::stake<TUSD>(&cap, &cfg, bond, CAPACITY, sc.ctx());
    let credits = staking::mint_credits<M_GB10_QWEN35B, TUSD>(
        &cap,
        &mut stake,
        &cfg,
        &mut market,
        QTY,
        sc.ctx(),
    );
    ts::return_shared(cfg);
    ts::return_shared(market);
    transfer::public_transfer(cap, PROVIDER);
    transfer::public_transfer(stake, PROVIDER);
    credits
}

/// End-to-end happy path over `Q = TUSD`: stake → mint → create_job → ack → attest → settle,
/// with the provider paid in TUSD and the fee landing in the TUSD treasury. This is the
/// localnet flow byte-for-byte, only the dollar differs — proving the generic `Q`.
#[test]
fun gb10_qwen_market_settles_over_generic_quote_coin() {
    let mut sc = begin();
    bootstrap_gb10_qwen(&mut sc);
    let credits = provider_setup(&mut sc);

    // Consumer creates a job, funding a TUSD escrow.
    sc.next_tx(CONSUMER);
    let _job_id = {
        let cfg = sc.take_shared<Config>();
        let market = sc.take_shared<Market<M_GB10_QWEN35B>>();
        let clk = sc.take_shared<Clock>();
        let mut stake = ts::take_from_address<ProviderStake<TUSD>>(&sc, PROVIDER);
        let escrow = mint_tusd(&mut sc, PRICE);
        let id = job::create_job<M_GB10_QWEN35B, TUSD>(
            &cfg,
            &market,
            &mut stake,
            PROVIDER,
            credits,
            escrow,
            b"input-hash-qwen",
            &clk,
            sc.ctx(),
        );
        ts::return_shared(cfg);
        ts::return_shared(market);
        ts::return_shared(clk);
        ts::return_to_address(PROVIDER, stake);
        id
    };

    // Provider acks.
    sc.next_tx(PROVIDER);
    {
        let mut job = sc.take_shared<Job<M_GB10_QWEN35B, TUSD>>();
        let clk = sc.take_shared<Clock>();
        job::ack<M_GB10_QWEN35B, TUSD>(&mut job, &clk, sc.ctx());
        ts::return_shared(job);
        ts::return_shared(clk);
    };

    // Provider submits a (mock) attestation within SLA -> VALID.
    sc.next_tx(PROVIDER);
    {
        let mut job = sc.take_shared<Job<M_GB10_QWEN35B, TUSD>>();
        let cfg = sc.take_shared<Config>();
        let market = sc.take_shared<Market<M_GB10_QWEN35B>>();
        let model = sc.take_shared<gix::registry::ModelRecord>();
        let allow = sc.take_shared<MeasurementAllowlist>();
        let clk = sc.take_shared<Clock>();
        gix::attestation::submit_mock_attestation<M_GB10_QWEN35B, TUSD>(
            &mut job,
            &cfg,
            &market,
            &model,
            &allow,
            MOCK_MEASUREMENT,
            b"output-hash-qwen",
            500,
            0,
            1000, // 1s latency, well within the 30s p99
            &clk,
            sc.ctx(),
        );
        ts::return_shared(job);
        ts::return_shared(cfg);
        ts::return_shared(market);
        ts::return_shared(model);
        ts::return_shared(allow);
        ts::return_shared(clk);
    };

    // Anyone settles: provider paid in TUSD, fee to the TUSD treasury, credit burned.
    sc.next_tx(CONSUMER);
    {
        let mut job = sc.take_shared<Job<M_GB10_QWEN35B, TUSD>>();
        let mut market = sc.take_shared<Market<M_GB10_QWEN35B>>();
        let cfg = sc.take_shared<Config>();
        let mut stake = ts::take_from_address<ProviderStake<TUSD>>(&sc, PROVIDER);
        let mut treasury = sc.take_shared<Treasury<TUSD>>();

        settlement::settle<M_GB10_QWEN35B, TUSD>(
            &mut job,
            &mut market,
            &cfg,
            &mut stake,
            &mut treasury,
            sc.ctx(),
        );

        // Job settled; capacity consumed; minted credit burned.
        assert!(job::job_state(&job) == job::s_settled(), 1);
        assert!(staking::minted_scu(&stake) == 0, 2);
        assert!(staking::reserved_scu(&stake) == 0, 3);
        assert!(market::outstanding_credits<M_GB10_QWEN35B>(&market) == 0, 4);
        // Fee (0.30% of 1 TUSD) landed in the TUSD treasury.
        let fee = (PRICE * config::protocol_fee_bps(&cfg)) / config::bps_denom();
        assert!(settlement::treasury_fees_collected(&treasury) == fee, 5);
        assert!(settlement::treasury_balance(&treasury) == fee, 6);

        ts::return_shared(job);
        ts::return_shared(market);
        ts::return_shared(cfg);
        ts::return_to_address(PROVIDER, stake);
        ts::return_shared(treasury);
    };

    // Provider received a TUSD payout (price - fee).
    sc.next_tx(PROVIDER);
    {
        let payout = ts::take_from_address<Coin<TUSD>>(&sc, PROVIDER);
        let fee = (PRICE * 30) / 10_000;
        assert!(coin::value(&payout) == PRICE - fee, 7);
        transfer::public_transfer(payout, PROVIDER);
    };

    sc.end();
}

/// The GB10·Qwen market can be created with the new witness and exposes its identity
/// (gpu_class = GB10, the qwen SLA), independent of the quote coin.
#[test]
fun gb10_qwen_market_identity() {
    let mut sc = begin();
    bootstrap_gb10_qwen(&mut sc);

    sc.next_tx(ADMIN);
    {
        let market = sc.take_shared<Market<M_GB10_QWEN35B>>();
        assert!(market::gpu_class(&market) == b"GB10", 1);
        assert!(market::name(&market) == b"GB10-qwen3.6-35b", 2);
        assert!(market::p99_ms(&market) == SLA_P99_MS, 3);
        assert!(market::is_active(&market), 4);
        ts::return_shared(market);
    };

    sc.end();
}

/// The order-book (Ask) path also works over `Q = TUSD`: a provider posts an ask, a distinct
/// buyer fills it funding a TUSD escrow, proving the parameterized quote across buyer != seller.
#[test]
fun gb10_qwen_ask_fill_over_generic_quote_coin() {
    let mut sc = begin();
    bootstrap_gb10_qwen(&mut sc);

    // Provider registers + stakes (no mint here; post_ask mints).
    sc.next_tx(PROVIDER);
    {
        let cfg = sc.take_shared<Config>();
        let cap = registry::register_provider(
            &cfg, b"http://gb10-node", b"GB10",
            x"0000000000000000000000000000000000000000000000000000000000000000", sc.ctx(),
        );
        let bond = mint_tusd(&mut sc, BOND);
        let stake = staking::stake<TUSD>(&cap, &cfg, bond, CAPACITY, sc.ctx());
        ts::return_shared(cfg);
        transfer::public_transfer(cap, PROVIDER);
        transfer::public_transfer(stake, PROVIDER);
    };

    // Provider posts a resting ask (mints credits inside post_ask).
    sc.next_tx(PROVIDER);
    {
        let cfg = sc.take_shared<Config>();
        let mut market = sc.take_shared<Market<M_GB10_QWEN35B>>();
        let cap = ts::take_from_address<ProviderCap>(&sc, PROVIDER);
        let mut stake = ts::take_from_address<ProviderStake<TUSD>>(&sc, PROVIDER);
        staking::post_ask<M_GB10_QWEN35B, TUSD>(
            &cap, &mut stake, &cfg, &mut market, QTY, 100_000, sc.ctx(),
        );
        ts::return_shared(cfg);
        ts::return_shared(market);
        ts::return_to_address(PROVIDER, cap);
        ts::return_to_address(PROVIDER, stake);
    };

    // A distinct buyer fills the ask funding a TUSD escrow (buyer never touches the stake).
    sc.next_tx(@0xC02);
    {
        let cfg = sc.take_shared<Config>();
        let market = sc.take_shared<Market<M_GB10_QWEN35B>>();
        let mut ask = sc.take_shared<Ask<M_GB10_QWEN35B>>();
        let clk = sc.take_shared<Clock>();
        let escrow = mint_tusd(&mut sc, QTY * 100_000);
        let _job_id = job::create_job_from_ask<M_GB10_QWEN35B, TUSD>(
            &cfg, &market, &mut ask, QTY, escrow, b"input-hash-qwen", &clk, sc.ctx(),
        );
        ts::return_shared(cfg);
        ts::return_shared(market);
        ts::return_shared(ask);
        ts::return_shared(clk);
    };

    // The shared TUSD-escrow Job now exists for the GB10·Qwen market.
    sc.next_tx(@0xC02);
    {
        let job = sc.take_shared<Job<M_GB10_QWEN35B, TUSD>>();
        assert!(job::job_state(&job) == job::s_dispatched(), 1);
        assert!(job::job_consumer(&job) == @0xC02, 2);
        assert!(job::job_provider(&job) == PROVIDER, 3);
        ts::return_shared(job);
    };

    sc.end();
}
