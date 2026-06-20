/**
 * Shared type-only aliases for the lazily-imported @mysten/sui transaction + client
 * types. Importing these as `import type` keeps the SDK out of the hermetic test/HTTP-only
 * paths (no runtime import) while giving chain.ts / deepbook.ts / walrus.ts a single,
 * consistent handle on the Transaction + SuiJsonRpcClient shapes.
 */

export type TransactionT = import("@mysten/sui/transactions").Transaction;
export type SuiClientT = import("@mysten/sui/jsonRpc").SuiJsonRpcClient;
