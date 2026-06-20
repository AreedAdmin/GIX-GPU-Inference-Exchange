/**
 * Gateway entrypoint: load deployment.json + a signer from env, construct the
 * GixClient, and start the OpenAI-compatible server.
 *
 * The OpenAI endpoint is unchanged externally; the underlying on-chain buy path
 * is NETWORK-SWITCHED inside `@gix/sdk`'s `runTask`: when `deployment.network`
 * is "testnet" the SDK buys via the M2 DeepBook swap → `create_job_from_fill`
 * (Option B / pay-at-match) with Walrus blobs; on localnet it stays on the M1
 * escrow `create_job` path. The gateway just passes `deployment` (carrying
 * `network`) + the optional fill seam below, so no gateway change is needed when
 * the SDK's testnet branch lands.
 *
 * Env:
 *   GIX_GATEWAY_PORT       listen port (default 8088)
 *   GIX_DEPLOYMENT         path to deployment.json (default ../../deployment.json)
 *   GIX_PROVIDER_URL       provider node base url (default http://localhost:8080)
 *   GIX_RPC_URL            Sui RPC url (default: network fullnode)
 *   GIX_PROVIDER_ADDRESS   provider operator address (default deployment.accounts.providers[0])
 *   GIX_MAX_PRICE_USDC     max MOCK_USDC base units per SCU per request (default 1_000_000)
 *   GIX_SUI_PRIVKEY        consumer signer bech32 key (suiprivkey1…) — required to serve
 *   ── M2 testnet DeepBook fill seam (only consumed by the SDK on testnet) ──
 *   GIX_DEEPBOOK_POOL_ID   the market's bound DeepBook pool (else deployment.markets[].deepbookPoolId)
 *   GIX_PROVIDER_RECORD_ID the single market provider's shared ProviderRecord id
 *   GIX_DEEP_IN            DEEP base units for the swap fee (0 ⇒ input-token fee)
 *   GIX_WALRUS_EPOCHS      Walrus storage epochs for input/output blobs (default 3)
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GixClient, fromSuiPrivateKey, type Deployment } from "@gix/sdk";
import { createGateway } from "./server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const port = Number(process.env.GIX_GATEWAY_PORT ?? 8088);
  const deploymentPath =
    process.env.GIX_DEPLOYMENT ?? resolve(__dirname, "../../../deployment.json");
  const providerUrl = process.env.GIX_PROVIDER_URL ?? "http://localhost:8080";
  const maxPrice = Number(process.env.GIX_MAX_PRICE_USDC ?? 1_000_000);

  const deployment = JSON.parse(readFileSync(deploymentPath, "utf8")) as Deployment;

  const privKey = process.env.GIX_SUI_PRIVKEY;
  if (!privKey) {
    throw new Error(
      "GIX_SUI_PRIVKEY (suiprivkey1…) is required to sign on-chain purchases. " +
        "Export the consumer's Sui private key and restart.",
    );
  }
  const signer = await fromSuiPrivateKey(privKey);

  // ── M2 testnet DeepBook fill seam ────────────────────────────────────────────
  // On testnet the SDK's runTask buys via DeepBook swap → create_job_from_fill and
  // needs the bound pool + the single provider's ProviderRecord (and a Walrus
  // signer for blob upload). We forward those from env; the SDK consumes them only
  // when `deployment.network === "testnet"`. Built loosely so this typechecks
  // against the CURRENT (pre-M2) SDK option surface and gets picked up once the
  // SDK's `fill` / `walrusSigner` options land (reconcile at integration).
  const fillSeam: Record<string, unknown> = {};
  if (deployment.network === "testnet") {
    const poolId = process.env.GIX_DEEPBOOK_POOL_ID;
    const providerRecordId = process.env.GIX_PROVIDER_RECORD_ID;
    const deepIn = process.env.GIX_DEEP_IN;
    const walrusEpochs = process.env.GIX_WALRUS_EPOCHS;
    fillSeam.fill = {
      ...(poolId ? { poolId } : {}),
      ...(providerRecordId ? { providerRecordId } : {}),
      ...(deepIn ? { deepIn: BigInt(deepIn) } : {}),
      ...(walrusEpochs ? { walrusEpochs: Number(walrusEpochs) } : {}),
    };
    // The Walrus upload leg needs a real @mysten/sui Signer; our keypair signer
    // already satisfies it. Pass it through under the SDK's documented key.
    fillSeam.walrusSigner = signer;
  }

  const client = new GixClient({
    deployment,
    signer,
    providerUrl,
    rpcUrl: process.env.GIX_RPC_URL,
    provider: process.env.GIX_PROVIDER_ADDRESS,
    logger: (m, meta) => console.log(`[sdk] ${m}`, meta ?? ""),
    // Forward the testnet fill seam (no-op on localnet / older SDKs).
    ...fillSeam,
  });

  const server = createGateway({ runner: client, maxPriceUsdcPerScu: maxPrice });
  server.listen(port, () => {
    console.log(`[gix-gateway] OpenAI-compatible gateway listening on :${port}`);
    console.log(`[gix-gateway]   deployment : ${deploymentPath} (${deployment.network})`);
    console.log(`[gix-gateway]   provider   : ${providerUrl}`);
    console.log(`[gix-gateway]   signer     : ${signer.toSuiAddress()}`);
    console.log(`[gix-gateway]   models     : ${client.markets().map((m) => m.name).join(", ")}`);
  });
}

main().catch((err) => {
  console.error(`[gix-gateway] fatal: ${(err as Error).message}`);
  process.exit(1);
});
