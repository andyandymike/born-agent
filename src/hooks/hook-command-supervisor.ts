import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { sha256Canonical } from "../completion/canonical-json.js";
import type { ProcessTreeCleanup } from "../execution/process-tree-cleanup.js";
import { currentProcessIdentity } from "../sessions/process-identity.js";
import {
  appendBoundedHookOutput,
  MAX_HOOK_OUTPUT_BYTES,
  parseHookCommandResult,
} from "./hook-command-result.js";
import { HookCommandOperationStore } from "./hook-command-operation-store.js";
import {
  hookCommandSupervisorBootstrapSchema,
  hookCommandSupervisorCapturedSchema,
  hookCommandSupervisorStartedSchema,
  type HookCommandSupervisorMessageV1,
} from "./hook-command-supervisor-schema.js";

const BOOTSTRAP_TIMEOUT_MS = 30_000;

function hash(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readStableRegularFile(path: string, label: string): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error(`${label} is not a unique regular non-link file`);
  }
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.nlink !== 1 ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    bytes.byteLength !== after.size
  ) {
    throw new Error(`${label} changed while it was read`);
  }
  return bytes;
}

async function assertStableDirectory(path: string, label: string): Promise<void> {
  const absolute = resolve(path);
  const before = await lstat(absolute);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`${label} is not a plain directory`);
  }
  const canonical = await realpath(absolute);
  const canonicalMetadata = await lstat(canonical);
  const after = await lstat(absolute);
  if (
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    !canonicalMetadata.isDirectory() ||
    canonicalMetadata.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    canonicalMetadata.dev !== after.dev ||
    canonicalMetadata.ino !== after.ino
  ) {
    throw new Error(`${label} changed identity during validation`);
  }
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolveSpawn, reject) => {
    const cleanup = (): void => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
    };
    const onSpawn = (): void => {
      cleanup();
      if (child.pid === undefined) reject(new Error("spawned Hook child has no PID"));
      else resolveSpawn(child.pid);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function closeResult(child: ChildProcessWithoutNullStreams): Promise<{
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}> {
  return new Promise((resolveClose, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolveClose({ exitCode, signal }));
  });
}

export interface HookCommandSupervisorIpcPort {
  disconnect(): void;
  isConnected(): boolean;
  receive(timeoutMs: number): Promise<unknown>;
  send(message: HookCommandSupervisorMessageV1): Promise<void>;
  waitForDisconnect(): Promise<void>;
}

export class NodeHookCommandSupervisorIpcPort implements HookCommandSupervisorIpcPort {
  constructor(private readonly target: NodeJS.Process = process) {}

  isConnected(): boolean {
    return this.target.connected === true;
  }

  receive(timeoutMs: number): Promise<unknown> {
    if (typeof this.target.send !== "function" || !this.isConnected()) {
      throw new Error("internal Hook supervisor requires inherited IPC");
    }
    return new Promise((resolveMessage, reject) => {
      let settled = false;
      const finish = (error: Error | null, message?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.target.off("message", onMessage);
        this.target.off("disconnect", onDisconnect);
        if (error === null) resolveMessage(message);
        else reject(error);
      };
      const onMessage = (message: unknown) => finish(null, message);
      const onDisconnect = () => finish(new Error("parent IPC closed before Hook bootstrap"));
      const timer = setTimeout(
        () => finish(new Error("Hook supervisor bootstrap timed out")),
        timeoutMs,
      );
      this.target.once("message", onMessage);
      this.target.once("disconnect", onDisconnect);
    });
  }

  send(message: HookCommandSupervisorMessageV1): Promise<void> {
    if (typeof this.target.send !== "function" || !this.isConnected()) {
      throw new Error("parent IPC closed before Hook receipt");
    }
    return new Promise((resolveSend, reject) => {
      this.target.send!(message, (error) => {
        if (error == null) resolveSend();
        else reject(new Error("Hook receipt could not be sent", { cause: error }));
      });
    });
  }

  waitForDisconnect(): Promise<void> {
    if (!this.isConnected()) return Promise.resolve();
    return new Promise((resolveDisconnect) => this.target.once("disconnect", resolveDisconnect));
  }

  disconnect(): void {
    if (this.isConnected()) this.target.disconnect();
  }
}

export class HookCommandSupervisor {
  constructor(private readonly options: {
    readonly cleanup: ProcessTreeCleanup;
    readonly ipc?: HookCommandSupervisorIpcPort;
    readonly operationRoot: string;
    readonly randomUUID?: () => string;
    readonly timestamp?: () => string;
  }) {}

  async run(input: {
    readonly invocationId: string;
    readonly runId: string;
    readonly sessionId: string;
  }): Promise<void> {
    const ipc = this.options.ipc ?? new NodeHookCommandSupervisorIpcPort();
    const timestamp = this.options.timestamp ?? (() => new Date().toISOString());
    const random = this.options.randomUUID ?? randomUUID;
    const store = await HookCommandOperationStore.openExisting({
      ...input,
      root: this.options.operationRoot,
    });
    const bootstrap = hookCommandSupervisorBootstrapSchema.parse(
      await ipc.receive(BOOTSTRAP_TIMEOUT_MS),
    );
    const requested = await store.read();
    if (
      requested === null ||
      requested.state !== "requested" ||
      requested.actionSha256 !== bootstrap.actionSha256 ||
      requested.hookIdentitySha256 !== bootstrap.hookIdentitySha256 ||
      requested.inputSha256 !== bootstrap.inputSha256 ||
      requested.invocationId !== bootstrap.invocationId ||
      requested.mode !== bootstrap.mode ||
      requested.nonceSha256 !== hash(bootstrap.rawNonce)
    ) {
      throw new Error("Hook supervisor bootstrap disagrees with its durable operation");
    }
    const inputBytes = Buffer.from(bootstrap.inputBase64, "base64");
    if (hash(inputBytes) !== bootstrap.inputSha256) {
      throw new Error("Hook supervisor input bytes disagree with the requested digest");
    }
    const [nodeBytes, scriptBytes] = await Promise.all([
      readStableRegularFile(bootstrap.executablePath, "Node executable"),
      readStableRegularFile(bootstrap.scriptPath, "Hook script"),
      assertStableDirectory(bootstrap.cwd, "Hook cwd"),
    ]);
    if (hash(nodeBytes) !== bootstrap.executableSha256 || hash(scriptBytes) !== bootstrap.scriptSha256) {
      throw new Error("Hook executable bytes changed before supervised spawn");
    }

    const supervisor = currentProcessIdentity();
    await store.markSpawning({
      nonce: random(),
      spawningAt: timestamp(),
      supervisor: {
        supervisorPid: supervisor.pid,
        supervisorStartIdentity: supervisor.startIdentity,
      },
    });
    if (!ipc.isConnected()) {
      await store.markNotStartedCaptured({
        capturedAt: timestamp(),
        code: "hook_invocation_cancelled",
        nonce: random(),
      });
      return;
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(bootstrap.executablePath, [bootstrap.scriptPath, ...bootstrap.argv], {
        cwd: bootstrap.cwd,
        detached: process.platform !== "win32",
        env: bootstrap.environment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      await store.markNotStartedCaptured({
        capturedAt: timestamp(),
        code: "hook_invocation_failed",
        nonce: random(),
      });
      await ipc.send(hookCommandSupervisorCapturedSchema.parse({
        invocationId: input.invocationId,
        kind: "captured",
        protocolVersion: 1,
      })).catch(() => undefined);
      return;
    }

    const parentDisconnected = ipc.waitForDisconnect();
    let spawnWinner: { readonly kind: "spawn"; readonly pid: number } | { readonly kind: "disconnect" };
    try {
      spawnWinner = await Promise.race([
        waitForSpawn(child).then((pid) => ({ kind: "spawn" as const, pid })),
        parentDisconnected.then(() => ({ kind: "disconnect" as const })),
      ]);
    } catch {
      await store.markNotStartedCaptured({
        capturedAt: timestamp(),
        code: "hook_invocation_failed",
        nonce: random(),
      });
      await ipc.send(hookCommandSupervisorCapturedSchema.parse({
        invocationId: input.invocationId,
        kind: "captured",
        protocolVersion: 1,
      })).catch(() => undefined);
      return;
    }
    const observedPid = child.pid;
    if (spawnWinner.kind === "disconnect" && observedPid === undefined) {
      await store.markNotStartedCaptured({
        capturedAt: timestamp(),
        code: "hook_invocation_cancelled",
        nonce: random(),
      });
      return;
    }
    const pid = spawnWinner.kind === "spawn" ? spawnWinner.pid : observedPid!;
    const processIdentitySha256 = sha256Canonical({
      action_sha256: bootstrap.actionSha256,
      invocation_id: bootstrap.invocationId,
      nonce: random(),
      pid,
      supervisor_start_identity: supervisor.startIdentity,
    });
    await store.markStarted({
      nonce: random(),
      process: {
        hookPid: pid,
        processIdentitySha256,
        supervisorPid: supervisor.pid,
        supervisorStartIdentity: supervisor.startIdentity,
      },
      startedAt: timestamp(),
    });
    const startedReceipt = hookCommandSupervisorStartedSchema.parse({
      hookPid: pid,
      invocationId: input.invocationId,
      kind: "started",
      processIdentitySha256,
      protocolVersion: 1,
      supervisorPid: supervisor.pid,
      supervisorStartIdentity: supervisor.startIdentity,
    });

    const captureFailure = async (
      code: "hook_gate_output_invalid" | "hook_invocation_cancelled" | "hook_invocation_failed" | "hook_invocation_timeout",
    ): Promise<void> => {
      const current = await store.read();
      if (current?.state === "started") {
        await store.markCaptured({
          capture: { code, effectState: "unknown", kind: "failure" },
          capturedAt: timestamp(),
          nonce: random(),
        });
      }
    };

    if (spawnWinner.kind === "disconnect") {
      await this.#terminateChild(child, pid);
      await captureFailure("hook_invocation_cancelled");
      return;
    }
    try {
      await ipc.send(startedReceipt);
    } catch {
      await this.#terminateChild(child, pid);
      await captureFailure("hook_invocation_cancelled");
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputLimitResolve: (() => void) | undefined;
    const outputLimit = new Promise<void>((resolveLimit) => {
      outputLimitResolve = resolveLimit;
    });
    child.stdout.on("data", (chunk: Buffer) => {
      const result = appendBoundedHookOutput(stdout, stdoutBytes, chunk);
      stdoutBytes = result.size;
      if (result.exceeded || stdoutBytes + stderrBytes > MAX_HOOK_OUTPUT_BYTES) outputLimitResolve?.();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const result = appendBoundedHookOutput(stderr, stderrBytes, chunk);
      stderrBytes = result.size;
      if (result.exceeded || stdoutBytes + stderrBytes > MAX_HOOK_OUTPUT_BYTES) outputLimitResolve?.();
    });
    child.stdin.on("error", () => undefined);
    const close = closeResult(child);
    child.stdin.end(inputBytes);
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolveTimeout) => {
      timeoutHandle = setTimeout(resolveTimeout, bootstrap.timeoutMs);
    });
    const winner = await Promise.race([
      close.then((value) => ({ kind: "close" as const, value })),
      timeout.then(() => ({ kind: "timeout" as const })),
      parentDisconnected.then(() => ({ kind: "disconnect" as const })),
      outputLimit.then(() => ({ kind: "output_limit" as const })),
    ]);
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);

    if (winner.kind !== "close") {
      await this.#terminateChild(child, pid);
      await captureFailure(
        winner.kind === "timeout"
          ? "hook_invocation_timeout"
          : winner.kind === "output_limit"
            ? "hook_gate_output_invalid"
            : "hook_invocation_cancelled",
      );
      if (winner.kind !== "disconnect") {
        await ipc.send(hookCommandSupervisorCapturedSchema.parse({
          invocationId: input.invocationId,
          kind: "captured",
          protocolVersion: 1,
        })).catch(() => undefined);
      }
      return;
    }
    const cleanupVerified = await this.#terminateChild(child, pid);
    if (!cleanupVerified || winner.value.exitCode !== 0 || winner.value.signal !== null) {
      await captureFailure("hook_invocation_failed");
      await ipc.send(hookCommandSupervisorCapturedSchema.parse({
        invocationId: input.invocationId,
        kind: "captured",
        protocolVersion: 1,
      })).catch(() => undefined);
      return;
    }
    const [finalNodeBytes, finalScriptBytes] = await Promise.all([
      readStableRegularFile(bootstrap.executablePath, "Node executable"),
      readStableRegularFile(bootstrap.scriptPath, "Hook script"),
      assertStableDirectory(bootstrap.cwd, "Hook cwd"),
    ]).catch(async (error: unknown) => {
      await captureFailure("hook_invocation_failed");
      throw error;
    });
    if (hash(finalNodeBytes) !== bootstrap.executableSha256 || hash(finalScriptBytes) !== bootstrap.scriptSha256) {
      await captureFailure("hook_invocation_failed");
    } else {
      try {
        const result = parseHookCommandResult({
          actionSha256: bootstrap.actionSha256,
          mode: bootstrap.mode,
          secrets: bootstrap.secrets,
          stderr,
          stdout,
        });
        await store.markCaptured({
          capture: result.kind === "gate"
            ? { ...result, evidence: [...result.evidence] }
            : { ...result },
          capturedAt: timestamp(),
          nonce: random(),
        });
      } catch {
        await captureFailure("hook_gate_output_invalid");
      }
    }
    await ipc.send(hookCommandSupervisorCapturedSchema.parse({
      invocationId: input.invocationId,
      kind: "captured",
      protocolVersion: 1,
    })).catch(() => undefined);
    ipc.disconnect();
  }

  async #terminateChild(child: ChildProcessWithoutNullStreams, pid: number): Promise<boolean> {
    const first = await this.options.cleanup.terminate(pid);
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The close/liveness checks below are authoritative.
      }
    }
    await new Promise<void>((resolveClose) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("close", finish);
        resolveClose();
      };
      const timer = setTimeout(finish, 5_000);
      if (child.exitCode !== null || child.signalCode !== null) finish();
      else child.once("close", finish);
    });
    if (first.verified) return true;
    return (await this.options.cleanup.terminate(pid)).verified;
  }
}
