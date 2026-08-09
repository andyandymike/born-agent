import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { z } from "zod";

import type { ApprovalPrompt } from "../approvals/approval-types.js";
import type { FrozenCapabilityContentSource } from "../capabilities/capability-platform.js";
import type { FrozenCapabilityRecord } from "../capabilities/capability-types.js";
import { sha256Canonical } from "../completion/canonical-json.js";
import type { ProcessTreeCleanup } from "../execution/process-tree-cleanup.js";
import { sanitizeChildEnvironment } from "../security/child-environment.js";
import { redactSensitiveText } from "../security/redact.js";
import { parseStrictJson } from "../system/strict-json.js";
import { HookError } from "./hook-errors.js";

const MAX_HOOK_OUTPUT_BYTES = 64 * 1024;
const SENSITIVE_ENVIRONMENT_NAME = /(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH|COOKIE)/iu;

const gateOutputSchema = z.object({
  schemaVersion: z.literal(1),
  decision: z.enum(["deny", "no_objection"]),
  code: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/u).optional(),
  evidence: z.array(z.string().min(1).max(512)).max(32).optional(),
  message: z.string().min(1).max(1024).optional(),
}).strict().superRefine((value, context) => {
  if (value.decision === "deny" && (value.code === undefined || value.message === undefined)) {
    context.addIssue({ code: "custom", message: "deny requires code and message" });
  }
  if (value.decision === "no_objection" && (value.code !== undefined || value.message !== undefined)) {
    context.addIssue({ code: "custom", message: "no_objection cannot carry deny fields" });
  }
});

const observerOutputSchema = z.union([
  z.object({}).strict(),
  z.object({
    schemaVersion: z.literal(1),
    status: z.literal("observed"),
    message: z.string().min(1).max(1024).optional(),
  }).strict(),
]);

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
    readonly requestId: string;
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

export type HookCommandRunnerResult =
  | {
      readonly actionSha256: string;
      readonly decision: "deny" | "no_objection";
      readonly evidence: readonly string[];
      readonly kind: "gate";
      readonly code?: string;
      readonly message?: string;
      readonly stderr: string;
      readonly stdout: string;
    }
  | {
      readonly actionSha256: string;
      readonly kind: "observer";
      readonly message?: string;
      readonly stderr: string;
      readonly stdout: string;
    };

export interface HookCommandRunnerInput {
  readonly events: HookCommandRunnerEventSink;
  readonly hook: FrozenCapabilityRecord;
  readonly inputBytes: Buffer;
  readonly inputSha256: string;
  readonly invocationId: string;
  readonly signal: AbortSignal;
}

export interface HookCommandRunnerLike {
  run(input: HookCommandRunnerInput): Promise<HookCommandRunnerResult>;
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

function boundedAppend(current: Buffer[], size: number, chunk: Buffer): { readonly exceeded: boolean; readonly size: number } {
  const next = size + chunk.byteLength;
  if (next <= MAX_HOOK_OUTPUT_BYTES) {
    current.push(Buffer.from(chunk));
    return { exceeded: false, size: next };
  }
  const remaining = Math.max(0, MAX_HOOK_OUTPUT_BYTES - size);
  if (remaining > 0) current.push(Buffer.from(chunk.subarray(0, remaining)));
  return { exceeded: true, size: MAX_HOOK_OUTPUT_BYTES };
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

export class HookCommandRunner implements HookCommandRunnerLike {
  constructor(private readonly options: {
    readonly cleanup: ProcessTreeCleanup;
    readonly content: FrozenCapabilityContentSource;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly executable: string;
    readonly prompt: ApprovalPrompt;
    readonly randomUUID: () => string;
    readonly secrets: readonly (string | undefined)[];
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
      if (SENSITIVE_ENVIRONMENT_NAME.test(name)) {
        throw new HookCommandExecutionError("hook_invocation_failed", "Hook environment cannot declare credential-like names", "none");
      }
    }
    const [script, nodeBytes] = await Promise.all([
      this.options.content.readComponentFile(input.hook.identity, handler.executable),
      readFile(this.options.executable),
    ]);
    const [scriptMetadata, executableMetadata] = await Promise.all([
      lstat(script.absolutePath),
      lstat(this.options.executable),
    ]);
    if (
      !scriptMetadata.isFile() || scriptMetadata.isSymbolicLink() ||
      !executableMetadata.isFile() || executableMetadata.isSymbolicLink()
    ) {
      throw new HookCommandExecutionError("hook_invocation_failed", "Hook executable identity is not a regular non-link file", "none");
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
    await input.events.approvalRequested({ actionSha256, invocationId: input.invocationId, requestId });
    const decision = await this.options.prompt.request({
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
    }, input.signal);
    await input.events.approvalDecided({ actionSha256, decision, invocationId: input.invocationId, requestId });
    if (decision !== "approved") {
      throw new HookCommandExecutionError("hook_approval_denied", "Hook command was not approved", "none");
    }

    const revalidated = await this.options.content.readComponentFile(input.hook.identity, handler.executable);
    if (
      revalidated.sha256 !== script.sha256 ||
      revalidated.path !== script.path ||
      revalidated.packageRoot !== script.packageRoot
    ) {
      throw new HookCommandExecutionError("hook_invocation_failed", "Hook bytes changed after approval", "none");
    }
    const childEnvironment = sanitizeChildEnvironment({
      BORN_HOOK_PROTOCOL: "1",
      BORN_HOOK_ACTION_SHA256: actionSha256,
      SystemRoot: this.options.environment.SystemRoot,
      TEMP: this.options.environment.TEMP,
      TMP: this.options.environment.TMP,
      WINDIR: this.options.environment.WINDIR,
      ...(handler.environment ?? {}),
    });
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
      const result = boundedAppend(stdout, stdoutBytes, chunk);
      stdoutBytes = result.size;
      outputExceeded ||= result.exceeded || stdoutBytes + stderrBytes > MAX_HOOK_OUTPUT_BYTES;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const result = boundedAppend(stderr, stderrBytes, chunk);
      stderrBytes = result.size;
      outputExceeded ||= result.exceeded || stdoutBytes + stderrBytes > MAX_HOOK_OUTPUT_BYTES;
    });
    const close = closeResult(child);
    child.stdin.end(input.inputBytes);
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const interruption = new Promise<"cancelled" | "timeout">((resolveInterruption) => {
      abortListener = () => resolveInterruption("cancelled");
      input.signal.addEventListener("abort", abortListener, { once: true });
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
    if (winner.value.exitCode !== 0 || winner.value.signal !== null) {
      throw new HookCommandExecutionError("hook_invocation_failed", "Hook child exited unsuccessfully", "unknown");
    }
    const finalScript = await this.options.content.readComponentFile(input.hook.identity, handler.executable);
    if (finalScript.sha256 !== script.sha256 || finalScript.path !== script.path) {
      throw new HookCommandExecutionError("hook_invocation_failed", "Hook bytes changed during execution", "unknown");
    }
    const stdoutText = redactSensitiveText(Buffer.concat(stdout).toString("utf8"), this.options.secrets);
    const stderrText = redactSensitiveText(Buffer.concat(stderr).toString("utf8"), this.options.secrets);
    let parsed: unknown;
    try {
      parsed = parseStrictJson(stdoutText.trim());
    } catch (error) {
      throw new HookCommandExecutionError("hook_gate_output_invalid", "Hook stdout is not one strict JSON document", "unknown", { cause: error });
    }
    if (metadata.mode === "gate") {
      let result: z.infer<typeof gateOutputSchema>;
      try {
        result = gateOutputSchema.parse(parsed);
      } catch (error) {
        throw new HookCommandExecutionError("hook_gate_output_invalid", "Hook gate output failed the strict protocol", "unknown", { cause: error });
      }
      return Object.freeze({
        actionSha256,
        ...(result.code === undefined ? {} : { code: result.code }),
        decision: result.decision,
        evidence: Object.freeze([...(result.evidence ?? [])]),
        kind: "gate" as const,
        ...(result.message === undefined ? {} : { message: result.message }),
        stderr: stderrText,
        stdout: stdoutText,
      });
    }
    let result: z.infer<typeof observerOutputSchema>;
    try {
      result = observerOutputSchema.parse(parsed);
    } catch (error) {
      throw new HookCommandExecutionError("hook_gate_output_invalid", "Hook observer output failed the strict protocol", "unknown", { cause: error });
    }
    return Object.freeze({
      actionSha256,
      kind: "observer" as const,
      ...(Object.hasOwn(result, "message") && typeof result.message === "string" ? { message: result.message } : {}),
      stderr: stderrText,
      stdout: stdoutText,
    });
  }
}
