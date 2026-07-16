import { spawn } from "node:child_process";

import { sanitizeChildEnvironment } from "../security/child-environment.js";

export interface GitArgvResult {
  readonly exitCode: number;
  readonly stderr: Buffer;
  readonly stdout: Buffer;
}

export interface GitArgvRunner {
  run(
    cwd: string,
    args: readonly string[],
    options?: { readonly maxOutputBytes?: number },
  ): Promise<GitArgvResult>;
}

export class GitArgvError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "GitArgvError";
  }
}

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  state: { bytes: number },
  limit: number,
): boolean {
  state.bytes += chunk.byteLength;
  if (state.bytes > limit) {
    return false;
  }
  chunks.push(Buffer.from(chunk));
  return true;
}

export class NodeGitArgvRunner implements GitArgvRunner {
  constructor(
    private readonly executable = "git",
    private readonly environment: Readonly<
      Record<string, string | undefined>
    > = process.env,
  ) {}

  run(
    cwd: string,
    args: readonly string[],
    options: { readonly maxOutputBytes?: number } = {},
  ): Promise<GitArgvResult> {
    const maxOutputBytes = options.maxOutputBytes ?? 32 * 1024 * 1024;
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, [...args], {
        cwd,
        env: {
          ...sanitizeChildEnvironment(this.environment),
          GIT_EXTERNAL_DIFF: "",
          GIT_PAGER: "cat",
        },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const total = { bytes: 0 };
      let outputExceeded = false;
      const capture = (target: Buffer[], value: Buffer): void => {
        if (!outputExceeded && !appendBounded(target, value, total, maxOutputBytes)) {
          outputExceeded = true;
          child.kill();
        }
      };

      child.stdout.on("data", (value: Buffer) => capture(stdout, value));
      child.stderr.on("data", (value: Buffer) => capture(stderr, value));
      child.once("error", (error) => {
        reject(
          new GitArgvError("git_spawn_failed", "failed to start fixed-argv git", {
            cause: error,
          }),
        );
      });
      child.once("close", (exitCode) => {
        if (outputExceeded) {
          reject(
            new GitArgvError(
              "git_output_limit_exceeded",
              "fixed-argv git output exceeded its internal evidence limit",
            ),
          );
          return;
        }
        resolve({
          exitCode: exitCode ?? 1,
          stderr: Buffer.concat(stderr),
          stdout: Buffer.concat(stdout),
        });
      });
    });
  }
}
