import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, missingRequired } from "../src/config.js";

/**
 * The config loader: bundled deployment.json defaults < config.json < env <
 * CLI overrides. The two integration seams (ASK_ID + PROVIDER_URL) have no
 * default and must be supplied by the running node.
 */

let dir: string;
let deploymentPath: string;
const PKG = "0xPKGFROMDEPLOY";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "gix-cfg-"));
  deploymentPath = join(dir, "deployment.json");
  writeFileSync(
    deploymentPath,
    JSON.stringify({
      network: "localnet",
      packageId: PKG,
      configId: "0xCFGFROMDEPLOY",
      usdcType: `${PKG}::mock_usdc::MOCK_USDC`,
      faucetId: "0xFAUCETFROMDEPLOY",
      clockId: "0x6",
      markets: [
        { id: "0xMARKETFROMDEPLOY", creditType: `${PKG}::markets::M_H100_LLAMA8B` },
      ],
    }),
  );
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const noEnv = {} as Record<string, string | undefined>;

describe("config loader — deployment.json defaults", () => {
  it("pulls chain ids from the bundled deployment.json", () => {
    const cfg = loadConfig({
      deploymentPath,
      env: noEnv,
      overrides: { askId: "0xASK", providerUrl: "http://node:8080" },
    });
    expect(cfg.packageId).toBe(PKG);
    expect(cfg.configId).toBe("0xCFGFROMDEPLOY");
    expect(cfg.marketId).toBe("0xMARKETFROMDEPLOY");
    expect(cfg.creditType).toBe(`${PKG}::markets::M_H100_LLAMA8B`);
    expect(cfg.usdcType).toBe(`${PKG}::mock_usdc::MOCK_USDC`);
    expect(cfg.faucetId).toBe("0xFAUCETFROMDEPLOY");
    expect(cfg.clockId).toBe("0x6");
    expect(cfg.network).toBe("localnet");
    // localnet RPC + faucet defaults are filled in.
    expect(cfg.rpcUrl).toBe("http://127.0.0.1:9000");
    expect(cfg.suiFaucetUrl).toContain("9123");
    expect(cfg.scuQty).toBe(1);
  });

  it("requires ASK_ID + PROVIDER_URL (no default → throws by default)", () => {
    expect(() => loadConfig({ deploymentPath, env: noEnv })).toThrow(/ASK_ID|PROVIDER_URL/);
  });

  it("requireAll:false defers the node-seam check (wallet/--fund path)", () => {
    const cfg = loadConfig({ deploymentPath, env: noEnv, requireAll: false });
    expect(cfg.packageId).toBe(PKG);
    // localnet ⇒ ask path; askId is the only unfilled node seam (providerUrl too).
    expect(cfg.buyPath).toBe("ask");
    expect(missingRequired(cfg).sort()).toEqual(["askId", "providerUrl"]);
  });
});

describe("config loader — precedence", () => {
  it("env overrides deployment.json", () => {
    const cfg = loadConfig({
      deploymentPath,
      env: {
        PACKAGE_ID: "0xENVPKG",
        ASK_ID: "0xENVASK",
        PROVIDER_URL: "http://env-node:8080",
        RPC_URL: "http://env-rpc:9000",
      },
    });
    expect(cfg.packageId).toBe("0xENVPKG");
    expect(cfg.askId).toBe("0xENVASK");
    expect(cfg.providerUrl).toBe("http://env-node:8080");
    expect(cfg.rpcUrl).toBe("http://env-rpc:9000");
  });

  it("config.json overrides deployment.json but loses to env and CLI", () => {
    const cfgFile = join(dir, "config.json");
    writeFileSync(
      cfgFile,
      JSON.stringify({
        PACKAGE_ID: "0xFILEPKG",
        ASK_ID: "0xFILEASK",
        PROVIDER_URL: "http://file-node:8080",
      }),
    );
    const cfg = loadConfig({
      deploymentPath,
      configPath: cfgFile,
      env: { PACKAGE_ID: "0xENVPKG" }, // env beats file
      overrides: { askId: "0xCLIASK" }, // CLI beats all
    });
    expect(cfg.packageId).toBe("0xENVPKG"); // env > file
    expect(cfg.askId).toBe("0xCLIASK"); // CLI > file
    expect(cfg.providerUrl).toBe("http://file-node:8080"); // file > deploy (no env/CLI)
  });

  it("testnet network picks testnet RPC + explorer defaults", () => {
    // testnet ⇒ the M2 DeepBook fill path; supply its node seams so validation
    // passes (the assertions here are about network-derived defaults).
    const cfg = loadConfig({
      deploymentPath,
      env: {
        GIX_NETWORK: "testnet",
        PROVIDER_URL: "http://node",
        DEEPBOOK_POOL_ID: "0xPOOL",
        CREDIT_COIN_TYPE: `0x2::coin::Coin<${PKG}::credit::Credit<${PKG}::markets::M_H100_LLAMA8B>>`,
        PROVIDER_RECORD_ID: "0xREC",
      },
    });
    expect(cfg.network).toBe("testnet");
    expect(cfg.buyPath).toBe("fill");
    expect(cfg.rpcUrl).toContain("testnet");
    expect(cfg.explorerTxBase).toContain("testnet");
    expect(cfg.suiFaucetUrl).toContain("testnet");
    expect(missingRequired(cfg)).toEqual([]);
  });

  it("testnet defaults to the fill path; localnet to the ask path", () => {
    const tn = loadConfig({
      deploymentPath,
      env: { GIX_NETWORK: "testnet" },
      requireAll: false,
    });
    expect(tn.buyPath).toBe("fill");
    // fill path needs the DeepBook seams instead of an Ask id.
    expect(missingRequired(tn).sort()).toEqual([
      "creditCoinType",
      "deepbookPoolId",
      "providerRecordId",
      "providerUrl",
    ]);

    const ln = loadConfig({ deploymentPath, env: noEnv, requireAll: false });
    expect(ln.buyPath).toBe("ask");

    // BUY_PATH explicitly overrides the network default.
    const forced = loadConfig({
      deploymentPath,
      env: { GIX_NETWORK: "testnet", BUY_PATH: "ask" },
      requireAll: false,
    });
    expect(forced.buyPath).toBe("ask");
  });
});

describe("missingRequired", () => {
  it("lists exactly the unfilled required fields", () => {
    const cfg = loadConfig({
      deploymentPath,
      env: noEnv,
      overrides: { askId: "0xASK", providerUrl: "http://node" },
    });
    expect(missingRequired(cfg)).toEqual([]);
  });
});
