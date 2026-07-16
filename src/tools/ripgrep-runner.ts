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
  // PHASE3: 专用 runner 只能启动固定程序 rg，且 shell:false；它不是通用命令执行器。
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
        // PHASE3: cancel、timeout 或结果上限都会终止子进程；Promise 要等 close 后才结算。
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
        // PHASE3: 在继续积累内存前检查 UTF-8 捕获字节和调用方的行数/match 数预算。
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
      // PHASE3: 消费但不透传原始 stderr，避免绝对路径、查询片段或系统细节进入用户输出/session。
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
