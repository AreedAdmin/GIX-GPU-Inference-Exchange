#!/usr/bin/env node
/**
 * get-wal.ts — swap testnet SUI -> WAL via the on-chain Walrus SUI/WAL exchange.
 *
 * Replicates the `walrus get-wal` CLI mechanism without the walrus CLI: builds a
 * PTB that splits `--amount` MIST off the gas coin, calls
 * `wal_exchange::exchange_for_wal(&mut Exchange, &mut Coin<SUI>, amount, ctx)`
 * on a testnet Exchange object (1:1 SUI:WAL), and transfers the returned
 * Coin<WAL> back to the sender.
 *
 * The Exchange object ids come from `@mysten/walrus`'s
 * TESTNET_WALRUS_PACKAGE_CONFIG.exchangeIds. The exchange package + WAL coin
 * type are read off the live Exchange object.
 *
 * Signer is loaded from the local Sui keystore (~/.sui/sui_config/sui.keystore,
 * first key) so it uses the same funded testnet address as the Sui CLI.
 *
 * Usage:
 *   tsx scripts/get-wal.ts [--amount 500000000]   # MIST/FROST, default 0.5 SUI
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const WAL_TYPE =
  "0x8270feb7375eee355e64fdb69c50abb6b5f9393a722883c1cf45f8e26048810a::wal::WAL";
// wal_exchange package (read off the Exchange object's type).
const EXCHANGE_PKG =
  "0x82593828ed3fcb8c6a235eac9abd0adbe9c5f9bbffa9b1e7a45cdd884481ef9f";

function getArg(flag: string, def?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

function loadKeypair() {
  const ks = JSON.parse(
    readFileSync(homedir() + "/.sui/sui_config/sui.keystore", "utf8"),
  ) as string[];
  return ks;
}

async function main() {
  const amount = BigInt(getArg("--amount", "500000000")!); // 0.5 SUI default
  const { SuiJsonRpcClient, getJsonRpcFullnodeUrl } = await import("@mysten/sui/jsonRpc");
  const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
  const { Transaction } = await import("@mysten/sui/transactions");
  const { TESTNET_WALRUS_PACKAGE_CONFIG } = await import("@mysten/walrus");

  const raw = Buffer.from(loadKeypair()[0], "base64");
  if (raw[0] !== 0) throw new Error(`expected Ed25519 keystore key (flag 0), got ${raw[0]}`);
  const signer = Ed25519Keypair.fromSecretKey(new Uint8Array(raw.subarray(1)));
  const sender = signer.getPublicKey().toSuiAddress();
  console.error(`signer: ${sender}`);

  const exchangeId = TESTNET_WALRUS_PACKAGE_CONFIG.exchangeIds[0];
  console.error(`exchange object: ${exchangeId}`);
  console.error(`swapping ${Number(amount) / 1e9} SUI -> WAL (1:1)`);

  const suiClient = new SuiJsonRpcClient({
    network: "testnet",
    url: getJsonRpcFullnodeUrl("testnet"),
  });

  const tx = new Transaction();
  tx.setSender(sender);
  // Split `amount` MIST off the gas coin -> a fresh Coin<SUI> to feed the swap.
  const [suiIn] = tx.splitCoins(tx.gas, [tx.pure.u64(amount)]);
  // exchange_for_wal(&mut Exchange, &mut Coin<SUI>, amount, ctx) -> Coin<WAL>.
  // NOTE: suiIn is passed by &mut and survives the call (drained to 0), so it
  // must be transferred back alongside the WAL coin to avoid UnusedValue.
  const walOut = tx.moveCall({
    target: `${EXCHANGE_PKG}::wal_exchange::exchange_for_wal`,
    arguments: [tx.object(exchangeId), suiIn, tx.pure.u64(amount)],
  });
  tx.transferObjects([walOut, suiIn], tx.pure.address(sender));

  const res = await suiClient.signAndExecuteTransaction({
    transaction: tx,
    signer,
    options: { showEffects: true, showBalanceChanges: true },
  });

  console.error(`\ntx digest: ${res.digest}`);
  console.error(`status: ${res.effects?.status?.status}`);
  if (res.effects?.status?.status !== "success") {
    console.error("FAILED:", JSON.stringify(res.effects?.status, null, 2));
    process.exit(1);
  }
  const gasUsed = res.effects?.gasUsed;
  if (gasUsed) {
    const gas =
      BigInt(gasUsed.computationCost) +
      BigInt(gasUsed.storageCost) -
      BigInt(gasUsed.storageRebate);
    console.error(`gas spent: ${Number(gas) / 1e9} SUI`);
  }
  console.error("balance changes:");
  for (const bc of res.balanceChanges ?? []) {
    console.error(`  ${bc.coinType}  ${bc.amount}`);
  }
  console.log(JSON.stringify({ digest: res.digest, amountMist: amount.toString(), wal: WAL_TYPE }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
