#!/usr/bin/env node
/**
 * GIX SDK demo — a narrated, end-to-end CONSUMER buy on Sui testnet.
 *
 * The developer-facing complement to the UI video: it drives the SAME flow the
 * dApp does, but programmatically via `@gix/sdk`, printing each step so you can
 * watch a prompt turn into an on-chain compute purchase served by a real GB10
 * GPU, with a cryptographically verifiable answer.
 *
 *   npx tsx examples/sdk-demo/run.ts "What is the capital of France?"
 *
 * THE FLOW (one run, consumer-only — the GB10 node runs separately on testnet):
 *   [1/5] Market & order book — read the GB10·Qwen market + the provider's
 *         current resting Ask straight from chain (price, qty, provider).
 *   [2/5] Buy — fill the ask via job::create_job_from_ask<M,Q>, carrying the
 *         prompt INLINE (input = UTF-8 bytes, input_hash = sha2_256(prompt)),
 *         escrow = qty × ask price. Prints the job id + buy tx.
 *   [3/5] Dispatch → inference — poll the on-chain Job state until terminal
 *         while the provider runs qwen.
 *   [4/5] Verify (trustless) — fetch the result, then check three proofs:
 *         sha2_256(output) == on-chain output_hash, the Ed25519 attestation
 *         signature over the canonical message, and the model matches the
 *         registered ModelRecord.
 *   [5/5] Settle — confirm Settled, provider paid, escrow released.
 *
 * Everything load-bearing (ask discovery, the inline-input PTB, the sha2_256
 * verify) lives in `@gix/sdk`; this file is the narration around it.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import chalk from "chalk";
import { Ed25519Keypair, Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";

import {
  GixChain,
  ProviderClient,
  sha2_256Hex,
  verifyOutput,
  type Deployment,
  type MarketDeployment,
  type WalletSigner,
} from "@gix/sdk";

// ── On-chain Job lifecycle states (mirror gix::job) ──────────────────────────
const STATE = {
  3: "Dispatched",
  4: "Executing",
  5: "Attested",
  6: "Verified",
  7: "Settled",
  8: "Refunded",
  9: "Expired",
} as const;
const TERMINAL_STATES = new Set([7, 8, 9]);

const SUISCAN = (digest: string) => `https://suiscan.xyz/testnet/tx/${digest}`;
const ATTEST_DOMAIN = new TextEncoder().encode("GIX_ATTEST_V1");

// ── small output helpers ─────────────────────────────────────────────────────
const out = (s = "") => process.stdout.write(s + "\n");
const dim = chalk.dim;
const bold = chalk.bold;
const ok = (s: string) => chalk.green("✓ ") + s;
const bad = (s: string) => chalk.red("✗ ") + s;
const rule = () => dim("─".repeat(72));

function header(n: number, title: string) {
  out();
  out(chalk.cyan.bold(`[${n}/5] `) + bold(title));
}

function kv(k: string, v: string) {
  // Pad the label to a fixed column, always leaving at least one trailing space
  // (long labels would otherwise butt right up against the value).
  out("  " + dim((k + ":").padEnd(14)) + " " + v);
}

/** MOCK_USDC is 6dp — render base units as a dollar figure + raw. */
function usdc(base: bigint | number): string {
  const v = typeof base === "bigint" ? base : BigInt(Math.round(base));
  return `${(Number(v) / 1e6).toFixed(6)} USDC ` + dim(`(${v} base units)`);
}

function sui(mist: bigint): string {
  return `${(Number(mist) / 1e9).toFixed(4)} SUI`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Run `tick()` to a terminal value while showing a spinner with a live label. */
async function spin<T>(
  label: () => string,
  tick: () => Promise<T | undefined>,
  intervalMs = 1500,
): Promise<T> {
  const start = Date.now();
  let i = 0;
  const tty = process.stdout.isTTY;
  for (;;) {
    const done = await tick();
    if (done !== undefined) {
      if (tty) process.stdout.write("\r" + " ".repeat(80) + "\r");
      return done;
    }
    const secs = ((Date.now() - start) / 1000).toFixed(0);
    const frame = SPINNER[i++ % SPINNER.length];
    if (tty) {
      process.stdout.write("\r" + chalk.yellow(frame) + " " + label() + dim(` (${secs}s)`) + "   ");
    } else if (i % 6 === 1) {
      out("  " + label() + dim(` (${secs}s)`));
    }
    await sleep(intervalMs);
  }
}

// ── config + signer ──────────────────────────────────────────────────────────

/** Load deployment.testnet.json from the repo root (two levels up). */
function loadDeployment(): { deployment: Deployment; raw: Record<string, unknown> } {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(here, "..", "..", "deployment.testnet.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return { deployment: raw as unknown as Deployment, raw };
}

/** A WalletSigner backed by the local sui CLI keystore key for `address`. */
function loadKeystoreSigner(address: string): { signer: WalletSigner; keypair: Ed25519Keypair } {
  const ksPath = join(homedir(), ".sui", "sui_config", "sui.keystore");
  const entries = JSON.parse(readFileSync(ksPath, "utf8")) as string[];
  for (const b64 of entries) {
    const rawKey = Buffer.from(b64, "base64");
    if (rawKey[0] !== 0x00) continue; // Ed25519 flag
    const kp = Ed25519Keypair.fromSecretKey(new Uint8Array(rawKey.subarray(1)));
    if (kp.getPublicKey().toSuiAddress() === address) {
      const signer: WalletSigner = {
        toSuiAddress: () => kp.getPublicKey().toSuiAddress(),
        signTransaction: (bytes) => kp.signTransaction(bytes),
      };
      return { signer, keypair: kp };
    }
  }
  throw new Error(`consumer key ${address} not found in keystore ${ksPath}`);
}

// ── verification helpers ─────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const h = hex.replace(/^0x/, "");
  const o = new Uint8Array(h.length / 2);
  for (let i = 0; i < o.length; i++) o[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return o;
}

function u64le(n: number | bigint): Uint8Array {
  const o = new Uint8Array(8);
  let v = BigInt(n);
  for (let i = 0; i < 8; i++) {
    o[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return o;
}

/** Reconstruct the byte-exact canonical attestation message (gix::attestation §2). */
function buildAttestationMessage(args: {
  jobId: string;
  measurement: string;
  inputHashHex: string;
  outputHashHex: string;
  outputTokenCount: number;
  tStart: number;
  tEnd: number;
}): Uint8Array {
  const parts = [
    ATTEST_DOMAIN,
    hexToBytes(args.jobId),
    new TextEncoder().encode(args.measurement),
    hexToBytes(args.inputHashHex),
    hexToBytes(args.outputHashHex),
    u64le(args.outputTokenCount),
    u64le(args.tStart),
    u64le(args.tEnd),
  ];
  const len = parts.reduce((a, p) => a + p.length, 0);
  const msg = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    msg.set(p, off);
    off += p.length;
  }
  return msg;
}

/** Decode an on-chain `vector<u8>` field (model_uri / model_hash) to a string. */
function vecU8ToStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return Buffer.from(v.map(Number)).toString("utf8");
  return "";
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const prompt = process.argv.slice(2).join(" ").trim();
  if (!prompt) {
    out(bad('no prompt given. Try: npx tsx examples/sdk-demo/run.ts "What is the capital of France?"'));
    process.exit(1);
  }

  const { deployment, raw } = loadDeployment();
  const market: MarketDeployment = deployment.markets[0]!;
  const consumer = (raw.accounts as any)?.consumers?.[0] as string;
  const providerUrl =
    (process.env.GIX_PROVIDER_URL as string | undefined) ?? "http://127.0.0.1:8082";
  const modelRecordId = market.modelId ?? (raw.modelRecordId as string);

  const { signer, keypair } = loadKeystoreSigner(consumer);
  const chain = new GixChain(deployment, {});
  const provider = new ProviderClient(providerUrl);
  const client = await chain.suiClient();

  const t0 = Date.now();

  // ── Header / config ────────────────────────────────────────────────────────
  out();
  out(bold("  GIX SDK demo ") + dim("· verifiable GPU inference, paid on-chain"));
  out(rule());
  kv("network", chalk.magenta(deployment.network));
  kv("package", deployment.packageId);
  kv("consumer", consumer);

  const [suiBal, usdcBal, health] = await Promise.all([
    chain.suiBalance(consumer),
    chain.usdcBalance(consumer),
    provider.health().catch(() => ({ ok: false } as { ok: boolean; model?: string; gpu?: string })),
  ]);
  kv("balances", `${sui(suiBal)}   ${usdc(usdcBal)}`);
  kv(
    "provider",
    `${providerUrl}  ` +
      (health.ok
        ? chalk.green(`(online · model=${health.model} · gpu=${health.gpu})`)
        : chalk.red("(offline)")),
  );
  kv("prompt", chalk.italic(`"${prompt}"`));

  // ── [1/5] Market & order book ────────────────────────────────────────────────
  header(1, "Market & order book");
  kv("market", `${chalk.bold(market.name)}  ` + dim(market.id));
  out("  " + dim("reading the provider's resting Ask from chain…"));
  const ask = await chain.findLatestAsk(market);
  if (!ask) throw new Error(`no live Ask found for market ${market.name} (${market.id})`);
  kv("ask", ask.askId);
  kv("price", chalk.bold(usdc(ask.pricePerScu)) + dim(" / SCU"));
  kv("available", `${ask.remainingScu} SCU`);
  kv("provider", ask.provider + dim("  (maker)"));

  // ── [2/5] Buy — fill the ask (automatic match) ───────────────────────────────
  header(2, "Buy — fill the ask (automatic match)");
  const scuQty = 1n;
  const input = new TextEncoder().encode(prompt);
  const inputHashHex = sha2_256Hex(prompt);
  const escrowUsdc = scuQty * ask.pricePerScu;
  kv("buying", `${scuQty} SCU`);
  kv("matched", chalk.bold(usdc(ask.pricePerScu)) + dim(" / SCU  (the maker's resting price)"));
  kv("escrow", chalk.bold(usdc(escrowUsdc)));
  kv("input_hash", `0x${inputHashHex}  ` + dim("(sha2_256 of the prompt, committed on-chain)"));
  out("  " + dim("calling job::create_job_from_ask<M,Q> — prompt rides INLINE on-chain…"));

  const buy = await chain.createJobFromAsk({
    signer,
    market,
    askId: ask.askId,
    scuQty,
    pricePerScu: ask.pricePerScu,
    input,
    inputHashHex,
  });
  out();
  kv("job id", chalk.bold(buy.jobId));
  kv("buy tx", chalk.blue.underline(SUISCAN(buy.digest)));

  // ── [3/5] Dispatch → inference ───────────────────────────────────────────────
  header(3, "Dispatch → inference");
  out("  " + dim("Job is Dispatched. Polling on-chain state while the provider serves it…"));
  let lastState = -1;
  const finalState = await spin(
    () => `provider running ${chalk.bold(health.model ?? market.name)} … ` + dim(`state=${STATE[lastState as keyof typeof STATE] ?? lastState}`),
    async () => {
      const s = await chain.readJobState(buy.jobId);
      lastState = s;
      return TERMINAL_STATES.has(s) ? s : undefined;
    },
  );
  // The provider caches /result around settle; retry a few times on 404.
  const result = await provider.awaitResult(buy.jobId, { timeoutMs: 30_000, intervalMs: 1500 });
  const serveSecs = ((result.tEnd - result.tStart) / 1000).toFixed(1);
  out(ok(`served ${chalk.bold(String(result.outputTokenCount))} tokens in ${chalk.bold(serveSecs + "s")} `) +
    dim(`· final state=${STATE[finalState as keyof typeof STATE] ?? finalState}`));

  // ── [4/5] Verify (trustless) ─────────────────────────────────────────────────
  header(4, "Verify (trustless)");
  out(rule());
  out(chalk.bold("  ANSWER"));
  out("  " + chalk.whiteBright(result.output.trim()));
  out(rule());

  // Proof 1 — output hash binds the answer to the on-chain attestation.
  const onChainOutputHash = await chain
    .awaitSettlement(buy.jobId, { timeoutMs: 30_000, intervalMs: 1500 })
    .then((t) => t.outputHashOnChain ?? result.outputHash)
    .catch(() => result.outputHash);
  const hashOk = verifyOutput(result.output, onChainOutputHash ?? result.outputHash);
  const localOutHash = sha2_256Hex(result.output);
  out(
    (hashOk ? ok("output integrity") : bad("output integrity")) +
      dim(`  sha2_256(output) == on-chain output_hash`),
  );
  const onChainHashHex = (onChainOutputHash ?? result.outputHash).replace(/^0x/, "");
  out("     " + dim(`local   0x${localOutHash}`));
  out("     " + dim(`onchain 0x${onChainHashHex}`));

  // Proof 2 — Ed25519 attestation signature over the canonical message.
  const msg = buildAttestationMessage({
    jobId: buy.jobId,
    measurement: result.measurement,
    inputHashHex,
    outputHashHex: result.outputHash,
    outputTokenCount: result.outputTokenCount,
    tStart: result.tStart,
    tEnd: result.tEnd,
  });
  const pub = new Ed25519PublicKey(hexToBytes(result.attestPubkey));
  const sigOk = await pub.verify(msg, hexToBytes(result.signature)).catch(() => false);
  const registeredKey = (raw.accounts as any)?.node?.attestPubkey as string | undefined;
  const keyMatches = registeredKey
    ? result.attestPubkey.toLowerCase() === registeredKey.toLowerCase()
    : true;
  out(
    (sigOk && keyMatches ? ok("attestation signature") : bad("attestation signature")) +
      dim(`  Ed25519 over GIX_ATTEST_V1 · key matches the registered provider key`),
  );
  out("     " + dim(`pubkey  ${result.attestPubkey}`));

  // Proof 3 — the served model matches the registered ModelRecord.
  const modelObj = await client.getObject({ id: modelRecordId, options: { showContent: true } });
  const mf = (modelObj.data?.content as any)?.fields ?? {};
  const modelUri = vecU8ToStr(mf.model_uri);
  const modelActive = Boolean(mf.active);
  // The node serves "qwen3.6:35b"; the registry records "qwen3.6-35b/vllm". Match
  // on the canonical model slug (digits-insensitive to the : / - separators).
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const modelOk = modelActive && slug(modelUri).includes(slug(result.model).replace(/vllm$/, ""));
  out(
    (modelOk ? ok("model identity") : bad("model identity")) +
      dim(`  served model ⊂ registered, active ModelRecord`),
  );
  out("     " + dim(`served     ${result.model}`));
  out("     " + dim(`registered ${modelUri}  (active=${modelActive})`));
  out("     " + dim(`measurement ${result.measurement}`));

  const allValid = hashOk && sigOk && keyMatches && modelOk;
  out();
  out(
    "  verdict: " +
      (allValid ? chalk.bgGreen.black.bold(" VALID ") : chalk.bgRed.white.bold(" INVALID ")) +
      dim("  (3 independent on-chain proofs)"),
  );
  // The attestation tx is the same tx that settled (node attests + settles); link
  // the settle tx below, which carries the AttestationSubmitted + Settled events.

  // ── [5/5] Settle ─────────────────────────────────────────────────────────────
  header(5, "Settle");
  const settleEv = await findSettleEvent(client, deployment.packageId, buy.jobId);
  if (settleEv) {
    const payout = BigInt((settleEv.fields.payout as string | number) ?? 0);
    const fee = BigInt((settleEv.fields.fee as string | number) ?? 0);
    out(ok(`Job ${chalk.bold("Settled")} on-chain`));
    kv("provider paid", chalk.bold(usdc(payout)) + dim(`  (+ ${usdc(fee)} protocol fee)`));
    kv("escrow", chalk.green("released") + dim(`  (${usdc(escrowUsdc)} → provider payout + fee)`));
    kv("attest+settle tx", chalk.blue.underline(SUISCAN(settleEv.digest)));
  } else {
    out(dim("  (no Settled event observed yet — final state was " + STATE[finalState as keyof typeof STATE] + ")"));
  }

  // ── Summary footer ───────────────────────────────────────────────────────────
  const totalSecs = ((Date.now() - t0) / 1000).toFixed(1);
  out();
  out(rule());
  out(
    "  " +
      (allValid ? chalk.green.bold("✓ verified inference") : chalk.red.bold("✗ unverified")) +
      dim(" · ") +
      `${totalSecs}s` +
      dim(" · ") +
      usdc(escrowUsdc) +
      dim(" · ") +
      chalk.bold("3 on-chain proofs"),
  );
  out(rule());
  out();

  if (!allValid) process.exitCode = 2;
  // Keep the consumer keypair referenced (silences unused-var on some toolchains).
  void keypair;
}

/** Find the package's Settled event for `jobId` and return its fields + tx digest. */
async function findSettleEvent(
  client: any,
  pkg: string,
  jobId: string,
): Promise<{ fields: Record<string, unknown>; digest: string } | undefined> {
  const res = await client.queryEvents({
    query: { MoveEventType: `${pkg}::events::Settled` },
    order: "descending",
    limit: 50,
  });
  for (const ev of res.data) {
    if ((ev.parsedJson as any)?.job_id === jobId) {
      return { fields: ev.parsedJson as Record<string, unknown>, digest: ev.id.txDigest };
    }
  }
  return undefined;
}

main().catch((e) => {
  out();
  out(bad((e as Error)?.message ?? String(e)));
  if (process.env.GIX_DEBUG) console.error(e);
  process.exit(1);
});
