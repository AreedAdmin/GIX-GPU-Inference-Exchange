// Scripted buy through the REAL web SuiOrderClient code path (Step 4 verification).
// Injects the node's keypair as the WalletSigner so buyer == provider == node (the
// verified localnet single-account model the SDK/gateway also use). This drives the
// exact create_job PTB the browser "Buy" button runs, then fetches + verifies /result.
import { readFileSync } from "node:fs";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiOrderClient } from "../src/trade/sui";
import type { ChainConfig } from "../src/trade/config";
import type { WalletSigner } from "../src/trade/burner";

const REPO = "/home/shehab/Desktop/Code Repos/gpu-inference-exchange";
const deployment = JSON.parse(readFileSync(`${REPO}/deployment.json`, "utf8"));
const m = deployment.markets[0];
const NODE_ADDR = "0x5d11b7bceb20471ed879c5b12f2f84f5e9064e929378ad514608170b22fa9549";

const cfg: ChainConfig = {
  network: "localnet",
  rpcUrl: "http://127.0.0.1:9000",
  faucetUrl: "http://127.0.0.1:9123",
  packageId: deployment.packageId,
  configId: deployment.configId,
  clockId: deployment.clockId,
  usdcType: deployment.usdcType,
  faucetId: deployment.faucetId,
  providerAddress: NODE_ADDR,
  providerUrl: "http://127.0.0.1:8081",
  market: {
    id: m.id,
    name: m.name,
    creditType: m.creditType,
    modelId: m.modelId,
    scuTokens: m.scuTokens,
    slaP99Ms: m.slaP99Ms,
  },
  explorerTxBase: "",
};

// Node keypair as the injected wallet signer (mirrors burner.ts signAndExecute).
const keyFile = JSON.parse(readFileSync(`${REPO}/node/.keys/sui-tx.key`, "utf8"));
const kp = Ed25519Keypair.fromSecretKey(Buffer.from(keyFile.seedHex, "hex"));
const signer: WalletSigner = {
  address: kp.toSuiAddress(),
  async signAndExecute(client, tx) {
    const res = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: kp,
      options: { showEffects: true, showEvents: true, showObjectChanges: true },
    });
    await client.waitForTransaction({ digest: res.digest });
    const status = (res.effects as { status?: { status: string; error?: string } } | undefined)?.status;
    if (status && status.status !== "success") {
      throw new Error(`tx ${res.digest} failed: ${status.error ?? "unknown"}`);
    }
    return { digest: res.digest, objectChanges: res.objectChanges, events: res.events };
  },
};

const oc = new SuiOrderClient({ cfg, signer });
const acct = await oc.connect();
console.log("[web-smoke] wallet:", acct.address);
console.log("[web-smoke] provider health:", await oc.providerHealth());

const prompt = "In one sentence, what is a GPU inference exchange?";
console.log("[web-smoke] runTask prompt:", prompt);
const buy = await oc.runTask({ marketId: cfg.market.id, qtyScu: 1, priceUsdcPerScu: 5, prompt });
console.log("[web-smoke] buy result:", buy);
if (!buy.ok || !buy.jobId) throw new Error("buy failed: " + (buy.error ?? "no jobId"));

// Poll the result viewer path (the store does this once the job settles).
let result;
for (let i = 0; i < 40; i++) {
  try {
    result = await oc.getResult(buy.jobId, { costUsdc: 5, digest: buy.digest });
    if (result?.output) break;
  } catch { /* not ready yet */ }
  await new Promise((r) => setTimeout(r, 2000));
}
console.log("[web-smoke] VERIFIED RESULT:", JSON.stringify({
  jobId: buy.jobId,
  digest: buy.digest,
  output: result?.output,
  verified: result?.verified,
  reportedOutputHash: result?.reportedOutputHash,
  localOutputHash: result?.localOutputHash,
  outputTokenCount: result?.outputTokenCount,
  providerPubkey: result?.providerPubkey,
}, null, 2));
