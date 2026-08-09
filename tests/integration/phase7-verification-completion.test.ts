import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createNodeRuntime } from "../../src/cli/node-runtime.js";
import { runCli } from "../../src/cli/run-cli.js";
import type { CliRuntime } from "../../src/cli/types.js";
import { verifyRunReportHash } from "../../src/completion/completion-report-renderer.js";
import type { RunEvent } from "../../src/events/run-event.js";
import { runReportSchema, type RunReport } from "../../src/reports/run-report-schema.js";
import {
  FakeContinuation,
  FakeStreamingChatClient,
} from "../fakes/fake-chat-client.js";
import type {
  FakeModelTurnRequest as ModelTurnRequest,
  FakeModelTurnSignal as ModelTurnSignal,
} from "../fakes/fake-chat-client.js";
import {
  createMemoryIO,
  InMemorySessionWriter,
} from "../helpers.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

const FIX_AND_VERIFY = "phase-07-fix-and-verify";
const VERIFICATION_FAILS = "phase-07-verification-fails";
const BLOCKED = "phase-07-blocked";

const fixedClamp = [
  "export function clamp(value, minimum, maximum) {",
  "  return Math.min(maximum, Math.max(minimum, value));",
  "}",
  "",
].join("\n");

const buggyClamp = [
  "export function clamp(value, minimum, maximum) {",
  "  return Math.min(minimum, Math.max(maximum, value));",
  "}",
  "",
].join("\n");

const clampPatch = [
  "diff --git a/fixtures/phase-07-fix-and-verify/src/clamp.mjs b/fixtures/phase-07-fix-and-verify/src/clamp.mjs",
  "--- a/fixtures/phase-07-fix-and-verify/src/clamp.mjs",
  "+++ b/fixtures/phase-07-fix-and-verify/src/clamp.mjs",
  "@@ -1,3 +1,3 @@",
  " export function clamp(value, minimum, maximum) {",
  "-  return Math.min(minimum, Math.max(maximum, value));",
  "+  return Math.min(maximum, Math.max(minimum, value));",
  " }",
  "",
].join("\n");

const answerPatch = [
  "diff --git a/fixtures/phase-07-verification-fails/src/answer.mjs b/fixtures/phase-07-verification-fails/src/answer.mjs",
  "--- a/fixtures/phase-07-verification-fails/src/answer.mjs",
  "+++ b/fixtures/phase-07-verification-fails/src/answer.mjs",
  "@@ -1 +1 @@",
  "-export const answer = 40;",
  "+export const answer = 41;",
  "",
].join("\n");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

async function git(workspace: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], {
    cwd: workspace,
    encoding: "utf8",
    windowsHide: true,
  });
}

async function fixtureWorkspace(
  fixtureName: string,
  baseline?: { readonly path: string; readonly value: string },
): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "born-phase7-integration-"));
  temporaryDirectories.push(workspace);
  const fixtureDestination = join(workspace, "fixtures", fixtureName);
  await mkdir(dirname(fixtureDestination), { recursive: true });
  await cp(resolve("fixtures", fixtureName), fixtureDestination, {
    recursive: true,
  });
  if (baseline !== undefined) {
    await writeFile(join(workspace, ...baseline.path.split("/")), baseline.value, "utf8");
  }
  await writeFile(join(workspace, ".gitignore"), ".bornagent/\n", "utf8");
  await git(workspace, ["init"]);
  await git(workspace, ["config", "user.email", "phase7@example.invalid"]);
  await git(workspace, ["config", "user.name", "Phase 7 Integration"]);
  await git(workspace, ["config", "core.autocrlf", "false"]);
  await git(workspace, ["add", "--all"]);
  await git(workspace, ["commit", "--no-gpg-sign", "-m", "fixture baseline"]);
  return workspace;
}

function toolTurn(
  name: string,
  callId: string,
  input: Readonly<Record<string, unknown>>,
): readonly ModelTurnSignal[] {
  return [
    {
      call: {
        argumentsJson: JSON.stringify(input),
        callId,
        name,
      },
      type: "tool_call",
    },
    {
      type: "usage",
      usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
    },
    {
      continuation: new FakeContinuation(callId),
      providerResponseId: `resp_${callId}`,
      type: "turn_completed",
    },
  ];
}

function finalTurn(text: string): readonly ModelTurnSignal[] {
  return [
    { delta: text, type: "text_delta" },
    {
      type: "usage",
      usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
    },
    {
      continuation: new FakeContinuation("natural-final"),
      providerResponseId: "resp_natural_final",
      type: "turn_completed",
    },
  ];
}

function scriptedClient(
  turns: readonly (readonly ModelTurnSignal[])[],
): FakeStreamingChatClient {
  let index = 0;
  return new FakeStreamingChatClient(async function* (request) {
    expect(request.tools.map((tool) => tool.name)).toEqual([
      "apply_patch",
      "find_references",
      "find_symbol",
      "finish_task",
      "list_files",
      "read_file",
      "repository_outline",
      "run_command",
      "search",
    ]);
    const turn = turns[index++];
    if (turn === undefined) throw new Error("unexpected model turn");
    yield* turn;
  });
}

function deterministicUUIDs(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  };
}

interface ScenarioResult {
  readonly approval: ReturnType<typeof vi.fn>;
  readonly client: FakeStreamingChatClient;
  readonly exitCode: number;
  readonly memory: ReturnType<typeof createMemoryIO>;
  readonly modelConfigurations: readonly ModelTurnRequest["model"][];
  readonly writer: InMemorySessionWriter;
}

async function runCodingScenario(options: {
  readonly args?: readonly string[];
  readonly client: FakeStreamingChatClient;
  readonly clock?: Partial<
    Pick<CliRuntime, "clearTimer" | "now" | "setTimer">
  >;
  readonly workspace: string;
  readonly writer?: InMemorySessionWriter;
}): Promise<ScenarioResult> {
  const memory = createMemoryIO();
  const writer = options.writer ?? new InMemorySessionWriter();
  const approval = vi.fn(async () => "approved" as const);
  const modelConfigurations: ModelTurnRequest["model"][] = [];
  const baseRuntime = createNodeRuntime({
    approvalInput: {
      interactive: false,
      readLine: async () => null,
    },
    capabilityUserStateRoot: join(options.workspace, ".test-capabilities"),
    cwd: options.workspace,
    env: {},
    execPath: process.execPath,
    killProcess: (processIdentity, signal) => process.kill(processIdentity, signal),
    nodeVersion: process.versions.node,
    onCancel: () => () => undefined,
    platform: process.platform,
    version: "0.0.0-phase7-test",
  });
  const runtime: CliRuntime = {
    ...baseRuntime,
    agentModelEvidence: () => ({
      backend: "fake",
      endpointScope: "in_process",
      kind: "contract_verified",
      remoteBillableRequests: 0,
    }),
    createApprovalPrompt: () => ({ request: approval }),
    createModelBackend: (configuration) => {
      modelConfigurations.push(configuration.provider);
      return options.client.selectIdentity(
        configuration.provider as "anthropic" | "ollama" | "openai",
        configuration.model,
      );
    },
    createSessionWriter: async () => writer,
    now: () => 0,
    randomUUID: deterministicUUIDs(),
    timestamp: () => "2026-07-17T00:00:00.000Z",
    ...options.clock,
  };

  const exitCode = await runCli(
    [
      "agent",
      "complete the checked-in Phase 7 fixture",
      "--provider",
      "ollama",
      "--task-profile",
      "coding",
      "--edit-approval",
      "ask",
      "--command-approval",
      "ask",
      "--report-format",
      "json",
      ...(options.args ?? []),
    ],
    memory.io,
    runtime,
  );
  return {
    approval,
    client: options.client,
    exitCode,
    memory,
    modelConfigurations,
    writer,
  };
}

function parseReport(output: string): RunReport {
  const jsonLine = output
    .split(/\r?\n/u)
    .find((line) => line.trimStart().startsWith("{"));
  if (jsonLine === undefined) {
    throw new Error(`missing JSON run report in: ${output}`);
  }
  return runReportSchema.parse(JSON.parse(jsonLine) as unknown);
}

function expectEventOrder(
  events: readonly RunEvent[],
  predicates: readonly ((event: RunEvent) => boolean)[],
): void {
  let cursor = -1;
  for (const predicate of predicates) {
    cursor = events.findIndex((event, index) => index > cursor && predicate(event));
    expect(cursor).toBeGreaterThan(-1);
  }
}

function eventType(type: RunEvent["type"]): (event: RunEvent) => boolean {
  return (event) => event.type === type;
}

function toolCompleted(
  callId: string,
  status: "error" | "success",
): (event: RunEvent) => boolean {
  return (event) =>
    event.type === "tool.call.completed" &&
    event.data.call_id === callId &&
    event.data.status === status;
}

function completionEvaluated(
  callId: string,
  effect: "accept" | "continue" | "incomplete",
): (event: RunEvent) => boolean {
  return (event) =>
    event.type === "completion.evaluated" &&
    event.data.call_id === callId &&
    event.data.effect === effect;
}

function expectNoPaidRequests(
  result: ScenarioResult,
  report: RunReport,
  expectedModelTurns: number,
): void {
  expect(result.modelConfigurations).toEqual(["ollama"]);
  expect(result.client.calls).toHaveLength(expectedModelTurns);
  expect(report.model_evidence).toEqual({
    backend: "fake",
    endpoint_scope: "in_process",
    kind: "contract_verified",
    remote_billable_requests: 0,
  });
  expect(verifyRunReportHash(report)).toBe(true);
}

describe("born agent Phase 7 verification and completion integration", () => {
  it("patches, runs a real reviewed offline verification, and completes with a deterministic report", async () => {
    const target = "fixtures/phase-07-fix-and-verify/src/clamp.mjs";
    const workspace = await fixtureWorkspace(FIX_AND_VERIFY, {
      path: target,
      value: buggyClamp,
    });
    const client = scriptedClient([
      toolTurn("apply_patch", "call_patch", { patch: clampPatch }),
      toolTurn("run_command", "call_verify", {
        args: ["verify.mjs"],
        cwd: "fixtures/phase-07-fix-and-verify",
        executable: "node",
        purpose: "verify",
        timeout_ms: 120_000,
      }),
      toolTurn("finish_task", "call_finish", {
        status: "completed",
        summary: "The clamp bounds are corrected and the reviewed offline check passed.",
      }),
    ]);

    const result = await runCodingScenario({ client, workspace });

    expect(result.exitCode, result.memory.readStderr()).toBe(0);
    expect(await readFile(join(workspace, ...target.split("/")), "utf8")).toBe(
      fixedClamp,
    );
    expect(result.approval).toHaveBeenCalledTimes(2);
    const report = parseReport(result.memory.readStdout());
    expect(report).toMatchObject({
      changed: [{ path: target }],
      diff_check: { checked_paths: [target], status: "passed" },
      model_narrative:
        "The clamp bounds are corrected and the reviewed offline check passed.",
      status: "completed",
      verifications: [
        {
          argv: ["node", "verify.mjs"],
          classification: "test",
          cwd: "fixtures/phase-07-fix-and-verify",
          exit_code: 0,
        },
      ],
    });
    expectNoPaidRequests(result, report, 3);
    expectEventOrder(result.writer.events, [
      eventType("patch.apply.completed"),
      eventType("command.execution.requested"),
      eventType("verification.started"),
      eventType("command.started"),
      eventType("command.completed"),
      eventType("verification.completed"),
      toolCompleted("call_verify", "success"),
      eventType("completion.candidate"),
      completionEvaluated("call_finish", "accept"),
      toolCompleted("call_finish", "success"),
      eventType("usage"),
      eventType("run.completed"),
    ]);
  }, 30_000);

  it("rejects completed after a failed verification, then reports blocked with exit 8", async () => {
    const target = "fixtures/phase-07-verification-fails/src/answer.mjs";
    const workspace = await fixtureWorkspace(VERIFICATION_FAILS, {
      path: target,
      value: "export const answer = 40;\n",
    });
    const client = scriptedClient([
      toolTurn("apply_patch", "call_patch", { patch: answerPatch }),
      toolTurn("run_command", "call_verify", {
        args: ["verify.mjs"],
        cwd: "fixtures/phase-07-verification-fails",
        executable: "node",
        purpose: "verify",
        timeout_ms: 120_000,
      }),
      toolTurn("finish_task", "call_rejected", {
        status: "completed",
        summary: "The answer is complete.",
      }),
      toolTurn("finish_task", "call_blocked", {
        status: "blocked",
        summary: "The reviewed offline verification still fails.",
      }),
    ]);

    const result = await runCodingScenario({ client, workspace });

    expect(result.exitCode).toBe(8);
    expect(result.approval).toHaveBeenCalledTimes(2);
    const report = parseReport(result.memory.readStderr());
    expect(report).toMatchObject({
      changed: [{ path: target }],
      reason: "task_blocked",
      status: "incomplete",
      verifications: [
        {
          argv: ["node", "verify.mjs"],
          classification: "test",
          exit_code: 1,
        },
      ],
    });
    expectNoPaidRequests(result, report, 4);
    const rejected = result.writer.events.find(
      (event) =>
        event.type === "completion.evaluated" &&
        event.data.call_id === "call_rejected",
    );
    expect(rejected).toMatchObject({
      data: { effect: "continue", reasons: ["verification_failed"] },
    });
    expectEventOrder(result.writer.events, [
      (event) =>
        event.type === "verification.completed" &&
        event.data.status === "failed",
      completionEvaluated("call_rejected", "continue"),
      toolCompleted("call_rejected", "error"),
      (event) =>
        event.type === "completion.candidate" &&
        event.data.call_id === "call_blocked",
      completionEvaluated("call_blocked", "incomplete"),
      toolCompleted("call_blocked", "success"),
      eventType("usage"),
      eventType("run.incomplete"),
    ]);
  }, 30_000);

  it("accepts an immediate blocked signal as an incomplete outcome", async () => {
    const workspace = await fixtureWorkspace(BLOCKED);
    const client = scriptedClient([
      toolTurn("finish_task", "call_blocked", {
        status: "blocked",
        summary: "The required user-supplied requirements.txt is missing.",
      }),
    ]);

    const result = await runCodingScenario({ client, workspace });

    expect(result.exitCode).toBe(8);
    expect(result.approval).not.toHaveBeenCalled();
    const report = parseReport(result.memory.readStderr());
    expect(report).toMatchObject({
      changed: [],
      model_narrative:
        "The required user-supplied requirements.txt is missing.",
      reason: "task_blocked",
      status: "incomplete",
      verifications: [],
    });
    expectNoPaidRequests(result, report, 1);
    expectEventOrder(result.writer.events, [
      eventType("completion.candidate"),
      completionEvaluated("call_blocked", "incomplete"),
      toolCompleted("call_blocked", "success"),
      eventType("usage"),
      eventType("run.incomplete"),
    ]);
  });

  it("closes a finish_task call before a deadline raised by completion evaluation", async () => {
    const workspace = await fixtureWorkspace(BLOCKED);
    let now = 0;
    let globalDeadline: (() => void) | undefined;
    const writer = new InMemorySessionWriter(
      "memory://finish-task-deadline.jsonl",
      (event) => {
        if (event.type === "completion.evaluated") {
          now = 1_000;
          globalDeadline?.();
        }
      },
    );
    const client = scriptedClient([
      toolTurn("finish_task", "call_deadline", {
        status: "blocked",
        summary: "The required input is unavailable.",
      }),
    ]);

    const result = await runCodingScenario({
      args: ["--max-duration-ms", "1000"],
      client,
      clock: {
        clearTimer: () => undefined,
        now: () => now,
        setTimer: (listener, delayMs) => {
          if (delayMs === 1_000) globalDeadline = listener;
          return { delayMs };
        },
      },
      workspace,
      writer,
    });

    expect(result.exitCode).toBe(7);
    expectEventOrder(result.writer.events, [
      eventType("completion.candidate"),
      completionEvaluated("call_deadline", "incomplete"),
      toolCompleted("call_deadline", "success"),
      eventType("usage"),
      eventType("run.budget_exceeded"),
    ]);
    expect(result.writer.events.at(-1)).toMatchObject({
      data: { reason: "max_duration", tool_calls: 1 },
      type: "run.budget_exceeded",
    });
  });

  it("treats a natural coding final as completion_signal_required", async () => {
    const workspace = await fixtureWorkspace(BLOCKED);
    const client = scriptedClient([
      finalTurn("Everything is complete."),
    ]);

    const result = await runCodingScenario({ client, workspace });

    expect(result.exitCode).toBe(8);
    expect(result.approval).not.toHaveBeenCalled();
    expect(result.memory.readStdout()).toBe("");
    const report = parseReport(result.memory.readStderr());
    expect(report).toMatchObject({
      changed: [],
      reason: "completion_signal_required",
      status: "incomplete",
      verifications: [],
    });
    expectNoPaidRequests(result, report, 1);
    expect(
      result.writer.events.some((event) => event.type === "completion.candidate"),
    ).toBe(false);
    expectEventOrder(result.writer.events, [
      (event) =>
        event.type === "text.delta" &&
        event.data.visibility === "internal_candidate",
      eventType("agent.step.completed"),
      eventType("usage"),
      (event) =>
        event.type === "run.incomplete" &&
        event.data.reason === "completion_signal_required",
    ]);
  });
});
