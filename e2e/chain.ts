/**
 * E2eChain — the live on-chain driver for the pool-free acceptance harness.
 *
 * Drives the FULL pool-free flow against a network via PTBs, mirroring the EXACT call shapes
 * the production `node/src/chain.ts` and `sdk/src/chain.ts` use (so this validates the same
 * ABI the shipped code targets — it does not invent a parallel one):
 *
 *   provider:  register_provider(cfg, endpoint, gpu_class, attest_pubkey) → ProviderCap
 *              stake(cap, cfg, bond, capacity)                            → ProviderStake
 *              post_ask<M>(cap, &mut stake, cfg, &mut market, qty, price) → Ask<M>
 *   consumer:  create_job_from_ask<M>(cfg, &market, &mut ask, qty, escrow, input_hash, clk) → Job
 *   provider:  ack<M>(job, clk)
 *              submit_signed_attestation<M>(...)        (ABI auto-detected: M1 15-arg / M2 17-arg)
 *              settle<M> | resolve_attested<M> | expire_and_resolve<M>
 *
 * KEY DESIGN CHOICES (so we never disturb the running localnet qwen demo / testnet wallet):
 *   - Keypairs are GENERATED in-process (Ed25519Keypair) and funded from the LOCALNET FAUCET
 *     HTTP (getFaucetHost('localnet')); we NEVER touch `sui client` global state or its active
 *     env/address. The provider/consumer are fresh wallets each run.
 *   - We LOCATE the deployed package from deployment.json by default (no test-publish, no race
 *     with the running node). The package, market, model, allowlist + faucet are reused.
 *   - The signed-attestation ABI shape is detected at runtime from the package's normalized
 *     Move function arity (15 params = M1 / 17 params = M2 with the u256 blob ids), so the same
 *     harness drives either deploy.
 *
 * All @mysten/sui imports are lazy (dynamic import) so building/typechecking and the hermetic
 * vitest units never require the SDK at module load.
 */

import type { Keypair } from "@mysten/sui/cryptography";
import type { Deployment } from "../sdk/src/types.js";

type SuiClientT = import("@mysten/sui/jsonRpc").SuiJsonRpcClient;
type TransactionT = import("@mysten/sui/transactions").Transaction;

/** One funded actor wallet (generated in-process). */
export interface Actor {
  keypair: Keypair;
  address: string;
}

export interface E2eChainOptions {
  deployment: Deployment;
  network: "localnet" | "testnet";
  rpcUrl?: string;
  log?: (m: string) => void;
}

/** The market entry the harness drives (the first market by default). */
function firstMarket(d: Deployment) {
  const m = d.markets[0];
  if (!m) throw new Error("deployment has no markets");
  return m;
}

export class E2eChain {
  private client!: SuiClientT;
  private Transaction!: new () => TransactionT;
  private faucetHost?: string;
  private requestFaucet!: (args: { host: string; recipient: string }) => Promise<unknown>;
  private Ed25519!: { generate(): Keypair };
  private connected = false;
  /** signed-attestation param count detected from the package ABI (15=M1, 17=M2). */
  private signedAttestParams?: number;
  /** create_job_from_ask param count detected from the package ABI (8=pre-inline, 9=inline Option 3). */
  private createJobFromAskParams?: number;
  /**
   * Whether the deployed package parameterises the quote coin `Q` as a generic across the
   * staking/job/settlement/attestation ABIs (detected from `staking::stake`'s type-parameter
   * count): newer deploys are `stake<Q>` / `post_ask<M,Q>` / `Job<M,Q>` / `settle<M,Q>` etc.,
   * whereas older deploys hardcoded the quote coin (`stake` with no type params, `post_ask<M>`).
   * When true the harness appends `usdcType` (the Q) to each generic call's type arguments;
   * when false it drives the single-`M` shape. This keeps ONE harness driving both deploys.
   */
  private quoteGeneric?: boolean;

  readonly pkg: string;
  readonly cfgId: string;
  readonly usdcType: string;
  readonly clockId: string;
  readonly market: ReturnType<typeof firstMarket>;

  constructor(private readonly opts: E2eChainOptions) {
    this.pkg = opts.deployment.packageId;
    this.cfgId = opts.deployment.configId;
    this.usdcType = opts.deployment.usdcType;
    this.clockId = opts.deployment.clockId;
    this.market = firstMarket(opts.deployment);
  }

  private log(m: string) {
    this.opts.log?.(m);
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    const { SuiJsonRpcClient, getJsonRpcFullnodeUrl } = await import("@mysten/sui/jsonRpc");
    const { Transaction } = await import("@mysten/sui/transactions");
    const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
    const url = this.opts.rpcUrl ?? getJsonRpcFullnodeUrl(this.opts.network);
    this.client = new SuiJsonRpcClient({ network: this.opts.network, url });
    this.Transaction = Transaction as unknown as new () => TransactionT;
    this.Ed25519 = Ed25519Keypair as unknown as { generate(): Keypair };
    if (this.opts.network === "localnet") {
      const { getFaucetHost, requestSuiFromFaucetV2 } = await import("@mysten/sui/faucet");
      this.faucetHost = getFaucetHost("localnet");
      this.requestFaucet = requestSuiFromFaucetV2 as unknown as typeof this.requestFaucet;
    }
    this.connected = true;
  }

  get suiClient(): SuiClientT {
    return this.client;
  }

  /** Generate a fresh wallet and fund it with gas from the localnet faucet (localnet only). */
  async newFundedActor(label: string): Promise<Actor> {
    await this.connect();
    const keypair = this.Ed25519.generate();
    const address = keypair.toSuiAddress();
    if (this.opts.network === "localnet") {
      if (!this.faucetHost) throw new Error("localnet faucet host unresolved");
      await this.requestFaucet({ host: this.faucetHost, recipient: address });
      await this.waitForGas(address);
    } else {
      throw new Error(
        "newFundedActor: testnet actors must be pre-funded keypairs (faucet auto-funding is localnet-only)",
      );
    }
    this.log(`[chain] funded ${label} = ${address}`);
    return { keypair, address };
  }

  private async waitForGas(address: string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const bal = await this.client.getBalance({ owner: address });
      if (BigInt(bal.totalBalance) > 0n) return;
      await sleep(500);
    }
    throw new Error(`waitForGas: ${address} never received gas within ${timeoutMs}ms`);
  }

  // ---- balances / reads --------------------------------------------------

  async usdc(address: string): Promise<bigint> {
    await this.connect();
    const bal = await this.client.getBalance({ owner: address, coinType: this.usdcType });
    return BigInt(bal.totalBalance);
  }

  async treasuryUsdc(): Promise<bigint> {
    await this.connect();
    const id = this.idField("treasuryId");
    const obj = await this.client.getObject({ id, options: { showContent: true } });
    const f = moveFields(obj);
    return readBalanceValue(f?.funds);
  }

  /** Read the bits of provider stake the invariants need. */
  async stakeView(stakeId: string): Promise<{ bond: bigint; slashedTotal: bigint; minted: bigint; reserved: bigint }> {
    await this.connect();
    const obj = await this.client.getObject({ id: stakeId, options: { showContent: true } });
    const f = moveFields(obj);
    return {
      bond: readBalanceValue(f?.bond),
      slashedTotal: bigOf(f?.slashed_total),
      minted: bigOf(f?.minted_scu),
      reserved: bigOf(f?.reserved_scu),
    };
  }

  /** Read a Job's state + escrow value + slashed flag + hashes + blob ids + inline input + attestation. */
  async jobView(jobId: string): Promise<{
    state: number;
    escrow: bigint;
    slashed: boolean;
    inputHash: string;
    outputHash: string;
    inputBlobId: bigint;
    outputBlobId: bigint;
    /** The on-chain inline `job.input` bytes (Option 3). Empty when the Walrus-blob path is used
     * OR the deployed package predates the inline ABI (no `input` field). */
    input: Uint8Array;
    isFill: boolean;
    verdict?: number;
  }> {
    await this.connect();
    const obj = await this.client.getObject({ id: jobId, options: { showContent: true } });
    const f = moveFields(obj);
    // escrow is Option<Escrow<Q>>; rendered as { fields: { vec: [ { fields: { funds: {fields:{value}} } } ] } }
    const escrow = readOptionEscrow(f?.escrow);
    const att = f?.attestation as { fields?: { vec?: Array<{ fields?: Record<string, unknown> }> } } | undefined;
    const attRec = att?.fields?.vec?.[0]?.fields;
    return {
      state: Number(f?.state ?? 0),
      escrow,
      slashed: boolOf(f?.slashed),
      inputHash: hexOfVec(f?.input_hash),
      outputHash: hexOfVec(f?.output_hash),
      inputBlobId: bigOf(f?.input_blob_id),
      outputBlobId: bigOf(f?.output_blob_id),
      input: bytesOfVec(f?.input),
      isFill: boolOf(f?.is_fill),
      verdict: attRec ? Number(attRec.verdict ?? 0) : undefined,
    };
  }

  /** The registered model_hash (ModelRecord.model_hash), lowercase hex. */
  async modelHash(): Promise<string> {
    await this.connect();
    const id = this.market.modelId ?? this.idField("modelRecordId");
    const obj = await this.client.getObject({ id, options: { showContent: true } });
    const f = moveFields(obj);
    return hexOfVec(f?.model_hash);
  }

  // ---- provider: register → stake → post_ask -----------------------------

  /**
   * register_provider + stake in ONE PTB (mirrors node setup), funding the bond from the
   * mock_usdc faucet inside the same PTB. Captures ProviderCap / ProviderRecord / ProviderStake.
   */
  async registerAndStake(
    provider: Actor,
    args: { attestPubkeyHex: string; bondUsdc: number; capacityScu: number; endpoint?: string; gpuClass?: string },
  ): Promise<{ capId: string; recordId: string; stakeId: string }> {
    await this.connect();
    const tx = new this.Transaction();
    const minted = tx.moveCall({
      target: `${this.pkg}::mock_usdc::mint_and_return`,
      arguments: [tx.object(this.idField("faucetId")), tx.pure.u64(BigInt(args.bondUsdc))],
    });
    const cap = tx.moveCall({
      target: `${this.pkg}::registry::register_provider`,
      arguments: [
        tx.object(this.cfgId),
        tx.pure.vector("u8", strBytes(args.endpoint ?? "http://127.0.0.1:8080")),
        tx.pure.vector("u8", strBytes(args.gpuClass ?? "GB10-mock")),
        tx.pure.vector("u8", Array.from(hexToBytes(args.attestPubkeyHex))),
      ],
    });
    const stake = tx.moveCall({
      target: `${this.pkg}::staking::stake`,
      // stake<Q>: append the quote coin (Q=MOCK_USDC) on the generic-Q ABI; omit on the older ABI.
      typeArguments: (await this.detectQuoteGeneric()) ? [this.usdcType] : [],
      arguments: [cap, tx.object(this.cfgId), minted, tx.pure.u64(BigInt(args.capacityScu))],
    });
    tx.transferObjects([cap, stake], tx.pure.address(provider.address));

    const res = await this.exec(tx, provider.keypair);
    this.assertOk(res, "register+stake");
    let capId: string | undefined, recordId: string | undefined, stakeId: string | undefined;
    for (const ch of objChanges(res)) {
      if (ch.type !== "created") continue;
      const t = ch.objectType ?? "";
      if (t.includes("::registry::ProviderCap")) capId = ch.objectId;
      else if (t.includes("::registry::ProviderRecord")) recordId = ch.objectId;
      else if (t.includes("::staking::ProviderStake")) stakeId = ch.objectId;
    }
    // ProviderRecord is shared; if not in objectChanges, read the ProviderRegistered event.
    if (!recordId) {
      for (const ev of res.events ?? []) {
        if (ev.type.endsWith("::events::ProviderRegistered")) {
          const f = (ev.parsedJson ?? {}) as Record<string, unknown>;
          recordId = (f.provider_id as string) ?? recordId;
        }
      }
    }
    if (!capId || !stakeId) throw new Error(`register+stake: missing cap/stake (cap=${capId} stake=${stakeId})`);
    if (!recordId) throw new Error("register+stake: could not resolve ProviderRecord id");
    this.log(`[chain] provider registered cap=${capId} record=${recordId} stake=${stakeId}`);
    return { capId, recordId, stakeId };
  }

  /** post_ask<M>(cap, &mut stake, cfg, &mut market, qty, price) → shared Ask<M>. */
  async postAsk(
    provider: Actor,
    ids: { capId: string; stakeId: string },
    qtyScu: number,
    pricePerScu: number,
  ): Promise<{ askId: string }> {
    await this.connect();
    const tx = new this.Transaction();
    tx.moveCall({
      target: `${this.pkg}::staking::post_ask`,
      typeArguments: await this.typeArgsMQ(),
      arguments: [
        tx.object(ids.capId),
        tx.object(ids.stakeId),
        tx.object(this.cfgId),
        tx.object(this.market.id),
        tx.pure.u64(BigInt(qtyScu)),
        tx.pure.u64(BigInt(pricePerScu)),
      ],
    });
    const res = await this.exec(tx, provider.keypair);
    this.assertOk(res, "post_ask");
    let askId: string | undefined;
    for (const ev of res.events ?? []) {
      if (ev.type.endsWith("::events::AskPosted")) {
        askId = ((ev.parsedJson ?? {}) as Record<string, unknown>).ask_id as string;
      }
    }
    if (!askId) {
      for (const ch of objChanges(res)) {
        if (ch.type === "created" && (ch.objectType ?? "").includes("::ask::Ask<")) askId = ch.objectId;
      }
    }
    if (!askId) throw new Error(`post_ask: no Ask id (digest ${res.digest})`);
    this.log(`[chain] ask posted ${askId} (${qtyScu} SCU @ ${pricePerScu})`);
    return { askId };
  }

  // ---- consumer: faucet USDC + create_job_from_ask -----------------------

  /** Faucet `amount` MOCK_USDC to the consumer wallet (mock_usdc::mint). */
  async faucetUsdc(consumer: Actor, amount: number): Promise<void> {
    await this.connect();
    const tx = new this.Transaction();
    tx.moveCall({
      target: `${this.pkg}::mock_usdc::mint`,
      arguments: [tx.object(this.idField("faucetId")), tx.pure.u64(BigInt(amount)), tx.pure.address(consumer.address)],
    });
    const res = await this.exec(tx, consumer.keypair);
    this.assertOk(res, "faucet usdc");
  }

  /**
   * Detect the create_job_from_ask ABI arity once. Two shapes exist across deploys:
   *   - pre-inline (8 params): (cfg, market, ask, qty, escrow_in, input_hash, clk, ctx)
   *   - inline / Option 3 (9 params): (cfg, market, ask, qty, escrow_in, INPUT, input_hash, clk, ctx)
   * The inline ABI carries the raw prompt bytes on-chain so the tunnel-free path needs no `/inputs`
   * HTTP and no Walrus input blob (input_blob_id is fixed to 0 internally on this path).
   */
  private async detectCreateJobFromAskParams(): Promise<number> {
    if (this.createJobFromAskParams !== undefined) return this.createJobFromAskParams;
    const fn = await this.client.getNormalizedMoveFunction({
      package: this.pkg,
      module: "job",
      function: "create_job_from_ask",
    });
    this.createJobFromAskParams = fn.parameters.length;
    this.log(
      `[chain] create_job_from_ask ABI: ${this.createJobFromAskParams} params ` +
        `(${this.createJobFromAskParams >= 9 ? "inline/Option3" : "pre-inline"})`,
    );
    return this.createJobFromAskParams;
  }

  /** Whether the located package exposes the inline-input (Option 3) create_job_from_ask ABI. */
  async supportsInlineInput(): Promise<boolean> {
    await this.connect();
    return (await this.detectCreateJobFromAskParams()) >= 9;
  }

  /**
   * Detect once whether the package parameterises the quote coin `Q` (newer `stake<Q>` ABI) or
   * hardcodes it (older `stake` with no type params). Signalled by `staking::stake`'s type-param
   * count: 1 ⇒ generic-Q, 0 ⇒ hardcoded.
   */
  private async detectQuoteGeneric(): Promise<boolean> {
    if (this.quoteGeneric !== undefined) return this.quoteGeneric;
    const fn = await this.client.getNormalizedMoveFunction({
      package: this.pkg,
      module: "staking",
      function: "stake",
    });
    this.quoteGeneric = fn.typeParameters.length >= 1;
    this.log(
      `[chain] quote-coin ABI: ${this.quoteGeneric ? "generic Q (stake<Q>, *<M,Q>)" : "hardcoded Q (stake, *<M>)"}`,
    );
    return this.quoteGeneric;
  }

  /**
   * Type arguments for a generic `<M, Q>` market call. On the generic-Q ABI this is
   * `[creditType, usdcType]`; on the older hardcoded-Q ABI it is `[creditType]` (single `M`).
   * Detected from the deployed package so one harness drives both deploys.
   */
  private async typeArgsMQ(): Promise<string[]> {
    return (await this.detectQuoteGeneric()) ? [this.market.creditType, this.usdcType] : [this.market.creditType];
  }

  /**
   * create_job_from_ask<M>(cfg, &market, &mut ask, qty, escrow_in, [input,] input_hash, clk) → Job.
   * Splits the exact escrow coin out of the consumer's MOCK_USDC inside the PTB. Adapts to the
   * detected ABI: when the inline ABI is present, `input` (raw prompt bytes) is passed immediately
   * before `input_hash` (and the contract pins `input_blob_id = 0` internally); when absent, the
   * pre-inline shape is used so existing localnet deploys keep working.
   *
   * Pass `input` to drive the tunnel-free inline path; omit it for the legacy Walrus/`/inputs` path.
   */
  async createJobFromAsk(
    consumer: Actor,
    args: { askId: string; qtyScu: number; escrowUsdc: number; inputHashHex: string; input?: Uint8Array },
  ): Promise<{ jobId: string }> {
    await this.connect();
    const inline = (await this.detectCreateJobFromAskParams()) >= 9;
    if (args.input && !inline) {
      throw new Error(
        "createJobFromAsk: inline input requested but the located package predates the inline ABI " +
          "(create_job_from_ask has no `input` param). Redeploy the inline-input contracts (Option 3) first.",
      );
    }
    const tx = new this.Transaction();
    const escrowCoin = await this.splitExactUsdc(tx, consumer.address, BigInt(args.escrowUsdc));
    const moveArgs: unknown[] = [
      tx.object(this.cfgId),
      tx.object(this.market.id),
      tx.object(args.askId),
      tx.pure.u64(BigInt(args.qtyScu)),
      escrowCoin,
    ];
    if (inline) {
      // input_blob_id is fixed to 0 by the contract on the inline path (§A): the prompt rides in `input`.
      moveArgs.push(tx.pure.vector("u8", Array.from(args.input ?? new Uint8Array())));
    }
    moveArgs.push(tx.pure.vector("u8", Array.from(hexToBytes(args.inputHashHex))));
    moveArgs.push(tx.object(this.clockId));
    tx.moveCall({
      target: `${this.pkg}::job::create_job_from_ask`,
      typeArguments: await this.typeArgsMQ(),
      arguments: moveArgs as never[],
    });
    const res = await this.exec(tx, consumer.keypair);
    this.assertOk(res, "create_job_from_ask");
    let jobId: string | undefined;
    for (const ch of objChanges(res)) {
      if (ch.type === "created" && (ch.objectType ?? "").includes("::job::Job<")) jobId = ch.objectId;
    }
    if (!jobId) {
      for (const ev of res.events ?? []) {
        if (ev.type.endsWith("::events::JobCreated")) jobId = ((ev.parsedJson ?? {}) as Record<string, unknown>).job_id as string;
      }
    }
    if (!jobId) throw new Error(`create_job_from_ask: no Job id (digest ${res.digest})`);
    this.log(`[chain] job created ${jobId}`);
    return { jobId };
  }

  // ---- provider: ack + signed attestation + settle -----------------------

  async ack(provider: Actor, jobId: string): Promise<void> {
    await this.connect();
    const tx = new this.Transaction();
    tx.moveCall({
      target: `${this.pkg}::job::ack`,
      typeArguments: await this.typeArgsMQ(),
      arguments: [tx.object(jobId), tx.object(this.clockId)],
    });
    const res = await this.exec(tx, provider.keypair);
    this.assertOk(res, "ack");
  }

  /** Detect the signed-attestation ABI arity once (15 = M1, 17 = M2 with u256 blob ids). */
  private async detectSignedAttestParams(): Promise<number> {
    if (this.signedAttestParams !== undefined) return this.signedAttestParams;
    const fn = await this.client.getNormalizedMoveFunction({
      package: this.pkg,
      module: "attestation",
      function: "submit_signed_attestation",
    });
    this.signedAttestParams = fn.parameters.length;
    this.log(`[chain] submit_signed_attestation ABI: ${this.signedAttestParams} params (${this.signedAttestParams >= 17 ? "M2" : "M1"})`);
    return this.signedAttestParams;
  }

  /**
   * submit_signed_attestation<M>(...) with the real Ed25519 signature the mock node produced.
   * Adapts to the detected ABI: M1 (15 params, no blob ids) vs M2 (17 params, +output_blob_id,
   * +quote_blob_id as u256). The signature/canonical-message bytes are IDENTICAL either way
   * (the blob ids are NOT part of the signed message), so the same served job works on both.
   */
  async submitSignedAttestation(
    provider: Actor,
    a: {
      jobId: string;
      providerRecordId: string;
      measurement: string;
      inputHashHex: string;
      outputHashHex: string;
      outputTokenCount: number;
      tStart: number;
      tEnd: number;
      signature: Uint8Array;
      outputBlobId?: bigint;
      quoteBlobId?: bigint;
    },
  ): Promise<{ verdict?: number }> {
    await this.connect();
    const nParams = await this.detectSignedAttestParams();
    const m2 = nParams >= 17;
    const tx = new this.Transaction();
    const sigArgs: ReturnType<TransactionT["pure"]["u64"]>[] | unknown[] = [
      tx.object(a.jobId),
      tx.object(this.cfgId),
      tx.object(this.market.id),
      tx.object(this.market.modelId ?? this.idField("modelRecordId")),
      tx.object(this.idField("allowlistId")),
      tx.object(a.providerRecordId),
      tx.pure.vector("u8", strBytes(a.measurement)),
      tx.pure.vector("u8", Array.from(hexToBytes(a.inputHashHex))),
      tx.pure.vector("u8", Array.from(hexToBytes(a.outputHashHex))),
      tx.pure.u64(BigInt(a.outputTokenCount)),
      tx.pure.u64(BigInt(a.tStart)),
      tx.pure.u64(BigInt(a.tEnd)),
      tx.pure.vector("u8", Array.from(a.signature)),
    ];
    if (m2) {
      sigArgs.push(tx.pure.u256(a.outputBlobId ?? 0n));
      sigArgs.push(tx.pure.u256(a.quoteBlobId ?? 0n));
    }
    sigArgs.push(tx.object(this.clockId));
    tx.moveCall({
      target: `${this.pkg}::attestation::submit_signed_attestation`,
      typeArguments: await this.typeArgsMQ(),
      arguments: sigArgs as never[],
    });
    const res = await this.exec(tx, provider.keypair);
    this.assertOk(res, "submit_signed_attestation");
    let verdict: number | undefined;
    for (const ev of res.events ?? []) {
      if (ev.type.endsWith("::events::AttestationSubmitted")) {
        verdict = numOf((ev.parsedJson ?? {}) as Record<string, unknown>, "verdict");
      }
    }
    return { verdict };
  }

  /** settle<M> (VALID) or resolve_attested<M> (faulty verdict) — the ESCROW (Ask) paths. */
  async settle(provider: Actor, jobId: string, stakeId: string, verdict: number | undefined): Promise<{ fn: string }> {
    await this.connect();
    const ok = verdict === 0;
    const fn = ok ? "settle" : "resolve_attested";
    const tx = new this.Transaction();
    tx.moveCall({
      target: `${this.pkg}::settlement::${fn}`,
      typeArguments: await this.typeArgsMQ(),
      arguments: [
        tx.object(jobId),
        tx.object(this.market.id),
        tx.object(this.cfgId),
        tx.object(stakeId),
        tx.object(this.idField("treasuryId")),
      ],
    });
    const res = await this.exec(tx, provider.keypair);
    this.assertOk(res, fn);
    return { fn };
  }

  /** expire_and_resolve<M>: a deadline lapsed with no valid attestation → refund (+slash). */
  async expireAndResolve(caller: Actor, jobId: string, stakeId: string): Promise<{ fn: string }> {
    await this.connect();
    const tx = new this.Transaction();
    tx.moveCall({
      target: `${this.pkg}::settlement::expire_and_resolve`,
      typeArguments: await this.typeArgsMQ(),
      arguments: [
        tx.object(jobId),
        tx.object(this.market.id),
        tx.object(this.cfgId),
        tx.object(stakeId),
        tx.object(this.idField("treasuryId")),
        tx.object(this.clockId),
      ],
    });
    const res = await this.exec(tx, caller.keypair);
    this.assertOk(res, "expire_and_resolve");
    return { fn: "expire_and_resolve" };
  }

  // ---- low-level ---------------------------------------------------------

  private async splitExactUsdc(tx: TransactionT, owner: string, amount: bigint) {
    const { data } = await this.client.getCoins({ owner, coinType: this.usdcType });
    if (data.length === 0) throw new Error(`splitExactUsdc: ${owner} holds no ${this.usdcType}`);
    const primary = tx.object(data[0]!.coinObjectId);
    if (data.length > 1) tx.mergeCoins(primary, data.slice(1).map((c) => tx.object(c.coinObjectId)));
    const [coin] = tx.splitCoins(primary, [tx.pure.u64(amount)]);
    return coin;
  }

  private async exec(tx: TransactionT, signer: Keypair) {
    const res = await this.client.signAndExecuteTransaction({
      transaction: tx as unknown as Parameters<SuiClientT["signAndExecuteTransaction"]>[0]["transaction"],
      signer,
      options: { showEffects: true, showEvents: true, showObjectChanges: true },
    });
    await this.client.waitForTransaction({ digest: res.digest });
    return res;
  }

  private assertOk(res: Awaited<ReturnType<E2eChain["exec"]>>, where: string): void {
    const status = res.effects?.status;
    if (status && status.status !== "success") {
      throw new Error(`E2eChain.${where}: tx ${res.digest} failed: ${status.error ?? "unknown"}`);
    }
  }

  /** A required object id from deployment.json (faucet/treasury/allowlist/model). */
  private idField(key: string): string {
    const v = (this.opts.deployment as unknown as Record<string, unknown>)[key];
    if (typeof v === "string" && v) return v;
    throw new Error(`deployment.json missing "${key}"`);
  }
}

// --- pure helpers ----------------------------------------------------------

function strBytes(s: string): number[] {
  return Array.from(Buffer.from(s, "utf8"));
}
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function objChanges(res: { objectChanges?: unknown[] | null }): Array<{ type?: string; objectType?: string; objectId?: string }> {
  return (res.objectChanges ?? []) as Array<{ type?: string; objectType?: string; objectId?: string }>;
}
function moveFields(obj: { data?: { content?: unknown } | null }): Record<string, unknown> | undefined {
  const content = obj.data?.content as { dataType?: string; fields?: Record<string, unknown> } | undefined;
  if (!content || content.dataType !== "moveObject") return undefined;
  return content.fields;
}
function bigOf(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  return 0n;
}
function boolOf(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v === "true";
  return false;
}
function numOf(f: Record<string, unknown>, k: string): number {
  const v = f[k];
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return 0;
}
function hexOfVec(v: unknown): string {
  if (Array.isArray(v)) return v.map((b) => Number(b).toString(16).padStart(2, "0")).join("");
  if (typeof v === "string") return v.startsWith("0x") ? v.slice(2) : v;
  return "";
}
/** Read a Move `vector<u8>` as rendered by the JSON-RPC: a `number[]`, a base64/hex string, or
 * absent (older package with no such field) → empty bytes. Used for the inline `job.input`. */
function bytesOfVec(v: unknown): Uint8Array {
  if (v === null || v === undefined) return new Uint8Array();
  if (Array.isArray(v)) return Uint8Array.from(v.map((b) => Number(b) & 0xff));
  if (v instanceof Uint8Array) return v;
  if (typeof v === "string") {
    const s = v.startsWith("0x") || v.startsWith("0X") ? v.slice(2) : v;
    // Hex if it's an even-length all-hex string; otherwise treat as base64 (sui-json default).
    if (s.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(s)) {
      const out = new Uint8Array(s.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
      return out;
    }
    return Uint8Array.from(Buffer.from(v, "base64"));
  }
  return new Uint8Array();
}
/**
 * Read Option<Escrow<Q>> → the locked balance value (0n when none/empty).
 *
 * The JSON-RPC renders `Option<Escrow<Q>>` as the inner `Escrow` struct directly (NOT a
 * `{ vec: [...] }` wrapper) when `some`, and as `null` / absent when `none`. The `Escrow`
 * struct flattens its `Balance<Q> funds` to a plain decimal string and also exposes
 * `funded_amount: u64` (the authoritative live value, kept in lockstep with `funds`).
 */
function readOptionEscrow(v: unknown): bigint {
  if (v === null || v === undefined) return 0n;
  const esc = (v as { fields?: Record<string, unknown> }).fields ?? (v as Record<string, unknown>);
  if (!esc || typeof esc !== "object") return 0n;
  const rec = esc as Record<string, unknown>;
  // Prefer funded_amount (clean u64); fall back to the funds balance (string or {fields:{value}}).
  if (rec.funded_amount !== undefined) return bigOf(rec.funded_amount);
  return readBalanceValue(rec.funds);
}

/** Read a Move `Balance<Q>` as rendered by the JSON-RPC: a plain decimal string, OR a
 * `{ fields: { value } }` object, OR a direct `{ value }`. Returns 0n if unreadable. */
function readBalanceValue(v: unknown): bigint {
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "object" && v !== null) {
    const o = v as { fields?: { value?: unknown }; value?: unknown };
    if (o.fields?.value !== undefined) return bigOf(o.fields.value);
    if (o.value !== undefined) return bigOf(o.value);
  }
  return 0n;
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
