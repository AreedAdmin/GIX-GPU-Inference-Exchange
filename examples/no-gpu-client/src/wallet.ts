/**
 * The client's own wallet.
 *
 * Generates a fresh Ed25519 keypair on first run and persists it (bech32
 * `suiprivkey1…`) in `./.wallet` (gitignored), so a non-expert on a Mac gets a
 * self-custodied address with zero setup. Subsequent runs reload it.
 *
 * Self-funding (`--fund`):
 *   - SUI gas: requested from the configured faucet (localnet :9123 / devnet /
 *     testnet). On mainnet (no faucet) we just print the address.
 *   - MOCK_USDC: minted via the package's `mock_usdc::mint` against the shared
 *     Faucet object (dev-only / unrestricted on localnet+devnet+testnet test
 *     deploys). On testnet, if minting is gated, we print the manual faucet URL.
 */

import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import type { GixConfig } from "./config.js";

export const WALLET_PATH = resolve(process.cwd(), ".wallet");

export interface Wallet {
  keypair: Ed25519Keypair;
  address: string;
}

/** Load the wallet from ./.wallet, or generate + persist a new one. */
export async function loadOrCreateWallet(path = WALLET_PATH): Promise<{
  wallet: Wallet;
  created: boolean;
}> {
  const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
  const { decodeSuiPrivateKey } = await import("@mysten/sui/cryptography");

  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8").trim();
    const { secretKey } = decodeSuiPrivateKey(raw);
    const keypair = Ed25519Keypair.fromSecretKey(secretKey);
    return { wallet: { keypair, address: keypair.toSuiAddress() }, created: false };
  }

  const keypair = new Ed25519Keypair();
  const bech32 = keypair.getSecretKey(); // suiprivkey1…
  writeFileSync(path, bech32 + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort on non-POSIX */
  }
  return { wallet: { keypair, address: keypair.toSuiAddress() }, created: true };
}

/** Request SUI gas from the configured faucet. Returns a short status string. */
export async function fundSui(cfg: GixConfig, address: string): Promise<string> {
  if (!cfg.suiFaucetUrl) {
    return cfg.network === "mainnet"
      ? "mainnet has no faucet — fund SUI manually"
      : "no SUI faucet configured (set SUI_FAUCET_URL)";
  }
  const { requestSuiFromFaucetV2 } = await import("@mysten/sui/faucet");
  // @mysten/sui 2.x only ships the v2 faucet protocol (v1/v0 were removed); modern
  // localnet/devnet/testnet faucets all speak v2.
  const attempts: Array<() => Promise<unknown>> = [
    () => requestSuiFromFaucetV2({ host: cfg.suiFaucetUrl, recipient: address }),
  ];
  let lastErr: unknown;
  for (const attempt of attempts) {
    try {
      await attempt();
      return `requested SUI gas from ${cfg.suiFaucetUrl}`;
    } catch (e) {
      lastErr = e;
    }
  }
  return `SUI faucet request failed: ${errMsg(lastErr)} (fund manually at ${cfg.suiFaucetUrl})`;
}

/**
 * Mint MOCK_USDC to the wallet via the package faucet:
 *   mock_usdc::mint(faucet, amount, recipient, ctx)  (dev faucet, unrestricted).
 * Needs the wallet to already hold a little SUI for gas, so call after fundSui.
 */
export async function fundUsdc(
  client: SuiJsonRpcClient,
  cfg: GixConfig,
  wallet: Wallet,
  amount: bigint,
): Promise<string> {
  const { Transaction } = await import("@mysten/sui/transactions");
  const tx = new Transaction();
  tx.moveCall({
    target: `${cfg.packageId}::mock_usdc::mint`,
    arguments: [
      tx.object(cfg.faucetId),
      tx.pure.u64(amount),
      tx.pure.address(wallet.address),
    ],
  });
  tx.setSender(wallet.address);
  try {
    const res = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: wallet.keypair,
      options: { showEffects: true },
    });
    await client.waitForTransaction({ digest: res.digest });
    if (res.effects?.status.status !== "success") {
      throw new Error(res.effects?.status.error ?? "mint failed");
    }
    return `minted ${amount} MOCK_USDC (base units) via mock_usdc::mint`;
  } catch (e) {
    return (
      `MOCK_USDC mint failed: ${errMsg(e)}. ` +
      `On a gated network, request MOCK_USDC from the deploy operator / faucet UI.`
    );
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
