/**
 * Synthetic deployment generator for dry-run / tests.
 *
 * When no real `deployment.json` exists (before contracts/ deploys), the harness
 * fabricates a deployment with the right shape so the orchestrator and dry-run
 * chain have markets, accounts, and types to reference. It mirrors the example
 * in docs/mvp-m1-integration-contract.md (one H100 llama-3.1-8b market).
 */

import type { Deployment, Scenario } from "./types.js";

const PKG = "0xdeadbeefcafef00d0000000000000000000000000000000000000000000000aa";

export function syntheticDeployment(scenario: Scenario): Deployment {
  const providers = Array.from(
    { length: scenario.providers.count },
    (_, i) => `0xprovider${String(i).padStart(54, "0")}`,
  );
  const consumers = Array.from(
    { length: scenario.consumers.count },
    (_, i) => `0xconsumer${String(i).padStart(54, "0")}`,
  );
  return {
    network: "localnet",
    packageId: PKG,
    configId: `${PKG.slice(0, 40)}config000000000000000000000001`,
    adminCapId: `${PKG.slice(0, 40)}admincap00000000000000000000001`,
    usdcType: `${PKG}::mock_usdc::MOCK_USDC`,
    clockId: "0x6",
    markets: [
      {
        id: `${PKG.slice(0, 40)}market0000000000000000000000001`,
        name: "H100-llama3.1-8b-int8",
        creditType: `${PKG}::markets::M_H100_LLAMA8B`,
        scuTokens: 1000,
        slaP99Ms: 5000,
      },
    ],
    accounts: {
      admin: `0xadmin${String(0).padStart(58, "0")}`,
      providers,
      consumers,
    },
  };
}
