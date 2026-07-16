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
    clearTimer: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
    createChatClient: () => ({
      complete: async (request) => ({
        model: request.model,
        providerResponseId: "resp_test",
        text: "fake response",
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      }),
    }),
    cwd: resolve("fixture-workspace"),
    env: { OPENAI_API_KEY: "test-api-key" },
    isReadableDirectory: async () => true,
    nodeVersion: "22.16.0",
    now: Date.now,
    onCancel: () => () => undefined,
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
    setTimer: (listener, delayMs) => setTimeout(listener, delayMs),
    version: "0.0.0",
    ...overrides,
  };
}
