#!/usr/bin/env node
/**
 * onramp-smoke.ts — a tiny, frugal, REAL SUI → DBUSDC swap on testnet.
 *
 * Proves the GIX on-ramp end-to-end against the LIVE DeepBook testnet pool
 *   SUI_DBUSDC (0x1c19362ca5… , base = SUI, quote = DBUSDC)
 * using `pool::swap_exact_base_for_quote` with INPUT-COIN FEES (deepAmount: 0 ⇒
 * pay_with_deep: false), so it needs NO DEEP and works today.
 *
 *  1. Load the local keystore key (~/.sui/sui_config/sui.keystore, first key) —
 *     the same funded testnet address the Sui CLI uses (0xb8e7…).
 *  2. DRY-RUN: read the live SUI_DBUSDC price/estimate. If the pool can't be
 *     priced or is unreachable, STOP before spending and report.
 *  3. Print SUI + DBUSDC balances BEFORE.
 *  4. Swap ~0.1 SUI → DBUSDC (real on-chain testnet txn).
 *  5. Print the digest, DBUSDC received, balances AFTER, and an explorer link.
 *
 * Frugal by design: the swap is ~0.1 SUI and total spend stays well under 0.3 SUI.
 *
 * Usage:
 *   tsx scripts/onramp-smoke.ts [--amount 0.1] [--slippage-bps 100] [--dry-run]
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  OnRampClient,
  TESTNET_DBUSDC_COIN_TYPE,
  TESTNET_SUI_DBUSDC_POOL_ID,
} from "../src/onramp.js";

const EXPLORER_TX_BASE = "https://suiscan.xyz/testnet/tx";

function getArg(flag: string, def?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function fmtSui(base: bigint): string {
  return (Number(base) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 6 });
}
function fmtDbusdc(base: bigint): string {
  return (Number(base) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 });
}

async function loadKeypair() {
  const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
  const ks = JSON.parse(
    readFileSync(homedir() + "/.sui/sui_config/sui.keystore", "utf8"),
  ) as string[];
  const raw = Buffer.from(ks[0]!, "base64");
  if (raw[0] !== 0) {
    throw new Error(`expected an Ed25519 keystore key (flag 0), got flag ${raw[0]}`);
  }
  return Ed25519Keypair.fromSecretKey(new Uint8Array(raw.subarray(1)));
}

async function main() {
  const amountSui = Number(getArg("--amount", "0.1"));
  const slippageBps = Number(getArg("--slippage-bps", "100"));
  const dryRunOnly = hasFlag("--dry-run");
  // The live SUI_DBUSDC pool enforces a 1-SUI minimum order size, so a sub-1-SUI
  // swap matches NOTHING. To honor the frugal "< 0.3 SUI" budget by default, any
  // swap above 0.3 SUI is refused UNLESS `--yes` explicitly authorizes spending
  // the real minimum (~1.1 SUI) so a genuine on-chain swap can be demonstrated.
  const FRUGAL_CAP_SUI = 0.3;
  const HARD_CAP_SUI = 1.5; // never spend more than this, even with --yes
  const authorized = hasFlag("--yes");

  if (!(amountSui > 0)) throw new Error(`--amount must be > 0 (got ${amountSui})`);
  if (amountSui > HARD_CAP_SUI) {
    throw new Error(
      `--amount ${amountSui} SUI exceeds the hard cap (${HARD_CAP_SUI}). Refusing to spend.`,
    );
  }
  if (amountSui > FRUGAL_CAP_SUI && !authorized && !dryRunOnly) {
    throw new Error(
      `--amount ${amountSui} SUI exceeds the frugal cap (${FRUGAL_CAP_SUI}). The live ` +
        `SUI_DBUSDC pool min order size is 1 SUI, so a real fill needs ~1.1 SUI. ` +
        `Re-run with --yes to authorize spending up to ${HARD_CAP_SUI} SUI.`,
    );
  }

  const signer = await loadKeypair();
  const sender = signer.getPublicKey().toSuiAddress();
  console.error(`signer:  ${sender}`);
  console.error(`pool:    SUI_DBUSDC  ${TESTNET_SUI_DBUSDC_POOL_ID}`);
  console.error(`dbusdc:  ${TESTNET_DBUSDC_COIN_TYPE}`);
  console.error(`amount:  ${amountSui} SUI  (input-coin fees, NO DEEP)\n`);

  const onramp = new OnRampClient({
    network: "testnet",
    logger: (m, x) => console.error(`  · ${m}`, x ?? ""),
  });

  // 1. DRY-RUN: price the swap. STOP before spending if nothing would fill (e.g.
  //    the amount is below the pool's 1-SUI min order size) or the pool is down.
  let quote;
  try {
    quote = await onramp.quote(amountSui);
  } catch (e) {
    console.error("\nDRY-RUN: swap would NOT fill — NOT spending. (This is the safe stop.)");
    console.error(`  ${(e as Error).message}`);
    console.error(
      `\n  The live SUI_DBUSDC pool requires ≥ ~1.1 SUI to clear its 1-SUI min ` +
        `order size.\n  To run a REAL swap, re-run with:  tsx scripts/onramp-smoke.ts ` +
        `--amount 1.1 --yes`,
    );
    console.log(
      JSON.stringify(
        { dryRun: true, filled: false, amountSui, reason: (e as Error).message },
        null,
        2,
      ),
    );
    process.exit(2);
  }
  console.error("dry-run quote:");
  console.error(`  est. DBUSDC out : ${quote.dbusdcOut.toFixed(6)} DBUSDC`);
  console.error(`  SUI that fills   : ${quote.suiFilled.toFixed(6)} SUI`);
  console.error(`  price           : ${quote.priceDbusdcPerSui.toFixed(6)} DBUSDC/SUI`);
  console.error(`  DEEP required   : ${quote.deepRequired}  (input-fee path)\n`);

  // 2. Balances BEFORE.
  const before = await onramp.balances(sender);
  console.error("balances before:");
  console.error(`  SUI    : ${fmtSui(before.sui)}`);
  console.error(`  DBUSDC : ${fmtDbusdc(before.dbusdc)}\n`);

  if (before.sui < BigInt(Math.ceil(amountSui * 1e9)) + 50_000_000n) {
    console.error("INSUFFICIENT SUI for the swap + gas. NOT spending.");
    process.exit(2);
  }

  if (dryRunOnly) {
    console.error("--dry-run set: priced + validated, not executing. Done.");
    console.log(
      JSON.stringify(
        { dryRun: true, amountSui, estDbusdcOut: quote.dbusdcOut, price: quote.priceDbusdcPerSui },
        null,
        2,
      ),
    );
    return;
  }

  // 3. EXECUTE the real swap.
  console.error("executing swap…");
  const result = await onramp.swapSuiForDbusdc(amountSui, signer, { slippageBps });

  // 4. Balances AFTER.
  const after = await onramp.balances(sender);
  const explorer = `${EXPLORER_TX_BASE}/${result.digest}`;

  console.error("\n=== SWAP OK ===");
  console.error(`digest          : ${result.digest}`);
  console.error(`explorer        : ${explorer}`);
  console.error(`DBUSDC received  : ${result.dbusdcReceived.toFixed(6)} DBUSDC`);
  console.error(`SUI net delta    : ${result.suiDelta.toFixed(6)} SUI  (swap + gas)`);
  console.error(`min-out floor    : ${fmtDbusdc(result.minOutBase)} DBUSDC`);
  console.error("\nbalances after:");
  console.error(`  SUI    : ${fmtSui(after.sui)}   (was ${fmtSui(before.sui)})`);
  console.error(`  DBUSDC : ${fmtDbusdc(after.dbusdc)}   (was ${fmtDbusdc(before.dbusdc)})`);

  // Machine-readable summary on stdout.
  console.log(
    JSON.stringify(
      {
        digest: result.digest,
        explorer,
        amountSui,
        dbusdcReceived: result.dbusdcReceived,
        suiDelta: result.suiDelta,
        balancesBefore: { sui: before.sui.toString(), dbusdc: before.dbusdc.toString() },
        balancesAfter: { sui: after.sui.toString(), dbusdc: after.dbusdc.toString() },
        dbusdcType: TESTNET_DBUSDC_COIN_TYPE,
        poolId: TESTNET_SUI_DBUSDC_POOL_ID,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
