// Static chain/market constants surfaced in the StatusBar + TopBar.
// Mirrors deployment.json (localnet); the WS feed / OrderClient agents read the live values.

export const DEPLOYMENT = {
  network: "localnet",
  packageId: "0x91bca1cd13a5131119467e8bf4867f76ab1c12fcc7200f8c0bbf3acd9dee72ee",
  configId: "0xc48c29e3dec0089382ab57149da931105f5ac5f60271a6b007356595685fb6c3",
  usdcType:
    "0x91bca1cd13a5131119467e8bf4867f76ab1c12fcc7200f8c0bbf3acd9dee72ee::mock_usdc::MOCK_USDC",
  market: {
    id: "0x816c8da0ce624cb62e84948bad3fe1fad60a8aa945d85661b29bcd73dffc55b1",
    name: "H100-llama3.1-8b-int8",
    scuTokens: 1000,
    slaP99Ms: 5000,
  },
} as const;

// 1 SCU = 1k output tokens at the tier. Quote = USDC.
export const SCU_TOKENS = 1000;

export function shortId(id: string, head = 6, tail = 4): string {
  if (id.length <= head + tail + 2) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}
