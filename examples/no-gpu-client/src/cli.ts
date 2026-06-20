#!/usr/bin/env node
/**
 * GIX GPU-less consumer client.
 *
 * Run on ANY computer (no GPU, no Ollama, no local chain) to buy a real
 * inference from a remote GB10 provider, pay for it on-chain in MOCK_USDC, and
 * print the cryptographically verified answer.
 *
 *   npm start -- "Your prompt here"
 *   npm start -- --prompt "Your prompt here" --fund
 *   npm start -- --config ./config.json "Your prompt here"
 *
 * Flow (demo-milestone-contract §3.1 + INTERFACE.md two-account buy):
 *   1. POST {prompt} -> provider /inputs        => inputHash
 *   2. job::create_job_from_ask<M>(...)         => Job id, funds MOCK_USDC escrow
 *   3. await Settled / AttestationSubmitted     => on-chain output_hash
 *   4. GET /result/:jobId                        => the answer
 *   5. re-hash output (sha2_256) vs on-chain output_hash => verified yes/no
 */

import { loadConfig, missingRequired, type GixConfig } from "./config.js";
import { loadOrCreateWallet, fundSui, fundUsdc, WALLET_PATH, type Wallet } from "./wallet.js";
import { Chain } from "./chain.js";
import { ProviderClient } from "./provider.js";
import { sha2_256Hex, verifyOutput } from "./hash.js";

interface Args {
  prompt?: string;
  configPath?: string;
  fund: boolean;
  scuQty?: number;
  ask?: string;
  provider?: string;
  rpc?: string;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { fund: false, help: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    switch (t) {
      case "--prompt":
      case "-p":
        a.prompt = argv[++i];
        break;
      case "--config":
      case "-c":
        a.configPath = argv[++i];
        break;
      case "--fund":
        a.fund = true;
        break;
      case "--scu":
        a.scuQty = Number(argv[++i]);
        break;
      case "--ask":
        a.ask = argv[++i];
        break;
      case "--provider":
        a.provider = argv[++i];
        break;
      case "--rpc":
        a.rpc = argv[++i];
        break;
      case "--help":
      case "-h":
        a.help = true;
        break;
      default:
        if (!t.startsWith("-")) positional.push(t);
    }
  }
  if (a.prompt === undefined && positional.length > 0) a.prompt = positional.join(" ");
  return a;
}

const USAGE = `
gix-buy — buy a verified inference from a remote GPU (no GPU needed locally)

Usage:
  npm start -- "Your prompt here"
  npm start -- --prompt "Your prompt" [--fund] [--config ./config.json]

Options:
  -p, --prompt <text>   The prompt to run (or pass it positionally).
  -c, --config <path>   Path to a config.json (overrides bundled deployment.json).
      --fund            Self-fund the wallet (SUI gas + MOCK_USDC) before buying.
      --scu <n>         SCU quantity to buy (default 1).
      --ask <0x..>      Provider's shared Ask<M> id (else ASK_ID / config).
      --provider <url>  Provider base URL (else PROVIDER_URL / config).
      --rpc <url>       Sui RPC URL (else RPC_URL / network default).
  -h, --help            Show this help.

Config sources (low->high): bundled deployment.json < config.json < env < flags.
ASK_ID + PROVIDER_URL come from the running provider node; the chain ids default
from deployment.json. Wallet persists in ./.wallet (gitignored).
`;

function fmtUsdc(base: bigint | number | undefined): string {
  if (base === undefined) return "n/a";
  const v = typeof base === "bigint" ? base : BigInt(Math.round(base));
  const dollars = Number(v) / 1e6; // MOCK_USDC = 6 decimals
  return `${dollars.toFixed(6)} USDC (${v} base units)`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }

  // 1. Resolve config (deployment.json defaults + overrides). Skip the hard
  //    require check until after we know whether the user even gave a prompt.
  let cfg: GixConfig;
  try {
    cfg = loadConfig({
      configPath: args.configPath,
      // Don't hard-require ASK_ID/PROVIDER_URL here — the wallet + --fund helper
      // run first; the buy step re-checks via missingRequired() below.
      requireAll: false,
      overrides: {
        ...(args.ask ? { askId: args.ask } : {}),
        ...(args.provider ? { providerUrl: args.provider } : {}),
        ...(args.rpc ? { rpcUrl: args.rpc } : {}),
        ...(args.scuQty ? { scuQty: args.scuQty } : {}),
      },
    });
  } catch (e) {
    fail((e as Error).message);
    return;
  }

  if (!args.prompt && !args.fund) {
    process.stdout.write(USAGE);
    fail('no prompt given. Try: npm start -- "What is the capital of France?"');
    return;
  }

  // 2. Wallet — generate/persist + print address.
  const { wallet, created } = await loadOrCreateWallet();
  line();
  log(`Wallet:   ${wallet.address}`);
  log(`          ${created ? "(new wallet generated)" : "(loaded)"} -> ${WALLET_PATH}`);
  log(`Network:  ${cfg.network}  RPC ${cfg.rpcUrl}`);

  const { SuiClient } = await import("@mysten/sui/client");
  const { Transaction } = await import("@mysten/sui/transactions");
  const client = new SuiClient({ url: cfg.rpcUrl });
  const chain = new Chain(
    client as unknown as ConstructorParameters<typeof Chain>[0],
    Transaction as unknown as new () => InstanceType<typeof Transaction>,
    {
      packageId: cfg.packageId,
      configId: cfg.configId,
      marketId: cfg.marketId,
      creditType: cfg.creditType,
      usdcType: cfg.usdcType,
      clockId: cfg.clockId,
      logger: (m, x) => log(`  · ${m}${x ? " " + JSON.stringify(x) : ""}`, true),
    },
  );

  // 3. Optional self-funding (fresh Mac wallet on localnet/devnet/testnet).
  if (args.fund) {
    line();
    log("Funding wallet…");
    log(`  SUI gas:   ${await fundSui(cfg, wallet.address)}`);
    // Give the faucet a moment so the gas coin is queryable before the USDC mint.
    await sleep(2500);
    log(`  MOCK_USDC: ${await fundUsdc(client, cfg, wallet as Wallet, 1_000_000n)}`);
    await sleep(1500);
  }

  // Balances snapshot.
  const [suiBal, usdcBal] = await Promise.all([
    chain.suiBalance(wallet.address).catch(() => 0n),
    chain.usdcBalance(wallet.address).catch(() => 0n),
  ]);
  log(`Balances: ${Number(suiBal) / 1e9} SUI   ${fmtUsdc(usdcBal)}`);

  if (!args.prompt) {
    line();
    log("Funded. Re-run with a prompt to buy:  npm start -- \"your prompt\"");
    return;
  }

  // Now the buy requires ASK_ID + PROVIDER_URL.
  const missing = missingRequired(cfg);
  if (missing.length > 0) {
    fail(
      `cannot buy — missing: ${missing.join(", ")}.\n` +
        `ASK_ID + PROVIDER_URL come from the running provider node (AskPosted event / its URL).`,
    );
    return;
  }

  const provider = new ProviderClient(cfg.providerUrl);
  const t0 = Date.now();

  // 4. POST prompt -> provider /inputs -> inputHash.
  line();
  log(`Prompt:   ${truncate(args.prompt, 120)}`);
  const health = await provider.health();
  log(`Provider: ${cfg.providerUrl}  ${health.ok ? `(ok, model=${health.model ?? "?"}, gpu=${health.gpu ?? "?"})` : "(no /health)"}`);

  const { inputHash } = await provider.submitInput(args.prompt);
  const localInputHash = sha2_256Hex(args.prompt);
  if (localInputHash !== inputHash.replace(/^0x/, "")) {
    log(`  ! provider inputHash ${inputHash} != local sha2_256 ${localInputHash} — using local`);
  }
  log(`inputHash: ${localInputHash}`);

  // 5. Read the ask, then create_job_from_ask funding the exact escrow.
  const ask = await chain.readAsk(cfg.askId);
  const scuQty = BigInt(cfg.scuQty);
  if (ask.remainingScu < scuQty) {
    fail(`ask ${cfg.askId} has only ${ask.remainingScu} SCU remaining (< ${scuQty} requested)`);
    return;
  }
  const escrow = scuQty * ask.pricePerScu;
  log(`Ask:      ${cfg.askId}`);
  log(`          price ${fmtUsdc(ask.pricePerScu)}/SCU · buying ${scuQty} SCU · escrow ${fmtUsdc(escrow)}`);
  if (usdcBal < escrow) {
    fail(`insufficient MOCK_USDC: have ${fmtUsdc(usdcBal)}, need ${fmtUsdc(escrow)}. Re-run with --fund.`);
    return;
  }

  log("Buying compute (create_job_from_ask)…");
  const { jobId, digest } = await chain.createJobFromAsk({
    keypair: wallet.keypair,
    askId: cfg.askId,
    scuQty,
    pricePerScu: ask.pricePerScu,
    inputHashHex: localInputHash,
  });
  log(`jobId:    ${jobId}`);
  log(`tx:       ${digest}`);
  if (cfg.explorerTxBase) log(`          ${cfg.explorerTxBase}/${digest}`);

  // 6. Await terminal event (provider serves + attests + settles).
  log("Waiting for the provider to serve + settle on-chain…");
  const terminal = await chain.awaitSettlement(jobId, { timeoutMs: 120_000, intervalMs: 2000 });
  log(`state:    ${terminal.state}${terminal.verdict !== undefined ? ` (verdict=${terminal.verdict})` : ""}`);

  // 7. GET /result/:jobId, then re-hash output vs on-chain output_hash.
  const result = await provider.awaitResult(jobId, { timeoutMs: 60_000, intervalMs: 1500 });
  const onChainHash = terminal.outputHashOnChain ?? result.outputHash;
  const verified = verifyOutput(result.output, onChainHash);
  const latencyMs = Date.now() - t0;

  // 8. Pretty print.
  printAnswer({
    output: result.output,
    verified,
    jobId,
    digest,
    cost: terminal.payoutUsdc ?? Number(escrow),
    latencyMs,
    model: result.model,
    explorer: cfg.explorerTxBase ? `${cfg.explorerTxBase}/${digest}` : undefined,
    localHash: sha2_256Hex(result.output),
    onChainHash: onChainHash.replace(/^0x/, ""),
  });

  if (!verified) {
    process.exitCode = 2; // answer did not verify — do not trust it.
  }
}

function printAnswer(r: {
  output: string;
  verified: boolean;
  jobId: string;
  digest: string;
  cost: number;
  latencyMs: number;
  model: string;
  explorer?: string;
  localHash: string;
  onChainHash: string;
}): void {
  const bar = "─".repeat(64);
  const check = r.verified ? "✓ verified" : "✗ NOT VERIFIED";
  process.stdout.write("\n" + bar + "\n");
  process.stdout.write("ANSWER\n");
  process.stdout.write(bar + "\n");
  process.stdout.write(r.output.trim() + "\n");
  process.stdout.write(bar + "\n");
  process.stdout.write(`${check}   (sha2_256 ${r.verified ? "matches" : "MISMATCH"})\n`);
  if (!r.verified) {
    process.stdout.write(`   local   = ${r.localHash}\n`);
    process.stdout.write(`   onchain = ${r.onChainHash}\n`);
  }
  process.stdout.write(`model     ${r.model}\n`);
  process.stdout.write(`jobId     ${r.jobId}\n`);
  process.stdout.write(`cost      ${fmtUsdc(r.cost)}\n`);
  process.stdout.write(`latency   ${(r.latencyMs / 1000).toFixed(1)}s\n`);
  if (r.explorer) process.stdout.write(`explorer  ${r.explorer}\n`);
  process.stdout.write(bar + "\n");
}

// --- tiny output helpers ---------------------------------------------------

let verbose = process.env.GIX_VERBOSE === "1";
function log(m: string, onlyVerbose = false): void {
  if (onlyVerbose && !verbose) return;
  process.stdout.write(m + "\n");
}
function line(): void {
  process.stdout.write("\n");
}
function fail(m: string): void {
  process.stderr.write(`\nerror: ${m}\n`);
  process.exitCode = 1;
}
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  fail((e as Error)?.message ?? String(e));
  process.exitCode = 1;
});
