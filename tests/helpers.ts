import { resolve } from "node:path";

import type { CliIO, CliRuntime } from "../src/cli/types.js";
import type { ExecutableResult } from "../src/doctor/types.js";

export function createMemoryIO(): {
  io: CliIO;
  readStderr(): string;
  readStdout(): string;
} {
  let stderr = "";
  let stdout = "";

  return {
    io: {
      stderr: { write: (value) => void (stderr += value) },
      stdout: { write: (value) => void (stdout += value) },
    },
    readStderr: () => stderr,
    readStdout: () => stdout,
  };
}

export function createRuntime(
  overrides: Partial<CliRuntime> = {},
): CliRuntime {
  return {
    cwd: resolve("fixture-workspace"),
    isReadableDirectory: async () => true,
    nodeVersion: "22.16.0",
    platform: "win32",
    runExecutable: async (command): Promise<ExecutableResult> => ({
      kind: "completed",
      exitCode: 0,
      stderr: "",
      stdout:
        command === "git"
          ? "git version 2.30.0.windows.2\n"
          : "ripgrep 15.1.0\n",
    }),
    version: "0.0.0",
    ...overrides,
  };
}

