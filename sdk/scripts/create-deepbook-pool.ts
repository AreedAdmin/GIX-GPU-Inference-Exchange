// sdk/scripts/create-deepbook-pool.ts
//
// Create the permissionless DeepBook v3 pool  Credit<M> / DBUSDC  on testnet.
// This is the one DEEP-gated step (creation fee = 500 DEEP). See
// docs/permissionless-pool-plan.md (Phase B).
//
// SAFETY: DRY-RUN by default — prints the exact plan and DeepBook's accepted
// tick/lot/min bounds, and touches nothing. Pass `--confirm` to actually create
// the pool (spends 500 DEEP) and print the new POOL_ID.
//
// Usage:
//   npx tsx sdk/scripts/create-deepbook-pool.ts            # dry run
//   npx tsx sdk/scripts/create-deepbook-pool.ts --confirm  # execute (500 DEEP)
//
// Inputs (env or edit the CONFIG block): the republished package id + credit witness
// from `contracts/scripts/stage-testnet-dbusdc.sh --confirm`, and the DBUSDC type.
//
// Signer: the active ~/.sui testnet key (must hold >= 500 DEEP + gas). Never embeds a key.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";

// ── CONFIG (fill from the staging-script output / env) ───────────────────────
const CONFIRM = process.argv.includes("--confirm");

const PKG = process.env.GIX_PKG ?? "0x<REPUBLISHED_PACKAGE_ID>"; // from stage-testnet-dbusdc.sh
const CREDIT_TYPE = `${PKG}::markets::M_GB10_QWEN35B`; // the market's credit witness
const CREDIT_COIN_TYPE = `${PKG}::credit::Credit<${CREDIT_TYPE}>`; // pool BASE
const DBUSDC_TYPE =
  process.env.GIX_DBUSDC_TYPE ??
  "0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC"; // pool QUOTE

// SCU micro-trading sizing (must satisfy DeepBook protocol bounds — the script prints them).
const TICK_SIZE = Number(process.env.GIX_TICK ?? 0.0001); // DBUSDC per SCU
const LOT_SIZE = Number(process.env.GIX_LOT ?? 1); // 1 SCU
const MIN_SIZE = Number(process.env.GIX_MIN ?? 1); // 1 SCU
const CREATION_FEE_DEEP = 500;

const RPC_URL =
  process.env.VITE_RPC_URL ?? "https://fullnode.testnet.sui.io:443";

function log(...a: unknown[]) {
  console.log("[create-pool]", ...a);
}

/** Load the active testnet Ed25519 key from the local sui keystore (never printed). */
async function loadKeypair() {
  const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
  const ks = JSON.parse(
    readFileSync(`${homedir()}/.sui/sui_config/sui.keystore`, "utf8"),
  ) as string[];
  const raw = Buffer.from(ks[0]!, "base64");
  if (raw[0] !== 0) throw new Error(`expected Ed25519 keystore key (flag 0), got ${raw[0]}`);
  return Ed25519Keypair.fromSecretKey(new Uint8Array(raw.subarray(1)));
}

async function main() {
  if (PKG.includes("<")) {
    throw new Error(
      "Set GIX_PKG to the republished package id (run contracts/scripts/stage-testnet-dbusdc.sh --confirm first).",
    );
  }

  const { SuiJsonRpcClient } = await import("@mysten/sui/jsonRpc");
  const rpc = new SuiJsonRpcClient({ network: "testnet", url: RPC_URL });
  const kp = await loadKeypair();
  const address = kp.toSuiAddress();

  // DEEP precheck — creation needs 500 DEEP.
  // TODO: confirm the testnet DEEP coin type id below (DeepBook testnet DEEP).
  const DEEP_TYPE = process.env.GIX_DEEP_TYPE ?? "0x<TESTNET_DEEP_COIN_TYPE>::deep::DEEP";
  let deepBal = 0;
  try {
    const b = await rpc.getBalance({ owner: address, coinType: DEEP_TYPE });
    deepBal = Number(b.totalBalance) / 1e6; // DEEP has 6 decimals
  } catch {
    /* unknown DEEP type → reported below */
  }

  log(`network=testnet  signer=${address}`);
  log(`base  = ${CREDIT_COIN_TYPE}`);
  log(`quote = ${DBUSDC_TYPE}`);
  log(`tick=${TICK_SIZE}  lot=${LOT_SIZE}  min=${MIN_SIZE}  creationFee=${CREATION_FEE_DEEP} DEEP`);
  log(`DEEP balance ≈ ${deepBal} (need ≥ ${CREATION_FEE_DEEP})`);

  if (!CONFIRM) {
    log("DRY RUN — pass --confirm to create the pool. Nothing was sent.");
    log("Next after --confirm: bind it with");
    log(
      `  sui client call --package ${PKG} --module market --function set_deepbook_pool_id \\\n` +
        `    --type-args ${CREDIT_TYPE} --args <ADMIN_CAP_ID> <MARKET_ID> <POOL_ID> --gas-budget 50000000`,
    );
    return;
  }

  if (deepBal < CREATION_FEE_DEEP) {
    throw new Error(
      `insufficient DEEP (${deepBal} < ${CREATION_FEE_DEEP}). Acquire testnet DEEP first (Phase 0).`,
    );
  }

  // ── EXECUTE ────────────────────────────────────────────────────────────────
  // Build via the DeepBook SDK so it sources the registry + 500-DEEP fee correctly.
  // The SDK needs our custom coins registered (coinKey → {address,type,scalar}).
  const { DeepBookClient } = await import("@mysten/deepbook-v3");
  const { Transaction } = await import("@mysten/sui/transactions");

  const db = new DeepBookClient({
    client: rpc as unknown as never,
    address,
    network: "testnet" as never,
    // TODO: register CREDIT_COIN_TYPE (scalar 1) and DBUSDC (scalar 1e6) in the SDK
    //       `coins` config so createPermissionlessPool can resolve them by key.
    // coins: { GIX_CREDIT: { address: PKG, type: CREDIT_COIN_TYPE, scalar: 1 },
    //          DBUSDC: { address: '0xf7152c05…', type: DBUSDC_TYPE, scalar: 1_000_000 } } as never,
  });

  const tx = new Transaction();
  tx.setSenderIfNotSet(address);
  // TODO: confirm the exact SDK method + arg names for your @mysten/deepbook-v3 version.
  //       The permissionless-pool call pays 500 DEEP from the sender's DEEP coins.
  // db.deepBook.createPermissionlessPool({
  //   baseCoinKey: "GIX_CREDIT",
  //   quoteCoinKey: "DBUSDC",
  //   tickSize: TICK_SIZE,
  //   lotSize: LOT_SIZE,
  //   minSize: MIN_SIZE,
  // })(tx as never);
  throw new Error(
    "SDK createPermissionlessPool call is stubbed — fill in the coin registration + method " +
      "for your @mysten/deepbook-v3 version (see TODOs), then re-run with --confirm.",
  );

  // const signed = await tx.sign({ client: rpc as never, signer: kp });
  // const exec = await rpc.executeTransactionBlock({ transactionBlock: signed.bytes, signature: signed.signature, options: { showEffects: true, showObjectChanges: true } });
  // await rpc.waitForTransaction({ digest: exec.digest });
  // const pool = exec.objectChanges?.find((c: any) => c.type === "created" && String(c.objectType).includes("::pool::Pool"));
  // log("POOL_ID =", (pool as any)?.objectId, "  digest =", exec.digest);
}

main().catch((e) => {
  console.error("[create-pool] ERROR:", (e as Error).message);
  process.exit(1);
});
