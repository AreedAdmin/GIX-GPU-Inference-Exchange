import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Keep tests hermetic: no validator, no Ollama, no network.
    environment: "node",
  },
});
