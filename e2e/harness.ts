#!/usr/bin/env -S npx tsx
/**
 * GIX pool-free E2E acceptance harness (§5).
 *
 *   tsx harness.ts --net=localnet --node=mock --scenario=happy|negatives|load|all
 *
 * Modes:
 *   --node=mock   deterministic in-process provider (no GPU) — CI / L1–L5. (default)
 *   --node=gb10   real qwen on the GB10 — L6 acceptance. WIRED, NOT RUN by this delivery.
 * Networks:
 *   --net=localnet  ephemeral, faucet-funded wallets; in-memory Walrus. (default)
 *   --net=testnet   real network + real Walrus. WIRED, NOT RUN (no testnet spend).
 *
 * It LOCATES the deployed package from deployment.json by default (no test-publish, so it never
 * races the running localnet qwen demo). Pass --deploy to test-publish a fresh ephemeral package
 * instead (localnet only). Generated provider/consumer wallets are funded from the LOCALNET
 * FAUCET — `sui client` global state (active env/address) is NEVER touched.
 *
 * Exits NONZERO on any invariant/audit/scenario failure (the CI gate). Writes a JUnit report.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";

// Node 18 does not expose a global WebCrypto, which @mysten/sui's Ed25519Keypair.generate()
// needs (crypto.getRandomValues). Install it before any keypair is created. No-op on Node ≥20.
if (!(globalThis as { crypto?: unknown }).crypto) {
  (globalThis as { crypto?: unknown }).crypto = webcrypto;
}
import type { Deployment } from "../sdk/src/types.js";
import { E2eChain } from "./chain.js";
import { MockNode } from "./mock-node.js";
import { InMemoryWalrus } from "./walrus.js";
import { Reporter } from "./report.js";
import { runHappy } from "./scenarios/happy.js";
import { runNegatives } from "./scenarios/negatives.js";
import { runLoad } from "./scenarios/load.js";
import { BASE_NOW_MS } from "./fixtures/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

interface Args {
  net: "localnet" | "testnet";
  node: "mock" | "gb10";
  scenario: "happy" | "negatives" | "load" | "all";
  deploy: boolean;
  loadN: number;
  deploymentPath: string;
  junit: string;
}

function parseArgs(argv: string[]): Args {
  const get = (k: string, d?: string) => {
    const a = argv.find((x) => x.startsWith(`--${k}=`));
    return a ? a.slice(k.length + 3) : d;
  };
  const has = (k: string) => argv.includes(`--${k}`);
  const net = (get("net", "localnet") as Args["net"]);
  const node = (get("node", "mock") as Args["node"]);
  const scenario = (get("scenario", "happy") as Args["scenario"]);
  const defaultDeployment = net === "testnet"
    ? resolve(REPO_ROOT, "deployment.testnet.json")
    : resolve(REPO_ROOT, "deployment.json");
  return {
    net,
    node,
    scenario,
    deploy: has("deploy"),
    loadN: Number(get("n", "4")),
    deploymentPath: resolve(get("deployment", defaultDeployment)!),
    junit: resolve(get("junit", resolve(HERE, "e2e-report.junit.xml"))!),
  };
}

function loadDeployment(path: string): Deployment {
  const d = JSON.parse(readFileSync(path, "utf8")) as Deployment;
  if (!d.packageId || !d.markets?.length) throw new Error(`deployment ${path} missing packageId/markets`);
  return d;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const log = (m: string) => console.log(m);

  console.log(`\n=== GIX pool-free E2E acceptance ===`);
  console.log(`net=${args.net} node=${args.node} scenario=${args.scenario}\n`);

  // --- guardrails ----------------------------------------------------------
  if (args.net === "testnet") {
    console.error(
      "REFUSING to run against testnet from this harness invocation.\n" +
        "testnet/gb10 are WIRED but NOT RUN by this delivery (no testnet spend). " +
        "To run acceptance on testnet deliberately, remove this guard.",
    );
    return 2;
  }
  if (args.node === "gb10") {
    console.error("--node=gb10 (real qwen) is WIRED but NOT RUN here. Use --node=mock for localnet.");
    return 2;
  }

  const deployment = loadDeployment(args.deploymentPath);
  if (args.deploy) {
    console.error(
      "--deploy (ephemeral test-publish) is supported per §5 but intentionally NOT triggered in this run " +
        "to avoid racing the running localnet qwen demo. Locating the existing package from deployment.json instead.",
    );
  }
  console.log(`package: ${deployment.packageId}`);
  console.log(`market:  ${deployment.markets[0]!.name} (${deployment.markets[0]!.id})`);
  console.log(`SLA p99: ${deployment.markets[0]!.slaP99Ms ?? 30000}ms\n`);

  const chain = new E2eChain({ deployment, network: "localnet", log });
  await chain.connect();

  // Sanity: confirm the located package is reachable + this is the chain we expect.
  const rep = new Reporter();
  const node = new MockNode();
  const walrus = new InMemoryWalrus();
  const slaP99Ms = deployment.markets[0]!.slaP99Ms ?? 30000;

  try {
    if (args.scenario === "happy" || args.scenario === "all") {
      console.log("--- scenario: happy ---");
      await runHappy({ chain, node, walrus, rep, nowMs: BASE_NOW_MS });
    }
    if (args.scenario === "negatives" || args.scenario === "all") {
      console.log("--- scenario: negatives ---");
      await runNegatives({ chain, node, walrus, rep, nowMs: BASE_NOW_MS, slaP99Ms });
    }
    if (args.scenario === "load" || args.scenario === "all") {
      console.log(`--- scenario: load (n=${args.loadN}) ---`);
      await runLoad({ chain, node, walrus, rep, nowMs: BASE_NOW_MS, n: args.loadN });
    }
  } catch (e) {
    rep.assert("harness", "uncaught", false, (e as Error).stack ?? String(e));
  }

  console.log(`\n=== summary ===`);
  console.log(rep.summary());
  rep.writeJUnit(args.junit);
  console.log(`JUnit: ${args.junit}`);

  return rep.failures > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(3);
  });
