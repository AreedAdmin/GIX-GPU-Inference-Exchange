/**
 * Gateway entrypoint: load deployment.json + a signer from env, construct the
 * GixClient, and start the OpenAI-compatible server.
 *
 * Env:
 *   GIX_GATEWAY_PORT       listen port (default 8088)
 *   GIX_DEPLOYMENT         path to deployment.json (default ../../deployment.json)
 *   GIX_PROVIDER_URL       provider node base url (default http://localhost:8080)
 *   GIX_RPC_URL            Sui RPC url (default: network fullnode)
 *   GIX_PROVIDER_ADDRESS   provider operator address (default deployment.accounts.providers[0])
 *   GIX_MAX_PRICE_USDC     max MOCK_USDC base units per SCU per request (default 1_000_000)
 *   GIX_SUI_PRIVKEY        consumer signer bech32 key (suiprivkey1…) — required to serve
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

  const client = new GixClient({
    deployment,
    signer,
    providerUrl,
    rpcUrl: process.env.GIX_RPC_URL,
    provider: process.env.GIX_PROVIDER_ADDRESS,
    logger: (m, meta) => console.log(`[sdk] ${m}`, meta ?? ""),
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
