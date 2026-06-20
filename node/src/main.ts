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

import { loadConfig } from "./config.js";
import { loadKeys } from "./keys.js";
import { OllamaClient, OllamaError } from "./ollama.js";
import { NodeStore } from "./store.js";
import { createHttpServer } from "./http.js";
import { NodeChain } from "./chain.js";
import { serveJob, type ServeDeps } from "./serve.js";

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`${new Date().toISOString()} ${msg}`);
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

  // 4. Chain: register + stake + serve loop.
  let chain: NodeChain | null = null;
  if (cfg.chainEnabled) {
    chain = new NodeChain(cfg, keys.suiKeypair, keys.suiAddress, log);
    try {
      const bal = await chain.getOwnedUsdcBalance();
      log(`[node] tx address ${keys.suiAddress} holds ${bal} ${cfg.deployment.usdcType} base units`);
      log(`[node] registering provider (endpoint=${cfg.publicEndpoint}, gpu=${cfg.gpuClass})`);
      const { digest } = await chain.setup(keys.attestPubkeyHex);
      log(`[node] registration+stake+mint done (digest ${digest})`);
    } catch (e) {
      log(`[node] WARNING: on-chain setup failed: ${(e as Error).message}`);
      log(`[node] continuing in HTTP/Ollama-only mode (fix RPC/deployment then restart)`);
      chain = null;
    }
  } else {
    log(`[node] GIX_CHAIN_ENABLED=false — running HTTP + Ollama only (no on-chain register/serve)`);
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

  // 5. Serve loop — subscribe to Dispatched.
  let stop: (() => void) | null = null;
  if (chain) {
    log(`[node] subscribing to Dispatched events for ${keys.suiAddress}`);
    stop = chain.subscribeDispatched((job) => {
      void serveJob(job, deps).catch((e) =>
        log(`[serve] job ${job.jobId}: error: ${(e as Error).message}`),
      );
    });
  } else {
    log(`[node] no chain serve loop; submit prompts via POST /inputs and drive jobs externally`);
  }

  // Graceful shutdown.
  const shutdown = (): void => {
    log(`[node] shutting down`);
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
