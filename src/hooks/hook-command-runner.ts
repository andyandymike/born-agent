import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import type { ApprovalPrompt, CommandApprovalPreview } from "../approvals/approval-types.js";
import type { FrozenCapabilityContentSource } from "../capabilities/capability-platform.js";
import type { FrozenCapabilityRecord } from "../capabilities/capability-types.js";
import { sha256Canonical } from "../completion/canonical-json.js";
import type { ProcessTreeCleanup } from "../execution/process-tree-cleanup.js";
import { sanitizeChildEnvironment } from "../security/child-environment.js";
import {
  appendBoundedHookOutput,
  HookCommandResultError,
  MAX_HOOK_OUTPUT_BYTES,
  parseHookCommandResult,
  type HookCommandRunnerResult,
} from "./hook-command-result.js";
import { HookCommandOperationStore } from "./hook-command-operation-store.js";
import {
  hookCommandSupervisorBootstrapSchema,
  hookCommandSupervisorMessageSchema,
  type HookCommandSupervisorMessageV1,
} from "./hook-command-supervisor-schema.js";
import { HookError } from "./hook-errors.js";

const FORBIDDEN_ENVIRONMENT_NAME = /(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH|COOKIE|PROXY)|^(?:ALL_PROXY|BORN_|COMSPEC|GIT_|HTTP_PROXY|HTTPS_PROXY|LD_PRELOAD|NODE_|NPM_|NO_PROXY|PATH|SSH_|SYSTEMROOT|TEMP|TMP|WINDIR|DYLD_)/iu;

export interface HookCommandRunnerEventSink {
  approvalDecided(input: {
    readonly actionSha256: string;
    readonly decision: "approved" | "cancelled" | "denied";
    readonly invocationId: string;
    readonly requestId: string;
  }): Promise<void>;
  approvalRequested(input: {
    readonly actionSha256: string;
    readonly invocationId: string;
    readonly preview: string;
    readonly requestId: string;
    readonly truncated: boolean;
  }): Promise<void>;
  permissionEvaluated(input: {
    readonly actionSha256: string;
    readonly effect: "ask" | "deny";
    readonly invocationId: string;
    readonly reasonCode: string;
  }): Promise<void>;
  started(input: {
    readonly actionSha256: string;
    readonly invocationId: string;
    readonly pid: number;
    readonly processIdentitySha256: string;
  }): Promise<void>;
}

export type { HookCommandRunnerResult } from "./hook-command-result.js";

export interface HookCommandOperationContext {
  readonly failurePolicy: "fail_closed" | "record_degraded";
  readonly requestedEventId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly sessionLockNonceSha256: string;
  readonly terminalEventId: string;
}

export interface HookCommandRunnerInput {
  readonly events: HookCommandRunnerEventSink;
  readonly hook: FrozenCapabilityRecord;
  readonly inputBytes: Buffer;
  readonly inputSha256: string;
  readonly invocationId: string;
  readonly operation?: HookCommandOperationContext;
  readonly signal: AbortSignal;
}

export interface HookCommandRunnerLike {
  run(input: HookCommandRunnerInput): Promise<HookCommandRunnerResult>;
  terminalCommitted?(input: HookCommandOperationContext & {
    readonly invocationId: string;
    readonly terminalType: "hook.invocation.completed" | "hook.invocation.decided" | "hook.invocation.failed";
  }): Promise<void>;
}

export class HookCommandExecutionError extends HookError {
  constructor(
    code: "hook_approval_denied" | "hook_gate_output_invalid" | "hook_invocation_cancelled" | "hook_invocation_failed" | "hook_invocation_timeout",
    message: string,
    readonly effectState: "none" | "unknown",
    options: ErrorOptions = {},
  ) {
    super(code, message, code === "hook_invocation_cancelled" ? 130 : 8, options);
  }
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolveSpawn, reject) => {
    const onSpawn = (): void => {
      cleanup();
      if (child.pid === undefined) reject(new Error("spawned Hook child has no PID"));
      else resolveSpawn(child.pid);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function closeResult(child: ChildProcessWithoutNullStreams): Promise<{ readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }> {
  return new Promise((resolveClose, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolveClose({ exitCode, signal }));
  });
}

function truncateUtf8(value: string, limit: number): string {
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const next = Buffer.byteLength(character, "utf8");
    if (bytes + next > limit) break;
    output += character;
    bytes += next;
  }
  return output;
}

class SupervisorReceiptQueue {
  readonly #queued: HookCommandSupervisorMessageV1[] = [];
  readonly #waiters: {
    readonly reject: (error: Error) => void;
    readonly resolve: (message: HookCommandSupervisorMessageV1) => void;
  }[] = [];
  #terminalError: Error | undefined;

  constructor(child: ChildProcess) {
    child.on("message", (value: unknown) => {
      try {
        this.#push(hookCommandSupervisorMessageSchema.parse(value));
      } catch (error) {
        this.#end(new Error("Hook supervisor sent an invalid receipt", { cause: error }));
      }
    });
    child.once("error", (error) => this.#end(new Error("Hook supervisor process failed", { cause: error })));
    child.once("exit", (code, signal) => this.#end(new Error(
      `Hook supervisor exited before its next receipt (code=${String(code)}, signal=${String(signal)})`,
    )));
  }

  next(): Promise<HookCommandSupervisorMessageV1> {
    const queued = this.#queued.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.#terminalError !== undefined) return Promise.reject(this.#terminalError);
    return new Promise((resolve, reject) => this.#waiters.push({ reject, resolve }));
  }

  #push(message: HookCommandSupervisorMessageV1): void {
    if (this.#terminalError !== undefined) return;
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#queued.push(message);
    else waiter.resolve(message);
  }

  #end(error: Error): void {
    if (this.#terminalError !== undefined) return;
    this.#terminalError = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }
}

function supervisorFailureMessage(code: string): string {
  switch (code) {
    case "hook_gate_output_invalid":
      return "Hook supervisor captured invalid command output";
    case "hook_invocation_cancelled":
      return "Hook supervisor captured cancellation";
    case "hook_invocation_timeout":
      return "Hook supervisor captured a timeout";
    default:
      return "Hook supervisor captured an execution failure";
  }
}

async function readStableRegularFile(path: string, label: string): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`${label} is not a regular non-link file`);
  }
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
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

export class HookCommandRunner implements HookCommandRunnerLike {
  constructor(private readonly options: {
    readonly cleanup: ProcessTreeCleanup;
    readonly content: FrozenCapabilityContentSource;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly executable: string;
    readonly operationRoot?: string;
    readonly prompt: ApprovalPrompt;
    readonly randomUUID: () => string;
    readonly secrets: readonly (string | undefined)[];
    readonly supervisorCliEntryPath?: string;
    readonly timestamp?: () => string;
    readonly workspace: string;
  }) {}

  async run(input: HookCommandRunnerInput): Promise<HookCommandRunnerResult> {
    if (input.signal.aborted) {
      throw new HookCommandExecutionError("hook_invocation_cancelled", "Hook command was cancelled before spawn", "none");
    }
    if (input.hook.metadata.kind !== "hook") {
      throw new HookCommandExecutionError("hook_invocation_failed", "Hook command runner received non-command metadata", "none");
    }
    const metadata = input.hook.metadata;
    const handler = metadata.handler;
    if (handler.type !== "command") {
      throw new HookCommandExecutionError("hook_invocation_failed", "Hook command runner received non-command metadata", "none");
    }
    if (
      handler.sandbox === "required" ||
      !input.hook.requestedEffects.includes("process_spawn") ||
      input.hook.requestedEffects.some((effect) => effect === "network" || effect === "workspace_write")
    ) {
      await input.events.permissionEvaluated({
        actionSha256: sha256Canonical({ hook: input.hook.identity, input: input.inputSha256, unsupported: true }),
        effect: "deny",
        invocationId: input.invocationId,
        reasonCode: handler.sandbox === "required"
          ? "required_sandbox_unavailable"
          : "hook_requested_effects_unsupported",
      });
      throw new HookCommandExecutionError(
        "hook_invocation_failed",
        handler.sandbox === "required"
          ? "Hook requires an unavailable OS sandbox"
          : "Hook requests effects outside the bounded command runner",
        "none",
      );
    }
    const extension = extname(handler.executable).toLowerCase();
    if (![".cjs", ".js", ".mjs"].includes(extension)) {
      throw new HookCommandExecutionError("hook_invocation_failed", "Hook executable must be a frozen JavaScript module", "none");
    }
    for (const name of Object.keys(handler.environment ?? {})) {
      if (FORBIDDEN_ENVIRONMENT_NAME.test(name)) {
        throw new HookCommandExecutionError("hook_invocation_failed", "Hook environment cannot declare credential, proxy, runtime-injection, or Host-reserved names", "none");
      }
    }
    const script = await this.options.content.readComponentFile(input.hook.identity, handler.executable)
      .catch((error: unknown) => {
        throw new HookCommandExecutionError("hook_invocation_failed", "Hook executable could not be frozen", "none", { cause: error });
      });
    const [scriptMetadata, nodeBytes] = await Promise.all([
      lstat(script.absolutePath),
      readStableRegularFile(this.options.executable, "Node executable"),
    ]).catch((error: unknown) => {
      throw new HookCommandExecutionError("hook_invocation_failed", "Hook executable identity could not be verified", "none", { cause: error });
    });
    if (!scriptMetadata.isFile() || scriptMetadata.isSymbolicLink()) {
      throw new HookCommandExecutionError("hook_invocation_failed", "Hook script is not a regular non-link file", "none");
    }
    const nodeSha256 = createHash("sha256").update(nodeBytes).digest("hex");
    const actionSha256 = sha256Canonical({
      argv: handler.argv,
      cwd: handler.cwd,
      environment: handler.environment ?? {},
      hook_identity: input.hook.identity,
      hook_input_sha256: input.inputSha256,
      node_sha256: nodeSha256,
      sandbox: handler.sandbox,
      script_path: script.path,
      script_sha256: script.sha256,
      timeout_ms: metadata.timeout_ms ?? 10_000,
    });
    await input.events.permissionEvaluated({
      actionSha256,
      effect: "ask",
      invocationId: input.invocationId,
      reasonCode: "frozen_command_hook_requires_user_approval",
    });
    const requestId = this.options.randomUUID();
    const approvalPreview: CommandApprovalPreview = {
      actionKind: "run_command",
      actionSha256,
      args: [`capability:${input.hook.identity.qualifiedId}/${handler.executable}`, ...handler.argv],
      cwd: handler.cwd,
      executable: "node",
      purpose: "inspect",
      reviewLines: [
        `Hook: ${input.hook.identity.qualifiedId}`,
        `event mode: ${metadata.mode}`,
        `frozen script sha256: ${script.sha256}`,
        `timeout_ms: ${String(metadata.timeout_ms ?? 10_000)}`,
        "input: canonical JSON over one closed stdin stream",
      ],
      riskWarning: "The Hook is argv-only and bounded, but policy_selected local execution is not an OS sandbox.",
    };
    const previewSource = [
      ...approvalPreview.reviewLines,
      `cwd: ${approvalPreview.cwd}`,
      `executor: ${approvalPreview.executor ?? "local"}`,
      `executable: ${approvalPreview.executable}`,
      ...approvalPreview.args.map((argument, index) => `argv[${String(index)}]: ${argument}`),
      `purpose: ${approvalPreview.purpose}`,
      `WARNING: ${approvalPreview.riskWarning}`,
    ].join("\n");
    const persistedPreview = truncateUtf8(previewSource, 32 * 1024);
    await input.events.approvalRequested({
      actionSha256,
      invocationId: input.invocationId,
      preview: persistedPreview,
      requestId,
      truncated: persistedPreview !== previewSource,
    });
    const decision = await this.options.prompt.request(approvalPreview, input.signal);
    await input.events.approvalDecided({ actionSha256, decision, invocationId: input.invocationId, requestId });
    if (decision !== "approved") {
      throw new HookCommandExecutionError("hook_approval_denied", "Hook command was not approved", "none");
    }

    const revalidated = await this.options.content.readComponentFile(input.hook.identity, handler.executable)
      .catch((error: unknown) => {
        throw new HookCommandExecutionError("hook_invocation_failed", "Hook script changed after approval", "none", { cause: error });
      });
    const [revalidatedMetadata, revalidatedNodeBytes] = await Promise.all([
      lstat(revalidated.absolutePath),
      readStableRegularFile(this.options.executable, "Node executable"),
    ]).catch((error: unknown) => {
      throw new HookCommandExecutionError("hook_invocation_failed", "Hook executable changed after approval", "none", { cause: error });
    });
    if (
      !revalidatedMetadata.isFile() ||
      revalidatedMetadata.isSymbolicLink() ||
      revalidated.sha256 !== script.sha256 ||
      revalidated.path !== script.path ||
      revalidated.packageRoot !== script.packageRoot ||
      createHash("sha256").update(revalidatedNodeBytes).digest("hex") !== nodeSha256
    ) {
      throw new HookCommandExecutionError("hook_invocation_failed", "Hook executable bytes changed after approval", "none");
    }
    const childEnvironment = sanitizeChildEnvironment({
      BORN_HOOK_PROTOCOL: "1",
      BORN_HOOK_ACTION_SHA256: actionSha256,
      BORN_HOOK_DEPTH: "1",
      BORN_HOOK_SUPPRESSED: "1",
      SystemRoot: this.options.environment.SystemRoot,
      TEMP: this.options.environment.TEMP,
      TMP: this.options.environment.TMP,
      WINDIR: this.options.environment.WINDIR,
      ...(handler.environment ?? {}),
    });
    const operation = input.operation;
    if (
      operation !== undefined &&
      this.options.operationRoot !== undefined &&
      this.options.supervisorCliEntryPath !== undefined
    ) {
      return this.#runSupervised({ ...input, operation }, {
        actionSha256,
        argv: handler.argv,
        cwd: handler.cwd === "workspace_root" ? resolve(this.options.workspace) : resolve(script.packageRoot),
        environment: childEnvironment,
        executableSha256: nodeSha256,
        hookIdentitySha256: sha256Canonical(input.hook.identity),
        mode: metadata.mode,
        scriptPath: script.absolutePath,
        scriptSha256: script.sha256,
        timeoutMs: metadata.timeout_ms ?? 10_000,
      });
    }
    const child = spawn(this.options.executable, [script.absolutePath, ...handler.argv], {
      cwd: handler.cwd === "workspace_root" ? resolve(this.options.workspace) : resolve(script.packageRoot),
      detached: process.platform !== "win32",
      env: childEnvironment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let pid: number;
    try {
      pid = await waitForSpawn(child);
    } catch (error) {
      throw new HookCommandExecutionError("hook_invocation_failed", "Hook process could not be spawned", "none", { cause: error });
    }
    const processIdentitySha256 = sha256Canonical({
      action_sha256: actionSha256,
      invocation_id: input.invocationId,
      nonce: this.options.randomUUID(),
      pid,
    });
    try {
      await input.events.started({ actionSha256, invocationId: input.invocationId, pid, processIdentitySha256 });
    } catch (error) {
      const cleanup = await this.options.cleanup.terminate(pid);
      throw new HookCommandExecutionError(
        "hook_invocation_failed",
        "Hook start fact could not be persisted",
        cleanup.verified ? "none" : "unknown",
        { cause: error },
      );
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputExceeded = false;
    child.stdout.on("data", (chunk: Buffer) => {
      const result = appendBoundedHookOutput(stdout, stdoutBytes, chunk);
      stdoutBytes = result.size;
      outputExceeded ||= result.exceeded || stdoutBytes + stderrBytes > MAX_HOOK_OUTPUT_BYTES;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const result = appendBoundedHookOutput(stderr, stderrBytes, chunk);
      stderrBytes = result.size;
      outputExceeded ||= result.exceeded || stdoutBytes + stderrBytes > MAX_HOOK_OUTPUT_BYTES;
    });
    const close = closeResult(child);
    child.stdin.end(input.inputBytes);
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const interruption = new Promise<"cancelled" | "timeout">((resolveInterruption) => {
      abortListener = () => resolveInterruption("cancelled");
      if (input.signal.aborted) resolveInterruption("cancelled");
      else input.signal.addEventListener("abort", abortListener, { once: true });
      timeoutHandle = setTimeout(() => resolveInterruption("timeout"), metadata.timeout_ms ?? 10_000);
    });
    const winner = await Promise.race([
      close.then((value) => ({ kind: "close" as const, value })),
      interruption.then((value) => ({ kind: "interruption" as const, value })),
    ]);
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    if (abortListener !== undefined) input.signal.removeEventListener("abort", abortListener);

    if (winner.kind === "interruption" || outputExceeded) {
      const cleanup = await this.options.cleanup.terminate(pid);
      if (!cleanup.verified) {
        throw new HookCommandExecutionError("hook_invocation_failed", "Hook process tree cleanup could not be verified", "unknown");
      }
      throw new HookCommandExecutionError(
        winner.kind === "interruption" && winner.value === "cancelled"
          ? "hook_invocation_cancelled"
          : winner.kind === "interruption"
            ? "hook_invocation_timeout"
            : "hook_gate_output_invalid",
        outputExceeded ? "Hook output exceeded 64 KiB" : `Hook invocation ${winner.value}`,
        "unknown",
      );
    }
    const cleanup = await this.options.cleanup.terminate(pid);
    if (!cleanup.verified) {
      throw new HookCommandExecutionError(
        "hook_invocation_failed",
        "Hook process tree cleanup could not be verified after exit",
        "unknown",
      );
    }
    if (winner.value.exitCode !== 0 || winner.value.signal !== null) {
      throw new HookCommandExecutionError("hook_invocation_failed", "Hook child exited unsuccessfully", "unknown");
    }
    const finalScript = await this.options.content.readComponentFile(input.hook.identity, handler.executable)
      .catch((error: unknown) => {
        throw new HookCommandExecutionError("hook_invocation_failed", "Hook script identity became unavailable during execution", "unknown", { cause: error });
      });
    const [finalMetadata, finalNodeBytes] = await Promise.all([
      lstat(finalScript.absolutePath),
      readStableRegularFile(this.options.executable, "Node executable"),
    ]).catch((error: unknown) => {
      throw new HookCommandExecutionError("hook_invocation_failed", "Hook executable identity changed during execution", "unknown", { cause: error });
    });
    if (
      !finalMetadata.isFile() ||
      finalMetadata.isSymbolicLink() ||
      finalScript.sha256 !== script.sha256 ||
      finalScript.path !== script.path ||
      finalScript.packageRoot !== script.packageRoot ||
      createHash("sha256").update(finalNodeBytes).digest("hex") !== nodeSha256
    ) {
      throw new HookCommandExecutionError("hook_invocation_failed", "Hook executable bytes changed during execution", "unknown");
    }
    try {
      return parseHookCommandResult({
        actionSha256,
        mode: metadata.mode,
        secrets: this.options.secrets,
        stderr,
        stdout,
      });
    } catch (error) {
      throw new HookCommandExecutionError(
        "hook_gate_output_invalid",
        error instanceof HookCommandResultError ? error.message : "Hook output failed validation",
        "unknown",
        { cause: error },
      );
    }
  }

  async terminalCommitted(input: HookCommandOperationContext & {
    readonly invocationId: string;
    readonly terminalType: "hook.invocation.completed" | "hook.invocation.decided" | "hook.invocation.failed";
  }): Promise<void> {
    if (this.options.operationRoot === undefined) return;
    const store = await HookCommandOperationStore.create({
      invocationId: input.invocationId,
      root: this.options.operationRoot,
      runId: input.runId,
      sessionId: input.sessionId,
    });
    if (await store.read() === null) return;
    await store.markTerminal({
      committedAt: (this.options.timestamp ?? (() => new Date().toISOString()))(),
      nonce: this.options.randomUUID(),
      terminalEventId: input.terminalEventId,
      terminalType: input.terminalType,
    });
  }

  async #runSupervised(
    input: HookCommandRunnerInput & { readonly operation: HookCommandOperationContext },
    execution: {
      readonly actionSha256: string;
      readonly argv: readonly string[];
      readonly cwd: string;
      readonly environment: Readonly<Record<string, string>>;
      readonly executableSha256: string;
      readonly hookIdentitySha256: string;
      readonly mode: "gate" | "observe";
      readonly scriptPath: string;
      readonly scriptSha256: string;
      readonly timeoutMs: number;
    },
  ): Promise<HookCommandRunnerResult> {
    const operationRoot = this.options.operationRoot!;
    const timestamp = this.options.timestamp ?? (() => new Date().toISOString());
    const rawNonce = randomBytes(32).toString("base64url");
    const store = await HookCommandOperationStore.create({
      invocationId: input.invocationId,
      root: operationRoot,
      runId: input.operation.runId,
      sessionId: input.operation.sessionId,
    });
    await store.createRequested({
      actionSha256: execution.actionSha256,
      createdAt: timestamp(),
      failurePolicy: input.operation.failurePolicy,
      hookIdentitySha256: execution.hookIdentitySha256,
      inputSha256: input.inputSha256,
      invocationId: input.invocationId,
      mode: execution.mode,
      nonceSha256: createHash("sha256").update(rawNonce).digest("hex"),
      requestedEventId: input.operation.requestedEventId,
      runId: input.operation.runId,
      schemaVersion: 1,
      sessionId: input.operation.sessionId,
      sessionLockNonceSha256: input.operation.sessionLockNonceSha256,
      state: "requested",
      terminalEventId: input.operation.terminalEventId,
    });
    const supervisorEnvironment = sanitizeChildEnvironment({
      BORN_HOOK_SUPERVISOR: "1",
      LANG: this.options.environment.LANG,
      LC_ALL: this.options.environment.LC_ALL,
      LOCALAPPDATA: this.options.environment.LOCALAPPDATA,
      SystemRoot: this.options.environment.SystemRoot,
      TEMP: this.options.environment.TEMP,
      TMP: this.options.environment.TMP,
      WINDIR: this.options.environment.WINDIR,
      XDG_STATE_HOME: this.options.environment.XDG_STATE_HOME,
    });
    let child: ChildProcess;
    try {
      child = spawn(this.options.executable, [
        this.options.supervisorCliEntryPath!,
        "internal",
        "hook-command-supervisor",
        "--session",
        input.operation.sessionId,
        "--run",
        input.operation.runId,
        "--invocation",
        input.invocationId,
      ], {
        cwd: this.options.workspace,
        detached: false,
        env: supervisorEnvironment,
        shell: false,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
      });
    } catch (error) {
      await store.markNotStartedCaptured({
        capturedAt: timestamp(),
        code: "hook_invocation_failed",
        nonce: this.options.randomUUID(),
      });
      throw new HookCommandExecutionError("hook_invocation_failed", "Hook supervisor could not be spawned", "none", { cause: error });
    }
    const receipts = new SupervisorReceiptQueue(child);
    const bootstrap = hookCommandSupervisorBootstrapSchema.parse({
      actionSha256: execution.actionSha256,
      argv: [...execution.argv],
      cwd: execution.cwd,
      environment: { ...execution.environment },
      executablePath: this.options.executable,
      executableSha256: execution.executableSha256,
      hookIdentitySha256: execution.hookIdentitySha256,
      inputBase64: input.inputBytes.toString("base64"),
      inputSha256: input.inputSha256,
      invocationId: input.invocationId,
      mode: execution.mode,
      protocolVersion: 1,
      rawNonce,
      scriptPath: execution.scriptPath,
      scriptSha256: execution.scriptSha256,
      secrets: this.options.secrets.filter((value): value is string => value !== undefined),
      timeoutMs: execution.timeoutMs,
    });
    try {
      await new Promise<void>((resolveSend, reject) => {
        if (child.send === undefined || !child.connected) {
          reject(new Error("Hook supervisor IPC is unavailable"));
          return;
        }
        child.send(bootstrap, (error) => {
          if (error == null) resolveSend();
          else reject(error);
        });
      });
    } catch (error) {
      if (child.connected) child.disconnect();
      child.kill();
      await store.markNotStartedCaptured({
        capturedAt: timestamp(),
        code: "hook_invocation_failed",
        nonce: this.options.randomUUID(),
      });
      throw new HookCommandExecutionError("hook_invocation_failed", "Hook supervisor bootstrap failed", "none", { cause: error });
    }

    let abortListener: (() => void) | undefined;
    const aborted = new Promise<"aborted">((resolveAbort) => {
      abortListener = () => resolveAbort("aborted");
      if (input.signal.aborted) resolveAbort("aborted");
      else input.signal.addEventListener("abort", abortListener, { once: true });
    });
    try {
      let startedPersisted = false;
      for (;;) {
        let receipt: HookCommandSupervisorMessageV1;
        try {
          const next = await Promise.race([
            receipts.next().then((value) => ({ kind: "receipt" as const, value })),
            aborted.then(() => ({ kind: "abort" as const })),
          ]);
          if (next.kind === "abort") {
            if (child.connected) child.disconnect();
            await new Promise<void>((resolveExit) => {
              let settled = false;
              const finish = (): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                child.off("exit", finish);
                resolveExit();
              };
              const timer = setTimeout(finish, Math.min(execution.timeoutMs + 2_000, 12_000));
              if (child.exitCode !== null || child.signalCode !== null) finish();
              else child.once("exit", finish);
            });
            return await this.#readSupervisedCapture(store, "hook_invocation_cancelled");
          }
          receipt = next.value;
        } catch (error) {
          return await this.#readSupervisedCapture(store, "hook_invocation_failed", error);
        }
        if (receipt.invocationId !== input.invocationId) {
          if (child.connected) child.disconnect();
          throw new HookCommandExecutionError("hook_invocation_failed", "Hook supervisor receipt identity is stale", "unknown");
        }
        if (receipt.kind === "started") {
          if (startedPersisted) {
            if (child.connected) child.disconnect();
            throw new HookCommandExecutionError("hook_invocation_failed", "Hook supervisor duplicated its start receipt", "unknown");
          }
          const operation = await store.read();
          if (
            operation?.state !== "started" ||
            operation.process.hookPid !== receipt.hookPid ||
            operation.process.processIdentitySha256 !== receipt.processIdentitySha256 ||
            operation.process.supervisorPid !== receipt.supervisorPid ||
            operation.process.supervisorStartIdentity !== receipt.supervisorStartIdentity
          ) {
            if (child.connected) child.disconnect();
            throw new HookCommandExecutionError("hook_invocation_failed", "Hook supervisor start receipt lacks an exact durable identity", "unknown");
          }
          try {
            await input.events.started({
              actionSha256: execution.actionSha256,
              invocationId: input.invocationId,
              pid: receipt.hookPid,
              processIdentitySha256: receipt.processIdentitySha256,
            });
          } catch (error) {
            if (child.connected) child.disconnect();
            throw new HookCommandExecutionError("hook_invocation_failed", "Hook start fact could not be persisted", "unknown", { cause: error });
          }
          startedPersisted = true;
          continue;
        }
        if (child.connected) child.disconnect();
        child.unref();
        return await this.#readSupervisedCapture(store, "hook_invocation_failed");
      }
    } finally {
      if (abortListener !== undefined) input.signal.removeEventListener("abort", abortListener);
    }
  }

  async #readSupervisedCapture(
    store: HookCommandOperationStore,
    fallbackCode: "hook_invocation_cancelled" | "hook_invocation_failed",
    cause?: unknown,
  ): Promise<HookCommandRunnerResult> {
    let operation = await store.read();
    if (operation?.state === "requested") {
      operation = await store.markNotStartedCaptured({
        capturedAt: (this.options.timestamp ?? (() => new Date().toISOString()))(),
        code: fallbackCode,
        nonce: this.options.randomUUID(),
      });
    }
    if (operation?.state === "started") {
      await this.options.cleanup.terminate(operation.process.hookPid);
      operation = await store.markCaptured({
        capture: { code: fallbackCode, effectState: "unknown", kind: "failure" },
        capturedAt: (this.options.timestamp ?? (() => new Date().toISOString()))(),
        nonce: this.options.randomUUID(),
      });
    }
    if (operation?.state !== "captured" && operation?.state !== "terminal") {
      throw new HookCommandExecutionError(
        "hook_invocation_failed",
        "Hook supervisor stopped without a provable terminal capture",
        "unknown",
        cause === undefined ? {} : { cause },
      );
    }
    if (operation.capture.kind === "failure") {
      throw new HookCommandExecutionError(
        operation.capture.code,
        supervisorFailureMessage(operation.capture.code),
        operation.capture.effectState,
        cause === undefined ? {} : { cause },
      );
    }
    if (operation.capture.kind === "gate") {
      return Object.freeze({
        actionSha256: operation.capture.actionSha256,
        ...(operation.capture.code === undefined ? {} : { code: operation.capture.code }),
        decision: operation.capture.decision,
        evidence: Object.freeze([...operation.capture.evidence]),
        kind: "gate" as const,
        ...(operation.capture.message === undefined ? {} : { message: operation.capture.message }),
        stderr: operation.capture.stderr,
        stdout: operation.capture.stdout,
      });
    }
    return Object.freeze({
      actionSha256: operation.capture.actionSha256,
      kind: "observer" as const,
      ...(operation.capture.message === undefined ? {} : { message: operation.capture.message }),
      stderr: operation.capture.stderr,
      stdout: operation.capture.stdout,
    });
  }
}
