import { describe, expect, it, vi } from "vitest";

import { CommandApprovalGate } from "../../src/approvals/command-approval-gate.js";
import type {
  ApprovalDecision,
  ApprovalPreview,
} from "../../src/approvals/approval-types.js";
import {
  EventPersistenceError,
  type EventPublisher,
} from "../../src/events/event-publisher.js";
import type { RunEventDraft } from "../../src/events/run-event.js";
import type { ExecutionPreparer } from "../../src/execution/execution-preparer.js";
import type {
  ExecutionResult,
  ExecutionSignal,
  Executor,
  PreparedExecution,
} from "../../src/execution/execution-types.js";
import type {
  PermissionDecision,
  PermissionEngineLike,
} from "../../src/permissions/permission-types.js";
import { createRunCommandTool } from "../../src/tools/run-command-tool.js";
import { FatalToolExecutionError } from "../../src/tools/tool-types.js";

const ACTION_SHA256 = "a".repeat(64);
const EXECUTION_INPUTS_SHA256 = "b".repeat(64);

type StoredEvent = {
  readonly data: Readonly<Record<string, unknown>>;
  readonly type: RunEventDraft["type"];
};

interface HarnessOptions {
  readonly approvalDecision?: ApprovalDecision;
  readonly decision?: PermissionDecision;
  readonly executorFinally?: () => void;
  readonly failEventType?: RunEventDraft["type"];
  readonly prepared?: PreparedExecution;
  readonly secrets?: readonly string[];
  readonly signals?: readonly ExecutionSignal[];
}

function allowDecision(): PermissionDecision {
  return {
    effect: "allow",
    policyId: "test-policy",
    policyVersion: "1",
    ruleId: "allow-test",
  };
}

function askDecision(): PermissionDecision {
  return {
    effect: "ask",
    policyId: "test-policy",
    policyVersion: "1",
    reasonCode: "approval_required",
    ruleId: "ask-test",
  };
}

function denyDecision(): PermissionDecision {
  return {
    effect: "deny",
    policyId: "test-policy",
    policyVersion: "1",
    reasonCode: "hard_deny",
    ruleId: "deny-test",
  };
}

function makePrepared(options: {
  readonly argv?: readonly string[];
  readonly revalidate?: () => Promise<"current" | "stale">;
} = {}): PreparedExecution {
  const argv = options.argv ?? ["fixtures/phase-06-command-execution/pass.mjs"];
  return {
    actionIdentity: {
      actionKind: "command",
      actionSha256: ACTION_SHA256,
      argv,
      binary: {
        bytesSha256: "c".repeat(64),
        canonicalIdentity: "trusted:node:phase6-fixture",
        version: "v22-test",
      },
      canonicalCwd: ".",
      environmentPolicy: {
        id: "phase6-minimum-env",
        variableNames: ["CI", "NO_COLOR", "PATH"],
        version: "1",
      },
      executionInputs: {
        lockfileSha256: null,
        manifestSha256: null,
        runnerConfigHashes: [],
      },
      executionInputsSha256: EXECUTION_INPUTS_SHA256,
      lifecycleScripts: null,
      logicalExecutable: "node",
      outputLimitBytes: 131_072,
      packageManager: null,
      purpose: "verify",
      timeoutMs: 120_000,
    },
    actionSha256: ACTION_SHA256,
    executionInputsSha256: EXECUTION_INPUTS_SHA256,
    request: {
      args: argv,
      cwd: "D:\\Code\\bornagent",
      environment: { CI: "1", NO_COLOR: "1" },
      executableFile: "C:\\Program Files\\nodejs\\node.exe",
      logicalExecutable: "node",
      outputLimitBytes: 131_072,
      purpose: "verify",
      timeoutMs: 120_000,
    },
    revalidate: options.revalidate ?? (async () => "current"),
    review: {
      lifecycleScripts: [],
      warning: "LocalExecutor is not a sandbox",
    },
  };
}

function makeResult(
  overrides: Partial<ExecutionResult> = {},
): ExecutionResult {
  const stdout = overrides.stdout ?? "";
  const stderr = overrides.stderr ?? "";
  return {
    cleanupVerified: true,
    durationMs: 5,
    exitCode: 0,
    ok: true,
    signal: null,
    stderr,
    stderrBytes: Buffer.byteLength(stderr, "utf8"),
    stdout,
    stdoutBytes: Buffer.byteLength(stdout, "utf8"),
    termination: "exit",
    truncated: false,
    ...overrides,
  };
}

async function* signalStream(
  signals: readonly ExecutionSignal[],
): AsyncIterable<ExecutionSignal> {
  for (const signal of signals) yield signal;
}

function signalsFor(result: ExecutionResult): readonly ExecutionSignal[] {
  const signals: ExecutionSignal[] = [];
  if (result.termination !== "spawn_error" && result.termination !== "cancelled") {
    signals.push({ processIdentity: "pid:test", type: "started" });
  }
  if (result.stdout.length > 0) {
    signals.push({
      chunk: result.stdout,
      chunkBytes: Buffer.byteLength(result.stdout, "utf8"),
      stream: "stdout",
      type: "output",
    });
  }
  if (result.stderr.length > 0) {
    signals.push({
      chunk: result.stderr,
      chunkBytes: Buffer.byteLength(result.stderr, "utf8"),
      stream: "stderr",
      type: "output",
    });
  }
  signals.push({ result, type: "completed" });
  return signals;
}

function createHarness(options: HarnessOptions = {}) {
  const events: StoredEvent[] = [];
  const publish = vi.fn(async (draft: RunEventDraft) => {
    if (draft.type === options.failEventType) {
      throw new EventPersistenceError(new Error("disk full"));
    }
    events.push(draft as StoredEvent);
    return draft as never;
  });
  const publisher = { publish } as unknown as EventPublisher;
  let nextId = 0;
  const randomUUID = () =>
    `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`;
  const prompt = vi.fn(
    async (preview: ApprovalPreview): Promise<ApprovalDecision> => {
      void preview;
      return options.approvalDecision ?? "approved";
    },
  );
  const approvalGate = new CommandApprovalGate({
    mode: "ask",
    prompt: { request: prompt },
    publisher,
    randomUUID,
  });
  const approvalRequest = vi.spyOn(approvalGate, "request");
  const prepared = options.prepared ?? makePrepared();
  const prepare = vi.fn(async () => prepared);
  const preparer = { prepare } as unknown as ExecutionPreparer;
  const evaluate = vi.fn(() => options.decision ?? allowDecision());
  const permissionEngine: PermissionEngineLike = { evaluate };
  const execute = vi.fn(async function* () {
    try {
      yield* signalStream(options.signals ?? signalsFor(makeResult()));
    } finally {
      options.executorFinally?.();
    }
  });
  const executor: Executor = { execute };
  const tool = createRunCommandTool({
    approvalGate,
    defaultTimeoutMs: 120_000,
    executor,
    maxOutputBytes: 131_072,
    permissionContext: () => ({}),
    permissionEngine,
    preparer,
    publisher,
    randomUUID,
    ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
  });

  return {
    approvalRequest,
    events,
    execute,
    invoke: () =>
      tool.execute(
        {
          args: [...prepared.actionIdentity.argv],
          cwd: null,
          executable: "node",
          purpose: "verify",
          timeout_ms: null,
        },
        {
          callId: "call-command",
          signal: new AbortController().signal,
          step: 1,
          toolName: "run_command",
        },
      ),
    prompt,
    publish,
  };
}

function eventsOf(harness: ReturnType<typeof createHarness>, type: string) {
  return harness.events.filter((event) => event.type === type);
}

function collectStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, output);
  }
  return output;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

describe("Phase 6 run_command tool", () => {
  it("hard-denies without prompting or crossing the executor boundary", async () => {
    const harness = createHarness({ decision: denyDecision() });

    await expect(harness.invoke()).resolves.toMatchObject({
      error: { code: "command_denied" },
      ok: false,
    });
    expect(harness.approvalRequest).not.toHaveBeenCalled();
    expect(harness.prompt).not.toHaveBeenCalled();
    expect(harness.execute).not.toHaveBeenCalled();
    expect(eventsOf(harness, "command.execution.requested")).toHaveLength(0);
  });

  it("treats an approved non-zero exit as a successful observation", async () => {
    const completed = makeResult({
      exitCode: 1,
      ok: false,
      stdout: "tests failed\n",
      stdoutBytes: 13,
    });
    const harness = createHarness({
      decision: askDecision(),
      signals: signalsFor(completed),
    });

    const result = await harness.invoke();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected command observation");
    expect(result.value).toMatchObject({
      exit_code: 1,
      stdout: "tests failed\n",
      termination: "exit",
    });
    expect(harness.prompt).toHaveBeenCalledOnce();
    expect(harness.execute).toHaveBeenCalledOnce();
  });

  it.each([
    ["timeout", "command_timeout"],
    ["output_limit_exceeded", "command_output_limit_exceeded"],
  ] as const)(
    "returns %s as an error while preserving bounded stdout",
    async (termination, errorCode) => {
      const completed = makeResult({
        exitCode: null,
        ok: false,
        stdout: "evidence before termination",
        termination,
        truncated: termination === "output_limit_exceeded",
      });
      const harness = createHarness({ signals: signalsFor(completed) });

      const result = await harness.invoke();
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected structured command error");
      expect(result.error.code).toBe(errorCode);
      expect(result.value).toMatchObject({
        stdout: "evidence before termination",
        termination,
      });
    },
  );

  it("stops a stale approved action before command.execution.requested", async () => {
    const prepared = makePrepared({ revalidate: async () => "stale" });
    const harness = createHarness({ decision: askDecision(), prepared });

    await expect(harness.invoke()).resolves.toMatchObject({
      error: { code: "command_stale", retryable: true },
      ok: false,
    });
    expect(harness.prompt).toHaveBeenCalledOnce();
    expect(eventsOf(harness, "approval.decided")).toHaveLength(1);
    expect(eventsOf(harness, "command.execution.requested")).toHaveLength(0);
    expect(harness.execute).not.toHaveBeenCalled();
  });

  it("does not execute when command.execution.requested cannot persist", async () => {
    const harness = createHarness({
      failEventType: "command.execution.requested",
    });

    await expect(harness.invoke()).rejects.toMatchObject({
      kind: "storage",
      workspaceMayHaveChanged: false,
    });
    expect(harness.execute).not.toHaveBeenCalled();
    expect(eventsOf(harness, "command.execution.requested")).toHaveLength(0);
  });

  it.each(["command.started", "command.output"] as const)(
    "finalizes the active executor when %s cannot persist",
    async (failEventType) => {
      const finalized = vi.fn();
      const completed = makeResult({ stdout: "persist me" });
      const harness = createHarness({
        executorFinally: finalized,
        failEventType,
        signals: signalsFor(completed),
      });

      await expect(harness.invoke()).rejects.toMatchObject({
        kind: "storage",
        workspaceMayHaveChanged: true,
      });
      expect(finalized).toHaveBeenCalledOnce();
      expect(eventsOf(harness, "command.completed")).toHaveLength(0);
    },
  );

  it("closes spawn_error without inventing command.started", async () => {
    const completed = makeResult({
      errorCode: "enoent",
      exitCode: null,
      ok: false,
      termination: "spawn_error",
    });
    const harness = createHarness({ signals: signalsFor(completed) });

    await expect(harness.invoke()).resolves.toMatchObject({
      error: { code: "command_spawn_failed" },
      ok: false,
    });
    expect(eventsOf(harness, "command.started")).toHaveLength(0);
    expect(eventsOf(harness, "command.completed")).toHaveLength(1);
  });

  it("splits output above 32 KiB with byte-exact contiguous indexes", async () => {
    const stdout = "x".repeat(70_000);
    const completed = makeResult({ stdout });
    const harness = createHarness({ signals: signalsFor(completed) });

    await expect(harness.invoke()).resolves.toMatchObject({ ok: true });
    const chunks = eventsOf(harness, "command.output");
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.map((event) => event.data.chunk_index)).toEqual(
      chunks.map((_event, index) => index),
    );
    expect(
      chunks.every(
        (event) =>
          event.data.bytes ===
            Buffer.byteLength(String(event.data.chunk), "utf8") &&
          Number(event.data.bytes) <= 32 * 1024,
      ),
    ).toBe(true);
    expect(chunks.map((event) => event.data.chunk).join("")).toBe(stdout);
  });

  it("removes secrets and control characters before events and prompt", async () => {
    const secret = "sk-phase6-super-secret";
    const prepared = makePrepared({
      argv: [`pass.mjs\n${secret}\u001b[31m`, "safe\targument"],
    });
    const completed = makeResult();
    const harness = createHarness({
      decision: askDecision(),
      prepared,
      secrets: [secret],
      signals: signalsFor(completed),
    });

    await expect(harness.invoke()).resolves.toMatchObject({ ok: true });
    const exposedStrings = collectStrings([
      harness.events,
      harness.prompt.mock.calls,
    ]);
    expect(exposedStrings.some((value) => value.includes(secret))).toBe(false);
    expect(exposedStrings.some((value) => value.includes("\u001b"))).toBe(false);
    expect(exposedStrings.some((value) => value.includes("safe\targument"))).toBe(
      false,
    );
    const displayedArgv = [
      ...eventsOf(harness, "approval.requested"),
      ...eventsOf(harness, "command.execution.requested"),
    ].flatMap((event) => event.data.redacted_argv ?? []);
    const promptArgv = collectStrings(
      harness.prompt.mock.calls.map(([preview]) =>
        preview.actionKind === "run_command" ? preview.args : [],
      ),
    );
    expect(
      collectStrings([displayedArgv, promptArgv]).some((value) =>
        containsControlCharacter(value),
      ),
    ).toBe(false);
    expect(exposedStrings.join(" ")).toContain("[redacted]");
    expect(exposedStrings.join(" ")).toContain("\\u001b");
  });

  it("raises a fatal error when process-tree cleanup is unverified", async () => {
    const completed = makeResult({
      cleanupVerified: false,
      exitCode: null,
      ok: false,
      termination: "cleanup_failed",
    });
    const harness = createHarness({ signals: signalsFor(completed) });

    const execution = harness.invoke();
    await expect(execution).rejects.toBeInstanceOf(FatalToolExecutionError);
    await expect(execution).rejects.toMatchObject({
      kind: "ambiguous_command_state",
      workspaceMayHaveChanged: true,
    });
    expect(eventsOf(harness, "command.completed")).toHaveLength(1);
  });
});
