/**
 * Seeded, deterministic fixtures for the GIX pool-free E2E harness (§5 Determinism rule).
 *
 * Everything here is frozen so L1–L5 are reproducible to the byte:
 *   - the mock node's completion is a PURE function of the prompt
 *     (`mockComplete(prompt) = "[gix-mock] echo: " + prompt`), so a given prompt maps to a
 *     fixed completion → fixed `sha2_256` output_hash → a fixed canonical message → a fixed
 *     signature under a fixed Ed25519 seed. No GPU, no randomness, no wall-clock.
 *   - the attestation key is derived from a constant 32-byte seed.
 *   - `nowMs` is INJECTED (never `Date.now()`), so deadlines/SLA windows are deterministic.
 *
 * The golden hashes below are the independently-verifiable `sha2_256` of the exact UTF-8
 * strings (e.g. `printf 'What is 2+2?' | sha256sum`). They are asserted in the audit/unit
 * tests so any drift in the hashing primitive fails loudly.
 */

import { createHash } from "node:crypto";

/** The deterministic mock-node measurement (MOCK-prefixed → K4 localnet-only fence). */
export const MOCK_MEASUREMENT = "MOCK-tdx-llama8b-v1";

/** The constant 32-byte Ed25519 attestation seed for the mock node (all 0x07). Fixed ⇒
 * the same pubkey + signatures every run. Distinct from the canonical-test seed (0x01) so
 * the two suites cannot accidentally share a golden vector. */
export const MOCK_ATTEST_SEED = new Uint8Array(32).fill(7);

/** A fixed base epoch-ms the harness clocks off of (2023-11-14T22:13:20Z). All injected
 * `nowMs` values derive from this so latency/SLA assertions are deterministic. */
export const BASE_NOW_MS = 1_700_000_000_000;

/** Tokens the mock node "reports" — a fixed function of completion length, deterministic. */
export function mockTokenCount(completion: string): number {
  // Roughly word-count; deterministic and stable for a given completion string.
  return completion.trim().length === 0 ? 0 : completion.trim().split(/\s+/).length;
}

/** The mock node's completion is a pure function of the prompt. THIS is the determinism
 * contract that lets a given prompt → fixed output_hash without a GPU. */
export function mockComplete(prompt: string): string {
  return `[gix-mock] echo: ${prompt}`;
}

/** sha2_256 of a UTF-8 string → lowercase hex (no 0x) — the GIX verification primitive. */
export function sha2(s: string): string {
  return createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
}

/** A single golden prompt fixture: the prompt, its deterministic completion, and the
 * frozen `sha2_256` hashes the on-chain attestation must bind. */
export interface GoldenPrompt {
  id: string;
  prompt: string;
  completion: string;
  inputHash: string;
  outputHash: string;
}

function golden(id: string, prompt: string): GoldenPrompt {
  const completion = mockComplete(prompt);
  return { id, prompt, completion, inputHash: sha2(prompt), outputHash: sha2(completion) };
}

/** Golden prompts. The hashes are frozen (asserted in tests) — change a prompt and the
 * test that pins the hash will fail, forcing a deliberate fixture update. */
export const GOLDEN_PROMPTS: Record<string, GoldenPrompt> = {
  P1: golden("P1", "What is 2+2?"),
  P2: golden("P2", "Name the capital of France."),
  P3: golden("P3", "Say PONG."),
};

/** Pinned golden hashes (independently verifiable via `printf '<prompt>' | sha256sum` and
 * `printf '[gix-mock] echo: <prompt>' | sha256sum`). The unit tests assert these so the
 * mock-node determinism contract can never silently drift. */
export const GOLDEN_HASHES = {
  P1: {
    inputHash: "52cb6b5e4a038af1756708f98afb718a08c75b87b2f03dbee4dd9c8139c15c5e",
    outputHash: "30bde88f24d6f2c7e2998db18ffd62f597a4936938bbeb9d4f00e2a0b44f5451",
  },
  P2: {
    inputHash: "5c5da3fd596bac972d64b45fe31b95483919c737f7170d713a55538918d3f068",
    outputHash: "089d33d62a2220ab443ebbfbe7fc2fe4b10f574bff2028db39c107fcd0c6582d",
  },
  P3: {
    inputHash: "841cef0c8f936c9dcc3e1bb8fad713e1be8a2e5798923b9b1b3a6ad7fc3b7102",
    outputHash: "929ad849dc7dea96755ba402871e91d235e8a39841528b1c229d3198bba67e9a",
  },
} as const;

/** Seeded economic config for the pool-free path. Mirrors `ask_flow_tests.move` constants so
 * the TS harness and the Move L1 tests price jobs identically. */
export interface EconConfig {
  /** Provider bond in MOCK_USDC base units (6dp). */
  bondUsdc: number;
  /** SCU capacity the provider stakes for. */
  capacityScu: number;
  /** SCU quantity the provider posts as a resting Ask. */
  askQtyScu: number;
  /** Price per SCU (MOCK_USDC base units). */
  pricePerScu: number;
  /** SCU quantity each consumer job buys from the Ask. */
  jobQtyScu: number;
}

/** The default seeded economics: a 10 mUSDC bond, capacity 100, an Ask of 50 SCU at
 * 0.1 mUSDC/SCU; each job buys 10 SCU ⇒ escrow = 10 * 100_000 = 1_000_000 base units. */
export const ECON: EconConfig = {
  bondUsdc: 10_000_000,
  capacityScu: 100,
  askQtyScu: 50,
  pricePerScu: 100_000,
  jobQtyScu: 10,
};

/** The exact escrow a job of `jobQtyScu` SCU funds at `pricePerScu`. */
export function escrowFor(econ: EconConfig = ECON): number {
  return econ.jobQtyScu * econ.pricePerScu;
}
