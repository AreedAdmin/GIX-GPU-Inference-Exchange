#!/usr/bin/env -S node --experimental-strip-types
/**
 * GIX M1 harness CLI.
 *
 *   npm run stream -- --scenario examples/scenarios/baseline.json
 *   npm run stream -- --scenario <path> --dry-run
 *   npm run stream -- --dry-run                 # built-in baseline, no chain
 *
 * Flags:
 *   --scenario <path>   scenario JSON (default: built-in `baseline`)
 *   --deployment <path> deployment.json (default: synthetic in dry-run)
 *   --dry-run           no chain; simulate the state machine in memory
 *   --log <fmt>         pretty | json | silent   (default: pretty)
 *   --realtime          pace orders by orderRatePerSec (live demo)
 *   --seed <n>          override the scenario RNG seed
 *   --serve             start the M1.5 trading-UI WS feed alongside the run
 *   --port <n>          WS feed port (default: 8787; implies --serve)
 */

import { loadDeployment, loadScenario } from "./config/load.js";
import { syntheticDeployment } from "./config/synthetic.js";
import { DryRunChain } from "./chain/dryrun.js";
import { StubMatcher } from "./matcher/matcher.js";
import { Logger, type LogFormat } from "./observability/logger.js";
import { Tally, renderSummary } from "./observability/tally.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import type { Chain } from "./chain/chain.js";

interface Args {
  scenario?: string;
  deployment?: string;
  dryRun: boolean;
  log: LogFormat;
  realtime: boolean;
  seed?: number;
  serve: boolean;
  port: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { dryRun: false, log: "pretty", realtime: false, serve: false, port: 8787 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--scenario":
        a.scenario = argv[++i];
        break;
      case "--deployment":
        a.deployment = argv[++i];
        break;
      case "--dry-run":
        a.dryRun = true;
        break;
      case "--realtime":
        a.realtime = true;
        break;
      case "--serve":
        a.serve = true;
        break;
      case "--port":
        a.port = Number(argv[++i]);
        a.serve = true;
        break;
      case "--log":
        a.log = (argv[++i] as LogFormat) ?? "pretty";
        break;
      case "--seed":
        a.seed = Number(argv[++i]);
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        if (arg?.startsWith("--")) {
          console.error(`unknown flag: ${arg}`);
          process.exit(2);
        }
    }
  }
  return a;
}

function printHelp(): void {
  process.stdout.write(
    [
      "gix-stream — GIX M1 synthetic order-flow harness",
      "",
      "Usage: npm run stream -- [--scenario <path>] [--dry-run] [options]",
      "",
      "  --scenario <path>    scenario JSON (default: built-in baseline)",
      "  --deployment <path>  deployment.json (default: synthetic in dry-run)",
      "  --dry-run            simulate the state machine in-memory, no chain",
      "  --log <fmt>          pretty | json | silent  (default: pretty)",
      "  --realtime           pace orders to orderRatePerSec",
      "  --seed <n>           override the scenario RNG seed",
      "  --serve              start the M1.5 trading-UI WS feed alongside the run",
      "  --port <n>           WS feed port (default: 8787; implies --serve)",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const logger = new Logger(args.log);

  const scenario = loadScenario(args.scenario);
  logger.info(`scenario: ${scenario.name}${scenario.description ? ` — ${scenario.description}` : ""}`);

  // Resolve deployment.
  let deployment;
  if (args.deployment) {
    deployment = loadDeployment(args.deployment);
  } else if (args.dryRun) {
    deployment = syntheticDeployment(scenario);
    logger.info("deployment: synthetic (dry-run)");
  } else {
    console.error(
      "error: --deployment <path> is required for an on-chain run (or pass --dry-run).",
    );
    process.exit(2);
    return;
  }

  // Select the chain backend.
  let chain: Chain;
  if (args.dryRun) {
    chain = new DryRunChain();
    logger.info("mode: DRY-RUN (no validator)");
  } else {
    // On-chain path: lazily import SuiChain so dry-run/tests never load the SDK.
    const { SuiChain } = await import("./chain/sui.js");
    const { loadKeystoreSigners } = await import("./chain/signers.js");
    logger.info("mode: SUI (localnet)");

    // Load real keypairs for every account the run touches from the sui keystore.
    const addrs = new Set<string>([
      ...deployment.accounts.providers,
      ...deployment.accounts.consumers,
    ]);
    if (deployment.accounts.admin) addrs.add(deployment.accounts.admin);
    const signers = loadKeystoreSigners([...addrs]);
    logger.info(`loaded ${signers.size} keypair(s) from the sui keystore`);

    chain = new SuiChain({
      deployment,
      logger,
      keypairFor: (address: string) => {
        const kp = signers.get(address);
        if (!kp) {
          throw new Error(
            `no keypair for ${address} in the sui keystore. Add it (sui keytool import) ` +
              `or run ops/scripts/fund.sh to create + fund the deployment accounts.`,
          );
        }
        return kp;
      },
    });
  }

  // Optional M1.5 trading-UI WS feed. Started before the run so a UI client can
  // connect and receive `hello` + synthetic book frames immediately, then the
  // streamer's real events flow through as trade/job/ticker frames.
  let feed: import("./serve/wsserver.js").WsFeedServer | undefined;
  if (args.serve) {
    const { WsFeedServer } = await import("./serve/wsserver.js");
    feed = new WsFeedServer({
      port: args.port,
      deployment,
      scenario,
      logger,
      seed: args.seed,
    });
  }

  const tally = new Tally();
  const orchestrator = new Orchestrator({
    scenario,
    deployment,
    chain,
    matcher: new StubMatcher(),
    logger,
    tally,
    seed: args.seed,
    // In serve mode pace orders to orderRatePerSec so the UI sees a live drip,
    // not a burst. An explicit --realtime still wins; otherwise serve implies it.
    realtime: args.realtime || args.serve,
    onEvent: feed ? (e) => feed!.onHarnessEvent(e) : undefined,
  });

  logger.info("── provider/consumer setup ──");
  await orchestrator.setup();
  logger.info("── streaming orders ──");
  const result = await orchestrator.run();

  logger.raw("\n" + renderSummary(result.tally));

  // With the WS feed up, keep the process alive after the run so the UI stays
  // connected and the synthetic book keeps drifting. Ctrl-C (SIGINT) shuts down.
  if (feed) {
    logger.info(`\nWS feed still serving on :${args.port} — book keeps drifting. Ctrl-C to stop.`);
    await new Promise<void>((resolve) => {
      const stop = () => {
        feed!.close().finally(resolve);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
