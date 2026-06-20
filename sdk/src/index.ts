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
  sha2_256HexBytes,
  hexEquals,
  normalizeHex,
  hexToBytes,
  strBytes,
} from "./hash.js";
export { ProviderClient } from "./provider.js";
export { GixChain, buildCreateJobPlan } from "./chain.js";
export type {
  CreateJobPlan,
  CreateJobOutcome,
  MoveCallPlan,
  PlanArg,
  TerminalOutcome,
} from "./chain.js";
export {
  buildFillJobPlan,
  loadDeepbookTestnetConstants,
  TESTNET_DEEP_COIN_TYPE,
} from "./deepbook.js";
export type {
  FillJobPlan,
  FillMoveCall,
  FillArg,
  DeepbookTestnetConstants,
} from "./deepbook.js";
export {
  WalrusHelper,
  verifyBlob,
  blobIdToU256,
  u256ToBlobId,
  DEFAULT_BLOB_EPOCHS,
} from "./walrus.js";
export type { UploadInputResult, WalrusHelperOptions } from "./walrus.js";
export type {
  Deployment,
  MarketDeployment,
  DeploymentAccounts,
  WalletSigner,
  WalrusUploadSigner,
  FillConfig,
  GixClientOptions,
  RunTaskArgs,
  RunTaskResult,
  MarketInfo,
  Balances,
  ProviderResult,
} from "./types.js";
