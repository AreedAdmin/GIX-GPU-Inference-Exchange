import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests for the reusable verifiers (audit / invariants / faults). These are
    // hermetic — no validator, no Walrus, no network — so they run in CI alongside the
    // node/ and sdk/ suites. The live-localnet orchestration lives in harness.ts (a CLI),
    // NOT in vitest, so `vitest run` never needs a running chain.
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
