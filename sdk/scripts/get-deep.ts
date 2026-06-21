// sdk/scripts/get-deep.ts
// Acquire testnet DEEP by swapping SUI on the live DeepBook DEEP_SUI pool (no DEEP
// needed up front — input-coin fees). Funds the 500-DEEP permissionless-pool creation
// fee (docs/permissionless-pool-plan.md Phase 0). Signs with the local ~/.sui testnet key.
//
//   npx tsx sdk/scripts/get-deep.ts            # default: spend 13 SUI, floor 500 DEEP
//   GIX_SUI_IN=14 GIX_MIN_DEEP=520 npx tsx sdk/scripts/get-deep.ts

import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const POOL_KEY = "DEEP_SUI"; // base=DEEP, quote=SUI (testnet)
const DEEP_TYPE =
  "0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP";
const DEEP_DEC = 6;
const SUI_IN = Number(process.env.GIX_SUI_IN ?? 13); // whole SUI to spend
const MIN_DEEP = Number(process.env.GIX_MIN_DEEP ?? 500); // revert if fewer DEEP out
const RPC_URL = process.env.VITE_RPC_URL ?? "https://fullnode.testnet.sui.io:443";

async function loadKeypair() {
  const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
  const ks = JSON.parse(
    readFileSync(`${homedir()}/.sui/sui_config/sui.keystore`, "utf8"),
  ) as string[];
  const raw = Buffer.from(ks[0]!, "base64");
  if (raw[0] !== 0) throw new Error(`expected Ed25519 keystore key (flag 0), got ${raw[0]}`);
  return Ed25519Keypair.fromSecretKey(new Uint8Array(raw.subarray(1)));
}

async function deepBal(rpc: any, owner: string): Promise<number> {
  const b = await rpc.getBalance({ owner, coinType: DEEP_TYPE });
  return Number(b.totalBalance) / 10 ** DEEP_DEC;
}

async function main() {
  const { SuiJsonRpcClient } = await import("@mysten/sui/jsonRpc");
  const { DeepBookClient } = await import("@mysten/deepbook-v3");
  const { Transaction } = await import("@mysten/sui/transactions");

  const rpc = new SuiJsonRpcClient({ network: "testnet", url: RPC_URL });
  const kp = await loadKeypair();
  const address = kp.toSuiAddress();
  const before = await deepBal(rpc, address);
  console.log(`[get-deep] signer=${address}  DEEP before=${before}`);
  console.log(`[get-deep] swapping ~${SUI_IN} SUI → DEEP on ${POOL_KEY} (floor ${MIN_DEEP} DEEP)…`);

  const db = new DeepBookClient({
    client: rpc as unknown as never,
    address,
    network: "testnet" as never,
  });

  const tx = new Transaction();
  tx.setSenderIfNotSet(address);
  // pay SUI (quote) → receive DEEP (base); deepAmount:0 ⇒ input-coin fees (no DEEP needed).
  const [deepOut, suiRemain, deepRemain] = db.deepBook.swapExactQuoteForBase({
    poolKey: POOL_KEY,
    amount: SUI_IN,
    deepAmount: 0,
    minOut: BigInt(Math.floor(MIN_DEEP * 10 ** DEEP_DEC)),
  })(tx as never) as unknown as [unknown, unknown, unknown];
  tx.transferObjects(
    [deepOut as never, suiRemain as never, deepRemain as never],
    tx.pure.address(address),
  );

  const res = await (rpc as any).signAndExecuteTransaction({
    transaction: tx,
    signer: kp,
    options: { showEffects: true, showBalanceChanges: true },
  });
  await rpc.waitForTransaction({ digest: res.digest });
  const st = res.effects?.status;
  if (st && st.status !== "success") throw new Error(st.error ?? "swap failed");

  const after = await deepBal(rpc, address);
  console.log(`[get-deep] ✓ digest=${res.digest}`);
  console.log(`[get-deep] DEEP after=${after}  (+${(after - before).toFixed(4)})`);
}

main().catch((e) => {
  console.error("[get-deep] ERROR:", (e as Error).message);
  process.exit(1);
});
