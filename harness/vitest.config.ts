import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Hermetic: dry-run + unit tests never touch the network or a validator.
    globals: false,
  },
});
