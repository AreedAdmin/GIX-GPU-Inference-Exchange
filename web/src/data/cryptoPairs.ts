// web/src/data/cryptoPairs.ts
// The "Crypto Pairs" catalog shown in the markets sidebar (category = crypto).
// These are currency → dollar exchange routes: swap a token into one of the three
// GIX dollars (USDC / DBUSDC / MOCK_USDC). The live SUI→DBUSDC route runs on the
// existing DeepBook testnet pool with no DEEP (see OnRampWidget); the rest are
// listed as offered routes with indicative rates until their pools are wired.

export type GixDollar = "USDC" | "DBUSDC" | "MOCK_USDC";

export interface CryptoPair {
  id: string;
  /** token the user pays */
  base: string;
  /** dollar the user receives */
  quote: GixDollar;
  /** indicative rate: `quote` per 1 `base` */
  last: number;
  change24h: number;
  /** true when a real on-chain route exists today (DeepBook testnet pool) */
  live: boolean;
}

export const CRYPTO_PAIRS: CryptoPair[] = [
  // Live SUI → dollar (the OnRamp pool: SUI_DBUSDC, input-coin fees, no DEEP).
  { id: "px-sui-usdc", base: "SUI", quote: "USDC", last: 2.34, change24h: 1.82, live: true },
  { id: "px-sui-dbusdc", base: "SUI", quote: "DBUSDC", last: 2.34, change24h: 1.82, live: true },
  { id: "px-sui-musdc", base: "SUI", quote: "MOCK_USDC", last: 2.34, change24h: 1.82, live: false },
  // Other offered routes (indicative until pools are wired).
  { id: "px-deep-usdc", base: "DEEP", quote: "USDC", last: 0.0721, change24h: -2.14, live: false },
  { id: "px-wal-usdc", base: "WAL", quote: "USDC", last: 0.412, change24h: 0.63, live: false },
  { id: "px-usdc-dbusdc", base: "USDC", quote: "DBUSDC", last: 1.0, change24h: 0.01, live: false },
  { id: "px-usdc-musdc", base: "USDC", quote: "MOCK_USDC", last: 1.0, change24h: 0.0, live: false },
];
