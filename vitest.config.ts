import { defineConfig } from "vitest/config";

const serializeHostedWindowsRepositoryCheck =
  process.env.BORN_CI_WINDOWS_SERIAL_TESTS === "1";

export default defineConfig({
  test: {
    // Phase 17's pinned TypeScript engine is intentionally loaded by several
    // integration suites. Bounding workers keeps per-test crash deadlines
    // meaningful instead of turning CPU contention into false timeouts. The
    // hosted Windows repository gate opts into one worker because its two-core
    // runner also cold-starts sealed child processes inside these tests. Give
    // only that explicit CI profile a larger per-test scheduling allowance;
    // default/local tests retain Vitest's 5s timeout and built/PTY cases keep
    // their own domain-specific outer budgets.
    maxWorkers: serializeHostedWindowsRepositoryCheck ? 1 : 2,
    testTimeout: serializeHostedWindowsRepositoryCheck ? 30_000 : 5_000,
    coverage: {
      reporter: ["text", "html"],
    },
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup-network-tripwire.ts"],
  },
});
