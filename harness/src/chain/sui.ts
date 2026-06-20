/**
 * SuiChain — the on-chain `Chain` implementation. Builds PTBs with @mysten/sui
 * and submits them against a localnet running the `gix` package.
 *
 * STATUS: reconciled against the AS-BUILT `gix` ABI in contracts/INTERFACE.md and
 * contracts/sources/*.move (M1). Every `tx.moveCall` target, arg order, and type
 * arg below matches the deployed package. See src/chain/INTERFACE_ASSUMPTIONS.md
 * for the per-item reconciliation log.
 *
 * To keep `npm test`/dry-run hermetic (no validator, no network), the heavy
 * @mysten/sui client construction is lazy: nothing in this file imports the SDK
 * at module load; it is dynamically imported the first time a real run starts.
 */

import type { MockAttestation } from "../actors/attestation.js";
import type { Deployment, MarketDeployment } from "../config/types.js";
import type { HarnessEvent } from "../observability/events.js";
import {
  FailureReason,
  FaultClass,
  JobState,
  type JobRecord,
  type Match,
} from "../orchestrator/model.js";
import type { Chain, CreateJobResult } from "./chain.js";
import type { Logger } from "../observability/logger.js";

// We import only types at the top to avoid loading the SDK in dry-run/tests.
// Runtime values are pulled in via dynamic import() inside connect().
type SuiClientT = import("@mysten/sui/client").SuiClient;
type KeypairT = import("@mysten/sui/cryptography").Keypair;
type TransactionT = import("@mysten/sui/transactions").Transaction;

export interface SuiChainOptions {
  deployment: Deployment;
  /** RPC url, defaults to localnet. */
  rpcUrl?: string;
  /**
   * Signer factory: maps an account address → its Keypair. Supplied by the CLI
   * from the sui keystore. In M1/localnet this is the set of funded accounts in
   * deployment.accounts (single funded account = admin/provider/consumer is OK).
   */
  keypairFor: (address: string) => KeypairT;
  logger: Logger;
}

/** What `submit_mock_attestation` records as the verdict, predicted off the on-chain
 * `compute_verdict` rule (attestation.move): INVALID if the measurement is not
 * allowlisted / model inactive / empty output; SLA_BREACH if t_end-t_start > p99;
 * else VALID. The harness submits the allowlisted measurement + a non-empty output,
 * so on chain only the SLA window distinguishes VALID from SLA_BREACH. */
type OnChainVerdict = "VALID" | "SLA_BREACH" | "INVALID";

export class SuiChain implements Chain {
  readonly mode = "sui" as const;

  private client!: SuiClientT;
  private Transaction!: new () => TransactionT;
  private connected = false;

  private readonly pkg: string;
  private readonly cfgId: string;
  private readonly usdcType: string;
  private readonly clockId: string;
  private readonly marketById: Map<string, MarketDeployment>;

  /** ProviderStake object id per provider, captured at setup. */
  private stakeIdByProvider = new Map<string, string>();
  /** ProviderCap object id per provider, captured at setup. */
  private capIdByProvider = new Map<string, string>();
  /** Minted Credit<M> coin id per (provider, market). */
  private creditCoinByKey = new Map<string, string>();

  constructor(private readonly opts: SuiChainOptions) {
    const d = opts.deployment;
    this.pkg = d.packageId;
    this.cfgId = d.configId;
    this.usdcType = d.usdcType;
    this.clockId = d.clockId;
    this.marketById = new Map(d.markets.map((m) => [m.id, m]));
  }

  /** Lazily construct the SDK client + Transaction class. */
  private async connect(): Promise<void> {
    if (this.connected) return;
    const { SuiClient, getFullnodeUrl } = await import("@mysten/sui/client");
    const { Transaction } = await import("@mysten/sui/transactions");
    this.client = new SuiClient({
      url: this.opts.rpcUrl ?? getFullnodeUrl("localnet"),
    });
    this.Transaction = Transaction as unknown as new () => TransactionT;
    this.connected = true;
  }

  private market(marketId: string): MarketDeployment {
    const m = this.marketById.get(marketId);
    if (!m) throw new Error(`SuiChain: unknown market ${marketId}`);
    return m;
  }

  // ---- lifecycle ---------------------------------------------------------

  async setupProvider(
    address: string,
    bondUsdc: number,
    capacityScu: number,
    mintScu: number,
  ): Promise<HarnessEvent[]> {
    await this.connect();
    const signer = this.opts.keypairFor(address);
    const tx = new this.Transaction();

    // 1. Faucet MOCK_USDC for the bond, composed inside the PTB.
    //    mock_usdc::mint_and_return(faucet, amount, ctx): Coin<MOCK_USDC>.
    const minted = tx.moveCall({
      target: `${this.pkg}::mock_usdc::mint_and_return`,
      arguments: [tx.object(this.faucetId()), tx.pure.u64(BigInt(bondUsdc))],
    });

    // 2. Register the provider → ProviderCap value (registry::register_provider
    //    mints + shares a ProviderRecord and RETURNS the ProviderCap). We use the
    //    returned cap directly in this same PTB, then transfer it to the operator
    //    so later txns can resolve it via getOwnedObjects.
    const providerCap = tx.moveCall({
      target: `${this.pkg}::registry::register_provider`,
      arguments: [
        tx.pure.address(address),
        tx.pure.vector("u8", strBytes(`http://provider/${address.slice(2, 10)}`)),
        tx.pure.vector("u8", strBytes("H100-80GB")),
      ],
    });

    // 3. stake(cap, cfg, bond, capacity_scu, ctx) -> ProviderStake.
    const stake = tx.moveCall({
      target: `${this.pkg}::staking::stake`,
      typeArguments: [],
      arguments: [
        providerCap,
        tx.object(this.cfgId),
        minted, // Coin<MOCK_USDC>
        tx.pure.u64(BigInt(capacityScu)),
      ],
    });

    // 4. mint_credits<M>(cap, &mut stake, cfg, &mut market, qty, ctx): Coin<Credit<M>>.
    const firstMarket = this.opts.deployment.markets[0]!;
    const credit = tx.moveCall({
      target: `${this.pkg}::staking::mint_credits`,
      typeArguments: [firstMarket.creditType],
      arguments: [
        providerCap,
        stake,
        tx.object(this.cfgId),
        tx.object(firstMarket.id),
        tx.pure.u64(BigInt(mintScu)),
      ],
    });

    // The fresh ProviderCap + ProviderStake + Credit coin must be transferred to
    // the provider so subsequent txns can reference them as owned objects.
    tx.transferObjects([providerCap, stake, credit], tx.pure.address(address));

    const res = await this.exec(tx, signer);
    this.assertOk(res, "setupProvider");
    // Capture created object ids from effects for later create_job/settle calls.
    this.captureSetupObjects(address, firstMarket.id, res);

    return this.eventsFromTx(res, ["Staked", "CreditsMinted"]);
  }

  async setupConsumer(address: string, budgetUsdc: number): Promise<HarnessEvent[]> {
    await this.connect();
    const signer = this.opts.keypairFor(address);
    const tx = new this.Transaction();
    // Faucet MOCK_USDC to the consumer so they can fund escrow.
    // mock_usdc::mint(faucet, amount, recipient, ctx) transfers to recipient.
    tx.moveCall({
      target: `${this.pkg}::mock_usdc::mint`,
      arguments: [
        tx.object(this.faucetId()),
        tx.pure.u64(BigInt(budgetUsdc)),
        tx.pure.address(address),
      ],
    });
    const res = await this.exec(tx, signer);
    this.assertOk(res, "setupConsumer");
    return [];
  }

  async createJob(match: Match, marketId: string, nowMs: number): Promise<CreateJobResult> {
    await this.connect();
    const market = this.market(marketId);
    const consumerSigner = this.opts.keypairFor(match.consumer);
    const tx = new this.Transaction();

    // escrow_in: a Coin<MOCK_USDC> == qty * price, resolved from the consumer's
    // MOCK_USDC coins (not gas — escrow must be the quote asset).
    const escrowCoin = await this.splitEscrowCoin(tx, match.consumer, match.escrowUsdc);
    // credits: a Credit<M> slice for this qty out of the provider's minted coin.
    const creditCoin = this.resolveCreditCoin(tx, match.provider, marketId, match.qtyScu);
    const stakeId = this.stakeIdByProvider.get(match.provider);
    if (!stakeId) throw new Error(`createJob: no ProviderStake for ${match.provider}`);

    // create_job<M>(cfg, market: &Market<M>, stake: &mut ProviderStake, provider,
    //   credits: Coin<Credit<M>>, escrow_in: Coin<MOCK_USDC>, input_hash, clk, ctx): ID
    // The Job is shared; the model_id is read from the market internally.
    tx.moveCall({
      target: `${this.pkg}::job::create_job`,
      typeArguments: [market.creditType],
      arguments: [
        tx.object(this.cfgId),
        tx.object(market.id),
        tx.object(stakeId),
        tx.pure.address(match.provider),
        creditCoin,
        escrowCoin,
        tx.pure.vector("u8", hexToBytes(match.bid.inputHash)),
        tx.object(this.clockId),
      ],
    });

    const res = await this.exec(tx, consumerSigner);
    this.assertOk(res, "createJob");
    const jobId =
      this.firstSharedObjectOfType(res, `${this.pkg}::job::Job`) ??
      `0xjob_${res.digest.slice(2, 10)}`;

    const record: JobRecord = {
      jobId,
      marketId,
      provider: match.provider,
      consumer: match.consumer,
      qtyScu: match.qtyScu,
      priceUsdcPerScu: match.priceUsdcPerScu,
      escrowUsdc: match.escrowUsdc,
      inputHash: match.bid.inputHash,
      outputHash: "",
      state: JobState.Dispatched,
      fault: FaultClass.None,
      failureReason: FailureReason.None,
      tStart: nowMs,
      tEnd: nowMs,
      slashedUsdc: 0,
      feeUsdc: 0,
      payoutUsdc: 0,
      slashed: false,
    };
    // JobCreated on chain carries `price_usdc`/`scu_qty` but not `escrowUsdc`; the
    // escrow value IS the price in M1, so surface it for the Tally.
    const events = this.eventsFromTx(res, ["JobCreated", "Dispatched"]).map((e) =>
      e.type === "JobCreated"
        ? { ...e, data: { ...(e.data ?? {}), escrowUsdc: match.escrowUsdc } }
        : e,
    );
    return { job: record, events };
  }

  async submitMockAttestation(
    job: JobRecord,
    att: MockAttestation,
    _slaP99Ms: number,
    _nowMs: number,
  ): Promise<HarnessEvent[]> {
    await this.connect();
    const market = this.market(job.marketId);
    const providerSigner = this.opts.keypairFor(job.provider);
    const tx = new this.Transaction();

    // The provider MUST ack (Dispatched → Executing) before attesting:
    // submit_mock_attestation asserts state == Executing. ack<M>(job, clk, ctx).
    tx.moveCall({
      target: `${this.pkg}::job::ack`,
      typeArguments: [market.creditType],
      arguments: [tx.object(job.jobId), tx.object(this.clockId)],
    });

    // submit_mock_attestation<M>(job, cfg, market: &Market<M>, model, allow,
    //   runtime_measurement, output_hash, output_token_count, t_start, t_end, clk, ctx).
    // The measurement MUST be the deploy-allowlisted MOCK measurement or the verdict
    // is INVALID. We submit the allowlisted value verbatim.
    tx.moveCall({
      target: `${this.pkg}::attestation::submit_mock_attestation`,
      typeArguments: [market.creditType],
      arguments: [
        tx.object(job.jobId),
        tx.object(this.cfgId),
        tx.object(market.id),
        tx.object(this.modelRecordId(market)),
        tx.object(this.allowlistId()),
        tx.pure.vector("u8", this.measurementBytes()),
        tx.pure.vector("u8", hexToBytes(att.outputHash)),
        tx.pure.u64(BigInt(att.outputTokenCount)),
        tx.pure.u64(BigInt(att.tStart)),
        tx.pure.u64(BigInt(att.tEnd)),
        tx.object(this.clockId),
      ],
    });
    const res = await this.exec(tx, providerSigner);
    this.assertOk(res, "submitMockAttestation");
    job.state = JobState.Attested;
    job.outputHash = att.outputHash;
    job.tStart = att.tStart;
    job.tEnd = att.tEnd;
    return this.eventsFromTx(res, ["AttestationSubmitted"]);
  }

  async resolve(job: JobRecord, slaP99Ms: number, _nowMs: number): Promise<HarnessEvent[]> {
    await this.connect();
    const market = this.market(job.marketId);
    const stakeId = this.stakeIdByProvider.get(job.provider);
    if (!stakeId) throw new Error(`resolve: no ProviderStake for ${job.provider}`);
    // settle / resolve_attested / expire are callable by anyone; sign with the
    // provider so a happy-path payout lands in the provider's wallet.
    const signer = this.opts.keypairFor(job.provider);
    const treasuryId = this.treasuryId();

    if (job.fault === FaultClass.SkipAttest) {
      // Missing attestation: the provider never acked/attested, so the only legal
      // route is expire_and_resolve once a deadline lapses (here: the ack deadline,
      // ~30s after creation). It refunds + slashes (liveness fault). We must wait
      // for the on-chain ack deadline to pass first.
      await this.awaitAckDeadline(job, market);
      const tx = new this.Transaction();
      tx.moveCall({
        target: `${this.pkg}::settlement::expire_and_resolve`,
        typeArguments: [market.creditType],
        arguments: [
          tx.object(job.jobId),
          tx.object(market.id),
          tx.object(this.cfgId),
          tx.object(stakeId),
          tx.object(treasuryId),
          tx.object(this.clockId),
        ],
      });
      const res = await this.exec(tx, signer);
      this.assertOk(res, "expire_and_resolve");
      return this.terminalEvents(job, res);
    }

    // Attested job: route off the verdict the chain recorded. VALID → settle;
    // SLA_BREACH / INVALID → resolve_attested (refund + slash).
    const verdict = this.predictOnChainVerdict(job, slaP99Ms);
    const tx = new this.Transaction();
    if (verdict === "VALID") {
      // settle<M>(job, &mut market, cfg, &mut stake, &mut treasury, ctx) — no clock.
      tx.moveCall({
        target: `${this.pkg}::settlement::settle`,
        typeArguments: [market.creditType],
        arguments: [
          tx.object(job.jobId),
          tx.object(market.id),
          tx.object(this.cfgId),
          tx.object(stakeId),
          tx.object(treasuryId),
        ],
      });
    } else {
      // resolve_attested<M>(job, &mut market, cfg, &mut stake, &mut treasury, ctx).
      tx.moveCall({
        target: `${this.pkg}::settlement::resolve_attested`,
        typeArguments: [market.creditType],
        arguments: [
          tx.object(job.jobId),
          tx.object(market.id),
          tx.object(this.cfgId),
          tx.object(stakeId),
          tx.object(treasuryId),
        ],
      });
    }
    const res = await this.exec(tx, signer);
    this.assertOk(res, verdict === "VALID" ? "settle" : "resolve_attested");
    return this.terminalEvents(job, res);
  }

  // ---- low-level helpers -------------------------------------------------

  private async exec(tx: TransactionT, signer: KeypairT) {
    const res = await this.client.signAndExecuteTransaction({
      transaction: tx as unknown as Parameters<
        SuiClientT["signAndExecuteTransaction"]
      >[0]["transaction"],
      signer,
      options: { showEffects: true, showEvents: true, showObjectChanges: true },
    });
    // Sequential txns by the same signer race on gas/object versions if the next
    // one is built before this digest is fully indexed (manifests as a JSON-RPC
    // "Internal error"). Block until the fullnode has it so the next getCoins /
    // owned-object read and gas selection see fresh state.
    await this.client.waitForTransaction({ digest: res.digest });
    return res;
  }

  /** Throw a readable error (with the tx digest) on a failed transaction. */
  private assertOk(res: Awaited<ReturnType<SuiChainT["exec"]>>, where: string): void {
    const status = res.effects?.status;
    if (status && status.status !== "success") {
      throw new Error(
        `SuiChain.${where}: tx ${res.digest} failed: ${status.error ?? "unknown error"}`,
      );
    }
  }

  /** Map the terminal move events to the harness Tally's expected field names and
   * stamp the JobRecord's terminal state from what actually happened on chain. */
  private terminalEvents(
    job: JobRecord,
    res: Awaited<ReturnType<SuiChainT["exec"]>>,
  ): HarnessEvent[] {
    const evs = this.eventsFromTx(res, ["Settled", "Refunded", "Slashed", "Expired"]);
    let settled = false;
    let refunded = false;
    let slashed = false;
    for (const e of evs) {
      if (e.type === "Settled") {
        settled = true;
        job.payoutUsdc = numOf(e.data, "payout");
        job.feeUsdc = numOf(e.data, "fee");
        // Re-key for the Tally (it reads payoutUsdc / feeUsdc).
        e.data = { ...(e.data ?? {}), payoutUsdc: job.payoutUsdc, feeUsdc: job.feeUsdc };
      } else if (e.type === "Refunded") {
        refunded = true;
        e.data = { ...(e.data ?? {}), amountUsdc: numOf(e.data, "amount") };
      } else if (e.type === "Slashed") {
        slashed = true;
        job.slashedUsdc = numOf(e.data, "penalty");
        job.slashed = job.slashedUsdc > 0;
        e.data = {
          ...(e.data ?? {}),
          penaltyUsdc: job.slashedUsdc,
          toConsumerUsdc: numOf(e.data, "to_consumer"),
          toTreasuryUsdc: numOf(e.data, "to_treasury"),
        };
      }
    }
    job.state = settled
      ? JobState.Settled
      : refunded
        ? JobState.Refunded
        : JobState.Expired;
    if (slashed) job.slashed = true;
    return evs;
  }

  /**
   * Translate emitted `gix::events` move events into HarnessEvents, keeping only
   * the requested types. The on-chain event `type` is `${pkg}::events::<Name>`.
   */
  private eventsFromTx(res: Awaited<ReturnType<SuiChainT["exec"]>>, want: string[]): HarnessEvent[] {
    const out: HarnessEvent[] = [];
    const ts = Number(res.timestampMs ?? Date.now());
    for (const ev of res.events ?? []) {
      const name = ev.type.split("::").pop() ?? "";
      if (!want.includes(name)) continue;
      const f = (ev.parsedJson ?? {}) as Record<string, unknown>;
      out.push({
        type: name as HarnessEvent["type"],
        ts,
        jobId: (f.job_id as string) ?? undefined,
        provider: (f.provider as string) ?? undefined,
        consumer: (f.consumer as string) ?? undefined,
        marketId: (f.market_id as string) ?? undefined,
        data: numericFields(f),
      });
    }
    return out;
  }

  // The following resolvers encapsulate the verified ABI's object requirements.

  /** Resolve the exact MOCK measurement bytes the deploy allowlisted for the model.
   * Falls back to the deploy default ("MOCK-tdx-llama8b-v1") if not surfaced. */
  private measurementBytes(): number[] {
    const tag = this.opts.deployment.mockMeasurement ?? "MOCK-tdx-llama8b-v1";
    return strBytes(tag);
  }

  private async splitEscrowCoin(tx: TransactionT, consumer: string, amount: number) {
    // Resolve the consumer's MOCK_USDC coins, merge if needed, split the exact
    // escrow. getCoins paginates; one page is plenty on localnet.
    const { data } = await this.client.getCoins({ owner: consumer, coinType: this.usdcType });
    if (data.length === 0) {
      throw new Error(
        `createJob: consumer ${consumer} holds no ${this.usdcType} coins (run setupConsumer first)`,
      );
    }
    const primary = tx.object(data[0]!.coinObjectId);
    if (data.length > 1) {
      tx.mergeCoins(primary, data.slice(1).map((c) => tx.object(c.coinObjectId)));
    }
    const [coin] = tx.splitCoins(primary, [tx.pure.u64(BigInt(amount))]);
    return coin;
  }

  private resolveCreditCoin(tx: TransactionT, provider: string, marketId: string, qty: number) {
    const key = `${provider}|${marketId}`;
    const coinId = this.creditCoinByKey.get(key);
    if (!coinId) throw new Error(`no Credit coin for ${key}`);
    const [slice] = tx.splitCoins(tx.object(coinId), [tx.pure.u64(BigInt(qty))]);
    return slice;
  }

  /** Predict the verdict `submit_mock_attestation` recorded. Mirrors compute_verdict:
   * the harness always submits the allowlisted measurement + a non-empty output, so
   * (on the active model) only the SLA window separates VALID from SLA_BREACH. The
   * harness's LateAttest fault forces t_end-t_start > p99 ⇒ SLA_BREACH. */
  private predictOnChainVerdict(job: JobRecord, slaP99Ms: number): OnChainVerdict {
    if (job.tEnd - job.tStart > slaP99Ms) return "SLA_BREACH";
    return "VALID";
  }

  /** Wait until the on-chain Clock passes a job's ack deadline so expire_and_resolve
   * is legal for a never-acked (SkipAttest) job. Polls the shared Clock. */
  private async awaitAckDeadline(job: JobRecord, market: MarketDeployment): Promise<void> {
    // ack_deadline = created_at + 30_000 (market DEFAULT_ACK_MS). created_at ≈ the
    // job's creation wall-clock; wait a little past 30s then confirm via the chain.
    const targetMs = job.tStart + 31_000;
    // Read the live Clock once to anchor; then sleep-and-recheck.
    for (let i = 0; i < 40; i++) {
      const now = await this.chainNowMs();
      if (now >= targetMs) return;
      await sleep(2_000);
    }
    void market;
  }

  private async chainNowMs(): Promise<number> {
    const obj = await this.client.getObject({ id: this.clockId, options: { showContent: true } });
    const content = obj.data?.content as
      | { fields?: { timestamp_ms?: string } }
      | undefined;
    const ts = content?.fields?.timestamp_ms;
    return ts ? Number(ts) : Date.now();
  }

  private extra(key: string, label: string): string {
    const v = (this.opts.deployment as unknown as Record<string, unknown>)[key];
    if (typeof v === "string" && v) return v;
    throw new Error(
      `SuiChain: deployment.json is missing "${key}" (the ${label} object id) ` +
        `now required by the verified gix ABI — add it to the deploy output.`,
    );
  }

  private faucetId(): string {
    return this.extra("faucetId", "mock_usdc::Faucet");
  }
  private treasuryId(): string {
    return this.extra("treasuryId", "settlement::Treasury");
  }
  private allowlistId(): string {
    return this.extra("allowlistId", "registry::MeasurementAllowlist");
  }
  private modelRecordId(market: MarketDeployment): string {
    const m = market as unknown as Record<string, unknown>;
    if (typeof m.modelId === "string" && m.modelId) return m.modelId;
    return this.extra("modelRecordId", "registry::ModelRecord");
  }

  /** Capture the ProviderCap, ProviderStake and Credit coin ids created at setup. */
  private captureSetupObjects(
    provider: string,
    marketId: string,
    res: Awaited<ReturnType<SuiChainT["exec"]>>,
  ): void {
    for (const ch of res.objectChanges ?? []) {
      if (ch.type !== "created") continue;
      if (ch.objectType.includes("::registry::ProviderCap")) {
        this.capIdByProvider.set(provider, ch.objectId);
      } else if (ch.objectType.includes("::staking::ProviderStake")) {
        this.stakeIdByProvider.set(provider, ch.objectId);
      } else if (ch.objectType.includes("::credit::Credit<")) {
        this.creditCoinByKey.set(`${provider}|${marketId}`, ch.objectId);
      }
    }
  }

  private firstSharedObjectOfType(
    res: Awaited<ReturnType<SuiChainT["exec"]>>,
    typeStr: string,
  ): string | undefined {
    for (const ch of res.objectChanges ?? []) {
      if (ch.type === "created" && ch.objectType.startsWith(typeStr)) return ch.objectId;
    }
    return undefined;
  }
}

type SuiChainT = SuiChain;

// --- pure helpers ---------------------------------------------------------

function strBytes(s: string): number[] {
  return Array.from(Buffer.from(s, "utf8"));
}

function hexToBytes(hex: string): number[] {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out: number[] = [];
  for (let i = 0; i + 1 < clean.length; i += 2) {
    out.push(parseInt(clean.slice(i, i + 2), 16));
  }
  return out;
}

function numOf(data: Record<string, number | string> | undefined, k: string): number {
  const v = data?.[k];
  return typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : 0;
}

function numericFields(f: Record<string, unknown>): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(f)) {
    if (typeof v === "number") out[k] = v;
    else if (typeof v === "string" && /^\d+$/.test(v)) out[k] = Number(v);
    else if (typeof v === "string") out[k] = v;
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
