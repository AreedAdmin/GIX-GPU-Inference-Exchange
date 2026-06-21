/**
 * Live tunnel-free buy on Sui testnet (Option 3 — inline on-chain input).
 *
 * The consumer fills the provider's resting Ask via
 *   job::create_job_from_ask<M, Q>(cfg, market, ask, qty_scu, escrow_in, input, input_hash, clk)
 * carrying the prompt INLINE (UTF-8 bytes) and its sha2_256 commitment. No POST /inputs.
 *
 * The running GIX node (watching Dispatched events) picks it up, reads the prompt FROM CHAIN
 * (job.input), runs qwen, signs an attestation, and settles — all on testnet.
 *
 * This script ONLY does the buy + prints the job id + buy digest. Polling/verification is
 * driven from the shell afterwards.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

// ---- known ids (deployment.testnet.json) -----------------------------------
const PKG = "0xa7063d55fcc9b4e9887ffcff9776f344751c72e63b5dea252d60c029b8f9cdaf";
const CFG = "0x31722451954376a1a63271d08c55f26c815fbae97e9e205e2afa00a59be2811c";
const MARKET = "0x64bfe7a666f07ba330ddcef0a6a07950d2571933c262dca0db2ee185205bddc8";
const ASK = "0xa1f088044366b2a73af0e2e55405691958ebe27a74316825abd441eec3b2123b";
const M = `${PKG}::markets::M_GB10_QWEN35B`;
const Q = `${PKG}::mock_usdc::MOCK_USDC`;
const CLOCK = "0x6";
const CONSUMER = "0xb8e7af9d7be92710d38b1f867c6bc99db9171e47d7bc1afef87ba8a4350ee4e7";

const PROMPT = "Explain in detail how a transformer neural network works, including self-attention, positional encoding, and training.";
const QTY_SCU = 1;

function loadConsumerKeypair(): Ed25519Keypair {
  // The sui CLI keystore holds the consumer key (active address == CONSUMER).
  const ksPath = join(homedir(), ".sui", "sui_config", "sui.keystore");
  const entries = JSON.parse(readFileSync(ksPath, "utf8")) as string[];
  for (const b64 of entries) {
    // Each entry is base64(flag || 32-byte secret). Ed25519 flag = 0x00.
    const raw = Buffer.from(b64, "base64");
    if (raw[0] !== 0x00) continue;
    const kp = Ed25519Keypair.fromSecretKey(new Uint8Array(raw.subarray(1)));
    if (kp.getPublicKey().toSuiAddress() === CONSUMER) return kp;
  }
  throw new Error(`consumer key ${CONSUMER} not found in keystore ${ksPath}`);
}

async function main() {
  const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl("testnet") });
  const kp = loadConsumerKeypair();
  const addr = kp.getPublicKey().toSuiAddress();
  if (addr !== CONSUMER) throw new Error(`signer ${addr} != consumer ${CONSUMER}`);

  // ---- read the ask to compute exact escrow -------------------------------
  const askObj = await client.getObject({ id: ASK, options: { showContent: true } });
  const fields = (askObj.data?.content as any)?.fields ?? {};
  const pricePerScu = BigInt(fields.price_usdc_per_scu);
  const required = BigInt(QTY_SCU) * pricePerScu;
  console.log(`[buy] ask price/SCU=${pricePerScu} qty=${QTY_SCU} -> required escrow=${required} base units`);

  // ---- find a Coin<MOCK_USDC> of the NEW package type ---------------------
  const coins = await client.getCoins({ owner: CONSUMER, coinType: Q });
  if (coins.data.length === 0) throw new Error(`no Coin<${Q}> owned by consumer`);
  const escrowSource = coins.data.find((c) => BigInt(c.balance) >= required) ?? coins.data[0];
  console.log(`[buy] escrow source coin ${escrowSource.coinObjectId} balance=${escrowSource.balance}`);

  // ---- input + input_hash (sha2_256) --------------------------------------
  const input = new TextEncoder().encode(PROMPT);
  const inputHash = new Uint8Array(createHash("sha256").update(Buffer.from(input)).digest());
  console.log(`[buy] prompt="${PROMPT}"`);
  console.log(`[buy] input_hash=0x${Buffer.from(inputHash).toString("hex")}`);

  // ---- build the PTB ------------------------------------------------------
  const tx = new Transaction();
  tx.setSender(addr);
  // Split exactly `required` out of the consumer's MOCK_USDC coin for escrow.
  const [escrowCoin] = tx.splitCoins(tx.object(escrowSource.coinObjectId), [tx.pure.u64(required)]);
  tx.moveCall({
    target: `${PKG}::job::create_job_from_ask`,
    typeArguments: [M, Q],
    arguments: [
      tx.object(CFG),
      tx.object(MARKET),
      tx.object(ASK),
      tx.pure.u64(BigInt(QTY_SCU)),
      escrowCoin,
      tx.pure.vector("u8", Array.from(input)),
      tx.pure.vector("u8", Array.from(inputHash)),
      tx.object(CLOCK),
    ],
  });

  const res = await client.signAndExecuteTransaction({
    signer: kp,
    transaction: tx,
    options: { showEffects: true, showObjectChanges: true, showEvents: true },
  });

  const status = res.effects?.status?.status;
  if (status !== "success") {
    console.error(`[buy] FAILED: ${JSON.stringify(res.effects?.status)}`);
    process.exit(1);
  }

  // ---- extract job id -----------------------------------------------------
  let jobId: string | undefined;
  for (const ch of res.objectChanges ?? []) {
    if (ch.type === "created" && (ch as any).objectType?.includes("::job::Job<")) {
      jobId = (ch as any).objectId;
    }
  }
  if (!jobId) {
    for (const ev of res.events ?? []) {
      if (ev.type.endsWith("::events::JobCreated")) jobId = (ev.parsedJson as any)?.job_id;
    }
  }

  console.log("==================================================================");
  console.log(`[buy] BUY DIGEST = ${res.digest}`);
  console.log(`[buy] JOB ID     = ${jobId}`);
  console.log(`[buy] escrow     = ${required} ${Q}`);
  console.log("==================================================================");
  // machine-readable line for the shell to parse
  console.log(`RESULT jobId=${jobId} buyDigest=${res.digest} inputHash=0x${Buffer.from(inputHash).toString("hex")} escrow=${required}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
