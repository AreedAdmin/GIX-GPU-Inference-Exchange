/**
 * NodeChain — the on-chain surface for the provider node.
 *
 * REUSES the patterns from harness/src/chain/sui.ts (not forked): lazy @mysten/sui
 * import (so HTTP/Ollama-only mode and unit tests stay hermetic), PTB construction
 * with the verified gix ABI arg orders, object-id capture from objectChanges, and
 * the same exec()/waitForTransaction() sequencing to avoid gas/version races.
 *
 * It implements the D0 lifecycle calls:
 *   - registerProvider(endpoint, gpuClass, attestPubkey)  [§1 ABI target]
 *   - stake + mintCredits (USDC bond, MOCK_USDC)
 *   - subscribeDispatched(onJob)                          [Dispatched event poll]
 *   - submitSignedAttestation(...)                        [§1 ABI target]
 *
 * IMPORTANT — ABI reconciliation:
 *   The demo §1 target signatures (register_provider with attest_pubkey;
 *   submit_signed_attestation) are being FINALIZED by D1. The as-built M1
 *   contracts/README.md still has register_provider(operator, endpoint,
 *   gpu_class, ctx) and submit_mock_attestation only. So this module:
 *     • targets the §1 signed-attestation entrypoints by default, AND
 *     • is feature-flagged (GIX_ATTEST_MODE=signed|mock) so the node runs against
 *       either the redeployed soft-attestation contract OR the current M1 mock
 *       contract for a localnet smoke test.
 *   Arg orders for the signed path follow demo §1 verbatim; reconcile to the final
 *   contracts/README.md once D1 publishes.
 */

import type { Keypair } from "@mysten/sui/cryptography";
import type { NodeConfig, MarketDeployment } from "./config.js";
import { marketOf } from "./config.js";
import { hexToBytes } from "./attest/canonical.js";
import type { SuiClientT, TransactionT } from "./txtypes.js";

/** A job to serve, distilled from a Dispatched event. */
export interface DispatchedJob {
  jobId: string;
  provider: string;
  modelId: string;
  /** input_hash as 0x-hex (sha2_256 of the prompt). */
  inputHash: string;
  execDeadline: number;
}

export interface SignedAttestationArgs {
  jobId: string;
  measurement: string; // utf8 measurement string
  inputHash: string; // 0x-hex 32B
  outputHash: string; // 0x-hex 32B
  outputTokenCount: number;
  tStart: number;
  tEnd: number;
  signature: Uint8Array; // 64B
  /** M2: Walrus output (completion) blob commitment as u256; 0 = none. */
  outputBlobId?: bigint;
  /** M2: Walrus attestation-quote blob commitment as u256; 0 = none. */
  quoteBlobId?: bigint;
}

/** M2: a job's kind + Walrus input commitment, read off the shared Job object. */
export interface JobMeta {
  /** true ⇒ created via create_job_from_fill (no escrow; settle via settle_fill/resolve_fill). */
  isFill: boolean;
  /** Walrus input (prompt) blob commitment as u256; 0n = none (use /inputs cache). */
  inputBlobId: bigint;
}

type AttestMode = "signed" | "mock";

export class NodeChain {
  private client!: SuiClientT;
  private Transaction!: new () => TransactionT;
  private connected = false;

  private readonly pkg: string;
  private readonly cfgId: string;
  private readonly usdcType: string;
  private readonly clockId: string;
  private readonly market: MarketDeployment;
  private readonly attestMode: AttestMode;
  private readonly network: NodeConfig["network"];
  private readonly m2Abi: boolean;

  // Captured at setup, mirrors the harness SuiChain bookkeeping.
  private providerCapId?: string;
  private providerRecordId?: string;
  private stakeId?: string;
  private creditCoinId?: string;
  private askId?: string;

  constructor(
    private readonly cfg: NodeConfig,
    private readonly signer: Keypair,
    private readonly providerAddress: string,
    private readonly log: (msg: string) => void,
  ) {
    this.pkg = cfg.deployment.packageId;
    this.cfgId = cfg.deployment.configId;
    this.usdcType = cfg.deployment.usdcType;
    this.clockId = cfg.deployment.clockId;
    this.market = marketOf(cfg);
    this.attestMode = (process.env.GIX_ATTEST_MODE as AttestMode) ?? "signed";
    this.network = cfg.network;
    this.m2Abi = cfg.m2Abi;
  }

  // ---- connection (lazy, harness pattern) -------------------------------

  private async connect(): Promise<void> {
    if (this.connected) return;
    const { SuiJsonRpcClient, getJsonRpcFullnodeUrl } = await import("@mysten/sui/jsonRpc");
    const { Transaction } = await import("@mysten/sui/transactions");
    this.client = new SuiJsonRpcClient({
      network: this.network,
      url: this.cfg.rpcUrl ?? getJsonRpcFullnodeUrl(this.network),
    });
    this.Transaction = Transaction as unknown as new () => TransactionT;
    this.connected = true;
    // Fail fast with a clear message if the RPC is unreachable.
    try {
      await this.client.getLatestSuiSystemState?.();
    } catch {
      /* getLatestSuiSystemState may not exist on localnet shim; ignore */
    }
  }

  async getOwnedUsdcBalance(): Promise<bigint> {
    await this.connect();
    const { data } = await this.client.getCoins({
      owner: this.providerAddress,
      coinType: this.usdcType,
    });
    return data.reduce((acc, c) => acc + BigInt(c.balance), 0n);
  }

  // ---- registration + stake + credits -----------------------------------

  /**
   * register_provider + stake + mint_credits in one or two PTBs.
   *
   * §1 target signature:
   *   register_provider(cfg, endpoint, gpu_class, attest_pubkey, ctx): ProviderCap
   * As-built M1 signature (mock contract):
   *   register_provider(operator, endpoint, gpu_class, ctx): ProviderCap
   * We target §1; if GIX_ATTEST_MODE=mock we fall back to the M1 arg list so the
   * node can smoke-test against the current localnet deploy.
   */
  async setup(attestPubkeyHex: string): Promise<{ digest: string }> {
    await this.connect();
    const tx = new this.Transaction();

    // 1. Faucet MOCK_USDC for the bond inside the PTB.
    const minted = tx.moveCall({
      target: `${this.pkg}::mock_usdc::mint_and_return`,
      arguments: [tx.object(this.faucetId()), tx.pure.u64(BigInt(this.cfg.bondUsdc))],
    });

    // 2. register_provider — arg list depends on attestMode.
    const endpointBytes = strBytes(this.cfg.publicEndpoint);
    const gpuBytes = strBytes(this.cfg.gpuClass);
    let providerCap: ReturnType<TransactionT["moveCall"]>;
    if (this.attestMode === "signed") {
      // §1: register_provider(cfg, endpoint, gpu_class, attest_pubkey, ctx)
      providerCap = tx.moveCall({
        target: `${this.pkg}::registry::register_provider`,
        arguments: [
          tx.object(this.cfgId),
          tx.pure.vector("u8", endpointBytes),
          tx.pure.vector("u8", gpuBytes),
          tx.pure.vector("u8", Array.from(hexToBytes(attestPubkeyHex))),
        ],
      });
    } else {
      // M1 as-built: register_provider(operator, endpoint, gpu_class, ctx)
      providerCap = tx.moveCall({
        target: `${this.pkg}::registry::register_provider`,
        arguments: [
          tx.pure.address(this.providerAddress),
          tx.pure.vector("u8", endpointBytes),
          tx.pure.vector("u8", gpuBytes),
        ],
      });
    }

    // 3. stake(cap, cfg, bond, capacity_scu, ctx) -> ProviderStake
    const stake = tx.moveCall({
      target: `${this.pkg}::staking::stake`,
      arguments: [
        providerCap,
        tx.object(this.cfgId),
        minted,
        tx.pure.u64(BigInt(this.cfg.capacityScu)),
      ],
    });

    // 4. mint_credits<M>(cap, &mut stake, cfg, &mut market, qty, ctx): Coin<Credit<M>>
    //    OPTIONAL legacy owned-credits path. Default GIX_MINT_SCU=0: skip the up-front
    //    mint entirely so the full staked capacity is free for post_ask (the two-account
    //    order book mints against the same capacity_scu and would abort EInsufficientCapacity
    //    if mint_credits already consumed it). Set GIX_MINT_SCU>0 only for the legacy flow.
    const toTransfer: Array<ReturnType<TransactionT["moveCall"]>> = [providerCap, stake];
    if (this.cfg.mintScu > 0) {
      const credit = tx.moveCall({
        target: `${this.pkg}::staking::mint_credits`,
        typeArguments: [this.market.creditType],
        arguments: [
          providerCap,
          stake,
          tx.object(this.cfgId),
          tx.object(this.market.id),
          tx.pure.u64(BigInt(this.cfg.mintScu)),
        ],
      });
      toTransfer.push(credit);
    }

    tx.transferObjects(toTransfer, tx.pure.address(this.providerAddress));

    const res = await this.exec(tx);
    this.assertOk(res, "setup(register+stake+mint)");
    this.captureSetupObjects(res);
    this.log(
      `[chain] registered provider; cap=${this.providerCapId} stake=${this.stakeId} ` +
        `record=${this.providerRecordId ?? "(n/a in mock mode)"}`,
    );
    return { digest: res.digest };
  }

  // ---- post resting Ask (two-account order book, E3) ---------------------

  /**
   * Publish resting capacity as a shared `Ask<M>` (contracts/README.md §"Shared-Ask order book").
   *
   *   post_ask<M>(cap, &mut stake, cfg, &mut market, qty_scu, price_usdc_per_scu, ctx): ID
   *
   * Mints `qty_scu` Credit<M> against free capacity (minted_scu += qty, gated at
   * capacity_scu), moves them into a NEW shared Ask<M> priced at `price_usdc_per_scu`,
   * emits CreditsMinted + AskPosted, and shares the Ask. We capture the new Ask id from
   * the AskPosted event (the Ask is a shared object, not "created" under our sender for
   * objectChanges-by-owner purposes, so the event is the reliable source).
   *
   * Requires the owned ProviderCap + ProviderStake captured at setup(). Provider-signed.
   * Returns the new shared Ask object id (what the consumer's create_job_from_ask targets).
   */
  async postAsk(qtyScu: number, priceUsdcPerScu: number): Promise<{ askId: string; digest: string }> {
    await this.connect();
    if (!this.providerCapId || !this.stakeId) {
      throw new Error("postAsk: no ProviderCap/ProviderStake captured (call setup() first)");
    }
    const tx = new this.Transaction();
    tx.moveCall({
      target: `${this.pkg}::staking::post_ask`,
      typeArguments: [this.market.creditType],
      arguments: [
        tx.object(this.providerCapId),
        tx.object(this.stakeId),
        tx.object(this.cfgId),
        tx.object(this.market.id),
        tx.pure.u64(BigInt(qtyScu)),
        tx.pure.u64(BigInt(priceUsdcPerScu)),
      ],
    });
    const res = await this.exec(tx);
    this.assertOk(res, "post_ask");

    let askId: string | undefined;
    for (const ev of res.events ?? []) {
      if (ev.type.endsWith("::events::AskPosted")) {
        const f = (ev.parsedJson ?? {}) as Record<string, unknown>;
        askId = (f.ask_id as string) ?? undefined;
      }
    }
    if (!askId) {
      // Fallback: a shared Ask<M> shows up in objectChanges as "created".
      for (const ch of res.objectChanges ?? []) {
        if (ch.type === "created" && ch.objectType.includes("::ask::Ask<")) {
          askId = ch.objectId;
        }
      }
    }
    if (!askId) {
      throw new Error(`post_ask: tx ${res.digest} succeeded but no AskPosted/Ask id found`);
    }
    this.askId = askId;
    return { askId, digest: res.digest };
  }

  /**
   * Read the resting Ask's `remaining_scu` (decrements on each consumer fill). Used by the
   * top-up loop to decide when to re-post. Returns undefined if the Ask object is gone or
   * unreadable. contracts/README.md: `ask::remaining_scu<M>(&Ask<M>): u64`, mirrored as a field on
   * the shared object so we can read it straight off the object content.
   */
  async getAskRemaining(askId: string): Promise<number | undefined> {
    await this.connect();
    try {
      const obj = await this.client.getObject({ id: askId, options: { showContent: true } });
      const content = obj.data?.content;
      if (!content || content.dataType !== "moveObject") return undefined;
      const fields = (content as unknown as { fields: Record<string, unknown> }).fields;
      const v = fields?.remaining_scu;
      if (typeof v === "number") return v;
      if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
      return undefined;
    } catch (e) {
      this.log(`[chain] getAskRemaining(${askId}) error: ${(e as Error).message}`);
      return undefined;
    }
  }

  // ---- M2: mint owned credits (for the DeepBook deposit) -----------------

  /**
   * Mint `qtyScu` Credit<M> against free staked capacity into THIS node's wallet, so the
   * DeepBook maker can deposit them into its BalanceManager. Uses the same accounting as
   * the legacy owned-credits path (minted_scu += qty, gated at capacity_scu; emits
   * CreditsMinted). Distinct from post_ask (which moves credits into a shared gix Ask) —
   * on testnet we sell via DeepBook instead, so we keep the Coin owned and hand it to the
   * BalanceManager. Requires the ProviderCap + ProviderStake captured at setup().
   *
   *   mint_credits<M>(cap, &mut stake, cfg, &mut market, qty, ctx): Coin<Credit<M>>
   */
  async mintCredits(qtyScu: number | bigint): Promise<{ digest: string; creditCoinId?: string }> {
    await this.connect();
    if (!this.providerCapId || !this.stakeId) {
      throw new Error("mintCredits: no ProviderCap/ProviderStake captured (call setup() first)");
    }
    const tx = new this.Transaction();
    const credit = tx.moveCall({
      target: `${this.pkg}::staking::mint_credits`,
      typeArguments: [this.market.creditType],
      arguments: [
        tx.object(this.providerCapId),
        tx.object(this.stakeId),
        tx.object(this.cfgId),
        tx.object(this.market.id),
        tx.pure.u64(BigInt(qtyScu)),
      ],
    });
    tx.transferObjects([credit], tx.pure.address(this.providerAddress));
    const res = await this.exec(tx);
    this.assertOk(res, "mint_credits");
    let creditCoinId: string | undefined;
    for (const ch of res.objectChanges ?? []) {
      if (ch.type === "created" && ch.objectType.includes("::credit::Credit<")) {
        creditCoinId = ch.objectId;
      }
    }
    if (creditCoinId) this.creditCoinId = creditCoinId;
    this.log(`[chain] minted ${qtyScu} SCU Credit -> coin ${creditCoinId ?? "?"} (digest ${res.digest})`);
    return { digest: res.digest, creditCoinId };
  }

  // ---- M2: read a job's kind + Walrus input commitment -------------------

  /**
   * Read the shared Job<M> to determine its kind (escrow vs fill) and its Walrus input
   * blob commitment. Fill-jobs (create_job_from_fill) MUST settle via settle_fill /
   * resolve_fill (the contract rejects the old settle/resolve_attested on them), and the
   * input prompt may need to be fetched from Walrus (input_blob_id != 0) rather than the
   * /inputs cache. Falls back to {isFill:false, inputBlobId:0n} if the read is ambiguous.
   */
  async getJobMeta(jobId: string): Promise<JobMeta> {
    await this.connect();
    try {
      const obj = await this.client.getObject({ id: jobId, options: { showContent: true } });
      const content = obj.data?.content;
      if (!content || content.dataType !== "moveObject") return { isFill: false, inputBlobId: 0n };
      const fields = (content as unknown as { fields: Record<string, unknown> }).fields;
      const isFill = boolOf(fields, "is_fill");
      const inputBlobId = u256Of(fields, "input_blob_id");
      return { isFill, inputBlobId };
    } catch (e) {
      this.log(`[chain] getJobMeta(${jobId}) error: ${(e as Error).message}`);
      return { isFill: false, inputBlobId: 0n };
    }
  }

  // ---- Dispatched subscription (poll, harness-event style) ---------------

  /**
   * Subscribe to Dispatched events for this provider. Sui JSON-RPC subscriptions are
   * being deprecated, so we poll queryEvents on a cursor (works on every fullnode).
   * Returns a stop() handle.
   */
  subscribeDispatched(onJob: (job: DispatchedJob) => void): () => void {
    let stopped = false;
    let cursor: import("@mysten/sui/jsonRpc").EventId | null | undefined = undefined;
    const eventType = `${this.pkg}::events::Dispatched`;

    const tick = async (): Promise<void> => {
      await this.connect();
      try {
        const page = await this.client.queryEvents({
          query: { MoveEventType: eventType },
          cursor: cursor ?? null,
          order: "ascending",
          limit: 50,
        });
        for (const ev of page.data) {
          const f = (ev.parsedJson ?? {}) as Record<string, unknown>;
          const provider = (f.provider as string) ?? "";
          // Only serve jobs dispatched to this provider.
          if (provider && provider !== this.providerAddress) continue;
          onJob({
            jobId: (f.job_id as string) ?? "",
            provider,
            modelId: (f.model_id as string) ?? "",
            inputHash: normHex(f.input_hash),
            execDeadline: numOf(f, "exec_deadline"),
          });
        }
        if (page.nextCursor) cursor = page.nextCursor;
      } catch (e) {
        this.log(`[chain] queryEvents error: ${(e as Error).message}`);
      }
    };

    const loop = async (): Promise<void> => {
      // Anchor the cursor at "now" so we only serve jobs dispatched after start.
      await this.connect();
      try {
        const initial = await this.client.queryEvents({
          query: { MoveEventType: eventType },
          order: "descending",
          limit: 1,
        });
        cursor = initial.data[0]?.id ?? null;
      } catch {
        cursor = null;
      }
      while (!stopped) {
        await tick();
        await sleep(1500);
      }
    };
    void loop();
    return () => {
      stopped = true;
    };
  }

  // ---- attestation submission --------------------------------------------

  /**
   * §1 target:
   *   submit_signed_attestation<M>(job, cfg, market, model, allow, provider_rec,
   *     runtime_measurement, input_hash, output_hash, output_token_count,
   *     t_start, t_end, signature, clk, ctx)
   *
   * The provider must ack (Dispatched → Executing) first (the mock path asserts this;
   * the signed path is expected to do the same). We ack then submit in one PTB.
   */
  async submitSignedAttestation(
    a: SignedAttestationArgs,
  ): Promise<{ digest: string; verdict?: number }> {
    await this.connect();
    const tx = new this.Transaction();

    tx.moveCall({
      target: `${this.pkg}::job::ack`,
      typeArguments: [this.market.creditType],
      arguments: [tx.object(a.jobId), tx.object(this.clockId)],
    });

    if (this.attestMode === "signed") {
      if (!this.providerRecordId) {
        throw new Error(
          "submitSignedAttestation: no ProviderRecord id captured (register first; " +
            "needs the soft-attestation contract that shares a ProviderRecord)",
        );
      }
      // M2: submit_signed_attestation gained output_blob_id + quote_blob_id (u256 Walrus
      // commitments) inserted after `signature`, before `clk`. They are NOT part of the
      // signed canonical message (the byte layout is unchanged), so the signature stays
      // valid. Pass 0 when no Walrus blob applies. Gated by m2Abi: the running localnet M1
      // contract does NOT have these args, so we omit them there (don't break the qwen demo).
      const sigArgs = [
        tx.object(a.jobId),
        tx.object(this.cfgId),
        tx.object(this.market.id),
        tx.object(this.modelRecordId()),
        tx.object(this.allowlistId()),
        tx.object(this.providerRecordId),
        tx.pure.vector("u8", strBytes(a.measurement)),
        tx.pure.vector("u8", Array.from(hexToBytes(a.inputHash))),
        tx.pure.vector("u8", Array.from(hexToBytes(a.outputHash))),
        tx.pure.u64(BigInt(a.outputTokenCount)),
        tx.pure.u64(BigInt(a.tStart)),
        tx.pure.u64(BigInt(a.tEnd)),
        tx.pure.vector("u8", Array.from(a.signature)),
      ];
      if (this.m2Abi) {
        sigArgs.push(tx.pure.u256(a.outputBlobId ?? 0n), tx.pure.u256(a.quoteBlobId ?? 0n));
      }
      sigArgs.push(tx.object(this.clockId));
      tx.moveCall({
        target: `${this.pkg}::attestation::submit_signed_attestation`,
        typeArguments: [this.market.creditType],
        arguments: sigArgs,
      });
    } else {
      // Mock fallback: submit_mock_attestation (no input_hash, no signature, no
      // provider_rec). Proves the localnet serve loop end-to-end against the M1 deploy.
      tx.moveCall({
        target: `${this.pkg}::attestation::submit_mock_attestation`,
        typeArguments: [this.market.creditType],
        arguments: [
          tx.object(a.jobId),
          tx.object(this.cfgId),
          tx.object(this.market.id),
          tx.object(this.modelRecordId()),
          tx.object(this.allowlistId()),
          tx.pure.vector("u8", strBytes(a.measurement)),
          tx.pure.vector("u8", Array.from(hexToBytes(a.outputHash))),
          tx.pure.u64(BigInt(a.outputTokenCount)),
          tx.pure.u64(BigInt(a.tStart)),
          tx.pure.u64(BigInt(a.tEnd)),
          tx.object(this.clockId),
        ],
      });
    }

    const res = await this.exec(tx);
    this.assertOk(res, `submit_${this.attestMode}_attestation`);
    // Capture the recorded verdict from the AttestationSubmitted event so the
    // caller can route settlement (VALID → settle, else resolve_attested).
    let verdict: number | undefined;
    for (const ev of res.events ?? []) {
      if (ev.type.endsWith("::events::AttestationSubmitted")) {
        const f = (ev.parsedJson ?? {}) as Record<string, unknown>;
        verdict = numOf(f, "verdict");
      }
    }
    return { digest: res.digest, verdict };
  }

  /**
   * Settle the job after attestation. The stubbed-match design has no separate settler, so
   * the provider node closes the loop. Branches on the JOB KIND (M2):
   *
   * ESCROW jobs (create_job / create_job_from_ask):
   *   VALID  → settle<M>(job, market, cfg, stake, treasury)         — pay provider + burn
   *   else   → resolve_attested<M>(job, market, cfg, stake, treasury) — refund + slash
   *
   * FILL jobs (create_job_from_fill, M2 / Option B — no escrow; provider paid at the match):
   *   VALID  → settle_fill<M>(job, market, cfg, stake)              — burn credit only (no
   *            treasury arg, no USDC moved)
   *   else   → resolve_fill<M>(job, market, cfg, stake, treasury)    — refund-from-slash
   *
   * The contract REJECTS the old settle/resolve_attested on a fill-job (EWrongJobKind=409),
   * so we read the kind first (or accept it injected to save a read). `isFill` defaults to
   * false (the legacy escrow path) so localnet behaviour is unchanged.
   */
  async settleJob(
    jobId: string,
    verdict: number | undefined,
    isFill = false,
  ): Promise<{ digest: string; fn: string }> {
    await this.connect();
    if (!this.stakeId) {
      throw new Error("settleJob: no ProviderStake id captured (register/stake first)");
    }
    const ok = verdict === 0;
    const tx = new this.Transaction();
    let fn: string;
    if (isFill) {
      // FILL jobs route to settle_fill / resolve_fill.
      fn = ok ? "settle_fill" : "resolve_fill";
      const args = [
        tx.object(jobId),
        tx.object(this.market.id),
        tx.object(this.cfgId),
        tx.object(this.stakeId),
      ];
      // settle_fill has NO treasury arg (no fee leg); resolve_fill does (slash remainder).
      if (!ok) args.push(tx.object(this.treasuryId()));
      tx.moveCall({
        target: `${this.pkg}::settlement::${fn}`,
        typeArguments: [this.market.creditType],
        arguments: args,
      });
    } else {
      // ESCROW jobs route to settle / resolve_attested (both take treasury).
      fn = ok ? "settle" : "resolve_attested";
      tx.moveCall({
        target: `${this.pkg}::settlement::${fn}`,
        typeArguments: [this.market.creditType],
        arguments: [
          tx.object(jobId),
          tx.object(this.market.id),
          tx.object(this.cfgId),
          tx.object(this.stakeId),
          tx.object(this.treasuryId()),
        ],
      });
    }
    const res = await this.exec(tx);
    this.assertOk(res, fn);
    return { digest: res.digest, fn };
  }

  // ---- low-level helpers (harness pattern) -------------------------------

  private async exec(tx: TransactionT) {
    const res = await this.client.signAndExecuteTransaction({
      transaction: tx as unknown as Parameters<
        SuiClientT["signAndExecuteTransaction"]
      >[0]["transaction"],
      signer: this.signer,
      options: { showEffects: true, showEvents: true, showObjectChanges: true },
    });
    await this.client.waitForTransaction({ digest: res.digest });
    return res;
  }

  private assertOk(res: Awaited<ReturnType<NodeChain["exec"]>>, where: string): void {
    const status = res.effects?.status;
    if (status && status.status !== "success") {
      throw new Error(`NodeChain.${where}: tx ${res.digest} failed: ${status.error ?? "unknown"}`);
    }
  }

  private captureSetupObjects(res: Awaited<ReturnType<NodeChain["exec"]>>): void {
    for (const ch of res.objectChanges ?? []) {
      if (ch.type !== "created") continue;
      const t = ch.objectType;
      if (t.includes("::registry::ProviderCap")) this.providerCapId = ch.objectId;
      else if (t.includes("::registry::ProviderRecord")) this.providerRecordId = ch.objectId;
      else if (t.includes("::staking::ProviderStake")) this.stakeId = ch.objectId;
      else if (t.includes("::credit::Credit<")) this.creditCoinId = ch.objectId;
    }
    // A ProviderRecord may be a SHARED object (not "created" under our sender). If we
    // didn't see it, try to locate it from the ProviderRegistered event's id.
    if (!this.providerRecordId && this.attestMode === "signed") {
      for (const ev of res.events ?? []) {
        if (ev.type.endsWith("::events::ProviderRegistered")) {
          const f = (ev.parsedJson ?? {}) as Record<string, unknown>;
          const id = f.provider_id as string | undefined;
          if (id) this.providerRecordId = id;
        }
      }
    }
  }

  private extra(key: string, label: string): string {
    const v = (this.cfg.deployment as unknown as Record<string, unknown>)[key];
    if (typeof v === "string" && v) return v;
    throw new Error(`NodeChain: deployment.json missing "${key}" (${label})`);
  }
  private faucetId(): string {
    return this.extra("faucetId", "mock_usdc::Faucet");
  }
  private allowlistId(): string {
    return this.extra("allowlistId", "registry::MeasurementAllowlist");
  }
  private treasuryId(): string {
    return this.extra("treasuryId", "settlement::Treasury");
  }
  private modelRecordId(): string {
    if (this.market.modelId) return this.market.modelId;
    return this.extra("modelRecordId", "registry::ModelRecord");
  }

  /** The provider's tx (payout/slash) address — also the Ask/Job `provider`. */
  get provider(): string {
    return this.providerAddress;
  }

  /** Exposed for diagnostics/integration. */
  get ids() {
    return {
      providerCapId: this.providerCapId,
      providerRecordId: this.providerRecordId,
      stakeId: this.stakeId,
      creditCoinId: this.creditCoinId,
      askId: this.askId,
    };
  }
}

// --- pure helpers (mirrors harness/src/chain/sui.ts) ----------------------

function strBytes(s: string): number[] {
  return Array.from(Buffer.from(s, "utf8"));
}

function normHex(v: unknown): string {
  if (Array.isArray(v)) {
    // input_hash often comes back as a number[] (vector<u8>).
    return "0x" + Buffer.from(v as number[]).toString("hex");
  }
  if (typeof v === "string") return v.startsWith("0x") ? v : "0x" + v;
  return "";
}

function numOf(f: Record<string, unknown>, k: string): number {
  const v = f[k];
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return 0;
}

function boolOf(f: Record<string, unknown>, k: string): boolean {
  const v = f[k];
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v === "true";
  return false;
}

/** Read a u256 move field (returned by RPC as a decimal string) as a bigint. 0n if absent. */
function u256Of(f: Record<string, unknown>, k: string): bigint {
  const v = f[k];
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  return 0n;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
