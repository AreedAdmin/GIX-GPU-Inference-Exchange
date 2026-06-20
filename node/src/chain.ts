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
 *   contracts/INTERFACE.md still has register_provider(operator, endpoint,
 *   gpu_class, ctx) and submit_mock_attestation only. So this module:
 *     • targets the §1 signed-attestation entrypoints by default, AND
 *     • is feature-flagged (GIX_ATTEST_MODE=signed|mock) so the node runs against
 *       either the redeployed soft-attestation contract OR the current M1 mock
 *       contract for a localnet smoke test.
 *   Arg orders for the signed path follow demo §1 verbatim; reconcile to the final
 *   INTERFACE.md once D1 publishes.
 */

import type { Keypair } from "@mysten/sui/cryptography";
import type { NodeConfig, MarketDeployment } from "./config.js";
import { marketOf } from "./config.js";
import { hexToBytes } from "./attest/canonical.js";

type SuiClientT = import("@mysten/sui/client").SuiClient;
type TransactionT = import("@mysten/sui/transactions").Transaction;

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
  }

  // ---- connection (lazy, harness pattern) -------------------------------

  private async connect(): Promise<void> {
    if (this.connected) return;
    const { SuiClient, getFullnodeUrl } = await import("@mysten/sui/client");
    const { Transaction } = await import("@mysten/sui/transactions");
    this.client = new SuiClient({ url: this.cfg.rpcUrl ?? getFullnodeUrl("localnet") });
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
   * Publish resting capacity as a shared `Ask<M>` (INTERFACE.md §"Shared-Ask order book").
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
   * unreadable. INTERFACE.md: `ask::remaining_scu<M>(&Ask<M>): u64`, mirrored as a field on
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

  // ---- Dispatched subscription (poll, harness-event style) ---------------

  /**
   * Subscribe to Dispatched events for this provider. Sui JSON-RPC subscriptions are
   * being deprecated, so we poll queryEvents on a cursor (works on every fullnode).
   * Returns a stop() handle.
   */
  subscribeDispatched(onJob: (job: DispatchedJob) => void): () => void {
    let stopped = false;
    let cursor: import("@mysten/sui/client").EventId | null | undefined = undefined;
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
      tx.moveCall({
        target: `${this.pkg}::attestation::submit_signed_attestation`,
        typeArguments: [this.market.creditType],
        arguments: [
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
          tx.object(this.clockId),
        ],
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
   * Settle the job after attestation. The stubbed-match design has no separate
   * settler, so the provider node closes the loop: a VALID verdict advances the
   * Job to Verified → `settle<M>` pays the provider + burns credits; any other
   * verdict leaves it Attested → `resolve_attested<M>` refunds (+ slash). Both
   * require the provider's &mut ProviderStake and the shared Treasury.
   *   settle<M>(job, market, cfg, stake, treasury, ctx)
   *   resolve_attested<M>(job, market, cfg, stake, treasury, ctx)
   */
  async settleJob(jobId: string, verdict: number | undefined): Promise<{ digest: string; fn: string }> {
    await this.connect();
    if (!this.stakeId) {
      throw new Error("settleJob: no ProviderStake id captured (register/stake first)");
    }
    const fn = verdict === 0 ? "settle" : "resolve_attested";
    const tx = new this.Transaction();
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
