import type {
  ChildProcessByStdio,
  spawn as nodeSpawn,
} from "node:child_process";
import type { Readable } from "node:stream";

import type {
  ExecutionResult,
  ExecutionSignal,
  ExecutionTermination,
  Executor,
  PreparedExecution,
} from "./execution-types.js";
import { BoundedOutputCapture } from "./output-capture.js";
import { sanitizeChildEnvironment } from "../security/child-environment.js";
import type {
  CleanupTimerApi,
  ProcessTreeCleanup,
  ProcessTreeCleanupResult,
} from "./process-tree-cleanup.js";

export interface ExecutionClock {
  now(): number;
}

export interface SpawnedProcessHandle {
  readonly pid: number | undefined;
  onSpawn(listener: () => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  onClose(
    listener: (exitCode: number | null, signal: string | null) => void,
  ): () => void;
  onOutput(
    stream: "stdout" | "stderr",
    listener: (chunk: Uint8Array) => void,
  ): () => void;
}

export type SpawnAdapter = (
  file: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly detached: boolean;
    readonly environment: Readonly<Record<string, string>>;
    readonly shell: false;
  },
) => SpawnedProcessHandle;

export type NodeSpawnFunction = typeof nodeSpawn;

function subscribe(
  child: ChildProcessByStdio<null, Readable, Readable>,
  event: "spawn",
  listener: () => void,
): () => void;
function subscribe(
  child: ChildProcessByStdio<null, Readable, Readable>,
  event: "error",
  listener: (error: Error) => void,
): () => void;
function subscribe(
  child: ChildProcessByStdio<null, Readable, Readable>,
  event: "close",
  listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void,
): () => void;
function subscribe(
  child: ChildProcessByStdio<null, Readable, Readable>,
  event: "close" | "error" | "spawn",
  listener:
    | (() => void)
    | ((error: Error) => void)
    | ((exitCode: number | null, signal: NodeJS.Signals | null) => void),
): () => void {
  child.on(event, listener);
  return () => child.removeListener(event, listener);
}

export function createNodeSpawnAdapter(spawnProcess: NodeSpawnFunction): SpawnAdapter {
  return (file, args, options) => {
    // PHASE6: This adapter preserves argv boundaries and hard-codes shell:false.
    // It prevents host-shell parsing, but approved repository code remains fully capable
    // of its own host side effects and is not an OS sandbox.
    const child = spawnProcess(file, [...args], {
      cwd: options.cwd,
      detached: options.detached,
      // PHASE8: sanitize again at the final spawn boundary. This keeps an
      // injected/custom PreparedExecution from bypassing ExecutionPreparer's
      // minimal-environment policy.
      env: sanitizeChildEnvironment(options.environment),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    return {
      onClose(listener) {
        return subscribe(child, "close", (exitCode, signal) =>
          listener(exitCode, signal),
        );
      },
      onError(listener) {
        return subscribe(child, "error", listener);
      },
      onOutput(stream, listener) {
        const readable = child[stream];
        const onData = (chunk: Buffer): void => listener(chunk);
        readable.on("data", onData);
        return () => readable.removeListener("data", onData);
      },
      onSpawn(listener) {
        return subscribe(child, "spawn", listener);
      },
      pid: child.pid,
    };
  };
}

type InternalEvent =
  | { readonly type: "spawn" }
  | { readonly type: "error"; readonly error: Error }
  | {
      readonly type: "close";
      readonly exitCode: number | null;
      readonly signal: string | null;
    }
  | {
      readonly type: "output";
      readonly stream: "stdout" | "stderr";
      readonly chunk: Uint8Array;
    }
  | { readonly type: "timeout" }
  | { readonly type: "abort" }
  | {
      readonly type: "cleanup";
      readonly result: ProcessTreeCleanupResult;
    };

class AsyncEventQueue {
  private readonly queued: InternalEvent[] = [];
  private waiter: ((event: InternalEvent) => void) | undefined;

  push(event: InternalEvent): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter(event);
    } else {
      this.queued.push(event);
    }
  }

  async next(): Promise<InternalEvent> {
    const queued = this.queued.shift();
    if (queued) {
      return queued;
    }
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

function spawnErrorCode(error: Error): string {
  const code = (error as Error & { readonly code?: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/u.test(code)
    ? code.toLowerCase()
    : "spawn_failed";
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function cleanupWithoutThrowing(
  cleanup: ProcessTreeCleanup,
  processIdentity: number | undefined,
): Promise<ProcessTreeCleanupResult> {
  try {
    return await cleanup.terminate(processIdentity);
  } catch {
    return { detail: "force_failed", forced: true, verified: false };
  }
}

export class LocalExecutor implements Executor {
  constructor(
    private readonly options: {
      readonly platform: NodeJS.Platform;
      readonly spawn: SpawnAdapter;
      readonly processTreeCleanup: ProcessTreeCleanup;
      readonly clock: ExecutionClock;
      readonly timers: CleanupTimerApi;
      readonly redact?: (value: string) => string;
    },
  ) {}

  async *execute(
    prepared: PreparedExecution,
    signal: AbortSignal,
  ): AsyncIterable<ExecutionSignal> {
    const startedAt = this.options.clock.now();
    if (signal.aborted) {
      yield {
        result: this.result({
          capture: new BoundedOutputCapture(prepared.request.outputLimitBytes),
          cleanupVerified: true,
          durationMs: this.options.clock.now() - startedAt,
          termination: "cancelled",
        }),
        type: "completed",
      };
      return;
    }

    const queue = new AsyncEventQueue();
    const capture = new BoundedOutputCapture(prepared.request.outputLimitBytes, {
      ...(this.options.redact ? { redact: this.options.redact } : {}),
    });
    let child: SpawnedProcessHandle;
    try {
      child = this.options.spawn(
        prepared.request.executableFile,
        prepared.request.args,
        {
          cwd: prepared.request.cwd,
          detached: this.options.platform !== "win32",
          environment: prepared.request.environment,
          shell: false,
        },
      );
    } catch (error) {
      const spawnError = error instanceof Error ? error : new Error("spawn failed");
      yield {
        result: this.result({
          capture,
          cleanupVerified: true,
          durationMs: this.options.clock.now() - startedAt,
          errorCode: spawnErrorCode(spawnError),
          termination: "spawn_error",
        }),
        type: "completed",
      };
      return;
    }

    const unsubscribe = [
      child.onSpawn(() => queue.push({ type: "spawn" })),
      child.onError((error) => queue.push({ error, type: "error" })),
      child.onClose((exitCode, childSignal) =>
        queue.push({ exitCode, signal: childSignal, type: "close" }),
      ),
      child.onOutput("stdout", (chunk) =>
        queue.push({ chunk, stream: "stdout", type: "output" }),
      ),
      child.onOutput("stderr", (chunk) =>
        queue.push({ chunk, stream: "stderr", type: "output" }),
      ),
    ];
    const onAbort = (): void => queue.push({ type: "abort" });
    signal.addEventListener("abort", onAbort, { once: true });
    const timeoutHandle = this.options.timers.setTimeout(
      () => queue.push({ type: "timeout" }),
      prepared.request.timeoutMs,
    );

    let firstCause: "cancelled" | "output_limit_exceeded" | "timeout" | null = null;
    const cleanupState: {
      promise: Promise<ProcessTreeCleanupResult> | null;
    } = { promise: null };
    let closed = false;
    let completed = false;
    const startCleanup = (
      cause: "cancelled" | "output_limit_exceeded" | "timeout",
    ): void => {
      if (firstCause !== null || closed) {
        return;
      }
      firstCause = cause;
      cleanupState.promise = cleanupWithoutThrowing(
        this.options.processTreeCleanup,
        child.pid,
      );
      void cleanupState.promise.then((result) =>
        queue.push({ result, type: "cleanup" }),
      );
    };

    try {
      while (!completed) {
        const event = await queue.next();
        if (event.type === "spawn") {
          // PHASE6: The caller persists command.started before requesting the next
          // generator item. If that write throws, finally performs immediate cleanup;
          // the persisted requested-without-started window remains effect unknown.
          yield {
            ...(child.pid === undefined
              ? {}
              : { processIdentity: String(child.pid) }),
            type: "started",
          };
          continue;
        }
        if (event.type === "output") {
          const chunk = capture.append(event.stream, event.chunk);
          if (chunk.text.length > 0) {
            yield {
              chunk: chunk.text,
              chunkBytes: utf8ByteLength(chunk.text),
              stream: chunk.stream,
              type: "output",
            };
          }
          if (chunk.limitExceeded) {
            startCleanup("output_limit_exceeded");
          }
          continue;
        }
        if (event.type === "abort") {
          startCleanup("cancelled");
          continue;
        }
        if (event.type === "timeout") {
          startCleanup("timeout");
          continue;
        }
        if (event.type === "error") {
          closed = true;
          for (const chunk of capture.finish()) {
            yield {
              chunk: chunk.text,
              chunkBytes: utf8ByteLength(chunk.text),
              stream: chunk.stream,
              type: "output",
            };
          }
          yield {
            result: this.result({
              capture,
              cleanupVerified: true,
              durationMs: this.options.clock.now() - startedAt,
              errorCode: spawnErrorCode(event.error),
              ...(child.pid === undefined ? {} : { processIdentity: child.pid }),
              termination: "spawn_error",
            }),
            type: "completed",
          };
          completed = true;
          continue;
        }
        if (event.type === "cleanup" && !closed) {
          if (!event.result.verified) {
            for (const chunk of capture.finish()) {
              yield {
                chunk: chunk.text,
                chunkBytes: utf8ByteLength(chunk.text),
                stream: chunk.stream,
                type: "output",
              };
            }
            yield {
              result: this.result({
                capture,
                cleanupVerified: false,
                durationMs: this.options.clock.now() - startedAt,
                errorCode: event.result.detail,
                ...(child.pid === undefined ? {} : { processIdentity: child.pid }),
                termination: "cleanup_failed",
              }),
              type: "completed",
            };
            completed = true;
          }
          continue;
        }
        if (event.type === "close") {
          closed = true;
          const cleanup = await (
            cleanupState.promise ??
            cleanupWithoutThrowing(this.options.processTreeCleanup, child.pid)
          );
          for (const chunk of capture.finish()) {
            yield {
              chunk: chunk.text,
              chunkBytes: utf8ByteLength(chunk.text),
              stream: chunk.stream,
              type: "output",
            };
          }
          const cleanupFailed = !cleanup.verified;
          const termination: ExecutionTermination = cleanupFailed
            ? "cleanup_failed"
            : (firstCause ?? (event.signal ? "signal" : "exit"));
          yield {
            result: this.result({
              capture,
              cleanupVerified: cleanup.verified,
              durationMs: this.options.clock.now() - startedAt,
              ...(cleanupFailed ? { errorCode: cleanup.detail } : {}),
              exitCode: event.exitCode,
              ...(child.pid === undefined ? {} : { processIdentity: child.pid }),
              signal: event.signal,
              termination,
            }),
            type: "completed",
          };
          completed = true;
        }
      }
    } finally {
      this.options.timers.clearTimeout(timeoutHandle);
      signal.removeEventListener("abort", onAbort);
      for (const removeListener of unsubscribe) {
        removeListener();
      }
      if (!closed && child.pid !== undefined) {
        // Consumer failure includes persistence failure after spawn. Do not let the
        // child continue merely because the event pipeline stopped consuming signals.
        await (
          cleanupState.promise ??
            cleanupWithoutThrowing(this.options.processTreeCleanup, child.pid)
        );
      }
    }
  }

  private result(options: {
    readonly capture: BoundedOutputCapture;
    readonly cleanupVerified: boolean;
    readonly durationMs: number;
    readonly termination: ExecutionTermination;
    readonly exitCode?: number | null;
    readonly signal?: string | null;
    readonly processIdentity?: number;
    readonly errorCode?: string;
  }): ExecutionResult {
    const ok = options.termination === "exit" || options.termination === "signal";
    return Object.freeze({
      cleanupVerified: options.cleanupVerified,
      durationMs: Math.max(0, Math.round(options.durationMs)),
      ...(options.errorCode ? { errorCode: options.errorCode } : {}),
      exitCode: options.exitCode ?? null,
      ok,
      ...(options.processIdentity === undefined
        ? {}
        : { processIdentity: String(options.processIdentity) }),
      signal: options.signal ?? null,
      stderr: options.capture.stderr,
      stderrBytes: options.capture.stderrBytes,
      stdout: options.capture.stdout,
      stdoutBytes: options.capture.stdoutBytes,
      termination: options.termination,
      truncated: options.capture.truncated,
    });
  }
}
