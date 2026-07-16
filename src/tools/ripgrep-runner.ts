import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type RipgrepRunResult =
  | {
      readonly exitCode: number;
      readonly kind: "completed";
      readonly lines: readonly string[];
      readonly truncated: boolean;
    }
  | { readonly kind: "cancelled" }
  | { readonly kind: "missing" }
  | { readonly kind: "timeout" }
  | { readonly kind: "failed" };

export interface RipgrepRunOptions {
  readonly cwd: string;
  readonly maxStdoutBytes: number;
  readonly onLine?: (line: string) => boolean;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export interface RipgrepRunnerLike {
  run(
    args: readonly string[],
    options: RipgrepRunOptions,
  ): Promise<RipgrepRunResult>;
}

export type SpawnRipgrep = (
  args: readonly string[],
  cwd: string,
) => ChildProcessWithoutNullStreams;

const spawnRipgrep: SpawnRipgrep = (args, cwd) =>
  spawn("rg", [...args], {
    cwd,
    shell: false,
    stdio: "pipe",
    windowsHide: true,
  });

export class RipgrepRunner implements RipgrepRunnerLike {
  constructor(private readonly spawnProcess: SpawnRipgrep = spawnRipgrep) {}

  run(
    args: readonly string[],
    options: RipgrepRunOptions,
  ): Promise<RipgrepRunResult> {
    return new Promise((resolve) => {
      if (options.signal.aborted) {
        resolve({ kind: "cancelled" });
        return;
      }

      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnProcess(args, options.cwd);
      } catch {
        resolve({ kind: "failed" });
        return;
      }

      const lines: string[] = [];
      let buffer = "";
      let capturedBytes = 0;
      let reason: "cancelled" | "limit" | "timeout" | undefined;
      let settled = false;

      const stop = (nextReason: typeof reason) => {
        if (reason === undefined) {
          reason = nextReason;
          child.kill();
        }
      };
      const onAbort = () => stop("cancelled");
      options.signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => stop("timeout"), options.timeoutMs);

      const finish = (result: RipgrepRunResult) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        options.signal.removeEventListener("abort", onAbort);
        resolve(result);
      };

      const acceptLine = (line: string) => {
        const lineBytes = Buffer.byteLength(`${line}\n`, "utf8");
        if (capturedBytes + lineBytes > options.maxStdoutBytes) {
          stop("limit");
          return;
        }
        if (options.onLine !== undefined && !options.onLine(line)) {
          stop("limit");
          return;
        }
        capturedBytes += lineBytes;
        lines.push(line);
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline >= 0 && reason === undefined) {
          const line = buffer.slice(0, newline).replace(/\r$/u, "");
          buffer = buffer.slice(newline + 1);
          acceptLine(line);
          newline = buffer.indexOf("\n");
        }
      });
      child.stderr.resume();
      child.on("error", (error: NodeJS.ErrnoException) => {
        finish(error.code === "ENOENT" ? { kind: "missing" } : { kind: "failed" });
      });
      child.on("close", (exitCode) => {
        if (reason === "cancelled") {
          finish({ kind: "cancelled" });
          return;
        }
        if (reason === "timeout") {
          finish({ kind: "timeout" });
          return;
        }
        if (reason === undefined && buffer.length > 0) {
          acceptLine(buffer.replace(/\r$/u, ""));
        }
        finish({
          exitCode: reason === "limit" ? 0 : (exitCode ?? 2),
          kind: "completed",
          lines,
          truncated: reason === "limit",
        });
      });
    });
  }
}
