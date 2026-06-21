#!/usr/bin/env -S npx tsx
/**
 * GIX provider node (D0) entrypoint.
 *
 * Lifecycle (§3 of docs/demo-milestone-contract.md):
 *   1. Load/persist keys (Sui tx + Ed25519 attestation) under node/.keys/.
 *   2. Ensure Ollama has the model (pull if missing); start the HTTP server (§3.1).
 *   3. If chain is enabled: register_provider(endpoint, gpu_class, attest_pubkey),
 *      stake (MOCK_USDC) + mint credits, then subscribe to Dispatched and serve.
 *   4. If chain is disabled (GIX_CHAIN_ENABLED=false): run HTTP + Ollama only, so the
 *      /inputs → inference → /result path is demoable without a deployed contract.
 *
 * Robust to Ollama/RPC unavailability with clear, actionable errors.
 */

import { loadConfig, marketOf, deepbookPoolIdOf } from "./config.js";
import { loadKeys } from "./keys.js";
import { OllamaClient, OllamaError } from "./ollama.js";
import { NodeStore } from "./store.js";
import { createHttpServer } from "./http.js";
import { NodeChain } from "./chain.js";
import { DeepBookMaker } from "./deepbook.js";
import { WalrusIO } from "./walrus.js";
import { serveJob, type ServeDeps } from "./serve.js";
import { writeNodeState, type NodeState } from "./state.js";

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`${new Date().toISOString()} ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  log(`[node] starting GIX provider node`);
  log(`[node] network=${cfg.deployment.network} pkg=${cfg.deployment.packageId}`);
  log(`[node] model=${cfg.model} gpu=${cfg.gpuClass} market=${cfg.marketId}`);
  log(`[node] ollama=${cfg.ollamaUrl} rpc=${cfg.rpcUrl} chainEnabled=${cfg.chainEnabled}`);
  log(
    cfg.maxTokens > 0
      ? `[node] max output tokens = ${cfg.maxTokens}`
      : `[node] max output tokens = uncapped`,
  );

  // 1. Keys.
  const keys = loadKeys(cfg.keysDir, log);

  // 2. Ollama — probe + ensure model.
  const ollama = new OllamaClient(cfg.ollamaUrl, cfg.model, cfg.maxTokens);
  let ollamaOk = false;
  try {
    await ollama.listModels(); // reachability probe
    log(`[node] Ollama reachable; ensuring model ${cfg.model} is present`);
    const pulled = await ollama.ensureModel((s) => log(`[ollama] pull: ${s}`));
    log(pulled ? `[node] model ${cfg.model} pulled` : `[node] model ${cfg.model} already present`);
    ollamaOk = true;
  } catch (e) {
    if (e instanceof OllamaError) {
      log(`[node] WARNING: ${e.message}`);
      log(`[node] continuing — /inputs will cache prompts but inference will error until Ollama is up`);
    } else {
      throw e;
    }
  }

  const store = new NodeStore();

  // 3. HTTP server (§3.1).
  const server = createHttpServer({
    store,
    model: cfg.model,
    gpu: cfg.gpuClass,
    ollamaOk: () => ollamaOk,
  });
  await new Promise<void>((resolve) => server.listen(cfg.httpPort, cfg.httpHost, resolve));
  log(`[node] HTTP listening on http://${cfg.httpHost}:${cfg.httpPort} (POST /inputs, GET /result/:jobId, GET /health)`);
  if (cfg.httpHost === "0.0.0.0") {
    log(`[node] HTTP bound on 0.0.0.0 — reachable cross-machine; public endpoint = ${cfg.publicEndpoint}`);
    if (cfg.publicEndpoint.includes("127.0.0.1") || cfg.publicEndpoint.includes("localhost")) {
      log(`[node] WARNING: GIX_PUBLIC_ENDPOINT not set — defaulted to ${cfg.publicEndpoint}, ` +
        `which a REMOTE consumer cannot reach. Set GIX_PUBLIC_ENDPOINT to a LAN IP or tunnel URL.`);
    }
  }

  const market = marketOf(cfg);
  const deepbookPoolId = deepbookPoolIdOf(market);

  // 4. Chain: register + stake + post liquidity (DeepBook ask OR gix Ask) + serve loop.
  let chain: NodeChain | null = null;
  let askId: string | undefined; // gix shared Ask id (localnet path)
  let deepbook: DeepBookMaker | null = null;
  let deepbookOrderId: string | undefined; // DeepBook resting ask order id (testnet path)
  if (cfg.chainEnabled) {
    chain = new NodeChain(cfg, keys.suiKeypair, keys.suiAddress, log);
    try {
      const bal = await chain.getOwnedUsdcBalance();
      log(`[node] tx address ${keys.suiAddress} holds ${bal} ${cfg.deployment.usdcType} base units`);
      log(`[node] registering provider (endpoint=${cfg.publicEndpoint}, gpu=${cfg.gpuClass})`);
      const { digest } = await chain.setup(keys.attestPubkeyHex);
      log(`[node] registration+stake${cfg.mintScu > 0 ? `+mint(${cfg.mintScu})` : ""} done (digest ${digest})`);

      if (cfg.deepbookEnabled && deepbookPoolId) {
        // ---- M2 TESTNET path: post a resting limit ASK on DeepBook ----------------------
        // Provider mints owned Credit<M>, deposits it into a BalanceManager, and places an
        // ask (sell Credit for USDC) on the market's bound pool. A consumer's USDC→Credit
        // swap pays this maker AT THE FILL; the consumer then feeds the credits into
        // create_job_from_fill in the same PTB. Replaces post_ask on testnet.
        try {
          log(`[node] DeepBook maker: pool=${deepbookPoolId} qty=${cfg.askQtyScu} SCU @ ${cfg.askPriceUsdc} (raw price)`);
          deepbook = new DeepBookMaker({
            network: cfg.network === "mainnet" ? "mainnet" : "testnet",
            rpcUrl: cfg.rpcUrl,
            signer: keys.suiKeypair,
            address: keys.suiAddress,
            creditCoinType: market.creditCoinType ?? market.creditType,
            usdcType: cfg.deployment.usdcType,
            poolId: deepbookPoolId,
            inputTokenFees: cfg.deepbookInputTokenFees,
            log,
          });
          await deepbook.ensureBalanceManager();
          // Mint owned Credit<M> for the deposit (separate gix PTB), then deposit + place ask.
          await chain.mintCredits(cfg.askQtyScu);
          await deepbook.depositCredits(cfg.askQtyScu);
          const placed = await deepbook.placeAsk(cfg.askQtyScu, cfg.askPriceUsdc);
          deepbookOrderId = placed.orderId;
          log(`[node] DeepBook ASK placed (order ${deepbookOrderId ?? "?"}, digest ${placed.digest})`);
        } catch (e) {
          log(`[node] WARNING: DeepBook maker setup failed: ${(e as Error).message}`);
          log(`[node] continuing (serve loop still works for jobs created elsewhere)`);
          deepbook = null;
        }
      } else {
        // ---- LOCALNET path: publish a resting shared gix Ask<M> (two-account flow, E3) ---
        if (cfg.deepbookEnabled && !deepbookPoolId) {
          log(`[node] DeepBook requested but market.deepbookPoolId is UNSET — falling back to gix Ask. ` +
            `Bind a pool via market::set_deepbook_pool_id and set deployment.markets[].deepbookPoolId.`);
        }
        try {
          log(`[node] posting gix Ask: qty=${cfg.askQtyScu} SCU @ ${cfg.askPriceUsdc} USDC/SCU on market ${cfg.marketId}`);
          const posted = await chain.postAsk(cfg.askQtyScu, cfg.askPriceUsdc);
          askId = posted.askId;
          log(`[node] gix Ask posted (digest ${posted.digest})`);
        } catch (e) {
          log(`[node] WARNING: post_ask failed: ${(e as Error).message}`);
          log(`[node] continuing (legacy serve loop still works; no resting Ask published)`);
        }
      }
    } catch (e) {
      log(`[node] WARNING: on-chain setup failed: ${(e as Error).message}`);
      log(`[node] continuing in HTTP/Ollama-only mode (fix RPC/deployment then restart)`);
      chain = null;
    }
  } else {
    log(`[node] GIX_CHAIN_ENABLED=false — running HTTP + Ollama only (no on-chain register/serve)`);
  }

  // M2: Walrus I/O (testnet). Built once and shared by the serve loop for output upload +
  // input read. null on localnet / when disabled ⇒ serve uses the /inputs cache.
  let walrus: WalrusIO | null = null;
  if (cfg.walrusEnabled && (cfg.network === "testnet" || cfg.network === "mainnet")) {
    walrus = new WalrusIO({
      network: cfg.network,
      rpcUrl: cfg.rpcUrl,
      signer: keys.suiKeypair,
      epochs: cfg.walrusEpochs,
      wasmUrl: cfg.walrusWasmUrl,
      // Reliability fix: route output/quote sliver writes through the upload relay (testnet
      // default), and give slow testnet nodes a longer read/connect timeout than the 10s default.
      ...(cfg.walrusRelayHost
        ? { uploadRelay: { host: cfg.walrusRelayHost, sendTip: { max: 1_000 } } }
        : {}),
      storageNodeClientOptions: { timeout: 60_000 },
      log,
    });
    log(`[node] Walrus I/O enabled (network=${cfg.network}, retain ${cfg.walrusEpochs} epochs` +
      `${cfg.walrusRelayHost ? `, relay ${cfg.walrusRelayHost}` : ", direct writes"}). ` +
      `Tx address must hold WAL (+ SUI gas).`);
  } else if (cfg.walrusEnabled) {
    log(`[node] WARNING: GIX_WALRUS set but network=${cfg.network} is not testnet/mainnet — Walrus disabled.`);
  }

  // Write the discovery artifact (node-state.json). On localnet the consumer (E3) reads
  // askId + fills via create_job_from_ask; on testnet it reads the DeepBook pool + makerType
  // and fills via the DeepBook swap → create_job_from_fill PTB.
  const persistState = (remainingScu?: number): void => {
    const state: NodeState = {
      network: cfg.deployment.network,
      packageId: cfg.deployment.packageId,
      configId: cfg.deployment.configId,
      clockId: cfg.deployment.clockId,
      usdcType: cfg.deployment.usdcType,
      marketId: cfg.marketId,
      creditType: market.creditType,
      provider: keys.suiAddress,
      publicEndpoint: cfg.publicEndpoint,
      askId,
      priceUsdcPerScu: cfg.askPriceUsdc,
      askQtyScu: cfg.askQtyScu,
      remainingScu,
      updatedAt: "", // filled by writeNodeState
      // M2 fields (present on the testnet DeepBook path).
      mode: deepbook ? "deepbook" : "ask",
      deepbookPoolId: deepbookPoolId,
      deepbookOrderId,
      balanceManagerId: deepbook?.managerId,
      walrus: cfg.walrusEnabled,
    };
    try {
      writeNodeState(cfg.nodeStatePath, state);
    } catch (e) {
      log(`[node] WARNING: could not write node-state.json at ${cfg.nodeStatePath}: ${(e as Error).message}`);
    }
  };
  persistState(askId || deepbookOrderId ? cfg.askQtyScu : undefined);
  if (deepbook && deepbookPoolId) {
    log(`[node] ===========================================================================`);
    log(`[node]  DeepBook resting ASK placed — consumer can now buy (swap → create_job_from_fill):`);
    log(`[node]    deepbook pool    = ${deepbookPoolId}`);
    log(`[node]    order id         = ${deepbookOrderId ?? "(read from book)"}`);
    log(`[node]    balance manager  = ${deepbook.managerId}`);
    log(`[node]    public endpoint  = ${cfg.publicEndpoint}`);
    log(`[node]    market           = ${cfg.marketId}`);
    log(`[node]    creditType (M)   = ${market.creditType}`);
    log(`[node]    price (raw)      = ${cfg.askPriceUsdc}`);
    log(`[node]    qty offered      = ${cfg.askQtyScu} SCU`);
    log(`[node]    discovery file   = ${cfg.nodeStatePath}`);
    log(`[node] ===========================================================================`);
  } else if (askId) {
    log(`[node] ===========================================================================`);
    log(`[node]  RESTING ASK published — consumer can now buy:`);
    log(`[node]    ask id           = ${askId}`);
    log(`[node]    public endpoint  = ${cfg.publicEndpoint}`);
    log(`[node]    market           = ${cfg.marketId}`);
    log(`[node]    creditType (M)   = ${market.creditType}`);
    log(`[node]    price/SCU        = ${cfg.askPriceUsdc} (USDC base units)`);
    log(`[node]    qty offered      = ${cfg.askQtyScu} SCU`);
    log(`[node]    discovery file   = ${cfg.nodeStatePath}`);
    log(`[node] ===========================================================================`);
  }

  const deps: ServeDeps = {
    ollama,
    attest: keys.attest,
    attestPubkeyHex: keys.attestPubkeyHex,
    chain,
    store,
    model: cfg.model,
    measurement: cfg.measurement,
    walrus,
    log,
  };

  // 5. Serve loop — subscribe to Dispatched. create_job_from_ask<M> emits BOTH JobCreated
  //    AND Dispatched (contracts/README.md), so this same subscription serves two-account jobs
  //    (consumer != provider) identically to legacy owned-credit jobs. The job's `provider`
  //    is this node (= ask.provider); the consumer's address is irrelevant to the node, and
  //    no consumer-owned object is ever needed — we fetch the prompt by input_hash from the
  //    /inputs cache, run Ollama, sign, submit_signed_attestation, then settle with OUR stake.
  let stop: (() => void) | null = null;
  if (chain) {
    log(`[node] subscribing to Dispatched events for provider ${keys.suiAddress} ` +
      `(serves both owned-credit and Ask-created jobs; consumer wallet may differ)`);
    stop = chain.subscribeDispatched((job) => {
      void serveJob(job, deps).catch((e) =>
        log(`[serve] job ${job.jobId}: error: ${(e as Error).message}`),
      );
    });
  } else {
    log(`[node] no chain serve loop; submit prompts via POST /inputs and drive jobs externally`);
  }

  // 6a. gix Ask top-up loop (localnet) — re-post a fresh Ask when remaining_scu runs low.
  //     Disabled by GIX_ASK_TOPUP_THRESHOLD_SCU=0.
  let topupStopped = false;
  if (chain && askId && !deepbook && cfg.askTopupThresholdScu > 0) {
    const topupLoop = async (): Promise<void> => {
      while (!topupStopped) {
        await sleep(cfg.askTopupPollMs);
        if (topupStopped || !chain || !askId) continue;
        const remaining = await chain.getAskRemaining(askId);
        if (remaining === undefined) continue;
        if (remaining > cfg.askTopupThresholdScu) {
          persistState(remaining);
          continue;
        }
        log(`[node] Ask ${askId} remaining=${remaining} ≤ threshold ${cfg.askTopupThresholdScu} — re-posting`);
        try {
          const posted = await chain.postAsk(cfg.askQtyScu, cfg.askPriceUsdc);
          askId = posted.askId;
          persistState(cfg.askQtyScu);
          log(`[node] Ask topped up: new ask id = ${askId} (digest ${posted.digest})`);
        } catch (e) {
          log(`[node] WARNING: Ask top-up failed: ${(e as Error).message} ` +
            `(capacity may be exhausted; raise GIX_CAPACITY_SCU)`);
        }
      }
    };
    void topupLoop();
  }

  // 6b. DeepBook ask refresh loop (testnet) — when the resting base runs low (consumers
  //     filled the ask), mint+deposit+re-place a fresh ask so liquidity never runs dry.
  //     Disabled by GIX_DEEPBOOK_REFRESH_THRESHOLD_SCU=0.
  if (chain && deepbook && cfg.deepbookRefreshThresholdScu > 0) {
    const refreshLoop = async (): Promise<void> => {
      while (!topupStopped) {
        await sleep(cfg.deepbookPollMs);
        if (topupStopped || !chain || !deepbook) continue;
        const remaining = await deepbook.getRestingBaseScu();
        if (remaining === undefined) continue;
        if (remaining > cfg.deepbookRefreshThresholdScu) {
          persistState(remaining);
          continue;
        }
        log(`[node] DeepBook ask remaining=${remaining} ≤ threshold ${cfg.deepbookRefreshThresholdScu} — re-placing`);
        try {
          await chain.mintCredits(cfg.askQtyScu);
          await deepbook.depositCredits(cfg.askQtyScu);
          const placed = await deepbook.placeAsk(cfg.askQtyScu, cfg.askPriceUsdc);
          deepbookOrderId = placed.orderId;
          persistState(cfg.askQtyScu);
          log(`[node] DeepBook ask refreshed: order ${deepbookOrderId ?? "?"} (digest ${placed.digest})`);
        } catch (e) {
          log(`[node] WARNING: DeepBook refresh failed: ${(e as Error).message} ` +
            `(capacity/credit may be exhausted; raise GIX_CAPACITY_SCU)`);
        }
      }
    };
    void refreshLoop();
  }

  // Graceful shutdown.
  const shutdown = (): void => {
    log(`[node] shutting down`);
    topupStopped = true;
    stop?.();
    // Best-effort: cancel resting DeepBook orders so capacity isn't stranded on chain.
    if (deepbook) {
      void deepbook.cancelAllAsks().catch((e) =>
        log(`[node] DeepBook cancelAllAsks on shutdown failed: ${(e as Error).message}`),
      );
    }
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log(`[node] ready`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(`[node] fatal: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
