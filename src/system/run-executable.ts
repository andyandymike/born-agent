import { execFile } from "node:child_process";

import type { ExecutableResult } from "../doctor/types.js";

interface ExecFileError extends Error {
  code?: number | string;
  killed?: boolean;
}

export function runExecutable(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<ExecutableResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        shell: false,
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ kind: "completed", exitCode: 0, stderr, stdout });
          return;
        }

        const execError = error as ExecFileError;
        if (execError.code === "ENOENT") {
          resolve({ kind: "missing" });
          return;
        }

        if (execError.killed) {
          resolve({ kind: "timeout" });
          return;
        }

        if (typeof execError.code === "number") {
          resolve({
            kind: "completed",
            exitCode: execError.code,
            stderr,
            stdout,
          });
          return;
        }

        resolve({ kind: "failed", message: execError.message });
      },
    );
  });
}

