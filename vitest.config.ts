import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      reporter: ["text", "html"],
    },
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup-network-tripwire.ts"],
  },
});
