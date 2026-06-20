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

import { loadConfig, marketOf } from "./config.js";
import { loadKeys } from "./keys.js";
import { OllamaClient, OllamaError } from "./ollama.js";
import { NodeStore } from "./store.js";
import { createHttpServer } from "./http.js";
import { NodeChain } from "./chain.js";
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

  // 1. Keys.
  const keys = loadKeys(cfg.keysDir, log);

  // 2. Ollama — probe + ensure model.
  const ollama = new OllamaClient(cfg.ollamaUrl, cfg.model);
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

  // 4. Chain: register + stake + post Ask + serve loop.
  let chain: NodeChain | null = null;
  let askId: string | undefined;
  if (cfg.chainEnabled) {
    chain = new NodeChain(cfg, keys.suiKeypair, keys.suiAddress, log);
    try {
      const bal = await chain.getOwnedUsdcBalance();
      log(`[node] tx address ${keys.suiAddress} holds ${bal} ${cfg.deployment.usdcType} base units`);
      log(`[node] registering provider (endpoint=${cfg.publicEndpoint}, gpu=${cfg.gpuClass})`);
      const { digest } = await chain.setup(keys.attestPubkeyHex);
      log(`[node] registration+stake${cfg.mintScu > 0 ? `+mint(${cfg.mintScu})` : ""} done (digest ${digest})`);

      // Publish resting capacity as a shared Ask<M> for the two-account flow (E3). This is
      // what an EXTERNAL consumer wallet fills via job::create_job_from_ask<M>.
      try {
        log(`[node] posting Ask: qty=${cfg.askQtyScu} SCU @ ${cfg.askPriceUsdc} USDC/SCU on market ${cfg.marketId}`);
        const posted = await chain.postAsk(cfg.askQtyScu, cfg.askPriceUsdc);
        askId = posted.askId;
        log(`[node] Ask posted (digest ${posted.digest})`);
      } catch (e) {
        log(`[node] WARNING: post_ask failed: ${(e as Error).message}`);
        log(`[node] continuing (legacy serve loop still works; no resting Ask published)`);
      }
    } catch (e) {
      log(`[node] WARNING: on-chain setup failed: ${(e as Error).message}`);
      log(`[node] continuing in HTTP/Ollama-only mode (fix RPC/deployment then restart)`);
      chain = null;
    }
  } else {
    log(`[node] GIX_CHAIN_ENABLED=false — running HTTP + Ollama only (no on-chain register/serve)`);
  }

  // Write the discovery artifact (node-state.json) the consumer (E3) reads to find the Ask.
  const market = marketOf(cfg);
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
    };
    try {
      writeNodeState(cfg.nodeStatePath, state);
    } catch (e) {
      log(`[node] WARNING: could not write node-state.json at ${cfg.nodeStatePath}: ${(e as Error).message}`);
    }
  };
  persistState(askId ? cfg.askQtyScu : undefined);
  if (askId) {
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
    log,
  };

  // 5. Serve loop — subscribe to Dispatched. create_job_from_ask<M> emits BOTH JobCreated
  //    AND Dispatched (INTERFACE.md), so this same subscription serves two-account jobs
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

  // 6. Ask top-up loop — when consumers draw the resting Ask's remaining_scu down to/below
  //    the threshold, re-post a fresh Ask so liquidity never runs dry mid-demo. The fresh
  //    Ask is a NEW shared object (new id); node-state.json is rewritten with the new id so
  //    the consumer always discovers a live Ask. Disabled by GIX_ASK_TOPUP_THRESHOLD_SCU=0.
  let topupStopped = false;
  if (chain && askId && cfg.askTopupThresholdScu > 0) {
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

  // Graceful shutdown.
  const shutdown = (): void => {
    log(`[node] shutting down`);
    topupStopped = true;
    stop?.();
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
