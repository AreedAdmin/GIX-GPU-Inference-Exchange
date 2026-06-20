/**
 * @gix/sdk — consumer SDK for the GPU Inference Exchange.
 *
 * Turns an inference request into an on-chain compute purchase served by a
 * provider's GPU, with cryptographically verifiable output.
 */

export { GixClient, verifyOutput } from "./client.js";
export { keypairSigner, fromSuiPrivateKey } from "./signer.js";
export {
  sha2_256Hex,
  sha2_256Bytes,
  hexEquals,
  normalizeHex,
  hexToBytes,
  strBytes,
} from "./hash.js";
export { ProviderClient } from "./provider.js";
export { GixChain, buildCreateJobPlan } from "./chain.js";
export type {
  CreateJobPlan,
  MoveCallPlan,
  PlanArg,
  TerminalOutcome,
} from "./chain.js";
export type {
  Deployment,
  MarketDeployment,
  DeploymentAccounts,
  WalletSigner,
  GixClientOptions,
  RunTaskArgs,
  RunTaskResult,
  MarketInfo,
  Balances,
  ProviderResult,
} from "./types.js";
