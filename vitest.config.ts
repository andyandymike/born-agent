import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Phase 17's pinned TypeScript engine is intentionally loaded by several
    // integration suites. Bounding workers keeps per-test crash deadlines
    // meaningful instead of turning CPU contention into false timeouts.
    maxWorkers: 2,
    coverage: {
      reporter: ["text", "html"],
    },
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup-network-tripwire.ts"],
  },
});
