// web/src/trade/burner.ts
// A faucet-funded BURNER Ed25519 key for dev signing on localnet (UI contract §5,
// demo-milestone-contract §5). dapp-kit wallets target testnet/mainnet, so on localnet
// we generate + persist a burner in localStorage and drive it directly. On testnet the
// real wallet-connect path (dapp-kit) is used instead (see wallet/WalletProvider.tsx).
//
// The SDK lazily imports @mysten/sui to keep the module graph light; here we do the same
// dynamic import so the heavy crypto only loads when the user actually connects.

import type { ChainConfig } from "./config";

type Ed25519KeypairT = import("@mysten/sui/keypairs/ed25519").Ed25519Keypair;

const STORAGE_KEY = "gix.burner.secretKey.v1";

/** A signer the OrderClient can use to sign + execute PTBs. Satisfied by both the
 *  burner keypair (localnet) and a dapp-kit wallet adapter (testnet). */
export interface WalletSigner {
  address: string;
  /** Sign + execute a built Transaction against the given SuiClient. Returns the digest. */
  signAndExecute(
    client: import("@mysten/sui/jsonRpc").SuiJsonRpcClient,
    tx: import("@mysten/sui/transactions").Transaction,
  ): Promise<{ digest: string; objectChanges?: unknown; events?: unknown }>;
}

/** Load the persisted burner secret key, or null if none stored yet. */
function loadStoredSecret(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeSecret(secret: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, secret);
  } catch {
    /* localStorage unavailable (private mode) — burner is ephemeral this session */
  }
}

/** Get-or-create the persisted burner keypair. Persists the bech32 secret in localStorage. */
export async function getBurnerKeypair(): Promise<Ed25519KeypairT> {
  const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
  const stored = loadStoredSecret();
  if (stored) {
    try {
      return Ed25519Keypair.fromSecretKey(stored);
    } catch {
      /* corrupt key — regenerate below */
    }
  }
  const kp = Ed25519Keypair.generate();
  // getSecretKey() returns the bech32 `suiprivkey1...` form fromSecretKey accepts.
  storeSecret(kp.getSecretKey());
  return kp;
}

/** Build a WalletSigner backed by the persisted burner keypair (localnet dev signing). */
export async function makeBurnerSigner(): Promise<WalletSigner> {
  const kp = await getBurnerKeypair();
  const address = kp.toSuiAddress();
  return {
    address,
    async signAndExecute(client, tx) {
      const res = await client.signAndExecuteTransaction({
        transaction: tx,
        signer: kp,
        options: { showEffects: true, showEvents: true, showObjectChanges: true },
      });
      // Block until the fullnode indexes the digest so the next owned-object / gas read
      // sees fresh state (mirrors harness/src/chain/sui.ts exec()).
      await client.waitForTransaction({ digest: res.digest });
      const status = res.effects?.status;
      if (status && status.status !== "success") {
        throw new Error(`tx ${res.digest} failed: ${status.error ?? "unknown error"}`);
      }
      return {
        digest: res.digest,
        objectChanges: res.objectChanges,
        events: res.events,
      };
    },
  };
}

/** Reset the burner (drop the stored key) — exposed for a "new burner" affordance. */
export function clearBurner(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* noop */
  }
}

/** Request test SUI for gas from the localnet/testnet faucet (Ed25519 burner). */
export async function fundSuiFromFaucet(cfg: ChainConfig, address: string): Promise<void> {
  const { requestSuiFromFaucetV2, getFaucetHost } = await import("@mysten/sui/faucet");
  const host =
    cfg.network === "localnet"
      ? cfg.faucetUrl
      : (() => {
          try {
            return getFaucetHost(cfg.network as "testnet" | "devnet");
          } catch {
            return cfg.faucetUrl;
          }
        })();
  await requestSuiFromFaucetV2({ host, recipient: address });
}

/** Mint MOCK_USDC to the address via the package's mock_usdc::mint faucet (signed by the
 *  burner — the localnet faucet is unrestricted, demo-milestone-contract §6). amount is in
 *  base units (6dp). */
export async function mintMockUsdc(
  cfg: ChainConfig,
  signer: WalletSigner,
  client: import("@mysten/sui/jsonRpc").SuiJsonRpcClient,
  amountBaseUnits: number,
): Promise<string> {
  const { Transaction } = await import("@mysten/sui/transactions");
  const tx = new Transaction();
  // mock_usdc::mint(faucet, amount, recipient, ctx) — transfers Coin<MOCK_USDC> to recipient.
  tx.moveCall({
    target: `${cfg.packageId}::mock_usdc::mint`,
    arguments: [
      tx.object(cfg.faucetId),
      tx.pure.u64(BigInt(amountBaseUnits)),
      tx.pure.address(signer.address),
    ],
  });
  const res = await signer.signAndExecute(client, tx);
  return res.digest;
}
